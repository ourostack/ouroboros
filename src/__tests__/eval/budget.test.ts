import { describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../heart/core"
import { createBudgetLedger, meteredRuntime } from "../../eval/budget"

const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, reasoning_tokens: 0, total_tokens: input + output })
const pricing = { premiumPerCall: 2, creditsPerMillionInput: 400, creditsPerMillionOutput: 2000 }

describe("budget ledger", () => {
  it("refuses a hold whose worst case would pass a cap, before anything is spent", () => {
    const ledger = createBudgetLedger({ premium: 100, credits: 50 })
    expect(ledger.reserve("a", { calls: 24, perCall: { premium: 5, credits: 1 }, pricing })).toMatchObject({ refused: expect.stringContaining("premium") })
    expect(ledger.reserve("b", { calls: 10, perCall: { premium: 2, credits: 6 }, pricing })).toMatchObject({ refused: expect.stringContaining("credits") })
    expect(ledger.totals()).toMatchObject({ spent: { premium: 0, credits: 0 }, held: { premium: 0, credits: 0 }, calls: 0 })
  })

  it("holds a session's worst case, so a second consumer cannot take what the first may still need", () => {
    const ledger = createBudgetLedger({ premium: 60 })
    const first = ledger.reserve("first", { calls: 24, perCall: { premium: 2, credits: 0 }, pricing })
    expect("refused" in first).toBe(false)
    expect(ledger.reserve("second", { calls: 24, perCall: { premium: 2, credits: 0 }, pricing })).toMatchObject({ refused: expect.any(String) })
    if ("refused" in first) throw new Error("unreachable")
    first.take()
    first.settle(usage(1000, 10))
    expect(first.release()).toMatchObject({ premium: 2 })
    expect(ledger.totals().held).toEqual({ premium: 0, credits: 0 })
    expect("refused" in ledger.reserve("second", { calls: 24, perCall: { premium: 2, credits: 0 }, pricing })).toBe(false)
  })

  it("charges every call its premium requests when it is taken, and its credits from the usage it reports", () => {
    const ledger = createBudgetLedger({ premium: 300, credits: 2500 })
    const hold = ledger.reserve("run", { calls: 3, perCall: { premium: 2, credits: 20 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    expect(hold.take()).toBe(true)
    expect(ledger.totals().spent.premium).toBe(2)
    hold.settle(usage(25_000, 800))
    // 25,000 × 400 / 1M + 800 × 2000 / 1M = 10 + 1.6
    expect(hold.spent()).toEqual({ premium: 2, credits: 11.6 })
    expect(ledger.totals()).toMatchObject({ calls: 1, held: { premium: 4, credits: 40 } })
  })

  it("counts a call with no usage report as billed at its reserved worst case", () => {
    const ledger = createBudgetLedger({ credits: 100 })
    const hold = ledger.reserve("run", { calls: 2, perCall: { premium: 0, credits: 30 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    hold.take()
    hold.settle(undefined)
    expect(hold.spent().credits).toBe(30)
  })

  it("refuses the call past the hold's calls, and every call once stopped", () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 1, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    expect(hold.take()).toBe(true)
    expect(hold.take()).toBe(false)
    const other = ledger.reserve("other", { calls: 5, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in other) throw new Error(other.refused)
    ledger.stop("provider said 429")
    expect(other.take()).toBe(false)
    expect(ledger.stopped()).toBe("provider said 429")
    expect(ledger.reserve("later", { calls: 1, perCall: { premium: 1, credits: 0 }, pricing })).toEqual({ refused: "stopped: provider said 429" })
  })

  it("stops once what was really spent passes a cap, and keeps the first reason", () => {
    const ledger = createBudgetLedger({ credits: 20 })
    const hold = ledger.reserve("run", { calls: 4, perCall: { premium: 0, credits: 5 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    hold.take()
    hold.settle(usage(100_000, 0)) // 40 credits, far past the estimate
    expect(ledger.stopped()).toMatch(/credits cap 20 passed/)
    ledger.stop("later reason")
    expect(ledger.stopped()).toMatch(/credits cap 20 passed/)
    expect(hold.take()).toBe(false)
    expect(hold.release()).toEqual({ premium: 0, credits: 40 })
  })

  it("refuses every reservation and the next call once the kill switch is set, and keeps that reason", () => {
    let set: string | undefined
    let asked = 0
    const ledger = createBudgetLedger({ premium: 100 }, { killSwitch: () => { asked += 1; return set } })
    const hold = ledger.reserve("run", { calls: 3, perCall: { premium: 2, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    expect(hold.take()).toBe(true)
    set = "the kill switch /x/STOP is set"
    expect(hold.take()).toBe(false)
    expect(ledger.stopped()).toBe("the kill switch /x/STOP is set")
    expect(ledger.reserve("next", { calls: 1, perCall: { premium: 1, credits: 0 }, pricing })).toEqual({ refused: "stopped: the kill switch /x/STOP is set" })
    const before = asked
    set = undefined
    expect(hold.take()).toBe(false)
    expect(asked).toBe(before)
  })

  it("rejects a negative or non-finite cap or worst case", () => {
    expect(() => createBudgetLedger({ premium: -1 })).toThrow(/premium cap/)
    const ledger = createBudgetLedger({})
    expect(() => ledger.reserve("x", { calls: 0, perCall: { premium: 1, credits: 0 }, pricing })).toThrow(/at least 1 call/)
    expect(() => ledger.reserve("x", { calls: 1, perCall: { premium: Number.NaN, credits: 0 }, pricing })).toThrow(/per-call/)
  })
})

function runtime(streamTurn: ProviderRuntime["streamTurn"]): ProviderRuntime {
  return {
    id: "github-copilot", model: "m", client: null, capabilities: new Set(), streamTurn,
    appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined,
    classifyError: (error) => ((error as { status?: number }).status === 402 ? "usage-limit" : "unknown"),
  }
}

describe("hold limits", () => {
  it("refuses the call that could pass the hold's own credit reservation, and says it was cut short", () => {
    const ledger = createBudgetLedger({ credits: 100 })
    // 4 calls at 1 credit each reserved; the first call really costs 2.6 credits (1,000 in, 1,100 out).
    const hold = ledger.reserve("a", { calls: 4, perCall: { premium: 0, credits: 1 }, pricing })
    if ("refused" in hold) throw new Error("unreachable")
    expect(hold.cutShort()).toBe(false)
    expect(hold.take()).toBe(true)
    hold.settle(usage(1000, 1100))
    expect(hold.take()).toBe(true)
    hold.settle(usage(100, 0))
    // 2.64 spent; one more call at the 1-credit estimate would reach 3.64, still within 4.
    expect(hold.take()).toBe(true)
    hold.settle(usage(1000, 0))
    // 3.04 spent; another would reach 4.04.
    expect(hold.take()).toBe(false)
    expect(hold.cutShort()).toBe(true)
    expect(hold.maxCall()).toBe(2.6)
    expect(hold.release()).toEqual({ premium: 0, credits: 3.04 })
  })

  it("reports no single-call cost before a call settles, and is not cut short by running out of calls", () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("a", { calls: 1, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error("unreachable")
    expect(hold.maxCall()).toBe(0)
    expect(hold.take()).toBe(true)
    expect(hold.take()).toBe(false)
    expect(hold.cutShort()).toBe(false)
  })
})

describe("metered runtime", () => {
  const request = { messages: [], activeTools: [], callbacks: {} } as never

  it("settles each call's usage on its hold", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 2, perCall: { premium: 1, credits: 9 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    const metered = meteredRuntime(runtime(async () => ({ content: "", toolCalls: [], outputItems: [], usage: usage(1_000_000, 0) })), hold, ledger)
    hold.take()
    await metered.streamTurn(request)
    expect(hold.spent()).toEqual({ premium: 1, credits: 400 })
    expect(metered.model).toBe("m")
    expect(metered.classifyError(new Error("x"))).toBe("unknown")
  })

  it("bills a failed call, and stops the ledger on a 402 or 429", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 3, perCall: { premium: 1, credits: 9 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    const fail = (status: number) => meteredRuntime(runtime(async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }) }), hold, ledger)
    hold.take()
    await expect(fail(500).streamTurn(request)).rejects.toThrow("HTTP 500")
    expect(ledger.stopped()).toBeUndefined()
    hold.take()
    await expect(fail(429).streamTurn(request)).rejects.toThrow("HTTP 429")
    expect(ledger.stopped()).toMatch(/429/)
    expect(hold.spent()).toEqual({ premium: 2, credits: 18 })
  })

  /** A runtime that fails with each status in turn, then answers; it counts its sends and the resets before them. */
  const flaky = (statuses: number[], classify?: (error: Error) => string) => {
    const seen = { sent: 0, resets: [] as unknown[] }
    const rt = runtime(async () => {
      const status = statuses[seen.sent]
      seen.sent += 1
      if (status !== undefined) throw Object.assign(new Error(`HTTP ${status}`), { status })
      return { content: "ok", toolCalls: [], outputItems: [], usage: usage(1_000_000, 0) }
    })
    rt.resetTurnState = (messages) => { seen.resets.push(messages) }
    if (classify) rt.classifyError = classify as ProviderRuntime["classifyError"]
    return { rt, seen }
  }
  const backoff = () => {
    const waits: number[] = []
    const retries: Array<[number, number]> = []
    return { waits, retries, retry: { delays: [15_000, 45_000, 120_000], sleep: async (ms: number) => { waits.push(ms) }, onRetry: (attempt: number, delay: number) => { retries.push([attempt, delay]) } } }
  }
  const asked = { messages: [{ role: "user", content: "q" }], activeTools: [], callbacks: {} } as never

  it("with a backoff, sends a call again after a 429, beneath the metering: one call, billed once", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 1, perCall: { premium: 1, credits: 9 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    const { rt, seen } = flaky([429])
    const b = backoff()
    hold.take()
    await expect(meteredRuntime(rt, hold, ledger, b.retry).streamTurn(asked)).resolves.toMatchObject({ content: "ok" })
    expect(seen.sent).toBe(2)
    expect(seen.resets).toEqual([[{ role: "user", content: "q" }]])
    expect(b.waits).toEqual([15_000])
    expect(b.retries).toEqual([[1, 15_000]])
    expect(ledger.stopped()).toBeUndefined()
    expect(ledger.totals().calls).toBe(1)
    expect(hold.spent()).toEqual({ premium: 1, credits: 400 })
  })

  it("retries a rate-limit three times at most, after 15 s, 45 s and 120 s, then lets the fourth 429 stop the ledger", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 2, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    const three = flaky([429, 429, 429])
    const b = backoff()
    hold.take()
    await expect(meteredRuntime(three.rt, hold, ledger, b.retry).streamTurn(asked)).resolves.toMatchObject({ content: "ok" })
    expect(three.seen.sent).toBe(4)
    expect(b.waits).toEqual([15_000, 45_000, 120_000])
    expect(b.retries).toEqual([[1, 15_000], [2, 45_000], [3, 120_000]])
    expect(ledger.stopped()).toBeUndefined()

    // A "rate-limit" classification without a status is retried the same way.
    const four = flaky([429, 429, 429, 429], (error) => ((error as { status?: number }).status === 429 ? "rate-limit" : "unknown"))
    const c = backoff()
    hold.take()
    await expect(meteredRuntime(four.rt, hold, ledger, c.retry).streamTurn(asked)).rejects.toThrow("HTTP 429")
    expect(four.seen.sent).toBe(4)
    expect(c.waits).toEqual([15_000, 45_000, 120_000])
    expect(ledger.stopped()).toBe("the provider answered 429: HTTP 429")
    expect(ledger.totals().calls).toBe(2)
    expect(hold.spent()).toEqual({ premium: 2, credits: 400 })
  })

  it("retries a rate-limit classification without a status, and never retries a 402, a usage-limit or another error", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 4, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    let n = 0
    const classified = runtime(async () => { n += 1; if (n === 1) throw new Error("slow"); return { content: "ok", toolCalls: [], outputItems: [] } })
    classified.classifyError = () => "rate-limit"
    const b = backoff()
    await expect(meteredRuntime(classified, hold, ledger, b.retry).streamTurn(asked)).resolves.toMatchObject({ content: "ok" })
    expect(b.waits).toEqual([15_000])

    const other = flaky([500])
    const c = backoff()
    await expect(meteredRuntime(other.rt, hold, ledger, c.retry).streamTurn(asked)).rejects.toThrow("HTTP 500")
    expect(other.seen.sent).toBe(1)
    // A 429 the provider calls a usage limit is a spent quota, not a pause: never retried.
    const quota = flaky([429], () => "usage-limit")
    await expect(meteredRuntime(quota.rt, hold, ledger, c.retry).streamTurn(asked)).rejects.toThrow("HTTP 429")
    expect(quota.seen.sent).toBe(1)
    expect(ledger.stopped()).toMatch(/^the provider answered 429/)
    const paid = flaky([402])
    await expect(meteredRuntime(paid.rt, hold, ledger, c.retry).streamTurn(asked)).rejects.toThrow("HTTP 402")
    expect(paid.seen.sent).toBe(1)
    expect(c.waits).toEqual([])
  })

  it("without a backoff, stops on the first 429 as before", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 1, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    const { rt, seen } = flaky([429])
    await expect(meteredRuntime(rt, hold, ledger).streamTurn(asked)).rejects.toThrow("HTTP 429")
    expect(seen.sent).toBe(1)
    expect(seen.resets).toEqual([])
    expect(ledger.stopped()).toBe("the provider answered 429: HTTP 429")
  })

  it("stops on a usage-limit classification without a status, and on a thrown non-error", async () => {
    const ledger = createBudgetLedger({})
    const hold = ledger.reserve("run", { calls: 2, perCall: { premium: 1, credits: 0 }, pricing })
    if ("refused" in hold) throw new Error(hold.refused)
    const inner = runtime(async () => { throw "boom" })
    await expect(meteredRuntime(inner, hold, ledger).streamTurn(request)).rejects.toThrow("boom")
    expect(ledger.stopped()).toBeUndefined()
    const limited = runtime(async () => { throw new Error("out of credit") })
    limited.classifyError = () => "usage-limit"
    await expect(meteredRuntime(limited, hold, ledger).streamTurn(request)).rejects.toThrow("out of credit")
    expect(ledger.stopped()).toMatch(/usage-limit/)
  })
})
