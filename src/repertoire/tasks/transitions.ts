import { emitNervesEvent } from "../../nerves/runtime"
import type {
  CanonicalTaskCollection,
  CanonicalTaskType,
  TaskStatus,
  TransitionResult,
} from "./types"

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

export const TASK_CANONICAL_TYPES: readonly CanonicalTaskType[] = [
  "one-shot",
  "ongoing",
]

export const TASK_CANONICAL_COLLECTIONS: readonly CanonicalTaskCollection[] = [
  "one-shots",
  "ongoing",
]

export const TASK_TYPE_TO_COLLECTION: Record<CanonicalTaskType, CanonicalTaskCollection> = {
  "one-shot": "one-shots",
  ongoing: "ongoing",
}

export const TASK_RESERVED_DIRECTORIES = ["templates", ".trash", "archive"] as const

export const TASK_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9][a-z0-9-]*\.md$/

export const TASK_REQUIRED_TEMPLATE_FIELDS: Record<CanonicalTaskType, readonly string[]> = {
  "one-shot": [
    "kind",
    "type",
    "category",
    "title",
    "status",
    "validator",
    "requester",
    "cadence",
    "scheduledAt",
    "lastRun",
    "created",
    "updated",
    "parent_task",
    "depends_on",
    "artifacts",
  ],
  ongoing: [
    "kind",
    "type",
    "category",
    "title",
    "status",
    "validator",
    "requester",
    "cadence",
    "scheduledAt",
    "lastRun",
    "created",
    "updated",
    "artifacts",
  ],
}

export function canonicalCollectionForTaskType(type: CanonicalTaskType): CanonicalTaskCollection {
  return TASK_TYPE_TO_COLLECTION[type]
}

export function normalizeTaskType(value: string | null | undefined): CanonicalTaskType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return TASK_CANONICAL_TYPES.includes(normalized as CanonicalTaskType)
    ? (normalized as CanonicalTaskType)
    : null
}

export function normalizeTaskStatus(value: string | null | undefined): TaskStatus | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return TASK_VALID_STATUSES.includes(normalized as TaskStatus)
    ? (normalized as TaskStatus)
    : null
}

export function isCanonicalTaskFilename(value: string | null | undefined): boolean {
  return typeof value === "string" && TASK_FILENAME_PATTERN.test(value)
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

export function renderTaskTransitionLines(): string[] {
  return TASK_VALID_STATUSES.map((from) => {
    const to = TASK_STATUS_TRANSITIONS[from]
    const rendered = to.length > 0 ? to.map((next) => `\`${next}\``).join(", ") : "(terminal)"
    return `- \`${from}\` -> ${rendered}`
  })
}
