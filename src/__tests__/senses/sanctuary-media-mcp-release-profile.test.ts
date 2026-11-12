import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const OWNER = "i thought we blocked clearly malware downloads?"
const RULE = "/\\.(exe|scr|bat|msi)$/i"
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

describe("media MCP: release profiles", () => {
  let mod: any
  let auditPath: string
  let calls: Array<{ method: string; url: string; body?: any }>
  let store: { radarr: any[]; sonarr: any[] }

  beforeEach(async () => {
    calls = []
    store = { radarr: [], sonarr: [{ id: 2, name: "Block Malware Extensions", enabled: true, ignored: [".exe"], required: [], indexerId: 0, tags: [] }] }
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
      const profiles = store[url.startsWith("http://radarr") ? "radarr" : "sonarr"]
      if (url.endsWith("/api/v3/releaseprofile") && method === "GET") return json(profiles)
      if (url.endsWith("/api/v3/releaseprofile") && method === "POST") { const made = { ...body, id: 9 }; profiles.push(made); return json(made) }
      const one = /\/api\/v3\/releaseprofile\/(\d+)$/.exec(url)
      if (one && method === "PUT") { const i = profiles.findIndex((p) => p.id === Number(one[1])); profiles[i] = body; return json(body) }
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.resetModules()
    mod = await import("../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")
  })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SANCTUARY_MEDIA_CREDENTIALS; delete process.env.SANCTUARY_MEDIA_AUDIT })
  const writes = () => calls.filter((c) => c.method !== "GET")

  it("reads the release profiles of a kind", async () => {
    expect(await mod.mediaReleaseProfile({ kind: "series" })).toEqual({ kind: "series", result: "release_profiles",
      profiles: [{ id: 2, name: "Block Malware Extensions", enabled: true, ignored: [".exe"], required: [] }] })
    expect((await mod.mediaReleaseProfile({ kind: "movie", action: "read" })).profiles).toEqual([])
  })

  it("shows a new profile as a dry run, then creates it with the owner's words and an audit line", async () => {
    const dry = await mod.mediaReleaseProfile({ kind: "movie", action: "set", name: "No programs", ignored: [RULE, " "] })
    expect(dry).toMatchObject({ result: "dry_run", before: null, after: { id: null, name: "No programs", enabled: true, ignored: [RULE], required: [] } })
    expect(writes()).toEqual([])
    expect(await mod.mediaReleaseProfile({ kind: "movie", action: "set", name: "No programs", ignored: [RULE], dry_run: false })).toMatchObject({ result: "owner_words_required" })
    expect(writes()).toEqual([])
    const made = await mod.mediaReleaseProfile({ kind: "movie", action: "set", name: "No programs", ignored: RULE, dry_run: false, owner_words: OWNER, caller: "butler" })
    expect(made).toMatchObject({ result: "created", before: null, after: { id: 9, name: "No programs", ignored: [RULE] } })
    expect(writes()).toEqual([{ method: "POST", url: "http://radarr/api/v3/releaseprofile", body: { name: "No programs", indexerId: 0, tags: [], enabled: true, ignored: [RULE], required: [] } }])
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({ tool: "media_release_profile", owner_words: OWNER, caller: "butler", before: null })
  })

  it("changes an existing profile by name, keeping lists it was not given, and reports an audit it could not write", async () => {
    process.env.SANCTUARY_MEDIA_AUDIT = "/dev/null/cannot/audit.ndjson"
    const out = await mod.mediaReleaseProfile({ kind: "series", action: "set", name: "block malware extensions", ignored: [RULE], dry_run: false, owner_words: OWNER })
    expect(out).toMatchObject({ result: "updated", before: { ignored: [".exe"] }, after: { id: 2, ignored: [RULE], required: [] } })
    expect(out.audit_error).toBeTruthy()
    expect(writes()[0]).toMatchObject({ method: "PUT", url: "http://sonarr/api/v3/releaseprofile/2" })
    expect((await mod.mediaReleaseProfile({ kind: "series", action: "set", name: "Block Malware Extensions", enabled: false })).after).toMatchObject({ enabled: false, ignored: [RULE] })
  })

  it("names what is missing instead of guessing", async () => {
    expect((await mod.mediaReleaseProfile({ kind: "show" })).result).toBe("invalid_kind")
    expect((await mod.mediaReleaseProfile({ kind: "movie", action: "delete" })).result).toBe("invalid_action")
    expect((await mod.mediaReleaseProfile({ kind: "movie", action: "set" })).result).toBe("name_required")
    expect((await mod.mediaReleaseProfile({ kind: "movie", action: "set", name: "x" })).result).toBe("no_change_requested")
    expect((await mod.mediaReleaseProfile({ kind: "movie", action: "set", name: "x", ignored: 5 })).result).toBe("no_change_requested")
    expect(writes()).toEqual([])
  })

  it("is a closed tool the owner profile grants", async () => {
    const tool = mod.TOOLS.find((t: any) => t.name === "media_release_profile")
    expect(tool.inputSchema.additionalProperties).toBe(false)
    expect(tool.description).toMatch(/end-anchored/u)
    const profiles = JSON.parse(readFileSync(join(__dirname, "../../../deploy/unraid/sanctuary.ouro/tool-profiles.json"), "utf8")).profiles
    expect(profiles["sanctuary-owner"].toolNames).toContain("media_release_profile")
    expect(profiles["sanctuary-household"].toolNames).not.toContain("media_release_profile")
  })
})
