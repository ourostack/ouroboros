import OpenAI from "openai"
import * as readline from "readline"
import * as os from "os"
import * as path from "path"
import { runAgent, ChannelCallbacks, getProvider, createSummarize } from "../heart/core"
import { buildSystem } from "../mind/prompt"
import { pickPhrase, getPhrases } from "../mind/phrases"
import { formatKick, formatError } from "../mind/format"
import { sessionPath } from "../heart/config"
import { loadSession, deleteSession, postTurn } from "../mind/context"
import { getPendingDir, drainDeferredReturns, drainPending, type PendingMessage } from "../mind/pending"
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
import { applyPendingUpdates, registerUpdateHook } from "../heart/versioning/update-hooks"
import { bundleMetaHook } from "../heart/daemon/hooks/bundle-meta"
import { agentConfigV2Hook } from "../heart/daemon/hooks/agent-config-v2"
import { getPackageVersion } from "../mind/bundle-manifest"
import { StreamingWordWrapper } from "./cli-layout"
import { ImperativeSpinner } from "./cli/spinner-imperative"
import { writeToolEnd } from "./cli/tool-display"

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

/* v8 ignore start -- cosmetic time formatting @preserve */
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
/* v8 ignore stop */

// readline.Interface exposes undocumented mutable line/cursor for in-progress input
type ReadlineInternals = readline.Interface & { line: string; cursor: number }

const CLI_PROMPT = "\x1b[36m) \x1b[0m"

export function writeCliAsyncAssistantMessage(
  rl: readline.Interface,
  message: string,
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  const rlInt = rl as ReadlineInternals
  const currentLine = rlInt.line ?? ""
  const currentCursor = rlInt.cursor ?? currentLine.length

  stdout.write("\r\x1b[K")
  stdout.write(`${renderMarkdown(message)}\n`)
  stdout.write(CLI_PROMPT)
  if (!currentLine) return

  stdout.write(currentLine)
  if (currentCursor < currentLine.length) {
    readline.cursorTo(process.stdout, 2 + currentCursor)
  }
}

// Module-level active spinner for log coordination.
// The terminal log sink calls these to avoid interleaving with spinner output.
let _activeSpinner: ImperativeSpinner | null = null
/* v8 ignore start -- spinner coordination: exercised at runtime, not unit-testable without real terminal @preserve */
export function pauseActiveSpinner(): void { _activeSpinner?.pause() }
export function resumeActiveSpinner(): void { _activeSpinner?.resume() }
/* v8 ignore stop */
export function setActiveSpinner(s: ImperativeSpinner | null): void { _activeSpinner = s }

// Re-export ImperativeSpinner as Spinner for backward compatibility
export { ImperativeSpinner as Spinner } from "./cli/spinner-imperative"

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
  let currentSpinner: ImperativeSpinner | null = null
  function setSpinner(s: ImperativeSpinner | null) { currentSpinner = s; setActiveSpinner(s) }
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
      setSpinner(new ImperativeSpinner(first, pool))
      currentSpinner!.start()
    },
    onModelStreamStart: () => {
      // No-op: content callbacks (onTextChunk, onReasoningChunk) handle
      // stopping the spinner. onModelStreamStart fires too early and
      // doesn't fire at all for settle tool streaming.
    },
    onClearText: () => {
      streamer.reset()
      wrapper.reset()
    },
    onTextChunk: (text: string) => {
      // Stop spinner if still running — settle streaming and Anthropic
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
      setSpinner(new ImperativeSpinner(first, toolPhrases))
      currentSpinner!.start()
      hadToolRun = true
    },
    onToolEnd: (name: string, argSummary: string, success: boolean) => {
      currentSpinner?.stop()
      setSpinner(null)
      writeToolEnd(name, argSummary, success)
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

/**
 * Async queue that bridges push-based Ink input to pull-based async iteration.
 * Input from Ink's onSubmit callback is pushed; the business logic loop awaits via for-await.
 */
export class InputQueue implements AsyncIterable<string> {
  private queue: string[] = []
  private resolve: ((value: IteratorResult<string>) => void) | null = null
  private done = false

  push(input: string): void {
    if (this.done) return
    if (this.resolve) {
      const r = this.resolve
      this.resolve = null
      r({ value: input, done: false })
    } else {
      this.queue.push(input)
    }
  }

  close(): void {
    this.done = true
    if (this.resolve) {
      const r = this.resolve
      this.resolve = null
      r({ value: undefined as unknown as string, done: true })
    }
  }

  /** Drain all buffered items, leaving any pending async awaiter untouched. */
  drainAll(): string[] {
    const items = [...this.queue]
    this.queue = []
    return items
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as string, done: true })
        }
        return new Promise<IteratorResult<string>>((resolve) => {
          this.resolve = resolve
        })
      },
    }
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
  /** Persist or react to assistant messages emitted asynchronously after the turn. */
  onAsyncAssistantMessage?: (
    messages: OpenAI.ChatCompletionMessageParam[],
    message: OpenAI.ChatCompletionAssistantMessageParam,
  ) => void | Promise<void>;
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
  /** Last activity timestamp (ISO string) for session resume display. */
  lastActivityAt?: string;
  /** Inject an input source for testing. When provided, Ink rendering is skipped
   *  and input is pulled from this async iterable instead. */
  _testInputSource?: AsyncIterable<string>;
  /** Custom turn handler. When provided, replaces the internal runAgent call.
   *  The handler receives the messages array (by reference), user input, callbacks,
   *  signal, and options. It is responsible for calling runAgent (or pipeline). */
  runTurn?: (
    messages: OpenAI.ChatCompletionMessageParam[],
    userInput: string,
    callbacks: ChannelCallbacks & { flushMarkdown(): void },
    signal?: AbortSignal,
    toolContext?: ToolContext,
  ) => Promise<{ usage?: UsageData; turnOutcome?: string; commandAction?: string }>;
}

export interface RunCliSessionResult {
  exitReason: "settle" | "tool_exit" | "user_quit";
  toolResult?: unknown;
}

export async function runCliSession(options: RunCliSessionOptions): Promise<RunCliSessionResult> {
  /* v8 ignore start -- integration: runCliSession is interactive, tested via E2E @preserve */
  const registry = createCommandRegistry()
  if (!options.disableCommands) {
    registerDefaultCommands(registry)
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = options.messages
    ?? [{ role: "system", content: await buildSystem("cli") }]

  // ─── Rendering: TUI (Ink + Static) for TTY, imperative for tests/pipes ───
  const useTui = !options._testInputSource && process.stdin.isTTY === true
  let currentAbort: AbortController | null = null
  let closed = false
  let cliCallbacks!: ChannelCallbacks & { flushMarkdown(): void }
  let tuiStore: import("./cli/tui-store").TuiStore | null = null
  let inkRef: { unmount: () => void } | null = null
  const inputQueue = useTui ? new InputQueue() : null
  let rl: readline.Interface | null = null

  if (useTui) {
    try {
      const [ink, React, tuiMod, storeMod] = await Promise.all([
        import("ink"),
        import("react"),
        import("./cli/ouro-tui"),
        import("./cli/tui-store"),
      ])
      const { OuroTui } = tuiMod
      const { TuiStore, createTuiCallbacks } = storeMod

      tuiStore = new TuiStore()
      cliCallbacks = createTuiCallbacks(tuiStore)

      // Seed input history from previous session (for up/down arrows) — NOT display
      const prevUserMsgs = messages
        .filter((msg): msg is { role: "user"; content: string } => msg.role === "user" && typeof msg.content === "string")
        .map(msg => msg.content)
      tuiStore.seedHistory(prevUserMsgs)

      // Show session resume context: summary + last few exchanges (dimmed)
      /* v8 ignore start -- session resume display: integration-only, tested visually @preserve */
      if (messages.length > 1) {
        const userAssistantMsgs = messages.filter(
          (m): m is { role: "user" | "assistant"; content: string } =>
            (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0,
        )
        // Extract last 2 exchanges (up to 4 messages)
        const lastExchanges: Array<{ role: "user" | "assistant"; content: string }> = []
        for (let i = userAssistantMsgs.length - 1; i >= 0 && lastExchanges.length < 4; i--) {
          lastExchanges.unshift({ role: userAssistantMsgs[i].role, content: userAssistantMsgs[i].content })
        }
        const msgCount = messages.filter(m => m.role === "user" || m.role === "assistant").length
        const timeAgo = options.lastActivityAt ? formatTimeAgo(new Date(options.lastActivityAt)) : null
        const summary = `  resuming session · ${msgCount} messages${timeAgo ? ` · last active ${timeAgo}` : ""} · showing recent`
        tuiStore.addSessionHistory(summary, lastExchanges)
      }
      /* v8 ignore stop */

      // Ctrl-C state machine (Claude Code behavior):
      // During generation: abort current request
      // Idle with text: clear input
      // Idle empty (first): warn
      // Idle empty (second): exit
      let ctrlCWarned = false
      let ctrlCTimer: ReturnType<typeof setTimeout> | null = null
      const handleCtrlC = (hasInput: boolean): import("./cli/ouro-tui").CtrlCAction => {
        if (currentAbort) {
          currentAbort.abort()
          ctrlCWarned = false
          return "abort"
        }
        if (hasInput) {
          ctrlCWarned = false
          return "clear"
        }
        if (ctrlCWarned) {
          ctrlCWarned = false
          if (ctrlCTimer) { clearTimeout(ctrlCTimer); ctrlCTimer = null }
          closed = true
          inputQueue!.close()
          return "exit"
        }
        ctrlCWarned = true
        // Reset after 2 seconds — must press twice within window
        ctrlCTimer = setTimeout(() => { ctrlCWarned = false }, 2000)
        return "warn"
      }

      // TUI root: subscribes to store, passes props to OuroTui
      // Elapsed timer is local React state (no store.notify overhead)
      const storeRef = tuiStore
      function TuiRoot(): any {
        const [, forceUpdate] = React.useState(0)
        const [elapsed, setElapsed] = React.useState(0)
        React.useEffect(() => storeRef.subscribe(() => {
          forceUpdate((n: number) => n + 1)
          // Reset ctrlC warning on any state change (new turn, etc.)
        }), [])
        React.useEffect(() => {
          const iv = setInterval(() => setElapsed(storeRef.getElapsed()), 1000)
          return () => clearInterval(iv)
        }, [])
        return React.createElement(OuroTui, {
          agentName: options.agentName,
          model: loadAgentConfig().humanFacing?.model ?? "",
          completedMessages: storeRef.completedMessages as any,
          inputHistory: storeRef.inputHistory,
          queuedInputs: storeRef.queuedInputs as any,
          live: storeRef.live,
          elapsedSeconds: elapsed,
          contextPercent: 0,
          onSubmit: (text: string) => { ctrlCWarned = false; inputQueue!.push(text); storeRef.enqueueInput(text) },
          onCtrlC: handleCtrlC,
          onPopQueue: () => { const items = storeRef.popAllQueuedForEditing(); inputQueue!.drainAll(); return items },
          headerShown: storeRef.headerShown,
          cwd: process.cwd().replace(process.env.HOME ?? "", "~"),
        })
      }

      inkRef = ink.render(React.createElement(TuiRoot), { exitOnCtrlC: false, patchConsole: false })
    } catch (err) {
      // Ink failed to load (CJS compat, missing deps, etc.) — fall through to imperative
      emitNervesEvent({
        component: "senses",
        event: "senses.tui_fallback",
        message: `TUI failed to load, falling back to imperative: ${err instanceof Error ? err.message : String(err)}`,
        meta: {},
      })
    }
  }

  // Fallback to imperative callbacks if TUI didn't initialize
  if (!tuiStore) {
    cliCallbacks = createCliCallbacks()
    if (options.banner !== false) {
      const bannerText = typeof options.banner === "string"
        ? options.banner
        : `${options.agentName} (type /commands for help)`
      // eslint-disable-next-line no-console -- terminal UX: startup banner
      console.log(`\n${bannerText}\n`)
    }
  }

  // Display helpers: route to TUI store or imperative stderr/stdout
  const display = {
    error: (msg: string) => {
      if (tuiStore) tuiStore.setError(msg)
      else process.stderr.write(`\x1b[31m${msg}\x1b[0m\n`)
    },
    warn: (msg: string) => {
      if (tuiStore) tuiStore.setError(msg) // TUI shows warnings as errors (amber color handled in component)
      else process.stderr.write(`\x1b[33m${msg}\x1b[0m\n`)
    },
    text: (msg: string) => {
      if (tuiStore) tuiStore.appendText(msg)
      else process.stdout.write(`${msg}\n`)
    },
    suppressInput: () => {
      if (tuiStore) tuiStore.suppressInput()
    },
    restoreInput: () => {
      if (tuiStore) tuiStore.restoreInput()
    },
  }
  const effectiveToolContext: ToolContext = {
    signin: options.toolContext?.signin ?? (async () => undefined),
    ...options.toolContext,
    codingFeedback: {
      send: async (message: string) => {
        const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: message,
        }
        messages.push(assistantMessage)
        await options.onAsyncAssistantMessage?.(messages, assistantMessage)
        display.text(message)
        await options.toolContext?.codingFeedback?.send(message)
      },
    },
  }

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
          currentAbort?.abort()
        }
        return result
      }
    : resolvedExecTool

  // Resolve toolChoiceRequired: use explicit option if set, else fall back to toggle
  const getEffectiveToolChoiceRequired = () =>
    options.toolChoiceRequired !== undefined ? options.toolChoiceRequired : getToolChoiceRequired()

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
    display.suppressInput()
    let result: { usage?: UsageData } | undefined
    try {
      result = await runAgent(messages, cliCallbacks, options.skipSystemPromptRefresh ? undefined : "cli", currentAbort.signal, {
        toolChoiceRequired: getEffectiveToolChoiceRequired(),
        traceId,
        tools: options.tools,
        execTool: wrappedExecTool,
        toolContext: effectiveToolContext,
      })
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        display.error(err instanceof Error ? err.message : String(err))
      }
    }
    cliCallbacks.flushMarkdown()
    display.restoreInput()
    currentAbort = null

    if (exitToolFired) {
      exitReason = "tool_exit"
      closed = true
    } else {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg?.role === "assistant" && !(typeof lastMsg.content === "string" ? lastMsg.content : "").trim()) {
        display.warn("(empty response)")
      }
      if (options.onTurnEnd) {
        await options.onTurnEnd(messages, result ?? { usage: undefined })
      }
    }
  }

  try {
    // Input source: TUI queue for Ink, test source for tests, readline fallback
    let inputSource: AsyncIterable<string>
    let inputCtrl: InputController | null = null
    if (tuiStore && inputQueue) {
      // TUI path: input comes from Ink's onSubmit → InputQueue
      inputSource = inputQueue
    } else if (options._testInputSource) {
      inputSource = options._testInputSource
    } else {
      // Imperative fallback: readline
      const isTTY = process.stdin.isTTY === true
      rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })
      inputCtrl = new InputController(rl)
      inputSource = rl
      process.stdout.write(CLI_PROMPT)
    }
    for await (const input of inputSource) {
      if (closed) break
      if (!input.trim()) continue
      // Remove from TUI queue display as the agent picks up this message
      tuiStore?.dequeueInput(input)

      // Optional input gate (e.g. trust gate in main)
      if (options.onInput) {
        const gate = options.onInput(input)
        if (!gate.allowed) {
          if (gate.reply) {
            display.text(gate.reply)
          }
          if (closed) break
          continue
        }
      }

      // Check for slash commands (legacy path only — pipeline handles commands for runTurn path)
      if (!options.runTurn) {
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
              continue
            } else if (dispatchResult.result.action === "response") {
              display.text(dispatchResult.result.message || "")
              continue
            }
          }
        }
      }

      // Track user message in TUI for display
      if (tuiStore) tuiStore.addUserMessage(input)

      currentAbort = new AbortController()
      if (tuiStore) tuiStore.suppressInput()
      inputCtrl?.suppress(() => { currentAbort?.abort() })
      let result: { usage?: UsageData; turnOutcome?: string; commandAction?: string } | undefined
      try {
        if (options.runTurn) {
          // Pipeline-based turn: the runTurn callback handles user message assembly,
          // pending drain, trust gate, runAgent, postTurn, and token accumulation.
          result = await options.runTurn(messages, input, cliCallbacks, currentAbort.signal, effectiveToolContext)

          // Handle pipeline-intercepted commands with loop-control side effects
          if (result?.turnOutcome === "command") {
            if (result.commandAction === "exit") {
              break
            } else if (result.commandAction === "new") {
              messages.length = 0
              messages.push({ role: "system", content: await buildSystem("cli") })
              await options.onNewSession?.()
              // eslint-disable-next-line no-console -- terminal UX: session cleared
              console.log("session cleared")
              continue
            }
            // For "response" commands: the pipeline already emitted the response via onTextChunk
            cliCallbacks.flushMarkdown()
            continue
          }
        } else {
          // Legacy path: inline runAgent (used by serpent guide and tests)
          const prefix = options.getContentPrefix?.()
          messages.push({ role: "user", content: prefix ? `${prefix}\n\n${input}` : input })
          const traceId = createTraceId()
          result = await runAgent(messages, cliCallbacks, options.skipSystemPromptRefresh ? undefined : "cli", currentAbort.signal, {
            toolChoiceRequired: getEffectiveToolChoiceRequired(),
            traceId,
            tools: options.tools,
            execTool: wrappedExecTool,
            toolContext: effectiveToolContext,
          })
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          display.error(err instanceof Error ? err.message : String(err))
        }
      }
      cliCallbacks.flushMarkdown()
      if (!tuiStore) process.stdout.write("\n") // ensure response ends with newline before prompt (imperative only)
      if (tuiStore) tuiStore.restoreInput()
      inputCtrl?.restore()
      currentAbort = null

      // Check if exit tool was fired during this turn
      if (exitToolFired) {
        exitReason = "tool_exit"
        break
      }

      // Safety net: never silently swallow an empty response
      const lastMsg = messages[messages.length - 1]
      if (lastMsg?.role === "assistant" && !(typeof lastMsg.content === "string" ? lastMsg.content : "").trim()) {
        display.warn("(empty response)")
      }

      // Post-turn hook (session persistence, pending drain, prompt refresh, etc.)
      if (options.onTurnEnd) {
        await options.onTurnEnd(messages, result ?? { usage: undefined })
      }

      if (closed) break
    }
  } finally {
    rl?.close()
    if (inkRef) {
      // Suppress React "state update on unmounted component" warnings during cleanup.
      // Ink's useInput hook fires after unmount — this is harmless but noisy.
      // This also covers the SerpentGuide exitOnToolCall path, which aborts the
      // current request and breaks out of the loop into this finally block.
      // eslint-disable-next-line no-console -- intentional console.warn/error override for cleanup
      const origWarn = console.warn; const origError = console.error // eslint-disable-line no-console
      // eslint-disable-next-line no-console -- suppress React unmount warnings
      console.warn = (...args: unknown[]) => { if (typeof args[0] === "string" && args[0].includes("Can't perform a React state update")) return; origWarn.apply(console, args) }
      // eslint-disable-next-line no-console -- suppress React unmount warnings
      console.error = (...args: unknown[]) => { if (typeof args[0] === "string" && args[0].includes("Can't perform a React state update")) return; origError.apply(console, args) }
      inkRef.unmount()
      setTimeout(() => { console.warn = origWarn; console.error = origError }, 100) // eslint-disable-line no-console
    }
    if (options.banner !== false) {
      // eslint-disable-next-line no-console -- terminal UX: goodbye
      console.log("bye")
    }
  }

  /* v8 ignore stop */

  return { exitReason, toolResult: exitToolResult }
}

export async function main(agentName?: string, options?: { pasteDebounceMs?: number; _testInputSource?: AsyncIterable<string> }) {
  if (agentName) setAgentName(agentName)
  const pasteDebounceMs = options?.pasteDebounceMs ?? 50

  // Register spinner hooks so log output clears the spinner before printing
  registerSpinnerHooks(pauseActiveSpinner, resumeActiveSpinner)

  // Fallback: apply pending updates for daemon-less direct CLI usage
  registerUpdateHook(bundleMetaHook)
  registerUpdateHook(agentConfigV2Hook)
  await applyPendingUpdates(getAgentBundlesRoot(), getPackageVersion())

  // Fail fast if provider is misconfigured (triggers human-readable error + exit)
  getProvider("human")

  // Resolve context kernel (identity + channel) for CLI
  const friendsPath = path.join(getAgentRoot(), "friends")
  const friendStore = new FileFriendStore(friendsPath)
  const username = os.userInfo().username
  const localExternalId = username
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
    : [{ role: "system", content: await buildSystem("cli", {}, resolvedContext) }]

  // Per-turn pipeline input: CLI capabilities and pending dir
  const cliCapabilities = getChannelCapabilities("cli")
  const currentAgentName = getAgentName()
  const pendingDir = getPendingDir(currentAgentName, friendId, "cli", "session")
  const summarize = createSummarize("human")
  const cliFailoverState: import("./pipeline").FailoverState = { pending: null }

  try {
    await runCliSession({
      agentName: currentAgentName,
      pasteDebounceMs,
      messages: sessionMessages,
      lastActivityAt: sessionState?.lastFriendActivityAt,
      _testInputSource: options?._testInputSource,
      onAsyncAssistantMessage: async (messages, _assistantMessage) => {
        postTurn(messages, sessPath, undefined, undefined, sessionState)
      },
      runTurn: async (messages, userInput, callbacks, signal, toolContext) => {
        // Run the full per-turn pipeline: resolve -> gate -> session -> drain -> runAgent -> postTurn -> tokens
        // User message passed via input.messages so the pipeline can prepend pending messages to it.
        const failoverState = cliFailoverState

        // Capture terminal errors instead of displaying immediately — the failover
        // message replaces the raw error if failover triggers successfully.
        let capturedTerminalError: Error | null = null
        /* v8 ignore start -- failover-aware callback wrapper: tested via pipeline integration @preserve */
        const failoverAwareCallbacks: typeof callbacks = {
          ...callbacks,
          onError: (error: Error, severity: "transient" | "terminal") => {
            if (severity === "terminal" && failoverState) {
              capturedTerminalError = error
              callbacks.onError(new Error(""), "transient")
              return
            }
            callbacks.onError(error, severity)
          },
        }
        /* v8 ignore stop */

        const result = await handleInboundTurn({
          channel: "cli",
          sessionKey: "session",
          capabilities: cliCapabilities,
          messages: [{ role: "user", content: userInput }],
          continuityIngressTexts: getCliContinuityIngressTexts(userInput),
          callbacks: failoverAwareCallbacks,
          friendResolver: { resolve: () => Promise.resolve(resolvedContext) },
          sessionLoader: {
            loadOrCreate: () => Promise.resolve({
              messages,
              sessionPath: sessPath,
              state: sessionState,
            }),
          },
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
            toolContext,
          },
          failoverState,
        })

        /* v8 ignore start -- failover display: tested via pipeline integration tests @preserve */
        if (result.failoverMessage) {
          // Failover handled it — show the actionable message instead of the raw error
          process.stdout.write(`\x1b[33m${result.failoverMessage}\x1b[0m\n`)
        } else if (capturedTerminalError) {
          // Failover didn't trigger (no failoverState, or sequence failed) — show the raw error
          process.stderr.write(`\x1b[31m${formatError(capturedTerminalError)}\x1b[0m\n`)
        }
        /* v8 ignore stop */

        // Handle gate rejection: display auto-reply if present
        if (!result.gateResult.allowed) {
          if ("autoReply" in result.gateResult && result.gateResult.autoReply) {
            process.stdout.write(`${result.gateResult.autoReply}\n`)
          }
        }

        return { usage: result.usage, turnOutcome: result.turnOutcome, commandAction: result.commandAction }
      },
      onNewSession: () => {
        deleteSession(sessPath)
      },
    })
  } finally {
    sessionLock?.release()
  }

  // Force exit: lingering handles (Ink cleanup timers, MCP connections) keep the
  // event loop alive after the interactive session ends. This is safe because all
  // session persistence has already completed in the finally block above.
  /* v8 ignore next -- process.exit not callable in vitest @preserve */
  if (!options?._testInputSource) process.exit(0)
}
// CI trigger
