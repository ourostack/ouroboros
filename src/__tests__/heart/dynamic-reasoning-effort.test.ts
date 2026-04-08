import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "other" })
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(defaultReadFileSync),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("child_process", () => ({ execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({ listSkills: vi.fn(), loadSkill: vi.fn() }))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "azure",
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

let capturedResponsesParams: any = null
const mockResponsesCreate = vi.fn().mockImplementation((params: any) => {
  capturedResponsesParams = params
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: "response.output_text.delta", delta: "hi" }
      yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    },
  }
})

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: mockResponsesCreate }
    constructor() {}
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic { messages = { create: vi.fn() }; constructor() {} }
  return { default: MockAnthropic }
})

import * as identity from "../../heart/identity"

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function makeOpenAICodexAccessToken(accountId = "chatgpt-account-test"): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))
  const payload = encodeBase64Url(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  )
  return `${header}.${payload}.signature`
}

describe("Azure dynamic reasoning effort", () => {
  beforeEach(() => {
    vi.resetModules()
    capturedResponsesParams = null
    mockResponsesCreate.mockClear()
  })

  it("uses reasoningEffort from ProviderTurnRequest instead of hardcoded medium", async () => {
    emitTestEvent("azure dynamic reasoning effort")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "azure",
      humanFacing: { provider: "azure", model: "gpt-4o" },
      agentFacing: { provider: "azure", model: "gpt-4o" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "key",
          endpoint: "https://test.openai.azure.com",
          deployment: "dep",
          modelName: "gpt-5.4",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../heart/providers/azure")
    const runtime = createAzureProviderRuntime()
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      },
      reasoningEffort: "high",
    })

    expect(capturedResponsesParams).toBeDefined()
    expect(capturedResponsesParams.reasoning).toEqual({ effort: "high", summary: "detailed" })
  }, 20000)

  it("defaults to medium when reasoningEffort is undefined", async () => {
    emitTestEvent("azure defaults to medium")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "azure",
      humanFacing: { provider: "azure", model: "gpt-4o" },
      agentFacing: { provider: "azure", model: "gpt-4o" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "key",
          endpoint: "https://test.openai.azure.com",
          deployment: "dep",
          modelName: "gpt-5.4",
        },
      },
    })

    const { createAzureProviderRuntime } = await import("../../heart/providers/azure")
    const runtime = createAzureProviderRuntime()
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      },
    })

    expect(capturedResponsesParams.reasoning).toEqual({ effort: "medium", summary: "detailed" })
  }, 20000)
})

describe("Codex dynamic reasoning effort", () => {
  beforeEach(() => {
    vi.resetModules()
    capturedResponsesParams = null
    mockResponsesCreate.mockClear()
  })

  it("uses reasoningEffort from ProviderTurnRequest instead of hardcoded medium", async () => {
    emitTestEvent("codex dynamic reasoning effort")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "openai-codex",
      humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
      agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.4",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    })

    const { createOpenAICodexProviderRuntime } = await import("../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime()
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      },
      reasoningEffort: "low",
    })

    expect(capturedResponsesParams).toBeDefined()
    expect(capturedResponsesParams.reasoning).toEqual({ effort: "low", summary: "detailed" })
  }, 20000)

  it("defaults to medium when reasoningEffort is undefined", async () => {
    emitTestEvent("codex defaults to medium")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "openai-codex",
      humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
      agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.4",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    })

    const { createOpenAICodexProviderRuntime } = await import("../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime()
    await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      },
    })

    expect(capturedResponsesParams.reasoning).toEqual({ effort: "medium", summary: "detailed" })
  }, 20000)
})
