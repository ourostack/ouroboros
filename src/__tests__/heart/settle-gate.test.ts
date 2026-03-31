import { describe, it, expect, vi, beforeEach } from "vitest"

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
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
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
import type { AttentionItem } from "../../senses/attention-queue"

async function setupMinimax() {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
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

describe("settle gate in inner dialog", () => {
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

    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("rejects settle when attention queue is non-empty in inner dialog", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
          ]),
        ])
      }
      // Second call: settle succeeds (queue was emptied externally for test)
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "settle", arguments: '{"answer":"really done"}' } },
        ]),
      ])
    })

    const queue: AttentionItem[] = [
      { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
    ]

    const messages: any[] = [{ role: "user", content: "heartbeat" }]
    // After first settle rejection, empty queue so second settle succeeds
    mockCreate.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return makeStream([
          makeChunk(undefined, [
            { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
          ]),
        ])
      }
      // Empty the queue before second call
      queue.splice(0, queue.length)
      return makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_2", function: { name: "settle", arguments: '{"answer":"really done"}' } },
        ]),
      ])
    })

    await runAgent(messages, makeCallbacks(), "inner", undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        delegatedOrigins: queue,
      },
    })

    const toolResults = messages.filter((m: any) => m.role === "tool")
    const rejectionResult = toolResults.find((m: any) => m.content?.includes("surface them before you settle"))
    expect(rejectionResult).toBeDefined()
  })

  it("settle succeeds when attention queue is empty", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      makeCallbacks(),
      "inner",
      undefined,
      {
        toolChoiceRequired: true,
        toolContext: {
          signin: async () => undefined,
          delegatedOrigins: [],
        },
      },
    )

    expect(result.outcome).toBe("settled")
  })

  it("settle in inner dialog does NOT produce CompletionMetadata", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      makeCallbacks(),
      "inner",
      undefined,
      {
        toolChoiceRequired: true,
        toolContext: {
          signin: async () => undefined,
          delegatedOrigins: [],
        },
      },
    )

    expect(result.completion).toBeUndefined()
  })

  it("settle tool result in inner dialog is '(settled)' not '(delivered)'", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } },
        ]),
      ])
    )

    const messages: any[] = [{ role: "user", content: "heartbeat" }]
    await runAgent(messages, makeCallbacks(), "inner", undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        delegatedOrigins: [],
      },
    })

    const toolResults = messages.filter((m: any) => m.role === "tool")
    const settledResult = toolResults.find((m: any) => m.content === "(settled)")
    expect(settledResult).toBeDefined()
  })

  it("settle in outer sessions still produces CompletionMetadata", async () => {
    mockCreate.mockReturnValue(
      makeStream([
        makeChunk(undefined, [
          { index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"hello there"}' } },
        ]),
      ])
    )

    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      makeCallbacks(),
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
      },
    )

    expect(result.completion).toBeDefined()
    expect(result.completion?.answer).toBe("hello there")
  })
})
