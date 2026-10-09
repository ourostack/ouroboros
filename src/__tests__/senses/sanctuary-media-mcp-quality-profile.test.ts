import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const OWNER = "make the Mandalorian movie upgradeable"
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })

const profileOf = (over: Record<string, unknown> = {}) => ({
  id: 4, name: "HD-1080p", upgradeAllowed: false, cutoff: 7,
  items: [
    { quality: { id: 4, name: "HDTV-720p" }, items: [], allowed: true },
    { quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true },
    { id: 1001, name: "WEB 1080p", items: [{ quality: { id: 3, name: "WEBDL-1080p" }, items: [], allowed: true }], allowed: true },
    { quality: { id: 19, name: "Bluray-2160p" }, items: [], allowed: false },
  ],
  ...over,
})

describe("media MCP: quality profiles", () => {
  let mod: any
  let auditPath: string
  let calls: Array<{ method: string; url: string; body?: any }>
  let store: { radarr: any[]; sonarr: any[]; movie: any; series: any }

  beforeEach(async () => {
    calls = []
    store = { radarr: [profileOf(), profileOf({ id: 5, name: "Any", cutoff: 4, upgradeAllowed: true })], sonarr: [profileOf({ id: 1, name: "HD-1080p" })], movie: { id: 777, title: "The Mandalorian and Grogu", qualityProfileId: 4 }, series: { id: 191, title: "The Chef Show", qualityProfileId: 1 } }
    const dir = mkdtempSync(join(tmpdir(), "media-cred-"))
    const credPath = join(dir, "c.json")
    writeFileSync(credPath, JSON.stringify({ jellyseerr: { url: "http://seerr", apiKey: "k" }, sonarr: { url: "http://sonarr", apiKey: "k" }, radarr: { url: "http://radarr", apiKey: "k" }, prowlarr: { url: "http://prowlarr", apiKey: "k" } }))
    process.env.SANCTUARY_MEDIA_CREDENTIALS = credPath
    auditPath = join(dir, "audit.ndjson")
    process.env.SANCTUARY_MEDIA_AUDIT = auditPath
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const method = init.method ?? "GET"
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const arr = url.startsWith("http://radarr") ? "radarr" : "sonarr"
      const profiles = store[arr as "radarr" | "sonarr"]
      const profileMatch = /\/api\/v3\/qualityprofile\/(\d+)$/.exec(url)
      if (profileMatch) {
        const index = profiles.findIndex((p) => p.id === Number(profileMatch[1]))
        if (index < 0) return { ok: false, status: 404, json: async () => ({}), text: async () => "NotFound" }
        if (method === "PUT") { profiles[index] = body; return json(body) }
        return json(profiles[index])
      }
      if (url.endsWith("/api/v3/qualityprofile")) return json(profiles)
      if (/\/api\/v3\/(movie|series)$/.test(url)) return json(url.includes("/movie") ? [store.movie, { id: 2, qualityProfileId: 4 }, { id: 3, qualityProfileId: 5 }] : [store.series])
      const itemMatch = /\/api\/v3\/(movie|series)\/(\d+)$/.exec(url)
      if (itemMatch) {
        const item = itemMatch[1] === "movie" ? store.movie : store.series
        if (Number(itemMatch[2]) !== item.id) return { ok: false, status: 404, json: async () => ({}), text: async () => "NotFound" }
        if (method === "PUT") { Object.assign(item, body); return json(item) }
        return json(item)
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
  })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS; delete process.env.SANCTUARY_MEDIA_AUDIT })
  const writes = () => calls.filter((c) => c.method !== "GET")

  it("reads every profile with its cutoff name, upgrade flag and ordered qualities", async () => {
    const out = await mod.mediaQualityProfile({ kind: "movie" })
    expect(calls).toEqual([{ method: "GET", url: "http://radarr/api/v3/qualityprofile", body: undefined }])
    expect(out.result).toBe("profiles")
    expect(out.profiles[0]).toMatchObject({ id: 4, name: "HD-1080p", upgrade_allowed: false, cutoff: 7, cutoff_name: "Bluray-1080p" })
    expect(out.profiles[0].qualities).toEqual([
      { id: 4, name: "HDTV-720p", allowed: true }, { id: 7, name: "Bluray-1080p", allowed: true },
      { id: 1001, name: "WEB 1080p", allowed: true, group: true }, { id: 19, name: "Bluray-2160p", allowed: false },
    ])
  })

  it("reads one profile, shows a cutoff that matches nothing as null, and reads the Sonarr side for series", async () => {
    store.radarr[0] = profileOf({ cutoff: 999 })
    expect((await mod.mediaQualityProfile({ kind: "movie", profile_id: 4 })).profiles[0].cutoff_name).toBeNull()
    expect(calls.at(-1)!.url).toBe("http://radarr/api/v3/qualityprofile/4")
    const series = await mod.mediaQualityProfile({ kind: "series" })
    expect(calls.at(-1)!.url).toBe("http://sonarr/api/v3/qualityprofile")
    expect(series.profiles[0].id).toBe(1)
    expect((await mod.mediaQualityProfile({ kind: "movie", profile_id: 404 })).result).toBe("no_such_profile")
  })

  it("says which profile a movie or series is on", async () => {
    const out = await mod.mediaQualityProfile({ kind: "movie", service_id: 777 })
    expect(out.item).toEqual({ service_id: 777, title: "The Mandalorian and Grogu", quality_profile_id: 4 })
    expect((await mod.mediaQualityProfile({ kind: "series", service_id: 191 })).item.quality_profile_id).toBe(1)
    expect((await mod.mediaQualityProfile({ kind: "movie", service_id: 5 })).result).toBe("no_such_item")
  })

  it("defaults to a dry run for set_upgrade: reports before and after and writes nothing", async () => {
    const out = await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, cutoff: 19 })
    expect(out).toMatchObject({ action: "set_upgrade", dry_run: true, result: "would_apply" })
    expect(out.before).toMatchObject({ upgrade_allowed: false, cutoff: 7 })
    expect(out.after).toMatchObject({ upgrade_allowed: true, cutoff: 19, cutoff_name: "Bluray-2160p" })
    expect(out.would_do).toContain("HD-1080p")
    expect(writes()).toEqual([])
  })

  it("applies set_upgrade only on dry_run false, with a full PUT body, and audits before, after and time", async () => {
    const out = await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, cutoff_name: "bluray-2160p", dry_run: false, owner_words: OWNER })
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "PUT", url: "http://radarr/api/v3/qualityprofile/4", body: { id: 4, name: "HD-1080p", upgradeAllowed: true, cutoff: 19 } })
    expect(writes()[0]!.body.items).toHaveLength(4)
    expect(out).toMatchObject({ result: "applied", dry_run: false, before: { upgrade_allowed: false, cutoff: 7 }, after: { upgrade_allowed: true, cutoff: 19 } })
    expect(Number.isNaN(Date.parse(out.applied_at))).toBe(false)
    expect(out.next_step).toContain("media_search_now")
  })

  it("changes one field without touching the other, and treats a repeat as unchanged", async () => {
    await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, dry_run: false, owner_words: OWNER })
    expect(store.radarr[0]).toMatchObject({ upgradeAllowed: true, cutoff: 7 })
    const again = await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, dry_run: false, owner_words: OWNER })
    expect(again.result).toBe("unchanged")
    expect(writes()).toHaveLength(1)
    await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, cutoff: 4, dry_run: false, owner_words: OWNER })
    expect(store.radarr[0]).toMatchObject({ upgradeAllowed: true, cutoff: 4 })
  })

  it("refuses a cutoff the profile does not hold, a missing profile, and a request that changes nothing", async () => {
    expect(await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, cutoff: 123, dry_run: false, owner_words: OWNER })).toMatchObject({ result: "cutoff_not_in_profile", qualities: expect.any(Array) })
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, cutoff_name: "nope", dry_run: false, owner_words: OWNER })).result).toBe("cutoff_not_in_profile")
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 404, upgrade_allowed: true })).result).toBe("no_such_profile")
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4 })).result).toBe("no_change_requested")
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", upgrade_allowed: true })).result).toBe("profile_id_required")
    expect(writes()).toEqual([])
  })

  it("assigns a movie to a profile: dry run by default, then a PUT of the whole movie", async () => {
    const dry = await mod.mediaQualityProfile({ kind: "movie", action: "assign", service_id: 777, profile_id: 5 })
    expect(dry).toMatchObject({ dry_run: true, result: "would_apply", before: { quality_profile_id: 4 }, after: { quality_profile_id: 5 } })
    expect(writes()).toEqual([])
    const done = await mod.mediaQualityProfile({ kind: "movie", action: "assign", service_id: 777, profile_id: 5, dry_run: false, owner_words: OWNER })
    expect(writes()).toEqual([{ method: "PUT", url: "http://radarr/api/v3/movie/777", body: { id: 777, title: "The Mandalorian and Grogu", qualityProfileId: 5 } }])
    expect(done).toMatchObject({ result: "applied", before: { quality_profile_id: 4 }, after: { quality_profile_id: 5 } })
    expect(done.next_step).toContain("media_search_now")
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "assign", service_id: 777, profile_id: 5, dry_run: false, owner_words: OWNER })).result).toBe("unchanged")
  })

  it("assigns a series through Sonarr and refuses unknown items and profiles", async () => {
    store.sonarr.push(profileOf({ id: 2, name: "Ultra" }))
    await mod.mediaQualityProfile({ kind: "series", action: "assign", service_id: 191, profile_id: 2, dry_run: false, owner_words: OWNER })
    expect(store.series.qualityProfileId).toBe(2)
    expect(writes()[0]!.url).toBe("http://sonarr/api/v3/series/191")
    expect((await mod.mediaQualityProfile({ kind: "series", action: "assign", service_id: 999, profile_id: 2 })).result).toBe("no_such_item")
    expect((await mod.mediaQualityProfile({ kind: "series", action: "assign", service_id: 191, profile_id: 99 })).result).toBe("no_such_profile")
    expect((await mod.mediaQualityProfile({ kind: "series", action: "assign", profile_id: 2 })).result).toBe("service_id_required")
    expect((await mod.mediaQualityProfile({ kind: "series", action: "assign", service_id: 191 })).result).toBe("profile_id_required")
  })

  it("rejects a bad kind or action and surfaces a service failure as an error", async () => {
    expect((await mod.mediaQualityProfile({ kind: "book" })).result).toBe("invalid_kind")
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "delete" })).result).toBe("invalid_action")
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }))
    await expect(mod.mediaQualityProfile({ kind: "movie" })).rejects.toMatchObject({ code: "radarr_http_500" })
  })

  it("is registered as a closed tool with a dry-run description", () => {
    const tool = mod.TOOLS.find((t: any) => t.name === "media_quality_profile")
    expect(tool.inputSchema.additionalProperties).toBe(false)
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["action", "caller", "cutoff", "cutoff_name", "dry_run", "kind", "owner_words", "profile_id", "service_id", "upgrade_allowed"])
    expect(tool.inputSchema.required).toEqual(["kind"])
    expect(tool.annotations).toBeUndefined()
    expect(tool.description).toContain("dry run")
    expect(mod.unknownArguments("media_quality_profile", { kind: "movie", click: true })).toMatchObject({ unknown: ["click"] })
  })

  it("refuses to apply without the owner's own words, for both writes, and changes nothing", async () => {
    for (const args of [{ action: "set_upgrade", profile_id: 4, upgrade_allowed: true }, { action: "assign", service_id: 777, profile_id: 5 }]) {
      expect(await mod.mediaQualityProfile({ kind: "movie", ...args, dry_run: false })).toMatchObject({ result: "owner_words_required" })
      expect(await mod.mediaQualityProfile({ kind: "movie", ...args, dry_run: false, owner_words: "   " })).toMatchObject({ result: "owner_words_required" })
    }
    expect(calls).toEqual([])
  })

  it("lets a dry run and a read go without owner words", async () => {
    expect((await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true })).result).toBe("would_apply")
    expect((await mod.mediaQualityProfile({ kind: "movie", dry_run: false })).result).toBe("profiles")
  })

  it("says how many titles share the profile a dry run would change, and points to assign for one title", async () => {
    const out = await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true })
    expect(out.titles_using_profile).toBe(2)
    expect(out.warning).toContain("2 movie title(s)")
    expect(out.warning).toContain("action assign")
    expect((await mod.mediaQualityProfile({ kind: "series", action: "set_upgrade", profile_id: 1, upgrade_allowed: true })).warning).toContain("1 series title(s)")
  })

  it("writes one audit line per applied change with before, after, the owner's words, the caller and the time", async () => {
    await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, dry_run: false, owner_words: OWNER, caller: "friend-1 (Ari)" })
    await mod.mediaQualityProfile({ kind: "movie", action: "assign", service_id: 777, profile_id: 5, dry_run: false, owner_words: OWNER })
    await mod.mediaQualityProfile({ kind: "movie", action: "assign", service_id: 777, profile_id: 5, dry_run: true })
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ tool: "media_quality_profile", action: "set_upgrade", kind: "movie", profile_id: 4, owner_words: OWNER, caller: "friend-1 (Ari)", before: { upgrade_allowed: false }, after: { upgrade_allowed: true } })
    expect(lines[0].owner_words_note).toMatch(/claimed by the caller.*not verified/)
    expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false)
    expect(lines[1]).toMatchObject({ action: "assign", service_id: 777, caller: "unknown", before: { quality_profile_id: 4 }, after: { quality_profile_id: 5 } })
  })

  it("describes the owner's words as a logged claim in the applied result", async () => {
    const out = await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, dry_run: false, owner_words: OWNER })
    expect(out.owner_words_note).toMatch(/logged as the caller's claim/)
  })

  it("reports an audit write that failed instead of hiding it", async () => {
    process.env.SANCTUARY_MEDIA_AUDIT = "/dev/null/cannot/write.ndjson"
    const out = await mod.mediaQualityProfile({ kind: "movie", action: "set_upgrade", profile_id: 4, upgrade_allowed: true, dry_run: false, owner_words: OWNER })
    expect(out.result).toBe("applied")
    expect(out.audit_error).toBeTruthy()
  })
})
