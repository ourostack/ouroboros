/**
 * Reads the two bundle sync records that post-turn sync leaves on disk and
 * turns them into one view for `ouro status` and the daemon health check:
 *
 *   - `state/pending-sync.json`: the last sync failed and nothing has
 *     succeeded since (written and cleared by `postTurnPush`).
 *   - `state/sync-skipped-files.json`: files sync left uncommitted because
 *     they are over `SYNC_FILE_SIZE_LIMIT_BYTES`.
 *
 * Reading never throws: an unreadable or malformed record reads as absent.
 */
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface BundleSyncFailure {
  error: string
  classification: string
  firstFailedAt: string
  lastFailedAt: string
  consecutiveFailures: number
}

export interface BundleSyncSkippedFile {
  path: string
  bytes: number
}

export interface BundleSyncHealth {
  failure: BundleSyncFailure | null
  skippedFiles: BundleSyncSkippedFile[]
}

export interface BundleSyncHealthCheck {
  name: string
  status: "ok" | "warn"
  message: string
}

export interface ReadBundleSyncHealthDeps {
  readFileSync?: (p: string, encoding: "utf-8") => string
}

function readJson(filePath: string, readFile: (p: string, encoding: "utf-8") => string): unknown {
  try {
    return JSON.parse(readFile(filePath, "utf-8")) as unknown
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Accepts both the on-disk `pending-sync.json` shape (`failedAt`) and the
 * `BundleSyncFailure` shape the daemon sends in status (`lastFailedAt`).
 */
export function parseBundleSyncFailure(value: unknown): BundleSyncFailure | null {
  const record = asRecord(value)
  if (!record || typeof record.error !== "string") return null
  const lastFailedAt = typeof record.failedAt === "string"
    ? record.failedAt
    : typeof record.lastFailedAt === "string" ? record.lastFailedAt : "unknown"
  return {
    error: record.error,
    classification: typeof record.classification === "string" ? record.classification : "unknown",
    firstFailedAt: typeof record.firstFailedAt === "string" ? record.firstFailedAt : lastFailedAt,
    lastFailedAt,
    consecutiveFailures: typeof record.consecutiveFailures === "number" && record.consecutiveFailures > 0
      ? record.consecutiveFailures
      : 1,
  }
}

/** Accepts the `sync-skipped-files.json` record or a bare array of files. */
export function parseBundleSyncSkippedFiles(value: unknown): BundleSyncSkippedFile[] {
  const files = Array.isArray(value) ? value : asRecord(value)?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((entry): BundleSyncSkippedFile[] => {
    const file = asRecord(entry)
    if (!file || typeof file.path !== "string" || typeof file.bytes !== "number") return []
    return [{ path: file.path, bytes: file.bytes }]
  })
}

export function readBundleSyncHealth(agentRoot: string, deps: ReadBundleSyncHealthDeps = {}): BundleSyncHealth {
  const readFile = deps.readFileSync ?? ((p, encoding) => fs.readFileSync(p, encoding))
  return {
    failure: parseBundleSyncFailure(readJson(path.join(agentRoot, "state", "pending-sync.json"), readFile)),
    skippedFiles: parseBundleSyncSkippedFiles(readJson(path.join(agentRoot, "state", "sync-skipped-files.json"), readFile)),
  }
}

/** First line of a git error, capped so one status line stays readable. */
export function summarizeSyncError(error: string): string {
  const firstLine = error.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "unknown"
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function describeSyncFailure(failure: BundleSyncFailure): string {
  return `sync failing since ${failure.firstFailedAt} (${failure.consecutiveFailures} attempt(s)): ${summarizeSyncError(failure.error)}`
}

export function describeSkippedFiles(files: BundleSyncSkippedFile[]): string {
  const listed = files.slice(0, 3).map((file) => `${file.path} (${formatMegabytes(file.bytes)})`).join(", ")
  const more = files.length > 3 ? `, and ${files.length - 3} more` : ""
  return `${files.length} file(s) too large to sync left uncommitted: ${listed}${more}`
}

/** The fields of a bundle sync row (`listBundleSyncRows`) the health check reads. */
export interface BundleSyncHealthRow {
  agent: string
  enabled: boolean
  failure?: BundleSyncFailure
  skippedFiles?: BundleSyncSkippedFile[]
}

/**
 * Daemon health check over the managed agents' bundle sync rows. Bundles with
 * sync disabled are ignored. Sync trouble is a warning, never critical: the
 * agent still runs, but its bundle is not being backed up, which must stay
 * visible until someone fixes it.
 */
export function checkBundleSyncHealth(rows: readonly BundleSyncHealthRow[]): BundleSyncHealthCheck {
  const problems: string[] = []
  for (const row of rows) {
    if (!row.enabled) continue
    if (row.failure) problems.push(`${row.agent}: ${describeSyncFailure(row.failure)}`)
    if (row.skippedFiles && row.skippedFiles.length > 0) problems.push(`${row.agent}: ${describeSkippedFiles(row.skippedFiles)}`)
  }
  if (problems.length === 0) {
    return { name: "bundle-sync", status: "ok", message: "bundle sync healthy" }
  }
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.bundle_sync_unhealthy",
    message: "bundle sync health check found problems",
    meta: { problems },
  })
  return { name: "bundle-sync", status: "warn", message: problems.join("; ") }
}
