import type {
  ShepherdCustodyEntry, ShepherdCustodySnapshot, ShepherdInputReceipt, ShepherdMaintenanceReceipt, ShepherdMaintenanceRequest,
  ShepherdRecoveryEvidence, ShepherdRecoveryReceipt, ShepherdRecoveryRequest, ShepherdRetirementProof,
} from "../../heart/shepherd/custody-types"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type Database from "better-sqlite3"
import { withFileLock } from "../../heart/file-lock"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  advanceCustodyRevision, checkInStorePath, copyCustodyInputReceipt, custodyCapacity, custodyRevision, openCustodyDatabase,
  hasRetiredCustodyInstance, parseCustodyDispatch, readRetiredCustodyRecord, refuseCustody, retiredCustodyKey,
  validCustodyInputReceipt, validateCustodyDirectory, type DispatchClaim, type DispatchRow,
} from "./checkin-store"
import { redactSecrets } from "./redact"

const refuse: (reason: string) => never = refuseCustody
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value)
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")
function canonical(value: unknown): string {
  return JSON.stringify(value, (_name, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
function validActor(request: { actor: unknown; requestId: unknown; expectedRevision: unknown }): boolean {
  return object(request.actor) && request.actor.kind === "local_owner_administration" && identity(request.actor.actorId)
    && identity(request.requestId) && typeof request.expectedRevision === "number" && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0
}
function fresh(value: unknown): boolean {
  return timestamp(value) && Date.parse(value) <= Date.now() && Date.now() - Date.parse(value) <= 30_000
}
function validRetirementShape(value: unknown): value is ShepherdRetirementProof {
  return object(value) && value.kind === "host_process_inventory" && identity(value.host) && identity(value.session)
    && (value.instance === null || identity(value.instance)) && timestamp(value.checkedAt) && value.gone === true && typeof value.wholeSessionRetired === "boolean"
}
const validRetirement = (value: unknown): value is ShepherdRetirementProof => validRetirementShape(value) && fresh(value.checkedAt)
function copyRetirement(proof: ShepherdRetirementProof): ShepherdRetirementProof {
  const { kind, host, session, instance, checkedAt, gone, wholeSessionRetired } = proof
  return { kind, host, session, instance, checkedAt, gone, wholeSessionRetired }
}
function parseJson(value: string, maxBytes = 8192): unknown {
  if (Buffer.byteLength(value) > maxBytes) refuse("recovery record byte limit")
  return JSON.parse(value)
}
function validRecoveryReceipt(value: unknown): value is ShepherdRecoveryReceipt {
  return object(value) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && identity(value.dispatchId)
    && ["acknowledged_delivery", "retired_instance"].includes(String(value.resolution))
    && ["claimed", "sent", "unknown"].includes(String(value.originalState)) && timestamp(value.at) && identity(value.actorId) && identity(value.requestId)
}
function auditRow(data: string): { receipt: ShepherdRecoveryReceipt; evidence: unknown } {
  const parsed = parseJson(data)
  if (!object(parsed) || !validRecoveryReceipt(parsed.receipt)) refuse("invalid recovery audit schema")
  return { receipt: parsed.receipt, evidence: parsed.evidence }
}
function reconciliationRows(db: Database.Database, claim: DispatchClaim): { receipts: ShepherdRecoveryReceipt[]; count: number; receipt: ShepherdInputReceipt | null } {
  const dispatchId = claim.id
  const count = db.prepare("SELECT COUNT(*) AS count FROM reconciliations WHERE dispatch_id=?").get(dispatchId) as { count: number }
  const rows = db.prepare("SELECT data FROM reconciliations WHERE dispatch_id=? ORDER BY rowid DESC LIMIT 20").all(dispatchId) as Array<{ data: string }>
  let receipt: ShepherdInputReceipt | null = null
  const receipts = rows.map(row => {
    const audit = auditRow(row.data)
    if (audit.receipt.dispatchId !== dispatchId) refuse("recovery dispatch identity mismatch")
    if (audit.receipt.resolution === "acknowledged_delivery") {
      if (!matchesReceipt(claim, audit.evidence, false)) refuse("invalid recovery host receipt schema")
      receipt ??= copyCustodyInputReceipt(audit.evidence.receipt)
    } else if (!validRetirementShape(audit.evidence) || audit.evidence.host !== claim.host || audit.evidence.session !== claim.session
      || audit.evidence.instance !== claim.instance || audit.evidence.instance === null && !audit.evidence.wholeSessionRetired) {
      refuse("invalid recovery retirement proof schema")
    }
    return audit.receipt
  })
  return { receipts, count: count.count, receipt }
}

type InspectionOptions = { limit: number; cursor?: string; id?: string }
export function readCheckInSnapshot(file: string, options: InspectionOptions): ShepherdCustodySnapshot {
  return readCustodySnapshot(file, options, "read")
}

/** Recovery may inspect a held marker only after trusted daemon quiescence; this never opens a writer. */
export function readMaintenanceCheckInSnapshot(file: string, options: InspectionOptions, sense: ShepherdMaintenanceRequest["sense"]): ShepherdCustodySnapshot {
  requireStoppedSense({ sense })
  return readCustodySnapshot(file, options, "maintenance-read")
}

function readCustodySnapshot(file: string, options: InspectionOptions, mode: "read" | "maintenance-read"): ShepherdCustodySnapshot {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200) refuse("inspection limit must be 1..200")
  if (options.id !== undefined && (!/^[a-f0-9]{64}$/.test(options.id) || options.cursor !== undefined)) refuse("invalid inspection ID or conflicting cursor")
  let cursor: { after: string; revision: number } | null = null
  if (options.cursor !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) } catch { refuse("invalid inspection cursor") }
    if (options.cursor.length > 200 || !object(parsed) || typeof parsed.after !== "string" || !/^[a-f0-9]{64}$/.test(parsed.after)
      || typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) refuse("invalid inspection cursor")
    cursor = { after: parsed.after, revision: parsed.revision }
  }
  const db = openCustodyDatabase(file, mode)
  if (!db) return {
    state: "missing", schemaVersion: null, revision: null, bytes: null, capacity: "unknown",
    totalCount: null, noticeCount: null, counts: null, entries: [], nextCursor: null,
  }
  try {
    return db.transaction((): ShepherdCustodySnapshot => {
      const schemaVersion = Number(db.pragma("user_version", { simple: true })) as 1 | 2
      const revision = schemaVersion === 2 ? custodyRevision(db) : 0
      if (cursor && cursor.revision !== revision) refuse("inspection cursor revision conflict")
      const capacity = custodyCapacity(db)
      const total = db.prepare("SELECT COUNT(*) AS count FROM dispatches").get() as { count: number }
      const notices = db.prepare("SELECT COUNT(*) AS count FROM notices").get() as { count: number }
      const grouped = db.prepare("SELECT json_extract(data,'$.state') AS state,COUNT(*) AS count FROM dispatches GROUP BY json_extract(data,'$.state')").all() as Array<{ state: string; count: number }>
      const counts: NonNullable<ShepherdCustodySnapshot["counts"]> = { claimed: 0, sent: 0, not_sent: 0, unknown: 0 }
      for (const group of grouped) {
        if (!["claimed", "sent", "not_sent", "unknown"].includes(group.state)) refuse("invalid custody state schema")
        counts[group.state as keyof typeof counts] = group.count
      }
      const rows = (options.id !== undefined
        ? db.prepare("SELECT id,host,session,instance,data FROM dispatches WHERE id=?").all(options.id)
        : db.prepare("SELECT id,host,session,instance,data FROM dispatches WHERE id>? ORDER BY id LIMIT ?").all(cursor?.after ?? "", options.limit + 1)) as DispatchRow[]
      const page = rows.slice(0, options.limit)
      const entries = page.map(row => {
        const claim = parseCustodyDispatch(row)
        const audit = schemaVersion === 2 ? reconciliationRows(db, claim) : { receipts: [], count: 0, receipt: null }
        const retired = schemaVersion === 2 && hasRetiredCustodyInstance(db, claim)
        const entry: ShepherdCustodyEntry = {
          id: claim.id, host: claim.host, session: claim.session, instance: claim.instance, state: claim.state, trigger: claim.trigger,
          claimedAt: claim.at, reason: claim.reason === undefined ? null : redactSecrets(claim.reason), retired,
          receipt: claim.receipt ? copyCustodyInputReceipt(claim.receipt) : audit.receipt, reconciliations: audit.receipts, reconciliationCount: audit.count,
        }
        return entry
      })
      return {
        state: "ready", schemaVersion, revision, ...capacity, totalCount: total.count, noticeCount: notices.count, counts, entries,
        nextCursor: rows.length > options.limit ? Buffer.from(JSON.stringify({ after: page.at(-1)!.id, revision })).toString("base64url") : null,
      }
    })()
  } finally { db.close() }
}

function priorRequest<T>(db: Database.Database, request: { actor: { actorId: string }; requestId: string }, hash: string, validate: (value: unknown) => value is T): T | null {
  const row = db.prepare("SELECT hash,receipt FROM custody_requests WHERE actor_id=? AND request_id=?").get(request.actor.actorId, request.requestId) as { hash: string; receipt: string } | undefined
  if (!row) return null
  if (row.hash !== hash) refuse("owner request ID was already used with different arguments")
  const receipt = parseJson(row.receipt)
  if (!validate(receipt)) refuse("invalid owner request receipt schema")
  return receipt
}
function rememberRequest(db: Database.Database, request: { actor: { actorId: string }; requestId: string }, hash: string, receipt: unknown): void {
  const serialized = JSON.stringify(receipt)
  db.prepare("INSERT INTO custody_requests(actor_id,request_id,hash,receipt) VALUES(?,?,?,?)").run(request.actor.actorId, request.requestId, hash, serialized)
}
function retireInstance(db: Database.Database, proof: ShepherdRetirementProof, provenance: unknown, archive?: { path: string; digest: string }): void {
  if (proof.instance === null && !proof.wholeSessionRetired) refuse("null instance requires whole session retirement proof")
  const prior = readRetiredCustodyRecord(db, proof)
  if (prior && !archive) return
  if (prior?.archive !== undefined && canonical(prior.archive) !== canonical(archive)) refuse("retired instance archive reference already assigned; manual maintenance required")
  if (Buffer.byteLength(JSON.stringify({ ...(prior ?? { proof, provenance }), ...(archive === undefined ? {} : { archive }) })) > 4096) refuse("retired instance index capacity")
  const data = JSON.stringify({ ...(prior ?? { proof: copyRetirement(proof), provenance }), ...(archive === undefined ? {} : { archive }) })
  db.prepare(`INSERT INTO retired_instances(key,host,session,instance,data) VALUES(?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET data=excluded.data`).run(retiredCustodyKey(proof), proof.host, proof.session, proof.instance, data)
}
function matchesReceipt(claim: DispatchClaim, evidence: unknown, requireFresh = true): evidence is { kind: "guarded_host_receipt_v1"; host: string; checkedAt: string; receipt: ShepherdInputReceipt } {
  return object(evidence) && evidence.kind === "guarded_host_receipt_v1" && timestamp(evidence.checkedAt) && (!requireFresh || fresh(evidence.checkedAt))
    && evidence.host === claim.host && validCustodyInputReceipt(evidence.receipt)
    && evidence.receipt.requestId === claim.id && evidence.receipt.surfaceId === claim.session
    && evidence.receipt.processInstance === claim.instance && evidence.receipt.pasteAdmitted && evidence.receipt.submitAdmitted
}

export async function reconcileShepherdDispatch(root: string, request: ShepherdRecoveryRequest): Promise<ShepherdRecoveryReceipt> {
  if (!object(request) || !validActor(request) || !identity(request.id)) refuse("invalid owner reconciliation request")
  request = structuredClone(request)
  const hash = digest(canonical({ operation: "reconcile", request: { ...request, evidence: { ...request.evidence, checkedAt: undefined } } }))
  const file = checkInStorePath(root)
  // Do not turn a missing ledger into a new source of authority.
  const inspection = readCheckInSnapshot(file, { limit: 1 })
  if (inspection.state === "missing") refuse("custody store is missing")
  return withFileLock(path.dirname(file), "operations", () => {
    const db = openCustodyDatabase(file, "write")
    try {
      let mutated = false
      const result = db.transaction(() => {
        custodyCapacity(db, true)
        const prior = priorRequest(db, request, hash, validRecoveryReceipt)
        if (prior) return prior
        if (custodyRevision(db) !== request.expectedRevision) refuse("reconciliation revision conflict")
        const row = db.prepare("SELECT id,host,session,instance,data FROM dispatches WHERE id=?").get(request.id) as DispatchRow | undefined
        if (!row) refuse("dispatch not found")
        const claim = parseCustodyDispatch(row)
        if (claim.state === "not_sent") refuse("definite not-sent dispatch requires no reconciliation")
        let resolution: ShepherdRecoveryReceipt["resolution"]
        let retirement: ShepherdRetirementProof | null = null
        let verifiedEvidence: ShepherdRecoveryEvidence
        if (matchesReceipt(claim, request.evidence)) {
          resolution = "acknowledged_delivery"
          verifiedEvidence = {
            kind: request.evidence.kind, host: request.evidence.host, checkedAt: request.evidence.checkedAt,
            receipt: copyCustodyInputReceipt(request.evidence.receipt),
          }
        } else if (validRetirement(request.evidence) && request.evidence.host === claim.host
          && request.evidence.session === claim.session && request.evidence.instance === claim.instance) {
          resolution = "retired_instance"
          retirement = request.evidence
          verifiedEvidence = copyRetirement(request.evidence)
        } else refuse("matching confirmed host receipt or fresh exact gone-instance proof required")
        const receipt: ShepherdRecoveryReceipt = {
          revision: advanceCustodyRevision(db), dispatchId: claim.id, resolution, originalState: claim.state,
          at: new Date(Date.now()).toISOString(), actorId: request.actor.actorId, requestId: request.requestId,
        }
        if (retirement) retireInstance(db, retirement, receipt)
        if (Buffer.byteLength(JSON.stringify({ receipt, evidence: request.evidence })) > 8192) refuse("recovery record byte limit")
        const audit = JSON.stringify({ receipt, evidence: verifiedEvidence })
        db.prepare("INSERT INTO reconciliations(id,dispatch_id,data) VALUES(?,?,?)").run(digest(JSON.stringify([request.actor.actorId, request.requestId])), claim.id, audit)
        rememberRequest(db, request, hash, receipt)
        mutated = true
        return receipt
      }).immediate()
      if (mutated) emitNervesEvent({ component: "senses", event: "senses.shepherd_dispatch_reconciled", message: "appended custody reconciliation without rewriting original outcome", meta: { resolution: result.resolution, revision: result.revision } })
      return result
    } finally { db.close() }
  })
}
interface MaintenanceIntent {
  version: 1
  hash: string
  sourceDigest: string
  sourceRevision: number
  stage: "copying" | "prepared"
  archive: string
  replacement: string
  archiveDigest: string | null
  replacementDigest: string | null
  receipt: ShepherdMaintenanceReceipt | null
}

function syncFile(file: string): void {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
}
function syncDirectory(dir: string): void {
  const handle = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
}
function privateRegular(file: string, maxBytes: number): void {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600 || stat.size > maxBytes) refuse("maintenance private file ownership, mode, link or byte limit")
}
function fileDigest(file: string): string {
  privateRegular(file, 64 * 1024 * 1024)
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65536)
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (!count) break
      hash.update(buffer.subarray(0, count))
    }
    return hash.digest("hex")
  } finally { fs.closeSync(handle) }
}
function writePrivateJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  syncFile(temp)
  fs.renameSync(temp, file)
  syncDirectory(path.dirname(file))
}
function maintenanceDirectory(dir: string, create: boolean): void {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) refuse("maintenance destination must be an exact absolute path")
  validateCustodyDirectory(dir, create)
}
function validMaintenanceReceipt(value: unknown): value is ShepherdMaintenanceReceipt {
  return object(value) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && identity(value.requestId) && identity(value.actorId)
    && Number.isSafeInteger(value.archivedCount) && Number(value.archivedCount) >= 0 && Number.isSafeInteger(value.retainedCount) && Number(value.retainedCount) >= 0
    && typeof value.archive === "string" && path.isAbsolute(value.archive) && typeof value.archiveDigest === "string" && /^[a-f0-9]{64}$/.test(value.archiveDigest) && timestamp(value.at)
}
function readIntent(file: string, hash: string, archive: string, replacementPrefix: string): MaintenanceIntent | null {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null
  privateRegular(file, 8192)
  const value = parseJson(fs.readFileSync(file, "utf8"))
  if (!object(value) || value.version !== 1 || value.hash !== hash || typeof value.sourceRevision !== "number" || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0
    || typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || value.archive !== archive
    || typeof value.replacement !== "string" || !value.replacement.startsWith(replacementPrefix)
    || path.dirname(value.replacement) !== path.dirname(replacementPrefix)
    || !["copying", "prepared"].includes(String(value.stage))) refuse("interrupted maintenance belongs to a different request or has invalid schema")
  const base = { version: 1 as const, hash, sourceDigest: value.sourceDigest, sourceRevision: value.sourceRevision, archive, replacement: value.replacement }
  if (value.stage === "prepared") {
    if (!validMaintenanceReceipt(value.receipt) || value.archiveDigest !== value.receipt.archiveDigest
      || typeof value.replacementDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.replacementDigest)) refuse("invalid prepared maintenance schema")
    return { ...base, stage: "prepared", archiveDigest: value.receipt.archiveDigest, replacementDigest: value.replacementDigest, receipt: value.receipt }
  }
  if (value.archiveDigest !== null || value.replacementDigest !== null || value.receipt !== null) refuse("invalid copying maintenance schema")
  return { ...base, stage: "copying", archiveDigest: null, replacementDigest: null, receipt: null }
}
function targetsClaim(proof: ShepherdRetirementProof, claim: DispatchClaim): boolean {
  return proof.host === claim.host && proof.session === claim.session && (proof.instance === null && proof.wholeSessionRetired || proof.instance === claim.instance)
}
function archiveCandidates(db: Database.Database, proofs: ShepherdRetirementProof[]): string[] {
  const ids: string[] = []
  for (const row of db.prepare("SELECT id,host,session,instance,data FROM dispatches").iterate() as Iterable<DispatchRow>) {
    const claim = parseCustodyDispatch(row)
    if (!proofs.some(proof => targetsClaim(proof, claim))) continue
    const retired = hasRetiredCustodyInstance(db, claim)
    if ((claim.state === "claimed" || claim.state === "unknown") && !retired) refuse("unresolved attempt must be reconciled before archive")
    ids.push(claim.id)
  }
  return ids
}
function validateArchive(file: string, expectedCount: number): void {
  const db = openCustodyDatabase(file, "read")!
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") refuse("archive integrity check failed")
    const count = db.prepare("SELECT COUNT(*) AS count FROM dispatches").get() as { count: number }
    if (count.count !== expectedCount) refuse("archive dispatch count mismatch")
    for (const row of db.prepare("SELECT id,host,session,instance,data FROM dispatches").iterate() as Iterable<DispatchRow>) parseCustodyDispatch(row)
  } finally { db.close() }
}
function verifyPrepared(intent: MaintenanceIntent): void {
  if (intent.stage !== "prepared" || !intent.receipt || fileDigest(intent.archive) !== intent.archiveDigest
    || fileDigest(intent.replacement) !== intent.replacementDigest) refuse("prepared maintenance payload digest mismatch")
  const manifest = `${intent.archive}.json`
  privateRegular(manifest, 8192)
  const value = parseJson(fs.readFileSync(manifest, "utf8"))
  if (!object(value) || value.archiveDigest !== intent.archiveDigest || value.requestHash !== intent.hash
    || canonical(value.receipt) !== canonical(intent.receipt)) refuse("archive manifest mismatch")
}
function requireStoppedSense(request: Pick<ShepherdMaintenanceRequest, "sense">): void {
  if (!object(request.sense) || request.sense.kind !== "daemon_lifecycle" || request.sense.enabled !== false || request.sense.processState !== "stopped" || !fresh(request.sense.checkedAt)) {
    refuse("maintenance requires a fresh disabled and stopped sense proof")
  }
}

/** Fresh lifecycle observations are preconditions, not a change to the operator's archival intent. */
export async function maintainShepherdCustody(root: string, request: ShepherdMaintenanceRequest): Promise<ShepherdMaintenanceReceipt> {
  if (!object(request) || !validActor(request) || typeof request.destination !== "string" || request.destination.length > 2000
    || !Array.isArray(request.retiredInstances) || request.retiredInstances.length > 200
    || request.requestFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(request.requestFingerprint)) refuse("invalid owner maintenance request")
  request = structuredClone(request)
  const hash = request.requestFingerprint ?? digest(canonical({ operation: "maintenance", request: {
    ...request, sense: undefined, retiredInstances: request.retiredInstances.map(proof => ({ ...proof, checkedAt: undefined })),
  } }))
  const file = checkInStorePath(root)
  const marker = `${file}.maintenance.json`
  const archive = path.join(request.destination, `custody-${hash}.sqlite`)
  const replacementPrefix = `${file}.replacement-${hash}-`
  maintenanceDirectory(request.destination, false)
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) refuse("custody store is missing")
  return withFileLock(path.dirname(file), "operations", async () => {
    let intent = readIntent(marker, hash, archive, replacementPrefix)
    const db = openCustodyDatabase(file, "maintenance")
    try {
      const prior = priorRequest(db, request, hash, validMaintenanceReceipt)
      if (prior) {
        if (intent) {
          if (intent.stage !== "prepared" || fileDigest(file) !== intent.replacementDigest || fileDigest(archive) !== prior.archiveDigest) refuse("completed maintenance does not match recovery marker")
          fs.unlinkSync(marker)
          syncDirectory(path.dirname(file))
        }
        return prior
      }
      requireStoppedSense(request)
      if (!request.retiredInstances.length || !request.retiredInstances.every(validRetirement)
        || request.retiredInstances.some(proof => proof.instance === null && !proof.wholeSessionRetired)) refuse("maintenance requires fresh exact retired-instance proofs")
      if (custodyRevision(db) !== request.expectedRevision) refuse("maintenance revision conflict")
      if (intent) {
        if (intent.sourceRevision !== custodyRevision(db) || fileDigest(file) !== intent.sourceDigest) refuse("maintenance source changed; manual recovery required")
        if (intent.stage === "prepared") {
          verifyPrepared(intent)
          requireStoppedSense(request)
          db.close()
          fs.renameSync(intent.replacement, file)
          syncDirectory(path.dirname(file))
          fs.unlinkSync(marker)
          syncDirectory(path.dirname(file))
          return intent.receipt!
        }
      }
      const ids = archiveCandidates(db, request.retiredInstances)
      if (!ids.length) refuse("no settled retired-instance payloads are eligible for archive")
      const total = db.prepare("SELECT COUNT(*) AS count FROM dispatches").get() as { count: number }
      maintenanceDirectory(request.destination, true)
      if (fs.lstatSync(archive, { throwIfNoEntry: false })) {
        if (!intent || intent.stage !== "copying") refuse("archive destination already exists; resume its exact prepared request")
        privateRegular(archive, 64 * 1024 * 1024)
        fs.renameSync(archive, `${archive}.interrupted-${randomUUID()}`)
        if (fs.lstatSync(`${archive}.json`, { throwIfNoEntry: false })) {
          privateRegular(`${archive}.json`, 8192)
          fs.renameSync(`${archive}.json`, `${archive}.json.interrupted-${randomUUID()}`)
        }
        syncDirectory(request.destination)
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_custody_archive_resumed", message: "preserved an interrupted archive publication before rebuilding from unchanged custody", meta: { stage: "copying" } })
      }
      intent = {
        version: 1, hash, sourceDigest: fileDigest(file), sourceRevision: custodyRevision(db), stage: "copying", archive,
        replacement: `${replacementPrefix}${randomUUID()}.sqlite`, archiveDigest: null, replacementDigest: null, receipt: null,
      }
      writePrivateJson(marker, intent)
      const archiveTemp = `${archive}.${randomUUID()}.tmp`
      fs.writeFileSync(archiveTemp, "", { flag: "wx", mode: 0o600 })
      await db.backup(archiveTemp)
      syncFile(archiveTemp)
      validateArchive(archiveTemp, total.count)
      const archiveDigest = fileDigest(archiveTemp)
      fs.writeFileSync(intent.replacement, "", { flag: "wx", mode: 0o600 })
      await db.backup(intent.replacement)
      const replacement = openCustodyDatabase(intent.replacement, "write")
      let receipt: ShepherdMaintenanceReceipt
      try {
        receipt = replacement.transaction(() => {
          for (const id of ids) {
            replacement.prepare("DELETE FROM reconciliations WHERE dispatch_id=?").run(id)
            replacement.prepare("DELETE FROM dispatches WHERE id=?").run(id)
          }
          for (const proof of request.retiredInstances) retireInstance(replacement, proof,
            { actorId: request.actor.actorId, requestId: request.requestId }, { path: archive, digest: archiveDigest })
          const result: ShepherdMaintenanceReceipt = {
            revision: advanceCustodyRevision(replacement), requestId: request.requestId, actorId: request.actor.actorId,
            archivedCount: ids.length, retainedCount: total.count - ids.length, archive, archiveDigest, at: new Date(Date.now()).toISOString(),
          }
          rememberRequest(replacement, request, hash, result)
          return result
        }).immediate()
        replacement.exec("VACUUM")
        custodyCapacity(replacement, true)
        if (replacement.pragma("integrity_check", { simple: true }) !== "ok") refuse("replacement custody integrity check failed")
      } finally { replacement.close() }
      syncFile(intent.replacement)
      validateArchive(intent.replacement, receipt.retainedCount)
      fs.renameSync(archiveTemp, archive)
      syncDirectory(request.destination)
      writePrivateJson(`${archive}.json`, { version: 1, requestHash: hash, archiveDigest, receipt })
      intent = { ...intent, stage: "prepared", archiveDigest, replacementDigest: fileDigest(intent.replacement), receipt }
      writePrivateJson(marker, intent)
      verifyPrepared(intent)
      requireStoppedSense(request)
      if (fileDigest(file) !== intent.sourceDigest) refuse("maintenance source changed before swap")
      db.close()
      fs.renameSync(intent.replacement, file)
      syncDirectory(path.dirname(file))
      fs.unlinkSync(marker)
      syncDirectory(path.dirname(file))
      emitNervesEvent({ component: "senses", event: "senses.shepherd_custody_archived", message: "archived settled retired custody and retained replay tombstones", meta: { archivedCount: receipt.archivedCount, retainedCount: receipt.retainedCount, revision: receipt.revision } })
      return receipt
    } finally { if (db.open) db.close() }
  })
}
