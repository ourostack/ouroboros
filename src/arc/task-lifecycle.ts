import { emitNervesEvent } from "../nerves/runtime"

/**
 * Shared lifecycle grammar for task-shaped work.
 *
 * Ponder packets in arc/ use this status universe to validate state
 * transitions. Other surfaces (desk task.md files) duck-type the same
 * vocabulary; no cross-reference required.
 */
export type TaskStatus =
  | "drafting"
  | "processing"
  | "validating"
  | "collaborating"
  | "paused"
  | "blocked"
  | "done"
  | "cancelled"

export interface TransitionResult {
  ok: boolean
  from: TaskStatus
  to: TaskStatus
  reason?: string
}

export const TASK_VALID_STATUSES: readonly TaskStatus[] = [
  "drafting",
  "processing",
  "validating",
  "collaborating",
  "paused",
  "blocked",
  "done",
  "cancelled",
]

export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  drafting: ["processing", "collaborating", "cancelled"],
  processing: ["validating", "paused", "blocked", "cancelled"],
  validating: ["done", "processing", "collaborating", "cancelled"],
  collaborating: ["processing", "validating", "paused", "cancelled"],
  paused: ["processing", "blocked", "cancelled"],
  blocked: ["processing", "paused", "cancelled"],
  done: [],
  cancelled: [],
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_VALID_STATUSES.includes(value as TaskStatus)
}

export function normalizeTaskStatus(value: string | null | undefined): TaskStatus | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return isTaskStatus(normalized) ? normalized : null
}

export function validateTransition(from: TaskStatus, to: TaskStatus): TransitionResult {
  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "validating task status transition",
    meta: { from, to },
  })

  if (from === to) {
    return { ok: true, from, to }
  }

  const allowed = TASK_STATUS_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    return {
      ok: false,
      from,
      to,
      reason: `invalid transition: ${from} -> ${to}`,
    }
  }

  return { ok: true, from, to }
}

