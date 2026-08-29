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
  schemaVersion: 1
  id: string
  state: "reserved"
  key: string
  target: string
  policyVersion: number
  grantVersion: number
  reservedAt: string
  expectedBeforeState: string | null
  effectReceipt: string | null
  verifiedAfterState: string | null
  recoveryState: "not_needed" | "pending" | "completed" | "failed"
}

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

function readActionReceipts(agentRoot: string): RoutineActionReceipt[] {
  const filePath = receiptsPath(agentRoot)
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RoutineActionReceipt)
}

export function consumeRoutineActionGrant(agentRoot: string, input: { key: string; target: string; expectedPolicyVersion: number; now?: string }): RoutineActionReceipt {
  return withImmediateSessionTurnLease(receiptsPath(agentRoot), () => {
    const policy = readStewardPolicy(agentRoot)
    if (policy.version !== input.expectedPolicyVersion) throw new Error("routine action policy version changed")
    const grant = policy.routineActionGrants[input.key]
    if (!grant) throw new Error("routine action grant is missing")
    if (!grant.targets.includes(input.target) || grant.exclusions.includes(input.target)) throw new Error("routine action target is not authorized")
    const now = input.now ?? new Date().toISOString()
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(now)) throw new Error("routine action grant expired")
    ensureDirectory(agentRoot)
    const windowStart = Date.parse(now) - grant.windowMs
    const used = readActionReceipts(agentRoot).filter((receipt) => receipt.key === input.key && Date.parse(receipt.reservedAt) > windowStart).length
    if (used >= grant.maxCount) throw new Error("routine action rate limit reached")
    const receipt: RoutineActionReceipt = {
      schemaVersion: 1,
      id: `action-${randomUUID()}`,
      state: "reserved",
      key: input.key,
      target: input.target,
      policyVersion: policy.version,
      grantVersion: grant.version,
      reservedAt: now,
      expectedBeforeState: null,
      effectReceipt: null,
      verifiedAfterState: null,
      recoveryState: "not_needed",
    }
    appendReceipt(receiptsPath(agentRoot), receipt)
    emitNervesEvent({ component: "heart", event: "heart.routine_action_reserved", message: "reserved routine action grant", meta: { key: input.key, target: input.target, policyVersion: policy.version } })
    return receipt
  })
}
