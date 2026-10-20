import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ShepherdManagedIdentity, ShepherdManagedInputReceipt, ShepherdRecoveryRequest } from "../../../heart/shepherd/custody-types"
import { checkInStorePath, openCheckInStore, receiptMatchesOutcome, type CheckInStore, type DispatchInput } from "../../../senses/shepherd/checkin-store"
import { readCheckInSnapshot, reconcileShepherdDispatch } from "../../../senses/shepherd/recovery"
import { runShepherdOperation } from "../../../senses/shepherd/operations"

const identity: ShepherdManagedIdentity = {
  kind: "agent_session", hostInstance: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", surfaceId: "11111111-1111-4111-8111-111111111111",
  provider: "copilot", providerSessionId: "owned-provider-session", backendPid: 314,
  backendStartSeconds: 12345, backendStartMicroseconds: 6789, surfaceGeneration: 7,
  executableSha256: "b".repeat(64), profileSha256: "a".repeat(64),
}
const instance = `agent_session:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
let root: string, file: string, store: CheckInStore
const now = () => new Date().toISOString()
const input = (): DispatchInput => ({
  host: "cmux", session: identity.surfaceId, instance, screenFingerprint: "screen-1", guidanceRevision: "guidance-1",
  reply: "Continue the authorized task.", trigger: "immediate", transition: "return-1", at: now(),
  nativeTarget: { kind: "agent_session", identity: { ...identity } },
})
const receipt = (id: string, nativeRequestId: string): ShepherdManagedInputReceipt => ({
  kind: "agent_session", receiptVersion: 1, requestId: id, nativeRequestId, identity: { ...identity },
  editorInserted: true, backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "server-message-42",
})
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-managed-custody-")))
  file = checkInStorePath(root)
  store = openCheckInStore(file)
})
afterEach(() => { store.close() })

describe("separately versioned managed input custody", () => {
  it("persists the native UUID and full managed identity before input, with a v3 downgrade barrier", () => {
    const claim = store.claimDispatch(input(), "worker")!
    const snapshot = readCheckInSnapshot(file, { limit: 1 })
    expect(snapshot).toMatchObject({ schemaVersion: 3, entries: [{ id: claim.id, nativeRequestId: claim.nativeRequestId,
      nativeTarget: { kind: "agent_session", identity }, instance, state: "claimed", receipt: null }] })
    const oldReader = new Database(file, { readonly: true })
    try {
      expect([0, 1, 2].includes(Number(oldReader.pragma("user_version", { simple: true })))).toBe(false)
    } finally { oldReader.close() }
    store.close()
    store = openCheckInStore(file)
    expect(store.claimDispatch(input(), "other-worker")).toBeNull()
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]!.nativeRequestId).toBe(claim.nativeRequestId)
  })

  it("keeps classic rows byte-for-byte across the first managed claim", () => {
    const classic = store.claimDispatch({ ...input(), nativeTarget: undefined, instance: "classic:birth", session: "classic" }, "classic")!
    store.completeDispatch(classic.id, "classic", { state: "unknown" })
    const readRow = () => {
      const db = new Database(file, { readonly: true })
      try { return db.prepare("SELECT data FROM dispatches WHERE id=?").get(classic.id) } finally { db.close() }
    }
    const before = readRow()
    expect(readCheckInSnapshot(file, { limit: 1 }).schemaVersion).toBe(2)
    store.claimDispatch(input(), "managed")
    expect(readCheckInSnapshot(file, { limit: 2 }).schemaVersion).toBe(3)
    expect(readRow()).toEqual(before)
  })

  it("preserves event surface spelling while binding normalized native UUID identity", () => {
    const nativeIdentity = { ...identity, surfaceId: "abcdefab-cdef-4abc-8abc-abcdefabcdef" }
    const nativeInstance = `agent_session:${createHash("sha256").update(JSON.stringify(nativeIdentity)).digest("hex")}`
    const claim = store.claimDispatch({ ...input(), session: nativeIdentity.surfaceId.toUpperCase(), instance: nativeInstance,
      nativeTarget: { kind: "agent_session", identity: nativeIdentity } }, "worker")!
    store.completeDispatch(claim.id, "worker", { state: "sent", nativeRequestId: claim.nativeRequestId,
      receipt: { ...receipt(claim.id, claim.nativeRequestId!), identity: nativeIdentity } })
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({
      session: nativeIdentity.surfaceId.toUpperCase(), state: "sent", receipt: { identity: nativeIdentity },
    })
  })

  it("stores exact managed stages without inventing terminal paste or Enter facts", () => {
    const claim = store.claimDispatch(input(), "worker")!
    const accepted = receipt(claim.id, claim.nativeRequestId!)
    store.completeDispatch(claim.id, "worker", { state: "sent", nativeRequestId: claim.nativeRequestId, receipt: accepted })
    accepted.identity.providerSessionId = "mutated-caller"
    const saved = readCheckInSnapshot(file, { limit: 1 }).entries[0]!
    expect(saved).toMatchObject({ state: "sent", receipt: receipt(claim.id, claim.nativeRequestId!) })
    expect(saved.receipt).not.toHaveProperty("pasteAdmitted")
    expect(saved.receipt).not.toHaveProperty("submitAdmitted")
    expect(saved.receipt).not.toHaveProperty("processInstance")
  })

  it.each(["extra", "provider"])("refuses malformed %s managed identity before creating a claim", failure => {
    const value = input()
    if (value.nativeTarget?.kind !== "agent_session") throw new Error("managed fixture required")
    if (failure === "extra") Reflect.set(value.nativeTarget.identity, "callerQualified", true)
    else Reflect.set(value.nativeTarget.identity, "provider", "unknown")
    expect(() => store.claimDispatch(value, "worker")).toThrow(/schema/i)
    expect(readCheckInSnapshot(file, { limit: 1 })).toMatchObject({ schemaVersion: 2, totalCount: 0 })
  })

  it.each([
    { state: "sent", editorInserted: false, backendWriteAdmitted: false, providerAcknowledged: false, expected: false },
    { state: "sent", editorInserted: true, backendWriteAdmitted: false, providerAcknowledged: false, expected: false },
    { state: "not_sent", editorInserted: false, backendWriteAdmitted: false, providerAcknowledged: false, expected: true },
    { state: "not_sent", editorInserted: true, backendWriteAdmitted: false, providerAcknowledged: false, expected: false },
    { state: "not_sent", editorInserted: false, backendWriteAdmitted: true, providerAcknowledged: false, expected: false },
    { state: "not_sent", editorInserted: false, backendWriteAdmitted: false, providerAcknowledged: true, expected: false },
    { state: "unknown", editorInserted: false, backendWriteAdmitted: false, providerAcknowledged: false, expected: true },
    { state: "unknown", editorInserted: true, backendWriteAdmitted: true, providerAcknowledged: true, expected: false },
  ])("does not reinterpret managed stages as completion: %j", value => {
    expect(receiptMatchesOutcome(value.state, { ...receipt("claim", "ffffffff-ffff-4fff-8fff-ffffffffffff"),
      editorInserted: value.editorInserted, backendWriteAdmitted: value.backendWriteAdmitted,
      providerAcknowledged: value.providerAcknowledged, providerInputId: value.providerAcknowledged ? "ack" : null })).toBe(value.expected)
  })

  it.each(["editor", "wire", "ack", "version", "nativeUUID", "provider", "birth", "profile"])(
    "refuses a managed sent completion with invalid %s proof", failure => {
      const claim = store.claimDispatch(input(), "worker")!
      const value = receipt(claim.id, claim.nativeRequestId!)
      if (failure === "editor") value.editorInserted = false
      if (failure === "wire") value.backendWriteAdmitted = false
      if (failure === "ack") { value.providerAcknowledged = false; value.providerInputId = null }
      if (failure === "version") Reflect.set(value, "receiptVersion", 2)
      if (failure === "nativeUUID") value.nativeRequestId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
      if (failure === "provider") value.identity.providerSessionId = "foreign-session"
      if (failure === "birth") value.identity.backendStartMicroseconds++
      if (failure === "profile") value.identity.profileSha256 = "c".repeat(64)
      expect(() => store.completeDispatch(claim.id, "worker", { state: "sent",
        nativeRequestId: claim.nativeRequestId, receipt: value })).toThrow(/receipt|identity|outcome/i)
      expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]!.state).toBe("claimed")
    })

  it("keeps a partial editor insertion unknown after reopening and blocks automatic retry", () => {
    const claim = store.claimDispatch(input(), "worker")!
    store.completeDispatch(claim.id, "worker", { state: "unknown", nativeRequestId: claim.nativeRequestId,
      receipt: { ...receipt(claim.id, claim.nativeRequestId!), backendWriteAdmitted: false, providerAcknowledged: false, providerInputId: null } })
    store.close()
    store = openCheckInStore(file)
    expect(store.claimDispatch({ ...input(), screenFingerprint: "changed-screen" }, "other")).toBeNull()
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({ state: "unknown",
      receipt: { kind: "agent_session", editorInserted: true, backendWriteAdmitted: false, providerAcknowledged: false } })
  })

  it("reconciles only an exact versioned managed ACK without changing the original unknown outcome", async () => {
    const claim = store.claimDispatch(input(), "worker")!
    store.completeDispatch(claim.id, "worker", { state: "unknown", nativeRequestId: claim.nativeRequestId })
    const request: ShepherdRecoveryRequest = {
      id: claim.id, expectedRevision: readCheckInSnapshot(file, { limit: 1 }).revision!, requestId: "recover-managed",
      actor: { kind: "local_owner_administration", actorId: "owner" },
      evidence: { kind: "managed_host_receipt_v1", host: "cmux", checkedAt: now(), receipt: receipt(claim.id, claim.nativeRequestId!) },
    }
    const recovered = await reconcileShepherdDispatch(root, request)
    expect(recovered).toMatchObject({ resolution: "acknowledged_delivery", originalState: "unknown" })
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({
      state: "unknown", receipt: receipt(claim.id, claim.nativeRequestId!), reconciliationCount: 1,
    })
  })

  it("derives late-ACK CLI reconciliation only from the persisted native target and one read-only lookup", async () => {
    const claim = store.claimDispatch(input(), "worker")!
    store.completeDispatch(claim.id, "worker", { state: "unknown", nativeRequestId: claim.nativeRequestId })
    const lookups: Array<{ requestId: string; identity: ShepherdManagedIdentity }> = []
    const result = await runShepherdOperation({
      kind: "shepherd.reconcile", agent: "fixture", id: claim.id, resolution: "delivered", requestId: "late-ack",
      expectedRevision: readCheckInSnapshot(file, { limit: 1 }).revision!,
    }, {
      agentRoot: () => root, resolveOwner: async () => ({ actorId: "owner" }),
      senseStopped: async () => { throw new Error("delivery reconciliation does not manipulate lifecycle") },
      host: async () => ({
        name: "cmux", list: async () => { throw new Error("no fresh identity adoption") },
        managedReceipt: async (requestId: string, bound: ShepherdManagedIdentity) => {
          lookups.push({ requestId, identity: { ...bound } })
          return { ...receipt(requestId, requestId), state: "accepted" as const, reason: "provider_acknowledged" }
        },
      }),
    })
    expect(lookups).toEqual([{ requestId: claim.nativeRequestId, identity }])
    expect(result).toMatchObject({ resolution: "acknowledged_delivery", originalState: "unknown" })
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({
      state: "unknown", receipt: receipt(claim.id, claim.nativeRequestId!), reconciliationCount: 1,
    })
  })

  it.each(["schema", "requestId", "pendingACK", "backendBirth"])("refuses CLI delivery reconciliation with %s native evidence", async failure => {
    const claim = store.claimDispatch(input(), "worker")!
    store.completeDispatch(claim.id, "worker", { state: "unknown", nativeRequestId: claim.nativeRequestId })
    await expect(runShepherdOperation({
      kind: "shepherd.reconcile", agent: "fixture", id: claim.id, resolution: "delivered", requestId: "bad-late-ack",
      expectedRevision: readCheckInSnapshot(file, { limit: 1 }).revision!,
    }, {
      agentRoot: () => root, resolveOwner: async () => ({ actorId: "owner" }),
      senseStopped: async () => { throw new Error("no lifecycle change") },
      host: async () => ({
        name: "cmux", list: async () => { throw new Error("no fresh identity adoption") },
        managedReceipt: async requestId => {
          const value = { ...receipt(requestId, requestId), state: "accepted" as const, reason: "provider_acknowledged" }
          if (failure === "schema") Reflect.set(value, "receiptVersion", 2)
          if (failure === "requestId") value.requestId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
          if (failure === "pendingACK") { value.providerAcknowledged = false; value.providerInputId = null }
          if (failure === "backendBirth") value.identity.backendStartSeconds++
          return value
        },
      }),
    })).rejects.toThrow(/matching confirmed managed host receipt/i)
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({ state: "unknown", reconciliationCount: 0 })
  })

  it.each(["classicKind", "nativeUUID", "birth", "missingACK"])("does not reconcile invalid managed %s evidence", async failure => {
    const claim = store.claimDispatch(input(), "worker")!
    store.completeDispatch(claim.id, "worker", { state: "unknown", nativeRequestId: claim.nativeRequestId })
    const value = receipt(claim.id, claim.nativeRequestId!)
    if (failure === "nativeUUID") value.nativeRequestId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    if (failure === "birth") value.identity.backendStartSeconds++
    if (failure === "missingACK") { value.providerAcknowledged = false; value.providerInputId = null }
    const evidence = { kind: failure === "classicKind" ? "guarded_host_receipt_v1" : "managed_host_receipt_v1",
      host: "cmux", checkedAt: now(), receipt: value }
    await expect(reconcileShepherdDispatch(root, {
      id: claim.id, expectedRevision: readCheckInSnapshot(file, { limit: 1 }).revision!, requestId: "bad-recover",
      actor: { kind: "local_owner_administration", actorId: "owner" }, evidence,
    })).rejects.toThrow(/matching confirmed host receipt/i)
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]!.reconciliationCount).toBe(0)
  })
})
