import type { PendingMessage } from "../mind/pending"
import type { ReturnObligation } from "../arc/obligations"
import { emitNervesEvent } from "../nerves/runtime"
import type { AttentionItem } from "../arc/attention-types"
import type { PonderPacket } from "../arc/packets"

// Re-export for consumers that import from here
export type { AttentionItem }

// ── Queue construction ───────────────────────────────────────────

function generateItemId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function originKey(friendId: string, channel: string, key: string): string {
  return `${friendId}/${channel}/${key}`
}

const PACKET_RETURN_HINT_MAX = 180
const PACKET_RETURN_HINT_COUNT_MAX = 4
const LITERAL_MARKER_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/
const RETURN_HINT_KEY_RE = /(expected|return|marker|answer|verdict)/i

function addReturnHint(hints: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > PACKET_RETURN_HINT_MAX) return
  if (!LITERAL_MARKER_RE.test(trimmed)) return
  if (seen.has(trimmed)) return
  seen.add(trimmed)
  hints.push(trimmed)
}

function extractQuotedReturnHints(value: string, hints: string[], seen: Set<string>): void {
  for (const match of value.matchAll(/"([^"\n]{1,180})"/g)) {
    addReturnHint(hints, seen, match[1])
    if (hints.length >= PACKET_RETURN_HINT_COUNT_MAX) return
  }
}

function extractPacketReturnHints(packet: PonderPacket): string[] {
  const hints: string[] = []
  const seen = new Set<string>()

  const sourceRequest = typeof packet.payload.sourceRequest === "string" ? packet.payload.sourceRequest : ""
  if (sourceRequest) extractQuotedReturnHints(sourceRequest, hints, seen)

  for (const [key, value] of Object.entries(packet.payload)) {
    if (hints.length >= PACKET_RETURN_HINT_COUNT_MAX) break
    if (key === "sourceRequest" || !RETURN_HINT_KEY_RE.test(key)) continue
    addReturnHint(hints, seen, value)
    if (Array.isArray(value)) {
      for (const item of value) {
        addReturnHint(hints, seen, item)
        if (hints.length >= PACKET_RETURN_HINT_COUNT_MAX) break
      }
    }
  }

  return hints
}

export interface BuildAttentionQueueInput {
  drainedPending: PendingMessage[]
  outstandingObligations: ReturnObligation[]
  friendNameResolver: (friendId: string) => string | null
  packetResolver?: (packetId: string) => PonderPacket | null
}

export function buildAttentionQueue(input: BuildAttentionQueueInput): AttentionItem[] {
  const { drainedPending, outstandingObligations, friendNameResolver, packetResolver } = input
  const seen = new Set<string>()
  const items: AttentionItem[] = []

  const enrichPacket = (packetId: string | undefined): Partial<AttentionItem> => {
    if (!packetId || !packetResolver) return {}
    const packet = packetResolver(packetId)
    if (!packet) return { packetId }
    return {
      packetId,
      packetKind: packet.kind,
      packetObjective: packet.objective,
      packetSummary: packet.summary,
      packetSuccessCriteria: packet.successCriteria,
      packetSourceRequest: typeof packet.payload.sourceRequest === "string" ? packet.payload.sourceRequest : undefined,
      packetReturnHints: extractPacketReturnHints(packet),
    }
  }

  // Source 1: drained pending messages with delegatedFrom (current-turn delegations)
  for (const msg of drainedPending) {
    if (!msg.delegatedFrom) continue
    const { friendId, channel, key, bridgeId } = msg.delegatedFrom
    const oKey = originKey(friendId, channel, key)
    seen.add(oKey)

    const resolvedName = friendNameResolver(friendId)
    items.push({
      id: msg.obligationId ?? generateItemId(),
      friendId,
      friendName: resolvedName ?? friendId,
      channel,
      key,
      ...(bridgeId ? { bridgeId } : {}),
      delegatedContent: msg.content,
      ...(msg.obligationId ? { obligationId: msg.obligationId } : {}),
      ...enrichPacket(msg.packetId),
      source: "drained",
      timestamp: msg.timestamp,
    })
  }

  // Source 2: outstanding obligations (crash recovery)
  for (const obligation of outstandingObligations) {
    const { friendId, channel, key, bridgeId } = obligation.origin
    const oKey = originKey(friendId, channel, key)
    if (seen.has(oKey)) continue // deduplicate: prefer drained version
    seen.add(oKey)

    const resolvedName = friendNameResolver(friendId)
    items.push({
      id: obligation.id,
      friendId,
      friendName: resolvedName ?? friendId,
      channel,
      key,
      ...(bridgeId ? { bridgeId } : {}),
      delegatedContent: obligation.delegatedContent,
      obligationId: obligation.id,
      ...enrichPacket(obligation.packetId),
      source: "obligation-recovery",
      timestamp: obligation.createdAt,
    })
  }

  // Sort FIFO (oldest first)
  items.sort((a, b) => a.timestamp - b.timestamp)

  emitNervesEvent({
    event: "senses.attention_queue_built",
    component: "senses",
    message: `attention queue built with ${items.length} item(s)`,
    meta: {
      drainedCount: items.filter((i) => i.source === "drained").length,
      recoveredCount: items.filter((i) => i.source === "obligation-recovery").length,
    },
  })

  return items
}

// ── Queue operations ─────────────────────────────────────────────

export function dequeueAttentionItem(queue: AttentionItem[], id: string): AttentionItem | null {
  const index = queue.findIndex((item) => item.id === id)
  if (index === -1) return null
  return queue.splice(index, 1)[0]
}

export function attentionQueueEmpty(queue: AttentionItem[]): boolean {
  return queue.length === 0
}

// ── Queue visibility ─────────────────────────────────────────────

const CONTENT_PREVIEW_MAX = 80
const PACKET_SOURCE_PREVIEW_MAX = 240

function preview(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

export function buildAttentionQueueSummary(queue: AttentionItem[]): string {
  if (queue.length === 0) return ""

  const lines = [
    "[internal: current held work items — not messages to send]",
    "Only listed items are waiting now; older transcript mentions and completed returns/probes are not current pressure.",
    "To return one, call surface with delegationId set to the bracketed id.",
    "Return only the requested result; do not add commentary about prior attempts, old loops, or completed probes.",
    "If literal return options are listed, copy the chosen option exactly, including suffixes and punctuation.",
  ]
  for (const item of queue) {
    if (item.packetKind && item.packetObjective) {
      lines.push(`- [${item.id}] ${item.friendName} -> ${item.packetKind}: ${item.packetObjective}`)
      if (item.packetSuccessCriteria?.length) {
        lines.push(`  return criteria: ${item.packetSuccessCriteria.join("; ")}`)
      }
      if (item.packetReturnHints?.length) {
        lines.push(`  literal return options: ${item.packetReturnHints.map((hint) => `"${hint}"`).join("; ")}`)
      }
      const sourceRequest = item.packetSourceRequest ?? item.delegatedContent
      if (sourceRequest.trim().length > 0 && sourceRequest.trim() !== item.packetObjective.trim()) {
        lines.push(`  source request: "${preview(sourceRequest, PACKET_SOURCE_PREVIEW_MAX)}"`)
      }
      continue
    }
    lines.push(`- [${item.id}] ${item.friendName} asked: "${preview(item.delegatedContent, CONTENT_PREVIEW_MAX)}"`)
  }
  return lines.join("\n")
}

export function buildAttentionQueueStatusFrame(queue: AttentionItem[]): string {
  return buildAttentionQueueSummary(queue)
}
