import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

import type { RsvpCliCommand, OuroCliDeps } from "../heart/daemon/cli-types"
import { createDegradedHabitFile, parseHabitFile, type HabitFile } from "../heart/habits/habit-parser"
import { applyHabitRuntimeState } from "../heart/habits/habit-runtime-state"
import { completeHabitRun } from "../heart/habits/habit-session"
import { appendRunLedgerRecordNonFatal, createRunLedgerRecord, usageMetadataFromUsageData, type RunLedgerLifecycle } from "../heart/run-ledger"
import { recordRsvpSpendLedgerRun } from "./spend-ledger"
import { RSVP_HABIT_ALLOWED_TOOLS, rsvpHabitRuntimePolicy, type RsvpHabitMetadata } from "./habit-policy"
import { emitNervesEvent } from "../nerves/runtime"
import {
  decisionsFromHabitRunTraceSteps,
  type FlightRecorderProducedRef,
  type HabitPermissionEnvelope,
  type HabitRunTraceStep,
  type HabitRunTrigger,
  type HabitSurfaceAttempt,
  type HabitToolPolicy,
} from "../arc/flight-recorder"

type RsvpRefreshCommand = Extract<RsvpCliCommand, { kind: "rsvp.refresh" }>

export type RsvpRefreshRunner = (command: RsvpRefreshCommand, deps: OuroCliDeps) => Promise<string>

export interface RunNativeRsvpHabitInput {
  agent: string
  bundlesRoot: string
  habitName: string
  trigger: HabitRunTrigger
  occurrenceId?: string
  noSend?: true
  now?: () => string | Date
  runRefresh?: RsvpRefreshRunner
}

export interface RunNativeRsvpHabitResult {
  ok: boolean
  message: string
  lifecycle: Extract<RunLedgerLifecycle, "completed" | "error">
  runId: string
  payload?: Record<string, unknown>
}

type ExecutableRsvpHabit = HabitFile & { status: "active"; rsvp: RsvpHabitMetadata }

interface NativeRsvpHabitRejection {
  kind: "rejected"
  habit: HabitFile
  errorCode: string
  message: string
}

type NativeRsvpHabitResolution =
  | { kind: "ready"; habit: ExecutableRsvpHabit }
  | NativeRsvpHabitRejection

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function nowIso(now: (() => string | Date) | undefined): string {
  const value = now ? now() : new Date()
  return value instanceof Date ? value.toISOString() : value
}

function nativeRunId(input: RunNativeRsvpHabitInput): string {
  const digest = sha256Hex(JSON.stringify({
    agent: input.agent,
    habitName: input.habitName,
    trigger: input.trigger,
    occurrenceId: input.occurrenceId ?? null,
  })).slice(0, 24)
  return `rsvp-${input.trigger}-${digest}`
}

function rejectionErrorCode(habit: HabitFile): string {
  return habit.status === "degraded"
    ? `habit_${habit.degradedReason}`
    : `habit_status_${habit.status}`
}

function rejectionMessage(habitName: string, habit: HabitFile): string {
  const reason = habit.status === "degraded" ? ` reason=${habit.degradedReason}` : ""
  return `native RSVP habit ${habitName} rejected by lifecycle: status=${habit.status}${reason}`
}

function resolveNativeRsvpHabit(agentRoot: string, habitPath: string, habitName: string): NativeRsvpHabitResolution {
  let habit: HabitFile
  if (!fs.existsSync(habitPath)) {
    habit = createDegradedHabitFile(habitPath, "read_error", "", "habit file not found")
  } else {
    try {
      habit = applyHabitRuntimeState(agentRoot, parseHabitFile(fs.readFileSync(habitPath, "utf-8"), habitPath))
    } catch (error) {
      habit = createDegradedHabitFile(
        habitPath,
        "read_error",
        "",
        String(error),
      )
    }
  }

  if (habit.status !== "active") {
    return {
      kind: "rejected",
      habit,
      errorCode: rejectionErrorCode(habit),
      message: rejectionMessage(habitName, habit),
    }
  }
  if (!habit.rsvp) {
    const degraded = createDegradedHabitFile(
      habitPath,
      "invalid_metadata",
      habit.body,
      "RSVP habit metadata is required",
    )
    return {
      kind: "rejected",
      habit: degraded,
      errorCode: rejectionErrorCode(degraded),
      message: rejectionMessage(habitName, degraded),
    }
  }
  return { kind: "ready", habit: habit as ExecutableRsvpHabit }
}

function noopCliDeps(input: RunNativeRsvpHabitInput, agentRoot: string): OuroCliDeps {
  return {
    socketPath: "",
    sendCommand: async () => ({ ok: false, error: "daemon socket unavailable in native RSVP habit runner" }),
    startDaemonProcess: async () => ({ pid: null }),
    writeStdout: () => undefined,
    checkSocketAlive: async () => false,
    cleanupStaleSocket: () => undefined,
    fallbackPendingMessage: () => "daemon socket unavailable in native RSVP habit runner",
    bundlesRoot: input.bundlesRoot,
    agentBundleRoot: agentRoot,
  }
}

async function defaultRunRefresh(command: RsvpRefreshCommand, deps: OuroCliDeps): Promise<string> {
  const { runRsvpCliCommand } = await import("./cli")
  return runRsvpCliCommand(command, deps)
}

function parseRefreshPayload(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RSVP refresh returned a non-object payload")
  }
  return parsed as Record<string, unknown>
}

function refreshCommandFor(input: RunNativeRsvpHabitInput, sendAllowed: boolean, mode: "shadow" | "live"): RsvpRefreshCommand {
  return {
    kind: "rsvp.refresh",
    agent: input.agent,
    habitName: input.habitName,
    mode,
    json: true,
    ...(sendAllowed ? { allowSend: true } : {}),
    ...(input.noSend || !sendAllowed ? { noSend: true } : {}),
  }
}

function permissionEnvelope(sendAllowed: boolean): HabitPermissionEnvelope {
  return {
    schemaVersion: 1,
    canMessageOutward: sendAllowed,
    returnRoutes: sendAllowed
      ? [{ kind: "family", recipient: "family", status: "allowed" }]
      : [],
    deniedTools: sendAllowed ? [] : ["send_message", "surface"],
    warnings: [],
  }
}

function toolPolicy(sendAllowed: boolean): HabitToolPolicy {
  return {
    requestedTools: [...RSVP_HABIT_ALLOWED_TOOLS],
    grantedTools: [...RSVP_HABIT_ALLOWED_TOOLS],
    deniedTools: [],
    outwardMessagingAllowed: sendAllowed,
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function refreshRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const value = payload.refresh
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function producedRefsFor(payload: Record<string, unknown>): FlightRecorderProducedRef[] {
  if (payload.sendAllowed === true) return []
  const snapshotId = stringField(refreshRecord(payload) ?? {}, "snapshotId")
  return snapshotId ? [{ kind: "none", locator: `state/rsvp/snapshots/${snapshotId}.json` }] : []
}

function outboundAction(payload: Record<string, unknown>): string {
  const refresh = refreshRecord(payload)
  const decision = refresh?.outboundDecision
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return "unknown"
  return stringField(decision as Record<string, unknown>, "action") ?? "unknown"
}

function surfaceAttemptsFor(payload: Record<string, unknown>, requestedSend: boolean, errorMessage: string | null): HabitSurfaceAttempt[] {
  if (payload.sendAllowed === true) {
    const delivery = (refreshRecord(payload)?.delivery ?? {}) as Record<string, unknown>
    const rawStatus = stringField(delivery, "status") ?? stringField(delivery, "result")
    if (rawStatus === "failed" || rawStatus === "error") {
      return [{
        recipient: "rsvp",
        channel: "bluebubbles",
        reason: "status",
        result: "failed",
        rawStatus,
        error: stringField(delivery, "error") ?? stringField(delivery, "message") ?? rawStatus,
      }]
    }
    return [{
      recipient: "rsvp",
      channel: "bluebubbles",
      reason: "status",
      result: "sent",
      ...(rawStatus ? { rawStatus } : {}),
    }]
  }
  if (requestedSend && errorMessage) {
    return [{
      recipient: "rsvp",
      channel: "bluebubbles",
      reason: "blocked",
      result: "blocked",
      error: errorMessage,
    }]
  }
  return []
}

function payloadError(payload: Record<string, unknown>): string | null {
  if (payload.ok === false || typeof payload.requires === "string") {
    return stringField(payload, "message") ?? "RSVP refresh did not complete"
  }
  return null
}

function traceStatusForSurfaceAttempt(attempt: HabitSurfaceAttempt | undefined): HabitRunTraceStep["status"] {
  if (!attempt) return "skipped"
  if (attempt.result === "failed") return "failed"
  if (attempt.result === "blocked" || attempt.result === "unavailable") return "blocked"
  return "succeeded"
}

function nativeRsvpTraceSteps(input: {
  habitName: string
  trigger: HabitRunTrigger
  mode: "shadow" | "live"
  source: string
  sendAllowed: boolean
  startedAt: string
  endedAt: string
  payload: Record<string, unknown>
  producedRefs: FlightRecorderProducedRef[]
  surfaceAttempts: HabitSurfaceAttempt[]
  errors: string[]
  lifecycle: Extract<RunLedgerLifecycle, "completed" | "error">
}): HabitRunTraceStep[] {
  const refresh = refreshRecord(input.payload)
  const snapshotId = stringField(refresh ?? {}, "snapshotId")
  const reportText = stringField(refresh ?? {}, "reportText")
  const action = outboundAction(input.payload)
  const firstAttempt = input.surfaceAttempts[0]
  const snapshotLocator = snapshotId ? `state/rsvp/snapshots/${snapshotId}.json` : null
  const decisions = [
    `mode=${input.mode}`,
    `sendAllowed=${String(input.sendAllowed)}`,
    `outboundAction=${action}`,
  ]
  return [
    {
      schemaVersion: 1,
      stepId: "trigger",
      kind: "trigger",
      status: "succeeded",
      at: input.startedAt,
      summary: `${input.trigger} triggered ${input.habitName}.`,
    },
    {
      schemaVersion: 1,
      stepId: "habit-definition",
      kind: "habit_definition",
      status: "succeeded",
      at: input.startedAt,
      summary: `Loaded habit definition for ${input.habitName}.`,
      refs: [{ kind: "habit_definition", locator: `habits/${input.habitName}.md`, label: input.habitName }],
    },
    {
      schemaVersion: 1,
      stepId: "fetch-refresh",
      kind: "fetch",
      status: input.errors.length > 0 ? "failed" : "succeeded",
      at: input.endedAt,
      summary: `Ran RSVP refresh in ${input.mode} mode.`,
      refs: [{ kind: "source", locator: `rsvp/${input.source}` }],
    },
    {
      schemaVersion: 1,
      stepId: "snapshot",
      kind: "snapshot",
      status: snapshotLocator ? "succeeded" : "skipped",
      at: input.endedAt,
      summary: snapshotLocator ? "Recorded the RSVP snapshot reference." : "No RSVP snapshot reference was returned.",
      ...(snapshotLocator ? { refs: [{ kind: "snapshot", locator: snapshotLocator }] } : {}),
    },
    {
      schemaVersion: 1,
      stepId: "render",
      kind: "render",
      status: reportText ? "succeeded" : "skipped",
      at: input.endedAt,
      summary: reportText ? "Rendered RSVP update text." : "No rendered RSVP update text was returned.",
    },
    {
      schemaVersion: 1,
      stepId: "decision",
      kind: "decision",
      status: input.errors.length > 0 ? "blocked" : "succeeded",
      at: input.endedAt,
      summary: `RSVP outbound decision: ${action}.`,
      decisions,
    },
    {
      schemaVersion: 1,
      stepId: "produced-ref",
      kind: "produced_ref",
      status: input.producedRefs.length > 0 ? "succeeded" : "skipped",
      at: input.endedAt,
      summary: input.producedRefs.length > 0 ? "Recorded produced RSVP refs." : "No separate produced refs were recorded.",
      ...(input.producedRefs.length > 0 ? { producedRefs: input.producedRefs } : {}),
    },
    {
      schemaVersion: 1,
      stepId: "surface-attempt",
      kind: "surface_attempt",
      status: traceStatusForSurfaceAttempt(firstAttempt),
      at: input.endedAt,
      summary: firstAttempt ? `Surface attempt ${firstAttempt.result} via ${firstAttempt.channel}.` : "No surface attempt was needed.",
      ...(firstAttempt ? { surfaceAttempt: firstAttempt } : {}),
    },
    {
      schemaVersion: 1,
      stepId: "send",
      kind: "send",
      status: input.sendAllowed
        ? traceStatusForSurfaceAttempt(firstAttempt)
        : "skipped",
      at: input.endedAt,
      summary: input.sendAllowed ? "Live send was allowed for this run." : "Live send was not allowed for this run.",
      ...(firstAttempt ? { surfaceAttempt: firstAttempt } : {}),
    },
    {
      schemaVersion: 1,
      stepId: "ledger",
      kind: "ledger",
      status: "succeeded",
      at: input.endedAt,
      summary: "Recorded native RSVP run ledger evidence.",
      refs: [
        { kind: "ledger", locator: "state/run-ledger/runs.jsonl" },
        { kind: "ledger", locator: "state/rsvp/spend-ledger.json" },
      ],
    },
    {
      schemaVersion: 1,
      stepId: "error",
      kind: "error",
      status: input.errors.length > 0 ? "failed" : "skipped",
      at: input.endedAt,
      summary: input.errors.length > 0 ? "RSVP refresh returned an error." : "No RSVP error happened.",
      ...(input.errors[0] ? { error: input.errors[0] } : {}),
    },
    {
      schemaVersion: 1,
      stepId: "complete",
      kind: "complete",
      status: input.lifecycle === "completed" ? "succeeded" : "failed",
      at: input.endedAt,
      summary: `Native RSVP habit ${input.lifecycle}.`,
    },
  ]
}

function recordNativeRunLedger(input: {
  agentRoot: string
  agent: string
  habitName: string
  runId: string
  trigger: HabitRunTrigger
  occurrenceId?: string
  startedAt: string
  lifecycle: RunLedgerLifecycle
  endedAt?: string
  errorName?: string
  errorCode?: string
}): void {
  const target = {
    habitName: input.habitName,
    runId: input.runId,
    trigger: input.trigger,
    occurrenceId: input.occurrenceId ?? null,
    command: "rsvp.refresh",
  }
  const record = createRunLedgerRecord({
    agent: input.agent,
    triggerType: "habit",
    sourceKind: "daemon",
    senseOrHabit: input.habitName,
    lifecycle: input.lifecycle,
    startedAt: input.startedAt,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    ...(input.lifecycle === "completed" || input.lifecycle === "error"
      ? { usage: usageMetadataFromUsageData(undefined, "none") }
      : {}),
    ...(input.errorName ? { errorName: input.errorName } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    target,
    idempotencyScope: target,
    sessionRef: {
      channel: "rsvp",
      keyHash: `sha256:${sha256Hex(input.runId)}`,
    },
  })
  appendRunLedgerRecordNonFatal(input.agentRoot, record)
  try {
    recordRsvpSpendLedgerRun(input.agentRoot, record)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "rsvp",
      event: "rsvp.native_habit_spend_ledger_error",
      message: "failed to record native RSVP habit spend ledger row",
      meta: { runId: input.runId, lifecycle: input.lifecycle, error: String(error) },
    })
  }
}

export async function runNativeRsvpHabit(input: RunNativeRsvpHabitInput): Promise<RunNativeRsvpHabitResult> {
  const agentRoot = path.join(input.bundlesRoot, `${input.agent}.ouro`)
  const habitPath = path.join(agentRoot, "habits", `${input.habitName}.md`)
  const startedAt = nowIso(input.now)
  const runId = nativeRunId(input)

  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.native_habit_start",
    message: "native RSVP habit starting",
    meta: {
      agent: input.agent,
      habitName: input.habitName,
      trigger: input.trigger,
      occurrenceId: input.occurrenceId ?? null,
      runId,
    },
  })

  recordNativeRunLedger({
    agentRoot,
    agent: input.agent,
    habitName: input.habitName,
    runId,
    trigger: input.trigger,
    occurrenceId: input.occurrenceId,
    startedAt,
    lifecycle: "started",
  })

  const resolution = resolveNativeRsvpHabit(agentRoot, habitPath, input.habitName)
  if (resolution.kind === "rejected") {
    const endedAt = nowIso(input.now)
    const degradedReason = resolution.habit.status === "degraded"
      ? resolution.habit.degradedReason
      : null
    const degradedDetail = resolution.habit.status === "degraded"
      ? resolution.habit.degradedDetail
      : null
    const payload = {
      ok: false,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: input.agent,
      requires: "active RSVP habit",
      message: resolution.message,
      status: resolution.habit.status,
      degradedReason,
      degradedDetail,
    }
    recordNativeRunLedger({
      agentRoot,
      agent: input.agent,
      habitName: input.habitName,
      runId,
      trigger: input.trigger,
      occurrenceId: input.occurrenceId,
      startedAt,
      endedAt,
      lifecycle: "error",
      errorName: "HabitLifecycleRejected",
      errorCode: resolution.errorCode,
    })
    const rejectionMeta = {
      entryPoint: "native_runner",
      agent: input.agent,
      habitName: input.habitName,
      trigger: input.trigger,
      occurrenceId: input.occurrenceId ?? null,
      runId,
      status: resolution.habit.status,
      degradedReason,
      degradedDetail,
      errorCode: resolution.errorCode,
    }
    emitNervesEvent({
      level: "warn",
      component: "rsvp",
      event: "rsvp.habit_lifecycle_rejected",
      message: resolution.message,
      meta: rejectionMeta,
    })
    emitNervesEvent({
      level: "error",
      component: "rsvp",
      event: "rsvp.native_habit_error",
      message: resolution.message,
      meta: {
        ...rejectionMeta,
        lifecycle: "error",
        receiptWritten: false,
        runtimeStateRecorded: false,
      },
    })
    return {
      ok: false,
      message: resolution.message,
      lifecycle: "error",
      runId,
      payload,
    }
  }

  const habit = resolution.habit
  const policy = rsvpHabitRuntimePolicy(habit.rsvp)
  const effectiveSendAllowed = policy.sendAllowed && input.noSend !== true
  const command = refreshCommandFor(input, policy.sendAllowed, habit.rsvp.mode)
  const deps = noopCliDeps(input, agentRoot)

  let payload: Record<string, unknown>
  let errorMessage: string | null = null
  try {
    payload = parseRefreshPayload(await (input.runRefresh ?? defaultRunRefresh)(command, deps))
    payload = { ...payload, status: habit.status }
    errorMessage = payloadError(payload)
    if (
      input.noSend === true
      && (
        payload.noSend !== true
        || payload.transportInvocationCount !== 0
        || payload.sendAllowed === true
        || payload.sideEffect === true
      )
    ) {
      errorMessage = "RSVP refresh violated the immutable no-send result contract"
      payload = {
        ...payload,
        ok: false,
        status: habit.status,
        message: errorMessage,
      }
    }
  } catch (error) {
    payload = {
      ok: false,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: input.agent,
      mode: habit.rsvp.mode,
      status: habit.status,
      message: error instanceof Error ? error.message : String(error),
    }
    errorMessage = stringField(payload, "message") ?? "RSVP refresh failed"
  }

  const endedAt = nowIso(input.now)
  const lifecycle: Extract<RunLedgerLifecycle, "completed" | "error"> = errorMessage ? "error" : "completed"
  const surfaceAttempts = surfaceAttemptsFor(payload, effectiveSendAllowed, errorMessage)
  const errors = errorMessage ? [errorMessage] : []
  const producedRefs = producedRefsFor(payload)

  recordNativeRunLedger({
    agentRoot,
    agent: input.agent,
    habitName: input.habitName,
    runId,
    trigger: input.trigger,
    occurrenceId: input.occurrenceId,
    startedAt,
    endedAt,
    lifecycle,
  })

  const traceSteps = nativeRsvpTraceSteps({
    habitName: input.habitName,
    trigger: input.trigger,
    mode: habit.rsvp.mode,
    source: habit.rsvp.source,
    sendAllowed: effectiveSendAllowed,
    startedAt,
    endedAt,
    payload,
    producedRefs,
    surfaceAttempts,
    errors,
    lifecycle,
  })

  const completion = completeHabitRun({
    agentRoot,
    habit,
    runId,
    trigger: input.trigger,
    startedAt,
    endedAt,
    operationId: `rsvp-native:${input.trigger}:${input.occurrenceId ?? runId}`,
    permissionEnvelope: permissionEnvelope(effectiveSendAllowed),
    toolPolicy: toolPolicy(effectiveSendAllowed),
    producedRefs,
    surfaceAttempts,
    traceSteps,
    errors,
    summarySnapshot: {
      summary: errorMessage
        ? `Native RSVP habit failed: ${errorMessage}`
        : "Native RSVP habit completed.",
      decisions: decisionsFromHabitRunTraceSteps(traceSteps),
      nextLikelyStep: null,
    },
  })

  const ok = lifecycle === "completed" && completion.receiptWritten && completion.runtimeStateRecorded
  const message = ok
    ? `native RSVP habit ${input.habitName} completed for ${input.agent}`
    : `native RSVP habit ${input.habitName} failed for ${input.agent}: ${errorMessage ?? "runtime state was not recorded"}`

  const terminalEventMeta = {
    agent: input.agent,
    habitName: input.habitName,
    trigger: input.trigger,
    runId,
    lifecycle,
    receiptWritten: completion.receiptWritten,
    runtimeStateRecorded: completion.runtimeStateRecorded,
  }
  if (lifecycle === "completed") {
    emitNervesEvent({
      component: "rsvp",
      event: "rsvp.native_habit_end",
      message,
      meta: terminalEventMeta,
    })
  } else {
    emitNervesEvent({
      level: "error",
      component: "rsvp",
      event: "rsvp.native_habit_error",
      message,
      meta: terminalEventMeta,
    })
  }

  return {
    ok,
    message,
    lifecycle,
    runId,
    payload,
  }
}
