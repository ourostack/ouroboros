import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  advanceCustodyRevision, checkInStorePath, custodyCapacity, custodyRevision, openCheckInStore, openCustodyDatabase,
  type CheckInStore, type DispatchInput,
} from "../../../senses/shepherd/checkin-store"
import { emitNervesEvent } from "../../../nerves/runtime"
import { readCheckInSnapshot } from "../../../senses/shepherd/recovery"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>()
  return { ...actual, openSync: vi.fn(actual.openSync) }
})

const stores: CheckInStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); vi.clearAllMocks() })

function location() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-checkins-")), "checkins", "custody.sqlite")
}
function open(file = location()) {
  const store = openCheckInStore(file)
  stores.push(store)
  return { store, file }
}
function input(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return { host: "cmux", session: "terminal-1", instance: "pid-23:start-42",
    screenFingerprint: "screen-a", guidanceRevision: "revision-a", reply: "Continue authorized work.",
    trigger: "immediate", transition: "return-1", at: "2026-10-16T04:00:00.000Z", ...overrides }
}
function mutate(file: string, work: (database: Database.Database) => void) {
  const database = new Database(file)
  try { work(database) } finally { database.close() }
}

describe("private cross-trigger check-in custody", () => {
  it("persists a distinct native UUID before exposing a new claim without changing its custody identity", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    expect(claim).toHaveProperty("nativeRequestId", expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/))
    expect(claim.id).toMatch(/^[a-f0-9]{64}$/)
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toHaveProperty("nativeRequestId", Reflect.get(claim, "nativeRequestId"))
    store.close()
    const other = open(file).store
    expect(other.claimDispatch(input(), "two")).toBeNull()
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toHaveProperty("nativeRequestId", Reflect.get(claim, "nativeRequestId"))
    const different = other.claimDispatch(input({ session: "different" }), "two")!
    expect(Reflect.get(different, "nativeRequestId")).not.toBe(Reflect.get(claim, "nativeRequestId"))
  })

  it("assigns a fresh native UUID only to a proven zero-input retry, never adopting caller identity", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    store.completeDispatch(claim.id, "one", { state: "not_sent", reason: "pre-input refusal" })
    const retry = store.claimDispatch({ ...input(), ...{ nativeRequestId: Reflect.get(claim, "nativeRequestId") } }, "two")!
    expect(retry.id).toBe(claim.id)
    expect(retry).toHaveProperty("nativeRequestId", expect.any(String))
    expect(Reflect.get(retry, "nativeRequestId")).not.toBe(Reflect.get(claim, "nativeRequestId"))
    store.completeDispatch(retry.id, "two", { state: "unknown", reason: "lost native reply" })
    store.close()
    const other = open(file).store
    expect(other.claimDispatch(input({ screenFingerprint: "changed" }), "three")).toBeNull()
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({
      id: claim.id, state: "unknown", nativeRequestId: Reflect.get(retry, "nativeRequestId"),
    })
  })

  it.each(["claimed", "sent", "not_sent", "unknown"] as const)("does not upgrade or retry legacy %s custody without a native identity", state => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    const legacy = { ...claim, state }
    Reflect.deleteProperty(legacy, "nativeRequestId")
    const data = JSON.stringify(legacy)
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?").run(data, claim.id))
    store.close()
    const other = open(file).store
    expect(other.claimDispatch(input(), "two")).toBeNull()
    mutate(file, db => expect(db.prepare("SELECT data FROM dispatches WHERE id=?").get(claim.id)).toEqual({ data }))
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).not.toHaveProperty("nativeRequestId")
  })

  it.each([null, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000",
    "12345678-1234-4234-8234-123456789abc-extra", 42])("refuses corrupt native attempt identities: %j", nativeRequestId => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?")
      .run(JSON.stringify({ ...claim, nativeRequestId }), claim.id))
    expect(() => store.claimDispatch(input(), "two")).toThrow(/schema/)
    expect(() => store.completeDispatch(claim.id, "one", { state: "sent" })).toThrow(/schema/)
  })

  it("binds native completions to the persisted attempt even when a worker identity is reused", () => {
    const { store, file } = open()
    const nativeTarget = { hostInstance: "native-boot", workspaceId: "workspace-1" }
    const claim = store.claimDispatch({ ...input(), ...{ nativeTarget } }, "same-worker")!
    const first = Reflect.get(claim, "nativeRequestId")
    expect(() => store.completeDispatch(claim.id, "same-worker", { state: "not_sent" })).toThrow(/native attempt/)
    store.completeDispatch(claim.id, "same-worker", { state: "not_sent", ...{ nativeRequestId: first } })
    const next = store.claimDispatch({ ...input(), ...{ nativeTarget } }, "same-worker")!
    expect(() => store.completeDispatch(next.id, "same-worker", {
      state: "sent", ...{ nativeRequestId: first },
    })).toThrow(/native attempt/)
    store.completeDispatch(next.id, "same-worker", { state: "unknown", ...{ nativeRequestId: Reflect.get(next, "nativeRequestId") } })
    expect(readCheckInSnapshot(file, { limit: 1 }).entries[0]).toMatchObject({ state: "unknown", nativeTarget })
  })

  it.each([null, {}, { hostInstance: "", workspaceId: "workspace" },
    { hostInstance: "boot", workspaceId: "" }, { hostInstance: 42, workspaceId: "workspace" },
    { hostInstance: "boot", workspaceId: "x".repeat(257) }])("refuses malformed native target binding: %j", nativeTarget => {
    const { store } = open()
    expect(() => store.claimDispatch({ ...input(), ...{ nativeTarget } }, "worker")).toThrow(/schema/)
  })

  it("uses the existing Shepherd state directory and private database modes", () => {
    expect(checkInStorePath("/agent")).toBe("/agent/state/senses/shepherd/checkins/custody.sqlite")
    const { store, file } = open()
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(store.shouldNotify("classification:evidence:guidance")).toBe(true)
  })

  it("claims once across independent connections and excludes trigger/transition/reply/time from the key", () => {
    const { store, file } = open()
    const other = open(file).store
    const claim = store.claimDispatch(input(), "one")
    expect(claim).toMatchObject({ owner: "one", state: "claimed", trigger: "immediate" })
    expect(other.claimDispatch(input({ trigger: "periodic", transition: "sweep-7", reply: "different",
      at: "2026-10-16T05:00:00.000Z" }), "two")).toBeNull()
    expect(other.claimDispatch(input({ trigger: "network", transition: "network-8" }), "two")).toBeNull()
  })

  it.each(["claimed", "unknown"] as const)("keeps a %s barrier across changed evidence and restart", state => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    if (state === "unknown") store.completeDispatch(claim.id, "one", { state, reason: "acceptance uncertain" })
    store.close()
    const other = open(file).store
    expect(other.claimDispatch(input({ screenFingerprint: "changed", guidanceRevision: "changed", trigger: "periodic" }), "two")).toBeNull()
    expect(other.claimDispatch(input({ session: "terminal-2" }), "two")).not.toBeNull()
    expect(other.claimDispatch(input({ instance: "new-process" }), "two")).not.toBeNull()
    expect(other.claimDispatch(input({ host: "herdr" }), "two")).not.toBeNull()
  })

  it("applies unknown-instance barriers in both directions without inventing process identity", () => {
    const { store } = open()
    store.claimDispatch(input({ instance: null }), "one")
    expect(store.claimDispatch(input({ screenFingerprint: "new" }), "two")).toBeNull()
    store.claimDispatch(input({ session: "known" }), "one")
    expect(store.claimDispatch(input({ session: "known", instance: null }), "two")).toBeNull()
    expect(store.claimDispatch(input({ session: "known", instance: "new" }), "two")).not.toBeNull()
  })

  it("deduplicates sent input after reopen but allows new evidence after positive completion", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    store.completeDispatch(claim.id, "one", { state: "sent" })
    store.close()
    const other = open(file).store
    expect(other.claimDispatch(input({ trigger: "periodic" }), "two")).toBeNull()
    expect(other.claimDispatch(input({ screenFingerprint: "new" }), "two")).not.toBeNull()
    expect(other.claimDispatch(input({ session: "revision", guidanceRevision: "new" }), "two")).not.toBeNull()
  })

  it("only permits reclaim after definite pre-input not-sent, with a new owner", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    store.completeDispatch(claim.id, "one", { state: "not_sent", reason: "guard refused before input" })
    store.close()
    const other = open(file).store
    const retry = other.claimDispatch(input({ trigger: "periodic" }), "two")!
    expect(retry.id).toBe(claim.id)
    expect(retry.owner).toBe("two")
    expect(retry.trigger).toBe("periodic")
    expect(() => other.completeDispatch(claim.id, "one", { state: "sent" })).toThrow("owner")
    other.completeDispatch(claim.id, "two", { state: "unknown", reason: "lost connection" })
    expect(other.claimDispatch(input(), "three")).toBeNull()
    expect(() => other.completeDispatch(claim.id, "two", { state: "not_sent" })).toThrow("owner")
  })

  it("refuses fabricated completions, owners, timestamps and oversized encoded rows", () => {
    const { store } = open()
    expect(() => store.claimDispatch(null as never, "one")).toThrow("schema")
    expect(() => store.claimDispatch(input(), "")).toThrow("owner")
    expect(() => store.claimDispatch(input(), "x".repeat(257))).toThrow("owner")
    expect(() => store.claimDispatch(input({ at: "not a time" }), "one")).toThrow("schema")
    expect(() => store.claimDispatch(input({ host: "" }), "one")).toThrow("schema")
    expect(() => store.claimDispatch(input({ instance: "" }), "one")).toThrow("schema")
    expect(() => store.claimDispatch(input({ trigger: "fabricated" as DispatchInput["trigger"] }), "one")).toThrow("schema")
    expect(() => store.claimDispatch(input({ reply: "😀".repeat(1024) }), "one")).toThrow("byte")
    const claim = store.claimDispatch(input(), "one")!
    expect(() => store.completeDispatch("missing", "one", { state: "sent" })).toThrow("owner")
    expect(() => store.completeDispatch(claim.id, "two", { state: "sent" })).toThrow("owner")
    expect(() => store.completeDispatch(claim.id, "one", JSON.parse('{"state":"pending"}'))).toThrow("state")
    expect(() => store.completeDispatch(claim.id, "one", { state: "unknown", reason: "x".repeat(1025) })).toThrow("reason")
    expect(store.claimDispatch(input(), "two")).toBeNull()
    store.completeDispatch(claim.id, "one", { state: "unknown" })
  })

  it("keeps notification suppression durable and separate from dispatch authority", () => {
    const { store, file } = open()
    store.markNotified("blocked:screen-a:revision-a", "2026-10-16T04:00:00Z")
    store.markNotified("blocked:screen-a:revision-a", "2026-10-16T05:00:00Z")
    expect(store.shouldNotify("blocked:screen-a:revision-a")).toBe(false)
    expect(store.claimDispatch(input(), "one")).not.toBeNull()
    store.close()
    const other = open(file).store
    expect(other.shouldNotify("blocked:screen-a:revision-a")).toBe(false)
    expect(other.shouldNotify("blocked:screen-b:revision-a")).toBe(true)
    expect(other.shouldNotify("blocked:screen-a:revision-b")).toBe(true)
    expect(() => other.shouldNotify("")).toThrow("signature")
    expect(() => other.markNotified("x".repeat(4096), "2026-10-16T04:00:00Z")).toThrow("signature")
    expect(() => other.markNotified("valid", "bad time")).toThrow("timestamp")
  })

  it("refuses unsafe paths, directory/file modes, symlinks and hardlinks", () => {
    expect(() => openCheckInStore("relative.sqlite")).toThrow("path")
    expect(() => openCheckInStore("/tmp/../tmp/checkins.sqlite")).toThrow("path")
    const { store, file } = open()
    store.close()
    fs.chmodSync(path.dirname(file), 0o755)
    expect(() => openCheckInStore(file)).toThrow("directory")
    fs.chmodSync(path.dirname(file), 0o700)
    fs.chmodSync(file, 0o644)
    expect(() => openCheckInStore(file)).toThrow("file")
    fs.chmodSync(file, 0o600)
    fs.linkSync(file, `${file}.hardlink`)
    expect(() => openCheckInStore(file)).toThrow("file")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkins-links-"))
    fs.symlinkSync(path.dirname(file), path.join(root, "linked"))
    expect(() => openCheckInStore(path.join(root, "linked", "db"))).toThrow("directory")
    fs.symlinkSync(file, path.join(root, "db"))
    expect(() => openCheckInStore(path.join(root, "db"))).toThrow("file")
  })

  it("refuses changed directory and file ownership", () => {
    const { store, file } = open()
    store.close()
    const uid = process.getuid!()
    const owner = vi.spyOn(process, "getuid").mockReturnValue(uid + 1)
    expect(() => openCheckInStore(file)).toThrow("directory")
    owner.mockReturnValueOnce(uid).mockReturnValue(uid + 1)
    expect(() => openCheckInStore(file)).toThrow("file")
  })

  it("refuses corrupt SQLite, unsupported schema and corrupt custody rather than replaying", () => {
    const corrupt = location()
    fs.mkdirSync(path.dirname(corrupt), { recursive: true, mode: 0o700 })
    fs.writeFileSync(corrupt, "not SQLite", { mode: 0o600 })
    expect(() => openCheckInStore(corrupt)).toThrow()
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?").run('{"state":"sent"}', claim.id))
    expect(() => store.claimDispatch(input(), "two")).toThrow("schema")
    expect(() => store.completeDispatch(claim.id, "one", { state: "sent" })).toThrow("schema")
    store.close()
    mutate(file, db => db.pragma("user_version = 99"))
    expect(() => openCheckInStore(file)).toThrow("schema")
  })

  it("refuses malformed notice evidence rather than treating it as a delivered notice", () => {
    const { store, file } = open()
    store.markNotified("signature", "2026-10-16T04:00:00Z")
    mutate(file, db => db.prepare("UPDATE notices SET data=?").run('{"at":"fabricated"}'))
    expect(() => store.shouldNotify("signature")).toThrow("schema")
    expect(() => store.markNotified("signature", "2026-10-16T05:00:00Z")).toThrow("schema")
  })

  it("does not swallow filesystem creation failures", () => {
    vi.mocked(fs.openSync).mockImplementationOnce(() => { throw new Error("creation denied") })
    expect(() => openCheckInStore(location())).toThrow("creation denied")
  })

  it("enforces encoded-byte limits on corrupt rows and on valid-looking late metadata", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?").run("x".repeat(4097), claim.id))
    expect(() => store.completeDispatch(claim.id, "one", { state: "sent" })).toThrow("byte")
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?")
      .run(JSON.stringify({ ...claim, reply: "x".repeat(3500) }), claim.id))
    expect(() => store.completeDispatch(claim.id, "one", { state: "unknown", reason: "x".repeat(1022) })).toThrow("byte")
    store.markNotified("signature", "2026-10-16T04:00:00Z")
    mutate(file, db => db.prepare("UPDATE notices SET data=?").run("x".repeat(4097)))
    expect(() => store.shouldNotify("signature")).toThrow("byte")
    expect(() => store.markNotified("x".repeat(3960), `2026-10-16${" ".repeat(200)}`)).toThrow("byte")
  })

  it.each([
    null, { owner: "" }, { owner: "x".repeat(257) }, { state: "pending" },
    { reason: "" }, { reason: "x".repeat(1025) }, { id: "different" },
    { host: "different" }, { session: "different" }, { instance: "different" },
  ])("refuses corrupted dispatch identity or phase: %j", change => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?")
      .run(JSON.stringify(change === null ? null : { ...claim, ...change }), claim.id))
    expect(() => store.completeDispatch(claim.id, "one", { state: "sent" })).toThrow("schema")
  })

  it.each(["host", "session", "instance"] as const)("refuses corruption of indexed %s evidence", column => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "one")!
    mutate(file, db => db.prepare(`UPDATE dispatches SET ${column}=? WHERE id=?`).run("different", claim.id))
    expect(() => store.completeDispatch(claim.id, "one", { state: "sent" })).toThrow("schema")
  })

  it("warns at 48 MiB using telemetry only and refuses writes at 64 MiB without eviction", () => {
    const { store, file } = open()
    mutate(file, db => {
      db.exec("CREATE TABLE capacity_fixture (data BLOB)")
      db.prepare("INSERT INTO capacity_fixture VALUES(zeroblob(?))").run(48 * 1024 * 1024)
    })
    const claim = store.claimDispatch(input(), "one")!
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn", event: "senses.shepherd_checkin_capacity_warning",
    }))
    store.completeDispatch(claim.id, "one", { state: "unknown" })
    mutate(file, db => db.prepare("UPDATE capacity_fixture SET data=zeroblob(?)").run(64 * 1024 * 1024))
    expect(() => store.claimDispatch(input({ session: "other" }), "two")).toThrow("capacity")
    expect(() => store.markNotified("new-signature", "2026-10-16T05:00:00Z")).toThrow("capacity")
    store.close()
    expect(() => openCheckInStore(file)).toThrow("capacity")
  })

  it("binds host receipts to the original request, surface, process and honest input outcome", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "owner")!
    const receipt = {
      requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance!,
      pasteAdmitted: true, submitAdmitted: true,
    }
    expect(() => store.completeDispatch(claim.id, "owner", { state: "sent", receipt: { ...receipt, submitAdmitted: "yes" as never } })).toThrow(/receipt schema/)
    expect(() => store.completeDispatch(claim.id, "owner", { state: "sent", receipt: { ...receipt, pasteAdmitted: false } })).toThrow(/receipt schema/)
    for (const change of [{ requestId: "other" }, { surfaceId: "other" }, { processInstance: "other" }]) {
      expect(() => store.completeDispatch(claim.id, "owner", { state: "sent", receipt: { ...receipt, ...change } })).toThrow(/receipt identity/)
    }
    expect(() => store.completeDispatch(claim.id, "owner", { state: "not_sent", receipt })).toThrow(/contradicts/)
    expect(() => store.completeDispatch(claim.id, "owner", { state: "sent", receipt: { ...receipt, submitAdmitted: false } })).toThrow(/contradicts/)
    store.completeDispatch(claim.id, "owner", { state: "sent", receipt })
    const data = new Database(file, { readonly: true })
    try { expect(JSON.parse((data.prepare("SELECT data FROM dispatches WHERE id=?").get(claim.id) as { data: string }).data)).toMatchObject({ state: "sent", receipt }) } finally { data.close() }
    expect(store.claimDispatch(input(), "retry")).toBeNull()
    const refused = store.claimDispatch(input({ session: "refused" }), "owner")!
    store.completeDispatch(refused.id, "owner", { state: "not_sent", receipt: {
      ...receipt, requestId: refused.id, surfaceId: refused.session, pasteAdmitted: false, submitAdmitted: false,
    } })
    expect(store.claimDispatch(input({ session: "refused" }), "retry")).not.toBeNull()
    const partial = store.claimDispatch(input({ session: "partial" }), "owner")!
    store.completeDispatch(partial.id, "owner", { state: "unknown", receipt: { ...receipt, requestId: partial.id, surfaceId: partial.session, submitAdmitted: false } })
    expect(store.claimDispatch(input({ session: "partial", screenFingerprint: "new" }), "retry")).toBeNull()
  })

  it("refuses corrupt stored receipts rather than treating their partial input as retryable", () => {
    const { store, file } = open()
    const claim = store.claimDispatch(input(), "owner")!
    const receipt = {
      requestId: claim.id, surfaceId: claim.session, workspaceId: "workspace-1", processInstance: claim.instance!,
      pasteAdmitted: true, submitAdmitted: true,
    }
    for (const change of [{ requestId: "other" }, { surfaceId: "other" }, { processInstance: "other" }, { submitAdmitted: "invalid" }]) {
      mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?").run(JSON.stringify({ ...claim, receipt: { ...receipt, ...change } }), claim.id))
      expect(() => store.claimDispatch(input(), "retry")).toThrow(/schema/)
    }
    mutate(file, db => db.prepare("UPDATE dispatches SET data=? WHERE id=?").run(JSON.stringify({ ...claim, state: "not_sent", receipt }), claim.id))
    expect(() => store.claimDispatch(input(), "retry")).toThrow(/schema/)
  })

  it("rejects invalid metadata revisions and exhausted monotonic counters", () => {
    const { file } = open()
    const db = new Database(file)
    try {
      db.prepare("UPDATE custody_meta SET revision=-1").run()
      expect(() => custodyRevision(db)).toThrow(/revision schema/)
      db.prepare("UPDATE custody_meta SET revision=?").run(Number.MAX_SAFE_INTEGER)
      expect(() => advanceCustodyRevision(db)).toThrow(/revision capacity/)
      db.prepare("DELETE FROM custody_meta").run()
      expect(() => custodyRevision(db)).toThrow(/revision schema/)
    } finally { db.close() }
  })

  it("reads missing files without creation and refuses unsupported empty databases", () => {
    const file = location()
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    expect(openCustodyDatabase(file, "read")).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, "", { mode: 0o600 })
    expect(() => openCustodyDatabase(file, "read")).toThrow(/schema/)
  })

  it("validates private journal files instead of trusting a safe main database alone", () => {
    const { store, file } = open()
    store.close()
    fs.writeFileSync(`${file}-journal`, "unsafe", { mode: 0o644 })
    expect(() => openCustodyDatabase(file, "read")).toThrow(/private file/)
  })

  it("does not rerun a migration another process completed before the write lock was acquired", () => {
    const { file } = open()
    const pragma = Database.prototype.pragma
    let initial = true
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      if (initial && source === "user_version") { initial = false; return 0 }
      return pragma.call(this, source, options)
    })
    const other = open(file).store
    expect(other.claimDispatch(input(), "owner")).not.toBeNull()
  })

  it("reports refusal headroom at the capacity boundary without pretending the store is empty", () => {
    const { store, file } = open()
    store.claimDispatch(input(), "owner")
    mutate(file, db => {
      db.exec("CREATE TABLE capacity_fixture (data BLOB)")
      const current = Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true }))
      db.prepare("INSERT INTO capacity_fixture VALUES(zeroblob(?))").run(64 * 1024 * 1024 - current - 65536)
    })
    const db = openCustodyDatabase(file, "read")!
    try {
      expect(custodyCapacity(db)).toMatchObject({ capacity: "refused" })
      expect(custodyCapacity(db).bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    } finally { db.close() }
    expect(() => store.claimDispatch(input({ session: "new" }), "retry")).toThrow(/capacity/)
  })
})
