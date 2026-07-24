import { createHash } from "crypto"
import { CronExpressionParser } from "cron-parser"

import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, sha256CanonicalJson } from "../runtime/canonical-json"

export type NormalizedHabitCadenceV1 =
  | {
      version: 1
      kind: "interval"
      intervalMs: number
      anchorUtc: string
      anchorSource: "habit-created" | "schedule-state-first-seen"
    }
  | {
      version: 1
      kind: "cron"
      expression: string
      timezone: string
      timezoneSource: "declared" | "machine-first-seen"
    }

export interface ScheduleProvenanceV1 {
  schemaVersion: 1
  recordVersion: number
  agent: string
  habitId: string
  definitionSha256: string
  cadenceText: string
  cadenceTimezone: string | null
  normalized: NormalizedHabitCadenceV1
  scheduleRevision: string
  firstSeenAt: string
  updatedAt: string
}

export interface ScheduledHabitSlotV1 {
  kind: "scheduled"
  slotKey: string
  scheduleRevision: string
  scheduledAtUtc: string
}

interface ParseOptions {
  created: string | null
  cadenceTimezone: string | null
  machineTimezone: string
  firstSeenAt: string
  prior?: ScheduleProvenanceV1 | null
}

const PORTABLE_CRON_FIELD = /^[0-9*,-/]+$/
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/

function base64UrlSha256(value: unknown): string {
  return createHash("sha256").update(Buffer.from(canonicalizeJson(value), "utf8")).digest("base64url")
}

function isoTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`Habit cadence ${label} must be a valid timestamp`)
  return new Date(milliseconds).toISOString()
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Habit cadence ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`Habit cadence ${label} fields are invalid`)
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Habit cadence ${label} must be non-empty`)
  return value
}

function validateTimezone(value: string, label: string): string {
  if (value.trim() !== value || value.length === 0) throw new Error(`Habit cadence ${label} timezone is invalid`)
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0)
  } catch {
    throw new Error(`Habit cadence ${label} timezone is not a valid IANA zone`)
  }
  return value
}

function portableCronFields(value: string): string[] {
  const trimmed = value.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "")
  if (trimmed.length === 0) throw new Error("Habit cadence is empty")
  const fields = trimmed.split(/[ \t\r\n\f\v]+/)
  if (fields.length !== 5 || fields.some((field) => field.length === 0 || !PORTABLE_CRON_FIELD.test(field))) {
    throw new Error("Habit cadence cron must contain exactly five portable numeric fields")
  }
  return fields
}

export function parseScheduleProvenanceV1(value: unknown): ScheduleProvenanceV1 {
  const raw = record(value, "schedule provenance")
  exactKeys(raw, [
    "schemaVersion",
    "recordVersion",
    "agent",
    "habitId",
    "definitionSha256",
    "cadenceText",
    "cadenceTimezone",
    "normalized",
    "scheduleRevision",
    "firstSeenAt",
    "updatedAt",
  ], "schedule provenance")
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.recordVersion) || Number(raw.recordVersion) < 1) {
    throw new Error("Habit cadence schedule provenance version is invalid")
  }
  const normalizedRaw = record(raw.normalized, "normalized schedule")
  let normalized: NormalizedHabitCadenceV1
  if (normalizedRaw.kind === "interval") {
    exactKeys(normalizedRaw, ["version", "kind", "intervalMs", "anchorUtc", "anchorSource"], "normalized interval")
    if (
      normalizedRaw.version !== 1 ||
      !Number.isSafeInteger(normalizedRaw.intervalMs) ||
      Number(normalizedRaw.intervalMs) <= 0 ||
      (normalizedRaw.anchorSource !== "habit-created" && normalizedRaw.anchorSource !== "schedule-state-first-seen")
    ) {
      throw new Error("Habit cadence normalized interval is invalid")
    }
    normalized = {
      version: 1,
      kind: "interval",
      intervalMs: Number(normalizedRaw.intervalMs),
      anchorUtc: isoTimestamp(nonEmptyString(normalizedRaw.anchorUtc, "interval anchor"), "interval anchor"),
      anchorSource: normalizedRaw.anchorSource,
    }
  } else if (normalizedRaw.kind === "cron") {
    exactKeys(normalizedRaw, ["version", "kind", "expression", "timezone", "timezoneSource"], "normalized cron")
    if (
      normalizedRaw.version !== 1 ||
      (normalizedRaw.timezoneSource !== "declared" && normalizedRaw.timezoneSource !== "machine-first-seen")
    ) {
      throw new Error("Habit cadence normalized cron is invalid")
    }
    const expression = portableCronFields(nonEmptyString(normalizedRaw.expression, "cron expression")).join(" ")
    const timezone = validateTimezone(nonEmptyString(normalizedRaw.timezone, "cron timezone"), "normalized cron")
    try {
      CronExpressionParser.parse(`0 ${expression}`, { strict: true, tz: timezone })
    } catch (error) {
      throw new Error(`Habit cadence normalized cron is invalid: ${error instanceof Error ? error.message : "parse failed"}`)
    }
    normalized = { version: 1, kind: "cron", expression, timezone, timezoneSource: normalizedRaw.timezoneSource }
  } else {
    throw new Error("Habit cadence normalized schedule kind is invalid")
  }
  const scheduleRevision = nonEmptyString(raw.scheduleRevision, "schedule revision")
  if (!BASE64URL_SHA256.test(scheduleRevision) || scheduleRevision !== base64UrlSha256(normalized)) {
    throw new Error("Habit cadence schedule revision does not match normalized provenance")
  }
  const definitionSha256 = nonEmptyString(raw.definitionSha256, "definition SHA-256")
  if (!/^[0-9a-f]{64}$/.test(definitionSha256)) throw new Error("Habit cadence definition SHA-256 is invalid")
  const cadenceText = nonEmptyString(raw.cadenceText, "cadence text")
  const cadenceTimezone = raw.cadenceTimezone === null
    ? null
    : validateTimezone(nonEmptyString(raw.cadenceTimezone, "declared timezone"), "declared")
  const firstSeenAt = isoTimestamp(nonEmptyString(raw.firstSeenAt, "firstSeenAt"), "firstSeenAt")
  const updatedAt = isoTimestamp(nonEmptyString(raw.updatedAt, "updatedAt"), "updatedAt")
  if (Date.parse(updatedAt) < Date.parse(firstSeenAt)) throw new Error("Habit cadence updatedAt precedes firstSeenAt")
  return {
    schemaVersion: 1,
    recordVersion: Number(raw.recordVersion),
    agent: nonEmptyString(raw.agent, "agent"),
    habitId: nonEmptyString(raw.habitId, "habit ID"),
    definitionSha256,
    cadenceText,
    cadenceTimezone,
    normalized,
    scheduleRevision,
    firstSeenAt,
    updatedAt,
  }
}

export function parseHabitCadenceV1(raw: unknown, options: ParseOptions): NormalizedHabitCadenceV1 {
  if (typeof raw !== "string") throw new Error("Habit cadence must be a string")
  const value = raw.trim()
  const interval = /^([1-9][0-9]*)([mhd])$/.exec(value)
  if (interval) {
    const count = Number(interval[1])
    const factor = interval[2] === "m" ? 60_000 : interval[2] === "h" ? 3_600_000 : 86_400_000
    const intervalMs = count * factor
    if (!Number.isSafeInteger(intervalMs)) throw new Error("Habit cadence interval exceeds the safe range")
    if (options.created !== null) {
      return {
        version: 1,
        kind: "interval",
        intervalMs,
        anchorUtc: isoTimestamp(options.created, "created"),
        anchorSource: "habit-created",
      }
    }
    const priorAnchor = options.prior?.normalized.kind === "interval" &&
      options.prior.normalized.anchorSource === "schedule-state-first-seen"
      ? options.prior.normalized.anchorUtc
      : null
    return {
      version: 1,
      kind: "interval",
      intervalMs,
      anchorUtc: priorAnchor ?? isoTimestamp(options.firstSeenAt, "firstSeenAt"),
      anchorSource: "schedule-state-first-seen",
    }
  }

  const expression = portableCronFields(raw).join(" ")
  const inheritedTimezone = options.prior?.normalized.kind === "cron" &&
    options.prior.normalized.timezoneSource === "machine-first-seen"
    ? options.prior.normalized.timezone
    : null
  const timezoneSource = options.cadenceTimezone === null ? "machine-first-seen" : "declared"
  const timezone = validateTimezone(options.cadenceTimezone ?? inheritedTimezone ?? options.machineTimezone, timezoneSource)
  try {
    CronExpressionParser.parse(`0 ${expression}`, { strict: true, tz: timezone })
  } catch (error) {
    throw new Error(`Habit cadence cron is invalid: ${error instanceof Error ? error.message : "parse failed"}`)
  }
  return { version: 1, kind: "cron", expression, timezone, timezoneSource }
}

export function reconcileScheduleProvenanceV1(input: {
  prior: ScheduleProvenanceV1 | null
  agent: string
  habitId: string
  cadence: string
  cadenceTimezone: string | null
  created: string | null
  machineTimezone: string
  now: string
}): ScheduleProvenanceV1 {
  const now = isoTimestamp(input.now, "reconciliation time")
  const definitionSha256 = sha256CanonicalJson({
    cadence: input.cadence,
    cadenceTimezone: input.cadenceTimezone,
    created: input.created,
  })
  if (input.prior && (input.prior.agent !== input.agent || input.prior.habitId !== input.habitId)) {
    throw new Error("Habit cadence prior provenance belongs to another habit")
  }
  if (input.prior?.definitionSha256 === definitionSha256) return parseScheduleProvenanceV1(input.prior)
  const normalized = parseHabitCadenceV1(input.cadence, {
    created: input.created,
    cadenceTimezone: input.cadenceTimezone,
    machineTimezone: input.machineTimezone,
    firstSeenAt: input.prior?.firstSeenAt ?? now,
    prior: input.prior,
  })
  const result: ScheduleProvenanceV1 = {
    schemaVersion: 1,
    recordVersion: (input.prior?.recordVersion ?? 0) + 1,
    agent: input.agent,
    habitId: input.habitId,
    definitionSha256,
    cadenceText: input.cadence,
    cadenceTimezone: input.cadenceTimezone,
    normalized,
    scheduleRevision: base64UrlSha256(normalized),
    firstSeenAt: input.prior?.firstSeenAt ?? now,
    updatedAt: now,
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.habit_schedule_provenance_reconciled",
    message: "reconciled canonical habit schedule provenance",
    meta: { agent: result.agent, habitId: result.habitId, scheduleRevision: result.scheduleRevision },
  })
  return parseScheduleProvenanceV1(result)
}

export function scheduledSlotAtOrBefore(
  schedule: ScheduleProvenanceV1,
  nowInput: string,
): ScheduledHabitSlotV1 | null {
  const now = isoTimestamp(nowInput, "slot time")
  const nowMs = Date.parse(now)
  let scheduledAtUtc: string
  if (schedule.normalized.kind === "interval") {
    const anchorMs = Date.parse(schedule.normalized.anchorUtc)
    if (nowMs < anchorMs) return null
    const ordinal = Math.floor((nowMs - anchorMs) / schedule.normalized.intervalMs)
    scheduledAtUtc = new Date(anchorMs + ordinal * schedule.normalized.intervalMs).toISOString()
  } else {
    const expression = CronExpressionParser.parse(`0 ${schedule.normalized.expression}`, {
      strict: true,
      tz: schedule.normalized.timezone,
      currentDate: new Date(nowMs + 1),
    })
    const previous = expression.prev().toISOString()
    if (previous === null) throw new Error("Habit cadence cron did not produce a prior slot")
    scheduledAtUtc = previous
  }
  const identity = occurrenceIdentityForScheduledSlot(schedule.agent, schedule.habitId, {
    scheduleRevision: schedule.scheduleRevision,
    scheduledAtUtc,
  })
  return {
    kind: "scheduled",
    slotKey: identity.slotKey,
    scheduleRevision: schedule.scheduleRevision,
    scheduledAtUtc,
  }
}

export function occurrenceIdentityForScheduledSlot(
  agent: string,
  habitId: string,
  slot: Pick<ScheduledHabitSlotV1, "scheduleRevision" | "scheduledAtUtc">,
): { slotKey: string; occurrenceId: string } {
  const slotKey = base64UrlSha256({
    schemaVersion: 1,
    agent,
    habitId,
    scheduleRevision: slot.scheduleRevision,
    scheduledAtUtc: isoTimestamp(slot.scheduledAtUtc, "scheduledAtUtc"),
  })
  return { slotKey, occurrenceId: `occ_${slotKey}` }
}
