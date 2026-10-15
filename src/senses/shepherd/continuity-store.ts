import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import Ajv from "ajv"
import Database from "better-sqlite3"
import type {
  ContinuityBatch, ContinuityClaim, ContinuityDispatchRequest, ContinuityDispatchReservation,
  ContinuityHold, ContinuityState,
} from "./continuity-types"

export class ContinuityStoreError extends Error {
  constructor(readonly code: "invalid" | "revision" | "busy" | "owner" | "hold" | "request", message: string) {
    super(`Shepherd continuity ${code}: ${message}`)
    this.name = "ContinuityStoreError"
  }
}

export interface ContinuityTransactionOptions {
  busyTimeoutMs?: number
}

const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" }
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] })
const array = (items: object, maxItems: number) => ({ type: "array", items, maxItems })
const choice = (...values: string[]) => ({ type: "string", enum: values })
const object = (properties: Record<string, object>, optional: string[] = []) => ({
  type: "object", properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false,
})
const ref = (name: string) => ({ $ref: `#/$defs/${name}` })
const processSchema = object({ pid: { type: "integer", minimum: 1, maximum: 2147483647 }, birth: text, uid: count })
const bindingSchema = object({
  id: text, agent: text, host: text, incarnation: text, surfaceId: text, surfaceGeneration: text,
  nativeSessionId: text, runner: choice("copilot", "claude", "codex"),
  process: processSchema, wrapper: nullable(processSchema), launchCwd: text, worktree: text,
  rootId: text, taskRef: text, taskKey: text, profileId: nullable(text),
  profileFingerprint: nullable(digest), configFingerprint: digest, enrollmentEpoch: text,
})
const assuranceSchema = object({
  checkpoint: choice("unverified", "verified"),
  endReadiness: choice("unconfirmed", "agent-confirmed-as-of-native-boundary", "native-observed"),
  backgroundCoverage: choice("unknown", "native-managed-snapshot"),
  jobInventory: choice("unverified", "preserved-agent-reported"), reopen: choice("unverified", "eligible", "blocked"),
  observedAt: nullable(text), qualifications: array(text, 64),
})
const roundSchema = object({
  kind: choice("preparation", "followup", "correction"), nonce: text, receiptSlot: text,
  phase: choice("reserved", "issued", "acknowledged", "uncertain", "blocked"), attemptId: text, expectedRevision: count,
})
const receiptSchema = object({
  schemaVersion: { const: 1 }, batchId: text, bindingId: text, generation: { type: "integer", minimum: 1 },
  round: choice("preparation", "followup", "correction", "bootstrap", "execute"), nonce: text, launchAttemptId: nullable(text),
  checkpoint: object({ rootId: text, relativePath: text, sha256: digest }),
  task: object({ ref: text, rootId: text, launchCwd: text, worktree: text, branch: text, head: text, nextAction: text }),
  confirmation: { type: "boolean" },
  knownJobs: array(object({ id: text, kind: text, owner: text, effects: text, status: text, disposition: text, reference: text }), 64),
  uncertainMutations: array(object({ id: text, operation: text, disposition: text, evidence: text }), 64),
})
const launchSchema = object({
  attemptId: text, bootstrapNonce: text, bootstrapSlot: text,
  phase: choice("reserved", "created", "bootstrapped", "grant-issued", "working", "reconciling", "uncertain", "blocked"),
  nativeSessionId: text, wrapper: nullable(processSchema), actor: nullable(processSchema),
  workspaceId: nullable(text), surfaceId: nullable(text), executeNonce: nullable(text), executeSlot: nullable(text),
  milestones: array(text, 32),
})
const targetSchema = object({
  id: text, binding: bindingSchema, generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  state: choice("previewed", "pending-boundary", "checkpoint-requested", "verifying", "ready", "blocked", "unsupported", "uncertain", "cancelled"),
  reopen: choice("not-requested", "eligible", "launching", "launched", "blocked", "unsupported", "uncertain"),
  rounds: array(roundSchema, 3), reasons: array(text, 64), assurance: assuranceSchema,
  receipt: nullable(receiptSchema), launch: nullable(launchSchema),
})
const batchSchema = object({
  id: text, agent: text, requestId: text, bodyHash: digest,
  origin: object({ actorId: text, requestId: text, surfaceId: text }, ["surfaceId"]),
  createdAt: text, cancellation: choice("none", "cancelling", "cancelled"), targets: array(targetSchema, 256),
})
const claimSchema = object({
  taskKey: text, agent: text, batchId: text, targetId: text, bindingId: text,
  phase: choice("source", "launch-reserved", "created", "transferred", "uncertain", "ended"),
  actor: nullable(processSchema), attemptId: nullable(text),
})
const holdSchema = object({ agent: text, host: text, surface: text, batchId: text, targetId: text })
const dispatchSchema = object({
  id: text, agent: text, host: text, surface: text, requestId: text, bodyHash: digest,
  phase: choice("reserved", "issued", "acknowledged", "uncertain", "blocked"),
})
const validate = new Ajv({ strict: true }).compile<ContinuityState>({
  ...object({
    schemaVersion: { const: 1 }, revision: count, batches: array(ref("batch"), 128),
    claims: array(ref("claim"), 256), holds: array(ref("hold"), 256), dispatches: array(ref("dispatch"), 2048),
  }),
  $defs: { batch: batchSchema, claim: claimSchema, hold: holdSchema, dispatch: dispatchSchema },
})

function empty(): ContinuityState {
  return { schemaVersion: 1, revision: 0, batches: [], claims: [], holds: [], dispatches: [] }
}

function refuse(message: string): never {
  throw new ContinuityStoreError("invalid", message)
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) refuse(`duplicate ${field}`)
}

function validateState(value: unknown): asserts value is ContinuityState {
  if (!validate(value)) refuse("state schema is invalid")
  const targets = value.batches.flatMap(batch => batch.targets)
  if (targets.length > 256) refuse("target capacity exceeded")
  unique(value.batches.map(batch => batch.id), "batch IDs")
  unique(value.batches.map(batch => JSON.stringify([batch.agent, batch.requestId])), "batch requests")
  unique(targets.map(target => target.id), "target IDs")
  unique(value.claims.map(claim => claim.taskKey), "canonical claims")
  unique(value.holds.map(hold => JSON.stringify([hold.agent, hold.host, hold.surface])), "surface holds")
  unique(value.dispatches.map(dispatch => JSON.stringify([dispatch.agent, dispatch.requestId])), "dispatch requests")
  for (const batch of value.batches) {
    if (batch.origin.requestId !== batch.requestId || batch.targets.some(target => target.binding.agent !== batch.agent)) refuse("batch binding identity mismatch")
  }
  for (const claim of value.claims) {
    const batch = value.batches.find(batch => batch.id === claim.batchId && batch.agent === claim.agent)
    const target = batch?.targets.find(target => target.id === claim.targetId)
    if (!target || claim.taskKey !== target.binding.taskKey) refuse("claim target mismatch")
    if (claim.phase === "source" && (claim.bindingId !== target.binding.id || !claim.actor)) refuse("source claim mismatch")
  }
  for (const hold of value.holds) {
    const batch = value.batches.find(batch => batch.id === hold.batchId && batch.agent === hold.agent)
    const target = batch?.targets.find(target => target.id === hold.targetId)
    if (!target || hold.host !== target.binding.host || hold.surface !== target.binding.surfaceId) refuse("hold target mismatch")
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 2 * 1024 * 1024) refuse("state byte capacity exceeded")
}

export function continuityStatePath(homeDir: string, machineId: string): string {
  if (!path.isAbsolute(homeDir) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(machineId)) refuse("invalid machine store path")
  return path.join(homeDir, ".ouro-cli", "state", "shepherd-continuity", machineId, "state.sqlite")
}

interface PathPin { path: string; dev: number; ino: number }

function checkPath(file: string, create: boolean): PathPin[] {
  if (!path.isAbsolute(file) || file.split(path.sep).includes("..")) refuse("database path must be absolute")
  const marker = `${path.sep}.ouro-cli${path.sep}state${path.sep}shepherd-continuity${path.sep}`
  const index = file.lastIndexOf(marker)
  if (index < 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/state\.sqlite$/.test(file.slice(index + marker.length))) refuse("database path is not the machine continuity store")
  const home = file.slice(0, index)
  const directories: string[] = [home]
  let current = path.dirname(file)
  while (current !== home) {
    directories.splice(1, 0, current)
    current = path.dirname(current)
  }
  const pins: PathPin[] = []
  for (const directory of directories) {
    let stat: fs.Stats
    try { stat = fs.lstatSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create || directory === home) throw error
      try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError
      }
      stat = fs.lstatSync(directory)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid!() && stat.uid !== 0) || (stat.mode & 0o022) !== 0) refuse("untrusted database directory")
    if ((directory === path.dirname(file) || directory === path.dirname(path.dirname(file))) && (stat.mode & 0o777) !== 0o700) refuse("continuity directory must be private")
    pins.push({ path: directory, dev: stat.dev, ino: stat.ino })
  }
  if (create && !fs.existsSync(file)) {
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      fs.closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  for (const target of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    let stat: fs.Stats
    try { stat = fs.lstatSync(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && target !== file) continue
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) refuse("untrusted database file")
    if (target === file) pins.push({ path: target, dev: stat.dev, ino: stat.ino })
  }
  return pins
}

function checkPins(pins: PathPin[]): void {
  for (const pin of pins) {
    const stat = fs.lstatSync(pin.path)
    if (stat.dev !== pin.dev || stat.ino !== pin.ino || stat.isSymbolicLink()) refuse("database path identity changed")
  }
}

function readRow(db: Database.Database): ContinuityState {
  const row = db.prepare("SELECT revision, payload FROM continuity_state WHERE id=1").get() as { revision: number; payload: string } | undefined
  if (!row || !Number.isSafeInteger(row.revision) || row.payload.length > 2 * 1024 * 1024) refuse("invalid state row")
  const state: unknown = JSON.parse(row.payload)
  validateState(state)
  if (state.revision !== row.revision) refuse("state revision mismatch")
  return state
}

export function readContinuityState(file: string): ContinuityState {
  let pins: PathPin[]
  try { pins = checkPath(file, false) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw error
  }
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 100 })
  try {
    checkPins(pins)
    const state = readRow(db)
    checkPins(pins)
    return state
  } finally { db.close() }
}

export async function transactContinuity<T>(
  file: string, expectedRevision: number | undefined, apply: (state: ContinuityState) => T,
  options: ContinuityTransactionOptions = {},
): Promise<{ revision: number; result: T }> {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) refuse("invalid busy timeout")
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) refuse("invalid expected revision")
  if (apply.constructor.name === "AsyncFunction") refuse("transaction callback must be synchronous")
  const pins = checkPath(file, true)
  const db = new Database(file, { timeout: busyTimeoutMs })
  let inTransaction = false
  try {
    checkPins(pins)
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = FULL")
    db.exec("BEGIN IMMEDIATE")
    inTransaction = true
    db.exec("CREATE TABLE IF NOT EXISTS continuity_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT")
    db.prepare("INSERT OR IGNORE INTO continuity_state (id, revision, payload) VALUES (1, 0, ?)").run(JSON.stringify(empty()))
    const state = readRow(db)
    if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new ContinuityStoreError("revision", "expected revision is stale")
    const revision = state.revision + 1
    const result = apply(state)
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) refuse("transaction callback must be synchronous")
    state.revision = revision
    validateState(state)
    checkPins(pins)
    checkPath(file, false)
    db.prepare("UPDATE continuity_state SET revision=?, payload=? WHERE id=1").run(revision, JSON.stringify(state))
    db.exec("COMMIT")
    inTransaction = false
    return { revision, result }
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK")
    if ((error as NodeJS.ErrnoException).code === "SQLITE_BUSY") throw new ContinuityStoreError("busy", "machine continuity transaction is busy")
    throw error
  } finally { db.close() }
}

export function reserveContinuityClaim(state: ContinuityState, claim: ContinuityClaim): ContinuityClaim {
  const existing = state.claims.find(value => value.taskKey === claim.taskKey)
  if (existing) {
    if (existing.bindingId !== claim.bindingId || existing.batchId !== claim.batchId || existing.targetId !== claim.targetId || existing.agent !== claim.agent || existing.attemptId !== claim.attemptId) {
      throw new ContinuityStoreError("owner", "canonical task already has an owner")
    }
    return existing
  }
  state.claims.push(structuredClone(claim))
  return state.claims[state.claims.length - 1]
}

function selectionFingerprint(batch: ContinuityBatch): string {
  return createHash("sha256").update(JSON.stringify({ agent: batch.agent, origin: batch.origin, bindings: batch.targets.map(target => target.binding) })).digest("hex")
}

export function createContinuityBatch(state: ContinuityState, batch: ContinuityBatch): ContinuityBatch {
  const existing = state.batches.find(value => value.agent === batch.agent && value.requestId === batch.requestId)
  if (existing) {
    if (existing.bodyHash !== batch.bodyHash || selectionFingerprint(existing) !== selectionFingerprint(batch)) throw new ContinuityStoreError("request", "request ID was used for a different body")
    return existing
  }
  if (state.batches.some(value => value.id === batch.id)) throw new ContinuityStoreError("request", "batch ID is already reserved")
  const cloned = structuredClone(batch)
  for (const target of cloned.targets) {
    if (continuityHold(state, batch.agent, target.binding.host, target.binding.surfaceId)) throw new ContinuityStoreError("hold", "surface already has a preparation hold")
    reserveContinuityClaim(state, {
      taskKey: target.binding.taskKey, agent: batch.agent, batchId: batch.id, targetId: target.id,
      bindingId: target.binding.id, phase: "source", actor: target.binding.process, attemptId: null,
    })
    state.holds.push({ agent: batch.agent, host: target.binding.host, surface: target.binding.surfaceId, batchId: batch.id, targetId: target.id })
  }
  state.batches.push(cloned)
  return cloned
}

export function continuityHold(state: ContinuityState, agent: string, host: string, surface: string): ContinuityHold | null {
  return state.holds.find(value => value.agent === agent && value.host === host && value.surface === surface) ?? null
}

export function reserveContinuityDispatch(state: ContinuityState, request: ContinuityDispatchRequest): ContinuityDispatchReservation {
  const existing = state.dispatches.find(value => value.agent === request.agent && value.requestId === request.requestId)
  if (existing) {
    if (existing.bodyHash !== request.bodyHash || existing.host !== request.host || existing.surface !== request.surface) throw new ContinuityStoreError("request", "dispatch request body differs")
    return { ...existing, newlyReserved: false }
  }
  if (continuityHold(state, request.agent, request.host, request.surface)) throw new ContinuityStoreError("hold", "surface has a preparation hold")
  const record = { ...request, id: randomUUID(), phase: "reserved" as const }
  state.dispatches.push(record)
  return { ...record, newlyReserved: true }
}

export function cancelContinuityBatch(state: ContinuityState, batchId: string, agent: string): "cancelled" | "cancelling" {
  const batch = state.batches.find(value => value.id === batchId && value.agent === agent)
  if (!batch) refuse("batch does not belong to agent")
  const unresolved = batch.targets.some(target =>
    target.launch !== null ||
    target.rounds.some(round => ["reserved", "issued", "uncertain"].includes(round.phase)) ||
    state.dispatches.some(dispatch => dispatch.agent === agent && dispatch.host === target.binding.host && dispatch.surface === target.binding.surfaceId && ["reserved", "issued", "uncertain"].includes(dispatch.phase)),
  )
  batch.cancellation = unresolved ? "cancelling" : "cancelled"
  if (!unresolved) {
    for (const target of batch.targets) target.state = "cancelled"
    state.holds = state.holds.filter(hold => hold.batchId !== batchId)
  }
  return batch.cancellation
}
