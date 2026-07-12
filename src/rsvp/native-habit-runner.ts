import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

import type { RsvpCliCommand, OuroCliDeps } from "../heart/daemon/cli-types"
import { parseHabitFile } from "../heart/habits/habit-parser"
import { applyHabitRuntimeState } from "../heart/habits/habit-runtime-state"
import { completeHabitRun } from "../heart/habits/habit-session"
import { appendRunLedgerRecordNonFatal, createRunLedgerRecord, usageMetadataFromUsageData, type RunLedgerLifecycle } from "../heart/run-ledger"
import { recordRsvpSpendLedgerRun } from "./spend-ledger"
import { RSVP_HABIT_ALLOWED_TOOLS, rsvpHabitRuntimePolicy } from "./habit-policy"
import { emitNervesEvent } from "../nerves/runtime"
import type {
  FlightRecorderProducedRef,
  HabitPermissionEnvelope,
  HabitRunTrigger,
  HabitSurfaceAttempt,
  HabitToolPolicy,
} from "../arc/flight-recorder"

type RsvpRefreshCommand = Extract<RsvpCliCommand, { kind: "rsvp.refresh" }>

export type RsvpRefreshRunner = (command: RsvpRefreshCommand, deps: OuroCliDeps) => Promise<string>

export interface RunNativeRsvpHabitInput {
  agent: string
  bundlesRoot: string
  habitName: string
  trigger: HabitRunTrigger
  occurrenceId?: string
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
    mode,
    json: true,
    ...(sendAllowed ? { allowSend: true } : { noSend: true }),
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

function surfaceAttemptsFor(payload: Record<string, unknown>, requestedSend: boolean, errorMessage: string | null): HabitSurfaceAttempt[] {
  if (payload.sendAllowed === true) {
    return [{
      recipient: "rsvp",
      channel: "bluebubbles",
      reason: "status",
      result: "sent",
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

  const habit = applyHabitRuntimeState(agentRoot, parseHabitFile(fs.readFileSync(habitPath, "utf-8"), habitPath))
  if (!habit.rsvp) throw new Error(`RSVP habit metadata is required before native execution: ${input.habitName}`)
  const policy = rsvpHabitRuntimePolicy(habit.rsvp)
  const command = refreshCommandFor(input, policy.sendAllowed, habit.rsvp.mode)
  const deps = noopCliDeps(input, agentRoot)

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

  let payload: Record<string, unknown>
  let errorMessage: string | null = null
  try {
    payload = parseRefreshPayload(await (input.runRefresh ?? defaultRunRefresh)(command, deps))
    errorMessage = payloadError(payload)
  } catch (error) {
    payload = {
      ok: false,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: input.agent,
      mode: habit.rsvp.mode,
      message: error instanceof Error ? error.message : String(error),
    }
    errorMessage = stringField(payload, "message") ?? "RSVP refresh failed"
  }

  const endedAt = nowIso(input.now)
  const lifecycle: Extract<RunLedgerLifecycle, "completed" | "error"> = errorMessage ? "error" : "completed"
  const surfaceAttempts = surfaceAttemptsFor(payload, policy.sendAllowed, errorMessage)
  const errors = errorMessage ? [errorMessage] : []

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

  const completion = completeHabitRun({
    agentRoot,
    habit,
    runId,
    trigger: input.trigger,
    startedAt,
    endedAt,
    operationId: `rsvp-native:${input.trigger}:${input.occurrenceId ?? runId}`,
    permissionEnvelope: permissionEnvelope(policy.sendAllowed),
    toolPolicy: toolPolicy(policy.sendAllowed),
    producedRefs: producedRefsFor(payload),
    surfaceAttempts,
    errors,
    summarySnapshot: {
      summary: errorMessage
        ? `Native RSVP habit failed: ${errorMessage}`
        : "Native RSVP habit completed.",
      decisions: [
        `mode=${habit.rsvp.mode}`,
        `sendAllowed=${String(policy.sendAllowed)}`,
      ],
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
