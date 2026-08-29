import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTelegramSenseApp, opaqueTelegramSubject, telegramBotIdFromToken } from "../../senses/telegram"
import type { TelegramLongPollOptions } from "../../senses/telegram-client"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram admission integration", () => {
  it("derives production subjects from numeric bot identity rather than token rotation", () => {
    const identityKey = "k".repeat(43)
    expect(telegramBotIdFromToken("777:old-secret")).toBe("777")
    expect(telegramBotIdFromToken("777:rotated-secret")).toBe("777")
    expect(opaqueTelegramSubject(identityKey, telegramBotIdFromToken("777:old-secret"), "42", "42"))
      .toBe(opaqueTelegramSubject(identityKey, telegramBotIdFromToken("777:rotated-secret"), "42", "42"))
  })

  it("keeps unknown content pre-model, sends typed admission effects, then runs it once after owner approval", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-admission-app-")); roots.push(root)
    let pollOptions!: TelegramLongPollOptions
    let nextMessageId = 100
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []
    let displayCode = 0
    const runTurn = vi.fn(async () => ({ response: "", ponderDeferred: false, deliveries: [], deliveryFailures: [] }))
    const claimFriend = vi.fn(async () => ({ kind: "created" as const, friendId: "household-friend" }))
    const app = createTelegramSenseApp({
      agentName: "butler",
      credentials: { botToken: "777:secret", botId: "777", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43),
      _agentRoot: root,
      api: {
        request: vi.fn(async (method: string, body: Record<string, unknown>) => {
          requests.push({ method, body: structuredClone(body) })
          return method === "sendMessage" ? { message_id: nextMessageId++ } : true
        }),
        stop: vi.fn(),
      },
      offsetStore: { load: () => 0, save: vi.fn() },
      inboxStore: { load: vi.fn(() => []), loadPending: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), quarantineStranded: vi.fn(() => []), acknowledgeIndeterminateWarning: vi.fn(() => true), capture: vi.fn(() => true), claim: vi.fn(() => true), complete: vi.fn(), commit: vi.fn() },
      createLongPoll: (options) => { pollOptions = options; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      runTurn,
      migrateIdentity: async () => undefined,
      admission: { ownerFriendId: "ari", claimFriend, createDisplayCode: () => displayCode++ === 0 ? "PINE-4821" : "OAK-7314" },
    })

    await pollOptions.onUnknownMessage!({ updateId: 11, messageId: 22, botId: "777", userId: "888", chatId: "888", text: "hostile https://evil.invalid", displayLabel: "<Unknown>", hasAttachments: true })
    expect(runTurn).not.toHaveBeenCalled()
    expect(requests[0]).toEqual({ method: "sendMessage", body: { chat_id: "888", text: "Thanks — I’ve asked Ari.", parse_mode: "HTML" } })
    expect(requests[1]).toMatchObject({ method: "sendMessage", body: { chat_id: "42", parse_mode: "HTML", reply_markup: { inline_keyboard: [[
      { text: "Allow", callback_data: expect.stringMatching(/^admit:[a-f0-9]{20}:allow$/u) },
      { text: "Deny", callback_data: expect.stringMatching(/^admit:[a-f0-9]{20}:deny$/u) },
      { text: "Block", callback_data: expect.stringMatching(/^admit:[a-f0-9]{20}:block$/u) },
    ]] } } })
    expect(JSON.stringify(requests)).not.toContain("evil.invalid")

    const callbackData = ((requests[1]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data)
    const callback = { update_id: 12, callback_query: { id: "callback-1", from: { id: 42 }, data: callbackData, message: { message_id: 101, chat: { id: 42 } } } }
    await expect(Promise.all([pollOptions.onUpdate!(callback), pollOptions.onUpdate!(callback)])).resolves.toEqual([true, true])
    expect(claimFriend).toHaveBeenCalledTimes(1)
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      friendId: "household-friend",
      channel: "telegram",
      userMessage: "hostile https://evil.invalid",
      ingressRelations: {
        replyToEventId: null,
        threadRootEventId: null,
        references: [expect.stringMatching(/^telegram-admission:[a-f0-9]{20}$/u)],
      },
      identity: expect.objectContaining({ provider: "telegram-user" }),
    }))
    expect(requests).toContainEqual({ method: "answerCallbackQuery", body: { callback_query_id: "callback-1" } })

    await pollOptions.onUnknownMessage!({ updateId: 13, messageId: 23, botId: "777", userId: "999", chatId: "999", text: "second quarantined request", displayLabel: "Second", hasAttachments: false })
    await pollOptions.onMessage({ updateId: 14, messageId: 24, userId: "42", chatId: "42", text: "Allow OAK-7314" })
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn.mock.calls[1]![0]).toMatchObject({ friendId: "household-friend", userMessage: "second quarantined request" })
    expect(JSON.stringify(runTurn.mock.calls)).not.toContain("Allow OAK-7314")
    await app.stop()
  })
})
