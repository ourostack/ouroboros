import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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

  it("sends a photo inline and any other file as a document, following the reply target", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-send-file-"))
    const photo = path.join(dir, "dinner.jpg")
    const menu = path.join(dir, "menu.pdf")
    fs.writeFileSync(photo, "jpg")
    fs.writeFileSync(menu, "%PDF")
    const request = vi.fn(async () => ({ message_id: 5 }))
    const chat = createTelegramChatActions({ request, stop: vi.fn() }, "77", "12")

    expect(await chat.actions.sendFile!(photo, "  tonight  ")).toBe("sent dinner.jpg")
    expect(request).toHaveBeenLastCalledWith("sendPhoto", {
      chat_id: "77", caption: "tonight",
      photo: { kind: "telegram_input_file", name: "dinner.jpg", contentType: "image/jpeg", bytes: Buffer.from("jpg") },
    })
    chat.actions.setReplyTarget!({ target: "thread" })
    expect(await chat.actions.sendFile!(menu, "")).toBe("sent menu.pdf")
    expect(request).toHaveBeenLastCalledWith("sendDocument", {
      chat_id: "77", reply_parameters: { message_id: 12 },
      document: { kind: "telegram_input_file", name: "menu.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF") },
    })
    await expect(chat.actions.sendFile!(menu, "x".repeat(1_025))).rejects.toThrow("a Telegram caption can be up to 1,024 characters")
    expect(request).toHaveBeenCalledTimes(2)
  })
})
