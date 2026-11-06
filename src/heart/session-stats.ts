import * as fs from "node:fs"
import { parseSessionEnvelope, type SessionEnvelope, type SessionEvent, type SessionEventRole } from "./session-events"

export interface SessionStatsReport {
  sessionPath: string
  envelopeVersion: number | null
  totalEvents: number
  byRole: Record<SessionEventRole, number>
  toolCalls: {
    total: number
    distinctNames: number
    topByFrequency: Array<{ name: string; count: number }>
  }
  attachments: number
  timeRange: {
    earliest: string | null
    latest: string | null
    durationMs: number | null
  }
  projection: {
    eventCount: number
    omittedFromProjection: number
    inputTokens: number | null
    maxTokens: number | null
    trimmed: boolean
  }
  lastUsage: unknown
}

const ROLES: SessionEventRole[] = ["system", "user", "assistant", "tool"]

function emptyByRole(): Record<SessionEventRole, number> {
  const counts = {} as Record<SessionEventRole, number>
  for (const role of ROLES) counts[role] = 0
  return counts
}

function eventTimeMs(event: SessionEvent): number | null {
  const value = event.time.authoredAt ?? event.time.observedAt ?? null
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function computeSessionStats(envelope: SessionEnvelope, sessionPath: string): SessionStatsReport {
  const byRole = emptyByRole()
  let toolCallTotal = 0
  let attachments = 0
  const toolNameCounts = new Map<string, number>()
  let earliestMs: number | null = null
  let latestMs: number | null = null
  for (const event of envelope.events) {
    byRole[event.role] = (byRole[event.role] ?? 0) + 1
    attachments += event.attachments.length
    for (const call of event.toolCalls) {
      toolCallTotal += 1
      const name = call.function.name
      toolNameCounts.set(name, (toolNameCounts.get(name) ?? 0) + 1)
    }
    const ms = eventTimeMs(event)
    if (ms !== null) {
      if (earliestMs === null || ms < earliestMs) earliestMs = ms
      if (latestMs === null || ms > latestMs) latestMs = ms
    }
  }
  const top = [...toolNameCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }))

  return {
    sessionPath,
    envelopeVersion: envelope.version,
    totalEvents: envelope.events.length,
    byRole,
    toolCalls: {
      total: toolCallTotal,
      distinctNames: toolNameCounts.size,
      topByFrequency: top,
    },
    attachments,
    timeRange: {
      earliest: earliestMs !== null ? new Date(earliestMs).toISOString() : null,
      latest: latestMs !== null ? new Date(latestMs).toISOString() : null,
      durationMs: earliestMs !== null && latestMs !== null ? latestMs - earliestMs : null,
    },
    projection: {
      eventCount: envelope.projection.eventIds.length,
      omittedFromProjection: Math.max(0, envelope.events.length - envelope.projection.eventIds.length),
      inputTokens: envelope.projection.inputTokens,
      maxTokens: envelope.projection.maxTokens,
      trimmed: envelope.projection.trimmed,
    },
    lastUsage: envelope.lastUsage,
  }
}

export function runSessionStats(sessionPath: string): SessionStatsReport {
  const text = fs.readFileSync(sessionPath, "utf-8")
  const raw = JSON.parse(text) as unknown
  const envelope = parseSessionEnvelope(raw)
  if (!envelope) {
    return {
      sessionPath,
      envelopeVersion: null,
      totalEvents: 0,
      byRole: emptyByRole(),
      toolCalls: { total: 0, distinctNames: 0, topByFrequency: [] },
      attachments: 0,
      timeRange: { earliest: null, latest: null, durationMs: null },
      projection: { eventCount: 0, omittedFromProjection: 0, inputTokens: null, maxTokens: null, trimmed: false },
      lastUsage: null,
    }
  }
  return computeSessionStats(envelope, sessionPath)
}

export function formatStatsReport(report: SessionStatsReport): string {
  const lines: string[] = []
  lines.push(`Session stats: ${report.sessionPath}`)
  if (report.envelopeVersion === null) {
    lines.push("  envelope: unrecognized (could not parse)")
    return lines.join("\n")
  }
  lines.push(`  envelope version: ${report.envelopeVersion}`)
  lines.push(`  total events:     ${report.totalEvents}`)
  lines.push(`  by role:          system=${report.byRole.system} user=${report.byRole.user} assistant=${report.byRole.assistant} tool=${report.byRole.tool}`)
  lines.push(`  tool calls:       ${report.toolCalls.total} (${report.toolCalls.distinctNames} distinct names)`)
  if (report.toolCalls.topByFrequency.length > 0) {
    lines.push("  top tools:")
    for (const { name, count } of report.toolCalls.topByFrequency) {
      lines.push(`    ${name}: ${count}`)
    }
  }
  lines.push(`  attachments:      ${report.attachments}`)
  if (report.timeRange.earliest && report.timeRange.latest) {
    const durationSec = report.timeRange.durationMs !== null ? Math.round(report.timeRange.durationMs / 1000) : null
    lines.push(`  time range:       ${report.timeRange.earliest} → ${report.timeRange.latest}${durationSec !== null ? ` (${durationSec}s)` : ""}`)
  }
  lines.push("  projection:")
  lines.push(`    in projection:  ${report.projection.eventCount}`)
  lines.push(`    omitted:        ${report.projection.omittedFromProjection}`)
  if (report.projection.inputTokens !== null) lines.push(`    input tokens:   ${report.projection.inputTokens}`)
  if (report.projection.maxTokens !== null) lines.push(`    max tokens:     ${report.projection.maxTokens}`)
  if (report.projection.trimmed) lines.push("    trimmed:        true")
  if (report.lastUsage) {
    lines.push(`  last usage:       ${JSON.stringify(report.lastUsage)}`)
  }
  return lines.join("\n")
}

export function runSessionStatsCli(argv: string[]): number {
  const positional = argv.filter((token) => !token.startsWith("--"))
  const flags = new Set(argv.filter((token) => token.startsWith("--")))
  if (flags.has("--help") || flags.has("-h") || positional.length === 0) {
    // eslint-disable-next-line no-console -- meta-tooling
    console.log("usage: ouro session-stats <session.json> [--json]")
    return positional.length === 0 ? 2 : 0
  }
  const report = runSessionStats(positional[0]!)
  if (flags.has("--json")) {
    // eslint-disable-next-line no-console -- meta-tooling
    console.log(JSON.stringify(report, null, 2))
  } else {
    // eslint-disable-next-line no-console -- meta-tooling
    console.log(formatStatsReport(report))
  }
  return 0
}
