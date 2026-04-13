import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Integration test: exercises the full path from buildSystem() -> SystemPrompt ->
 * ProviderTurnRequest -> streamAnthropicMessages params construction.
 */

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
  if (p.endsWith("SOUL.md")) return "i am a test soul"
  if (p.endsWith("IDENTITY.md")) return "i am test identity"
  if (p.endsWith("LORE.md")) return "test lore"
  if (p.endsWith("TACIT.md")) return "test tacit knowledge"
  if (p.endsWith("ASPIRATIONS.md")) return "test aspirations"
  if (p.endsWith("FRIENDS.md")) return "test friends"
  if (p.endsWith("secrets.json")) return JSON.stringify({})
  if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.20" })
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(defaultReadFileSync),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
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

const mockGetBoard = vi.fn()
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: mockGetBoard,
  }),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    context: { maxTokens: 80000, contextMargin: 20 },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
  resetIdentity: vi.fn(),
}))

vi.mock("../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn(() => "dev"),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../mind/friends/channel", () => ({
  getChannelCapabilities: vi.fn(() => ({
    channel: "cli",
    availableIntegrations: [],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: false,
  })),
  isRemoteChannel: vi.fn(() => false),
  channelToFacing: vi.fn(() => "human"),
}))

vi.mock("../../mind/first-impressions", () => ({
  getFirstImpressions: vi.fn(() => null),
}))

vi.mock("../../heart/core", () => ({
  getProviderDisplayLabel: vi.fn(() => "mock-provider"),
}))

vi.mock("openai", () => {
  class MockOpenAI { chat = { completions: { create: vi.fn() } }; responses = { create: vi.fn() }; constructor() {} }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

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

describe("Anthropic prompt caching integration", () => {
  beforeEach(() => {
    vi.resetModules()
    capturedAnthropicParams = null
    mockAnthropicMessagesCreate.mockClear()
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [], collaborating: [],
        paused: [], blocked: [], done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("buildSystem stable prefix does NOT contain date/time or rhythm status", async () => {
    emitTestEvent("integration: stable has no date")
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const sp = await buildSystem("cli")

    expect(sp.stable).not.toContain("current date and time:")
    expect(sp.stable).not.toContain("my rhythms:")
  })

  it("buildSystem volatile suffix DOES contain date/time", async () => {
    emitTestEvent("integration: volatile has date")
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const sp = await buildSystem("cli")

    expect(sp.volatile).toContain("current date and time:")
  })

  it("cache_control annotation is on the first (stable) block only when sent to Anthropic", async () => {
    emitTestEvent("integration: cache_control first block only")
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
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    // Build the real system prompt
    const sp = await buildSystem("cli")

    // Pass to Anthropic provider
    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    const runtime = createAnthropicProviderRuntime("claude-opus-4-6")
    await runtime.streamTurn({
      messages: [
        { role: "system", content: flattenSystemPrompt(sp) },
        { role: "user", content: "hi" },
      ],
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
      systemPrompt: sp,
    })

    expect(capturedAnthropicParams).toBeDefined()
    const systemBlocks = capturedAnthropicParams.system

    // First block has cache_control
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" })

    // First block contains stable content but NOT date
    expect(systemBlocks[0].text).toContain("test identity")
    expect(systemBlocks[0].text).not.toContain("current date and time:")

    // Second block (volatile) has date but no cache_control
    expect(systemBlocks.length).toBeGreaterThanOrEqual(2)
    expect(systemBlocks[1].text).toContain("current date and time:")
    expect(systemBlocks[1].cache_control).toBeUndefined()
  })

  it("non-Anthropic provider receives a flat string with all content", async () => {
    emitTestEvent("integration: flat string for non-anthropic")
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const sp = await buildSystem("cli")
    const flat = flattenSystemPrompt(sp)

    // Flat string contains both stable and volatile content
    expect(flat).toContain("test identity")
    expect(flat).toContain("current date and time:")
    expect(flat).toContain("# who i am")
    expect(flat).toContain("# dynamic state for this turn")
  })
})
