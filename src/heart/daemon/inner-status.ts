import { emitNervesEvent } from "../../nerves/runtime"
import type { DriftFinding } from "./drift-detection"

export interface InnerRuntimeState {
  status: string
  reason?: string
  startedAt?: string
  lastCompletedAt?: string
}

export interface JournalFileEntry {
  name: string
  mtimeMs: number
}

export interface HeartbeatInfo {
  cadenceMs: number
  lastCompletedAt: number | null
}

export interface BuildInnerStatusInput {
  agentName: string
  runtimeState: InnerRuntimeState | null
  journalFiles: JournalFileEntry[]
  heartbeat: HeartbeatInfo | null
  attentionCount: number
  now: number
  /**
   * Layer 4: drift findings for this agent. When non-empty, a
   * "drift advisory" section is appended after the existing status
   * fields with one line per finding (lane, intent vs observed, and
   * a copy-pasteable `ouro use` repair command).
   *
   * Optional for backward compatibility: pre-Layer-4 callers omit
   * this field and the section is suppressed.
   */
  driftFindings?: DriftFinding[]
}

function formatRelativeTime(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / (60 * 1000))
  if (minutes < 1) return "just now"
  if (minutes === 1) return "1 minute ago"
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return "1 hour ago"
  return `${hours} hours ago`
}

function formatCadence(cadenceMs: number): string {
  const minutes = Math.round(cadenceMs / (60 * 1000))
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60)
    return `${hours}h`
  }
  return `${minutes}m`
}

export function buildInnerStatusOutput(input: BuildInnerStatusInput): string {
  const { agentName, runtimeState, journalFiles, heartbeat, attentionCount, now } = input
  const lines: string[] = []

  lines.push(`inner dialog status: ${agentName}`)

  // Last turn
  if (runtimeState?.lastCompletedAt) {
    const lastMs = new Date(runtimeState.lastCompletedAt).getTime()
    const elapsed = now - lastMs
    const relativeTime = formatRelativeTime(elapsed)
    const reasonSuffix = runtimeState.reason ? ` (${runtimeState.reason})` : ""
    lines.push(`  last turn: ${relativeTime}${reasonSuffix}`)
  } else {
    lines.push("  last turn: unknown")
  }

  // Status
  if (runtimeState) {
    const reasonSuffix = runtimeState.status === "running" && runtimeState.reason ? ` (${runtimeState.reason})` : ""
    lines.push(`  status: ${runtimeState.status}${reasonSuffix}`)
  } else {
    lines.push("  status: unknown")
  }

  // Heartbeat health
  if (heartbeat && heartbeat.lastCompletedAt !== null) {
    const elapsed = now - heartbeat.lastCompletedAt
    const threshold = heartbeat.cadenceMs * 1.5
    const health = elapsed < threshold ? "healthy" : "overdue"
    const cadenceStr = formatCadence(heartbeat.cadenceMs)
    const sinceStr = formatRelativeTime(elapsed)
    lines.push(`  heartbeat: ${health} (cadence ${cadenceStr}, ${sinceStr})`)
  } else {
    lines.push("  heartbeat: unknown")
  }

  // Journal
  if (journalFiles.length === 0) {
    lines.push("  journal: (empty)")
  } else {
    lines.push("  journal:")
    const sorted = [...journalFiles].sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const file of sorted) {
      const elapsed = now - file.mtimeMs
      const relativeTime = formatRelativeTime(elapsed)
      lines.push(`    - ${file.name} (${relativeTime})`)
    }
  }

  // Attention
  const thoughtWord = attentionCount === 1 ? "thought" : "thoughts"
  lines.push(`  attention: ${attentionCount} held ${thoughtWord}`)

  // Layer 4 drift advisory. Renders one line per finding with the
  // lane, intent vs observed binding, and the copy-pasteable repair
  // command. Suppressed entirely when no findings exist (or the field
  // is absent — pre-Layer-4 callers).
  const driftFindings = input.driftFindings ?? []
  if (driftFindings.length > 0) {
    lines.push("  drift advisory:")
    for (const finding of driftFindings) {
      lines.push(`    - ${finding.lane}: intent ${finding.intentProvider}/${finding.intentModel} vs observed ${finding.observedProvider}/${finding.observedModel}`)
      lines.push(`      repair: ${finding.repairCommand}`)
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.inner_status_read",
    message: "inner dialog status read",
    meta: {
      agentName,
      status: runtimeState?.status ?? "unknown",
      journalCount: journalFiles.length,
      attentionCount,
      driftCount: driftFindings.length,
    },
  })

  return lines.join("\n")
}
