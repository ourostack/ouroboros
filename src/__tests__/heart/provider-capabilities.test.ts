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

// Default readFileSync: return psyche file stubs
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

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockAnthropicMessagesCreate = vi.fn()
const mockAnthropicCtor = vi.fn()
const mockOpenAICtor = vi.fn()

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(opts?: any) { mockOpenAICtor(opts) }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockAnthropicMessagesCreate }
    constructor(opts?: any) { mockAnthropicCtor(opts) }
  }
  return { default: MockAnthropic }
})

import * as identity from "../../heart/identity"

function makeAnthropicSetupToken(): string {
  return `sk-ant-oat01-${"a".repeat(80)}`
}

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
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  )
  return `${header}.${payload}.signature`
}

async function setAgentProvider(provider: "azure" | "minimax" | "anthropic" | "openai-codex") {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider,
  })
}

describe("provider factory capability declarations", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe("Anthropic provider", () => {
    it("returns reasoning-effort capability and correct efforts for claude-opus-4-6", async () => {
      emitTestEvent("anthropic opus-4-6 capabilities")
      await setAgentProvider("anthropic")
      const config = await import("../../heart/config")
      config.resetConfigCache()
      config.patchRuntimeConfig({
        providers: {
          anthropic: { model: "claude-opus-4-6", setupToken: makeAnthropicSetupToken() },
        },
      })
      const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
      const runtime = createAnthropicProviderRuntime()
      expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
      expect(runtime.supportedReasoningEfforts).toEqual(["low", "medium", "high", "max"])
    })

    it("returns reasoning-effort capability and correct efforts for claude-sonnet-4-6", async () => {
      emitTestEvent("anthropic sonnet-4-6 capabilities")
      await setAgentProvider("anthropic")
      const config = await import("../../heart/config")
      config.resetConfigCache()
      config.patchRuntimeConfig({
        providers: {
          anthropic: { model: "claude-sonnet-4-6", setupToken: makeAnthropicSetupToken() },
        },
      })
      const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
      const runtime = createAnthropicProviderRuntime()
      expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
      expect(runtime.supportedReasoningEfforts).toEqual(["low", "medium", "high"])
    })
  })

  describe("Azure provider", () => {
    it("returns reasoning-effort capability for gpt-5.4", async () => {
      emitTestEvent("azure gpt-5.4 capabilities")
      await setAgentProvider("azure")
      const config = await import("../../heart/config")
      config.resetConfigCache()
      config.patchRuntimeConfig({
        providers: {
          azure: {
            apiKey: "azure-test-key",
            endpoint: "https://test.openai.azure.com",
            deployment: "test-deployment",
            modelName: "gpt-5.4",
          },
        },
      })
      const { createAzureProviderRuntime } = await import("../../heart/providers/azure")
      const runtime = createAzureProviderRuntime()
      expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
      expect(runtime.supportedReasoningEfforts).toEqual(["low", "medium", "high"])
    })
  })

  describe("OpenAI Codex provider", () => {
    it("returns reasoning-effort and phase-annotation capabilities for gpt-5.4", async () => {
      emitTestEvent("codex gpt-5.4 capabilities")
      await setAgentProvider("openai-codex")
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
      expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
      expect(runtime.capabilities.has("phase-annotation")).toBe(true)
      expect(runtime.supportedReasoningEfforts).toEqual(["low", "medium", "high"])
    })
  })

  describe("MiniMax provider", () => {
    it("returns empty capabilities and no supportedReasoningEfforts", async () => {
      emitTestEvent("minimax capabilities")
      await setAgentProvider("minimax")
      const config = await import("../../heart/config")
      config.resetConfigCache()
      config.patchRuntimeConfig({
        providers: {
          minimax: { apiKey: "test-key", model: "test-model" },
        },
      })
      const { createMinimaxProviderRuntime } = await import("../../heart/providers/minimax")
      const runtime = createMinimaxProviderRuntime()
      expect(runtime.capabilities.size).toBe(0)
      expect(runtime.supportedReasoningEfforts).toBeUndefined()
    })
  })
})
