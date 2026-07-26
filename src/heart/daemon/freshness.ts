/**
 * Pipeline freshness — "is this pipe still moving?"
 *
 * Every outage this module exists to prevent had the same shape: a health
 * check verified that something was *configured* or *connected*, and reported
 * a green tick next to a pipe that had been dead for weeks.
 *
 *   - mail: `mail enabled` / `mail config ok` / `45479 messages` all passed
 *     while zero mail had been ingested for 77 days after a vault key rotation
 *     changed the mailbox keyIds. The message count is cumulative, so it can
 *     only ever go up — it is not a liveness signal.
 *   - bluebubbles: the upstream HTTP probe stayed `ok` for days while inbound
 *     delivery was dead, because the server was POSTing its webhook to a
 *     stale port. A reachable upstream does not prove inbound delivery.
 *   - launchd: checks asserted a plist *file* existed rather than that the
 *     job was loaded.
 *
 * The fix is to assert on *observed data flow*, with three rules baked into
 * this primitive:
 *
 *   1. Age is always stated in the message, in human units, with the
 *      timestamp it was derived from.
 *   2. "Never observed any activity" and "could not observe" are distinct
 *      states from "activity, but stale" — and none of them can read as
 *      `pass`. An unobservable pipe is unverified, not healthy.
 *   3. Every non-`pass` result carries a concrete remediation hint.
 *
 * Thresholds are always supplied by the caller so freshness policy lives with
 * the pipe it describes, not in this file.
 */

import { emitNervesEvent } from "../../nerves/runtime"

export const FRESHNESS_MINUTE_MS = 60 * 1000
export const FRESHNESS_HOUR_MS = 60 * FRESHNESS_MINUTE_MS
export const FRESHNESS_DAY_MS = 24 * FRESHNESS_HOUR_MS

/** Small tolerance before a future timestamp is treated as clock skew. */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = FRESHNESS_MINUTE_MS

/** Result status for a freshness check. Matches `DoctorCheckStatus`. */
export type FreshnessStatus = "pass" | "warn" | "fail"

/**
 * What the freshness probe actually saw. Deliberately not collapsed into a
 * single nullable timestamp: `never` and `unknown` mean different things to
 * an operator and must never be silently rendered as healthy.
 */
export type FreshnessState =
  /** Activity within the warn threshold. */
  | "fresh"
  /** Activity observed, but older than the warn (or fail) threshold. */
  | "stale"
  /** The store was readable and has never recorded any activity. */
  | "never"
  /** The store could not be read, so freshness is unverified. */
  | "unknown"
  /** The newest activity is timestamped in the future — clock skew. */
  | "future"

/** A single observation of "when did this pipe last move?". */
export type FreshnessObservation =
  /** Activity was observed at `atMs` (epoch ms). */
  | { kind: "activity"; atMs: number }
  /** The store was readable and contains no activity at all. */
  | { kind: "none" }
  /** The store could not be observed; freshness is unverified. */
  | { kind: "unknown"; reason: string }

/** Age boundaries at which a pipe stops being considered healthy. */
export interface FreshnessThresholds {
  /** Age at or beyond which the pipe warns. */
  warnAfterMs: number
  /** Age at or beyond which the pipe fails. */
  failAfterMs: number
}

export interface FreshnessInput {
  /** Verb phrase for the flow, e.g. `"mail ingested"`. */
  activity: string
  /** Noun for one unit of flow, e.g. `"message"`. */
  unit: string
  /** What the probe saw. */
  observation: FreshnessObservation
  /** Current time in epoch ms. Injected so tests are deterministic. */
  nowMs: number
  thresholds: FreshnessThresholds
  /** Concrete, actionable fix appended to every non-`pass` detail. */
  remediation: string
  /**
   * Epoch ms since which this pipe has been configured and expected to
   * deliver. Used only for the `never` state, so a pipe wired up five minutes
   * ago is not reported with the same severity as one that has never
   * delivered in three months. Omit when unknown — `never` then fails.
   */
  configuredSinceMs?: number | null
  /**
   * How the timestamp was derived, plus any bound on the work performed.
   * Surfaced verbatim so a bounded scan can never masquerade as exhaustive.
   */
  provenance?: string
  /** Extra context prefixed to the detail, e.g. contrast with a green probe. */
  context?: string
  /** Override the skew tolerance before a future timestamp warns. */
  clockSkewToleranceMs?: number
}

export interface FreshnessResult {
  status: FreshnessStatus
  state: FreshnessState
  /** Age of the newest activity in ms; null for `never` / `unknown`. */
  ageMs: number | null
  /** Human-readable, actionable one-liner for a doctor check detail. */
  detail: string
}

/**
 * Human-readable duration. Always rounds down so the age is never overstated:
 * "77 days" means at least 77 days have elapsed.
 */
export function formatFreshnessAge(ms: number): string {
  const clamped = Math.max(0, ms)
  const seconds = Math.floor(clamped / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.floor(clamped / FRESHNESS_MINUTE_MS)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.floor(clamped / FRESHNESS_HOUR_MS)
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`
  // The day bucket only starts at 48h, so it is always plural.
  return `${Math.floor(clamped / FRESHNESS_DAY_MS)} days`
}

/** Minute-precision ISO instant — keeps the incident date visible and unambiguous. */
export function formatFreshnessTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z")
}

function joinDetail(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part && part.trim().length > 0).join("; ")
}

function statusForAge(ageMs: number, thresholds: FreshnessThresholds): FreshnessStatus {
  if (ageMs >= thresholds.failAfterMs) return "fail"
  if (ageMs >= thresholds.warnAfterMs) return "warn"
  return "pass"
}

/**
 * Severity for "readable store, nothing ever recorded".
 *
 * Floors at `warn` on purpose: a configured-but-never-delivered pipe is never
 * healthy, but a pipe wired up minutes ago does not deserve a hard failure.
 */
function statusForNever(input: FreshnessInput): { status: FreshnessStatus; configuredForMs: number | null } {
  const since = input.configuredSinceMs
  if (typeof since !== "number" || !Number.isFinite(since)) {
    return { status: "fail", configuredForMs: null }
  }
  const configuredForMs = Math.max(0, input.nowMs - since)
  const escalated = statusForAge(configuredForMs, input.thresholds)
  return { status: escalated === "pass" ? "warn" : escalated, configuredForMs }
}

function evaluateActivity(input: FreshnessInput, atMs: number): FreshnessResult {
  const tolerance = input.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS
  const skewMs = atMs - input.nowMs
  const timestamp = formatFreshnessTimestamp(atMs)

  if (skewMs > tolerance) {
    return {
      status: "warn",
      state: "future",
      ageMs: 0,
      detail: joinDetail([
        input.context,
        `last ${input.unit} is timestamped ${timestamp}, ${formatFreshnessAge(skewMs)} in the future — clock skew means freshness cannot be trusted`,
        input.provenance,
        `fix: ${input.remediation}`,
      ]),
    }
  }

  const ageMs = Math.max(0, -skewMs)
  const status = statusForAge(ageMs, input.thresholds)
  if (status === "pass") {
    return {
      status,
      state: "fresh",
      ageMs,
      detail: joinDetail([
        input.context,
        `${input.activity} ${formatFreshnessAge(ageMs)} ago (last ${input.unit} ${timestamp})`,
        input.provenance,
      ]),
    }
  }

  return {
    status,
    state: "stale",
    ageMs,
    detail: joinDetail([
      input.context,
      `no ${input.activity} in ${formatFreshnessAge(ageMs)} — last ${input.unit} ${timestamp}`,
      input.provenance,
      `fix: ${input.remediation}`,
    ]),
  }
}

/**
 * Turn a single observation into a status + actionable detail.
 *
 * The only path that can return `pass` is an observed activity timestamp
 * inside the warn threshold. Everything else — no activity, unreadable store,
 * skewed clock — is surfaced, never swallowed.
 */
export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const observation = input.observation

  if (observation.kind === "unknown") {
    return {
      status: "fail",
      state: "unknown",
      ageMs: null,
      detail: joinDetail([
        input.context,
        `${input.activity}: last-activity time could not be determined — ${observation.reason}; unverified, not healthy`,
        input.provenance,
        `fix: ${input.remediation}`,
      ]),
    }
  }

  if (observation.kind === "none") {
    const { status, configuredForMs } = statusForNever(input)
    return {
      status,
      state: "never",
      ageMs: null,
      detail: joinDetail([
        input.context,
        configuredForMs === null
          ? `no ${input.activity} ever — the store is readable and empty`
          : `no ${input.activity} ever — the store is readable and empty, and this pipe has been configured for ${formatFreshnessAge(configuredForMs)}`,
        input.provenance,
        `fix: ${input.remediation}`,
      ]),
    }
  }

  if (!Number.isFinite(observation.atMs)) {
    return evaluateFreshness({
      ...input,
      observation: { kind: "unknown", reason: `observed timestamp is not a finite epoch-ms value (${String(observation.atMs)})` },
    })
  }

  return evaluateActivity(input, observation.atMs)
}

/** Filesystem seam used by the observation helpers. */
export interface FreshnessFsDeps {
  existsSync: (p: string) => boolean
  readdirSync: (p: string) => string[]
  statSync: (p: string) => { mtimeMs: number }
}

export interface FreshnessProbe {
  observation: FreshnessObservation
  /** Human-readable note on how the observation was derived and what it cost. */
  provenance: string
}

/**
 * Last-write probe for **create-per-event** stores — one new file per event,
 * such as the mailroom's `messages/<id>.json`.
 *
 * A directory's mtime advances whenever an entry is created or removed, so it
 * is an exact answer to "when was a file last added here" for O(1) cost, with
 * no per-entry stat. That matters: the production mailroom holds ~45k message
 * files and must never be stat-walked by a health check.
 *
 * It is also the semantically *correct* signal here. A message's `receivedAt`
 * is when the mail was sent, not when this machine ingested it — an mbox
 * backfill writes month-old `receivedAt` values today — so parsing message
 * bodies would answer a different question than "is the pipe moving?".
 *
 * `hasEntries` is supplied by the caller (which typically already lists the
 * directory for a count) so an empty directory reports `none` rather than
 * reporting its own creation time as activity.
 */
export function observeCreatePerEventStore(
  dir: string,
  deps: FreshnessFsDeps,
  options: { hasEntries: boolean },
): FreshnessProbe {
  const provenance = `derived from ${dir} directory mtime (O(1), no per-entry scan)`
  if (!deps.existsSync(dir)) {
    return { observation: { kind: "none" }, provenance: `${dir} does not exist` }
  }
  if (!options.hasEntries) {
    return { observation: { kind: "none" }, provenance: `${dir} is empty` }
  }
  try {
    return { observation: { kind: "activity", atMs: deps.statSync(dir).mtimeMs }, provenance }
  } catch (error) {
    return {
      observation: { kind: "unknown", reason: `${dir} could not be stat'd: ${error instanceof Error ? error.message : String(error)}` },
      provenance,
    }
  }
}

export interface AppendPerEventStoreOptions {
  /** Only entries with this suffix are considered. */
  suffix: string
  /** Hard bound on how many entries get stat'd. */
  maxEntries: number
}

/**
 * Last-write probe for **append-per-event** stores — a small set of long-lived
 * logs appended in place, such as the BlueBubbles inbound ndjson (one file per
 * chat).
 *
 * Directory mtime is the wrong signal here: appending to an existing file does
 * not touch its parent directory, so a busy-but-not-growing log set would look
 * frozen. This stats each matching entry and takes the newest.
 *
 * The scan is bounded by `maxEntries`. When the bound is hit the provenance
 * says so explicitly — a bounded scan must never masquerade as exhaustive.
 */
export function observeAppendPerEventStore(
  dir: string,
  deps: FreshnessFsDeps,
  options: AppendPerEventStoreOptions,
): FreshnessProbe {
  if (!deps.existsSync(dir)) {
    return { observation: { kind: "none" }, provenance: `${dir} does not exist` }
  }

  let entries: string[]
  try {
    entries = deps.readdirSync(dir).filter((name) => name.endsWith(options.suffix))
  } catch (error) {
    return {
      observation: { kind: "unknown", reason: `${dir} could not be listed: ${error instanceof Error ? error.message : String(error)}` },
      provenance: `attempted directory listing of ${dir}`,
    }
  }

  if (entries.length === 0) {
    return { observation: { kind: "none" }, provenance: `${dir} holds no ${options.suffix} logs` }
  }

  const scanned = entries.slice(0, options.maxEntries)
  const truncated = entries.length > scanned.length
  const provenance = truncated
    ? `newest mtime across the first ${scanned.length} of ${entries.length} ${options.suffix} logs in ${dir} — scan bounded, newer activity may exist in the unscanned ${entries.length - scanned.length}`
    : `newest mtime across ${scanned.length} ${options.suffix} log${scanned.length === 1 ? "" : "s"} in ${dir}`

  let newest = Number.NEGATIVE_INFINITY
  const failures: string[] = []
  for (const name of scanned) {
    try {
      const mtimeMs = deps.statSync(`${dir}/${name}`).mtimeMs
      if (mtimeMs > newest) newest = mtimeMs
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (newest === Number.NEGATIVE_INFINITY) {
    return {
      observation: { kind: "unknown", reason: `none of the ${scanned.length} log(s) in ${dir} could be stat'd: ${failures.slice(0, 3).join("; ")}` },
      provenance,
    }
  }

  return {
    observation: { kind: "activity", atMs: newest },
    provenance: failures.length > 0 ? `${provenance} (${failures.length} unreadable and skipped)` : provenance,
  }
}

/** Optional per-pipe threshold override, as written in `agent.json`. */
export interface FreshnessThresholdOverride {
  warnAfterHours?: number
  failAfterHours?: number
}

/**
 * Merge an `agent.json` override onto in-repo defaults.
 *
 * Configuration lives in a committed config file rather than an environment
 * variable, per the repo configuration policy. Non-positive and non-finite
 * values are ignored so a malformed override can never disable the check.
 */
export function resolveFreshnessThresholds(
  defaults: FreshnessThresholds,
  override: unknown,
): FreshnessThresholds {
  const record = override && typeof override === "object" && !Array.isArray(override)
    ? override as Record<string, unknown>
    : null
  const hours = (key: string): number | null => {
    const value = record?.[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * FRESHNESS_HOUR_MS : null
  }
  return {
    warnAfterMs: hours("warnAfterHours") ?? defaults.warnAfterMs,
    failAfterMs: hours("failAfterHours") ?? defaults.failAfterMs,
  }
}

/* v8 ignore start -- module load observability event */
emitNervesEvent({
  component: "daemon",
  event: "daemon.pipeline_freshness_loaded",
  message: "pipeline freshness primitive loaded",
  meta: {},
})
/* v8 ignore stop */
