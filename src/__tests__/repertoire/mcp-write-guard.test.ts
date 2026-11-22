import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { callerRung, FAMILY_ONLY_ARGUMENTS, guardMcpArgs, OWNER_ONLY_WRITE_TOOLS, REPLAY_REFUSED_WRITE_TOOLS } from "../../repertoire/mcp-write-guard"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-"))
  fs.mkdirSync(path.join(root, "state", "replay"), { recursive: true })
  fs.writeFileSync(path.join(root, "state", "replay", "identities.json"), JSON.stringify({ friends: { "replay-1": {} } }))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const ctxFor = (friendId: string, profileId = "sanctuary-agent-peer", name = "Friend", trustLevel?: string) => ({
  signin: async () => undefined, agentRoot: root, context: { friend: { id: friendId, name, ...(trustLevel ? { trustLevel } : {}) } },
  relationshipAuthorization: { profileId, authorizedContextScopes: [], advertisedToolNames: [], authorizeTool: () => ({ allowed: false as const, reason: "x" }) },
}) as any
const write = { kind: "movie", action: "set_upgrade", dry_run: false, owner_words: "do it" }

describe("guardMcpArgs", () => {
  it("only the media quality and release profile tools are owner-only", () => {
    expect([...OWNER_ONLY_WRITE_TOOLS]).toEqual(["media_quality_profile", "media_release_profile"])
  })

  it("lets the owner apply and stamps who asked, ignoring any caller the model wrote", () => {
    const out = guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { ...write, caller: "forged" }, ctx: ctxFor("owner-1", "sanctuary-owner", "Ari") })
    expect(out).toEqual({ args: { ...write, caller: "owner-1 (Ari)" } })
  })

  it("refuses to apply for a caller who is not the owner, but lets them dry run and read", () => {
    expect(JSON.parse(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: write, ctx: ctxFor("peer-1") }).rejected!)).toMatchObject({ result: "family_only", tool: "media_quality_profile", argument: "dry_run" })
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { ...write, dry_run: "false" }, ctx: ctxFor("peer-1") })).toMatchObject({ rejected: expect.any(String) })
    // An omitted dry_run counts as applying: only dry_run true is a dry run.
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { kind: "movie", action: "set_upgrade" }, ctx: ctxFor("peer-1") })).toHaveProperty("rejected")
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { kind: "movie", action: "set_upgrade", dry_run: true }, ctx: ctxFor("peer-1") })).toMatchObject({ args: { caller: "peer-1 (Friend)" } })
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { kind: "movie", action: "read", dry_run: false }, ctx: ctxFor("peer-1") })).toHaveProperty("args")
  })

  it("stamps an unknown caller, and a caller with no name, and the actor friend id when there is no friend record", () => {
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { dry_run: true }, ctx: undefined })).toEqual({ args: { dry_run: true, caller: "unknown" } })
    const noName = { signin: async () => undefined, context: { friend: { id: "f9" } }, relationshipAuthorization: { profileId: "sanctuary-owner" } } as any
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: write, ctx: noName })).toMatchObject({ args: { caller: "f9" } })
    const actor = { signin: async () => undefined, relationshipAuthorization: { profileId: "sanctuary-owner", actor: { friendId: "a1" } } } as any
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: write, ctx: actor })).toMatchObject({ args: { caller: "a1" } })
  })

  it("forces a replay identity to a dry run on any tool that declares dry_run, even for an owner profile", () => {
    const forced = guardMcpArgs({ toolName: "media_diagnose_and_fix", declaresDryRun: true, args: { dry_run: false }, ctx: ctxFor("replay-1", "sanctuary-owner") })
    expect(forced).toEqual({ args: { dry_run: true } })
    expect(guardMcpArgs({ toolName: "media_diagnose_and_fix", declaresDryRun: true, args: {}, ctx: ctxFor("replay-1") })).toEqual({ args: { dry_run: true } })
    expect(guardMcpArgs({ toolName: "media_diagnose_and_fix", declaresDryRun: true, args: { dry_run: true }, ctx: ctxFor("replay-1") })).toEqual({ args: { dry_run: true } })
  })

  it("leaves other callers and tools without dry_run untouched", () => {
    expect(guardMcpArgs({ toolName: "media_diagnose_and_fix", declaresDryRun: true, args: { dry_run: false }, ctx: ctxFor("someone") })).toEqual({ args: { dry_run: false } })
    expect(guardMcpArgs({ toolName: "media_search", declaresDryRun: false, args: { q: "x" }, ctx: ctxFor("replay-1") })).toEqual({ args: { q: "x" } })
    expect(guardMcpArgs({ toolName: "media_diagnose_and_fix", declaresDryRun: true, args: { dry_run: false }, ctx: { signin: async () => undefined } as any })).toEqual({ args: { dry_run: false } })
  })

  it("refuses a replay identity every media write tool that has no dry run, and lets others call them", () => {
    expect([...REPLAY_REFUSED_WRITE_TOOLS].sort()).toEqual(["media_blocklist", "media_blocklist_stalled", "media_fill_missing", "media_manual_import", "media_monitor", "media_release_grab", "media_request", "media_search_now"])
    for (const toolName of ["media_request", "media_search_now", "media_blocklist", "media_blocklist_stalled", "media_fill_missing", "media_release_grab"]) {
      expect(guardMcpArgs({ toolName, declaresDryRun: false, args: {}, ctx: ctxFor("replay-1", "sanctuary-owner") }), toolName).toMatchObject({ rejected: expect.stringContaining("no dry run") })
      // The owner never sees this refusal, so it must not become a hedge in the rehearsed reply.
      expect(guardMcpArgs({ toolName, declaresDryRun: false, args: {}, ctx: ctxFor("replay-1", "sanctuary-owner") }), toolName).toMatchObject({ rejected: expect.stringMatching(/Nothing ran\..*leave this limit out of the reply/) })
      expect(guardMcpArgs({ toolName, declaresDryRun: false, args: {}, ctx: ctxFor("someone") }), toolName).toEqual({ args: {} })
    }
  })

  it("lets a replay identity preview a manual import but not apply one", () => {
    expect(guardMcpArgs({ toolName: "media_manual_import", declaresDryRun: false, args: { mode: "import" }, ctx: ctxFor("replay-1") })).toHaveProperty("rejected")
    expect(guardMcpArgs({ toolName: "media_manual_import", declaresDryRun: false, args: { mode: "preview" }, ctx: ctxFor("replay-1") })).toEqual({ args: { mode: "preview", caller_rung: "friend" } })
    expect(guardMcpArgs({ toolName: "media_manual_import", declaresDryRun: false, args: {}, ctx: ctxFor("replay-1") })).toEqual({ args: { caller_rung: "friend" } })
  })

  describe("media trust rungs (spec R12)", () => {
    const friend = ctxFor("f-1", "sanctuary-household", "Maya", "friend")
    const family = ctxFor("fam-1", "sanctuary-household", "Sam", "family")
    const refusal = (out: ReturnType<typeof guardMcpArgs>) => JSON.parse(out.rejected!)

    it.each([
      ["media_quality_profile", { kind: "movie", action: "set_upgrade", dry_run: false }, "dry_run"],
      ["media_quality_profile", { kind: "movie", action: "set_upgrade" }, "dry_run"],
      ["media_release_profile", { kind: "series", action: "set", dry_run: "false" }, "dry_run"],
      ["media_blocklist", { kind: "series", service_id: 3, remove_ids: [7] }, "remove_ids"],
      ["media_blocklist_stalled", { kind: "series", owner_words: "yes remove it" }, "owner_words"],
      ["media_fill_missing", { series: "Bluey", retry_blocklisted: ["S01E02"] }, "retry_blocklisted"],
    ])("refuses a friend %s with %j, naming the argument", (toolName, args, argument) => {
      const out = guardMcpArgs({ toolName, declaresDryRun: true, args, ctx: friend })
      expect(refusal(out)).toEqual({ result: "family_only", tool: toolName, argument, summary: expect.stringContaining(`${argument} on ${toolName} is for family`) })
      expect(guardMcpArgs({ toolName, declaresDryRun: true, args, ctx: family })).toHaveProperty("args")
    })

    it.each([
      ["media_quality_profile", { kind: "movie", action: "set_upgrade", dry_run: true }],
      ["media_quality_profile", { kind: "movie", action: "read" }],
      ["media_blocklist", { kind: "series", service_id: 3, remove_ids: [] }],
      ["media_blocklist_stalled", { kind: "series" }],
      ["media_blocklist_stalled", { kind: "series", owner_words: "  " }],
      ["media_fill_missing", { series: "Bluey" }],
      ["media_search", { q: "Bluey" }],
      ["media_search_now", { kind: "series", service_id: 3 }],
    ])("lets a friend find and fix: %s with %j", (toolName, args) => {
      expect(guardMcpArgs({ toolName, declaresDryRun: true, args, ctx: friend })).toHaveProperty("args")
    })

    it("stamps media_manual_import with the rung, overwriting one the model wrote", () => {
      expect(guardMcpArgs({ toolName: "media_manual_import", declaresDryRun: false, args: { mode: "import", caller_rung: "family" }, ctx: friend })).toEqual({ args: { mode: "import", caller_rung: "friend" } })
      expect(guardMcpArgs({ toolName: "media_manual_import", declaresDryRun: false, args: { mode: "preview" }, ctx: family })).toEqual({ args: { mode: "preview", caller_rung: "family" } })
    })

    it("reads the rung from trust: family record, owner profile or the agent's own turn is family; anything else is a friend", () => {
      expect(callerRung(family)).toBe("family")
      expect(callerRung(ctxFor("owner-1", "sanctuary-owner", "Ari"))).toBe("family")
      expect(callerRung({ signin: async () => undefined } as any)).toBe("family")
      expect(callerRung({ signin: async () => undefined, relationshipAuthorization: { profileId: "sanctuary-agent-peer", actor: { friendId: "a1", trustLevel: "family" } } } as any)).toBe("family")
      expect(callerRung({ signin: async () => undefined, relationshipAuthorization: { profileId: "sanctuary-agent-peer", actor: { friendId: "a1", trustLevel: "acquaintance" } } } as any)).toBe("friend")
      expect(callerRung(friend)).toBe("friend")
      expect(callerRung(ctxFor("x"))).toBe("friend")
      expect(callerRung(undefined)).toBe("friend")
      expect(Object.keys(FAMILY_ONLY_ARGUMENTS).sort()).toEqual(["media_blocklist", "media_blocklist_stalled", "media_fill_missing", "media_quality_profile", "media_release_profile"])
    })
  })
})
