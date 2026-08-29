import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type { TrustLevel } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { readSessionTransaction, withImmediateSessionTurnLease, writeSessionTransaction } from "../mind/session-transaction"

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
}

export type StewardPolicyMutation =
  | { kind: "set_desired_state"; key: string; value: string; provenance: LearnedPolicyProvenance; source: string; expiresAt?: string }
  | { kind: "grant_routine_action"; key: string; action: string; targets: string[]; maxCount: number; windowMs: number; verificationRequired: boolean; exclusions: string[]; provenance: ActionGrantProvenance | "observed" | "default"; expiresAt?: string }

export interface RoutineActionReceipt {
  schemaVersion: 2
  id: string
  state: "reserved" | "attempting" | "effect_acknowledged" | "recovery_pending" | "verified" | "failed" | "indeterminate" | "recovered_no_effect"
  key: string
  action: string
  target: string
  policyVersion: number
  grantVersion: number
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
  | { allowed: true; policyVersion: number; grantVersion: number; key: string; action: string; target: string }
  | { allowed: false; reason: string }

const EMPTY_POLICY: StewardPolicyRecord = { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null }

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

function appendReceipt(filePath: string, value: unknown): void {
  const fd = fs.openSync(filePath, "a", 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(filePath, 0o600)
}

function requireText(value: string, label: string): string {
  const result = value.trim()
  if (!result) throw new Error(`${label} must be nonempty`)
  return result
}

function optionalExpiry(value: string | undefined, now: string): string | undefined {
  if (!value) return undefined
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value || epoch <= Date.parse(now)) throw new Error("policy expiry must be a future canonical timestamp")
  return value
}

function validateStewardPolicy(value: unknown): StewardPolicyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("steward policy is invalid")
  const candidate = value as Partial<StewardPolicyRecord>
  if (candidate.schemaVersion !== 1 || !Number.isInteger(candidate.version) || candidate.version! < 0 || typeof candidate.desiredStates !== "object" || !candidate.desiredStates || typeof candidate.routineActionGrants !== "object" || !candidate.routineActionGrants) {
    throw new Error("steward policy is invalid")
  }
  return candidate as StewardPolicyRecord
}

export function readStewardPolicy(agentRoot: string): StewardPolicyRecord {
  const filePath = policyPath(agentRoot)
  if (!fs.existsSync(filePath)) return structuredClone(EMPTY_POLICY)
  return validateStewardPolicy(JSON.parse(fs.readFileSync(filePath, "utf8")))
}

export function updateStewardPolicy(agentRoot: string, input: { expectedVersion: number; actor: StewardPolicyActor; mutation: StewardPolicyMutation; now?: string }): StewardPolicyRecord {
  if (input.actor.trustLevel !== "family") throw new Error("steward policy mutation requires family authority")
  const authorizingSessionEvent = requireText(input.actor.sessionEventId, "authorizing session event")
  const issuer = requireText(input.actor.friendId, "issuer")
  return withImmediateSessionTurnLease(policyPath(agentRoot), (lease) => {
    const snapshot = readSessionTransaction(policyPath(agentRoot), lease)
    const current = snapshot.value === null ? structuredClone(EMPTY_POLICY) : validateStewardPolicy(snapshot.value)
    if (current.version !== input.expectedVersion) throw new Error(`steward policy version changed: expected ${input.expectedVersion}, got ${current.version}`)
    const now = input.now ?? new Date().toISOString()
    const expiresAt = optionalExpiry(input.mutation.expiresAt, now)
    const version = current.version + 1
    const next: StewardPolicyRecord = { ...current, version, desiredStates: { ...current.desiredStates }, routineActionGrants: { ...current.routineActionGrants }, updatedAt: now }
    if (input.mutation.kind === "set_desired_state") {
      next.desiredStates[requireText(input.mutation.key, "desired state key")] = {
        value: requireText(input.mutation.value, "desired state value"),
        provenance: input.mutation.provenance,
        version,
        source: requireText(input.mutation.source, "desired state source"),
        ...(expiresAt ? { expiresAt } : {}),
      }
    } else {
      if (input.mutation.provenance !== "stated" && input.mutation.provenance !== "installed_explicit_policy") throw new Error("routine action grants require explicit authority")
      if (!Number.isInteger(input.mutation.maxCount) || input.mutation.maxCount < 1 || !Number.isFinite(input.mutation.windowMs) || input.mutation.windowMs <= 0) throw new Error("routine action grant bounds are invalid")
      if (!input.mutation.verificationRequired) throw new Error("routine action grants require post-action verification")
      const targets = [...new Set(input.mutation.targets.map((value) => requireText(value, "routine action target")))]
      if (targets.length === 0) throw new Error("routine action grant requires a target")
      next.routineActionGrants[requireText(input.mutation.key, "routine action key")] = {
        action: requireText(input.mutation.action, "routine action"), targets, maxCount: input.mutation.maxCount, windowMs: input.mutation.windowMs,
        verificationRequired: input.mutation.verificationRequired, exclusions: [...new Set(input.mutation.exclusions)], provenance: input.mutation.provenance,
        issuer, authorizedAt: now, authorizingSessionEvent, version, ...(expiresAt ? { expiresAt } : {}),
      }
    }
    ensureDirectory(agentRoot)
    writeSessionTransaction(policyPath(agentRoot), next, { lease, expectedRevision: snapshot.revision })
    appendReceipt(auditPath(agentRoot), { schemaVersion: 1, policyVersion: version, issuer, authorizingSessionEvent, mutationKind: input.mutation.kind, at: now })
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

function expectedOff(policy: StewardPolicyRecord, target: string, now: string): boolean {
  const desired = policy.desiredStates[`container:${target}`]
  if (!desired || (desired.expiresAt && Date.parse(desired.expiresAt) <= Date.parse(now))) return false
  return /^(?:off|disabled|paused|intentionally_off|intentionally_paused)$/u.test(desired.value.trim().toLowerCase())
}

export function inspectRoutineActionGrant(agentRoot: string, input: { key: string; action: string; target: string; expectedPolicyVersion?: number; now?: string }): RoutineActionGrantDecision {
  try {
    const policy = readStewardPolicy(agentRoot)
    if (input.expectedPolicyVersion !== undefined && policy.version !== input.expectedPolicyVersion) return { allowed: false, reason: "routine action policy version changed" }
    const grant = policy.routineActionGrants[input.key]
    if (!grant) return { allowed: false, reason: "routine action grant is missing" }
    if (grant.action !== input.action) return { allowed: false, reason: "routine action does not match the grant" }
    if (!grant.targets.includes(input.target) || grant.exclusions.includes(input.target)) return { allowed: false, reason: "routine action target is not authorized" }
    const now = input.now ?? new Date().toISOString()
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(now)) return { allowed: false, reason: "routine action grant expired" }
    if (expectedOff(policy, input.target, now)) return { allowed: false, reason: "container is expected off" }
    return { allowed: true, policyVersion: policy.version, grantVersion: grant.version, key: input.key, action: grant.action, target: input.target }
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : "routine action policy is unavailable" }
  }
}

export function consumeRoutineActionGrant(agentRoot: string, input: {
  key: string
  target: string
  expectedPolicyVersion: number
  action?: string
  authorizationReceiptId?: string
  authorizationVersion?: number
  attemptId?: string
  expectedBeforeState?: string
  resolvedTarget?: { id: string; name: string }
  effect?: { operation: string; targetId: string }
  now?: string
}): RoutineActionReceipt {
  return withImmediateSessionTurnLease(receiptsPath(agentRoot), () => {
    const policy = readStewardPolicy(agentRoot)
    const grant = policy.routineActionGrants[input.key]
    const now = input.now ?? new Date().toISOString()
    const action = input.action ?? grant?.action ?? ""
    const decision = inspectRoutineActionGrant(agentRoot, { key: input.key, action, target: input.target, expectedPolicyVersion: input.expectedPolicyVersion, now })
    if (!decision.allowed) throw new Error(decision.reason)
    if (!grant) throw new Error("routine action grant is missing")
    ensureDirectory(agentRoot)
    const windowStart = Date.parse(now) - grant.windowMs
    const used = readRoutineActionReceipts(agentRoot).filter((receipt) => receipt.key === input.key && Date.parse(receipt.reservedAt) > windowStart).length
    if (used >= grant.maxCount) throw new Error("routine action rate limit reached")
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
      reservedAt: now,
      updatedAt: now,
      authorizationReceiptId: input.authorizationReceiptId ?? `policy-${grant.issuer}-${grant.authorizingSessionEvent}`,
      authorizationVersion: input.authorizationVersion ?? grant.version,
      attemptId: input.attemptId ?? `attempt-${randomUUID()}`,
      attempt: 1,
      expectedBeforeState: input.expectedBeforeState ?? null,
      resolvedTarget: input.resolvedTarget ?? { id: "unresolved", name: input.target },
      effect: input.effect ?? { operation: action, targetId: input.resolvedTarget?.id ?? "unresolved" },
      effectReceipt: null,
      verifiedAfterState: null,
      recoveryState: { state: "not_needed", compensation: "none" },
    }
    appendReceipt(receiptsPath(agentRoot), receipt)
    emitNervesEvent({ component: "heart", event: "heart.routine_action_reserved", message: "reserved routine action grant", meta: { key: input.key, target: input.target, policyVersion: policy.version } })
    return receipt
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
  return withImmediateSessionTurnLease(receiptsPath(agentRoot), () => {
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
