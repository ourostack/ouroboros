import { describe, expect, it, vi } from "vitest"

import {
  createTelegramApprovalAdapter,
  escapeTelegramHtml,
  type TelegramApprovalDecision,
  type TelegramPersistedPendingApproval,
  type TelegramApprovalUpdate,
} from "../../../scripts/approval-spike/telegram-adapter"

const BOT_TOKEN = "unit-test-token-not-a-secret"
const CHAT_ID = "7001"
const USER_ID = "42"

type FetchCall = { url: string; body: Record<string, unknown> }

function telegramResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify(status >= 400
    ? { ok: false, error_code: status, description: "synthetic error" }
    : { ok: true, result }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function callbackUpdate(input: {
  callbackData: string
  callbackId?: string
  userId?: string
  chatId?: string
  messageId?: number
}): TelegramApprovalUpdate {
  return {
    update_id: 101,
    callback_query: {
      id: input.callbackId ?? "callback-1",
      from: { id: Number(input.userId ?? USER_ID) },
      data: input.callbackData,
      message: {
        message_id: input.messageId ?? 99,
        chat: { id: Number(input.chatId ?? CHAT_ID) },
      },
    },
  }
}

function fixture(overrides: {
  responses?: Response[]
  onDecision?: (decision: TelegramApprovalDecision) => Promise<{ accepted: boolean; terminalText: string }>
  handles?: string[]
  pendingStore?: {
    load: () => TelegramPersistedPendingApproval[]
    save: (records: TelegramPersistedPendingApproval[]) => void
  }
  resolveDecisionToken?: (approvalId: string) => Promise<string>
} = {}) {
  const calls: FetchCall[] = []
  const responses = [...(overrides.responses ?? [])]
  const respond = vi.fn(async () => responses.shift() ?? telegramResponse(true))
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
    return (await respond()).clone()
  })
  const sleep = vi.fn(async (_milliseconds: number) => undefined)
  const onDecision = vi.fn(overrides.onDecision ?? (async (decision: TelegramApprovalDecision) => ({
    accepted: true,
    terminalText: decision.decision === "approve" ? "✅ Approved — running" : "❌ Denied",
  })))
  const handles = [...(overrides.handles ?? ["approve-handle", "deny-handle"])]
  const adapter = createTelegramApprovalAdapter({
    botToken: BOT_TOKEN,
    expectedUserId: USER_ID,
    expectedChatId: CHAT_ID,
    fetch,
    sleep,
    createOpaqueHandle: () => handles.shift() ?? "unused-handle",
    onDecision,
    pendingStore: overrides.pendingStore,
    resolveDecisionToken: overrides.resolveDecisionToken,
  })
  return { adapter, calls, fetch, respond, sleep, onDecision }
}

async function prompt(f = fixture()) {
  f.respond.mockResolvedValueOnce(telegramResponse({ message_id: 99, chat: { id: Number(CHAT_ID) } }))
  const sent = await f.adapter.sendApproval({
    approvalId: "approval-1",
    decisionToken: "server-side-decision-token",
    prompt: "Restart <calibre-web> & verify?",
    expiresAt: "2099-08-17T18:30:00.000Z",
  })
  return { ...f, sent }
}

describe("test-only Telegram approval adapter", () => {
  it("escapes the complete Telegram HTML special-character set", () => {
    expect(escapeTelegramHtml("<restart> & done")).toBe("&lt;restart&gt; &amp; done")
  })

  it("sends one HTML approval prompt with byte-bounded opaque callbacks and no decision token", async () => {
    const f = await prompt()

    expect(f.sent).toEqual({ messageId: "99", approveCallbackData: "a:approve-handle", denyCallbackData: "d:deny-handle" })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toEqual({
      url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      body: {
        chat_id: CHAT_ID,
        text: "Restart &lt;calibre-web&gt; &amp; verify?",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "Approve", callback_data: "a:approve-handle" },
            { text: "Deny", callback_data: "d:deny-handle" },
          ]],
        },
      },
    })
    expect(Buffer.byteLength(f.sent.approveCallbackData, "utf8")).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(f.sent.denyCallbackData, "utf8")).toBeLessThanOrEqual(64)
    expect(JSON.stringify(f.calls)).not.toContain("server-side-decision-token")
    expect(JSON.stringify(f.calls)).not.toContain("approval-1")
  })

  it.each([
    ["null", "null"],
    ["primitive", JSON.stringify("not-an-envelope")],
    ["array", "[]"],
  ])("fails closed when Telegram returns a %s API envelope", async (_label, body) => {
    const f = fixture({ responses: [new Response(body)] })

    await expect(f.adapter.sendApproval({
      approvalId: "approval-1",
      decisionToken: "private-invalid-envelope-token",
      prompt: "safe",
      expiresAt: "2099-08-17T18:30:00.000Z",
    })).rejects.toThrow("Telegram returned an invalid response")
    expect(JSON.stringify(f.calls)).not.toContain("private-invalid-envelope-token")
  })

  it("fails a 429 without retry_after instead of retrying indefinitely", async () => {
    const f = fixture({ responses: [new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 429 })] })

    await expect(f.adapter.sendApproval({
      approvalId: "approval-1",
      decisionToken: "private-malformed-retry-token",
      prompt: "safe",
      expiresAt: "2099-08-17T18:30:00.000Z",
    })).rejects.toThrow("Telegram sendMessage failed with 429")
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it.each([
    ["null rejection", null],
    ["primitive rejection", "network unavailable"],
    ["ordinary error", new Error("network unavailable")],
  ])("does not reinterpret a %s as an HTML formatting rejection", async (_label, rejection) => {
    const f = fixture()
    f.respond.mockRejectedValueOnce(rejection)

    await expect(f.adapter.sendApproval({
      approvalId: "approval-1",
      decisionToken: "private-network-error-token",
      prompt: "safe",
      expiresAt: "2099-08-17T18:30:00.000Z",
    })).rejects.toBe(rejection)
    expect(f.calls).toHaveLength(1)
  })

  it("does not reinterpret a non-400 Telegram API error as an HTML formatting rejection", async () => {
    const f = fixture({ responses: [telegramResponse(null, 500)] })

    await expect(f.adapter.sendApproval({
      approvalId: "approval-1",
      decisionToken: "private-api-error-token",
      prompt: "safe",
      expiresAt: "2099-08-17T18:30:00.000Z",
    })).rejects.toThrow("synthetic error")
    expect(f.calls).toHaveLength(1)
  })

  it.each([
    ["pending approve handle", ["approve", "deny", "approve", "other-deny"]],
    ["pending deny handle", ["approve", "deny", "other-approve", "deny"]],
  ] as const)("rejects a %s collision without sending the colliding prompt", async (_label, handles) => {
    const f = fixture({ handles: [...handles] })
    if (handles.length === 4) {
      f.respond.mockResolvedValueOnce(telegramResponse({ message_id: 99 }))
      await f.adapter.sendApproval({ approvalId: "approval-1", decisionToken: "first-token", prompt: "first", expiresAt: "2099-08-17T18:30:00.000Z" })
    }

    await expect(f.adapter.sendApproval({ approvalId: "approval-2", decisionToken: "second-token", prompt: "second", expiresAt: "2099-08-17T18:30:00.000Z" }))
      .rejects.toThrow("callback handle collision")
    expect(f.calls).toHaveLength(handles.length === 4 ? 1 : 0)
  })

  it.each([
    ["null", null],
    ["array", []],
    ["object without message_id", { chat: { id: Number(CHAT_ID) } }],
  ])("fails closed when sendMessage returns a %s result", async (_label, result) => {
    const f = fixture({ responses: [telegramResponse(result)] })

    await expect(f.adapter.sendApproval({ approvalId: "approval-1", decisionToken: "private-result-token", prompt: "safe", expiresAt: "2099-08-17T18:30:00.000Z" }))
      .rejects.toThrow("did not include message_id")
  })

  it.each([
    ["approve", "a:approve-handle", "✅ Approved — running"],
    ["deny", "d:deny-handle", "❌ Denied"],
  ] as const)("acknowledges, binds, and terminalizes a valid %s callback", async (decision, callbackData, terminalText) => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockResolvedValueOnce(telegramResponse(true))

    const outcome = await f.adapter.handleUpdate(callbackUpdate({ callbackData }))

    expect(outcome).toEqual({ handled: true, accepted: true, reason: "accepted" })
    expect(f.onDecision).toHaveBeenCalledWith({
      approvalId: "approval-1",
      decisionToken: "server-side-decision-token",
      decision,
      requesterId: USER_ID,
      transport: "telegram",
      transportChatId: CHAT_ID,
      transportMessageId: "99",
    })
    expect(f.calls.slice(1)).toEqual([
      {
        url: `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
        body: { callback_query_id: "callback-1" },
      },
      {
        url: `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`,
        body: { chat_id: CHAT_ID, message_id: 99, text: terminalText, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      },
    ])
  })

  it.each([
    ["foreign user", { userId: "43" }, "foreign_user"],
    ["foreign chat", { chatId: "7002" }, "foreign_chat"],
    ["foreign message", { messageId: 100 }, "foreign_message"],
    ["unknown handle", { callbackData: "a:unknown" }, "stale_callback"],
  ])("acknowledges but refuses a %s callback without deciding or editing", async (_label, change, reason) => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    const update = callbackUpdate({ callbackData: "a:approve-handle", ...change })

    expect(await f.adapter.handleUpdate(update)).toEqual({ handled: true, accepted: false, reason })
    expect(f.onDecision).not.toHaveBeenCalled()
    expect(f.calls.slice(1)).toEqual([{
      url: `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      body: { callback_query_id: "callback-1", text: "This approval is no longer valid.", show_alert: true },
    }])
  })

  it("treats Telegram's expired-query acknowledgement error as a stale callback", async () => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: query is too old and response timeout expired or query ID is invalid",
    }), { status: 400, headers: { "content-type": "application/json" } }))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:unknown" }))).resolves.toEqual({
      handled: true,
      accepted: false,
      reason: "stale_callback",
    })
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it("surfaces a non-expiry acknowledgement failure", async () => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(false, 500))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:unknown" })))
      .rejects.toThrow("synthetic error")
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it("continues an authenticated decision when Telegram says its acknowledgement expired", async () => {
    const f = await prompt()
    f.respond
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: query is too old and response timeout expired or query ID is invalid",
      }), { status: 400, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(telegramResponse(true))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "d:deny-handle" }))).resolves.toEqual({
      handled: true,
      accepted: true,
      reason: "accepted",
    })
    expect(f.onDecision).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["missing callback data", callbackUpdate({ callbackData: "a:approve-handle" }), "stale_callback"],
    ["missing callback message", callbackUpdate({ callbackData: "a:approve-handle" }), "foreign_chat"],
  ])("fails closed for a %s", async (label, update, reason) => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    if (label === "missing callback data") delete update.callback_query!.data
    else delete update.callback_query!.message

    await expect(f.adapter.handleUpdate(update)).resolves.toEqual({ handled: true, accepted: false, reason })
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it("makes a successful callback terminal and refuses duplicate/stale reuse", async () => {
    const f = await prompt()
    f.respond.mockResolvedValue(telegramResponse(true))
    const update = callbackUpdate({ callbackData: "a:approve-handle" })

    expect(await f.adapter.handleUpdate(update)).toMatchObject({ accepted: true })
    expect(await f.adapter.handleUpdate({ ...update, callback_query: { ...update.callback_query!, id: "callback-2" } })).toEqual({
      handled: true,
      accepted: false,
      reason: "stale_callback",
    })
    expect(f.onDecision).toHaveBeenCalledTimes(1)
    expect(f.calls.at(-1)).toEqual({
      url: `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
      body: { callback_query_id: "callback-2", text: "This approval is no longer valid.", show_alert: true },
    })
  })

  it("restores opaque callback bindings after restart without persisting the decision token", async () => {
    let durableRecords: TelegramPersistedPendingApproval[] = []
    const pendingStore = {
      load: vi.fn(() => structuredClone(durableRecords)),
      save: vi.fn((records: TelegramPersistedPendingApproval[]) => { durableRecords = structuredClone(records) }),
    }
    const first = await prompt(fixture({ pendingStore }))

    expect(JSON.stringify(durableRecords)).not.toContain("server-side-decision-token")
    expect(durableRecords).toEqual([{
      approvalId: "approval-1",
      messageId: "99",
      approveCallbackData: "a:approve-handle",
      denyCallbackData: "d:deny-handle",
      expiresAt: "2099-08-17T18:30:00.000Z",
    }])

    const resolveDecisionToken = vi.fn(async () => "server-side-decision-token")
    const restarted = fixture({ pendingStore, resolveDecisionToken })
    restarted.respond.mockResolvedValue(telegramResponse(true))
    const outcome = await restarted.adapter.handleUpdate(callbackUpdate({ callbackData: first.sent.approveCallbackData }))

    expect(outcome).toEqual({ handled: true, accepted: true, reason: "accepted" })
    expect(resolveDecisionToken).toHaveBeenCalledWith("approval-1")
    expect(restarted.onDecision).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1",
      decisionToken: "server-side-decision-token",
    }))
    expect(durableRecords).toEqual([])
  })

  it("durably records the terminal outcome before removing restored handles", async () => {
    let durableRecords: TelegramPersistedPendingApproval[] = [{
      approvalId: "approval-1",
      messageId: "99",
      approveCallbackData: "a:approve-handle",
      denyCallbackData: "d:deny-handle",
      expiresAt: "2099-08-17T18:30:00.000Z",
    }]
    const events: string[] = []
    const pendingStore = {
      load: () => structuredClone(durableRecords),
      save: (records: TelegramPersistedPendingApproval[]) => {
        durableRecords = structuredClone(records)
        events.push(records.length === 0 ? "persisted-consumed" : "persisted-terminal")
      },
    }
    const f = fixture({
      pendingStore,
      resolveDecisionToken: async () => { events.push("resolved-token"); return "server-side-decision-token" },
    })
    f.respond.mockImplementation(async () => { events.push("telegram-request"); return telegramResponse(true) })

    await f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" }))

    expect(events).toEqual([
      "telegram-request",
      "resolved-token",
      "persisted-terminal",
      "telegram-request",
      "persisted-consumed",
    ])
    expect(durableRecords).toEqual([])
  })

  it("fails closed after restart when no durable token resolver is configured", async () => {
    const pendingStore = {
      load: () => [{
        approvalId: "approval-1",
        messageId: "99",
        approveCallbackData: "a:approve-handle",
        denyCallbackData: "d:deny-handle",
        expiresAt: "2099-08-17T18:30:00.000Z",
      }],
      save: vi.fn(),
    }
    const f = fixture({ pendingStore })
    f.respond.mockResolvedValue(telegramResponse(true))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" })))
      .rejects.toThrow("decision token resolver")
    expect(f.onDecision).not.toHaveBeenCalled()
    expect(pendingStore.save).not.toHaveBeenCalled()
  })

  it("rejects colliding persisted callback bindings during startup", () => {
    const first: TelegramPersistedPendingApproval = {
      approvalId: "approval-1",
      messageId: "99",
      approveCallbackData: "a:duplicate",
      denyCallbackData: "d:first",
      expiresAt: "2099-08-17T18:30:00.000Z",
    }
    const second = { ...first, approvalId: "approval-2", messageId: "100", denyCallbackData: "d:second" }

    expect(() => fixture({ pendingStore: { load: () => [first, second], save: vi.fn() } }))
      .toThrow("persisted approval callback handle collision")
  })

  it("removes in-memory handles and fails before authority when durable prompt persistence fails", async () => {
    const pendingStore = {
      load: () => [],
      save: vi.fn(() => { throw new Error("pending store unavailable") }),
    }
    const f = fixture({ pendingStore })
    f.respond.mockResolvedValueOnce(telegramResponse({ message_id: 99 }))

    await expect(f.adapter.sendApproval({
      approvalId: "approval-1",
      decisionToken: "private-persistence-error-token",
      prompt: "safe",
      expiresAt: "2099-08-17T18:30:00.000Z",
    })).rejects.toThrow("pending store unavailable")
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" })))
      .resolves.toEqual({ handled: true, accepted: false, reason: "stale_callback" })
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it("atomically consumes a callback before any await so concurrent duplicates reach authority once", async () => {
    const authority = deferred<{ accepted: boolean; terminalText: string }>()
    const f = await prompt(fixture({ onDecision: () => authority.promise }))
    f.respond.mockResolvedValue(telegramResponse(true))
    const first = f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle", callbackId: "callback-1" }))
    const second = f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle", callbackId: "callback-2" }))

    await vi.waitFor(() => {
      expect(f.onDecision).toHaveBeenCalledTimes(1)
      expect(f.calls.some((call) => call.body.callback_query_id === "callback-2")).toBe(true)
    })
    authority.resolve({ accepted: true, terminalText: "✅ Approved — running" })

    await expect(first).resolves.toEqual({ handled: true, accepted: true, reason: "accepted" })
    await expect(second).resolves.toEqual({ handled: true, accepted: false, reason: "stale_callback" })
    expect(f.onDecision).toHaveBeenCalledTimes(1)
  })

  it("completes callback acknowledgement before awaiting slow decision authority", async () => {
    const authority = deferred<{ accepted: boolean; terminalText: string }>()
    const acknowledgement = deferred<Response>()
    const f = await prompt(fixture({ onDecision: () => authority.promise }))
    f.respond.mockImplementationOnce(() => acknowledgement.promise)
    const pending = f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" }))

    await vi.waitFor(() => expect(f.calls.at(-1)?.url).toMatch(/answerCallbackQuery$/))
    expect(f.onDecision).not.toHaveBeenCalled()
    acknowledgement.resolve(telegramResponse(true))
    await vi.waitFor(() => expect(f.onDecision).toHaveBeenCalledTimes(1))
    authority.resolve({ accepted: true, terminalText: "✅ Approved — running" })
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    await pending
  })

  it("keeps buttons removed when the decision authority refuses the callback", async () => {
    const f = await prompt(fixture({ onDecision: async () => ({ accepted: false, terminalText: "⚠️ Approval expired" }) }))
    f.respond.mockResolvedValue(telegramResponse(true))

    expect(await f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" }))).toEqual({
      handled: true,
      accepted: false,
      reason: "decision_refused",
    })
    expect(f.calls.at(-1)?.body).toEqual({
      chat_id: CHAT_ID,
      message_id: 99,
      text: "⚠️ Approval expired",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    })
  })

  it("escapes terminal HTML and retries a 400 terminal edit as plain text with empty buttons", async () => {
    const f = await prompt(fixture({ onDecision: async () => ({ accepted: false, terminalText: "⚠️ <expired> & refused" }) }))
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockResolvedValueOnce(telegramResponse(null, 400))
    f.respond.mockResolvedValueOnce(telegramResponse(true))

    await f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" }))

    expect(f.calls.at(-2)?.body).toEqual({
      chat_id: CHAT_ID,
      message_id: 99,
      text: "⚠️ &lt;expired&gt; &amp; refused",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    })
    expect(f.calls.at(-1)?.body).toEqual({
      chat_id: CHAT_ID,
      message_id: 99,
      text: "⚠️ <expired> & refused",
      reply_markup: { inline_keyboard: [] },
    })
  })

  it("honors 429 retry_after for terminal edits and resends the exact empty-button request", async () => {
    const retry = new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 })
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockResolvedValueOnce(retry)
    f.respond.mockResolvedValueOnce(telegramResponse(true))

    await f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" }))

    expect(f.sleep).toHaveBeenCalledWith(2_000)
    expect(f.calls.at(-1)).toEqual(f.calls.at(-2))
    expect(f.calls.at(-1)?.body).toHaveProperty("reply_markup", { inline_keyboard: [] })
  })

  it("retains a terminal handle when editing throws, so retry finishes without deciding twice", async () => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockRejectedValueOnce(new Error("telegram unavailable"))
    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle", callbackId: "callback-1" })))
      .rejects.toThrow("telegram unavailable")

    f.respond.mockResolvedValueOnce(telegramResponse(true))
    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle", callbackId: "callback-2" })))
      .resolves.toEqual({ handled: true, accepted: true, reason: "accepted" })
    expect(f.onDecision).toHaveBeenCalledTimes(1)
  })

  it("restarts after a terminal-edit crash without resolving the token or deciding again", async () => {
    let durableRecords: TelegramPersistedPendingApproval[] = []
    const pendingStore = {
      load: vi.fn(() => structuredClone(durableRecords)),
      save: vi.fn((records: TelegramPersistedPendingApproval[]) => { durableRecords = structuredClone(records) }),
    }
    const first = await prompt(fixture({ pendingStore }))
    first.respond.mockResolvedValueOnce(telegramResponse(true))
    first.respond.mockRejectedValueOnce(new Error("telegram unavailable"))

    await expect(first.adapter.handleUpdate(callbackUpdate({ callbackData: first.sent.approveCallbackData })))
      .rejects.toThrow("telegram unavailable")
    expect(first.onDecision).toHaveBeenCalledTimes(1)
    expect(durableRecords).toEqual([expect.objectContaining({
      approvalId: "approval-1",
      terminal: { accepted: true, terminalText: "✅ Approved — running" },
    })])
    expect(JSON.stringify(durableRecords)).not.toContain("server-side-decision-token")

    const resolveDecisionToken = vi.fn(async () => "must-not-be-used")
    const restarted = fixture({ pendingStore, resolveDecisionToken })
    restarted.respond.mockResolvedValue(telegramResponse(true))

    await expect(restarted.adapter.handleUpdate(callbackUpdate({ callbackData: first.sent.approveCallbackData })))
      .resolves.toEqual({ handled: true, accepted: true, reason: "accepted" })
    expect(resolveDecisionToken).not.toHaveBeenCalled()
    expect(restarted.onDecision).not.toHaveBeenCalled()
    expect(durableRecords).toEqual([])
  })

  it("clears restarted terminal state when Telegram says the edit was already applied", async () => {
    let durableRecords: TelegramPersistedPendingApproval[] = [{
      approvalId: "approval-1",
      messageId: "99",
      approveCallbackData: "a:approve-handle",
      denyCallbackData: "d:deny-handle",
      expiresAt: "2099-08-17T18:30:00.000Z",
      terminal: { accepted: true, terminalText: "✅ Approved — running" },
    }]
    const pendingStore = {
      load: vi.fn(() => structuredClone(durableRecords)),
      save: vi.fn((records: TelegramPersistedPendingApproval[]) => { durableRecords = structuredClone(records) }),
    }
    const f = fixture({ pendingStore, resolveDecisionToken: vi.fn(async () => "must-not-be-used") })
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: message is not modified",
    }), { status: 400, headers: { "content-type": "application/json" } }))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" })))
      .resolves.toEqual({ handled: true, accepted: true, reason: "accepted" })
    expect(f.onDecision).not.toHaveBeenCalled()
    expect(durableRecords).toEqual([])
  })

  it("accepts an already-applied plain fallback terminal edit", async () => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockResolvedValueOnce(telegramResponse(null, 400))
    f.respond.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: message is not modified",
    }), { status: 400, headers: { "content-type": "application/json" } }))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" })))
      .resolves.toEqual({ handled: true, accepted: true, reason: "accepted" })
  })

  it("surfaces a non-idempotent plain fallback terminal-edit failure", async () => {
    const f = await prompt()
    f.respond.mockResolvedValueOnce(telegramResponse(true))
    f.respond.mockResolvedValueOnce(telegramResponse(null, 400))
    f.respond.mockResolvedValueOnce(telegramResponse(null, 500))

    await expect(f.adapter.handleUpdate(callbackUpdate({ callbackData: "a:approve-handle" })))
      .rejects.toThrow("synthetic error")
    expect(f.onDecision).toHaveBeenCalledTimes(1)
  })

  it("retries sendMessage without formatting after Telegram rejects HTML with 400", async () => {
    const f = fixture({ responses: [telegramResponse(null, 400), telegramResponse({ message_id: 99, chat: { id: Number(CHAT_ID) } })] })

    await f.adapter.sendApproval({ approvalId: "approval-1", decisionToken: "private-fallback-token-xyz", prompt: "<bad>", expiresAt: "2099-08-17T18:30:00.000Z" })

    expect(f.calls).toHaveLength(2)
    const keyboard = { inline_keyboard: [[
      { text: "Approve", callback_data: "a:approve-handle" },
      { text: "Deny", callback_data: "d:deny-handle" },
    ]] }
    expect(f.calls[0]?.body).toEqual({ chat_id: CHAT_ID, text: "&lt;bad&gt;", parse_mode: "HTML", reply_markup: keyboard })
    expect(f.calls[1]?.body).toEqual({ chat_id: CHAT_ID, text: "<bad>", reply_markup: keyboard })
    expect(JSON.stringify(f.calls)).not.toContain("private-fallback-token-xyz")
    expect(JSON.stringify(f.calls)).not.toContain("approval-1")
  })

  it("honors Telegram 429 retry_after before resending the exact request", async () => {
    const retry = new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }), { status: 429 })
    const f = fixture({ responses: [retry, telegramResponse({ message_id: 99, chat: { id: Number(CHAT_ID) } })] })

    await f.adapter.sendApproval({ approvalId: "approval-1", decisionToken: "private-retry-token-xyz", prompt: "safe", expiresAt: "2099-08-17T18:30:00.000Z" })

    expect(f.sleep).toHaveBeenCalledWith(3_000)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toEqual(f.calls[0])
    expect(JSON.stringify(f.calls)).not.toContain("private-retry-token-xyz")
    expect(JSON.stringify(f.calls)).not.toContain("approval-1")
  })

  it("ignores non-callback updates without network or decision activity", async () => {
    const f = fixture()
    expect(await f.adapter.handleUpdate({ update_id: 102 })).toEqual({ handled: false, accepted: false, reason: "not_callback" })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.onDecision).not.toHaveBeenCalled()
  })

  it.each([
    ["approve", ["🙂".repeat(16), "deny"]],
    ["deny", ["approve", "🙂".repeat(16)]],
  ] as const)("rejects an oversized %s callback handle before sending", async (_label, handles) => {
    const f = fixture({ handles: [...handles] })
    await expect(f.adapter.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "safe", expiresAt: "2099-08-17T18:30:00.000Z" }))
      .rejects.toThrow(/64 bytes/i)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
