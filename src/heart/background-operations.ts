import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot } from "./identity"

export type BackgroundOperationStatus = "queued" | "running" | "succeeded" | "failed"

export interface BackgroundOperationProgress {
  current?: number
  total?: number
  unit?: string
}

export interface BackgroundOperationFailure {
  class: string
  retryDisposition?: "retry-safe" | "fix-before-retry" | "investigate-first"
  hint?: string
}

export interface BackgroundOperationRecord {
  schemaVersion: 1
  id: string
  agentName: string
  kind: string
  title: string
  status: BackgroundOperationStatus
  summary: string
  detail?: string
  progress?: BackgroundOperationProgress
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  spec?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message: string }
  failure?: BackgroundOperationFailure
  remediation?: string[]
}

interface BackgroundOperationLocator {
  agentName: string
  agentRoot?: string
  id: string
}

interface BackgroundOperationWriteInput extends BackgroundOperationLocator {
  kind: string
  title: string
  summary: string
  createdAt: string
  spec?: Record<string, unknown>
}

interface BackgroundOperationUpdateInput extends BackgroundOperationLocator {
  summary?: string
  detail?: string
  progress?: BackgroundOperationProgress
  spec?: Record<string, unknown>
  updatedAt?: string
}

interface BackgroundOperationRunningInput extends BackgroundOperationUpdateInput {
  startedAt: string
}

interface BackgroundOperationCompleteInput extends BackgroundOperationUpdateInput {
  finishedAt: string
  result?: Record<string, unknown>
}

interface BackgroundOperationFailInput extends BackgroundOperationUpdateInput {
  finishedAt: string
  error: string
  failure?: BackgroundOperationFailure
  remediation?: string[]
}

function operationsDir(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(agentRoot, "state", "background-operations")
}

function operationPath(locator: BackgroundOperationLocator): string {
  return path.join(operationsDir(locator.agentName, locator.agentRoot), `${locator.id}.json`)
}

function normalizeProgress(progress: BackgroundOperationProgress | undefined): BackgroundOperationProgress | undefined {
  if (!progress) return undefined
  const normalized: BackgroundOperationProgress = {}
  if (typeof progress.current === "number" && Number.isFinite(progress.current)) normalized.current = progress.current
  if (typeof progress.total === "number" && Number.isFinite(progress.total)) normalized.total = progress.total
  if (typeof progress.unit === "string" && progress.unit.trim().length > 0) normalized.unit = progress.unit.trim()
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeRecord(record: Partial<BackgroundOperationRecord>): BackgroundOperationRecord | null {
  if (record.schemaVersion !== 1) return null
  if (typeof record.id !== "string" || record.id.trim().length === 0) return null
  if (typeof record.agentName !== "string" || record.agentName.trim().length === 0) return null
  if (typeof record.kind !== "string" || record.kind.trim().length === 0) return null
  if (typeof record.title !== "string" || record.title.trim().length === 0) return null
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) return null
  if (typeof record.createdAt !== "string" || record.createdAt.trim().length === 0) return null
  if (typeof record.updatedAt !== "string" || record.updatedAt.trim().length === 0) return null
  if (
    record.status !== "queued"
    && record.status !== "running"
    && record.status !== "succeeded"
    && record.status !== "failed"
  ) {
    return null
  }

  const normalized: BackgroundOperationRecord = {
    schemaVersion: 1,
    id: record.id,
    agentName: record.agentName,
    kind: record.kind,
    title: record.title,
    status: record.status,
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  if (typeof record.detail === "string" && record.detail.trim().length > 0) normalized.detail = record.detail.trim()
  if (typeof record.startedAt === "string" && record.startedAt.trim().length > 0) normalized.startedAt = record.startedAt
  if (typeof record.finishedAt === "string" && record.finishedAt.trim().length > 0) normalized.finishedAt = record.finishedAt
  const progress = normalizeProgress(record.progress)
  if (progress) normalized.progress = progress
  if (record.spec && typeof record.spec === "object" && !Array.isArray(record.spec)) normalized.spec = { ...record.spec }
  if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) normalized.result = { ...record.result }
  if (record.error && typeof record.error.message === "string" && record.error.message.trim().length > 0) {
    normalized.error = { message: record.error.message.trim() }
  }
  if (record.failure && typeof record.failure === "object" && !Array.isArray(record.failure)) {
    const failureClass = typeof record.failure.class === "string" ? record.failure.class.trim() : ""
    const retryDisposition = record.failure.retryDisposition
    const hint = typeof record.failure.hint === "string" ? record.failure.hint.trim() : ""
    if (failureClass) {
      normalized.failure = {
        class: failureClass,
        ...(retryDisposition === "retry-safe" || retryDisposition === "fix-before-retry" || retryDisposition === "investigate-first"
          ? { retryDisposition }
          : {}),
        ...(hint ? { hint } : {}),
      }
    }
  }
  if (Array.isArray(record.remediation)) {
    const remediation = record.remediation.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    if (remediation.length > 0) normalized.remediation = remediation
  }
  return normalized
}

function readRecord(filePath: string): BackgroundOperationRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<BackgroundOperationRecord>
    return normalizeRecord(parsed)
  } catch {
    return null
  }
}

function specText(spec: Record<string, unknown> | undefined, key: string): string {
  const value = spec?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function visibleOperationKey(record: BackgroundOperationRecord): string | null {
  if (record.kind !== "mail.import-mbox") return null
  const filePath = specText(record.spec, "filePath")
  if (!filePath) return null
  const ownerEmail = specText(record.spec, "ownerEmail").toLowerCase()
  const source = specText(record.spec, "source").toLowerCase()
  return `${record.agentName.toLowerCase()}|${record.kind}|${filePath}|${ownerEmail}|${source}`
}

function writeRecord(locator: BackgroundOperationLocator, record: BackgroundOperationRecord): BackgroundOperationRecord {
  const normalized = normalizeRecord(record)
  if (!normalized) {
    throw new Error(`invalid background operation record: ${locator.id}`)
  }
  fs.mkdirSync(operationsDir(locator.agentName, locator.agentRoot), { recursive: true })
  fs.writeFileSync(operationPath(locator), `${JSON.stringify(normalized, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "engine",
    event: "engine.background_operation_written",
    message: "background operation state written",
    meta: { agentName: locator.agentName, id: locator.id, kind: normalized.kind, status: normalized.status },
  })
  return normalized
}

function requireRecord(locator: BackgroundOperationLocator): BackgroundOperationRecord {
  const record = readBackgroundOperation(locator)
  if (!record) {
    throw new Error(`background operation not found: ${locator.id}`)
  }
  return record
}

export function readBackgroundOperation(locator: BackgroundOperationLocator): BackgroundOperationRecord | null {
  return readRecord(operationPath(locator))
}

export function listBackgroundOperations(input: {
  agentName: string
  agentRoot?: string
  limit?: number
}): BackgroundOperationRecord[] {
  const dir = operationsDir(input.agentName, input.agentRoot)
  if (!fs.existsSync(dir)) return []
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const records = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readRecord(path.join(dir, entry)))
    .filter((entry): entry is BackgroundOperationRecord => entry !== null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const visibleKeys = new Set<string>()
  const visible = records.filter((record) => {
    const key = visibleOperationKey(record)
    if (!key) return true
    if (visibleKeys.has(key)) return false
    visibleKeys.add(key)
    return true
  })
  return visible.slice(0, input.limit ?? 10)
}

export function startBackgroundOperation(input: BackgroundOperationWriteInput): BackgroundOperationRecord {
  return writeRecord(input, {
    schemaVersion: 1,
    id: input.id,
    agentName: input.agentName,
    kind: input.kind,
    title: input.title,
    status: "queued",
    summary: input.summary,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...(input.spec ? { spec: input.spec } : {}),
  })
}

export function markBackgroundOperationRunning(input: BackgroundOperationRunningInput): BackgroundOperationRecord {
  const current = requireRecord(input)
  const updatedAt = input.updatedAt ?? input.startedAt
  return writeRecord(input, {
    ...current,
    status: "running",
    summary: input.summary ?? current.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(normalizeProgress(input.progress) ? { progress: normalizeProgress(input.progress) } : {}),
    startedAt: input.startedAt,
    updatedAt,
    ...(current.finishedAt ? { finishedAt: current.finishedAt } : {}),
  })
}

export function updateBackgroundOperation(input: BackgroundOperationUpdateInput): BackgroundOperationRecord {
  const current = requireRecord(input)
  return writeRecord(input, {
    ...current,
    summary: input.summary ?? current.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(normalizeProgress(input.progress) ? { progress: normalizeProgress(input.progress) } : {}),
    ...(input.spec ? { spec: input.spec } : {}),
    updatedAt: input.updatedAt ?? current.updatedAt,
  })
}

export function completeBackgroundOperation(input: BackgroundOperationCompleteInput): BackgroundOperationRecord {
  const current = requireRecord(input)
  return writeRecord(input, {
    ...current,
    status: "succeeded",
    summary: input.summary ?? current.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(normalizeProgress(input.progress) ? { progress: normalizeProgress(input.progress) } : {}),
    ...(input.result ? { result: input.result } : {}),
    error: undefined,
    remediation: undefined,
    failure: undefined,
    finishedAt: input.finishedAt,
    updatedAt: input.updatedAt ?? input.finishedAt,
  })
}

export function failBackgroundOperation(input: BackgroundOperationFailInput): BackgroundOperationRecord {
  const current = requireRecord(input)
  return writeRecord(input, {
    ...current,
    status: "failed",
    summary: input.summary ?? current.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(normalizeProgress(input.progress) ? { progress: normalizeProgress(input.progress) } : {}),
    error: { message: input.error },
    ...(input.failure ? { failure: input.failure } : {}),
    ...(input.remediation && input.remediation.length > 0 ? { remediation: input.remediation } : {}),
    finishedAt: input.finishedAt,
    updatedAt: input.updatedAt ?? input.finishedAt,
  })
}
