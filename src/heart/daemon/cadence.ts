import { emitNervesEvent } from "../../nerves/runtime"

export const DEFAULT_CADENCE_MS = 30 * 60 * 1000 // 30 minutes

export interface CadenceDueState {
  due: boolean
  elapsedMs: number
  occurrenceId: string | null
}

interface FixedDailyCron {
  minute: number
  hour: number
}

function parseFixedDailyCron(raw: unknown): FixedDailyCron | null {
  if (typeof raw !== "string") return null
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minuteRaw = parts[0]!
  const hourRaw = parts[1]!
  const day = parts[2]
  const month = parts[3]
  const weekday = parts[4]
  if (day !== "*" || month !== "*" || weekday !== "*") return null
  if (!/^\d+$/.test(minuteRaw) || !/^\d+$/.test(hourRaw)) return null
  const minute = Number.parseInt(minuteRaw!, 10)
  const hour = Number.parseInt(hourRaw!, 10)
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null
  return { minute, hour }
}

function coerceTimeMs(value: number | string | Date): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function localOccurrenceForDay(referenceMs: number, fixed: FixedDailyCron): Date {
  const occurrence = new Date(referenceMs)
  occurrence.setHours(fixed.hour, fixed.minute, 0, 0)
  return occurrence
}

function previousFixedDailyOccurrence(fixed: FixedDailyCron, nowMs: number): Date {
  const occurrence = localOccurrenceForDay(nowMs, fixed)
  if (occurrence.getTime() > nowMs) {
    occurrence.setDate(occurrence.getDate() - 1)
  }
  return occurrence
}

function nextFixedDailyOccurrence(fixed: FixedDailyCron, fromMs: number): Date {
  const occurrence = localOccurrenceForDay(fromMs, fixed)
  if (occurrence.getTime() <= fromMs) {
    occurrence.setDate(occurrence.getDate() + 1)
  }
  return occurrence
}

/**
 * Parse a cadence shorthand (e.g. "30m", "2h", "1d") into a cron string.
 * Also accepts raw cron strings (5 space-separated fields) and passes them through.
 * Returns null for invalid input.
 */
export function parseCadenceToCron(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (!value) return null

  // Cron format (minute hour day month weekday)
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(value)) {
    return value
  }

  const cadenceMatch = /^(\d+)(m|h|d)$/.exec(value)
  if (!cadenceMatch) return null

  const interval = Number.parseInt(cadenceMatch[1], 10)
  if (!Number.isFinite(interval) || interval <= 0) return null

  emitNervesEvent({
    event: "daemon.cadence_parsed",
    component: "daemon",
    message: "parsed cadence shorthand to cron",
    meta: { raw: value, interval, unit: cadenceMatch[2] },
  })

  const unit = cadenceMatch[2]
  if (unit === "m") return `*/${interval} * * * *`
  if (unit === "h") return `0 */${interval} * * *`
  return `0 0 */${interval} * *`
}

/**
 * Parse a cadence shorthand (e.g. "30m", "2h", "1d") into milliseconds.
 * Returns null for invalid input.
 */
export function parseCadenceToMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (!value) return null

  const match = /^(\d+)(m|h|d)$/.exec(value)
  if (!match) return null

  const interval = Number.parseInt(match[1], 10)
  if (!Number.isFinite(interval) || interval <= 0) return null

  emitNervesEvent({
    event: "daemon.cadence_parsed_ms",
    component: "daemon",
    message: "parsed cadence shorthand to milliseconds",
    meta: { raw: value, interval, unit: match[2] },
  })

  const unit = match[2]
  if (unit === "m") return interval * 60 * 1000
  if (unit === "h") return interval * 60 * 60 * 1000
  return interval * 24 * 60 * 60 * 1000
}

export function nextCadenceRunAt(raw: unknown, from: number | string | Date): string | null {
  const fromMs = coerceTimeMs(from)
  if (fromMs === null) return null

  const intervalMs = parseCadenceToMs(raw)
  if (intervalMs !== null) {
    return new Date(fromMs + intervalMs).toISOString()
  }

  const fixed = parseFixedDailyCron(raw)
  if (!fixed) return null
  const next = nextFixedDailyOccurrence(fixed, fromMs)
  emitNervesEvent({
    event: "daemon.fixed_cadence_next_run_computed",
    component: "daemon",
    message: "computed fixed daily cadence next run",
    meta: { raw, nextRunAt: next.toISOString() },
  })
  return next.toISOString()
}

export function cadenceFallbackDelayMs(raw: unknown, nowMs: number): number | null {
  const intervalMs = parseCadenceToMs(raw)
  if (intervalMs !== null) return intervalMs

  const nextRunAt = nextCadenceRunAt(raw, nowMs)
  if (!nextRunAt) return null
  const delay = Date.parse(nextRunAt) - nowMs
  return delay
}

export function evaluateCadenceDue(raw: unknown, lastRun: string | null, nowMs: number): CadenceDueState | null {
  const intervalMs = parseCadenceToMs(raw)
  if (intervalMs !== null) {
    if (lastRun === null) {
      return { due: true, elapsedMs: Infinity, occurrenceId: `overdue:first-run:${String(raw).trim()}` }
    }
    const lastRunMs = Date.parse(lastRun)
    if (!Number.isFinite(lastRunMs)) return { due: false, elapsedMs: 0, occurrenceId: null }
    const elapsedMs = nowMs - lastRunMs
    return {
      due: elapsedMs >= intervalMs,
      elapsedMs,
      occurrenceId: elapsedMs >= intervalMs ? `overdue:last-run:${lastRun}:cadence:${String(raw).trim()}` : null,
    }
  }

  const fixed = parseFixedDailyCron(raw)
  if (!fixed) return null
  const occurrence = previousFixedDailyOccurrence(fixed, nowMs)
  const elapsedMs = lastRun === null ? Infinity : nowMs - occurrence.getTime()
  const todayOccurrence = localOccurrenceForDay(nowMs, fixed)
  const hasReachedTodayOccurrence = todayOccurrence.getTime() <= nowMs
  const lastRunMs = lastRun === null ? null : Date.parse(lastRun)
  const due = lastRunMs === null
    ? hasReachedTodayOccurrence
    : Number.isFinite(lastRunMs) && lastRunMs < occurrence.getTime()
  return {
    due,
    elapsedMs,
    occurrenceId: due ? `fixed-daily:${occurrence.toISOString()}:cadence:${String(raw).trim()}` : null,
  }
}
