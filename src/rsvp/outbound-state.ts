import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
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

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
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
