import { emitNervesEvent } from "../nerves/runtime"
import { readRecentEpisodes, type EpisodeRecord } from "../mind/episodes"
import { readPendingObligations, type Obligation } from "./obligations"
import { readActiveCares, type CareRecord } from "./cares"
import { readOpenIntentions, type IntentionRecord } from "./intentions"
import { readPeerPresence, type AgentPresence } from "./presence"
import { type TempoMode } from "./tempo"

export interface TemporalView {
  recentEpisodes: EpisodeRecord[]
  activeObligations: Obligation[]
  activeCares: CareRecord[]
  openIntentions: IntentionRecord[]
  peerPresence: AgentPresence[]
  tempo: TempoMode
  assembledAt: string
}

export function buildTemporalView(
  agentRoot: string,
  options?: {
    episodeLimit?: number
    tempo?: TempoMode
    /** Pre-read data to avoid redundant disk reads when the pipeline already has these. */
    preloaded?: {
      recentEpisodes?: EpisodeRecord[]
      activeObligations?: Obligation[]
      activeCares?: CareRecord[]
    }
  },
): TemporalView {
  const episodeLimit = options?.episodeLimit ?? 20
  const tempo = options?.tempo ?? "brief"

  const recentEpisodes = options?.preloaded?.recentEpisodes ?? readRecentEpisodes(agentRoot, { limit: episodeLimit })
  const activeObligations = options?.preloaded?.activeObligations ?? readPendingObligations(agentRoot)
  const activeCares = options?.preloaded?.activeCares ?? readActiveCares(agentRoot)
  const openIntentions = readOpenIntentions(agentRoot)
  const peerPresence = readPeerPresence(agentRoot)

  const view: TemporalView = {
    recentEpisodes,
    activeObligations,
    activeCares,
    openIntentions,
    peerPresence,
    tempo,
    assembledAt: new Date().toISOString(),
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.temporal_view_assembled",
    message: `temporal view assembled: ${recentEpisodes.length} episodes, ${activeObligations.length} obligations, ${activeCares.length} cares, ${openIntentions.length} intentions`,
    meta: {
      episodeCount: recentEpisodes.length,
      obligationCount: activeObligations.length,
      careCount: activeCares.length,
      intentionCount: openIntentions.length,
      peerCount: peerPresence.length,
      tempo,
    },
  })

  return view
}
