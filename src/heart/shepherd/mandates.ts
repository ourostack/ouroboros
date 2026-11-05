import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { withFileLock } from "../file-lock"
import { emitNervesEvent } from "../../nerves/runtime"
import type {
  ShepherdAdministrationContext, ShepherdMandate, ShepherdMandateProvenance, ShepherdMandateRequest,
  ShepherdMandateState, ShepherdMandateTarget, ShepherdMandateReceipt, ShepherdMandateResolution,
} from "./types"

const MAX_BYTES = 2 * 1024 * 1024
const MAX_LIFETIME = 7 * 86_400_000
const empty = (): ShepherdMandateState => ({ version: 1, revision: 0, mandates: [], requests: [] })
const digest = (value: string): string => createHash("sha256").update(value).digest("hex")
const mandateId = (actorId: string, requestId: string): string => `mandate:${digest(JSON.stringify([actorId, requestId]))}`
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value)
const identity = (value: unknown): value is string => text(value, 200) && value === value.trim() && !/[\r\n\t]/.test(value)
const iso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const canonicalProjectShape = (value: unknown): value is string =>
  typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
  && (value === path.parse(value).root || !value.endsWith(path.sep)) && !/[\x00-\x1f\x7f-\x9f]/.test(value)

function validContext(value: unknown): value is ShepherdAdministrationContext {
  return object(value) && exactKeys(value, ["kind", "actorId", "requestId"]) && value.kind === "local_owner_administration"
    && identity(value.actorId) && identity(value.requestId)
}
function validProvenance(value: unknown): value is ShepherdMandateProvenance {
  return object(value) && exactKeys(value, ["kind", "actorId", "requestId", "at"])
    && validContext({ kind: value.kind, actorId: value.actorId, requestId: value.requestId }) && iso(value.at)
}
function validTarget(value: unknown): value is ShepherdMandateTarget {
  return object(value) && exactKeys(value, ["project"], ["host", "session", "instance"]) && canonicalProjectShape(value.project)
    && ["host", "session", "instance"].every(key => !Object.hasOwn(value, key) || identity(value[key]))
    && (value.session === undefined || value.host !== undefined)
    && (value.instance === undefined || value.session !== undefined)
}
function validRequest(value: unknown): value is ShepherdMandateRequest {
  if (!object(value) || !validContext(value.context) || !integer(value.expectedRevision)) return false
  return value.operation === "grant"
    ? exactKeys(value, ["operation", "context", "expectedRevision", "target", "task", "expiresAt"])
      && validTarget(value.target) && text(value.task, 2000) && iso(value.expiresAt)
    : value.operation === "revoke" && exactKeys(value, ["operation", "context", "expectedRevision", "mandateId"])
      && identity(value.mandateId)
}
function validMandate(value: unknown): value is ShepherdMandate {
  return object(value) && exactKeys(value, ["id", "revision", "target", "task", "action", "createdAt", "expiresAt", "status", "provenance", "revoked"])
    && typeof value.id === "string" && /^mandate:[a-f0-9]{64}$/.test(value.id) && integer(value.revision) && value.revision > 0
    && validTarget(value.target) && text(value.task, 2000) && value.action === "continue_text"
    && iso(value.createdAt) && iso(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.createdAt)
    && Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= MAX_LIFETIME
    && validProvenance(value.provenance) && value.provenance.at === value.createdAt
    && value.id === mandateId(value.provenance.actorId, value.provenance.requestId)
    && (value.status === "active" ? value.revoked === null : value.status === "revoked" && validProvenance(value.revoked)
      && Date.parse(value.revoked.at) >= Date.parse(value.createdAt))
}
function validReceipt(value: unknown): value is ShepherdMandateReceipt {
  return object(value) && exactKeys(value, ["revision", "operation", "mandateId", "provenance"])
    && integer(value.revision) && value.revision > 0 && (value.operation === "grant" || value.operation === "revoke")
    && typeof value.mandateId === "string" && /^mandate:[a-f0-9]{64}$/.test(value.mandateId) && validProvenance(value.provenance)
}
function validState(value: unknown, nowMs = Date.now()): value is ShepherdMandateState {
  if (!object(value) || !exactKeys(value, ["version", "revision", "mandates", "requests"])
    || value.version !== 1 || !integer(value.revision) || !Array.isArray(value.mandates) || !Array.isArray(value.requests)
    || !value.mandates.every(validMandate) || value.revision !== value.requests.length) return false
  const ids = new Set(value.mandates.map(mandate => mandate.id))
  if (ids.size !== value.mandates.length
    || value.mandates.filter(mandate => mandate.status === "active" && Date.parse(mandate.expiresAt) > nowMs).length > 100) return false
  const requests = new Set<string>()
  const grants = new Map<string, ShepherdMandateReceipt>()
  const revocations = new Map<string, ShepherdMandateReceipt>()
  for (const [index, request] of value.requests.entries()) {
    if (!object(request) || !exactKeys(request, ["actorId", "requestId", "hash", "receipt"])
      || !identity(request.actorId) || !identity(request.requestId) || typeof request.hash !== "string" || !/^[a-f0-9]{64}$/.test(request.hash)
      || !validReceipt(request.receipt) || request.receipt.revision !== index + 1
      || request.actorId !== request.receipt.provenance.actorId || request.requestId !== request.receipt.provenance.requestId
      || !ids.has(request.receipt.mandateId)) return false
    const key = JSON.stringify([request.actorId, request.requestId])
    const operations = request.receipt.operation === "grant" ? grants : revocations
    if (requests.has(key) || operations.has(request.receipt.mandateId)) return false
    requests.add(key)
    operations.set(request.receipt.mandateId, request.receipt)
  }
  return value.mandates.every(mandate => {
    const grant = grants.get(mandate.id)
    const revoked = revocations.get(mandate.id)
    return grant && canonical(grant.provenance) === canonical(mandate.provenance)
      && (mandate.status === "active" ? !revoked && mandate.revision === grant.revision
        : revoked && revoked.revision > grant.revision && revoked.revision === mandate.revision
          && canonical(revoked.provenance) === canonical(mandate.revoked))
  })
}

function owned(metadata: fs.Stats): void {
  if (!process.getuid || metadata.uid !== process.getuid()) throw new Error("Shepherd mandates require current-user ownership")
}
function directory(candidate: string, privateMode: boolean, create: boolean): boolean {
  let metadata = fs.lstatSync(candidate, { throwIfNoEntry: false })
  if (!metadata && create) {
    try { fs.mkdirSync(candidate, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    metadata = fs.lstatSync(candidate)
  }
  if (!metadata) return false
  owned(metadata)
  if (!metadata.isDirectory()) throw new Error("Shepherd mandate directory must be a directory, not a link")
  if (privateMode ? (metadata.mode & 0o7777) !== 0o700 : (metadata.mode & 0o022) !== 0) {
    throw new Error("Shepherd mandate directory requires 0700 mode and non-writable ancestors")
  }
  return true
}
function storeDirectory(root: string, create = false): string | null {
  const base = path.resolve(root)
  if (!directory(base, false, false)) throw new Error("Shepherd mandate bundle directory is missing")
  let current = base
  for (const name of ["state", "senses", "shepherd"]) {
    current = path.join(current, name)
    if (!directory(current, name === "shepherd", create)) return null
  }
  return current
}
function regularFile(metadata: fs.Stats): void {
  owned(metadata)
  if (!metadata.isFile()) throw new Error("Shepherd mandates require a regular file, not a link")
  if ((metadata.mode & 0o7777) !== 0o600) throw new Error("Shepherd mandate file requires 0600 mode")
  if (metadata.nlink !== 1) throw new Error("Shepherd mandate file requires a single link")
  if (metadata.size > MAX_BYTES) throw new Error("Shepherd mandates exceed 2 MiB")
}

/** Missing is empty, not a grant. No read creates, repairs, or changes any filesystem entry. */
export function readShepherdMandates(agentRoot: string): ShepherdMandateState {
  const dir = storeDirectory(agentRoot)
  if (!dir) return empty()
  const file = path.join(dir, "mandates.json")
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!metadata) return empty()
  regularFile(metadata)
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  let raw: string
  try {
    const opened = fs.fstatSync(handle)
    regularFile(opened)
    if (opened.ino !== metadata.ino || opened.dev !== metadata.dev) throw new Error("Shepherd mandate file changed during read")
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let count = 0
    while (count < bytes.length) {
      const received = fs.readSync(handle, bytes, count, bytes.length - count, null)
      if (received === 0) break
      count += received
    }
    if (count > MAX_BYTES) throw new Error("Shepherd mandates exceed 2 MiB")
    raw = bytes.toString("utf8", 0, count)
  } finally { fs.closeSync(handle) }
  let state: unknown
  try { state = JSON.parse(raw) } catch { throw new Error("Shepherd mandates contain malformed JSON") }
  if (!validState(state)) throw new Error("Shepherd mandates contain an invalid or unsupported schema")
  return state
}

function requireCanonicalProject(project: string): void {
  try {
    if (canonicalProjectShape(project) && fs.realpathSync.native(project) === project && fs.statSync(project).isDirectory()) return
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
  }
  throw new Error("Shepherd mandates require an exact existing canonical project directory")
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
function persist(dir: string, state: ShepherdMandateState): void {
  const snapshot = JSON.stringify(state)
  if (Buffer.byteLength(snapshot) > MAX_BYTES) throw new Error("Shepherd mandates exceed 2 MiB; no change was written")
  const temporary = path.join(dir, `mandates.${randomUUID()}.tmp`)
  const handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(handle, snapshot, "utf8")
    fs.fsyncSync(handle)
  } finally { fs.closeSync(handle) }
  fs.renameSync(temporary, path.join(dir, "mandates.json"))
  const directoryHandle = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
}

/** Caller has already validated the local-family owner; this is not exposed as an agent/browser grant tool. */
export async function updateShepherdMandate(agentRoot: string, request: ShepherdMandateRequest): Promise<ShepherdMandateReceipt> {
  if (!validRequest(request)) throw new Error("Invalid Shepherd mandate administrative request: requires canonical project, bounded task and expiry")
  // Never hold a caller-owned mutable object across the asynchronous lock acquisition.
  request = structuredClone(request)
  const bodyHash = digest(canonical(request))
  // Read before creating state so malformed existing authority is never repaired by a mutation.
  const initial = readShepherdMandates(agentRoot)
  const existingDir = storeDirectory(agentRoot)
  const now = Date.now()
  // A replay remains a replay after expiry; expiry is checked only for a new grant under the lock.
  if (!existingDir && request.operation === "grant" && (Date.parse(request.expiresAt) <= now || Date.parse(request.expiresAt) - now > MAX_LIFETIME)) {
    throw new Error("Shepherd mandate expiry must be in the future and within seven days")
  }
  if (!existingDir) {
    if (request.operation === "revoke") throw new Error("Shepherd mandate not found")
    if (request.expectedRevision !== initial.revision) throw new Error("Shepherd mandate revision conflict")
    requireCanonicalProject(request.target.project)
  }
  const dir = storeDirectory(agentRoot, true)!
  return withFileLock(dir, "mandates", () => {
    const state = readShepherdMandates(agentRoot)
    const prior = state.requests.find(item => item.actorId === request.context.actorId && item.requestId === request.context.requestId)
    if (prior) {
      if (prior.hash !== bodyHash) throw new Error("Shepherd mandate request ID was already used with different arguments")
      return prior.receipt
    }
    if (state.revision !== request.expectedRevision) throw new Error(`Shepherd mandate revision conflict: expected ${request.expectedRevision}, current ${state.revision}`)
    const committedAt = Date.now()
    const provenance: ShepherdMandateProvenance = { ...request.context, at: new Date(committedAt).toISOString() }
    const revision = state.revision + 1
    let id: string
    if (request.operation === "grant") {
      if (Date.parse(request.expiresAt) <= committedAt || Date.parse(request.expiresAt) - committedAt > MAX_LIFETIME) {
        throw new Error("Shepherd mandate expiry must be in the future and within seven days")
      }
      if (state.mandates.filter(item => item.status === "active" && Date.parse(item.expiresAt) > committedAt).length >= 100) {
        throw new Error("Shepherd already has 100 active mandates; revoke one explicitly")
      }
      requireCanonicalProject(request.target.project)
      id = mandateId(request.context.actorId, request.context.requestId)
      state.mandates.push({
        id, revision, target: { ...request.target }, task: request.task, action: "continue_text",
        createdAt: provenance.at, expiresAt: request.expiresAt, status: "active", provenance, revoked: null,
      })
    } else {
      const mandate = state.mandates.find(item => item.id === request.mandateId)
      if (!mandate) throw new Error("Shepherd mandate not found")
      if (mandate.status === "revoked") throw new Error("Shepherd mandate is already revoked")
      if (committedAt < Date.parse(mandate.createdAt)) throw new Error("Shepherd mandate clock moved before grant time; no change was written")
      id = mandate.id
      mandate.status = "revoked"
      mandate.revoked = provenance
      mandate.revision = revision
    }
    const receipt: ShepherdMandateReceipt = { revision, operation: request.operation, mandateId: id, provenance }
    state.revision = revision
    state.requests.push({ actorId: request.context.actorId, requestId: request.context.requestId, hash: bodyHash, receipt })
    persist(dir, state)
    emitNervesEvent({ component: "heart", event: "heart.shepherd_mandate_mutated", message: "committed a trusted Shepherd mandate revision", meta: { operation: request.operation, revision } })
    return receipt
  })
}

export function resolveShepherdMandate(state: ShepherdMandateState, target: ShepherdMandateTarget, nowMs: number): ShepherdMandateResolution {
  if (!validState(state, nowMs) || !Number.isFinite(nowMs)) return { state: "withheld", reason: "invalid_mandate_state" }
  if (!validTarget(target)) return { state: "withheld", reason: "invalid_project" }
  try { requireCanonicalProject(target.project) } catch (error) {
    if ((error as Error).message !== "Shepherd mandates require an exact existing canonical project directory") throw error
    return { state: "withheld", reason: "invalid_project" }
  }
  const matches = state.mandates.filter(mandate => mandate.status === "active"
    && Date.parse(mandate.createdAt) <= nowMs && Date.parse(mandate.expiresAt) > nowMs
    && mandate.target.project === target.project
    && (["host", "session", "instance"] as const).every(key => mandate.target[key] === undefined || mandate.target[key] === target[key]))
  if (matches.length !== 1) return { state: "withheld", reason: matches.length ? "ambiguous_mandates" : "no_applicable_mandate" }
  return { state: "authorized", mandate: matches[0]! }
}
