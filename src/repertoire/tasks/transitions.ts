import { emitNervesEvent } from "../../nerves/runtime"

export {
  TASK_STATUS_TRANSITIONS,
  TASK_VALID_STATUSES,
  isTaskStatus,
  normalizeTaskStatus,
  renderTaskTransitionLines,
  validateTransition,
} from "../../arc/task-lifecycle"
import type {
  CanonicalTaskCollection,
  CanonicalTaskType,
} from "./types"

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
  emitNervesEvent({
    event: "repertoire.task_type_normalize",
    component: "repertoire",
    message: "normalizing task type",
    meta: { input: value ?? null },
  })

  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return TASK_CANONICAL_TYPES.includes(normalized as CanonicalTaskType)
    ? (normalized as CanonicalTaskType)
    : null
}

export function isCanonicalTaskFilename(value: string | null | undefined): boolean {
  return typeof value === "string" && TASK_FILENAME_PATTERN.test(value)
}
