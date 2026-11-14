import { describe, expect, it, vi } from "vitest"

import { createTelegramChatActions } from "../../senses/telegram-chat-actions"

describe("createTelegramChatActions", () => {
  it("reacts with one emoji on the named message in this chat", async () => {
    const request = vi.fn(async () => true)
    const chat = createTelegramChatActions({ request, stop: vi.fn() }, "77", "12")
    expect(await chat.actions.react!("❤️")).toBe("reacted with ❤️")
    expect(request).toHaveBeenCalledWith("setMessageReaction", { chat_id: "77", message_id: 12, reaction: [{ type: "emoji", emoji: "❤️" }] })
    expect(await chat.actions.react!("❤️", "not-an-id")).toBe("not-an-id is not a Telegram message id.")
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("posts plainly by default and replies to a message only when asked", () => {
    const chat = createTelegramChatActions({ request: vi.fn(), stop: vi.fn() }, "77")
    expect(chat.replyToMessageId()).toBeUndefined()
    expect(chat.actions.setReplyTarget!({ target: "thread", messageId: "abc" })).toBe("abc is not a Telegram message id.")
    expect(chat.replyToMessageId()).toBeUndefined()
    expect(chat.actions.setReplyTarget!({ target: "thread", messageId: "40" })).toBe("my reply will answer message 40")
    expect(chat.replyToMessageId()).toBe(40)
    expect(chat.actions.setReplyTarget!({ target: "top_level" })).toBe("my reply will post plainly in the chat")
    expect(chat.replyToMessageId()).toBeUndefined()
  })
})
