import * as path from "path"
import { FileFriendStore } from "@ouro.bot/friends"
import { getAgentRoot } from "../identity"
import { appendReplayNotice, isReplayWindowOpen } from "../../a2a/replay-harness"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CrossChatDeliveryRequest, CrossChatDirectDeliveryResult } from "../cross-chat-delivery"

/**
 * An A2A peer is a client that calls this agent's server; there is no channel back to it. When an await filed from
 * an A2A conversation resolves or expires, the outcome goes to the agent's owner in the owner's own Telegram chat,
 * written by the agent as itself (an owner notice, the same path that announces delegated commands). Nothing is
 * sent as the owner or to the peer, and the notice id is the await's delivery id, so a retry cannot double-send.
 */
const NOTICE_ID_MAX_BYTES = 512

export type NotifyOwner = (input: { noticeId: string; text: string }) => Promise<void>

export function createA2AAwaitOwnerDeliverer(agentName: string, notifyOwner: NotifyOwner = defaultNotifyOwner(agentName)) {
  return async (request: CrossChatDeliveryRequest): Promise<CrossChatDirectDeliveryResult> => {
    if (!request.deliveryId || Buffer.byteLength(request.deliveryId) > NOTICE_ID_MAX_BYTES) {
      return { status: "blocked", detail: "A2A await follow-up is missing a valid delivery id" }
    }
    try {
      const peer = await new FileFriendStore(path.join(getAgentRoot(agentName), "friends")).get(request.friendId)
      const agentRoot = getAgentRoot(agentName)
      if (isReplayWindowOpen(agentRoot, request.friendId)) {
        appendReplayNotice(agentRoot, { noticeId: request.deliveryId, text: request.content, friendId: request.friendId })
        return { status: "delivered_now", detail: "written to the replay sink (replay window open for this peer)" }
      }
      const from = peer?.name ?? "a connected agent"
      await notifyOwner({ noticeId: request.deliveryId, text: `Follow-up on a request from ${from}: ${request.content}` })
      return { status: "delivered_now", detail: "sent to the owner's Telegram chat as the agent" }
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.await_a2a_owner_notice_error",
        message: "A2A await follow-up could not be delivered to the owner",
        meta: { agentName, friendId: request.friendId, error: error instanceof Error ? error.message : String(error) },
      })
      return { status: "failed", detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function defaultNotifyOwner(agentName: string): NotifyOwner {
  return async (input) => {
    const { sendTelegramOwnerNotice } = await import("../../senses/telegram")
    await sendTelegramOwnerNotice(agentName, { ...input, signal: AbortSignal.timeout(30_000) })
  }
}
