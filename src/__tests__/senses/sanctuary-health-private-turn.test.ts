import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getAgentRoot: vi.fn(),
  setAgentName: vi.fn(),
  runAgent: vi.fn(),
  reserveAutonomyBudget: vi.fn(),
  resolveAutonomyBudgetPolicy: vi.fn(),
  resolveToolDefinition: vi.fn(),
  createTelegramBotApi: vi.fn(),
  sendTelegramText: vi.fn(),
  createSanctuaryHealthSweep: vi.fn(),
  createSanctuaryToolContext: vi.fn(),
  loadTelegramSenseCredentials: vi.fn(),
  loadOrCreateMachineIdentity: vi.fn(),
  readMachineRuntimeCredentialConfig: vi.fn(),
  refreshMachineRuntimeCredentialConfig: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({ getAgentRoot: mocks.getAgentRoot, setAgentName: mocks.setAgentName }))
vi.mock("../../heart/core", () => ({ runAgent: mocks.runAgent }))
vi.mock("../../heart/autonomy-budget", () => ({
  reserveAutonomyBudget: mocks.reserveAutonomyBudget,
  resolveAutonomyBudgetPolicy: mocks.resolveAutonomyBudgetPolicy,
}))
vi.mock("../../repertoire/tools", () => ({ resolveToolDefinition: mocks.resolveToolDefinition }))
vi.mock("../../senses/telegram-client", () => ({
  createTelegramBotApi: mocks.createTelegramBotApi,
  sendTelegramText: mocks.sendTelegramText,
}))
vi.mock("../../senses/sanctuary-health", () => ({ createSanctuaryHealthSweep: mocks.createSanctuaryHealthSweep }))
vi.mock("../../senses/sanctuary-runtime", () => ({ createSanctuaryToolContext: mocks.createSanctuaryToolContext }))
vi.mock("../../senses/telegram", () => ({ loadTelegramSenseCredentials: mocks.loadTelegramSenseCredentials }))
vi.mock("../../heart/machine-identity", () => ({ loadOrCreateMachineIdentity: mocks.loadOrCreateMachineIdentity }))
vi.mock("../../heart/runtime-credentials", () => ({
  readMachineRuntimeCredentialConfig: mocks.readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig: mocks.refreshMachineRuntimeCredentialConfig,
}))

import { runSanctuaryHealthHabit, runSanctuaryHealthPrivateTurn } from "../../senses/sanctuary-health-runner"

function completed(): { outcome: "completed" } { return { outcome: "completed" } }

describe("Sanctuary health private turn", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAgentRoot.mockReturnValue("/agents/sanctuary")
    mocks.resolveAutonomyBudgetPolicy.mockReturnValue({})
    mocks.reserveAutonomyBudget.mockReturnValue({ allowed: true, status: "reserved" })
    mocks.resolveToolDefinition.mockReturnValue({ tool: { name: "send_message" } })
    mocks.runAgent.mockResolvedValue(completed())
    mocks.loadOrCreateMachineIdentity.mockReturnValue({ machineId: "sanctuary" })
    mocks.readMachineRuntimeCredentialConfig.mockReturnValue({ ok: false, error: "missing" })
    mocks.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: true, credentials: {} })
  })

  it("runs the bounded profile and delivers exactly once", async () => {
    const deliver = vi.fn(async () => undefined)
    mocks.runAgent.mockImplementation(async (_messages, callbacks, _lane, _signal, options) => {
      callbacks.onModelStart()
      callbacks.onModelStreamStart()
      callbacks.onTextChunk("text")
      callbacks.onReasoningChunk("reason")
      callbacks.onToolStart("send_message", {})
      callbacks.onToolEnd("send_message", "ok")
      callbacks.onError(new Error("observed"))
      callbacks.onClearText()
      expect(await options.toolContext.signin()).toBeUndefined()
      expect(await options.execTool("send_message", { friendId: "operator", channel: "telegram", content: " alert " })).toBe("delivered")
      await expect(options.execTool("send_message", { friendId: "operator", channel: "telegram", content: "again" })).rejects.toThrow("already attempted")
      return completed()
    })

    await expect(runSanctuaryHealthPrivateTurn({ agentName: "sanctuary", eventId: "evt-1", payload: "degraded", deliver })).resolves.toEqual({ delivered: true })
    expect(mocks.setAgentName).toHaveBeenCalledWith("sanctuary")
    expect(deliver).toHaveBeenCalledWith(" alert ")
  })

  it("fails closed when the canonical tool or autonomy reservation is unavailable", async () => {
    mocks.resolveToolDefinition.mockReturnValueOnce(undefined)
    await expect(runSanctuaryHealthPrivateTurn({ agentName: "sanctuary", eventId: "evt", payload: "x", deliver: vi.fn() })).rejects.toThrow("canonical send_message")

    mocks.reserveAutonomyBudget.mockReturnValueOnce({ allowed: false, status: "blocked", reason: "daily cap" })
    await expect(runSanctuaryHealthPrivateTurn({ agentName: "sanctuary", eventId: "evt", payload: "x", deliver: vi.fn() })).rejects.toThrow("daily cap")
  })

  it("permits duplicate reservations but rejects every unapproved tool invocation", async () => {
    mocks.reserveAutonomyBudget.mockReturnValue({ allowed: false, status: "duplicate" })
    for (const [name, args, message] of [
      ["other", {}, "cannot execute"],
      ["send_message", { friendId: "other", channel: "telegram", content: "x" }, "target or content"],
      ["send_message", { friendId: "operator", channel: "other", content: "x" }, "target or content"],
      ["send_message", { friendId: "operator", channel: "telegram", content: " " }, "target or content"],
    ] as const) {
      mocks.runAgent.mockImplementationOnce(async (_messages, _callbacks, _lane, _signal, options) => {
        await expect(options.execTool(name, args)).rejects.toThrow(message)
        return completed()
      })
      await expect(runSanctuaryHealthPrivateTurn({ agentName: "sanctuary", eventId: "evt", payload: "x", deliver: vi.fn() })).resolves.toEqual({ delivered: false })
    }
  })

  it("propagates provider errors with and without an attached error", async () => {
    mocks.runAgent.mockResolvedValueOnce({ outcome: "errored", error: new Error("provider failed") })
    await expect(runSanctuaryHealthPrivateTurn({ agentName: "sanctuary", eventId: "evt", payload: "x", deliver: vi.fn() })).rejects.toThrow("provider failed")
    mocks.runAgent.mockResolvedValueOnce({ outcome: "errored" })
    await expect(runSanctuaryHealthPrivateTurn({ agentName: "sanctuary", eventId: "evt", payload: "x", deliver: vi.fn() })).rejects.toThrow("private turn failed")
  })

  it("uses the production dependency adapters for a payable health event", async () => {
    const sweep = vi.fn(async () => ({ message: "degraded", incidents: [], deliveryId: "delivery-default" }))
    mocks.createSanctuaryHealthSweep.mockReturnValue(sweep)
    mocks.createSanctuaryToolContext.mockReturnValue({ sanctuary: {} })
    mocks.loadTelegramSenseCredentials.mockReturnValue({ botToken: "secret", authorizedChatId: "42" })
    const api = { stop: vi.fn() }
    mocks.createTelegramBotApi.mockReturnValue(api)
    mocks.sendTelegramText.mockResolvedValue([81])
    mocks.runAgent.mockImplementation(async (_messages, _callbacks, _lane, _signal, options) => {
      await options.execTool("send_message", { friendId: "operator", channel: "telegram", content: "summary" })
      return completed()
    })

    await expect(runSanctuaryHealthHabit("sanctuary")).resolves.toMatchObject({ ok: true, data: { delivered: true } })
    expect(mocks.refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("sanctuary", "sanctuary", { preserveCachedOnFailure: true })
    expect(mocks.refreshMachineRuntimeCredentialConfig).toHaveBeenCalledBefore(mocks.createSanctuaryToolContext)
    expect(mocks.createTelegramBotApi).toHaveBeenCalledWith({ token: "secret" })
    expect(mocks.sendTelegramText).toHaveBeenCalledWith(api, "42", "summary")
    expect(api.stop).toHaveBeenCalledOnce()
  })
})
