import { emitNervesEvent } from "../nerves/runtime"
import { type TemporalView } from "./temporal-view"
import { type TempoMode, TEMPO_BUDGETS, type TempoTokenBudget } from "./tempo"
import { type EpisodeRecord } from "../mind/episodes"
import { type Obligation } from "./obligations"
import { type CareRecord } from "./cares"
import { type AgentPresence } from "./presence"

export interface WakePacket {
  plotLine: string
  obligations: string
  cares: string
  presence: string
  resumeHint: string
  tempo: TempoMode
  tokenBudget: TempoTokenBudget
  assembledAt: string
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// --- Section builders (pure derivation from authored data, no embellishment) ---

function buildPlotLine(episodes: EpisodeRecord[], tempo: TempoMode): string {
  if (episodes.length === 0) return ""

  const limit = tempo === "crisis" ? 3 : tempo === "brief" ? 2 : 5
  const selected = episodes.slice(0, limit)

  const lines = selected.map((ep) => {
    const parts = [`- ${ep.summary}`]
    if (ep.whyItMattered && tempo !== "brief") {
      parts[0] += ` (${ep.whyItMattered})`
    }
    return parts[0]
  })

  return lines.join("\n")
}

function buildObligationsSection(obligations: Obligation[]): string {
  if (obligations.length === 0) return ""

  return obligations
    .map((ob) => {
      const parts = [`- ${ob.content}`]
      if (ob.meaning?.resumeHint) {
        parts.push(` [hint: ${ob.meaning.resumeHint}]`)
      }
      if (ob.meaning?.stalenessClass && ob.meaning.stalenessClass !== "fresh") {
        parts.push(` (${ob.meaning.stalenessClass})`)
      }
      if (ob.meaning?.waitingOn) {
        parts.push(` waiting on ${ob.meaning.waitingOn.kind}: ${ob.meaning.waitingOn.target}`)
      }
      return parts.join("")
    })
    .join("\n")
}

function buildCaresSection(cares: CareRecord[]): string {
  if (cares.length === 0) return ""

  return cares
    .map((c) => {
      const parts = [`- ${c.label}`]
      if (c.salience !== "low") {
        parts.push(` [${c.salience}]`)
      }
      if (c.currentRisk) {
        parts.push(` risk: ${c.currentRisk}`)
      }
      return parts.join("")
    })
    .join("\n")
}

function buildPresenceSection(peers: AgentPresence[]): string {
  if (peers.length === 0) return ""

  return peers
    .map(
      (p) =>
        `- ${p.agentName}: ${p.availability}/${p.lane}`,
    )
    .join("\n")
}

function buildResumeHint(view: TemporalView): string {
  // Compose from authored obligation resumeHints and top intentions
  const hints: string[] = []

  for (const ob of view.activeObligations) {
    if (ob.meaning?.resumeHint) {
      hints.push(ob.meaning.resumeHint)
    }
  }

  for (const intent of view.openIntentions.slice(0, 3)) {
    hints.push(intent.content)
  }

  if (hints.length === 0) {
    // Fall back to top obligation content
    if (view.activeObligations.length > 0) {
      hints.push(view.activeObligations[0].content)
    }
  }

  if (hints.length === 0) return ""
  return hints.join("; ")
}

export function buildWakePacket(view: TemporalView): WakePacket {
  const tempo = view.tempo
  const tokenBudget = TEMPO_BUDGETS[tempo]

  const packet: WakePacket = {
    plotLine: buildPlotLine(view.recentEpisodes, tempo),
    obligations: buildObligationsSection(view.activeObligations),
    cares: buildCaresSection(view.activeCares),
    presence: buildPresenceSection(view.peerPresence),
    resumeHint: buildResumeHint(view),
    tempo,
    tokenBudget,
    assembledAt: new Date().toISOString(),
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.wake_packet_built",
    message: `wake packet built: tempo=${tempo}`,
    meta: {
      tempo,
      plotLineTokens: estimateTokens(packet.plotLine),
      obligationsTokens: estimateTokens(packet.obligations),
      caresTokens: estimateTokens(packet.cares),
      presenceTokens: estimateTokens(packet.presence),
      resumeHintTokens: estimateTokens(packet.resumeHint),
    },
  })

  return packet
}

/**
 * Renders a wake packet to prompt text, respecting token budget.
 * Truncation priority (last truncated first):
 *   resumeHint (PROTECTED) > obligations > cares > plotLine > presence
 * So presence is truncated first, then plotLine, then cares, then obligations.
 * resumeHint is never truncated.
 */
export function renderWakePacket(packet: WakePacket): string {
  const budget = packet.tokenBudget

  // Assemble sections in priority order (highest priority first for budget allocation)
  // Each section is { label, content, priority } where lower priority number = truncated first
  const sections = [
    { label: "resume", content: packet.resumeHint, priority: 5 },
    { label: "obligations", content: packet.obligations, priority: 4 },
    { label: "cares", content: packet.cares, priority: 3 },
    { label: "plot", content: packet.plotLine, priority: 2 },
    { label: "presence", content: packet.presence, priority: 1 },
  ].filter((s) => s.content.length > 0)

  if (sections.length === 0) {
    emitNervesEvent({
      component: "heart",
      event: "heart.wake_packet_rendered",
      message: "wake packet rendered: empty",
      meta: { tokens: 0, tempo: packet.tempo },
    })
    return ""
  }

  // Build the rendered output, truncating lower-priority sections first
  let rendered = formatSections(sections)
  let tokens = estimateTokens(rendered)

  // Truncate sections from lowest priority until we fit budget
  const sortedByPriority = [...sections].sort((a, b) => a.priority - b.priority)

  for (const section of sortedByPriority) {
    if (tokens <= budget.max) break
    // Skip resumeHint — it's PROTECTED
    if (section.label === "resume") continue

    // Remove this section entirely
    const idx = sections.findIndex((s) => s.label === section.label)
    sections.splice(idx, 1)
    rendered = formatSections(sections)
    tokens = estimateTokens(rendered)
  }

  // If still over budget after removing all non-protected sections, trim what's left
  if (tokens > budget.max) {
    const maxChars = budget.max * 4
    rendered = rendered.slice(0, maxChars)
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.wake_packet_rendered",
    message: `wake packet rendered: ${tokens} tokens`,
    meta: { tokens, tempo: packet.tempo, sectionCount: sections.length },
  })

  return rendered
}

function formatSections(sections: Array<{ label: string; content: string }>): string {
  const parts: string[] = []

  for (const section of sections) {
    switch (section.label) {
      case "resume":
        parts.push(`**Next:** ${section.content}`)
        break
      case "obligations":
        parts.push(`**Owed:**\n${section.content}`)
        break
      case "cares":
        parts.push(`**Cares:**\n${section.content}`)
        break
      case "plot":
        parts.push(`**Recent:**\n${section.content}`)
        break
      case "presence":
        parts.push(`**Peers:**\n${section.content}`)
        break
    }
  }

  return parts.join("\n\n")
}

/**
 * Ultra-compact version for coding context (max 200 tokens).
 * Just resumeHint + top obligation + top care, single-line bullets.
 */
export function renderCompactWakePacket(packet: WakePacket): string {
  const parts: string[] = []

  if (packet.resumeHint) {
    parts.push(`next: ${packet.resumeHint}`)
  }
  if (packet.obligations) {
    // Just first line of obligations
    const firstOb = packet.obligations.split("\n")[0]
    parts.push(`owed: ${firstOb.replace(/^- /, "")}`)
  }
  if (packet.cares) {
    const firstCare = packet.cares.split("\n")[0]
    parts.push(`care: ${firstCare.replace(/^- /, "")}`)
  }

  const compact = parts.join(" | ")

  // Hard cap at 200 tokens (800 chars)
  const maxChars = 200 * 4
  const result = compact.length > maxChars ? compact.slice(0, maxChars) : compact

  emitNervesEvent({
    component: "heart",
    event: "heart.wake_packet_compact_rendered",
    message: `compact wake packet: ${estimateTokens(result)} tokens`,
    meta: { tokens: estimateTokens(result) },
  })

  return result
}
