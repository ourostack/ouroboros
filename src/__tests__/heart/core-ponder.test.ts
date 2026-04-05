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

const mockCreateObligation = vi.fn(() => ({ id: "obl-test-123" }))
vi.mock("../../arc/obligations", () => ({
  createObligation: (...args: any[]) => mockCreateObligation(...args),
  readObligations: vi.fn(() => []),
  readPendingObligations: vi.fn(() => []),
  advanceObligation: vi.fn(),
  fulfillObligation: vi.fn(),
  findPendingObligationForOrigin: vi.fn(),
  isOpenObligation: vi.fn(),
  isOpenObligationStatus: vi.fn(),
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

// Streams a ponder tool call with given args
function ponderToolCallChunks(args: Record<string, string>) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_ponder", function: { name: "ponder", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify(args) } }]),
  ]
}

// Streams a settle after ponder (for mixed-call test)
function settleChunks(answer: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
  ]
}

describe("ponder tool in runAgent", () => {
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
    mockCreateObligation.mockReset().mockReturnValue({ id: "obl-test-123" })
    await setupMinimax()
    const core = await import("../../heart/core")
    runAgent = core.runAgent
  })

  // ── Outer session behavior ──────────────────────────────────

  it("intercepts sole ponder call from outer session, returns pondered outcome", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "think about naming", say: "let me sit with that" }),
    ))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(result.outcome).toBe("pondered")
  })

  it("emits say text via onTextChunk from outer session", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "naming question", say: "let me think about that" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(callbacks.onTextChunk).toHaveBeenCalledWith("let me think about that")
  })

  it("creates heart obligation from outer session with currentSession", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "naming conventions", say: "pondering that" }),
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

    expect(mockCreateObligation).toHaveBeenCalledWith(
      "/mock/repo/testagent",
      expect.objectContaining({
        origin: { friendId: "alex", channel: "teams", key: "session1" },
        content: "naming conventions",
      }),
    )
  })

  it("enqueues pending message with delegatedFrom from outer session", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "naming conventions", say: "pondering that" }),
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

    expect(mockQueuePendingMessage).toHaveBeenCalledWith(
      "/mock/pending/self/inner/dialog",
      expect.objectContaining({
        from: "testagent",
        friendId: "self",
        channel: "inner",
        key: "dialog",
        delegatedFrom: {
          friendId: "alex",
          channel: "teams",
          key: "session1",
        },
        obligationStatus: "pending",
      }),
    )
  })

  it("calls requestInnerWake after enqueue from outer session", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "test", say: "thinking..." }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(mockRequestInnerWake).toHaveBeenCalledWith("testagent")
  })

  it("returns (pondering) as tool result", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "test", say: "thinking..." }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    // Verify onToolEnd was called for ponder
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(
      "ponder",
      expect.any(String),
      true,
    )
  })

  it("rejects ponder from outer session when thought is missing", async () => {
    // First call: ponder with only say, no thought
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ say: "let me think" }),
    ))
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

    // Should NOT have queued a pending message (rejected)
    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
  })

  it("rejects ponder from outer session when say is missing", async () => {
    // First call: ponder with only thought, no say
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "think about this" }),
    ))
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

    // Should NOT have queued a pending message (rejected)
    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
  })

  it("rejects ponder from outer session when both thought and say are missing", async () => {
    // First call: ponder with no args
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({}),
    ))
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

    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
  })

  // ── Inner dialog behavior ──────────────────────────────────

  it("ponder from inner dialog succeeds with no args", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({}),
    ))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(result.outcome).toBe("pondered")
  })

  it("ponder from inner dialog enqueues synthetic pending WITHOUT delegatedFrom", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({}),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(mockQueuePendingMessage).toHaveBeenCalledWith(
      "/mock/pending/self/inner/dialog",
      expect.objectContaining({
        from: "testagent",
        friendId: "self",
        channel: "inner",
        key: "dialog",
      }),
    )
    // Should NOT have delegatedFrom
    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.delegatedFrom).toBeUndefined()
  })

  it("ponder from inner dialog does NOT create obligation", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({}),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(mockCreateObligation).not.toHaveBeenCalled()
  })

  it("ponder from inner dialog is NOT gated by attention queue", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({}),
    ))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
          delegatedOrigins: [
            { friendId: "alex", channel: "teams", key: "s1", content: "pending", delegationId: "d1" },
          ],
        },
      },
    )

    // Should succeed even with attention queue items
    expect(result.outcome).toBe("pondered")
  })

  it("ponder sets done = true", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "test", say: "thinking..." }),
    ))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    // If done was set to true, there should be only one model call
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe("pondered")
  })

  // ── Sole-call rejection ──────────────────────────────────

  it("rejects ponder in mixed call with other tools", async () => {
    // First call: ponder + another tool in same turn
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_ponder", function: { name: "ponder", arguments: "" } },
        { index: 1, id: "call_other", function: { name: "read_file", arguments: "" } },
      ]),
      makeChunk(undefined, [
        { index: 0, function: { arguments: JSON.stringify({ thought: "test", say: "hi" }) } },
        { index: 1, function: { arguments: JSON.stringify({ path: "/tmp/foo" }) } },
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

    // ponder should NOT have queued a pending message
    expect(mockQueuePendingMessage).not.toHaveBeenCalled()
  })

  // ── Nerves event ──────────────────────────────────

  it("emits engine.pondered nerves event", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "test content", say: "thinking..." }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "engine",
      event: "engine.pondered",
    }))
  })

  // ── Ponder available in inner dialog tool set ──────────────────────────────────

  it("ponder tool is available in inner dialog channel", async () => {
    // This tests that the tool filtering includes ponder for inner dialog
    // If ponder were excluded from inner dialog, the model would need to use
    // a different tool or the call would be treated as a regular tool execution
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({}),
    ))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    // If ponder were filtered out, it wouldn't be intercepted
    expect(result.outcome).toBe("pondered")
  })

  // ── Handoff packet coverage ──────────────────────────────────

  it("handoff packet includes delegation decision reasons as prose", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "naming conventions", say: "let me think" }),
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
        toolContext: {
          currentSession: { friendId: "alex", channel: "teams", key: "session1" },
        },
      },
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.content).toContain("something in the conversation called for reflection")
    expect(enqueued.content).toContain("this touches other conversations")
  })

  it("handoff packet with outwardClosureRequired includes obligation text", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "naming", say: "pondering that" }),
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

  it("handoff packet without currentSession says 'no one -- just thinking'", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "just pondering", say: "hmm" }),
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

  it("handoff packet without outwardClosureRequired says 'nothing -- just thinking'", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "just thinking", say: "one sec" }),
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

  it("handoff packet without delegation decision uses default reason", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "just thinking", say: "one sec" }),
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

  it("enqueues pending with obligationId when obligation creation succeeds", async () => {
    mockCreateObligation.mockReturnValue({ id: "obl-xyz-789" })
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "naming", say: "thinking..." }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "alex", channel: "teams", key: "s1" },
        },
      },
    )

    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.obligationId).toBe("obl-xyz-789")
  })

  // ── Ponder from outer without currentSession ──────────────────

  it("ponder from outer without currentSession does not create obligation", async () => {
    mockCreate.mockReturnValueOnce(makeStream(
      ponderToolCallChunks({ thought: "musing", say: "let me think" }),
    ))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    expect(mockCreateObligation).not.toHaveBeenCalled()
    // Still enqueues pending but without delegatedFrom
    const enqueued = mockQueuePendingMessage.mock.calls[0][1]
    expect(enqueued.delegatedFrom).toBeUndefined()
  })
})
