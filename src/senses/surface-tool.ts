import { dequeueAttentionItem, type AttentionItem } from "./attention-queue"
import { emitNervesEvent } from "../nerves/runtime"

// ── Routing result ───────────────────────────────────────────────

export interface SurfaceRouteResult {
  status: "delivered" | "queued" | "deferred" | "failed"
  detail?: string
}

// ── Handler ──────────────────────────────────────────────────────

export interface HandleSurfaceInput {
  content: string
  delegationId?: string
  friendId?: string
  queue: AttentionItem[]
  routeToFriend: (friendId: string, content: string, queueItem?: AttentionItem) => Promise<SurfaceRouteResult>
  advanceObligation: (obligationId: string, update: { status: string; returnedAt?: number; returnTarget?: string }) => void
  fulfillHeartObligation?: (origin: { friendId: string; channel: string; key: string }) => void
}

export async function handleSurface(input: HandleSurfaceInput): Promise<string> {
  const { content, delegationId, friendId, queue, routeToFriend, advanceObligation, fulfillHeartObligation } = input

  // Resolve target friend
  let targetFriendId: string
  let queueItem: AttentionItem | undefined

  if (delegationId) {
    // Look up in attention queue
    const found = queue.find((item) => item.id === delegationId)
    if (!found) {
      return `no delegation found with id ${delegationId} — check your attention queue`
    }
    targetFriendId = found.friendId
    queueItem = found
  } else if (friendId) {
    targetFriendId = friendId
  } else {
    return "specify who this thought is for — use delegationId to address a held thought, or friendId for spontaneous outreach"
  }

  // Route to target
  const result = await routeToFriend(targetFriendId, content, queueItem)

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

  // On successful routing with delegationId:
  // 1. Advance obligation to "returned" (disk FIRST — crash safety)
  // 2. Dequeue from process-local queue (AFTER obligation advance)
  if (delegationId && queueItem && result.status !== "failed") {
    if (queueItem.obligationId) {
      advanceObligation(queueItem.obligationId, {
        status: "returned",
        returnedAt: Date.now(),
        returnTarget: "surface",
      })
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
    dequeueAttentionItem(queue, delegationId)
  }

  // Return delivery status
  const detail = result.detail ? ` — ${result.detail}` : ""
  return `${result.status}${detail}`
}
