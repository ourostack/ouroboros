import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

let calls: Array<{ method: string; url: string; body?: any }>
let routes: (method: string, url: string, body: any) => unknown

async function load(cred: Record<string, unknown>): Promise<any> {
  calls = []
  const dir = mkdtempSync(join(tmpdir(), "media-cred-"))
  const credPath = join(dir, "c.json")
  writeFileSync(credPath, JSON.stringify({ jellyseerr: { url: "http://seerr", apiKey: "k" }, sonarr: { url: "http://sonarr", apiKey: "k" }, radarr: { url: "http://radarr", apiKey: "k" }, prowlarr: { url: "http://prowlarr", apiKey: "k" }, ...cred }))
  process.env.SANCTUARY_MEDIA_CREDENTIALS = credPath
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
    const answer = routes(method, url, body)
    if (answer === undefined) throw new Error(`unexpected ${method} ${url}`)
    return json(answer)
  })
  vi.resetModules()
  return await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
}

afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS })
const writes = () => calls.filter((c) => c.method !== "GET")

describe("media MCP: season and episode monitoring", () => {
  let mod: any
  let series: any
  const episodes = [
    { id: 51, seasonNumber: 5, episodeNumber: 1, monitored: false },
    { id: 52, seasonNumber: 5, episodeNumber: 2, monitored: false },
    { id: 61, seasonNumber: 6, episodeNumber: 1, monitored: false },
  ]

  beforeEach(async () => {
    series = { id: 198, title: "A Show", monitored: true, seasons: [{ seasonNumber: 4, monitored: true }, { seasonNumber: 5, monitored: false }, { seasonNumber: 6, monitored: false }] }
    routes = (method, url, body) => {
      if (url === "http://sonarr/api/v3/series/198" && method === "GET") return series
      if (url === "http://sonarr/api/v3/series/198" && method === "PUT") { series = body; return body }
      if (url.startsWith("http://sonarr/api/v3/episode?") && method === "GET") return episodes
      if (url === "http://sonarr/api/v3/episode/monitor" && method === "PUT") return []
      if (url === "http://sonarr/api/v3/command" && method === "POST") return { id: 7, ...body }
      return undefined
    }
    mod = await load({})
  })

  it("monitors whole seasons: the series' season flags and every episode in them, then searches them", async () => {
    const result = await mod.mediaMonitor({ service_id: 198, season_numbers: [5, 6], monitored: true, search: true })
    expect(result).toEqual({ result: "monitoring_changed", series_id: 198, monitored: true, seasons: [5, 6], episode_ids: [51, 52, 61], searched: ["season 5", "season 6"] })
    expect(writes()).toEqual([
      { method: "PUT", url: "http://sonarr/api/v3/series/198", body: { ...series, seasons: [{ seasonNumber: 4, monitored: true }, { seasonNumber: 5, monitored: true }, { seasonNumber: 6, monitored: true }] } },
      { method: "PUT", url: "http://sonarr/api/v3/episode/monitor", body: { episodeIds: [51, 52, 61], monitored: true } },
      { method: "POST", url: "http://sonarr/api/v3/command", body: { name: "SeasonSearch", seriesId: 198, seasonNumber: 5 } },
      { method: "POST", url: "http://sonarr/api/v3/command", body: { name: "SeasonSearch", seriesId: 198, seasonNumber: 6 } },
    ])
  })

  it("monitors single episodes and searches just those", async () => {
    const result = await mod.mediaMonitor({ service_id: 198, episode_ids: [52], monitored: true, search: true })
    expect(result).toMatchObject({ seasons: [], episode_ids: [52], searched: ["episodes 52"] })
    expect(writes()).toEqual([
      { method: "PUT", url: "http://sonarr/api/v3/episode/monitor", body: { episodeIds: [52], monitored: true } },
      { method: "POST", url: "http://sonarr/api/v3/command", body: { name: "EpisodeSearch", episodeIds: [52] } },
    ])
  })

  it("unmonitors without searching, and reports a season the series does not have", async () => {
    expect(await mod.mediaMonitor({ service_id: 198, season_numbers: [5], monitored: false, search: true })).toMatchObject({ monitored: false, searched: [] })
    expect(writes().some((c) => c.url.endsWith("/command"))).toBe(false)
    expect(await mod.mediaMonitor({ service_id: 198, season_numbers: [9], monitored: true })).toEqual({ result: "unknown_season", series_id: 198, seasons: [9], has: [4, 5, 6] })
  })

  it("asks for what to change", async () => {
    expect(await mod.mediaMonitor({ season_numbers: [5], monitored: true })).toEqual({ result: "service_id_required" })
    expect(await mod.mediaMonitor({ service_id: 198, monitored: true })).toEqual({ result: "seasons_or_episodes_required" })
    expect(await mod.mediaMonitor({ service_id: 198, season_numbers: [5] })).toEqual({ result: "monitored_required" })
  })

  it("is registered as a write tool", () => {
    const tool = mod.TOOLS.find((t: any) => t.name === "media_monitor")
    expect(tool.annotations).toEqual({ readOnlyHint: false })
    expect(tool.inputSchema.required).toEqual(["service_id", "monitored"])
  })
})

describe("media MCP: Jellyfin watch history", () => {
  let mod: any
  const played = [
    { Type: "Episode", Name: "Pilot", SeriesName: "A Show", ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true, PlayCount: 2, LastPlayedDate: "2026-11-01T20:00:00Z" } },
    { Type: "Movie", Name: "A Film", UserData: { Played: true, PlayCount: 1, LastPlayedDate: "2026-10-30T20:00:00Z" } },
  ]
  const resumable = [
    { Type: "Episode", Name: "Second", SeriesName: "A Show", ParentIndexNumber: 1, IndexNumber: 2, UserData: { Played: false, PlayedPercentage: 41.6, PlayCount: 0, LastPlayedDate: "2026-11-02T20:00:00Z" } },
  ]

  beforeEach(async () => {
    routes = (method, url) => {
      if (method !== "GET") return undefined
      if (url === "http://jellyfin/Users") return [{ Id: "u1", Name: "Ari" }, { Id: "u2", Name: "Rachel" }]
      if (url.startsWith("http://jellyfin/Users/u1/Items?")) return { Items: url.includes("IsResumable") ? resumable : played }
      if (url.startsWith("http://jellyfin/Users/u2/Items?")) return { Items: [] }
      return undefined
    }
    mod = await load({ jellyfin: { url: "http://jellyfin", apiKey: "j" } })
  })

  it("lists a user's watched and half-watched items, newest first, with completion", async () => {
    expect(await mod.mediaWatchHistory({ user: "ari" })).toEqual({ result: "watch_history", user: "Ari", count: 3, items: [
      { kind: "episode", title: "Second", series: "A Show", code: "S01E02", played: false, percent: 42, play_count: 0, last_played: "2026-11-02T20:00:00Z" },
      { kind: "episode", title: "Pilot", series: "A Show", code: "S01E01", played: true, percent: 100, play_count: 2, last_played: "2026-11-01T20:00:00Z" },
      { kind: "movie", title: "A Film", series: null, code: null, played: true, percent: 100, play_count: 1, last_played: "2026-10-30T20:00:00Z" },
    ] })
    const query = calls.find((c) => c.url.includes("IsPlayed"))!.url
    expect(query).toContain("Recursive=true")
    expect(query).toContain("Fields=UserData")
  })

  it("filters by state and title", async () => {
    expect((await mod.mediaWatchHistory({ user: "u1", state: "in_progress" })).items.map((i: any) => i.title)).toEqual(["Second"])
    expect((await mod.mediaWatchHistory({ user: "Ari", state: "played", title: "a film" })).items.map((i: any) => i.title)).toEqual(["A Film"])
    expect((await mod.mediaWatchHistory({ user: "Ari", title: "show", limit: 1 })).items.map((i: any) => i.title)).toEqual(["Second"])
  })

  it("names the users when it cannot tell whose history to read", async () => {
    expect(await mod.mediaWatchHistory({})).toEqual({ result: "user_required", users: ["Ari", "Rachel"] })
    expect(await mod.mediaWatchHistory({ user: "nobody" })).toEqual({ result: "unknown_user", users: ["Ari", "Rachel"] })
    expect(await mod.mediaWatchHistory({ user: "Rachel", state: "everything" })).toEqual({ result: "bad_state", states: ["all", "played", "in_progress"] })
  })

  it("says so when Jellyfin is not configured, and is registered read-only", async () => {
    mod = await load({})
    expect(await mod.mediaWatchHistory({ user: "Ari" })).toEqual({ result: "jellyfin_not_configured" })
    expect(mod.TOOLS.find((t: any) => t.name === "media_watch_history").annotations).toEqual({ readOnlyHint: true })
  })
})
