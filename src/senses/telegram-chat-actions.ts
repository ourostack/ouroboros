import type { ChatActions, ReplyTargetSelection } from "../repertoire/tools-base"
import { chatActionsForTurn } from "../repertoire/tools-chat"
import type { TelegramBotApi } from "./telegram-client"

/** One turn's Telegram chat actions, plus the reply target the turn's sends should use. */
export interface TelegramTurnChatActions {
  actions: ChatActions
  /** The message the next reply answers, or undefined to post it plainly. */
  replyToMessageId(): number | undefined
}

function telegramMessageId(value: string): number | undefined {
  return /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/**
 * Telegram turns here are one-to-one chats, where a reply reads plainly without quoting, so the default posts plainly.
 * The agent can still reply to a specific message.
 */
export function createTelegramChatActions(api: TelegramBotApi, chatId: string, inboundMessageId?: string): TelegramTurnChatActions {
  let selection: ReplyTargetSelection = { target: "current_lane" }
  return {
    actions: chatActionsForTurn({
      react: async (emoji, messageId) => {
        const id = telegramMessageId(messageId)
        if (id === undefined) return `${messageId} is not a Telegram message id.`
        await api.request("setMessageReaction", { chat_id: chatId, message_id: id, reaction: [{ type: "emoji", emoji }] })
        return `reacted with ${emoji}`
      },
      setReplyTarget: (next) => {
        if (next.target === "thread" && telegramMessageId(next.messageId) === undefined) return `${next.messageId} is not a Telegram message id.`
        selection = next
        return next.target === "thread" ? `my reply will answer message ${next.messageId}` : "my reply will post plainly in the chat"
      },
    }, inboundMessageId),
    replyToMessageId: () => selection.target === "thread" ? telegramMessageId(selection.messageId) : undefined,
  }
}
