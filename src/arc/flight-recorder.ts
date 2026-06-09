import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import { capStructuredRecordString, capStructuredRecordStringLeaves } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"

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

export interface HabitSurfaceAttempt {
  recipient: string
  channel: string
  reason: "needed_input" | "status" | "answer" | "blocked" | "other"
  result: "sent" | "queued" | "blocked" | "failed"
}

export interface HabitRunReceipt {
  schemaVersion: 1
  runId: string
  habitName: string
  trigger: "cron" | "launchd" | "poke" | "overdue" | "manual"
  startedAt: string
  endedAt: string
  outcome: "no_change" | "wrote_arc" | "updated_desk" | "wrote_record" | "surfaced" | "blocked" | "error"
  producedRefs: FlightRecorderProducedRef[]
  surfaceAttempts: HabitSurfaceAttempt[]
  errors: string[]
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

function isResumeCandidate(value: unknown): value is FlightRecorderResume {
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
    ...(resume.canContinue && !resume.hasCompleteState ? ["canContinue true while hasCompleteState false"] : []),
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

function latestFromEvent(event: FlightRecorderEvent, previous: FlightRecorderResume): FlightRecorderResume {
  const currentAskValue = event.currentAsk !== undefined ? event.currentAsk : previous.currentAsk.value
  const nextSafeActionValue = event.nextSafeAction !== undefined ? event.nextSafeAction : previous.nextSafeAction.value
  const currentAskSourceEventIds = event.currentAsk !== undefined ? [event.id] : previous.currentAsk.sourceEventIds
  const nextSafeActionSourceEventIds = event.nextSafeAction !== undefined ? [event.id] : previous.nextSafeAction.sourceEventIds
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
      sourceEventIds: [event.id],
    },
    recorderHealth: { status: "ok", issues: [] },
  }
}

export function readFlightRecorderResume(agentRoot: string): FlightRecorderResume {
  const latestPath = flightRecorderLatestPath(agentRoot)
  try {
    const parsed = JSON.parse(fs.readFileSync(latestPath, "utf-8")) as unknown
    if (!isResumeCandidate(parsed)) {
      throw new Error("latest.json has invalid flight-recorder resume shape")
    }
    const resume = normalizeResumeInvariants(parsed)
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
  const safeResume = normalizeResumeInvariants(resume)
  atomicWriteJson(flightRecorderLatestPath(agentRoot), safeResume)
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

export function writeHabitRunReceipt(agentRoot: string, receipt: HabitRunReceipt): void {
  fs.mkdirSync(receiptsDir(agentRoot), { recursive: true })
  const safeReceipt: HabitRunReceipt = {
    ...receipt,
    habitName: capStructuredRecordString(receipt.habitName),
    producedRefs: receipt.producedRefs.map((ref) => ({ ...ref, locator: capStructuredRecordString(ref.locator) })),
    surfaceAttempts: receipt.surfaceAttempts.map((attempt) => ({
      ...attempt,
      recipient: capStructuredRecordString(attempt.recipient),
      channel: capStructuredRecordString(attempt.channel),
    })),
    errors: receipt.errors.map((error) => capStructuredRecordString(error)),
  }
  atomicWriteJson(path.join(receiptsDir(agentRoot), `${safeReceipt.runId}.json`), safeReceipt)
  recordFlightRecorderEvent(agentRoot, {
    kind: "habit_run",
    recordedAt: safeReceipt.endedAt,
    summary: `habit ${safeReceipt.habitName} finished with ${safeReceipt.outcome}`,
    producedRefs: safeReceipt.producedRefs,
    meta: { receiptPath: path.join("arc", "flight-recorder", "habit-receipts", `${safeReceipt.runId}.json`) },
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
