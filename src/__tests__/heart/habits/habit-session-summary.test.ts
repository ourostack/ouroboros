import { describe, expect, it } from "vitest"
import type { HabitRunOutcome, HabitRunReceipt } from "../../../arc/flight-recorder"
import {
  selectHabitRunReceipt,
  type HabitSummaryReceipt,
} from "../../../heart/habits/habit-session-summary"

function makeReceipt(
  runId: string,
  overrides: Partial<HabitRunReceipt> & { operationId?: string | null } = {},
): HabitSummaryReceipt {
  const habitName = overrides.habitName ?? "journal"
  const endedAt = overrides.endedAt ?? "2026-06-11T12:00:00.000Z"
  return {
    schemaVersion: 2,
    runId,
    sessionId: runId,
    habitName,
    trigger: overrides.trigger ?? "manual",
    startedAt: overrides.startedAt ?? "2026-06-11T11:59:00.000Z",
    endedAt,
    outcome: overrides.outcome ?? "no_change",
    definitionLocator: overrides.definitionLocator ?? `habits/${habitName}.md`,
    sessionLocator: overrides.sessionLocator ?? `state/habit-sessions/${runId}/session.json`,
    pendingLocator: overrides.pendingLocator ?? `state/habit-sessions/${runId}/pending`,
    runtimeStateLocator: overrides.runtimeStateLocator ?? `state/habits/${habitName}.json`,
    receiptLocator: overrides.receiptLocator ?? `arc/flight-recorder/habit-receipts/${runId}.json`,
    nextRunAt: overrides.nextRunAt ?? null,
    permissionEnvelope: overrides.permissionEnvelope ?? {
      schemaVersion: 1,
      canMessageOutward: true,
      returnRoutes: [],
      deniedTools: [],
      warnings: [],
    },
    toolPolicy: overrides.toolPolicy ?? {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: true,
    },
    producedRefs: overrides.producedRefs ?? [],
    surfaceAttempts: overrides.surfaceAttempts ?? [],
    errors: overrides.errors ?? [],
    operationId: overrides.operationId ?? null,
  }
}

describe("habit-session-summary selector", () => {
  it("selects an explicit run id and rejects run id combined with filters", () => {
    const receipts = [
      makeReceipt("run-a", { habitName: "journal" }),
      makeReceipt("run-b", { habitName: "heartbeat" }),
    ]

    expect(selectHabitRunReceipt(receipts, { runId: "run-b" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-b" },
    })
    expect(selectHabitRunReceipt(receipts, { runId: "missing" })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "no habit run matched selector",
      },
    })

    expect(selectHabitRunReceipt(receipts, { runId: "run-b", habitName: "heartbeat" })).toEqual({
      ok: false,
      error: {
        code: "run_id_exclusive",
        message: "runId cannot be combined with habitName, operationId, or which",
      },
    })
    expect(selectHabitRunReceipt(receipts, { runId: "run-b", which: "latest" })).toMatchObject({
      ok: false,
      error: { code: "run_id_exclusive" },
    })
    expect(selectHabitRunReceipt(receipts, { runId: "run-b", operationId: "op-1" })).toMatchObject({
      ok: false,
      error: { code: "run_id_exclusive" },
    })
  })

  it("requires habitName or operationId when no explicit run id is supplied", () => {
    expect(selectHabitRunReceipt([], {})).toEqual({
      ok: false,
      error: {
        code: "selector_required",
        message: "provide runId, habitName, or operationId",
      },
    })
    expect(selectHabitRunReceipt([], { habitName: "journal" })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "no habit run matched selector",
      },
    })
  })

  it("defaults to latest and sorts by endedAt descending then runId descending", () => {
    const receipts = [
      makeReceipt("run-a", { endedAt: "2026-06-11T12:01:00.000Z" }),
      makeReceipt("run-c", { endedAt: "2026-06-11T12:01:00.000Z" }),
      makeReceipt("run-z", { endedAt: "2026-06-11T12:00:00.000Z" }),
    ]

    expect(selectHabitRunReceipt(receipts, { habitName: "journal" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-c" },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "previous" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-a" },
    })
    expect(receipts.map((receipt) => receipt.runId)).toEqual(["run-a", "run-c", "run-z"])
  })

  it("filters by operationId with an optional habitName", () => {
    const receipts = [
      makeReceipt("run-a", { habitName: "journal", operationId: "op-a", endedAt: "2026-06-11T12:00:00.000Z" }),
      makeReceipt("run-b", { habitName: "heartbeat", operationId: "op-a", endedAt: "2026-06-11T12:03:00.000Z" }),
      makeReceipt("run-c", { habitName: "journal", operationId: "op-b", endedAt: "2026-06-11T12:04:00.000Z" }),
    ]

    expect(selectHabitRunReceipt(receipts, { operationId: "op-a" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-b" },
    })
    expect(selectHabitRunReceipt(receipts, { operationId: "op-a", habitName: "journal" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-a" },
    })
  })

  it("maps latest-success and latest-failure to explicit outcome sets", () => {
    const successOutcomes: HabitRunOutcome[] = ["no_change", "wrote_arc", "updated_desk", "wrote_record", "surfaced"]
    const failureOutcomes: HabitRunOutcome[] = ["blocked", "error"]
    const receipts = [
      ...successOutcomes.map((outcome, index) => makeReceipt(`success-${index}`, {
        outcome,
        endedAt: `2026-06-11T12:0${index}:00.000Z`,
      })),
      ...failureOutcomes.map((outcome, index) => makeReceipt(`failure-${index}`, {
        outcome,
        endedAt: `2026-06-11T12:1${index}:00.000Z`,
      })),
    ]

    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "latest-success" })).toMatchObject({
      ok: true,
      receipt: { runId: "success-4", outcome: "surfaced" },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "latest-failure" })).toMatchObject({
      ok: true,
      receipt: { runId: "failure-1", outcome: "error" },
    })
  })

  it("returns typed errors for invalid which values and missing matches", () => {
    const receipts = [makeReceipt("run-a", { habitName: "journal" })]

    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "banana" })).toEqual({
      ok: false,
      error: {
        code: "invalid_which",
        message: "which must be latest, previous, latest-success, or latest-failure",
      },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "missing" })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "no habit run matched selector",
      },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "previous" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
  })
})
