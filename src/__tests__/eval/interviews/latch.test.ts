import { describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import { createBudgetLedger } from "../../../eval/budget"
import { CALL_LIMITS, createInterviewLatch, guardedRuntime, RefusedCall, requestText, SESSION_CALLS, type SessionLatch } from "../../../eval/interviews/latch"
import { brandHits, scannedText } from "../../../eval/interviews/protocol"

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
  it("reserves a session's worst case of 45 calls, the nudge included, before it starts, and refuses one that could pass a cap", () => {
    // 3 jobs at 12, 3 debriefs at 2, the choice and the blinding check at 1, and the one nudge the choice may get
    expect(SESSION_CALLS).toBe(3 * CALL_LIMITS.job + 3 * CALL_LIMITS.debrief + CALL_LIMITS.choose + CALL_LIMITS.identify + 1)
    expect(CALL_LIMITS).toEqual({ job: 12, debrief: 2, choose: 1, identify: 1 })
    const ledger = createBudgetLedger({ premium: 50 })
    const latch = createInterviewLatch({ ledger, pricing, perCall: () => ({ premium: 1, credits: 0 }) })
    const first = latch.reserve("X-1")
    expect("refused" in first).toBe(false)
    expect(ledger.totals().held.premium).toBe(45)
    expect(latch.reserve("X-2")).toMatchObject({ refused: expect.stringContaining("premium") })
    expect(latch.reserve("small", 5)).not.toHaveProperty("refused")
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
    const lines: unknown[] = []
    const replacements = [{ pattern: /ouro/gi, with: "agent", tier: "word" }]
    const rewrites = { path: 1 }
    const guarded = guardedRuntime({ inner, latch, ledger, pricing, gateFor: () => gate, log: (entry) => { logged.push(entry.body); lines.push(entry) }, replacements, rewrites })
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
    // The request's matches, by tier, are on its log line and added to the arm's running count.
    expect(lines[0]).toMatchObject({ kind: "job", sent: true, rewrites: { word: 4 } })
    expect(rewrites).toStrictEqual({ path: 1, word: 4 })
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
    expect(logged).toEqual([{ kind: "job", sent: false, body: expect.stringContaining("agent, based on Claude"), rewrites: { list: 1 } }])
  })

  it("leaves a provider's encrypted reasoning out of the scan and the rewrite, and scans and rewrites everything else, summaries included", async () => {
    // Encrypted reasoning is opaque base64 the scan can't read, and its letters can spell a brand word
    // by chance: the 2026-11-23 H pilot was voided on "GPT" inside one.
    const blob = "x9hJJLGPTyhe+OURO/Claude0wDl="
    const withReasoning = (summary: unknown[], ask = "find the almanac"): ProviderTurnRequest => ({ ...request(ask), messages: [
      { role: "user", content: ask },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "{}" } }], _reasoning_items: [{ type: "reasoning", id: "rs_1", encrypted_content: blob, summary }] },
      { role: "tool", tool_call_id: "c1", content: "187" },
    ] } as unknown as ProviderTurnRequest)
    const guard = () => {
      const { latch, ledger } = session()
      const gate = latch.gate("job")
      const seen: ProviderTurnRequest[] = []
      const inner = runtime(async (sent) => { seen.push(sent); return { content: "ok", toolCalls: [], outputItems: [], usage } })
      const logged: Array<{ sent: boolean; body: string; rewrites?: Record<string, number> }> = []
      const guarded = guardedRuntime({ inner, latch, ledger, pricing, gateFor: () => gate, log: (entry) => logged.push(entry), replacements: [{ pattern: /ouro/gi, with: "agent", tier: "word" }] })
      return { latch, seen, logged, guarded, inner }
    }

    const clean = guard()
    await expect(clean.guarded.streamTurn(withReasoning([{ type: "summary_text", text: "Looking in ouro's catalog." }]))).resolves.toMatchObject({ content: "ok" })
    expect(clean.latch.voided()).toBeNull()
    // The ciphertext is sent and logged exactly as the provider returned it; the summary beside it is rewritten.
    const item = (clean.seen[0]!.messages[1] as unknown as { _reasoning_items: Array<{ encrypted_content: string; summary: Array<{ text: string }> }> })._reasoning_items[0]!
    expect(item.encrypted_content).toBe(blob)
    expect(item.summary[0]!.text).toBe("Looking in agent's catalog.")
    expect(clean.logged).toEqual([{ kind: "job", sent: true, body: expect.stringContaining(blob), rewrites: { word: 1 } }])
    expect(brandHits(scannedText(JSON.parse(clean.logged[0]!.body)))).toEqual([])

    // A brand word in a readable field still voids: in the reasoning's summary, or in a message beside the ciphertext.
    const summary = guard()
    await expect(summary.guarded.streamTurn(withReasoning([{ type: "summary_text", text: "Ask gpt." }]))).rejects.toThrow("not sent: the request names gpt")
    expect(summary.latch.voided()).toEqual(["gpt"])
    const beside = guard()
    await expect(beside.guarded.streamTurn(withReasoning([], "is this gpt?"))).rejects.toThrow("not sent: the request names gpt")
    expect(beside.inner.sent).toBe(0)
    // Only a string under encrypted_content is opaque: any other value there is scanned as it is.
    expect(brandHits(scannedText({ encrypted_content: { text: "gpt" } }))).toEqual(["gpt"])
    // A reasoning item's id is the provider's opaque handle too (Copilot's run to 456 base64 characters), while any
    // other id, a call's included, is scanned.
    expect(brandHits(scannedText([{ type: "reasoning", id: "rs+GPTx/Ouro==", summary: [] }]))).toEqual([])
    expect(brandHits(scannedText([{ type: "function_call", id: "fc_gpt", call_id: "call_ouro" }, { role: "assistant", id: "msg_claude" }]))).toEqual(["gpt", "ouro", "claude"])
  })

  it("reads a brand word in an id only as a whole segment between delimiters, and in readable text anywhere", () => {
    // Random ids (call_ plus 24 base64 letters, about 45 a session) would spell a brand word by chance; an id an arm
    // makes from its own name would not be random. So in an id a brand word counts only between delimiters.
    const ids = (value: string) => brandHits(scannedText({ id: value, call_id: value, tool_call_id: value, response_id: value, previous_response_id: value, item_id: value }))
    for (const random of ["call_abGPTx9Ouro", "fc_8UstjClaude0Im", "resp_xRADIXq", "call_ouroboros2", "msg-gptz"]) expect(ids(random)).toEqual([])
    expect(ids("ouro_call_3")).toEqual(Array(6).fill("ouro"))
    expect(ids("gpt-5")).toEqual(Array(6).fill("gpt"))
    for (const named of ["call.claude", "x:codex:1", "a/openhands/b", "ouroboros", "run_all-hands_2", "call_GPT", "run_mui_1", "x_mui", "mui_1"]) expect(ids(named)).toHaveLength(6)
    expect(ids("call_xmuiz")).toEqual([])
    // Only a string under an id key is an id: a schema property named id is scanned in full.
    expect(brandHits(scannedText({ properties: { id: { type: "string", description: "the gptx handle" } } }))).toEqual(["gpt"])
    // A tool call's id in a chat message is an id too.
    expect(brandHits(scannedText({ tool_calls: [{ id: "call_k6upGPTffAT4", type: "function", function: { name: "shell", arguments: "{}" } }] }))).toEqual([])
    expect(brandHits(scannedText({ tool_calls: [{ id: "call_k6upGPTffAT4", type: "function", function: { name: "gptshell", arguments: "{}" } }] }))).toEqual(["gpt"])
    // Readable fields keep the whole pattern, inside words included.
    expect(brandHits(scannedText({ content: "call_abGPTx9", name: "myouro" }))).toEqual(["GPT", "ouro"])
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
