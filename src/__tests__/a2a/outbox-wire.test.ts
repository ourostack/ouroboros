import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { escalationGrantsPath, setEscalationGrant } from "../../a2a/escalation-grants"
import { FileOutboxStore } from "../../a2a/outbox-store"
import { encodeOutboxCommand, handleOutboxCommand, isOutboxMethod, parseOutboxCommand } from "../../a2a/outbox-wire"
import { fileFailureReport, readFailureReport } from "../../heart/failure-reports"
import { agentMetaFor, makeTestIdentity, signedResolution } from "../test-helpers/resolution-signing"

let tmp: TmpBundleHandle | null = null
afterEach(() => { tmp?.cleanup(); tmp = null })
const NOW = "2026-10-08T00:00:00.000Z"
const friend = (id: string, overrides: Partial<FriendRecord> = {}): FriendRecord => ({
  id, name: id, role: "friend", trustLevel: "family", admissionState: "active", initiativePolicy: "reactive_only", connections: [], externalIds: [],
  tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: NOW, updatedAt: NOW, schemaVersion: 1, ...overrides,
})

describe("outbox command encoding", () => {
  it("round-trips a command and rejects anything that is not exactly one", () => {
    expect(parseOutboxCommand(encodeOutboxCommand("outbox/list", { since: "x" }))).toEqual({ method: "outbox/list", params: { since: "x" } })
    expect(parseOutboxCommand(JSON.stringify({ ouro: "a2a-method", method: "outbox/ack" }))).toEqual({ method: "outbox/ack", params: {} })
    for (const text of ["hello", "[]", "null", JSON.stringify({ ouro: "other", method: "outbox/list" }), JSON.stringify({ ouro: "a2a-method", method: "message/send" }),
      JSON.stringify({ ouro: "a2a-method", method: "outbox/list", params: [] }), JSON.stringify({ ouro: "a2a-method", method: "outbox/list", params: null })]) {
      expect(parseOutboxCommand(text)).toBeNull()
    }
    expect(isOutboxMethod("report/resolve")).toBe(true)
    expect(isOutboxMethod("SendMessage")).toBe(false)
    expect(isOutboxMethod(7)).toBe(false)
  })
})

describe("outbox command handling", () => {
  function setup() {
    tmp = createTmpBundle({ agentName: `wire-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` })
    return { agentRoot: tmp.agentRoot, outbox: new FileOutboxStore(tmp.agentRoot) }
  }

  it("refuses a missing, unverified or revoked friend", async () => {
    const { agentRoot } = setup()
    for (const sender of [undefined, friend("p", { admissionState: "unverified" }), friend("p", { admissionState: "revoked" })]) {
      expect(await handleOutboxCommand({ agentRoot, friend: sender, method: "outbox/list", params: {} })).toMatchObject({ ok: false, code: -32003 })
    }
  })

  it("lists and acks only the caller's own outbox and ignores any parameter naming another peer", async () => {
    const { agentRoot, outbox } = setup()
    const mine = outbox.append("me", { kind: "await_outcome", body: "mine" }, 1_760_000_000_000)
    const secret = outbox.append("them", { kind: "failure_report", body: "secret" }, 1_760_000_000_001)
    const listed = await handleOutboxCommand({ agentRoot, friend: friend("me"), method: "outbox/list", params: { friendId: "them", peer: "them", limit: 500 } })
    expect(listed).toEqual({ ok: true, result: { entries: [expect.objectContaining({ id: mine.id, body: "mine" })], nextCursor: mine.id, more: false } })
    expect(JSON.stringify(listed)).not.toContain("secret")
    expect(await handleOutboxCommand({ agentRoot, friend: friend("me"), method: "outbox/list", params: { since: mine.id, limit: 1 } })).toEqual({ ok: true, result: { entries: [], nextCursor: null, more: false } })
    expect(await handleOutboxCommand({ agentRoot, friend: friend("me"), method: "outbox/ack", params: { ids: [secret.id, mine.id] } })).toEqual({ ok: true, result: { acked: [mine.id], unknown: [secret.id] } })
    expect(outbox.list("them").entries).toHaveLength(1)
  })

  it("rejects malformed list and ack parameters", async () => {
    const { agentRoot } = setup()
    const call = (method: "outbox/list" | "outbox/ack", params: Record<string, unknown>) => handleOutboxCommand({ agentRoot, friend: friend("me"), method, params })
    expect(await call("outbox/list", { since: 5 })).toMatchObject({ ok: false, code: -32602 })
    expect(await call("outbox/list", { limit: "2" })).toMatchObject({ ok: false, code: -32602 })
    expect(await call("outbox/list", { limit: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, code: -32602 })
    expect(await call("outbox/ack", {})).toMatchObject({ ok: false, code: -32602 })
    expect(await call("outbox/ack", { ids: [] })).toMatchObject({ ok: false, code: -32602 })
    expect(await call("outbox/ack", { ids: [1] })).toMatchObject({ ok: false, code: -32602 })
    expect(await call("outbox/ack", { ids: Array.from({ length: 101 }, (_, i) => String(i)) })).toMatchObject({ ok: false, code: -32602 })
  })

  it("lets only an escalation holder resolve its own report, and only with its own signature", async () => {
    const { agentRoot } = setup()
    const store = new FileFriendStore(path.join(agentRoot, "friends"))
    const key = await makeTestIdentity()
    const holder = friend("claude", { kind: "agent", agentMeta: agentMetaFor(key) })
    await store.put("claude", holder)
    await store.put("ari", friend("ari"))
    setEscalationGrant(agentRoot, "claude", { grant: true, source: "test", did: key.did })
    const filed = await fileFailureReport(agentRoot, store, { ariWords: "a", tried: "b", error: "c", severity: "low", origin: { friendId: "ari", channel: "telegram", key: "k" } })
    if (!filed.ok) throw new Error("setup failed")
    const claim = { reportId: filed.id, version: "0.1.0-alpha.9", note: "Fixed." }
    const params = { id: filed.id, version: claim.version, note: claim.note, ...await signedResolution(key, claim) }
    const call = (who: FriendRecord, p: Record<string, unknown>, verifiedDid: string | undefined = key.did) => handleOutboxCommand({ agentRoot, friend: who, method: "report/resolve", params: p, ...(verifiedDid ? { verifiedDid } : {}) })
    expect(await call(friend("ari"), params)).toMatchObject({ ok: false, code: -32003, message: "report/resolve needs the escalation grant" })
    expect(await call(holder, { id: 1, version: "x", note: "n" })).toMatchObject({ ok: false, code: -32602 })
    expect(await call(holder, { id: filed.id, version: claim.version, note: claim.note })).toMatchObject({ ok: false, code: -32602 })
    expect(await call(holder, { ...params, proof: undefined })).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("no_proof") })
    const attacker = await makeTestIdentity()
    expect(await call(holder, { ...params, ...await signedResolution(attacker, claim) })).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("wrong_signer") })
    expect(await call(holder, { ...params, note: "Changed after signing." })).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("bad_signature") })
    // the friend record is writable by the Butler's own uid: a swapped DID there, signed with the new key, must not pass
    const swapped = await makeTestIdentity()
    const swappedFriend = friend("claude", { kind: "agent", agentMeta: agentMetaFor(swapped) })
    expect(await call(swappedFriend, { ...params, ...await signedResolution(swapped, claim) }, swapped.did)).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("pinned escalation holder") })
    // the verified caller must be the pinned DID even when the signature is the pinned key's
    expect(await call(holder, params, swapped.did)).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("pinned escalation holder") })
    expect(await call(holder, params, "")).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("pinned escalation holder") })
    // purpose binding: a signature over the same fields without the purpose does not verify
    expect(await call(holder, { ...params, proof: { ...(params.proof as object), sig: "AAAA" } })).toMatchObject({ ok: false, code: -32003, message: expect.stringContaining("bad_signature") })
    const bad = { reportId: filed.id, version: "soon", note: "n" }
    const loose = { reportId: filed.id, version: "v0.1.0-alpha.9", note: "n" }
    expect(await call(holder, { id: filed.id, version: "v0.1.0-alpha.9", note: "n", ...await signedResolution(key, loose) })).toMatchObject({ ok: false, code: -32003, message: "report not resolved: bad_version" })
    expect(await call(holder, { id: filed.id, version: "soon", note: "n", ...await signedResolution(key, bad) })).toMatchObject({ ok: false, code: -32003, message: "report not resolved: bad_version" })
    expect(await call(holder, params)).toEqual({ ok: true, result: { id: filed.id, status: "resolved" } })
    expect(readFailureReport(agentRoot, filed.id)).toMatchObject({ status: "resolved", resolution: { proof: expect.objectContaining({ signerDid: key.did }) } })
  })
})

describe("a grant without a pinned DID", () => {
  it("is not held, so the holder cannot resolve", async () => {
    tmp = createTmpBundle({ agentName: `wire-nodid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` })
    const agentRoot = tmp.agentRoot
    const key = await makeTestIdentity()
    const holder = friend("claude", { kind: "agent", agentMeta: agentMetaFor(key) })
    setEscalationGrant(agentRoot, "claude", { grant: true, source: "test", did: key.did })
    const file = escalationGrantsPath(agentRoot)
    const written = JSON.parse(fs.readFileSync(file, "utf8"))
    delete written.grants.claude.did
    fs.writeFileSync(file, JSON.stringify(written))
    const params = { id: "x", version: "0.1.0", note: "n", ...await signedResolution(key, { reportId: "x", version: "0.1.0", note: "n" }) }
    expect(await handleOutboxCommand({ agentRoot, friend: holder, method: "report/resolve", params, verifiedDid: key.did })).toMatchObject({ ok: false, code: -32003, message: "report/resolve needs the escalation grant" })
  })
})
