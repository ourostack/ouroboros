import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The media MCP is a hand-written standalone .mjs deployed into the bundle as-is;
// it has no TypeScript types. It is imported here for its two pure exports, which
// are the deterministic core the agent must never have to reason out itself.
// @ts-expect-error - untyped hand-written module deployed verbatim
import { computeDownloadState, diagnose } from "../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs"

const GB = 1073741824
const hoursAgo = (now: number, h: number) => new Date(now - h * 3_600_000).toISOString()

function baseResult(over: Record<string, unknown> = {}) {
  return {
    file: { on_shelf: false },
    search: { grab_attempts: 1, last_grab_title: "Some Release", monitored: true },
    download: { active_downloads: 0, active_items: 0, states: [], tracked_states: [], errors: [], size_left_bytes: 0, size_total_bytes: 0, percent_complete: null, stalled: false, stalled_items: [] },
    ...over,
  }
}
const healthyChain = { healthy: true, problems: [] }

describe("media MCP — computeDownloadState", () => {
  const now = Date.parse("2026-09-22T00:00:00.000Z")

  it("counts a season pack once per download, not once per queue row", () => {
    // Three episode rows sharing one downloadId: summing rows would report the
    // pack at 3x its real size. Progressing, so not stalled.
    const rows = [1, 2, 3].map((n) => ({ id: n, downloadId: "pack-1", status: "downloading", trackedDownloadState: "downloading", size: 15 * GB, sizeleft: 5 * GB, added: hoursAgo(now, 1) }))
    const d = computeDownloadState(rows, now)
    expect(d.active_downloads).toBe(1)
    expect(d.active_items).toBe(3)
    expect(d.size_total_bytes).toBe(15 * GB)
    expect(d.stalled).toBe(false)
  })

  it("reports a release at zero bytes past the stall window as stalled", () => {
    // The exact production shape from 2026-09-21: 2.17 GB, nothing downloaded, 30h old.
    const rows = [{ id: 1356738359, downloadId: "abc", status: "downloading", trackedDownloadState: "downloading", title: "Autumn.in.New.York.2000.1080p.BluRay", size: 2166264964, sizeleft: 2166264964, added: hoursAgo(now, 30) }]
    const d = computeDownloadState(rows, now)
    expect(d.stalled).toBe(true)
    expect(d.percent_complete).toBe(0)
    expect(d.stalled_items).toHaveLength(1)
    expect(d.stalled_items[0]).toMatchObject({ age_hours: 30, size_gb: 2.02, queue_id: 1356738359 })
  })

  it("does not call a fresh zero-byte grab stalled inside the window", () => {
    const rows = [{ id: 1, downloadId: "x", status: "queued", size: 2 * GB, sizeleft: 2 * GB, added: hoursAgo(now, 2) }]
    expect(computeDownloadState(rows, now).stalled).toBe(false)
  })

  it("does not call a download stalled while it is making progress, however old", () => {
    const rows = [{ id: 1, downloadId: "x", status: "downloading", size: 4 * GB, sizeleft: 1 * GB, added: hoursAgo(now, 48) }]
    expect(computeDownloadState(rows, now).stalled).toBe(false)
  })

  it("computes percent complete from deduplicated totals", () => {
    const rows = [{ id: 1, downloadId: "x", status: "downloading", size: 100, sizeleft: 25, added: hoursAgo(now, 1) }]
    expect(computeDownloadState(rows, now).percent_complete).toBe(75)
  })

  it("is empty and quiet with no queue rows", () => {
    const d = computeDownloadState([], now)
    expect(d.active_downloads).toBe(0)
    expect(d.stalled).toBe(false)
    expect(d.percent_complete).toBeNull()
  })
})

describe("media MCP — diagnose", () => {
  it("calls a stalled download stuck, with the blocklist-and-research fix", () => {
    const download = computeDownloadState(
      [{ id: 9, downloadId: "d", status: "downloading", title: "Dead.Release", size: 2 * GB, sizeleft: 2 * GB, added: hoursAgo(Date.parse("2026-09-22T00:00:00.000Z"), 30) }],
      Date.parse("2026-09-22T00:00:00.000Z"),
    )
    const dx = diagnose({ shelf: {}, result: baseResult({ download }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_stage).toBe("download")
    expect(dx.stuck_reason).toBe("stalled_no_progress")
    expect(dx.likely_fix).toBe("blocklist_and_research")
    expect(dx.summary).toContain("Stalled, not slow")
    expect(dx.summary).toContain("30 hours")
  })

  it("calls a genuinely progressing download downloading, not stuck", () => {
    const download = { active_downloads: 1, active_items: 1, states: ["downloading"], tracked_states: ["downloading"], errors: [], size_left_bytes: 1 * GB, size_total_bytes: 4 * GB, percent_complete: 75, stalled: false, stalled_items: [] }
    const dx = diagnose({ shelf: {}, result: baseResult({ download }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_stage).toBeNull()
    expect(dx.summary).toContain("Downloading now")
  })

  it("says nothing is stuck when the movie is on the shelf", () => {
    const dx = diagnose({ shelf: {}, result: baseResult({ file: { on_shelf: true } }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_reason).toBeNull()
    expect(dx.summary).toContain("Nothing is stuck")
  })

  it("blames the acquisition chain, not the title, when the chain is down", () => {
    const chain = { healthy: false, problems: [{ service: "prowlarr", message: "Prowlarr has zero indexers configured." }] }
    const dx = diagnose({ shelf: {}, result: baseResult({ search: { grab_attempts: 0, monitored: true } }), chain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_reason).toBe("acquisition_chain_down")
    expect(dx.human_action_required).toBe(true)
  })

  it("names an unmonitored request rather than searching forever", () => {
    const dx = diagnose({ shelf: {}, result: baseResult(), chain: healthyChain, entity: { monitored: false }, kind: "movie" })
    expect(dx.stuck_reason).toBe("not_monitored")
  })

  it("points a never-grabbed title at a rescan", () => {
    const dx = diagnose({ shelf: {}, result: baseResult({ search: { grab_attempts: 0, monitored: true } }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_reason).toBe("no_search_run_or_no_acceptable_release")
  })

  it("distinguishes grabbed-but-not-imported from a partial series", () => {
    const grabbed = diagnose({ shelf: {}, result: baseResult({ search: { grab_attempts: 1, last_grab_title: "The Grab", monitored: true } }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(grabbed.stuck_reason).toBe("grabbed_but_not_imported")

    const partial = diagnose({ shelf: {}, result: baseResult({ file: { episodes_on_disk: 4, episodes_total: 10 } }), chain: healthyChain, entity: { monitored: true }, kind: "series" })
    expect(partial.stuck_reason).toBe("partially_imported")
  })
})

describe("media MCP — search_now and blocklist_stalled", () => {
  type Call = { method: string; url: string; body?: unknown }
  const now = Date.now()
  let calls: Call[]
  let mod: any
  let series: any[]
  let movies: any[]
  let queues: { sonarr: any[]; radarr: any[] }
  let lookups: { series: any[]; movie: any[] }
  let jellyfinItems: any[]
  let deleteStatus: Record<number, number>
  let radarrDown: boolean

  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

  beforeEach(async () => {
    calls = []
    series = [
      { id: 7, title: "Severance", year: 2022, tmdbId: 95396 },
      { id: 8, title: "Fargo", year: 2014, tmdbId: 1 },
      { id: 9, title: "Fargo", year: 2024, tmdbId: 2 },
    ]
    movies = [{ id: 3, title: "Autumn in New York", year: 2000, tmdbId: 5 }]
    queues = { sonarr: [], radarr: [] }
    lookups = { series: [], movie: [] }
    jellyfinItems = []
    deleteStatus = {}
    radarrDown = false
    const dir = mkdtempSync(join(tmpdir(), "media-cred-"))
    const credPath = join(dir, "c.json")
    writeFileSync(credPath, JSON.stringify({
      jellyseerr: { url: "http://seerr", apiKey: "k" }, sonarr: { url: "http://sonarr", apiKey: "k" },
      radarr: { url: "http://radarr", apiKey: "k" }, prowlarr: { url: "http://prowlarr", apiKey: "k" },
      jellyfin: { url: "http://jellyfin", apiKey: "jk" },
    }))
    process.env.SANCTUARY_MEDIA_CREDENTIALS = credPath
    process.env.SANCTUARY_MEDIA_STATE = join(dir, "state", "download-progress.json")
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const method = init.method ?? "GET"
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined })
      const isSonarr = url.startsWith("http://sonarr")
      if (radarrDown && url.startsWith("http://radarr")) throw new Error("connect ECONNREFUSED")
      if (url.includes("/series/lookup")) return json(lookups.series)
      if (url.includes("/movie/lookup")) return json(lookups.movie)
      if (url.startsWith("http://jellyfin/Items")) return json({ Items: jellyfinItems })
      if (url.includes("/api/v3/series")) return json(series)
      if (url.includes("/api/v3/movie")) return json(movies)
      if (url.includes("/api/v3/queue/") && method === "DELETE") {
        const status = deleteStatus[Number(url.split("/queue/")[1].split("?")[0])] ?? 204
        return { ok: status < 300, status, json: async () => { throw new SyntaxError("Unexpected end of JSON input") }, text: async () => (status < 300 ? "" : "gone") }
      }
      if (url.includes("/api/v3/queue")) {
        const all = isSonarr ? queues.sonarr : queues.radarr
        const page = Number(new URL(url).searchParams.get("page") ?? 1)
        return json({ records: all.slice((page - 1) * 200, page * 200), totalRecords: all.length })
      }
      if (url.includes("/api/v3/command")) return json({ id: 99, name: JSON.parse(init.body).name, status: "queued" })
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
  })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS; delete process.env.SANCTUARY_MEDIA_STATE })

  const commands = () => calls.filter((c) => c.url.includes("/command"))
  const deletes = () => calls.filter((c) => c.method === "DELETE")
  const stalledRow = (id: number, extra: Record<string, unknown> = {}) => ({ id, seriesId: 7, movieId: 3, downloadId: `d${id}`, title: `Rel.${id}`, status: "downloading", size: 2 * GB, sizeleft: 2 * GB, added: hoursAgo(now, 30), ...extra })

  it("searches a series by service_id", async () => {
    const out = await mod.mediaSearchNow({ kind: "series", service_id: 7 })
    expect(commands()[0]).toMatchObject({ method: "POST", url: "http://sonarr/api/v3/command", body: { name: "SeriesSearch", seriesId: 7 } })
    expect(out).toMatchObject({ kind: "series", service_id: 7, title: "Severance", command: { id: 99, name: "SeriesSearch", status: "queued" }, queue: [] })
  })

  it("resolves by case-insensitive title and by tmdb_id", async () => {
    expect((await mod.mediaSearchNow({ kind: "series", title: "severance" })).service_id).toBe(7)
    expect((await mod.mediaSearchNow({ kind: "series", tmdb_id: 95396 })).service_id).toBe(7)
  })

  it("refuses an ambiguous title without searching", async () => {
    const out = await mod.mediaSearchNow({ kind: "series", title: "Fargo" })
    expect(out.result).toBe("ambiguous")
    expect(out.candidates.map((c: any) => c.service_id)).toEqual([8, 9])
    expect(commands()).toHaveLength(0)
  })

  it("reports not_found with near candidates and never adds anything", async () => {
    lookups.series = [{ title: "Zebra Show", year: 2020, tvdbId: 5, tmdbId: 6 }]
    const out = await mod.mediaSearchNow({ kind: "series", title: "Zebra" })
    expect(out.result).toBe("not_found")
    expect(out.candidates[0]).toMatchObject({ title: "Zebra Show", not_in_library: true })
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0)
    expect((await mod.mediaSearchNow({ kind: "series" })).result).toBe("not_found")
  })

  it("searches a movie through Radarr", async () => {
    const out = await mod.mediaSearchNow({ kind: "movie", title: "Autumn in New York" })
    expect(commands()[0]).toMatchObject({ url: "http://radarr/api/v3/command", body: { name: "MoviesSearch", movieIds: [3] } })
    expect(out.service_id).toBe(3)
  })

  it("rejects a bad kind", async () => {
    expect((await mod.mediaSearchNow({ kind: "show" })).result).toBe("invalid_kind")
    expect((await mod.mediaBlocklistStalled({ kind: "show", service_id: 1 })).result).toBe("invalid_kind")
  })

  it("reports the item's queue with the shared stalled rule, ignoring other items", async () => {
    queues.sonarr = [stalledRow(1), stalledRow(2, { added: hoursAgo(now, 1) }), stalledRow(3, { seriesId: 99 })]
    const out = await mod.mediaSearchNow({ kind: "series", service_id: 7 })
    expect(out.queue).toEqual([
      { queue_id: 1, title: "Rel.1", status: "downloading", size_left_bytes: 2 * GB, stalled: true },
      { queue_id: 2, title: "Rel.2", status: "downloading", size_left_bytes: 2 * GB, stalled: false },
    ])
    expect(mod.isStalledRow(stalledRow(1), now)).toBe(true)
    // Nearly done but unfinished for days (Curb S10E02 at 99.85% for weeks) is stuck too; a fresh partial is not.
    expect(mod.isStalledRow(stalledRow(9, { sizeleft: 2 * 1024 * 1024, added: hoursAgo(now, 24 * 36) }), now)).toBe(true)
    expect(mod.isStalledRow(stalledRow(9, { sizeleft: 2 * 1024 * 1024, added: hoursAgo(now, 30) }), now)).toBe(false)
    expect(mod.isStalledRow(stalledRow(9, { sizeleft: 0, added: hoursAgo(now, 24 * 36) }), now)).toBe(false)
    expect(mod.isStalledRow(stalledRow(9, { added: undefined }), now)).toBe(false)
    expect(mod.isStalledRow(stalledRow(9, { size: 0 }), now)).toBe(false)
  })

  it("blocklists every stalled row then re-searches", async () => {
    queues.sonarr = [stalledRow(1), stalledRow(2, { added: hoursAgo(now, 1) }), stalledRow(4)]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7 })
    expect(out.removed).toEqual([1, 4])
    expect(deletes().map((d) => d.url)).toEqual([
      "http://sonarr/api/v3/queue/1?removeFromClient=true&blocklist=true&skipRedownload=true",
      "http://sonarr/api/v3/queue/4?removeFromClient=true&blocklist=true&skipRedownload=true",
    ])
    expect(out.command).toMatchObject({ name: "SeriesSearch" })
    expect(calls.findIndex((c) => c.method === "DELETE")).toBeLessThan(calls.findIndex((c) => c.url.includes("/command")))
  })

  it("treats a 200 with an empty body as success, as Sonarr answers a queue DELETE", async () => {
    // Live 2026-10-02: Curb S10E02 was blocklisted, then res.json() threw and the re-search never ran.
    queues.sonarr = [stalledRow(5)]
    deleteStatus[5] = 200
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7 })
    expect(out.removed).toEqual([5])
    expect(out.failed ?? []).toEqual([])
    expect(out.command).toMatchObject({ name: "SeriesSearch" })
  })

  it("blocklists only the explicit ids and can skip the re-search", async () => {
    queues.radarr = [stalledRow(5), stalledRow(6)]
    const out = await mod.mediaBlocklistStalled({ kind: "movie", service_id: 3, queue_ids: [6], research: false })
    expect(out.removed).toEqual([6])
    expect(out.command).toBeNull()
    expect(deletes()).toHaveLength(1)
    expect(commands()).toHaveLength(0)
  })

  // Live 2026-10-05: "yes please get them" deleted the only copy of The Chef Show S2, a 75.9% pack
  // stalled for two days with no ETA, after one observation in a process that had since restarted.
  const chefPack = (extra: Record<string, unknown> = {}) => stalledRow(477226420, { downloadId: "743E", title: "The Chef Show [Season 2] (2020)", size: 5914587502, sizeleft: 1426063360, timeleft: "00:00:00", added: hoursAgo(Date.now(), 55), ...extra })

  it("keeps a partial download whose stall is not confirmed, even when named", async () => {
    queues.sonarr = [chefPack()]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420], research: true })
    expect(out.result).toBe("kept_downloads")
    expect(out.kept).toEqual([{ queue_id: 477226420, title: "The Chef Show [Season 2] (2020)", percent: 75.9, reason: "stall_unconfirmed" }])
    expect(out.message).toContain("media_fill_missing")
    expect(out.message).toContain("30 minutes")
    expect(deletes()).toHaveLength(0)
    expect(commands()).toHaveLength(0)
  })

  it("keeps a named download that is still moving, however old", async () => {
    queues.sonarr = [chefPack({ timeleft: "01:10:00", added: hoursAgo(Date.now(), 24 * 10) })]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })
    expect(out.kept[0].reason).toBe("still_downloading")
    expect(deletes()).toHaveLength(0)
  })

  it("does not treat age alone as death for a partial download", async () => {
    // Past the 72 h stuck window with no ETA, but never observed: kept until a second sighting.
    queues.sonarr = [chefPack({ added: hoursAgo(Date.now(), 24 * 5) })]
    expect(mod.isStalledRow(queues.sonarr[0], Date.now())).toBe(true)
    expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7 })).result).toBe("kept_downloads")
    expect(deletes()).toHaveLength(0)
  })

  it("names a fresh zero-byte grab as not started yet and removes a failed one", () => {
    const now = Date.now()
    expect(mod.removalVerdict(stalledRow(1, { added: hoursAgo(now, 1) }), now, undefined)).toBe("not_started_yet")
    expect(mod.removalVerdict(stalledRow(1, { sizeleft: GB, status: "failed" }), now, undefined)).toBe("dead")
    expect(mod.removalVerdict({ id: 2, sizeleft: 5, status: "downloading", timeleft: null }, now, { sizeleft: 5, at: now - 31 * 60_000 })).toBe("dead")
    expect(mod.removalVerdict({ id: 2, sizeleft: 5, status: "downloading" }, now, { sizeleft: 6, at: now - 31 * 60_000 })).toBe("stall_unconfirmed")
  })

  it("removes named downloads on the owner's own words and echoes them", async () => {
    queues.sonarr = [chefPack()]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420], owner_words: " clear the stuck chef download ", research: false })
    expect(out.removed).toEqual([477226420])
    expect(out.removed_on_owner_words).toBe("clear the stuck chef download")
    expect(out.kept).toBeUndefined()
    expect(deletes()).toHaveLength(1)
  })

  it("refuses owner words without named queue ids", async () => {
    queues.sonarr = [chefPack()]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, owner_words: "clear everything" })
    expect(out.result).toBe("owner_words_need_queue_ids")
    expect(deletes()).toHaveLength(0)
  })

  it("confirms a stall across a restart from the persisted observation, then removes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      queues.sonarr = [chefPack()]
      expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })).result).toBe("kept_downloads")
      vi.setSystemTime(Date.now() + 31 * 60_000)
      vi.resetModules()
      mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
      const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420], research: false })
      expect(out.removed).toEqual([477226420])
    } finally { vi.useRealTimers() }
  })

  it("restarts confirmation when progress was made or the sightings are hours apart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      queues.sonarr = [chefPack()]
      await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })
      vi.setSystemTime(Date.now() + 7 * 3_600_000)
      expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })).result).toBe("kept_downloads")
      vi.setSystemTime(Date.now() + 31 * 60_000)
      queues.sonarr = [chefPack({ sizeleft: 1_000_000_000 })]
      expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })).result).toBe("kept_downloads")
      vi.setSystemTime(Date.now() + 31 * 60_000)
      expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420], research: false })).removed).toEqual([477226420])
    } finally { vi.useRealTimers() }
  })

  it("keeps movie and id-only rows apart from series rows with the same id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const partial = (extra: Record<string, unknown> = {}) => stalledRow(6, { downloadId: undefined, sizeleft: GB, added: hoursAgo(Date.now(), 30), ...extra })
      queues.radarr = [partial()]
      queues.sonarr = [partial()]
      expect((await mod.mediaBlocklistStalled({ kind: "movie", service_id: 3, queue_ids: [6] })).result).toBe("kept_downloads")
      vi.setSystemTime(Date.now() + 31 * 60_000)
      expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [6] })).result).toBe("kept_downloads")
      expect((await mod.mediaBlocklistStalled({ kind: "movie", service_id: 3, queue_ids: [6], research: false })).removed).toEqual([6])
      expect(mod.progressKey({ id: 6 }, "movie")).toBe("MOVIE:ROW:6")
      expect(mod.progressKey({ id: 6, downloadId: "ab" })).toBe("SERIES:AB")
    } finally { vi.useRealTimers() }
  })

  it("removes confirmed rows and reports the kept ones in the same call", async () => {
    queues.sonarr = [stalledRow(1), chefPack()]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [1, 477226420], research: false })
    expect(out.removed).toEqual([1])
    expect(out.kept).toHaveLength(1)
  })

  it("merges observations another process saved and never leaves a temp file behind", async () => {
    const statePath = process.env.SANCTUARY_MEDIA_STATE as string
    queues.sonarr = [chefPack()]
    await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })
    const other = { "SERIES:OTHER": { sizeleft: 1, at: Date.now(), seen: Date.now() }, "SERIES:OLD": { sizeleft: 1, at: 1, seen: 1 } }
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...other }))
    await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })
    const saved = JSON.parse(readFileSync(statePath, "utf8"))
    expect(Object.keys(saved).sort()).toEqual(["SERIES:743E", "SERIES:OTHER"])
    expect(readdirSync(dirname(statePath))).toEqual(["download-progress.json"])
  })

  it("starts empty from an unreadable, malformed or truncated progress file and survives an unwritable one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-state-"))
    const bad = join(dir, "bad.json")
    writeFileSync(bad, JSON.stringify({ "SERIES:743E": { sizeleft: "x", at: 1 }, OTHER: null }))
    process.env.SANCTUARY_MEDIA_STATE = bad
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
    queues.sonarr = [chefPack()]
    expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })).result).toBe("kept_downloads")
    writeFileSync(bad, "{\"SERIES:743E\": {\"sizel")
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
    expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })).result).toBe("kept_downloads")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.SANCTUARY_MEDIA_STATE = join(bad, "under-a-file.json")
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
    expect((await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [477226420] })).result).toBe("kept_downloads")
    expect(String(stderr.mock.calls[0]?.[0])).toContain("download progress not saved")
    stderr.mockRestore()
  })

  it("refuses a queue id that belongs to another item", async () => {
    queues.sonarr = [stalledRow(1), stalledRow(3, { seriesId: 99 })]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7, queue_ids: [1, 3] })
    expect(out.result).toBe("queue_id_not_for_item")
    expect(out.foreign_queue_ids).toEqual([3])
    expect(deletes()).toHaveLength(0)
  })

  it("deletes a season pack once, tolerates a vanished row, reports a failed delete and still re-searches", async () => {
    queues.sonarr = [stalledRow(1, { downloadId: "pack" }), stalledRow(2, { downloadId: "pack" }), stalledRow(4), stalledRow(5)]
    deleteStatus = { 4: 404, 5: 500 }
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7 })
    expect(deletes().map((d) => d.url.split("?")[0])).toEqual([
      "http://sonarr/api/v3/queue/1", "http://sonarr/api/v3/queue/4", "http://sonarr/api/v3/queue/5",
    ])
    expect(out.removed).toEqual([1, 4])
    expect(out.failed).toEqual([{ queue_id: 5, error: expect.stringContaining("500") }])
    expect(out.command).toMatchObject({ name: "SeriesSearch" })
  })

  it("reads every page of a long queue, filtered to the item", async () => {
    queues.sonarr = [...Array.from({ length: 250 }, (_, i) => stalledRow(1000 + i, { seriesId: 99 })), stalledRow(1)]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7 })
    expect(out.removed).toEqual([1])
    const queueReads = calls.filter((c) => c.method === "GET" && c.url.includes("/api/v3/queue?"))
    expect(queueReads[0].url).toContain("seriesIds=7")
    expect(queueReads[1].url).toContain("page=2")
  })

  it("names a lone typo-distance match instead of searching it", async () => {
    const out = await mod.mediaSearchNow({ kind: "series", title: "severence" })
    expect(out.result).toBe("ambiguous")
    expect(out.candidates[0]).toMatchObject({ service_id: 7, match: "fuzzy" })
    expect(commands()).toHaveLength(0)
  })

  it("keeps Sonarr matches when Radarr is down, and notes the outage", async () => {
    radarrDown = true
    const ranked = await mod.findLibraryCandidates("severance", "any")
    expect(ranked.map((c: any) => c.service_id)).toEqual([7])
    expect(ranked.notes[0]).toContain("library_unavailable")
    await expect(mod.findLibraryCandidates("autumn", "movie")).rejects.toThrow("radarr did not respond")
  })

  it("says nothing_to_blocklist when no row is stalled", async () => {
    queues.sonarr = [stalledRow(2, { added: hoursAgo(now, 1) })]
    const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 7 })
    expect(out.result).toBe("nothing_to_blocklist")
    expect(out.queue).toHaveLength(1)
    expect(deletes()).toHaveLength(0)
    expect((await mod.mediaBlocklistStalled({ kind: "series" })).result).toBe("service_id_required")
  })

  describe("title resolution", () => {
    beforeEach(() => {
      series.push({ id: 191, title: "The Chef Show", year: 2018, tmdbId: 83867, tvdbId: 1 })
      movies.push({ id: 4, title: "Chef", year: 2014, tmdbId: 211672 })
    })

    it("finds both the movie Chef and the series The Chef Show for the query chef", async () => {
      const r = await mod.resolveTitle("chef")
      const brief = r.library_matches.map((c: any) => ({ kind: c.kind, service_id: c.service_id, title: c.title, match: c.match }))
      expect(brief).toEqual([
        { kind: "movie", service_id: 4, title: "Chef", match: "exact" },
        { kind: "series", service_id: 191, title: "The Chef Show", match: "prefix" },
      ])
      expect(r.not_in_library).toBe(false)
      expect(r.lookup_candidates).toEqual([])
    })

    it("tolerates a typo: chef shwo finds The Chef Show", async () => {
      const r = await mod.resolveTitle("chef shwo")
      expect(r.library_matches[0]).toMatchObject({ kind: "series", service_id: 191, match: "fuzzy" })
    })

    it("normalizes case, punctuation and a leading the", () => {
      expect(mod.matchKind("CHEF-SHOW!", "The Chef Show")).toBe("exact")
      expect(mod.matchKind("show chef", "The Chef Show")).toBe("token")
      expect(mod.matchKind("the chef show", "Chef Show")).toBe("exact")
      expect(mod.matchKind("chef", "Chef's Table")).toBe("prefix")
    })

    it("falls back to the TVDB/TMDB lookup only when the library has nothing", async () => {
      lookups.series = [{ title: "Totally New Show", year: 2026, tvdbId: 9, tmdbId: 10 }, { id: 5, title: "Already Tracked", tvdbId: 1 }]
      lookups.movie = [{ title: "Totally New Film", year: 2025, tmdbId: 11 }]
      const r = await mod.resolveTitle("totally new")
      expect(r.library_matches).toEqual([])
      expect(r.not_in_library).toBe(true)
      expect(r.lookup_candidates.map((c: any) => [c.kind, c.title, c.not_in_library])).toEqual([["series", "Totally New Show", true], ["movie", "Totally New Film", true]])
      const hit = await mod.resolveTitle("chef")
      expect(hit.lookup_candidates).toEqual([])
      expect(calls.some((c) => c.url.includes("lookup") && c.url.includes("term=chef"))).toBe(false)
    })

    it("does not match an unrelated short query", async () => {
      expect(mod.matchKind("xq", "The Chef Show")).toBeNull()
      expect(mod.matchKind("chess", "Chef")).toBeNull()
      expect(mod.matchKind("zz", "Chef")).toBeNull()
      const r = await mod.resolveTitle("xq")
      expect(r.library_matches).toEqual([])
    })

    it("adds Jellyfin-only titles and marks shared ones", async () => {
      jellyfinItems = [{ Id: "j1", Name: "The Chef Show", Type: "Series", ProviderIds: { Tmdb: "83867" } }, { Id: "j2", Name: "Chef Special", Type: "Movie", ProductionYear: 2001 }]
      const r = await mod.resolveTitle("chef")
      expect(r.library_matches.find((c: any) => c.service_id === 191).in_jellyfin).toBe(true)
      expect(r.library_matches.find((c: any) => c.jellyfin_id === "j2")).toMatchObject({ source: "jellyfin", kind: "movie" })
    })

    it("survives a Jellyfin outage", async () => {
      const base = (globalThis as any).fetch
      vi.stubGlobal("fetch", async (url: string, init: any) => (url.startsWith("http://jellyfin") ? { ok: false, status: 500, text: async () => "boom" } : base(url, init)))
      const r = await mod.resolveTitle("chef")
      expect(r.library_matches).toHaveLength(2)
      expect(r.notes[0]).toContain("jellyfin_unavailable")
    })

    it("media_search surfaces library_matches for a half-remembered title", async () => {
      const base = (globalThis as any).fetch
      vi.stubGlobal("fetch", async (url: string, init: any) => (url.startsWith("http://seerr") ? json({ results: [] }) : base(url, init)))
      const out = await mod.mediaSearch({ query: "chef" })
      expect(out.library_matches.map((c: any) => c.title)).toEqual(["Chef", "The Chef Show"])
      expect(out.note).toContain("library_matches")
    })

    it("media_search reports lookup candidates when nothing is in the library", async () => {
      lookups.series = [{ title: "Zebra Show", tvdbId: 3 }]
      const base = (globalThis as any).fetch
      vi.stubGlobal("fetch", async (url: string, init: any) => (url.startsWith("http://seerr") ? json({ results: [] }) : base(url, init)))
      const out = await mod.mediaSearch({ query: "zebra" })
      expect(out.library_matches).toEqual([])
      expect(out.lookup_candidates[0]).toMatchObject({ title: "Zebra Show", not_in_library: true })
    })

    it("media_request_status names library candidates when there is no Jellyseerr request", async () => {
      const base = (globalThis as any).fetch
      vi.stubGlobal("fetch", async (url: string, init: any) => (url.startsWith("http://seerr") ? json({ results: [] }) : base(url, init)))
      const out = await mod.mediaRequestStatus({ title: "chef" })
      expect(out.found).toBe(false)
      expect(out.library_matches.map((c: any) => c.service_id)).toEqual([4, 191])
    })

    it("media_search_now resolves the partial title chef to the series", async () => {
      const out = await mod.mediaSearchNow({ kind: "series", title: "chef" })
      expect(out).toMatchObject({ service_id: 191, title: "The Chef Show" })
    })
  })
})

describe("media MCP — read-only annotations", () => {
  it("marks exactly the inspection tools read-only, so an orientation hold still lets the Butler look", async () => {
    const mod: any = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
    const readOnly = mod.TOOLS.filter((t: any) => t.annotations?.readOnlyHint === true).map((t: any) => t.name).sort()
    expect(readOnly).toEqual(["media_chain_health", "media_episodes", "media_indexer_search", "media_release_search", "media_request_status", "media_search"])
  })
})

describe("media MCP — release numbering tools", () => {
  type Call = { method: string; url: string; body?: any }
  let calls: Call[]
  let mod: any
  let blocklist: any[]
  let manual: any[]
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
  const episodes = [14472, 14473, 14474, 14475, 14476].map((id, i) => ({ id, seasonNumber: 2, episodeNumber: i + 1, title: ["Milk Bar Bake Sale", "Roy's Italian Cuisine", "Jessica Largey", "Tartine", "Late Night Burger"][i], airDate: "2020-09-24", hasFile: false, monitored: true, ...(i < 4 ? { sceneSeasonNumber: 4, sceneEpisodeNumber: i + 1 } : {}) }))
  const pack = { guid: "g-s3", indexerId: 5, indexer: "Idx", title: "The Chef Show Season 3 [1080p x265 10bit S85 Joy]", size: 9e9, seeders: 40, age: 100, quality: { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1 } }, languages: [{ id: 1, name: "English" }],
    fullSeason: true, seasonNumber: 3, episodeNumbers: [], mappedEpisodeInfo: [], rejected: true, rejections: ["Unknown Series"], protocol: "torrent" }
  const blocked = { guid: "g-bl", indexerId: 5, title: "The Chef Show S03 1080p NF WEBRip DDP5 1 x264", seeders: 3, fullSeason: true, seasonNumber: 3, rejected: true, rejections: [{ reason: "Release is blocklisted" }],
    mappedEpisodeInfo: [{ id: 1, seasonNumber: 1, episodeNumber: 1, title: "Wrong" }] }

  beforeEach(async () => {
    calls = []
    blocklist = [{ id: 11, seriesId: 191, sourceTitle: "Bad.S03", episodeIds: [1], date: "2026-10-01" }, { id: 12, seriesId: 5, sourceTitle: "Other" }]
    manual = [{ path: "/dl/Chef.S02E01.mkv", name: "Chef.S02E01", seasonNumber: 2, episodes: [], quality: { quality: { name: "WEBDL-1080p" } }, languages: [{ id: 1, name: "English" }], releaseGroup: "Joy", rejections: [{ reason: "Unknown Series" }] }]
    const dir = mkdtempSync(join(tmpdir(), "media-cred-"))
    const credPath = join(dir, "c.json")
    writeFileSync(credPath, JSON.stringify({ jellyseerr: { url: "http://seerr", apiKey: "k" }, sonarr: { url: "http://sonarr", apiKey: "k" }, radarr: { url: "http://radarr", apiKey: "k" }, prowlarr: { url: "http://prowlarr", apiKey: "k" } }))
    process.env.SANCTUARY_MEDIA_CREDENTIALS = credPath
    process.env.SANCTUARY_MEDIA_STATE = join(dir, "state", "download-progress.json")
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const method = init.method ?? "GET"
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined })
      if (url.includes("/api/v3/episode")) return json(episodes)
      if (url.startsWith("http://prowlarr/api/v1/search")) return json([
        { indexer: "1337x", title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", size: 5.9e9, seeders: 0, age: 1800, protocol: "torrent" },
        { indexer: "Lime", title: "The Chef Show S03 1080p NF WEBRip", seeders: 3, protocol: "torrent" },
        { title: "No seeders field" },
      ])
      if (url.startsWith("http://sonarr/api/v3/release") && method === "GET") return json([pack, blocked, pack])
      if (url.startsWith("http://radarr/api/v3/release") && method === "GET") return json([{ guid: "m1", indexerId: 2, title: "Movie 2020", seeders: 1, rejections: [] }])
      if (url.includes("/api/v3/release") && method === "POST") return json({ approved: true, rejected: false, rejections: [], downloadId: "DL1" })
      if (url.includes("/api/v3/blocklist/bulk")) { const ids = JSON.parse(init.body).ids; blocklist = blocklist.filter((b) => !ids.includes(b.id)); return json({}) }
      if (url.includes("/api/v3/blocklist")) return json({ records: blocklist, totalRecords: blocklist.length })
      if (url.includes("/api/v3/manualimport")) return json(manual)
      if (url.includes("/api/v3/command")) return json({ id: 7, name: JSON.parse(init.body).name, status: "queued" })
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
  })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS; delete process.env.SANCTUARY_MEDIA_STATE })

  it("media_episodes lists a season with ids and codes", async () => {
    const out = await mod.mediaEpisodes({ service_id: 191, season_number: 2 })
    expect(calls[0].url).toBe("http://sonarr/api/v3/episode?seriesId=191&seasonNumber=2")
    expect(out.episodes[0]).toEqual({ episode_id: 14472, code: "S02E01", season: 2, episode: 1, title: "Milk Bar Bake Sale", air_date: "2020-09-24", has_file: false, monitored: true, scene_code: "S04E01" })
    expect(out.episodes[4].scene_code).toBeNull()
    expect(out.count).toBe(5)
  })

  it("media_indexer_search finds releases under any name, sorted by seeders, and grabs nothing", async () => {
    const out = await mod.mediaIndexerSearch({ query: "The Chef Show Season 4", limit: 2 })
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://prowlarr/api/v1/search?query=The%20Chef%20Show%20Season%204&type=search&limit=100" })
    expect(out.count).toBe(3)
    expect(out.releases.map((r: any) => r.seeders)).toEqual([3, 0])
    expect(out.releases[1]).toEqual({ indexer: "1337x", title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", size_bytes: 5.9e9, seeders: 0, age_days: 1800, protocol: "torrent" })
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0)
    expect((await mod.mediaIndexerSearch({ query: "  " })).result).toBe("query_required")
    expect((await mod.mediaIndexerSearch({ query: "x", limit: 999 })).releases).toHaveLength(3)
  })

  it("release search returns compact rows with parse, mapping, rejections and blocklist flag", async () => {
    const out = await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
    expect(calls[0].url).toBe("http://sonarr/api/v3/release?seriesId=191&seasonNumber=2")
    expect(out.total_found).toBe(2)
    expect(out.releases[0]).toMatchObject({ guid: "g-s3", indexer_id: 5, full_season: true, parsed_season: 3, rejected: true, rejections: ["Unknown Series"], blocklisted: false, quality: "WEBDL-1080p" })
    expect(out.releases[1]).toMatchObject({ guid: "g-bl", blocklisted: true, mapped_episodes: [{ episode_id: 1, code: "S01E01", title: "Wrong" }] })
    const filtered = await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2, query: "joy" })
    expect(filtered.releases.map((r: any) => r.guid)).toEqual(["g-s3"])
  })

  it("release search by episode ids and for a movie, and requires a scope", async () => {
    await mod.mediaReleaseSearch({ kind: "series", service_id: 191, episode_ids: [14472, 14473] })
    expect(calls.map((c) => c.url)).toEqual(["http://sonarr/api/v3/release?episodeId=14472", "http://sonarr/api/v3/release?episodeId=14473"])
    const movie = await mod.mediaReleaseSearch({ kind: "movie", service_id: 3 })
    expect(calls.at(-1)!.url).toBe("http://radarr/api/v3/release?movieId=3")
    expect(movie.releases[0].mapped_movie_id).toBeNull()
    expect(await mod.mediaReleaseSearch({ kind: "series", service_id: 191 })).toEqual({ result: "season_number_or_episode_ids_required" })
    expect(await mod.mediaReleaseSearch({ kind: "tv", service_id: 1 })).toMatchObject({ result: "invalid_kind" })
  })

  it("grabs with an explicit episode override body", async () => {
    await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
    const out = await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5, series_id: 191, episode_ids: [14472, 14473, 14474, 14475, 14476], download_client_id: 2 })
    const post = calls.find((c) => c.method === "POST")!
    expect(post.url).toBe("http://sonarr/api/v3/release")
    // Sonarr v4 throws ArgumentNullException (HTTP 500) on an override without quality and languages.
    expect(post.body).toEqual({ guid: "g-s3", indexerId: 5, seriesId: 191, episodeIds: [14472, 14473, 14474, 14475, 14476], shouldOverride: true,
      quality: pack.quality, languages: pack.languages, downloadClientId: 2 })
    expect(out).toMatchObject({ result: "grabbed", response: { approved: true, download_id: "DL1" } })
  })

  it("refuses an override when the search did not report the release's quality", async () => {
    await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-bl", indexer_id: 5, series_id: 191, episode_ids: [14472] })).toMatchObject({ result: "release_quality_unknown" })
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })

  it("sends an empty language list when the search reported none", async () => {
    const bare = { ...pack, guid: "g-bare", languages: undefined }
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const method = init.method ?? "GET"
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined })
      if (url.includes("/api/v3/episode")) return json(episodes)
      if (method === "GET") return json([bare])
      return json({ approved: true, rejected: false, rejections: [], downloadId: "DL2" })
    })
    await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
    await mod.mediaReleaseGrab({ kind: "series", guid: "g-bare", indexer_id: 5, series_id: 191, episode_ids: [14472] })
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ quality: pack.quality, languages: [] })
  })

  it("refuses a mismatched season pack without episode_ids, and a foreign episode id", async () => {
    await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5 })).toMatchObject({ result: "season_pack_mismatch", parsed_season: 3, target_season: 2 })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5, season_number: 2 })).toMatchObject({ result: "season_pack_mismatch" })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5, series_id: 191, episode_ids: [1] })).toEqual({ result: "episode_id_not_for_series", foreign_episode_ids: [1] })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "nope", indexer_id: 5 })).toMatchObject({ result: "search_first" })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 6, series_id: 191, episode_ids: [14472] })).toEqual({ result: "indexer_mismatch", expected_indexer_id: 5 })
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5, series_id: 4, episode_ids: [14472] })).toMatchObject({ result: "series_mismatch", searched_series_id: 191 })
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })

  it("grabs a matching season pack without episode_ids and a movie release plainly", async () => {
    await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 3 })
    await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5 })
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ guid: "g-s3", indexerId: 5 })
    await mod.mediaReleaseSearch({ kind: "movie", service_id: 3 })
    await mod.mediaReleaseGrab({ kind: "movie", guid: "m1", indexer_id: 2 })
    expect(calls.filter((c) => c.method === "POST")[1]).toMatchObject({ url: "http://radarr/api/v3/release", body: { guid: "m1", indexerId: 2 } })
  })

  it("expires cached releases and caps per-episode searches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
      vi.setSystemTime(Date.now() + 26 * 60_000)
      expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5, series_id: 191, episode_ids: [14472] })).toMatchObject({ result: "search_first" })
      // a later search prunes the expired rows and caches fresh ones
      await mod.mediaReleaseSearch({ kind: "series", service_id: 191, season_number: 2 })
      expect((await mod.mediaReleaseGrab({ kind: "series", guid: "g-s3", indexer_id: 5, series_id: 191, episode_ids: [14472] })).result).toBe("grabbed")
    } finally { vi.useRealTimers() }
    expect(await mod.mediaReleaseSearch({ kind: "series", service_id: 191, episode_ids: [1, 2, 3, 4, 5, 6, 7] })).toMatchObject({ result: "too_many_episode_ids", max: 6 })
  })

  it("keeps at most 500 cached releases, dropping the oldest", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ guid: `r${i}`, indexerId: 1, title: `R${i}`, seeders: 501 - i, rejections: [] }))
    vi.stubGlobal("fetch", async () => json(many))
    await mod.mediaReleaseSearch({ kind: "movie", service_id: 3, limit: 1 })
    expect((await mod.mediaReleaseGrab({ kind: "movie", guid: "r0", indexer_id: 1 })).result).toBe("search_first")
    expect((await mod.mediaReleaseGrab({ kind: "movie", guid: "r500", indexer_id: 1 })).result).toBe("grabbed")
  })

  it("flags a blocklist listing cut off at the page limit", async () => {
    vi.stubGlobal("fetch", async () => json({ records: [{ id: 1, seriesId: 191, sourceTitle: "x" }], totalRecords: 1e6 }))
    const out = await mod.mediaBlocklist({ kind: "series", service_id: 191 })
    expect(out.truncated).toBe(true)
    expect(out.count).toBe(20)
  })

  it("warns when an import replaces an episode that already has a file", async () => {
    episodes[0].hasFile = true
    try {
      const out = await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [{ path: "/dl/Chef.S02E01.mkv", episode_ids: [14472] }] })
      expect(out.replacing).toEqual([{ episode_id: 14472, code: "S02E01" }])
    } finally { episodes[0].hasFile = false }
  })

  it("lists the item's blocklist and removes only its own entries", async () => {
    const list = await mod.mediaBlocklist({ kind: "series", service_id: 191 })
    expect(list.entries).toEqual([{ blocklist_id: 11, title: "Bad.S03", date: "2026-10-01", indexer: null, quality: null, episode_ids: [1], message: null }])
    expect(await mod.mediaBlocklist({ kind: "series", service_id: 191, remove_ids: [11, 12] })).toMatchObject({ result: "blocklist_id_not_for_item", foreign_blocklist_ids: [12] })
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    const out = await mod.mediaBlocklist({ kind: "series", service_id: 191, remove_ids: [11] })
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ url: "http://sonarr/api/v3/blocklist/bulk", body: { ids: [11] } })
    expect(out).toMatchObject({ result: "removed", removed: [11], count: 0 })
  })

  it("previews a download and imports files mapped by title", async () => {
    const preview = await mod.mediaManualImport({ service_id: 191, download_id: "DL1" })
    expect(calls[0].url).toBe("http://sonarr/api/v3/manualimport?downloadId=DL1&seriesId=191&filterExistingFiles=false")
    expect(preview.files[0]).toMatchObject({ path: "/dl/Chef.S02E01.mkv", parsed_season: 2, mapped_episodes: [], rejections: ["Unknown Series"] })
    const out = await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [{ path: "/dl/Chef.S02E01.mkv", episode_ids: [14472] }] })
    expect(calls.find((c) => c.url.endsWith("/command"))!.body).toEqual({ name: "ManualImport", importMode: "auto", files: [{ path: "/dl/Chef.S02E01.mkv", seriesId: 191, episodeIds: [14472],
      quality: manual[0].quality, languages: manual[0].languages, releaseGroup: "Joy", indexerFlags: 0, releaseType: "unknown", downloadId: "DL1" }] })
    expect(out.replacing).toBeUndefined()
    expect(out).toMatchObject({ mode: "import", command: { id: 7, name: "ManualImport" } })
  })

  it("refuses to import a path outside the preview, a foreign episode, or missing episodes", async () => {
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [{ path: "/etc/passwd", episode_ids: [14472] }] })).toMatchObject({ result: "path_not_in_preview", paths: ["/etc/passwd"] })
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [{ path: "/dl/Chef.S02E01.mkv", episode_ids: [99] }] })).toMatchObject({ result: "episode_id_not_for_series", foreign_episode_ids: [99] })
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [{ path: "/dl/Chef.S02E01.mkv", episode_ids: [] }] })).toMatchObject({ result: "episode_ids_required" })
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1" })).toEqual({ result: "files_required" })
    expect(await mod.mediaManualImport({ service_id: 191 })).toEqual({ result: "download_id_required" })
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [null] })).toEqual({ result: "files_required" })
    const dup = { path: "/dl/Chef.S02E01.mkv", episode_ids: [14472] }
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [dup, dup] })).toEqual({ result: "duplicate_path" })
    manual.push({ ...manual[0], path: "/dl/Chef.S02E02.mkv", indexerFlags: 8, releaseType: "seasonPack" })
    expect(await mod.mediaManualImport({ mode: "import", service_id: 191, download_id: "DL1", files: [dup, { path: "/dl/Chef.S02E02.mkv", episode_ids: [14472] }] })).toEqual({ result: "episode_id_on_two_files" })
    expect(calls.some((c) => c.url.endsWith("/command"))).toBe(false)
  })
})

describe("media MCP — media_fill_missing", () => {
  type Call = { method: string; url: string; body?: any }
  const now = Date.parse("2026-10-05T08:00:00Z")
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
  const s1Titles = ["Seth Rogen", "Pizzana", "Guerrilla Tacos", "Hog Island", "Skywalker Ranch", "Extra Helpings with Babish and Dave"]
  const s2Titles = ["Milk Bar Bake Sale", "Roy's Italian Cuisine", "Jessica Largey", "Tartine", "Late Night Burger"]
  const q = { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1 } }
  const langs = [{ id: 1, name: "English" }]
  let calls: Call[]
  let episodes: any[]
  let queue: any[]
  let history: any[]
  let releases: Record<string, any[]>
  let prowlarrRows: any[]
  let manual: any[]
  let commands: any[]
  let mod: any
  let fail: ((method: string, url: string) => boolean) | null
  let blocklist: any[]

  const rel = (guid: string, title: string, seeders: number, over: Record<string, unknown> = {}) => ({ guid, indexerId: 5, indexer: "Lime", title, size: 5e9, seeders, quality: q, languages: langs, rejections: [], mappedEpisodeInfo: [], ...over })
  const mappedHave = [9, 10, 11, 12, 13, 14].map((n) => ({ id: 14451 + n, seasonNumber: 1, episodeNumber: n }))
  const packRow = (id: number, episodeId: number, over: Record<string, unknown> = {}) => ({ id, seriesId: 191, episodeId, title: "The Chef Show [Season 2] (2020) [WEB-DL 1080p]", status: "downloading", trackedDownloadState: "downloading",
    size: 5914587502, sizeleft: 1426063360, timeleft: "00:00:00", added: "2026-10-03T02:10:43Z", downloadId: "743E301E", ...over })
  const posts = () => calls.filter((c) => c.method !== "GET")

  beforeEach(async () => {
    calls = []
    commands = []
    fail = null
    episodes = [
      ...s1Titles.map((title, i) => ({ id: 14460 + i, seasonNumber: 1, episodeNumber: 9 + i, title, airDate: "2019-09-13", airDateUtc: "2019-09-13T07:00:00Z", hasFile: true, monitored: true })),
      ...s2Titles.map((title, i) => ({ id: 14472 + i, seasonNumber: 2, episodeNumber: i + 1, title, airDate: "2020-09-24", airDateUtc: "2020-09-24T07:00:00Z", hasFile: false, monitored: true })),
      { id: 1, seasonNumber: 0, episodeNumber: 1, title: "Special", airDate: "2020-01-01", hasFile: false, monitored: true },
      { id: 2, seasonNumber: 3, episodeNumber: 1, title: "Future Episode", airDate: "2027-01-01", airDateUtc: "2027-01-01T00:00:00Z", hasFile: false, monitored: true },
    ]
    queue = []
    history = []
    manual = []
    blocklist = []
    prowlarrRows = [{ title: "Vegas Chef Prizefight S01E03", seeders: 13, indexer: "Lime" }, { title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", seeders: 0, indexer: "LimeTorrents" }, { title: "The Chef Show S02 1080p WEB X264 STARZ", seeders: 3, indexer: "Lime" }]
    releases = {
      "seasonNumber=2": [
        rel("g-starz", "The Chef Show S02 1080p WEB X264 STARZ[rartv]", 3, { fullSeason: true, seasonNumber: 2, mappedEpisodeInfo: mappedHave }),
        rel("g-2019", "The Chef Show (2019) Season 01 S01 (1080p NF WEBRip x265 HEVC 10bit AAC 5.1 Joy)", 9, { fullSeason: true, seasonNumber: 1 }),
        rel("g-vegas", "Vegas Chef Prizefight S01E03 Its All About the Show", 13, { rejections: ["Unknown Series"] }),
        rel("g-480", "The Chef Show S02E02 WEB X264 STARZ", 4, { rejections: ["WEBDL-480p is not wanted in profile"], mappedEpisodeInfo: [mappedHave[1]] }),
        rel("g-bl", "The Chef Show S02E05 1080p HEVC x265 MeGusta", 5, { rejections: [{ reason: "Release is blocklisted" }], mappedEpisodeInfo: [mappedHave[4]] }),
        rel("g-2020", "The Chef Show [Season 2] (2020) [WEB DL 1080p]", 4, { fullSeason: true, seasonNumber: 2, mappedEpisodeInfo: mappedHave, rejections: ["Wrong season"] }),
      ],
    }
    const dir = mkdtempSync(join(tmpdir(), "media-cred-"))
    const credPath = join(dir, "c.json")
    writeFileSync(credPath, JSON.stringify({ jellyseerr: { url: "http://seerr", apiKey: "k" }, sonarr: { url: "http://sonarr", apiKey: "k" }, radarr: { url: "http://radarr", apiKey: "k" }, prowlarr: { url: "http://prowlarr", apiKey: "k" } }))
    process.env.SANCTUARY_MEDIA_CREDENTIALS = credPath
    process.env.SANCTUARY_MEDIA_STATE = join(dir, "state", "download-progress.json")
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const method = init.method ?? "GET"
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const query = url.split("?")[1] ?? ""
      if (fail && fail(method, url)) return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" }
      if (url.startsWith("http://sonarr/api/v3/series/191")) return json({ id: 191, title: "The Chef Show", year: 2019 })
      if (url.startsWith("http://sonarr/api/v3/series")) return json([{ id: 191, title: "The Chef Show", tvdbId: 1, tmdbId: 2, year: 2019 }])
      if (url.startsWith("http://sonarr/api/v3/episode")) {
        const season = /seasonNumber=(\d+)/.exec(query)?.[1]
        return json(season === undefined ? episodes : episodes.filter((e) => e.seasonNumber === Number(season)))
      }
      if (url.startsWith("http://sonarr/api/v3/queue/") && method === "DELETE") { const id = Number(url.split("/queue/")[1].split("?")[0]); queue = queue.filter((r) => r.downloadId !== queue.find((x) => x.id === id)?.downloadId); return json({}) }
      if (url.startsWith("http://sonarr/api/v3/queue")) return json({ records: queue, totalRecords: queue.length })
      if (url.startsWith("http://sonarr/api/v3/history/series")) return json(history)
      if (url.startsWith("http://sonarr/api/v3/blocklist/bulk") && method === "DELETE") { blocklist = blocklist.filter((b) => !body.ids.includes(b.id)); return json({}) }
      if (url.startsWith("http://sonarr/api/v3/blocklist")) return json({ records: blocklist, totalRecords: blocklist.length })
      if (url.startsWith("http://sonarr/api/v3/release") && method === "GET") {
        const key = Object.keys(releases).find((k) => query.includes(k))
        return json(key ? releases[key] : [])
      }
      if (url.startsWith("http://sonarr/api/v3/release") && method === "POST") return json({ approved: true, downloadId: `DL-${body.guid}` })
      if (url.startsWith("http://sonarr/api/v3/manualimport")) return json(manual)
      if (url.startsWith("http://sonarr/api/v3/command") && method === "GET") return json(commands)
      if (url.startsWith("http://sonarr/api/v3/command")) return json({ id: 42, name: body.name, status: "queued" })
      if (url.startsWith("http://prowlarr/api/v1/search")) return json(prowlarrRows)
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
  })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS; delete process.env.SANCTUARY_MEDIA_STATE })

  // Live 2026-10-05: the only copy of the 2020 pack was deleted and blocklisted by mistake.
  const blockThePack = () => {
    releases["seasonNumber=2"] = releases["seasonNumber=2"].map((r: any) => (r.guid === "g-2020" ? { ...r, seeders: 0, rejections: [{ reason: "Release is blocklisted" }] } : r))
    blocklist = [{ id: 77, seriesId: 191, sourceTitle: "The Chef Show [Season 2] (2020) [WEB-DL 1080p]", episodeIds: [14472, 14473, 14474, 14475, 14476] }, { id: 78, seriesId: 191, sourceTitle: "The Chef Show S02E05 1080p HEVC x265 MeGusta" }]
  }
  const s2 = ["S02E01", "S02E02", "S02E03", "S02E04", "S02E05"]

  it("reports a matching release that is only blocklisted, and leaves it alone without the owner's words", async () => {
    blockThePack()
    const out = await mod.mediaFillMissing({ series: "chef show", season_number: 2 }, { nowMs: now })
    expect(out.blocklisted_matches).toEqual([{ title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", seeders: 0, episodes: s2, blocklist_ids: [77] }])
    expect(out.summary).toContain("only matching release is on the blocklist")
    expect(out.next_step).toContain("retry_blocklisted")
    expect(out.actions).toEqual([])
    expect(calls.filter((c) => c.method !== "GET")).toEqual([])
  })

  it("takes the release off the blocklist on the owner's words and grabs it to wait for peers", async () => {
    blockThePack()
    const out = await mod.mediaFillMissing({ series: "chef show", season_number: 2, retry_blocklisted: " yes please get them " }, { nowMs: now })
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ url: "http://sonarr/api/v3/blocklist/bulk", body: { ids: [77] } })
    expect(out.actions[0]).toEqual({ action: "removed_from_blocklist", title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", owner_words: "yes please get them" })
    expect(out.actions[1]).toMatchObject({ action: "grabbed", title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", episodes: s2, may_never_finish: true })
    expect(calls.find((c) => c.method === "POST" && c.url.includes("/release"))?.body).toMatchObject({ guid: "g-2020", episodeIds: [14472, 14473, 14474, 14475, 14476] })
    expect(out.blocklisted_matches).toBeUndefined()
    expect(blocklist.map((b) => b.id)).toEqual([78])
    expect(out.summary).toContain("no seeders: it waits for peers and may never finish")
    expect(out.next_step).toContain("await_condition")
  })

  it("keeps reporting a blocklisted match it cannot find on the blocklist, or when lifting fails", async () => {
    blockThePack()
    blocklist = []
    const out = await mod.mediaFillMissing({ series: "chef show", season_number: 2, retry_blocklisted: "yes" }, { nowMs: now })
    expect(out.blocklisted_matches[0].blocklist_ids).toEqual([])
    expect(calls.filter((c) => c.method !== "GET")).toEqual([])
    blockThePack()
    calls.length = 0
    fail = (method, url) => method === "DELETE" && url.includes("/blocklist")
    const failed = await mod.mediaFillMissing({ series: "chef show", season_number: 2, retry_blocklisted: "yes" }, { nowMs: now })
    expect(failed.blocklisted_matches[0].blocklist_ids).toEqual([77])
    expect(failed.errors.map((e: any) => e.step)).toContain("remove from blocklist")
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })

  it("does not offer a blocklisted release when another release covers the same episodes", async () => {
    blockThePack()
    releases["seasonNumber=2"].push(rel("g-alt", "The Chef Show [Season 2] (2020) [WEB DL 720p]", 6, { fullSeason: true, seasonNumber: 2 }))
    const out = await mod.mediaFillMissing({ series: "chef show", season_number: 2 }, { nowMs: now })
    expect(out.blocklisted_matches).toBeUndefined()
    expect(out.actions[0]).toMatchObject({ action: "grabbed", title: "The Chef Show [Season 2] (2020) [WEB DL 720p]" })
  })

  it("matches an other-series blocklisted release as other_series", () => {
    expect(mod.matchReleaseToEpisodes({ title: "Vegas Chef Prizefight S01E03", rejections: ["Release is blocklisted"] }, { seriesId: 191, seriesTitle: "The Chef Show", seriesYear: 2019, wanted: [], have: [] })).toEqual({ reject: "other_series" })
  })

  it("shares stall observations with media_blocklist_stalled, so a stall fill saw can be confirmed by the guard", async () => {
    queue = [14472, 14473].map((ep, i) => packRow(900 + i, ep))
    const first = await mod.mediaFillMissing({ series: "chef show", season_number: 2 }, { nowMs: now })
    expect(first.in_flight[0]).toMatchObject({ state: "stalled", stall_confirmed: false })
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(now + 31 * 60_000)
      const out = await mod.mediaBlocklistStalled({ kind: "series", service_id: 191, queue_ids: [900], research: false })
      expect(out.removed).toEqual([900])
    } finally { vi.useRealTimers() }
  })

  it("matches the 2020 season pack by season and air year, skips packs of episodes we have, and grabs it with the right mapping", async () => {
    const out = await mod.mediaFillMissing({ series: "chef show" }, { nowMs: now })
    expect(out.goal_met).toBe(false)
    expect(out.on_shelf).toEqual({ count: 6, of: 11 })
    const grab = posts().find((c) => c.url === "http://sonarr/api/v3/release")!
    expect(grab.body).toEqual({ guid: "g-2020", indexerId: 5, seriesId: 191, episodeIds: [14472, 14473, 14474, 14475, 14476], shouldOverride: true, quality: q, languages: langs })
    expect(out.actions).toEqual([{ action: "grabbed", title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", indexer: "Lime", seeders: 4, matched_by: "season_and_air_year",
      episodes: ["S02E01", "S02E02", "S02E03", "S02E04", "S02E05"], download_id: "DL-g-2020" }])
    const reasons = Object.fromEntries(out.rejected_releases.map((r: any) => [r.title, r.reason]))
    expect(reasons).toMatchObject({
      "The Chef Show S02 1080p WEB X264 STARZ[rartv]": "holds_episodes_we_have",
      "The Chef Show (2019) Season 01 S01 (1080p NF WEBRip x265 HEVC 10bit AAC 5.1 Joy)": "no_episode_match",
      "Vegas Chef Prizefight S01E03 Its All About the Show": "other_series",
      "The Chef Show S02E02 WEB X264 STARZ": "quality_not_wanted",
      "The Chef Show S02E05 1080p HEVC x265 MeGusta": "blocklisted",
    })
    expect(out.not_found).toEqual([])
    expect(out.in_flight).toEqual([{ title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", download_id: "DL-g-2020", episodes: ["S02E01", "S02E02", "S02E03", "S02E04", "S02E05"], state: "just_grabbed" }])
    expect(out.searched).toEqual(["Sonarr season search S02"])
    expect(out.indexer_evidence).toBeUndefined()
    expect(out.summary).toContain("Grabbed 1 release now.")
    // The grabbed release is in the shared cache, so a follow-up media_release_grab works too.
    expect(await mod.mediaReleaseGrab({ kind: "series", guid: "g-2020", indexer_id: 5, series_id: 191, episode_ids: [14472] })).toMatchObject({ result: "grabbed" })
  })

  it("says stop when nothing monitored is missing, and lists unmonitored gaps", async () => {
    episodes = episodes.map((e) => (e.seasonNumber === 2 ? { ...e, hasFile: e.id !== 14476, monitored: e.id !== 14476 } : e))
    const out = await mod.mediaFillMissing({ service_id: 191, season_number: 2 }, { nowMs: now })
    expect(out).toMatchObject({ goal_met: true, on_shelf: { count: 4, of: 5 }, not_monitored_missing: [{ episode_id: 14476, code: "S02E05", title: "Late Night Burger" }] })
    expect(out.next_step).toContain("Goal met. Stop here")
    expect(calls.some((c) => c.url.includes("/release") || c.url.includes("/queue"))).toBe(false)
  })

  it("keeps a stalled download that has no alternative and backs the report with indexer evidence", async () => {
    queue = [packRow(1, 14460), packRow(2, 14461)]
    history = [14472, 14473, 14474, 14475, 14476].map((episodeId) => ({ episodeId, downloadId: "743E301E", date: "2026-10-03T02:10:43Z", sourceTitle: "The Chef Show [Season 2] (2020) [WEB DL 1080p]" }))
    releases["seasonNumber=2"] = releases["seasonNumber=2"].map((r) => (r.guid === "g-2020" ? { ...r, seeders: 0 } : r))
    episodes = episodes.map((e) => (e.seasonNumber === 2 ? { ...e, sceneSeasonNumber: 4, sceneEpisodeNumber: e.episodeNumber } : e))
    const out = await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now })
    expect(posts()).toEqual([])
    expect(out.in_flight).toEqual([{ title: "The Chef Show [Season 2] (2020) [WEB-DL 1080p]", download_id: "743E301E", episodes: ["S02E01", "S02E02", "S02E03", "S02E04", "S02E05"], percent: 75.9, queue_id: 1,
      added: "2026-10-03T02:10:43Z", state: "stalled", stall: "no_peers", stall_confirmed: false, note: "No other usable release was found, so this download was kept in case peers return." }])
    expect(out.not_found).toEqual([])
    expect(out.rejected_releases.find((r: any) => r.title === "The Chef Show [Season 2] (2020) [WEB DL 1080p]").reason).toBe("same_release_as_stalled_download")
    expect(out.indexer_evidence.map((x: any) => x.query)).toEqual(["The Chef Show 2020", "The Chef Show S04"])
    expect(out.indexer_evidence[0]).toEqual({ query: "The Chef Show 2020", results: 2, top: [{ title: "The Chef Show S02 1080p WEB X264 STARZ", seeders: 3, indexer: "Lime" }, { title: "The Chef Show [Season 2] (2020) [WEB DL 1080p]", seeders: 0, indexer: "LimeTorrents" }] })
    expect(out.summary).toContain("stalled with no peers and no other usable release (The Chef Show [Season 2] (2020) [WEB-DL 1080p] at 75.9%)")
    expect(out.next_step).toContain("do not grab, import or blocklist anything by hand")
    // Seen again 31 minutes later at the same size: the stall is confirmed, and still nothing is touched.
    const later = await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now + 31 * 60_000 })
    expect(later.in_flight[0].stall_confirmed).toBeUndefined()
    expect(posts()).toEqual([])
  })

  it("replaces a stalled download with a seeded release that holds all its episodes", async () => {
    queue = [packRow(1, 14460)]
    history = [14472, 14473, 14474, 14475, 14476].map((episodeId) => ({ episodeId, downloadId: "743E301E", date: "2026-10-03T02:10:43Z" }))
    releases["seasonNumber=2"].push(rel("g-alt", "The Chef Show Season 2 2020 1080p NF WEB-DL", 12, { fullSeason: true, seasonNumber: 2 }))
    const first = await mod.mediaFillMissing({ service_id: 191 }, { nowMs: now })
    // One snapshot without an ETA is not proof: the download is kept and nothing is grabbed yet.
    expect(posts()).toEqual([])
    expect(first.in_flight[0]).toMatchObject({ state: "stalled", stall_confirmed: false, note: expect.stringContaining("A seeded alternative exists") })
    const out = await mod.mediaFillMissing({ service_id: 191 }, { nowMs: now + 31 * 60_000 })
    // The replacement is grabbed first; the stalled download is removed only after that succeeded.
    expect(posts().map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["POST http://sonarr/api/v3/release", "DELETE http://sonarr/api/v3/queue/1"])
    expect(posts()[1].url).toContain("blocklist=true")
    expect(posts()[0].body.guid).toBe("g-alt")
    expect(out.actions.map((a: any) => a.action)).toEqual(["grabbed", "blocklisted_stalled"])
    expect(out.in_flight.map((x: any) => x.state)).toEqual(["just_grabbed"])
  })

  it("trusts the grab history over a queue row's re-parsed episodes and does not search while a download moves", async () => {
    queue = [packRow(1, 14460, { timeleft: "02:00:00", added: "2026-10-05T07:00:00Z" })]
    history = [14472, 14473, 14474, 14475, 14476].map((episodeId) => ({ episodeId, downloadId: "743e301e", date: "2026-10-05T07:00:00Z" }))
    const out = await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now })
    expect(out.in_flight).toEqual([expect.objectContaining({ state: "downloading", episodes: ["S02E01", "S02E02", "S02E03", "S02E04", "S02E05"] })])
    expect(out.searched).toEqual([])
    expect(out.next_step).toContain("Work is in progress")
    expect(posts()).toEqual([])
  })

  it("counts a grab made minutes ago as in flight before it reaches the queue", async () => {
    history = [{ episodeId: 14472, downloadId: "NEW", date: "2026-10-05T07:55:00Z", sourceTitle: "Chef.Milk.Bar" }, { episodeId: 14473, downloadId: "OLD", date: "2026-09-01T00:00:00Z" }, { episodeId: 14474 }]
    releases["seasonNumber=2"] = []
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now })
    expect(out.in_flight[0]).toEqual({ title: "Chef.Milk.Bar", download_id: "NEW", episodes: ["S02E01"], state: "just_grabbed" })
    expect(out.not_found.map((e: any) => e.code)).toEqual(["S02E02", "S02E03", "S02E04", "S02E05"])
    expect(out.searched).toEqual(["Sonarr season search S02", "Sonarr episode search S02E02", "Sonarr episode search S02E03", "Sonarr episode search S02E04", "Sonarr episode search S02E05"])
    expect(out.summary).toContain("No usable release found for S02E02, S02E03, S02E04, S02E05.")
  })

  it("imports a finished download by episode title when Sonarr will not", async () => {
    queue = [packRow(1, 14460, { sizeleft: 0, status: "completed", trackedDownloadState: "importBlocked" })]
    history = [14472, 14473].map((episodeId) => ({ episodeId, downloadId: "743E301E", date: "2026-10-03T02:10:43Z" }))
    manual = [
      { path: "/dl/The.Chef.Show.S02E01.Milk.Bar.Bake.Sale.mkv", name: "The.Chef.Show.S02E01.Milk.Bar.Bake.Sale", episodes: [{ id: 14460 }], quality: q, languages: langs, releaseGroup: "G" },
      { path: "/dl/The.Chef.Show.S02E02.Roys.Italian.Cuisine.mkv", name: "The.Chef.Show.S02E02.Roys.Italian.Cuisine", episodes: [{ id: 14461 }], quality: q, languages: langs },
      { path: "/dl/sample.mkv", name: "sample", episodes: [] },
    ]
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now })
    const imp = posts().find((c) => c.url === "http://sonarr/api/v3/command")!
    expect(imp.body.files.map((f: any) => [f.path, f.episodeIds])).toEqual([["/dl/The.Chef.Show.S02E01.Milk.Bar.Bake.Sale.mkv", [14472]], ["/dl/The.Chef.Show.S02E02.Roys.Italian.Cuisine.mkv", [14473]]])
    expect(out.actions[0]).toMatchObject({ action: "imported_by_title", command_id: 42, unmatched_files: ["sample"] })
    expect(out.in_flight[0].state).toBe("importing")
    // A second call while that import runs does not import again.
    commands = [{ name: "ManualImport", status: "started", body: { files: [{ downloadId: "743E301E" }] } }]
    const again = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now })
    expect(again.actions[0]).toEqual({ action: "import_already_running", download_id: "743E301E" })
  })

  it("reports a finished download it cannot map by title instead of guessing", async () => {
    queue = [packRow(1, 14460, { sizeleft: 0, trackedDownloadState: "importPending" })]
    history = [{ episodeId: 14472, downloadId: "743E301E", date: "2026-10-03T02:10:43Z" }]
    manual = [{ path: "/dl/a.mkv", name: "a", episodes: [] }]
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now })
    expect(out.actions[0]).toMatchObject({ action: "import_needs_mapping", download_id: "743E301E", unmatched_files: ["a"] })
    expect(out.in_flight[0].state).toBe("downloaded_needs_mapping")
  })

  it("grabs an unseeded release only when nothing better exists, and flags it", async () => {
    releases["seasonNumber=2"] = [rel("g-tartine", "The Chef Show Tartine 1080p", 0)]
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now, deadlineMs: 60_000 })
    expect(out.actions).toEqual([expect.objectContaining({ action: "grabbed", matched_by: "episode_title", episodes: ["S02E04"], may_never_finish: true })])
  })

  it("names the candidates when the series is ambiguous or unknown", async () => {
    expect(await mod.mediaFillMissing({ series: "zzz unknown" }, { nowMs: now })).toMatchObject({ result: "not_found" })
  })

  it("matches releases by title, year and season, never by a code alone", () => {
    const wanted = episodes.filter((e) => e.seasonNumber === 2)
    const have = episodes.filter((e) => e.hasFile)
    const m = (title: string, over: Record<string, unknown> = {}) => mod.matchReleaseToEpisodes({ title, ...over }, { seriesTitle: "The Chef Show", wanted, have })
    expect(m("The Chef Show S02E04 Tartine 1080p")).toEqual({ episode_ids: [14475], basis: "episode_title" })
    expect(m("The Chef Show Hog Island 1080p")).toEqual({ reject: "holds_episodes_we_have" })
    expect(m("The Chef Show S02E01 1080p", { seasonNumber: 2, episodeNumbers: [1], mappedEpisodeInfo: [{ id: 14472 }] })).toEqual({ episode_ids: [14472], basis: "sonarr_parse" })
    // Sonarr mapped it to a wanted episode, but the name's numbering is neither its TVDB nor its scene code.
    expect(m("The Chef Show S03E07 1080p", { seasonNumber: 3, episodeNumbers: [7], mappedEpisodeInfo: [{ id: 14472 }] })).toEqual({ reject: "parse_disagrees_with_numbering" })
    const scened = wanted.map((e) => ({ ...e, sceneSeasonNumber: 4, sceneEpisodeNumber: e.episodeNumber }))
    expect(mod.matchReleaseToEpisodes({ title: "The Chef Show S04 1080p", fullSeason: true, seasonNumber: 4, mappedEpisodeInfo: scened.map((e) => ({ id: e.id })) }, { seriesTitle: "The Chef Show", wanted: scened, have })).toMatchObject({ basis: "sonarr_parse" })
    // An episode titled like the series does not match every release of the series.
    expect(mod.matchReleaseToEpisodes({ title: "Fargo S01E02 1080p" }, { seriesTitle: "Fargo", wanted: [{ id: 1, title: "Fargo", seasonNumber: 1 }], have: [] })).toEqual({ reject: "no_episode_match" })
    // A year suffix in the series name, the series' own year, and resolutions are not air years.
    const who = [{ id: 7, title: "The Eleventh Hour", seasonNumber: 5, airDate: "2010-04-03" }]
    expect(mod.matchReleaseToEpisodes({ title: "Doctor Who 2005 S05E01 The Eleventh Hour 1920x1080" }, { seriesTitle: "Doctor Who (2005)", seriesYear: 2005, wanted: who, have: [] })).toEqual({ episode_ids: [7], basis: "episode_title" })
    expect(mod.matchReleaseToEpisodes({ title: "Doctor Who S05E01 The Eleventh Hour 2160p" }, { seriesTitle: "Doctor Who (2005)", seriesYear: 2005, wanted: who, have: [] })).toMatchObject({ basis: "episode_title" })
    expect(mod.matchReleaseToEpisodes({ title: "Doctor Who S05E01", mappedSeriesId: 9 }, { seriesId: 191, seriesTitle: "Doctor Who", wanted: who, have: [] })).toEqual({ reject: "other_series" })
    expect(m("The Chef Show S02E01 2020 1080p", { mappedEpisodeInfo: [{ id: 14460 }] })).toEqual({ reject: "holds_episodes_we_have" })
    expect(m("The Chef Show Season 2 2019")).toMatchObject({ reject: "year_mismatch", years: [2019] })
    expect(m("The Chef Show 1080p")).toEqual({ reject: "no_episode_match" })
    expect(mod.matchReleaseToEpisodes({ title: "Show Special 1080p" }, { seriesTitle: "Show", wanted: [{ id: 1, title: "Special", seasonNumber: 0 }], have: [] })).toEqual({ reject: "no_episode_match" })
    expect(m("The Chef Show 2020 1080p", { fullSeason: true, seasonNumber: 2 })).toMatchObject({ basis: "season_and_air_year" })
    expect(mod.seasonInTitle("Show [Season 2] (2020)")).toBe(2)
    expect(mod.seasonInTitle("Show S03 1080p")).toBe(3)
    expect(mod.seasonInTitle("Show S03E01 1080p")).toBeNull()
    expect(mod.seasonInTitle("Show Temporada 1")).toBe(1)
  })

  it("calls a torrent stalled only with evidence", () => {
    const row = (over: Record<string, unknown>) => ({ status: "downloading", size: 100, sizeleft: 40, timeleft: "00:00:00", added: "2026-10-05T00:00:00Z", ...over })
    expect(mod.stallReason(row({}), now)).toEqual({ stall: "no_peers", confirmed: false })
    expect(mod.stallReason(row({}), now, { sizeleft: 40, at: now - 31 * 60_000 })).toEqual({ stall: "no_peers", confirmed: true })
    expect(mod.stallReason(row({}), now, { sizeleft: 40, at: now - 5 * 60_000 })).toEqual({ stall: "no_peers", confirmed: false })
    expect(mod.stallReason(row({}), now, { sizeleft: 50, at: now - 31 * 60_000 })).toEqual({ stall: "no_peers", confirmed: false })
    expect(mod.stallReason(row({ timeleft: "01:00:00" }), now)).toBeNull()
    expect(mod.stallReason(row({ added: "2026-10-05T06:00:00Z" }), now)).toBeNull()
    expect(mod.stallReason(row({ status: "paused" }), now)).toBeNull()
    expect(mod.stallReason(row({ sizeleft: 100, timeleft: "01:00:00" }), now)).toEqual({ stall: "never_started", confirmed: true })
    expect(mod.stallReason(row({ added: "2026-09-30T00:00:00Z", timeleft: "01:00:00" }), now)).toEqual({ stall: "unfinished_for_days", confirmed: true })
  })

  it("keeps the stalled download when the replacement grab fails, and still returns what it did", async () => {
    queue = [packRow(1, 14460)]
    history = [14472, 14473, 14474, 14475, 14476].map((episodeId) => ({ episodeId, downloadId: "743E301E", date: "2026-10-03T02:10:43Z" }))
    releases["seasonNumber=2"].push(rel("g-alt", "The Chef Show Season 2 2020 1080p NF WEB-DL", 12, { fullSeason: true, seasonNumber: 2 }))
    await mod.mediaFillMissing({ service_id: 191 }, { nowMs: now })
    fail = (method, url) => method === "POST" && url.includes("/release")
    const out = await mod.mediaFillMissing({ service_id: 191 }, { nowMs: now + 31 * 60_000 })
    expect(posts().filter((c) => c.method === "DELETE")).toEqual([])
    expect(out.errors).toEqual([expect.objectContaining({ step: "grab The Chef Show Season 2 2020 1080p NF WEB-DL", error: "sonarr_http_500" })])
    expect(out.in_flight[0]).toMatchObject({ state: "stalled" })
    expect(out.incomplete).toBe(true)
    expect(out.next_step).toContain("call media_fill_missing again")
  })

  it("never replaces a stalled download with an unseeded release, even one that also covers other episodes", async () => {
    queue = [packRow(1, 14460)]
    history = [14472, 14473, 14474].map((episodeId) => ({ episodeId, downloadId: "743E301E", date: "2026-10-03T02:10:43Z" }))
    releases["seasonNumber=2"] = [rel("g-dead", "The Chef Show Season 2 2020 1080p", 0, { fullSeason: true, seasonNumber: 2 })]
    await mod.mediaFillMissing({ service_id: 191 }, { nowMs: now })
    const out = await mod.mediaFillMissing({ service_id: 191 }, { nowMs: now + 31 * 60_000 })
    expect(posts().filter((c) => c.method === "DELETE")).toEqual([])
    const grab = posts().find((c) => c.url.endsWith("/release"))!
    expect(grab.body.episodeIds).toEqual([14475, 14476])
    expect(out.actions[0]).toMatchObject({ action: "grabbed", may_never_finish: true, episodes: ["S02E04", "S02E05"] })
  })

  it("survives a failed search and evidence lookup, reporting the step", async () => {
    fail = (method, url) => url.includes("/release?seriesId") || url.startsWith("http://prowlarr")
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now })
    expect(out.errors.map((e: any) => e.step)).toEqual(["season search S02", 'indexer evidence "The Chef Show 2020"'])
    expect(out.not_found).toHaveLength(5)
    expect(out.incomplete).toBe(true)
  })

  it("refuses a second pass for the same series while one is running", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const realFetch = globalThis.fetch
    vi.stubGlobal("fetch", async (url: string, init: any) => { if (String(url).includes("/release")) await gate; return realFetch(url, init) })
    const first = mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now })
    await new Promise((r) => setTimeout(r, 20))
    expect(await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now })).toMatchObject({ result: "already_running", series_id: 191 })
    release()
    await first
    expect((await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now })).result).toBeUndefined()
  })

  it("defers episodes past the grab cap instead of calling them not found", async () => {
    releases["seasonNumber=2"] = s2Titles.map((t, i) => rel(`g-${i}`, `The Chef Show ${t} 1080p`, 5 + i))
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now })
    expect(out.actions.filter((x: any) => x.action === "grabbed")).toHaveLength(3)
    expect(out.deferred.map((e: any) => e.code)).toHaveLength(2)
    expect(out.not_found).toEqual([])
    expect(out.incomplete).toBe(true)
  })

  it("lists episodes beyond the per-call search cap as unsearched", async () => {
    episodes = Array.from({ length: 8 }, (_, i) => ({ id: 500 + i, seasonNumber: 3, episodeNumber: i + 1, title: `Episode Title Number ${i + 1}`, airDate: "2021-01-01", hasFile: false, monitored: true }))
    fail = (_method, url) => url.includes("/release?seriesId")
    const out = await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now, deadlineMs: 60_000 })
    expect(out.searched.filter((x: string) => x.startsWith("Sonarr episode search"))).toHaveLength(6)
    // The season search failed, so S03 counts as searched; all eight are open and none is deferred.
    expect(out.not_found).toHaveLength(8)
  })

  it("searches the least recently searched seasons first, so a deadline cannot starve later seasons", async () => {
    episodes = [3, 4, 5].flatMap((season) => [1, 2].map((n) => ({ id: season * 100 + n, seasonNumber: season, episodeNumber: n, title: `Title ${season} ${n} Long`, airDate: "2021-01-01", hasFile: false, monitored: true })))
    const seasonSearches = () => calls.filter((c) => c.url.includes("/release?seriesId")).map((c) => /seasonNumber=(\d+)/.exec(c.url)![1])
    // A deadline already spent allows no search; the next calls each get exactly one season search.
    let t = 0
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000))
    await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now, deadlineMs: 3_500 })
    await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now, deadlineMs: 3_500 })
    await mod.mediaFillMissing({ series: "The Chef Show" }, { nowMs: now, deadlineMs: 3_500 })
    vi.restoreAllMocks()
    expect(seasonSearches()).toEqual(["3", "4", "5"])
  })

  it("defers grabs and imports once the action grace past the deadline is spent", async () => {
    queue = [packRow(1, 14460, { sizeleft: 0, trackedDownloadState: "importPending" })]
    history = [{ episodeId: 14472, downloadId: "743E301E", date: "2026-10-03T02:10:43Z" }]
    releases["seasonNumber=2"] = [rel("g-t", "The Chef Show Tartine 1080p", 9)]
    const out = await mod.mediaFillMissing({ series: "The Chef Show", season_number: 2 }, { nowMs: now, deadlineMs: -60_000 })
    expect(posts()).toEqual([])
    expect(out.in_flight[0].state).toBe("downloaded_import_next_call")
    expect(out.incomplete).toBe(true)
    expect(out.searched).toEqual([])
  })

  it("keeps the series year as evidence when the missing episodes aired that year", () => {
    const wanted = [{ id: 1, title: "Pilot Episode Here", seasonNumber: 1, episodeNumber: 1, airDate: "2020-03-01" }]
    expect(mod.matchReleaseToEpisodes({ title: "Show (2020) Season 1 1080p" }, { seriesTitle: "Show", seriesYear: 2020, wanted, have: [] })).toEqual({ episode_ids: [1], basis: "season_and_air_year" })
  })

  it("closes every schema and refuses invented parameters by name", () => {
    for (const t of mod.TOOLS) expect(t.inputSchema.additionalProperties).toBe(false)
    expect(mod.unknownArguments("media_fill_missing", { series: "x", dry_run: true })).toMatchObject({ error: "unknown_parameter", unknown: ["dry_run"], allowed: ["series", "service_id", "season_number", "retry_blocklisted"] })
    expect(mod.unknownArguments("media_fill_missing", { series: "x" })).toBeNull()
    expect(mod.unknownArguments("media_chain_health", { x: 1 }).message).toContain("no parameters")
    expect(mod.TOOLS.find((t: any) => t.name === "media_fill_missing")._meta).toEqual({ "ouro.bot/timeoutMs": 240_000 })
    expect(mod.TOOLS.find((t: any) => t.name === "media_fill_missing").annotations).toBeUndefined()
  })
})
