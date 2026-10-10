import { createHash } from "crypto"
import type { Channel } from "@ouro.bot/friends"
import {
  deliverCrossChatMessage,
  type CrossChatDeliveryDeps,
  type CrossChatDeliveryRequest,
  type CrossChatDeliveryResult,
  type CrossChatDirectDeliveryResult,
} from "../../heart/cross-chat-delivery"
import { canonicalizeTelegramSessionKey } from "../../heart/config"
import { getAgentRoot } from "../../heart/identity"
import { getPendingDir, queuePendingMessage } from "../../mind/pending"
import { emitNervesEvent } from "../../nerves/runtime"

export interface OwnerNoticeTarget {
  friendId: string
  channel: string
  key: string
}

export interface OwnerNoticeDeps {
  deliver: (request: CrossChatDeliveryRequest, deps: CrossChatDeliveryDeps) => Promise<CrossChatDeliveryResult>
  queuePending: (agentName: string, target: OwnerNoticeTarget, text: string) => void
  deliverers: CrossChatDeliveryDeps["deliverers"]
  agentRoot?: string
}

type Deliverer = (request: CrossChatDeliveryRequest) => Promise<CrossChatDirectDeliveryResult>

/**
 * The live senders `send_message` uses that work from a CLI process. Teams needs
 * a bot connection this process does not have, so it falls through to the queue.
 */
export function defaultOwnerNoticeDeliverers(agentName: string): Partial<Record<Channel, Deliverer>> {
  return {
    bluebubbles: async (request) => {
      const { sendProactiveBlueBubblesMessageToSession } = await import("../bluebubbles")
      const result = await sendProactiveBlueBubblesMessageToSession({
        friendId: request.friendId,
        sessionKey: request.key,
        text: request.content,
        intent: request.intent,
        authorizingSession: request.authorizingSession,
      } as Parameters<typeof sendProactiveBlueBubblesMessageToSession>[0])
      if (result.delivered) return { status: "delivered_now", detail: "sent to the bluebubbles chat now" }
      if (result.reason === "missing_target") return { status: "blocked", detail: "bluebubbles could not resolve a routable target for that session" }
      if (result.reason === "blocked_meta_content") return { status: "blocked", detail: "blocked: contains internal meta markers" }
      if (result.reason === "send_error") return { status: "failed", detail: "bluebubbles send failed" }
      return { status: "unavailable", detail: "live delivery unavailable right now; queued for the next active turn" }
    },
    telegram: async (request) => {
      const key = canonicalizeTelegramSessionKey(request.key)
      const hash = createHash("sha256").update(`${request.friendId}\0${key}\0${request.content}`).digest("hex")
      const { sendTelegramAwaitFollowUp } = await import("../telegram")
      return sendTelegramAwaitFollowUp(agentName, {
        ...request,
        key,
        requestId: request.requestId ?? `local-audio-notice:${hash}`,
        deliveryId: request.deliveryId ?? `local-audio-notice:${hash}`,
      })
    },
  }
}

/**
 * Tell the owner about a local audio call right now, through the path
 * `send_message` uses. If live delivery fails, is blocked or throws, the notice
 * goes to the owner's pending queue so it is never lost.
 */
export async function notifyOwnerLive(
  agentName: string,
  target: OwnerNoticeTarget,
  text: string,
  overrides: Partial<OwnerNoticeDeps> = {},
): Promise<CrossChatDeliveryResult["status"]> {
  const root = overrides.agentRoot ?? getAgentRoot(agentName)
  const queue = overrides.queuePending ?? ((name, to, body) => {
    queuePendingMessage(getPendingDir(name, to.friendId, to.channel, to.key, root), {
      from: name,
      friendId: to.friendId,
      channel: to.channel,
      key: to.key,
      content: body,
      timestamp: Date.now(),
    })
  })
  const deliver = overrides.deliver ?? deliverCrossChatMessage
  try {
    const result = await deliver({
      friendId: target.friendId,
      channel: target.channel,
      key: target.key,
      content: text,
      intent: "generic_outreach",
    }, {
      agentName,
      queuePending: (message) => queue(agentName, target, message.content),
      deliverers: overrides.deliverers ?? defaultOwnerNoticeDeliverers(agentName),
    })
    if (result.status === "delivered_now" || result.status === "queued_for_later") return result.status
    emitNervesEvent({ component: "senses", event: "senses.voice_local_notice_fallback", message: `live owner notice ${result.status}; queued`, meta: { detail: result.detail } })
  } catch (error) {
    emitNervesEvent({ component: "senses", event: "senses.voice_local_notice_fallback", message: "live owner notice threw; queued", meta: { error: error instanceof Error ? error.message : String(error) } })
  }
  queue(agentName, target, text)
  return "queued_for_later"
}
