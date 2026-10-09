import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  friends: [] as unknown[],
  friendsError: null as unknown,
  policy: { desiredStates: {}, routineActionGrants: {} } as unknown,
  policyError: null as unknown,
  escalation: {} as Record<string, unknown>,
  delegated: {} as Record<string, unknown>,
}))

vi.mock("@ouro.bot/friends", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ouro.bot/friends")>()
  return {
    ...actual,
    FileFriendStore: class {
      async listAll() {
        if (state.friendsError) throw state.friendsError
        return state.friends
      }
    },
  }
})
vi.mock("../../heart/steward-policy", () => ({
  readStewardPolicy: () => {
    if (state.policyError) throw state.policyError
    return state.policy
  },
}))
vi.mock("../../a2a/delegated-command-grants", () => ({ viewDelegatedCommandGrants: () => ({ state: "trusted", grants: state.delegated, ignored: [] }) }))
vi.mock("../../a2a/escalation-grants", () => ({ readEscalationGrants: () => state.escalation }))

import { draftDigest, recallSweep, LIST_CAP, queueProblem, readLedger, runHouseSweep, safe, writeLedger, progressPath, type HouseSweepDeps } from "../../repertoire/house-sweep"

const NOW = Date.parse("2026-10-09T12:00:00.000Z")
const HOUR = 3_600_000
const DAY = 86_400_000
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "house-sweep-"))
  state.friends = []
  state.friendsError = null
  state.policy = { desiredStates: {}, routineActionGrants: {} }
  state.policyError = null
  state.escalation = {}
  state.delegated = {}
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true })
  fs.writeFileSync(path.join(root, "mcp", "media-credentials.json"), JSON.stringify({ sonarr: { url: "http://sonarr/", apiKey: "s" }, radarr: { url: "http://radarr", apiKey: "r" } }))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

type Routes = Record<string, unknown>
function fakeFetch(routes: { sonarr?: Routes; radarr?: Routes; fail?: "sonarr" | "radarr"; status?: number }): typeof fetch {
  return (async (url: string) => {
    const service = url.startsWith("http://sonarr") ? "sonarr" : "radarr"
    if (routes.fail === service) return { ok: false, status: routes.status ?? 500, json: async () => ({}) }
    const table = (routes[service] ?? {}) as Routes
    const key = url.includes("/queue") ? "queue" : url.includes("/wanted/missing") ? "missing" : "history"
    return { ok: true, status: 200, json: async () => table[key] ?? { records: [] } }
  }) as unknown as typeof fetch
}

function host(over: { containers?: unknown[]; storage?: unknown; disks?: unknown; fail?: boolean } = {}): HouseSweepDeps["sanctuary"] {
  const ok = (data: unknown) => async () => ({ ok: true, data })
  return {
    listContainers: over.fail ? async () => ({ ok: false }) : ok({ containers: over.containers ?? [] }),
    getStorage: ok(over.storage ?? { array: { state: "STARTED", usedPercent: 40 }, shares: [] }),
    getDisks: ok(over.disks ?? { disks: [], parity: { result: "ok", ageHours: 24 } }),
  } as unknown as HouseSweepDeps["sanctuary"]
}

const sweep = (extra: Partial<HouseSweepDeps> = {}, routes: Parameters<typeof fakeFetch>[0] = {}) =>
  runHouseSweep({ agentRoot: root, sanctuary: host(), fetch: fakeFetch(routes), now: () => NOW, ...extra })

describe("queueProblem", () => {
  it("flags statuses, messages, and error text", () => {
    expect(queueProblem({ trackedDownloadStatus: "warning", errorMessage: "boom" }, NOW)).toBe("boom")
    expect(queueProblem({ status: "failed", statusMessages: [{ title: "T", messages: ["m"] }] }, NOW)).toBe("T")
    expect(queueProblem({ statusMessages: [{ messages: ["only"] }] }, NOW)).toBe("only")
    expect(queueProblem({ status: "failed" }, NOW)).toBe("status failed")
    expect(queueProblem({ trackedDownloadStatus: "error", errorMessage: "x".repeat(200) }, NOW)?.endsWith("...")).toBe(true)
    expect(queueProblem({ trackedDownloadStatus: "warning", statusMessages: [{}] , status: undefined}, NOW)).toBe("status warning")
  })
  it("flags an old partial download with no ETA only", () => {
    const base = { size: 100, sizeleft: 50, added: iso(-7 * HOUR) }
    expect(queueProblem(base, NOW)).toBe("partial download with no ETA")
    expect(queueProblem({ ...base, timeleft: "00:00:00" }, NOW)).toBe("partial download with no ETA")
    expect(queueProblem({ ...base, timeleft: "01:00:00" }, NOW)).toBeNull()
    expect(queueProblem({ ...base, added: iso(-HOUR) }, NOW)).toBeNull()
    expect(queueProblem({ ...base, added: "nope" }, NOW)).toBeNull()
    expect(queueProblem({ size: 0, added: iso(-7 * HOUR) }, NOW)).toBeNull()
  })
})

describe("runHouseSweep queue findings", () => {
  const stalled = { id: 11, seriesId: 5, series: { title: "Show" }, title: "Show.S01E01.1080p", size: 1000, sizeleft: 400, trackedDownloadStatus: "warning", errorMessage: "stalled" }
  it("reports a stalled series download with a fix and a digest", async () => {
    const report = await sweep({}, { sonarr: { queue: { records: [stalled] } } })
    expect(report.scope).toBe("live")
    expect(report.queue.sonarr).toEqual({ total: 1, stalled: 1, importProblems: 0 })
    const finding = report.findings.find((f) => f.id === "downloads:sonarr:11")!
    expect(finding).toMatchObject({ next: "fix", refs: { service: "sonarr", queueId: 11 }, fix: { tool: "media_fill_missing", args: { service_id: 5 } }, alreadyReported: false })
    expect(finding.summary).toContain("Show")
    expect(report.digest_due).toBe(true)
    expect(report.digest_draft).toContain("Show")
    expect(report.fresh).toContain("downloads:sonarr:11")
    expect(recallSweep(root, "live")!.map((f) => f.id)).toContain("downloads:sonarr:11")
    expect(recallSweep(root, "replay")).toBeUndefined()
    expect(fs.existsSync(path.join(root, "state", "house-sweep", "last-report.json"))).toBe(false)
  })
  it("treats a stalled movie as an owner item and reads an array payload", async () => {
    const report = await sweep({}, { radarr: { queue: [{ id: 3, movieId: 9, movie: { title: "Film" }, title: "Film.2020", size: 10, sizeleft: 5, status: "failed" }, { noid: true }] } })
    const finding = report.findings.find((f) => f.id === "downloads:radarr:3")!
    expect(finding.next).toBe("owner")
    expect(finding.fix).toBeUndefined()
    expect(report.queue.radarr).toEqual({ total: 2, stalled: 1, importProblems: 0 })
  })
  it("uses fallback names and no fix for a stall without ids", async () => {
    const report = await sweep({}, { sonarr: { queue: [{ id: 1, size: 0, status: "failed" }] } })
    const finding = report.findings.find((f) => f.id === "downloads:sonarr:1")!
    expect(finding.summary).toContain("an unknown title")
    expect(finding.summary).toContain("0%")
    expect(finding.next).toBe("owner")
  })
  it("reports an import failure as an owner item", async () => {
    const report = await sweep({}, { sonarr: { queue: [{ id: 2, seriesId: 5, series: { title: "Show" }, title: "R", trackedDownloadState: "importBlocked" }, { id: 4, title: "R2", trackedDownloadState: "importFailed", statusMessages: [{ title: "bad" }] }] } })
    expect(report.queue.sonarr).toMatchObject({ importProblems: 2, stalled: 0 })
    expect(report.findings.find((f) => f.id === "imports:sonarr:2")).toMatchObject({ area: "imports", next: "owner" })
    expect(report.findings.find((f) => f.id === "imports:sonarr:4")!.summary).toContain("bad")
  })
  it("detects a frozen download across sweeps and resets when it moves", async () => {
    const item = { id: 8, seriesId: 1, series: { title: "Slow" }, title: "Slow", size: 100, sizeleft: 60, timeleft: "01:00:00" }
    const first = await sweep({ now: () => NOW }, { sonarr: { queue: [item] } })
    expect(first.queue.sonarr).toMatchObject({ stalled: 0 })
    const later = await sweep({ now: () => NOW + 8 * HOUR }, { sonarr: { queue: [item] } })
    expect(later.queue.sonarr).toMatchObject({ stalled: 1 })
    expect(later.findings.find((f) => f.id === "downloads:sonarr:8")!.summary).toContain("no progress for 8h")
    const moved = await sweep({ now: () => NOW + 9 * HOUR }, { sonarr: { queue: [{ ...item, sizeleft: 30 }] } })
    expect(moved.queue.sonarr).toMatchObject({ stalled: 0 })
  })
  it("reports recent failed downloads once, and skips old, bad, and in-flight ones", async () => {
    const report = await sweep({}, {
      sonarr: { queue: [{ id: 1, seriesId: 7, size: 10, sizeleft: 5, timeleft: "00:10:00" }], history: { records: [
        { id: 100, date: iso(-DAY), seriesId: 4, sourceTitle: "Gone.S01" },
        { id: 101, date: iso(-DAY), seriesId: 7, sourceTitle: "InFlight" },
        { id: 102, date: iso(-10 * DAY), seriesId: 4, sourceTitle: "Old" },
        { date: iso(-DAY), sourceTitle: "NoId" },
        { id: 103, date: "bad" },
        { id: 104, date: iso(-DAY), sourceTitle: "NoSubject" },
      ] } },
      radarr: { history: [{ id: 5, date: iso(-DAY), movieId: 2, sourceTitle: "Movie" }] },
    })
    const ids = report.findings.map((f) => f.id)
    expect(ids).toContain("downloads:sonarr:failed:100")
    expect(ids).toContain("downloads:sonarr:failed:104")
    expect(ids).toContain("downloads:radarr:failed:5")
    expect(ids).not.toContain("downloads:sonarr:failed:101")
    expect(ids).not.toContain("downloads:sonarr:failed:102")
    expect(report.findings.find((f) => f.id === "downloads:sonarr:failed:100")!.fix?.tool).toBe("media_fill_missing")
    expect(report.findings.find((f) => f.id === "downloads:sonarr:failed:104")!.fix).toBeUndefined()
    expect(report.findings.find((f) => f.id === "downloads:radarr:failed:5")!.fix).toBeUndefined()
  })
  it("reports monitored-but-missing items past the grace period", async () => {
    const report = await sweep({}, {
      sonarr: { missing: { records: [
        { seriesId: 1, series: { title: "Old Show" }, airDateUtc: iso(-10 * DAY), monitored: true },
        { seriesId: 1, series: { title: "Old Show" }, airDateUtc: iso(-20 * DAY) },
        { seriesId: 2, airDateUtc: iso(-5 * DAY) },
        { seriesId: 3, series: { title: "Fresh" }, airDateUtc: iso(-DAY) },
        { seriesId: 4, series: { title: "Unmonitored" }, airDateUtc: iso(-9 * DAY), monitored: false },
        { seriesId: 5, series: { title: "Queued" }, airDateUtc: iso(-9 * DAY) },
        { series: { title: "NoId" }, airDateUtc: iso(-9 * DAY) },
        { seriesId: 6, series: { title: "NoDate" } },
      ] }, queue: [{ id: 1, seriesId: 5, size: 10, sizeleft: 5, timeleft: "00:10:00" }] },
      radarr: { missing: { records: [
        { id: 20, title: "Movie A", added: iso(-30 * DAY) },
        { id: 21, title: "Unreleased", added: iso(-30 * DAY), isAvailable: false },
        { id: 22, added: iso(-6 * DAY) },
      ] } },
    })
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]))
    expect(byId["missing:sonarr:1"].summary).toBe("Old Show: 2 monitored episodes missing, the oldest aired 20 days ago")
    expect(byId["missing:sonarr:1"].fix).toMatchObject({ tool: "media_fill_missing", args: { service_id: 1 } })
    expect(byId["missing:sonarr:2"].summary).toContain("an unknown title: 1 monitored episode missing")
    expect(byId["missing:radarr:20"]).toMatchObject({ summary: "Movie A: monitored movie still missing after 30 days", fix: { tool: "media_search_now", args: { kind: "movie", service_id: 20 } } })
    expect(byId["missing:radarr:22"].summary).toContain("an unknown title")
    for (const absent of ["missing:sonarr:3", "missing:sonarr:4", "missing:sonarr:5", "missing:sonarr:6", "missing:radarr:21"]) expect(byId[absent]).toBeUndefined()
  })
  it("reports unreadable and credential-less sources without throwing", async () => {
    fs.writeFileSync(path.join(root, "mcp", "media-credentials.json"), JSON.stringify({ sonarr: { url: "http://sonarr", apiKey: "s" } }))
    const report = await sweep({}, { fail: "sonarr", status: 503 })
    expect(report.queue.sonarr).toEqual({ unavailable: "sonarr answered HTTP 503" })
    expect(report.queue.radarr).toEqual({ unavailable: "no credentials" })
    expect(report.sources.sonarr).toContain("503")
    expect(report.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["sweep:sonarr", "sweep:radarr"]))
  })
  it("keeps progress for an unreadable service", async () => {
    fs.mkdirSync(path.dirname(progressPath(root)), { recursive: true })
    fs.writeFileSync(progressPath(root), JSON.stringify({ items: { "sonarr:1": { sizeleft: 5, since: iso(-DAY) }, "radarr:2": { sizeleft: 1, since: iso(-DAY) } } }))
    await sweep({}, { fail: "sonarr" })
    const kept = JSON.parse(fs.readFileSync(progressPath(root), "utf8")).items
    expect(kept["sonarr:1"]).toBeDefined()
    expect(kept["radarr:2"]).toBeUndefined()
  })
  it("handles a non-error rejection and a missing credential file", async () => {
    fs.rmSync(path.join(root, "mcp"), { recursive: true })
    const report = await sweep({ fetch: (async () => { throw "weird" }) as unknown as typeof fetch })
    expect(report.queue.sonarr).toEqual({ unavailable: "no credentials" })
    fs.mkdirSync(path.join(root, "mcp"))
    const custom = path.join(root, "creds.json")
    fs.writeFileSync(custom, JSON.stringify({ sonarr: { url: "http://sonarr", apiKey: "k" } }))
    const again = await sweep({ credentialsPath: custom, fetch: (async () => { throw "weird" }) as unknown as typeof fetch })
    expect(again.queue.sonarr).toEqual({ unavailable: "weird" })
  })
  it("uses the global fetch and clock by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => [] } as Response)
    const report = await runHouseSweep({ agentRoot: root })
    expect(spy).toHaveBeenCalled()
    expect(report.sources.host).toContain("not attached")
    spy.mockRestore()
  })
})

describe("runHouseSweep host", () => {
  it("flags containers against the steward policy", async () => {
    state.policy = { desiredStates: {
      "container:plex": { value: "always_on" },
      "container:old": { value: "off" },
      "container:expired": { value: "on", expiresAt: iso(-DAY) },
      "container:fine": { value: "on" },
      "container:lazy": { value: "on_demand" },
    }, routineActionGrants: {} }
    const report = await sweep({ sanctuary: host({ containers: [
      { name: "plex", state: "exited" }, { name: "old", state: "running" }, { name: "expired", state: "exited" },
      { name: "fine", state: "running" }, { name: "lazy", state: "exited" },
      { name: "auto", state: "exited", autostart: true }, { name: "auto-ok", state: "running", autostart: true }, { name: "manual", state: "exited" },
    ] }) })
    const ids = report.findings.filter((f) => f.area === "containers").map((f) => f.id).sort()
    expect(ids).toEqual(["containers:auto", "containers:old", "containers:plex"])
    expect(report.findings.find((f) => f.id === "containers:plex")!.severity).toBe("critical")
    expect(report.host!.containers).toBe(8)
  })
  it("flags containers with no policy readable", async () => {
    state.policyError = new Error("policy broke")
    const report = await sweep({ sanctuary: host({ containers: [{ name: "auto", state: "exited", autostart: true }] }) })
    expect(report.sources.policy).toContain("policy broke")
    expect(report.findings.map((f) => f.id)).toContain("containers:auto")
    state.policyError = "odd"
    expect((await sweep()).sources.policy).toBe("odd")
  })
  it("flags capacity, array state, SMART, temperature, and parity", async () => {
    const report = await sweep({ sanctuary: host({
      storage: { array: { state: "STOPPED", usedPercent: 99 }, shares: [{ name: "media", usedPercent: 91 }, { name: "ok", usedPercent: 10 }, { name: "nopct" }] },
      disks: { disks: [{ id: "d1", name: "disk1", smart: "failed", temperatureC: 55 }, { id: "d2", name: "disk2", smart: "ok", temperatureC: 30 }, { id: "d3", name: "disk3" }], parity: { result: "failed", errors: 3 } },
    }) })
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]))
    expect(byId["disk:array:capacity"].severity).toBe("critical")
    expect(byId["disk:share:media:capacity"].severity).toBe("warn")
    expect(byId["disk:array:state"].summary).toContain("STOPPED")
    expect(byId["disk:d1:smart"]).toBeDefined()
    expect(byId["disk:d1:temperature"].summary).toContain("55C")
    expect(byId["parity:result"].summary).toContain("3 errors")
    expect(byId["disk:d2:smart"]).toBeUndefined()
    expect(report.host).toMatchObject({ array: "STOPPED", arrayUsedPercent: 99, parity: "failed" })
  })
  it("flags old, unknown, and skips in-progress parity", async () => {
    const old = await sweep({ sanctuary: host({ disks: { disks: [], parity: { result: "ok", ageHours: 24 * 60 } } }) })
    expect(old.findings.find((f) => f.id === "parity:age")!.summary).toContain("60 days")
    const unknown = await sweep({ sanctuary: host({ disks: { disks: [], parity: {} } }) })
    expect(unknown.findings.find((f) => f.id === "parity:age")!.summary).toContain("unknown")
    const running = await sweep({ sanctuary: host({ disks: { disks: [], parity: { result: "in_progress" } } }) })
    expect(running.findings.find((f) => f.id === "parity:age")).toBeUndefined()
    const failedUnknown = await sweep({ sanctuary: host({ disks: { disks: [], parity: { result: "failed" } } }) })
    expect(failedUnknown.findings.find((f) => f.id === "parity:result")!.summary).toContain("unknown errors")
  })
  it("reports unreadable host parts and a missing or throwing runtime", async () => {
    const partial = await sweep({ sanctuary: host({ fail: true }) })
    expect(partial.sources.host).toBe("containers unreadable")
    const none = await sweep({ sanctuary: undefined })
    expect(none.sources.host).toContain("not attached")
    expect(none.host).toBeUndefined()
    const boom = await sweep({ sanctuary: { listContainers: async () => { throw new Error("ssh down") }, getStorage: async () => ({}), getDisks: async () => ({}) } as unknown as HouseSweepDeps["sanctuary"] })
    expect(boom.sources.host).toBe("ssh down")
    const weird = await sweep({ sanctuary: { listContainers: async () => { throw "odd" }, getStorage: async () => ({}), getDisks: async () => ({}) } as unknown as HouseSweepDeps["sanctuary"] })
    expect(weird.sources.host).toBe("odd")
    const empty = await sweep({ sanctuary: { listContainers: async () => ({ ok: true, data: {} }), getStorage: async () => ({ ok: false }), getDisks: async () => ({ ok: false }) } as unknown as HouseSweepDeps["sanctuary"] })
    expect(empty.sources.host).toBe("storage, disks unreadable")
  })
})

describe("runHouseSweep grants", () => {
  const friend = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), trustLevel: "family", admissionState: "active", ...over })
  it("flags expiring standing permissions and expectations", async () => {
    state.policy = {
      desiredStates: { "container:a": { value: "on", expiresAt: iso(3 * DAY) }, "container:b": { value: "on", expiresAt: iso(30 * DAY) }, "container:c": { value: "on" } },
      routineActionGrants: { fix: { expiresAt: iso(-DAY) } },
    }
    const report = await sweep({ sanctuary: host({ containers: [{ name: "a", state: "running" }] }) })
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]))
    expect(byId["grants:desired:container:a"].summary).toContain("expires in 3 days")
    expect(byId["grants:routine:fix"].summary).toContain("expired")
    expect(byId["grants:desired:container:b"]).toBeUndefined()
    expect(byId["grants:desired:container:c"]).toBeUndefined()
  })
  it("flags expiring and inert delegation and escalation grants", async () => {
    state.friends = [
      friend("ana"),
      friend("bo", { trustLevel: "friend" }),
      friend("cy", { admissionState: "blocked" }),
      friend("di"),
    ]
    state.delegated = { ana: { expiresAt: iso(2 * DAY) }, bo: { grantedAt: "x" }, ghost: {} }
    state.escalation = { ana: { expiresAt: iso(-DAY) }, cy: { grantedAt: "x" }, ghost: {} }
    const report = await sweep()
    const ids = report.findings.map((f) => f.id)
    expect(ids).toEqual(expect.arrayContaining(["grants:delegation:ana", "grants:delegation:bo:inert", "grants:escalation:ana", "grants:escalation:cy:inert"]))
    expect(ids).not.toContain("grants:delegation:ana:inert")
    expect(ids).not.toContain("grants:escalation:di")
  })
  it("ignores the old delegationGrant on a friend record: only the trusted grant is warned about", async () => {
    state.friends = [friend("ana", { delegationGrant: { scope: "principal_commands", expiresAt: iso(DAY) } })]
    expect((await sweep()).findings.map((f) => f.id)).not.toContain("grants:delegation:ana")
  })
  it("reports unreadable friends", async () => {
    state.friendsError = new Error("no store")
    expect((await sweep()).sources.grants).toBe("friends unreadable: no store")
    state.friendsError = "odd"
    expect((await sweep()).sources.grants).toBe("friends unreadable: odd")
  })
})

describe("runHouseSweep reporting ledger", () => {
  const stalled = { id: 11, seriesId: 5, series: { title: "Show" }, title: "R", size: 1000, sizeleft: 400, status: "failed", errorMessage: "stalled" }
  it("suppresses told findings, reminds after a week, re-raises on change, and prunes gone ones", async () => {
    const first = await sweep({}, { sonarr: { queue: [stalled] } })
    const finding = first.findings.find((f) => f.id === "downloads:sonarr:11")!
    writeLedger(root, {
      "downloads:sonarr:11": { fingerprint: finding.fingerprint, reportedAt: iso(-DAY) },
      "downloads:sonarr:99": { fingerprint: "old", reportedAt: iso(-DAY) },
    })
    const quiet = await sweep({}, { sonarr: { queue: [stalled] } })
    expect(quiet.findings.find((f) => f.id === "downloads:sonarr:11")!.alreadyReported).toBe(true)
    expect(quiet.digest_due).toBe(false)
    expect(quiet.digest_draft).toBe("")
    expect(Object.keys(readLedger(root))).toEqual(["downloads:sonarr:11"])
    const remind = await sweep({ now: () => NOW + 8 * DAY }, { sonarr: { queue: [stalled] } })
    expect(remind.findings.find((f) => f.id === "downloads:sonarr:11")!.alreadyReported).toBe(false)
    writeLedger(root, { "downloads:sonarr:11": { fingerprint: "different", reportedAt: iso(-DAY) } })
    const changed = await sweep({}, { sonarr: { queue: [stalled] } })
    expect(changed.digest_due).toBe(true)
  })
  it("a replay sweep ignores and never writes the ledger", async () => {
    const live = await sweep({}, { sonarr: { queue: [stalled] } })
    const fp = live.findings.find((f) => f.id === "downloads:sonarr:11")!.fingerprint
    writeLedger(root, { "downloads:sonarr:11": { fingerprint: fp, reportedAt: iso(-DAY) }, "gone": { fingerprint: "x", reportedAt: iso(-DAY) } })
    const replay = await sweep({ replay: true }, { sonarr: { queue: [stalled] } })
    expect(replay.scope).toBe("replay")
    expect(replay.digest_due).toBe(true)
    expect(Object.keys(readLedger(root)).sort()).toEqual(["downloads:sonarr:11", "gone"])
    expect(recallSweep(root, "replay")!.length).toBeGreaterThan(0)
  })
  it("caps a long list", async () => {
    const records = Array.from({ length: LIST_CAP * 3 + 4 }, (_, i) => ({ id: i + 1, seriesId: i + 1, series: { title: `S${i}` }, title: "t", size: 10, sizeleft: 5, status: "failed" }))
    const report = await sweep({}, { sonarr: { queue: records } })
    expect(report.findings).toHaveLength(LIST_CAP * 3)
    expect(report.omitted).toBe(4)
    expect(report.digest_draft).toContain(`and ${LIST_CAP * 3 - LIST_CAP} more`)
  })
  it("draftDigest handles empty and short lists", () => {
    expect(draftDigest([])).toBe("")
    expect(draftDigest([{ summary: "a" }])).toBe("- a")
  })
})

describe("sanitizing, pruning, and the daily cap", () => {
  it("strips links, control characters and newlines from outside text", async () => {
    expect(safe("a\nb\u0007 https://evil.example/x?y=1 c")).toBe("a b c")
    const report = await sweep({}, { sonarr: { queue: [{ id: 1, seriesId: 2, series: { title: "Evil\nShow http://x.test/p" }, title: "R", size: 10, sizeleft: 5, status: "failed" }] } })
    const summary = report.findings.find((f) => f.id === "downloads:sonarr:1")!.summary
    expect(summary).not.toMatch(/http|\n/u)
    expect(summary).toContain("Evil Show")
  })
  it("keeps ledger entries whose source could not be read, and prunes those whose source is fine", async () => {
    const entry = { fingerprint: "x", reportedAt: iso(-DAY) }
    writeLedger(root, { "downloads:sonarr:1": entry, "downloads:radarr:2": entry, "missing:sonarr:3": entry, "containers:a": entry, "disk:array:capacity": entry, "grants:routine:z": entry, "sweep:host": entry, "parity:age": entry, "stale:other": entry })
    const report = await sweep({ sanctuary: undefined }, { fail: "sonarr" })
    expect(report.sources.sonarr).not.toBe("ok")
    expect(Object.keys(readLedger(root)).sort()).toEqual(["containers:a", "disk:array:capacity", "downloads:sonarr:1", "missing:sonarr:3", "parity:age", "sweep:host"])
  })
  it("says no digest is due after one went out today, but not for a replay sweep", async () => {
    const stalled = { id: 11, seriesId: 5, series: { title: "Show" }, title: "R", size: 1000, sizeleft: 400, status: "failed" }
    writeLedger(root, {}, iso(-HOUR))
    const today = await sweep({}, { sonarr: { queue: [stalled] } })
    expect(today.digest_due).toBe(false)
    expect(today.fresh).toContain("downloads:sonarr:11")
    expect(today.guidance).toContain("already went out today")
    expect((await sweep({ replay: true }, { sonarr: { queue: [stalled] } })).digest_due).toBe(true)
    writeLedger(root, {}, iso(-2 * DAY))
    const later = await sweep({}, { sonarr: { queue: [stalled] } })
    expect(later.digest_due).toBe(true)
    expect(later.guidance).not.toContain("already went out today")
  })
})
