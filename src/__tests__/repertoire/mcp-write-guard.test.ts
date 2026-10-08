import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { guardMcpArgs, OWNER_ONLY_WRITE_TOOLS } from "../../repertoire/mcp-write-guard"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-"))
  fs.mkdirSync(path.join(root, "state", "replay"), { recursive: true })
  fs.writeFileSync(path.join(root, "state", "replay", "identities.json"), JSON.stringify({ friends: { "replay-1": {} } }))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const ctxFor = (friendId: string, profileId = "sanctuary-agent-peer", name = "Friend") => ({
  signin: async () => undefined, agentRoot: root, context: { friend: { id: friendId, name } },
  relationshipAuthorization: { profileId, authorizedContextScopes: [], advertisedToolNames: [], authorizeTool: () => ({ allowed: false as const, reason: "x" }) },
}) as any
const write = { kind: "movie", action: "set_upgrade", dry_run: false, owner_words: "do it" }

describe("guardMcpArgs", () => {
  it("only the media quality profile tool is owner-only", () => {
    expect([...OWNER_ONLY_WRITE_TOOLS]).toEqual(["media_quality_profile"])
  })

  it("lets the owner apply and stamps who asked, ignoring any caller the model wrote", () => {
    const out = guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { ...write, caller: "forged" }, ctx: ctxFor("owner-1", "sanctuary-owner", "Ari") })
    expect(out).toEqual({ args: { ...write, caller: "owner-1 (Ari)" } })
  })

  it("refuses to apply for a caller who is not the owner, but lets them dry run and read", () => {
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: write, ctx: ctxFor("peer-1") })).toMatchObject({ rejected: expect.stringContaining("only the owner") })
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { ...write, dry_run: "false" }, ctx: ctxFor("peer-1") })).toMatchObject({ rejected: expect.any(String) })
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { kind: "movie", action: "set_upgrade" }, ctx: ctxFor("peer-1") })).toMatchObject({ args: { caller: "peer-1 (Friend)" } })
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: { kind: "movie", action: "read", dry_run: false }, ctx: ctxFor("peer-1") })).toHaveProperty("args")
  })

  it("stamps an unknown caller, and a caller with no name, and the actor friend id when there is no friend record", () => {
    expect(guardMcpArgs({ toolName: "media_quality_profile", declaresDryRun: true, args: {}, ctx: undefined })).toEqual({ args: { caller: "unknown" } })
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
})
