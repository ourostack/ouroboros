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

export function buildAttentionQueueSummary(queue: AttentionItem[]): string {
  if (queue.length === 0) return ""

  const lines = ["you're holding:"]
  for (const item of queue) {
    if (item.packetKind && item.packetObjective) {
      lines.push(`- [${item.id}] ${item.friendName} -> ${item.packetKind}: ${item.packetObjective}`)
      continue
    }
    const preview = item.delegatedContent.length > CONTENT_PREVIEW_MAX
      ? `${item.delegatedContent.slice(0, CONTENT_PREVIEW_MAX - 3)}...`
      : item.delegatedContent
    lines.push(`- [${item.id}] ${item.friendName} asked: "${preview}"`)
  }
  return lines.join("\n")
}
