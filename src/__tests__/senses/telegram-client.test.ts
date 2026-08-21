import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { createHash, createHmac } from "node:crypto"

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

  it("durably signs prompt binding, callback acknowledgement, and terminalization from the bound-message clock", async () => {
    let clock = 1_000_000
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = []
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    const transport = createTelegramApprovalTransport({
      api: {
        stop: vi.fn(),
        request: vi.fn(async (method: string) => {
          if (method === "sendMessage") { clock += 37; return { message_id: 99 } }
          if (method === "answerCallbackQuery") clock += 5_000
          return true
        }),
      },
      expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: (() => { const values = ["approve", "deny"]; return () => values.shift()! })(),
      onDecision: vi.fn(async () => ({ accepted: true, terminalText: "done" })),
      now: () => clock,
      signAcceptanceEvidence: (_event: string, meta: Record<string, unknown>) => `mac:${JSON.stringify(meta)}`,
      onAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => { evidence.push({ event, meta }) },
    } as never)
    const binding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64) }
    const sent = await transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "Restart?", acceptanceBinding: binding } as never)
    expect(sent.expiresAt).toBe(1_300_037)
    expect(records[0]).toMatchObject({ expiresAt: 1_300_037, acceptanceBinding: { ...binding, boundAt: 1_000_037, messageIdDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) } })
    expect(evidence[0]).toMatchObject({ event: "senses.telegram_approval_prompt_bound", meta: { ...binding, approvalId: "approval-1", boundAt: 1_000_037, evidenceMac: expect.stringMatching(/^mac:/u) } })

    clock = 1_120_037
    await transport.handleUpdate(approvalCallback(sent.approveCallbackData))
    expect(evidence.map((entry) => entry.event)).toEqual([
      "senses.telegram_approval_prompt_bound",
      "telegram.approval_prompt_terminalized",
      "telegram.callback_settled",
    ])
    expect(evidence[1]!.meta).toMatchObject({ terminalEditStartedAt: 1_125_037, terminalizedAt: 1_125_037, buttonsRemoved: true, evidenceMac: expect.stringMatching(/^mac:/u) })
    expect(evidence[2]!.meta).toMatchObject({ callbackAt: 1_120_037, acknowledged: true, accepted: true, reason: "accepted", evidenceMac: expect.stringMatching(/^mac:/u) })
    expect(evidence.every((entry) => entry.meta.checkpointDigest === binding.checkpointDigest
      && entry.meta.suspendedSessionRevisionDigest === binding.suspendedSessionRevisionDigest)).toBe(true)
  })

  it.each([false, true])("authenticates expiry observation before a delayed%s terminal edit", async (fallback) => {
    let clock = 1_000_000
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = []
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string, body: Record<string, unknown>) => {
        if (method === "sendMessage") return { message_id: 99 }
        clock += 5_000
        if (fallback && body.parse_mode === "HTML") throw new TelegramApiError("format rejected", { status: 400 })
        return true
      }) },
      expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: (() => { const values = ["approve", "deny"]; return () => values.shift()! })(),
      onDecision: vi.fn(), onExpire: vi.fn(), now: () => clock,
      signAcceptanceEvidence: () => "f".repeat(64),
      onAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => { evidence.push({ event, meta }) },
    } as never)
    const binding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64) }
    const sent = await transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "Restart?", acceptanceBinding: binding } as never)
    clock = 1_300_900
    await transport.reconcileExpired()
    expect(evidence.at(-1)).toMatchObject({ event: "telegram.approval_prompt_terminalized", meta: {
      ...binding, boundAt: 1_000_000, expiryDeadlineAt: sent.expiresAt, expiryObservedAt: 1_300_900, terminalEditStartedAt: 1_300_900, terminalizedAt: fallback ? 1_310_900 : 1_305_900, buttonsRemoved: true,
    } })
  })

  it("observes a second expiry on time while an earlier approval terminal edit is still retrying", async () => {
    let clock = 1_000
    let releaseFirst!: () => void
    const firstEdit = new Promise<void>((resolve) => { releaseFirst = resolve })
    const onExpire = vi.fn()
    const records = [
      { approvalId: "first", messageId: "91", deliveryState: "bound" as const, approveCallbackData: "a:first", denyCallbackData: "d:first", expiresAt: 1_000 },
      { approvalId: "second", messageId: "92", deliveryState: "bound" as const, approveCallbackData: "a:second", denyCallbackData: "d:second", expiresAt: 2_000 },
    ]
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string, body: Record<string, unknown>) => {
        if (method === "editMessageText" && body.message_id === 91) await firstEdit
        return true
      }) },
      expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: vi.fn() },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), onExpire, now: () => clock,
    })

    const firstPass = transport.reconcileExpired()
    await vi.waitFor(() => expect(onExpire).toHaveBeenCalledWith("first"))
    clock = 2_000
    const secondPass = transport.reconcileExpired()
    try {
      await vi.waitFor(() => expect(onExpire).toHaveBeenCalledWith("second"))
    } finally {
      releaseFirst()
      await Promise.allSettled([firstPass, secondPass])
    }
    expect(onExpire.mock.calls.filter(([approvalId]) => approvalId === "first")).toHaveLength(1)
  })

  it("persists and signs the first expiry observation before a failed edit, then reuses it after restart", async () => {
    let clock = 301_000
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = [{
      approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 300_000,
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
    }]
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    const store = { load: () => structuredClone(records), save: (next: typeof records) => { records = structuredClone(next) } }
    const options = {
      expectedUserId: "10", expectedChatId: "10", pendingStore: store, createOpaqueHandle: vi.fn(), onDecision: vi.fn(), onExpire: vi.fn(), now: () => clock,
      signAcceptanceEvidence: () => "9".repeat(64), onAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => { evidence.push({ event, meta }) },
    }
    const first = createTelegramApprovalTransport({ ...options, api: { stop: vi.fn(), request: vi.fn(async () => { throw new Error("edit unavailable") }) } } as never)
    await expect(first.reconcileExpired()).rejects.toThrow("edit unavailable")
    expect(records[0]).toMatchObject({ expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 300_000, observedAt: 301_000, evidenceMac: "9".repeat(64) } })
    expect(evidence).toEqual([expect.objectContaining({ event: "telegram.approval_expiry_observed", meta: expect.objectContaining({ expiryDeadlineAt: 300_000, expiryObservedAt: 301_000, evidenceMac: "9".repeat(64) }) })])

    clock = 320_000
    const restarted = createTelegramApprovalTransport({ ...options, api: { stop: vi.fn(), request: vi.fn(async () => true) } } as never)
    await restarted.reconcileExpired()
    expect(evidence.filter(({ event }) => event === "telegram.approval_expiry_observed").every(({ meta }) => meta.expiryObservedAt === 301_000)).toBe(true)
    expect(evidence.findLast(({ event }) => event === "telegram.approval_prompt_terminalized")?.meta).toMatchObject({ expiryObservedAt: 301_000, expiryDeadlineAt: 300_000 })
  })

  it("persists the callback's exact first expiry observation before acknowledging it", async () => {
    let clock = 1_000
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = [{
      approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000,
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
    }]
    let observationAtAck: unknown
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => {
        if (method === "answerCallbackQuery") { observationAtAck = records[0]?.expiryObservation; clock += 5 }
        return true
      }) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), onExpire: vi.fn(), now: () => clock,
      signAcceptanceEvidence: () => "f".repeat(64), onAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => { evidence.push({ event, meta }) },
    } as never)
    await transport.handleUpdate(approvalCallback("a:approve"))
    expect(observationAtAck).toMatchObject({ deadlineAt: 1_000, observedAt: 1_000, evidenceMac: "f".repeat(64) })
    expect(evidence.find(({ event }) => event === "telegram.callback_settled")?.meta.callbackAt).toBe(1_000)
  })

  it("rolls back a failed expiry-observation commit so same-instance retry persists before ack", async () => {
    const initial = [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000,
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 } }]
    let durable = structuredClone(initial) as ReturnType<TelegramPendingApprovalStore["load"]>
    let fail = true
    const stateAtAck: unknown[] = []
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => { if (method === "answerCallbackQuery") stateAtAck.push(durable[0]?.expiryObservation); return true }) },
      expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => structuredClone(durable), save: (next) => { if (fail) { fail = false; throw new Error("transient expiry save") }; durable = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), onExpire: vi.fn(), now: () => 1_000, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve"))).rejects.toThrow("transient expiry save")
    expect(stateAtAck).toEqual([])
    await transport.handleUpdate(approvalCallback("a:approve", { id: "retry" }))
    expect(stateAtAck[0]).toMatchObject({ observedAt: 1_000, evidenceMac: "f".repeat(64) })
  })

  it("serializes an expired callback against proactive reconciliation for the same approval", async () => {
    let releaseEdit!: () => void
    const editBlocked = new Promise<void>((resolve) => { releaseEdit = resolve })
    const onExpire = vi.fn()
    const edits: number[] = []
    const fixture = approvalFixture({
      now: () => 2_000,
      records: [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000 }],
      onExpire,
      apiRequest: async (method) => { if (method === "editMessageText") { edits.push(1); await editBlocked }; return true },
    })
    const proactive = fixture.transport.reconcileExpired()
    await vi.waitFor(() => expect(onExpire).toHaveBeenCalledOnce())
    const callback = fixture.transport.handleUpdate(approvalCallback("a:approve", { id: "racing-expired" }))
    await Promise.resolve()
    expect(onExpire).toHaveBeenCalledOnce()
    expect(edits).toHaveLength(1)
    releaseEdit()
    await Promise.allSettled([proactive, callback])
    expect(onExpire).toHaveBeenCalledOnce()
    expect(edits).toHaveLength(1)
  })

  it("retains one authenticated callback tombstone after expiry and consumes it without replay", async () => {
    let clock = 1_000_000
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = []
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    const onDecision = vi.fn()
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => method === "sendMessage" ? { message_id: 99 } : true) },
      expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: (() => { const values = ["approve", "deny"]; return () => values.shift()! })(),
      onDecision, onExpire: vi.fn(), now: () => clock,
      signAcceptanceEvidence: () => "f".repeat(64),
      onAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => { evidence.push({ event, meta }) },
    } as never)
    const binding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64) }
    const sent = await transport.sendApproval({ approvalId: "approval-1", decisionToken: "secret", prompt: "Restart?", acceptanceBinding: binding } as never)
    clock = sent.expiresAt
    await transport.reconcileExpired()
    expect(records).toEqual([expect.objectContaining({ approvalId: "approval-1", deliveryState: "terminal_tombstone" })])
    expect(transport.listPendingDeliveries()).toEqual([])

    clock += 10
    await transport.handleUpdate(approvalCallback(sent.approveCallbackData))
    expect(evidence.at(-1)).toMatchObject({ event: "telegram.approval_stale_callback_settled", meta: {
      ...binding, approvalId: "approval-1", staleAt: clock, acknowledged: true, accepted: false, reason: "stale_callback", evidenceMac: "f".repeat(64),
    } })
    expect(records).toEqual([expect.objectContaining({
      approvalId: "approval-1", deliveryState: "terminal_tombstone",
      staleTap: expect.objectContaining({ schemaVersion: "telegram-approval-stale-tap-v1", state: "consumed", consumedAt: clock }),
    })])
    await transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-2" }))
    expect(evidence.filter((entry) => entry.event === "telegram.approval_stale_callback_settled")).toHaveLength(1)
    expect(onDecision).not.toHaveBeenCalled()
  })

  it("never emits stale-tap success when durable consumption cannot be persisted", async () => {
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    const tombstone = { approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000, terminalizedAt: 2_000, tombstoneExpiresAt: 602_000, tombstoneMac: "f".repeat(64),
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1" as const, deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "f".repeat(64) } }
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => [structuredClone(tombstone)], save: () => { throw new Error("disk unavailable") } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 3_000,
      signAcceptanceEvidence: () => "f".repeat(64), onAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => { evidence.push({ event, meta }) },
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "stale-save-failure" }))).rejects.toThrow("disk unavailable")
    expect(evidence.filter(({ event }) => event === "telegram.approval_stale_callback_settled")).toEqual([])
  })

  it("resumes the same durably attempted stale tap after restart before emitting success", async () => {
    const queryId = "stale-resume"
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = [{
      approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone", approveCallbackData: "a:approve", denyCallbackData: "d:deny",
      expiresAt: 1_000, terminalizedAt: 2_000, tombstoneExpiresAt: 602_000, tombstoneMac: "f".repeat(64),
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "f".repeat(64) },
      staleTap: { schemaVersion: "telegram-approval-stale-tap-v1", state: "attempted", queryIdDigest: createHash("sha256").update(queryId).digest("hex"), attemptedAt: 2_100, consumedAt: null, evidenceMac: "f".repeat(64) },
    }]
    const evidence: string[] = []
    let stateAtAck: unknown
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => {
        if (method === "answerCallbackQuery") stateAtAck = records[0]?.staleTap?.state
        return true
      }) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 2_200, signAcceptanceEvidence: () => "f".repeat(64),
      onAcceptanceEvidence: (event: string) => { evidence.push(event) },
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: queryId }))).resolves.toMatchObject({ reason: "stale_callback" })
    expect(stateAtAck).toBe("consumed")
    expect(records[0]).toMatchObject({ staleTap: { state: "consumed", attemptedAt: 2_100, consumedAt: 2_200 } })
    expect(evidence.filter((event) => event === "telegram.approval_stale_callback_settled")).toHaveLength(1)
  })

  it.each(["attempted", "consumed"] as const)("rolls back a transient %s stale-tap commit before same-instance retry", async (failedState) => {
    const queryId = "stale-retry"
    let durable: ReturnType<TelegramPendingApprovalStore["load"]> = [{
      approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone", approveCallbackData: "a:approve", denyCallbackData: "d:deny",
      expiresAt: 1_000, terminalizedAt: 2_000, tombstoneExpiresAt: 602_000, tombstoneMac: "f".repeat(64),
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "f".repeat(64) },
    }]
    let failed = false
    const committed: string[] = []
    const stateAtAck: unknown[] = []
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => { if (method === "answerCallbackQuery") stateAtAck.push(durable[0]?.staleTap?.state); return true }) },
      expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => structuredClone(durable), save: (next) => {
        const state = next[0]?.staleTap?.state
        if (!failed && state === failedState) { failed = true; throw new Error(`transient ${failedState} save`) }
        durable = structuredClone(next)
        if (state) committed.push(state)
      } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 2_100, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: queryId }))).rejects.toThrow(`transient ${failedState} save`)
    expect(stateAtAck).toEqual([])
    await transport.handleUpdate(approvalCallback("a:approve", { id: queryId }))
    expect(committed).toEqual(["attempted", "consumed"])
    expect(stateAtAck).toEqual(["consumed"])
  })

  it("refuses to consume a recovered stale-tap attempt with a different callback query", async () => {
    const queryId = "original-query"
    const api = { stop: vi.fn(), request: vi.fn(async () => true) }
    const transport = createTelegramApprovalTransport({
      api, expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => [{
        approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone", approveCallbackData: "a:approve", denyCallbackData: "d:deny",
        expiresAt: 1_000, terminalizedAt: 2_000, tombstoneExpiresAt: 602_000, tombstoneMac: "f".repeat(64),
        acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
        expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "f".repeat(64) },
        staleTap: { schemaVersion: "telegram-approval-stale-tap-v1", state: "attempted", queryIdDigest: createHash("sha256").update(queryId).digest("hex"), attemptedAt: 2_100, consumedAt: null, evidenceMac: "f".repeat(64) },
      }], save: vi.fn() }, createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 2_200, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "different-query" }))).rejects.toThrow("query mismatch")
    expect(api.request).not.toHaveBeenCalledWith("answerCallbackQuery", expect.anything())
  })

  it.each([
    { patch: { expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "e".repeat(64) } }, error: "terminal tombstone" },
    { patch: { staleTap: { schemaVersion: "telegram-approval-stale-tap-v1", state: "attempted", queryIdDigest: "invalid", attemptedAt: 2_100, consumedAt: null } }, error: "terminal tombstone" },
  ])("fails closed on invalid persisted tombstone evidence: $error", async ({ patch, error }) => {
    const record = {
      approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny",
      expiresAt: 1_000, terminalizedAt: 2_000, tombstoneExpiresAt: 602_000, tombstoneMac: "f".repeat(64),
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1" as const, deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "f".repeat(64) },
      ...patch,
    }
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => [record] as never, save: vi.fn() }, createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 2_200,
      signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "stale-resume" }))).rejects.toThrow(error)
  })

  it.each(["tombstone", "staleTap"] as const)("authenticates valid-shaped %s state against durable tamper", async (target) => {
    const sign = (event: string, meta: Record<string, unknown>) => createHash("sha256").update(JSON.stringify({ event, meta })).digest("hex")
    const acceptanceBinding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 }
    const common = { approvalId: "approval-1", ...acceptanceBinding }
    const expiryFields = { expiryObservationSchemaVersion: "telegram-approval-expiry-observation-v1", expiryDeadlineAt: 1_000, expiryObservedAt: 2_000 }
    const tombstoneFields = { terminalizedAt: 2_000, tombstoneExpiresAt: 602_000 }
    const staleFields = { staleTapSchemaVersion: "telegram-approval-stale-tap-v1", staleTapState: "consumed", queryIdDigest: createHash("sha256").update("query-1").digest("hex"), attemptedAt: 2_100, consumedAt: 2_200 }
    const record = {
      approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000,
      ...tombstoneFields, acceptanceBinding,
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1" as const, deadlineAt: 1_000, observedAt: 2_000, evidenceMac: sign("telegram.approval_expiry_observed", { ...common, ...expiryFields }) },
      tombstoneMac: sign("telegram.approval_terminal_tombstone_state", { ...common, ...expiryFields, ...tombstoneFields }),
      staleTap: { schemaVersion: "telegram-approval-stale-tap-v1" as const, state: "consumed" as const, queryIdDigest: staleFields.queryIdDigest, attemptedAt: 2_100, consumedAt: 2_200,
        evidenceMac: sign("telegram.approval_stale_tap_state", { ...common, ...tombstoneFields, ...staleFields }) },
    }
    const tampered = target === "tombstone"
      ? { ...record, terminalizedAt: 2_001, tombstoneExpiresAt: 602_001 }
      : { ...record, staleTap: { ...record.staleTap, consumedAt: 2_201 } }
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => [tampered] as never, save: vi.fn() }, createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 602_001,
      signAcceptanceEvidence: sign,
    } as never)
    if (target === "tombstone") await expect(transport.reconcileExpired()).rejects.toThrow("terminal tombstone")
    else await expect(transport.handleUpdate(approvalCallback("a:approve"))).rejects.toThrow("terminal tombstone")
  })

  it("keeps terminal tombstone purge inside the callback claim and rejects tampered tombstones", async () => {
    const base = {
      approvalId: "approval-1", messageId: "99", deliveryState: "terminal_tombstone" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny",
      expiresAt: 1_000, terminalizedAt: 2_000, tombstoneExpiresAt: 602_000, tombstoneMac: "f".repeat(64),
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1" as const, deadlineAt: 1_000, observedAt: 2_000, evidenceMac: "f".repeat(64) },
    }
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = [structuredClone(base)]
    let releaseAck!: () => void
    const ack = new Promise<void>((resolve) => { releaseAck = resolve })
    let markAckStarted!: () => void
    const ackStarted = new Promise<void>((resolve) => { markAckStarted = resolve })
    let stateAtAck: unknown
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => {
        if (method === "answerCallbackQuery") { stateAtAck = records[0]?.staleTap?.state; markAckStarted(); await ack }
        return true
      }) },
      expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 602_000, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    const callback = transport.handleUpdate(approvalCallback("a:approve"))
    await ackStarted
    await transport.reconcileExpired()
    releaseAck()
    await callback
    expect(stateAtAck).toBe("consumed")
    expect(records).toHaveLength(1)

    records = [{ ...structuredClone(base), expiryObservation: { ...base.expiryObservation, evidenceMac: "e".repeat(64) } }]
    const tampered = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn() }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => { records = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), now: () => 602_000, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    await expect(tampered.reconcileExpired()).rejects.toThrow("terminal tombstone")
    expect(records).toHaveLength(1)
  })

  it.each(["reconcile", "callback"] as const)("rolls back a transient terminal tombstone commit during expired %s", async (driver) => {
    let records: ReturnType<TelegramPendingApprovalStore["load"]> = [{
      approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000,
      acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 },
    }]
    let failed = false
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(records), save: (next) => {
        if (!failed && next[0]?.deliveryState === "terminal_tombstone") { failed = true; throw new Error("transient tombstone save") }
        records = structuredClone(next)
      } }, createOpaqueHandle: vi.fn(), onDecision: vi.fn(), onExpire: vi.fn(), now: () => 1_000, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    const drive = () => driver === "reconcile" ? transport.reconcileExpired() : transport.handleUpdate(approvalCallback("a:approve"))
    await expect(drive()).rejects.toThrow("transient tombstone save")
    expect(records[0]).toMatchObject({ deliveryState: "bound", expiryObservation: expect.objectContaining({ observedAt: 1_000 }) })
    await drive()
    expect(records[0]).toMatchObject({ deliveryState: "terminal_tombstone", tombstoneMac: "f".repeat(64) })
  })

  it("durably retires an unclaimed terminal tombstone at its bounded deadline", async () => {
    let clock = 2_000_000
    const saves: unknown[] = []
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn() }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: {
        load: () => [{ approvalId: "expired", messageId: "99", deliveryState: "terminal_tombstone", approveCallbackData: "a:expired", denyCallbackData: "d:expired", expiresAt: 1_000_000, terminalizedAt: 1_400_000, tombstoneExpiresAt: 2_000_000, tombstoneMac: "f".repeat(64),
          acceptanceBinding: { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 700_000 },
          expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 1_000_000, observedAt: 1_000_000, evidenceMac: "f".repeat(64) } }],
        save: (records) => { saves.push(structuredClone(records)) },
      },
      createOpaqueHandle: vi.fn(), onDecision: vi.fn(), onExpire: vi.fn(), now: () => clock, signAcceptanceEvidence: () => "f".repeat(64),
    } as never)
    await transport.reconcileExpired()
    expect(saves).toEqual([[]])
    expect(transport.listPendingDeliveries()).toEqual([])
    clock += 1
    await transport.reconcileExpired()
    expect(saves).toHaveLength(1)
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

  it("does not acknowledge or claim a valid decision when its durable attempt fence fails", async () => {
    const api = { stop: vi.fn(), request: vi.fn(async () => true) }
    const onDecision = vi.fn(async () => ({ accepted: true, terminalText: "done" }))
    const transport = createTelegramApprovalTransport({
      api, expectedUserId: "10", expectedChatId: "10", pendingStore: {
        load: () => [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 10_000 }],
        save: () => { throw new Error("decision fence unavailable") },
      }, createOpaqueHandle: vi.fn(), onDecision, resolveDecisionToken: async () => "token", now: () => 1_000,
    })
    await expect(transport.handleUpdate(approvalCallback("a:approve"))).rejects.toThrow("decision fence unavailable")
    expect(api.request).not.toHaveBeenCalledWith("answerCallbackQuery", expect.anything())
    expect(onDecision).not.toHaveBeenCalled()
  })

  it("resumes a durably fenced decision after crash without losing the tap while bound", async () => {
    let durable: ReturnType<TelegramPendingApprovalStore["load"]> = [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 10_000 }]
    const firstApi = { stop: vi.fn(), request: vi.fn(async () => true) }
    const options = {
      expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => structuredClone(durable), save: (next: typeof durable) => { durable = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), resolveDecisionToken: async () => "token", now: () => 1_000,
    }
    const crashed = createTelegramApprovalTransport({ ...options, api: firstApi, onDecision: vi.fn(async () => { throw new Error("crash after attempt fence") }) })
    await expect(crashed.handleUpdate(approvalCallback("a:approve", { id: "decision-query" }))).rejects.toThrow("crash after attempt fence")
    expect(durable[0]).toMatchObject({ deliveryState: "bound", decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1", decision: "approve", attemptedAt: 1_000 } })
    expect(durable[0]?.terminal).toBeUndefined()
    expect(firstApi.request).not.toHaveBeenCalledWith("answerCallbackQuery", expect.anything())

    const order: string[] = []
    const restarted = createTelegramApprovalTransport({ ...options,
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => { if (method === "answerCallbackQuery") order.push("ack"); return true }) },
      onDecision: vi.fn(async () => { order.push("claim"); return { accepted: true, terminalText: "done" } }),
    })
    await restarted.handleUpdate(approvalCallback("a:approve", { id: "decision-query" }))
    expect(order.slice(0, 2)).toEqual(["claim", "ack"])
  })

  it("lets an authenticated pre-deadline decision attempt resume after wall-clock expiry", async () => {
    let clock = 999
    let durable: ReturnType<TelegramPendingApprovalStore["load"]> = [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000 }]
    const onDecision = vi.fn()
      .mockRejectedValueOnce(new Error("crash before claim"))
      .mockResolvedValueOnce({ accepted: true, terminalText: "done" })
    const onExpire = vi.fn()
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(durable), save: (next) => { durable = structuredClone(next) } }, createOpaqueHandle: vi.fn(),
      onDecision, onExpire, resolveDecisionToken: async () => "token", now: () => clock,
    })
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "decision-query" }))).rejects.toThrow("crash before claim")
    clock = 1_001
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "decision-query" }))).resolves.toMatchObject({ accepted: true })
    expect(onExpire).not.toHaveBeenCalled()
  })

  it("rejects valid-shaped decision-attempt tamper against its token MAC and approval binding", async () => {
    const decisionToken = "decision-token"
    const acceptanceBinding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 }
    const payload = { approvalId: "approval-1", messageId: "99", expiresAt: 1_000, approveCallbackData: "a:approve", denyCallbackData: "d:deny", acceptanceBinding,
      schemaVersion: "telegram-approval-decision-attempt-v1", decision: "approve", queryIdDigest: createHash("sha256").update("decision-query").digest("hex"), attemptedAt: 900 }
    const evidenceMac = createHmac("sha256", decisionToken).update(JSON.stringify(payload)).digest("hex")
    const api = { stop: vi.fn(), request: vi.fn(async () => true) }
    const onDecision = vi.fn()
    const transport = createTelegramApprovalTransport({
      api, expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => [{
        approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000, acceptanceBinding,
        decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1", decision: "approve", queryIdDigest: payload.queryIdDigest, attemptedAt: 901, evidenceMac },
      }] as never, save: vi.fn() }, createOpaqueHandle: vi.fn(), onDecision, resolveDecisionToken: async () => decisionToken, now: () => 901,
    } as never)
    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "decision-query" }))).rejects.toThrow("decision attempt")
    expect(api.request).not.toHaveBeenCalled()
    expect(onDecision).not.toHaveBeenCalled()
  })

  it.each(["approve", "deny"] as const)("recovers a tokenless late-terminal %s using independently signed attempt evidence", async (decision) => {
    const acceptanceBinding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 }
    const attemptedAt = 900
    const attempt = { schemaVersion: "telegram-approval-decision-attempt-v1" as const, decision, queryIdDigest: "a".repeat(64), attemptedAt, evidenceMac: "b".repeat(64), recoveryMac: "c".repeat(64) }
    let durable: ReturnType<TelegramPendingApprovalStore["load"]> = [{
      approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000,
      acceptanceBinding, decisionAttempt: attempt, terminal: { accepted: decision === "approve", terminalText: "done" }, terminalMac: "f".repeat(64),
    }]
    const onDecision = vi.fn()
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(durable), save: (next) => { durable = structuredClone(next) } }, createOpaqueHandle: vi.fn(), onDecision,
      resolveDecisionToken: async () => "", now: () => 1_100, signAcceptanceEvidence: (event: string) => event === "telegram.approval_decision_attempt_recovery_state" ? "c".repeat(64) : "f".repeat(64),
      commitAcceptanceEvidence: vi.fn(),
    } as never)

    await expect(transport.recoverDecisionAttempt("approval-1")).resolves.toBe(true)
    expect(onDecision).not.toHaveBeenCalled()
    expect(durable).toEqual([])
  })

  it("fails closed on tampered tokenless late-terminal recovery evidence", async () => {
    const acceptanceBinding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 }
    const record = { approvalId: "approval-1", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000, acceptanceBinding,
      decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1" as const, decision: "approve" as const, queryIdDigest: "a".repeat(64), attemptedAt: 900, evidenceMac: "b".repeat(64), recoveryMac: "d".repeat(64) }, terminal: { accepted: true, terminalText: "done" }, terminalMac: "c".repeat(64) }
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => [record], save: vi.fn() }, createOpaqueHandle: vi.fn(), onDecision: vi.fn(),
      resolveDecisionToken: async () => "", now: () => 1_100, signAcceptanceEvidence: () => "c".repeat(64), commitAcceptanceEvidence: vi.fn(),
    } as never)
    await expect(transport.recoverDecisionAttempt("approval-1")).rejects.toThrow("decision attempt")
    expect(transport.listPendingDeliveries()).toHaveLength(1)
  })

  it.each([
    { accepted: false, terminalText: "done" },
    { accepted: true, terminalText: "tampered text" },
  ])("fails closed when a signed late-terminal outcome is altered", async (terminal) => {
    const acceptanceBinding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 }
    const record = { approvalId: "approval-1", messageId: "99", deliveryState: "bound" as const, approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 1_000, acceptanceBinding,
      decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1" as const, decision: "approve" as const, queryIdDigest: "a".repeat(64), attemptedAt: 900, evidenceMac: "b".repeat(64), recoveryMac: "c".repeat(64) }, terminal, terminalMac: "d".repeat(64) }
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10", pendingStore: { load: () => [record], save: vi.fn() }, createOpaqueHandle: vi.fn(), onDecision: vi.fn(),
      resolveDecisionToken: async () => "", now: () => 1_100,
      signAcceptanceEvidence: (event: string) => event === "telegram.approval_decision_attempt_recovery_state" ? "c".repeat(64) : "e".repeat(64), commitAcceptanceEvidence: vi.fn(),
    } as never)
    await expect(transport.recoverDecisionAttempt("approval-1")).rejects.toThrow("terminal outcome")
    expect(transport.listPendingDeliveries()).toHaveLength(1)
  })

  it.each(["approve", "deny"] as const)("recovers a poll-quarantined %s decision attempt at startup without Telegram redispatch", async (decision) => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-decision-recovery-")); tempDirectories.push(directory)
    const pendingStore = new FileTelegramPendingApprovalStore(join(directory, "pending.json"))
    pendingStore.save([{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 10_000 }])
    const offsetStore = new FileTelegramOffsetStore(join(directory, "offset.json"))
    const inboxStore = new FileTelegramUpdateInboxStore(join(directory, "inbox.json"))
    const update = approvalCallback(decision === "approve" ? "a:approve" : "d:deny", { id: "decision-query" })
    const firstTransport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10", pendingStore, createOpaqueHandle: vi.fn(),
      onDecision: vi.fn(async () => { throw new Error("crash after poll offset commit") }), resolveDecisionToken: async () => "token", now: () => 1_000,
    })
    const poll = createTelegramLongPoll({
      api: { stop: vi.fn(), request: vi.fn(async (method: string) => method === "getUpdates" ? [update] : true) }, expectedUserId: "10", expectedChatId: "10",
      offsetStore, inboxStore, onMessage: vi.fn(), onUpdate: async (input) => (await firstTransport.handleUpdate(input)).handled,
    })
    await expect(poll.pollOnce()).rejects.toThrow("crash after poll offset commit")
    expect(offsetStore.load()).toBe(2)
    expect(inboxStore.loadIndeterminate()).toHaveLength(1)
    expect(pendingStore.load()[0]).toMatchObject({ decisionAttempt: expect.objectContaining({ attemptedAt: 1_000 }) })

    const onDecision = vi.fn(async () => ({ accepted: decision === "approve", terminalText: "done" }))
    const restarted = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10", pendingStore, createOpaqueHandle: vi.fn(),
      onDecision, resolveDecisionToken: async () => "token", now: () => 2_000,
    }) as ReturnType<typeof createTelegramApprovalTransport> & { recoverDecisionAttempt(approvalId: string): Promise<boolean> }
    await expect(restarted.recoverDecisionAttempt("approval-1")).resolves.toBe(true)
    expect(onDecision).toHaveBeenCalledOnce()
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision }))
    expect(pendingStore.load()).toEqual([])
  })

  it("rolls back a transient terminal cleanup failure for same-instance recovery without replaying authority", async () => {
    const acceptanceBinding = { scenarioHandleDigest: "a".repeat(64), actionDigest: "b".repeat(64), targetDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), messageIdDigest: "f".repeat(64), boundAt: 0 }
    const evidence: Array<{ event: string; meta: Record<string, unknown> }> = []
    let durable: ReturnType<TelegramPendingApprovalStore["load"]> = [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 10_000, acceptanceBinding }]
    let cleanupFailed = false
    const pendingStore = {
      load: () => structuredClone(durable),
      save: (next: typeof durable) => {
        if (next.length === 0 && !cleanupFailed) { cleanupFailed = true; throw new Error("cleanup save unavailable") }
        durable = structuredClone(next)
      },
    }
    const onDecision = vi.fn(async () => ({ accepted: true, terminalText: "done" }))
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10", pendingStore,
      createOpaqueHandle: vi.fn(), onDecision, resolveDecisionToken: async () => "token", now: () => 1_000,
      signAcceptanceEvidence: () => "f".repeat(64), onAcceptanceEvidence: (event, meta) => { evidence.push({ event, meta }) },
    } as never)

    await expect(transport.handleUpdate(approvalCallback("a:approve", { id: "decision-query" }))).rejects.toThrow("cleanup save unavailable")
    expect(transport.listPendingDeliveries()).toHaveLength(1)
    await expect(transport.recoverDecisionAttempt("approval-1")).resolves.toBe(true)

    expect(onDecision).toHaveBeenCalledOnce()
    expect(durable).toEqual([])
    const settlements = evidence.filter((entry) => entry.event === "telegram.callback_settled")
    expect(settlements).toHaveLength(2)
    expect(settlements[0]!.meta).toEqual(settlements[1]!.meta)
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

  it("preserves a durable decision attempt after onDecision rejects and retries only the same query", async () => {
    const onDecision = vi.fn()
      .mockRejectedValueOnce(new Error("continuation unavailable"))
      .mockResolvedValueOnce({ accepted: false, terminalText: "⚠️ Approval did not complete" })
    const resolveDecisionToken = vi.fn(async () => "must-not-be-reused")
    const fixture = approvalFixture({ onDecision, resolveDecisionToken })
    const sent = await fixture.transport.sendApproval({ approvalId: "approval-1", decisionToken: "one-shot-token", prompt: "Restart?" })

    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-1" })))
      .rejects.toThrow("continuation unavailable")
    expect(fixture.records()).toEqual([expect.objectContaining({
      approvalId: "approval-1",
      deliveryState: "bound",
      decisionAttempt: expect.objectContaining({ schemaVersion: "telegram-approval-decision-attempt-v1", decision: "approve" }),
    })])
    expect(JSON.stringify(fixture.records())).not.toContain("one-shot-token")

    await expect(fixture.transport.handleUpdate(approvalCallback(sent.approveCallbackData, { id: "query-1" })))
      .resolves.toEqual({ handled: true, accepted: false, reason: "decision_refused" })
    expect(onDecision).toHaveBeenCalledTimes(2)
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
    expect(stale.saves.find((save) => save[0]?.settlementReceipt)?.[0]?.settlementReceipt).toMatchObject({
      acknowledgementState: "rejected_as_stale",
    })

    const failed = approvalFixture({ apiRequest: async (method) => {
      if (method === "answerCallbackQuery") throw new Error("ack down")
      return { message_id: 99 }
    } })
    const failedSent = await failed.transport.sendApproval({ approvalId: "a", decisionToken: "secret", prompt: "go?" })
    await expect(failed.transport.handleUpdate(approvalCallback(failedSent.approveCallbackData))).rejects.toThrow("ack down")
    expect(failed.transport.listPendingDeliveries()).toHaveLength(1)
  })

  it.each(["approve", "deny"] as const)("retains a %s settlement until its durable audit append succeeds", async (decision) => {
    let durable: ReturnType<TelegramPendingApprovalStore["load"]> = [{ approvalId: "approval-1", messageId: "99", deliveryState: "bound", approveCallbackData: "a:approve", denyCallbackData: "d:deny", expiresAt: 10_000 }]
    let appendAttempts = 0
    const committed: Array<{ event: string; meta: Record<string, unknown> }> = []
    const onDecision = vi.fn(async () => ({ accepted: decision === "approve", terminalText: "done" }))
    const transport = createTelegramApprovalTransport({
      api: { stop: vi.fn(), request: vi.fn(async () => true) }, expectedUserId: "10", expectedChatId: "10",
      pendingStore: { load: () => structuredClone(durable), save: (next) => { durable = structuredClone(next) } },
      createOpaqueHandle: vi.fn(), onDecision, resolveDecisionToken: async () => "token", now: () => 1_000,
      signAcceptanceEvidence: () => "f".repeat(64),
      commitAcceptanceEvidence: (event: string, meta: Record<string, unknown>) => {
        appendAttempts += 1
        if (appendAttempts === 1) throw new Error("audit append unavailable")
        committed.push({ event, meta })
      },
    } as never)

    const callbackData = decision === "approve" ? "a:approve" : "d:deny"
    await expect(transport.handleUpdate(approvalCallback(callbackData, { id: "decision-query" }))).rejects.toThrow("audit append unavailable")
    expect(transport.listPendingDeliveries()).toHaveLength(1)
    await expect(transport.recoverDecisionAttempt("approval-1")).resolves.toBe(true)

    expect(onDecision).toHaveBeenCalledOnce()
    expect(committed).toHaveLength(1)
    expect(committed[0]?.event).toBe("telegram.callback_settled")
    expect(committed[0]?.meta).toMatchObject({ approvalId: "approval-1", evidenceMac: "f".repeat(64) })
    expect(durable).toEqual([])
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
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore, onMessage })
    await poll.pollOnce()
    expect(onMessage).not.toHaveBeenCalled()
    expect(offset).toBe(4)
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
