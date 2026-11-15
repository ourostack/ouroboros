import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

const mockTellOwner = vi.hoisted(() => vi.fn())
vi.mock("../../heart/sync", () => ({
  tellOwner: (...args: unknown[]) => mockTellOwner(...args),
}))

import {
  clearProviderEntryCooldown,
  coolDownProviderEntry,
  fallsBackOn,
  firstReadyChainIndex,
  nextReadyChainIndex,
  noteProviderServed,
  providerCooldownUntil,
  providerEntryCoolingDown,
  providerFallbackChain,
  resetProviderFallbackState,
  setProviderFallbackOwnerNotifier,
} from "../../heart/provider-fallback"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({ component: "test", event: "test.case", message: testName, meta: {} })
}

const OPUS = { provider: "anthropic" as const, model: "claude-opus-5-5" }
const SONNET = { provider: "anthropic" as const, model: "claude-sonnet-5-5" }
const MINIMAX = { provider: "minimax" as const, model: "MiniMax-M3" }
const NOW = Date.parse("2026-11-15T12:00:00.000Z")

function httpError(message: string, status?: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), status === undefined ? {} : { status }, headers ? { headers } : {})
}

describe("provider fallback chain", () => {
  beforeEach(() => {
    mockEmitNervesEvent.mockClear()
    mockTellOwner.mockClear()
    resetProviderFallbackState()
  })
  afterEach(() => {
    setProviderFallbackOwnerNotifier(null)
  })

  it("has no chain unless agent.json opts in with providerFallback", () => {
    emitTestEvent("no chain without opt-in")
    expect(providerFallbackChain({ humanFacing: OPUS, agentFacing: SONNET }, "outward")).toEqual([])
    expect(providerFallbackChain({ humanFacing: OPUS, agentFacing: SONNET, providerFallback: [] }, "outward")).toEqual([])
  })

  it("orders the lane's own model, then the other lane, then the fallbacks, without repeats", () => {
    emitTestEvent("chain order")
    const config = { humanFacing: OPUS, agentFacing: SONNET, providerFallback: [MINIMAX, OPUS, MINIMAX] }
    expect(providerFallbackChain(config, "outward")).toEqual([OPUS, SONNET, MINIMAX])
    expect(providerFallbackChain(config, "inner")).toEqual([SONNET, OPUS, MINIMAX])
    expect(providerFallbackChain({ humanFacing: OPUS, agentFacing: OPUS, providerFallback: [MINIMAX] }, "inner")).toEqual([OPUS, MINIMAX])
  })

  it("falls back on errors the agent cannot fix, not on unknown errors", () => {
    emitTestEvent("fallback classifications")
    for (const classification of ["auth-failure", "usage-limit", "rate-limit", "server-error", "network-error"] as const) {
      expect(fallsBackOn(classification)).toBe(true)
    }
    expect(fallsBackOn("unknown")).toBe(false)
  })

  it("cools entries down by Retry-After, an hour for credit or auth, five minutes otherwise", () => {
    emitTestEvent("cooldown durations")
    expect(providerCooldownUntil("rate-limit", httpError("slow down", 429, { "retry-after": "30" }), NOW)).toBe(NOW + 30_000)
    const headers = new Headers({ "retry-after": "90" })
    expect(providerCooldownUntil("server-error", Object.assign(new Error("overloaded"), { status: 529, headers }), NOW)).toBe(NOW + 90_000)
    expect(providerCooldownUntil("usage-limit", httpError("Your credit balance is too low", 400), NOW)).toBe(NOW + 60 * 60_000)
    expect(providerCooldownUntil("auth-failure", httpError("invalid x-api-key", 401), NOW)).toBe(NOW + 60 * 60_000)
    expect(providerCooldownUntil("rate-limit", httpError("slow down", 429, { "retry-after": "soon" }), NOW)).toBe(NOW + 5 * 60_000)
    expect(providerCooldownUntil("network-error", new Error("fetch failed"), NOW)).toBe(NOW + 5 * 60_000)
  })

  it("benches the whole provider for credit and auth, only the model for throttles and outages", () => {
    emitTestEvent("cooldown scope")
    coolDownProviderEntry(OPUS, "server-error", httpError("overloaded", 529), NOW)
    expect(providerEntryCoolingDown(OPUS, NOW + 1000)).toBe(true)
    expect(providerEntryCoolingDown(SONNET, NOW + 1000)).toBe(false)
    expect(providerEntryCoolingDown(OPUS, NOW + 5 * 60_000 + 1)).toBe(false)

    coolDownProviderEntry(OPUS, "usage-limit", httpError("Your credit balance is too low", 400), NOW)
    expect(providerEntryCoolingDown(SONNET, NOW + 1000)).toBe(true)
    expect(providerEntryCoolingDown(MINIMAX, NOW + 1000)).toBe(false)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.provider_cooldown",
      meta: expect.objectContaining({ provider: "anthropic", model: "claude-opus-5-5", classification: "usage-limit", scope: "provider" }),
    }))

    clearProviderEntryCooldown(SONNET)
    expect(providerEntryCoolingDown(SONNET, NOW + 1000)).toBe(false)
    // Opus's own outage cooldown is separate from the account-wide one.
    expect(providerEntryCoolingDown(OPUS, NOW + 1000)).toBe(true)
    clearProviderEntryCooldown(OPUS)
    expect(providerEntryCoolingDown(OPUS, NOW + 1000)).toBe(false)
  })

  it("starts each turn on the first entry that is not cooling down, and the primary when all are", () => {
    emitTestEvent("first ready entry")
    const chain = [OPUS, SONNET, MINIMAX]
    expect(firstReadyChainIndex(chain, NOW)).toBe(0)
    coolDownProviderEntry(OPUS, "usage-limit", new Error("credit balance is too low"), NOW)
    expect(firstReadyChainIndex(chain, NOW + 1)).toBe(2)
    coolDownProviderEntry(MINIMAX, "rate-limit", new Error("429"), NOW)
    expect(firstReadyChainIndex(chain, NOW + 1)).toBe(0)
  })

  it("finds the next entry after the current one, skipping entries that are cooling down", () => {
    emitTestEvent("next ready entry")
    const chain = [OPUS, SONNET, MINIMAX]
    expect(nextReadyChainIndex(chain, 0, NOW)).toBe(1)
    coolDownProviderEntry(SONNET, "rate-limit", new Error("429"), NOW)
    expect(nextReadyChainIndex(chain, 0, NOW + 1)).toBe(2)
    expect(nextReadyChainIndex(chain, 2, NOW + 1)).toBeNull()
  })

  it("records who served each turn and tells the owner once when the backup takes over", async () => {
    emitTestEvent("served and notice")
    const notices: Array<{ noticeId: string; text: string }> = []
    setProviderFallbackOwnerNotifier((_root, _agent, notice) => { notices.push(notice) })
    const chain = [OPUS, SONNET, MINIMAX]
    const owner = { agentName: "sanctuary", agentRoot: "/bundles/sanctuary.ouro" }

    noteProviderServed({ ...owner, lane: "outward", chain, index: 0, now: NOW })
    expect(notices).toEqual([])
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.provider_served",
      meta: expect.objectContaining({ provider: "anthropic", model: "claude-opus-5-5", lane: "outward", fallback: false }),
    }))

    coolDownProviderEntry(OPUS, "usage-limit", new Error("credit balance is too low"), NOW)
    noteProviderServed({ ...owner, lane: "outward", chain, index: 2, now: NOW + 1 })
    noteProviderServed({ ...owner, lane: "inner", chain: [SONNET, OPUS, MINIMAX], index: 2, now: NOW + 2 })
    expect(notices).toHaveLength(1)
    expect(notices[0].noticeId).toBe(`provider-fallback:sanctuary:${NOW + 1}`)
    expect(notices[0].text).toContain("Claude")
    expect(notices[0].text).toContain("MiniMax (MiniMax-M3)")
    expect(notices[0].text).toContain("out of credit")
    expect(notices[0].text).not.toMatch(/switch to/i)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.provider_served",
      meta: expect.objectContaining({ provider: "minimax", fallback: true, primaryProvider: "anthropic" }),
    }))

    // The primary comes back: the episode ends quietly.
    noteProviderServed({ ...owner, lane: "outward", chain, index: 0, now: NOW + 3 })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.provider_fallback_recovered" }))
    expect(notices).toHaveLength(1)

    // A second outage the same day stays quiet; one a day later is told again.
    noteProviderServed({ ...owner, lane: "outward", chain, index: 2, now: NOW + 60_000 })
    expect(notices).toHaveLength(1)
    noteProviderServed({ ...owner, lane: "outward", chain, index: 0, now: NOW + 60_001 })
    noteProviderServed({ ...owner, lane: "outward", chain, index: 1, now: NOW + 25 * 60 * 60_000 })
    expect(notices).toHaveLength(2)
    expect(notices[1].text).toContain("a provider problem")
  })

  it("uses the shared owner notice path by default", async () => {
    emitTestEvent("default notifier")
    noteProviderServed({ agentName: "sanctuary", agentRoot: "/b", lane: "outward", chain: [OPUS, MINIMAX], index: 1 })
    await vi.waitFor(() => expect(mockTellOwner).toHaveBeenCalledWith("/b", "sanctuary", expect.objectContaining({ noticeId: expect.stringMatching(/^provider-fallback:sanctuary:\d+$/) })))
  })

  it("names unfamiliar providers by their id", () => {
    emitTestEvent("provider labels")
    const notices: Array<{ text: string }> = []
    setProviderFallbackOwnerNotifier((_root, _agent, notice) => { notices.push(notice) })
    coolDownProviderEntry({ provider: "azure", model: "gpt" }, "server-error", new Error("503"), NOW)
    noteProviderServed({ agentName: "a", agentRoot: "/a", lane: "outward", chain: [{ provider: "azure", model: "gpt" }, { provider: "github-copilot", model: "" }], index: 1, now: NOW })
    expect(notices[0].text).toContain("azure")
    expect(notices[0].text).toContain("having an outage")
    expect(notices[0].text).toContain("github-copilot as a backup")
  })
})
