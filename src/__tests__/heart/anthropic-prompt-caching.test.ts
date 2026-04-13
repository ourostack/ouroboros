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
    provider: "anthropic",
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
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

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import * as identity from "../../heart/identity"

function makeAnthropicSetupToken(): string {
  return `sk-ant-oat01-${"a".repeat(80)}`
}

const minimalCallbacks = {
  onModelStart: () => {},
  onModelStreamStart: () => {},
  onTextChunk: () => {},
  onReasoningChunk: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onError: () => {},
}

describe("Anthropic prompt caching", () => {
  beforeEach(() => {
    vi.resetModules()
    capturedAnthropicParams = null
    mockAnthropicMessagesCreate.mockClear()
  })

  it("emits cache_control on stable prefix when systemPrompt is present", async () => {
    emitTestEvent("anthropic cache_control stable prefix")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
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
      messages: [
        { role: "system", content: "stable prefix\n\nvolatile suffix" },
        { role: "user", content: "hi" },
      ],
      activeTools: [],
      callbacks: minimalCallbacks,
      systemPrompt: { stable: "stable prefix", volatile: "volatile suffix" },
    })

    expect(capturedAnthropicParams).toBeDefined()
    const systemBlocks = capturedAnthropicParams.system
    expect(systemBlocks).toHaveLength(2)

    // First block: claudeCodePreamble + stable prefix with cache_control
    expect(systemBlocks[0].type).toBe("text")
    expect(systemBlocks[0].text).toContain("You are Claude Code")
    expect(systemBlocks[0].text).toContain("stable prefix")
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" })

    // Second block: volatile suffix without cache_control
    expect(systemBlocks[1].type).toBe("text")
    expect(systemBlocks[1].text).toBe("volatile suffix")
    expect(systemBlocks[1].cache_control).toBeUndefined()
  })

  it("falls back to existing behavior when systemPrompt is absent", async () => {
    emitTestEvent("anthropic fallback no systemPrompt")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
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
      messages: [
        { role: "system", content: "plain system prompt" },
        { role: "user", content: "hi" },
      ],
      activeTools: [],
      callbacks: minimalCallbacks,
      // No systemPrompt field
    })

    expect(capturedAnthropicParams).toBeDefined()
    const systemBlocks = capturedAnthropicParams.system
    // Should be [claudeCodePreamble, { type: "text", text: "plain system prompt" }]
    expect(systemBlocks).toHaveLength(2)
    expect(systemBlocks[0].text).toContain("You are Claude Code")
    expect(systemBlocks[0].cache_control).toBeUndefined()
    expect(systemBlocks[1].text).toBe("plain system prompt")
    expect(systemBlocks[1].cache_control).toBeUndefined()
  })

  it("omits volatile block when volatile is empty", async () => {
    emitTestEvent("anthropic cache_control empty volatile")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
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
      messages: [
        { role: "system", content: "stable only" },
        { role: "user", content: "hi" },
      ],
      activeTools: [],
      callbacks: minimalCallbacks,
      systemPrompt: { stable: "stable only", volatile: "" },
    })

    expect(capturedAnthropicParams).toBeDefined()
    const systemBlocks = capturedAnthropicParams.system
    // Should only have the cached stable block (no empty volatile block)
    expect(systemBlocks).toHaveLength(1)
    expect(systemBlocks[0].text).toContain("You are Claude Code")
    expect(systemBlocks[0].text).toContain("stable only")
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" })
  })

  it("prepends claudeCodePreamble to stable prefix text (one cached block)", async () => {
    emitTestEvent("anthropic preamble in stable block")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
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
      messages: [
        { role: "system", content: "my stable\n\nmy volatile" },
        { role: "user", content: "hi" },
      ],
      activeTools: [],
      callbacks: minimalCallbacks,
      systemPrompt: { stable: "my stable", volatile: "my volatile" },
    })

    expect(capturedAnthropicParams).toBeDefined()
    const systemBlocks = capturedAnthropicParams.system
    // The first block should contain BOTH the preamble and the stable prefix
    // (merged into one block, not separate blocks)
    expect(systemBlocks[0].text).toMatch(/^You are Claude Code.*\n\nmy stable$/)
  })
})
