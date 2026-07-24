import * as path from "path"

import { writeHabitRunReceipt } from "../../arc/flight-recorder"
import { emitNervesEvent } from "../../nerves/runtime"
import { readHabitProjectionCandidate } from "./habit-projection-candidate"
import type { HabitProjectionResult } from "./habit-projection-store"
import { recordHabitRun } from "./habit-runtime-state"

export interface HabitProjectionPublicationResult {
  sessionProjected: boolean
  runtimeStateRecorded: boolean
}

export function publishHabitProjection(
  bundleRoot: string,
  projection: HabitProjectionResult,
): HabitProjectionPublicationResult {
  const { receipt, occurrence } = projection
  const candidate = readHabitProjectionCandidate(bundleRoot, receipt.occurrenceId, receipt.attemptId)
  if (candidate && candidate.receipt.habitName !== occurrence.habitId) {
    throw new Error("Habit projection candidate habit does not match occurrence authority")
  }
  if (candidate) writeHabitRunReceipt(bundleRoot, candidate.receipt)

  if (receipt.state !== "completed") {
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_projection_diagnostic_published",
      message: "published a non-completed habit occurrence as diagnostic state",
      meta: {
        agent: receipt.agent,
        habitId: receipt.habitId,
        occurrenceId: receipt.occurrenceId,
        attemptId: receipt.attemptId,
        state: receipt.state,
        sessionProjected: candidate !== null,
      },
    })
    return { sessionProjected: candidate !== null, runtimeStateRecorded: false }
  }

  const attempt = occurrence.attempts.at(-1)
  if (!attempt || attempt.attemptId !== receipt.attemptId || attempt.state !== "completed" || attempt.settledAt === null) {
    throw new Error("Completed habit projection does not match a settled latest attempt")
  }
  recordHabitRun(bundleRoot, occurrence.habitId, attempt.settledAt, {
    definitionPath: path.join(bundleRoot, "habits", `${occurrence.habitId}.md`),
    activeOperationId: candidate?.receipt.operationId ?? null,
    latestRunId: candidate?.receipt.runId ?? occurrence.occurrenceId,
    latestReceiptLocator: projection.receiptRef,
  })
  emitNervesEvent({
    component: "heart",
    event: "heart.habit_projection_completion_published",
    message: "published session and runtime state from completed occurrence authority",
    meta: {
      agent: receipt.agent,
      habitId: receipt.habitId,
      occurrenceId: receipt.occurrenceId,
      attemptId: receipt.attemptId,
      sessionProjected: candidate !== null,
    },
  })
  return { sessionProjected: candidate !== null, runtimeStateRecorded: true }
}
