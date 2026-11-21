import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"
import type { ChannelCallbacks, ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import type { TurnResult } from "../../../heart/streaming"
import { createProxyRuntime, createStreamChannel, serveProxyRuntime, type ProxyChannel, type ProxyMessage } from "../../../eval/transport/provider-proxy"

/** Two in-memory channel ends; each message is cloned and delivered on a later microtask, as over a pipe. */
function channelPair(): { guest: ProxyChannel; host: ProxyChannel; wire: ProxyMessage[] } {
  const toGuest: Array<(msg: ProxyMessage) => void> = []
  const toHost: Array<(msg: ProxyMessage) => void> = []
  const wire: ProxyMessage[] = []
  const deliver = (listeners: typeof toGuest) => (msg: ProxyMessage) => {
    wire.push(msg)
    const copy = structuredClone(msg)
    queueMicrotask(() => { for (const listener of listeners) listener(copy) })
  }
  return {
    guest: { send: deliver(toHost), onMessage: (fn) => { toGuest.push(fn) } },
    host: { send: deliver(toGuest), onMessage: (fn) => { toHost.push(fn) } },
    wire,
  }
}

const RESULT: TurnResult = { content: "hello there", toolCalls: [{ id: "c1", name: "settle", arguments: "{}" }], outputItems: [] }

type HostLog = Array<[string, ...unknown[]]>

function hostRuntime(log: HostLog, streamTurn?: ProviderRuntime["streamTurn"], extra: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    id: "github-copilot", model: "host-model", client: { secret: "never crosses" }, capabilities: new Set(["reasoning-effort"]),
    supportedReasoningEfforts: ["low", "high"],
    streamTurn: streamTurn ?? (async (request) => {
      log.push(["streamTurn", request.messages, request.activeTools, request.reasoningEffort])
      request.callbacks.onModelStreamStart()
      request.callbacks.onTextChunk("hello ")
      request.callbacks.onTextChunk("there")
      return RESULT
    }),
    appendToolOutput: (callId, output) => { log.push(["appendToolOutput", callId, output]) },
    resetTurnState: (messages) => { log.push(["resetTurnState", messages]) },
    ping: async () => undefined,
    classifyError: (error) => (error as Error & { status?: number }).status === 429 ? "rate-limit" : "unknown",
    ...extra,
  }
}

function recordingCallbacks(events: unknown[][], extra: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
  const record = (name: string) => (...args: unknown[]) => { events.push([name, ...args]) }
  return {
    onModelStart: record("onModelStart"), onModelStreamStart: record("onModelStreamStart"), onTextChunk: record("onTextChunk"),
    onReasoningChunk: record("onReasoningChunk"), onToolStart: record("onToolStart"), onToolEnd: record("onToolEnd"),
    onError: (error, severity) => { events.push(["onError", error.message, severity]) },
    ...extra,
  }
}

function request(callbacks: ChannelCallbacks, extra: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest {
  return { messages: [{ role: "user", content: "hi" }], activeTools: [], callbacks, ...extra }
}

const unlimited = { take: () => true }

describe("provider proxy", () => {
  it("knows the host runtime's identity, capabilities and reasoning efforts before the first turn", async () => {
    const { guest, host, wire } = channelPair()
    serveProxyRuntime(host, hostRuntime([]), unlimited)
    const runtime = await createProxyRuntime(guest)
    expect(wire.map((msg) => msg.type)).toEqual(["hello", "capabilities"])
    expect(runtime.id).toBe("github-copilot")
    expect(runtime.model).toBe("host-model")
    expect([...runtime.capabilities]).toEqual(["reasoning-effort"])
    expect(runtime.supportedReasoningEfforts).toEqual(["low", "high"])
    expect(runtime.client).toBeNull()
    await expect(runtime.ping()).resolves.toBeUndefined()
  })

  it("leaves reasoning efforts unset when the host runtime has none", async () => {
    const { guest, host } = channelPair()
    serveProxyRuntime(host, hostRuntime([], undefined, { supportedReasoningEfforts: undefined }), unlimited)
    const runtime = await createProxyRuntime(guest)
    expect("supportedReasoningEfforts" in runtime).toBe(false)
  })

  it("streams the host's callback events to the guest in order and resolves with the host's result", async () => {
    const { guest, host, wire } = channelPair()
    const log: HostLog = []
    serveProxyRuntime(host, hostRuntime(log), unlimited)
    const runtime = await createProxyRuntime(guest)
    const events: unknown[][] = []
    const messages = [{ role: "user" as const, content: "find the book" }]
    const result = await runtime.streamTurn(request(recordingCallbacks(events), { messages, reasoningEffort: "high" }))
    expect(result).toEqual(RESULT)
    expect(events).toEqual([["onModelStreamStart"], ["onTextChunk", "hello "], ["onTextChunk", "there"]])
    expect(log).toEqual([["streamTurn", messages, [], "high"]])
    expect(JSON.stringify(wire)).not.toContain("never crosses")
  })

  it("passes the settle output mode through, and carries a host onError back as an Error", async () => {
    const { guest, host } = channelPair()
    let seenMode: unknown
    serveProxyRuntime(host, hostRuntime([], async (req) => {
      seenMode = req.callbacks.settleOutputMode
      req.callbacks.onError(new Error("slow down"), "transient")
      return RESULT
    }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const events: unknown[][] = []
    await runtime.streamTurn(request(recordingCallbacks(events, { settleOutputMode: "retractable_buffer" })))
    expect(seenMode).toBe("retractable_buffer")
    expect(events).toEqual([["onError", "slow down", "transient"]])
  })

  it("sends appendToolOutput and resetTurnState to the host in order with identical arguments", async () => {
    const { guest, host } = channelPair()
    const log: HostLog = []
    serveProxyRuntime(host, hostRuntime(log), unlimited)
    const runtime = await createProxyRuntime(guest)
    const reset = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }]
    runtime.resetTurnState(reset)
    runtime.appendToolOutput("call-1", "first")
    runtime.appendToolOutput("call-2", "second")
    await runtime.streamTurn(request(recordingCallbacks([])))
    expect(log.map(([name]) => name)).toEqual(["resetTurnState", "appendToolOutput", "appendToolOutput", "streamTurn"])
    expect(log[0]).toEqual(["resetTurnState", reset])
    expect(log.slice(1, 3)).toEqual([["appendToolOutput", "call-1", "first"], ["appendToolOutput", "call-2", "second"]])
  })

  it("refuses a turn the budget cannot pay for, without calling the host runtime or allowing a retry", async () => {
    const { guest, host } = channelPair()
    const log: HostLog = []
    serveProxyRuntime(host, hostRuntime(log), { take: () => false })
    const runtime = await createProxyRuntime(guest)
    const failure = await runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "budget exhausted", reason: "budget", retryable: false })
    expect(runtime.classifyError(failure as Error)).toBe("usage-limit")
    expect(log).toEqual([])
  })

  it("rejects with the host's classification on a 429, and stops every later turn without calling the host", async () => {
    const { guest, host } = channelPair()
    let calls = 0
    serveProxyRuntime(host, hostRuntime([], async () => {
      calls += 1
      throw Object.assign(new Error("too many requests"), { status: 429 })
    }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const first = await runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(runtime.classifyError(first as Error)).toBe("rate-limit")
    expect(first).toMatchObject({ message: "too many requests", status: 429, reason: "provider", retryable: false })
    const second = await runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(second).toMatchObject({ message: "the provider stopped this run earlier: too many requests", status: 429, reason: "stopped", retryable: false })
    expect(runtime.classifyError(second as Error)).toBe("rate-limit")
    expect(calls).toBe(1)
  })

  it("stops on a 402 even when the host runtime does not classify it", async () => {
    const { guest, host } = channelPair()
    serveProxyRuntime(host, hostRuntime([], async () => { throw Object.assign(new Error("payment required"), { status: 402 }) }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const failure = await runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(failure).toMatchObject({ status: 402, retryable: false })
    expect(runtime.classifyError(failure as Error)).toBe("unknown")
  })

  it("stops on a usage-limit classification that carries no status", async () => {
    const { guest, host } = channelPair()
    let calls = 0
    serveProxyRuntime(host, hostRuntime([], async () => { calls += 1; throw new Error("quota spent") }, { classifyError: () => "usage-limit" }), unlimited)
    const runtime = await createProxyRuntime(guest)
    await runtime.streamTurn(request(recordingCallbacks([]))).catch(() => undefined)
    const second = await runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(second).toMatchObject({ message: "the provider stopped this run earlier: quota spent", reason: "stopped", retryable: false })
    expect("status" in (second as object)).toBe(false)
    expect(calls).toBe(1)
  })

  it("passes other host errors through, never retryable, and keeps serving later turns", async () => {
    const { guest, host } = channelPair()
    let calls = 0
    serveProxyRuntime(host, hostRuntime([], async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("bad gateway"), { status: 502 })
      if (calls === 2) throw Object.assign(new Error("malformed"), { retryable: false })
      if (calls === 3) throw "not an error object"
      return RESULT
    }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const turn = () => runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(await turn()).toMatchObject({ message: "bad gateway", status: 502, reason: "provider", retryable: false })
    expect(await turn()).toMatchObject({ message: "malformed", retryable: false })
    expect(await turn()).toMatchObject({ message: "not an error object", retryable: false })
    expect(await turn()).toEqual(RESULT)
    expect(runtime.classifyError(new Error("local"))).toBe("unknown")
  })

  it("sends an abort instead of the signal, and the host's runtime sees its own signal abort", async () => {
    const { guest, host, wire } = channelPair()
    let hostSignal: AbortSignal | undefined
    serveProxyRuntime(host, hostRuntime([], (req) => new Promise((_resolve, reject) => {
      hostSignal = req.signal
      req.signal!.addEventListener("abort", () => reject(new Error("aborted")))
    })), unlimited)
    const runtime = await createProxyRuntime(guest)
    const controller = new AbortController()
    const pending = runtime.streamTurn(request(recordingCallbacks([]), { signal: controller.signal })).catch((error: Error) => error)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    expect(await pending).toMatchObject({ message: "aborted" })
    expect(hostSignal!.aborted).toBe(true)
    const turnMessage = wire.find((msg) => msg.type === "streamTurn")!
    expect(JSON.stringify(turnMessage)).not.toContain("signal")
    expect(wire.some((msg) => msg.type === "abort")).toBe(true)
  })

  it("fails a turn whose signal is already aborted without reaching the host or spending budget", async () => {
    const { guest, host, wire } = channelPair()
    const log: HostLog = []
    let units = 0
    serveProxyRuntime(host, hostRuntime(log), { take: () => { units += 1; return true } })
    const runtime = await createProxyRuntime(guest)
    const failure = await runtime.streamTurn(request(recordingCallbacks([]), { signal: AbortSignal.abort() })).catch((error: Error) => error)
    expect(failure).toMatchObject({ message: "aborted before the provider call", reason: "aborted", retryable: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).toEqual([])
    expect(units).toBe(0)
    expect(wire.some((msg) => msg.type === "streamTurn")).toBe(false)
  })

  it("stops listening to a turn's signal once the turn is over", async () => {
    const { guest, host, wire } = channelPair()
    serveProxyRuntime(host, hostRuntime([]), unlimited)
    const runtime = await createProxyRuntime(guest)
    const controller = new AbortController()
    await runtime.streamTurn(request(recordingCallbacks([]), { signal: controller.signal }))
    controller.abort()
    expect(wire.some((msg) => msg.type === "abort")).toBe(false)
  })

  it("fails the turn when a guest callback throws, tells the host to stop, and drops the callbacks after it", async () => {
    const { guest, host, wire } = channelPair()
    let hostSignal: AbortSignal | undefined
    serveProxyRuntime(host, hostRuntime([], async (req) => {
      hostSignal = req.signal
      req.callbacks.onTextChunk("one")
      req.callbacks.onTextChunk("two")
      await new Promise((resolve) => setTimeout(resolve, 0))
      return RESULT
    }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const events: unknown[][] = []
    const failure = await runtime.streamTurn(request(recordingCallbacks(events, {
      onTextChunk: (text) => { events.push(["onTextChunk", text]); throw new Error("display failed") },
    }))).catch((error: Error) => error)
    expect(failure).toMatchObject({ message: "display failed", reason: "callback", retryable: false })
    expect((failure as Error).cause).toMatchObject({ message: "display failed" })
    expect(events).toEqual([["onTextChunk", "one"]])
    expect(wire.filter((msg) => msg.type === "abort")).toHaveLength(1)
    expect(hostSignal!.aborted).toBe(true)
  })

  it("fails with the callback's own failure when the host then reports an error, and wraps a thrown value that is not an Error", async () => {
    const { guest, host } = channelPair()
    serveProxyRuntime(host, hostRuntime([], (req) => new Promise((_resolve, reject) => {
      req.callbacks.onTextChunk("one")
      req.signal!.addEventListener("abort", () => reject(new Error("aborted")))
    })), unlimited)
    const runtime = await createProxyRuntime(guest)
    const failure = await runtime.streamTurn(request(recordingCallbacks([], {
      onTextChunk: () => { throw "render broke" },
    }))).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "render broke", retryable: false })
  })

  it("fails the turn when the callback's error cannot be changed", async () => {
    const { guest, host } = channelPair()
    serveProxyRuntime(host, hostRuntime([]), unlimited)
    const runtime = await createProxyRuntime(guest)
    const frozen = Object.freeze(new Error("frozen failure"))
    const failure = await runtime.streamTurn(request(recordingCallbacks([], { onModelStreamStart: () => { throw frozen } }))).catch((error: Error) => error)
    expect(failure).toMatchObject({ message: "frozen failure", reason: "callback", retryable: false })
    expect((failure as Error).cause).toBe(frozen)
  })

  it("emits the guest's start, end and error events for each turn", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((event) => events.push(event))
    try {
      const { guest, host } = channelPair()
      let calls = 0
      serveProxyRuntime(host, hostRuntime([], async () => { calls += 1; if (calls === 2) throw new Error("bad gateway"); return RESULT }), unlimited)
      const runtime = await createProxyRuntime(guest)
      await runtime.streamTurn(request(recordingCallbacks([])))
      await runtime.streamTurn(request(recordingCallbacks([]))).catch(() => undefined)
    } finally {
      unregister()
    }
    expect(events.map((event) => event.event).filter((name) => name.startsWith("eval.proxy_guest"))).toEqual([
      "eval.proxy_guest_turn_start", "eval.proxy_guest_turn_end", "eval.proxy_guest_turn_start", "eval.proxy_guest_turn_error",
    ])
  })

  it("refuses a second turn while one is in flight, without calling the host for it", async () => {
    const { guest, host } = channelPair()
    let calls = 0
    let finish: (result: TurnResult) => void = () => undefined
    serveProxyRuntime(host, hostRuntime([], () => { calls += 1; return new Promise((resolve) => { finish = resolve }) }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const first = runtime.streamTurn(request(recordingCallbacks([])))
    const second = await runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    expect(second).toMatchObject({ reason: "busy", retryable: false })
    finish(RESULT)
    expect(await first).toEqual(RESULT)
    expect(calls).toBe(1)
  })

  it("carries a host onError whose value is not an Error", async () => {
    const { guest, host } = channelPair()
    serveProxyRuntime(host, hostRuntime([], async (req) => {
      ;(req.callbacks.onError as (error: unknown, severity: string) => void)("plain text", "terminal")
      return RESULT
    }), unlimited)
    const runtime = await createProxyRuntime(guest)
    const events: unknown[][] = []
    await runtime.streamTurn(request(recordingCallbacks(events)))
    expect(events).toEqual([["onError", "plain text", "terminal"]])
  })

  it("ignores messages for turns it does not know, messages meant for the other side, callback events outside the provider set, and an abort for a finished turn", async () => {
    const { guest, host } = channelPair()
    const log: HostLog = []
    serveProxyRuntime(host, hostRuntime(log), unlimited)
    const runtime = await createProxyRuntime(guest)
    const events: unknown[][] = []
    host.send({ type: "turnResult", turn: 99, result: RESULT })
    host.send({ type: "callback", turn: 99, event: "onTextChunk", args: ["stray"] })
    guest.send({ type: "abort", turn: 99 })
    host.send({ type: "hello" })
    guest.send({ type: "turnResult", turn: 1, result: RESULT })
    const pending = runtime.streamTurn(request(recordingCallbacks(events)))
    host.send({ type: "callback", turn: 1, event: "flushNow", args: [] })
    host.send({ type: "callback", turn: 1, event: "onKick", args: [] })
    await pending
    expect(events).toEqual([["onModelStreamStart"], ["onTextChunk", "hello "], ["onTextChunk", "there"]])
  })
})

describe("createStreamChannel", () => {
  it("carries messages as newline-delimited JSON, across chunk boundaries and blank lines", async () => {
    const hostToGuest = new PassThrough()
    const guestToHost = new PassThrough()
    const guest = createStreamChannel(hostToGuest, guestToHost)
    const host = createStreamChannel(guestToHost, hostToGuest)
    const log: HostLog = []
    serveProxyRuntime(host, hostRuntime(log), unlimited)
    const ready = createProxyRuntime(guest)
    const runtime = await ready
    const events: unknown[][] = []
    const result = await runtime.streamTurn(request(recordingCallbacks(events)))
    expect(result).toEqual(RESULT)
    expect(events).toHaveLength(3)

    const input = new PassThrough()
    const received: ProxyMessage[] = []
    createStreamChannel(input, new PassThrough()).onMessage((msg) => received.push(msg))
    const line = JSON.stringify({ type: "hello" })
    input.write(line.slice(0, 5))
    input.write(`${line.slice(5)}\n\n${JSON.stringify({ type: "abort", turn: 3 })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toEqual([{ type: "hello" }, { type: "abort", turn: 3 }])
  })

  it("keeps a character whose bytes are split across chunks", async () => {
    const input = new PassThrough()
    const received: ProxyMessage[] = []
    createStreamChannel(input, new PassThrough()).onMessage((msg) => received.push(msg))
    const bytes = Buffer.from(`${JSON.stringify({ type: "appendToolOutput", callId: "c", output: "Ålmanac — ✓" })}\n`, "utf8")
    const cut = bytes.indexOf(Buffer.from("✓", "utf8")) + 1
    input.write(bytes.subarray(0, cut))
    input.write(bytes.subarray(cut))
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toEqual([{ type: "appendToolOutput", callId: "c", output: "Ålmanac — ✓" }])
  })

  it("never throws on a line that is not a message: the host keeps serving, and the guest's turn fails and aborts the host call", async () => {
    const hostToGuest = new PassThrough()
    const guestToHost = new PassThrough()
    const guest = createStreamChannel(hostToGuest, guestToHost)
    const host = createStreamChannel(guestToHost, hostToGuest)
    let release: () => void = () => undefined
    serveProxyRuntime(host, hostRuntime([], async () => { await new Promise<void>((resolve) => { release = resolve }); return RESULT }), unlimited)
    guestToHost.write("npm warn something\n42\n{\"no\":\"type\"}\n")
    const runtime = await createProxyRuntime(guest)
    const pending = runtime.streamTurn(request(recordingCallbacks([]))).catch((error: Error) => error)
    await new Promise((resolve) => setImmediate(resolve))
    const sent: string[] = []
    guestToHost.on("data", (chunk: string | Buffer) => sent.push(chunk.toString()))
    hostToGuest.write("Traceback (most recent call last)\n")
    expect(await pending).toMatchObject({ reason: "channel", retryable: false, message: expect.stringContaining("Traceback") })
    expect(sent.join("")).toContain(JSON.stringify({ type: "abort", turn: 1 }))
    release()
  })

  it("turns a message of a known type but the wrong shape into a broken channel, before the host spends anything", async () => {
    const guestToHost = new PassThrough()
    const hostToGuest = new PassThrough()
    const host = createStreamChannel(guestToHost, hostToGuest)
    const log: HostLog = []
    let units = 0
    serveProxyRuntime(host, hostRuntime(log), { take: () => { units += 1; return true } })
    const replies: ProxyMessage[] = []
    createStreamChannel(hostToGuest, new PassThrough()).onMessage((msg) => replies.push(msg))
    const bad = [
      { type: "streamTurn", turn: 1 }, { type: "streamTurn", turn: "1", request: { messages: [] } }, { type: "streamTurn", turn: 1, request: { messages: "x" } },
      { type: "resetTurnState" }, { type: "appendToolOutput", callId: 1, output: "x" }, { type: "abort" }, { type: "mystery" },
      { type: "capabilities", id: "x" }, { type: "callback", turn: 1, event: "onTextChunk" }, { type: "turnResult", turn: 1 }, { type: "error", turn: 1, error: {} },
    ]
    guestToHost.write(bad.map((msg) => JSON.stringify(msg)).join("\n") + "\n")
    await new Promise((resolve) => setImmediate(resolve))
    expect(units).toBe(0)
    expect(log).toEqual([])
    guestToHost.write(`${JSON.stringify({ type: "streamTurn", turn: 2, request: { messages: [{ role: "user", content: "hi" }], activeTools: [] } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(replies.map((msg) => msg.type)).toContain("turnResult")
    expect(units).toBe(1)
  })

  it("survives a listener that throws, reporting it instead of crashing the stream", async () => {
    const input = new PassThrough()
    const channel = createStreamChannel(input, new PassThrough())
    const received: ProxyMessage[] = []
    channel.onMessage(() => { throw new Error("listener broke") })
    channel.onMessage(() => { throw "listener broke too" })
    channel.onMessage((msg) => received.push(msg))
    input.write(`${JSON.stringify({ type: "hello" })}\n${JSON.stringify({ type: "abort", turn: 1 })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toEqual([{ type: "hello" }, { type: "abort", turn: 1 }])
  })

  it("keeps serving when the host runtime throws on a state call", async () => {
    const hostToGuest = new PassThrough()
    const guestToHost = new PassThrough()
    const guest = createStreamChannel(hostToGuest, guestToHost)
    const host = createStreamChannel(guestToHost, hostToGuest)
    serveProxyRuntime(host, hostRuntime([], undefined, { resetTurnState: () => { throw new Error("state broke") } }), unlimited)
    const runtime = await createProxyRuntime(guest)
    runtime.resetTurnState([])
    expect(await runtime.streamTurn(request(recordingCallbacks([])))).toEqual(RESULT)
  })

  it("reports a failed stream as a broken channel rather than an unhandled error", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const received: ProxyMessage[] = []
    createStreamChannel(input, output).onMessage((msg) => received.push(msg))
    output.emit("error", new Error("EPIPE"))
    input.emit("error", new Error("closed"))
    expect(received).toEqual([{ type: "invalid", reason: "output failed: EPIPE" }, { type: "invalid", reason: "input failed: closed" }])
  })
})
