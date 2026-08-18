import { describe, expect, it, vi } from "vitest"

import { createTelegramSenseApp } from "../../senses/telegram"
import type { TelegramBotApi, TelegramInboundMessage, TelegramLongPoll } from "../../senses/telegram-client"

function fixture() {
  let onMessage: ((message: TelegramInboundMessage) => Promise<void>) | undefined
  let onUpdate: ((update: any) => Promise<boolean>) | undefined
  const poll: TelegramLongPoll = {
    pollOnce: vi.fn(async () => 0),
    run: vi.fn(async () => undefined),
    stop: vi.fn(),
  }
  const api: TelegramBotApi = {
    request: vi.fn(async () => ({ message_id: 71 })),
    stop: vi.fn(),
  }
  const createLongPoll = vi.fn((options: any) => {
    onMessage = options.onMessage
    onUpdate = options.onUpdate
    return poll
  })
  const runTurn = vi.fn(async (options: any) => {
    await options.deliverySink.onDelivery({ kind: "settle", text: "All systems nominal." })
    return {
      response: "All systems nominal.",
      ponderDeferred: false,
      deliveries: [{ kind: "settle", text: "All systems nominal." }],
      deliveryFailures: [],
    }
  })
  const approvalTransport = {
    sendApproval: vi.fn(),
    handleUpdate: vi.fn(async () => ({ handled: true, accepted: true, reason: "accepted" })),
    reconcileExpired: vi.fn(async () => undefined),
  }
  const app = createTelegramSenseApp({
    agentName: "butler",
    credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
    api,
    offsetStore: { load: () => 0, save: vi.fn() },
    createLongPoll,
    runTurn,
    approvalTransport,
  })
  return { app, api, poll, runTurn, approvalTransport, getOnMessage: () => onMessage!, getOnUpdate: () => onUpdate! }
}

describe("Telegram sense", () => {
  it("maps one authorized private update into the shared Telegram turn and delivery route", async () => {
    const f = fixture()
    await f.getOnMessage()({ updateId: 9, messageId: "10", userId: "42", chatId: "42", text: "health?" })

    expect(f.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "butler",
      channel: "telegram",
      sessionKey: "telegram:42",
      friendId: "telegram-user:42",
      identity: { provider: "telegram-user", externalId: "42", displayName: "Telegram user 42" },
      userMessage: "health?",
    }))
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "42",
      text: "All systems nominal.",
      parse_mode: "HTML",
    }, undefined)
  })

  it("routes callback updates only through the approval transport", async () => {
    const f = fixture()
    const update = { update_id: 10, callback_query: { id: "cb", from: { id: 42 }, data: "opaque" } }
    await expect(f.getOnUpdate()(update)).resolves.toBe(true)
    expect(f.approvalTransport.handleUpdate).toHaveBeenCalledWith(update)
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it("reconciles approvals before polling and stops both poll and API", async () => {
    const f = fixture()
    await f.app.run()
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledBefore(f.poll.run as any)
    f.app.stop()
    expect(f.poll.stop).toHaveBeenCalledOnce()
    expect(f.api.stop).toHaveBeenCalledOnce()
  })

  it("supports proactive private delivery through the same bounded formatter", async () => {
    const f = fixture()
    await f.app.sendProactive("Array recovered")
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "42",
      text: "Array recovered",
      parse_mode: "HTML",
    }, undefined)
  })
})
