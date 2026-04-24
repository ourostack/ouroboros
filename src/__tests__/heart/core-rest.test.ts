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
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
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

const mockInjectNoteSearchContext = vi.fn().mockResolvedValue(undefined)
vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: (...args: any[]) => mockInjectNoteSearchContext(...args),
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

vi.mock("../../arc/obligations", () => ({
  createObligation: vi.fn(() => ({ id: "obl-test-123" })),
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

// Streams a rest tool call
function restToolCallChunks(args: Record<string, unknown> = {}) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_rest", function: { name: "rest", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify(args) } }]),
  ]
}

// Streams a settle to end the loop
function settleChunks(answer: string) {
  return [
    makeChunk(undefined, [{ index: 0, id: "call_final", function: { name: "settle", arguments: "" } }]),
    makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ answer, intent: "complete" }) } }]),
  ]
}

describe("rest tool in runAgent", () => {
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

  // ── Basic rest behavior (inner dialog) ──────────────────────

  it("rest from inner dialog with empty attention queue succeeds", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
          delegatedOrigins: [],
        },
      },
    )

    expect(result.outcome).toBe("rested")
  })

  it("rest from inner dialog without delegatedOrigins succeeds", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

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

    expect(result.outcome).toBe("rested")
  })

  it("rest sets done = true (only one model call)", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

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

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("rest emits engine.rested nerves event", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

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

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "engine",
      event: "engine.rested",
    }))
  })

  it("rest accepts HEARTBEAT_OK as a clean no-op status", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks({ status: "HEARTBEAT_OK" })))

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

    expect(result.outcome).toBe("rested")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "engine",
      event: "engine.rested",
      meta: expect.objectContaining({ status: "HEARTBEAT_OK" }),
    }))
  })

  // ── Attention queue gating ──────────────────────────────────

  it("rest is rejected when attention queue has items", async () => {
    vi.useFakeTimers()
    // First call: rest (should be rejected because attention queue has items)
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    // After rejection, model tries rest again. Once mocked-once calls are exhausted,
    // fall through to an HTTP error and advance the shared provider attempt timers.
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockImplementation(() => {
      const err: any = new Error("test fixture: stop loop")
      err.status = 400
      throw err
    })

    const callbacks = makeCallbacks()
    const promise = runAgent(
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
    await vi.advanceTimersByTimeAsync(2100)
    await vi.advanceTimersByTimeAsync(4100)
    await vi.advanceTimersByTimeAsync(100)
    await promise
    vi.useRealTimers()

    // First rest call was rejected with attention queue gate message
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("rest", expect.any(String), false)
  })

  it("rest is rejected when fresh pending work arrived this turn", async () => {
    vi.useFakeTimers()
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    mockCreate.mockImplementation(() => {
      const err: any = new Error("test fixture: stop loop")
      err.status = 400
      throw err
    })

    const callbacks = makeCallbacks()
    const promise = runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
      undefined,
      {
        pendingMessages: [
          { from: "mailroom", content: "[Mail Import Ready]\nA local MBOX archive is ready for delegated-mail backfill." },
        ],
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
          delegatedOrigins: [],
        },
      },
    )
    await vi.advanceTimersByTimeAsync(2100)
    await vi.advanceTimersByTimeAsync(4100)
    await vi.advanceTimersByTimeAsync(100)
    await promise
    vi.useRealTimers()

    expect(callbacks.onToolEnd).toHaveBeenCalledWith("rest", expect.any(String), false)
  })

  // ── Sole-call rejection ──────────────────────────────────

  it("rest is rejected in mixed call with other tools", async () => {
    // First call: rest + another tool in same turn
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [
        { index: 0, id: "call_rest", function: { name: "rest", arguments: "" } },
        { index: 1, id: "call_other", function: { name: "read_file", arguments: "" } },
      ]),
      makeChunk(undefined, [
        { index: 0, function: { arguments: "{}" } },
        { index: 1, function: { arguments: JSON.stringify({ path: "/tmp/foo" }) } },
      ]),
    ]))
    // Second call: settle to end the loop
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("done")))

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

    // Rest was rejected as sole-call violation, then settled
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  // ── Tool filtering ──────────────────────────────────

  it("rest is available in inner dialog tool set", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

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

    // If rest were filtered out, it would go through normal tool execution and not be intercepted
    expect(result.outcome).toBe("rested")
  })

  it("settle is NOT available in inner dialog tool set (replaced by rest)", async () => {
    // Settle in inner dialog should be rejected -- it's not in the tool set
    // The model may still call it but it should not be in activeTools
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

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

    // Check that the tools sent to the model don't include "settle" for inner dialog
    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).not.toContain("settle")
    expect(toolNames).toContain("rest")
  })

  it("settle IS available in outer session (not replaced by rest)", async () => {
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("hello")))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "cli",
    )

    const params = mockCreate.mock.calls[0][0]
    const toolNames = params.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain("settle")
    expect(toolNames).not.toContain("rest")
  })

  // ── Edge cases ──────────────────────────────────

  it("rest handles malformed JSON arguments gracefully", async () => {
    // Stream a rest call with invalid JSON arguments
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_rest", function: { name: "rest", arguments: "" } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: "not json" } }]),
    ]))

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

    // Should still succeed (args parse falls back to {})
    expect(result.outcome).toBe("rested")
  })

  it("rest from inner dialog with no toolContext succeeds (no attention queue)", async () => {
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "heartbeat" }],
      callbacks,
      "inner",
    )

    expect(result.outcome).toBe("rested")
  })
})
