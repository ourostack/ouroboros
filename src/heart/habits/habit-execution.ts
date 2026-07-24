import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
  type Pair,
} from "yaml"

import { emitNervesEvent } from "../../nerves/runtime"
import type { ProcessIdentity } from "../runtime/process-identity"

export interface HabitExecutionEnvelopeV1 {
  version: 1
  adapter: string
  config: Record<string, unknown>
  policy: {
    maxOccurrenceAttempts: number
    unknownSlotFence: "none" | "habit"
  }
}

export interface HabitExecutionErrorV1 {
  code: string
  message: string
  retryable: boolean
}

export interface HabitEvidenceV1 {
  kind: "adapter-owned"
  ref: string
  sha256: string
  observedAt: string
}

export type HabitExecutionResultV1 =
  | { version: 1; status: "completed"; resultRef: string }
  | { version: 1; status: "failed_terminal"; error: HabitExecutionErrorV1 }
  | {
      version: 1
      status: "failed_retryable"
      error: HabitExecutionErrorV1
      safeRetryEvidence: HabitEvidenceV1
      notBefore: string
    }

export type HabitInvocationOutcomeV1 =
  | { version: 1; disposition: "settled"; result: HabitExecutionResultV1 }
  | {
      version: 1
      disposition: "outcome_unknown"
      reason: "adapter_reported_unknown"
      evidence: HabitEvidenceV1
    }

export type HabitReconciliationResultV1 =
  | { version: 1; disposition: "completed"; resultRef: string; evidence: HabitEvidenceV1 }
  | {
      version: 1
      disposition: "safe_retry"
      error: HabitExecutionErrorV1
      notBefore: string
      evidence: HabitEvidenceV1
    }
  | {
      version: 1
      disposition: "failed_terminal"
      error: HabitExecutionErrorV1
      evidence: HabitEvidenceV1
    }
  | { version: 1; disposition: "unresolved" }

export interface HabitInvocationV1<C> {
  schemaVersion: 1
  agent: string
  bundleRoot: string
  habit: {
    id: string
    title: string
    body: string
    tools: string[]
    continuity: { mode: "fresh" | "stateful" }
  }
  config: C
  occurrenceId: string
  attemptId: string
  trigger: { kind: string; observedAt: string; scheduleProofRef: string | null }
  owner: ProcessIdentity & { daemonInstanceId: string }
  deadlineAt: string
  signal: AbortSignal
}

export type HabitUnknownReason =
  | "adapter_exception"
  | "execution_timeout"
  | "owner_died"
  | "aborted_after_invoke"
  | "invalid_result"
  | "result_absent"
  | "adapter_transport_unknown"
  | "adapter_reported_unknown"

export interface HabitReconciliationInputV1<C> {
  schemaVersion: 1
  agent: string
  bundleRoot: string
  habitId: string
  config: C
  occurrenceId: string
  attemptId: string
  unknownReason: HabitUnknownReason
  priorEvidence: HabitEvidenceV1[]
}

export interface HabitExecutionAdapter<C> {
  readonly id: string
  readonly version: 1
  validateConfig(raw: Record<string, unknown>): C
  invoke(input: HabitInvocationV1<C>): Promise<HabitInvocationOutcomeV1>
  reconcile?(input: HabitReconciliationInputV1<C>): Promise<HabitReconciliationResultV1>
}

const DEFAULT_POLICY = Object.freeze({
  maxOccurrenceAttempts: 3,
  unknownSlotFence: "none" as const,
})

export const DEFAULT_HABIT_EXECUTION: HabitExecutionEnvelopeV1 = Object.freeze({
  version: 1 as const,
  adapter: "agent-turn",
  config: Object.freeze({}),
  policy: DEFAULT_POLICY,
})

function fail(message: string): never {
  throw new Error(`Habit execution: ${message}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) fail(`${label} has unknown field ${unknown.sort()[0]}`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function canonicalTimestamp(value: unknown, label: string): string {
  const text = nonEmptyString(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail(`${label} must be canonical UTC time`)
  }
  return text
}

function parseEvidence(value: unknown): HabitEvidenceV1 {
  const raw = record(value, "evidence")
  exactKeys(raw, ["kind", "ref", "sha256", "observedAt"], "evidence")
  if (raw.kind !== "adapter-owned" || typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    fail("evidence must be adapter-owned with a lowercase SHA-256")
  }
  return {
    kind: "adapter-owned",
    ref: nonEmptyString(raw.ref, "evidence ref"),
    sha256: raw.sha256,
    observedAt: canonicalTimestamp(raw.observedAt, "evidence observedAt"),
  }
}

function parseExecutionError(value: unknown): HabitExecutionErrorV1 {
  const raw = record(value, "execution error")
  exactKeys(raw, ["code", "message", "retryable"], "execution error")
  if (typeof raw.retryable !== "boolean") fail("execution error retryable must be boolean")
  return {
    code: nonEmptyString(raw.code, "execution error code"),
    message: nonEmptyString(raw.message, "execution error message"),
    retryable: raw.retryable,
  }
}

export function parseHabitExecutionResultV1(value: unknown): HabitExecutionResultV1 {
  const raw = record(value, "execution result")
  if (raw.version !== 1) fail("execution result version must be 1")
  if (raw.status === "completed") {
    exactKeys(raw, ["version", "status", "resultRef"], "completed execution result")
    return { version: 1, status: "completed", resultRef: nonEmptyString(raw.resultRef, "result ref") }
  }
  if (raw.status === "failed_terminal") {
    exactKeys(raw, ["version", "status", "error"], "terminal execution result")
    const error = parseExecutionError(raw.error)
    if (error.retryable) fail("terminal execution error cannot be retryable")
    return { version: 1, status: "failed_terminal", error }
  }
  if (raw.status === "failed_retryable") {
    exactKeys(raw, ["version", "status", "error", "safeRetryEvidence", "notBefore"], "retryable execution result")
    const error = parseExecutionError(raw.error)
    if (!error.retryable) fail("retryable execution error must be retryable")
    return {
      version: 1,
      status: "failed_retryable",
      error,
      safeRetryEvidence: parseEvidence(raw.safeRetryEvidence),
      notBefore: canonicalTimestamp(raw.notBefore, "retry notBefore"),
    }
  }
  fail("execution result status is invalid")
}

export function parseHabitInvocationOutcomeV1(value: unknown): HabitInvocationOutcomeV1 {
  const raw = record(value, "invocation outcome")
  if (raw.version !== 1) fail("invocation outcome version must be 1")
  if (raw.disposition === "settled") {
    exactKeys(raw, ["version", "disposition", "result"], "settled invocation outcome")
    return { version: 1, disposition: "settled", result: parseHabitExecutionResultV1(raw.result) }
  }
  if (raw.disposition === "outcome_unknown") {
    exactKeys(raw, ["version", "disposition", "reason", "evidence"], "unknown invocation outcome")
    if (raw.reason !== "adapter_reported_unknown") fail("unknown invocation reason is invalid")
    return {
      version: 1,
      disposition: "outcome_unknown",
      reason: "adapter_reported_unknown",
      evidence: parseEvidence(raw.evidence),
    }
  }
  fail("invocation outcome disposition is invalid")
}

export function parseHabitReconciliationResultV1(value: unknown): HabitReconciliationResultV1 {
  const raw = record(value, "reconciliation result")
  if (raw.version !== 1) fail("reconciliation result version must be 1")
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
      evidence: parseEvidence(raw.evidence),
    }
  }
  if (raw.disposition === "safe_retry") {
    exactKeys(raw, ["version", "disposition", "error", "notBefore", "evidence"], "safe-retry reconciliation result")
    const error = parseExecutionError(raw.error)
    if (!error.retryable) fail("safe-retry reconciliation error must be retryable")
    return {
      version: 1,
      disposition: "safe_retry",
      error,
      notBefore: canonicalTimestamp(raw.notBefore, "reconciliation notBefore"),
      evidence: parseEvidence(raw.evidence),
    }
  }
  if (raw.disposition === "failed_terminal") {
    exactKeys(raw, ["version", "disposition", "error", "evidence"], "terminal reconciliation result")
    const error = parseExecutionError(raw.error)
    if (error.retryable) fail("terminal reconciliation error cannot be retryable")
    return {
      version: 1,
      disposition: "failed_terminal",
      error,
      evidence: parseEvidence(raw.evidence),
    }
  }
  fail("reconciliation result disposition is invalid")
}

function validateYamlNode(node: Node): void {
  if (isAlias(node)) fail("YAML aliases are forbidden")
  if ("tag" in node && typeof node.tag === "string") fail("explicit YAML tags are forbidden")
  if (isMap(node)) {
    for (const pair of node.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") fail("YAML map contains a non-string key")
      if (pair.key.value === "<<") fail("YAML merge keys are forbidden")
      validateYamlNode(pair.key)
      validateYamlNode(pair.value as Node)
    }
  } else if (isSeq(node)) {
    for (const item of node.items) validateYamlNode(item as Node)
  }
}

export function parseHabitFrontmatterYaml(raw: string): Record<string, unknown> {
  const documents = parseAllDocuments(raw, { merge: false, uniqueKeys: true })
  if (documents.length === 0) return {}
  if (documents.length !== 1) fail("multiple YAML documents are forbidden")
  const document = documents[0]
  if (document.errors.length > 0) fail(`duplicate key or invalid YAML: ${document.errors[0].message}`)
  validateYamlNode(document.contents as Node)
  if (!isMap(document.contents)) fail("frontmatter document must be a map")
  const value = document.toJS({ maxAliasCount: 0 }) as unknown
  emitNervesEvent({
    component: "heart",
    event: "heart.habit_frontmatter_parsed",
    message: "parsed strict generic habit frontmatter",
    meta: { fields: Object.keys(record(value, "frontmatter")).length },
  })
  return record(value, "frontmatter")
}

export function parseHabitExecutionEnvelope(raw: unknown): HabitExecutionEnvelopeV1 {
  const envelope = record(raw, "envelope")
  exactKeys(envelope, ["version", "adapter", "config", "policy"], "envelope")
  if (envelope.version !== 1) fail("version must be 1")
  if (typeof envelope.adapter !== "string" || !/^[a-z][a-z0-9-]*$/.test(envelope.adapter)) {
    fail("adapter must match ^[a-z][a-z0-9-]*$")
  }
  const config = record(envelope.config, "config")
  const rawPolicy = envelope.policy === undefined ? {} : record(envelope.policy, "policy")
  exactKeys(rawPolicy, ["maxOccurrenceAttempts", "unknownSlotFence"], "policy")
  const maxOccurrenceAttempts = rawPolicy.maxOccurrenceAttempts ?? DEFAULT_POLICY.maxOccurrenceAttempts
  if (!Number.isInteger(maxOccurrenceAttempts) || (maxOccurrenceAttempts as number) < 1 || (maxOccurrenceAttempts as number) > 10) {
    fail("maxOccurrenceAttempts must be an integer from 1 through 10")
  }
  const unknownSlotFence = rawPolicy.unknownSlotFence ?? DEFAULT_POLICY.unknownSlotFence
  if (unknownSlotFence !== "none" && unknownSlotFence !== "habit") {
    fail("unknownSlotFence must be none or habit")
  }
  return {
    version: 1,
    adapter: envelope.adapter,
    config,
    policy: { maxOccurrenceAttempts: maxOccurrenceAttempts as number, unknownSlotFence },
  }
}
