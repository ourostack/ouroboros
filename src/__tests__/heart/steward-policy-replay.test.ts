import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { inspectRoutineActionGrant, readStewardPolicy, updateStewardPolicy, type StewardPolicyActor } from "../../heart/steward-policy"
import { stewardPolicyToolDefinition } from "../../repertoire/tools-steward-policy"

const roots: string[] = []
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }) })

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "steward-replay-"))
  roots.push(value)
  return value
}

const policyFile = (agentRoot: string) => path.join(agentRoot, "state", "policy", "steward.json")
const auditFile = (agentRoot: string) => path.join(agentRoot, "state", "policy", "policy-audit.ndjson")
const bytes = (agentRoot: string) => [policyFile(agentRoot), auditFile(agentRoot)].map((file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)

function markReplay(agentRoot: string, where: "identities" | "window", friendId: string, body: unknown = { name: "replay-principal" }): void {
  const dir = path.join(agentRoot, "state", "replay")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, where === "identities" ? "identities.json" : "window.json"), JSON.stringify({ friends: { [friendId]: body } }))
}

const ari: StewardPolicyActor = {
  friendId: "ari", trustLevel: "family", sessionEventId: "a2a-delegated:task-1",
  authorization: { profileId: "sanctuary-owner", profileVersion: 7, requestId: "task-1", sessionKey: "ctx-books", receiptId: "auth-1" },
}
const via = (delegateFriendId: string): StewardPolicyActor => ({ ...ari, delegatedVia: { delegateFriendId, delegateDid: "did:key:z6MkPeer", noticeId: "delegated:task-1" } })
const set = (value = "on") => ({ kind: "set_desired_state" as const, key: "container:calibre-web", value, provenance: "stated" as const, source: "Ari via peer (delegated): Books stays on" })

function toolContext(agentRoot: string, delegateFriendId: string, commandId = "task-1") {
  const delegatedCommand = { principalFriendId: "ari", principalName: "Ari", delegateFriendId, delegateName: "Claude Code", delegateDid: "did:key:z6MkPeer", commandId, noticeId: `delegated:${commandId}` }
  let receipts = 0
  const relationshipAuthorization = {
    profileId: "sanctuary-owner", requestId: commandId, authorizedContextScopes: [], advertisedToolNames: [],
    authorizeTool: () => { receipts += 1; return { allowed: true as const, receiptId: "auth", profileVersion: 7 } },
    actor: { friendId: "ari", trustLevel: "family" as const, sessionEventId: `a2a-delegated:${commandId}` },
  }
  return { context: { signin: async () => undefined, agentRoot, currentSession: { friendId: "a2a-peer", channel: "a2a", key: "ctx-books" }, relationshipAuthorization, delegatedCommand }, receipts: () => receipts }
}

describe("replay identities cannot write owner policy", () => {
  it("refuses a replay-delegated set and leaves the policy bytes unchanged", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: set("off") })
    markReplay(agentRoot, "identities", "replay-p")
    const before = bytes(agentRoot)
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: via("replay-p"), mutation: set("on") })).toThrow("replay identities cannot write owner policy")
    expect(bytes(agentRoot)).toEqual(before)
  })

  it("refuses a replay-delegated same-value set before the idempotent no-op", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: set("on") })
    markReplay(agentRoot, "identities", "replay-p")
    const before = bytes(agentRoot)
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: via("replay-p"), mutation: set("on") })).toThrow("replay identities cannot write owner policy")
    expect(bytes(agentRoot)).toEqual(before)
  })

  it("refuses a direct replay actor, and an expired window entry still counts", () => {
    const agentRoot = root()
    markReplay(agentRoot, "window", "replay-p", { expiresAt: "2020-01-01T00:00:00.000Z" })
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { ...ari, friendId: "replay-p" }, mutation: set() })).toThrow("replay identities cannot write owner policy")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: via("replay-p"), mutation: set() })).toThrow("replay identities cannot write owner policy")
    expect(fs.existsSync(policyFile(agentRoot))).toBe(false)
  })

  it("refuses a grant from a replay identity", () => {
    const agentRoot = root()
    markReplay(agentRoot, "identities", "replay-p")
    const grant = { kind: "grant_routine_action" as const, key: "unraid.restart:calibre-web", action: "unraid.container.restart", targets: ["calibre-web"], maxCount: 1, windowMs: 1000, verificationRequired: true, exclusions: [], provenance: "stated" as const }
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: via("replay-p"), mutation: grant })).toThrow("replay identities cannot write owner policy")
    expect(fs.existsSync(policyFile(agentRoot))).toBe(false)
  })

  it("still writes for a real family delegate that is not a replay identity", () => {
    const agentRoot = root()
    markReplay(agentRoot, "identities", "replay-p")
    const result = updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: via("real-peer"), mutation: set() })
    expect(result.version).toBe(1)
  })

  it("refuses through the tool before consuming an authorization receipt, and a real delegate still writes", async () => {
    const agentRoot = root()
    markReplay(agentRoot, "identities", "replay-p")
    const replay = toolContext(agentRoot, "replay-p")
    const args = { action: "set_desired_state", provenance: "stated", key: "container:calibre-web", value: "on", source: "Books stays on" }
    expect(() => stewardPolicyToolDefinition.handler(args, replay.context as any)).toThrow("replay identities cannot write owner policy")
    expect(replay.receipts()).toBe(0)
    expect(fs.existsSync(policyFile(agentRoot))).toBe(false)
    const real = toolContext(agentRoot, "real-peer")
    const written = JSON.parse(await stewardPolicyToolDefinition.handler(args, real.context as any) as string)
    expect(written.desiredStates["container:calibre-web"].source).toBe("Ari via Claude Code (delegated): Books stays on")
  })
})

describe("audited provenance correction", () => {
  function wrongSource(): string {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { ...set("on"), source: "Ari via replay-principal (delegated): wrong", expiresAt: "2099-01-01T00:00:00.000Z" } })
    return agentRoot
  }
  const correct = { kind: "correct_provenance" as const, key: "container:calibre-web", source: "Ari via Claude Code (delegated): Books stays on", correction: "source named the replay identity; Ari never said this through it" }

  it("writes a correction, bumps the version, keeps the value, records the note, and the audit chain re-verifies", () => {
    const agentRoot = wrongSource()
    const before = readStewardPolicy(agentRoot).desiredStates["container:calibre-web"]!
    const result = updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "a2a-delegated:task-2", authorization: { ...ari.authorization!, requestId: "task-2" } }, mutation: correct })
    expect(result.version).toBe(2)
    expect(result.desiredStates["container:calibre-web"]).toEqual({ ...before, version: 2, source: correct.source, correction: correct.correction })
    const reread = readStewardPolicy(agentRoot)
    expect(reread).toEqual(result)
    const rows = fs.readFileSync(auditFile(agentRoot), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(rows.map((row) => row.mutationKind)).toEqual(["set_desired_state", "correct_provenance"])
    expect(JSON.parse(rows[1].preimage).desiredStates["container:calibre-web"].source).toBe("Ari via replay-principal (delegated): wrong")
    expect(JSON.parse(rows[1].postimage).desiredStates["container:calibre-web"].source).toBe(correct.source)
  })

  it("replays the same correction as a no-op", () => {
    const agentRoot = wrongSource()
    const actor = { ...ari, sessionEventId: "a2a-delegated:task-2", authorization: { ...ari.authorization!, requestId: "task-2" } }
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor, mutation: correct })
    expect(updateStewardPolicy(agentRoot, { expectedVersion: 1, actor, mutation: correct }).version).toBe(2)
  })

  it("keeps a routine action authorized by the corrected desired state", () => {
    const agentRoot = wrongSource()
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "e-grant", authorization: { ...ari.authorization!, requestId: "r-grant" } }, mutation: { kind: "grant_routine_action", key: "unraid.restart:calibre-web", action: "unraid.container.restart", targets: ["calibre-web"], maxCount: 1, windowMs: 1000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    updateStewardPolicy(agentRoot, { expectedVersion: 2, actor: { ...ari, sessionEventId: "e2", authorization: { ...ari.authorization!, requestId: "r2" } }, mutation: correct })
    const requester = { kind: "owner" as const, friendId: "ari", profileId: "sanctuary-owner", requestId: "r", sessionEventId: "e", origin: { friendId: "ari", channel: "telegram", key: "telegram_owner" } }
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:calibre-web", action: "unraid.container.restart", target: "calibre-web", requester, authorizationVersion: 7 })).toMatchObject({ allowed: true })
  })

  it("refuses a correction for a missing key", () => {
    const agentRoot = wrongSource()
    const before = bytes(agentRoot)
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "e2", authorization: { ...ari.authorization!, requestId: "r2" } }, mutation: { ...correct, key: "container:missing" } })).toThrow("existing desired state key")
    expect(bytes(agentRoot)).toEqual(before)
  })

  it("refuses a correction with an empty correction note or source", () => {
    const agentRoot = wrongSource()
    const actor = { ...ari, sessionEventId: "e2", authorization: { ...ari.authorization!, requestId: "r2" } }
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 1, actor, mutation: { ...correct, correction: "  " } })).toThrow("correction must be nonempty")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 1, actor, mutation: { ...correct, source: "" } })).toThrow("corrected source must be nonempty")
    expect(readStewardPolicy(agentRoot).version).toBe(1)
  })

  it("refuses a correction from a replay identity", () => {
    const agentRoot = wrongSource()
    markReplay(agentRoot, "identities", "replay-p")
    const before = bytes(agentRoot)
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: via("replay-p"), mutation: correct })).toThrow("replay identities cannot write owner policy")
    expect(bytes(agentRoot)).toEqual(before)
  })

  it("exposes correct_provenance through the tool with the delegated attribution", async () => {
    const agentRoot = wrongSource()
    const { context } = toolContext(agentRoot, "real-peer", "task-2")
    const out = JSON.parse(await stewardPolicyToolDefinition.handler({ action: "correct_provenance", key: "container:calibre-web", source: "Books stays on", correction: correct.correction }, context as any) as string)
    expect(out.version).toBe(2)
    expect(out.desiredStates["container:calibre-web"]).toMatchObject({ value: "on", source: "Ari via Claude Code (delegated): Books stays on", correction: correct.correction })
    expect(stewardPolicyToolDefinition.tool.function.description).toContain("never changes the value")
    await expect(stewardPolicyToolDefinition.handler({ action: "correct_provenance", key: "container:calibre-web", source: "x" }, toolContext(agentRoot, "real-peer", "task-3").context as any)).rejects.toThrow("correction must be nonempty")
    await expect(stewardPolicyToolDefinition.handler({ action: "correct_provenance", source: "x", correction: "y" }, toolContext(agentRoot, "real-peer", "task-4").context as any)).rejects.toThrow("key must be nonempty")
  })

  it("rejects an audit row whose correction changes more than the source", () => {
    const agentRoot = wrongSource()
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "e2", authorization: { ...ari.authorization!, requestId: "r2" } }, mutation: correct })
    const lines = fs.readFileSync(auditFile(agentRoot), "utf8").trim().split("\n")
    // Re-forge the correction row so it also flips the value, with self-consistent hashes, and the validator must still refuse it.
    const row = JSON.parse(lines[1]!)
    const post = JSON.parse(row.postimage)
    post.desiredStates["container:calibre-web"].value = "off"
    row.postimage = JSON.stringify(post, null, 2)
    row.affectedKeyResult = post.desiredStates["container:calibre-web"]
    fs.writeFileSync(auditFile(agentRoot), `${lines[0]}\n${JSON.stringify(row)}\n`)
    expect(() => readStewardPolicy(agentRoot)).toThrow("audit row is invalid")
  })

  it("rejects a correction row for a key the preimage never had, and one with no correction note", () => {
    const agentRoot = wrongSource()
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "e2", authorization: { ...ari.authorization!, requestId: "r2" } }, mutation: correct })
    const lines = fs.readFileSync(auditFile(agentRoot), "utf8").trim().split("\n")
    const noNote = JSON.parse(lines[1]!)
    const post = JSON.parse(noNote.postimage)
    delete post.desiredStates["container:calibre-web"].correction
    noNote.postimage = JSON.stringify(post, null, 2)
    noNote.affectedKeyResult = post.desiredStates["container:calibre-web"]
    fs.writeFileSync(auditFile(agentRoot), `${lines[0]}\n${JSON.stringify(noNote)}\n`)
    expect(() => readStewardPolicy(agentRoot)).toThrow("audit row is invalid")
    const missing = JSON.parse(lines[1]!)
    missing.key = "container:other"
    fs.writeFileSync(auditFile(agentRoot), `${lines[0]}\n${JSON.stringify(missing)}\n`)
    expect(() => readStewardPolicy(agentRoot)).toThrow("audit row is invalid")
  })
})
