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
    provider: "anthropic",
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

let capturedAnthropicParams: any = null
const mockAnthropicMessagesCreate = vi.fn().mockImplementation((params: any) => {
  capturedAnthropicParams = params
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }
      yield { type: "content_block_stop", index: 0 }
      yield { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } }
    },
  }
})

vi.mock("openai", () => {
  class MockOpenAI { chat = { completions: { create: vi.fn() } }; responses = { create: vi.fn() }; constructor() {} }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockAnthropicMessagesCreate }
    constructor() {}
  }
  return { default: MockAnthropic }
})

import * as identity from "../../heart/identity"

function makeAnthropicSetupToken(): string {
  return `sk-ant-oat01-${"a".repeat(80)}`
}

describe("Anthropic thinking request params", () => {
  beforeEach(() => {
    vi.resetModules()
    capturedAnthropicParams = null
    mockAnthropicMessagesCreate.mockClear()
  })

  it("sends thinking parameter with adaptive type and effort in request", async () => {
    emitTestEvent("anthropic thinking param sent")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "anthropic",
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: { anthropic: { setupToken: makeAnthropicSetupToken() } },
    })

    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6")
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

    expect(capturedAnthropicParams).toBeDefined()
    expect(capturedAnthropicParams.thinking).toEqual({ type: "adaptive" })
    expect(capturedAnthropicParams.output_config).toEqual({ effort: "high" })
  })

  it("defaults thinking effort to medium when reasoningEffort is undefined", async () => {
    emitTestEvent("anthropic thinking defaults medium")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "anthropic",
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: { anthropic: { setupToken: makeAnthropicSetupToken() } },
    })

    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6")
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

    expect(capturedAnthropicParams.thinking).toEqual({ type: "adaptive" })
    expect(capturedAnthropicParams.output_config).toEqual({ effort: "medium" })
  })

  it("sets max_tokens from registry maxOutputTokens for opus-4-6", async () => {
    emitTestEvent("anthropic max_tokens from registry opus")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "anthropic",
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: { anthropic: { setupToken: makeAnthropicSetupToken() } },
    })

    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6")
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

    expect(capturedAnthropicParams.max_tokens).toBe(128000)
  })

  it("sets max_tokens from registry maxOutputTokens for sonnet-4-6", async () => {
    emitTestEvent("anthropic max_tokens from registry sonnet")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "anthropic",
      humanFacing: { provider: "anthropic", model: "claude-sonnet-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-sonnet-4-6" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: { anthropic: { setupToken: makeAnthropicSetupToken() } },
    })

    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-sonnet-4-6")
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

    expect(capturedAnthropicParams.max_tokens).toBe(64000)
  })

  it("falls back to sensible default max_tokens when registry has no maxOutputTokens", async () => {
    emitTestEvent("anthropic max_tokens fallback")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "anthropic",
      humanFacing: { provider: "anthropic", model: "unknown-model" },
      agentFacing: { provider: "anthropic", model: "unknown-model" },
    })
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: { anthropic: { setupToken: makeAnthropicSetupToken() } },
    })

    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("unknown-model")
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

    // Should fall back to a sensible default (not 4096)
    expect(capturedAnthropicParams.max_tokens).toBeGreaterThan(4096)
  })
})
