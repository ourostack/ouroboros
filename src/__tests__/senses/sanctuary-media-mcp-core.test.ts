import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS })

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
  const pack = { guid: "g-s3", indexerId: 5, indexer: "Idx", title: "The Chef Show Season 3 [1080p x265 10bit S85 Joy]", size: 9e9, seeders: 40, age: 100, quality: { quality: { name: "WEBDL-1080p" } },
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
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS })

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
    expect(post.body).toEqual({ guid: "g-s3", indexerId: 5, seriesId: 191, episodeIds: [14472, 14473, 14474, 14475, 14476], shouldOverride: true, downloadClientId: 2 })
    expect(out).toMatchObject({ result: "grabbed", response: { approved: true, download_id: "DL1" } })
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
