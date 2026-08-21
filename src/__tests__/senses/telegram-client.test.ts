import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"

import {
  TelegramApiError,
  createTelegramBotApi,
  escapeTelegramHtml,
  sendTelegramText,
  splitTelegramText,
  FileTelegramOffsetStore,
  FileTelegramUpdateInboxStore,
  FileTelegramPendingApprovalStore,
  createTelegramLongPoll,
  createTelegramApprovalTransport,
  type TelegramPendingApprovalStore,
  type TelegramBotApi,
} from "../../senses/telegram-client"

const token = "123456:super-secret-token"
const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("Telegram approval callback transport", () => {
  function approvalFixture(input: {
    now?: () => number
    records?: ReturnType<TelegramPendingApprovalStore["load"]>
    onDecision?: ReturnType<typeof vi.fn>
    onExpire?: ReturnType<typeof vi.fn>
    apiRequest?: (method: string, body: Record<string, unknown>) => Promise<unknown>
    save?: (records: ReturnType<TelegramPendingApprovalStore["load"]>, call: number) => void
    handles?: string[]
    resolveDecisionToken?: () => Promise<string | undefined>
  } = {}) {
    let records = structuredClone(input.records ?? [])
    const saves: ReturnType<TelegramPendingApprovalStore["load"]>[] = []
    const store: TelegramPendingApprovalStore = {
      load: () => structuredClone(records),
      save: (next) => {
        input.save?.(next, saves.length + 1)
        records = structuredClone(next); saves.push(structuredClone(next))
      },
    }
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async (method: string, body: Record<string, unknown>) => {
        calls.push({ method, body })
        return input.apiRequest ? input.apiRequest(method, body) : method === "sendMessage" ? { message_id: 99 } : true
      }),
    }
    const onDecision = input.onDecision ?? vi.fn(async (decision) => ({
      accepted: true,
      terminalText: decision.decision === "approve" ? "✅ Approved — running" : "❌ Denied",
    }))
    const transport = createTelegramApprovalTransport({
      api,
      expectedUserId: "10",
      expectedChatId: "10",
      pendingStore: store,
      createOpaqueHandle: (() => { const values = [...(input.handles ?? ["approve", "deny"])]; return () => values.shift() ?? "extra" })(),
      onDecision,
      onExpire: input.onExpire,
      resolveDecisionToken: input.resolveDecisionToken ?? (async () => "restored-secret-token"),
      now: input.now ?? (() => 1_000_000),
    })
    return { transport, calls, onDecision, records: () => records, saves }
  }

  function approvalCallback(data: string, overrides: { userId?: number; chatId?: number; messageId?: number; id?: string } = {}) {
    return {
      update_id: 1,
      callback_query: {
        id: overrides.id ?? "query-1",
        from: { id: overrides.userId ?? 10 },
        data,
        message: { message_id: overrides.messageId ?? 99, chat: { id: overrides.chatId ?? 10 } },
      },
    }
  }

  it("sends a token-free prompt with opaque callbacks and an exact 300000ms durable TTL", async () => {
    const fixture = approvalFixture()
    const sent = await fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret-token", prompt: "Restart <books>?" })

    expect(sent).toEqual({ messageId: "99", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_300_000 })
    expect(fixture.calls[0]).toEqual({
      method: "sendMessage",
      body: {
        chat_id: "10",
        text: "Restart &lt;books&gt;?",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "Approve", callback_data: "a:approve" },
          { text: "Deny", callback_data: "d:deny" },
        ]] },
      },
    })
    expect(JSON.stringify(fixture.records())).not.toContain("secret-token")
    expect(fixture.saves.slice(0, 3).map((save) => save[0]?.deliveryState)).toEqual(["pending", "send_attempting", "bound"])
    expect(fixture.saves[0]?.[0]?.messageId).toBeNull()
  })

  it("persists an indeterminate prompt delivery when sendMessage may have escaped", async () => {
    const fixture = approvalFixture({ apiRequest: async () => { throw new Error("connection reset after write") } })

    await expect(fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "Restart?" }))
      .rejects.toThrow("connection reset after write")

    expect(fixture.records()).toEqual([expect.objectContaining({
      approvalId: "approval-1",
      messageId: null,
      deliveryState: "delivery_indeterminate",
    })])
    expect(fixture.saves.map((save) => save[0]?.deliveryState)).toEqual(["pending", "send_attempting", "delivery_indeterminate"])
    expect(fixture.onDecision).not.toHaveBeenCalled()
  })

  it("acknowledges, decides once, terminalizes, removes buttons, and refuses replay", async () => {
    const fixture = approvalFixture()
    const sent = await fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret-token", prompt: "Restart?" })
    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData))).resolves.toMatchObject({ accepted: true })
    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-2" }))).resolves.toEqual({ handled: true, accepted: false, reason: "stale_callback" })
    expect(fixture.onDecision).toHaveBeenCalledTimes(1)
    expect(fixture.calls.slice(1, 3)).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "query-1" } },
      { method: "editMessageText", body: { chat_id: "10", message_id: 99, text: "✅ Approved — running", parse_mode: "HTML", reply_markup: { inline_keyboard: [] } } },
    ])
  })

  it.each([
    ["foreign_user", { userId: 11 }],
    ["foreign_chat", { chatId: 11 }],
    ["foreign_message", { messageId: 100 }],
  ])("refuses %s before authority", async (reason, overrides) => {
    const fixture = approvalFixture()
    const sent = await fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "Restart?" })
    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, overrides))).resolves.toEqual({ handled: true, accepted: false, reason })
    expect(fixture.onDecision).not.toHaveBeenCalled()
  })

  it("restores pending callbacks, resolves the secret server-side, and reconciles startup expiry", async () => {
    const liveRecord = { approvalId: "live", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:live", denyCallbackData: "d:live", expiresAt: 1_300_000 }
    const restored = approvalFixture({ records: [liveRecord] })
    await restored.transport.handleUpdate(approvalCallback("a:live"))
    expect(restored.onDecision).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "live", decisionToken: "restored-secret-token" }))

    const expired = approvalFixture({ records: [{ ...liveRecord, approvalId: "expired", expiresAt: 999_999 }] })
    await expired.transport.reconcileExpired()
    expect(expired.onDecision).not.toHaveBeenCalled()
    expect(expired.records()).toEqual([])
    expect(expired.calls.at(-1)?.body).toHaveProperty("reply_markup", { inline_keyboard: [] })
  })

  it("expires the canonical approval before removing an expired Telegram prompt", async () => {
    const order: string[] = []
    const onExpire = vi.fn(async (approvalId: string) => { order.push(`expire:${approvalId}`) })
    const record = { approvalId: "expired", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:expired", denyCallbackData: "d:expired", expiresAt: 999_999 }
    const fixture = approvalFixture({ records: [record], onExpire })
    const request = fixture.calls

    await fixture.transport.reconcileExpired()

    expect(onExpire).toHaveBeenCalledWith("expired")
    expect(fixture.records()).toEqual([])
    expect(request.at(-1)?.method).toBe("editMessageText")
  })

  it("isolates one terminal-edit failure so later expired prompts still lose their buttons", async () => {
    const records = [
      { approvalId: "blocked", messageId: "98", deliveryState: "bound" as const, approveCallbackData: "a:blocked", denyCallbackData: "d:blocked", expiresAt: 999_999 },
      { approvalId: "later", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:later", denyCallbackData: "d:later", expiresAt: 999_999 },
    ]
    const fixture = approvalFixture({
      records,
      apiRequest: async (_method, body) => {
        if (body.message_id === 98) throw new Error("first prompt unavailable")
        return true
      },
    })

    await expect(fixture.transport.reconcileExpired()).rejects.toThrow("first prompt unavailable")
    expect(fixture.calls).toContainEqual(expect.objectContaining({
      method: "editMessageText",
      body: expect.objectContaining({ message_id: 99, reply_markup: { inline_keyboard: [] } }),
    }))
    expect(fixture.records()).toEqual([expect.objectContaining({ approvalId: "blocked" })])
  })

  it("terminalizes and removes a recovered approval prompt without replaying its callback", async () => {
    const record = { approvalId: "recovered", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:recovered", denyCallbackData: "d:recovered", expiresAt: 1_300_000 }
    const fixture = approvalFixture({ records: [record] })

    await fixture.transport.terminalizeRecovered("recovered", "⚠️ Recovered safely")

    expect(fixture.records()).toEqual([])
    expect(fixture.calls.at(-1)).toEqual({
      method: "editMessageText",
      body: { chat_id: "10", message_id: 99, text: "⚠️ Recovered safely", parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    })
    expect(fixture.onDecision).not.toHaveBeenCalled()
  })

  it("cleans an expired terminal tombstone without re-expiring its canonical journal", async () => {
    const onExpire = vi.fn()
    const record = {
      approvalId: "indeterminate",
      messageId: null,
      deliveryState: "delivery_indeterminate" as const,
      approveCallbackData: "a:indeterminate",
      denyCallbackData: "d:indeterminate",
      expiresAt: 999_999,
      terminal: { accepted: false, terminalText: "not executed" },
    }
    const fixture = approvalFixture({ records: [record], onExpire })

    await fixture.transport.reconcileExpired()

    expect(onExpire).not.toHaveBeenCalled()
    expect(fixture.records()).toEqual([])
  })

  it("retries a terminal tombstone immediately without waiting for its original expiry", async () => {
    const onExpire = vi.fn()
    const record = {
      approvalId: "terminal-now",
      messageId: "99",
      deliveryState: "bound" as const,
      approveCallbackData: "a:terminal-now",
      denyCallbackData: "d:terminal-now",
      expiresAt: 1_300_000,
      terminal: { accepted: true, terminalText: "✅ Approved — action completed" },
    }
    const fixture = approvalFixture({ records: [record], onExpire })

    await fixture.transport.reconcileExpired()

    expect(onExpire).not.toHaveBeenCalled()
    expect(fixture.records()).toEqual([])
    expect(fixture.calls.at(-1)).toEqual({
      method: "editMessageText",
      body: {
        chat_id: "10",
        message_id: 99,
        text: "✅ Approved — action completed",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      },
    })
  })

  it("atomically consumes concurrent duplicate callbacks before authority", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const onDecision = vi.fn(async () => { await gate; return { accepted: true, terminalText: "done" } })
    const fixture = approvalFixture({ onDecision })
    const sent = await fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "Restart?" })
    const first = fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-1" }))
    const second = fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-2" }))
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1))
    release()
    await expect(first).resolves.toMatchObject({ accepted: true })
    await expect(second).resolves.toMatchObject({ accepted: false, reason: "stale_callback" })
  })

  it("terminally fences a decision token after onDecision rejects", async () => {
    const onDecision = vi.fn(async () => { throw new Error("continuation unavailable") })
    const resolveDecisionToken = vi.fn(async () => "must-not-be-reused")
    const fixture = approvalFixture({ onDecision, resolveDecisionToken })
    const sent = await fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "one-shot-token", prompt: "Restart?" })

    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-1" })))
      .rejects.toThrow("continuation unavailable")
    expect(fixture.records()).toEqual([expect.objectContaining({
      approvalId: "approval-1",
      terminal: { accepted: false, terminalText: "⚠️ Approval did not complete" },
    })])
    expect(JSON.stringify(fixture.records())).not.toContain("one-shot-token")

    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-2" })))
      .resolves.toEqual({ handled: true, accepted: false, reason: "decision_refused" })
    expect(onDecision).toHaveBeenCalledOnce()
    expect(resolveDecisionToken).not.toHaveBeenCalled()
  })

  it("validates persisted callback handles and collisions", () => {
    const base = { approvalId: "one", messageId: "1", approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 2_000_000 }
    expect(() => approvalFixture({ records: [{ ...base, approveCallbackData: `a:${"x".repeat(64)}` }] })).toThrow("1 to 64 bytes")
    expect(() => approvalFixture({ records: [base, { ...base, approvalId: "two", approveCallbackData: "a:x", denyCallbackData: "d:y" }] })).toThrow("collision")
  })

  it("rejects generated handle collisions and rolls back both pre-send persistence failures", async () => {
    const collision = approvalFixture({ records: [{ approvalId: "old", messageId: "1", approveCallbackData: "a:same", denyCallbackData: "d:old", expiresAt: 2_000_000 }], handles: ["same", "new"] })
    await expect(collision.transport.sendApproval({ approvalId: "new", decisionToken: "secret", prompt: "go?" })).rejects.toThrow("collision")

    for (const failureCall of [1, 2]) {
      const fixture = approvalFixture({ save: (_records, call) => { if (call === failureCall) throw new Error(`save-${failureCall}`) } })
      await expect(fixture.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "go?" })).rejects.toThrow(`save-${failureCall}`)
      expect(fixture.transport.listPendingDeliveries()).toEqual([])
    }
  })

  it("falls back from exact escaped HTML to exact plaintext and validates message ids", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const fixture = approvalFixture({ apiRequest: async (method, body) => {
      calls.push({ method, body })
      if (calls.length === 1) throw new TelegramApiError("bad html", { status: 400 })
      return { message_id: 7 }
    } })
    await expect(fixture.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "a < b" })).resolves.toMatchObject({ messageId: "7" })
    expect(calls).toEqual([
      { method: "sendMessage", body: expect.objectContaining({ text: "a &lt; b", parse_mode: "HTML" }) },
      { method: "sendMessage", body: expect.not.objectContaining({ parse_mode: "HTML" }) },
    ])

    for (const result of [null, [], {}, { message_id: "7" }, { message_id: 1.5 }, { message_id: 0 }]) {
      const invalid = approvalFixture({ apiRequest: async () => result })
      await expect(invalid.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "go?" })).rejects.toThrow("canonical message_id")
      expect(invalid.transport.listPendingDeliveries()).toMatchObject([{ deliveryState: "delivery_indeterminate", messageId: null }])
    }
  })

  it("does not plaintext-retry non-400 prompt failures", async () => {
    const apiRequest = vi.fn(async () => { throw new TelegramApiError("down", { status: 500 }) })
    const fixture = approvalFixture({ apiRequest })
    await expect(fixture.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "go?" })).rejects.toThrow("down")
    expect(apiRequest).toHaveBeenCalledOnce()
  })

  it.each([
    ["not_callback", { update_id: 1 }],
    ["stale_callback", { update_id: 1, callback_query: { id: "q", from: { id: 10 } } }],
  ])("returns %s for unsupported callback shape", async (reason, update) => {
    await expect(approvalFixture().transport.handleUpdate(update as any)).resolves.toMatchObject({ reason })
  })

  it("handles indeterminate, unbound, and expired callback states without authority", async () => {
    const base = { approvalId: "a", messageId: "99", approveCallbackData: "a:x", denyCallbackData: "d:x" }
    for (const [record, reason] of [
      [{ ...base, deliveryState: "delivery_indeterminate", expiresAt: 2_000_000 }, "delivery_indeterminate"],
      [{ ...base, messageId: null, deliveryState: "pending", expiresAt: 2_000_000 }, "prompt_not_bound"],
      [{ ...base, deliveryState: "bound", expiresAt: 999_999 }, "expired"],
    ] as const) {
      const onExpire = vi.fn()
      const fixture = approvalFixture({ records: [record], onExpire })
      await expect(fixture.transport.handleUpdate(approvalCallback("a:x"))).resolves.toMatchObject({ accepted: false, reason })
      expect(fixture.onDecision).not.toHaveBeenCalled()
      if (reason === "expired") expect(onExpire).toHaveBeenCalledWith("a")
    }
  })

  it("reconciles an interrupted delivery when its callback reveals the message identity", async () => {
    const record = { approvalId: "a", messageId: null, deliveryState: "send_attempting" as const, approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 2_000_000 }
    const fixture = approvalFixture({ records: [record] })
    await expect(fixture.transport.handleUpdate(approvalCallback("a:x"))).resolves.toMatchObject({ reason: "delivery_indeterminate" })
    expect(fixture.records()).toEqual([])
    expect(fixture.calls).toContainEqual({ method: "editMessageText", body: expect.objectContaining({ message_id: 99, reply_markup: { inline_keyboard: [] } }) })
  })

  it("tolerates stale callback acknowledgements but propagates other acknowledgement failures", async () => {
    const stale = approvalFixture({ apiRequest: async (method) => {
      if (method === "answerCallbackQuery") throw new TelegramApiError("query is too old", { status: 400 })
      return { message_id: 99 }
    } })
    const sent = await stale.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "go?" })
    await expect(stale.transport.handleUpdate(approvalCallback(sent.denyCallbackData))).resolves.toMatchObject({ accepted: true })
    expect(stale.onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }))

    const failed = approvalFixture({ apiRequest: async (method) => {
      if (method === "answerCallbackQuery") throw new Error("ack down")
      return { message_id: 99 }
    } })
    const failedSent = await failed.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "go?" })
    await expect(failed.transport.handleUpdate(approvalCallback(failedSent.approveCallbackData))).rejects.toThrow("ack down")
    expect(failed.transport.listPendingDeliveries()).toHaveLength(1)
  })

  it("covers terminal edit idempotence, plaintext fallback, and hard failures", async () => {
    const record = { approvalId: "a", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 999_999 }
    const idempotent = approvalFixture({ records: [{ ...record, terminal: { accepted: false, terminalText: "done" } }], apiRequest: async () => { throw new TelegramApiError("message is not modified", { status: 400 }) } })
    await expect(idempotent.transport.reconcileExpired()).resolves.toBeUndefined()

    let unchangedCalls = 0
    const fallbackUnchanged = approvalFixture({ records: [record], apiRequest: async () => {
      unchangedCalls += 1
      throw new TelegramApiError(unchangedCalls === 1 ? "bad html" : "message is not modified", { status: 400 })
    } })
    await expect(fallbackUnchanged.transport.reconcileExpired()).resolves.toBeUndefined()

    let calls = 0
    const fallback = approvalFixture({ records: [record], apiRequest: async () => {
      calls += 1
      if (calls === 1) throw new TelegramApiError("bad html", { status: 400 })
      return true
    } })
    await fallback.transport.reconcileExpired()
    expect(fallback.calls.at(-1)).toEqual({ method: "editMessageText", body: expect.not.objectContaining({ parse_mode: "HTML" }) })

    for (const error of [new Error("down"), new TelegramApiError("down", { status: 500 }), new TelegramApiError("still bad", { status: 400 })]) {
      let call = 0
      const hard = approvalFixture({ records: [record], apiRequest: async () => {
        call += 1
        if (error instanceof TelegramApiError && error.status === 400 && call === 1) throw new TelegramApiError("bad html", { status: 400 })
        throw error
      } })
      await expect(hard.transport.reconcileExpired()).rejects.toThrow()
    }
  })

  it("requires a restored decision token and preserves refused terminal outcomes", async () => {
    const record = { approvalId: "a", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 2_000_000 }
    const missing = approvalFixture({ records: [record], resolveDecisionToken: async () => undefined })
    await expect(missing.transport.handleUpdate(approvalCallback("a:x"))).rejects.toThrow("decision token resolver")
    expect(missing.transport.listPendingDeliveries()).toHaveLength(1)

    const refused = approvalFixture({ records: [{ ...record, terminal: { accepted: false, terminalText: "refused" } }] })
    await expect(refused.transport.handleUpdate(approvalCallback("a:x"))).resolves.toEqual({ handled: true, accepted: false, reason: "decision_refused" })
    expect(refused.onDecision).not.toHaveBeenCalled()
  })

  it("terminalizes missing, null-message, and bound recovered approvals safely", async () => {
    const none = approvalFixture()
    await none.transport.terminalizeRecovered("missing", "done")
    const record = { approvalId: "a", messageId: null, deliveryState: "delivery_indeterminate" as const, approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 2_000_000 }
    const indeterminate = approvalFixture({ records: [record] })
    await indeterminate.transport.terminalizeRecovered("a", "done")
    expect(indeterminate.transport.listPendingDeliveries()).toEqual([{ ...record, terminal: { accepted: false, terminalText: "done" } }])
    expect(JSON.stringify(indeterminate.transport.listPendingDeliveries())).not.toContain("secret")
  })

  it("removes an orphaned transport row without invoking canonical expiry", async () => {
    const onExpire = vi.fn()
    const fixture = approvalFixture({
      records: [{ approvalId: "orphan", messageId: "99", deliveryState: "bound", approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 2_000_000 }],
      onExpire,
    })

    await expect(fixture.transport.terminalizeOrphaned("orphan", "no journal")).resolves.toEqual({ terminalEditSucceeded: true })

    expect(fixture.calls).toEqual([expect.objectContaining({ method: "editMessageText" })])
    expect(fixture.transport.listPendingDeliveries()).toEqual([])
    expect(fixture.records()).toEqual([])
    expect(onExpire).not.toHaveBeenCalled()
    await expect(fixture.transport.terminalizeOrphaned("absent", "no journal")).resolves.toEqual({ terminalEditSucceeded: true })
  })

  it("durably removes an orphan even when its terminal edit fails", async () => {
    const fixture = approvalFixture({
      records: [{ approvalId: "orphan", messageId: "99", deliveryState: "bound", approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 2_000_000 }],
      apiRequest: async () => { throw new TelegramApiError("upstream unavailable", { status: 503 }) },
    })

    await expect(fixture.transport.terminalizeOrphaned("orphan", "no journal")).resolves.toEqual({ terminalEditSucceeded: false })
    expect(fixture.transport.listPendingDeliveries()).toEqual([])
    expect(fixture.records()).toEqual([])
  })

  it("uses the wall clock by default and leaves live approvals pending during reconciliation", async () => {
    const future = Date.now() + 60_000
    let records = [{ approvalId: "a", messageId: "1", deliveryState: "bound" as const, approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: future }]
    const transport = createTelegramApprovalTransport({
      api: { request: vi.fn(), stop: vi.fn() },
      expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: () => "opaque",
      onDecision: vi.fn(),
    })
    await transport.reconcileExpired()
    expect(transport.listPendingDeliveries()).toHaveLength(1)
  })
})

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("Telegram Bot API HTTP core", () => {
  it("posts JSON to the exact bot method and returns a validated result", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: { id: 42 } }))
    const api = createTelegramBotApi({ token, fetch })

    await expect(api.request("getMe", { probe: true })).resolves.toEqual({ id: 42 })
    expect(fetch).toHaveBeenCalledWith(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: true }),
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    ["Bot API error", jsonResponse({ ok: false, error_code: 400, description: `bad ${token}` }, 400)],
    ["HTTP failure", new Response("gateway failure", { status: 502 })],
    ["invalid envelope", jsonResponse({ result: {} })],
    ["missing result", jsonResponse({ ok: true })],
  ])("fails safely for %s without leaking the token", async (_label, response) => {
    const api = createTelegramBotApi({ token, fetch: vi.fn(async () => response) })
    const error = await api.request("sendMessage", { text: token }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TelegramApiError)
    expect(String(error)).not.toContain(token)
  })

  it("redacts the token from transport failures", async () => {
    const cause = new Error(`socket failed for ${token}`, { cause: { token } })
    Object.defineProperty(cause, "rawResponse", { value: { token }, enumerable: false })
    const api = createTelegramBotApi({
      token,
      fetch: vi.fn(async () => { throw cause }),
    })
    const error = await api.request("getUpdates", {}).catch((caught: unknown) => caught) as TelegramApiError

    expect(error).toBeInstanceOf(TelegramApiError)
    expect(error).not.toBe(cause)
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain(token)
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(token)
  })

  it("rebuilds token-bearing TelegramApiErrors without retaining custom fields or causes", async () => {
    const cause = new TelegramApiError(`upstream failed for ${token}`, { status: 503, cause: new Error(token) })
    Object.assign(cause, { rawResponse: { token } })
    const api = createTelegramBotApi({ token, fetch: vi.fn(async () => { throw cause }) })

    const error = await api.request("getUpdates", {}).catch((caught: unknown) => caught) as TelegramApiError

    expect(error).toMatchObject({ status: 503, errorCode: null, retryAfterSeconds: null })
    expect(error).not.toBe(cause)
    expect(error.cause).toBeUndefined()
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(token)
  })
})

describe("Telegram durable authorized long poll", () => {
  it("persists only opaque update receipts and migrates legacy raw inbox rows to tombstones", () => {
    const directory = makeTempDirectory("ouro-telegram-inbox-privacy-")
    const inboxPath = join(directory, "inbox.json")
    const store = new FileTelegramUpdateInboxStore(inboxPath)
    const update = {
      update_id: 918273645,
      callback_query: {
        id: "raw-callback-query-id",
        from: { id: 817263540 },
        data: "a:raw-callback-data",
        message: { message_id: 716253401, chat: { id: 615243019 } },
      },
    }
    store.capture(update)
    let persisted = readFileSync(inboxPath, "utf8")
    for (const raw of ["918273645", "raw-callback-query-id", "817263540", "a:raw-callback-data", "716253401", "615243019"]) {
      expect(persisted).not.toContain(raw)
    }
    expect(persisted).toMatch(/tgu_[A-Za-z0-9_-]{43}/u)

    writeFileSync(inboxPath, JSON.stringify({ pending: [update], dispatching: [update], completedUpdateIds: [update.update_id] }))
    expect(store.loadIndeterminate()).toHaveLength(1)
    persisted = readFileSync(inboxPath, "utf8")
    for (const raw of ["918273645", "raw-callback-query-id", "817263540", "a:raw-callback-data", "716253401", "615243019"]) {
      expect(persisted).not.toContain(raw)
    }
  })

  it("warns once durably and retains indeterminate receipts through the exact accepted window", () => {
    const directory = makeTempDirectory("ouro-telegram-inbox-retention-")
    const inboxPath = join(directory, "inbox.json")
    let now = 1_000
    const store = new FileTelegramUpdateInboxStore(inboxPath, {
      now: () => now,
      indeterminateRetentionMs: 100,
      maxIndeterminateReceipts: 2,
    })
    const update = { update_id: 7, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "restart" } }

    expect(store.capture(update)).toBe(true)
    expect(store.claim(update)).toBe(true)
    const warning = store.quarantineStranded()[0]!
    expect(store.quarantineStranded()).toHaveLength(1)
    expect(JSON.parse(readFileSync(inboxPath, "utf8")).indeterminate[0]).toMatchObject({
      quarantinedAt: 1_000,
      warningAcknowledged: false,
    })

    const restarted = new FileTelegramUpdateInboxStore(inboxPath, {
      now: () => now,
      indeterminateRetentionMs: 100,
      maxIndeterminateReceipts: 2,
    })
    expect(restarted.quarantineStranded()).toHaveLength(1)
    expect(restarted.acknowledgeIndeterminateWarning(warning)).toBe(true)
    expect(restarted.acknowledgeIndeterminateWarning(warning)).toBe(false)
    expect(restarted.quarantineStranded()).toEqual([])
    now = 1_100
    expect(restarted.capture(update)).toBe(false)
    now = 1_101
    expect(restarted.capture(update)).toBe(true)
  })

  it("prunes indeterminate receipts deterministically at the count boundary", () => {
    const directory = makeTempDirectory("ouro-telegram-inbox-count-")
    let now = 1_000
    const store = new FileTelegramUpdateInboxStore(join(directory, "inbox.json"), {
      now: () => now,
      indeterminateRetentionMs: 1_000,
      maxIndeterminateReceipts: 2,
    })
    const update = (updateId: number) => ({
      update_id: updateId,
      message: { message_id: updateId, from: { id: 10 }, chat: { id: 10, type: "private" }, text: `message-${updateId}` },
    })
    for (const updateId of [1, 2]) {
      expect(store.capture(update(updateId))).toBe(true)
      expect(store.claim(update(updateId))).toBe(true)
    }
    const initialWarnings = store.quarantineStranded()
    expect(initialWarnings).toHaveLength(2)
    for (const warning of initialWarnings) expect(store.acknowledgeIndeterminateWarning(warning)).toBe(true)
    now += 1
    expect(store.capture(update(3))).toBe(true)
    expect(store.claim(update(3))).toBe(true)
    const thirdWarning = store.quarantineStranded()
    expect(thirdWarning).toHaveLength(1)
    expect(store.acknowledgeIndeterminateWarning(thirdWarning[0]!)).toBe(true)

    expect(store.loadIndeterminate()).toHaveLength(2)
    expect(store.capture(update(1))).toBe(true)
    expect(store.capture(update(2))).toBe(false)
    expect(store.capture(update(3))).toBe(false)
  })

  it("migrates version-two opaque receipts into bounded one-shot warning tombstones", () => {
    const directory = makeTempDirectory("ouro-telegram-inbox-v2-")
    const inboxPath = join(directory, "inbox.json")
    const seed = new FileTelegramUpdateInboxStore(inboxPath)
    const update = { update_id: 4, message: { message_id: 4, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "legacy opaque" } }
    seed.capture(update)
    const receipt = seed.loadPending()[0]!
    writeFileSync(inboxPath, JSON.stringify({ version: 2, pending: [], dispatching: [], indeterminate: [receipt] }))

    const migrated = new FileTelegramUpdateInboxStore(inboxPath, { now: () => 2_000 })
    const migratedWarning = migrated.quarantineStranded()[0]!
    expect(migratedWarning).toEqual(expect.objectContaining({ digest: receipt.digest }))
    expect(migrated.acknowledgeIndeterminateWarning(migratedWarning)).toBe(true)
    expect(migrated.quarantineStranded()).toEqual([])
    expect(JSON.parse(readFileSync(inboxPath, "utf8"))).toMatchObject({
      version: 3,
      indeterminate: [expect.objectContaining({ quarantinedAt: 2_000, warningAcknowledged: true })],
    })

    writeFileSync(inboxPath, JSON.stringify({
      pending: [update, { ...update, update_id: 5 }],
      dispatching: [],
      completedUpdateIds: [],
    }))
    const legacyRaw = new FileTelegramUpdateInboxStore(inboxPath, {
      now: () => 3_000,
      maxIndeterminateReceipts: 1,
    })
    expect(legacyRaw.loadIndeterminate()).toHaveLength(1)
    expect(JSON.parse(readFileSync(inboxPath, "utf8")).indeterminate).toHaveLength(1)
  })

  it("does not durably capture unauthorized callback identities or data", async () => {
    const inboxStore = {
      loadIndeterminate: vi.fn(() => []), loadPending: vi.fn(() => []),
      acknowledgeIndeterminateWarning: vi.fn(() => true),
      capture: vi.fn(() => true), claim: vi.fn(() => true), complete: vi.fn(), discardCompletedBefore: vi.fn(), load: vi.fn(),
    }
    const callback = { update_id: 7, callback_query: { id: "foreign-query", from: { id: 99 }, data: "a:foreign", message: { message_id: 8, chat: { id: 99 } } } }
    const onUpdate = vi.fn(async () => true)
    const poll = createTelegramLongPoll({
      api: { stop: vi.fn(), request: vi.fn(async () => [callback]) }, expectedUserId: "10", expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() }, inboxStore, onMessage: vi.fn(), onUpdate,
    })
    await poll.pollOnce()
    expect(inboxStore.capture).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith(callback)
  })

  it("durably claims authorized callbacks by opaque receipt and skips an unclaimable duplicate", async () => {
    const inboxStore = {
      quarantineStranded: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), loadPending: vi.fn(() => []),
      acknowledgeIndeterminateWarning: vi.fn(() => true),
      capture: vi.fn(() => true), claim: vi.fn(() => false), complete: vi.fn(), load: vi.fn(),
    }
    const callback = { update_id: 7, callback_query: { id: "query", from: { id: 10 }, data: "a:opaque", message: { message_id: 8, chat: { id: 10 } } } }
    const onUpdate = vi.fn(async () => true)
    const poll = createTelegramLongPoll({
      api: { stop: vi.fn(), request: vi.fn(async () => [callback]) }, expectedUserId: "10", expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() }, inboxStore, onMessage: vi.fn(), onUpdate,
    })
    await poll.pollOnce()
    expect(inboxStore.capture).toHaveBeenCalledWith(callback)
    expect(inboxStore.claim).toHaveBeenCalledWith(callback)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("captures before offset and quarantines a turn whose dispatch may have begun", async () => {
    const directory = makeTempDirectory("ouro-telegram-inbox-")
    const inboxPath = join(directory, "inbox.json")
    const inboxStore = new FileTelegramUpdateInboxStore(inboxPath)
    let offset = 0
    const offsetStore = { load: () => offset, save: (value: number) => { offset = value } }
    const onMessage = vi.fn(async () => {
      expect(inboxStore.load()).toHaveLength(1)
      expect(offset).toBe(12)
      throw new Error("synthetic turn crash")
    })
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async () => [
        { update_id: 11, message: { message_id: 2, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "restart" } },
      ]),
    }
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore, inboxStore, onMessage })

    await expect(poll.pollOnce()).rejects.toThrow("synthetic turn crash")
    expect(offset).toBe(12)
    expect(inboxStore.loadIndeterminate()).toHaveLength(1)
    let persisted = readFileSync(inboxPath, "utf8")
    expect(JSON.parse(persisted).indeterminate[0].warningAcknowledged).toBe(false)
    for (const raw of ["update_id", "message_id", '"from"', '"chat"', "restart"]) expect(persisted).not.toContain(raw)

    const recoveredMessage = vi.fn(async () => undefined)
    const recoveredApi: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => []) }
    const recovered = createTelegramLongPoll({
      api: recoveredApi,
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore,
      inboxStore: new FileTelegramUpdateInboxStore(inboxPath),
      onMessage: recoveredMessage,
    })
    await recovered.pollOnce()
    expect(recoveredMessage).not.toHaveBeenCalled()
    expect(inboxStore.loadIndeterminate()).toHaveLength(1)
    persisted = readFileSync(inboxPath, "utf8")
    expect(JSON.parse(persisted).indeterminate[0].warningAcknowledged).toBe(true)
  })

  it("rejects a conflicting durable update with the same update id", () => {
    const directory = makeTempDirectory("ouro-telegram-inbox-conflict-")
    const store = new FileTelegramUpdateInboxStore(join(directory, "inbox.json"))
    store.capture({ update_id: 7, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "one" } })
    expect(() => store.capture({ update_id: 7, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "two" } })).toThrow("conflicting")
  })

  it("restores offsets, suppresses duplicates, and advances past foreign updates before dispatch", async () => {
    const directory = makeTempDirectory("ouro-telegram-offset-")
    const path = join(directory, "offset.json")
    writeFileSync(path, JSON.stringify({ nextUpdateId: 5 }))
    const store = new FileTelegramOffsetStore(path)
    const onMessage = vi.fn(async () => undefined)
    const request = vi.fn(async () => [
      { update_id: 4, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "duplicate" } },
      { update_id: 5, message: { message_id: 2, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "hello" } },
      { update_id: 6, message: { message_id: 3, from: { id: 99 }, chat: { id: 99, type: "private" }, text: "foreign" } },
    ])
    const api: TelegramBotApi = { request, stop: vi.fn() }
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore: store, onMessage })

    await expect(poll.pollOnce()).resolves.toBe(7)
    expect(request).toHaveBeenCalledWith("getUpdates", { offset: 5, timeout: 50, allowed_updates: ["message", "callback_query"] }, expect.any(AbortSignal))
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ updateId: 5, userId: "10", chatId: "10", text: "hello" }))
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ nextUpdateId: 7 })

    const restartedRequest = vi.fn(async () => [])
    const restarted = createTelegramLongPoll({
      api: { request: restartedRequest, stop: vi.fn() },
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: new FileTelegramOffsetStore(path),
      onMessage,
    })
    await restarted.pollOnce()
    expect(restartedRequest).toHaveBeenCalledWith("getUpdates", expect.objectContaining({ offset: 7 }), expect.any(AbortSignal))
  })

  it("drops malformed, non-private, foreign-chat, and message-less updates with zero dispatch", async () => {
    let offset = 0
    const offsetStore = { load: () => offset, save: (value: number) => { offset = value } }
    const onMessage = vi.fn(async () => undefined)
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async () => [
        { update_id: 0 },
        { update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "group" }, text: "group" } },
        { update_id: 2, message: { message_id: 2, from: { id: 10 }, chat: { id: 11, type: "private" }, text: "other chat" } },
        { update_id: 3, message: { message_id: 3, chat: { id: 10, type: "private" }, text: "no sender" } },
      ]),
    }
    const acceptanceEventMeta = vi.fn(() => ({}))
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore, onMessage, acceptanceEventMeta })
    await poll.pollOnce()
    expect(onMessage).not.toHaveBeenCalled()
    expect(offset).toBe(4)
    expect(acceptanceEventMeta.mock.calls.map(([update, distinctAccount]) => [update?.update_id, distinctAccount])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, false],
    ])
  })

  it("fails closed on corrupt offset state and stops an active poll", async () => {
    const directory = makeTempDirectory("ouro-telegram-corrupt-")
    const path = join(directory, "offset.json")
    writeFileSync(path, "not json")
    expect(() => new FileTelegramOffsetStore(path).load()).toThrow("Telegram offset state is corrupt")

    const api: TelegramBotApi = { request: vi.fn(async () => []), stop: vi.fn() }
    const poll = createTelegramLongPoll({
      api,
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() },
      onMessage: vi.fn(),
    })
    poll.stop()
    await expect(poll.pollOnce()).rejects.toThrow("stopped")
  })

  it.each([
    ["authorized message", { update_id: 7, message: { message_id: 8, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "restart" } }],
    ["authorized callback", { update_id: 7, callback_query: { id: "query", from: { id: 10 }, data: "a:opaque", message: { message_id: 8, chat: { id: 10 } } } }],
    ["unauthorized drop", { update_id: 7, message: { message_id: 8, from: { id: 99 }, chat: { id: 99, type: "private" }, text: "foreign" } }],
  ] as const)("checks acceptance audit exhaustion before any %s effect", async (_label, update) => {
    const offsetStore = { load: () => 0, save: vi.fn() }
    const inboxStore = {
      quarantineStranded: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), loadPending: vi.fn(() => []),
      acknowledgeIndeterminateWarning: vi.fn(() => true), capture: vi.fn(() => true), claim: vi.fn(() => true),
      complete: vi.fn(), discardCompletedBefore: vi.fn(), load: vi.fn(),
    }
    const onMessage = vi.fn(async () => undefined)
    const onUpdate = vi.fn(async () => true)
    const acceptanceEventMeta = vi.fn(() => ({}))
    const onBeforeDispatch = vi.fn(() => { throw new Error("Telegram audit ledger exceeds its bound") })
    const onDispatchSettled = vi.fn()
    const poll = createTelegramLongPoll({
      api: { stop: vi.fn(), request: vi.fn(async () => [update]) }, expectedUserId: "10", expectedChatId: "10",
      offsetStore, inboxStore, onMessage, onUpdate, acceptanceEventMeta, onBeforeDispatch, onDispatchSettled,
    })

    await expect(poll.pollOnce()).rejects.toThrow("Telegram audit ledger exceeds its bound")
    expect(onBeforeDispatch).toHaveBeenCalledOnce()
    expect(offsetStore.save).not.toHaveBeenCalled()
    expect(inboxStore.capture).not.toHaveBeenCalled()
    expect(inboxStore.claim).not.toHaveBeenCalled()
    expect(inboxStore.complete).not.toHaveBeenCalled()
    expect(onMessage).not.toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(acceptanceEventMeta).not.toHaveBeenCalled()
    expect(onDispatchSettled).not.toHaveBeenCalled()
  })

  it("checks audit health after a failed dispatch and preserves both failures", async () => {
    const dispatchFailure = new Error("turn dispatch failed")
    const auditFailure = new Error("Telegram audit ledger is corrupt")
    const onDispatchSettled = vi.fn(() => { throw auditFailure })
    const poll = createTelegramLongPoll({
      api: { stop: vi.fn(), request: vi.fn(async () => [
        { update_id: 7, message: { message_id: 8, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "restart" } },
      ]) },
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() },
      inboxStore: {
        quarantineStranded: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), loadPending: vi.fn(() => []),
        acknowledgeIndeterminateWarning: vi.fn(() => true), capture: vi.fn(() => true), claim: vi.fn(() => true),
        complete: vi.fn(), discardCompletedBefore: vi.fn(), load: vi.fn(),
      },
      onMessage: async () => { throw dispatchFailure },
      onDispatchSettled,
    })

    const thrown = await poll.pollOnce().catch((error) => error as unknown)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([dispatchFailure, auditFailure])
    expect(onDispatchSettled).toHaveBeenCalledOnce()
  })

  it("propagates a non-shutdown polling failure from the joined run lifecycle", async () => {
    const poll = createTelegramLongPoll({
      api: { request: vi.fn(async () => { throw new Error("synthetic poll failure") }), stop: vi.fn() },
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() },
      onMessage: vi.fn(),
    })
    await expect(poll.run()).rejects.toThrow("synthetic poll failure")
  })

  it("joins cleanly when an external lifecycle signal aborts an active request", async () => {
    const controller = new AbortController()
    const request = vi.fn(async (_method: string, _body: Record<string, unknown>, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("synthetic external abort")), { once: true })
      })
      return []
    })
    const poll = createTelegramLongPoll({
      api: { request, stop: vi.fn() },
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() },
      onMessage: vi.fn(),
    })
    const running = poll.run(controller.signal)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    controller.abort()
    await expect(running).resolves.toBeUndefined()
  })

  it("validates, atomically saves, and defaults missing durable stores", () => {
    const directory = makeTempDirectory("ouro-telegram-stores-")
    const offsetPath = join(directory, "nested", "offset.json")
    const offset = new FileTelegramOffsetStore(offsetPath)
    expect(offset.load()).toBe(0)
    offset.save(0)
    expect(offset.load()).toBe(0)
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => offset.save(invalid)).toThrow("non-negative")
    for (const invalid of [{}, { nextUpdateId: -1 }, { nextUpdateId: 1.5 }]) {
      writeFileSync(offsetPath, JSON.stringify(invalid))
      expect(() => offset.load()).toThrow("offset state is corrupt")
    }

    const inboxPath = join(directory, "inbox.json")
    const inbox = new FileTelegramUpdateInboxStore(inboxPath)
    expect(inbox.load()).toEqual([])
    expect(inbox.loadPending()).toEqual([])
    expect(inbox.loadIndeterminate()).toEqual([])
    const one = { update_id: 2, message: { message_id: 2, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "two" } }
    const zero = { update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "one" } }
    expect(inbox.capture(one)).toBe(true)
    expect(inbox.capture(zero)).toBe(true)
    expect(inbox.loadPending()).toHaveLength(2)
    expect(inbox.loadPending().every((receipt) => /^tgu_[A-Za-z0-9_-]{43}$/u.test(receipt.digest))).toBe(true)
    expect(inbox.capture(zero)).toBe(false)
    const absent = { update_id: 99 }
    expect(inbox.claim(absent)).toBe(false)
    expect(inbox.claim(zero)).toBe(true)
    expect(inbox.claim(zero)).toBe(false)
    inbox.complete(zero)
    inbox.complete(zero)
    expect(inbox.capture(zero)).toBe(true)
    expect(inbox.load()).toHaveLength(2)

    const pendingPath = join(directory, "pending.json")
    const pending = new FileTelegramPendingApprovalStore(pendingPath)
    expect(pending.load()).toEqual([])
    pending.save([{ approvalId: "a", messageId: null, approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 1 }])
    expect(pending.load()).toHaveLength(1)
    writeFileSync(pendingPath, JSON.stringify({ nope: true }))
    expect(() => pending.load()).toThrow("pending approval state is corrupt")

    expect(() => new FileTelegramOffsetStore(directory).load()).toThrow()
    const legacyInboxPath = join(directory, "legacy-inbox.json")
    writeFileSync(legacyInboxPath, JSON.stringify({ pending: [], completedUpdateIds: [] }))
    expect(new FileTelegramUpdateInboxStore(legacyInboxPath).load()).toEqual([])
    expect(() => new FileTelegramUpdateInboxStore(inboxPath, { indeterminateRetentionMs: 0 })).toThrow("retention")
    expect(() => new FileTelegramUpdateInboxStore(inboxPath, { indeterminateRetentionMs: 1.5 })).toThrow("retention")
    expect(() => new FileTelegramUpdateInboxStore(inboxPath, { maxIndeterminateReceipts: 0 })).toThrow("limit")
    expect(() => new FileTelegramUpdateInboxStore(inboxPath, { maxIndeterminateReceipts: 1.5 })).toThrow("limit")
    writeFileSync(inboxPath, JSON.stringify({ version: 3, pending: [], dispatching: [], indeterminate: [] }))
    expect(() => new FileTelegramUpdateInboxStore(inboxPath, { now: () => 1.5 }).load()).toThrow("inbox state is corrupt")
  })

  it.each([
    {},
    { pending: {}, completedUpdateIds: [] },
    { pending: [], dispatching: {}, completedUpdateIds: [] },
    { pending: [null], completedUpdateIds: [] },
    { pending: [], dispatching: [null], completedUpdateIds: [] },
    { pending: [], completedUpdateIds: [-1] },
    { version: 2, pending: {}, dispatching: [], indeterminate: [] },
    { version: 2, pending: [{}], dispatching: [], indeterminate: [] },
    { version: 2, pending: [], dispatching: [], indeterminate: [], raw: "forbidden" },
    { version: 3, pending: [], dispatching: [], indeterminate: [{}] },
  ])("rejects corrupt inbox state %j", (state) => {
    const directory = makeTempDirectory("ouro-telegram-inbox-invalid-")
    const inboxPath = join(directory, "inbox.json")
    writeFileSync(inboxPath, JSON.stringify(state))
    expect(() => new FileTelegramUpdateInboxStore(inboxPath).load()).toThrow("inbox state is corrupt")
  })

  it("quarantines stranded receipts without blind replay", async () => {
    const onMessage = vi.fn(async () => undefined)
    const onUpdate = vi.fn(async (update) => Boolean(update.callback_query))
    const pending = { update_id: 1, callback_query: { id: "cb", from: { id: 10 }, data: "opaque" } }
    const inboxStore = {
      quarantineStranded: vi.fn(() => [{ digest: `tgu_${"a".repeat(43)}`, sequenceDigest: `tgs_${"b".repeat(43)}`, updateClass: "callback" as const }]),
      loadIndeterminate: vi.fn(() => []), loadPending: vi.fn(() => []),
      acknowledgeIndeterminateWarning: vi.fn(() => true),
      claim: vi.fn((id: number) => id === 1),
      complete: vi.fn(), capture: vi.fn(), discardCompletedBefore: vi.fn(), load: vi.fn(),
    }
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => []) }
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore: { load: () => 0, save: vi.fn() }, inboxStore, onMessage, onUpdate })
    await expect(poll.pollOnce()).resolves.toBe(0)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(onMessage).not.toHaveBeenCalled()
    expect(inboxStore.complete).not.toHaveBeenCalled()
  })

  it("rejects non-array updates and skips invalid, duplicate, and unclaimable durable updates", async () => {
    const offsetStore = { load: () => 2, save: vi.fn() }
    const invalidApi: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({})) }
    const invalid = createTelegramLongPoll({ api: invalidApi, expectedUserId: "10", expectedChatId: "10", offsetStore, onMessage: vi.fn() })
    await expect(invalid.pollOnce()).rejects.toThrow("must be an array")

    const onMessage = vi.fn()
    const inboxStore = {
      quarantineStranded: vi.fn(() => []), loadIndeterminate: vi.fn(() => []), loadPending: vi.fn(() => []),
      acknowledgeIndeterminateWarning: vi.fn(() => true),
      capture: vi.fn(() => true), claim: vi.fn(() => false), complete: vi.fn(), discardCompletedBefore: vi.fn(), load: vi.fn(),
    }
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => [null, { update_id: 1 }, { update_id: 2.5 }, {
      update_id: 2, callback_query: { id: "cb", from: { id: 10 }, data: "x" },
    }]) }
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore, inboxStore, onMessage })
    await expect(poll.pollOnce()).resolves.toBe(3)
    expect(onMessage).not.toHaveBeenCalled()
    expect(inboxStore.capture).not.toHaveBeenCalled()
    expect(inboxStore.complete).not.toHaveBeenCalled()
  })

  it("runs until externally aborted and combines the caller signal", async () => {
    const controller = new AbortController()
    const request = vi.fn(async () => { controller.abort(); return [] })
    const poll = createTelegramLongPoll({ api: { request, stop: vi.fn() }, expectedUserId: "10", expectedChatId: "10", offsetStore: { load: () => 0, save: vi.fn() }, onMessage: vi.fn() })
    await poll.run(controller.signal)
    expect(request).toHaveBeenCalledOnce()
  })

  it("runs without a caller signal until stopped", async () => {
    let poll!: ReturnType<typeof createTelegramLongPoll>
    const request = vi.fn(async () => { poll.stop(); return [] })
    poll = createTelegramLongPoll({ api: { request, stop: vi.fn() }, expectedUserId: "10", expectedChatId: "10", offsetStore: { load: () => 0, save: vi.fn() }, onMessage: vi.fn() })
    await poll.run()
    expect(request).toHaveBeenCalledOnce()
  })
})

describe("Telegram HTML rendering and chunking", () => {
  it("escapes the complete Telegram HTML metacharacter set", () => {
    expect(escapeTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d")
  })

  it("prefers paragraph, newline, then whitespace boundaries near 1200 units", () => {
    const text = `${"a".repeat(1190)}\n\n${"b".repeat(30)}\n${"c".repeat(30)} ${"d".repeat(30)}`
    const chunks = splitTelegramText(text)
    expect(chunks[0]).toBe(`${"a".repeat(1190)}\n\n`)
    expect(chunks.join("")).toBe(text)
  })

  it("hard-splits without breaking surrogate pairs and never exceeds 4000 rendered UTF-16 units", () => {
    const text = `${"x".repeat(3999)}😀${"y".repeat(4000)}`
    const chunks = splitTelegramText(text, { targetUnits: 4000, maxUnits: 4000 })
    expect(chunks).toHaveLength(3)
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true)
    expect(chunks.join("")).toBe(text)
  })

  it("sends canonical HTML and retries exactly once as identical plaintext on HTTP 400", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async (method: string, body: Record<string, unknown>) => {
        calls.push({ method, body })
        if (calls.length === 1) throw new TelegramApiError("bad html", { status: 400 })
        return { message_id: 7 }
      }),
    }
    await expect(sendTelegramText(api, "42", "a < b")).resolves.toEqual([7])
    expect(calls).toEqual([
      { method: "sendMessage", body: { chat_id: "42", text: "a &lt; b", parse_mode: "HTML" } },
      { method: "sendMessage", body: { chat_id: "42", text: "a < b" } },
    ])
  })

  it("refuses to receipt a sendMessage result without one canonical message id", async () => {
    const api: TelegramBotApi = { request: vi.fn(async () => ({ ok: true })), stop: vi.fn() }
    await expect(sendTelegramText(api, "42", "hello")).rejects.toThrow("message_id")
  })

  it("does not retry non-400 failures or retry a failed plaintext fallback", async () => {
    const non400: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => { throw new TelegramApiError("down", { status: 500 }) }) }
    await expect(sendTelegramText(non400, "42", "hello")).rejects.toThrow("down")
    expect(non400.request).toHaveBeenCalledTimes(1)

    const always400: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => { throw new TelegramApiError("bad", { status: 400 }) }) }
    await expect(sendTelegramText(always400, "42", "hello")).rejects.toThrow("bad")
    expect(always400.request).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ targetUnits: 0 }, "limits"],
    [{ targetUnits: 1.5 }, "limits"],
    [{ targetUnits: 2, maxUnits: 1 }, "limits"],
    [{ maxUnits: 1.5 }, "limits"],
  ])("rejects invalid chunk limits %#", (options, message) => {
    expect(() => splitTelegramText("hello", options)).toThrow(message)
  })

  it("handles empty text plus newline and whitespace boundaries", () => {
    expect(splitTelegramText("")).toEqual([""])
    expect(splitTelegramText("aaaa\nbbbb", { targetUnits: 6, maxUnits: 8 })).toEqual(["aaaa\n", "bbbb"])
    expect(splitTelegramText("aaa bbbb", { targetUnits: 6, maxUnits: 8 })).toEqual(["aaa ", "bbbb"])
  })

  it("rejects a rendered character that cannot fit the maximum", () => {
    expect(() => splitTelegramText("&", { targetUnits: 1, maxUnits: 1 })).toThrow("cannot fit one character")
  })

  it.each([null, [], { message_id: 0 }, { message_id: 1.5 }])("rejects malformed send receipt %j", async (result) => {
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => result) }
    await expect(sendTelegramText(api, "42", "hello")).rejects.toThrow("canonical message_id")
  })

  it("sends every chunk with the exact caller signal", async () => {
    const controller = new AbortController()
    let id = 0
    const api: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => ({ message_id: ++id })) }
    await expect(sendTelegramText(api, "42", "x".repeat(1_201), controller.signal)).resolves.toEqual([1, 2])
    for (const call of (api.request as any).mock.calls) expect(call[2]).toBe(controller.signal)
  })
})

describe("Telegram rate limiting and shutdown", () => {
  it("retries at most three 429 responses with exact 1..30 second clamping", async () => {
    const retryAfter = [0, 31, 1]
    const fetch = vi.fn(async () => {
      const next = retryAfter.shift()
      return next === undefined
        ? jsonResponse({ ok: true, result: "done" })
        : jsonResponse({ ok: false, error_code: 429, description: "slow", parameters: { retry_after: next } }, 429)
    })
    const sleep = vi.fn(async () => undefined)
    const api = createTelegramBotApi({ token, fetch, sleep })

    await expect(api.request("sendMessage", {})).resolves.toBe("done")
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1_000, 30_000, 1_000])
  })

  it("fails on the fourth 429 and on malformed retry metadata", async () => {
    const sleep = vi.fn(async () => undefined)
    const repeated = createTelegramBotApi({
      token,
      sleep,
      fetch: vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429)),
    })
    await expect(repeated.request("sendMessage", {})).rejects.toMatchObject({ status: 429 })
    expect(sleep).toHaveBeenCalledTimes(3)

    const malformedSleep = vi.fn(async () => undefined)
    const malformed = createTelegramBotApi({
      token,
      sleep: malformedSleep,
      fetch: vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1.5 } }, 429)),
    })
    await expect(malformed.request("sendMessage", {})).rejects.toMatchObject({ status: 429 })
    expect(malformedSleep).not.toHaveBeenCalled()
  })

  it("aborts during backoff and shutdown without a post-abort retry", async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429))
    const sleep = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      controller.abort()
      signal.throwIfAborted()
    })
    const api = createTelegramBotApi({ token, fetch, sleep })
    await expect(api.request("sendMessage", {}, controller.signal)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)

    const blockingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    const stoppable = createTelegramBotApi({ token, fetch: blockingFetch })
    const pending = stoppable.request("getUpdates", {})
    stoppable.stop()
    await expect(pending).rejects.toThrow()
    expect(blockingFetch).toHaveBeenCalledTimes(1)
  })

  it("supports a custom API root and default platform fetch", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: true }))
    vi.stubGlobal("fetch", fetch)
    try {
      const api = createTelegramBotApi({ token, apiRoot: "https://telegram.example/" })
      await expect(api.request("getMe", {})).resolves.toBe(true)
      expect(fetch).toHaveBeenCalledWith(`https://telegram.example/bot${token}/getMe`, expect.objectContaining({
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("uses and aborts the default bounded retry sleep", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetch = vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429))
      const api = createTelegramBotApi({ token, fetch })
      const pending = api.request("getMe", {}, controller.signal)
      const rejected = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(1)
      controller.abort(new Error("caller stopped"))
      await rejected
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("records numeric Bot API metadata and default error descriptions without leaking tokens", async () => {
    const api = createTelegramBotApi({ token, fetch: vi.fn(async () => jsonResponse({ ok: false, error_code: "bad", parameters: { retry_after: "later" } }, 400)) })
    const error = await api.request("getMe", {}).catch((caught) => caught) as TelegramApiError
    expect(error).toMatchObject({ message: "Telegram request failed", status: 400, errorCode: null, retryAfterSeconds: null })

    const primitive = createTelegramBotApi({ token, fetch: vi.fn(async () => { throw token }) })
    await expect(primitive.request("getMe", {})).rejects.toMatchObject({ message: "[redacted]" })
  })

  it("covers a successful envelope on a non-OK HTTP status", async () => {
    const api = createTelegramBotApi({ token, fetch: vi.fn(async () => jsonResponse({ ok: true, result: true }, 500)) })
    await expect(api.request("getMe", {})).rejects.toMatchObject({ status: 500 })
  })
})
