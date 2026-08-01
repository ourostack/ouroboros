import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import {
  HABIT_LIFECYCLE_POLL_MS,
  HABIT_LIFECYCLE_TIMEOUT_MS,
  HabitLifecycleError,
  acquireHabitLifecycleLock,
  buildHabitSendOperation,
  createHabitLifecycleJournal,
  habitLifecycleLeaseIsCurrent,
  listHabitLifecycleJournals,
  readHabitLifecycleJournal,
  releaseHabitLifecycleLock,
  transitionHabitLifecycleJournal,
  writeHabitLifecycleJournal,
  type HabitBoundaryState,
  type HabitLifecycleDeps,
  type HabitLifecycleJournal,
  type HabitLifecycleLease,
  type HabitTransportResult,
} from "../heart/habits/habit-lifecycle"
import { createDegradedHabitFile, parseHabitFile, type HabitFileStatus } from "../heart/habits/habit-parser"
import { emitNervesEvent, type NervesEvent } from "../nerves/runtime"
import type { BlueBubblesOutboundStatus } from "../senses/bluebubbles/outbound-state"
import type { RsvpSnapshot } from "./snapshot"

export const RSVP_OUTBOUND_STATE_POLICY_VERSION = "rsvp-outbound-state/v1" as const

export type RsvpBaselineAdvanceStatus = Extract<
  BlueBubblesOutboundStatus,
  "accepted" | "enqueued" | "local-visible" | "delivered"
>

export interface RsvpOutboundBaseline {
  snapshotId: string
  contentHash: string
  recordedAt: string
  reason: string
  bluebubblesRecordId?: string
  advancedBy?: RsvpBaselineAdvanceStatus
}

export interface RsvpPendingReport {
  snapshotId: string
  contentHash: string
  reportHash: string
  reportLength: number
  idempotencyKey: string
  bluebubblesRecordId: string
  status: BlueBubblesOutboundStatus
  tempGuid?: string
  messageGuid?: string
  recordedAt: string
  updatedAt: string
  contentStored: false
}

export interface RsvpOutboundState {
  schemaVersion: 1
  policyVersion: typeof RSVP_OUTBOUND_STATE_POLICY_VERSION
  updatedAt: string
  baseline?: RsvpOutboundBaseline
  pendingReports: RsvpPendingReport[]
}

export type RsvpOutboundDecision =
  | {
    action: "skip"
    reason: "baseline-current"
    currentSnapshotId: string
    idempotencyKey: string
    reportText: string
  }
  | {
    action: "send"
    currentSnapshotId: string
    idempotencyKey: string
    reportText: string
    existingPending?: RsvpPendingReport
  }

export interface RsvpBlueBubblesAttemptRecord {
  recordId: string
  status: BlueBubblesOutboundStatus
  tempGuid?: string
  messageGuid?: string
}

export interface RsvpSendBoundaryObservation extends HabitTransportResult {
  transportInvoked: boolean
}

export interface RsvpSendBoundaryResult {
  ok: boolean
  operationId: string
  boundaryState: HabitBoundaryState
  transportInvoked: boolean
  replayed: boolean
  transportResult: HabitTransportResult
  errorCode?: string
}

export interface ExecuteRsvpSendBoundaryInput {
  agentRoot: string
  habitId: string
  outboundIdempotencyKey: string
  noSend: boolean
  invokeTransport: (
    markTransportInvoked: () => void,
  ) => Promise<{ messageGuid?: string; httpStatus?: number } | null | undefined>
}

export interface RsvpSendBoundaryDeps {
  lifecycle?: HabitLifecycleDeps
  releaseLifecycleLock?: typeof releaseHabitLifecycleLock
}

const AMBIGUOUS_HTTP_STATUSES = new Set([408, 409, 425, 429])
const retainedRsvpSendLeases = new Map<string, HabitLifecycleLease>()

export function classifyRsvpSendBoundary(observation: RsvpSendBoundaryObservation): HabitBoundaryState {
  if (!observation.transportInvoked) return "not_crossed"
  const messageGuid = observation.messageGuid?.trim() ?? ""
  if (
    observation.httpStatus !== null
    && observation.httpStatus >= 200
    && observation.httpStatus <= 299
    && messageGuid.length > 0
  ) return "crossed"
  if (
    observation.httpStatus !== null
    && observation.httpStatus >= 400
    && observation.httpStatus <= 499
    && !AMBIGUOUS_HTTP_STATUSES.has(observation.httpStatus)
  ) return "not_crossed"
  return "crossing_unknown"
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function lifecycleNowIso(deps: HabitLifecycleDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

function lifecycleErrorCode(error: unknown, fallback: string): string {
  return error instanceof HabitLifecycleError ? error.code : fallback
}

function emitBoundaryTelemetry(event: NervesEvent): void {
  try {
    emitNervesEvent(event)
  } catch {
    // Observability must never mutate or obscure the durable transport boundary.
  }
}

function failedBoundaryResult(
  operationId: string,
  errorCode: string,
  options: { transportInvoked?: boolean; boundaryState?: HabitBoundaryState; replayed?: boolean } = {},
): RsvpSendBoundaryResult {
  const boundaryState = options.boundaryState ?? "not_crossed"
  return {
    ok: false,
    operationId,
    boundaryState,
    transportInvoked: options.transportInvoked ?? false,
    replayed: options.replayed ?? false,
    transportResult: {
      httpStatus: null,
      messageGuid: null,
      errorCode,
    },
    errorCode,
  }
}

function currentHabitStatus(
  agentRoot: string,
  habitId: string,
  deps: HabitLifecycleDeps,
): HabitFileStatus {
  const definitionPath = path.join(agentRoot, "habits", `${habitId}.md`)
  try {
    return parseHabitFile((deps.fs ?? fs).readFileSync(definitionPath, "utf8"), definitionPath).status
  } catch (error) {
    return createDegradedHabitFile(definitionPath, "read_error", "", String(error)).status
  }
}

function cancellationFencesSend(
  agentRoot: string,
  habitId: string,
  deps: HabitLifecycleDeps,
): boolean {
  return listHabitLifecycleJournals({ agentRoot, habitId }, deps).some((journal) => (
    journal.operationKind === "cancel" && journal.generation >= 1
  ))
}

function terminalBoundaryResult(
  journal: HabitLifecycleJournal,
  replayed: boolean,
  errorCode?: string,
): RsvpSendBoundaryResult {
  const boundaryState = journal.boundaryState!
  const transportResult = journal.transportResult!
  const failureCode = errorCode ?? transportResult.errorCode ?? undefined
  return {
    ok: boundaryState === "crossed",
    operationId: journal.operationId,
    boundaryState,
    transportInvoked: journal.transportInvokedAt !== null,
    replayed,
    transportResult,
    ...(boundaryState === "crossed" || failureCode === undefined ? {} : { errorCode: failureCode }),
  }
}

function emitBoundaryClassified(
  habitId: string,
  operationId: string,
  boundaryState: HabitBoundaryState,
  transportInvoked: boolean,
): void {
  emitBoundaryTelemetry({
    component: "rsvp",
    event: "habit_send_boundary_classified",
    message: "classified RSVP habit send boundary",
    meta: { habitId, operationId, boundaryState, transportInvoked },
  })
}

function persistBoundaryClassification(input: {
  lease: HabitLifecycleLease
  intent: HabitLifecycleJournal
  observation: RsvpSendBoundaryObservation
  transportInvokedAt: string | null
  replayed: boolean
  deps: HabitLifecycleDeps
  errorCode?: string
}): RsvpSendBoundaryResult {
  const boundaryState = classifyRsvpSendBoundary(input.observation)
  const classifiedAt = lifecycleNowIso(input.deps)
  let terminal: HabitLifecycleJournal
  let resultErrorCode = input.errorCode
  try {
    terminal = transitionHabitLifecycleJournal(input.intent, {
      state: boundaryState,
      at: classifiedAt,
      transportInvokedAt: input.observation.transportInvoked ? input.transportInvokedAt : null,
      transportResult: {
        httpStatus: input.observation.httpStatus,
        messageGuid: input.observation.messageGuid,
        errorCode: input.observation.errorCode,
      },
    })
    writeHabitLifecycleJournal(input.lease, terminal, input.deps)
  } catch {
    const fallbackError = "classification_durability_unknown"
    const fallbackBoundaryState = input.observation.transportInvoked
      ? "crossing_unknown"
      : "not_crossed"
    terminal = transitionHabitLifecycleJournal(input.intent, {
      state: fallbackBoundaryState,
      at: classifiedAt,
      transportInvokedAt: input.observation.transportInvoked
        ? input.transportInvokedAt ?? input.intent.intentAt!
        : null,
      transportResult: {
        httpStatus: input.observation.httpStatus,
        messageGuid: input.observation.messageGuid,
        errorCode: fallbackError,
      },
    })
    try {
      writeHabitLifecycleJournal(input.lease, terminal, input.deps)
    } catch {
      // The caller still reports the only safe classification when terminal durability cannot be proven.
    }
    resultErrorCode = fallbackError
  }
  emitBoundaryClassified(
    input.lease.habitId,
    input.lease.operationId,
    terminal.boundaryState!,
    terminal.transportInvokedAt !== null,
  )
  return terminalBoundaryResult(terminal, input.replayed, resultErrorCode)
}

function rsvpSendLeaseKey(agentRoot: string, habitId: string, operationId: string): string {
  return JSON.stringify([path.resolve(agentRoot), habitId, operationId])
}

async function releaseRsvpSendLease(
  leaseKey: string,
  lease: HabitLifecycleLease,
  deps: RsvpSendBoundaryDeps,
): Promise<boolean> {
  const lifecycle = deps.lifecycle ?? {}
  const release = deps.releaseLifecycleLock ?? releaseHabitLifecycleLock
  const attempts = Math.floor(HABIT_LIFECYCLE_TIMEOUT_MS / HABIT_LIFECYCLE_POLL_MS) + 1
  const wait = lifecycle.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (release(lease, lifecycle)) {
        retainedRsvpSendLeases.delete(leaseKey)
        return true
      }
    } catch {
      retainedRsvpSendLeases.set(leaseKey, lease)
      return false
    }
    if (attempt + 1 < attempts) await wait(HABIT_LIFECYCLE_POLL_MS)
  }
  retainedRsvpSendLeases.set(leaseKey, lease)
  return false
}

function transportErrorObservation(error: unknown, transportInvoked: boolean): RsvpSendBoundaryObservation {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const declaredInvoked = record.transportInvoked === true
  const httpStatus = typeof record.httpStatus === "number" && Number.isInteger(record.httpStatus)
    ? record.httpStatus
    : null
  const name = typeof record.name === "string" ? record.name : ""
  const errorCode = typeof record.errorCode === "string" && record.errorCode.trim().length > 0
    ? record.errorCode.trim()
    : name === "TimeoutError"
      ? "timeout"
      : name === "AbortError"
        ? "abort"
        : error instanceof TypeError
          ? "socket"
          : transportInvoked || declaredInvoked
            ? "transport_error"
            : "validation"
  return {
    transportInvoked: transportInvoked || declaredInvoked,
    httpStatus,
    messageGuid: null,
    errorCode,
  }
}

export async function executeRsvpSendBoundary(
  input: ExecuteRsvpSendBoundaryInput,
  deps: RsvpSendBoundaryDeps = {},
): Promise<RsvpSendBoundaryResult> {
  const lifecycle = deps.lifecycle ?? {}
  const operation = buildHabitSendOperation({
    habitId: input.habitId,
    outboundIdempotencyKey: input.outboundIdempotencyKey,
  })
  if (input.noSend) return failedBoundaryResult(operation.operationId, "immutable_no_send")

  const leaseKey = rsvpSendLeaseKey(input.agentRoot, input.habitId, operation.operationId)
  let lease = retainedRsvpSendLeases.get(leaseKey)
  try {
    if (lease && !habitLifecycleLeaseIsCurrent(lease, lifecycle)) {
      retainedRsvpSendLeases.delete(leaseKey)
      lease = undefined
    }
    if (!lease) {
      const lock = await acquireHabitLifecycleLock({
        agentRoot: input.agentRoot,
        habitId: input.habitId,
        operationId: operation.operationId,
      }, lifecycle)
      if (lock.status === "timeout") {
        return failedBoundaryResult(operation.operationId, lock.error)
      }
      lease = lock.lease
    }
  } catch (error) {
    return failedBoundaryResult(operation.operationId, lifecycleErrorCode(error, "lifecycle_lock_failed"))
  }
  const activeLease = lease
  let transportInvoked = false
  let transportInvokedAt: string | null = null
  let intent: HabitLifecycleJournal | null = null
  const markTransportInvoked = (): void => {
    if (transportInvoked) return
    transportInvoked = true
    transportInvokedAt = lifecycleNowIso(lifecycle)
    emitBoundaryTelemetry({
      component: "rsvp",
      event: "habit_transport_invoked",
      message: "invoked RSVP habit transport",
      meta: { habitId: input.habitId, operationId: operation.operationId },
    })
  }

  const boundaryResult = await (async (): Promise<RsvpSendBoundaryResult> => {
    try {
      const existing = readHabitLifecycleJournal({
        agentRoot: input.agentRoot,
        habitId: input.habitId,
        operationId: operation.operationId,
      }, lifecycle)
      if (
        existing?.state === "not_crossed"
        || existing?.state === "crossing_unknown"
        || existing?.state === "crossed"
      ) return terminalBoundaryResult(existing, true)
      if (existing?.state === "send_intent") {
        return persistBoundaryClassification({
          lease: activeLease,
          intent: existing,
          observation: {
            transportInvoked: true,
            httpStatus: null,
            messageGuid: null,
            errorCode: "recovered_unclassified_send_intent",
          },
          transportInvokedAt: existing.intentAt,
          replayed: true,
          deps: lifecycle,
          errorCode: "recovered_unclassified_send_intent",
        })
      }

      const status = currentHabitStatus(input.agentRoot, input.habitId, lifecycle)
      if (status !== "active") {
        return failedBoundaryResult(operation.operationId, `habit_status_${status}`)
      }
      if (cancellationFencesSend(input.agentRoot, input.habitId, lifecycle)) {
        return failedBoundaryResult(operation.operationId, "cancellation_pending")
      }

      intent = existing ?? createHabitLifecycleJournal({
        habitId: input.habitId,
        operationId: operation.operationId,
        operationKind: "send",
        updatedAt: lifecycleNowIso(lifecycle),
      })
      if (existing === null) writeHabitLifecycleJournal(activeLease, intent, lifecycle)
      intent = transitionHabitLifecycleJournal(intent, {
        state: "send_intent",
        at: lifecycleNowIso(lifecycle),
      })
      try {
        writeHabitLifecycleJournal(activeLease, intent, lifecycle)
      } catch (error) {
        const visible = readHabitLifecycleJournal({
          agentRoot: input.agentRoot,
          habitId: input.habitId,
          operationId: operation.operationId,
        }, lifecycle)
        if (visible?.state === "send_intent") {
          return persistBoundaryClassification({
            lease: activeLease,
            intent: visible,
            observation: {
              transportInvoked: false,
              httpStatus: null,
              messageGuid: null,
              errorCode: lifecycleErrorCode(error, "lifecycle_write_failed"),
            },
            transportInvokedAt: null,
            replayed: false,
            deps: lifecycle,
            errorCode: lifecycleErrorCode(error, "lifecycle_write_failed"),
          })
        }
        return failedBoundaryResult(
          operation.operationId,
          lifecycleErrorCode(error, "lifecycle_write_failed"),
        )
      }
      emitBoundaryTelemetry({
        component: "rsvp",
        event: "habit_send_intent",
        message: "recorded durable RSVP habit send intent",
        meta: { habitId: input.habitId, operationId: operation.operationId },
      })

      let observation: RsvpSendBoundaryObservation
      try {
        const result = await input.invokeTransport(markTransportInvoked)
        const messageGuid = result?.messageGuid?.trim() || null
        if (messageGuid !== null && !transportInvoked) markTransportInvoked()
        observation = {
          transportInvoked,
          httpStatus: typeof result?.httpStatus === "number" ? result.httpStatus : 200,
          messageGuid,
          errorCode: messageGuid === null ? "missing_message_guid" : null,
        }
      } catch (error) {
        observation = transportErrorObservation(error, transportInvoked)
        if (observation.transportInvoked && !transportInvoked) markTransportInvoked()
      }
      return persistBoundaryClassification({
        lease: activeLease,
        intent,
        observation,
        transportInvokedAt,
        replayed: false,
        deps: lifecycle,
      })
    } catch (error) {
      const errorCode = lifecycleErrorCode(error, "send_boundary_failed")
      return failedBoundaryResult(operation.operationId, errorCode, {
        transportInvoked,
        boundaryState: transportInvoked ? "crossing_unknown" : "not_crossed",
      })
    }
  })()

  let released = false
  try {
    released = await releaseRsvpSendLease(leaseKey, activeLease, deps)
  } catch {
    retainedRsvpSendLeases.set(leaseKey, activeLease)
  }
  if (!released) {
    return {
      ...boundaryResult,
      ok: false,
      errorCode: "lifecycle_lock_release_failed",
    }
  }
  return boundaryResult
}

function hashString(input: string): string {
  return `sha256:${sha256Hex(input)}`
}

function rsvpOutboundStatePath(agentRoot: string): string {
  return path.join(agentRoot, "state", "rsvp", "outbound-state.json")
}

function emptyState(now: string): RsvpOutboundState {
  return {
    schemaVersion: 1,
    policyVersion: RSVP_OUTBOUND_STATE_POLICY_VERSION,
    updatedAt: now,
    pendingReports: [],
  }
}

function nowIso(input?: string): string {
  return input ?? new Date().toISOString()
}

function reportHash(reportText: string): string {
  return hashString(reportText.trim().replace(/\s+/g, " "))
}

function idempotencyKeyFor(snapshot: RsvpSnapshot, reportText: string): string {
  return [
    "rsvp-report",
    snapshot.agent,
    snapshot.source.weddingId,
    snapshot.source.eventId,
    snapshot.snapshotId,
    reportHash(reportText).slice("sha256:".length, "sha256:".length + 16),
  ].join(":")
}

function isBaseline(value: unknown): value is RsvpOutboundBaseline {
  const row = value as Partial<RsvpOutboundBaseline> | null
  return !!row
    && typeof row.snapshotId === "string"
    && typeof row.contentHash === "string"
    && typeof row.recordedAt === "string"
    && typeof row.reason === "string"
}

function isPending(value: unknown): value is RsvpPendingReport {
  const row = value as Partial<RsvpPendingReport> | null
  return !!row
    && typeof row.snapshotId === "string"
    && typeof row.contentHash === "string"
    && typeof row.reportHash === "string"
    && typeof row.reportLength === "number"
    && typeof row.idempotencyKey === "string"
    && typeof row.bluebubblesRecordId === "string"
    && typeof row.status === "string"
    && typeof row.recordedAt === "string"
    && typeof row.updatedAt === "string"
    && row.contentStored === false
}

function isState(value: unknown): value is RsvpOutboundState {
  const row = value as Partial<RsvpOutboundState> | null
  return !!row
    && row.schemaVersion === 1
    && row.policyVersion === RSVP_OUTBOUND_STATE_POLICY_VERSION
    && typeof row.updatedAt === "string"
    && (row.baseline === undefined || isBaseline(row.baseline))
    && Array.isArray(row.pendingReports)
}

export function readRsvpOutboundState(agentRoot: string): RsvpOutboundState {
  const filePath = rsvpOutboundStatePath(agentRoot)
  if (!fs.existsSync(filePath)) return emptyState(new Date().toISOString())
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
    if (!isState(parsed)) return emptyState(new Date().toISOString())
    return {
      schemaVersion: 1,
      policyVersion: RSVP_OUTBOUND_STATE_POLICY_VERSION,
      updatedAt: parsed.updatedAt,
      ...(parsed.baseline ? { baseline: parsed.baseline } : {}),
      pendingReports: parsed.pendingReports.filter(isPending),
    }
  } catch {
    return emptyState(new Date().toISOString())
  }
}

function writeState(agentRoot: string, state: RsvpOutboundState): RsvpOutboundState {
  const filePath = rsvpOutboundStatePath(agentRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
  fs.renameSync(tmp, filePath)
  return state
}

export function ensureRsvpOutboundState(agentRoot: string, now: string = new Date().toISOString()): RsvpOutboundState {
  const filePath = rsvpOutboundStatePath(agentRoot)
  if (fs.existsSync(filePath)) return readRsvpOutboundState(agentRoot)
  const state = writeState(agentRoot, emptyState(now))
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.outbound_state_initialized",
    message: "initialized RSVP outbound state",
    meta: { updatedAt: state.updatedAt },
  })
  return state
}

export function writeRsvpBaseline(input: {
  agentRoot: string
  snapshot: RsvpSnapshot
  recordedAt: string
  reason: string
}): RsvpOutboundState {
  const current = readRsvpOutboundState(input.agentRoot)
  const state = writeState(input.agentRoot, {
    schemaVersion: 1,
    policyVersion: RSVP_OUTBOUND_STATE_POLICY_VERSION,
    updatedAt: input.recordedAt,
    baseline: {
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      recordedAt: input.recordedAt,
      reason: input.reason,
    },
    pendingReports: current.pendingReports.filter((entry) => entry.snapshotId !== input.snapshot.snapshotId),
  })
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.outbound_baseline_written",
    message: "wrote RSVP outbound baseline",
    meta: { snapshotId: input.snapshot.snapshotId, reason: input.reason },
  })
  return state
}

export function decideRsvpOutboundReport(input: {
  agentRoot: string
  currentSnapshot: RsvpSnapshot
  reportText: string
  now?: string
}): RsvpOutboundDecision {
  const state = readRsvpOutboundState(input.agentRoot)
  const idempotencyKey = idempotencyKeyFor(input.currentSnapshot, input.reportText)
  const currentSnapshotId = input.currentSnapshot.snapshotId
  const report = reportHash(input.reportText)
  if (
    state.baseline?.snapshotId === currentSnapshotId
    && state.baseline.contentHash === input.currentSnapshot.contentHash
  ) {
    emitNervesEvent({
      component: "rsvp",
      event: "rsvp.outbound_decision",
      message: "decided RSVP report outbound action",
      meta: { action: "skip", snapshotId: currentSnapshotId },
    })
    return {
      action: "skip",
      reason: "baseline-current",
      currentSnapshotId,
      idempotencyKey,
      reportText: input.reportText,
    }
  }
  const existingPending = state.pendingReports.find((entry) =>
    entry.snapshotId === currentSnapshotId && entry.reportHash === report,
  )
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.outbound_decision",
    message: "decided RSVP report outbound action",
    meta: { action: "send", snapshotId: currentSnapshotId, existingPending: Boolean(existingPending), now: nowIso(input.now) },
  })
  return {
    action: "send",
    currentSnapshotId,
    idempotencyKey,
    reportText: input.reportText,
    ...(existingPending ? { existingPending } : {}),
  }
}

function isAdvanceStatus(status: BlueBubblesOutboundStatus): status is RsvpBaselineAdvanceStatus {
  return status === "accepted" || status === "enqueued" || status === "local-visible" || status === "delivered"
}

function pendingReportFor(input: {
  currentSnapshot: RsvpSnapshot
  reportText: string
  bluebubblesRecord: RsvpBlueBubblesAttemptRecord
  recordedAt: string
}): RsvpPendingReport {
  const normalized = input.reportText.trim().replace(/\s+/g, " ")
  return {
    snapshotId: input.currentSnapshot.snapshotId,
    contentHash: input.currentSnapshot.contentHash,
    reportHash: reportHash(input.reportText),
    reportLength: normalized.length,
    idempotencyKey: idempotencyKeyFor(input.currentSnapshot, input.reportText),
    bluebubblesRecordId: input.bluebubblesRecord.recordId,
    status: input.bluebubblesRecord.status,
    ...(input.bluebubblesRecord.tempGuid?.trim() ? { tempGuid: input.bluebubblesRecord.tempGuid.trim() } : {}),
    ...(input.bluebubblesRecord.messageGuid?.trim() ? { messageGuid: input.bluebubblesRecord.messageGuid.trim() } : {}),
    recordedAt: input.recordedAt,
    updatedAt: input.recordedAt,
    contentStored: false,
  }
}

export function recordRsvpOutboundAttempt(input: {
  agentRoot: string
  currentSnapshot: RsvpSnapshot
  reportText: string
  bluebubblesRecord: RsvpBlueBubblesAttemptRecord
  recordedAt: string
}): RsvpOutboundState {
  const current = readRsvpOutboundState(input.agentRoot)
  const pending = pendingReportFor(input)
  const remainingPending = current.pendingReports.filter((entry) =>
    entry.snapshotId !== pending.snapshotId || entry.reportHash !== pending.reportHash,
  )
  const state = isAdvanceStatus(input.bluebubblesRecord.status)
    ? writeState(input.agentRoot, {
        schemaVersion: 1,
        policyVersion: RSVP_OUTBOUND_STATE_POLICY_VERSION,
        updatedAt: input.recordedAt,
        baseline: {
          snapshotId: input.currentSnapshot.snapshotId,
          contentHash: input.currentSnapshot.contentHash,
          recordedAt: input.recordedAt,
          reason: "bluebubbles-outbound-accepted",
          bluebubblesRecordId: input.bluebubblesRecord.recordId,
          advancedBy: input.bluebubblesRecord.status,
        },
        pendingReports: remainingPending,
      })
    : writeState(input.agentRoot, {
        schemaVersion: 1,
        policyVersion: RSVP_OUTBOUND_STATE_POLICY_VERSION,
        updatedAt: input.recordedAt,
        ...(current.baseline ? { baseline: current.baseline } : {}),
        pendingReports: [...remainingPending, pending],
      })

  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.outbound_attempt_recorded",
    message: "recorded RSVP outbound attempt",
    meta: {
      snapshotId: input.currentSnapshot.snapshotId,
      bluebubblesRecordId: input.bluebubblesRecord.recordId,
      status: input.bluebubblesRecord.status,
      baselineAdvanced: isAdvanceStatus(input.bluebubblesRecord.status),
    },
  })
  return state
}
