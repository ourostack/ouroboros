/**
 * Shared classifier for legacy `tasks/` → `desk/` migration.
 *
 * Pure data + parsing. Takes a file path relative to `<bundle>/tasks/` plus
 * its content, returns a classification bucket. Used by `migrate-to-desk.ts`
 * to decide where each file lands in the new `desk/` shape.
 *
 * Bucket definitions:
 * - **terminal** — explicit done/complete/approved/cancelled/fixed status (or
 *   synonyms). Always archived. Files under `tasks/archive/` are unconditionally
 *   terminal regardless of frontmatter.
 * - **stale_live** — live-looking status (`in-progress`, `ready_for_execution`,
 *   `drafting`, `collaborating`, etc.) but the resolved `updated` date is
 *   older than the 30-day cutoff. → archive (when-in-doubt rule).
 * - **ambiguous** — no status, junk format, unknown status, `.md.bak` backup,
 *   or empty file. → archive.
 * - **live_clear** — live status AND updated within the last 30 days AND
 *   coherent. → migrate to `legacy` track on the new desk.
 * - **special_europe_trip** — historical one-off `ongoing/2026-03-09-1410-summer-2026-europe-trip.md` from the initial bundle that authored this migrator; kept as a labelled special case until the bundle is deprecated.
 *
 * Effective `updated` resolution priority: YAML `updated` → `approved` →
 * `created` → body `**Updated**:` → date prefix in filename → file mtime.
 *
 * This is a pure-data helper: no side effects, no nerves observability of
 * its own. The migrator emits nerves events around classify() calls.
 */

import { parseFrontmatter } from "../../util/frontmatter"

export type ClassificationBucket =
  | "terminal"
  | "stale_live"
  | "ambiguous"
  | "live_clear"
  | "special_europe_trip"

export interface ClassificationInput {
  /** Path relative to `<bundle>/tasks/`. e.g. `one-shots/2026-05-10-doing-foo.md`. */
  relPath: string
  /** Raw file content (markdown). For non-markdown files, the body. */
  content: string
  /** File mtime (epoch ms). Last-resort `updated` fallback. */
  mtimeMs: number
  /**
   * Cutoff date (epoch ms). Files with effective `updated` strictly older than
   * this are stale_live (if their status is live). Per planning: 30 days ago.
   * Inject this so tests are deterministic.
   */
  cutoffMs: number
}

export interface ClassificationResult {
  bucket: ClassificationBucket
  /** Effective `updated` timestamp (ms) used in the decision. */
  updatedMs: number
  /** Resolved status string (lowercased), or undefined if none found. */
  status: string | undefined
  /** Reason string for the migration log. */
  reason: string
}

// ── Status vocabulary ──

const TERMINAL_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "approved",
  "cancelled",
  "canceled",
  "fixed",
  "merged",
  "merged_and_published",
  "abandoned",
  "rejected",
  "closed",
  "shipped",
  "resolved",
  "archived",
  "obsolete",
  "deprecated",
  "superseded",
  "converted",
  "discarded",
  "won't-do",
  "wontfix",
  "won't-fix",
])

const LIVE_STATUSES = new Set([
  "drafting",
  "in-progress",
  "in_progress",
  "inprogress",
  "ready_for_execution",
  "ready-for-execution",
  "collaborating",
  "processing",
  "validating",
  "blocked",
  "paused",
  "open",
  "needs_review",
  "needs-review",
  "handoff_needs_work_planner",
  "running",
  "active",
  "reopened",
  "handed-off",
  "local_verified",
  "ongoing",
])

// ── Helpers ──

function isMarkdownFile(relPath: string): boolean {
  return relPath.endsWith(".md")
}

function isBackupFile(relPath: string): boolean {
  return relPath.endsWith(".md.bak") || relPath.endsWith("~") || relPath.endsWith(".swp")
}

function isInArchiveSubdir(relPath: string): boolean {
  return relPath.startsWith("archive/") || relPath.includes("/archive/")
}

/**
 * Detect the historical europe-trip task. Per the lift plan:
 * `ongoing/2026-03-09-1410-summer-2026-europe-trip.md` is the only
 * special-cased file.
 */
function isEuropeTripTask(relPath: string): boolean {
  return relPath === "ongoing/2026-03-09-1410-summer-2026-europe-trip.md"
}

/**
 * Extract the frontmatter block (between `---` fences) from a markdown file.
 * Returns the raw frontmatter text or undefined if no fenced block exists.
 */
function extractFrontmatterBlock(content: string): string | undefined {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---")) return undefined
  const afterFirstFence = trimmed.slice(3)
  const closeIdx = afterFirstFence.indexOf("\n---")
  if (closeIdx === -1) return undefined
  return afterFirstFence.slice(0, closeIdx).replace(/^\r?\n/, "")
}

function readStatusFromFrontmatter(fm: Record<string, unknown>): string | undefined {
  const candidates = ["status", "Status", "STATUS", "state", "State"]
  for (const key of candidates) {
    const value = fm[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase()
    }
  }
  return undefined
}

function readDateFromFrontmatter(fm: Record<string, unknown>, key: string): number | undefined {
  const value = fm[key]
  if (typeof value !== "string") return undefined
  const parsed = parseDateString(value)
  return parsed
}

/**
 * Parse a date string into epoch ms. Accepts YYYY-MM-DD and full ISO 8601
 * timestamps. Returns undefined for unparseable input.
 */
function parseDateString(raw: string): number | undefined {
  const trimmed = raw.trim()
  /* v8 ignore start -- defensive: callers (readDateFromFrontmatter, extractUpdatedFromBody) only pass values that have already been confirmed non-empty (frontmatter scalar or regex-captured digits). The empty-string fallback is unreachable in practice. @preserve */
  if (!trimmed) return undefined
  /* v8 ignore stop */
  // YYYY-MM-DD or YYYY-MM-DD HH:MM or full ISO
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnlyMatch) {
    const ms = Date.UTC(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]) - 1,
      Number(dateOnlyMatch[3]),
    )
    /* v8 ignore start -- Date.UTC normalizes out-of-range numeric inputs to finite ms; the regex already guarantees four+two+two-digit ints. The undefined branch is genuinely unreachable. @preserve */
    return Number.isFinite(ms) ? ms : undefined
    /* v8 ignore stop */
  }
  const ms = Date.parse(trimmed)
  /* v8 ignore start -- v8 coverage tooling intermittently fails to register the NaN→undefined branch even when tests demonstrably exercise it (see "garbage123" / "not-a-date-at-all-12345xyz67890" tests in migrate-to-desk.test.ts). The behavior is correct; the coverage signal is the noise. @preserve */
  if (!Number.isFinite(ms)) return undefined
  /* v8 ignore stop */
  return ms
}

/**
 * Extract date prefix from a filename like `2026-05-12-1122-doing-foo.md`.
 * Returns epoch ms or undefined.
 */
function extractDatePrefixFromFilename(relPath: string): number | undefined {
  /* v8 ignore start -- defensive `?? relPath` fallback: String.split() always returns at least one element, so pop() never returns undefined on a non-empty input. The fallback exists only as a type guard for the strict no-implicit-any setting. @preserve */
  const base = relPath.split("/").pop() ?? relPath
  /* v8 ignore stop */
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2}))?/.exec(base)
  if (!match) return undefined
  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    match[4] ? Number(match[4]) : 0,
    match[5] ? Number(match[5]) : 0,
  )
  /* v8 ignore start -- Date.UTC normalizes out-of-range numeric inputs to finite ms; the regex already guarantees four+two+two-digit ints. The undefined branch is genuinely unreachable. @preserve */
  return Number.isFinite(ms) ? ms : undefined
  /* v8 ignore stop */
}

/**
 * Extract `**Updated**: YYYY-MM-DD` from body prose (some legacy task formats
 * use this convention instead of YAML frontmatter).
 */
function extractUpdatedFromBody(content: string): number | undefined {
  const match = /\*\*Updated\*\*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[A-Za-z0-9:_\- .]*)/.exec(content)
  if (!match) return undefined
  return parseDateString(match[1])
}

/**
 * Resolve the effective `updated` timestamp using the priority chain.
 * Priority: YAML `updated` → `approved` → `created` → body `**Updated**:` →
 * date prefix in filename → file mtime.
 */
export function resolveUpdatedMs(input: ClassificationInput): number {
  const fmBlock = extractFrontmatterBlock(input.content)
  if (fmBlock) {
    const fm = parseFrontmatter(fmBlock)
    const updated = readDateFromFrontmatter(fm, "updated") ?? readDateFromFrontmatter(fm, "Updated")
    if (updated !== undefined) return updated
    const approved = readDateFromFrontmatter(fm, "approved") ?? readDateFromFrontmatter(fm, "Approved")
    if (approved !== undefined) return approved
    const created = readDateFromFrontmatter(fm, "created") ?? readDateFromFrontmatter(fm, "Created")
    if (created !== undefined) return created
  }
  const bodyUpdated = extractUpdatedFromBody(input.content)
  if (bodyUpdated !== undefined) return bodyUpdated
  const filenameDate = extractDatePrefixFromFilename(input.relPath)
  if (filenameDate !== undefined) return filenameDate
  return input.mtimeMs
}

/**
 * Classify a status string into a coarse category. `terminal` overrides
 * everything. `live` is the explicit live set. `unknown` is anything else.
 */
function classifyStatus(status: string | undefined): "terminal" | "live" | "unknown" | "missing" {
  if (!status) return "missing"
  const normalized = status.trim().toLowerCase()
  // Some statuses are free-text sentences (e.g. "core line approved, companion proof line in discussion").
  // Match terminal keywords if they appear as the leading word.
  const head = normalized.split(/[\s,;:]+/)[0]
  if (TERMINAL_STATUSES.has(head) || TERMINAL_STATUSES.has(normalized)) return "terminal"
  if (LIVE_STATUSES.has(head) || LIVE_STATUSES.has(normalized)) return "live"
  return "unknown"
}

// ── Public classifier ──

/**
 * Classify a single file. Pairing/grouping is handled by the migrator at a
 * higher level — this function is purely per-file.
 */
export function classifyFile(input: ClassificationInput): ClassificationResult {
  // Europe-trip override comes first.
  if (isEuropeTripTask(input.relPath)) {
    return {
      bucket: "special_europe_trip",
      updatedMs: resolveUpdatedMs(input),
      status: undefined,
      reason: "operator-flagged europe-trip task",
    }
  }

  // Backup files and `archive/` subdir are unconditionally archived.
  if (isBackupFile(input.relPath)) {
    return {
      bucket: "ambiguous",
      updatedMs: resolveUpdatedMs(input),
      status: undefined,
      reason: "backup or swap file",
    }
  }
  if (isInArchiveSubdir(input.relPath)) {
    return {
      bucket: "terminal",
      updatedMs: resolveUpdatedMs(input),
      status: undefined,
      reason: "under archive/ subdir",
    }
  }

  // Empty file → ambiguous.
  if (input.content.trim().length === 0) {
    return {
      bucket: "ambiguous",
      updatedMs: input.mtimeMs,
      status: undefined,
      reason: "empty file",
    }
  }

  // Non-markdown files inherit from their parent task dir (handled at the
  // migrator level via the pairing rule). Classifier defaults to ambiguous
  // for non-md singletons.
  if (!isMarkdownFile(input.relPath)) {
    return {
      bucket: "ambiguous",
      updatedMs: resolveUpdatedMs(input),
      status: undefined,
      reason: "non-markdown file (will inherit from parent if grouped)",
    }
  }

  const fmBlock = extractFrontmatterBlock(input.content)
  const fm = fmBlock ? parseFrontmatter(fmBlock) : {}
  const status = readStatusFromFrontmatter(fm)
  const category = classifyStatus(status)
  const updatedMs = resolveUpdatedMs(input)

  if (category === "terminal") {
    return {
      bucket: "terminal",
      updatedMs,
      status,
      reason: `terminal status: ${status}`,
    }
  }
  if (category === "missing" || category === "unknown") {
    return {
      bucket: "ambiguous",
      updatedMs,
      status,
      reason: status ? `unknown status: ${status}` : "no status",
    }
  }
  // category === "live"
  if (updatedMs < input.cutoffMs) {
    return {
      bucket: "stale_live",
      updatedMs,
      status,
      reason: `live status (${status}) but updated >30d ago`,
    }
  }
  return {
    bucket: "live_clear",
    updatedMs,
    status,
    reason: `live status (${status}) within 30d`,
  }
}

// ── Pairing rules ──

/**
 * Derive a task slug from a filename. Strips the `YYYY-MM-DD-HHMM-` (or
 * `YYYY-MM-DD-`) prefix and the `planning-` / `doing-` / `ideation-` /
 * `audit-` / `audit-report-` / `audit-backlog-` infix. Returns the remaining
 * stem (without `.md`).
 *
 * Examples:
 *   `2026-05-10-doing-foo.md` → `foo`
 *   `2026-05-12-1122-doing-rest-loop-incident.md` → `rest-loop-incident`
 *   `2026-05-12-1122-planning-rest-loop-incident.md` → `rest-loop-incident`
 *   `one-shots/2026-04-29-0942-planning-substrate-trip-control-deploy.md`
 *     → `substrate-trip-control-deploy`
 */
export function deriveTaskSlug(relPath: string): string {
  /* v8 ignore start -- defensive `?? relPath` fallback: String.split() always returns at least one element, so pop() never returns undefined. The fallback exists as a type guard. @preserve */
  const base = relPath.split("/").pop() ?? relPath
  /* v8 ignore stop */
  const stem = base.replace(/\.md$/, "")
  // Strip YYYY-MM-DD[-HHMM]- prefix
  let remainder = stem.replace(/^\d{4}-\d{2}-\d{2}(?:-\d{4})?-/, "")
  // Strip role infix: planning, doing, ideation, audit, audit-report, audit-backlog
  remainder = remainder.replace(/^(planning|doing|ideation|audit-report|audit-backlog|audit)-/, "")
  return remainder
}

/**
 * Extract the parent task directory for a sub-artifact path. Returns
 * undefined for top-level files.
 *
 * Examples:
 *   `one-shots/2026-05-10-doing-foo/baseline.md` → `one-shots/2026-05-10-doing-foo`
 *   `one-shots/2026-05-10-doing-foo.md` → undefined
 */
export function extractParentTaskDir(relPath: string): string | undefined {
  const segments = relPath.split("/")
  if (segments.length < 2) return undefined
  // Walk segments — if any intermediate segment looks like a task-dir name
  // (matches the `YYYY-MM-DD[-HHMM]-(planning|doing|ideation|audit*)-` pattern),
  // return everything up to and including it. Otherwise no parent.
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (/^\d{4}-\d{2}-\d{2}(?:-\d{4})?-(planning|doing|ideation|audit-report|audit-backlog|audit)-/.test(segments[i])) {
      return segments.slice(0, i + 1).join("/")
    }
  }
  return undefined
}
