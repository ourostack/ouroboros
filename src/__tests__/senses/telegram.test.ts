import { describe, expect, it, vi } from "vitest"

import { createTelegramSenseApp } from "../../senses/telegram"
import type { TelegramBotApi, TelegramInboundMessage, TelegramLongPoll } from "../../senses/telegram-client"

function fixture(input: {
  healthSweep?: any
  approvalRuntime?: any
  pollRun?: () => Promise<void>
  botToken?: string
} = {}) {
  let onMessage: ((message: TelegramInboundMessage) => Promise<void>) | undefined
  let onUpdate: ((update: any) => Promise<boolean>) | undefined
  const poll: TelegramLongPoll = {
    pollOnce: vi.fn(async () => 0),
    run: vi.fn(input.pollRun ?? (async () => undefined)),
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
    terminalizeRecovered: vi.fn(async () => undefined),
  }
  const app = createTelegramSenseApp({
    agentName: "butler",
    credentials: { botToken: input.botToken ?? "test-token", authorizedUserId: "42", authorizedChatId: "42" },
    identityKey: "k".repeat(43),
    migrateIdentity: async () => undefined,
    api,
    offsetStore: { load: () => 0, save: vi.fn() },
    createLongPoll,
    runTurn,
    approvalTransport: input.approvalRuntime ? undefined : approvalTransport,
    approvalRuntime: input.approvalRuntime,
    healthSweep: input.healthSweep,
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
      sessionKey: expect.stringMatching(/^telegram:tg_[A-Za-z0-9_-]{43}$/u),
      friendId: expect.stringMatching(/^telegram-user:tg_[A-Za-z0-9_-]{43}$/u),
      identity: {
        provider: "telegram-user",
        externalId: expect.stringMatching(/^tg_[A-Za-z0-9_-]{43}$/u),
        displayName: expect.stringMatching(/^Telegram user tg_[A-Za-z0-9_-]{43}$/u),
      },
      userMessage: "health?",
    }))
    expect(f.api.request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "42",
      text: "All systems nominal.",
      parse_mode: "HTML",
    }, undefined)
  })

  it("keeps the same opaque friend and session identity across bot-token rotation", async () => {
    const first = fixture({ botToken: "old-token" })
    const rotated = fixture({ botToken: "rotated-token" })
    await first.getOnMessage()({ updateId: 1, messageId: "1", userId: "42", chatId: "42", text: "before" })
    await rotated.getOnMessage()({ updateId: 2, messageId: "2", userId: "42", chatId: "42", text: "after" })

    const firstTurn = first.runTurn.mock.calls[0]![0]
    const rotatedTurn = rotated.runTurn.mock.calls[0]![0]
    expect(rotatedTurn.friendId).toBe(firstTurn.friendId)
    expect(rotatedTurn.sessionKey).toBe(firstTurn.sessionKey)
    expect(rotatedTurn.identity).toEqual(firstTurn.identity)
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
    await f.app.stop()
    await f.app.stop()
    expect(f.poll.stop).toHaveBeenCalledOnce()
    expect(f.api.stop).toHaveBeenCalledOnce()
  })

  it("reconciles expired approvals while polling stays up and stops scheduling on shutdown", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({
      pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }),
    })

    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(4)

    const stopping = f.app.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(4)
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("keeps expiry reconciliation alive after redacted Error and non-Error failures", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic expiry failure"))
      .mockRejectedValueOnce("synthetic non-error failure")
      .mockResolvedValue(undefined)

    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(3)

    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("joins an in-flight reconciliation before closing transport resources", async () => {
    vi.useFakeTimers()
    let releaseReconcile!: () => void
    let finishPolling!: () => void
    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(), handleUpdate: vi.fn(), terminalizeRecovered: vi.fn(),
        reconcileExpired: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseReconcile = resolve })),
      },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const f = fixture({ approvalRuntime, pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    const running = f.app.run()
    await vi.waitFor(() => expect(approvalRuntime.transport.reconcileExpired).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    const stopping = f.app.stop()
    expect(approvalRuntime.close).not.toHaveBeenCalled()
    releaseReconcile()
    finishPolling()
    await stopping
    expect(approvalRuntime.close).toHaveBeenCalledOnce()
    await running
    vi.useRealTimers()
  })

  it("joins an active callback dispatch before closing the approval journal or API", async () => {
    let releaseDecision!: () => void
    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(), terminalizeRecovered: vi.fn(), reconcileExpired: vi.fn(async () => undefined),
        handleUpdate: vi.fn(() => new Promise<{ handled: boolean; accepted: boolean; reason: string }>((resolve) => {
          releaseDecision = () => resolve({ handled: true, accepted: true, reason: "accepted" })
        })),
      },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const f = fixture({ approvalRuntime })
    ;(f.poll.run as any).mockImplementation(async () => {
      await f.getOnUpdate()({ update_id: 1, callback_query: { id: "decision", from: { id: 42 } } })
    })

    const running = f.app.run()
    await vi.waitFor(() => expect(approvalRuntime.transport.handleUpdate).toHaveBeenCalledOnce())
    const stopping = f.app.stop()
    await Promise.resolve()

    expect(f.api.stop).not.toHaveBeenCalled()
    expect(approvalRuntime.close).not.toHaveBeenCalled()
    releaseDecision()
    await running
    await stopping
    expect(f.api.stop).toHaveBeenCalledOnce()
    expect(approvalRuntime.close).toHaveBeenCalledOnce()
  })

  it("deduplicates concurrent run calls and still closes after a failed startup lifecycle", async () => {
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    const first = f.app.run()
    const second = f.app.run()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(f.poll.run).toHaveBeenCalledOnce())
    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await first

    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(), handleUpdate: vi.fn(), terminalizeRecovered: vi.fn(), reconcileExpired: vi.fn(),
      },
      coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
    }
    const failed = createTelegramSenseApp({
      agentName: "butler",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43),
      migrateIdentity: async () => { throw new Error("synthetic startup failure") },
      api: { request: vi.fn(), stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      approvalRuntime,
    })
    await expect(failed.run()).rejects.toThrow("synthetic startup failure")
    await expect(failed.stop()).resolves.toBeUndefined()
    expect(approvalRuntime.close).toHaveBeenCalledOnce()

    const neverStarted = fixture()
    await expect(neverStarted.app.stop()).resolves.toBeUndefined()
    expect(neverStarted.api.stop).toHaveBeenCalledOnce()
  })

  it("caps persistent reconciliation retries with exponential backoff", async () => {
    vi.useFakeTimers()
    let finishPolling!: () => void
    const f = fixture({ pollRun: () => new Promise<void>((resolve) => { finishPolling = resolve }) })
    f.approvalTransport.reconcileExpired
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("persistent failure"))
    const running = f.app.run()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.approvalTransport.reconcileExpired).toHaveBeenCalledTimes(6)
    const stopping = f.app.stop()
    finishPolling()
    await stopping
    await running
    vi.useRealTimers()
  })

  it("recovers interrupted approval decisions before expiring prompts or polling", async () => {
    const order: string[] = []
    const approvalRuntime = {
      transport: {
        sendApproval: vi.fn(),
        handleUpdate: vi.fn(),
        reconcileExpired: vi.fn(async () => { order.push("reconcile") }),
        terminalizeRecovered: vi.fn(),
      },
      coordinator: vi.fn(),
      recover: vi.fn(async () => { order.push("recover") }),
      close: vi.fn(),
    }
    const f = fixture({ approvalRuntime })
    ;(f.poll.run as any).mockImplementation(async () => { order.push("poll") })

    await f.app.run()

    expect(order).toEqual(["recover", "reconcile", "poll"])
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

  it("persists health delivery intent before Telegram send and receipts it afterward", async () => {
    const order: string[] = []
    const healthSweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", deliveryId: "delivery-1" })),
      {
        markDeliveryAttempting: vi.fn(async () => { order.push("attempting") }),
        markDelivered: vi.fn(async () => { order.push("delivered") }),
      },
    )
    const f = fixture({ healthSweep })
    ;(f.api.request as any).mockImplementation(async () => { order.push("send"); return { message_id: 71 } })

    await f.app.run()

    expect(order).toEqual(["attempting", "send", "delivered"])
  })

  it("leaves an attempted health delivery unreceipted when Telegram send fails", async () => {
    const healthSweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", deliveryId: "delivery-1" })),
      { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() },
    )
    const f = fixture({ healthSweep })
    ;(f.api.request as any).mockRejectedValue(new Error("offline"))

    await f.app.run()

    expect(healthSweep.markDeliveryAttempting).toHaveBeenCalledWith("delivery-1")
    expect(healthSweep.markDelivered).not.toHaveBeenCalled()
  })
})
