import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkInStorePath, openCheckInStore, type DispatchInput } from "../../../senses/shepherd/checkin-store"
import { readCheckInSnapshot, reconcileShepherdDispatch, maintainShepherdCustody } from "../../../senses/shepherd/recovery"
import type {
  ShepherdMaintenanceRequest, ShepherdRecoveryRequest, ShepherdRetirementProof,
} from "../../../heart/shepherd/custody-types"

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual, renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync), fsyncSync: vi.fn(actual.fsyncSync),
  }
})

let root: string
let file: string
const NOW = Date.parse("2026-10-17T22:00:00.000Z")
const at = () => new Date(NOW).toISOString()
const actor = { kind: "local_owner_administration" as const, actorId: "existing-owner" }
const input = (overrides: Partial<DispatchInput> = {}): DispatchInput => ({
  host: "cmux", session: "surface-1", instance: "pid:7:start:42", screenFingerprint: "screen-1", guidanceRevision: "guidance-1",
  reply: "Continue the authorized task.", trigger: "immediate", transition: "stop-1", at: at(), ...overrides,
})
function seed(state: "claimed" | "sent" | "not_sent" | "unknown" = "unknown", overrides: Partial<DispatchInput> = {}) {
  const store = openCheckInStore(file)
  try {
    const claim = store.claimDispatch(input(overrides), "worker-1")!
    if (state !== "claimed") store.completeDispatch(claim.id, "worker-1", { state, reason: "original outcome" })
    return claim
  } finally { store.close() }
}
function mutate(work: (database: Database.Database) => void) {
  const database = new Database(file)
  try { work(database) } finally { database.close() }
}
const revision = () => readCheckInSnapshot(file, { limit: 10 }).revision!
const gone = (overrides: Partial<ShepherdRetirementProof> = {}): ShepherdRetirementProof => ({
  kind: "host_process_inventory", host: "cmux", session: "surface-1", instance: "pid:7:start:42",
  checkedAt: at(), gone: true, wholeSessionRetired: false, ...overrides,
})
const retire = (id: string, overrides: Partial<ShepherdRecoveryRequest> = {}): ShepherdRecoveryRequest => ({
  id, expectedRevision: revision(), actor, requestId: "retire-1", evidence: gone(), ...overrides,
})
const maintenance = (overrides: Partial<ShepherdMaintenanceRequest> = {}): ShepherdMaintenanceRequest => ({
  expectedRevision: revision(), requestId: "maintenance-1", actor,
  sense: { kind: "daemon_lifecycle", checkedAt: at(), enabled: false, processState: "stopped" },
  retiredInstances: [gone()], destination: path.join(root, "archives"), ...overrides,
})

async function interrupted(stage: "copying" | "prepared" | "swapped") {
  const claim = seed()
  await reconcileShepherdDispatch(root, retire(claim.id))
  const request = maintenance()
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  if (stage === "copying") {
    vi.mocked(fs.writeFileSync).mockImplementation((candidate, data, options) => {
      if (String(candidate).includes("/archives/custody-") && data === "") throw new Error("interrupted fixture")
      actual.writeFileSync(candidate, data, options)
    })
  } else if (stage === "prepared") {
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).includes(".replacement-") && String(to) === file) throw new Error("interrupted fixture")
      actual.renameSync(from, to)
    })
  } else {
    vi.mocked(fs.unlinkSync).mockImplementation(candidate => {
      if (String(candidate) === `${file}.maintenance.json`) throw new Error("interrupted fixture")
      actual.unlinkSync(candidate)
    })
  }
  await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/interrupted fixture/)
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync)
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync)
  const marker = `${file}.maintenance.json`
  const intent = JSON.parse(fs.readFileSync(marker, "utf8"))
  return { request, marker, intent }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync)
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actual.unlinkSync)
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync)
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync)
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-recovery-")))
  file = checkInStorePath(root)
})

describe("bounded readonly custody inspection", () => {
  it("reports missing without creating a database, directories, or a comforting empty count", () => {
    expect(readCheckInSnapshot(file, { limit: 20 })).toEqual({
      state: "missing", schemaVersion: null, revision: null, bytes: null, capacity: "unknown",
      totalCount: null, noticeCount: null, counts: null, entries: [], nextCursor: null,
    })
    expect(fs.existsSync(path.join(root, "state"))).toBe(false)
  })

  it("pages coherent bounded snapshots with original outcomes, counts and revision-bound cursors", () => {
    const a = seed("claimed")
    seed("sent", { session: "surface-2" })
    seed("not_sent", { session: "surface-3" })
    const first = readCheckInSnapshot(file, { limit: 2 })
    expect(first).toMatchObject({ state: "ready", schemaVersion: 2, totalCount: 3, noticeCount: 0, counts: { claimed: 1, sent: 1, not_sent: 1, unknown: 0 }, entries: expect.any(Array), nextCursor: expect.any(String) })
    expect(first.entries).toHaveLength(2)
    const second = readCheckInSnapshot(file, { limit: 2, cursor: first.nextCursor! })
    expect(second.entries).toHaveLength(1)
    expect(new Set([...first.entries, ...second.entries].map(row => row.id)).size).toBe(3)
    expect([...first.entries, ...second.entries].find(row => row.id === a.id)).toMatchObject({ state: "claimed", retired: false, receipt: null, reconciliations: [] })
    seed("unknown", { session: "surface-4" })
    expect(() => readCheckInSnapshot(file, { limit: 2, cursor: first.nextCursor! })).toThrow(/revision/)
    for (const limit of [0, -1, 201, 0.5]) expect(() => readCheckInSnapshot(file, { limit })).toThrow(/limit/)
    expect(() => readCheckInSnapshot(file, { limit: 2, cursor: "fabricated" })).toThrow(/cursor/)
  })

  it("reads v1 without migration and preserves old claims/sends/unknowns exactly when opening for writes", () => {
    const legacy = [seed("claimed"), seed("sent", { session: "sent" }), seed("unknown", { session: "unknown" })]
    const db = new Database(file)
    let before: unknown[]
    try {
      before = db.prepare("SELECT * FROM dispatches ORDER BY id").all()
      for (const name of ["custody_meta", "custody_requests", "reconciliations", "retired_instances", "custody_migrations"]) db.exec(`DROP TABLE IF EXISTS ${name}`)
      db.pragma("user_version = 1")
    } finally { db.close() }
    expect(readCheckInSnapshot(file, { limit: 20 })).toMatchObject({ schemaVersion: 1, revision: 0, totalCount: 3 })
    const readonly = new Database(file, { readonly: true })
    try { expect(readonly.pragma("user_version", { simple: true })).toBe(1) } finally { readonly.close() }
    const store = openCheckInStore(file)
    try {
      for (const claim of legacy) expect(store.claimDispatch(claim, "next")).toBeNull()
    } finally { store.close() }
    const migrated = new Database(file, { readonly: true })
    try {
      expect(migrated.prepare("SELECT * FROM dispatches ORDER BY id").all()).toEqual(before!)
      expect(migrated.prepare("SELECT data FROM custody_migrations").all()).toContainEqual({ data: expect.stringContaining('"fromVersion":1') })
    } finally { migrated.close() }
  })

  it("surfaces unsafe modes, links, corrupt row/schema and oversized databases instead of empty state", () => {
    seed()
    fs.chmodSync(file, 0o644)
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/file/)
    fs.chmodSync(file, 0o600)
    const db = new Database(file)
    try { db.prepare("UPDATE dispatches SET data=?").run("{") } finally { db.close() }
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow()
  })

  it("validates decoded cursor fields and stored classification counts", () => {
    seed()
    const cursor = Buffer.from(JSON.stringify({ after: "invalid", revision: 0 })).toString("base64url")
    expect(() => readCheckInSnapshot(file, { limit: 10, cursor })).toThrow(/cursor/)
    mutate(db => {
      const row = db.prepare("SELECT id,data FROM dispatches").get() as { id: string; data: string }
      db.prepare("UPDATE dispatches SET data=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.data), state: "invented" }), row.id)
    })
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/state schema/)
  })

  it("bounds audit payloads and rejects mismatched recovery identities instead of rendering them as fact", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    let original = ""
    mutate(db => { original = (db.prepare("SELECT data FROM reconciliations").get() as { data: string }).data })
    const audit = JSON.parse(original)
    for (const data of [
      "x".repeat(8193), "{}", JSON.stringify({ ...audit, receipt: { ...audit.receipt, dispatchId: "different" } }),
      JSON.stringify({ ...audit, evidence: { kind: "guarded_host_receipt_v1", receipt: null } }),
    ]) {
      mutate(db => db.prepare("UPDATE reconciliations SET data=?").run(data))
      expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow()
    }
    mutate(db => db.prepare("UPDATE reconciliations SET data=?").run(original))
    expect(readCheckInSnapshot(file, { limit: 10 }).entries[0]!.reconciliationCount).toBe(1)
  })

  it("projects only declared host receipt fields and never persists unexpected host payloads as custody evidence", async () => {
    const store = openCheckInStore(file)
    const claim = store.claimDispatch(input(), "worker")!
    const receipt = {
      requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance!,
      pasteAdmitted: true, submitAdmitted: true,
    }
    try { store.completeDispatch(claim.id, "worker", { state: "sent", receipt: { ...receipt, unexpected: "PRIVATE_EXTRA_SENTINEL" } } as never) } finally { store.close() }
    expect(readCheckInSnapshot(file, { limit: 10 }).entries[0]!.receipt).toEqual(receipt)
    await reconcileShepherdDispatch(root, {
      ...retire(claim.id), evidence: { kind: "guarded_host_receipt_v1", host: "cmux", checkedAt: at(),
        unexpected: "PRIVATE_EXTRA_SENTINEL", receipt: { ...receipt, unexpected: "PRIVATE_EXTRA_SENTINEL" } },
    } as ShepherdRecoveryRequest)
    mutate(db => {
      expect(JSON.stringify(db.prepare("SELECT data FROM dispatches").all())).not.toContain("PRIVATE_EXTRA_SENTINEL")
      expect(JSON.stringify(db.prepare("SELECT data FROM reconciliations").all())).not.toContain("PRIVATE_EXTRA_SENTINEL")
    })
  })

  it("refuses writable ancestors even when the immediate custody directory and file are private", () => {
    seed()
    fs.chmodSync(root, 0o777)
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/ancestor/)
    expect(() => openCheckInStore(file)).toThrow(/ancestor/)
    fs.chmodSync(root, 0o700)
    expect(readCheckInSnapshot(file, { limit: 10 }).totalCount).toBe(1)
  })
})

describe("append-only owner reconciliation", () => {
  it("acknowledges a matching accepted host receipt without rewriting uncertainty or opening the barrier", async () => {
    const claim = seed()
    const request: ShepherdRecoveryRequest = {
      ...retire(claim.id),
      evidence: { kind: "guarded_host_receipt_v1", host: "cmux", checkedAt: at(), receipt: {
        requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance!,
        pasteAdmitted: true, submitAdmitted: true,
      } },
    }
    const result = await reconcileShepherdDispatch(root, request)
    expect(result).toMatchObject({ originalState: "unknown", resolution: "acknowledged_delivery", actorId: actor.actorId, requestId: request.requestId })
    const row = readCheckInSnapshot(file, { limit: 10 }).entries[0]!
    expect(row).toMatchObject({ state: "unknown", reason: "original outcome", reconciliations: [result], receipt: { requestId: claim.id } })
    expect(await reconcileShepherdDispatch(root, request)).toEqual(result)
    const store = openCheckInStore(file)
    try { expect(store.claimDispatch(input({ screenFingerprint: "new" }), "retry")).toBeNull() } finally { store.close() }
    await expect(reconcileShepherdDispatch(root, { ...request, evidence: gone() })).rejects.toThrow(/request.*different/)
  })

  it("rejects missing, partial, wrong-target receipts and stale or asserted evidence", async () => {
    const claim = seed()
    for (const evidence of [
      { kind: "operator_assertion", sent: true },
      { kind: "guarded_host_receipt_v1", host: "cmux", checkedAt: at(), receipt: null },
      { kind: "guarded_host_receipt_v1", host: "cmux", checkedAt: at(), receipt: { requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance, pasteAdmitted: true, submitAdmitted: false } },
      { ...gone(), instance: "different" }, { ...gone(), gone: false }, { ...gone(), checkedAt: new Date(NOW - 30_001).toISOString() },
    ]) {
      const before = revision()
      await expect(reconcileShepherdDispatch(root, { ...retire(claim.id), evidence } as ShepherdRecoveryRequest)).rejects.toThrow()
      expect(revision()).toBe(before)
    }
    await expect(reconcileShepherdDispatch(root, { ...retire(claim.id), expectedRevision: 0 })).rejects.toThrow(/revision/)
  })

  it("retires an exactly proven gone instance forever, including changed evidence and reopen", async () => {
    const claim = seed()
    const receipt = await reconcileShepherdDispatch(root, retire(claim.id))
    expect(receipt).toMatchObject({ originalState: "unknown", resolution: "retired_instance" })
    expect(readCheckInSnapshot(file, { limit: 10 }).entries[0]).toMatchObject({ state: "unknown", retired: true })
    const store = openCheckInStore(file)
    try {
      expect(store.claimDispatch(input({ screenFingerprint: "new", guidanceRevision: "new" }), "retry")).toBeNull()
      expect(store.claimDispatch(input({ instance: "new-instance" }), "new-process")).not.toBeNull()
    } finally { store.close() }
  })

  it("requires whole-session retirement for a null instance and does not invent a new process", async () => {
    const claim = seed("claimed", { instance: null })
    await expect(reconcileShepherdDispatch(root, retire(claim.id, { evidence: gone({ instance: null }) }))).rejects.toThrow(/whole session/)
    await reconcileShepherdDispatch(root, retire(claim.id, { evidence: gone({ instance: null, wholeSessionRetired: true }) }))
    const store = openCheckInStore(file)
    try {
      expect(store.claimDispatch(input({ instance: "new-instance" }), "retry")).toBeNull()
      expect(store.claimDispatch(input({ session: "new-session" }), "new-session")).not.toBeNull()
    } finally { store.close() }
  })

  it("serializes conflicting recovery requests and never silently overwrites an operator decision", async () => {
    const claim = seed()
    const request = retire(claim.id)
    const results = await Promise.allSettled([
      reconcileShepherdDispatch(root, request),
      reconcileShepherdDispatch(root, { ...request, requestId: "different-request" }),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    expect(readCheckInSnapshot(file, { limit: 10 }).entries[0]!.reconciliations).toHaveLength(1)
  })

  it("rejects invalid owners, absent stores/dispatches and requests to reconcile definite non-input", async () => {
    await expect(reconcileShepherdDispatch(root, { id: "x", expectedRevision: 0, actor, requestId: "missing", evidence: gone() })).rejects.toThrow(/missing/)
    const claim = seed("not_sent")
    const request = retire(claim.id)
    await expect(reconcileShepherdDispatch(root, { ...request, actor: { kind: "browser" } as never })).rejects.toThrow(/owner/)
    await expect(reconcileShepherdDispatch(root, { ...request, id: "missing" })).rejects.toThrow(/not found/)
    await expect(reconcileShepherdDispatch(root, request)).rejects.toThrow(/not-sent/)
  })

  it("rejects oversized evidence transactionally, preserving the original uncertainty", async () => {
    const claim = seed()
    const request = retire(claim.id)
    await expect(reconcileShepherdDispatch(root, { ...request, evidence: { ...gone(), excessive: "x".repeat(5000) } } as ShepherdRecoveryRequest)).rejects.toThrow(/index capacity/)
    await expect(reconcileShepherdDispatch(root, {
      ...request, evidence: { kind: "guarded_host_receipt_v1", host: "cmux", checkedAt: at(), receipt: {
        requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance!,
        pasteAdmitted: true, submitAdmitted: true, excessive: "x".repeat(9000),
      } },
    } as ShepherdRecoveryRequest)).rejects.toThrow(/record byte limit/)
    expect(revision()).toBe(request.expectedRevision)
    expect(readCheckInSnapshot(file, { limit: 10 }).entries[0]!.reconciliations).toEqual([])
  })

  it("rejects corrupt replay receipts and retired-index payloads", async () => {
    const claim = seed()
    const request = retire(claim.id)
    await reconcileShepherdDispatch(root, request)
    mutate(db => db.prepare("UPDATE custody_requests SET receipt=?").run("{}"))
    await expect(reconcileShepherdDispatch(root, request)).rejects.toThrow(/receipt schema/)
    mutate(db => db.prepare("UPDATE retired_instances SET data=?").run("{}"))
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/retired instance schema/)
    expect(() => openCheckInStore(file)).toThrow(/retired instance schema/)
    mutate(db => db.prepare("UPDATE retired_instances SET data=?").run("x".repeat(4097)))
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/index capacity/)
  })

  it("bounds returned audit history explicitly while preserving every original audit and retirement proof", async () => {
    const claim = seed()
    const first = await reconcileShepherdDispatch(root, retire(claim.id))
    for (let i = 0; i < 21; i++) await reconcileShepherdDispatch(root, retire(claim.id, { requestId: `audit-${i}` }))
    const entry = readCheckInSnapshot(file, { limit: 10 }).entries[0]!
    expect(entry.reconciliations).toHaveLength(20)
    expect(entry.reconciliationCount).toBe(22)
    mutate(db => {
      const index = JSON.parse((db.prepare("SELECT data FROM retired_instances").get() as { data: string }).data)
      expect(index.provenance).toEqual(first)
      expect(db.prepare("SELECT COUNT(*) AS count FROM reconciliations").get()).toEqual({ count: 22 })
    })
  })

  it("refuses a corrupted acknowledgement that no longer proves admitted input", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, {
      ...retire(claim.id), evidence: { kind: "guarded_host_receipt_v1", host: "cmux", checkedAt: at(), receipt: {
        requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance!,
        pasteAdmitted: true, submitAdmitted: true,
      } },
    })
    mutate(db => {
      const row = db.prepare("SELECT data FROM reconciliations").get() as { data: string }
      const audit = JSON.parse(row.data)
      audit.evidence.receipt.submitAdmitted = false
      db.prepare("UPDATE reconciliations SET data=?").run(JSON.stringify(audit))
    })
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/host receipt schema/)
  })
})

describe("offline custody archive", () => {
  it("requires disabled/stopped sense and refuses unresolved live attempts", async () => {
    seed()
    await expect(maintainShepherdCustody(root, maintenance({ sense: { kind: "daemon_lifecycle", checkedAt: at(), enabled: true, processState: "running" } as never }))).rejects.toThrow(/stopped/)
    await expect(maintainShepherdCustody(root, maintenance({ retiredInstances: [] }))).rejects.toThrow(/retired/)
    await expect(maintainShepherdCustody(root, maintenance())).rejects.toThrow(/unresolved/)
    expect(fs.existsSync(path.join(root, "archives"))).toBe(false)
  })

  it("archives settled retired payloads durably but retains tombstones through restart and replay", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    seed("sent", { session: "unrelated-session" })
    const request = maintenance()
    const receipt = await maintainShepherdCustody(root, request)
    expect(receipt).toMatchObject({ archivedCount: 1, retainedCount: 1, archiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(fs.statSync(receipt.archive).mode & 0o777).toBe(0o600)
    expect(readCheckInSnapshot(file, { limit: 10 })).toMatchObject({ totalCount: 1 })
    const archive = new Database(receipt.archive, { readonly: true })
    try { expect(archive.prepare("SELECT id FROM dispatches WHERE id=?").get(claim.id)).toEqual({ id: claim.id }) } finally { archive.close() }
    expect(await maintainShepherdCustody(root, request)).toEqual(receipt)
    mutate(db => {
      const retired = JSON.parse((db.prepare("SELECT data FROM retired_instances").get() as { data: string }).data)
      expect(retired.archive).toEqual({ path: receipt.archive, digest: receipt.archiveDigest })
      expect(retired.provenance).toMatchObject({ dispatchId: claim.id, resolution: "retired_instance" })
    })
    const store = openCheckInStore(file)
    try { expect(store.claimDispatch(input({ screenFingerprint: "new" }), "retry")).toBeNull() } finally { store.close() }
  })

  it("blocks input and inspection after an interrupted swap, then resumes the exact prepared operation", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let fail = true
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (fail && String(from).includes(".replacement-") && String(to) === file) {
        fail = false
        throw new Error("simulated crash before swap")
      }
      actual.renameSync(from, to)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/crash before swap/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/maintenance/)
    await expect(maintainShepherdCustody(root, { ...request, requestId: "different" })).rejects.toThrow(/different request/)
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_000)
    const refreshed = {
      ...request, sense: { ...request.sense, checkedAt: new Date(NOW + 60_000).toISOString() },
      retiredInstances: request.retiredInstances.map(proof => ({ ...proof, checkedAt: new Date(NOW + 60_000).toISOString() })),
    }
    const result = await maintainShepherdCustody(root, refreshed)
    expect(result.archivedCount).toBe(1)
    expect(fs.existsSync(`${file}.maintenance.json`)).toBe(false)
    expect(readCheckInSnapshot(file, { limit: 10 }).totalCount).toBe(0)
    const store = openCheckInStore(file)
    try { expect(store.claimDispatch(input({ screenFingerprint: "changed" }), "retry")).toBeNull() } finally { store.close() }
  })

  it("reconciles an interrupted post-swap cleanup without archiving or dispatching again", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let fail = true
    vi.mocked(fs.unlinkSync).mockImplementation(candidate => {
      if (fail && String(candidate) === `${file}.maintenance.json`) {
        fail = false
        throw new Error("simulated crash after swap")
      }
      actual.unlinkSync(candidate)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/crash after swap/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
    const result = await maintainShepherdCustody(root, request)
    expect(result.archivedCount).toBe(1)
    expect(readCheckInSnapshot(file, { limit: 10 }).totalCount).toBe(0)
    expect(await maintainShepherdCustody(root, request)).toEqual(result)
  })

  it("recovers interrupted copying without treating a partial archive as authority", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let fail = true
    vi.mocked(fs.writeFileSync).mockImplementation((candidate, data, options) => {
      if (fail && String(candidate).includes("/archives/custody-") && String(candidate).endsWith(".tmp") && data === "") {
        fail = false
        throw new Error("simulated crash during archive copy")
      }
      actual.writeFileSync(candidate, data, options)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/archive copy/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
    expect((await maintainShepherdCustody(root, request)).archivedCount).toBe(1)
  })

  it("preserves a published archive if interrupted before its prepared marker, then safely rebuilds", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let fail = true
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (fail && String(to) === `${file}.maintenance.json` && JSON.parse(actual.readFileSync(from, "utf8")).stage === "prepared") {
        fail = false
        throw new Error("simulated crash while preparing marker")
      }
      actual.renameSync(from, to)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/preparing marker/)
    const result = await maintainShepherdCustody(root, request)
    expect(result.archivedCount).toBe(1)
    expect(fs.readdirSync(request.destination).filter(name => name.includes(".interrupted-"))).toHaveLength(2)
    expect(fs.existsSync(result.archive)).toBe(true)
  })

  it("rechecks stopped-sense evidence after awaited backups before swapping", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let advance = true
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (advance && String(to) === `${file}.maintenance.json` && JSON.parse(actual.readFileSync(from, "utf8")).stage === "prepared") {
        advance = false
        vi.spyOn(Date, "now").mockReturnValue(NOW + 30_001)
      }
      actual.renameSync(from, to)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/stopped sense proof/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
    const freshAt = new Date(NOW + 30_001).toISOString()
    const result = await maintainShepherdCustody(root, {
      ...request, sense: { ...request.sense, checkedAt: freshAt }, retiredInstances: request.retiredInstances.map(proof => ({ ...proof, checkedAt: freshAt })),
    })
    expect(result.archivedCount).toBe(1)
  })

  it("refuses unsafe destinations and changed semantic intent without altering custody", async () => {
    const claim = seed("sent")
    const before = revision()
    await expect(maintainShepherdCustody(root, maintenance({ destination: "relative" }))).rejects.toThrow(/absolute/)
    const destination = path.join(root, "public-archive")
    fs.mkdirSync(destination, { mode: 0o755 })
    await expect(maintainShepherdCustody(root, maintenance({ destination }))).rejects.toThrow(/0700/)
    const link = path.join(root, "linked")
    fs.symlinkSync(destination, link)
    await expect(maintainShepherdCustody(root, maintenance({ destination: link }))).rejects.toThrow(/link/)
    await expect(maintainShepherdCustody(root, maintenance({ expectedRevision: 0 }))).rejects.toThrow(/revision/)
    expect(revision()).toBe(before)
    const request = maintenance()
    await maintainShepherdCustody(root, request)
    await expect(maintainShepherdCustody(root, { ...request, retiredInstances: [gone({ instance: "changed" })] })).rejects.toThrow(/different arguments/)
    const store = openCheckInStore(file)
    try { expect(store.claimDispatch({ ...input(), screenFingerprint: claim.id }, "retry")).toBeNull() } finally { store.close() }
  })

  it.each(["copying", "prepared"] as const)("rejects malformed %s recovery records instead of guessing which file is authoritative", async stage => {
    const { request, marker, intent } = await interrupted(stage)
    fs.writeFileSync(marker, JSON.stringify(stage === "copying" ? { ...intent, archiveDigest: "unexpected" } : { ...intent, receipt: {} }))
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/maintenance schema/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
  })

  it("refuses corrupt prepared payloads and manifests without replacing the canonical ledger", async () => {
    const { request, intent } = await interrupted("prepared")
    fs.chmodSync(intent.archive, 0o644)
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/private file/)
    fs.chmodSync(intent.archive, 0o600)
    fs.writeFileSync(`${intent.archive}.json`, "{}")
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/manifest mismatch/)
    fs.appendFileSync(intent.replacement, "changed")
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/payload digest/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
  })

  it("refuses a completed swap if its retained archive no longer matches the recorded digest", async () => {
    const { request, intent } = await interrupted("swapped")
    fs.appendFileSync(intent.archive, "changed")
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/does not match recovery marker/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
  })

  it("detects a changed canonical source while resuming instead of overwriting newer custody", async () => {
    const { request } = await interrupted("prepared")
    mutate(db => db.prepare("INSERT INTO notices(signature,data) VALUES(?,?)").run("external-write", JSON.stringify({ signature: "external-write", at: at() })))
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/source changed/)
  })

  it("rechecks the source digest immediately before the final swap", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to) === `${file}.maintenance.json` && JSON.parse(actual.readFileSync(from, "utf8")).stage === "prepared") {
        mutate(db => db.prepare("INSERT INTO notices(signature,data) VALUES(?,?)").run("late-write", JSON.stringify({ signature: "late-write", at: at() })))
      }
      actual.renameSync(from, to)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/source changed before swap/)
  })

  it("does not overwrite an existing archive when its original intent marker is absent", async () => {
    const { request, marker } = await interrupted("prepared")
    fs.renameSync(marker, `${marker}.saved`)
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/destination already exists/)
    expect(readCheckInSnapshot(file, { limit: 10 }).totalCount).toBe(1)
  })

  it("resumes a copy interrupted after archive publication but before manifest publication", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let fail = true
    vi.mocked(fs.writeFileSync).mockImplementation((candidate, data, options) => {
      if (fail && String(candidate).includes("/archives/custody-") && String(candidate).includes(".sqlite.json.")) {
        fail = false
        throw new Error("interrupted manifest publication")
      }
      actual.writeFileSync(candidate, data, options)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/manifest publication/)
    const result = await maintainShepherdCustody(root, request)
    expect(result.archivedCount).toBe(1)
    expect(fs.readdirSync(request.destination).filter(name => name.includes(".interrupted-"))).toHaveLength(1)
  })

  it("requires a real store, valid administration, eligible targets and explicit whole-session retirement", async () => {
    const missing: ShepherdMaintenanceRequest = {
      expectedRevision: 0, requestId: "missing", actor, destination: path.join(root, "archives"),
      sense: { kind: "daemon_lifecycle", checkedAt: at(), enabled: false, processState: "stopped" }, retiredInstances: [gone()],
    }
    await expect(maintainShepherdCustody(root, missing)).rejects.toThrow(/missing/)
    seed("sent")
    await expect(maintainShepherdCustody(root, maintenance({ actor: { kind: "browser" } as never }))).rejects.toThrow(/owner/)
    await expect(maintainShepherdCustody(root, maintenance({ retiredInstances: [gone({ instance: null })] }))).rejects.toThrow(/retired-instance/)
    await expect(maintainShepherdCustody(root, maintenance({ retiredInstances: [gone({ session: "different" })] }))).rejects.toThrow(/eligible/)
  })

  it("archives an explicitly retired whole session without allowing that session to reopen", async () => {
    const claim = seed("unknown", { instance: null })
    const proof = gone({ instance: null, wholeSessionRetired: true })
    await reconcileShepherdDispatch(root, retire(claim.id, { evidence: proof }))
    const result = await maintainShepherdCustody(root, maintenance({ retiredInstances: [proof] }))
    expect(result.archivedCount).toBe(1)
    const store = openCheckInStore(file)
    try { expect(store.claimDispatch(input({ instance: "different" }), "retry")).toBeNull() } finally { store.close() }
  })

  it.each([1, 2])("checks SQLite integrity at archive/replacement stage %s before swapping", async corruptCheck => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const pragma = Database.prototype.pragma
    let checks = 0
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      if (source === "integrity_check" && ++checks === corruptCheck) return "simulated damaged SQLite"
      return pragma.call(this, source, options)
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/integrity check/)
    expect(() => openCheckInStore(file)).toThrow(/maintenance/)
  })

  it("detects an incomplete archive copy by its payload count", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    const request = maintenance()
    const backup = Database.prototype.backup
    vi.spyOn(Database.prototype, "backup").mockImplementationOnce(async function (this: Database.Database, destination, options) {
      const result = await backup.call(this, destination, options)
      const copy = new Database(destination)
      try { copy.prepare("DELETE FROM dispatches").run() } finally { copy.close() }
      return result
    })
    await expect(maintainShepherdCustody(root, request)).rejects.toThrow(/count mismatch/)
  })

  it("does not replace the first archive reference if an old executable recreates payload for a retired instance", async () => {
    const claim = seed("claimed")
    await reconcileShepherdDispatch(root, retire(claim.id))
    const first = await maintainShepherdCustody(root, maintenance())
    mutate(db => db.prepare("INSERT INTO dispatches(id,host,session,instance,data) VALUES(?,?,?,?,?)")
      .run(claim.id, claim.host, claim.session, claim.instance, JSON.stringify(claim)))
    await expect(maintainShepherdCustody(root, maintenance({ requestId: "second-archive" }))).rejects.toThrow(/archive reference already assigned/)
    expect(fs.existsSync(first.archive)).toBe(true)
  })

  it("refuses malformed retained archive references rather than hiding custody provenance", async () => {
    const claim = seed()
    await reconcileShepherdDispatch(root, retire(claim.id))
    await maintainShepherdCustody(root, maintenance({ retiredInstances: [gone(), gone()] }))
    mutate(db => {
      const row = db.prepare("SELECT data FROM retired_instances").get() as { data: string }
      db.prepare("UPDATE retired_instances SET data=?").run(JSON.stringify({ ...JSON.parse(row.data), archive: { path: "relative", digest: "invalid" } }))
    })
    expect(() => readCheckInSnapshot(file, { limit: 10 })).toThrow(/archive reference schema/)
    expect(() => openCheckInStore(file)).toThrow(/archive reference schema/)
  })
})
