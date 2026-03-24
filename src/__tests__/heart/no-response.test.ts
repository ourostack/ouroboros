import { describe, it, expect, vi, beforeEach } from "vitest"

// Default readFileSync: return psyche file stubs so prompt.ts module-level loads work
function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
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

const mockCreate = vi.fn()
const mockResponsesCreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    }
    responses = {
      create: mockResponsesCreate,
    }
    constructor(_opts?: any) {}
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic }
})

const mockInjectAssociativeRecall = vi.fn().mockResolvedValue(undefined)
vi.mock("../../mind/associative-recall", () => ({
  injectAssociativeRecall: (...args: any[]) => mockInjectAssociativeRecall(...args),
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks, RunAgentOutcome } from "../../heart/core"

async function setupMinimax() {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
  })
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
}

function makeStream(chunks: any[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

function makeChunk(content?: string, toolCalls?: any[]) {
  const delta: any = {}
  if (content !== undefined) delta.content = content
  if (toolCalls !== undefined) delta.tool_calls = toolCalls
  return { choices: [{ delta }] }
}

function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onClearText: vi.fn(),
    ...overrides,
  }
}

describe("observe tool in runAgent", () => {
  let runAgent: (
    messages: any[],
    callbacks: ChannelCallbacks,
    channel?: string,
    signal?: AbortSignal,
    options?: Record<string, unknown>,
  ) => Promise<{ usage?: any; outcome: RunAgentOutcome; completion?: any }>

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("RunAgentOutcome includes observed (type-level compile check)", async () => {
    // If this compiles, observed is part of the union
    const outcome: RunAgentOutcome = "observed"
    expect(outcome).toBe("observed")
  })

  it("returns outcome 'observed' when observe is the sole tool call", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "observe", arguments: '{"reason":"not directed at me"}' } },
        ]),
      ])
    )

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    const result = await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: true, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    expect(result.outcome).toBe("observed")
    expect(result.completion).toBeUndefined()
  })

  it("does not invoke onTextChunk or onClearText when observe is used", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "observe", arguments: '{}' } },
        ]),
      ])
    )

    const onTextChunk = vi.fn()
    const onClearText = vi.fn()
    const callbacks = makeCallbacks({ onTextChunk, onClearText })
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: true, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    expect(onTextChunk).not.toHaveBeenCalled()
    expect(onClearText).not.toHaveBeenCalled()
  })

  it("rejects observe when mixed with other tool calls", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "observe", arguments: '{}' } },
            { index: 1, id: "call_2", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ]),
        ])
      }
      // Second call: model returns settle alone to end the loop
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_3", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    })

    vi.mocked(fs.readFileSync).mockReturnValue("file data")

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: true, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    // Find rejection message for observe
    const toolResults = messages.filter((m: any) => m.role === "tool")
    const rejection = toolResults.find((m: any) => m.tool_call_id === "call_1")
    expect(rejection).toBeDefined()
    expect(rejection.content).toContain("rejected")
    expect(rejection.content).toContain("observe must be the only tool call")
  })

  it("includes observe in activeTools when toolChoiceRequired and isGroupChat", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: true, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    // The MiniMax provider passes tools through to the API
    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain("observe")
    expect(toolNames).toContain("settle")
  })

  it("does NOT include observe in activeTools when isGroupChat is false", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: false, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).not.toContain("observe")
  })

  it("does NOT include observe when isGroupChat is undefined", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).not.toContain("observe")
  })

  it("emits a nerves event when observe is used", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    await setupMinimax()

    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "observe", arguments: '{"reason":"just a reaction"}' } },
        ]),
      ])
    )

    const core = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    await core.runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: true, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    // Check that emitNervesEvent was called with the observe event
    const observeEvent = emitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "engine.observe"
    )
    expect(observeEvent).toBeDefined()
    expect(observeEvent![0].component).toBe("engine")
    expect(observeEvent![0].meta).toHaveProperty("reason", "just a reaction")
  })

  it("pushes assistant message and silenced tool result to messages", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "observe", arguments: '{}' } },
        ]),
      ])
    )

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]
    await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        context: { isGroupChat: true, channel: { channel: "bluebubbles", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      },
    })

    const assistantMsg = messages.find((m: any) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.tool_calls[0].function.name).toBe("observe")

    const toolResult = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "call_1")
    expect(toolResult).toBeDefined()
    expect(toolResult.content).toBe("(silenced)")
  })

  it("inner dialog excludes go_inward, send_message, and observe from tool set", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      makeCallbacks(),
      "inner",
      undefined,
      {
        toolChoiceRequired: true,
        toolContext: {
          signin: async () => undefined,
          context: { isGroupChat: false, channel: { channel: "inner", senseType: "open", availableIntegrations: [], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
        },
      },
    )

    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).not.toContain("go_inward")
    expect(toolNames).not.toContain("send_message")
    expect(toolNames).not.toContain("observe")
    expect(toolNames).toContain("settle")
    expect(toolNames).toContain("surface")
  })
})
