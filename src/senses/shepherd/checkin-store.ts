import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { emitNervesEvent } from "../../nerves/runtime"
import { shepherdStateDir } from "./returns"
import type { ShepherdDispatchReceipt, ShepherdInputReceipt, ShepherdManagedInputReceipt, ShepherdNativeTarget } from "../../heart/shepherd/custody-types"
import { copyManagedIdentity, copyManagedReceipt, managedInstanceKey, sameManagedIdentity, validManagedIdentity, validManagedReceipt } from "./managed-evidence"

export interface DispatchInput {
  host: string
  session: string
  instance: string | null
  /** Hash of redacted judge text, not the raw inspection digest or human-send proof. */
  screenFingerprint: string
  guidanceRevision: string
  reply: string
  trigger: "immediate" | "network" | "periodic"
  transition: string
  at: string
  nativeTarget?: ShepherdNativeTarget
}
export interface DispatchClaim extends DispatchInput {
  id: string
  /** Absent on legacy custody; never synthesized while reopening an existing attempt. */
  nativeRequestId?: string
  owner: string
  state: "claimed" | "sent" | "not_sent" | "unknown"
  reason?: string
  receipt?: ShepherdDispatchReceipt
}
export interface DispatchResult {
  state: "sent" | "not_sent" | "unknown"
  reason?: string
  receipt?: ShepherdDispatchReceipt
  nativeRequestId?: string
}
export interface CheckInStore {
  claimDispatch(input: DispatchInput, owner: string): DispatchClaim | null
  completeDispatch(id: string, owner: string, result: DispatchResult): void
  shouldNotify(signature: string): boolean
  markNotified(signature: string, at: string): void
  close(): void
}

export interface DispatchRow { id: string; host: string; session: string; instance: string | null; data: string }
interface Notice { signature: string; at: string }
const MAX_ROW = 4096
const COMPLETION_HEADROOM = 2300
const MAX_DB = 64 * 1024 * 1024
const WARN_DB = 48 * 1024 * 1024
const warnedDatabases = new WeakSet<Database.Database>()
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
export function refuseCustody(reason: string): never {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_checkin_store_refused",
    message: "check-in custody operation refused", meta: { reason } })
  throw new Error(`Shepherd check-in custody: ${reason}`)
}
const refuse: (reason: string) => never = refuseCustody
function bounded(value: unknown, limit: number, field: string): asserts value is string {
  if (!text(value) || bytes(value) > limit) refuse(`${field} byte limit or type`)
}
function validInput(value: unknown): value is DispatchInput {
  const nativeTarget = object(value) ? value.nativeTarget : undefined
  return object(value) && ["host", "session", "screenFingerprint", "guidanceRevision", "reply", "transition"].every(key => text(value[key])) &&
    (value.instance === null || text(value.instance)) && ["immediate", "network", "periodic"].includes(String(value.trigger)) && timestamp(value.at)
    && (nativeTarget === undefined || object(nativeTarget) && Object.keys(nativeTarget).length === 2
      && (nativeTarget.kind === "agent_session"
        ? validManagedIdentity(nativeTarget.identity) && typeof value.session === "string" && nativeTarget.identity.surfaceId === value.session.toLowerCase() &&
          managedInstanceKey(nativeTarget.identity) === value.instance
        : ["hostInstance", "workspaceId"].every(key => text(nativeTarget[key]) && bytes(nativeTarget[key]) <= 256)))
}
function dispatchId(input: DispatchInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.host, input.session, input.instance, input.screenFingerprint, input.guidanceRevision,
  ])).digest("hex")
}
function validClaim(value: unknown): value is DispatchClaim {
  return object(value) && validInput(value) && text(value.id) && text(value.owner) && bytes(value.owner) <= 256 &&
    (value.nativeRequestId === undefined || typeof value.nativeRequestId === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nativeRequestId)) &&
    (value.nativeTarget === undefined || value.nativeRequestId !== undefined) &&
    ["claimed", "sent", "not_sent", "unknown"].includes(String(value.state)) &&
    (value.reason === undefined || text(value.reason) && bytes(value.reason) <= 1024)
    && (value.receipt === undefined || validCustodyInputReceipt(value.receipt)
      && receiptMatchesClaim({ id: value.id, session: value.session, instance: value.instance,
        nativeTarget: value.nativeTarget, nativeRequestId: value.nativeRequestId }, value.receipt)
      && receiptMatchesOutcome(value.state, value.receipt))
}
export function validCustodyInputReceipt(value: unknown): value is ShepherdDispatchReceipt {
  if (object(value) && value.kind === "agent_session") return validManagedReceipt(value)
  return object(value) && value.kind === undefined && ["requestId", "surfaceId", "workspaceId", "processInstance"].every(key => text(value[key]) && bytes(value[key]) <= 256)
    && typeof value.pasteAdmitted === "boolean" && typeof value.submitAdmitted === "boolean"
    && (!value.submitAdmitted || value.pasteAdmitted)
}
export function copyCustodyInputReceipt(receipt: ShepherdManagedInputReceipt): ShepherdManagedInputReceipt
export function copyCustodyInputReceipt(receipt: ShepherdInputReceipt): ShepherdInputReceipt
export function copyCustodyInputReceipt(receipt: ShepherdDispatchReceipt): ShepherdDispatchReceipt
export function copyCustodyInputReceipt(receipt: ShepherdDispatchReceipt): ShepherdDispatchReceipt {
  if (receipt.kind === "agent_session") return copyManagedReceipt(receipt)
  const { requestId, surfaceId, workspaceId, processInstance, pasteAdmitted, submitAdmitted } = receipt
  return { requestId, surfaceId, workspaceId, processInstance, pasteAdmitted, submitAdmitted }
}
export function receiptMatchesClaim(claim: Pick<DispatchClaim, "id" | "session" | "instance" | "nativeTarget" | "nativeRequestId">,
  receipt: ShepherdDispatchReceipt): boolean {
  if (receipt.requestId !== claim.id) return false
  if (receipt.kind === "agent_session") {
    return claim.nativeTarget?.kind === "agent_session" && receipt.nativeRequestId === claim.nativeRequestId &&
      receipt.identity.surfaceId === claim.session.toLowerCase() && managedInstanceKey(receipt.identity) === claim.instance &&
      sameManagedIdentity(receipt.identity, claim.nativeTarget.identity)
  }
  return claim.nativeTarget?.kind !== "agent_session" && receipt.surfaceId === claim.session &&
    receipt.processInstance === claim.instance && (claim.nativeTarget === undefined || receipt.workspaceId === claim.nativeTarget.workspaceId)
}
export function receiptMatchesOutcome(state: unknown, receipt: ShepherdDispatchReceipt): boolean {
  if (receipt.kind === "agent_session") return state === "sent"
    ? receipt.editorInserted && receipt.backendWriteAdmitted && receipt.providerAcknowledged
    : state === "not_sent" ? !receipt.editorInserted && !receipt.backendWriteAdmitted && !receipt.providerAcknowledged
      : !(receipt.editorInserted && receipt.backendWriteAdmitted && receipt.providerAcknowledged)
  return state === "sent" ? receipt.pasteAdmitted && receipt.submitAdmitted : state !== "not_sent" || !receipt.pasteAdmitted && !receipt.submitAdmitted
}
export function parseCustodyDispatch(row: DispatchRow, schemaVersion = 2): DispatchClaim {
  if (Buffer.byteLength(row.data) > MAX_ROW) refuse("record byte limit")
  const value: unknown = JSON.parse(row.data)
  if (!validClaim(value) || value.id !== row.id || dispatchId(value) !== row.id || value.host !== row.host ||
    value.session !== row.session || value.instance !== row.instance ||
    schemaVersion < 3 && (value.nativeTarget?.kind === "agent_session" || value.receipt?.kind === "agent_session")) refuse("invalid dispatch schema")
  return value
}
export function validateCustodyDirectory(directory: string, create: boolean): boolean {
  const uid = process.getuid!()
  for (let candidate = directory; candidate !== path.dirname(candidate); candidate = path.dirname(candidate)) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) refuse("private directory ancestor is a link")
    if (stat && (!stat.isDirectory() || stat.uid !== 0 && stat.uid !== uid
      || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) refuse("private directory ancestor ownership or mode")
  }
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return false
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || stat.uid !== uid) refuse("private directory ownership or mode; require 0700")
  return true
}
function privateFile(file: string): void {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid!()) refuse("private file ownership or mode")
}

export function checkInStorePath(agentRoot: string): string {
  return path.join(shepherdStateDir(agentRoot), "checkins", "custody.sqlite")
}

export function assertNoCustodyMaintenance(file: string): void {
  if (fs.lstatSync(`${file}.maintenance.json`, { throwIfNoEntry: false })) refuse("interrupted or active maintenance; resume the exact owner maintenance request")
}

export function custodyCapacity(database: Database.Database, writing = false): { bytes: number; capacity: "normal" | "warning" | "refused" } {
  const size = Number(database.pragma("page_count", { simple: true })) * Number(database.pragma("page_size", { simple: true }))
  if (size > MAX_DB || writing && size + 65536 > MAX_DB) refuse("database capacity; no input authorized")
  if (!warnedDatabases.has(database) && size >= WARN_DB) {
    warnedDatabases.add(database)
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_checkin_capacity_warning",
      message: "check-in custody is approaching capacity", meta: { bytes: size, limit: MAX_DB } })
  }
  return { bytes: size, capacity: size + 65536 > MAX_DB ? "refused" : size >= WARN_DB ? "warning" : "normal" }
}

export function custodyRevision(database: Database.Database): number {
  const row = database.prepare("SELECT revision FROM custody_meta WHERE singleton=1").get() as { revision: unknown } | undefined
  if (!row || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) refuse("invalid custody revision schema")
  return row.revision
}
export function advanceCustodyRevision(database: Database.Database): number {
  const revision = custodyRevision(database) + 1
  if (!Number.isSafeInteger(revision)) refuse("custody revision capacity")
  database.prepare("UPDATE custody_meta SET revision=? WHERE singleton=1").run(revision)
  return revision
}
export function hasRetiredCustodyInstance(database: Database.Database, input: { host: string; session: string; instance: string | null }): boolean {
  const row = database.prepare(`SELECT key,host,session,instance,data FROM retired_instances WHERE host=? AND session=?
    AND (instance IS NULL OR ? IS NULL OR instance=?) LIMIT 1`).get(input.host, input.session, input.instance, input.instance) as
    RetiredRow | undefined
  if (!row) return false
  validateRetiredRow(row)
  return true
}
interface RetiredRow { key: string; host: string; session: string; instance: string | null; data: string }
export function retiredCustodyKey(input: { host: string; session: string; instance: string | null }): string {
  return createHash("sha256").update(JSON.stringify([input.host, input.session, input.instance])).digest("hex")
}
export function readRetiredCustodyRecord(database: Database.Database, input: { host: string; session: string; instance: string | null }): Record<string, unknown> | null {
  const row = database.prepare("SELECT key,host,session,instance,data FROM retired_instances WHERE key=?").get(retiredCustodyKey(input)) as RetiredRow | undefined
  return row ? validateRetiredRow(row) : null
}
function validateRetiredRow(row: RetiredRow): Record<string, unknown> {
  if (Buffer.byteLength(row.data) > MAX_ROW) refuse("retired instance index capacity")
  const data: unknown = JSON.parse(row.data)
  const expectedKey = retiredCustodyKey(row)
  if (!object(data) || !object(data.proof) || row.key !== expectedKey || data.proof.kind !== "host_process_inventory"
    || data.proof.host !== row.host || data.proof.session !== row.session || data.proof.instance !== row.instance
    || data.proof.gone !== true || !timestamp(data.proof.checkedAt) || typeof data.proof.wholeSessionRetired !== "boolean"
    || row.instance === null && !data.proof.wholeSessionRetired) refuse("invalid retired instance schema")
  if (data.archive !== undefined && (!object(data.archive) || typeof data.archive.path !== "string" || !path.isAbsolute(data.archive.path)
    || typeof data.archive.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.archive.digest))) refuse("invalid retired archive reference schema")
  return data
}

export function openCustodyDatabase(file: string, mode: "read" | "maintenance-read"): Database.Database | null
export function openCustodyDatabase(file: string, mode: "write" | "maintenance"): Database.Database
export function openCustodyDatabase(file: string, mode: "read" | "maintenance-read" | "write" | "maintenance"): Database.Database | null {
  const readonly = mode === "read" || mode === "maintenance-read"
  if (!path.isAbsolute(file) || path.normalize(file) !== file) refuse("database path")
  if (mode !== "maintenance" && mode !== "maintenance-read") assertNoCustodyMaintenance(file)
  if (!validateCustodyDirectory(path.dirname(file), !readonly)) return null
  if (readonly) {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null
  } else {
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      fs.closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  privateFile(file)
  for (const suffix of ["-journal", "-wal", "-shm"]) if (fs.lstatSync(`${file}${suffix}`, { throwIfNoEntry: false })) privateFile(`${file}${suffix}`)
  const database = new Database(file, { fileMustExist: true, readonly })
  try {
    const version = database.pragma("user_version", { simple: true })
    if (![0, 1, 2, 3].includes(Number(version)) || version === 0 && readonly) refuse("unsupported database schema")
    custodyCapacity(database)
    database.pragma("busy_timeout = 1000")
    if (version !== 0) {
      database.prepare("SELECT id,host,session,instance,data FROM dispatches LIMIT 0").all()
      database.prepare("SELECT signature,data FROM notices LIMIT 0").all()
    }
    if (readonly) {
      if (version === 2 || version === 3) validateCustodyV2(database)
      return database
    }
    database.pragma("journal_mode = DELETE")
    database.pragma("synchronous = FULL")
    database.pragma(`max_page_count = ${Math.floor(MAX_DB / Number(database.pragma("page_size", { simple: true })))}`)
    if (version !== 2 && version !== 3) database.transaction(() => {
      if ([2, 3].includes(Number(database.pragma("user_version", { simple: true })))) return
      database.exec(`CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY NOT NULL, host TEXT NOT NULL, session TEXT NOT NULL, instance TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatch_barriers ON dispatches(host,session,instance);
      CREATE TABLE IF NOT EXISTS notices (signature TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
      CREATE TABLE custody_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      INSERT INTO custody_meta VALUES(1,0);
      CREATE TABLE custody_requests (actor_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
      CREATE TABLE reconciliations (id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX reconciliation_dispatch ON reconciliations(dispatch_id);
      CREATE TABLE retired_instances (key TEXT PRIMARY KEY,host TEXT NOT NULL,session TEXT NOT NULL,instance TEXT,data TEXT NOT NULL);
      CREATE INDEX retired_scope ON retired_instances(host,session,instance);
      CREATE TABLE custody_migrations (version INTEGER PRIMARY KEY,data TEXT NOT NULL);`)
      for (const row of database.prepare("SELECT id,host,session,instance,data FROM dispatches").iterate() as Iterable<DispatchRow>) parseCustodyDispatch(row)
      const counts = database.prepare("SELECT COUNT(*) AS count FROM dispatches").get() as { count: number }
      database.prepare("INSERT INTO custody_migrations VALUES(2,?)").run(JSON.stringify({ fromVersion: version, at: new Date().toISOString(), preservedDispatches: counts.count }))
      database.pragma("user_version = 2")
    }).immediate()
    validateCustodyV2(database)
    const schemaVersion = Number(database.pragma("user_version", { simple: true }))
    for (const row of database.prepare("SELECT id,host,session,instance,data FROM dispatches").iterate() as Iterable<DispatchRow>) parseCustodyDispatch(row, schemaVersion)
  } catch (error) { database.close(); throw error }
  return database
}

function validateCustodyV2(database: Database.Database): void {
  custodyRevision(database)
  for (const query of [
    "SELECT actor_id,request_id,hash,receipt FROM custody_requests LIMIT 0",
    "SELECT id,dispatch_id,data FROM reconciliations LIMIT 0",
    "SELECT key,host,session,instance,data FROM retired_instances LIMIT 0",
    "SELECT version,data FROM custody_migrations LIMIT 0",
  ]) database.prepare(query).all()
  for (const row of database.prepare("SELECT key,host,session,instance,data FROM retired_instances").iterate() as Iterable<RetiredRow>) validateRetiredRow(row)
}

export function openCheckInStore(file: string): CheckInStore {
  const database = openCustodyDatabase(file, "write")
  const parseDispatch = (row: DispatchRow) => parseCustodyDispatch(row, Number(database.pragma("user_version", { simple: true })))
  const transact = <T>(work: () => T): T => database.transaction(() => {
    assertNoCustodyMaintenance(file)
    custodyCapacity(database, true)
    return work()
  }).immediate()
  function write(record: DispatchClaim): void {
    const data = JSON.stringify(record)
    if (Buffer.byteLength(data) > MAX_ROW) refuse("record byte limit")
    database.prepare(`INSERT INTO dispatches(id,host,session,instance,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, record.host, record.session, record.instance, data)
    advanceCustodyRevision(database)
  }
  function notice(signature: string): Notice | null {
    bounded(signature, MAX_ROW - 128, "signature")
    const row = database.prepare("SELECT data FROM notices WHERE signature=?").get(signature) as { data: string } | undefined
    if (!row) return null
    if (Buffer.byteLength(row.data) > MAX_ROW) refuse("notice byte limit")
    const value: unknown = JSON.parse(row.data)
    if (!object(value) || value.signature !== signature || !timestamp(value.at)) refuse("invalid notice schema")
    return { signature, at: value.at }
  }
  emitNervesEvent({ component: "senses", event: "senses.shepherd_checkin_store_opened",
    message: "opened private check-in custody", meta: { status: "ready" } })
  return {
    claimDispatch(input, owner) {
      if (!validInput(input)) refuse("invalid dispatch input schema")
      bounded(owner, 256, "owner")
      const record: DispatchClaim = { ...input,
        ...(input.nativeTarget?.kind === "agent_session" ? { nativeTarget: {
          kind: "agent_session", identity: copyManagedIdentity(input.nativeTarget.identity),
        } } : {}), id: dispatchId(input), nativeRequestId: randomUUID(), owner, state: "claimed" }
      if (bytes(record) + COMPLETION_HEADROOM > MAX_ROW) refuse("reserved record byte limit")
      return transact(() => {
        if (record.nativeTarget?.kind === "agent_session" && database.pragma("user_version", { simple: true }) === 2) {
          database.prepare("INSERT INTO custody_migrations VALUES(3,?)").run(JSON.stringify({ fromVersion: 2, at: input.at }))
          database.pragma("user_version = 3")
        }
        if (hasRetiredCustodyInstance(database, input)) return null
        const rows = database.prepare(`SELECT id,host,session,instance,data FROM dispatches
          WHERE id=? OR (host=? AND session=? AND (instance IS NULL OR ? IS NULL OR instance=?))`)
          .all(record.id, input.host, input.session, input.instance, input.instance) as DispatchRow[]
        for (const row of rows) {
          const prior = parseDispatch(row)
          if (prior.state === "claimed" || prior.state === "unknown"
            || prior.id === record.id && (prior.state === "sent" || prior.nativeRequestId === undefined)) return null
        }
        write(record)
        return record
      })
    },
    completeDispatch(id, owner, result) {
      bounded(owner, 256, "owner")
      if (!object(result) || !["sent", "not_sent", "unknown"].includes(result.state)) refuse("invalid completion state")
      if (result.reason !== undefined) bounded(result.reason, 1024, "reason")
      if (result.receipt !== undefined && !validCustodyInputReceipt(result.receipt)) refuse("invalid host receipt schema")
      if (result.receipt && !receiptMatchesOutcome(result.state, result.receipt)) refuse("host receipt contradicts completion outcome")
      transact(() => {
        const row = database.prepare("SELECT id,host,session,instance,data FROM dispatches WHERE id=?").get(id) as DispatchRow | undefined
        if (!row) refuse("unknown dispatch owner")
        const prior = parseDispatch(row)
        if (prior.owner !== owner || prior.state !== "claimed") refuse("dispatch owner or phase mismatch")
        if ((prior.nativeTarget !== undefined || result.nativeRequestId !== undefined)
          && result.nativeRequestId !== prior.nativeRequestId) refuse("native attempt identity mismatch")
        if (result.receipt && !receiptMatchesClaim(prior, result.receipt)) refuse("host receipt identity mismatch")
        write({ ...prior, state: result.state, ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.receipt === undefined ? {} : { receipt: copyCustodyInputReceipt(result.receipt) }) })
      })
    },
    shouldNotify(signature) { return notice(signature) === null },
    markNotified(signature, at) {
      bounded(signature, MAX_ROW - 128, "signature")
      if (!timestamp(at)) refuse("invalid notification timestamp")
      const data = JSON.stringify({ signature, at })
      if (Buffer.byteLength(data) > MAX_ROW) refuse("notice byte limit")
      transact(() => {
        if (!notice(signature)) {
          database.prepare("INSERT INTO notices(signature,data) VALUES(?,?)").run(signature, data)
          advanceCustodyRevision(database)
        }
      })
    },
    close() { database.close() },
  }
}
