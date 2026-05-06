import { emitNervesEvent } from "../../nerves/runtime"

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

  emitNervesEvent({
    component: "daemon",
    event: "daemon.inner_status_read",
    message: "inner dialog status read",
    meta: {
      agentName,
      status: runtimeState?.status ?? "unknown",
      journalCount: journalFiles.length,
      attentionCount,
    },
  })

  return lines.join("\n")
}
