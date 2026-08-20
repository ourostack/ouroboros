import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getAgentRoot: vi.fn(() => "/tmp/telegram-agent"),
  readRuntimeCredentialConfig: vi.fn(),
  runSenseTurn: vi.fn(),
  createTelegramBotApi: vi.fn(),
  createTelegramLongPoll: vi.fn(),
  sendTelegramText: vi.fn(),
  createSanctuaryToolContext: vi.fn(() => ({ sanctuary: true })),
  createTelegramApprovalRuntime: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({ getAgentRoot: mocks.getAgentRoot }))
vi.mock("../../heart/runtime-credentials", () => ({ readRuntimeCredentialConfig: mocks.readRuntimeCredentialConfig }))
vi.mock("../../senses/shared-turn", () => ({ runSenseTurn: mocks.runSenseTurn }))
vi.mock("../../senses/sanctuary-runtime", () => ({ createSanctuaryToolContext: mocks.createSanctuaryToolContext }))
vi.mock("../../senses/telegram-approval-runtime", () => ({ createTelegramApprovalRuntime: mocks.createTelegramApprovalRuntime }))
vi.mock("../../senses/telegram-client", async (importActual) => ({
  ...await importActual<typeof import("../../senses/telegram-client")>(),
  createTelegramBotApi: mocks.createTelegramBotApi,
  createTelegramLongPoll: mocks.createTelegramLongPoll,
  sendTelegramText: mocks.sendTelegramText,
}))

import {
  createTelegramSenseApp,
  loadTelegramSenseCredentials,
  parseTelegramSenseCredentials,
  startTelegramSenseApp,
} from "../../senses/telegram"

const credentials = { botToken: "synthetic-test-token", authorizedUserId: "42", authorizedChatId: "43" }

function defaultFixture() {
  let onMessage: ((message: any) => Promise<void>) | undefined
  let onUpdate: ((update: any) => Promise<boolean>) | undefined
  const poll = { pollOnce: vi.fn(), run: vi.fn(async () => undefined), stop: vi.fn() }
  const api = { request: vi.fn(), stop: vi.fn() }
  const transport = {
    sendApproval: vi.fn(), handleUpdate: vi.fn(async () => ({ handled: true })), reconcileExpired: vi.fn(),
    terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []),
  }
  const runtime = { transport, coordinator: vi.fn(), recover: vi.fn(), close: vi.fn() }
  mocks.createTelegramBotApi.mockReturnValue(api)
  mocks.createTelegramLongPoll.mockImplementation((options: any) => {
    onMessage = options.onMessage
    onUpdate = options.onUpdate
    return poll
  })
  mocks.createTelegramApprovalRuntime.mockReturnValue(runtime)
  mocks.sendTelegramText.mockResolvedValue([71])
  mocks.runSenseTurn.mockResolvedValue({ response: "fallback", deliveries: [], deliveryFailures: [], ponderDeferred: false })
  return { api, poll, runtime, transport, getOnMessage: () => onMessage!, getOnUpdate: () => onUpdate! }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readRuntimeCredentialConfig.mockReturnValue({ ok: true, config: {
    telegramBotToken: ` ${credentials.botToken} `,
    telegramAuthorizedUserId: " 42 ",
    telegramAuthorizedChatId: "43",
  } })
})

describe("Telegram sense coverage contracts", () => {
  it("parses trimmed credentials and rejects missing or non-canonical values without echoing secrets", () => {
    expect(parseTelegramSenseCredentials({
      telegramBotToken: ` ${credentials.botToken} `,
      telegramAuthorizedUserId: " 42 ",
      telegramAuthorizedChatId: "43",
    })).toEqual(credentials)
    for (const value of [undefined, null, "", "   "]) {
      expect(() => parseTelegramSenseCredentials({ telegramBotToken: value, telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "43" })).toThrow("bot token is missing")
    }
    for (const id of ["0", "01", "-1", "1.5", "abc"]) {
      expect(() => parseTelegramSenseCredentials({ telegramBotToken: credentials.botToken, telegramAuthorizedUserId: id, telegramAuthorizedChatId: "43" })).toThrow("canonical positive decimal")
    }
  })

  it("constructs default API, stores, turn runner, tool context, approval runtime, and poll paths", async () => {
    const f = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "sanctuary", credentials })
    expect(mocks.createTelegramBotApi).toHaveBeenCalledWith({ token: credentials.botToken })
    expect(mocks.createSanctuaryToolContext).toHaveBeenCalledWith("sanctuary")
    expect(mocks.createTelegramApprovalRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "sanctuary", api: f.api, authorizedUserId: "42", authorizedChatId: "43", toolContext: { sanctuary: true },
    }))
    expect(mocks.createTelegramLongPoll).toHaveBeenCalledWith(expect.objectContaining({
      api: f.api, expectedUserId: "42", expectedChatId: "43",
    }))
    await app.run()
    expect(f.runtime.recover).toHaveBeenCalledBefore(f.transport.reconcileExpired)
    expect(f.transport.reconcileExpired).toHaveBeenCalledBefore(f.poll.run)
    app.stop()
    expect(f.runtime.close).toHaveBeenCalledOnce()
  })

  it("supplies an empty tool context if context construction yields no value", () => {
    const f = defaultFixture()
    mocks.createSanctuaryToolContext.mockReturnValueOnce(undefined as any)
    createTelegramSenseApp({ agentName: "sanctuary", credentials })
    expect(mocks.createTelegramApprovalRuntime).toHaveBeenCalledWith(expect.objectContaining({ api: f.api, toolContext: {} }))
  })

  it("starts a non-Sanctuary Telegram agent without constructing Sanctuary runtime state", async () => {
    const f = defaultFixture()
    createTelegramSenseApp({ agentName: "slugger", credentials })

    expect(mocks.createSanctuaryToolContext).not.toHaveBeenCalled()
    expect(mocks.createTelegramApprovalRuntime).not.toHaveBeenCalled()
    await f.getOnMessage()({ updateId: 1, messageId: "2", text: "hello" })
    const turnOptions = mocks.runSenseTurn.mock.calls[0]![0]
    expect(turnOptions).not.toHaveProperty("toolContext")
    expect(turnOptions).not.toHaveProperty("approvalCoordinatorFactory")
    expect(mocks.sendTelegramText).toHaveBeenCalledExactlyOnceWith(f.api, "43", "fallback", undefined)
  })

  it("passes default tool and approval context, then sends a response only when no streamed delivery occurred", async () => {
    const f = defaultFixture()
    createTelegramSenseApp({ agentName: "sanctuary", credentials })
    await f.getOnMessage()({ updateId: 1, messageId: "2", text: "hello" })
    expect(mocks.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: { sanctuary: true }, approvalCoordinatorFactory: f.runtime.coordinator,
    }))
    expect(mocks.sendTelegramText).toHaveBeenCalledExactlyOnceWith(f.api, "43", "fallback", undefined)

    mocks.sendTelegramText.mockClear()
    mocks.runSenseTurn.mockImplementationOnce(async (options: any) => {
      await options.deliverySink.onDelivery({ text: "streamed" })
      return { response: "also returned", deliveries: [], deliveryFailures: [], ponderDeferred: false }
    })
    await f.getOnMessage()({ updateId: 2, messageId: "3", text: "again" })
    expect(mocks.sendTelegramText).toHaveBeenCalledExactlyOnceWith(f.api, "43", "streamed", undefined)

    mocks.sendTelegramText.mockClear()
    mocks.runSenseTurn.mockResolvedValueOnce({ response: "   ", deliveries: [], deliveryFailures: [], ponderDeferred: false })
    await f.getOnMessage()({ updateId: 3, messageId: "4", text: "quiet" })
    expect(mocks.sendTelegramText).not.toHaveBeenCalled()
  })

  it.each([new Error("turn failed"), "primitive failure"])("records turn failure and sends one fixed safe response", async (failure) => {
    const f = defaultFixture()
    mocks.runSenseTurn.mockRejectedValueOnce(failure)
    createTelegramSenseApp({ agentName: "butler", credentials })
    await f.getOnMessage()({ updateId: 1, messageId: "2", text: "hello" })
    expect(mocks.sendTelegramText).toHaveBeenCalledWith(f.api, "43", "I couldn't complete that turn. The failure was recorded; please try again.", undefined)
  })

  it("declines non-callback updates and callbacks when no approval transport exists", async () => {
    const f = defaultFixture()
    mocks.createTelegramApprovalRuntime.mockReturnValue(undefined)
    createTelegramSenseApp({
      agentName: "butler", credentials, api: f.api, offsetStore: { load: () => 0, save: vi.fn() },
      runTurn: mocks.runSenseTurn,
    })
    await expect(f.getOnUpdate()({ update_id: 1 })).resolves.toBe(false)
    await expect(f.getOnUpdate()({ update_id: 2, callback_query: { id: "q", from: { id: 42 } } })).resolves.toBe(false)
  })

  it("runs every health sweep result branch and receipts exact message ids", async () => {
    for (const result of [
      {},
      { message: "health" },
      { message: "health", deliveryId: "delivery-1" },
    ]) {
      const f = defaultFixture()
      const healthSweep = Object.assign(vi.fn(async () => result), { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() })
      const app = createTelegramSenseApp({ agentName: "butler", credentials, healthSweep })
      await app.run()
      if ("deliveryId" in result) {
        expect(healthSweep.markDeliveryAttempting).toHaveBeenCalledWith("delivery-1")
        expect(healthSweep.markDelivered).toHaveBeenCalledWith("delivery-1", [71])
      }
      expect(f.poll.run).toHaveBeenCalledOnce()
    }
  })

  it.each([new Error("health failed"), "primitive health failure"])("contains health sweep failures", async (failure) => {
    const f = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "butler", credentials, healthSweep: vi.fn(async () => { throw failure }) })
    await expect(app.run()).resolves.toBeUndefined()
    expect(f.poll.run).toHaveBeenCalledOnce()
  })

  it("validates proactive messages and forwards the exact caller signal", async () => {
    const f = defaultFixture()
    const app = createTelegramSenseApp({ agentName: "butler", credentials })
    const controller = new AbortController()
    await app.sendProactive("  hello  ", controller.signal)
    expect(mocks.sendTelegramText).toHaveBeenCalledWith(f.api, "43", "hello", controller.signal)
    await expect(app.sendProactive("   ")).rejects.toThrow("proactive message is missing")
  })

  it("loads credentials, explains missing runtime config, and starts the default app", async () => {
    expect(loadTelegramSenseCredentials("butler")).toEqual(credentials)
    mocks.readRuntimeCredentialConfig.mockReturnValueOnce({ ok: false, reason: "missing" })
    expect(() => loadTelegramSenseCredentials("butler")).toThrow("actor: agent-runnable")
    const f = defaultFixture()
    await expect(startTelegramSenseApp("butler")).resolves.toMatchObject({ run: expect.any(Function), stop: expect.any(Function) })
    expect(mocks.createTelegramBotApi).toHaveBeenCalledWith({ token: credentials.botToken })
    expect(f.api.stop).not.toHaveBeenCalled()
  })
})
