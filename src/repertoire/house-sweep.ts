import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { FileFriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { readStewardPolicy } from "../heart/steward-policy"
import { readEscalationGrants } from "../a2a/escalation-grants"
import type { ToolContext } from "./tools-base"

/**
 * The Butler's daily house-care sweep, gathered in one deterministic read so the model does not chain a dozen calls:
 * stalled or failed downloads and missing episodes and movies (Sonarr and Radarr), failed imports, disk and parity,
 * container state against the steward policy, and grants that expire or no longer work. It changes nothing in the
 * house. Its only writes are its own bookkeeping under `state/house-sweep/`: when each queue item last moved, and
 * which findings the owner has already been told about, so a repeat finding is not repeated unless it changed.
 */

export const STALL_MIN_AGE_HOURS = 6
export const CAPACITY_PERCENT = 90
export const CRITICAL_CAPACITY_PERCENT = 98
export const TEMPERATURE_C = 50
export const PARITY_MAX_AGE_DAYS = 45
export const MISSING_GRACE_DAYS = 3
export const FAILED_HISTORY_DAYS = 3
export const GRANT_WARNING_DAYS = 7
export const REMIND_DAYS = 7
export const LIST_CAP = 8
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export type FindingArea = "downloads" | "imports" | "missing" | "disk" | "parity" | "containers" | "grants" | "sweep"
export type FindingSeverity = "info" | "warn" | "critical"

export interface Finding {
  id: string
  area: FindingArea
  severity: FindingSeverity
  summary: string
  /** "fix": a tool the Butler already holds may settle it; "owner": it needs the owner's choice. A fix that does not settle it becomes an owner item. */
  next: "fix" | "owner"
  fix?: { tool: string; args: Record<string, unknown>; note: string }
  refs?: { service: "sonarr" | "radarr"; queueId: number }
  /** Changes when the finding's facts change; drives the "already told the owner" check. */
  fingerprint: string
  alreadyReported: boolean
}

export interface HouseSweepReport {
  checkedAt: string
  scope: "live" | "replay"
  queue: Record<"sonarr" | "radarr", { total: number; stalled: number; importProblems: number } | { unavailable: string }>
  sources: Record<"sonarr" | "radarr" | "host" | "policy" | "grants", "ok" | string>
  host?: { array: string | null; arrayUsedPercent: number | null; parity: string | null; parityAgeDays: number | null; containers: number }
  findings: Finding[]
  omitted: number
  fresh: string[]
  digest_due: boolean
  digest_draft: string
  guidance: string
}

export interface HouseSweepDeps {
  agentRoot: string
  sanctuary?: ToolContext["sanctuary"]
  fetch?: typeof fetch
  now?: () => number
  credentialsPath?: string
  /** A replay identity's sweep treats every finding as new and never touches the owner's "already told" ledger. */
  replay?: boolean
}

type Dict = Record<string, unknown>
const dict = (value: unknown): Dict => (value && typeof value === "object" && !Array.isArray(value) ? value as Dict : {})
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string => (typeof value === "string" ? value : "")
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const lower = (value: unknown): string => text(value).toLowerCase()
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 3)}...` : value)
const fingerprintOf = (id: string, detail: string): string => createHash("sha256").update(`${id}\0${detail}`).digest("hex").slice(0, 12)

// ---- bookkeeping -------------------------------------------------------------------------------------------------

export const houseSweepDir = (agentRoot: string): string => path.join(agentRoot, "state", "house-sweep")

function readJson(file: string): Dict {
  try { return dict(JSON.parse(fs.readFileSync(file, "utf8"))) } catch { return {} }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const progressPath = (agentRoot: string): string => path.join(houseSweepDir(agentRoot), "queue-progress.json")
export const ledgerPath = (agentRoot: string): string => path.join(houseSweepDir(agentRoot), "reported.json")
export const lastReportPath = (agentRoot: string, scope: "live" | "replay"): string => path.join(houseSweepDir(agentRoot), scope === "live" ? "last-report.json" : "last-report-replay.json")

export interface LedgerEntry { fingerprint: string; reportedAt: string }
export const readLedger = (agentRoot: string): Record<string, LedgerEntry> => dict(readJson(ledgerPath(agentRoot)).entries) as Record<string, LedgerEntry>
export const writeLedger = (agentRoot: string, entries: Record<string, LedgerEntry>): void => writeJson(ledgerPath(agentRoot), { schemaVersion: 1, entries })

// ---- Sonarr and Radarr -------------------------------------------------------------------------------------------

interface ArrCredentials { url: string; apiKey: string }

function readCredentials(file: string): Record<"sonarr" | "radarr", ArrCredentials | null> {
  const parsed = readJson(file)
  const pick = (name: string): ArrCredentials | null => {
    const entry = dict(parsed[name])
    return text(entry.url) && text(entry.apiKey) ? { url: text(entry.url).replace(/\/+$/u, ""), apiKey: text(entry.apiKey) } : null
  }
  return { sonarr: pick("sonarr"), radarr: pick("radarr") }
}

async function arrGet(service: string, creds: ArrCredentials, pathAndQuery: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(`${creds.url}/api/v3${pathAndQuery}`, { headers: { "X-Api-Key": creds.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${service} answered HTTP ${response.status}`)
  return response.json()
}

const records = (payload: unknown): Dict[] => (Array.isArray(payload) ? payload : list(dict(payload).records)).map(dict)

/** The same notion of "stuck" the replay gate applies to a queue record: Sonarr flags it, or a partial download with no ETA has sat for hours. */
export function queueProblem(item: Dict, nowMs: number): string | null {
  const flagged = (value: unknown): boolean => ["warning", "error", "failed"].includes(lower(value))
  const messages = list(item.statusMessages).flatMap((entry) => [text(dict(entry).title), ...list(dict(entry).messages).map(text)]).filter(Boolean)
  const errorMessage = text(item.errorMessage)
  if (flagged(item.trackedDownloadStatus) || flagged(item.status) || messages.length > 0) {
    return clip(errorMessage || messages[0] || `status ${text(item.trackedDownloadStatus) || text(item.status)}`, 140)
  }
  const size = num(item.size) ?? 0
  const left = num(item.sizeleft) ?? 0
  const noEta = item.timeleft === undefined || item.timeleft === null || item.timeleft === "00:00:00"
  const addedAt = Date.parse(text(item.added))
  if (size > 0 && left > 0 && noEta && Number.isFinite(addedAt) && nowMs - addedAt >= STALL_MIN_AGE_HOURS * HOUR_MS) return "partial download with no ETA"
  return null
}

interface ArrSummary {
  queue: { total: number; stalled: number; importProblems: number }
  findings: Omit<Finding, "alreadyReported">[]
}

const nameOf = (service: "sonarr" | "radarr", item: Dict): string =>
  text(service === "sonarr" ? dict(item.series).title : dict(item.movie).title) || text(item.title) || "an unknown title"

function summarizeArr(service: "sonarr" | "radarr", queuePayload: unknown, missingPayload: unknown, historyPayload: unknown, nowMs: number, progress: Dict, nextProgress: Dict): ArrSummary {
  const label = service === "sonarr" ? "Sonarr" : "Radarr"
  const items = records(queuePayload)
  const findings: ArrSummary["findings"] = []
  let stalled = 0
  let importProblems = 0
  const inFlight = new Set<number>()
  for (const item of items) {
    const queueId = num(item.id)
    if (queueId === null) continue
    const subjectId = num(service === "sonarr" ? item.seriesId : item.movieId)
    if (subjectId !== null) inFlight.add(subjectId)
    const key = `${service}:${queueId}`
    const left = num(item.sizeleft) ?? 0
    const previous = dict(progress[key])
    const since = previous.sizeleft === left && Number.isFinite(Date.parse(text(previous.since))) ? text(previous.since) : new Date(nowMs).toISOString()
    nextProgress[key] = { sizeleft: left, since }
    const frozen = left > 0 && nowMs - Date.parse(since) >= STALL_MIN_AGE_HOURS * HOUR_MS
    const problem = queueProblem(item, nowMs) ?? (frozen ? `no progress for ${Math.floor((nowMs - Date.parse(since)) / HOUR_MS)}h` : null)
    const importState = lower(item.trackedDownloadState)
    const importBlocked = importState === "importfailed" || importState === "importblocked"
    if (problem === null && !importBlocked) continue
    const size = num(item.size) ?? 0
    const percent = size > 0 ? Math.round(((size - left) / size) * 100) : 0
    const name = nameOf(service, item)
    const release = clip(text(item.title), 80)
    const refs = { service, queueId }
    if (importBlocked) {
      importProblems += 1
      const id = `imports:${service}:${queueId}`
      findings.push({ id, area: "imports", severity: "warn", next: "owner", refs, summary: `${label} cannot import ${name} (${release}): ${problem ?? importState}`, fingerprint: fingerprintOf(id, importState) })
      continue
    }
    stalled += 1
    const id = `downloads:${service}:${queueId}`
    const series = service === "sonarr" && subjectId !== null
    findings.push({
      id, area: "downloads", severity: "warn", refs,
      next: series ? "fix" : "owner",
      summary: `${label} download of ${name} is stuck at ${percent}% (${release}): ${problem}`,
      fingerprint: fingerprintOf(id, problem!.startsWith("no progress") ? "frozen" : problem!),
      ...(series ? { fix: { tool: "media_fill_missing", args: { service_id: subjectId }, note: "keeps the partial download; replaces it only when a seeded alternative is grabbed" } } : {}),
    })
  }

  // Failed downloads Sonarr or Radarr recorded recently (the queue row is gone, the episode or movie may still be missing).
  for (const event of records(historyPayload)) {
    const when = Date.parse(text(event.date))
    const eventId = num(event.id)
    if (eventId === null || !Number.isFinite(when) || nowMs - when > FAILED_HISTORY_DAYS * DAY_MS) continue
    const subjectId = num(service === "sonarr" ? event.seriesId : event.movieId)
    if (subjectId !== null && inFlight.has(subjectId)) continue
    const id = `downloads:${service}:failed:${eventId}`
    const series = service === "sonarr" && subjectId !== null
    findings.push({
      id, area: "downloads", severity: "warn", next: series ? "fix" : "owner",
      summary: `${label} recorded a failed download: ${clip(text(event.sourceTitle), 90)}`,
      fingerprint: fingerprintOf(id, "failed"),
      ...(series ? { fix: { tool: "media_fill_missing", args: { service_id: subjectId }, note: "looks for another release" } } : {}),
    })
  }

  // Monitored but missing, and not already on its way.
  const cutoff = nowMs - MISSING_GRACE_DAYS * DAY_MS
  const missingBySubject = new Map<number, { name: string; count: number; oldest: number }>()
  for (const row of records(missingPayload)) {
    if (service === "radarr" && row.isAvailable === false) continue
    const subjectId = service === "sonarr" ? num(row.seriesId) : num(row.id)
    const stamp = Date.parse(text(service === "sonarr" ? row.airDateUtc : row.added))
    if (subjectId === null || inFlight.has(subjectId) || row.monitored === false || !Number.isFinite(stamp) || stamp > cutoff) continue
    const name = (service === "sonarr" ? text(dict(row.series).title) : text(row.title)) || "an unknown title"
    const seen = missingBySubject.get(subjectId)
    missingBySubject.set(subjectId, { name, count: (seen?.count ?? 0) + 1, oldest: Math.min(seen?.oldest ?? stamp, stamp) })
  }
  for (const [subjectId, entry] of [...missingBySubject].sort((a, b) => a[1].oldest - b[1].oldest)) {
    const id = `missing:${service}:${subjectId}`
    const series = service === "sonarr"
    const days = Math.floor((nowMs - entry.oldest) / DAY_MS)
    findings.push({
      id, area: "missing", severity: "info", next: "fix",
      summary: series ? `${entry.name}: ${entry.count} monitored episode${entry.count === 1 ? "" : "s"} missing, the oldest aired ${days} days ago` : `${entry.name}: monitored movie still missing after ${days} days`,
      fingerprint: fingerprintOf(id, String(entry.count)),
      fix: series
        ? { tool: "media_fill_missing", args: { service_id: subjectId }, note: "searches, grabs a seeded release, imports what finished" }
        : { tool: "media_search_now", args: { kind: "movie", service_id: subjectId }, note: "triggers a Radarr search" },
    })
  }
  return { queue: { total: items.length, stalled, importProblems }, findings }
}

// ---- the host, the policy and the grants -------------------------------------------------------------------------

function okData(result: unknown): Dict | null {
  const value = dict(result)
  return value.ok === true ? dict(value.data) : null
}

type HostSummary = NonNullable<HouseSweepReport["host"]>

async function sweepHost(sanctuary: NonNullable<HouseSweepDeps["sanctuary"]>, policyStates: Record<string, Dict> | null, nowMs: number, findings: Omit<Finding, "alreadyReported">[]): Promise<{ summary: HostSummary; problem: string | null }> {
  const [containersResult, storageResult, disksResult] = await Promise.all([sanctuary.listContainers(), sanctuary.getStorage(), sanctuary.getDisks()])
  const containers = okData(containersResult)
  const storage = okData(storageResult)
  const disks = okData(disksResult)
  const unavailable = [containers ? "" : "containers", storage ? "" : "storage", disks ? "" : "disks"].filter(Boolean)
  const summary: HostSummary = { array: null, arrayUsedPercent: null, parity: null, parityAgeDays: null, containers: 0 }

  for (const container of list(containers?.containers).map(dict)) {
    summary.containers += 1
    const name = text(container.name)
    const state = text(container.state)
    const desired = policyStates ? dict(policyStates[`container:${name}`]) : {}
    const expires = Date.parse(text(desired.expiresAt))
    const value = Object.keys(desired).length > 0 && !(Number.isFinite(expires) && expires <= nowMs) ? lower(desired.value) : ""
    const wantedOn = ["on", "always_on", "expected_on"].includes(value)
    const wantedOff = /^(?:off|disabled|paused|intentionally_off|intentionally_paused)$/u.test(value)
    const running = state === "running"
    const id = `containers:${name}`
    if (wantedOn && !running) findings.push({ id, area: "containers", severity: "critical", next: "owner", summary: `${name} should be on by the steward policy but is ${state}`, fingerprint: fingerprintOf(id, `down:${state}`) })
    else if (wantedOff && running) findings.push({ id, area: "containers", severity: "warn", next: "owner", summary: `${name} should be off by the steward policy but is running`, fingerprint: fingerprintOf(id, "up") })
    else if (!value && container.autostart === true && !running) findings.push({ id, area: "containers", severity: "warn", next: "owner", summary: `${name} starts with the array but is ${state}, and the policy says nothing about it`, fingerprint: fingerprintOf(id, `down:${state}`) })
  }

  const arrayInfo = dict(storage?.array)
  summary.array = text(arrayInfo.state) || null
  summary.arrayUsedPercent = num(arrayInfo.usedPercent)
  const capacity = (id: string, label: string, percent: number | null): void => {
    if (percent === null || percent < CAPACITY_PERCENT) return
    findings.push({ id, area: "disk", severity: percent >= CRITICAL_CAPACITY_PERCENT ? "critical" : "warn", next: "owner", summary: `${label} is ${percent}% full`, fingerprint: fingerprintOf(id, String(Math.floor(percent))) })
  }
  capacity("disk:array:capacity", "the array", summary.arrayUsedPercent)
  for (const share of list(storage?.shares).map(dict)) capacity(`disk:share:${text(share.name)}:capacity`, `share ${text(share.name)}`, num(share.usedPercent))
  if (storage && summary.array && summary.array.toUpperCase() !== "STARTED") findings.push({ id: "disk:array:state", area: "disk", severity: "critical", next: "owner", summary: `the array is ${summary.array}`, fingerprint: fingerprintOf("disk:array:state", summary.array) })

  for (const disk of list(disks?.disks).map(dict)) {
    const id = `disk:${text(disk.id)}`
    if (disk.smart === "failed") findings.push({ id: `${id}:smart`, area: "disk", severity: "critical", next: "owner", summary: `${text(disk.name)} reports a failed SMART status`, fingerprint: fingerprintOf(`${id}:smart`, "failed") })
    const temperature = num(disk.temperatureC)
    if (temperature !== null && temperature >= TEMPERATURE_C) findings.push({ id: `${id}:temperature`, area: "disk", severity: "warn", next: "owner", summary: `${text(disk.name)} is ${temperature}C`, fingerprint: fingerprintOf(`${id}:temperature`, String(Math.floor(temperature / 5))) })
  }
  const parity = dict(disks?.parity)
  summary.parity = text(parity.result) || null
  const ageHours = num(parity.ageHours)
  summary.parityAgeDays = ageHours === null ? null : Math.floor(ageHours / 24)
  if (disks) {
    const result = summary.parity
    if (result === "failed") findings.push({ id: "parity:result", area: "parity", severity: "critical", next: "owner", summary: `the last parity check failed (${num(parity.errors) ?? "unknown"} errors)`, fingerprint: fingerprintOf("parity:result", `failed:${num(parity.errors)}`) })
    else if (result !== "in_progress" && (summary.parityAgeDays === null || summary.parityAgeDays >= PARITY_MAX_AGE_DAYS)) findings.push({ id: "parity:age", area: "parity", severity: "warn", next: "owner", summary: summary.parityAgeDays === null ? "parity check age is unknown" : `the last parity check was ${summary.parityAgeDays} days ago`, fingerprint: fingerprintOf("parity:age", summary.parityAgeDays === null ? "unknown" : "old") })
  }
  return { summary, problem: unavailable.length > 0 ? `${unavailable.join(", ")} unreadable` : null }
}

async function sweepGrants(agentRoot: string, policy: ReturnType<typeof readStewardPolicy> | null, nowMs: number, findings: Omit<Finding, "alreadyReported">[]): Promise<string> {
  const expiry = (id: string, label: string, expiresAt: unknown): void => {
    const at = Date.parse(text(expiresAt))
    if (!Number.isFinite(at) || at - nowMs > GRANT_WARNING_DAYS * DAY_MS) return
    const days = Math.floor((at - nowMs) / DAY_MS)
    findings.push({ id, area: "grants", severity: at <= nowMs ? "warn" : "info", next: "owner", summary: at <= nowMs ? `${label} expired` : `${label} expires in ${days} days`, fingerprint: fingerprintOf(id, at <= nowMs ? "expired" : "soon") })
  }
  for (const [key, grant] of Object.entries(policy?.routineActionGrants ?? {})) expiry(`grants:routine:${key}`, `the standing permission ${key}`, grant.expiresAt)
  for (const [key, entry] of Object.entries(policy?.desiredStates ?? {})) expiry(`grants:desired:${key}`, `the standing expectation ${key}`, entry.expiresAt)
  try {
    const friends = await new FileFriendStore(path.join(agentRoot, "friends")).listAll()
    const escalation = readEscalationGrants(agentRoot)
    const active = (friend: { trustLevel?: string; admissionState?: string }): boolean => friend.trustLevel === "family" && friend.admissionState === "active"
    for (const friend of friends) {
      const delegation = friend.delegationGrant
      if (delegation) {
        expiry(`grants:delegation:${friend.id}`, `${friend.name}'s delegation grant`, (delegation as { expiresAt?: unknown }).expiresAt)
        if (!active(friend)) findings.push({ id: `grants:delegation:${friend.id}:inert`, area: "grants", severity: "info", next: "owner", summary: `${friend.name} holds a delegation grant but is no longer an active family friend, so it does nothing`, fingerprint: fingerprintOf(`grants:delegation:${friend.id}:inert`, "inert") })
      }
      const held = escalation[friend.id]
      if (held) {
        expiry(`grants:escalation:${friend.id}`, `${friend.name}'s escalation grant`, (held as { expiresAt?: unknown }).expiresAt)
        if (!active(friend)) findings.push({ id: `grants:escalation:${friend.id}:inert`, area: "grants", severity: "info", next: "owner", summary: `${friend.name} holds an escalation grant but is no longer an active family friend, so reports cannot reach them`, fingerprint: fingerprintOf(`grants:escalation:${friend.id}:inert`, "inert") })
      }
    }
    return "ok"
  } catch (error) {
    return `friends unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

// ---- the sweep ---------------------------------------------------------------------------------------------------

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warn: 1, info: 2 }

export async function runHouseSweep(deps: HouseSweepDeps): Promise<HouseSweepReport> {
  const now = deps.now ?? Date.now
  const nowMs = now()
  const fetchImpl = deps.fetch ?? fetch
  const scope: "live" | "replay" = deps.replay ? "replay" : "live"
  const findings: Omit<Finding, "alreadyReported">[] = []
  const sources: HouseSweepReport["sources"] = { sonarr: "ok", radarr: "ok", host: "ok", policy: "ok", grants: "ok" }
  const queue: HouseSweepReport["queue"] = { sonarr: { unavailable: "not read" }, radarr: { unavailable: "not read" } }
  const unavailable = (source: keyof HouseSweepReport["sources"], reason: string): void => {
    sources[source] = reason
    findings.push({ id: `sweep:${source}`, area: "sweep", severity: "warn", next: "owner", summary: `the sweep could not read ${source}: ${clip(reason, 120)}`, fingerprint: fingerprintOf(`sweep:${source}`, "unavailable") })
  }

  const credentials = readCredentials(deps.credentialsPath ?? path.join(deps.agentRoot, "mcp", "media-credentials.json"))
  const progress = dict(readJson(progressPath(deps.agentRoot)).items)
  const nextProgress: Dict = {}
  for (const service of ["sonarr", "radarr"] as const) {
    const creds = credentials[service]
    if (!creds) { queue[service] = { unavailable: "no credentials" }; unavailable(service, "no credentials in the media credential file"); continue }
    try {
      const sonarr = service === "sonarr"
      const [queuePayload, missingPayload, historyPayload] = await Promise.all([
        arrGet(service, creds, sonarr ? "/queue?pageSize=200&includeSeries=true" : "/queue?pageSize=200&includeMovie=true", fetchImpl),
        arrGet(service, creds, sonarr ? "/wanted/missing?pageSize=500&monitored=true&includeSeries=true&sortKey=airDateUtc&sortDirection=ascending" : "/wanted/missing?pageSize=500&monitored=true", fetchImpl),
        arrGet(service, creds, "/history?pageSize=50&eventType=4&sortKey=date&sortDirection=descending", fetchImpl),
      ])
      const summary = summarizeArr(service, queuePayload, missingPayload, historyPayload, nowMs, progress, nextProgress)
      queue[service] = summary.queue
      findings.push(...summary.findings)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      queue[service] = { unavailable: clip(reason, 120) }
      unavailable(service, reason)
    }
  }
  // A source that could not be read keeps its last known progress, so one bad morning does not reset every stall clock.
  for (const service of ["sonarr", "radarr"] as const) {
    if ("unavailable" in queue[service]) for (const [key, value] of Object.entries(progress)) if (key.startsWith(`${service}:`)) nextProgress[key] = value
  }
  writeJson(progressPath(deps.agentRoot), { schemaVersion: 1, items: nextProgress })

  let policy: ReturnType<typeof readStewardPolicy> | null = null
  try { policy = readStewardPolicy(deps.agentRoot) } catch (error) { unavailable("policy", error instanceof Error ? error.message : String(error)) }

  let host: HouseSweepReport["host"]
  if (!deps.sanctuary) unavailable("host", "the Unraid read runtime is not attached to this turn")
  else {
    try {
      const swept = await sweepHost(deps.sanctuary, policy ? policy.desiredStates as unknown as Record<string, Dict> : null, nowMs, findings)
      host = swept.summary
      if (swept.problem) unavailable("host", swept.problem)
    } catch (error) {
      unavailable("host", error instanceof Error ? error.message : String(error))
    }
  }
  const grantsStatus = await sweepGrants(deps.agentRoot, policy, nowMs, findings)
  if (grantsStatus !== "ok") unavailable("grants", grantsStatus)

  // What the owner has already been told. A replay sweep reads and writes none of it.
  const ledger = deps.replay ? {} : readLedger(deps.agentRoot)
  const ordered = findings
    .map((finding): Finding => {
      const told = ledger[finding.id]
      const recent = told !== undefined && told.fingerprint === finding.fingerprint && nowMs - Date.parse(told.reportedAt) < REMIND_DAYS * DAY_MS
      return { ...finding, alreadyReported: recent }
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id))
  if (!deps.replay) {
    // A finding that is gone is forgotten, so it is told again if it comes back.
    const present = new Set(ordered.map((finding) => finding.id))
    const kept = Object.fromEntries(Object.entries(ledger).filter(([id]) => present.has(id)))
    if (Object.keys(kept).length !== Object.keys(ledger).length) writeLedger(deps.agentRoot, kept)
  }

  const fresh = ordered.filter((finding) => !finding.alreadyReported)
  const shown = ordered.slice(0, LIST_CAP * 3)
  const shownIds = new Set(shown.map((finding) => finding.id))
  const report: HouseSweepReport = {
    checkedAt: new Date(nowMs).toISOString(),
    scope,
    queue,
    sources,
    ...(host ? { host } : {}),
    findings: shown,
    omitted: ordered.length - shown.length,
    fresh: fresh.filter((finding) => shownIds.has(finding.id)).map((finding) => finding.id),
    digest_due: fresh.length > 0,
    digest_draft: draftDigest(fresh.filter((finding) => shownIds.has(finding.id))),
    guidance: "Try every finding with a fix first (the fix never deletes a partial download). Anything still unsettled, and every finding without a fix, goes in ONE short digest with house_digest_send using the finding ids. If digest_due is false, say nothing to the owner. Never remove a download or delete anything.",
  }
  writeJson(lastReportPath(deps.agentRoot, scope), { schemaVersion: 1, at: report.checkedAt, findings: shown.map((finding) => ({ id: finding.id, fingerprint: finding.fingerprint, summary: finding.summary })) })
  emitNervesEvent({ component: "repertoire", event: "repertoire.house_sweep_run", message: "house sweep gathered", meta: { scope, findings: ordered.length, fresh: fresh.length, digestDue: report.digest_due } })
  return report
}

export function draftDigest(findings: readonly Pick<Finding, "summary">[]): string {
  if (findings.length === 0) return ""
  return findings.slice(0, LIST_CAP).map((finding) => `- ${finding.summary}`).join("\n") + (findings.length > LIST_CAP ? `\n- and ${findings.length - LIST_CAP} more` : "")
}
