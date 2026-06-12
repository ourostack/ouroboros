import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import { capStructuredRecordString, capStructuredRecordStringLeaves } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { readPendingObligations, type Obligation } from "./obligations"

export type FlightRecorderConfidence = "current" | "stale_risky" | "unknown"
export type FlightRecorderHealthStatus = "ok" | "degraded" | "unavailable"

export interface FlightRecorderResume {
  schemaVersion: 1
  hasCompleteState: boolean
  canContinue: boolean
  missing: string[]
  gaps: string[]
  currentAsk: {
    value: string | null
    confidence: FlightRecorderConfidence
    sourceEventIds: string[]
  }
  nextSafeAction: {
    value: string | null
    stopBefore: string[]
    sourceEventIds: string[]
  }
  blockedBecause: string[]
  activeObligationIds: string[]
  activeReturnObligationIds: string[]
  activePacketIds: string[]
  openEvolutionCaseIds: string[]
  recentClaimIds: string[]
  unverifiedClaimIds: string[]
  lastSafeCheckpoint: {
    turnId: string | null
    sessionRef: string | null
    recordedAt: string | null
    sourceEventIds: string[]
  }
  recorderHealth: {
    status: FlightRecorderHealthStatus
    issues: string[]
  }
}

export type FlightRecorderEventKind =
  | "turn_accepted"
  | "context_built"
  | "model_started"
  | "tool_completed"
  | "tool_failed"
  | "blocker_detected"
  | "claim_recorded"
  | "evidence_recorded"
  | "obligation_changed"
  | "post_turn_persisted"
  | "sync_pushed"
  | "sync_failed"
  | "habit_run"
  | "agent_note"

export interface FlightRecorderEvent {
  schemaVersion: 1
  id: string
  kind: FlightRecorderEventKind
  recordedAt: string
  turnId?: string
  sessionRef?: string
  summary: string
  currentAsk?: string | null
  nextSafeAction?: string | null
  stopBefore?: string[]
  blockedBecause?: string[]
  activeObligationIds?: string[]
  activeReturnObligationIds?: string[]
  activePacketIds?: string[]
  openEvolutionCaseIds?: string[]
  recentClaimIds?: string[]
  unverifiedClaimIds?: string[]
  producedRefs?: FlightRecorderProducedRef[]
  meta?: Record<string, unknown>
}

export interface FlightRecorderProducedRef {
  kind: "arc" | "desk_task" | "desk_record" | "claim" | "surface" | "none"
  locator: string
}

export type HabitRunTrigger = "cron" | "launchd" | "poke" | "overdue" | "manual"
export type HabitRunOutcome = "no_change" | "wrote_arc" | "updated_desk" | "wrote_record" | "surfaced" | "blocked" | "error"
export type HabitReturnRouteKind = "family" | "originator" | "extra"
export type HabitReturnRouteStatus = "allowed" | "unresolved"

export interface HabitReturnRoute {
  kind: HabitReturnRouteKind
  recipient: string
  status: HabitReturnRouteStatus
  friendId?: string
  channel?: string
  key?: string
  reason?: string
}

export interface HabitPermissionEnvelope {
  schemaVersion: 1
  canMessageOutward: boolean
  returnRoutes: HabitReturnRoute[]
  deniedTools: string[]
  warnings: string[]
}

export interface HabitToolPolicy {
  requestedTools: string[] | null
  grantedTools: string[]
  deniedTools: string[]
  outwardMessagingAllowed: boolean
}

export interface HabitSurfaceAttempt {
  recipient: string
  channel: string
  reason: "needed_input" | "status" | "answer" | "blocked" | "other"
  result: "sent" | "delivered" | "delivered_now" | "queued" | "deferred" | "blocked" | "failed" | "unavailable"
  routeKind?: HabitReturnRouteKind
  rawStatus?: string
  error?: string
}

export interface HabitRunSummarySnapshot {
  summary: string
  decisions: string[]
  nextLikelyStep: string | null
}

export interface LegacyHabitRunReceipt {
  schemaVersion: 1
  runId: string
  habitName: string
  trigger: HabitRunTrigger
  startedAt: string
  endedAt: string
  outcome: HabitRunOutcome
  producedRefs: FlightRecorderProducedRef[]
  surfaceAttempts: HabitSurfaceAttempt[]
  errors: string[]
}

export interface HabitRunReceipt {
  schemaVersion: 2
  runId: string
  sessionId: string
  habitName: string
  trigger: HabitRunTrigger
  startedAt: string
  endedAt: string
  outcome: HabitRunOutcome
  definitionLocator: string
  sessionLocator: string
  pendingLocator: string
  runtimeStateLocator: string
  receiptLocator: string
  operationId?: string | null
  nextRunAt: string | null
  permissionEnvelope: HabitPermissionEnvelope
  toolPolicy: HabitToolPolicy
  summarySnapshot: HabitRunSummarySnapshot
  producedRefs: FlightRecorderProducedRef[]
  surfaceAttempts: HabitSurfaceAttempt[]
  errors: string[]
}

export type WritableHabitRunReceipt =
  | (Omit<HabitRunReceipt, "summarySnapshot"> & { summarySnapshot?: HabitRunSummarySnapshot })
  | LegacyHabitRunReceipt

export function isHabitRunTrigger(value: unknown): value is HabitRunTrigger {
  return value === "cron"
    || value === "launchd"
    || value === "poke"
    || value === "overdue"
    || value === "manual"
}

export interface RecordFlightRecorderEventInput extends Omit<FlightRecorderEvent, "schemaVersion" | "id" | "recordedAt" | "summary"> {
  id?: string
  recordedAt?: string
  summary: string
}

function flightRecorderDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "flight-recorder")
}

function eventsDir(agentRoot: string): string {
  return path.join(flightRecorderDir(agentRoot), "events")
}

function receiptsDir(agentRoot: string): string {
  return path.join(flightRecorderDir(agentRoot), "habit-receipts")
}

function habitReceiptPath(agentRoot: string, runId: string): string {
  return path.join(receiptsDir(agentRoot), `${runId}.json`)
}

export function flightRecorderLatestPath(agentRoot: string): string {
  return path.join(flightRecorderDir(agentRoot), "latest.json")
}

function eventDay(recordedAt: string): string {
  return recordedAt.slice(0, 10) || "unknown"
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  fs.renameSync(tmpPath, filePath)
}

function cappedArray(values: string[]): string[] {
  return values.map((value) => capStructuredRecordString(value))
}

function normalizeEvent(input: RecordFlightRecorderEventInput): FlightRecorderEvent {
  const recordedAt = input.recordedAt ?? new Date().toISOString()
  return {
    schemaVersion: 1,
    id: input.id ?? `fr-${randomUUID()}`,
    kind: input.kind,
    recordedAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
    summary: capStructuredRecordString(input.summary),
    ...(input.currentAsk !== undefined ? { currentAsk: input.currentAsk ? capStructuredRecordString(input.currentAsk) : null } : {}),
    ...(input.nextSafeAction !== undefined ? { nextSafeAction: input.nextSafeAction ? capStructuredRecordString(input.nextSafeAction) : null } : {}),
    ...(input.stopBefore ? { stopBefore: cappedArray(input.stopBefore)! } : {}),
    ...(input.blockedBecause ? { blockedBecause: cappedArray(input.blockedBecause)! } : {}),
    ...(input.activeObligationIds ? { activeObligationIds: cappedArray(input.activeObligationIds)! } : {}),
    ...(input.activeReturnObligationIds ? { activeReturnObligationIds: cappedArray(input.activeReturnObligationIds)! } : {}),
    ...(input.activePacketIds ? { activePacketIds: cappedArray(input.activePacketIds)! } : {}),
    ...(input.openEvolutionCaseIds ? { openEvolutionCaseIds: cappedArray(input.openEvolutionCaseIds)! } : {}),
    ...(input.recentClaimIds ? { recentClaimIds: cappedArray(input.recentClaimIds)! } : {}),
    ...(input.unverifiedClaimIds ? { unverifiedClaimIds: cappedArray(input.unverifiedClaimIds)! } : {}),
    ...(input.producedRefs ? { producedRefs: input.producedRefs.map((ref) => ({ ...ref, locator: capStructuredRecordString(ref.locator) })) } : {}),
    ...(input.meta ? { meta: capStructuredRecordStringLeaves(input.meta) } : {}),
  }
}

function degradedResume(issues: string[]): FlightRecorderResume {
  return {
    schemaVersion: 1,
    hasCompleteState: false,
    canContinue: false,
    missing: ["currentAsk", "nextSafeAction"],
    gaps: [],
    currentAsk: { value: null, confidence: "unknown", sourceEventIds: [] },
    nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
    blockedBecause: [],
    activeObligationIds: [],
    activeReturnObligationIds: [],
    activePacketIds: [],
    openEvolutionCaseIds: [],
    recentClaimIds: [],
    unverifiedClaimIds: [],
    lastSafeCheckpoint: { turnId: null, sessionRef: null, recordedAt: null, sourceEventIds: [] },
    recorderHealth: {
      status: "degraded",
      issues,
    },
  }
}

/* v8 ignore start -- defensive schema guard fan-out; tests cover valid load and malformed-shape degradation @preserve */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

export function isFlightRecorderResume(value: unknown): value is FlightRecorderResume {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const currentAsk = record.currentAsk as Record<string, unknown> | undefined
  const nextSafeAction = record.nextSafeAction as Record<string, unknown> | undefined
  const lastSafeCheckpoint = record.lastSafeCheckpoint as Record<string, unknown> | undefined
  const recorderHealth = record.recorderHealth as Record<string, unknown> | undefined
  return record.schemaVersion === 1
    && typeof record.hasCompleteState === "boolean"
    && typeof record.canContinue === "boolean"
    && isStringArray(record.missing)
    && isStringArray(record.gaps)
    && !!currentAsk
    && typeof currentAsk === "object"
    && !Array.isArray(currentAsk)
    && isNullableString(currentAsk.value)
    && (currentAsk.confidence === "current" || currentAsk.confidence === "stale_risky" || currentAsk.confidence === "unknown")
    && isStringArray(currentAsk.sourceEventIds)
    && !!nextSafeAction
    && typeof nextSafeAction === "object"
    && !Array.isArray(nextSafeAction)
    && isNullableString(nextSafeAction.value)
    && isStringArray(nextSafeAction.stopBefore)
    && isStringArray(nextSafeAction.sourceEventIds)
    && isStringArray(record.blockedBecause)
    && isStringArray(record.activeObligationIds)
    && isStringArray(record.activeReturnObligationIds)
    && isStringArray(record.activePacketIds)
    && isStringArray(record.openEvolutionCaseIds)
    && isStringArray(record.recentClaimIds)
    && isStringArray(record.unverifiedClaimIds)
    && !!lastSafeCheckpoint
    && typeof lastSafeCheckpoint === "object"
    && !Array.isArray(lastSafeCheckpoint)
    && isNullableString(lastSafeCheckpoint.turnId)
    && isNullableString(lastSafeCheckpoint.sessionRef)
    && isNullableString(lastSafeCheckpoint.recordedAt)
    && isStringArray(lastSafeCheckpoint.sourceEventIds)
    && !!recorderHealth
    && typeof recorderHealth === "object"
    && !Array.isArray(recorderHealth)
    && (recorderHealth.status === "ok" || recorderHealth.status === "degraded" || recorderHealth.status === "unavailable")
    && isStringArray(recorderHealth.issues)
}
/* v8 ignore stop */

/* v8 ignore start -- semantic invariant fan-out is defensive; regression tests cover unsafe continuation normalization @preserve */
function nonEmpty(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function normalizeResumeInvariants(resume: FlightRecorderResume): FlightRecorderResume {
  const hasCurrentAsk = nonEmpty(resume.currentAsk.value)
  const hasNextSafeAction = nonEmpty(resume.nextSafeAction.value)
  const hasCompleteState = hasCurrentAsk && hasNextSafeAction
  const missing = [
    ...(hasCurrentAsk ? [] : ["currentAsk"]),
    ...(hasNextSafeAction ? [] : ["nextSafeAction"]),
  ]
  const missingChanged = resume.missing.join("\n") !== missing.join("\n")
  const issues = [
    ...(resume.canContinue && !hasCompleteState ? ["canContinue true while hasCompleteState false"] : []),
    ...(resume.canContinue && !hasCurrentAsk ? ["canContinue true without currentAsk"] : []),
    ...(resume.canContinue && !hasNextSafeAction ? ["canContinue true without nextSafeAction"] : []),
    ...(resume.canContinue && resume.blockedBecause.length > 0 ? ["canContinue true while blocked"] : []),
    ...(resume.canContinue && resume.recorderHealth.status !== "ok" ? ["canContinue true while recorder health is not ok"] : []),
  ]
  if (issues.length === 0 && resume.hasCompleteState === hasCompleteState && !missingChanged) return resume
  return {
    ...resume,
    hasCompleteState,
    canContinue: issues.length === 0 ? resume.canContinue : false,
    missing,
    currentAsk: {
      ...resume.currentAsk,
      confidence: hasCurrentAsk ? resume.currentAsk.confidence : "unknown",
    },
    recorderHealth: issues.length > 0
      ? {
          status: resume.recorderHealth.status === "unavailable" ? "unavailable" : "degraded",
          issues: uniqueStrings([...resume.recorderHealth.issues, ...issues]),
        }
      : resume.recorderHealth,
  }
}
/* v8 ignore stop */

interface ReconciledResume {
  resume: FlightRecorderResume
  staleActiveObligationIds: string[]
  missingActiveObligationIds: string[]
}

function remainingArcWorkDescriptions(resume: FlightRecorderResume): string[] {
  return [
    ...resume.activeReturnObligationIds.map((id) => `return obligation ${id}`),
    ...resume.activePacketIds.map((id) => `packet ${id}`),
    ...resume.openEvolutionCaseIds.map((id) => `evolution case ${id}`),
  ]
}

function nextSafeActionAfterObligationReconcile(
  resume: FlightRecorderResume,
  activeObligations: Obligation[],
  staleActiveObligationIds: string[],
): string {
  const firstActive = activeObligations[0]
  if (firstActive) {
    const detail = firstActive.nextAction?.trim() || firstActive.content
    return capStructuredRecordString(`continue open obligation ${firstActive.id}: ${detail}`)
  }
  const remainingWork = remainingArcWorkDescriptions(resume)
  if (remainingWork.length > 0) {
    return capStructuredRecordString(`continue remaining Arc work: ${remainingWork.slice(0, 5).join(", ")}`)
  }
  return capStructuredRecordString(`wait for new input; reconciled completed or missing obligations: ${staleActiveObligationIds.join(", ")}`)
}

function reconcileActiveObligations(agentRoot: string, resume: FlightRecorderResume): ReconciledResume {
  const activeObligations = readPendingObligations(agentRoot)
  const activeObligationIds = activeObligations.map((obligation) => obligation.id)
  const activeIdSet = new Set(activeObligationIds)
  const resumeIdSet = new Set(resume.activeObligationIds)
  const staleActiveObligationIds = resume.activeObligationIds.filter((id) => !activeIdSet.has(id))
  const missingActiveObligationIds = activeObligationIds.filter((id) => !resumeIdSet.has(id))
  if (staleActiveObligationIds.length === 0 && missingActiveObligationIds.length === 0) {
    return { resume, staleActiveObligationIds, missingActiveObligationIds }
  }
  const nextSafeActionValue = staleActiveObligationIds.length > 0 || !nonEmpty(resume.nextSafeAction.value)
    ? nextSafeActionAfterObligationReconcile(resume, activeObligations, staleActiveObligationIds)
    : resume.nextSafeAction.value
  const canContinue = nonEmpty(resume.currentAsk.value)
    && nonEmpty(nextSafeActionValue)
    && resume.blockedBecause.length === 0
    && resume.recorderHealth.status === "ok"
  return {
    resume: normalizeResumeInvariants({
      ...resume,
      canContinue,
      activeObligationIds,
      nextSafeAction: {
        ...resume.nextSafeAction,
        value: nextSafeActionValue,
      },
    }),
    staleActiveObligationIds,
    missingActiveObligationIds,
  }
}

function normalizeResumeForAgentRoot(agentRoot: string, resume: FlightRecorderResume): ReconciledResume {
  return reconcileActiveObligations(agentRoot, normalizeResumeInvariants(resume))
}

function emitFlightRecorderReconciled(
  agentRoot: string,
  staleActiveObligationIds: string[],
  missingActiveObligationIds: string[],
): void {
  if (staleActiveObligationIds.length === 0 && missingActiveObligationIds.length === 0) return
  emitNervesEvent({
    component: "mind",
    event: "mind.flight_recorder_resume_reconciled",
    message: "flight recorder resume reconciled with canonical Arc state",
    meta: {
      agentRoot,
      staleActiveObligationIds,
      missingActiveObligationIds,
    },
  })
}

function latestFromEvent(event: FlightRecorderEvent, previous: FlightRecorderResume): FlightRecorderResume {
  const currentAskValue = event.currentAsk !== undefined ? event.currentAsk : previous.currentAsk.value
  const nextSafeActionValue = event.nextSafeAction !== undefined ? event.nextSafeAction : previous.nextSafeAction.value
  const currentAskSourceEventIds = event.currentAsk !== undefined ? [event.id] : previous.currentAsk.sourceEventIds
  const nextSafeActionSourceEventIds = event.nextSafeAction !== undefined ? [event.id] : previous.nextSafeAction.sourceEventIds
  const inheritedBlocker = event.blockedBecause === undefined && previous.blockedBecause.length > 0
  const lastSafeCheckpointEventIds = inheritedBlocker
    ? uniqueStrings([...previous.lastSafeCheckpoint.sourceEventIds, event.id])
    : [event.id]
  const hasCurrentAsk = typeof currentAskValue === "string" && currentAskValue.trim().length > 0
  const hasNextSafeAction = typeof nextSafeActionValue === "string" && nextSafeActionValue.trim().length > 0
  return {
    ...previous,
    hasCompleteState: hasCurrentAsk && hasNextSafeAction,
    canContinue: hasCurrentAsk && hasNextSafeAction && (event.blockedBecause?.length ?? previous.blockedBecause.length) === 0,
    missing: [
      ...(hasCurrentAsk ? [] : ["currentAsk"]),
      ...(hasNextSafeAction ? [] : ["nextSafeAction"]),
    ],
    currentAsk: {
      value: currentAskValue,
      confidence: hasCurrentAsk ? "current" : "unknown",
      sourceEventIds: currentAskSourceEventIds,
    },
    nextSafeAction: {
      value: nextSafeActionValue,
      stopBefore: event.stopBefore ?? previous.nextSafeAction.stopBefore,
      sourceEventIds: nextSafeActionSourceEventIds,
    },
    blockedBecause: event.blockedBecause ?? previous.blockedBecause,
    activeObligationIds: event.activeObligationIds ?? previous.activeObligationIds,
    activeReturnObligationIds: event.activeReturnObligationIds ?? previous.activeReturnObligationIds,
    activePacketIds: event.activePacketIds ?? previous.activePacketIds,
    openEvolutionCaseIds: event.openEvolutionCaseIds ?? previous.openEvolutionCaseIds,
    recentClaimIds: event.recentClaimIds ?? previous.recentClaimIds,
    unverifiedClaimIds: event.unverifiedClaimIds ?? previous.unverifiedClaimIds,
    lastSafeCheckpoint: {
      turnId: event.turnId ?? previous.lastSafeCheckpoint.turnId,
      sessionRef: event.sessionRef ?? previous.lastSafeCheckpoint.sessionRef,
      recordedAt: event.recordedAt,
      sourceEventIds: lastSafeCheckpointEventIds,
    },
    recorderHealth: { status: "ok", issues: [] },
  }
}

export function readFlightRecorderResume(agentRoot: string): FlightRecorderResume {
  const latestPath = flightRecorderLatestPath(agentRoot)
  try {
    const parsed = JSON.parse(fs.readFileSync(latestPath, "utf-8")) as unknown
    if (!isFlightRecorderResume(parsed)) {
      throw new Error("latest.json has invalid flight-recorder resume shape")
    }
    const {
      resume,
      staleActiveObligationIds,
      missingActiveObligationIds,
    } = normalizeResumeForAgentRoot(agentRoot, parsed)
    if (staleActiveObligationIds.length > 0 || missingActiveObligationIds.length > 0) {
      atomicWriteJson(latestPath, resume)
      emitFlightRecorderReconciled(agentRoot, staleActiveObligationIds, missingActiveObligationIds)
    }
    emitNervesEvent({
      component: "mind",
      event: "mind.flight_recorder_resume_read",
      message: "flight recorder resume read",
      meta: { agentRoot, canContinue: resume.canContinue, hasCompleteState: resume.hasCompleteState },
    })
    return resume
  } catch (error) {
    const issue = fs.existsSync(latestPath)
      ? `latest.json unreadable: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`
      : "latest.json missing"
    emitNervesEvent({
      component: "mind",
      event: "mind.flight_recorder_resume_read",
      message: "flight recorder resume missing or degraded",
      meta: { agentRoot, issue },
    })
    return degradedResume([issue])
  }
}

export function writeFlightRecorderResume(agentRoot: string, resume: FlightRecorderResume): void {
  const {
    resume: safeResume,
    staleActiveObligationIds,
    missingActiveObligationIds,
  } = normalizeResumeForAgentRoot(agentRoot, resume)
  atomicWriteJson(flightRecorderLatestPath(agentRoot), safeResume)
  emitFlightRecorderReconciled(agentRoot, staleActiveObligationIds, missingActiveObligationIds)
  emitNervesEvent({
    component: "mind",
    event: "mind.flight_recorder_resume_written",
    message: "flight recorder resume written",
    meta: { agentRoot, canContinue: safeResume.canContinue, hasCompleteState: safeResume.hasCompleteState },
  })
}

export function recordFlightRecorderEvent(agentRoot: string, input: RecordFlightRecorderEventInput): FlightRecorderEvent {
  const event = normalizeEvent(input)
  fs.mkdirSync(eventsDir(agentRoot), { recursive: true })
  fs.appendFileSync(path.join(eventsDir(agentRoot), `${eventDay(event.recordedAt)}.jsonl`), `${JSON.stringify(event)}\n`, "utf-8")
  const latest = latestFromEvent(event, readFlightRecorderResume(agentRoot))
  writeFlightRecorderResume(agentRoot, latest)
  emitNervesEvent({
    component: "mind",
    event: "mind.flight_recorder_event_recorded",
    message: "flight recorder event recorded",
    meta: { agentRoot, eventId: event.id, kind: event.kind },
  })
  return event
}

export function isSafeHabitRunId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
    && !value.includes("..")
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isProducedRefArray(value: unknown): value is FlightRecorderProducedRef[] {
  return Array.isArray(value)
    && value.every((entry) => isPlainRecord(entry)
      && (entry.kind === "arc"
        || entry.kind === "desk_task"
        || entry.kind === "desk_record"
        || entry.kind === "claim"
        || entry.kind === "surface"
        || entry.kind === "none")
      && typeof entry.locator === "string")
}

function isHabitSurfaceAttemptArray(value: unknown): value is HabitSurfaceAttempt[] {
  return Array.isArray(value)
    && value.every((entry) => isPlainRecord(entry)
      && typeof entry.recipient === "string"
      && typeof entry.channel === "string"
      && (entry.reason === "needed_input"
        || entry.reason === "status"
        || entry.reason === "answer"
        || entry.reason === "blocked"
        || entry.reason === "other")
      && (entry.result === "sent"
        || entry.result === "delivered"
        || entry.result === "delivered_now"
        || entry.result === "queued"
        || entry.result === "deferred"
        || entry.result === "blocked"
        || entry.result === "failed"
        || entry.result === "unavailable")
      && (entry.routeKind === undefined
        || entry.routeKind === "family"
        || entry.routeKind === "originator"
        || entry.routeKind === "extra")
      && (entry.rawStatus === undefined || typeof entry.rawStatus === "string")
      && (entry.error === undefined || typeof entry.error === "string"))
}

function isHabitReturnRouteArray(value: unknown): value is HabitReturnRoute[] {
  return Array.isArray(value)
    && value.every((entry) => isPlainRecord(entry)
      && (entry.kind === "family" || entry.kind === "originator" || entry.kind === "extra")
      && typeof entry.recipient === "string"
      && (entry.status === "allowed" || entry.status === "unresolved")
      && (entry.friendId === undefined || typeof entry.friendId === "string")
      && (entry.channel === undefined || typeof entry.channel === "string")
      && (entry.key === undefined || typeof entry.key === "string")
      && (entry.reason === undefined || typeof entry.reason === "string"))
}

function isHabitPermissionEnvelope(value: unknown): value is HabitPermissionEnvelope {
  if (!isPlainRecord(value)) return false
  return value.schemaVersion === 1
    && typeof value.canMessageOutward === "boolean"
    && isHabitReturnRouteArray(value.returnRoutes)
    && isStringArray(value.deniedTools)
    && isStringArray(value.warnings)
}

function isHabitToolPolicy(value: unknown): value is HabitToolPolicy {
  if (!isPlainRecord(value)) return false
  return (value.requestedTools === null || isStringArray(value.requestedTools))
    && isStringArray(value.grantedTools)
    && isStringArray(value.deniedTools)
    && typeof value.outwardMessagingAllowed === "boolean"
}

function defaultHabitRunSummarySnapshot(receipt: {
  habitName: string
  outcome: HabitRunOutcome
  producedRefs: FlightRecorderProducedRef[]
  surfaceAttempts: HabitSurfaceAttempt[]
  errors: string[]
}): HabitRunSummarySnapshot {
  if (receipt.errors.length > 0) {
    return {
      summary: `Habit ${receipt.habitName} finished with errors: ${receipt.errors.join("; ")}`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  const surface = receipt.surfaceAttempts.find((attempt) =>
    attempt.result !== "blocked" && attempt.result !== "failed" && attempt.result !== "unavailable")
  if (surface) {
    return {
      summary: `Habit ${receipt.habitName} surfaced via ${surface.recipient}/${surface.channel}.`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  const produced = receipt.producedRefs.find((ref) => ref.kind !== "none")
  if (produced) {
    return {
      summary: `Habit ${receipt.habitName} produced ${produced.kind}: ${produced.locator}.`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  return {
    summary: `Habit ${receipt.habitName} finished with ${receipt.outcome}.`,
    decisions: [],
    nextLikelyStep: null,
  }
}

function normalizeHabitRunSummarySnapshot(
  value: unknown,
  fallback: HabitRunSummarySnapshot,
): HabitRunSummarySnapshot {
  const snapshot = isPlainRecord(value) ? value : {}
  const summary = typeof snapshot.summary === "string" && snapshot.summary.trim().length > 0
    ? snapshot.summary
    : fallback.summary
  const nextLikelyStep = snapshot.nextLikelyStep === null
    ? null
    : typeof snapshot.nextLikelyStep === "string" && snapshot.nextLikelyStep.trim().length > 0
      ? snapshot.nextLikelyStep
      : fallback.nextLikelyStep
  return {
    summary: capStructuredRecordString(summary),
    decisions: cappedArray(isStringArray(snapshot.decisions) ? snapshot.decisions : fallback.decisions),
    nextLikelyStep: nextLikelyStep === null ? null : capStructuredRecordString(nextLikelyStep),
  }
}

function isHabitRunReceipt(value: unknown): value is HabitRunReceipt {
  if (!isPlainRecord(value)) return false
  return value.schemaVersion === 2
    && isSafeHabitRunId(value.runId)
    && typeof value.sessionId === "string"
    && typeof value.habitName === "string"
    && (value.trigger === "cron"
      || value.trigger === "launchd"
      || value.trigger === "poke"
      || value.trigger === "overdue"
      || value.trigger === "manual")
    && typeof value.startedAt === "string"
    && typeof value.endedAt === "string"
    && (value.outcome === "no_change"
      || value.outcome === "wrote_arc"
      || value.outcome === "updated_desk"
      || value.outcome === "wrote_record"
      || value.outcome === "surfaced"
      || value.outcome === "blocked"
      || value.outcome === "error")
    && typeof value.definitionLocator === "string"
    && typeof value.sessionLocator === "string"
    && typeof value.pendingLocator === "string"
    && typeof value.runtimeStateLocator === "string"
    && typeof value.receiptLocator === "string"
    && (value.operationId === undefined || value.operationId === null || typeof value.operationId === "string")
    && (value.nextRunAt === null || typeof value.nextRunAt === "string")
    && isHabitPermissionEnvelope(value.permissionEnvelope)
    && isHabitToolPolicy(value.toolPolicy)
    && (value.summarySnapshot === undefined || isPlainRecord(value.summarySnapshot))
    && isProducedRefArray(value.producedRefs)
    && isHabitSurfaceAttemptArray(value.surfaceAttempts)
    && isStringArray(value.errors)
}

function isLegacyHabitRunReceipt(value: unknown): value is LegacyHabitRunReceipt {
  if (!isPlainRecord(value)) return false
  return value.schemaVersion === 1
    && isSafeHabitRunId(value.runId)
    && typeof value.habitName === "string"
    && (value.trigger === "cron"
      || value.trigger === "launchd"
      || value.trigger === "poke"
      || value.trigger === "overdue"
      || value.trigger === "manual")
    && typeof value.startedAt === "string"
    && typeof value.endedAt === "string"
    && (value.outcome === "no_change"
      || value.outcome === "wrote_arc"
      || value.outcome === "updated_desk"
      || value.outcome === "wrote_record"
      || value.outcome === "surfaced"
      || value.outcome === "blocked"
      || value.outcome === "error")
    && isProducedRefArray(value.producedRefs)
    && isHabitSurfaceAttemptArray(value.surfaceAttempts)
    && isStringArray(value.errors)
}

function warnMalformedHabitReceipt(agentRoot: string, runId: string, reason: string): void {
  emitNervesEvent({
    level: "warn",
    component: "mind",
    event: "mind.flight_recorder_habit_receipt_malformed",
    message: "flight recorder habit receipt malformed",
    meta: { agentRoot, runId: capStructuredRecordString(runId), reason },
  })
}

function normalizeLegacyHabitRunReceipt(receipt: LegacyHabitRunReceipt): HabitRunReceipt {
  const sawSurface = receipt.surfaceAttempts.length > 0 || receipt.producedRefs.some((ref) => ref.kind === "surface")
  return {
    schemaVersion: 2,
    runId: receipt.runId,
    sessionId: receipt.runId,
    habitName: receipt.habitName,
    trigger: receipt.trigger,
    startedAt: receipt.startedAt,
    endedAt: receipt.endedAt,
    outcome: receipt.outcome,
    definitionLocator: `habits/${receipt.habitName}.md`,
    sessionLocator: `state/habit-sessions/${receipt.runId}/session.json`,
    pendingLocator: `state/habit-sessions/${receipt.runId}/pending`,
    runtimeStateLocator: `state/habits/${receipt.habitName}.json`,
    receiptLocator: `arc/flight-recorder/habit-receipts/${receipt.runId}.json`,
    operationId: null,
    nextRunAt: null,
    permissionEnvelope: {
      schemaVersion: 1,
      canMessageOutward: sawSurface,
      returnRoutes: [],
      deniedTools: sawSurface ? [] : ["send_message", "surface"],
      warnings: ["legacy receipt normalized without habit permission envelope"],
    },
    toolPolicy: {
      requestedTools: null,
      grantedTools: sawSurface ? ["surface"] : [],
      deniedTools: sawSurface ? [] : ["send_message", "surface"],
      outwardMessagingAllowed: sawSurface,
    },
    summarySnapshot: defaultHabitRunSummarySnapshot(receipt),
    producedRefs: receipt.producedRefs,
    surfaceAttempts: receipt.surfaceAttempts,
    errors: receipt.errors,
  }
}

function capHabitRunReceipt(receipt: Omit<HabitRunReceipt, "summarySnapshot"> & { summarySnapshot?: HabitRunSummarySnapshot }): HabitRunReceipt {
  const fallbackSnapshot = defaultHabitRunSummarySnapshot(receipt)
  return {
    ...receipt,
    habitName: capStructuredRecordString(receipt.habitName),
    definitionLocator: capStructuredRecordString(receipt.definitionLocator),
    sessionLocator: capStructuredRecordString(receipt.sessionLocator),
    pendingLocator: capStructuredRecordString(receipt.pendingLocator),
    runtimeStateLocator: capStructuredRecordString(receipt.runtimeStateLocator),
    receiptLocator: capStructuredRecordString(receipt.receiptLocator),
    operationId: receipt.operationId ? capStructuredRecordString(receipt.operationId) : null,
    permissionEnvelope: {
      ...receipt.permissionEnvelope,
      returnRoutes: receipt.permissionEnvelope.returnRoutes.map((route) => ({
        ...route,
        recipient: capStructuredRecordString(route.recipient),
        ...(route.friendId ? { friendId: capStructuredRecordString(route.friendId) } : {}),
        ...(route.channel ? { channel: capStructuredRecordString(route.channel) } : {}),
        ...(route.key ? { key: capStructuredRecordString(route.key) } : {}),
        ...(route.reason ? { reason: capStructuredRecordString(route.reason) } : {}),
      })),
      deniedTools: cappedArray(receipt.permissionEnvelope.deniedTools),
      warnings: cappedArray(receipt.permissionEnvelope.warnings),
    },
    toolPolicy: {
      requestedTools: receipt.toolPolicy.requestedTools ? cappedArray(receipt.toolPolicy.requestedTools) : null,
      grantedTools: cappedArray(receipt.toolPolicy.grantedTools),
      deniedTools: cappedArray(receipt.toolPolicy.deniedTools),
      outwardMessagingAllowed: receipt.toolPolicy.outwardMessagingAllowed,
    },
    summarySnapshot: normalizeHabitRunSummarySnapshot(receipt.summarySnapshot, fallbackSnapshot),
    producedRefs: receipt.producedRefs.map((ref) => ({ ...ref, locator: capStructuredRecordString(ref.locator) })),
    surfaceAttempts: receipt.surfaceAttempts.map((attempt) => ({
      ...attempt,
      recipient: capStructuredRecordString(attempt.recipient),
      channel: capStructuredRecordString(attempt.channel),
      ...(attempt.rawStatus ? { rawStatus: capStructuredRecordString(attempt.rawStatus) } : {}),
      ...(attempt.error ? { error: capStructuredRecordString(attempt.error) } : {}),
    })),
    errors: receipt.errors.map((error) => capStructuredRecordString(error)),
  }
}

function normalizeHabitRunReceiptForWrite(receipt: WritableHabitRunReceipt): HabitRunReceipt {
  return capHabitRunReceipt(receipt.schemaVersion === 1 ? normalizeLegacyHabitRunReceipt(receipt) : receipt)
}

export function readHabitRunReceipt(agentRoot: string, runId: string): HabitRunReceipt | null {
  if (!isSafeHabitRunId(runId)) {
    warnMalformedHabitReceipt(agentRoot, runId, "unsafe run id")
    return null
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(habitReceiptPath(agentRoot, runId), "utf-8")) as unknown
    const receipt = isHabitRunReceipt(parsed)
      ? parsed
      : isLegacyHabitRunReceipt(parsed)
        ? normalizeLegacyHabitRunReceipt(parsed)
        : null
    if (!receipt) {
      warnMalformedHabitReceipt(agentRoot, runId, "invalid habit receipt shape")
      return null
    }
    emitNervesEvent({
      component: "mind",
      event: "mind.flight_recorder_habit_receipt_read",
      message: "flight recorder habit receipt read",
      meta: { agentRoot, runId },
    })
    return capHabitRunReceipt(receipt)
  } catch (error) {
    warnMalformedHabitReceipt(
      agentRoot,
      runId,
      error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error),
    )
    return null
  }
}

export function listHabitRunReceipts(agentRoot: string, options: { limit?: number } = {}): HabitRunReceipt[] {
  const dir = receiptsDir(agentRoot)
  if (!fs.existsSync(dir)) return []
  const receipts = fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readHabitRunReceipt(agentRoot, path.basename(fileName, ".json")))
    .filter((receipt): receipt is HabitRunReceipt => receipt !== null)
    .sort((left, right) => right.endedAt.localeCompare(left.endedAt) || right.runId.localeCompare(left.runId))
  return typeof options.limit === "number" && options.limit >= 0 ? receipts.slice(0, options.limit) : receipts
}

export function writeHabitRunReceipt(agentRoot: string, receipt: WritableHabitRunReceipt): void {
  fs.mkdirSync(receiptsDir(agentRoot), { recursive: true })
  const safeReceipt = normalizeHabitRunReceiptForWrite(receipt)
  if (!isSafeHabitRunId(safeReceipt.runId)) {
    warnMalformedHabitReceipt(agentRoot, safeReceipt.runId, "unsafe run id")
    throw new Error(`unsafe habit run id: ${safeReceipt.runId}`)
  }
  atomicWriteJson(habitReceiptPath(agentRoot, safeReceipt.runId), safeReceipt)
  recordFlightRecorderEvent(agentRoot, {
    kind: "habit_run",
    recordedAt: safeReceipt.endedAt,
    summary: `habit ${safeReceipt.habitName} finished with ${safeReceipt.outcome}`,
    producedRefs: safeReceipt.producedRefs,
    meta: {
      receiptPath: path.join("arc", "flight-recorder", "habit-receipts", `${safeReceipt.runId}.json`),
      operationId: safeReceipt.operationId ?? null,
    },
  })
  emitNervesEvent({
    component: "mind",
    event: "mind.flight_recorder_habit_receipt_written",
    message: "flight recorder habit receipt written",
    meta: { agentRoot, runId: safeReceipt.runId, habitName: safeReceipt.habitName, outcome: safeReceipt.outcome },
  })
}

export function formatFlightRecorderResume(resume: FlightRecorderResume): string {
  const lines = ["## Arc resume"]
  lines.push(`can continue: ${resume.canContinue ? "yes" : "no"}`)
  lines.push(`complete state: ${resume.hasCompleteState ? "yes" : "no"}`)
  if (resume.currentAsk.value) lines.push(`current ask: ${resume.currentAsk.value}`)
  if (resume.nextSafeAction.value) lines.push(`next safe action: ${resume.nextSafeAction.value}`)
  if (resume.nextSafeAction.stopBefore.length > 0) lines.push(`stop before: ${resume.nextSafeAction.stopBefore.join(", ")}`)
  if (resume.blockedBecause.length > 0) lines.push(`blocked: ${resume.blockedBecause.join("; ")}`)
  if (resume.missing.length > 0) lines.push(`missing: ${resume.missing.join(", ")}`)
  if (resume.gaps.length > 0) lines.push(`gaps: ${resume.gaps.join("; ")}`)
  if (resume.activeObligationIds.length > 0) lines.push(`obligations: ${resume.activeObligationIds.join(", ")}`)
  if (resume.activeReturnObligationIds.length > 0) lines.push(`return obligations: ${resume.activeReturnObligationIds.join(", ")}`)
  if (resume.activePacketIds.length > 0) lines.push(`packets: ${resume.activePacketIds.join(", ")}`)
  if (resume.unverifiedClaimIds.length > 0) lines.push(`unverified claims: ${resume.unverifiedClaimIds.join(", ")}`)
  if (resume.recorderHealth.status !== "ok") {
    lines.push(`recorder health: ${resume.recorderHealth.status} (${resume.recorderHealth.issues.join("; ")})`)
  }
  return lines.join("\n")
}

export function createHabitRunId(habitName: string, now: Date = new Date()): string {
  const safeName = habitName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "habit"
  return `${now.toISOString().replace(/[:.]/g, "-")}-${safeName}-${randomUUID().slice(0, 8)}`
}
