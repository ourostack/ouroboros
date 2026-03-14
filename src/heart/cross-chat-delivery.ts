import type { PendingMessage } from "../mind/pending"
import { isTrustedLevel, type Channel, type TrustLevel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"

export type CrossChatDeliveryIntent = "generic_outreach" | "explicit_cross_chat"

export interface CrossChatDeliveryRequest {
  friendId: string
  channel: string
  key: string
  content: string
  intent: CrossChatDeliveryIntent
  authorizingSession?: {
    friendId: string
    channel: string
    key: string
    trustLevel?: TrustLevel
  }
}

export interface CrossChatDeliveryResult {
  status: "delivered_now" | "queued_for_later" | "blocked" | "failed"
  detail: string
}

export interface CrossChatDirectDeliveryResult {
  status: "delivered_now" | "unavailable" | "blocked" | "failed"
  detail: string
}

export interface CrossChatDeliveryDeps {
  agentName: string
  queuePending: (message: PendingMessage) => void
  deliverers?: Partial<Record<Channel, (request: CrossChatDeliveryRequest) => Promise<CrossChatDirectDeliveryResult>>>
  now?: () => number
}

function buildPendingEnvelope(request: CrossChatDeliveryRequest, agentName: string, now: number): PendingMessage {
  return {
    from: agentName,
    friendId: request.friendId,
    channel: request.channel,
    key: request.key,
    content: request.content,
    timestamp: now,
  }
}

function queueForLater(
  request: CrossChatDeliveryRequest,
  deps: CrossChatDeliveryDeps,
  detail: string,
): CrossChatDeliveryResult {
  deps.queuePending(buildPendingEnvelope(request, deps.agentName, (deps.now ?? Date.now)()))
  return {
    status: "queued_for_later",
    detail,
  }
}

function isExplicitlyAuthorized(request: CrossChatDeliveryRequest): boolean {
  return request.intent === "explicit_cross_chat"
    && Boolean(request.authorizingSession)
    && isTrustedLevel(request.authorizingSession?.trustLevel)
}

export async function deliverCrossChatMessage(
  request: CrossChatDeliveryRequest,
  deps: CrossChatDeliveryDeps,
): Promise<CrossChatDeliveryResult> {
  emitNervesEvent({
    component: "engine",
    event: "engine.cross_chat_delivery_start",
    message: "resolving cross-chat delivery",
    meta: {
      friendId: request.friendId,
      channel: request.channel,
      key: request.key,
      intent: request.intent,
      authorizingTrustLevel: request.authorizingSession?.trustLevel ?? null,
    },
  })

  if (request.intent === "generic_outreach") {
    const result = queueForLater(
      request,
      deps,
      "generic outreach stays queued until the target session is next active",
    )
    emitNervesEvent({
      component: "engine",
      event: "engine.cross_chat_delivery_end",
      message: "queued generic outreach for later delivery",
      meta: {
        friendId: request.friendId,
        channel: request.channel,
        key: request.key,
        status: result.status,
      },
    })
    return result
  }

  if (!isExplicitlyAuthorized(request)) {
    const result = {
      status: "blocked",
      detail: "explicit cross-chat delivery requires a trusted asking session",
    } satisfies CrossChatDeliveryResult
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.cross_chat_delivery_end",
      message: "blocked explicit cross-chat delivery",
      meta: {
        friendId: request.friendId,
        channel: request.channel,
        key: request.key,
        status: result.status,
      },
    })
    return result
  }

  const deliverer = deps.deliverers?.[request.channel as Channel]
  if (!deliverer) {
    const result = queueForLater(
      request,
      deps,
      "live delivery unavailable right now; queued for the next active turn",
    )
    emitNervesEvent({
      component: "engine",
      event: "engine.cross_chat_delivery_end",
      message: "queued explicit cross-chat delivery because no live deliverer was available",
      meta: {
        friendId: request.friendId,
        channel: request.channel,
        key: request.key,
        status: result.status,
      },
    })
    return result
  }

  try {
    const direct = await deliverer(request)
    if (direct.status === "delivered_now" || direct.status === "blocked" || direct.status === "failed") {
      const result = {
        status: direct.status,
        detail: direct.detail,
      } satisfies CrossChatDeliveryResult
      emitNervesEvent({
        level: result.status === "failed" ? "error" : result.status === "blocked" ? "warn" : "info",
        component: "engine",
        event: "engine.cross_chat_delivery_end",
        message: "completed direct cross-chat delivery resolution",
        meta: {
          friendId: request.friendId,
          channel: request.channel,
          key: request.key,
          status: result.status,
        },
      })
      return result
    }

    const result = queueForLater(
      request,
      deps,
      direct.detail.trim() || "live delivery unavailable right now; queued for the next active turn",
    )
    emitNervesEvent({
      component: "engine",
      event: "engine.cross_chat_delivery_end",
      message: "queued explicit cross-chat delivery after adapter reported unavailability",
      meta: {
        friendId: request.friendId,
        channel: request.channel,
        key: request.key,
        status: result.status,
      },
    })
    return result
  } catch (error) {
    const result = {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    } satisfies CrossChatDeliveryResult
    emitNervesEvent({
      level: "error",
      component: "engine",
      event: "engine.cross_chat_delivery_end",
      message: "cross-chat delivery threw unexpectedly",
      meta: {
        friendId: request.friendId,
        channel: request.channel,
        key: request.key,
        status: result.status,
        reason: result.detail,
      },
    })
    return result
  }
}
