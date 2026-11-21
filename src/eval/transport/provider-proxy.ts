/**
 * A provider runtime split across a process boundary. Inside the sandbox, `createProxyRuntime` is the agent's
 * `ProviderRuntime`; on the host, `serveProxyRuntime` holds the one real runtime for the run, so credentials never
 * enter the container and per-turn provider state (the Responses API's input) lives in one place.
 *
 * The guest asks for the runtime's identity and capabilities before the first turn, because the system prompt reads
 * them before the first call. Turn requests, `appendToolOutput` and `resetTurnState` go to the host in order with
 * their exact arguments; streamed callback events come back in order. An abort signal does not cross the wire: the
 * guest sends `abort` instead, and a signal already aborted fails the turn without reaching the host. Every turn takes
 * one unit of the host's budget first, and the first 402 or 429 stops the run: that call and every later one reject.
 * Every proxied error is marked not retryable, because a retry inside the sandbox would rebuild a provider from the
 * guest's own config; its `reason` says whether the provider, the budget, an earlier stop, a second turn in flight or
 * a broken channel ended it. A line on the wire that is not a message fails the guest's turns and never throws.
 * The guest answers `ping` itself and has no `fetchContextWindow`, so context limits come from the model table.
 */
import type { Readable, Writable } from "node:stream"
import type { ChannelCallbacks, ProviderCapability, ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../../heart/core"
import type { TurnResult } from "../../heart/streaming"
import { emitNervesEvent } from "../../nerves/runtime"

type CallbackEvent = Exclude<keyof ChannelCallbacks, "settleOutputMode">
type WireRequest = Omit<ProviderTurnRequest, "callbacks" | "signal"> & { settleOutputMode?: ChannelCallbacks["settleOutputMode"] }
export type ProxyStopReason = "provider" | "budget" | "stopped" | "busy" | "channel" | "aborted" | "callback"
type WireError = { message: string; classification: ProviderErrorClassification; status?: number; reason: ProxyStopReason }

export type ProxyMessage =
  | { type: "hello" }
  | { type: "capabilities"; id: ProviderRuntime["id"]; model: string; capabilities: ProviderCapability[]; supportedReasoningEfforts?: string[] }
  | { type: "streamTurn"; turn: number; request: WireRequest }
  | { type: "callback"; turn: number; event: CallbackEvent; args: unknown[] }
  | { type: "turnResult"; turn: number; result: TurnResult }
  | { type: "appendToolOutput"; callId: string; output: string }
  | { type: "resetTurnState"; messages: ProviderTurnRequest["messages"] }
  | { type: "error"; turn: number; error: WireError }
  | { type: "abort"; turn: number }
  /** Never sent: a channel delivers it when a line is not a message or a stream fails. */
  | { type: "invalid"; reason: string }
  /** Never sent: a channel delivers it once when the other side has gone away. */
  | { type: "closed" }

export type ProxyChannel = { send(msg: ProxyMessage): void; onMessage(fn: (msg: ProxyMessage) => void): void }

/** The callback events a provider streams; anything else on the wire is ignored. */
const CALLBACK_EVENTS: ReadonlySet<string> = new Set<CallbackEvent>([
  "onModelStart", "onModelStreamStart", "onTextChunk", "onReasoningChunk", "onToolStart", "onToolEnd", "onError", "onClearText", "onKick",
])

/** Stops the run, never retried: the budget is spent, or the provider says the account is out of credit or rate-limited. */
const STOPPING_STATUS = new Set([402, 429])
const STOPPING_CLASSIFICATION = new Set<ProviderErrorClassification>(["usage-limit", "rate-limit"])

class ProxiedProviderError extends Error {
  readonly classification: ProviderErrorClassification
  declare readonly status?: number
  readonly reason: ProxyStopReason
  readonly retryable = false
  constructor(error: WireError, cause?: unknown) {
    super(error.message, { cause })
    this.name = "ProxiedProviderError"
    this.classification = error.classification
    if (error.status !== undefined) this.status = error.status
    this.reason = error.reason
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isTurn = (value: unknown): boolean => Number.isInteger(value)

/** The shape each message type must have; the guest is untrusted, so anything else never reaches a listener. */
const SHAPES: Record<string, (msg: Record<string, unknown>) => boolean> = {
  hello: () => true,
  capabilities: (msg) => typeof msg.id === "string" && typeof msg.model === "string" && Array.isArray(msg.capabilities),
  streamTurn: (msg) => isTurn(msg.turn) && isObject(msg.request) && Array.isArray(msg.request.messages),
  callback: (msg) => isTurn(msg.turn) && typeof msg.event === "string" && Array.isArray(msg.args),
  turnResult: (msg) => isTurn(msg.turn) && isObject(msg.result),
  appendToolOutput: (msg) => typeof msg.callId === "string" && typeof msg.output === "string",
  resetTurnState: (msg) => Array.isArray(msg.messages),
  error: (msg) => isTurn(msg.turn) && isObject(msg.error) && typeof msg.error.message === "string",
  abort: (msg) => isTurn(msg.turn),
}

function isMessage(value: unknown): value is ProxyMessage {
  return isObject(value) && typeof value.type === "string" && Object.hasOwn(SHAPES, value.type) && SHAPES[value.type]!(value)
}

function parseLine(line: string): ProxyMessage {
  try {
    const value: unknown = JSON.parse(line)
    if (isMessage(value)) return value
  } catch {
    // Not JSON: reported below like any other line that is not a message.
  }
  return { type: "invalid", reason: `not a proxy message: ${line.slice(0, 80)}` }
}

/** Far above any real turn's transcript; past it a line is dropped, so a guest cannot grow the host's buffer without bound. */
const MAX_LINE_LENGTH = 64 * 1024 * 1024

/** Newline-delimited JSON over a pair of byte streams, such as a container's stdin and stdout. */
export function createStreamChannel(input: Readable, output: Writable, maxLineLength = MAX_LINE_LENGTH): ProxyChannel {
  const listeners: Array<(msg: ProxyMessage) => void> = []
  const deliver = (msg: ProxyMessage): void => {
    for (const listener of listeners) {
      try {
        listener(msg)
      } catch (caught) {
        // A throw here would escape the stream's data handler and end the process.
        emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_channel_error", message: "a proxy message handler failed", meta: { type: msg.type, error: caught instanceof Error ? caught.message : String(caught) } })
      }
    }
  }
  const tooLong: ProxyMessage = { type: "invalid", reason: "line too long" }
  let buffered = ""
  let discarding = false
  let closed = false
  input.setEncoding("utf8")
  input.on("data", (chunk: string) => {
    let text = chunk
    if (discarding) {
      const newline = text.indexOf("\n")
      if (newline < 0) return
      text = text.slice(newline + 1)
      discarding = false
    }
    buffered += text
    const lines = buffered.split("\n")
    buffered = lines.pop()!
    for (const line of lines.filter(Boolean)) deliver(line.length > maxLineLength ? tooLong : parseLine(line))
    if (buffered.length > maxLineLength) {
      buffered = ""
      discarding = true
      deliver(tooLong)
    }
  })
  const close = (): void => { if (!closed) { closed = true; deliver({ type: "closed" }) } }
  input.on("end", close)
  input.on("close", close)
  input.on("error", (error: Error) => deliver({ type: "invalid", reason: `input failed: ${error.message}` }))
  output.on("error", (error: Error) => deliver({ type: "invalid", reason: `output failed: ${error.message}` }))
  return {
    send: (msg) => { output.write(`${JSON.stringify(msg)}\n`) },
    onMessage: (fn) => { listeners.push(fn) },
  }
}

/** Guest side: a runtime whose every call is served by the host. Resolves once the host has said what it is. */
export function createProxyRuntime(channel: ProxyChannel): Promise<ProviderRuntime> {
  type Pending = { request: ProviderTurnRequest; resolve(result: TurnResult): void; reject(error: Error): void; callbackError?: Error }
  const turns = new Map<number, Pending>()
  let nextTurn = 1
  return new Promise((resolveRuntime) => {
    channel.onMessage((msg) => {
      if (msg.type === "capabilities") {
        emitNervesEvent({ component: "eval", event: "eval.proxy_runtime_ready", message: "proxy provider runtime is ready", meta: { provider: msg.id, model: msg.model } })
        resolveRuntime({
          id: msg.id,
          model: msg.model,
          client: null,
          capabilities: new Set(msg.capabilities),
          ...(msg.supportedReasoningEfforts ? { supportedReasoningEfforts: msg.supportedReasoningEfforts } : {}),
          streamTurn: (request) => new Promise((resolve, reject) => {
            const turn = nextTurn++
            const { callbacks, signal, ...wire } = request
            if (signal?.aborted) {
              emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_guest_turn_error", message: "proxied turn aborted before it started", meta: { turn, reason: "aborted" } })
              return reject(new ProxiedProviderError({ message: "aborted before the provider call", classification: "unknown", reason: "aborted" }))
            }
            emitNervesEvent({ component: "eval", event: "eval.proxy_guest_turn_start", message: "sending a turn to the host provider", meta: { turn } })
            const onAbort = (): void => channel.send({ type: "abort", turn })
            const settle = (): void => { turns.delete(turn); signal?.removeEventListener("abort", onAbort) }
            turns.set(turn, {
              request,
              resolve: (result) => { settle(); emitNervesEvent({ component: "eval", event: "eval.proxy_guest_turn_end", message: "host provider turn finished", meta: { turn } }); resolve(result) },
              reject: (error) => { settle(); emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_guest_turn_error", message: "host provider turn failed", meta: { turn, error: error.message } }); reject(error) },
            })
            channel.send({ type: "streamTurn", turn, request: { ...wire, ...(callbacks.settleOutputMode ? { settleOutputMode: callbacks.settleOutputMode } : {}) } })
            signal?.addEventListener("abort", onAbort, { once: true })
          }),
          appendToolOutput: (callId, output) => channel.send({ type: "appendToolOutput", callId, output }),
          resetTurnState: (messages) => channel.send({ type: "resetTurnState", messages }),
          ping: async () => undefined,
          classifyError: (error) => error instanceof ProxiedProviderError ? error.classification : "unknown",
        })
        return
      }
      if (msg.type === "invalid" || msg.type === "closed") {
        const why = msg.type === "closed" ? "input closed" : msg.reason
        for (const [turn, pending] of [...turns]) {
          channel.send({ type: "abort", turn })
          pending.reject(new ProxiedProviderError({ message: `proxy channel failed: ${why}`, classification: "unknown", reason: "channel" }))
        }
        return
      }
      const pending = "turn" in msg ? turns.get(msg.turn) : undefined
      if (!pending) return
      if (msg.type === "callback" && CALLBACK_EVENTS.has(msg.event)) {
        if (pending.callbackError) return
        const args = msg.event === "onError" ? [new Error(String(msg.args[0])), msg.args[1]] : msg.args
        try {
          ;(pending.request.callbacks[msg.event] as ((...values: unknown[]) => void) | undefined)?.(...args)
        } catch (caught) {
          // In-process, a throwing callback fails the turn; here the host is told to stop, and the turn fails with it.
          pending.callbackError = new ProxiedProviderError({ message: caught instanceof Error ? caught.message : String(caught), classification: "unknown", reason: "callback" }, caught)
          channel.send({ type: "abort", turn: msg.turn })
        }
      } else if (msg.type === "turnResult") {
        if (pending.callbackError) pending.reject(pending.callbackError)
        else pending.resolve(msg.result)
      } else if (msg.type === "error") {
        pending.reject(pending.callbackError ?? new ProxiedProviderError(msg.error))
      }
    })
    channel.send({ type: "hello" })
  })
}

function streamingCallbacks(channel: ProxyChannel, turn: number, settleOutputMode: WireRequest["settleOutputMode"]): ChannelCallbacks {
  const forward = (event: CallbackEvent) => (...args: unknown[]): void => {
    channel.send({ type: "callback", turn, event, args: event === "onError" ? [args[0] instanceof Error ? args[0].message : String(args[0]), args[1]] : args })
  }
  const callbacks = Object.fromEntries([...CALLBACK_EVENTS].map((event) => [event, forward(event as CallbackEvent)])) as unknown as ChannelCallbacks
  return settleOutputMode ? { ...callbacks, settleOutputMode } : callbacks
}

/** Host side: serves one real runtime to the guest, taking one budget unit per turn. */
export function serveProxyRuntime(channel: ProxyChannel, runtime: ProviderRuntime, budget: { take(): boolean }): void {
  const aborts = new Map<number, AbortController>()
  let stopped: WireError | undefined
  channel.onMessage((msg) => {
    if (msg.type === "closed") {
      // The guest has gone away: its turn's call is wasted, so stop it.
      for (const abort of aborts.values()) abort.abort()
    } else if (msg.type === "invalid") {
      emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_channel_error", message: "ignored a line from the guest that is not a proxy message", meta: { reason: msg.reason } })
    } else if (msg.type === "hello") {
      channel.send({
        type: "capabilities", id: runtime.id, model: runtime.model, capabilities: [...runtime.capabilities],
        ...(runtime.supportedReasoningEfforts ? { supportedReasoningEfforts: [...runtime.supportedReasoningEfforts] } : {}),
      })
    } else if (msg.type === "appendToolOutput") {
      runtime.appendToolOutput(msg.callId, msg.output)
    } else if (msg.type === "resetTurnState") {
      runtime.resetTurnState(msg.messages)
    } else if (msg.type === "abort") {
      aborts.get(msg.turn)?.abort()
    } else if (msg.type === "streamTurn") {
      void serveTurn(msg.turn, msg.request)
    }
  })

  function refuse(turn: number, error: WireError): void {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_turn_error", message: "proxy turn refused without calling the provider", meta: { turn, reason: error.reason } })
    channel.send({ type: "error", turn, error })
  }

  async function serveTurn(turn: number, request: WireRequest): Promise<void> {
    if (stopped) return refuse(turn, { ...stopped, message: `the provider stopped this run earlier: ${stopped.message}`, reason: "stopped" })
    // One runtime keeps one turn's provider state, so a second turn in flight would corrupt the first.
    if (aborts.size > 0) return refuse(turn, { message: "another turn is still in flight", classification: "unknown", reason: "busy" })
    if (!budget.take()) return refuse(turn, { message: "budget exhausted", classification: "usage-limit", reason: "budget" })
    emitNervesEvent({ component: "eval", event: "eval.proxy_turn_start", message: "serving a proxied provider turn", meta: { turn, provider: runtime.id, model: runtime.model } })
    const abort = new AbortController()
    aborts.set(turn, abort)
    try {
      const { settleOutputMode, ...rest } = request
      const result = await runtime.streamTurn({ ...rest, callbacks: streamingCallbacks(channel, turn, settleOutputMode), signal: abort.signal })
      channel.send({ type: "turnResult", turn, result })
      emitNervesEvent({ component: "eval", event: "eval.proxy_turn_end", message: "proxied provider turn finished", meta: { turn } })
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      const classification = runtime.classifyError(error)
      const status = (error as Error & { status?: unknown }).status
      const wire: WireError = { message: error.message, classification, reason: "provider", ...(typeof status === "number" ? { status } : {}) }
      if ((typeof status === "number" && STOPPING_STATUS.has(status)) || STOPPING_CLASSIFICATION.has(classification)) stopped = wire
      emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_turn_error", message: "proxied provider turn failed", meta: { turn, classification, status: wire.status ?? null, stopped: Boolean(stopped) } })
      channel.send({ type: "error", turn, error: wire })
    } finally {
      aborts.delete(turn)
    }
  }
}
