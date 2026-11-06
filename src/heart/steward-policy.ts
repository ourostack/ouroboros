import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { TrustLevel } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { readSessionTransaction, withImmediateSessionTurnLease, withSessionTurnLease, writeSessionTransaction, type SessionTurnLease } from "../mind/session-transaction"

export type LearnedPolicyProvenance = "stated" | "observed" | "default"
export type ActionGrantProvenance = "stated" | "installed_explicit_policy"

export interface DesiredStateEntry {
  value: string
  provenance: LearnedPolicyProvenance
  version: number
  source: string
  expiresAt?: string
}

export interface RoutineActionGrant {
  action: string
  targets: string[]
  maxCount: number
  windowMs: number
  verificationRequired: boolean
  exclusions: string[]
  provenance: ActionGrantProvenance
  issuer: string
  authorizedAt: string
  authorizingSessionEvent: string
  version: number
  expiresAt?: string
}

export interface StewardPolicyRecord {
  schemaVersion: 1
  version: number
  desiredStates: Record<string, DesiredStateEntry>
  routineActionGrants: Record<string, RoutineActionGrant>
  updatedAt: string | null
}

export interface StewardPolicyActor {
  friendId: string
  trustLevel: TrustLevel
  sessionEventId: string
  authorization?: {
    profileId: string
    profileVersion: number
    requestId: string
    sessionKey: string
    receiptId: string
  }
}

export type StewardPolicyMutation =
  | { kind: "set_desired_state"; key: string; value: string; provenance: LearnedPolicyProvenance; source: string; expiresAt?: string }
  | { kind: "grant_routine_action"; key: string; action: string; targets: string[]; maxCount: number; windowMs: number; verificationRequired: boolean; exclusions: string[]; provenance: ActionGrantProvenance | "observed" | "default"; expiresAt?: string }

export type RoutineActionRequester =
  | { kind: "owner" | "household_request"; friendId: string; profileId: string; requestId: string; sessionEventId: string; origin: { friendId: string; channel: string; key: string } }
  | { kind: "owner_event"; friendId: string; profileId: string; event: import("./external-events/router").ExternalEventLeaseMember; target: { id: string; name: string } }

interface RoutineActionGrantInput {
  key: string
  action: string
  target: string
  requester: RoutineActionRequester
  authorizationVersion: number
  expectedPolicyVersion?: number
  expectedDesiredStateVersion?: number
  expectedGrantVersion?: number
  now?: string
}

export interface RoutineActionReceipt {
  schemaVersion: 2
  id: string
  state: "reserved" | "attempting" | "effect_acknowledged" | "recovery_pending" | "verified" | "failed" | "indeterminate" | "recovered_no_effect"
  key: string
  action: string
  target: string
  policyVersion: number
  grantVersion: number
  desiredStateVersion?: number
  requester?: RoutineActionRequester
  reservedAt: string
  updatedAt: string
  authorizationReceiptId: string
  authorizationVersion: number
  attemptId: string
  attempt: number
  expectedBeforeState: string | null
  resolvedTarget: { id: string; name: string }
  effect: { operation: string; targetId: string }
  effectReceipt: string | null
  verifiedAfterState: string | null
  recoveryState: { state: "not_needed" | "pending" | "manual_inspection_required" | "completed" | "failed"; compensation: "none" | "required" | "completed" }
}

export type RoutineActionGrantDecision =
  | { allowed: true; policyVersion: number; desiredStateVersion: number; grantVersion: number; key: string; action: string; target: string; requester: RoutineActionRequester; authorizationVersion: number }
  | { allowed: false; reason: string; approvalFallback?: true }

const EMPTY_POLICY: StewardPolicyRecord = { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null }
const MAX_POLICY_BYTES = 1024 * 1024
const MAX_AUDIT_ROW_BYTES = 16 * MAX_POLICY_BYTES

interface PolicyAuditRow {
  schemaVersion: 2
  transactionId: string
  precedingBytesSha256: string
  mutationKind: StewardPolicyMutation["kind"]
  key: string
  mutationFingerprint: string
  affectedKeyResult: DesiredStateEntry | RoutineActionGrant
  affectedKeyResultSha256: string
  issuer: string
  authorizingSessionEvent: string
  authorization: NonNullable<StewardPolicyActor["authorization"]>
  preimage: string
  preimageVersion: number
  preimageSha256: string
  postimage: string
  postimageVersion: number
  postimageSha256: string
  at: string
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex")
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

function canonicalTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length
}

function ownerAuthorization(value: unknown): value is NonNullable<StewardPolicyActor["authorization"]> {
  return record(value) && exactKeys(value, ["profileId", "profileVersion", "requestId", "sessionKey", "receiptId"])
    && value.profileId === "sanctuary-owner" && positiveInteger(value.profileVersion)
    && text(value.requestId) && text(value.sessionKey) && text(value.receiptId)
}

function desiredEntry(value: unknown, version: number): value is DesiredStateEntry {
  return record(value) && exactKeys(value, ["value", "provenance", "version", "source"], ["expiresAt"])
    && text(value.value) && text(value.source) && positiveInteger(value.version) && value.version <= version
    && (value.provenance === "stated" || value.provenance === "observed" || value.provenance === "default")
    && (value.expiresAt === undefined || canonicalTime(value.expiresAt))
}

function grantEntry(value: unknown, version: number): value is RoutineActionGrant {
  return record(value) && exactKeys(value, ["action", "targets", "maxCount", "windowMs", "verificationRequired", "exclusions", "provenance", "issuer", "authorizedAt", "authorizingSessionEvent", "version"], ["expiresAt"])
    && text(value.action) && textArray(value.targets) && value.targets.length > 0 && textArray(value.exclusions)
    && positiveInteger(value.maxCount) && positiveInteger(value.windowMs) && value.verificationRequired === true
    && (value.provenance === "stated" || value.provenance === "installed_explicit_policy")
    && text(value.issuer) && text(value.authorizingSessionEvent) && canonicalTime(value.authorizedAt)
    && positiveInteger(value.version) && value.version <= version && (value.expiresAt === undefined || canonicalTime(value.expiresAt))
}

function policyRecord(value: unknown): value is StewardPolicyRecord {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "version", "desiredStates", "routineActionGrants", "updatedAt"])
    || value.schemaVersion !== 1 || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0
    || !record(value.desiredStates) || !record(value.routineActionGrants)
    || !(value.updatedAt === null ? value.version === 0 : canonicalTime(value.updatedAt))) return false
  const version = value.version
  return Object.entries(value.desiredStates).every(([key, entry]) => text(key) && desiredEntry(entry, version))
    && Object.entries(value.routineActionGrants).every(([key, entry]) => text(key) && grantEntry(entry, version))
}

function policyImage(bytes: string): StewardPolicyRecord {
  if (Buffer.byteLength(bytes) > MAX_POLICY_BYTES) throw new Error("steward policy audit image exceeds its bound")
  if (bytes === "") return structuredClone(EMPTY_POLICY)
  let value: unknown
  try { value = JSON.parse(bytes) } catch (cause) { throw new Error("steward policy audit image is invalid", { cause }) }
  if (!policyRecord(value)) throw new Error("steward policy audit image is invalid")
  return value
}

function mutationFingerprint(kind: StewardPolicyMutation["kind"], key: string, result: DesiredStateEntry | RoutineActionGrant): string {
  const generated = ["version", "issuer", "authorizedAt", "authorizingSessionEvent"]
  const input = Object.fromEntries(Object.entries(result).filter(([field]) => !generated.includes(field)).sort(([left], [right]) => left.localeCompare(right)))
  return sha256(JSON.stringify([kind, key, input]))
}

function operationIdentity(issuer: string, event: string, requestId: string, kind: StewardPolicyMutation["kind"], key: string): string {
  return JSON.stringify([issuer, event, requestId, kind, key])
}

function auditRow(value: unknown): value is PolicyAuditRow {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "transactionId", "precedingBytesSha256", "mutationKind", "key", "mutationFingerprint", "affectedKeyResult", "affectedKeyResultSha256", "issuer", "authorizingSessionEvent", "authorization", "preimage", "preimageVersion", "preimageSha256", "postimage", "postimageVersion", "postimageSha256", "at"])
    || value.schemaVersion !== 2 || (value.mutationKind !== "set_desired_state" && value.mutationKind !== "grant_routine_action")
    || !text(value.key) || !text(value.issuer) || !text(value.authorizingSessionEvent) || !ownerAuthorization(value.authorization)
    || typeof value.preimage !== "string" || typeof value.postimage !== "string" || !canonicalTime(value.at)) return false
  const before = policyImage(value.preimage)
  const after = policyImage(value.postimage)
  const result = value.mutationKind === "set_desired_state" ? after.desiredStates[value.key] : after.routineActionGrants[value.key]
  if (!result || value.preimageVersion !== before.version || value.postimageVersion !== after.version
    || after.version !== before.version + 1 || result.version !== after.version || after.updatedAt !== value.at
    || value.preimageSha256 !== sha256(value.preimage) || value.postimageSha256 !== sha256(value.postimage)
    || value.postimage !== JSON.stringify(after, null, 2) || !isDeepStrictEqual(value.affectedKeyResult, result)
    || value.affectedKeyResultSha256 !== sha256(JSON.stringify(result))
    || value.mutationFingerprint !== mutationFingerprint(value.mutationKind, value.key, result)
    || value.transactionId !== sha256(JSON.stringify([operationIdentity(value.issuer, value.authorizingSessionEvent, value.authorization.requestId, value.mutationKind, value.key), value.mutationFingerprint]))) return false
  if ("action" in result && (result.issuer !== value.issuer || result.authorizingSessionEvent !== value.authorizingSessionEvent || result.authorizedAt !== value.at)) return false
  const expected = {
    ...before, version: after.version, updatedAt: value.at,
    desiredStates: value.mutationKind === "set_desired_state" ? { ...before.desiredStates, [value.key]: result } : before.desiredStates,
    routineActionGrants: value.mutationKind === "grant_routine_action" ? { ...before.routineActionGrants, [value.key]: result } : before.routineActionGrants,
  }
  return isDeepStrictEqual(after, expected)
}

function policyDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "policy")
}

function policyPath(agentRoot: string): string {
  return path.join(policyDir(agentRoot), "steward.json")
}

function receiptsPath(agentRoot: string): string {
  return path.join(policyDir(agentRoot), "action-receipts.ndjson")
}

function auditPath(agentRoot: string): string {
  return path.join(policyDir(agentRoot), "policy-audit.ndjson")
}

function ensureDirectory(agentRoot: string): void {
  fs.mkdirSync(policyDir(agentRoot), { recursive: true, mode: 0o700 })
  fs.chmodSync(policyDir(agentRoot), 0o700)
}

function syncParentDirectory(filePath: string): void {
  const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

function appendReceipt(filePath: string, value: unknown): void {
  const creating = !fs.existsSync(filePath)
  const fd = fs.openSync(filePath, "a", 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(filePath, 0o600)
  if (creating) syncParentDirectory(filePath)
}

function requireText(value: unknown, label: string): string {
  const result = typeof value === "string" ? value.trim() : ""
  if (!result) throw new Error(`${label} must be nonempty`)
  return result
}

function optionalExpiry(value: string | undefined, now?: string): string | undefined {
  if (!value) return undefined
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value || (now !== undefined && epoch <= Date.parse(now))) throw new Error("policy expiry must be a future canonical timestamp")
  return value
}

function validateStewardPolicy(value: unknown): StewardPolicyRecord {
  if (!policyRecord(value)) throw new Error("steward policy is invalid")
  return value
}

function readAuditBytes(agentRoot: string): string {
  try {
    const bytes = fs.readFileSync(auditPath(agentRoot))
    const decoded = bytes.toString("utf8")
    if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error("steward policy audit encoding is invalid")
    return decoded
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
    throw error
  }
}

function readPolicyTransaction(filePath: string, lease: SessionTurnLease) {
  const exists = fs.existsSync(filePath)
  if (exists && fs.statSync(filePath).size > MAX_POLICY_BYTES) throw new Error("steward policy exceeds its bound")
  const snapshot = readSessionTransaction(filePath, lease)
  const raw = exists ? fs.readFileSync(filePath) : Buffer.alloc(0)
  if (!Buffer.from(snapshot.bytes, "utf8").equals(raw)) throw new Error("steward policy encoding or bytes changed")
  return { ...snapshot, exists }
}

function readAuditedPolicy(agentRoot: string, lease: SessionTurnLease) {
  const filePath = policyPath(agentRoot)
  let snapshot = readPolicyTransaction(filePath, lease)
  let policy = !snapshot.exists && snapshot.bytes === "" ? structuredClone(EMPTY_POLICY) : validateStewardPolicy(snapshot.value)
  const auditBytes = readAuditBytes(agentRoot)
  const rows: PolicyAuditRow[] = []
  const seen = new Set<string>()
  const preceding = createHash("sha256")
  let legacyVersion = 0
  if (auditBytes && !auditBytes.endsWith("\n")) throw new Error("steward policy audit has a partial final row")
  for (const line of auditBytes ? auditBytes.slice(0, -1).split("\n") : []) {
    if (Buffer.byteLength(line) > MAX_AUDIT_ROW_BYTES) throw new Error("steward policy audit row exceeds its bound")
    let row: unknown
    try { row = JSON.parse(line) } catch (cause) { throw new Error("steward policy audit row is invalid", { cause }) }
    if (record(row) && row.schemaVersion === 1) {
      if (rows.length || !positiveInteger(row.policyVersion) || row.policyVersion <= legacyVersion) throw new Error("steward policy audit legacy prefix is invalid")
      legacyVersion = row.policyVersion
    } else {
      if (!auditRow(row) || row.precedingBytesSha256 !== preceding.copy().digest("hex")) throw new Error("steward policy audit row is invalid")
      const prior = rows.at(-1)
      if (prior ? row.preimage !== prior.postimage || row.preimageVersion !== prior.postimageVersion : row.preimageVersion !== legacyVersion) throw new Error("steward policy audit chain is invalid")
      const identity = operationIdentity(row.issuer, row.authorizingSessionEvent, row.authorization.requestId, row.mutationKind, row.key)
      if (seen.has(identity)) throw new Error("steward policy audit contains a duplicate transaction")
      seen.add(identity)
      rows.push(row)
    }
    preceding.update(`${line}\n`, "utf8")
  }
  const last = rows.at(-1)
  if (!last) {
    if (policy.version !== legacyVersion) throw new Error("steward policy audit does not match the policy head")
  } else if (snapshot.bytes !== last.postimage) {
    if (snapshot.bytes !== last.preimage) throw new Error("steward policy audit does not match the policy head")
    const fd = fs.openSync(auditPath(agentRoot), "r")
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    syncParentDirectory(auditPath(agentRoot))
    writeSessionTransaction(filePath, policyImage(last.postimage), { lease, expectedRevision: snapshot.revision })
    snapshot = readPolicyTransaction(filePath, lease)
    if (snapshot.bytes !== last.postimage) throw new Error("steward policy audit recovery readback differs")
    policy = validateStewardPolicy(snapshot.value)
    emitNervesEvent({ component: "heart", event: "heart.steward_policy_recovered", message: "recovered an authorized steward policy write", meta: { version: policy.version } })
  }
  return { ...snapshot, policy, rows, auditBytes }
}

function readPolicyState(agentRoot: string): { policy: StewardPolicyRecord; rows: PolicyAuditRow[] } {
  if (!fs.existsSync(policyPath(agentRoot)) && !fs.existsSync(auditPath(agentRoot))) {
    return { policy: structuredClone(EMPTY_POLICY), rows: [] }
  }
  return withImmediateSessionTurnLease(policyPath(agentRoot), (lease) => readAuditedPolicy(agentRoot, lease))
}

export function readStewardPolicy(agentRoot: string): StewardPolicyRecord {
  return readPolicyState(agentRoot).policy
}

export function updateStewardPolicy(agentRoot: string, input: { expectedVersion: number; actor: StewardPolicyActor; mutation: StewardPolicyMutation; now?: string }): StewardPolicyRecord {
  if (input.actor.trustLevel !== "family") throw new Error("steward policy mutation requires family authority")
  const authorizingSessionEvent = requireText(input.actor.sessionEventId, "authorizing session event")
  const issuer = requireText(input.actor.friendId, "issuer")
  const authorization = input.actor.authorization
  if (!ownerAuthorization(authorization)) throw new Error("steward policy mutation requires current owner authorization")
  if (input.mutation.kind !== "set_desired_state" && input.mutation.kind !== "grant_routine_action") throw new Error("steward policy mutation kind is invalid")
  return withImmediateSessionTurnLease(policyPath(agentRoot), (lease) => {
    const snapshot = readAuditedPolicy(agentRoot, lease)
    const current = snapshot.policy
    const now = input.now ?? new Date().toISOString()
    if (!canonicalTime(now)) throw new Error("policy update time must be canonical")
    const expiresAt = optionalExpiry(input.mutation.expiresAt)
    const version = current.version + 1
    if (!positiveInteger(version)) throw new Error("steward policy version is exhausted")
    const next: StewardPolicyRecord = { ...current, version, desiredStates: { ...current.desiredStates }, routineActionGrants: { ...current.routineActionGrants }, updatedAt: now }
    const key = requireText(input.mutation.key, input.mutation.kind === "set_desired_state" ? "desired state key" : "routine action key")
    let affectedKeyResult: DesiredStateEntry | RoutineActionGrant
    if (input.mutation.kind === "set_desired_state") {
      if (input.mutation.provenance !== "stated" && input.mutation.provenance !== "observed" && input.mutation.provenance !== "default") throw new Error("desired state provenance is invalid")
      affectedKeyResult = {
        value: requireText(input.mutation.value, "desired state value"),
        provenance: input.mutation.provenance,
        version,
        source: requireText(input.mutation.source, "desired state source"),
        ...(expiresAt ? { expiresAt } : {}),
      }
      next.desiredStates = { ...current.desiredStates, [key]: affectedKeyResult }
    } else {
      if (input.mutation.provenance !== "stated" && input.mutation.provenance !== "installed_explicit_policy") throw new Error("routine action grants require explicit authority")
      if (!positiveInteger(input.mutation.maxCount) || !positiveInteger(input.mutation.windowMs)) throw new Error("routine action grant bounds are invalid")
      if (input.mutation.verificationRequired !== true) throw new Error("routine action grants require post-action verification")
      if (!Array.isArray(input.mutation.targets) || !Array.isArray(input.mutation.exclusions)) throw new Error("routine action targets and exclusions must be arrays")
      const targets = [...new Set(input.mutation.targets.map((value) => requireText(value, "routine action target")))].sort()
      if (targets.length === 0) throw new Error("routine action grant requires a target")
      affectedKeyResult = {
        action: requireText(input.mutation.action, "routine action"), targets, maxCount: input.mutation.maxCount, windowMs: input.mutation.windowMs,
        verificationRequired: input.mutation.verificationRequired, exclusions: [...new Set(input.mutation.exclusions.map((value) => requireText(value, "routine action exclusion")))].sort(), provenance: input.mutation.provenance,
        issuer, authorizedAt: now, authorizingSessionEvent, version, ...(expiresAt ? { expiresAt } : {}),
      }
      next.routineActionGrants = { ...current.routineActionGrants, [key]: affectedKeyResult }
    }
    const fingerprint = mutationFingerprint(input.mutation.kind, key, affectedKeyResult)
    const identity = operationIdentity(issuer, authorizingSessionEvent, authorization.requestId, input.mutation.kind, key)
    const previousIndex = snapshot.rows.findIndex((row) => operationIdentity(row.issuer, row.authorizingSessionEvent, row.authorization.requestId, row.mutationKind, row.key) === identity)
    if (previousIndex >= 0) {
      const previous = snapshot.rows[previousIndex]!
      const currentResult = previous.mutationKind === "set_desired_state" ? current.desiredStates[key] : current.routineActionGrants[key]
      if (previous.mutationFingerprint !== fingerprint || snapshot.rows.slice(previousIndex + 1).some((row) => row.mutationKind === previous.mutationKind && row.key === key)
        || !isDeepStrictEqual(currentResult, previous.affectedKeyResult)) throw new Error("steward policy transaction replay changed")
      return current
    }
    if (current.version !== input.expectedVersion) throw new Error(`steward policy version changed: expected ${input.expectedVersion}, got ${current.version}`)
    optionalExpiry(expiresAt, now)
    const postimage = JSON.stringify(next, null, 2)
    if (Buffer.byteLength(postimage) > MAX_POLICY_BYTES) throw new Error("steward policy exceeds its bound")
    const row: PolicyAuditRow = {
      schemaVersion: 2, transactionId: sha256(JSON.stringify([identity, fingerprint])), precedingBytesSha256: sha256(snapshot.auditBytes),
      mutationKind: input.mutation.kind, key, mutationFingerprint: fingerprint, affectedKeyResult, affectedKeyResultSha256: sha256(JSON.stringify(affectedKeyResult)),
      issuer, authorizingSessionEvent, authorization: { ...authorization },
      preimage: snapshot.bytes, preimageVersion: current.version, preimageSha256: snapshot.revision,
      postimage, postimageVersion: version, postimageSha256: sha256(postimage), at: now,
    }
    if (Buffer.byteLength(JSON.stringify(row)) > MAX_AUDIT_ROW_BYTES) throw new Error("steward policy audit row exceeds its bound")
    ensureDirectory(agentRoot)
    appendReceipt(auditPath(agentRoot), row)
    writeSessionTransaction(policyPath(agentRoot), next, { lease, expectedRevision: snapshot.revision })
    if (readPolicyTransaction(policyPath(agentRoot), lease).bytes !== postimage) throw new Error("steward policy publication readback differs")
    emitNervesEvent({ component: "heart", event: "heart.steward_policy_updated", message: "updated steward policy", meta: { version, mutationKind: input.mutation.kind, issuer } })
    return next
  })
}

function readActionReceiptHistory(agentRoot: string): RoutineActionReceipt[] {
  const filePath = receiptsPath(agentRoot)
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RoutineActionReceipt)
}

export function readRoutineActionReceipts(agentRoot: string): RoutineActionReceipt[] {
  const latest = new Map<string, RoutineActionReceipt>()
  for (const receipt of readActionReceiptHistory(agentRoot)) latest.set(receipt.id, receipt)
  return [...latest.values()]
}

function currentRequester(value: unknown, target: string): value is RoutineActionRequester {
  if (!record(value) || !text(value.friendId)) return false
  if (value.kind === "owner" || value.kind === "household_request") {
    return exactKeys(value, ["kind", "friendId", "profileId", "requestId", "sessionEventId", "origin"])
      && value.profileId === (value.kind === "owner" ? "sanctuary-owner" : "sanctuary-household")
      && text(value.requestId) && text(value.sessionEventId) && record(value.origin)
      && exactKeys(value.origin, ["friendId", "channel", "key"])
      && value.origin.friendId === value.friendId && value.origin.channel === "telegram" && text(value.origin.key)
  }
  return value.kind === "owner_event" && exactKeys(value, ["kind", "friendId", "profileId", "event", "target"])
    && value.profileId === "sanctuary-event" && record(value.target) && exactKeys(value.target, ["id", "name"])
    && text(value.target.id) && value.target.name === target && record(value.event)
    && exactKeys(value.event, ["schemaVersion", "recordPath", "agent", "source", "eventId", "generation", "observationRevision", "claimOwner"])
    && value.event.schemaVersion === 1 && value.event.source === "sanctuary-health"
    && value.event.eventId === `container:${value.target.id}:availability`
    && text(value.event.recordPath) && text(value.event.agent) && positiveInteger(value.event.generation)
    && text(value.event.observationRevision) && text(value.event.claimOwner)
}

function appliedEntry(rows: readonly PolicyAuditRow[], kind: StewardPolicyMutation["kind"], key: string, entry: DesiredStateEntry | RoutineActionGrant): boolean {
  return rows.some((row) => row.mutationKind === kind && row.key === key && row.postimageVersion === entry.version && isDeepStrictEqual(row.affectedKeyResult, entry))
}

const UNRESOLVED_ACTION_STATES = new Set<RoutineActionReceipt["state"]>(["reserved", "attempting", "effect_acknowledged", "recovery_pending", "indeterminate"])

function inspectRoutineActionGrantSnapshot(
  policy: StewardPolicyRecord,
  rows: readonly PolicyAuditRow[],
  receipts: RoutineActionReceipt[],
  input: RoutineActionGrantInput,
): RoutineActionGrantDecision {
  const now = input.now === undefined ? new Date().toISOString() : input.now
  if (!canonicalTime(now)) return { allowed: false, reason: "routine action time must be canonical" }
  if (!text(input.key) || !text(input.action) || !text(input.target)) return { allowed: false, reason: "routine action requires an exact key, action, and target" }
  if (input.expectedPolicyVersion !== undefined && policy.version !== input.expectedPolicyVersion) return { allowed: false, reason: "routine action policy version changed" }
  if (!currentRequester(input.requester, input.target) || !positiveInteger(input.authorizationVersion)) return { allowed: false, reason: "routine action requires a current versioned requester" }
  const desiredKey = `container:${input.target}`
  const desired = policy.desiredStates[desiredKey]
  if (input.expectedDesiredStateVersion !== undefined && desired?.version !== input.expectedDesiredStateVersion) return { allowed: false, reason: "routine action desired state version changed" }
  const activeDesired = desired && (desired.expiresAt === undefined || Date.parse(desired.expiresAt) > Date.parse(now))
  const desiredValue = desired?.value.toLowerCase()
  if (activeDesired && /^(?:off|disabled|paused|intentionally_off|intentionally_paused)$/u.test(desiredValue!)) return { allowed: false, reason: "container is expected off" }
  const grant = policy.routineActionGrants[input.key]
  if (input.expectedGrantVersion !== undefined && grant?.version !== input.expectedGrantVersion) return { allowed: false, reason: "routine action grant version changed" }
  const fallback = input.requester.kind === "owner" ? { approvalFallback: true as const } : {}
  if (!grant) return { allowed: false, reason: "routine action grant is missing", ...fallback }
  if (grant.provenance !== "stated") return { allowed: false, reason: "routine action grant must be owner-stated" }
  if (!appliedEntry(rows, "grant_routine_action", input.key, grant)) return { allowed: false, reason: "routine action grant has no applied owner authorization" }
  if (grant.action !== input.action) return { allowed: false, reason: "routine action does not match the grant" }
  if (!grant.targets.includes(input.target) || grant.exclusions.includes(input.target)) return { allowed: false, reason: "routine action target is not authorized" }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(now)) return { allowed: false, reason: "routine action grant expired", ...fallback }
  if (!activeDesired || desired.provenance !== "stated" || !appliedEntry(rows, "set_desired_state", desiredKey, desired)) return { allowed: false, reason: "container has no active applied owner-stated desired state" }
  if (!["on", "always_on", "expected_on"].includes(desiredValue!) && !(desiredValue === "on_demand" && input.requester.kind !== "owner_event")) return { allowed: false, reason: "container desired state does not authorize this request" }
  if (receipts.some((receipt) => receipt.action === input.action && receipt.target === input.target && UNRESOLVED_ACTION_STATES.has(receipt.state))) {
    return { allowed: false, reason: "routine action has an unresolved receipt for this target" }
  }
  const windowStart = Date.parse(now) - grant.windowMs
  if (receipts.filter((receipt) => receipt.key === input.key && Date.parse(receipt.reservedAt) > windowStart).length >= grant.maxCount) return { allowed: false, reason: "routine action rate limit reached" }
  return { allowed: true, policyVersion: policy.version, desiredStateVersion: desired.version, grantVersion: grant.version, key: input.key, action: grant.action, target: input.target, requester: input.requester, authorizationVersion: input.authorizationVersion }
}

export function inspectRoutineActionGrant(agentRoot: string, input: RoutineActionGrantInput): RoutineActionGrantDecision {
  try {
    const { policy, rows } = readPolicyState(agentRoot)
    return inspectRoutineActionGrantSnapshot(policy, rows, readRoutineActionReceipts(agentRoot), input)
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : "routine action policy is unavailable" }
  }
}

export function consumeRoutineActionGrant(agentRoot: string, input: {
  key: string
  target: string
  expectedPolicyVersion: number
  expectedDesiredStateVersion?: number
  expectedGrantVersion?: number
  requester: RoutineActionRequester
  action?: string
  authorizationReceiptId: string
  authorizationVersion: number
  attemptId?: string
  expectedBeforeState?: string
  resolvedTarget?: { id: string; name: string }
  effect?: { operation: string; targetId: string }
  now?: string
}): RoutineActionReceipt {
  if (!text(input.authorizationReceiptId)) throw new Error("routine action requires a current authorization receipt")
  const authorizationReceiptId = input.authorizationReceiptId
  return withImmediateSessionTurnLease(policyPath(agentRoot), (lease) => {
    const snapshot = readAuditedPolicy(agentRoot, lease)
    const policy = snapshot.policy
    const grant = policy.routineActionGrants[input.key]
    const now = input.now === undefined ? new Date().toISOString() : input.now
    const action = input.action === undefined ? grant?.action ?? "" : input.action
    const receipts = readRoutineActionReceipts(agentRoot)
    const decision = inspectRoutineActionGrantSnapshot(policy, snapshot.rows, receipts, { ...input, action, now })
    if (!decision.allowed) throw new Error(decision.reason)
    const resolvedTarget = input.resolvedTarget === undefined
      ? decision.requester.kind === "owner_event" ? decision.requester.target : { id: "unresolved", name: input.target }
      : input.resolvedTarget
    if (!record(resolvedTarget) || !text(resolvedTarget.id) || resolvedTarget.name !== input.target) throw new Error("routine action resolved target is invalid")
    if (decision.requester.kind === "owner_event" && resolvedTarget.id !== decision.requester.target.id) throw new Error("routine action event target binding changed")
    ensureDirectory(agentRoot)
    const id = `action-${randomUUID()}`
    const receipt: RoutineActionReceipt = {
      schemaVersion: 2,
      id,
      state: "reserved",
      key: input.key,
      action,
      target: input.target,
      policyVersion: policy.version,
      grantVersion: grant.version,
      desiredStateVersion: decision.desiredStateVersion,
      requester: structuredClone(decision.requester),
      reservedAt: now,
      updatedAt: now,
      authorizationReceiptId,
      authorizationVersion: decision.authorizationVersion,
      attemptId: input.attemptId ?? `attempt-${randomUUID()}`,
      attempt: 1,
      expectedBeforeState: input.expectedBeforeState ?? null,
      resolvedTarget: { id: resolvedTarget.id, name: resolvedTarget.name },
      effect: input.effect ?? { operation: action, targetId: resolvedTarget.id },
      effectReceipt: null,
      verifiedAfterState: null,
      recoveryState: { state: "not_needed", compensation: "none" },
    }
    appendReceipt(receiptsPath(agentRoot), receipt)
    emitNervesEvent({ component: "heart", event: "heart.routine_action_reserved", message: "reserved routine action grant", meta: { key: input.key, target: input.target, policyVersion: policy.version } })
    return receipt
  })
}

export function withStewardPolicyLease<T>(agentRoot: string, operation: (lease: SessionTurnLease) => Promise<T>): Promise<T> {
  return withSessionTurnLease(policyPath(agentRoot), operation)
}

export async function withRoutineActionAttempt(
  agentRoot: string,
  reservation: RoutineActionReceipt,
  validate: () => Promise<void>,
  attempt: () => Promise<void>,
): Promise<void> {
  await withStewardPolicyLease(agentRoot, async (lease) => {
    await validate()
    const snapshot = readAuditedPolicy(agentRoot, lease)
    const receipts = readRoutineActionReceipts(agentRoot)
    const current = receipts.find((receipt) => receipt.id === reservation.id)
    if (!current || current.state !== "reserved" || !isDeepStrictEqual(current, reservation)) throw new Error("routine action reservation changed")
    if (!reservation.requester || reservation.desiredStateVersion === undefined) throw new Error("routine action reservation has no current requester binding")
    const now = new Date().toISOString()
    const decision = inspectRoutineActionGrantSnapshot(snapshot.policy, snapshot.rows, receipts.filter((receipt) => receipt.id !== reservation.id), {
      key: reservation.key, action: reservation.action, target: reservation.target, requester: reservation.requester,
      authorizationVersion: reservation.authorizationVersion, expectedPolicyVersion: reservation.policyVersion,
      expectedDesiredStateVersion: reservation.desiredStateVersion, expectedGrantVersion: reservation.grantVersion, now,
    })
    if (!decision.allowed) throw new Error(decision.reason)
    const reservedAt = Date.parse(reservation.reservedAt)
    const windowStart = Date.parse(now) - snapshot.policy.routineActionGrants[reservation.key]!.windowMs
    if (!(reservedAt > windowStart && reservedAt <= Date.parse(now))) throw new Error("routine action reservation is outside its rate window")
    await attempt()
  })
}

export function transitionRoutineActionReceipt(agentRoot: string, input: {
  id: string
  expectedState: RoutineActionReceipt["state"]
  state: RoutineActionReceipt["state"]
  effectReceipt?: string
  verifiedAfterState?: string
  recoveryState?: RoutineActionReceipt["recoveryState"]
  at?: string
}): RoutineActionReceipt {
  return withImmediateSessionTurnLease(policyPath(agentRoot), () => {
    const current = readRoutineActionReceipts(agentRoot).find((receipt) => receipt.id === input.id)
    if (!current) throw new Error("routine action receipt is missing")
    if (current.state !== input.expectedState) throw new Error(`routine action receipt state changed: expected ${input.expectedState}, got ${current.state}`)
    const now = input.at ?? new Date().toISOString()
    const recoveryState = input.recoveryState ?? current.recoveryState
    const next: RoutineActionReceipt = {
      ...current,
      state: input.state,
      updatedAt: now,
      ...(input.effectReceipt !== undefined ? { effectReceipt: input.effectReceipt } : {}),
      ...(input.verifiedAfterState !== undefined ? { verifiedAfterState: input.verifiedAfterState } : {}),
      recoveryState,
    }
    appendReceipt(receiptsPath(agentRoot), next)
    emitNervesEvent({ component: "heart", event: "heart.routine_action_transitioned", message: "transitioned routine action receipt", meta: { id: next.id, state: next.state, target: next.target } })
    return next
  })
}

export async function recoverRoutineActionReceipts(agentRoot: string, options: {
  observeTarget(target: { id: string; name: string }): Promise<{ id: string; name: string; state: string }>
  afterRecoveryClaim?: (receipt: RoutineActionReceipt) => void
}): Promise<RoutineActionReceipt[]> {
  const recovered: RoutineActionReceipt[] = []
  for (const receipt of readRoutineActionReceipts(agentRoot)) {
    if (receipt.state === "reserved") {
      recovered.push(transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "reserved", state: "recovered_no_effect", recoveryState: { state: "completed", compensation: "none" } }))
      continue
    }
    if (receipt.state === "attempting") {
      recovered.push(transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "attempting", state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } }))
      continue
    }
    if (receipt.state !== "effect_acknowledged" && receipt.state !== "recovery_pending") continue
    const pending = receipt.state === "effect_acknowledged"
      ? transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "effect_acknowledged", state: "recovery_pending", recoveryState: { state: "pending", compensation: "none" } })
      : receipt
    options.afterRecoveryClaim?.(pending)
    const observed = await options.observeTarget(pending.resolvedTarget)
    if (observed.id === pending.resolvedTarget.id && observed.name === pending.resolvedTarget.name && observed.state === "running") {
      recovered.push(transitionRoutineActionReceipt(agentRoot, { id: pending.id, expectedState: "recovery_pending", state: "verified", verifiedAfterState: observed.state, recoveryState: { state: "completed", compensation: "none" } }))
    } else {
      recovered.push(transitionRoutineActionReceipt(agentRoot, { id: pending.id, expectedState: "recovery_pending", state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } }))
    }
  }
  emitNervesEvent({ component: "heart", event: "heart.routine_action_recovery", message: "reconciled interrupted routine action receipts", meta: { recoveredCount: recovered.length } })
  return recovered
}
