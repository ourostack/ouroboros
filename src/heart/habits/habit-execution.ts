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

function validateYamlNode(node: Node | null): void {
  if (node === null) return
  if (isAlias(node)) fail("YAML aliases are forbidden")
  if ("tag" in node && typeof node.tag === "string") fail("explicit YAML tags are forbidden")
  if (isMap(node)) {
    for (const pair of node.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") fail("YAML map contains a non-string key")
      if (pair.key.value === "<<") fail("YAML merge keys are forbidden")
      validateYamlNode(pair.key)
      validateYamlNode(pair.value as Node | null)
    }
  } else if (isSeq(node)) {
    for (const item of node.items) validateYamlNode(item as Node | null)
  }
}

export function parseHabitFrontmatterYaml(raw: string): Record<string, unknown> {
  const documents = parseAllDocuments(raw, { merge: false, uniqueKeys: true })
  if (documents.length !== 1) fail("multiple YAML documents are forbidden")
  const document = documents[0]
  if (document.errors.length > 0) fail(`duplicate key or invalid YAML: ${document.errors[0].message}`)
  validateYamlNode(document.contents)
  if (document.contents === null) return {}
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
