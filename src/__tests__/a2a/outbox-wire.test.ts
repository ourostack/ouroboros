import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { setEscalationGrant } from "../../a2a/escalation-grants"
import { FileOutboxStore } from "../../a2a/outbox-store"
import { encodeOutboxCommand, handleOutboxCommand, isOutboxMethod, parseOutboxCommand } from "../../a2a/outbox-wire"
import { fileFailureReport, readFailureReport } from "../../heart/failure-reports"

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
    tmp = createTmpBundle({ agentName: `wire-${Date.now()}` })
    return { agentRoot: tmp.agentRoot, outbox: new FileOutboxStore(tmp.agentRoot) }
  }

  it("refuses a missing, unverified or revoked friend", () => {
    const { agentRoot } = setup()
    for (const sender of [undefined, friend("p", { admissionState: "unverified" }), friend("p", { admissionState: "revoked" })]) {
      expect(handleOutboxCommand({ agentRoot, friend: sender, method: "outbox/list", params: {} })).toMatchObject({ ok: false, code: -32003 })
    }
  })

  it("lists and acks only the caller's own outbox and ignores any parameter naming another peer", () => {
    const { agentRoot, outbox } = setup()
    const mine = outbox.append("me", { kind: "await_outcome", body: "mine" }, 1_760_000_000_000)
    const secret = outbox.append("them", { kind: "failure_report", body: "secret" }, 1_760_000_000_001)
    const listed = handleOutboxCommand({ agentRoot, friend: friend("me"), method: "outbox/list", params: { friendId: "them", peer: "them", limit: 500 } })
    expect(listed).toEqual({ ok: true, result: { entries: [expect.objectContaining({ id: mine.id, body: "mine" })], nextCursor: mine.id, more: false } })
    expect(JSON.stringify(listed)).not.toContain("secret")
    expect(handleOutboxCommand({ agentRoot, friend: friend("me"), method: "outbox/list", params: { since: mine.id, limit: 1 } })).toEqual({ ok: true, result: { entries: [], nextCursor: null, more: false } })
    expect(handleOutboxCommand({ agentRoot, friend: friend("me"), method: "outbox/ack", params: { ids: [secret.id, mine.id] } })).toEqual({ ok: true, result: { acked: [mine.id], unknown: [secret.id] } })
    expect(outbox.list("them").entries).toHaveLength(1)
  })

  it("rejects malformed list and ack parameters", () => {
    const { agentRoot } = setup()
    const call = (method: "outbox/list" | "outbox/ack", params: Record<string, unknown>) => handleOutboxCommand({ agentRoot, friend: friend("me"), method, params })
    expect(call("outbox/list", { since: 5 })).toMatchObject({ ok: false, code: -32602 })
    expect(call("outbox/list", { limit: "2" })).toMatchObject({ ok: false, code: -32602 })
    expect(call("outbox/list", { limit: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, code: -32602 })
    expect(call("outbox/ack", {})).toMatchObject({ ok: false, code: -32602 })
    expect(call("outbox/ack", { ids: [] })).toMatchObject({ ok: false, code: -32602 })
    expect(call("outbox/ack", { ids: [1] })).toMatchObject({ ok: false, code: -32602 })
    expect(call("outbox/ack", { ids: Array.from({ length: 101 }, (_, i) => String(i)) })).toMatchObject({ ok: false, code: -32602 })
  })

  it("lets only an escalation holder resolve its own report", async () => {
    const { agentRoot } = setup()
    const store = new FileFriendStore(path.join(agentRoot, "friends"))
    await store.put("claude", friend("claude"))
    await store.put("ari", friend("ari"))
    setEscalationGrant(agentRoot, "claude", { grant: true, source: "test" })
    const filed = await fileFailureReport(agentRoot, store, { ariWords: "a", tried: "b", error: "c", severity: "low", origin: { friendId: "ari", channel: "telegram", key: "k" } })
    if (!filed.ok) throw new Error("setup failed")
    const params = { id: filed.id, version: "0.1.0-alpha.9", note: "Fixed." }
    expect(handleOutboxCommand({ agentRoot, friend: friend("ari"), method: "report/resolve", params })).toMatchObject({ ok: false, code: -32003, message: "report/resolve needs the escalation grant" })
    expect(handleOutboxCommand({ agentRoot, friend: friend("claude"), method: "report/resolve", params: { id: 1, version: "x", note: "n" } })).toMatchObject({ ok: false, code: -32602 })
    expect(handleOutboxCommand({ agentRoot, friend: friend("claude"), method: "report/resolve", params: { ...params, version: "soon" } })).toMatchObject({ ok: false, code: -32003, message: "report not resolved: bad_version" })
    expect(handleOutboxCommand({ agentRoot, friend: friend("claude"), method: "report/resolve", params })).toEqual({ ok: true, result: { id: filed.id, status: "resolved" } })
    expect(readFailureReport(agentRoot, filed.id)).toMatchObject({ status: "resolved" })
  })
})
