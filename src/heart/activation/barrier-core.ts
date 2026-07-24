import { createHash } from "crypto"

import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, sha256CanonicalJson } from "../runtime/canonical-json"
import {
  mutateProtectedJson,
  readProtectedJson,
  type ProtectedStoreIo,
} from "../runtime/protected-json-store"
import type { ExactProcessState, ProcessIdentity } from "../runtime/process-identity"

export interface ResourceKey {
  machineId: string
  ownerUid: number
  serviceId: string
  incarnationId: string
}

export interface ResourceBarrierTarget {
  resourceId: string
  incarnationId: string
}

export interface ScheduledBarrierTarget {
  agent: string
  habitId: string
}

export type BarrierTarget = ResourceBarrierTarget | ScheduledBarrierTarget
export type BarrierScope = "resource-repair" | "scheduled-dispatch"

export type BarrierReleasePolicy =
  | { kind: "continuous" }
  | { kind: "one-shot-current"; terminalTimeoutMs: 600000 }

export interface BarrierV1 {
  barrierId: string
  scope: BarrierScope
  target: BarrierTarget
  targetKey: string
  holder: string
  tokenHash: string
  releasePolicy: BarrierReleasePolicy
  status: "held" | "released"
  acquiredEpoch: string
  releasedEpoch: string | null
  acquiredAt: string
  releasedAt: string | null
}

export interface RepairDeferredPayload {
  observationId: string
  repairEligibilityId: string
}

export interface ScheduledDeferredPayload {
  scheduleRevision: string
  slotKey: string
  scheduledAtUtc: string
}

export interface DeferredV1 {
  deferredId: string
  kind: BarrierScope
  target: BarrierTarget
  targetKey: string
  dedupeKey: string
  payload: RepairDeferredPayload | ScheduledDeferredPayload
  blockedBy: string[]
  state: "pending" | "ready" | "settled" | "discarded"
  firstDeniedAt: string
  lastDeniedAt: string
  readyAt: string | null
  settledAt: string | null
  deliveryRef: string | null
}

export interface ActionWindowV1 {
  schemaVersion: 1
  actionWindowId: string
  barrierId: string
  resourceId: string
  incarnationId: string
  deferredId: string
  repairEligibilityId: string
  state: "armed" | "consumed" | "succeeded" | "blocked" | "superseded"
  repairGeneration: number | null
  releasedAt: string
  terminalDeadlineAt: string
  consumedAt: string | null
  terminalAt: string | null
  terminalRef: string | null
  terminalSha256: string | null
  supersededBy: string | null
}

export interface BarrierStoreV1 {
  schemaVersion: 1
  revision: number
  lastWriterEpoch: string
  barriers: Record<string, BarrierV1>
  deferredIntents: Record<string, DeferredV1>
  actionWindows: Record<string, ActionWindowV1>
  updatedAt: string
}

export interface RepairGenerationReconciliationV1 {
  schemaVersion: 1
  resourceId: string
  resourceKey: ResourceKey
  repairGeneration: number
  takeoverId: string
  disposition: "committed" | "rolled_back"
  requestRef: string
  requestSha256: string
  ownerAuthorityRef: string
  ownerAuthoritySha256: string
  inspectRef: string
  inspectSha256: string
  observedAt: string
}

interface CommandAuthority {
  writerEpoch: string
  at: string
}

export type BarrierCommandV1 =
  | (CommandAuthority & {
      kind: "barrier.acquire"
      barrierId: string
      scope: "resource-repair"
      target: ResourceBarrierTarget
      holder: string
      tokenHash: string
      releasePolicy: { kind: "one-shot-current"; terminalTimeoutMs: 600000 }
    })
  | (CommandAuthority & {
      kind: "barrier.acquire"
      barrierId: string
      scope: "scheduled-dispatch"
      target: ScheduledBarrierTarget
      holder: string
      tokenHash: string
      releasePolicy: { kind: "continuous" }
    })
  | (CommandAuthority & {
      kind: "admission.scheduled"
      deferredId: string
      target: ScheduledBarrierTarget
      scheduleRevision: string
      slotKey: string
      scheduledAtUtc: string
    })
  | (CommandAuthority & {
      kind: "admission.repair"
      deferredId: string
      target: ResourceBarrierTarget
      observationId: string
      repairEligibilityId: string
      repairGeneration: number
    })
  | (CommandAuthority & {
      kind: "barrier.release"
      barrierId: string
      holder: string
      tokenHash: string
      currentDedupeKey: string
    })
  | (CommandAuthority & {
      kind: "action-window.succeed"
      actionWindowId: string
      repairGeneration: number
      terminalRef: string
      terminalSha256: string
    })
  | (CommandAuthority & {
      kind: "action-window.block"
      actionWindowId: string
      repairGeneration: number
      disposition: "failed_terminal" | "outcome_unknown"
      terminalRef: string
      terminalSha256: string
    })
  | (CommandAuthority & {
      kind: "action-window.expire"
      actionWindowId: string
    })
  | (CommandAuthority & {
      kind: "barrier.rearm"
      barrierId: string
      holder: string
      tokenHash: string
      blockedActionWindowId: string
      currentDedupeKey: string
      reconciliation: RepairGenerationReconciliationV1
      remainingBudget: number
      cooldownUntil: string | null
    })

export type BarrierCommandResultV1 =
  | { kind: "acquired"; barrier: BarrierV1; replayed: boolean }
  | { kind: "deferred"; deferredId: string; deferred: DeferredV1 }
  | { kind: "admitted"; actionWindow: ActionWindowV1 | null }
  | {
      kind: "released"
      barrier: BarrierV1
      readyDeferredIds: string[]
      discardedDeferredIds: string[]
      actionWindow: ActionWindowV1 | null
      replayed: boolean
    }
  | { kind: "succeeded"; actionWindow: ActionWindowV1; replayed: boolean }
  | { kind: "blocked"; actionWindow: ActionWindowV1; replayed: boolean }
  | {
      kind: "rearmed"
      priorActionWindowId: string
      actionWindow: ActionWindowV1
      barrier: BarrierV1
    }

export interface AppliedBarrierCommandV1 {
  store: BarrierStoreV1
  result: BarrierCommandResultV1
}

export class ActivationBarrierError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ActivationBarrierError"
  }
}

function fail(message: string): never {
  throw new ActivationBarrierError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`)
  return value
}

function requireExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly ${wanted.join(", ")}`)
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function requireSafeUnsigned(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`)
  return value as number
}

function requirePositive(value: unknown, label: string): number {
  const parsed = requireSafeUnsigned(value, label)
  if (parsed === 0) fail(`${label} must be positive`)
  return parsed
}

function requireSha256(value: unknown, label: string): string {
  const parsed = requireString(value, label)
  if (!/^[a-f0-9]{64}$/.test(parsed)) fail(`${label} must be a lowercase SHA-256 hex digest`)
  return parsed
}

function requireIso(value: unknown, label: string): string {
  const parsed = requireString(value, label)
  const date = new Date(parsed)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail(`${label} must be a canonical ISO-8601 timestamp`)
  }
  return parsed
}

function requireNullableIso(value: unknown, label: string): string | null {
  return value === null ? null : requireIso(value, label)
}

function requireNullableString(value: unknown, label: string): string | null {
  return value === null ? null : requireString(value, label)
}

function parseResourceTarget(value: unknown, label: string): ResourceBarrierTarget {
  const record = requireRecord(value, label)
  requireExactKeys(record, ["resourceId", "incarnationId"], label)
  return {
    resourceId: requireString(record.resourceId, `${label}.resourceId`),
    incarnationId: requireString(record.incarnationId, `${label}.incarnationId`),
  }
}

function parseScheduledTarget(value: unknown, label: string): ScheduledBarrierTarget {
  const record = requireRecord(value, label)
  requireExactKeys(record, ["agent", "habitId"], label)
  return {
    agent: requireString(record.agent, `${label}.agent`),
    habitId: requireString(record.habitId, `${label}.habitId`),
  }
}

function parseTarget(scope: BarrierScope, value: unknown, label: string): BarrierTarget {
  return scope === "resource-repair"
    ? parseResourceTarget(value, label)
    : parseScheduledTarget(value, label)
}

function parseResourceKey(value: unknown): ResourceKey {
  const record = requireRecord(value, "resource key")
  requireExactKeys(record, ["machineId", "ownerUid", "serviceId", "incarnationId"], "resource key")
  return {
    machineId: requireString(record.machineId, "resource key machineId"),
    ownerUid: requireSafeUnsigned(record.ownerUid, "resource key ownerUid"),
    serviceId: requireString(record.serviceId, "resource key serviceId"),
    incarnationId: requireString(record.incarnationId, "resource key incarnationId"),
  }
}

function parseReconciliation(value: unknown): RepairGenerationReconciliationV1 {
  const record = requireRecord(value, "repair reconciliation")
  requireExactKeys(record, [
    "schemaVersion", "resourceId", "resourceKey", "repairGeneration", "takeoverId", "disposition",
    "requestRef", "requestSha256", "ownerAuthorityRef", "ownerAuthoritySha256", "inspectRef",
    "inspectSha256", "observedAt",
  ], "repair reconciliation")
  if (record.schemaVersion !== 1) fail("repair reconciliation schemaVersion must be 1")
  if (record.disposition !== "committed" && record.disposition !== "rolled_back") {
    fail("repair reconciliation disposition must be committed or rolled_back")
  }
  return {
    schemaVersion: 1,
    resourceId: requireString(record.resourceId, "repair reconciliation resourceId"),
    resourceKey: parseResourceKey(record.resourceKey),
    repairGeneration: requirePositive(record.repairGeneration, "repair reconciliation generation"),
    takeoverId: requireString(record.takeoverId, "repair reconciliation takeoverId"),
    disposition: record.disposition,
    requestRef: requireString(record.requestRef, "repair reconciliation requestRef"),
    requestSha256: requireSha256(record.requestSha256, "repair reconciliation requestSha256"),
    ownerAuthorityRef: requireString(record.ownerAuthorityRef, "repair reconciliation ownerAuthorityRef"),
    ownerAuthoritySha256: requireSha256(record.ownerAuthoritySha256, "repair reconciliation ownerAuthoritySha256"),
    inspectRef: requireString(record.inspectRef, "repair reconciliation inspectRef"),
    inspectSha256: requireSha256(record.inspectSha256, "repair reconciliation inspectSha256"),
    observedAt: requireIso(record.observedAt, "repair reconciliation observedAt"),
  }
}

export function deriveBarrierTargetKey(scope: BarrierScope, target: BarrierTarget): string {
  const parsed = parseTarget(scope, target, "barrier target")
  return `${scope}:sha256:${sha256CanonicalJson({ scope, target: parsed })}`
}

export function deriveRepairEligibilityId(resourceKey: ResourceKey, qualifyingProbeSequences: number[]): string {
  const parsedKey = parseResourceKey(resourceKey)
  if (!Array.isArray(qualifyingProbeSequences) || qualifyingProbeSequences.length === 0) {
    fail("qualifying probe sequences must be non-empty")
  }
  const parsed = qualifyingProbeSequences.map((value) => requireSafeUnsigned(value, "qualifying probe sequence"))
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index] <= parsed[index - 1]) fail("qualifying probe sequences must be strictly increasing")
  }
  return sha256CanonicalJson({ resourceKey: parsedKey, qualifyingProbeSequences: parsed })
}

export function deriveActionWindowId(
  barrierId: string,
  deferredId: string,
  repairEligibilityId: string,
): string {
  const bytes = canonicalizeJson({
    barrierId: requireString(barrierId, "barrierId"),
    deferredId: requireString(deferredId, "deferredId"),
    repairEligibilityId: requireString(repairEligibilityId, "repairEligibilityId"),
  })
  return `aw_${createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("base64url")}`
}

function parseReleasePolicy(scope: BarrierScope, value: unknown): BarrierReleasePolicy {
  const record = requireRecord(value, "barrier release policy")
  if (scope === "scheduled-dispatch") {
    requireExactKeys(record, ["kind"], "scheduled barrier release policy")
    if (record.kind !== "continuous") fail("scheduled barriers require continuous release")
    return { kind: "continuous" }
  }
  requireExactKeys(record, ["kind", "terminalTimeoutMs"], "resource barrier release policy")
  if (record.kind !== "one-shot-current" || record.terminalTimeoutMs !== 600_000) {
    fail("resource barriers require the exact one-shot-current 600000ms policy")
  }
  return { kind: "one-shot-current", terminalTimeoutMs: 600_000 }
}

function parseBarrier(value: unknown, mapKey: string): BarrierV1 {
  const record = requireRecord(value, `barrier ${mapKey}`)
  requireExactKeys(record, [
    "barrierId", "scope", "target", "targetKey", "holder", "tokenHash", "releasePolicy", "status",
    "acquiredEpoch", "releasedEpoch", "acquiredAt", "releasedAt",
  ], `barrier ${mapKey}`)
  if (record.barrierId !== mapKey) fail(`barrier map key ${mapKey} does not match barrierId`)
  if (record.scope !== "resource-repair" && record.scope !== "scheduled-dispatch") fail("barrier scope is invalid")
  const scope = record.scope
  const target = parseTarget(scope, record.target, "barrier target")
  const targetKey = requireString(record.targetKey, "barrier targetKey")
  if (targetKey !== deriveBarrierTargetKey(scope, target)) fail("barrier targetKey does not match its target")
  if (record.status !== "held" && record.status !== "released") fail("barrier status is invalid")
  const releasedEpoch = requireNullableString(record.releasedEpoch, "barrier releasedEpoch")
  const releasedAt = requireNullableIso(record.releasedAt, "barrier releasedAt")
  if (record.status === "held" ? releasedEpoch !== null || releasedAt !== null : releasedEpoch === null || releasedAt === null) {
    fail("barrier release fields disagree with status")
  }
  return {
    barrierId: mapKey,
    scope,
    target,
    targetKey,
    holder: requireString(record.holder, "barrier holder"),
    tokenHash: requireSha256(record.tokenHash, "barrier tokenHash"),
    releasePolicy: parseReleasePolicy(scope, record.releasePolicy),
    status: record.status,
    acquiredEpoch: requireString(record.acquiredEpoch, "barrier acquiredEpoch"),
    releasedEpoch,
    acquiredAt: requireIso(record.acquiredAt, "barrier acquiredAt"),
    releasedAt,
  }
}

function parseDeferred(value: unknown, mapKey: string): DeferredV1 {
  const record = requireRecord(value, `deferred ${mapKey}`)
  requireExactKeys(record, [
    "deferredId", "kind", "target", "targetKey", "dedupeKey", "payload", "blockedBy", "state",
    "firstDeniedAt", "lastDeniedAt", "readyAt", "settledAt", "deliveryRef",
  ], `deferred ${mapKey}`)
  if (record.deferredId !== mapKey) fail(`deferred map key ${mapKey} does not match deferredId`)
  if (record.kind !== "resource-repair" && record.kind !== "scheduled-dispatch") fail("deferred kind is invalid")
  const kind = record.kind
  const target = parseTarget(kind, record.target, "deferred target")
  const targetKey = requireString(record.targetKey, "deferred targetKey")
  if (targetKey !== deriveBarrierTargetKey(kind, target)) fail("deferred targetKey does not match its target")
  const payloadRecord = requireRecord(record.payload, "deferred payload")
  let payload: RepairDeferredPayload | ScheduledDeferredPayload
  let expectedDedupe: string
  if (kind === "resource-repair") {
    requireExactKeys(payloadRecord, ["observationId", "repairEligibilityId"], "repair deferred payload")
    payload = {
      observationId: requireString(payloadRecord.observationId, "repair observationId"),
      repairEligibilityId: requireString(payloadRecord.repairEligibilityId, "repair eligibilityId"),
    }
    expectedDedupe = payload.repairEligibilityId
  } else {
    requireExactKeys(payloadRecord, ["scheduleRevision", "slotKey", "scheduledAtUtc"], "scheduled deferred payload")
    payload = {
      scheduleRevision: requireString(payloadRecord.scheduleRevision, "schedule revision"),
      slotKey: requireString(payloadRecord.slotKey, "schedule slotKey"),
      scheduledAtUtc: requireIso(payloadRecord.scheduledAtUtc, "scheduledAtUtc"),
    }
    expectedDedupe = payload.slotKey
  }
  if (record.dedupeKey !== expectedDedupe) fail("deferred dedupeKey does not match its payload")
  if (!Array.isArray(record.blockedBy)) fail("deferred blockedBy must be an array")
  const blockedBy = record.blockedBy.map((entry) => requireString(entry, "deferred blocker"))
  if (new Set(blockedBy).size !== blockedBy.length || [...blockedBy].sort().some((entry, index) => entry !== blockedBy[index])) {
    fail("deferred blockedBy must be sorted and unique")
  }
  if (!["pending", "ready", "settled", "discarded"].includes(record.state as string)) fail("deferred state is invalid")
  const deferredState = record.state as DeferredV1["state"]
  const readyAt = requireNullableIso(record.readyAt, "deferred readyAt")
  const settledAt = requireNullableIso(record.settledAt, "deferred settledAt")
  const deliveryRef = requireNullableString(record.deliveryRef, "deferred deliveryRef")
  if (deferredState === "pending" && (readyAt !== null || settledAt !== null || deliveryRef !== null)) {
    fail("pending deferred timestamps are invalid")
  }
  if (deferredState === "ready" && (readyAt === null || settledAt !== null || deliveryRef !== null)) {
    fail("ready deferred timestamps are invalid")
  }
  if (deferredState === "settled" && (readyAt === null || settledAt === null || deliveryRef === null)) {
    fail("settled deferred fields are invalid")
  }
  if (deferredState === "discarded" && (settledAt === null || deliveryRef !== null)) {
    fail("discarded deferred fields are invalid")
  }
  return {
    deferredId: mapKey,
    kind,
    target,
    targetKey,
    dedupeKey: expectedDedupe,
    payload,
    blockedBy,
    state: deferredState,
    firstDeniedAt: requireIso(record.firstDeniedAt, "deferred firstDeniedAt"),
    lastDeniedAt: requireIso(record.lastDeniedAt, "deferred lastDeniedAt"),
    readyAt,
    settledAt,
    deliveryRef,
  }
}

function parseActionWindow(value: unknown, mapKey: string): ActionWindowV1 {
  const record = requireRecord(value, `action window ${mapKey}`)
  requireExactKeys(record, [
    "schemaVersion", "actionWindowId", "barrierId", "resourceId", "incarnationId", "deferredId",
    "repairEligibilityId", "state", "repairGeneration", "releasedAt", "terminalDeadlineAt", "consumedAt",
    "terminalAt", "terminalRef", "terminalSha256", "supersededBy",
  ], `action window ${mapKey}`)
  if (record.schemaVersion !== 1 || record.actionWindowId !== mapKey) fail("action window identity is invalid")
  const barrierId = requireString(record.barrierId, "action window barrierId")
  const deferredId = requireString(record.deferredId, "action window deferredId")
  const repairEligibilityId = requireString(record.repairEligibilityId, "action window eligibilityId")
  if (deriveActionWindowId(barrierId, deferredId, repairEligibilityId) !== mapKey) {
    fail("action window id does not match its authority")
  }
  if (!["armed", "consumed", "succeeded", "blocked", "superseded"].includes(record.state as string)) {
    fail("action window state is invalid")
  }
  const windowState = record.state as ActionWindowV1["state"]
  const repairGeneration = record.repairGeneration === null
    ? null
    : requirePositive(record.repairGeneration, "action window repairGeneration")
  const consumedAt = requireNullableIso(record.consumedAt, "action window consumedAt")
  const terminalAt = requireNullableIso(record.terminalAt, "action window terminalAt")
  const terminalRef = requireNullableString(record.terminalRef, "action window terminalRef")
  const terminalSha256 = record.terminalSha256 === null
    ? null
    : requireSha256(record.terminalSha256, "action window terminalSha256")
  const supersededBy = requireNullableString(record.supersededBy, "action window supersededBy")
  if (windowState === "armed" && (repairGeneration !== null || consumedAt !== null || terminalAt !== null || terminalRef !== null || terminalSha256 !== null || supersededBy !== null)) {
    fail("armed action window fields are invalid")
  }
  if (windowState === "consumed" && (repairGeneration === null || consumedAt === null || terminalAt !== null || terminalRef !== null || terminalSha256 !== null || supersededBy !== null)) {
    fail("consumed action window fields are invalid")
  }
  if (windowState === "succeeded" && (repairGeneration === null || consumedAt === null || terminalAt === null || terminalRef === null || terminalSha256 === null || supersededBy !== null)) {
    fail("succeeded action window fields are invalid")
  }
  if (windowState === "blocked" && (terminalAt === null || supersededBy !== null || (terminalRef === null) !== (terminalSha256 === null))) {
    fail("blocked action window fields are invalid")
  }
  if (windowState === "superseded" && (terminalAt === null || supersededBy === null)) {
    fail("superseded action window fields are invalid")
  }
  return {
    schemaVersion: 1,
    actionWindowId: mapKey,
    barrierId,
    resourceId: requireString(record.resourceId, "action window resourceId"),
    incarnationId: requireString(record.incarnationId, "action window incarnationId"),
    deferredId,
    repairEligibilityId,
    state: windowState,
    repairGeneration,
    releasedAt: requireIso(record.releasedAt, "action window releasedAt"),
    terminalDeadlineAt: requireIso(record.terminalDeadlineAt, "action window terminalDeadlineAt"),
    consumedAt,
    terminalAt,
    terminalRef,
    terminalSha256,
    supersededBy,
  }
}

function parseMap<T>(value: unknown, label: string, parse: (entry: unknown, key: string) => T): Record<string, T> {
  const record = requireRecord(value, label)
  const result: Record<string, T> = {}
  for (const key of Object.keys(record).sort()) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") fail(`${label} contains an unsafe key`)
    result[key] = parse(record[key], key)
  }
  return result
}

export function parseBarrierStore(value: unknown): BarrierStoreV1 {
  const record = requireRecord(value, "barrier store")
  requireExactKeys(record, [
    "schemaVersion", "revision", "lastWriterEpoch", "barriers", "deferredIntents", "actionWindows", "updatedAt",
  ], "barrier store")
  if (record.schemaVersion !== 1) fail("barrier store schemaVersion must be 1")
  const barriers = parseMap(record.barriers, "barriers", parseBarrier)
  const deferredIntents = parseMap(record.deferredIntents, "deferred intents", parseDeferred)
  const actionWindows = parseMap(record.actionWindows, "action windows", parseActionWindow)

  for (const deferred of Object.values(deferredIntents)) {
    for (const barrierId of deferred.blockedBy) {
      const barrier = barriers[barrierId]
      if (!barrier || barrier.scope !== deferred.kind || barrier.targetKey !== deferred.targetKey) {
        fail("deferred intent references a mismatched barrier")
      }
    }
  }
  const activeByResource = new Set<string>()
  for (const window of Object.values(actionWindows)) {
    const barrier = barriers[window.barrierId]
    const deferred = deferredIntents[window.deferredId]
    if (
      !barrier || barrier.scope !== "resource-repair" || barrier.status !== "released" ||
      (barrier.target as ResourceBarrierTarget).resourceId !== window.resourceId ||
      (barrier.target as ResourceBarrierTarget).incarnationId !== window.incarnationId
    ) {
      fail("action window references a mismatched released resource barrier")
    }
    if (
      !deferred || deferred.kind !== "resource-repair" || deferred.targetKey !== barrier.targetKey ||
      (deferred.payload as RepairDeferredPayload).repairEligibilityId !== window.repairEligibilityId
    ) {
      fail("action window references a mismatched deferred intent")
    }
    if (window.state === "armed" || window.state === "consumed" || window.state === "blocked") {
      if (activeByResource.has(window.resourceId)) fail("barrier store has more than one active window for a resource")
      activeByResource.add(window.resourceId)
    }
  }

  return {
    schemaVersion: 1,
    revision: requireSafeUnsigned(record.revision, "barrier store revision"),
    lastWriterEpoch: requireString(record.lastWriterEpoch, "barrier store lastWriterEpoch"),
    barriers,
    deferredIntents,
    actionWindows,
    updatedAt: requireIso(record.updatedAt, "barrier store updatedAt"),
  }
}

export function createEmptyBarrierStore(writerEpoch: string, at: string): BarrierStoreV1 {
  return parseBarrierStore({
    schemaVersion: 1,
    revision: 0,
    lastWriterEpoch: requireString(writerEpoch, "writerEpoch"),
    barriers: {},
    deferredIntents: {},
    actionWindows: {},
    updatedAt: requireIso(at, "updatedAt"),
  })
}

function cloneStore(store: BarrierStoreV1): BarrierStoreV1 {
  return structuredClone(store)
}

function commitMutation(prior: BarrierStoreV1, next: BarrierStoreV1, writerEpoch: string, at: string): BarrierStoreV1 {
  next.revision = prior.revision + 1
  next.lastWriterEpoch = requireString(writerEpoch, "writerEpoch")
  next.updatedAt = requireIso(at, "command timestamp")
  return parseBarrierStore(next)
}

function exactEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right)
}

function heldBarriers(store: BarrierStoreV1, scope: BarrierScope, targetKey: string): BarrierV1[] {
  return Object.values(store.barriers)
    .filter((barrier) => barrier.status === "held" && barrier.scope === scope && barrier.targetKey === targetKey)
    .sort((left, right) => left.barrierId.localeCompare(right.barrierId))
}

function activeWindowsForResource(store: BarrierStoreV1, resourceId: string): ActionWindowV1[] {
  return Object.values(store.actionWindows).filter((window) =>
    window.resourceId === resourceId && ["armed", "consumed", "blocked"].includes(window.state),
  )
}

function deferAdmission(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "admission.scheduled" | "admission.repair" }>,
  scope: BarrierScope,
  target: BarrierTarget,
  payload: RepairDeferredPayload | ScheduledDeferredPayload,
  dedupeKey: string,
  blockers: BarrierV1[],
): AppliedBarrierCommandV1 {
  const targetKey = deriveBarrierTargetKey(scope, target)
  const existing = Object.values(prior.deferredIntents).find((deferred) =>
    deferred.kind === scope && deferred.targetKey === targetKey && deferred.dedupeKey === dedupeKey &&
    (deferred.state === "pending" || deferred.state === "ready"),
  )
  const next = cloneStore(prior)
  const blockedBy = blockers.map((barrier) => barrier.barrierId)
  let deferred: DeferredV1
  if (existing) {
    if (!exactEqual(existing.payload, payload)) fail("deferred dedupe identity conflicts with its payload")
    deferred = {
      ...existing,
      blockedBy,
      state: "pending",
      lastDeniedAt: requireIso(command.at, "denial timestamp"),
      readyAt: null,
      settledAt: null,
      deliveryRef: null,
    }
    next.deferredIntents[existing.deferredId] = deferred
  } else {
    deferred = {
      deferredId: requireString(command.deferredId, "deferredId"),
      kind: scope,
      target,
      targetKey,
      dedupeKey,
      payload,
      blockedBy,
      state: "pending",
      firstDeniedAt: requireIso(command.at, "denial timestamp"),
      lastDeniedAt: requireIso(command.at, "denial timestamp"),
      readyAt: null,
      settledAt: null,
      deliveryRef: null,
    }
    if (next.deferredIntents[deferred.deferredId]) fail("deferredId conflicts with an existing intent")
    next.deferredIntents[deferred.deferredId] = deferred
  }
  const store = commitMutation(prior, next, command.writerEpoch, command.at)
  return { store, result: { kind: "deferred", deferredId: deferred.deferredId, deferred } }
}

function applyAcquire(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "barrier.acquire" }>,
): AppliedBarrierCommandV1 {
  const target = parseTarget(command.scope, command.target, "barrier target")
  const barrier: BarrierV1 = {
    barrierId: requireString(command.barrierId, "barrierId"),
    scope: command.scope,
    target,
    targetKey: deriveBarrierTargetKey(command.scope, target),
    holder: requireString(command.holder, "barrier holder"),
    tokenHash: requireSha256(command.tokenHash, "barrier tokenHash"),
    releasePolicy: parseReleasePolicy(command.scope, command.releasePolicy),
    status: "held",
    acquiredEpoch: requireString(command.writerEpoch, "writerEpoch"),
    releasedEpoch: null,
    acquiredAt: requireIso(command.at, "barrier acquiredAt"),
    releasedAt: null,
  }
  const existing = prior.barriers[barrier.barrierId]
  if (existing) {
    if (exactEqual(existing, barrier)) return { store: prior, result: { kind: "acquired", barrier: existing, replayed: true } }
    fail("barrier acquisition conflicts with an existing barrier identity")
  }
  const next = cloneStore(prior)
  next.barriers[barrier.barrierId] = barrier
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: { kind: "acquired", barrier, replayed: false },
  }
}

function applyScheduledAdmission(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "admission.scheduled" }>,
): AppliedBarrierCommandV1 {
  const target = parseScheduledTarget(command.target, "scheduled target")
  const targetKey = deriveBarrierTargetKey("scheduled-dispatch", target)
  const blockers = heldBarriers(prior, "scheduled-dispatch", targetKey)
  if (blockers.length === 0) return { store: prior, result: { kind: "admitted", actionWindow: null } }
  const payload: ScheduledDeferredPayload = {
    scheduleRevision: requireString(command.scheduleRevision, "schedule revision"),
    slotKey: requireString(command.slotKey, "schedule slotKey"),
    scheduledAtUtc: requireIso(command.scheduledAtUtc, "scheduledAtUtc"),
  }
  return deferAdmission(prior, command, "scheduled-dispatch", target, payload, payload.slotKey, blockers)
}

function applyRepairAdmission(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "admission.repair" }>,
): AppliedBarrierCommandV1 {
  const target = parseResourceTarget(command.target, "repair target")
  const targetKey = deriveBarrierTargetKey("resource-repair", target)
  const blockers = heldBarriers(prior, "resource-repair", targetKey)
  const payload: RepairDeferredPayload = {
    observationId: requireString(command.observationId, "repair observationId"),
    repairEligibilityId: requireString(command.repairEligibilityId, "repair eligibilityId"),
  }
  if (blockers.length > 0) {
    return deferAdmission(prior, command, "resource-repair", target, payload, payload.repairEligibilityId, blockers)
  }

  const active = activeWindowsForResource(prior, target.resourceId)
  if (active.length === 0) return { store: prior, result: { kind: "admitted", actionWindow: null } }
  if (active.length !== 1) fail("resource has multiple active action windows")
  const window = active[0]
  if (window.incarnationId !== target.incarnationId) fail("active action window belongs to a different incarnation")
  const generation = requirePositive(command.repairGeneration, "repair generation")
  if (window.state === "blocked") fail("blocked action window requires terminal reconciliation before another generation")
  if (window.repairEligibilityId !== payload.repairEligibilityId) fail("active action window blocks a different eligibility")
  if (window.state === "consumed") {
    if (window.repairGeneration !== generation) fail("action window already consumed a different generation")
    return { store: prior, result: { kind: "admitted", actionWindow: window } }
  }
  const next = cloneStore(prior)
  const consumed: ActionWindowV1 = {
    ...window,
    state: "consumed",
    repairGeneration: generation,
    consumedAt: requireIso(command.at, "repair consumedAt"),
  }
  next.actionWindows[window.actionWindowId] = consumed
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: { kind: "admitted", actionWindow: consumed },
  }
}

function releaseReplay(prior: BarrierStoreV1, barrier: BarrierV1, command: Extract<BarrierCommandV1, { kind: "barrier.release" }>): AppliedBarrierCommandV1 {
  if (
    barrier.holder !== command.holder || barrier.tokenHash !== command.tokenHash ||
    barrier.releasedEpoch !== command.writerEpoch || barrier.releasedAt !== command.at
  ) {
    fail("released barrier cannot be replayed with drifted authority")
  }
  const windows = Object.values(prior.actionWindows).filter((window) => window.barrierId === barrier.barrierId)
  const actionWindow = windows.length === 0 ? null : windows.length === 1 ? windows[0] : fail("released barrier has multiple action windows")
  const matching = Object.values(prior.deferredIntents).filter((deferred) =>
    deferred.kind === barrier.scope && deferred.targetKey === barrier.targetKey,
  )
  return {
    store: prior,
    result: {
      kind: "released",
      barrier,
      readyDeferredIds: matching.filter((item) => item.readyAt === command.at).map((item) => item.deferredId).sort(),
      discardedDeferredIds: matching.filter((item) => item.state === "discarded" && item.settledAt === command.at).map((item) => item.deferredId).sort(),
      actionWindow,
      replayed: true,
    },
  }
}

function applyRelease(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "barrier.release" }>,
): AppliedBarrierCommandV1 {
  const barrierId = requireString(command.barrierId, "barrierId")
  const barrier = prior.barriers[barrierId]
  if (!barrier) fail("barrier is missing")
  requireString(command.holder, "barrier holder")
  requireSha256(command.tokenHash, "barrier tokenHash")
  requireString(command.currentDedupeKey, "current deferred dedupe key")
  requireIso(command.at, "release timestamp")
  requireString(command.writerEpoch, "writerEpoch")
  if (barrier.status === "released") return releaseReplay(prior, barrier, command)
  if (barrier.holder !== command.holder) fail("barrier holder mismatch")
  if (barrier.tokenHash !== command.tokenHash) fail("barrier token mismatch")

  const pending = Object.values(prior.deferredIntents).filter((deferred) =>
    deferred.kind === barrier.scope && deferred.targetKey === barrier.targetKey && deferred.state === "pending",
  )
  const current = pending.filter((deferred) => deferred.dedupeKey === command.currentDedupeKey)
  if (barrier.releasePolicy.kind === "one-shot-current" && current.length !== 1) {
    fail("one-shot release requires exactly one current deferred repair")
  }
  if (barrier.releasePolicy.kind === "one-shot-current") {
    const target = barrier.target as ResourceBarrierTarget
    if (activeWindowsForResource(prior, target.resourceId).length > 0) {
      fail("one-shot resource already has an active action window; explicit rearm is required")
    }
  }

  const next = cloneStore(prior)
  const releasedBarrier: BarrierV1 = {
    ...barrier,
    status: "released",
    releasedEpoch: command.writerEpoch,
    releasedAt: command.at,
  }
  next.barriers[barrierId] = releasedBarrier
  const readyDeferredIds: string[] = []
  const discardedDeferredIds: string[] = []
  for (const deferred of pending) {
    if (deferred.dedupeKey === command.currentDedupeKey) {
      next.deferredIntents[deferred.deferredId] = { ...deferred, state: "ready", readyAt: command.at }
      readyDeferredIds.push(deferred.deferredId)
    } else {
      next.deferredIntents[deferred.deferredId] = { ...deferred, state: "discarded", settledAt: command.at }
      discardedDeferredIds.push(deferred.deferredId)
    }
  }

  let actionWindow: ActionWindowV1 | null = null
  if (barrier.releasePolicy.kind === "one-shot-current") {
    const deferred = current[0]
    const target = barrier.target as ResourceBarrierTarget
    const eligibility = (deferred.payload as RepairDeferredPayload).repairEligibilityId
    const actionWindowId = deriveActionWindowId(barrierId, deferred.deferredId, eligibility)
    actionWindow = {
      schemaVersion: 1,
      actionWindowId,
      barrierId,
      resourceId: target.resourceId,
      incarnationId: target.incarnationId,
      deferredId: deferred.deferredId,
      repairEligibilityId: eligibility,
      state: "armed",
      repairGeneration: null,
      releasedAt: command.at,
      terminalDeadlineAt: new Date(new Date(command.at).getTime() + barrier.releasePolicy.terminalTimeoutMs).toISOString(),
      consumedAt: null,
      terminalAt: null,
      terminalRef: null,
      terminalSha256: null,
      supersededBy: null,
    }
    if (next.actionWindows[actionWindowId]) fail("action window identity already exists")
    next.actionWindows[actionWindowId] = actionWindow
  }
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: {
      kind: "released",
      barrier: releasedBarrier,
      readyDeferredIds: readyDeferredIds.sort(),
      discardedDeferredIds: discardedDeferredIds.sort(),
      actionWindow,
      replayed: false,
    },
  }
}

function applySucceed(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "action-window.succeed" }>,
): AppliedBarrierCommandV1 {
  const window = prior.actionWindows[requireString(command.actionWindowId, "actionWindowId")]
  if (!window) fail("action window is missing")
  const generation = requirePositive(command.repairGeneration, "repair generation")
  const terminalRef = requireString(command.terminalRef, "terminalRef")
  const terminalSha256 = requireSha256(command.terminalSha256, "terminalSha256")
  if (window.state === "succeeded") {
    if (
      window.repairGeneration === generation && window.terminalRef === terminalRef &&
      window.terminalSha256 === terminalSha256 && window.terminalAt === command.at
    ) return { store: prior, result: { kind: "succeeded", actionWindow: window, replayed: true } }
    fail("succeeded action window cannot change terminal authority")
  }
  if (window.state !== "consumed" && window.state !== "blocked") fail("action window is not success-eligible")
  if (window.repairGeneration !== generation) fail("success generation does not match action window")
  const next = cloneStore(prior)
  const succeeded: ActionWindowV1 = {
    ...window,
    state: "succeeded",
    terminalAt: requireIso(command.at, "success timestamp"),
    terminalRef,
    terminalSha256,
  }
  next.actionWindows[window.actionWindowId] = succeeded
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: { kind: "succeeded", actionWindow: succeeded, replayed: false },
  }
}

function applyBlock(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "action-window.block" }>,
): AppliedBarrierCommandV1 {
  const window = prior.actionWindows[requireString(command.actionWindowId, "actionWindowId")]
  if (!window) fail("action window is missing")
  const generation = requirePositive(command.repairGeneration, "repair generation")
  const terminalRef = requireString(command.terminalRef, "terminalRef")
  const terminalSha256 = requireSha256(command.terminalSha256, "terminalSha256")
  if (command.disposition !== "failed_terminal" && command.disposition !== "outcome_unknown") fail("block disposition is invalid")
  if (window.state === "blocked") {
    if (
      window.repairGeneration === generation && window.terminalRef === terminalRef &&
      window.terminalSha256 === terminalSha256 && window.terminalAt === command.at
    ) return { store: prior, result: { kind: "blocked", actionWindow: window, replayed: true } }
    fail("blocked action window cannot change terminal authority")
  }
  if (window.state !== "consumed" || window.repairGeneration !== generation) fail("action window generation is not block-eligible")
  const next = cloneStore(prior)
  const blocked: ActionWindowV1 = {
    ...window,
    state: "blocked",
    terminalAt: requireIso(command.at, "block timestamp"),
    terminalRef,
    terminalSha256,
  }
  next.actionWindows[window.actionWindowId] = blocked
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: { kind: "blocked", actionWindow: blocked, replayed: false },
  }
}

function applyExpire(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "action-window.expire" }>,
): AppliedBarrierCommandV1 {
  const window = prior.actionWindows[requireString(command.actionWindowId, "actionWindowId")]
  if (!window) fail("action window is missing")
  if (window.state !== "armed" && window.state !== "consumed") fail("action window is not deadline-eligible")
  const at = requireIso(command.at, "expiry timestamp")
  if (new Date(at).getTime() < new Date(window.terminalDeadlineAt).getTime()) fail("action window deadline has not passed")
  const next = cloneStore(prior)
  const blocked: ActionWindowV1 = {
    ...window,
    state: "blocked",
    terminalAt: at,
    terminalRef: null,
    terminalSha256: null,
  }
  next.actionWindows[window.actionWindowId] = blocked
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: { kind: "blocked", actionWindow: blocked, replayed: false },
  }
}

function applyRearm(
  prior: BarrierStoreV1,
  command: Extract<BarrierCommandV1, { kind: "barrier.rearm" }>,
): AppliedBarrierCommandV1 {
  const old = prior.actionWindows[requireString(command.blockedActionWindowId, "blockedActionWindowId")]
  if (!old || old.state !== "blocked") fail("rearm requires the matching blocked action window")
  if (old.repairGeneration === null) fail("rearm requires a consumed repair generation")
  const barrier = prior.barriers[requireString(command.barrierId, "barrierId")]
  if (!barrier || barrier.status !== "held" || barrier.scope !== "resource-repair" || barrier.releasePolicy.kind !== "one-shot-current") {
    fail("rearm requires a new held one-shot resource barrier")
  }
  if (barrier.holder !== command.holder || barrier.tokenHash !== command.tokenHash) fail("rearm barrier authority mismatch")
  const target = barrier.target as ResourceBarrierTarget
  if (target.resourceId !== old.resourceId || target.incarnationId !== old.incarnationId) fail("rearm target does not match blocked window")
  if (!Number.isSafeInteger(command.remainingBudget) || command.remainingBudget <= 0) fail("rearm requires remaining repair budget")
  const at = requireIso(command.at, "rearm timestamp")
  if (command.cooldownUntil !== null && new Date(requireIso(command.cooldownUntil, "cooldownUntil")).getTime() > new Date(at).getTime()) {
    fail("rearm cooldown has not elapsed")
  }
  const reconciliation = parseReconciliation(command.reconciliation)
  if (
    reconciliation.resourceId !== old.resourceId ||
    reconciliation.resourceKey.incarnationId !== old.incarnationId ||
    reconciliation.repairGeneration !== old.repairGeneration
  ) {
    fail("reconciliation does not match the blocked repair generation")
  }
  if (new Date(reconciliation.observedAt).getTime() > new Date(at).getTime()) fail("reconciliation inspection is from the future")
  const currentDedupeKey = requireString(command.currentDedupeKey, "current deferred dedupe key")
  const candidates = Object.values(prior.deferredIntents).filter((deferred) =>
    deferred.kind === "resource-repair" && deferred.targetKey === barrier.targetKey &&
    deferred.state === "pending" && deferred.dedupeKey === currentDedupeKey,
  )
  if (candidates.length !== 1) fail("rearm requires exactly one new current deferred repair")
  const otherActive = activeWindowsForResource(prior, old.resourceId).filter((window) => window.actionWindowId !== old.actionWindowId)
  if (otherActive.length > 0) fail("rearm compare-and-set found another active action window")

  const deferred = candidates[0]
  const eligibility = (deferred.payload as RepairDeferredPayload).repairEligibilityId
  const actionWindowId = deriveActionWindowId(barrier.barrierId, deferred.deferredId, eligibility)
  if (prior.actionWindows[actionWindowId]) fail("rearm action window already exists")
  const next = cloneStore(prior)
  const releasedBarrier: BarrierV1 = {
    ...barrier,
    status: "released",
    releasedEpoch: command.writerEpoch,
    releasedAt: at,
  }
  const actionWindow: ActionWindowV1 = {
    schemaVersion: 1,
    actionWindowId,
    barrierId: barrier.barrierId,
    resourceId: old.resourceId,
    incarnationId: old.incarnationId,
    deferredId: deferred.deferredId,
    repairEligibilityId: eligibility,
    state: "armed",
    repairGeneration: null,
    releasedAt: at,
    terminalDeadlineAt: new Date(new Date(at).getTime() + barrier.releasePolicy.terminalTimeoutMs).toISOString(),
    consumedAt: null,
    terminalAt: null,
    terminalRef: null,
    terminalSha256: null,
    supersededBy: null,
  }
  next.actionWindows[old.actionWindowId] = { ...old, state: "superseded", supersededBy: actionWindowId }
  next.actionWindows[actionWindowId] = actionWindow
  next.barriers[barrier.barrierId] = releasedBarrier
  next.deferredIntents[deferred.deferredId] = { ...deferred, state: "ready", readyAt: at }
  for (const stale of Object.values(prior.deferredIntents)) {
    if (
      stale.kind === "resource-repair" && stale.targetKey === barrier.targetKey && stale.state === "pending" &&
      stale.deferredId !== deferred.deferredId
    ) {
      next.deferredIntents[stale.deferredId] = { ...stale, state: "discarded", settledAt: at }
    }
  }
  return {
    store: commitMutation(prior, next, command.writerEpoch, command.at),
    result: { kind: "rearmed", priorActionWindowId: old.actionWindowId, actionWindow, barrier: releasedBarrier },
  }
}

export function applyBarrierCommand(priorValue: BarrierStoreV1, command: BarrierCommandV1): AppliedBarrierCommandV1 {
  const prior = parseBarrierStore(priorValue)
  let applied: AppliedBarrierCommandV1
  switch (command.kind) {
    case "barrier.acquire": applied = applyAcquire(prior, command); break
    case "admission.scheduled": applied = applyScheduledAdmission(prior, command); break
    case "admission.repair": applied = applyRepairAdmission(prior, command); break
    case "barrier.release": applied = applyRelease(prior, command); break
    case "action-window.succeed": applied = applySucceed(prior, command); break
    case "action-window.block": applied = applyBlock(prior, command); break
    case "action-window.expire": applied = applyExpire(prior, command); break
    case "barrier.rearm": applied = applyRearm(prior, command); break
  }
  if (applied.store !== prior) {
    emitNervesEvent({
      component: "heart",
      event: "heart.activation_barrier_transition_committed",
      message: "applied generic activation barrier transition",
      meta: { operation: command.kind, revision: applied.store.revision },
    })
  }
  return applied
}

type PublicBarrierCommandV1 = Exclude<BarrierCommandV1, { kind: "barrier.rearm" }>

export interface ReconciliationAuthority {
  resolve(ref: string, sha256: string): RepairGenerationReconciliationV1
}

export interface ActivationBarrierStoreOptions {
  targetPath: string
  owner: ProcessIdentity
  proveOwnerState(owner: ProcessIdentity): ExactProcessState
  reconciliationAuthority?: ReconciliationAuthority
  io?: ProtectedStoreIo
}

export interface RearmBarrierInputV1 extends CommandAuthority {
  barrierId: string
  holder: string
  tokenHash: string
  blockedActionWindowId: string
  currentDedupeKey: string
  reconciliationRef: string
  reconciliationSha256: string
  remainingBudget: number
  cooldownUntil: string | null
}

export class ActivationBarrierStore {
  private readonly options: ActivationBarrierStoreOptions

  constructor(options: ActivationBarrierStoreOptions) {
    this.options = options
  }

  read(): BarrierStoreV1 {
    return readProtectedJson(this.options.targetPath, parseBarrierStore, this.options.io)
  }

  private mutate(
    command: BarrierCommandV1,
    duringLock?: (applied: AppliedBarrierCommandV1) => void,
  ): AppliedBarrierCommandV1 {
    let applied: AppliedBarrierCommandV1 | null = null
    const store = mutateProtectedJson({
      targetPath: this.options.targetPath,
      owner: this.options.owner,
      proveOwnerState: this.options.proveOwnerState,
      parse: parseBarrierStore,
      initial: createEmptyBarrierStore(command.writerEpoch, command.at),
      mutate: (prior) => {
        applied = applyBarrierCommand(prior, command)
        duringLock?.(applied)
        return applied.store
      },
      io: this.options.io,
    })
    if (applied === null) fail("activation barrier mutation produced no result")
    return { ...(applied as AppliedBarrierCommandV1), store }
  }

  apply(command: PublicBarrierCommandV1): AppliedBarrierCommandV1 {
    if ((command as BarrierCommandV1).kind === "barrier.rearm") {
      fail("raw rearm is forbidden; use reconciliation authority")
    }
    return this.mutate(command)
  }

  withScheduledAdmission<T>(
    command: Extract<BarrierCommandV1, { kind: "admission.scheduled" }>,
    claim: () => T,
  ): { admission: BarrierCommandResultV1; claim?: T } {
    let claimResult: T | undefined
    const applied = this.mutate(command, (candidate) => {
      if (candidate.result.kind === "admitted") claimResult = claim()
    })
    return { admission: applied.result, ...(applied.result.kind === "admitted" ? { claim: claimResult } : {}) }
  }

  withRepairAdmission<T>(
    command: Extract<BarrierCommandV1, { kind: "admission.repair" }>,
    beginAttempt: () => T,
  ): { admission: BarrierCommandResultV1; attempt?: T } {
    let attemptResult: T | undefined
    let invokeAfterCommit = false
    const applied = this.mutate(command, (candidate) => {
      if (candidate.result.kind !== "admitted") return
      if (candidate.result.actionWindow === null) attemptResult = beginAttempt()
      else invokeAfterCommit = true
    })
    if (invokeAfterCommit) attemptResult = beginAttempt()
    return { admission: applied.result, ...(applied.result.kind === "admitted" ? { attempt: attemptResult } : {}) }
  }

  rearm(input: RearmBarrierInputV1): AppliedBarrierCommandV1 {
    const authority = this.options.reconciliationAuthority
    if (!authority) fail("rearm requires a reconciliation authority resolver")
    const ref = requireString(input.reconciliationRef, "reconciliationRef")
    const sha256 = requireSha256(input.reconciliationSha256, "reconciliationSha256")
    const reconciliation = authority.resolve(ref, sha256)
    return this.mutate({
      kind: "barrier.rearm",
      barrierId: input.barrierId,
      holder: input.holder,
      tokenHash: input.tokenHash,
      blockedActionWindowId: input.blockedActionWindowId,
      currentDedupeKey: input.currentDedupeKey,
      reconciliation,
      remainingBudget: input.remainingBudget,
      cooldownUntil: input.cooldownUntil,
      writerEpoch: input.writerEpoch,
      at: input.at,
    })
  }
}
