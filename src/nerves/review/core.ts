import * as fs from "node:fs"

export interface NerveReviewFilter {
  componentSubstring?: string
  eventSubstring?: string
  level?: string
  sinceMs?: number
  limit?: number
  nowMs?: number
}

export interface NerveReviewEntry {
  raw: string
  parsed: Record<string, unknown> | null
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

export function parseDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim().toLowerCase())
  if (!match) return null
  const amount = Number.parseFloat(match[1]!)
  if (!Number.isFinite(amount) || amount < 0) return null
  switch (match[2]) {
    case "ms": return amount
    case "s": return amount * 1_000
    case "m": return amount * 60_000
    case "h": return amount * 3_600_000
    case "d": return amount * 86_400_000
    /* v8 ignore start -- exhaustive switch over the regex group; unreachable */
    default: return null
    /* v8 ignore stop */
  }
}

function entryTimeMs(parsed: Record<string, unknown> | null): number | null {
  if (!parsed) return null
  const time = parsed.time
  if (typeof time === "string") {
    const ms = Date.parse(time)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

function readLastNLines(filePath: string, maxLines: number, maxBytes = 8 * 1024 * 1024): string[] {
  let text: string
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > maxBytes) {
      const fd = fs.openSync(filePath, "r")
      try {
        const buf = Buffer.alloc(maxBytes)
        fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes)
        text = buf.toString("utf-8")
      } finally {
        fs.closeSync(fd)
      }
    } else {
      text = fs.readFileSync(filePath, "utf-8")
    }
  } catch {
    return []
  }
  const lines = text.split("\n").filter((line) => line.length > 0)
  return lines.slice(-maxLines)
}

export function reviewNerveEvents(
  filePath: string,
  filter: NerveReviewFilter = {},
): NerveReviewEntry[] {
  const limit = filter.limit ?? 50
  const candidateLineCount = Math.max(limit * 4, 200)
  const lines = readLastNLines(filePath, candidateLineCount)
  const cutoffMs = filter.sinceMs !== undefined && filter.nowMs !== undefined
    ? filter.nowMs - filter.sinceMs
    : null
  const matched: NerveReviewEntry[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!
    let parsed: Record<string, unknown> | null = null
    try {
      const value = JSON.parse(raw) as unknown
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    } catch {
      parsed = null
    }
    if (!parsed) continue
    if (filter.componentSubstring) {
      const component = String(parsed.component ?? "")
      if (!component.toLowerCase().includes(filter.componentSubstring.toLowerCase())) continue
    }
    if (filter.eventSubstring) {
      const event = String(parsed.event ?? "")
      if (!event.toLowerCase().includes(filter.eventSubstring.toLowerCase())) continue
    }
    if (filter.level) {
      const level = String(parsed.level ?? "info")
      if (level !== filter.level) continue
    }
    if (cutoffMs !== null) {
      const eventMs = entryTimeMs(parsed)
      if (eventMs === null || eventMs < cutoffMs) continue
    }
    matched.push({ raw, parsed })
    if (matched.length >= limit) break
  }
  return matched.reverse()
}

export function formatNerveEntry(entry: NerveReviewEntry): string {
  const parsed = entry.parsed
  if (!parsed) return entry.raw
  const time = String(parsed.time ?? "")
  const level = String(parsed.level ?? "info")
  const component = String(parsed.component ?? "?")
  const event = String(parsed.event ?? "?")
  const message = String(parsed.message ?? "")
  return `${time} [${level.padEnd(5)}] ${component}/${event} — ${message}`
}
