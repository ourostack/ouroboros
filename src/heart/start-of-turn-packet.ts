import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { type BundleStateIssue, renderBundleStateHint } from "./bundle-state"
import { type TemporalView } from "./temporal-view"
import { type TempoMode, TEMPO_BUDGETS, type TempoTokenBudget } from "./tempo"
import { type EpisodeRecord } from "../arc/episodes"
import { type Obligation } from "../arc/obligations"
import { type CareRecord } from "../arc/cares"
import { type AgentPresence } from "../arc/presence"

export interface StartOfTurnPacket {
  plotLine: string
  obligations: string
  cares: string
  presence: string
  resumeHint: string
  currentSessionTiming?: string
  tempo: TempoMode
  tokenBudget: TempoTokenBudget
  assembledAt: string
  syncFailure?: string
  bundleState?: BundleStateIssue[]
  capabilities?: string
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

function buildResumeHint(view: TemporalView, obligations?: Obligation[]): string {
  // Compose from authored obligation resumeHints and top intentions
  const hints: string[] = []
  const effectiveObligations = obligations ?? view.activeObligations

  for (const ob of effectiveObligations) {
    if (ob.meaning?.resumeHint) {
      hints.push(ob.meaning.resumeHint)
    }
  }

  for (const intent of view.openIntentions.slice(0, 3)) {
    hints.push(intent.content)
  }

  if (hints.length === 0) {
    // Fall back to top obligation content
    if (effectiveObligations.length > 0) {
      hints.push(effectiveObligations[0].content)
    }
  }

  if (hints.length === 0) return ""
  return hints.join("; ")
}

interface ChangelogEntry {
  version: string
  changes: string[]
}

/**
 * Build a compact summary of capability changes between runtime versions.
 * Reads bundle-meta.json for version info and changelog.json for change descriptions.
 * Returns undefined if no version change detected or files are missing/malformed.
 */
export function buildCapabilitiesSection(bundleRoot: string): string | undefined {
  let meta: Record<string, unknown>
  try {
    const raw = fs.readFileSync(path.join(bundleRoot, "bundle-meta.json"), "utf-8")
    meta = JSON.parse(raw) as Record<string, unknown>
  } catch {
    emitNervesEvent({
      component: "heart",
      event: "heart.capabilities_check",
      message: "bundle-meta.json missing or malformed",
      meta: { bundleRoot },
    })
    return undefined
  }

  const currentVersion = meta.runtimeVersion
  const previousVersion = meta.previousRuntimeVersion
  if (typeof currentVersion !== "string" || typeof previousVersion !== "string") {
    return undefined
  }
  if (currentVersion === previousVersion) {
    return undefined
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.capabilities_version_change",
    message: `runtime version changed from ${previousVersion} to ${currentVersion}`,
    meta: { previousVersion, currentVersion },
  })

  let changelog: ChangelogEntry[] | undefined
  try {
    const raw = fs.readFileSync(path.join(bundleRoot, "changelog.json"), "utf-8")
    changelog = JSON.parse(raw) as ChangelogEntry[]
  } catch {
    // changelog missing -- still report the version change
  }

  const parts: string[] = [`Updated from ${previousVersion} to ${currentVersion}`]

  if (changelog && Array.isArray(changelog)) {
    const relevantChanges: string[] = []
    for (const entry of changelog) {
      if (entry.version === previousVersion) break
      if (Array.isArray(entry.changes)) {
        relevantChanges.push(...entry.changes)
      }
    }
    if (relevantChanges.length > 0) {
      parts.push(`: ${relevantChanges.join("; ")}`)
    }
  }

  return parts.join("")
}

export function buildStartOfTurnPacket(
  view: TemporalView,
  opts?: {
    canonicalObligations?: { primary: Obligation | null; all: Obligation[] }
    currentSessionTiming?: string
  },
): StartOfTurnPacket {
  const tempo = view.tempo
  const tokenBudget = TEMPO_BUDGETS[tempo]
  const effectiveObligations = opts?.canonicalObligations ? opts.canonicalObligations.all : view.activeObligations

  const packet: StartOfTurnPacket = {
    plotLine: buildPlotLine(view.recentEpisodes, tempo),
    obligations: buildObligationsSection(effectiveObligations),
    cares: buildCaresSection(view.activeCares),
    presence: buildPresenceSection(view.peerPresence),
    resumeHint: buildResumeHint(view, opts?.canonicalObligations ? effectiveObligations : undefined),
    currentSessionTiming: opts?.currentSessionTiming,
    tempo,
    tokenBudget,
    assembledAt: new Date().toISOString(),
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.start_of_turn_packet_built",
    message: `start-of-turn packet built: tempo=${tempo}`,
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
 * Renders a start-of-turn packet to prompt text, respecting token budget.
 * Truncation priority (last truncated first):
 *   resumeHint (PROTECTED) > obligations > cares > plotLine > presence
 * So presence is truncated first, then plotLine, then cares, then obligations.
 * resumeHint is never truncated.
 */
export function renderStartOfTurnPacket(packet: StartOfTurnPacket): string {
  const budget = packet.tokenBudget

  // Assemble sections in priority order (highest priority first for budget allocation)
  // Each section is { label, content, priority } where lower priority number = truncated first
  const sections = [
    // bundleState and syncFailure share the top remediation tier — both
    // are actionable "fix your git" signals. bundleState is preferred
    // because it's structured (array of enum values) while syncFailure is
    // a legacy free-form string; both render when populated.
    { label: "bundleState", content: renderBundleStateHint(packet.bundleState ?? []), priority: 7 },
    { label: "syncFailure", content: packet.syncFailure ?? "", priority: 7 },
    { label: "resume", content: packet.resumeHint, priority: 6 },
    { label: "sessionTiming", content: packet.currentSessionTiming ?? "", priority: 5 },
    { label: "obligations", content: packet.obligations, priority: 5 },
    { label: "cares", content: packet.cares, priority: 4 },
    { label: "plot", content: packet.plotLine, priority: 3 },
    { label: "capabilities", content: packet.capabilities ?? "", priority: 2 },
    { label: "presence", content: packet.presence, priority: 1 },
  ].filter((s) => s.content.length > 0)

  if (sections.length === 0) {
    emitNervesEvent({
      component: "heart",
      event: "heart.start_of_turn_packet_rendered",
      message: "start-of-turn packet rendered: empty",
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
    event: "heart.start_of_turn_packet_rendered",
    message: `start-of-turn packet rendered: ${tokens} tokens`,
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
      case "capabilities":
        parts.push(`**Capabilities:** ${section.content}`)
        break
      case "syncFailure":
        parts.push(`**Sync warning:** ${section.content}`)
        break
      case "bundleState":
        parts.push(`**Bundle:** ${section.content}`)
        break
    }
  }

  return parts.join("\n\n")
}

/**
 * Ultra-compact version for coding context (max 200 tokens).
 * Just resumeHint + top obligation + top care, single-line bullets.
 */
export function renderCompactStartOfTurnPacket(packet: StartOfTurnPacket): string {
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
    event: "heart.start_of_turn_packet_compact_rendered",
    message: `compact start-of-turn packet: ${estimateTokens(result)} tokens`,
    meta: { tokens: estimateTokens(result) },
  })

  return result
}
