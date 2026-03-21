import OpenAI from "openai"
import * as readline from "readline"
import * as os from "os"
import * as path from "path"
import { runAgent, ChannelCallbacks, getProvider, createSummarize } from "../heart/core"
import { buildSystem } from "../mind/prompt"
import { pickPhrase, getPhrases } from "../mind/phrases"
import { formatToolResult, formatKick, formatError } from "../mind/format"
import { sessionPath } from "../heart/config"
import { loadSession, deleteSession, postTurn } from "../mind/context"
import { getPendingDir, drainDeferredReturns, drainPending, type PendingMessage } from "../mind/pending"
// refreshSystemPrompt removed: runAgent already handles prompt refresh per-turn
import type { UsageData } from "../mind/context"
import { createCommandRegistry, registerDefaultCommands, parseSlashCommand, getToolChoiceRequired } from "./commands"
import { getAgentName, setAgentName, getAgentRoot, getAgentBundlesRoot, loadAgentConfig } from "../heart/identity"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { createTraceId, registerSpinnerHooks } from "../nerves"
import { FileFriendStore } from "../mind/friends/store-file"
import { FriendResolver } from "../mind/friends/resolver"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import type { ToolContext } from "../repertoire/tools"
import { configureCliRuntimeLogger } from "../nerves/cli-logging"
import { emitNervesEvent } from "../nerves/runtime"
import { enforceTrustGate } from "./trust-gate"
import { handleInboundTurn } from "./pipeline"
import { getChannelCapabilities } from "../mind/friends/channel"
import { acquireSessionLock, SessionLockError } from "./session-lock"
import { applyPendingUpdates, registerUpdateHook } from "../heart/daemon/update-hooks"
import { bundleMetaHook } from "../heart/daemon/hooks/bundle-meta"
import { getPackageVersion } from "../mind/bundle-manifest"
import { formatEchoedInputSummary, StreamingWordWrapper } from "./cli-layout"

export { formatEchoedInputSummary, wrapCliText, StreamingWordWrapper } from "./cli-layout"

/**
 * Format pending messages as content-prefix strings for injection into
 * the next user message. Self-messages (from === agentName) become
 * `[inner thought: {content}]`, inter-agent messages become
 * `[message from {name}: {content}]`.
 */
export function formatPendingPrefix(messages: PendingMessage[], agentName: string): string {
  return messages
    .map((msg) =>
      msg.from === agentName
        ? `[inner thought: ${msg.content}]`
        : `[message from ${msg.from}: ${msg.content}]`,
    )
    .join("\n")
}

export function getCliContinuityIngressTexts(input: string): string[] {
  const trimmed = input.trim()
  return trimmed ? [trimmed] : []
}

// readline.Interface exposes undocumented mutable line/cursor for in-progress input
type ReadlineInternals = readline.Interface & { line: string; cursor: number }

// Module-level active spinner for log coordination.
// The terminal log sink calls these to avoid interleaving with spinner output.
let _activeSpinner: Spinner | null = null
/* v8 ignore start -- spinner coordination: exercised at runtime, not unit-testable without real terminal @preserve */
export function pauseActiveSpinner(): void { _activeSpinner?.pause() }
export function resumeActiveSpinner(): void { _activeSpinner?.resume() }
/* v8 ignore stop */
export function setActiveSpinner(s: Spinner | null): void { _activeSpinner = s }

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
  private stopped = false

  constructor(m = "working", phrases?: readonly string[]) {
    this.msg = m
    if (phrases && phrases.length > 0) this.phrases = phrases
  }

  start() {
    this.stopped = false
    process.stderr.write("\r\x1b[K")
    this.spin()
    this.iv = setInterval(() => this.spin(), 80)
    if (this.phrases) {
      this.piv = setInterval(() => this.rotatePhrase(), 1500)
    }
  }

  private spin() {
    // Guard: clearInterval can't prevent already-dequeued callbacks
    /* v8 ignore next -- race guard: timer callback fires after stop() @preserve */
    if (this.stopped) return
    process.stderr.write(`\r\x1b[K${this.frames[this.i]} ${this.msg}... `)
    this.i = (this.i + 1) % this.frames.length
  }

  private rotatePhrase() {
    /* v8 ignore next -- race guard: timer callback fires after stop() @preserve */
    if (this.stopped) return
    const next = pickPhrase(this.phrases!, this.lastPhrase)
    this.lastPhrase = next
    this.msg = next
  }

  /* v8 ignore start -- pause/resume: exercised at runtime via log sink coordination @preserve */
  /** Clear the spinner line temporarily so other output can print cleanly. */
  pause() {
    if (this.stopped) return
    process.stderr.write("\r\x1b[K")
  }

  /** Restore the spinner line after a pause. */
  resume() {
    if (this.stopped) return
    this.spin()
  }
  /* v8 ignore stop */

  stop(ok?: string) {
    this.stopped = true
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
  function setSpinner(s: Spinner | null) { currentSpinner = s; setActiveSpinner(s) }
  let hadToolRun = false
  let textDirty = false // true when text/reasoning was written without a trailing newline
  const streamer = new MarkdownStreamer()
  const wrapper = new StreamingWordWrapper()

  return {
    onModelStart: () => {
      currentSpinner?.stop()
      setSpinner(null)
      textDirty = false
      streamer.reset()
      wrapper.reset()
      const phrases = getPhrases()
      const pool = hadToolRun ? phrases.followup : phrases.thinking
      const first = pickPhrase(pool)
      setSpinner(new Spinner(first, pool))
      currentSpinner!.start()
    },
    onModelStreamStart: () => {
      // No-op: content callbacks (onTextChunk, onReasoningChunk) handle
      // stopping the spinner. onModelStreamStart fires too early and
      // doesn't fire at all for final_answer tool streaming.
    },
    onClearText: () => {
      streamer.reset()
      wrapper.reset()
    },
    onTextChunk: (text: string) => {
      // Stop spinner if still running — final_answer streaming and Anthropic
      // tool-only responses bypass onModelStreamStart, so the spinner would
      // otherwise keep running (and its \r writes overwrite response text).
      if (currentSpinner) {
        currentSpinner.stop()
        setSpinner(null)
      }
      const rendered = streamer.push(text)
      /* v8 ignore start -- wrapper integration: tested via cli.test.ts onTextChunk tests @preserve */
      if (rendered) {
        const wrapped = wrapper.push(rendered)
        if (wrapped) process.stdout.write(wrapped)
      }
      /* v8 ignore stop */
      textDirty = text.length > 0 && !text.endsWith("\n")
    },
    onReasoningChunk: (_text: string) => {
      // Keep reasoning private in the CLI surface. The spinner continues to
      // represent active thinking until actual tool or answer output arrives.
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
      setSpinner(new Spinner(first, toolPhrases))
      currentSpinner!.start()
      hadToolRun = true
    },
    onToolEnd: (name: string, argSummary: string, success: boolean) => {
      currentSpinner?.stop()
      setSpinner(null)
      const msg = formatToolResult(name, argSummary, success)
      const color = success ? "\x1b[32m" : "\x1b[31m"
      process.stderr.write(`${color}${msg}\x1b[0m\n`)
    },
    onError: (error: Error, severity: "transient" | "terminal") => {
      if (severity === "transient") {
        currentSpinner?.fail(error.message)
        setSpinner(null)
      } else {
        currentSpinner?.stop()
        setSpinner(null)
        process.stderr.write(`\x1b[31m${formatError(error)}\x1b[0m\n`)
      }
    },
    onKick: () => {
      currentSpinner?.stop()
      setSpinner(null)
      if (textDirty) {
        process.stdout.write("\n")
        textDirty = false
      }
      process.stderr.write(`\x1b[33m${formatKick()}\x1b[0m\n`)
    },
    flushMarkdown: () => {
      currentSpinner?.stop()
      setSpinner(null)
      /* v8 ignore start -- wrapper flush: tested via cli.test.ts flushMarkdown tests @preserve */
      const remaining = streamer.flush()
      if (remaining) {
        const wrapped = wrapper.push(remaining)
        if (wrapped) process.stdout.write(wrapped)
      }
      const tail = wrapper.flush()
      if (tail) process.stdout.write(tail)
      /* v8 ignore stop */
    },
  }
}

// Debounced line iterator: collects rapid-fire lines (paste) into a single input.
// When the debounce timeout wins the race, the pending iter.next() is saved
// and reused in the next iteration to prevent it from silently consuming input.
export async function* createDebouncedLines(source: AsyncIterable<string>, debounceMs: number): AsyncGenerator<string> {
  if (debounceMs <= 0) {
    yield* source
    return
  }
  const iter = source[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<string>> | null = null
  while (true) {
    const first = pending ? await pending : await iter.next()
    pending = null
    if (first.done) break
    const lines = [first.value]
    let more = true
    while (more) {
      const nextPromise = iter.next()
      const raced = await Promise.race([
        nextPromise.then((r) => ({ kind: "line" as const, result: r })),
        new Promise<{ kind: "timeout" }>((r) => setTimeout(() => r({ kind: "timeout" }), debounceMs)),
      ])
      if (raced.kind === "timeout") {
        pending = nextPromise
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

export interface RunCliSessionOptions {
  agentName: string;
  tools?: OpenAI.ChatCompletionFunctionTool[];
  execTool?: (name: string, args: Record<string, string>, ctx?: ToolContext) => Promise<string>;
  toolChoiceRequired?: boolean;
  exitOnToolCall?: string;
  pasteDebounceMs?: number;
  /** Pre-built messages to start the session with (skips buildSystem if provided) */
  messages?: OpenAI.ChatCompletionMessageParam[];
  /** ToolContext passed through to runAgent */
  toolContext?: ToolContext;
  /** Called before processing each input line. Return allowed:false to skip the turn. */
  onInput?: (input: string) => { allowed: boolean; reply?: string };
  /** Called after each agent turn completes (post-runAgent). */
  onTurnEnd?: (messages: OpenAI.ChatCompletionMessageParam[], result: { usage?: UsageData }) => void | Promise<void>;
  /** Called when /new command resets the session. */
  onNewSession?: () => void | Promise<void>;
  /** If true, auto-process the last user message before waiting for input (e.g. specialist greeting). */
  autoFirstTurn?: boolean;
  /** Custom banner shown at session start. Set to false to suppress entirely. */
  banner?: string | false;
  /** If true, slash commands are disabled (input always goes to the agent). */
  disableCommands?: boolean;
  /** If true, skip system prompt refresh in runAgent (use provided messages[0] as-is). */
  skipSystemPromptRefresh?: boolean;
  /** Returns and clears pending content prefix to prepend to the next user message. */
  getContentPrefix?: () => string | undefined;
  /** Custom turn handler. When provided, replaces the internal runAgent call.
   *  The handler receives the messages array (by reference), user input, callbacks,
   *  signal, and options. It is responsible for calling runAgent (or pipeline). */
  runTurn?: (
    messages: OpenAI.ChatCompletionMessageParam[],
    userInput: string,
    callbacks: ChannelCallbacks & { flushMarkdown(): void },
    signal?: AbortSignal,
  ) => Promise<{ usage?: UsageData }>;
}

export interface RunCliSessionResult {
  exitReason: "final_answer" | "tool_exit" | "user_quit";
  toolResult?: unknown;
}

export async function runCliSession(options: RunCliSessionOptions): Promise<RunCliSessionResult> {
  /* v8 ignore start -- integration: runCliSession is interactive, tested via E2E @preserve */
  const pasteDebounceMs = options.pasteDebounceMs ?? 50

  const registry = createCommandRegistry()
  if (!options.disableCommands) {
    registerDefaultCommands(registry)
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = options.messages
    ?? [{ role: "system", content: await buildSystem("cli") }]

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const ctrl = new InputController(rl)
  let currentAbort: AbortController | null = null
  const history: string[] = []
  let closed = false
  rl.on("close", () => { closed = true })

  if (options.banner !== false) {
    const bannerText = typeof options.banner === "string"
      ? options.banner
      : `${options.agentName} (type /commands for help)`
    // eslint-disable-next-line no-console -- terminal UX: startup banner
    console.log(`\n${bannerText}\n`)
  }

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
          // Abort immediately so the model doesn't generate more output
          // (e.g. reasoning about calling final_answer after complete_adoption)
          currentAbort?.abort()
        }
        return result
      }
    : resolvedExecTool

  // Resolve toolChoiceRequired: use explicit option if set, else fall back to toggle
  const getEffectiveToolChoiceRequired = () =>
    options.toolChoiceRequired !== undefined ? options.toolChoiceRequired : getToolChoiceRequired()

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

  const debouncedLines = (source: AsyncIterable<string>) => createDebouncedLines(source, pasteDebounceMs)

  emitNervesEvent({
    component: "senses",
    event: "senses.cli_session_start",
    message: "runCliSession started",
    meta: { agentName: options.agentName, hasExitOnToolCall: !!options.exitOnToolCall },
  })

  let exitReason: RunCliSessionResult["exitReason"] = "user_quit"

  // Auto-first-turn: process the last user message immediately so the agent
  // speaks first (e.g. specialist greeting). Only triggers when explicitly opted in.
  if (options.autoFirstTurn && messages.length > 0 && messages[messages.length - 1]?.role === "user") {
    currentAbort = new AbortController()
    const traceId = createTraceId()
    ctrl.suppress(() => currentAbort!.abort())
    let result: { usage?: UsageData } | undefined
    try {
      result = await runAgent(messages, cliCallbacks, options.skipSystemPromptRefresh ? undefined : "cli", currentAbort.signal, {
        toolChoiceRequired: getEffectiveToolChoiceRequired(),
        traceId,
        tools: options.tools,
        execTool: wrappedExecTool,
        toolContext: options.toolContext,
      })
    } catch (err) {
      // AbortError (Ctrl-C) -- silently continue to prompt
      // All other errors: show the user what happened
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        process.stderr.write(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\n`)
      }
    }
    cliCallbacks.flushMarkdown()
    ctrl.restore()
    currentAbort = null

    if (exitToolFired) {
      exitReason = "tool_exit"
      rl.close()
    } else {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg?.role === "assistant" && !(typeof lastMsg.content === "string" ? lastMsg.content : "").trim()) {
        process.stderr.write("\x1b[33m(empty response)\x1b[0m\n")
      }
      process.stdout.write("\n\n")
      if (options.onTurnEnd) {
        await options.onTurnEnd(messages, result ?? { usage: undefined })
      }
    }
  }

  if (!exitToolFired) {
    process.stdout.write("\x1b[36m> \x1b[0m")
  }

  try {
    for await (const input of debouncedLines(rl)) {
      if (closed) break
      if (!input.trim()) { process.stdout.write("\x1b[36m> \x1b[0m"); continue }

      // Optional input gate (e.g. trust gate in main)
      if (options.onInput) {
        const gate = options.onInput(input)
        if (!gate.allowed) {
          if (gate.reply) {
            process.stdout.write(`${gate.reply}\n`)
          }
          if (closed) break
          process.stdout.write("\x1b[36m> \x1b[0m")
          continue
        }
      }

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
            await options.onNewSession?.()
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

      // Re-style the echoed input lines without leaving wrapped paste remnants behind.
      const cols = process.stdout.columns || 80
      process.stdout.write(formatEchoedInputSummary(input, cols))

      addHistory(history, input)

      currentAbort = new AbortController()
      ctrl.suppress(() => currentAbort!.abort())
      let result: { usage?: UsageData } | undefined
      try {
        if (options.runTurn) {
          // Pipeline-based turn: the runTurn callback handles user message assembly,
          // pending drain, trust gate, runAgent, postTurn, and token accumulation.
          result = await options.runTurn(messages, input, cliCallbacks, currentAbort.signal)
        } else {
          // Legacy path: inline runAgent (used by adoption specialist and tests)
          const prefix = options.getContentPrefix?.()
          messages.push({ role: "user", content: prefix ? `${prefix}\n\n${input}` : input })
          const traceId = createTraceId()
          result = await runAgent(messages, cliCallbacks, options.skipSystemPromptRefresh ? undefined : "cli", currentAbort.signal, {
            toolChoiceRequired: getEffectiveToolChoiceRequired(),
            traceId,
            tools: options.tools,
            execTool: wrappedExecTool,
            toolContext: options.toolContext,
          })
        }
      } catch (err) {
        // AbortError (Ctrl-C) -- silently return to prompt
        // All other errors: show the user what happened
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          process.stderr.write(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\n`)
        }
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

      // Post-turn hook (session persistence, pending drain, prompt refresh, etc.)
      if (options.onTurnEnd) {
        await options.onTurnEnd(messages, result ?? { usage: undefined })
      }

      if (closed) break
      process.stdout.write("\x1b[36m> \x1b[0m")
    }
  } finally {
    rl.close()
    if (options.banner !== false) {
      // eslint-disable-next-line no-console -- terminal UX: goodbye
      console.log("bye")
    }
  }

  /* v8 ignore stop */

  return { exitReason, toolResult: exitToolResult }
}

export async function main(agentName?: string, options?: { pasteDebounceMs?: number }) {
  if (agentName) setAgentName(agentName)
  const pasteDebounceMs = options?.pasteDebounceMs ?? 50

  // Register spinner hooks so log output clears the spinner before printing
  registerSpinnerHooks(pauseActiveSpinner, resumeActiveSpinner)

  // Fallback: apply pending updates for daemon-less direct CLI usage
  registerUpdateHook(bundleMetaHook)
  await applyPendingUpdates(getAgentBundlesRoot(), getPackageVersion())

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
  let sessionState = existing?.state
  const mcpManager = await getSharedMcpManager() ?? undefined
  const sessionMessages: OpenAI.ChatCompletionMessageParam[] = existing?.messages && existing.messages.length > 0
    ? existing.messages
    : [{ role: "system", content: await buildSystem("cli", { mcpManager }, resolvedContext) }]

  // Per-turn pipeline input: CLI capabilities and pending dir
  const cliCapabilities = getChannelCapabilities("cli")
  const currentAgentName = getAgentName()
  const pendingDir = getPendingDir(currentAgentName, friendId, "cli", "session")
  const summarize = createSummarize()

  try {
    await runCliSession({
      agentName: currentAgentName,
      pasteDebounceMs,
      messages: sessionMessages,
      runTurn: async (messages, userInput, callbacks, signal) => {
        // Run the full per-turn pipeline: resolve -> gate -> session -> drain -> runAgent -> postTurn -> tokens
        // User message passed via input.messages so the pipeline can prepend pending messages to it.
        const result = await handleInboundTurn({
          channel: "cli",
          sessionKey: "session",
          capabilities: cliCapabilities,
          messages: [{ role: "user", content: userInput }],
          continuityIngressTexts: getCliContinuityIngressTexts(userInput),
          callbacks,
          friendResolver: { resolve: () => Promise.resolve(resolvedContext) },
          sessionLoader: { loadOrCreate: () => Promise.resolve({ messages, sessionPath: sessPath, state: sessionState }) },
          pendingDir,
          friendStore,
          provider: "local",
          externalId: localExternalId,
          enforceTrustGate,
          drainPending,
          drainDeferredReturns: (deferredFriendId) => drainDeferredReturns(currentAgentName, deferredFriendId),
          runAgent: (msgs, cb, channel, sig, opts) => runAgent(msgs, cb, channel, sig, {
            ...opts,
            toolContext: {
              /* v8 ignore next -- default no-op signin; pipeline provides the real one @preserve */
              signin: async () => undefined,
              ...opts?.toolContext,
              summarize,
            },
          }),
          postTurn: (turnMessages, sessionPathArg, usage, hooks, state) => {
            postTurn(turnMessages, sessionPathArg, usage, hooks, state)
            sessionState = state
          },
          accumulateFriendTokens,
          signal,
          runAgentOptions: {
            toolChoiceRequired: getToolChoiceRequired(),
            traceId: createTraceId(),
            mcpManager,
          },
        })

        // Handle gate rejection: display auto-reply if present
        if (!result.gateResult.allowed) {
          if ("autoReply" in result.gateResult && result.gateResult.autoReply) {
            process.stdout.write(`${result.gateResult.autoReply}\n`)
          }
        }

        return { usage: result.usage }
      },
      onNewSession: () => {
        deleteSession(sessPath)
      },
    })
  } finally {
    sessionLock?.release()
  }
}
