import { describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import { createBudgetLedger } from "../../../eval/budget"
import { CALL_LIMITS, createInterviewLatch, guardedRuntime, RefusedCall, requestText, SESSION_CALLS, type SessionLatch } from "../../../eval/interviews/latch"

const usage = { input_tokens: 20_000, output_tokens: 1_000, reasoning_tokens: 0, total_tokens: 21_000 }
const pricing = { premiumPerCall: 1, creditsPerMillionInput: 30, creditsPerMillionOutput: 120 }

function runtime(streamTurn?: ProviderRuntime["streamTurn"]): ProviderRuntime & { sent: number } {
  const rt = {
    sent: 0,
    id: "minimax", model: "MiniMax-M3", client: null, capabilities: new Set(),
    streamTurn: async (request: ProviderTurnRequest) => {
      rt.sent += 1
      return streamTurn ? streamTurn(request) : { content: "ok", toolCalls: [], outputItems: [], usage }
    },
    appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined,
    classifyError: (error: Error) => ((error as { status?: number }).status === 429 ? "rate-limit" : "unknown"),
  }
  return rt as unknown as ProviderRuntime & { sent: number }
}

const request = (text: string): ProviderTurnRequest => ({ messages: [{ role: "user", content: text }], activeTools: [], callbacks: {} as never })

function session(caps = { premium: 100, credits: 100 }, perCall = 0.5): { latch: SessionLatch; ledger: ReturnType<typeof createBudgetLedger> } {
  const ledger = createBudgetLedger(caps)
  const reserved = createInterviewLatch({ ledger, pricing, perCall: () => ({ premium: 1, credits: perCall }) }).reserve("X-pilot")
  if ("refused" in reserved) throw new Error(reserved.refused)
  return { latch: reserved, ledger }
}

describe("the interview latch", () => {
  it("reserves a session's worst case of 44 calls before it starts, and refuses one that could pass a cap", () => {
    expect(SESSION_CALLS).toBe(44)
    expect(CALL_LIMITS).toEqual({ job: 12, debrief: 2, choose: 1, identify: 1 })
    const ledger = createBudgetLedger({ premium: 50 })
    const latch = createInterviewLatch({ ledger, pricing, perCall: () => ({ premium: 1, credits: 0 }) })
    const first = latch.reserve("X-1")
    expect("refused" in first).toBe(false)
    expect(ledger.totals().held.premium).toBe(44)
    expect(latch.reserve("X-2")).toMatchObject({ refused: expect.stringContaining("premium") })
    expect(latch.reserve("small", 6)).not.toHaveProperty("refused")
    expect(latch.ledger).toBe(ledger)
  })

  it("lets each conversation take its own limit of calls, then refuses, and lets the nudge through once", () => {
    const { latch } = session()
    const job = latch.gate("job")
    for (let i = 0; i < 12; i += 1) expect(job.take()).toBe(true)
    expect(job.take()).toBe(false)
    expect(job.refused()).toBe("the job conversation's call limit of 12 is used up")
    expect(job.calls()).toBe(12)
    const choose = latch.gate("choose")
    expect(choose.take()).toBe(true)
    expect(choose.take()).toBe(false)
    choose.allowOneMore()
    expect(choose.take()).toBe(true)
    expect(choose.kind).toBe("choose")
  })

  it("refuses a call the session's hold cannot cover, saying why", () => {
    const small = createBudgetLedger({ premium: 100 })
    const tiny = createInterviewLatch({ ledger: small, pricing, perCall: () => ({ premium: 1, credits: 0 }) }).reserve("t", 1) as SessionLatch
    const gate = tiny.gate("job")
    expect(gate.take()).toBe(true)
    expect(gate.take()).toBe(false)
    expect(gate.refused()).toBe("the session's 1 calls are used up")

    const { latch, ledger } = session()
    ledger.stop("the provider answered 429")
    const after = latch.gate("debrief")
    expect(after.take()).toBe(false)
    expect(after.refused()).toBe("the budget stopped: the provider answered 429")

    const credits = createBudgetLedger({ credits: 100 })
    const cut = createInterviewLatch({ ledger: credits, pricing, perCall: () => ({ premium: 0, credits: 0.1 }) }).reserve("c", 3) as SessionLatch
    cut.hold.take()
    cut.hold.settle({ ...usage, input_tokens: 1_000_000 })
    const g = cut.gate("job")
    expect(g.take()).toBe(false)
    expect(g.refused()).toBe("the session's credit reservation is used up")
  })
})

describe("the guarded runtime", () => {
  it("sends a clean request, counts it on the conversation's gate and records its usage and credits", async () => {
    const { latch, ledger } = session()
    const inner = runtime()
    const resets: unknown[] = []
    inner.resetTurnState = (messages) => { resets.push(messages) }
    const logged: Array<{ kind: string; sent: boolean }> = []
    const gate = latch.gate("job")
    const guarded = guardedRuntime({ inner, latch, ledger, pricing, gateFor: () => gate, log: (entry) => logged.push({ kind: entry.kind, sent: entry.sent }) })
    await expect(guarded.streamTurn(request("find the almanac"))).resolves.toMatchObject({ content: "ok" })
    expect(gate.calls()).toBe(1)
    // The provider rebuilds its body from the scanned messages before every call.
    expect(resets).toEqual([[{ role: "user", content: "find the almanac" }]])
    expect(latch.calls()).toEqual([{ kind: "job", usage, credits: 0.72, sent: true }])
    expect(logged).toEqual([{ kind: "job", sent: true }])
    expect(guarded.model).toBe("MiniMax-M3")
    await expect(guarded.ping()).resolves.toBeUndefined()
    expect(guarded.classifyError(new RefusedCall("x", "limit"))).toBe("unknown")
    expect(guarded.classifyError(Object.assign(new Error("slow"), { status: 429 }))).toBe("rate-limit")
    expect(latch.voided()).toBeNull()
    expect(latch.release().premium).toBe(1)
  })

  it("refuses a request with brand words unsent and voids the session", async () => {
    const { latch, ledger } = session()
    const inner = runtime()
    const logged: boolean[] = []
    const gate = latch.gate("job")
    const guarded = guardedRuntime({ inner, latch, ledger, pricing, gateFor: () => gate, log: (entry) => logged.push(entry.sent) })
    await expect(guarded.streamTurn(request("path /home/ouro/x and OURO"))).rejects.toThrow("not sent: the request names ouro")
    await expect(guarded.streamTurn({ ...request("clean"), systemPrompt: "I am Claude" } as ProviderTurnRequest)).rejects.toBeInstanceOf(RefusedCall)
    expect(inner.sent).toBe(0)
    expect(gate.calls()).toBe(0)
    expect(latch.voided()).toEqual(["ouro", "OURO"])
    expect(logged).toEqual([false, false])
    expect(latch.calls().every((call) => !call.sent)).toBe(true)
  })

  it("refuses a call past the gate unsent, and records a provider error as a sent call with no usage", async () => {
    const { latch, ledger } = session()
    const gate = latch.gate("identify")
    const failing = runtime(async () => { throw Object.assign(new Error("busy"), { status: 429 }) })
    const guarded = guardedRuntime({ inner: failing, latch, ledger, pricing, gateFor: () => gate, log: () => undefined })
    await expect(guarded.streamTurn(request("q4"))).rejects.toThrow("busy")
    expect(ledger.stopped()).toMatch(/429/)
    await expect(guarded.streamTurn(request("q4 again"))).rejects.toThrow(/not sent: the identify conversation's call limit of 1 is used up/)
    expect(latch.calls()).toEqual([{ kind: "identify", usage: null, credits: 0, sent: true }])
    const fresh = session()
    const noUsage = runtime(async () => ({ content: "", toolCalls: [], outputItems: [] }))
    const g2 = fresh.latch.gate("job")
    await guardedRuntime({ inner: noUsage, latch: fresh.latch, ledger: fresh.ledger, pricing, gateFor: () => g2, log: () => undefined }).streamTurn(request("x"))
    expect(fresh.latch.calls()).toEqual([{ kind: "job", usage: null, credits: 0, sent: true }])
  })

  it("rewrites a request with the arm's replacement list before the scan, sends the rewritten one, and gives the harness its own tool names back", async () => {
    const { latch, ledger } = session()
    const gate = latch.gate("job")
    const seen: ProviderTurnRequest[] = []
    const resets: unknown[] = []
    const inner = runtime(async (sent) => {
      seen.push(sent)
      return { content: "ok", toolCalls: [{ id: "c1", name: "agent_shell", arguments: "{\"cmd\":\"ls /home/agent\"}" }], outputItems: [], usage }
    })
    inner.resetTurnState = (messages) => { resets.push(messages) }
    const logged: string[] = []
    const replacements = [{ pattern: /ouro/gi, with: "agent" }]
    const guarded = guardedRuntime({ inner, latch, ledger, pricing, gateFor: () => gate, log: (entry) => logged.push(entry.body), replacements })
    const own: ProviderTurnRequest = {
      ...request("list /home/ouro"), systemPrompt: { stable: "You are Ouro.", volatile: "" },
      activeTools: [{ type: "function", function: { name: "ouro_shell", description: "Ouro's shell" } }],
    }
    const result = await guarded.streamTurn(own)
    // The model was sent only the rewritten request, and that is what was scanned, logged and reset.
    expect(seen[0]!.messages).toEqual([{ role: "user", content: "list /home/agent" }])
    expect(seen[0]!.systemPrompt).toEqual({ stable: "You are agent.", volatile: "" })
    expect(seen[0]!.activeTools[0]!.function.name).toBe("agent_shell")
    expect(resets).toEqual([[{ role: "user", content: "list /home/agent" }]])
    expect(logged[0]).not.toMatch(/ouro/i)
    expect(latch.voided()).toBeNull()
    // The harness's request is its own, and the model's call comes back under the harness's tool name.
    expect(own.messages).toEqual([{ role: "user", content: "list /home/ouro" }])
    expect(result.toolCalls).toEqual([{ id: "c1", name: "ouro_shell", arguments: "{\"cmd\":\"ls /home/agent\"}" }])
  })

  it("still voids a session whose rewritten request leaks a brand word the list missed", async () => {
    const { latch, ledger } = session()
    const gate = latch.gate("job")
    const inner = runtime()
    const logged: Array<{ sent: boolean; body: string }> = []
    const guarded = guardedRuntime({ inner, latch, ledger, pricing, gateFor: () => gate, log: (entry) => logged.push(entry), replacements: [{ pattern: /ouro/gi, with: "agent" }] })
    await expect(guarded.streamTurn(request("ouro, based on Claude"))).rejects.toThrow("not sent: the request names claude")
    expect(inner.sent).toBe(0)
    expect(latch.voided()).toEqual(["Claude"])
    // The log holds the rewritten body the scan read.
    expect(logged).toEqual([{ kind: "job", sent: false, body: expect.stringContaining("agent, based on Claude") }])
  })

  it("scans the system prompt, tools, deferred tools and messages", () => {
    const text = requestText({ ...request("m"), systemPrompt: "s", activeTools: [{ type: "function", function: { name: "t", parameters: {} } }], deferredTools: [] } as unknown as ProviderTurnRequest)
    expect(JSON.parse(text)).toEqual({ systemPrompt: "s", tools: [{ type: "function", function: { name: "t", parameters: {} } }], deferred: [], messages: [{ role: "user", content: "m" }] })
    expect(JSON.parse(requestText(request("m")))).toMatchObject({ systemPrompt: null, deferred: [] })
    expect(JSON.parse(requestText(request("m")))).not.toHaveProperty("traceId")
    // A provider may send the trace id as metadata, so it is scanned too.
    expect(JSON.parse(requestText({ ...request("m"), traceId: "ouro-turn-1" }))).toMatchObject({ traceId: "ouro-turn-1" })
  })
})
