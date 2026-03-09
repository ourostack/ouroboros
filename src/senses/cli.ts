import OpenAI from "openai"
import * as readline from "readline"
import * as os from "os"
import * as path from "path"
import { runAgent, ChannelCallbacks, getProvider, createSummarize } from "../heart/core"
import { buildSystem } from "../mind/prompt"
import { pickPhrase, getPhrases } from "../mind/phrases"
import { formatToolResult, formatKick, formatError } from "../mind/format"
import { sessionPath } from "../heart/config"
import { loadSession, deleteSession, postTurn, saveSession } from "../mind/context"
import { getPendingDir, drainPending } from "../mind/pending"
import { refreshSystemPrompt } from "../mind/prompt-refresh"
import type { UsageData } from "../mind/context"
import { createCommandRegistry, registerDefaultCommands, parseSlashCommand, getToolChoiceRequired } from "./commands"
import { getAgentName, setAgentName, getAgentRoot, loadAgentConfig } from "../heart/identity"
import { createTraceId } from "../nerves"
import { FileFriendStore } from "../mind/friends/store-file"
import { FriendResolver } from "../mind/friends/resolver"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import type { ToolContext } from "../repertoire/tools"
import { configureCliRuntimeLogger } from "../nerves/cli-logging"
import { emitNervesEvent } from "../nerves/runtime"
import { enforceTrustGate } from "./trust-gate"
import { acquireSessionLock, SessionLockError } from "./session-lock"

// readline.Interface exposes undocumented mutable line/cursor for in-progress input
type ReadlineInternals = readline.Interface & { line: string; cursor: number }

// spinner that only touches stderr, cleans up after itself
// exported for direct testability (stop-without-start branch)
export class Spinner {
  private frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"]
  private i = 0
  private iv: NodeJS.Timeout | null = null
  private piv: NodeJS.Timeout | null = null
  private msg = ""
  private phrases: readonly string[] | null = null
  private lastPhrase = ""

  constructor(m = "working", phrases?: readonly string[]) {
    this.msg = m
    if (phrases && phrases.length > 0) this.phrases = phrases
  }

  start() {
    process.stderr.write("\r\x1b[K")
    this.spin()
    this.iv = setInterval(() => this.spin(), 80)
    if (this.phrases) {
      this.piv = setInterval(() => this.rotatePhrase(), 1500)
    }
  }

  private spin() {
    process.stderr.write(`\r${this.frames[this.i]} ${this.msg}... `)
    this.i = (this.i + 1) % this.frames.length
  }

  private rotatePhrase() {
    const next = pickPhrase(this.phrases!, this.lastPhrase)
    this.lastPhrase = next
    this.msg = next
  }

  stop(ok?: string) {
    if (this.iv) { clearInterval(this.iv); this.iv = null }
    if (this.piv) { clearInterval(this.piv); this.piv = null }
    process.stderr.write("\r\x1b[K")
    /* v8 ignore next -- ok parameter currently unused by callers @preserve */
    if (ok) process.stderr.write(`\x1b[32m\u2713\x1b[0m ${ok}\n`)
  }

  fail(msg: string) {
    this.stop()
    process.stderr.write(`\x1b[31m\u2717\x1b[0m ${msg}\n`)
  }
}

// Input controller: pauses readline during model/tool execution.
// Does NOT touch raw mode — readline with terminal:true manages raw mode
// internally. Touching it causes ^C to be echoed by the terminal driver.
// During suppress, we consume stdin data ourselves to swallow stray
// keystrokes and catch Ctrl-C (0x03) for interrupt.
export class InputController {
  private rl: readline.Interface
  private suppressed = false
  private dataHandler: ((data: Buffer) => void) | null = null
  private onInterrupt: (() => void) | null = null

  constructor(rl: readline.Interface) {
    this.rl = rl
  }

  suppress(onInterrupt?: () => void) {
    if (this.suppressed) return
    this.suppressed = true
    this.onInterrupt = onInterrupt || null
    this.rl.pause()
    // Consume stdin to swallow keystrokes; catch Ctrl-C (0x03)
    this.dataHandler = (data: Buffer) => {
      if (data[0] === 0x03 && this.onInterrupt) {
        this.onInterrupt()
      }
      // All other input is swallowed
    }
    process.stdin.on("data", this.dataHandler)
    // rl.pause() paused stdin — resume it so our data handler receives keypresses
    process.stdin.resume()
  }

  restore() {
    if (!this.suppressed) return
    this.suppressed = false
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler)
      this.dataHandler = null
    }
    this.onInterrupt = null
    this.rl.resume()
  }
}

// Ctrl-C handling: returns "clear" if input was non-empty, "warn" on first empty press, "exit" on second
let _ctrlCWarned = false

export function handleSigint(_rl: readline.Interface, currentInput: string): "clear" | "warn" | "exit" {
  if (currentInput.length > 0) {
    _ctrlCWarned = false
    return "clear"
  }
  if (_ctrlCWarned) {
    _ctrlCWarned = false
    return "exit"
  }
  _ctrlCWarned = true
  return "warn"
}

// History management
export function addHistory(history: string[], entry: string): void {
  if (!entry.trim()) return
  if (history.length > 0 && history[history.length - 1] === entry) return
  history.push(entry)
}

export function renderMarkdown(text: string): string {
  const placeholders: string[] = []
  // Protect fenced code blocks
  let result = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_m, code: string) => {
    const idx = placeholders.length
    placeholders.push(`\x1b[2m${code.replace(/\n$/, "")}\x1b[22m`)
    return `\x00${idx}\x00`
  })
  // Protect inline code
  result = result.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = placeholders.length
    placeholders.push(`\x1b[36m${code}\x1b[39m`)
    return `\x00${idx}\x00`
  })
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m")
  // Italic (avoid matching inside bold remnants)
  result = result.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, "\x1b[3m$1\x1b[23m")
  // Restore placeholders
  result = result.replace(/\x00(\d+)\x00/g, (_m, idx: string) => placeholders[parseInt(idx)])
  return result
}

// Ordered longest-first so we match ``` before ` and ** before *
const MARKERS = ["```", "**", "*", "`"] as const

export class MarkdownStreamer {
  private buf = ""
  private openMarker: string | null = null

  push(text: string): string {
    this.buf += text
    return this.drain(false)
  }

  flush(): string {
    return this.drain(true)
  }

  reset(): void {
    this.buf = ""
    this.openMarker = null
  }

  private drain(final: boolean): string {
    let out = ""

    while (this.buf.length > 0) {
      if (this.openMarker) {
        const closeIdx = this.buf.indexOf(this.openMarker)
        if (closeIdx !== -1) {
          const segment = this.openMarker + this.buf.slice(0, closeIdx + this.openMarker.length)
          out += renderMarkdown(segment)
          this.buf = this.buf.slice(closeIdx + this.openMarker.length)
          this.openMarker = null
          continue
        }
        if (final) {
          out += renderMarkdown(this.openMarker + this.buf)
          this.buf = ""
          this.openMarker = null
        }
        break
      }

      // Normal mode — look for the next opening marker
      let earliest = -1
      let matched: string | null = null
      for (const m of MARKERS) {
        const idx = this.buf.indexOf(m)
        if (idx !== -1 && (earliest === -1 || idx < earliest)) {
          earliest = idx
          matched = m
        }
      }

      if (matched !== null && earliest !== -1) {
        // If the tail from the match to end-of-buffer is a proper prefix of a
        // longer marker, hold it back rather than consuming it prematurely.
        // E.g. a trailing `*` could be the start of `**`, trailing `` ` `` could be `` ``` ``.
        const tail = this.buf.slice(earliest)
        if (!final && MARKERS.some(m => m.length > tail.length && m.startsWith(tail))) {
          if (earliest > 0) {
            out += renderMarkdown(this.buf.slice(0, earliest))
            this.buf = this.buf.slice(earliest)
          }
          break
        }
        if (earliest > 0) {
          out += renderMarkdown(this.buf.slice(0, earliest))
        }
        this.buf = this.buf.slice(earliest + matched.length)
        this.openMarker = matched
        continue
      }

      out += renderMarkdown(this.buf)
      this.buf = ""
      break
    }

    return out
  }
}

export function createCliCallbacks(): ChannelCallbacks & { flushMarkdown(): void } {
  emitNervesEvent({
    component: "senses",
    event: "senses.cli_callbacks_created",
    message: "cli callbacks created",
    meta: {},
  })
  let currentSpinner: Spinner | null = null
  let hadReasoning = false
  let hadToolRun = false
  let textDirty = false // true when text/reasoning was written without a trailing newline
  const streamer = new MarkdownStreamer()

  return {
    onModelStart: () => {
      currentSpinner?.stop()
      currentSpinner = null
      hadReasoning = false
      textDirty = false
      streamer.reset()
      const phrases = getPhrases()
      const pool = hadToolRun ? phrases.followup : phrases.thinking
      const first = pickPhrase(pool)
      currentSpinner = new Spinner(first, pool)
      currentSpinner.start()
    },
    onModelStreamStart: () => {
      currentSpinner?.stop()
      currentSpinner = null
    },
    onTextChunk: (text: string) => {
      if (hadReasoning) {
        process.stdout.write("\n\n")
        hadReasoning = false
      }
      const rendered = streamer.push(text)
      if (rendered) process.stdout.write(rendered)
      textDirty = text.length > 0 && !text.endsWith("\n")
    },
    onReasoningChunk: (text: string) => {
      hadReasoning = true
      process.stdout.write(`\x1b[2m${text}\x1b[0m`)
      textDirty = text.length > 0 && !text.endsWith("\n")
    },
    onToolStart: (_name: string, _args: Record<string, string>) => {
      // Stop the model-start spinner: when the model returns only tool calls
      // (no content/reasoning), onModelStreamStart never fires, so the old
      // spinner's intervals would leak.
      currentSpinner?.stop()
      // Ensure the spinner starts on a fresh line so it doesn't overwrite
      // the last line of text/reasoning output via \r\x1b[K
      if (textDirty) {
        process.stdout.write("\n")
        textDirty = false
      }
      const toolPhrases = getPhrases().tool
      const first = pickPhrase(toolPhrases)
      currentSpinner = new Spinner(first, toolPhrases)
      currentSpinner.start()
      hadToolRun = true
    },
    onToolEnd: (name: string, argSummary: string, success: boolean) => {
      currentSpinner?.stop()
      currentSpinner = null
      const msg = formatToolResult(name, argSummary, success)
      const color = success ? "\x1b[32m" : "\x1b[31m"
      process.stderr.write(`${color}${msg}\x1b[0m\n`)
    },
    onError: (error: Error, severity: "transient" | "terminal") => {
      if (severity === "transient") {
        currentSpinner?.fail(error.message)
        currentSpinner = null
      } else {
        currentSpinner?.stop()
        currentSpinner = null
        process.stderr.write(`\x1b[31m${formatError(error)}\x1b[0m\n`)
      }
    },
    onKick: () => {
      currentSpinner?.stop()
      currentSpinner = null
      if (textDirty) {
        process.stdout.write("\n")
        textDirty = false
      }
      process.stderr.write(`\x1b[33m${formatKick()}\x1b[0m\n`)
    },
    flushMarkdown: () => {
      currentSpinner?.stop()
      currentSpinner = null
      const remaining = streamer.flush()
      if (remaining) process.stdout.write(remaining)
    },
  }
}

export interface RunCliSessionOptions {
  agentName: string;
  tools?: OpenAI.ChatCompletionFunctionTool[];
  execTool?: (name: string, args: Record<string, string>, ctx?: ToolContext) => Promise<string>;
  toolChoiceRequired?: boolean;
  exitOnToolCall?: string;
  pasteDebounceMs?: number;
  /** Pre-built messages to start the session with (skips buildSystem if provided) */
  messages?: OpenAI.ChatCompletionMessageParam[];
}

export interface RunCliSessionResult {
  exitReason: "final_answer" | "tool_exit" | "user_quit";
  toolResult?: unknown;
}

export async function runCliSession(options: RunCliSessionOptions): Promise<RunCliSessionResult> {
  const pasteDebounceMs = options.pasteDebounceMs ?? 50

  const registry = createCommandRegistry()
  registerDefaultCommands(registry)

  const messages: OpenAI.ChatCompletionMessageParam[] = options.messages
    ? [...options.messages]
    : [{ role: "system", content: await buildSystem("cli") }]

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const ctrl = new InputController(rl)
  let currentAbort: AbortController | null = null
  const history: string[] = []
  let closed = false
  rl.on("close", () => { closed = true })

  // eslint-disable-next-line no-console -- terminal UX: startup banner
  console.log(`\n${options.agentName} (type /commands for help)\n`)

  const cliCallbacks = createCliCallbacks()

  // exitOnToolCall machinery: wrap execTool to detect target tool
  let exitToolResult: unknown | undefined
  let exitToolFired = false
  const resolvedExecTool = options.execTool
  const wrappedExecTool = options.exitOnToolCall && resolvedExecTool
    ? async (name: string, args: Record<string, string>, ctx?: ToolContext): Promise<string> => {
        const result = await resolvedExecTool(name, args, ctx)
        if (name === options.exitOnToolCall) {
          exitToolResult = result
          exitToolFired = true
        }
        return result
      }
    : resolvedExecTool

  // Resolve toolChoiceRequired: use explicit option if set, else fall back to toggle
  const getEffectiveToolChoiceRequired = () =>
    options.toolChoiceRequired !== undefined ? options.toolChoiceRequired : getToolChoiceRequired()

  process.stdout.write("\x1b[36m> \x1b[0m")

  // Ctrl-C at the input prompt: clear line or warn/exit
  rl.on("SIGINT", () => {
    const rlInt = rl as ReadlineInternals
    const currentLine = rlInt.line || ""
    const result = handleSigint(rl, currentLine)
    if (result === "clear") {
      rlInt.line = "";
      rlInt.cursor = 0
      process.stdout.write("\r\x1b[K\x1b[36m> \x1b[0m")
    } else if (result === "warn") {
      rlInt.line = "";
      rlInt.cursor = 0
      process.stdout.write("\r\x1b[K")
      process.stderr.write("press Ctrl-C again to exit\n")
      process.stdout.write("\x1b[36m> \x1b[0m")
    } else {
      rl.close()
    }
  })

  // Debounced line iterator: collects rapid-fire lines (paste) into a single input
  async function* debouncedLines(source: AsyncIterable<string>): AsyncGenerator<string> {
    if (pasteDebounceMs <= 0) {
      yield* source
      return
    }
    const iter = source[Symbol.asyncIterator]()
    while (true) {
      const first = await iter.next()
      if (first.done) break
      const lines = [first.value]
      let more = true
      while (more) {
        const raced = await Promise.race([
          iter.next().then((r) => ({ kind: "line" as const, result: r })),
          new Promise<{ kind: "timeout" }>((r) => setTimeout(() => r({ kind: "timeout" }), pasteDebounceMs)),
        ])
        if (raced.kind === "timeout") {
          more = false
        } else if (raced.result.done) {
          more = false
        } else {
          lines.push(raced.result.value)
        }
      }
      yield lines.join("\n")
    }
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.cli_session_start",
    message: "runCliSession started",
    meta: { agentName: options.agentName, hasExitOnToolCall: !!options.exitOnToolCall },
  })

  let exitReason: RunCliSessionResult["exitReason"] = "user_quit"

  try {
    for await (const input of debouncedLines(rl)) {
      if (closed) break
      if (!input.trim()) { process.stdout.write("\x1b[36m> \x1b[0m"); continue }

      // Check for slash commands
      const parsed = parseSlashCommand(input)
      if (parsed) {
        const dispatchResult = registry.dispatch(parsed.command, { channel: "cli" })
        if (dispatchResult.handled && dispatchResult.result) {
          if (dispatchResult.result.action === "exit") {
            break
          } else if (dispatchResult.result.action === "new") {
            messages.length = 0
            messages.push({ role: "system", content: await buildSystem("cli") })
            // eslint-disable-next-line no-console -- terminal UX: session cleared
            console.log("session cleared")
            process.stdout.write("\x1b[36m> \x1b[0m")
            continue
          } else if (dispatchResult.result.action === "response") {
            // eslint-disable-next-line no-console -- terminal UX: command dispatch result
            console.log(dispatchResult.result.message || "")
            process.stdout.write("\x1b[36m> \x1b[0m")
            continue
          }
        }
      }

      // Re-style the echoed input lines
      const cols = process.stdout.columns || 80
      const inputLines = input.split("\n")
      let echoRows = 0
      for (const line of inputLines) {
        echoRows += Math.ceil((2 + line.length) / cols)
      }
      process.stdout.write(`\x1b[${echoRows}A\x1b[K` + `\x1b[1m> ${inputLines[0]}${inputLines.length > 1 ? ` (+${inputLines.length - 1} lines)` : ""}\x1b[0m\n\n`)

      messages.push({ role: "user", content: input })
      addHistory(history, input)

      currentAbort = new AbortController()
      const traceId = createTraceId()
      ctrl.suppress(() => currentAbort!.abort())
      try {
        await runAgent(messages, cliCallbacks, "cli", currentAbort.signal, {
          toolChoiceRequired: getEffectiveToolChoiceRequired(),
          traceId,
          tools: options.tools,
          execTool: wrappedExecTool,
        })
      } catch {
        // AbortError -- silently return to prompt
      }
      cliCallbacks.flushMarkdown()
      ctrl.restore()
      currentAbort = null

      // Check if exit tool was fired during this turn
      if (exitToolFired) {
        exitReason = "tool_exit"
        break
      }

      // Safety net: never silently swallow an empty response
      const lastMsg = messages[messages.length - 1]
      if (lastMsg?.role === "assistant" && !(typeof lastMsg.content === "string" ? lastMsg.content : "").trim()) {
        process.stderr.write("\x1b[33m(empty response)\x1b[0m\n")
      }

      process.stdout.write("\n\n")

      if (closed) break
      process.stdout.write("\x1b[36m> \x1b[0m")
    }
  } finally {
    rl.close()
    // eslint-disable-next-line no-console -- terminal UX: goodbye
    console.log("bye")
  }

  return { exitReason, toolResult: exitToolResult }
}

export async function main(agentName?: string, options?: { pasteDebounceMs?: number }) {
  if (agentName) setAgentName(agentName)
  const pasteDebounceMs = options?.pasteDebounceMs ?? 50

  // Fail fast if provider is misconfigured (triggers human-readable error + exit)
  getProvider()

  // Resolve context kernel (identity + channel) for CLI
  const friendsPath = path.join(getAgentRoot(), "friends")
  const friendStore = new FileFriendStore(friendsPath)
  const username = os.userInfo().username
  const hostname = os.hostname()
  const localExternalId = `${username}@${hostname}`
  const resolver = new FriendResolver(friendStore, {
    provider: "local" as const,
    externalId: localExternalId,
    displayName: username,
    channel: "cli",
  })
  const resolvedContext = await resolver.resolve()
  const cliToolContext: ToolContext = {
    /* v8 ignore next -- CLI has no OAuth sign-in; this no-op satisfies the interface @preserve */
    signin: async () => undefined,
    context: resolvedContext,
    friendStore,
    summarize: createSummarize(),
  }

  const friendId = resolvedContext.friend.id
  const agentConfig = loadAgentConfig()
  configureCliRuntimeLogger(friendId, {
    level: agentConfig.logging?.level,
    sinks: agentConfig.logging?.sinks,
  })
  const sessPath = sessionPath(friendId, "cli", "session")

  let sessionLock: { release: () => void } | null = null
  try {
    sessionLock = acquireSessionLock(`${sessPath}.lock`, getAgentName())
  } catch (error) {
    /* v8 ignore start -- integration: main() is interactive, lock tested in session-lock.test.ts @preserve */
    if (error instanceof SessionLockError) {
      process.stderr.write(`${error.message}\n`)
      return
    }
    throw error
    /* v8 ignore stop */
  }

  // Load existing session or start fresh
  const existing = loadSession(sessPath)
  const sessionMessages: OpenAI.ChatCompletionMessageParam[] = existing?.messages && existing.messages.length > 0
    ? existing.messages
    : [{ role: "system", content: await buildSystem("cli", undefined, resolvedContext) }]

  // Pending queue drain: inject pending messages as harness-context + assistant-content pairs
  const pendingDir = getPendingDir(getAgentName(), friendId, "cli", "session")
  const drainToMessages = () => {
    const pending = drainPending(pendingDir)
    if (pending.length === 0) return 0
    for (const msg of pending) {
      sessionMessages.push({ role: "user", name: "harness", content: `[proactive message from ${msg.from}]` })
      sessionMessages.push({ role: "assistant", content: msg.content })
    }
    return pending.length
  }

  // Startup drain: deliver offline messages
  const startupCount = drainToMessages()
  if (startupCount > 0) {
    saveSession(sessPath, sessionMessages)
  }

  // Note: main() does NOT use runCliSession because it has additional
  // session management, trust gate, and pending drain concerns that are
  // specific to the standard agent flow. runCliSession is designed for
  // simpler use cases like the adoption specialist.

  const registry = createCommandRegistry()
  registerDefaultCommands(registry)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const ctrl = new InputController(rl)
  let currentAbort: AbortController | null = null
  const history: string[] = []
  let closed = false
  rl.on("close", () => { closed = true })

  // eslint-disable-next-line no-console -- terminal UX: startup banner
  console.log(`\n${getAgentName()} (type /commands for help)\n`)

  const cliCallbacks = createCliCallbacks()

  process.stdout.write("\x1b[36m> \x1b[0m")

  // Ctrl-C at the input prompt: clear line or warn/exit
  // readline with terminal:true catches Ctrl-C in raw mode (no ^C echo)
  rl.on("SIGINT", () => {
    const rlInt = rl as ReadlineInternals
    const currentLine = rlInt.line || ""
    const result = handleSigint(rl, currentLine)
    if (result === "clear") {
      rlInt.line = "";
      rlInt.cursor = 0
      process.stdout.write("\r\x1b[K\x1b[36m> \x1b[0m")
    } else if (result === "warn") {
      rlInt.line = "";
      rlInt.cursor = 0
      process.stdout.write("\r\x1b[K")
      process.stderr.write("press Ctrl-C again to exit\n")
      process.stdout.write("\x1b[36m> \x1b[0m")
    } else {
      rl.close()
    }
  })

  // Debounced line iterator: collects rapid-fire lines (paste) into a single input
  async function* debouncedLines(source: AsyncIterable<string>): AsyncGenerator<string> {
    if (pasteDebounceMs <= 0) {
      yield* source
      return
    }
    const iter = source[Symbol.asyncIterator]()
    while (true) {
      const first = await iter.next()
      if (first.done) break
      // Collect any lines that arrive within the debounce window (paste detection)
      const lines = [first.value]
      let more = true
      while (more) {
        const raced = await Promise.race([
          iter.next().then((r) => ({ kind: "line" as const, result: r })),
          new Promise<{ kind: "timeout" }>((r) => setTimeout(() => r({ kind: "timeout" }), pasteDebounceMs)),
        ])
        if (raced.kind === "timeout") {
          more = false
        } else if (raced.result.done) {
          more = false
        } else {
          lines.push(raced.result.value)
        }
      }
      yield lines.join("\n")
    }
  }

  try {
    for await (const input of debouncedLines(rl)) {
      if (closed) break
      if (!input.trim()) { process.stdout.write("\x1b[36m> \x1b[0m"); continue }

      const trustGate = enforceTrustGate({
        friend: resolvedContext.friend,
        provider: "local",
        externalId: localExternalId,
        channel: "cli",
      })
      if (!trustGate.allowed) {
        if (trustGate.reason === "stranger_first_reply") {
          process.stdout.write(`${trustGate.autoReply}\n`)
        }
        if (closed) break
        process.stdout.write("\x1b[36m> \x1b[0m")
        continue
      }

      // Check for slash commands
      const parsed = parseSlashCommand(input)
      if (parsed) {
        const dispatchResult = registry.dispatch(parsed.command, { channel: "cli" })
        if (dispatchResult.handled && dispatchResult.result) {
          if (dispatchResult.result.action === "exit") {
            break
          } else if (dispatchResult.result.action === "new") {
            sessionMessages.length = 0
            sessionMessages.push({ role: "system", content: await buildSystem("cli") })
            deleteSession(sessPath)
            // eslint-disable-next-line no-console -- terminal UX: session cleared
            console.log("session cleared")
            process.stdout.write("\x1b[36m> \x1b[0m")
            continue
          } else if (dispatchResult.result.action === "response") {
            // eslint-disable-next-line no-console -- terminal UX: command dispatch result
            console.log(dispatchResult.result.message || "")
            process.stdout.write("\x1b[36m> \x1b[0m")
            continue
          }
        }
      }

      // Re-style the echoed input lines (readline terminal:true echoes each line)
      // For multiline paste, each line was echoed separately — erase them all
      const cols = process.stdout.columns || 80
      const inputLines = input.split("\n")
      let echoRows = 0
      for (const line of inputLines) {
        echoRows += Math.ceil((2 + line.length) / cols) // "> " prefix + line content
      }
      process.stdout.write(`\x1b[${echoRows}A\x1b[K` + `\x1b[1m> ${inputLines[0]}${inputLines.length > 1 ? ` (+${inputLines.length - 1} lines)` : ""}\x1b[0m\n\n`)

      sessionMessages.push({ role: "user", content: input })
      addHistory(history, input)

      currentAbort = new AbortController()
      const traceId = createTraceId()
      ctrl.suppress(() => currentAbort!.abort())
      let result: { usage?: UsageData } | undefined
      try {
        result = await runAgent(sessionMessages, cliCallbacks, "cli", currentAbort.signal, {
          toolChoiceRequired: getToolChoiceRequired(),
          toolContext: cliToolContext,
          traceId,
        })
      } catch {
        // AbortError — silently return to prompt
      }
      cliCallbacks.flushMarkdown()
      ctrl.restore()
      currentAbort = null

      // Safety net: never silently swallow an empty response
      const lastMsg = sessionMessages[sessionMessages.length - 1]
      if (lastMsg?.role === "assistant" && !(typeof lastMsg.content === "string" ? lastMsg.content : "").trim()) {
        process.stderr.write("\x1b[33m(empty response)\x1b[0m\n")
      }

      process.stdout.write("\n\n")

      postTurn(sessionMessages, sessPath, result?.usage)
      await accumulateFriendTokens(friendStore, resolvedContext.friend.id, result?.usage)

      // Post-turn: drain any pending messages that arrived during runAgent
      drainToMessages()

      // Post-turn: refresh system prompt so active sessions metadata is current
      await refreshSystemPrompt(sessionMessages, "cli", undefined, resolvedContext)

      if (closed) break
      process.stdout.write("\x1b[36m> \x1b[0m")
    }
  } finally {
    sessionLock?.release()
    rl.close()
    // eslint-disable-next-line no-console -- terminal UX: goodbye
    console.log("bye")
  }
}
