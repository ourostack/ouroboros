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

  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" })

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
      if (url.includes("/series/lookup")) return json(lookups.series)
      if (url.includes("/movie/lookup")) return json(lookups.movie)
      if (url.startsWith("http://jellyfin/Items")) return json({ Items: jellyfinItems })
      if (url.includes("/api/v3/series")) return json(series)
      if (url.includes("/api/v3/movie")) return json(movies)
      if (url.includes("/api/v3/queue/") && method === "DELETE") return { ok: true, status: 204, json: async () => null, text: async () => "" }
      if (url.includes("/api/v3/queue")) return json({ records: isSonarr ? queues.sonarr : queues.radarr })
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
