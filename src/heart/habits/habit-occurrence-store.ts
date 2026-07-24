import { createHash, randomUUID } from "crypto"
import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, sha256CanonicalJson } from "../runtime/canonical-json"
import {
  acquireProtectedLock,
  readProtectedJson,
  readProtectedJsonOptional,
  writeProtectedJsonUnderLock,
  type ProtectedLock,
} from "../runtime/protected-json-store"
import { parseProcessIdentity, type ExactProcessState, type ProcessIdentity } from "../runtime/process-identity"
import {
  parseHabitExecutionEnvelope,
  type HabitEvidenceV1,
  type HabitExecutionEnvelopeV1,
  type HabitExecutionErrorV1,
  type HabitExecutionResultV1,
  type HabitReconciliationResultV1,
  type HabitUnknownReason,
} from "./habit-execution"
import { occurrenceIdentityForScheduledSlot } from "./habit-cadence-v1"

export type HabitOccurrenceState = "running" | "completed" | "failed_retryable" | "failed_terminal" | "outcome_unknown"

export type HabitTerminalDispositionV1 =
  | { kind: "adapter_terminal"; resultSha256: string }
  | { kind: "reconciliation_terminal"; evidence: HabitEvidenceV1; evidenceSha256: string }
  | { kind: "retry_exhausted"; maxAttempts: number; sourceResultSha256: string; exhaustedAt: string }
  | {
      kind: "schedule_superseded"
      priorScheduleRevision: string
      activeScheduleRevision: string
      scheduleProvenanceSha256: string
      supersededAt: string
    }

export interface HabitAttemptV1 {
  attemptId: string
  ordinal: number
  state: HabitOccurrenceState
  terminalDisposition: HabitTerminalDispositionV1 | null
  trigger: { kind: string; observedAt: string; scheduleProofRef: string | null }
  owner: ProcessIdentity & { daemonInstanceId: string }
  claimedAt: string
  deadlineAt: string
  settledAt: string | null
  result: HabitExecutionResultV1 | null
  unknownReason: HabitUnknownReason | null
  unknownEvidence: HabitEvidenceV1[]
  reconciliation: HabitReconciliationResultV1 | null
}

export interface HabitOccurrenceV1 {
  schemaVersion: 1
  recordVersion: number
  occurrenceId: string
  agent: string
  habitId: string
  slot:
    | { kind: "scheduled"; slotKey: string; scheduleRevision: string; scheduledAtUtc: string }
    | { kind: "manual"; requestId: string }
  execution: HabitExecutionEnvelopeV1
  maxAttempts: number
  state: HabitOccurrenceState
  terminalDisposition: HabitTerminalDispositionV1 | null
  activeAttemptId: string | null
  latestAttemptId: string
  attempts: HabitAttemptV1[]
  createdAt: string
  updatedAt: string
}

export interface HabitUnknownSlotFenceV1 {
  schemaVersion: 1
  agent: string
  habitId: string
  revision: number
  priorFenceSha256: string | null
  mode: "habit"
  state: "open" | "blocked"
  blockingOccurrenceId: string | null
  blockingOccurrenceRef: string | null
  blockingOccurrenceSha256: string | null
  blockingAttemptId: string | null
  updatedAt: string
}

interface HabitUnknownFenceTxnV1 {
  schemaVersion: 1
  transactionId: string
  revision: number
  priorTxnSha256: string | null
  agent: string
  habitId: string
  state: "prepared" | "committed"
  priorOccurrenceRef: string
  priorOccurrenceSha256: string
  nextOccurrenceRef: string
  nextOccurrenceSha256: string
  priorFenceRef: string | null
  priorFenceSha256: string | null
  nextFenceRef: string
  nextFenceSha256: string
  occurrenceHeadApplied: boolean
  fenceHeadApplied: boolean
  preparedAt: string
  committedAt: string | null
}

export interface HabitOccurrenceClaimInput {
  habitId: string
  slot: { kind: "scheduled"; slotKey: string; scheduleRevision: string; scheduledAtUtc: string }
  execution: HabitExecutionEnvelopeV1
  trigger: { kind: string; observedAt: string; scheduleProofRef: string | null }
  deadlineAt: string
  scheduleProvenanceSha256?: string
}

export interface HabitManualClaimInput {
  habitId: string
  requestId: string
  execution: HabitExecutionEnvelopeV1
  trigger: { kind: string; observedAt: string; scheduleProofRef: string | null }
  deadlineAt: string
}

export type HabitOccurrenceClaimResult =
  | { kind: "claimed"; occurrence: HabitOccurrenceV1; attempt: HabitAttemptV1 }
  | {
      kind: "blocked"
      reason: "active_attempt" | "unknown_slot_fence" | "occurrence_settled" | "retry_not_due" | "outcome_unknown"
      occurrenceId: string
    }

export type HabitFenceAdmissionResult =
  | { kind: "admitted" }
  | { kind: "blocked"; reason: "unknown_slot_fence" | "retry_not_due"; occurrenceId: string }

export interface HabitReconciliationCandidateV1 {
  occurrenceId: string
  attemptId: string
  execution: HabitExecutionEnvelopeV1
  unknownReason: HabitUnknownReason
  priorEvidence: HabitEvidenceV1[]
}

export interface HabitOwnedReconciliationInputV1 {
  occurrenceId: string
  attemptId: string
  adapter: { id: string; version: 1 }
  priorEvidence: HabitEvidenceV1[]
  result: HabitReconciliationResultV1
}

export interface HabitOccurrenceStoreOptions {
  bundleRoot: string
  agent: string
  owner: ProcessIdentity & { daemonInstanceId: string }
  now(): string
  proveOwnerState(owner: ProcessIdentity): ExactProcessState
  fault?(point: "after_txn_prepared" | "after_occurrence_head" | "after_fence_head"): void
}

export class HabitOccurrenceCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HabitOccurrenceCorruptError"
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HabitOccurrenceCorruptError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HabitOccurrenceCorruptError(`${label} must be non-empty`)
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (actual.join("\0") !== expected.join("\0")) {
    throw new HabitOccurrenceCorruptError(`${label} fields are invalid`)
  }
}

function timestamp(value: unknown, label: string): string {
  const text = nonEmptyString(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new HabitOccurrenceCorruptError(`${label} must be canonical UTC time`)
  }
  return text
}

function sha256(value: unknown): string {
  return sha256CanonicalJson(value)
}

function base64UrlSha256(value: unknown): string {
  return createHash("sha256").update(Buffer.from(canonicalizeJson(value), "utf8")).digest("base64url")
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T
}

function evidence(value: unknown): HabitEvidenceV1 {
  const raw = record(value, "habit evidence")
  exactKeys(raw, ["kind", "ref", "sha256", "observedAt"], "habit evidence")
  if (raw.kind !== "adapter-owned" || typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    throw new HabitOccurrenceCorruptError("habit evidence is invalid")
  }
  return {
    kind: "adapter-owned",
    ref: nonEmptyString(raw.ref, "habit evidence ref"),
    sha256: raw.sha256,
    observedAt: timestamp(raw.observedAt, "habit evidence observedAt"),
  }
}

function executionError(value: unknown): HabitExecutionErrorV1 {
  const raw = record(value, "habit execution error")
  exactKeys(raw, ["code", "message", "retryable"], "habit execution error")
  if (typeof raw.retryable !== "boolean") throw new HabitOccurrenceCorruptError("habit execution error retryable is invalid")
  return {
    code: nonEmptyString(raw.code, "habit execution error code"),
    message: nonEmptyString(raw.message, "habit execution error message"),
    retryable: raw.retryable,
  }
}

function executionResult(value: unknown): HabitExecutionResultV1 {
  const raw = record(value, "habit execution result")
  if (raw.version !== 1) throw new HabitOccurrenceCorruptError("habit execution result version is invalid")
  if (raw.status === "completed") {
    exactKeys(raw, ["version", "status", "resultRef"], "completed execution result")
    return { version: 1, status: "completed", resultRef: nonEmptyString(raw.resultRef, "execution result ref") }
  }
  if (raw.status === "failed_terminal") {
    exactKeys(raw, ["version", "status", "error"], "terminal execution result")
    const error = executionError(raw.error)
    if (error.retryable) throw new HabitOccurrenceCorruptError("terminal execution error cannot be retryable")
    return { version: 1, status: "failed_terminal", error }
  }
  if (raw.status === "failed_retryable") {
    exactKeys(raw, ["version", "status", "error", "safeRetryEvidence", "notBefore"], "retryable execution result")
    const error = executionError(raw.error)
    if (!error.retryable) throw new HabitOccurrenceCorruptError("retryable execution error must be retryable")
    return {
      version: 1,
      status: "failed_retryable",
      error,
      safeRetryEvidence: evidence(raw.safeRetryEvidence),
      notBefore: timestamp(raw.notBefore, "retry notBefore"),
    }
  }
  throw new HabitOccurrenceCorruptError("habit execution result status is invalid")
}

function reconciliationResult(value: unknown): HabitReconciliationResultV1 {
  const raw = record(value, "habit reconciliation result")
  if (raw.version !== 1) throw new HabitOccurrenceCorruptError("habit reconciliation result version is invalid")
  if (raw.disposition === "unresolved") {
    exactKeys(raw, ["version", "disposition"], "unresolved reconciliation result")
    return { version: 1, disposition: "unresolved" }
  }
  if (raw.disposition === "completed") {
    exactKeys(raw, ["version", "disposition", "resultRef", "evidence"], "completed reconciliation result")
    return {
      version: 1,
      disposition: "completed",
      resultRef: nonEmptyString(raw.resultRef, "reconciliation result ref"),
      evidence: evidence(raw.evidence),
    }
  }
  if (raw.disposition === "safe_retry") {
    exactKeys(raw, ["version", "disposition", "error", "notBefore", "evidence"], "retry reconciliation result")
    const error = executionError(raw.error)
    if (!error.retryable) throw new HabitOccurrenceCorruptError("safe-retry reconciliation error must be retryable")
    return {
      version: 1,
      disposition: "safe_retry",
      error,
      notBefore: timestamp(raw.notBefore, "reconciliation notBefore"),
      evidence: evidence(raw.evidence),
    }
  }
  if (raw.disposition === "failed_terminal") {
    exactKeys(raw, ["version", "disposition", "error", "evidence"], "terminal reconciliation result")
    const error = executionError(raw.error)
    if (error.retryable) throw new HabitOccurrenceCorruptError("terminal reconciliation error cannot be retryable")
    return {
      version: 1,
      disposition: "failed_terminal",
      error,
      evidence: evidence(raw.evidence),
    }
  }
  throw new HabitOccurrenceCorruptError("habit reconciliation disposition is invalid")
}

const UNKNOWN_REASONS = new Set<HabitUnknownReason>([
  "adapter_exception",
  "execution_timeout",
  "owner_died",
  "aborted_after_invoke",
  "invalid_result",
  "result_absent",
  "adapter_transport_unknown",
  "adapter_reported_unknown",
])

function unknownReason(value: unknown): HabitUnknownReason | null {
  if (value === null) return null
  if (typeof value !== "string" || !UNKNOWN_REASONS.has(value as HabitUnknownReason)) {
    throw new HabitOccurrenceCorruptError("habit unknown reason is invalid")
  }
  return value as HabitUnknownReason
}

function terminalDisposition(value: unknown): HabitTerminalDispositionV1 | null {
  if (value === null) return null
  const raw = record(value, "habit terminal disposition")
  if (raw.kind === "adapter_terminal") {
    exactKeys(raw, ["kind", "resultSha256"], "adapter terminal disposition")
    if (typeof raw.resultSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.resultSha256)) {
      throw new HabitOccurrenceCorruptError("adapter terminal result hash is invalid")
    }
    return { kind: "adapter_terminal", resultSha256: raw.resultSha256 }
  }
  if (raw.kind === "reconciliation_terminal") {
    exactKeys(raw, ["kind", "evidence", "evidenceSha256"], "reconciliation terminal disposition")
    const parsedEvidence = evidence(raw.evidence)
    if (raw.evidenceSha256 !== sha256(parsedEvidence)) {
      throw new HabitOccurrenceCorruptError("reconciliation terminal evidence hash is invalid")
    }
    return { kind: "reconciliation_terminal", evidence: parsedEvidence, evidenceSha256: raw.evidenceSha256 as string }
  }
  if (raw.kind === "retry_exhausted") {
    exactKeys(raw, ["kind", "maxAttempts", "sourceResultSha256", "exhaustedAt"], "retry exhausted disposition")
    if (!Number.isSafeInteger(raw.maxAttempts) || Number(raw.maxAttempts) < 1 || Number(raw.maxAttempts) > 10) {
      throw new HabitOccurrenceCorruptError("retry exhausted attempt limit is invalid")
    }
    if (typeof raw.sourceResultSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sourceResultSha256)) {
      throw new HabitOccurrenceCorruptError("retry exhausted source hash is invalid")
    }
    return {
      kind: "retry_exhausted",
      maxAttempts: Number(raw.maxAttempts),
      sourceResultSha256: raw.sourceResultSha256,
      exhaustedAt: timestamp(raw.exhaustedAt, "retry exhausted time"),
    }
  }
  if (raw.kind === "schedule_superseded") {
    exactKeys(raw, ["kind", "priorScheduleRevision", "activeScheduleRevision", "scheduleProvenanceSha256", "supersededAt"], "schedule superseded disposition")
    const priorScheduleRevision = hashToken(raw.priorScheduleRevision, "prior schedule revision")
    const activeScheduleRevision = hashToken(raw.activeScheduleRevision, "active schedule revision")
    if (typeof raw.scheduleProvenanceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.scheduleProvenanceSha256)) {
      throw new HabitOccurrenceCorruptError("schedule provenance hash is invalid")
    }
    return {
      kind: "schedule_superseded",
      priorScheduleRevision,
      activeScheduleRevision,
      scheduleProvenanceSha256: raw.scheduleProvenanceSha256,
      supersededAt: timestamp(raw.supersededAt, "schedule superseded time"),
    }
  }
  throw new HabitOccurrenceCorruptError("habit terminal disposition kind is invalid")
}

function hashToken(value: unknown, label: string): string {
  const token = nonEmptyString(value, label)
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HabitOccurrenceCorruptError(`${label} is not a base64url SHA-256`)
  return token
}

function parseAttempt(value: unknown, occurrenceId: string, expectedOrdinal: number): HabitAttemptV1 {
  const raw = record(value, "habit attempt")
  exactKeys(raw, [
    "attemptId", "ordinal", "state", "terminalDisposition", "trigger", "owner", "claimedAt", "deadlineAt",
    "settledAt", "result", "unknownReason", "unknownEvidence", "reconciliation",
  ], "habit attempt")
  if (raw.ordinal !== expectedOrdinal) throw new HabitOccurrenceCorruptError("habit attempt ordinal is not consecutive")
  const expectedAttemptId = `hat_${base64UrlSha256({ schemaVersion: 1, occurrenceId, ordinal: expectedOrdinal })}`
  if (raw.attemptId !== expectedAttemptId) throw new HabitOccurrenceCorruptError("habit attempt ID is not derived from its occurrence")
  const state = raw.state
  if (!["running", "completed", "failed_retryable", "failed_terminal", "outcome_unknown"].includes(String(state))) {
    throw new HabitOccurrenceCorruptError("habit attempt state is invalid")
  }
  const trigger = record(raw.trigger, "habit attempt trigger")
  exactKeys(trigger, ["kind", "observedAt", "scheduleProofRef"], "habit attempt trigger")
  const owner = record(raw.owner, "habit attempt owner")
  exactKeys(owner, ["uid", "pid", "startIdentity", "bootId", "daemonInstanceId"], "habit attempt owner")
  const processOwner = parseProcessIdentity({
    uid: owner.uid,
    pid: owner.pid,
    startIdentity: owner.startIdentity,
    bootId: owner.bootId,
  })
  const parsedResult = raw.result === null ? null : executionResult(raw.result)
  const parsedUnknownReason = unknownReason(raw.unknownReason)
  const parsedEvidence = Array.isArray(raw.unknownEvidence) ? raw.unknownEvidence.map(evidence) : null
  if (parsedEvidence === null) throw new HabitOccurrenceCorruptError("habit unknown evidence must be an array")
  const parsedReconciliation = raw.reconciliation === null ? null : reconciliationResult(raw.reconciliation)
  const parsedDisposition = terminalDisposition(raw.terminalDisposition)
  const settledAt = raw.settledAt === null ? null : timestamp(raw.settledAt, "habit attempt settledAt")
  const parsed: HabitAttemptV1 = {
    attemptId: expectedAttemptId,
    ordinal: expectedOrdinal,
    state: state as HabitOccurrenceState,
    terminalDisposition: parsedDisposition,
    trigger: {
      kind: nonEmptyString(trigger.kind, "habit attempt trigger kind"),
      observedAt: timestamp(trigger.observedAt, "habit attempt trigger observedAt"),
      scheduleProofRef: trigger.scheduleProofRef === null ? null : nonEmptyString(trigger.scheduleProofRef, "schedule proof ref"),
    },
    owner: {
      ...processOwner,
      daemonInstanceId: nonEmptyString(owner.daemonInstanceId, "owner daemon instance ID"),
    },
    claimedAt: timestamp(raw.claimedAt, "habit attempt claimedAt"),
    deadlineAt: timestamp(raw.deadlineAt, "habit attempt deadlineAt"),
    settledAt,
    result: parsedResult,
    unknownReason: parsedUnknownReason,
    unknownEvidence: parsedEvidence,
    reconciliation: parsedReconciliation,
  }
  if (parsed.state === "running") {
    if (settledAt !== null || parsedResult !== null || parsedUnknownReason !== null || parsedEvidence.length > 0 || parsedReconciliation !== null || parsedDisposition !== null) {
      throw new HabitOccurrenceCorruptError("running attempt contains settlement state")
    }
  } else if (settledAt === null) {
    throw new HabitOccurrenceCorruptError("settled attempt is missing settledAt")
  }
  if (parsed.state === "outcome_unknown") {
    if (parsedResult !== null || parsedDisposition !== null || parsedUnknownReason === null) {
      throw new HabitOccurrenceCorruptError("unknown attempt settlement is invalid")
    }
  } else if (parsed.state !== "running" && parsedResult === null) {
    throw new HabitOccurrenceCorruptError("settled attempt is missing its result")
  }
  if ((parsedUnknownReason === "adapter_reported_unknown") !== (parsedEvidence.length === 1)) {
    throw new HabitOccurrenceCorruptError("attempt unknown evidence does not match its reason")
  }
  if (parsedUnknownReason === null && parsedEvidence.length > 0) {
    throw new HabitOccurrenceCorruptError("attempt without an unknown reason has evidence")
  }
  if ((parsed.state === "failed_terminal") !== (parsedDisposition !== null)) {
    throw new HabitOccurrenceCorruptError("attempt terminal disposition does not match state")
  }
  if (parsed.state === "completed" && parsedResult?.status !== "completed") {
    throw new HabitOccurrenceCorruptError("completed attempt result is invalid")
  }
  if (parsed.state === "failed_retryable" && parsedResult?.status !== "failed_retryable") {
    throw new HabitOccurrenceCorruptError("retryable attempt result is invalid")
  }
  if (parsed.state === "failed_terminal") {
    if (parsedDisposition?.kind === "adapter_terminal" && (
      parsedResult?.status !== "failed_terminal" || parsedDisposition.resultSha256 !== sha256(parsedResult)
    )) {
      throw new HabitOccurrenceCorruptError("adapter terminal disposition does not match its result")
    }
    if (parsedDisposition?.kind === "retry_exhausted" && (
      parsedResult?.status !== "failed_retryable" || parsedDisposition.sourceResultSha256 !== sha256(parsedResult)
    )) {
      throw new HabitOccurrenceCorruptError("retry-exhausted disposition does not match its result")
    }
    if (parsedDisposition?.kind === "reconciliation_terminal" && parsedResult?.status !== "failed_terminal") {
      throw new HabitOccurrenceCorruptError("reconciliation terminal disposition does not match its result")
    }
    if (parsedDisposition?.kind === "schedule_superseded" && parsedResult?.status !== "failed_retryable") {
      throw new HabitOccurrenceCorruptError("schedule supersession does not retain its retryable result")
    }
  }
  if (parsed.state !== "outcome_unknown" && parsed.state !== "running" && parsedUnknownReason !== null && parsedReconciliation === null) {
    throw new HabitOccurrenceCorruptError("resolved unknown attempt is missing reconciliation evidence")
  }
  return parsed
}

function parseOccurrence(value: unknown): HabitOccurrenceV1 {
  const raw = record(value, "habit occurrence")
  exactKeys(raw, [
    "schemaVersion", "recordVersion", "occurrenceId", "agent", "habitId", "slot", "execution", "maxAttempts",
    "state", "terminalDisposition", "activeAttemptId", "latestAttemptId", "attempts", "createdAt", "updatedAt",
  ], "habit occurrence")
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.recordVersion) || Number(raw.recordVersion) < 1) {
    throw new HabitOccurrenceCorruptError("habit occurrence version is invalid")
  }
  const occurrenceId = nonEmptyString(raw.occurrenceId, "habit occurrence ID")
  const agent = nonEmptyString(raw.agent, "habit occurrence agent")
  const habitId = nonEmptyString(raw.habitId, "habit occurrence habit ID")
  const slot = record(raw.slot, "habit occurrence slot")
  let parsedSlot: HabitOccurrenceV1["slot"]
  if (slot.kind === "scheduled") {
    exactKeys(slot, ["kind", "slotKey", "scheduleRevision", "scheduledAtUtc"], "scheduled occurrence slot")
    parsedSlot = {
      kind: "scheduled",
      slotKey: hashToken(slot.slotKey, "scheduled slot key"),
      scheduleRevision: hashToken(slot.scheduleRevision, "schedule revision"),
      scheduledAtUtc: timestamp(slot.scheduledAtUtc, "scheduled time"),
    }
    const expectedIdentity = occurrenceIdentityForScheduledSlot(agent, habitId, parsedSlot)
    if (occurrenceId !== expectedIdentity.occurrenceId || parsedSlot.slotKey !== expectedIdentity.slotKey) {
      throw new HabitOccurrenceCorruptError("scheduled occurrence identity is invalid")
    }
  } else if (slot.kind === "manual") {
    exactKeys(slot, ["kind", "requestId"], "manual occurrence slot")
    parsedSlot = { kind: "manual", requestId: nonEmptyString(slot.requestId, "manual request ID") }
    if (!/^occ_manual_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(occurrenceId)) {
      throw new HabitOccurrenceCorruptError("manual occurrence ID is invalid")
    }
  } else {
    throw new HabitOccurrenceCorruptError("habit occurrence slot kind is invalid")
  }
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.map((attempt, index) => parseAttempt(attempt, occurrenceId, index + 1))
    : []
  if (attempts.length === 0) throw new HabitOccurrenceCorruptError("habit occurrence has no attempts")
  const state = raw.state as HabitOccurrenceState
  if (!["running", "completed", "failed_retryable", "failed_terminal", "outcome_unknown"].includes(state)) {
    throw new HabitOccurrenceCorruptError("habit occurrence state is invalid")
  }
  const latest = attempts.at(-1)!
  if (raw.latestAttemptId !== latest.attemptId || latest.state !== state) {
    throw new HabitOccurrenceCorruptError("habit occurrence latest attempt does not own aggregate state")
  }
  if (state === "running" && raw.activeAttemptId !== latest.attemptId) {
    throw new HabitOccurrenceCorruptError("running occurrence must name its active attempt")
  }
  if (state !== "running" && raw.activeAttemptId !== null) {
    throw new HabitOccurrenceCorruptError("non-running occurrence cannot name an active attempt")
  }
  const parsedTerminalDisposition = terminalDisposition(raw.terminalDisposition)
  if ((state === "failed_terminal") !== (parsedTerminalDisposition !== null)) {
    throw new HabitOccurrenceCorruptError("terminal disposition does not match occurrence state")
  }
  const execution = parseHabitExecutionEnvelope(raw.execution)
  if (
    !Number.isSafeInteger(raw.maxAttempts) ||
    Number(raw.maxAttempts) < 1 ||
    Number(raw.maxAttempts) > 10 ||
    Number(raw.maxAttempts) !== execution.policy.maxOccurrenceAttempts ||
    attempts.length > Number(raw.maxAttempts)
  ) {
    throw new HabitOccurrenceCorruptError("habit occurrence attempt budget is invalid")
  }
  if (canonicalizeJson(latest.terminalDisposition) !== canonicalizeJson(parsedTerminalDisposition)) {
    throw new HabitOccurrenceCorruptError("aggregate and latest attempt dispositions differ")
  }
  if (parsedTerminalDisposition?.kind === "retry_exhausted" && parsedTerminalDisposition.maxAttempts !== Number(raw.maxAttempts)) {
    throw new HabitOccurrenceCorruptError("retry-exhausted disposition changed the immutable attempt budget")
  }
  if (state === "failed_retryable" && attempts.length >= Number(raw.maxAttempts)) {
    throw new HabitOccurrenceCorruptError("retryable occurrence exhausted its immutable attempt budget")
  }
  for (const priorAttempt of attempts.slice(0, -1)) {
    if (priorAttempt.state === "running") throw new HabitOccurrenceCorruptError("a prior habit attempt remains running")
  }
  const createdAt = timestamp(raw.createdAt, "habit occurrence createdAt")
  const updatedAt = timestamp(raw.updatedAt, "habit occurrence updatedAt")
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new HabitOccurrenceCorruptError("habit occurrence updatedAt precedes createdAt")
  }
  return {
    schemaVersion: 1,
    recordVersion: Number(raw.recordVersion),
    occurrenceId,
    agent,
    habitId,
    slot: parsedSlot,
    execution,
    maxAttempts: Number(raw.maxAttempts),
    state,
    terminalDisposition: parsedTerminalDisposition,
    activeAttemptId: raw.activeAttemptId as string | null,
    latestAttemptId: latest.attemptId,
    attempts,
    createdAt,
    updatedAt,
  }
}

function parseFence(value: unknown): HabitUnknownSlotFenceV1 {
  const raw = record(value, "habit unknown-slot fence")
  exactKeys(raw, [
    "schemaVersion", "agent", "habitId", "revision", "priorFenceSha256", "mode", "state",
    "blockingOccurrenceId", "blockingOccurrenceRef", "blockingOccurrenceSha256", "blockingAttemptId", "updatedAt",
  ], "habit unknown-slot fence")
  if (raw.schemaVersion !== 1 || raw.mode !== "habit" || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new HabitOccurrenceCorruptError("habit unknown-slot fence is invalid")
  }
  const state = raw.state
  if (state !== "open" && state !== "blocked") throw new HabitOccurrenceCorruptError("habit unknown-slot fence state is invalid")
  const blocked = state === "blocked"
  const fields = [raw.blockingOccurrenceId, raw.blockingOccurrenceRef, raw.blockingOccurrenceSha256, raw.blockingAttemptId]
  if (fields.some((item) => (item !== null) !== blocked)) {
    throw new HabitOccurrenceCorruptError("habit unknown-slot fence blocking fields are inconsistent")
  }
  const revision = Number(raw.revision)
  if (
    (revision === 0 && raw.priorFenceSha256 !== null) ||
    (revision > 0 && (typeof raw.priorFenceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.priorFenceSha256)))
  ) {
    throw new HabitOccurrenceCorruptError("habit unknown-slot fence prior hash is invalid")
  }
  return {
    schemaVersion: 1,
    agent: nonEmptyString(raw.agent, "habit fence agent"),
    habitId: nonEmptyString(raw.habitId, "habit fence habit ID"),
    revision,
    priorFenceSha256: raw.priorFenceSha256 as string | null,
    mode: "habit",
    state,
    blockingOccurrenceId: blocked ? nonEmptyString(raw.blockingOccurrenceId, "blocking occurrence ID") : null,
    blockingOccurrenceRef: blocked ? nonEmptyString(raw.blockingOccurrenceRef, "blocking occurrence ref") : null,
    blockingOccurrenceSha256: blocked && typeof raw.blockingOccurrenceSha256 === "string" && /^[0-9a-f]{64}$/.test(raw.blockingOccurrenceSha256)
      ? raw.blockingOccurrenceSha256
      : blocked
        ? (() => { throw new HabitOccurrenceCorruptError("blocking occurrence SHA-256 is invalid") })()
        : null,
    blockingAttemptId: blocked ? nonEmptyString(raw.blockingAttemptId, "blocking attempt ID") : null,
    updatedAt: timestamp(raw.updatedAt, "habit fence updatedAt"),
  }
}

function parseTransaction(value: unknown): HabitUnknownFenceTxnV1 {
  const raw = record(value, "habit unknown-fence transaction")
  exactKeys(raw, [
    "schemaVersion", "transactionId", "revision", "priorTxnSha256", "agent", "habitId", "state",
    "priorOccurrenceRef", "priorOccurrenceSha256", "nextOccurrenceRef", "nextOccurrenceSha256",
    "priorFenceRef", "priorFenceSha256", "nextFenceRef", "nextFenceSha256",
    "occurrenceHeadApplied", "fenceHeadApplied", "preparedAt", "committedAt",
  ], "habit unknown-fence transaction")
  if (raw.schemaVersion !== 1 || (raw.state !== "prepared" && raw.state !== "committed")) {
    throw new HabitOccurrenceCorruptError("habit unknown-fence transaction is invalid")
  }
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new HabitOccurrenceCorruptError("habit unknown-fence transaction revision is invalid")
  }
  const revision = Number(raw.revision)
  if (
    (revision === 0 && raw.priorTxnSha256 !== null) ||
    (revision > 0 && (typeof raw.priorTxnSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.priorTxnSha256)))
  ) {
    throw new HabitOccurrenceCorruptError("habit unknown-fence transaction prior hash is invalid")
  }
  const hash = (field: unknown, label: string): string => {
    if (typeof field !== "string" || !/^[0-9a-f]{64}$/.test(field)) {
      throw new HabitOccurrenceCorruptError(`${label} is invalid`)
    }
    return field
  }
  if (typeof raw.occurrenceHeadApplied !== "boolean" || typeof raw.fenceHeadApplied !== "boolean") {
    throw new HabitOccurrenceCorruptError("habit unknown-fence application flags are invalid")
  }
  if (raw.fenceHeadApplied && !raw.occurrenceHeadApplied) {
    throw new HabitOccurrenceCorruptError("habit unknown-fence transaction applied the fence first")
  }
  if ((raw.state === "committed") !== (raw.committedAt !== null) || (raw.state === "committed" && !raw.fenceHeadApplied)) {
    throw new HabitOccurrenceCorruptError("habit unknown-fence commit state is invalid")
  }
  return {
    schemaVersion: 1,
    transactionId: (() => {
      const id = nonEmptyString(raw.transactionId, "habit unknown-fence transaction ID")
      if (!/^huft_[A-Za-z0-9_-]{43}$/.test(id)) throw new HabitOccurrenceCorruptError("habit unknown-fence transaction ID is invalid")
      return id
    })(),
    revision,
    priorTxnSha256: raw.priorTxnSha256 as string | null,
    agent: nonEmptyString(raw.agent, "habit unknown-fence agent"),
    habitId: nonEmptyString(raw.habitId, "habit unknown-fence habit ID"),
    state: raw.state,
    priorOccurrenceRef: nonEmptyString(raw.priorOccurrenceRef, "prior occurrence ref"),
    priorOccurrenceSha256: hash(raw.priorOccurrenceSha256, "prior occurrence SHA-256"),
    nextOccurrenceRef: nonEmptyString(raw.nextOccurrenceRef, "next occurrence ref"),
    nextOccurrenceSha256: hash(raw.nextOccurrenceSha256, "next occurrence SHA-256"),
    priorFenceRef: raw.priorFenceRef === null ? null : nonEmptyString(raw.priorFenceRef, "prior fence ref"),
    priorFenceSha256: raw.priorFenceSha256 === null ? null : hash(raw.priorFenceSha256, "prior fence SHA-256"),
    nextFenceRef: nonEmptyString(raw.nextFenceRef, "next fence ref"),
    nextFenceSha256: hash(raw.nextFenceSha256, "next fence SHA-256"),
    occurrenceHeadApplied: raw.occurrenceHeadApplied,
    fenceHeadApplied: raw.fenceHeadApplied,
    preparedAt: timestamp(raw.preparedAt, "habit unknown-fence preparedAt"),
    committedAt: raw.committedAt === null ? null : timestamp(raw.committedAt, "habit unknown-fence committedAt"),
  }
}

function resultNotBefore(occurrence: HabitOccurrenceV1): number {
  const result = occurrence.attempts.at(-1)!.result as Extract<HabitExecutionResultV1, { status: "failed_retryable" }>
  return Date.parse(result.notBefore)
}

export class HabitOccurrenceStore {
  readonly options: HabitOccurrenceStoreOptions
  private readonly stateRoot: string
  private readonly occurrenceDir: string
  private readonly fenceDir: string
  private readonly transactionDir: string
  private readonly lockTarget: string

  constructor(options: HabitOccurrenceStoreOptions) {
    this.options = options
    this.stateRoot = path.join(options.bundleRoot, "state", "habits")
    this.occurrenceDir = path.join(this.stateRoot, "occurrences")
    this.fenceDir = path.join(this.stateRoot, "unknown-slot-fences")
    this.transactionDir = path.join(this.stateRoot, "unknown-fence-transactions")
    this.lockTarget = path.join(this.stateRoot, "scheduler-authority.json")
    for (const directory of [this.stateRoot, this.occurrenceDir, this.fenceDir, this.transactionDir]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
  }

  checkFenceAdmission(habitId: string, execution: HabitExecutionEnvelopeV1): HabitFenceAdmissionResult {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      this.safeName(habitId, "habit ID")
      const envelope = parseHabitExecutionEnvelope(execution)
      this.recoverAbandonedAttemptsUnderLock(habitId, lock)
      const fence = envelope.policy.unknownSlotFence === "habit"
        ? this.ensureOpenFence(habitId, lock)
        : this.readFenceOptional(habitId)
      if (fence?.state === "blocked") {
        const blocking = this.requireBlockingOccurrence(fence)
        if (blocking.state === "failed_retryable" && resultNotBefore(blocking) <= Date.parse(this.now())) {
          emitNervesEvent({
            component: "heart",
            event: "heart.habit_occurrence_fenced_retry_admitted",
            message: "admitted the due retry named by the still-blocked habit fence",
            meta: { agent: this.options.agent, habitId, occurrenceId: blocking.occurrenceId },
          })
          return { kind: "admitted" }
        }
        return {
          kind: "blocked",
          reason: blocking.state === "failed_retryable" ? "retry_not_due" : "unknown_slot_fence",
          occurrenceId: fence.blockingOccurrenceId!,
        }
      }
      emitNervesEvent({
        component: "heart",
        event: "heart.habit_occurrence_fence_admitted",
        message: "admitted habit dispatch through the recovered unknown-slot fence",
        meta: { agent: this.options.agent, habitId },
      })
      return { kind: "admitted" }
    })
  }

  claimNext(input: HabitOccurrenceClaimInput): HabitOccurrenceClaimResult {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      this.validateScheduledClaimInput(input)
      const executionEnvelope = parseHabitExecutionEnvelope(input.execution)
      this.recoverAbandonedAttemptsUnderLock(input.habitId, lock)
      const fence = executionEnvelope.policy.unknownSlotFence === "habit"
        ? this.ensureOpenFence(input.habitId, lock)
        : this.readFenceOptional(input.habitId)
      const occurrences = this.listHabitOccurrences(input.habitId)
      this.supersedeOldRetries(occurrences, input, fence, lock)
      const refreshed = this.listHabitOccurrences(input.habitId)
      if (fence?.state === "blocked") {
        const blocking = this.requireBlockingOccurrence(fence)
        if (blocking.state === "failed_retryable" && resultNotBefore(blocking) <= Date.parse(this.now())) {
          return this.appendRetry(blocking, input.trigger, input.deadlineAt, fence, lock)
        }
        return {
          kind: "blocked",
          reason: blocking.state === "failed_retryable" ? "retry_not_due" : "unknown_slot_fence",
          occurrenceId: blocking.occurrenceId,
        }
      }
      const active = refreshed.find((occurrence) => occurrence.state === "running")
      if (active) {
        return {
          kind: "blocked",
          reason: "active_attempt",
          occurrenceId: active.occurrenceId,
        }
      }
      const dueRetry = refreshed
        .filter((occurrence) => occurrence.state === "failed_retryable" && resultNotBefore(occurrence) <= Date.parse(this.now()))
        .sort((left, right) => resultNotBefore(left) - resultNotBefore(right) ||
          this.scheduledAt(left).localeCompare(this.scheduledAt(right)) || left.occurrenceId.localeCompare(right.occurrenceId))[0]
      if (dueRetry) return this.appendRetry(dueRetry, input.trigger, input.deadlineAt, null, lock)

      const occurrenceId = `occ_${input.slot.slotKey}`
      const existing = this.readOccurrenceOptional(occurrenceId)
      if (existing) return { kind: "blocked", reason: "occurrence_settled", occurrenceId }
      return this.createOccurrence({ ...input, execution: executionEnvelope }, occurrenceId, lock)
    })
  }

  claimManual(input: HabitManualClaimInput): HabitOccurrenceClaimResult {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      this.validateManualClaimInput(input)
      const executionEnvelope = parseHabitExecutionEnvelope(input.execution)
      this.recoverAbandonedAttemptsUnderLock(input.habitId, lock)
      const fence = executionEnvelope.policy.unknownSlotFence === "habit"
        ? this.ensureOpenFence(input.habitId, lock)
        : this.readFenceOptional(input.habitId)
      if (fence?.state === "blocked") {
        return { kind: "blocked", reason: "unknown_slot_fence", occurrenceId: fence.blockingOccurrenceId! }
      }
      const active = this.listHabitOccurrences(input.habitId).find((occurrence) => occurrence.state === "running")
      if (active) {
        return {
          kind: "blocked",
          reason: "active_attempt",
          occurrenceId: active.occurrenceId,
        }
      }
      const occurrenceId = `occ_manual_${randomUUID()}`
      return this.createOccurrence({
        ...input,
        execution: executionEnvelope,
        slot: { kind: "manual", requestId: input.requestId },
      }, occurrenceId, lock)
    })
  }

  settle(occurrenceId: string, attemptId: string, result: HabitExecutionResultV1): HabitOccurrenceV1 {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      const prior = this.readOccurrence(occurrenceId)
      const normalizedResult = executionResult(result)
      const latest = prior.attempts.at(-1)!
      if (
        prior.state !== "running" &&
        latest.attemptId === attemptId &&
        latest.result !== null &&
        canonicalizeJson(latest.result) === canonicalizeJson(normalizedResult)
      ) {
        return prior
      }
      const attempt = this.requireCurrentRunningAttempt(prior, attemptId)
      const now = this.now()
      const next = clone(prior)
      const nextAttempt = next.attempts.at(-1)!
      next.recordVersion += 1
      next.updatedAt = now
      next.activeAttemptId = null
      nextAttempt.settledAt = now
      nextAttempt.result = clone(normalizedResult)
      nextAttempt.unknownReason = null
      nextAttempt.unknownEvidence = []
      nextAttempt.reconciliation = null
      if (normalizedResult.status === "completed") {
        next.state = "completed"
        nextAttempt.state = "completed"
        next.terminalDisposition = null
        nextAttempt.terminalDisposition = null
      } else if (normalizedResult.status === "failed_terminal") {
        const disposition: HabitTerminalDispositionV1 = { kind: "adapter_terminal", resultSha256: sha256(normalizedResult) }
        next.state = "failed_terminal"
        nextAttempt.state = "failed_terminal"
        next.terminalDisposition = disposition
        nextAttempt.terminalDisposition = disposition
      } else if (attempt.ordinal >= prior.maxAttempts) {
        const disposition: HabitTerminalDispositionV1 = {
          kind: "retry_exhausted",
          maxAttempts: prior.maxAttempts,
          sourceResultSha256: sha256(normalizedResult),
          exhaustedAt: now,
        }
        next.state = "failed_terminal"
        nextAttempt.state = "failed_terminal"
        next.terminalDisposition = disposition
        nextAttempt.terminalDisposition = disposition
      } else {
        timestamp(normalizedResult.notBefore, "retry notBefore")
        next.state = "failed_retryable"
        nextAttempt.state = "failed_retryable"
        next.terminalDisposition = null
        nextAttempt.terminalDisposition = null
      }
      return this.persistOccurrenceMutation(prior, next, lock)
    })
  }

  markUnknown(
    occurrenceId: string,
    attemptId: string,
    reason: HabitUnknownReason,
    priorEvidence: HabitEvidenceV1[],
  ): HabitOccurrenceV1 {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      const prior = this.readOccurrence(occurrenceId)
      const normalizedEvidence = priorEvidence.map(evidence)
      if ((reason === "adapter_reported_unknown") !== (normalizedEvidence.length === 1)) {
        throw new HabitOccurrenceCorruptError("unknown evidence does not match its reason")
      }
      const latest = prior.attempts.at(-1)!
      if (
        prior.state === "outcome_unknown" &&
        latest.attemptId === attemptId &&
        latest.unknownReason === reason &&
        canonicalizeJson(latest.unknownEvidence) === canonicalizeJson(normalizedEvidence)
      ) {
        return prior
      }
      this.requireCurrentRunningAttempt(prior, attemptId)
      const next = clone(prior)
      const nextAttempt = next.attempts.at(-1)!
      next.recordVersion += 1
      next.state = "outcome_unknown"
      next.terminalDisposition = null
      next.activeAttemptId = null
      next.updatedAt = this.now()
      nextAttempt.state = "outcome_unknown"
      nextAttempt.terminalDisposition = null
      nextAttempt.settledAt = this.now()
      nextAttempt.result = null
      nextAttempt.unknownReason = reason
      nextAttempt.unknownEvidence = normalizedEvidence
      nextAttempt.reconciliation = null
      return this.persistOccurrenceMutation(prior, next, lock)
    })
  }

  listReconciliationCandidates(habitId: string): HabitReconciliationCandidateV1[] {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      this.safeName(habitId, "habit ID")
      this.recoverAbandonedAttemptsUnderLock(habitId, lock)
      return this.listHabitOccurrences(habitId)
        .filter((occurrence) => occurrence.state === "outcome_unknown")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.occurrenceId.localeCompare(right.occurrenceId))
        .map((occurrence) => {
          const attempt = occurrence.attempts.at(-1)!
          return {
            occurrenceId: occurrence.occurrenceId,
            attemptId: attempt.attemptId,
            execution: clone(occurrence.execution),
            unknownReason: attempt.unknownReason!,
            priorEvidence: clone(attempt.unknownEvidence),
          }
        })
    })
  }

  reconcileOwned(
    input: HabitOwnedReconciliationInputV1,
  ): HabitOccurrenceClaimResult | { kind: "settled"; occurrence: HabitOccurrenceV1 } | { kind: "unresolved" } {
    return this.withLock((lock) => {
      this.recoverPreparedTransactionsUnderLock(lock)
      const prior = this.readOccurrence(input.occurrenceId)
      if (prior.execution.adapter !== input.adapter.id || prior.execution.version !== input.adapter.version) {
        throw new HabitOccurrenceCorruptError("reconciliation does not match the recorded adapter pair")
      }
      const normalizedResult = reconciliationResult(input.result)
      const priorAttempt = prior.attempts.at(-1)!
      if (prior.state !== "outcome_unknown" || priorAttempt.attemptId !== input.attemptId) {
        throw new HabitOccurrenceCorruptError("reconciliation does not own the current unknown attempt")
      }
      if (canonicalizeJson(priorAttempt.unknownEvidence) !== canonicalizeJson(input.priorEvidence.map(evidence))) {
        throw new HabitOccurrenceCorruptError("reconciliation evidence differs from durable prior evidence")
      }
      if (normalizedResult.disposition === "unresolved") return { kind: "unresolved" }
      const now = this.now()
      if (normalizedResult.disposition === "safe_retry" && priorAttempt.ordinal < prior.maxAttempts) {
        timestamp(normalizedResult.notBefore, "reconciliation retry notBefore")
        if (Date.parse(normalizedResult.notBefore) > Date.parse(now)) {
          const waiting = clone(prior)
          const waitingAttempt = waiting.attempts.at(-1)!
          waiting.recordVersion += 1
          waiting.state = "failed_retryable"
          waiting.updatedAt = now
          waitingAttempt.state = "failed_retryable"
          waitingAttempt.result = {
            version: 1,
            status: "failed_retryable",
            error: normalizedResult.error,
            safeRetryEvidence: normalizedResult.evidence,
            notBefore: normalizedResult.notBefore,
          }
          waitingAttempt.reconciliation = clone(normalizedResult)
          return { kind: "settled", occurrence: this.persistOccurrenceMutation(prior, waiting, lock) }
        }
        const next = this.retryAfterReconciliation(prior, normalizedResult, now)
        const fence = this.readFenceOptional(prior.habitId)
        const persisted = prior.execution.policy.unknownSlotFence === "habit"
          ? this.writeOccurrenceFencePair(
              prior,
              next,
              fence!,
              this.blockedFenceSuccessor(fence!, next),
              lock,
            )
          : writeProtectedJsonUnderLock(this.occurrencePath(next.occurrenceId), next, parseOccurrence, lock)
        return { kind: "claimed", occurrence: persisted, attempt: persisted.attempts.at(-1)! }
      }

      const next = clone(prior)
      const nextAttempt = next.attempts.at(-1)!
      next.recordVersion += 1
      next.activeAttemptId = null
      next.updatedAt = now
      nextAttempt.settledAt = now
      nextAttempt.reconciliation = clone(normalizedResult)
      if (normalizedResult.disposition === "completed") {
        next.state = "completed"
        next.terminalDisposition = null
        nextAttempt.state = "completed"
        nextAttempt.terminalDisposition = null
        nextAttempt.result = { version: 1, status: "completed", resultRef: normalizedResult.resultRef }
      } else {
        const terminalEvidence = evidence(normalizedResult.evidence)
        const terminalResult: HabitExecutionResultV1 = normalizedResult.disposition === "safe_retry"
          ? {
              version: 1,
              status: "failed_retryable",
              error: normalizedResult.error,
              safeRetryEvidence: normalizedResult.evidence,
              notBefore: normalizedResult.notBefore,
            }
          : { version: 1, status: "failed_terminal", error: normalizedResult.error }
        const disposition: HabitTerminalDispositionV1 = normalizedResult.disposition === "safe_retry"
          ? {
              kind: "retry_exhausted",
              maxAttempts: prior.maxAttempts,
              sourceResultSha256: sha256(terminalResult),
              exhaustedAt: now,
            }
          : { kind: "reconciliation_terminal", evidence: terminalEvidence, evidenceSha256: sha256(terminalEvidence) }
        next.state = "failed_terminal"
        next.terminalDisposition = disposition
        nextAttempt.state = "failed_terminal"
        nextAttempt.terminalDisposition = disposition
        nextAttempt.result = terminalResult
      }
      return { kind: "settled", occurrence: this.persistOccurrenceMutation(prior, next, lock) }
    })
  }

  readOccurrence(occurrenceId: string): HabitOccurrenceV1 {
    try {
      return readProtectedJson(this.occurrencePath(occurrenceId), parseOccurrence)
    } catch (error) {
      if (error instanceof HabitOccurrenceCorruptError) throw error
      throw new HabitOccurrenceCorruptError((error as Error).message)
    }
  }

  readFence(habitId: string): HabitUnknownSlotFenceV1 {
    try {
      return readProtectedJson(this.fencePath(habitId), parseFence)
    } catch (error) {
      if (error instanceof HabitOccurrenceCorruptError) throw error
      throw new HabitOccurrenceCorruptError((error as Error).message)
    }
  }

  recoverPreparedTransactions(): void {
    this.withLock((lock) => this.recoverPreparedTransactionsUnderLock(lock))
  }

  private withLock<T>(operation: (lock: ProtectedLock) => T): T {
    const { uid, pid, startIdentity, bootId } = this.options.owner
    const lock = acquireProtectedLock(
      this.lockTarget,
      { uid, pid, startIdentity, bootId },
      this.options.proveOwnerState,
    )
    try {
      return operation(lock)
    } finally {
      lock.release()
    }
  }

  private now(): string {
    return timestamp(this.options.now(), "store time")
  }

  private safeName(value: string, label: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new HabitOccurrenceCorruptError(`${label} is not path-safe`)
    return value
  }

  private occurrencePath(occurrenceId: string): string {
    return path.join(this.occurrenceDir, `${this.safeName(occurrenceId, "occurrence ID")}.json`)
  }

  private fencePath(habitId: string): string {
    return path.join(this.fenceDir, `${this.safeName(habitId, "habit ID")}.json`)
  }

  private readOccurrenceOptional(occurrenceId: string): HabitOccurrenceV1 | null {
    return readProtectedJsonOptional(this.occurrencePath(occurrenceId), parseOccurrence)
  }

  private readFenceOptional(habitId: string): HabitUnknownSlotFenceV1 | null {
    const fence = readProtectedJsonOptional(this.fencePath(habitId), parseFence)
    if (fence && (fence.agent !== this.options.agent || fence.habitId !== habitId)) {
      throw new HabitOccurrenceCorruptError("habit fence belongs to another agent or habit")
    }
    return fence
  }

  private listHabitOccurrences(habitId: string): HabitOccurrenceV1[] {
    return fs.readdirSync(this.occurrenceDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readOccurrence(name.slice(0, -5)))
      .filter((occurrence) => occurrence.agent === this.options.agent && occurrence.habitId === habitId)
  }

  private validateScheduledClaimInput(input: HabitOccurrenceClaimInput): void {
    this.safeName(input.habitId, "habit ID")
    const scheduleRevision = hashToken(input.slot.scheduleRevision, "schedule revision")
    const scheduledAtUtc = timestamp(input.slot.scheduledAtUtc, "scheduled time")
    const identity = occurrenceIdentityForScheduledSlot(this.options.agent, input.habitId, {
      scheduleRevision,
      scheduledAtUtc,
    })
    if (input.slot.kind !== "scheduled" || input.slot.slotKey !== identity.slotKey) {
      throw new HabitOccurrenceCorruptError("scheduled claim identity is invalid")
    }
    this.validateTrigger(input.trigger)
    timestamp(input.deadlineAt, "attempt deadline")
    if (input.scheduleProvenanceSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.scheduleProvenanceSha256)) {
      throw new HabitOccurrenceCorruptError("schedule provenance SHA-256 is invalid")
    }
  }

  private validateManualClaimInput(input: HabitManualClaimInput): void {
    this.safeName(input.habitId, "habit ID")
    nonEmptyString(input.requestId, "manual request ID")
    this.validateTrigger(input.trigger)
    timestamp(input.deadlineAt, "attempt deadline")
  }

  private validateTrigger(trigger: HabitOccurrenceClaimInput["trigger"]): void {
    nonEmptyString(trigger.kind, "trigger kind")
    timestamp(trigger.observedAt, "trigger observedAt")
    if (trigger.scheduleProofRef !== null) nonEmptyString(trigger.scheduleProofRef, "schedule proof ref")
  }

  private recoverAbandonedAttemptsUnderLock(habitId: string, lock: ProtectedLock): void {
    for (const prior of this.listHabitOccurrences(habitId)) {
      if (prior.state !== "running") continue
      const attempt = prior.attempts.at(-1)!
      let reason: HabitUnknownReason | null = null
      if (Date.parse(attempt.deadlineAt) <= Date.parse(this.now())) {
        reason = "execution_timeout"
      } else {
        let ownerState: ExactProcessState
        try {
          ownerState = this.options.proveOwnerState(attempt.owner)
        } catch {
          continue
        }
        if (ownerState.state === "dead") reason = "owner_died"
      }
      if (reason === null) continue
      const next = clone(prior)
      const nextAttempt = next.attempts.at(-1)!
      const settledAt = this.now()
      next.recordVersion += 1
      next.state = "outcome_unknown"
      next.terminalDisposition = null
      next.activeAttemptId = null
      next.updatedAt = settledAt
      nextAttempt.state = "outcome_unknown"
      nextAttempt.terminalDisposition = null
      nextAttempt.settledAt = settledAt
      nextAttempt.result = null
      nextAttempt.unknownReason = reason
      nextAttempt.unknownEvidence = []
      nextAttempt.reconciliation = null
      this.persistOccurrenceMutation(prior, next, lock)
    }
  }

  private createOccurrence(
    input: HabitOccurrenceClaimInput | (HabitManualClaimInput & { slot: HabitOccurrenceV1["slot"] }),
    occurrenceId: string,
    lock: ProtectedLock,
  ): HabitOccurrenceClaimResult {
    const claimedAt = this.now()
    timestamp(input.deadlineAt, "attempt deadline")
    const attempt = this.newAttempt(occurrenceId, 1, input.trigger, input.deadlineAt, claimedAt)
    const occurrence: HabitOccurrenceV1 = {
      schemaVersion: 1,
      recordVersion: 1,
      occurrenceId,
      agent: this.options.agent,
      habitId: input.habitId,
      slot: clone(input.slot),
      execution: clone(input.execution),
      maxAttempts: input.execution.policy.maxOccurrenceAttempts,
      state: "running",
      terminalDisposition: null,
      activeAttemptId: attempt.attemptId,
      latestAttemptId: attempt.attemptId,
      attempts: [attempt],
      createdAt: claimedAt,
      updatedAt: claimedAt,
    }
    const persisted = writeProtectedJsonUnderLock(this.occurrencePath(occurrenceId), occurrence, parseOccurrence, lock)
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_occurrence_claimed",
      message: "claimed durable habit occurrence before dispatch",
      meta: { agent: persisted.agent, habitId: persisted.habitId, occurrenceId, attemptId: attempt.attemptId },
    })
    return { kind: "claimed", occurrence: persisted, attempt: persisted.attempts[0]! }
  }

  private appendRetry(
    prior: HabitOccurrenceV1,
    trigger: HabitOccurrenceClaimInput["trigger"],
    deadlineAt: string,
    fence: HabitUnknownSlotFenceV1 | null,
    lock: ProtectedLock,
  ): HabitOccurrenceClaimResult {
    const next = clone(prior)
    const claimedAt = this.now()
    const attempt = this.newAttempt(prior.occurrenceId, prior.attempts.length + 1, trigger, deadlineAt, claimedAt)
    next.recordVersion += 1
    next.state = "running"
    next.terminalDisposition = null
    next.activeAttemptId = attempt.attemptId
    next.latestAttemptId = attempt.attemptId
    next.attempts.push(attempt)
    next.updatedAt = claimedAt
    let persisted: HabitOccurrenceV1
    if (fence?.state === "blocked") {
      const nextFence = this.blockedFenceSuccessor(fence, next)
      persisted = this.writeOccurrenceFencePair(prior, next, fence, nextFence, lock)
    } else {
      persisted = writeProtectedJsonUnderLock(this.occurrencePath(next.occurrenceId), next, parseOccurrence, lock)
    }
    return { kind: "claimed", occurrence: persisted, attempt: persisted.attempts.at(-1)! }
  }

  private newAttempt(
    occurrenceId: string,
    ordinal: number,
    trigger: HabitOccurrenceClaimInput["trigger"],
    deadlineAt: string,
    claimedAt: string,
  ): HabitAttemptV1 {
    return {
      attemptId: `hat_${base64UrlSha256({ schemaVersion: 1, occurrenceId, ordinal })}`,
      ordinal,
      state: "running",
      terminalDisposition: null,
      trigger: { ...trigger, observedAt: timestamp(trigger.observedAt, "trigger observedAt") },
      owner: clone(this.options.owner),
      claimedAt,
      deadlineAt: timestamp(deadlineAt, "attempt deadlineAt"),
      settledAt: null,
      result: null,
      unknownReason: null,
      unknownEvidence: [],
      reconciliation: null,
    }
  }

  private requireCurrentRunningAttempt(occurrence: HabitOccurrenceV1, attemptId: string): HabitAttemptV1 {
    const attempt = occurrence.attempts.at(-1)!
    if (occurrence.state !== "running" || occurrence.activeAttemptId !== attemptId || attempt.attemptId !== attemptId) {
      throw new HabitOccurrenceCorruptError("result does not own the active attempt")
    }
    return attempt
  }

  private scheduledAt(occurrence: HabitOccurrenceV1): string {
    return occurrence.slot.kind === "scheduled" ? occurrence.slot.scheduledAtUtc : occurrence.createdAt
  }

  private supersedeOldRetries(
    occurrences: HabitOccurrenceV1[],
    input: HabitOccurrenceClaimInput,
    fence: HabitUnknownSlotFenceV1 | null,
    lock: ProtectedLock,
  ): void {
    for (const prior of occurrences) {
      if (prior.slot.kind !== "scheduled" || prior.state !== "failed_retryable") continue
      if (prior.slot.scheduleRevision === input.slot.scheduleRevision || fence?.blockingOccurrenceId === prior.occurrenceId) continue
      const next = clone(prior)
      const now = this.now()
      const disposition: HabitTerminalDispositionV1 = {
        kind: "schedule_superseded",
        priorScheduleRevision: prior.slot.scheduleRevision,
        activeScheduleRevision: input.slot.scheduleRevision,
        scheduleProvenanceSha256: input.scheduleProvenanceSha256 ?? sha256({ scheduleRevision: input.slot.scheduleRevision }),
        supersededAt: now,
      }
      next.recordVersion += 1
      next.state = "failed_terminal"
      next.terminalDisposition = disposition
      next.activeAttemptId = null
      next.updatedAt = now
      const attempt = next.attempts.at(-1)!
      attempt.state = "failed_terminal"
      attempt.terminalDisposition = disposition
      writeProtectedJsonUnderLock(this.occurrencePath(next.occurrenceId), next, parseOccurrence, lock)
    }
  }

  private ensureOpenFence(habitId: string, lock: ProtectedLock): HabitUnknownSlotFenceV1 {
    const existing = this.readFenceOptional(habitId)
    if (existing) return existing
    const initial: HabitUnknownSlotFenceV1 = {
      schemaVersion: 1,
      agent: this.options.agent,
      habitId,
      revision: 0,
      priorFenceSha256: null,
      mode: "habit",
      state: "open",
      blockingOccurrenceId: null,
      blockingOccurrenceRef: null,
      blockingOccurrenceSha256: null,
      blockingAttemptId: null,
      updatedAt: this.now(),
    }
    return writeProtectedJsonUnderLock(this.fencePath(habitId), initial, parseFence, lock)
  }

  private requireBlockingOccurrence(fence: HabitUnknownSlotFenceV1): HabitOccurrenceV1 {
    const occurrence = this.readOccurrence(fence.blockingOccurrenceId!)
    const expectedRef = path.relative(this.options.bundleRoot, this.occurrencePath(occurrence.occurrenceId))
    if (
      fence.blockingOccurrenceRef !== expectedRef ||
      sha256(occurrence) !== fence.blockingOccurrenceSha256 ||
      occurrence.latestAttemptId !== fence.blockingAttemptId
    ) {
      throw new HabitOccurrenceCorruptError("blocked fence does not match its occurrence authority")
    }
    return occurrence
  }

  private persistOccurrenceMutation(
    prior: HabitOccurrenceV1,
    next: HabitOccurrenceV1,
    lock: ProtectedLock,
  ): HabitOccurrenceV1 {
    const fence = this.readFenceOptional(prior.habitId)
    if (next.state === "outcome_unknown" && next.execution.policy.unknownSlotFence === "habit") {
      const priorFence = fence ?? this.ensureOpenFence(prior.habitId, lock)
      return this.writeOccurrenceFencePair(prior, next, priorFence, this.blockedFenceSuccessor(priorFence, next), lock)
    }
    if (fence?.state === "blocked" && fence.blockingOccurrenceId === prior.occurrenceId) {
      const nextFence = next.state === "completed" || next.state === "failed_terminal"
        ? this.openFenceSuccessor(fence)
        : this.blockedFenceSuccessor(fence, next)
      return this.writeOccurrenceFencePair(prior, next, fence, nextFence, lock)
    }
    return writeProtectedJsonUnderLock(this.occurrencePath(next.occurrenceId), next, parseOccurrence, lock)
  }

  private blockedFenceSuccessor(prior: HabitUnknownSlotFenceV1, occurrence: HabitOccurrenceV1): HabitUnknownSlotFenceV1 {
    return {
      schemaVersion: 1,
      agent: this.options.agent,
      habitId: occurrence.habitId,
      revision: prior.revision + 1,
      priorFenceSha256: sha256(prior),
      mode: "habit",
      state: "blocked",
      blockingOccurrenceId: occurrence.occurrenceId,
      blockingOccurrenceRef: path.relative(this.options.bundleRoot, this.occurrencePath(occurrence.occurrenceId)),
      blockingOccurrenceSha256: sha256(occurrence),
      blockingAttemptId: occurrence.latestAttemptId,
      updatedAt: this.now(),
    }
  }

  private openFenceSuccessor(prior: HabitUnknownSlotFenceV1): HabitUnknownSlotFenceV1 {
    return {
      schemaVersion: 1,
      agent: this.options.agent,
      habitId: prior.habitId,
      revision: prior.revision + 1,
      priorFenceSha256: sha256(prior),
      mode: "habit",
      state: "open",
      blockingOccurrenceId: null,
      blockingOccurrenceRef: null,
      blockingOccurrenceSha256: null,
      blockingAttemptId: null,
      updatedAt: this.now(),
    }
  }

  private retryAfterReconciliation(
    prior: HabitOccurrenceV1,
    result: Extract<HabitReconciliationResultV1, { disposition: "safe_retry" }>,
    now: string,
  ): HabitOccurrenceV1 {
    const next = clone(prior)
    const priorAttempt = next.attempts.at(-1)!
    priorAttempt.reconciliation = clone(result)
    const deadlineAt = new Date(Date.parse(now) + 300_000).toISOString()
    const retry = this.newAttempt(
      prior.occurrenceId,
      prior.attempts.length + 1,
      { kind: "reconciliation-retry", observedAt: now, scheduleProofRef: priorAttempt.trigger.scheduleProofRef },
      deadlineAt,
      now,
    )
    next.recordVersion += 1
    next.state = "running"
    next.terminalDisposition = null
    next.activeAttemptId = retry.attemptId
    next.latestAttemptId = retry.attemptId
    next.attempts.push(retry)
    next.updatedAt = now
    return next
  }

  private writeOccurrenceFencePair(
    priorOccurrence: HabitOccurrenceV1,
    nextOccurrence: HabitOccurrenceV1,
    priorFence: HabitUnknownSlotFenceV1,
    nextFence: HabitUnknownSlotFenceV1,
    lock: ProtectedLock,
  ): HabitOccurrenceV1 {
    const transactionId = `huft_${base64UrlSha256({
      occurrenceId: priorOccurrence.occurrenceId,
      priorRecordVersion: priorOccurrence.recordVersion,
      nextRecordVersion: nextOccurrence.recordVersion,
      priorFenceRevision: priorFence.revision,
      nextFenceRevision: nextFence.revision,
    })}`
    const nextOccurrencePayload = path.join(this.transactionDir, `${transactionId}.occurrence.json`)
    const nextFencePayload = path.join(this.transactionDir, `${transactionId}.fence.json`)
    writeProtectedJsonUnderLock(nextOccurrencePayload, nextOccurrence, parseOccurrence, lock)
    writeProtectedJsonUnderLock(nextFencePayload, nextFence, parseFence, lock)
    const prepared: HabitUnknownFenceTxnV1 = {
      schemaVersion: 1,
      transactionId,
      revision: 0,
      priorTxnSha256: null,
      agent: this.options.agent,
      habitId: priorOccurrence.habitId,
      state: "prepared",
      priorOccurrenceRef: path.relative(this.options.bundleRoot, this.occurrencePath(priorOccurrence.occurrenceId)),
      priorOccurrenceSha256: sha256(priorOccurrence),
      nextOccurrenceRef: path.relative(this.options.bundleRoot, nextOccurrencePayload),
      nextOccurrenceSha256: sha256(nextOccurrence),
      priorFenceRef: path.relative(this.options.bundleRoot, this.fencePath(priorFence.habitId)),
      priorFenceSha256: sha256(priorFence),
      nextFenceRef: path.relative(this.options.bundleRoot, nextFencePayload),
      nextFenceSha256: sha256(nextFence),
      occurrenceHeadApplied: false,
      fenceHeadApplied: false,
      preparedAt: this.now(),
      committedAt: null,
    }
    this.writeTransactionRevision(prepared, lock)
    this.options.fault?.("after_txn_prepared")
    writeProtectedJsonUnderLock(this.occurrencePath(nextOccurrence.occurrenceId), nextOccurrence, parseOccurrence, lock)
    const occurrenceApplied = this.nextTransactionRevision(prepared, { occurrenceHeadApplied: true })
    this.writeTransactionRevision(occurrenceApplied, lock)
    this.options.fault?.("after_occurrence_head")
    writeProtectedJsonUnderLock(this.fencePath(nextFence.habitId), nextFence, parseFence, lock)
    const fenceApplied = this.nextTransactionRevision(occurrenceApplied, { fenceHeadApplied: true })
    this.writeTransactionRevision(fenceApplied, lock)
    this.options.fault?.("after_fence_head")
    const committed = this.nextTransactionRevision(fenceApplied, { state: "committed", committedAt: this.now() })
    this.writeTransactionRevision(committed, lock)
    return nextOccurrence
  }

  private nextTransactionRevision(
    prior: HabitUnknownFenceTxnV1,
    patch: Partial<HabitUnknownFenceTxnV1>,
  ): HabitUnknownFenceTxnV1 {
    return { ...prior, ...patch, revision: prior.revision + 1, priorTxnSha256: sha256(prior) }
  }

  private transactionPath(transactionId: string, revision: number): string {
    return path.join(this.transactionDir, `${transactionId}.txn-r${revision}.json`)
  }

  private writeTransactionRevision(transaction: HabitUnknownFenceTxnV1, lock: ProtectedLock): void {
    writeProtectedJsonUnderLock(this.transactionPath(transaction.transactionId, transaction.revision), transaction, parseTransaction, lock)
  }

  private recoverPreparedTransactionsUnderLock(lock: ProtectedLock): void {
    const revisions = new Map<string, HabitUnknownFenceTxnV1[]>()
    for (const name of fs.readdirSync(this.transactionDir)) {
      const match = /^(huft_[A-Za-z0-9_-]+)\.txn-r([0-9]+)\.json$/.exec(name)
      if (!match) continue
      const transaction = readProtectedJson(path.join(this.transactionDir, name), parseTransaction)
      if (transaction.transactionId !== match[1] || transaction.revision !== Number(match[2])) {
        throw new HabitOccurrenceCorruptError("habit unknown-fence transaction filename disagrees with its record")
      }
      const records = revisions.get(transaction.transactionId) ?? []
      records.push(transaction)
      revisions.set(transaction.transactionId, records)
    }
    for (const records of revisions.values()) {
      records.sort((left, right) => left.revision - right.revision)
      for (let index = 0; index < records.length; index += 1) {
        const current = records[index]!
        if (current.revision !== index) throw new HabitOccurrenceCorruptError("habit unknown-fence transaction revision chain has a gap")
        if (index > 0) {
          const prior = records[index - 1]!
          if (
            current.priorTxnSha256 !== sha256(prior) ||
            current.transactionId !== prior.transactionId ||
            current.agent !== prior.agent ||
            current.habitId !== prior.habitId ||
            current.priorOccurrenceRef !== prior.priorOccurrenceRef ||
            current.priorOccurrenceSha256 !== prior.priorOccurrenceSha256 ||
            current.nextOccurrenceRef !== prior.nextOccurrenceRef ||
            current.nextOccurrenceSha256 !== prior.nextOccurrenceSha256 ||
            current.priorFenceRef !== prior.priorFenceRef ||
            current.priorFenceSha256 !== prior.priorFenceSha256 ||
            current.nextFenceRef !== prior.nextFenceRef ||
            current.nextFenceSha256 !== prior.nextFenceSha256 ||
            current.preparedAt !== prior.preparedAt
          ) {
            throw new HabitOccurrenceCorruptError("habit unknown-fence transaction revision chain is inconsistent")
          }
        }
      }
      const transaction = records.at(-1)!
      if (transaction.state === "committed") continue
      if (transaction.agent !== this.options.agent) throw new HabitOccurrenceCorruptError("habit unknown-fence transaction belongs to another agent")
      const nextOccurrence = readProtectedJson(this.resolveBundleRef(transaction.nextOccurrenceRef), parseOccurrence)
      const nextFence = readProtectedJson(this.resolveBundleRef(transaction.nextFenceRef), parseFence)
      if (sha256(nextOccurrence) !== transaction.nextOccurrenceSha256 || sha256(nextFence) !== transaction.nextFenceSha256) {
        throw new HabitOccurrenceCorruptError("habit unknown-fence transaction payload hash is invalid")
      }
      let current = transaction
      const occurrence = this.readOccurrence(nextOccurrence.occurrenceId)
      const occurrenceSha = sha256(occurrence)
      if (!current.occurrenceHeadApplied) {
        if (occurrenceSha !== current.priorOccurrenceSha256 && occurrenceSha !== current.nextOccurrenceSha256) {
          throw new HabitOccurrenceCorruptError("prepared transaction occurrence head has a third value")
        }
        if (occurrenceSha !== current.nextOccurrenceSha256) {
          writeProtectedJsonUnderLock(this.occurrencePath(nextOccurrence.occurrenceId), nextOccurrence, parseOccurrence, lock)
        }
        current = this.nextTransactionRevision(current, { occurrenceHeadApplied: true })
        this.writeTransactionRevision(current, lock)
      } else if (occurrenceSha !== current.nextOccurrenceSha256) {
        throw new HabitOccurrenceCorruptError("prepared transaction occurrence head regressed")
      }
      const fence = this.readFence(nextFence.habitId)
      const fenceSha = sha256(fence)
      if (!current.fenceHeadApplied) {
        if (fenceSha !== current.priorFenceSha256 && fenceSha !== current.nextFenceSha256) {
          throw new HabitOccurrenceCorruptError("prepared transaction fence head has a third value")
        }
        if (fenceSha !== current.nextFenceSha256) {
          writeProtectedJsonUnderLock(this.fencePath(nextFence.habitId), nextFence, parseFence, lock)
        }
        current = this.nextTransactionRevision(current, { fenceHeadApplied: true })
        this.writeTransactionRevision(current, lock)
      } else if (fenceSha !== current.nextFenceSha256) {
        throw new HabitOccurrenceCorruptError("prepared transaction fence head regressed")
      }
      this.writeTransactionRevision(this.nextTransactionRevision(current, { state: "committed", committedAt: this.now() }), lock)
    }
  }

  private resolveBundleRef(reference: string): string {
    if (path.isAbsolute(reference)) throw new HabitOccurrenceCorruptError("habit authority ref must be bundle-relative")
    const bundleRoot = path.resolve(this.options.bundleRoot)
    const resolved = path.resolve(bundleRoot, reference)
    if (resolved === bundleRoot || !resolved.startsWith(`${bundleRoot}${path.sep}`)) {
      throw new HabitOccurrenceCorruptError("habit authority ref escapes its bundle")
    }
    return resolved
  }
}
