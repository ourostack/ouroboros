import { emitNervesEvent } from "../../nerves/runtime"

export const DEFAULT_CADENCE_MS = 30 * 60 * 1000 // 30 minutes

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
