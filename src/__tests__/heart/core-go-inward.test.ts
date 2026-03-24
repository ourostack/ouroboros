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

const mockQueuePendingMessage = vi.fn()
vi.mock("../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../mind/pending")>("../../mind/pending")
  return {
    ...actual,
    queuePendingMessage: (...args: any[]) => mockQueuePendingMessage(...args),
    getInnerDialogPendingDir: vi.fn(() => "/mock/pending/self/inner/dialog"),
  }
})

const mockRequestInnerWake = vi.fn().mockResolvedValue(undefined)
vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: (...args: any[]) => mockRequestInnerWake(...args),
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks, RunAgentOutcome } from "../../heart/core"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

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

// Streams a go_inward tool call with given args
function goInwardToolCallChunks(args: Record<string, string>) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_go_inward", function: { name: "go_inward", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify(args) } }]),
  ]
}

// Streams a settle after go_inward
function settleChunks(answer: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
  ]
}

describe("go_inward in runAgent", () => {
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
    mockCreate.mockReset()
    mockQueuePendingMessage.mockReset()
    mockRequestInnerWake.mockReset().mockResolvedValue(undefined)
    await setupMinimax()
    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  it("intercepts sole go_inward call, enqueues pending, sets outcome go_inward", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "think about naming" }),
    ))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(result.outcome).toBe("go_inward")
    expect(mockQueuePendingMessage).toHaveBeenCalledWith(
      "/mock/pending/self/inner/dialog",
      expect.objectContaining({
        from: "testagent",
        friendId: "self",
        channel: "inner",
        key: "dialog",
        mode: "reflect",
      }),
    )
  })

  it("emits answer via callbacks when go_inward has answer parameter", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "think about naming", answer: "let me think about that" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(callbacks.onClearText).toHaveBeenCalled()
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("let me think about that")
  })

  it("does not emit answer when go_inward has no answer parameter", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "just thinking" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
  })

  it("uses mode from go_inward parameter", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "work on architecture", mode: "plan" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(mockQueuePendingMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: "plan" }),
    )
  })

  it("defaults to reflect mode when no mode parameter", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "pondering" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(mockQueuePendingMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: "reflect" }),
    )
  })

  it("rejects go_inward in mixed call", async () => {
    // First call: go_inward + another tool in same turn
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_go", function: { name: "go_inward", arguments: "" } },
        { index: 1, id: "call_other", function: { name: "read_memory", arguments: "" } },
      ]),
      makeChunk(undefined, [
        { index: 0, function: { arguments: JSON.stringify({ topic: "test" }) } },
        { index: 1, function: { arguments: "{}" } },
      ]),
    ]))
    // Second call: settle to end the loop
    mockCreate.mockReturnValueOnce(makeStream(
      settleChunks("done"),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    // go_inward should NOT have queued a pending message
    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
  })

  it("handoff packet includes delegation decision reasons as prose", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "naming conventions" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
      undefined,
      {
        delegationDecision: {
          target: "delegate-inward",
          reasons: ["explicit_reflection", "cross_session"],
          outwardClosureRequired: false,
        },
      },
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("something in the conversation called for reflection")
    expect(enqueued.content).toContain("this touches other conversations")
  })

  it("handoff packet includes who asked from currentSession", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "naming conventions" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "alex", channel: "teams", key: "session1" },
        },
      },
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("## who asked\nalex")
    expect(enqueued.delegatedFrom).toEqual({
      friendId: "alex",
      channel: "teams",
      key: "session1",
    })
    expect(enqueued.obligationStatus).toBe("pending")
  })

  it("handoff packet without currentSession says 'no one -- just thinking'", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "just pondering" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("no one -- just thinking")
  })

  it("handoff packet with outwardClosureRequired includes obligation text", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "naming" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
      undefined,
      {
        delegationDecision: {
          target: "delegate-inward",
          reasons: [],
          outwardClosureRequired: true,
        },
        toolContext: {
          currentSession: { friendId: "alex", channel: "teams", key: "session1" },
        },
      },
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("i'm holding something for alex")
  })

  it("handoff packet without outwardClosureRequired says 'no obligation'", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "just thinking" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("nothing -- just thinking")
  })

  it("triggers inner wake after enqueue", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "test" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(mockRequestInnerWake).toHaveBeenCalledWith("testagent")
  })

  it("emits nerves event for go_inward", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "test content" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "engine",
      event: "engine.go_inward",
      message: "taking thread inward",
    }))
  })

  it("does not set delegatedFrom when currentSession is inner channel", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "recursive thought" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.delegatedFrom).toBeUndefined()
    expect(enqueued.obligationStatus).toBeUndefined()
  })

  it("handles reasons with no delegation decision gracefully", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      goInwardToolCallChunks({ topic: "just thinking" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("this felt like it needed more thought")
  })
})
