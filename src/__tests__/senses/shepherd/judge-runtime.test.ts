import { beforeEach, describe, expect, it, vi } from "vitest"
import { getShepherdJudgeRuntime } from "../../../senses/shepherd/judge-runtime"

const mocks = vi.hoisted(() => ({
  config: vi.fn(), credentials: vi.fn(), resolve: vi.fn(), ordinary: vi.fn(), event: vi.fn(),
}))
vi.mock("../../../heart/identity", () => ({ loadAgentConfig: mocks.config }))
vi.mock("../../../heart/provider-credentials", () => ({ readProviderCredentialRecord: mocks.credentials }))
vi.mock("../../../heart/core", () => ({
  createProviderRegistry: () => ({ resolve: mocks.resolve }), getProviderRuntime: mocks.ordinary,
}))
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: mocks.event }))

const owner = { agentName: "synthetic", agentRoot: "/synthetic/agent.ouro" }
const binding = { provider: "github-copilot", model: "claude-opus-5.5" }
const record = { provider: "github-copilot", credentials: { token: "synthetic-only" }, config: {}, revision: "fixture" }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.config.mockReturnValue({ agentFacing: { ...binding } })
  mocks.credentials.mockResolvedValue({ ok: true, record })
  mocks.resolve.mockImplementation((id: string, model: string) => ({ id, model }))
  mocks.ordinary.mockImplementation(async () => ({ id: "github-copilot", model: "claude-opus-5.5" }))
})

describe("dedicated Shepherd judge runtime", () => {
  it("selects the measured Shepherd model without changing the ordinary agent-facing binding", async () => {
    expect(await getShepherdJudgeRuntime(owner)).toMatchObject({ id: "github-copilot", model: "claude-haiku-5.5" })
    expect(mocks.config).toHaveBeenCalledWith(owner)
    expect(mocks.credentials).toHaveBeenCalledWith("synthetic", "github-copilot")
    expect(mocks.resolve).toHaveBeenCalledWith("github-copilot", "claude-haiku-5.5", record)
    expect(mocks.ordinary).not.toHaveBeenCalled()
    expect(binding).toEqual({ provider: "github-copilot", model: "claude-opus-5.5" })
  })

  it("constructs fresh judge state and re-reads the current owner credential revision each time", async () => {
    const first = await getShepherdJudgeRuntime(owner)
    const nextRecord = { ...record, revision: "updated-fixture" }
    mocks.credentials.mockResolvedValue({ ok: true, record: nextRecord })
    const second = await getShepherdJudgeRuntime(owner)
    expect(first).not.toBe(second)
    expect(second.model).toBe("claude-haiku-5.5")
    expect(mocks.resolve).toHaveBeenLastCalledWith("github-copilot", "claude-haiku-5.5", nextRecord)
  })

  it("uses the normal owner-scoped runtime for another provider and reacts to a binding change", async () => {
    expect((await getShepherdJudgeRuntime(owner)).model).toBe("claude-haiku-5.5")
    mocks.config.mockReturnValue({ agentFacing: { provider: "openai-codex", model: "gpt-5.4" } })
    mocks.ordinary.mockResolvedValue({ id: "openai-codex", model: "gpt-5.4" })
    expect(await getShepherdJudgeRuntime(owner)).toMatchObject({ id: "openai-codex", model: "gpt-5.4" })
    expect(mocks.ordinary).toHaveBeenCalledWith("agent", owner)
    expect(mocks.credentials).toHaveBeenCalledTimes(1)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
  })

  it("reports missing credentials with owner, model and normal remediation, without falling back", async () => {
    mocks.credentials.mockResolvedValue({ ok: false, error: "Synthetic credential unavailable" })
    await expect(getShepherdJudgeRuntime(owner)).rejects.toThrow(/github-copilot.*claude-haiku-5.5.*synthetic/s)
    await expect(getShepherdJudgeRuntime(owner)).rejects.toThrow("ouro auth --agent synthetic --provider github-copilot")
    expect(mocks.ordinary).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "engine.provider_init_error" }))
  })

  it.each(["throw", "null", "non-error"] as const)("fails explicitly on %s factory failure instead of substituting a model", async failure => {
    if (failure === "throw") mocks.resolve.mockImplementation(() => { throw new Error("Synthetic factory failure") })
    else if (failure === "non-error") mocks.resolve.mockImplementation(() => { throw "Synthetic non-error failure" })
    else mocks.resolve.mockReturnValue(null)
    await expect(getShepherdJudgeRuntime(owner)).rejects.toThrow(/failure|initialized/)
    expect(mocks.ordinary).not.toHaveBeenCalled()
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "engine.provider_init_error" }))
  })
})
