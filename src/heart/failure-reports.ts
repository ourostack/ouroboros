import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as semver from "semver"
import type { FriendStore } from "@ouro.bot/friends"
import { escalationHolders } from "../a2a/escalation-grants"
import { FileOutboxStore } from "../a2a/outbox-store"
import { isReplayWindowOpen } from "../a2a/replay-harness"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The agent files a failure report when it cannot do what its owner asked: a tool is missing, a tool errors in a way it
 * cannot work around, or it is about to give up. A report goes into the outbox of every friend holding the escalation
 * grant (initially the desk's Claude Code), is folded into an open report with the same fingerprint, and is rate
 * limited. When an escalation peer calls `report/resolve` with the version that carries the fix, the owner is told once
 * the running version reaches it, and the report closes.
 *
 * Replay peers (the upgrade gate's synthetic friends) stay out of real outboxes both ways: a report that starts in a
 * replay conversation goes only to escalation holders whose own replay window is open, and a real report never goes to
 * one. Replay reports also close without a notice to the owner.
 */
export type FailureSeverity = "low" | "medium" | "high"

export interface FailureReportInput {
  ariWords: string
  tried: string
  error: string
  failedTool?: string
  severity: FailureSeverity
  origin: { friendId: string | null; channel: string | null; key: string | null }
}

export interface FailureReportRecord {
  id: string
  shortId: string
  fingerprint: string
  createdAt: string
  lastSeenAt: string
  occurrences: number
  severity: FailureSeverity
  ariWords: string
  tried: string
  error: string
  failedTool: string | null
  origin: FailureReportInput["origin"]
  replay: boolean
  recipients: string[]
  outboxEntries: Record<string, string>
  status: "open" | "resolved" | "closed"
  resolution?: { version: string; note: string; by: string; at: string }
  closedAt?: string
}

export type FileReportResult =
  | { ok: true; id: string; shortId: string; duplicate: boolean; recipients: number }
  | { ok: false; reason: "no_escalation_peer" | "rate_limited" | "invalid"; detail: string }

export type ResolveReportResult =
  | { ok: true; id: string; status: "resolved" }
  | { ok: false; reason: "unknown_report" | "not_recipient" | "already_closed" | "bad_version" | "bad_note" }

export const REPORTS_PER_HOUR = 5
export const REPORTS_PER_DAY = 20
const FIELD_MAX_CHARS = 2_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export function reportsDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "reports")
}

function reportFile(agentRoot: string, id: string): string {
  return path.join(reportsDir(agentRoot), `${id}.json`)
}

function cap(value: string): string {
  return value.trim().slice(0, FIELD_MAX_CHARS)
}

/** The same failure reads the same: numbers, ids and paths are blanked so a retry with a new request id folds in. */
export function errorClass(error: string): string {
  return error.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>")
    .replace(/(?:\/[\w.@-]+){2,}/gu, "<path>")
    .replace(/\d+/gu, "<n>")
    .replace(/\s+/gu, " ").trim().slice(0, 80)
}

export function failureFingerprint(failedTool: string | undefined, error: string): string {
  return createHash("sha256").update(`${(failedTool ?? "").trim().toLowerCase()}\0${errorClass(error)}`).digest("hex").slice(0, 16)
}

export function readFailureReport(agentRoot: string, id: string): FailureReportRecord | null {
  if (!REPORT_ID.test(id)) return null
  try {
    return JSON.parse(fs.readFileSync(reportFile(agentRoot, id), "utf8")) as FailureReportRecord
  } catch {
    return null
  }
}

function writeReport(agentRoot: string, record: FailureReportRecord): void {
  fs.mkdirSync(reportsDir(agentRoot), { recursive: true })
  const file = reportFile(agentRoot, record.id)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function listFailureReports(agentRoot: string): FailureReportRecord[] {
  let names: string[]
  try {
    names = fs.readdirSync(reportsDir(agentRoot))
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
    const record = readFailureReport(agentRoot, name.slice(0, -5))
    return record ? [record] : []
  })
}

export function reportBody(record: Pick<FailureReportRecord, "shortId" | "severity" | "ariWords" | "tried" | "error" | "failedTool" | "origin">): string {
  return [
    `Failure report ${record.shortId} (${record.severity})`,
    `Ari asked: ${record.ariWords}`,
    `I tried: ${record.tried}`,
    `${record.failedTool ? `${record.failedTool} failed` : "I gave up"}: ${record.error}`,
    `Conversation: ${record.origin.channel ?? "unknown"}/${record.origin.key ?? "unknown"}`,
  ].join("\n")
}

export async function fileFailureReport(agentRoot: string, store: FriendStore, input: FailureReportInput, now: number = Date.now()): Promise<FileReportResult> {
  const ariWords = cap(input.ariWords)
  const tried = cap(input.tried)
  const error = cap(input.error)
  if (!ariWords || !tried || !error) return { ok: false, reason: "invalid", detail: "ari_words, tried and error are all required" }
  const failedTool = input.failedTool?.trim() ? input.failedTool.trim().slice(0, 120) : null
  const fingerprint = failureFingerprint(failedTool ?? undefined, error)
  const existing = listFailureReports(agentRoot)

  const replay = input.origin.friendId !== null && isReplayWindowOpen(agentRoot, input.origin.friendId, now)
  // A replay conversation never folds: each gate run must leave a fresh report to read back.
  const open = replay ? undefined : existing.find((record) => !record.replay && record.fingerprint === fingerprint && record.status !== "closed")
  if (open) {
    writeReport(agentRoot, { ...open, occurrences: open.occurrences + 1, lastSeenAt: new Date(now).toISOString() })
    emitNervesEvent({ component: "senses", event: "senses.failure_report_folded", message: "folded a repeat failure into an open report", meta: { reportId: open.id, occurrences: open.occurrences + 1 } })
    return { ok: true, id: open.id, shortId: open.shortId, duplicate: true, recipients: open.recipients.length }
  }

  const holders = (await escalationHolders(agentRoot, store)).filter((holder) => isReplayWindowOpen(agentRoot, holder.id, now) === replay)
  if (holders.length === 0) return { ok: false, reason: "no_escalation_peer", detail: replay ? "no replay escalation peer" : "no friend holds the escalation grant" }
  const created = existing.filter((record) => record.replay === replay).map((record) => Date.parse(record.createdAt))
  if (created.filter((at) => now - at < HOUR_MS).length >= REPORTS_PER_HOUR || created.filter((at) => now - at < DAY_MS).length >= REPORTS_PER_DAY) {
    return { ok: false, reason: "rate_limited", detail: `at most ${REPORTS_PER_HOUR} new reports an hour and ${REPORTS_PER_DAY} a day` }
  }

  const id = randomUUID()
  const record: FailureReportRecord = {
    id, shortId: id.slice(0, 8), fingerprint, createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), occurrences: 1,
    severity: input.severity, ariWords, tried, error, failedTool, origin: input.origin, replay,
    recipients: holders.map((holder) => holder.id), outboxEntries: {}, status: "open",
  }
  const outbox = new FileOutboxStore(agentRoot)
  for (const holder of holders) {
    record.outboxEntries[holder.id] = outbox.append(holder.id, {
      kind: "failure_report",
      body: reportBody(record),
      meta: { reportId: id, shortId: record.shortId, severity: record.severity, failedTool, fingerprint, conversation: { channel: input.origin.channel, key: input.origin.key } },
    }, now).id
  }
  writeReport(agentRoot, record)
  emitNervesEvent({ component: "senses", event: "senses.failure_report_filed", message: "filed a failure report", meta: { reportId: id, severity: record.severity, recipients: holders.length, replay } })
  return { ok: true, id, shortId: record.shortId, duplicate: false, recipients: holders.length }
}

/** Records the fix a recipient says is live from `version`; the owner is told only once the running version reaches it. */
export function resolveFailureReport(agentRoot: string, input: { id: string; version: string; note: string; byFriendId: string }, now: number = Date.now()): ResolveReportResult {
  const record = readFailureReport(agentRoot, input.id)
  if (!record) return { ok: false, reason: "unknown_report" }
  if (!record.recipients.includes(input.byFriendId)) return { ok: false, reason: "not_recipient" }
  if (record.status === "closed") return { ok: false, reason: "already_closed" }
  const version = semver.valid(input.version)
  if (!version) return { ok: false, reason: "bad_version" }
  const note = cap(input.note)
  if (!note) return { ok: false, reason: "bad_note" }
  writeReport(agentRoot, { ...record, status: "resolved", resolution: { version, note, by: input.byFriendId, at: new Date(now).toISOString() } })
  emitNervesEvent({ component: "senses", event: "senses.failure_report_resolved", message: "an escalation peer resolved a failure report", meta: { reportId: record.id, version } })
  return { ok: true, id: record.id, status: "resolved" }
}

export function fixLiveNoticeText(record: FailureReportRecord): string {
  const resolution = record.resolution!
  return `The fix for what I couldn't do for you earlier (report ${record.shortId}) is live now, in version ${resolution.version}. ${resolution.note}\n\nYou asked: ${record.ariWords}`
}

export interface ConfirmDeps {
  runningVersion: string
  /** Sends the owner notice; throws when it cannot, which leaves the report resolved so the next pass retries. */
  notifyOwner(input: { noticeId: string; text: string }): Promise<void>
}

/** Tells the owner about each resolved report whose fix has reached the running version, then closes it. */
export async function confirmResolvedReports(agentRoot: string, deps: ConfirmDeps, now: number = Date.now()): Promise<{ closed: string[]; waiting: string[]; failed: string[] }> {
  const result = { closed: [] as string[], waiting: [] as string[], failed: [] as string[] }
  for (const record of listFailureReports(agentRoot)) {
    if (record.status !== "resolved" || !record.resolution) continue
    if (!semver.valid(deps.runningVersion) || !semver.gte(deps.runningVersion, record.resolution.version)) { result.waiting.push(record.id); continue }
    if (!record.replay) {
      try {
        await deps.notifyOwner({ noticeId: `failure-fixed:${record.id}`, text: fixLiveNoticeText(record) })
      } catch (error) {
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.failure_report_notice_failed", message: "could not tell the owner a fix is live; will retry", meta: { reportId: record.id, error: error instanceof Error ? error.message : String(error) } })
        result.failed.push(record.id)
        continue
      }
    }
    writeReport(agentRoot, { ...record, status: "closed", closedAt: new Date(now).toISOString() })
    emitNervesEvent({ component: "senses", event: "senses.failure_report_closed", message: "closed a failure report after its fix went live", meta: { reportId: record.id, version: record.resolution.version } })
    result.closed.push(record.id)
  }
  return result
}
