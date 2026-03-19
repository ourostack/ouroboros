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

describe("no_response tool in runAgent", () => {
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

  it("RunAgentOutcome includes no_response (type-level compile check)", async () => {
    // If this compiles, no_response is part of the union
    const outcome: RunAgentOutcome = "no_response"
    expect(outcome).toBe("no_response")
  })

  it("returns outcome 'no_response' when no_response is the sole tool call", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "no_response", arguments: '{"reason":"not directed at me"}' } },
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

    expect(result.outcome).toBe("no_response")
    expect(result.completion).toBeUndefined()
  })

  it("does not invoke onTextChunk or onClearText when no_response is used", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "no_response", arguments: '{}' } },
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

  it("rejects no_response when mixed with other tool calls", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "no_response", arguments: '{}' } },
            { index: 1, id: "call_2", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ]),
        ])
      }
      // Second call: model returns final_answer alone to end the loop
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_3", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
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

    // Find rejection message for no_response
    const toolResults = messages.filter((m: any) => m.role === "tool")
    const rejection = toolResults.find((m: any) => m.tool_call_id === "call_1")
    expect(rejection).toBeDefined()
    expect(rejection.content).toContain("rejected")
    expect(rejection.content).toContain("no_response must be the only tool call")
  })

  it("includes no_response in activeTools when toolChoiceRequired and isGroupChat", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
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
    expect(toolNames).toContain("no_response")
    expect(toolNames).toContain("final_answer")
  })

  it("does NOT include no_response in activeTools when isGroupChat is false", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
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
    expect(toolNames).not.toContain("no_response")
  })

  it("does NOT include no_response when isGroupChat is undefined", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "final_answer", arguments: '{"answer":"done"}' } },
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
    expect(toolNames).not.toContain("no_response")
  })

  it("emits a nerves event when no_response is used", async () => {
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
          { index: 0, id: "call_1", function: { name: "no_response", arguments: '{"reason":"just a reaction"}' } },
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

    // Check that emitNervesEvent was called with the no_response event
    const noResponseEvent = emitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "engine.no_response"
    )
    expect(noResponseEvent).toBeDefined()
    expect(noResponseEvent![0].component).toBe("engine")
    expect(noResponseEvent![0].meta).toHaveProperty("reason", "just a reaction")
  })

  it("pushes assistant message and silenced tool result to messages", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "no_response", arguments: '{}' } },
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
    expect(assistantMsg.tool_calls[0].function.name).toBe("no_response")

    const toolResult = messages.find((m: any) => m.role === "tool" && m.tool_call_id === "call_1")
    expect(toolResult).toBeDefined()
    expect(toolResult.content).toBe("(silenced)")
  })
})
