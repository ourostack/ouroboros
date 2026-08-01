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

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    context: { maxTokens: 80000, contextMargin: 20 },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ourostack/ouroboros.git",
  resetIdentity: vi.fn(),
}))

vi.mock("../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn(() => "dev"),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

// Friends now lives in the @ouro.bot/friends package (a single barrel module).
// Mock the package, spreading the real barrel and overriding the channel helpers.
vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    getChannelCapabilities: vi.fn(() => ({
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: false,
    })),
    isRemoteChannel: vi.fn(() => false),
    channelToFacing: vi.fn(() => "human"),
  }
})

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
  })

  async function makeRuntime() {
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({
      providers: { anthropic: { setupToken: makeAnthropicSetupToken() } },
    })
    const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
    return createAnthropicProviderRuntime("claude-opus-4-6")
  }

  function makeCallbacks(mode: "retractable_buffer" | "final_only") {
    let visible = ""
    const onTextChunk = vi.fn((text: string) => { visible += text })
    const onClearText = vi.fn(() => { visible = "" })
    return {
      callbacks: {
        onModelStart: vi.fn(),
        onModelStreamStart: vi.fn(),
        onTextChunk,
        onReasoningChunk: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        onClearText,
        settleOutputMode: mode,
      },
      onTextChunk,
      onClearText,
      visible: () => visible,
    }
  }

  function anthropicSettleStream(argumentsParts: string[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "settle", input: {} } }
        for (const partial_json of argumentsParts) {
          yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } }
        }
        yield { type: "content_block_stop", index: 0 }
      },
    }
  }

  it("finalizes valid Anthropic settle arguments once before final-only emission", async () => {
    const runtime = await makeRuntime()
    const { SettleParser } = await import("../../heart/streaming")
    const finish = vi.spyOn(SettleParser.prototype, "finish")
    const harness = makeCallbacks("final_only")
    mockAnthropicMessagesCreate.mockImplementationOnce(() => anthropicSettleStream([
      '{"answer":"hel',
      'lo"}',
    ]))

    try {
      const result = await runtime.streamTurn({
        messages: [{ role: "user", content: "hi" }],
        activeTools: [],
        callbacks: harness.callbacks as any,
      })

      expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
      expect(finish).toHaveBeenCalledTimes(1)
      expect(harness.onTextChunk).toHaveBeenCalledOnce()
      expect(harness.onTextChunk).toHaveBeenCalledWith("hello")
      expect(result.settleFinalization).toEqual({ ok: true, answer: "hello" })
      expect(result.settleStreamed).toBe(true)
    } finally {
      finish.mockRestore()
    }
  })

  it.each([
    { label: "incomplete", args: '{"answer":"partial', errorCode: "incomplete_settle_arguments" },
    { label: "invalid", args: String.raw`{"answer":"partial\x"}`, errorCode: "invalid_settle_arguments" },
  ])("returns exact $label Anthropic finalization without retrying", async ({ args, errorCode }) => {
    const runtime = await makeRuntime()
    const harness = makeCallbacks("retractable_buffer")
    mockAnthropicMessagesCreate.mockImplementationOnce(() => anthropicSettleStream([args]))

    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: harness.callbacks as any,
    })

    expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
    expect(result.settleFinalization).toEqual({ ok: false, errorCode })
    expect(harness.visible()).toBe("")
    expect(harness.onClearText).toHaveBeenCalledTimes(2)
  })

  it("drops ordinary provider text before an invalid final-only Anthropic settle", async () => {
    const runtime = await makeRuntime()
    const harness = makeCallbacks("final_only")
    const invalidArgs = String.raw`{"answer":"partial\x"}`
    mockAnthropicMessagesCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "must stay private" } }
        yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "settle", input: {} } }
        yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: invalidArgs } }
        yield { type: "content_block_stop", index: 1 }
      },
    }))

    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: harness.callbacks as any,
    })

    expect(result.settleFinalization).toEqual({
      ok: false,
      errorCode: "invalid_settle_arguments",
    })
    expect(harness.onTextChunk).not.toHaveBeenCalled()
    expect(harness.visible()).toBe("")
  })

  it("releases ordinary final-only Anthropic text when no settle is present", async () => {
    const runtime = await makeRuntime()
    const harness = makeCallbacks("final_only")
    mockAnthropicMessagesCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ordinary " } }
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } }
      },
    }))

    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: harness.callbacks as any,
    })

    expect(result.settleFinalization).toBeUndefined()
    expect(harness.onTextChunk).toHaveBeenCalledOnce()
    expect(harness.onTextChunk).toHaveBeenCalledWith("ordinary answer")
    expect(harness.visible()).toBe("ordinary answer")
  })

  it("cancels a partial final-only Anthropic settle without finalizing or emitting", async () => {
    const runtime = await makeRuntime()
    const harness = makeCallbacks("final_only")
    const controller = new AbortController()
    mockAnthropicMessagesCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "settle", input: {} } }
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"answer":"partial' } }
        controller.abort()
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"}' } }
      },
    }))

    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: harness.callbacks as any,
      signal: controller.signal,
    })

    expect(mockAnthropicMessagesCreate).toHaveBeenCalledTimes(1)
    expect(harness.onTextChunk).not.toHaveBeenCalled()
    expect(result.settleFinalization).toBeUndefined()
    expect(result.settleStreamed).toBe(false)
  })

  it("retracts a partial Anthropic settle when stream iteration fails", async () => {
    const runtime = await makeRuntime()
    const harness = makeCallbacks("retractable_buffer")
    const failure = new Error("anthropic stream failed")
    mockAnthropicMessagesCreate.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "settle", input: {} } }
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"answer":"partial' } }
        throw failure
      },
    }))

    await expect(runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: harness.callbacks as any,
    })).rejects.toBe(failure)

    expect(harness.visible()).toBe("")
    expect(harness.onClearText).toHaveBeenCalledTimes(2)
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
