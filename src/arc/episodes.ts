import * as fs from "fs"
import * as path from "path"
import { capStructuredRecordString, capStructuredRecordStringLeaves } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"

export type EpisodeKind =
  | "obligation_shift"
  | "coding_milestone"
  | "bridge_event"
  | "care_event"
  | "tempo_shift"
  | "turning_point"

export interface EpisodeRecord {
  id: string
  timestamp: string
  kind: EpisodeKind
  summary: string
  whyItMattered: string
  relatedEntities: string[]
  salience: "low" | "medium" | "high" | "critical"
  meta?: Record<string, unknown>
}

function episodesDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "episodes")
}

function generateId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 10)
  return `ep-${timestamp}-${random}`
}

export function emitEpisode(
  agentRoot: string,
  input: Omit<EpisodeRecord, "id" | "timestamp">,
): EpisodeRecord {
  const now = new Date().toISOString()
  const id = generateId()
  const episode: EpisodeRecord = {
    id,
    timestamp: now,
    kind: input.kind,
    summary: capStructuredRecordString(input.summary),
    whyItMattered: capStructuredRecordString(input.whyItMattered),
    relatedEntities: input.relatedEntities,
    salience: input.salience,
    ...(input.meta ? { meta: capStructuredRecordStringLeaves(input.meta) } : {}),
  }

  const dir = episodesDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(episode, null, 2), "utf-8")

  emitNervesEvent({
    component: "mind",
    event: "mind.episode_emitted",
    message: `episode emitted: ${input.kind}`,
    meta: {
      episodeId: id,
      kind: input.kind,
      salience: input.salience,
    },
  })

  return episode
}

export function readRecentEpisodes(
  agentRoot: string,
  options?: { limit?: number; since?: string; kinds?: EpisodeKind[] },
): EpisodeRecord[] {
  const dir = episodesDir(agentRoot)
  if (!fs.existsSync(dir)) {
    emitNervesEvent({
      component: "mind",
      event: "mind.episodes_read",
      message: "read episodes: directory missing, returning empty",
      meta: { count: 0 },
    })
    return []
  }

  const limit = options?.limit ?? 50
  const since = options?.since
  const kinds = options?.kinds

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  const episodes: EpisodeRecord[] = []

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8")
      const episode = JSON.parse(content) as EpisodeRecord
      if (since && episode.timestamp < since) continue
      if (kinds && !kinds.includes(episode.kind)) continue
      episodes.push(episode)
    } catch {
      // Skip malformed JSON files gracefully
    }
  }

  episodes.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const result = episodes.slice(0, limit)

  emitNervesEvent({
    component: "mind",
    event: "mind.episodes_read",
    message: `read ${result.length} recent episodes`,
    meta: { count: result.length, total: episodes.length, limit },
  })

  return result
}
