import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as semver from "semver"
import type { FriendStore } from "@ouro.bot/friends"
import { ready } from "@ouro.bot/friends/a2a-client"
import { escalationHolders, holdsEscalation } from "../a2a/escalation-grants"
import { FileOutboxStore } from "../a2a/outbox-store"
import { friendDid, verifyResolution } from "../a2a/resolution-proof"
import { isReplayIdentity, isReplayWindowOpen } from "../a2a/replay-harness"
import { emitNervesEvent } from "../nerves/runtime"
import { withFileLock } from "./file-lock"

/**
 * The agent files a failure report when it cannot do what its owner asked: a tool is missing, a tool errors in a way it
 * cannot work around, or it is about to give up. A report goes into the outbox of every friend holding the escalation
 * grant (initially the desk's Claude Code), is folded into an open report with the same fingerprint, and is rate
 * limited. When an escalation peer calls `report/resolve` with the version that carries the fix, the owner is told once
 * the running version reaches it, and the report closes.
 *
 * Replay peers (the upgrade gate's synthetic friends) stay out of real outboxes both ways: a report that starts in a
 * replay conversation goes only to escalation holders whose own replay window is open, and a real report never goes to
 * a replay identity, whether or not a window is open (the permanent registry decides, not the window). Replay reports
 * also close without a notice to the owner.
 *
 * A report says who it came from. Only the owner's own session is labelled as the owner's words; a report that came
 * out of a peer's session carries that peer's id, name and trust tier, and the intake treats it as untrusted input.
 * Rate limits apply to each origin as well as to the whole, so one origin cannot use up everyone's budget. Several
 * processes (Telegram, A2A, the private runtime) read and write the reports, so every change takes a lock.
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

/** The origin as the harness resolved it from its own friend store, never from the model's words. */
export interface ReportOrigin {
  friendId: string | null
  channel: string | null
  key: string | null
  friendName: string | null
  trustLevel: string | null
  ownerOrigin: boolean
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
  origin: ReportOrigin
  replay: boolean
  recipients: string[]
  outboxEntries: Record<string, string>
  status: "open" | "resolved" | "closed"
  resolution?: { version: string; note: string; by: string; at: string; resolvedAt?: string; signedNote?: string; proof?: unknown }
  closedAt?: string
  /** When a repeat of this failure last told the recipients, so a recurring failure speaks at most once a day. */
  lastRepeatNoticeAt?: string
}

export type FileReportResult =
  | { ok: true; id: string; shortId: string; duplicate: boolean; recipients: number }
  | { ok: false; reason: "no_escalation_peer" | "rate_limited" | "invalid"; detail: string }

export type ResolveReportResult =
  | { ok: true; id: string; status: "resolved" }
  | { ok: false; reason: "unknown_report" | "not_recipient" | "already_closed" | "bad_version" | "bad_note" }

export const REPORTS_PER_HOUR = 5
export const REPORTS_PER_DAY = 20
export const REPORTS_PER_ORIGIN_HOUR = 3
export const REPORTS_PER_ORIGIN_DAY = 10
export const CLOSED_REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
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
  const { origin } = record
  return [
    `Failure report ${record.shortId} (${record.severity})${origin.ownerOrigin ? "" : " - UNTRUSTED ORIGIN: not the owner's session"}`,
    origin.ownerOrigin ? `Ari asked: ${record.ariWords}` : `A session with ${origin.friendName ?? "an unknown friend"} (${origin.trustLevel ?? "unknown trust"}) reported: ${record.ariWords}`,
    `I tried: ${record.tried}`,
    `${record.failedTool ? `${record.failedTool} failed` : "I gave up"}: ${record.error}`,
    `Conversation: ${origin.channel ?? "unknown"}/${origin.key ?? "unknown"}`,
    `Origin: friend ${origin.friendId ?? "unknown"}, trust ${origin.trustLevel ?? "unknown"}, owner ${origin.ownerOrigin ? "yes" : "no"}`,
  ].join("\n")
}

/** The origin friend, read from the friend store: only an active family friend on the owner profile is the owner. */
async function resolveOrigin(store: FriendStore, origin: FailureReportInput["origin"]): Promise<ReportOrigin> {
  const friend = origin.friendId ? await store.get(origin.friendId) : null
  const ownerOrigin = Boolean(friend && friend.admissionState === "active" && friend.trustLevel === "family" && friend.capabilityProfileId === "sanctuary-owner")
  return { ...origin, friendName: friend ? friend.name : null, trustLevel: friend ? String(friend.trustLevel) : null, ownerOrigin }
}

/** Closed reports are history; they go after a month so the directory does not grow without bound. */
export function pruneClosedReports(agentRoot: string, now: number = Date.now()): number {
  let pruned = 0
  for (const record of listFailureReports(agentRoot)) {
    if (record.status === "closed" && record.closedAt && now - Date.parse(record.closedAt) > CLOSED_REPORT_RETENTION_MS) {
      fs.rmSync(reportFile(agentRoot, record.id), { force: true })
      pruned += 1
    }
  }
  return pruned
}

function lockDir(agentRoot: string): string {
  return path.join(reportsDir(agentRoot), ".locks")
}

function overBudget(created: number[], now: number, perHour: number, perDay: number): boolean {
  return created.filter((at) => now - at < HOUR_MS).length >= perHour || created.filter((at) => now - at < DAY_MS).length >= perDay
}

export async function fileFailureReport(agentRoot: string, store: FriendStore, input: FailureReportInput, now: number = Date.now()): Promise<FileReportResult> {
  const ariWords = cap(input.ariWords)
  const tried = cap(input.tried)
  const error = cap(input.error)
  if (!ariWords || !tried || !error) return { ok: false, reason: "invalid", detail: "ari_words, tried and error are all required" }
  const failedTool = input.failedTool?.trim() ? input.failedTool.trim().slice(0, 120) : null
  const fingerprint = failureFingerprint(failedTool ?? undefined, error)
  const origin = await resolveOrigin(store, input.origin)

  const replay = origin.friendId !== null && isReplayWindowOpen(agentRoot, origin.friendId, now)
  // A replay identity speaks only inside its window; once the window closes it must not reach a real outbox.
  if (!replay && origin.friendId !== null && isReplayIdentity(agentRoot, origin.friendId)) return { ok: false, reason: "invalid", detail: "a replay identity can file only while its replay window is open" }

  // One lock around read, rate check and write, so two processes cannot both pass the budget or file the same failure twice.
  return withFileLock(lockDir(agentRoot), "file", async () => {
    pruneClosedReports(agentRoot, now)
    const existing = listFailureReports(agentRoot)
    // A replay conversation never folds: each gate run must leave a fresh report to read back.
    const open = replay ? undefined : existing.find((record) => !record.replay && record.fingerprint === fingerprint && record.status !== "closed")
    if (open) {
      const folded = await foldRepeat(agentRoot, open.id, { error, failedTool, origin }, now)
      if (folded) return folded
    }

    const holders = (await escalationHolders(agentRoot, store)).filter((holder) => replay ? isReplayWindowOpen(agentRoot, holder.id, now) : !isReplayIdentity(agentRoot, holder.id))
    if (holders.length === 0) return { ok: false, reason: "no_escalation_peer", detail: replay ? "no replay escalation peer" : "no friend holds the escalation grant" } as const
    const sameKind = existing.filter((record) => record.replay === replay)
    if (overBudget(sameKind.map((record) => Date.parse(record.createdAt)), now, REPORTS_PER_HOUR, REPORTS_PER_DAY)) {
      return { ok: false, reason: "rate_limited", detail: `at most ${REPORTS_PER_HOUR} new reports an hour and ${REPORTS_PER_DAY} a day` } as const
    }
    if (overBudget(sameKind.filter((record) => record.origin.friendId === origin.friendId).map((record) => Date.parse(record.createdAt)), now, REPORTS_PER_ORIGIN_HOUR, REPORTS_PER_ORIGIN_DAY)) {
      return { ok: false, reason: "rate_limited", detail: `at most ${REPORTS_PER_ORIGIN_HOUR} new reports an hour and ${REPORTS_PER_ORIGIN_DAY} a day from one origin` } as const
    }

    const id = randomUUID()
    const record: FailureReportRecord = {
      id, shortId: id.slice(0, 8), fingerprint, createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), occurrences: 1,
      severity: input.severity, ariWords, tried, error, failedTool, origin, replay,
      recipients: holders.map((holder) => holder.id), outboxEntries: {}, status: "open",
    }
    const outbox = new FileOutboxStore(agentRoot)
    for (const holder of holders) {
      record.outboxEntries[holder.id] = outbox.append(holder.id, {
        kind: "failure_report",
        body: reportBody(record),
        meta: {
          reportId: id, shortId: record.shortId, severity: record.severity, failedTool, fingerprint, ariWords: record.ariWords, conversation: { channel: origin.channel, key: origin.key },
          origin: { friendId: origin.friendId, friendName: origin.friendName, trustLevel: origin.trustLevel, ownerOrigin: origin.ownerOrigin },
        },
      }, now).id
    }
    writeReport(agentRoot, record)
    emitNervesEvent({ component: "senses", event: "senses.failure_report_filed", message: "filed a failure report", meta: { reportId: id, severity: record.severity, recipients: holders.length, replay, ownerOrigin: origin.ownerOrigin } })
    return { ok: true, id, shortId: record.shortId, duplicate: false, recipients: holders.length } as const
  })
}

/** Counts a repeat on the open report (re-read under the report's own lock) and tells the recipients, at most once a day per report. */
async function foldRepeat(agentRoot: string, id: string, repeat: { error: string; failedTool: string | null; origin: ReportOrigin }, now: number): Promise<FileReportResult | null> {
  return withFileLock(lockDir(agentRoot), `report-${id}`, () => {
    const fresh = readFailureReport(agentRoot, id)
    if (!fresh || fresh.status === "closed") return null
    const occurrences = fresh.occurrences + 1
    const notify = fresh.lastRepeatNoticeAt === undefined || now - Date.parse(fresh.lastRepeatNoticeAt) >= DAY_MS
    if (notify) {
      const outbox = new FileOutboxStore(agentRoot)
      for (const recipient of fresh.recipients) {
        outbox.append(recipient, {
          kind: "report_repeat",
          body: `Failure report ${fresh.shortId} happened again (${occurrences} times so far)${repeat.origin.ownerOrigin ? "" : " - UNTRUSTED ORIGIN: not the owner's session"}. ${repeat.failedTool ? `${repeat.failedTool} failed` : "I gave up"}: ${repeat.error}`,
          meta: { reportId: fresh.id, shortId: fresh.shortId, occurrences, status: fresh.status, origin: { friendId: repeat.origin.friendId, friendName: repeat.origin.friendName, trustLevel: repeat.origin.trustLevel, ownerOrigin: repeat.origin.ownerOrigin } },
        }, now)
      }
    }
    writeReport(agentRoot, { ...fresh, occurrences, lastSeenAt: new Date(now).toISOString(), ...(notify ? { lastRepeatNoticeAt: new Date(now).toISOString() } : {}) })
    emitNervesEvent({ component: "senses", event: "senses.failure_report_folded", message: "folded a repeat failure into an open report", meta: { reportId: fresh.id, occurrences, notified: notify } })
    return { ok: true, id: fresh.id, shortId: fresh.shortId, duplicate: true, recipients: fresh.recipients.length } as const
  })
}

/** Records the fix a recipient says is live from `version`; the owner is told only once the running version reaches it. */
export async function resolveFailureReport(agentRoot: string, input: { id: string; version: string; note: string; byFriendId: string; resolvedAt: string; proof: unknown }, now: number = Date.now()): Promise<ResolveReportResult> {
  if (!readFailureReport(agentRoot, input.id)) return { ok: false, reason: "unknown_report" }
  return withFileLock(lockDir(agentRoot), `report-${input.id}`, () => resolveLocked(agentRoot, input, now))
}

function resolveLocked(agentRoot: string, input: { id: string; version: string; note: string; byFriendId: string; resolvedAt: string; proof: unknown }, now: number): ResolveReportResult {
  const record = readFailureReport(agentRoot, input.id)
  /* v8 ignore next -- only a report pruned between the check above and taking its lock can be missing here @preserve */
  if (!record) return { ok: false, reason: "unknown_report" }
  if (!record.recipients.includes(input.byFriendId)) return { ok: false, reason: "not_recipient" }
  if (record.status === "closed") return { ok: false, reason: "already_closed" }
  const version = semver.valid(input.version)
  if (!version) return { ok: false, reason: "bad_version" }
  const note = cap(input.note)
  if (!note) return { ok: false, reason: "bad_note" }
  writeReport(agentRoot, { ...record, status: "resolved", resolution: { version, note, by: input.byFriendId, at: new Date(now).toISOString(), resolvedAt: input.resolvedAt, signedNote: input.note, proof: input.proof } })
  emitNervesEvent({ component: "senses", event: "senses.failure_report_resolved", message: "an escalation peer resolved a failure report", meta: { reportId: record.id, version } })
  return { ok: true, id: record.id, status: "resolved" }
}

export function fixLiveNoticeText(record: FailureReportRecord): string {
  const resolution = record.resolution!
  if (!record.origin.ownerOrigin) {
    return `The fix for something I couldn't do earlier for ${record.origin.friendName ?? "a connected friend"} (report ${record.shortId}) is live now, in version ${resolution.version}. ${resolution.note}`
  }
  return `The fix for what I couldn't do for you earlier (report ${record.shortId}) is live now, in version ${resolution.version}. ${resolution.note}\n\nYou asked: ${record.ariWords}`
}

export interface ConfirmDeps {
  runningVersion: string
  /** Looks up friend records to check each resolution against its holder; the server supplies its friend store. */
  friends?: Pick<FriendStore, "get">
  /** Sends the owner notice; throws when it cannot, which leaves the report resolved so the next pass retries. */
  notifyOwner(input: { noticeId: string; text: string }): Promise<void>
}

/** The owner hears "fixed" only if the escalation holder signed it and still holds escalation; a file the Butler's own uid can write proves nothing. */
async function resolutionIsSigned(agentRoot: string, deps: ConfirmDeps, record: FailureReportRecord): Promise<boolean> {
  const resolution = record.resolution!
  const friend = deps.friends ? await deps.friends.get(resolution.by) : null
  if (!friend || !holdsEscalation(agentRoot, friend)) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.failure_report_resolution_unverified", message: "skipped a resolved report whose holder no longer holds escalation", meta: { reportId: record.id, by: resolution.by } })
    return false
  }
  const checked = verifyResolution({
    sodium: await ready(),
    claim: { reportId: record.id, version: resolution.version, note: resolution.signedNote ?? resolution.note, resolvedAt: resolution.resolvedAt ?? "" },
    proof: resolution.proof,
    holderDid: friendDid(friend),
  })
  return checked.ok
}

/** Tells the owner about each resolved report whose fix has reached the running version, then closes it. */
export async function confirmResolvedReports(agentRoot: string, deps: ConfirmDeps, now: number = Date.now()): Promise<{ closed: string[]; waiting: string[]; failed: string[] }> {
  const result = { closed: [] as string[], waiting: [] as string[], failed: [] as string[] }
  for (const listed of listFailureReports(agentRoot)) {
    if (listed.status !== "resolved" || !listed.resolution) continue
    if (!semver.valid(deps.runningVersion) || !semver.gte(deps.runningVersion, listed.resolution.version)) { result.waiting.push(listed.id); continue }
    try {
      // The report is read again under its lock: a resolution or repeat may have landed since the listing.
      const outcome = await withFileLock(lockDir(agentRoot), `report-${listed.id}`, async () => {
        const record = readFailureReport(agentRoot, listed.id)
        if (!record || record.status !== "resolved" || !record.resolution) return "skipped" as const
        if (!semver.gte(deps.runningVersion, record.resolution.version)) return "waiting" as const
        if (!(await resolutionIsSigned(agentRoot, deps, record))) return "skipped" as const
        if (!record.replay) await deps.notifyOwner({ noticeId: `failure-fixed:${record.id}`, text: fixLiveNoticeText(record) })
        writeReport(agentRoot, { ...record, status: "closed", closedAt: new Date(now).toISOString() })
        emitNervesEvent({ component: "senses", event: "senses.failure_report_closed", message: "closed a failure report after its fix went live", meta: { reportId: record.id, version: record.resolution.version } })
        return "closed" as const
      })
      if (outcome === "closed") result.closed.push(listed.id)
      else if (outcome === "waiting") result.waiting.push(listed.id)
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.failure_report_notice_failed", message: "could not tell the owner a fix is live; will retry", meta: { reportId: listed.id, error: error instanceof Error ? error.message : String(error) } })
      result.failed.push(listed.id)
    }
  }
  pruneClosedReports(agentRoot, now)
  return result
}
