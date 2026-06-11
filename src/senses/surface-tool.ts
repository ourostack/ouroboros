import { dequeueAttentionItem, type AttentionItem } from "./attention-queue"
import { emitNervesEvent } from "../nerves/runtime"

// ── Routing result ───────────────────────────────────────────────

export interface SurfaceRouteResult {
  status: "delivered" | "queued" | "deferred" | "failed"
  detail?: string
}

export interface SurfaceDeliveryHint {
  channel?: "auto" | "voice"
  phoneNumber?: string
}

// ── Handler ──────────────────────────────────────────────────────

export interface HandleSurfaceInput {
  content: string
  delegationId?: string
  friendId?: string
  deliveryHint?: SurfaceDeliveryHint
  queue: AttentionItem[]
  routeToFriend: (friendId: string, content: string, queueItem?: AttentionItem, deliveryHint?: SurfaceDeliveryHint) => Promise<SurfaceRouteResult>
  advanceObligation: (obligationId: string, update: { status: string; returnedAt?: number; returnTarget?: string }) => void
  completePonderPacket?: (packetId: string) => void
  fulfillHeartObligation?: (origin: { friendId: string; channel: string; key: string }) => void
  onRouteResult?: (event: { targetFriendId: string; queueItem?: AttentionItem; result: SurfaceRouteResult }) => void
}

export async function handleSurface(input: HandleSurfaceInput): Promise<string> {
  const {
    content,
    delegationId,
    friendId,
    deliveryHint,
    queue,
    routeToFriend,
    advanceObligation,
    completePonderPacket,
    fulfillHeartObligation,
    onRouteResult,
  } = input

  // Resolve target friend
  let targetFriendId: string
  let queueItem: AttentionItem | undefined

  const matchesFriend = (item: AttentionItem, target: string): boolean =>
    item.friendId === target || item.friendName.toLowerCase() === target.toLowerCase()

  const inferQueueItem = (target?: string): AttentionItem | string | undefined => {
    if (queue.length === 0) return undefined
    const candidates = target
      ? queue.filter((item) => matchesFriend(item, target))
      : queue
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      return `multiple held thoughts match ${target ?? "this surface call"} — use delegationId to choose one`
    }
    return undefined
  }

  if (delegationId) {
    // Look up in attention queue
    const found = queue.find((item) => item.id === delegationId)
    if (!found) {
      return `no delegation found with id ${delegationId} — check your attention queue`
    }
    targetFriendId = found.friendId
    queueItem = found
  } else if (friendId) {
    const inferred = inferQueueItem(friendId)
    if (typeof inferred === "string") return inferred
    queueItem = inferred
    targetFriendId = queueItem?.friendId ?? friendId
  } else {
    const inferred = inferQueueItem()
    if (typeof inferred === "string") return inferred
    if (inferred) {
      queueItem = inferred
      targetFriendId = inferred.friendId
    } else {
      return "specify who this thought is for — use delegationId to address a held thought, or friendId for spontaneous outreach"
    }
  }

  if (queueItem?.packetId && !delegationId) {
    return `held private return ${queueItem.id} is waiting — call surface with delegationId="${queueItem.id}" so the return is tied to the correct packet`
  }

  // Route to target
  const result = deliveryHint
    ? await routeToFriend(targetFriendId, content, queueItem, deliveryHint)
    : await routeToFriend(targetFriendId, content, queueItem)

  emitNervesEvent({
    event: "senses.surface_routed",
    component: "senses",
    message: `surface routed to ${targetFriendId}: ${result.status}`,
    meta: {
      targetFriendId,
      status: result.status,
      hasDelegationId: !!delegationId,
      ...(result.detail ? { detail: result.detail } : {}),
    },
  })
  onRouteResult?.({ targetFriendId, queueItem, result })

  // On successful routing with delegationId:
  // 1. Advance obligation to "returned" (disk FIRST — crash safety)
  // 2. Dequeue from process-local queue (AFTER obligation advance)
  if (queueItem && result.status !== "failed") {
    if (queueItem.obligationId) {
      advanceObligation(queueItem.obligationId, {
        status: "returned",
        returnedAt: Date.now(),
        returnTarget: "surface",
      })
    }
    if (completePonderPacket && queueItem.packetId) {
      try {
        completePonderPacket(queueItem.packetId)
      } catch {
        // swallowed — packet completion must never break surface delivery
      }
    }
    // Fulfill the heart obligation for this origin (separate from inner/mind obligation)
    if (fulfillHeartObligation) {
      try {
        fulfillHeartObligation({
          friendId: queueItem.friendId,
          channel: queueItem.channel,
          key: queueItem.key,
        })
      } catch {
        // swallowed — heart obligation fulfillment must never break surface delivery
      }
    }
    dequeueAttentionItem(queue, queueItem.id)
  }

  // Return delivery status
  const detail = result.detail ? ` — ${result.detail}` : ""
  return `${result.status}${detail}`
}
