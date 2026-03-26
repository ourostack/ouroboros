import { emitNervesEvent } from "../nerves/runtime"

export interface JournalFileInfo {
  name: string
  mtime: number
  preview: string
}

export interface PendingObligationInfo {
  id: string
  content: string
  friendName: string
  timestamp: number
  staleness: number
}

export interface ContextualHeartbeatOptions {
  journalDir: string
  lastCompletedAt?: string
  pendingObligations: PendingObligationInfo[]
  lastSurfaceAt?: string
  checkpoint?: string
  now: () => Date
  readJournalDir: () => JournalFileInfo[]
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes
const MAX_JOURNAL_FILES = 10

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours} ${hours === 1 ? "hour" : "hours"}`
}

function formatRelativeTime(nowMs: number, mtimeMs: number): string {
  const diffMs = nowMs - mtimeMs
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? "day" : "days"} ago`
}

export function buildContextualHeartbeat(options: ContextualHeartbeatOptions): string {
  const {
    lastCompletedAt,
    pendingObligations,
    lastSurfaceAt,
    checkpoint,
    now,
    readJournalDir,
  } = options

  const nowDate = now()
  const nowMs = nowDate.getTime()
  const journalFiles = readJournalDir()

  // Cold start: no journal files and no runtime state
  if (journalFiles.length === 0 && !lastCompletedAt) {
    const lines = ["...time passing. anything stirring?"]
    if (checkpoint) {
      lines.push(`\nlast i remember: ${checkpoint}`)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.contextual_heartbeat_built",
      message: "contextual heartbeat built (cold start)",
      meta: { coldStart: true },
    })
    return lines.join("\n")
  }

  const sections: string[] = []

  // Elapsed time since last turn
  if (lastCompletedAt) {
    const lastMs = new Date(lastCompletedAt).getTime()
    const elapsed = nowMs - lastMs
    sections.push(`it's been ${formatElapsed(elapsed)} since your last turn.`)
  }

  // Pending attention count
  if (pendingObligations.length > 0) {
    const count = pendingObligations.length
    sections.push(`you're holding ${count} ${count === 1 ? "thought" : "thoughts"}.`)
  }

  // Journal index
  if (journalFiles.length > 0) {
    const sorted = [...journalFiles].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_JOURNAL_FILES)
    const indexLines: string[] = ["## journal"]
    for (const file of sorted) {
      const ago = formatRelativeTime(nowMs, file.mtime)
      const previewClause = file.preview ? ` — ${file.preview}` : ""
      indexLines.push(`- ${file.name} (${ago})${previewClause}`)
    }
    sections.push(indexLines.join("\n"))
  }

  // Journal entries since last surface
  if (lastSurfaceAt && journalFiles.length > 0) {
    const surfaceMs = new Date(lastSurfaceAt).getTime()
    const entriesSinceSurface = journalFiles.filter((f) => f.mtime > surfaceMs).length
    if (entriesSinceSurface > 0) {
      const surfaceElapsed = formatElapsed(nowMs - surfaceMs)
      sections.push(`${entriesSinceSurface} journal ${entriesSinceSurface === 1 ? "entry" : "entries"} since you last surfaced, ${surfaceElapsed} ago.`)
    }
  }

  // Stale obligation alerts
  const staleObligations = pendingObligations.filter((o) => o.staleness >= STALE_THRESHOLD_MS)
  if (staleObligations.length > 0) {
    for (const obligation of staleObligations) {
      sections.push(`this has been sitting for ${formatElapsed(obligation.staleness)}: ${obligation.content}`)
    }
  }

  // Checkpoint
  if (checkpoint) {
    sections.push(`last i remember: ${checkpoint}`)
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.contextual_heartbeat_built",
    message: "contextual heartbeat built",
    meta: {
      hasJournal: journalFiles.length > 0,
      hasLastCompleted: !!lastCompletedAt,
      obligationCount: pendingObligations.length,
      staleCount: staleObligations.length,
    },
  })

  return sections.join("\n\n")
}
