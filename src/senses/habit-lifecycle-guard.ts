import type { HabitFile } from "../heart/habits/habit-parser"
import { emitNervesEvent } from "../nerves/runtime"

export type PrivateRuntimeHabitBoundary = "private-runtime-worker" | "private-runtime"

export function privateRuntimeHabitRejectionReason(
  habit: Extract<HabitFile, { status: "degraded" }>,
  boundary: PrivateRuntimeHabitBoundary,
): string
export function privateRuntimeHabitRejectionReason(
  habit: HabitFile,
  boundary: PrivateRuntimeHabitBoundary,
): string | null
export function privateRuntimeHabitRejectionReason(
  habit: HabitFile,
  boundary: PrivateRuntimeHabitBoundary,
): string | null {
  if (habit.status === "active") return null

  const reason = `habit status ${habit.status} is non-executable before private runtime execution`
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.habit_lifecycle_rejected",
    message: "habit lifecycle state rejected before private runtime execution",
    meta: {
      boundary,
      habitName: habit.name,
      status: habit.status,
      degradedReason: habit.status === "degraded" ? habit.degradedReason : null,
      detail: habit.status === "degraded" ? habit.degradedDetail : null,
      reason,
    },
  })
  return reason
}
