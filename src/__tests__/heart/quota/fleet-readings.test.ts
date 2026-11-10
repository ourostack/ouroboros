import { describe, expect, it, vi } from "vitest"
import {
  agentBurnContent,
  agentBurnFileName,
  directReading,
  loadFleetQuota,
  mergeReadings,
  publishAgentBurn,
  readFleetQuota,
  readingsFromBalancerState,
} from "../../../heart/quota/fleet-readings"

const state = (readings: Record<string, unknown>) => ({ readings })
const raw = (pct: number, at: string, extra: Record<string, unknown> = {}) => ({
  pct,
  at,
  overage_permitted: true,
  reset: "2026-12-01T00:00:00.000Z",
  ...extra,
})

describe("readingsFromBalancerState", () => {
  it("reads quota-balance.json readings", () => {
    expect(readingsFromBalancerState(state({
      "a@msft.ghe.com": raw(95.4, "2026-11-10T02:45:29.173Z", { burn_per_h: 12, dry_at: "2026-11-13T00:00:00Z", remaining: 954000, entitlement: 1000000 }),
      "a_microsoft@github.com": { pct: 0, overage_permitted: false, at: "2026-11-10T02:45:29.741Z" },
    }), "local")).toEqual([
      { key: "a@msft.ghe.com", leftPct: 95.4, burnPerH: 12, dryAt: "2026-11-13T00:00:00Z", overageOk: true, at: "2026-11-10T02:45:29.173Z", reset: "2026-12-01T00:00:00.000Z", remaining: 954000, entitlement: 1000000, source: "local" },
      { key: "a_microsoft@github.com", leftPct: 0, burnPerH: null, dryAt: null, overageOk: false, at: "2026-11-10T02:45:29.741Z", reset: null, remaining: null, entitlement: null, source: "local" },
    ])
  })

  it("skips malformed state and readings without a percentage", () => {
    expect(readingsFromBalancerState(null, "local")).toEqual([])
    expect(readingsFromBalancerState({ readings: [] }, "local")).toEqual([])
    expect(readingsFromBalancerState(state({ x: "nope", y: { pct: "1" }, z: { pct: Number.NaN } }), "local")).toEqual([])
  })
})

describe("mergeReadings", () => {
  it("keeps the freshest reading per account, and the earlier list on a tie", () => {
    const local = readingsFromBalancerState(state({ k: raw(50, "2026-11-10T02:00:00Z"), j: raw(10, "2026-11-10T02:00:00Z") }), "local")
    const fleet = readingsFromBalancerState(state({ k: raw(40, "2026-11-10T03:00:00Z"), j: raw(20, "2026-11-10T02:00:00Z") }), "fleet")
    const merged = mergeReadings(local, fleet)
    expect(merged.find((r) => r.key === "k")).toMatchObject({ leftPct: 40, source: "fleet" })
    expect(merged.find((r) => r.key === "j")).toMatchObject({ leftPct: 10, source: "local" })
  })

  it("prefers a dated reading over an undated one", () => {
    const undated = [{ key: "k", leftPct: 1, burnPerH: null, dryAt: null, overageOk: false, at: null }]
    const dated = [{ key: "k", leftPct: 2, burnPerH: null, dryAt: null, overageOk: false, at: "2026-11-10T00:00:00Z" }]
    expect(mergeReadings(undated, dated)[0].leftPct).toBe(2)
    expect(mergeReadings(dated, undated)[0].leftPct).toBe(2)
  })
})

describe("readFleetQuota", () => {
  it("reads local state first, then each Mac's <machine>.quota.txt, ignoring agent burn files", () => {
    const gist = {
      files: {
        "aris-mac-mini.quota.txt": { content: JSON.stringify(state({ m: raw(70, "2026-11-10T02:00:00Z"), k: raw(10, "2026-11-10T01:00:00Z") })) },
        "laptop.ouroboros.quota.txt": { content: JSON.stringify(state({ z: raw(1, "2026-11-10T09:00:00Z") })) },
        "broken.quota.txt": { content: "{half" },
        "nocontent.quota.txt": { truncated: true },
        "notes.md": { content: "hi" },
      },
    }
    const readings = readFleetQuota({ localState: state({ k: raw(50, "2026-11-10T02:00:00Z") }), gist })
    expect(readings.map((r) => [r.key, r.leftPct, r.source]).sort()).toEqual([
      ["k", 50, "local"],
      ["m", 70, "fleet:aris-mac-mini"],
    ])
  })

  it("copes with no sources", () => {
    expect(readFleetQuota({})).toEqual([])
    expect(readFleetQuota({ gist: { files: null } })).toEqual([])
  })
})

describe("directReading", () => {
  const at = "2026-11-10T02:00:00.000Z"

  it("reads premium_interactions from /copilot_internal/user", () => {
    expect(directReading("k", {
      quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
      quota_snapshots: { premium_interactions: { percent_remaining: 28.7, overage_permitted: true, remaining: 287751, entitlement: 1000000 } },
    }, at)).toEqual({ key: "k", leftPct: 28.7, burnPerH: null, dryAt: null, overageOk: true, at, reset: "2026-12-01T00:00:00.000Z", remaining: 287751, entitlement: 1000000, source: "direct" })
  })

  it("treats an unlimited account as fully left", () => {
    expect(directReading("k", { quota_snapshots: { premium_interactions: { unlimited: true } } }, at)).toMatchObject({ leftPct: 100, overageOk: false, reset: null })
  })

  it("returns null without a usable snapshot", () => {
    expect(directReading("k", null, at)).toBeNull()
    expect(directReading("k", { quota_snapshots: {} }, at)).toBeNull()
    expect(directReading("k", { quota_snapshots: { premium_interactions: {} } }, at)).toBeNull()
  })
})

describe("agent burn", () => {
  const msft = { key: "a@msft.ghe.com", leftPct: 95.3, burnPerH: null, dryAt: null, overageOk: true, at: "2026-11-10T01:59:00.000Z", reset: "2026-12-01T00:00:00Z", remaining: 953000, entitlement: 1000000 }
  const mscom = { key: "a@microsoft.ghe.com", leftPct: 28.7, burnPerH: null, dryAt: null, overageOk: true, at: "2026-11-10T01:58:00.000Z" }
  const burn = { agent: "ouroboros", machine: "laptop", at: "2026-11-10T02:00:00.000Z", current: "a@msft.ghe.com", requestsPerH: { "a@msft.ghe.com": 12, "a@other.ghe.com": 1 }, readings: [msft, mscom] }

  it("names the file <machine>.<agent>.quota.txt", () => {
    expect(agentBurnFileName("laptop", "ouroboros")).toBe("laptop.ouroboros.quota.txt")
  })

  it("writes the shape the app balancer's parseAgentQuota reads", () => {
    expect(JSON.parse(agentBurnContent(burn))).toEqual({
      machine: "laptop",
      agent: "ouroboros",
      at: burn.at,
      current: "a@msft.ghe.com",
      readings: [
        { key: "a@msft.ghe.com", leftPct: 95.3, burnPerH: 12, dryAt: null, overageOk: true, at: "2026-11-10T01:59:00.000Z", remaining: 953000, entitlement: 1000000, reset: "2026-12-01T00:00:00Z" },
        { key: "a@microsoft.ghe.com", leftPct: 28.7, burnPerH: 0, dryAt: null, overageOk: true, at: "2026-11-10T01:58:00.000Z" },
        { key: "a@other.ghe.com", leftPct: null, burnPerH: 1, dryAt: null, overageOk: false, at: burn.at },
      ],
    })
  })

  it("patches the fleet gist", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    await expect(publishAgentBurn({ gistId: "g1", token: "t" }, burn, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.github.com/gists/g1")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(String(init.body)).files["laptop.ouroboros.quota.txt"].content).toContain("\"agent\": \"ouroboros\"")
  })

  it("never throws when the gist can't be written", async () => {
    const failing = vi.fn(async () => new Response("no", { status: 403 }))
    await expect(publishAgentBurn({ gistId: "g1", token: "t" }, burn, { fetch: failing as unknown as typeof fetch })).resolves.toBe(false)
    const throwing = vi.fn(async () => { throw new Error("offline") })
    await expect(publishAgentBurn({ gistId: "g1", token: "t" }, burn, { fetch: throwing as unknown as typeof fetch })).resolves.toBe(false)
  })
})

describe("loadFleetQuota", () => {
  const localJson = JSON.stringify(state({ k: raw(50, "2026-11-10T02:00:00Z") }))

  it("reads the local balancer state under the home directory, then the gist", async () => {
    const readFile = vi.fn(() => localJson)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ files: { "mini.quota.txt": { content: JSON.stringify(state({ m: raw(70, "2026-11-10T02:00:00Z") })) } } }), { status: 200 }))
    const readings = await loadFleetQuota({ gistId: "g1", token: "t" }, { readFile, fetch: fetchMock as unknown as typeof fetch, homeDir: "/home/x" })
    expect(readFile).toHaveBeenCalledWith("/home/x/.config/mac-fleet/quota-balance.json")
    expect(readings.map((r) => r.key).sort()).toEqual(["k", "m"])
  })

  it("works without a gist, a local file, or a reachable gist", async () => {
    const missing = vi.fn(() => { throw new Error("ENOENT") })
    await expect(loadFleetQuota(null, { readFile: missing, homeDir: "/home/x" })).resolves.toEqual([])
    const denied = vi.fn(async () => new Response("no", { status: 404 }))
    await expect(loadFleetQuota({ gistId: "g", token: "t" }, { readFile: () => localJson, fetch: denied as unknown as typeof fetch })).resolves.toHaveLength(1)
    const offline = vi.fn(async () => { throw new Error("offline") })
    await expect(loadFleetQuota({ gistId: "g", token: "t" }, { readFile: () => localJson, fetch: offline as unknown as typeof fetch })).resolves.toHaveLength(1)
  })

  it("defaults to the real home directory and file reader", async () => {
    await expect(loadFleetQuota(null, { homeDir: "/nonexistent-ouro-test-home" })).resolves.toEqual([])
  })

  it("defaults to the global fetch for reading and publishing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
    try {
      await expect(loadFleetQuota({ gistId: "g", token: "t" }, { readFile: () => "{}" })).resolves.toEqual([])
      await expect(publishAgentBurn({ gistId: "g", token: "t" }, { agent: "a", machine: "m", at: "x", current: null, requestsPerH: {}, readings: [] })).resolves.toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
