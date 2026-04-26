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
    vi.mocked(emitNervesEvent).mockClear()
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

  it("rest is rejected once when fresh pending work arrived, then accepted on the second attempt", async () => {
    // Regression for the self-sustaining 'fresh work arrived' loop Slugger
    // hit. The gate previously fired on every rest call within the turn
    // because hasFreshPendingWork(options) reads from the turn-start
    // snapshot and never updates. The fix gates it once-per-turn: after the
    // agent has been told fresh work arrived, repeated rest attempts pass.
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks())) // first rest → blocked
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks())) // second rest → accepted

    const callbacks = makeCallbacks()
    await runAgent(
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

    // First rest blocked by gate, second rest accepted — exactly 2 chat calls.
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const restEnds = (callbacks.onToolEnd as any).mock.calls.filter((c: any[]) => c[0] === "rest")
    expect(restEnds).toHaveLength(2)
    expect(restEnds[0][2]).toBe(false) // first rest blocked
    expect(restEnds[1][2]).toBe(true)  // second rest accepted
    // Gate observability event fires exactly once per turn.
    const gateEvents = vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.fresh_work_gate_fired")
    expect(gateEvents).toHaveLength(1)
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

  // Regression for the MiniMax-M2.7 empty-reply bug Slugger surfaced via MCP.
  // The model emitted only a <think>...</think> block with no tool call,
  // despite tool_choice: "required". The harness used to silently accept
  // the empty turn — now it retries with a corrective nudge up to twice,
  // then falls through.
  it("retries with a corrective nudge when the model returns no tool call despite tool_choice=required", async () => {
    // Stream 1: only think content, no tool call (the violation)
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("<think>thinking but never calling a tool</think>", undefined),
    ]))
    // Stream 2: same violation again
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("<think>still thinking, still no tool</think>", undefined),
    ]))
    // Stream 3: agent finally settles
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("ok here is my answer")))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "say hi" }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "mcp", key: "test" },
        },
      },
    )

    // Three model calls total: 2 violations + 1 successful settle.
    expect(mockCreate).toHaveBeenCalledTimes(3)
    // engine.no_tool_call_retry warn event fired twice.
    const retryEvents = vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.no_tool_call_retry")
    expect(retryEvents).toHaveLength(2)
    expect(retryEvents[0]?.[0]).toMatchObject({ level: "warn", meta: expect.objectContaining({ attempt: 1, cap: 2 }) })
    expect(retryEvents[1]?.[0]).toMatchObject({ level: "warn", meta: expect.objectContaining({ attempt: 2, cap: 2 }) })
    // Final settle delivered "ok here is my answer" to onTextChunk.
    const textCalls = (callbacks.onTextChunk as any).mock.calls.flat()
    expect(textCalls.join("")).toContain("ok here is my answer")
  })

  it("does NOT retry when the model returns no tool call but tool_choice was not required", async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("just plain content with no tool call", undefined),
    ]))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "mcp",
      undefined,
      {
        toolChoiceRequired: false,
        toolContext: {
          currentSession: { friendId: "self", channel: "mcp", key: "test" },
        },
      },
    )

    // Single model call, no retry.
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const retryEvents = vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.no_tool_call_retry")
    expect(retryEvents).toHaveLength(0)
  })

  it("retries with the inner-dialog corrective when channel is inner", async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("<think>thinking, no tool call</think>", undefined),
    ]))
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

    // Two model calls: one violation + one rest accepted.
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const retryEvents = vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.no_tool_call_retry")
    expect(retryEvents).toHaveLength(1)
    // The pushed corrective message should reference rest (inner-dialog wording),
    // not settle. Inspect the messages array indirectly via the last mockCreate call's params.
    const lastCallParams = mockCreate.mock.calls[1]?.[0] as any
    const userMessages = (lastCallParams.messages as any[]).filter((m) => m.role === "user")
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg.content).toContain("rest")
    expect(lastUserMsg.content).not.toContain("settle")
  })

  it("caps no-tool-call retries at 2 then accepts the empty turn", async () => {
    // Three consecutive no-tool-call violations.
    mockCreate.mockReturnValueOnce(makeStream([makeChunk("<think>v1</think>", undefined)]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk("<think>v2</think>", undefined)]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk("<think>v3</think>", undefined)]))

    const callbacks = makeCallbacks()
    await runAgent(
      [{ role: "user", content: "hi" }],
      callbacks,
      "mcp",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "mcp", key: "test" },
        },
      },
    )

    // 3 model calls (turn + 2 retries), cap reached, accept as-is.
    expect(mockCreate).toHaveBeenCalledTimes(3)
    const retryEvents = vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.no_tool_call_retry")
    expect(retryEvents).toHaveLength(2)
  })
})
