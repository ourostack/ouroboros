import * as path from "path"
import { FileFriendStore } from "@ouro.bot/friends"
import { getAgentRoot } from "../identity"
import { appendReplayNotice, isReplayWindowOpen } from "../../a2a/replay-harness"
import { FileOutboxStore } from "../../a2a/outbox-store"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CrossChatDeliveryRequest, CrossChatDirectDeliveryResult } from "../cross-chat-delivery"

/**
 * An A2A peer is a client that calls this agent's server; there is no channel back to it. When an await filed from
 * an A2A conversation resolves or expires, the outcome goes to the agent's owner in the owner's own Telegram chat,
 * written by the agent as itself (an owner notice, the same path that announces delegated commands). Nothing is
 * sent as the owner or to the peer, and the notice id is the await's delivery id, so a retry cannot double-send.
 *
 * An await filed in a plain A2A conversation (no request id) was not delegated by the owner, so the owner hears nothing
 * and the outcome goes to the peer instead: into its own outbox, which it reads with `outbox/list`. A question that needs
 * the owner's decision is the exception, because only the owner can answer it: the peer is told, in one fixed
 * sentence that never repeats the question, that the owner was asked, and the owner is asked as before.
 */
const NOTICE_ID_MAX_BYTES = 512

/** The owner's question can carry anything the Butler read or wrote, so a plain peer is told only that the owner was asked. */
export const PEER_ASKED_OWNER_TEXT = "I've asked my owner and will let you know."

/** A question for the owner reads as the owner's own question, with a pointer to the request it is about; every other outcome is a follow-up report. */
export function askedOwnerText(question: string, about: string): string {
  return `${question}\n\n(about the request from ${about})`
}

function ownerNoticeText(request: CrossChatDeliveryRequest, from: string): string {
  return request.noticeKind === "asked_owner" ? askedOwnerText(request.content, from) : `Follow-up on a request from ${from}: ${request.content}`
}

export type NotifyOwner = (input: { noticeId: string; text: string }) => Promise<void>

export function createA2AAwaitOwnerDeliverer(agentName: string, notifyOwner: NotifyOwner = defaultNotifyOwner(agentName)) {
  return async (request: CrossChatDeliveryRequest): Promise<CrossChatDirectDeliveryResult> => {
    if (!request.deliveryId || Buffer.byteLength(request.deliveryId) > NOTICE_ID_MAX_BYTES) {
      return { status: "blocked", detail: "A2A await follow-up is missing a valid delivery id" }
    }
    try {
      const peer = await new FileFriendStore(path.join(getAgentRoot(agentName), "friends")).get(request.friendId)
      const agentRoot = getAgentRoot(agentName)
      const from = peer?.name ?? "a connected agent"
      const peerAwait = !request.requestId
      if (peerAwait) {
        const body = request.noticeKind === "asked_owner"
          ? PEER_ASKED_OWNER_TEXT
          : request.content
        await new FileOutboxStore(agentRoot).appendOnce(request.friendId, request.deliveryId, { kind: "await_outcome", body, meta: { outcome: request.noticeKind ?? "follow_up" } })
        if (request.noticeKind !== "asked_owner") return { status: "delivered_now", detail: "posted to the peer's outbox" }
      }
      if (isReplayWindowOpen(agentRoot, request.friendId)) {
        appendReplayNotice(agentRoot, { noticeId: request.deliveryId, text: request.noticeKind === "asked_owner" ? ownerNoticeText(request, from) : request.content, friendId: request.friendId })
        return { status: "delivered_now", detail: "written to the replay sink (replay window open for this peer)" }
      }
      await notifyOwner({ noticeId: request.deliveryId, text: ownerNoticeText(request, from) })
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
