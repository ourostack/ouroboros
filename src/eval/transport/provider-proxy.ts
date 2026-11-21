/**
 * A provider runtime split across a process boundary. Inside the sandbox, `createProxyRuntime` is the agent's
 * `ProviderRuntime`; on the host, `serveProxyRuntime` holds the one real runtime for the run, so credentials never
 * enter the container and per-turn provider state (the Responses API's input) lives in one place.
 *
 * The guest asks for the runtime's identity and capabilities before the first turn, because the system prompt reads
 * them before the first call. Turn requests, `appendToolOutput` and `resetTurnState` go to the host in order with
 * their exact arguments; streamed callback events come back in order. An abort signal does not cross the wire: the
 * guest sends `abort` instead. Every turn takes one unit of the host's budget first, and the first 402 or 429 stops
 * the run: that call and every later one reject without a retry.
 */
import type { Readable, Writable } from "node:stream"
import type { ChannelCallbacks, ProviderCapability, ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../../heart/core"
import type { TurnResult } from "../../heart/streaming"
import { emitNervesEvent } from "../../nerves/runtime"

type CallbackEvent = Exclude<keyof ChannelCallbacks, "settleOutputMode">
type WireRequest = Omit<ProviderTurnRequest, "callbacks" | "signal"> & { settleOutputMode?: ChannelCallbacks["settleOutputMode"] }
type WireError = { message: string; classification: ProviderErrorClassification; status?: number; retryable: boolean }

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
  readonly retryable: boolean
  constructor(error: WireError) {
    super(error.message)
    this.name = "ProxiedProviderError"
    this.classification = error.classification
    if (error.status !== undefined) this.status = error.status
    this.retryable = error.retryable
  }
}

/** Newline-delimited JSON over a pair of byte streams, such as a container's stdin and stdout. */
export function createStreamChannel(input: Readable, output: Writable): ProxyChannel {
  const listeners: Array<(msg: ProxyMessage) => void> = []
  let buffered = ""
  input.setEncoding("utf8")
  input.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop()!
    for (const line of lines.filter(Boolean)) {
      const msg = JSON.parse(line) as ProxyMessage
      for (const listener of listeners) listener(msg)
    }
  })
  return {
    send: (msg) => { output.write(`${JSON.stringify(msg)}\n`) },
    onMessage: (fn) => { listeners.push(fn) },
  }
}

/** Guest side: a runtime whose every call is served by the host. Resolves once the host has said what it is. */
export function createProxyRuntime(channel: ProxyChannel): Promise<ProviderRuntime> {
  const turns = new Map<number, { request: ProviderTurnRequest; resolve(result: TurnResult): void; reject(error: Error): void }>()
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
            turns.set(turn, { request, resolve, reject })
            const { callbacks, signal, ...wire } = request
            channel.send({ type: "streamTurn", turn, request: { ...wire, ...(callbacks.settleOutputMode ? { settleOutputMode: callbacks.settleOutputMode } : {}) } })
            signal?.addEventListener("abort", () => channel.send({ type: "abort", turn }), { once: true })
          }),
          appendToolOutput: (callId, output) => channel.send({ type: "appendToolOutput", callId, output }),
          resetTurnState: (messages) => channel.send({ type: "resetTurnState", messages }),
          ping: async () => undefined,
          classifyError: (error) => error instanceof ProxiedProviderError ? error.classification : "unknown",
        })
        return
      }
      const pending = "turn" in msg ? turns.get(msg.turn) : undefined
      if (!pending) return
      if (msg.type === "callback" && CALLBACK_EVENTS.has(msg.event)) {
        const args = msg.event === "onError" ? [new Error(String(msg.args[0])), msg.args[1]] : msg.args
        ;(pending.request.callbacks[msg.event] as ((...values: unknown[]) => void) | undefined)?.(...args)
      } else if (msg.type === "turnResult") {
        turns.delete(msg.turn)
        pending.resolve(msg.result)
      } else if (msg.type === "error") {
        turns.delete(msg.turn)
        pending.reject(new ProxiedProviderError(msg.error))
      }
    })
    channel.send({ type: "hello" })
  })
}

function streamingCallbacks(channel: ProxyChannel, turn: number, settleOutputMode: WireRequest["settleOutputMode"]): ChannelCallbacks {
  const forward = (event: CallbackEvent) => (...args: unknown[]): void => {
    channel.send({ type: "callback", turn, event, args: event === "onError" ? [(args[0] as Error).message, args[1]] : args })
  }
  const callbacks = Object.fromEntries([...CALLBACK_EVENTS].map((event) => [event, forward(event as CallbackEvent)])) as unknown as ChannelCallbacks
  return settleOutputMode ? { ...callbacks, settleOutputMode } : callbacks
}

/** Host side: serves one real runtime to the guest, taking one budget unit per turn. */
export function serveProxyRuntime(channel: ProxyChannel, runtime: ProviderRuntime, budget: { take(): boolean }): void {
  const aborts = new Map<number, AbortController>()
  let stopped: WireError | undefined
  channel.onMessage((msg) => {
    if (msg.type === "hello") {
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

  async function serveTurn(turn: number, request: WireRequest): Promise<void> {
    if (stopped) return channel.send({ type: "error", turn, error: stopped })
    if (!budget.take()) {
      emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_turn_error", message: "proxy turn refused: budget exhausted", meta: { turn, reason: "budget" } })
      return channel.send({ type: "error", turn, error: { message: "budget exhausted", classification: "usage-limit", retryable: false } })
    }
    emitNervesEvent({ component: "eval", event: "eval.proxy_turn_start", message: "serving a proxied provider turn", meta: { turn, provider: runtime.id, model: runtime.model } })
    const abort = new AbortController()
    aborts.set(turn, abort)
    const { settleOutputMode, ...rest } = request
    try {
      const result = await runtime.streamTurn({ ...rest, callbacks: streamingCallbacks(channel, turn, settleOutputMode), signal: abort.signal })
      channel.send({ type: "turnResult", turn, result })
      emitNervesEvent({ component: "eval", event: "eval.proxy_turn_end", message: "proxied provider turn finished", meta: { turn } })
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      const classification = runtime.classifyError(error)
      const status = (error as Error & { status?: unknown }).status
      const wire: WireError = {
        message: error.message, classification, retryable: (error as Error & { retryable?: unknown }).retryable !== false,
        ...(typeof status === "number" ? { status } : {}),
      }
      if ((typeof status === "number" && STOPPING_STATUS.has(status)) || STOPPING_CLASSIFICATION.has(classification)) {
        stopped = { ...wire, retryable: false }
      }
      emitNervesEvent({ component: "eval", level: "error", event: "eval.proxy_turn_error", message: "proxied provider turn failed", meta: { turn, classification, status: wire.status ?? null, stopped: Boolean(stopped) } })
      channel.send({ type: "error", turn, error: stopped ?? wire })
    } finally {
      aborts.delete(turn)
    }
  }
}
