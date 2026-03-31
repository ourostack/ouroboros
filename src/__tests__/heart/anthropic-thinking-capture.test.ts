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

vi.mock("child_process", () => ({ execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({ listSkills: vi.fn(), loadSkill: vi.fn() }))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

let streamEvents: any[] = []
const mockAnthropicMessagesCreate = vi.fn().mockImplementation(() => {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of streamEvents) yield event
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

async function createRuntime() {
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
    providers: { anthropic: { model: "claude-opus-4-6", setupToken: makeAnthropicSetupToken() } },
  })
  const { createAnthropicProviderRuntime } = await import("../../heart/providers/anthropic")
  return createAnthropicProviderRuntime()
}

const noopCallbacks = {
  onModelStart: () => {},
  onModelStreamStart: () => {},
  onTextChunk: () => {},
  onReasoningChunk: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onError: () => {},
}

describe("Anthropic thinking block capture during streaming", () => {
  beforeEach(() => {
    vi.resetModules()
    streamEvents = []
    mockAnthropicMessagesCreate.mockClear()
  })

  it("captures thinking blocks from content_block_start + thinking_delta + signature_delta", async () => {
    emitTestEvent("captures thinking blocks")
    streamEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think..." } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " more thoughts" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "456" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const runtime = await createRuntime()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: noopCallbacks,
    })

    expect(result.outputItems).toHaveLength(1)
    const thinkingBlock = result.outputItems[0] as any
    expect(thinkingBlock.type).toBe("thinking")
    expect(thinkingBlock.thinking).toBe("let me think... more thoughts")
    expect(thinkingBlock.signature).toBe("sig123456")
  })

  it("captures redacted_thinking blocks with data field", async () => {
    emitTestEvent("captures redacted_thinking blocks")
    streamEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "encrypted_data_here" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "response" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const runtime = await createRuntime()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: noopCallbacks,
    })

    expect(result.outputItems).toHaveLength(1)
    const block = result.outputItems[0] as any
    expect(block.type).toBe("redacted_thinking")
    expect(block.data).toBe("encrypted_data_here")
  })

  it("preserves block ordering with text and tool_use blocks", async () => {
    emitTestEvent("preserves block ordering")
    streamEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking first" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "redacted" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const runtime = await createRuntime()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: noopCallbacks,
    })

    expect(result.outputItems).toHaveLength(2)
    expect((result.outputItems[0] as any).type).toBe("thinking")
    expect((result.outputItems[1] as any).type).toBe("redacted_thinking")
    expect(result.content).toBe("hello")
  })

  it("coexists with tool_use blocks", async () => {
    emitTestEvent("coexists with tool_use blocks")
    streamEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deciding" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool1", name: "shell", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const runtime = await createRuntime()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
      callbacks: noopCallbacks,
    })

    expect(result.outputItems).toHaveLength(1)
    expect((result.outputItems[0] as any).type).toBe("thinking")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe("shell")
  })

  it("handles redacted_thinking with missing data field", async () => {
    emitTestEvent("handles redacted_thinking missing data")
    streamEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { input_tokens: 5, output_tokens: 3 } },
    ]

    const runtime = await createRuntime()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: noopCallbacks,
    })

    expect(result.outputItems).toHaveLength(1)
    expect((result.outputItems[0] as any).data).toBe("")
  })

  it("handles signature_delta with missing signature field and orphan index", async () => {
    emitTestEvent("handles signature_delta edge cases")
    streamEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta" } },
      // Orphan signature_delta for an index that has no thinking block
      { type: "content_block_delta", index: 99, delta: { type: "signature_delta", signature: "orphan" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", usage: { input_tokens: 5, output_tokens: 3 } },
    ]

    const runtime = await createRuntime()
    const result = await runtime.streamTurn({
      messages: [{ role: "user", content: "hi" }],
      activeTools: [],
      callbacks: noopCallbacks,
    })

    expect(result.outputItems).toHaveLength(1)
    const block = result.outputItems[0] as any
    expect(block.type).toBe("thinking")
    expect(block.signature).toBe("")
  })
})
