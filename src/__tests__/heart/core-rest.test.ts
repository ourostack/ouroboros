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
const mockWithdrawDeferredReturn = vi.fn(() => 1)
vi.mock("../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../mind/pending")>("../../mind/pending")
  return {
    ...actual,
    queuePendingMessage: (...args: any[]) => mockQueuePendingMessage(...args),
    withdrawDeferredReturn: (...args: any[]) => mockWithdrawDeferredReturn(...args),
    getPrivateRuntimePendingDir: vi.fn(() => "/mock/pending/self/inner/dialog"),
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

  // ── Basic rest behavior (private runtime) ──────────────────────

  it("rest from private runtime with empty attention queue succeeds", async () => {
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

  it("rest from private runtime without delegatedOrigins succeeds", async () => {
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

  it("passes rendered sense context packet messages through to the provider request", async () => {
    mockCreate.mockReturnValueOnce(makeStream([makeChunk("I can see the context.")]))

    const callbacks = makeCallbacks()
    await runAgent(
      [
        { role: "system", content: "system prompt" },
        {
          role: "system",
          content: "Untrusted bluebubbles context packet scp_same_thread:\nRSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
        },
        { role: "user", content: "who is pending?" },
      ],
      callbacks,
      "bluebubbles",
      undefined,
      { contextPacketIds: ["scp_same_thread"] },
    )

    const createCall = mockCreate.mock.calls[0]?.[0]
    expect(createCall.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Untrusted bluebubbles context packet scp_same_thread"),
      }),
      expect.objectContaining({
        role: "user",
        content: "who is pending?",
      }),
    ]))
  })

  // ── Attention queue gating ──────────────────────────────────

  it.each(["held", "fresh"])("A003 keeps %s-work rest admission control out of canonical and generated history", async (kind) => {
    const messages: any[] = [{ role: "user", content: "heartbeat" }]
    const canonicalViews: any[][] = []
    const outbound: any[][] = []
    const generated = vi.fn()
    const origins = kind === "held" ? [{ friendId: "alex", channel: "teams", key: "s1", content: "pending", delegationId: "d1" }] : []
    let calls = 0
    mockCreate.mockImplementation((request: any) => {
      calls++
      canonicalViews.push(structuredClone(messages))
      outbound.push(structuredClone(request.messages))
      return makeStream([makeChunk(undefined, [{
        index: 0, id: calls === 1 ? "rest_rejected_A003" : `rest_accepted_${calls}`,
        function: { name: "rest", arguments: "{}" },
      }])])
    })
    const callbacks = makeCallbacks({
      onToolEnd: vi.fn((_name: string, _summary: string, success: boolean) => { if (!success) origins.splice(0) }),
    })
    const options = {
      ...(kind === "fresh" ? { pendingMessages: [{ from: "mailroom", content: "fresh bounded work" }] } : {}),
      toolContext: { currentSession: { friendId: "self", channel: "inner", key: "dialog" }, delegatedOrigins: origins },
      captureGeneratedMessages: generated,
    }
    const result = await runAgent(messages, callbacks, "inner", undefined, options as any)
    expect(result.outcome).toBe("rested")
    expect(calls).toBe(2)
    expect(JSON.stringify(outbound[1])).toContain("rest_rejected_A003")
    expect(JSON.stringify(canonicalViews[1])).not.toContain("rest_rejected_A003")
    expect(JSON.stringify([messages, generated.mock.calls])).not.toContain("rest_rejected_A003")
    const gate = kind === "held"
      ? "current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you rest. Older transcript claims are historical; only the current held-work frame is the gate."
      : "fresh work arrived for me this turn — inspect the pending messages above and take the next concrete action before you rest."
    expect(JSON.stringify(outbound[1])).toContain(gate)
    expect(canonicalViews[1].filter((message) => message.role !== "system")).toEqual([{ role: "user", content: "heartbeat" }])
    expect(messages.filter((message) => message.role === "user")).toEqual([{ role: "user", content: "heartbeat" }])
    expect(JSON.stringify([canonicalViews, messages, generated.mock.calls])).not.toContain(gate)
    expect(generated).toHaveBeenCalledExactlyOnceWith([
      { role: "assistant", tool_calls: [{ id: "rest_accepted_2", type: "function", function: { name: "rest", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "rest_accepted_2", content: "(resting)" },
    ])
    expect(messages.filter((message) => message.role === "tool")).toEqual([{ role: "tool", tool_call_id: "rest_accepted_2", content: "(resting)" }])
    messages.push({ role: "user", content: "next turn" })
    await runAgent(messages, makeCallbacks(), "inner")
    expect(JSON.stringify(outbound[2])).not.toContain(gate)
    expect(outbound[2].filter((message) => message.role === "user").map((message) => message.content)).toEqual(["heartbeat", "next turn"])
    expect(outbound[2].filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls?.map((call: any) => call.id) ?? [])).toEqual(["rest_accepted_2"])
    expect(outbound[2].filter((message) => message.role === "tool").map((message) => message.content)).toEqual(["(resting)"])
  })

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

  // ── Unsent surface gate ──────────────────────────────────

  const surfaceTestTool = {
    type: "function" as const,
    function: {
      name: "surface",
      description: "tell a friend",
      parameters: { type: "object", properties: { content: { type: "string" }, friendId: { type: "string" }, channel: { type: "string" } }, required: ["content"] },
    },
  }
  const toolCallChunks = (id: string, name: string, args: Record<string, unknown>) => [
    makeChunk(undefined, [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }]),
  ]
  const notSent = "deferred — not sent now; saved for their next message. iMessage did not send (send_error). (code: surface-not-sent)"

  it("rest is refused once while this turn's surface to a person came back not sent, then accepted", async () => {
    // Regression for 2026-11-22: a private turn surfaced news for a person, got a result
    // that did not reach them, and rested in the same turn.
    mockCreate.mockReturnValueOnce(makeStream(toolCallChunks("call_surface", "surface", { content: "Your sign-in is done.", friendId: "friend-1" })))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks())) // refused: the surface was not sent
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks())) // accepted: told once
    const execTool = vi.fn(async () => notSent)

    const callbacks = makeCallbacks()
    await runAgent([{ role: "user", content: "an agent says Robin's sign-in is done" }], callbacks, "inner", undefined, {
      tools: [surfaceTestTool],
      execTool,
      toolContext: { currentSession: { friendId: "self", channel: "inner", key: "dialog" }, delegatedOrigins: [] },
    })

    expect(mockCreate).toHaveBeenCalledTimes(3)
    const restEnds = (callbacks.onToolEnd as any).mock.calls.filter((c: any[]) => c[0] === "rest")
    expect(restEnds.map((c: any[]) => c[2])).toEqual([false, true])
    const refusal = (mockCreate.mock.calls[2]?.[0]?.messages as any[]).find((m) => m.role === "tool" && m.tool_call_id === "call_rest")
    expect(refusal?.content).toContain("did not reach them")
    expect(refusal?.content).toContain("iMessage did not send (send_error)")
    expect(refusal?.content).toMatch(/\(code: surface-not-sent\)$/u)
    const gateEvents = vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.surface_not_sent_gate_fired")
    expect(gateEvents).toHaveLength(1)
  })

  it("rest is refused once while a tool printed ACT: lines and no one has been told since, then accepted", async () => {
    // Regression for 2026-11-25: heartbeats ran a scan that listed dead lanes, then rested
    // without acting or telling anyone, for about a day.
    const shellTool = { type: "function" as const, function: { name: "shell", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }
    mockCreate.mockReturnValueOnce(makeStream(toolCallChunks("call_shell", "shell", { command: "bash habits/heartbeat-scan.sh" })))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks())) // refused: ACT line unanswered
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks())) // accepted: told once
    const execTool = vi.fn(async () => "== LANES\nACT: lane-a dead: REVIVED -> text Ari\nQUIET lane-b")

    const callbacks = makeCallbacks()
    await runAgent([{ role: "user", content: "30 minutes have passed." }], callbacks, "inner", undefined, {
      tools: [shellTool],
      execTool,
      toolContext: { currentSession: { friendId: "self", channel: "inner", key: "dialog" }, delegatedOrigins: [] },
    })

    expect(mockCreate).toHaveBeenCalledTimes(3)
    const restEnds = (callbacks.onToolEnd as any).mock.calls.filter((c: any[]) => c[0] === "rest")
    expect(restEnds.map((c: any[]) => c[2])).toEqual([false, true])
    const refusal = (mockCreate.mock.calls[2]?.[0]?.messages as any[]).find((m) => m.role === "tool" && m.tool_call_id === "call_rest")
    expect(refusal?.content).toContain("ACT: lane-a dead: REVIVED -> text Ari")
    expect(refusal?.content).not.toContain("QUIET lane-b")
    expect(refusal?.content).toMatch(/\(code: act-unanswered\)$/u)
    expect(vi.mocked(emitNervesEvent).mock.calls.filter(([e]) => (e as any).event === "engine.act_gate_fired")).toHaveLength(1)
  })

  it("finds this turn's ACT: lines until a later send reaches someone", async () => {
    const { unansweredActLines } = await import("../../heart/core")
    const scan = { name: "shell", args: {}, result: "x\nACT: revive lane-a\n  ACT: indented counts\nnot ACT: mid-line" }
    const sent = { name: "send_message", args: { friendId: "ari" }, result: "delivered now\nsent to the active bluebubbles chat now" }
    expect(unansweredActLines([])).toBeNull()
    expect(unansweredActLines([{ name: "shell", args: {}, result: "all quiet" }])).toBeNull()
    expect(unansweredActLines([scan])).toBe("ACT: revive lane-a\nACT: indented counts")
    expect(unansweredActLines([scan, sent])).toBeNull()
    expect(unansweredActLines([scan, { ...sent, result: "queued for later\nari isn't reachable now" }])).toBeNull()
    // Quoted ACT: lines in a file read are not work this turn.
    expect(unansweredActLines([{ ...scan, name: "read_file" }])).toBeNull()
    expect(unansweredActLines([scan, { ...sent, result: "failed\nbluebubbles send failed (code: delivery-failed)" }])).not.toBeNull()
    // A new ACT line after the send needs its own.
    expect(unansweredActLines([scan, sent, { name: "shell", args: {}, result: "ACT: revive lane-c" }])).toBe("ACT: revive lane-c")
  })

  it("finds this turn's unsent surface until a later send to the same friend succeeds", async () => {
    const { unsentSurfaceResult } = await import("../../heart/core")
    const surface = (result: string, friendId = "friend-1") => ({ name: "surface", args: { friendId }, result })
    const sent = "delivered now\nsent to the active bluebubbles chat now"
    expect(unsentSurfaceResult([])).toBeNull()
    expect(unsentSurfaceResult([surface("delivered — sent to Telegram now")])).toBeNull()
    expect(unsentSurfaceResult([surface(notSent), { name: "read_file", args: {}, result: "x" }])).toBe(notSent)
    // A later successful send to the same friend clears it, whichever tool sent it.
    expect(unsentSurfaceResult([surface(notSent), surface("delivered — sent to Telegram now")])).toBeNull()
    expect(unsentSurfaceResult([surface(notSent), surface("forwarded — handed to mini-host, which runs Teams; it sends on its next sync")])).toBeNull()
    expect(unsentSurfaceResult([surface(notSent), { name: "send_message", args: { friendId: "friend-1" }, result: sent }])).toBeNull()
    // A send to someone else, or one that failed, does not.
    expect(unsentSurfaceResult([surface(notSent), surface("delivered — sent to Telegram now", "friend-2")])).toBe(notSent)
    expect(unsentSurfaceResult([surface(notSent), { name: "send_message", args: { friendId: "friend-2" }, result: sent }])).toBe(notSent)
    expect(unsentSurfaceResult([surface(notSent), { name: "send_message", args: { friendId: "friend-1" }, result: "failed\nbluebubbles send failed (code: delivery-failed)" }])).toBe(notSent)
    // A later surface to the same friend that also came back unsent is the one rest reports.
    const second = "deferred — not sent now; saved for their next message. friend-1 has no chat session with you yet. (code: surface-not-sent)"
    expect(unsentSurfaceResult([surface(notSent), surface(second)])).toBe(second)
    // Each friend is tracked on its own: reaching one friend leaves another friend's unsent surface standing.
    expect(unsentSurfaceResult([surface(notSent, "friend-1"), surface(second, "friend-2"), surface("delivered — sent to Telegram now", "friend-2")])).toBe(notSent)
    // Friend ids compare trimmed and case-blind, and a send that may have gone out counts as reaching them.
    expect(unsentSurfaceResult([surface(notSent, " Friend-1 "), surface("delivered — sent to Telegram now", "friend-1")])).toBeNull()
    expect(unsentSurfaceResult([surface(notSent), surface("unconfirmed — the iMessage send failed partway, so it may have reached them; don't resend unless they say they didn't get it")])).toBeNull()
    // A surface addressed by delegationId is tracked by that held thought, so reaching another one does not clear it.
    const held = (result: string, delegationId: string) => ({ name: "surface", args: { delegationId }, result })
    expect(unsentSurfaceResult([held(notSent, "d-1"), held("delivered — sent to Telegram now", "d-2")])).toBe(notSent)
    expect(unsentSurfaceResult([held(notSent, "d-1"), held("delivered — sent to Telegram now", "d-1")])).toBeNull()
  })

  it("names the saved surfaces that a later send in the turn made redundant", async () => {
    const { surfacesReachedLater } = await import("../../heart/core")
    const surface = (result: string, friendId: string, content = "the news") => ({ name: "surface", args: { friendId, content }, result })
    const reached = "delivered — sent to Telegram now"
    expect(surfacesReachedLater([])).toEqual([])
    expect(surfacesReachedLater([surface(notSent, "friend-1")])).toEqual([])
    // The same words reaching the same friend (ids and spacing compared loosely) make the saved copy redundant.
    expect(surfacesReachedLater([surface(notSent, " friend-1 "), surface(notSent, "friend-2"), surface(reached, "Friend-1", "  The   news ")]))
      .toEqual([{ friendId: "friend-1", content: "the news" }])
    expect(surfacesReachedLater([surface(notSent, "friend-1"), { name: "send_message", args: { friendId: "friend-1", content: "the news" }, result: "delivered now\nsent to the active bluebubbles chat now" }]))
      .toEqual([{ friendId: "friend-1", content: "the news" }])
    // Other news reaching them leaves the saved copy alone, and so does a send with no words.
    expect(surfacesReachedLater([surface(notSent, "friend-1"), surface(reached, "friend-1", "dinner is at 7")])).toEqual([])
    expect(surfacesReachedLater([surface(notSent, "friend-1", ""), surface(reached, "friend-1", "")])).toEqual([])
    expect(surfacesReachedLater([surface(notSent, "friend-1"), { name: "send_message", args: { friendId: "friend-1" }, result: "delivered now" }])).toEqual([])
    // Only the copies saved since those words last reached them.
    expect(surfacesReachedLater([surface(notSent, "friend-1"), surface(reached, "friend-1"), surface(notSent, "friend-1"), surface(reached, "friend-1")]))
      .toEqual([{ friendId: "friend-1", content: "the news" }])
    // A surface addressed by delegationId names no friend, so nothing is withdrawn for it.
    expect(surfacesReachedLater([{ name: "surface", args: { content: "x" }, result: notSent }, { name: "surface", args: { content: "x" }, result: reached }])).toEqual([])
  })

  it("rest goes through at once when the turn reached the same friend another way after an unsent surface", async () => {
    mockCreate.mockReturnValueOnce(makeStream(toolCallChunks("call_surface", "surface", { content: "Your sign-in is done.", friendId: "friend-1" })))
    mockCreate.mockReturnValueOnce(makeStream(toolCallChunks("call_surface_2", "surface", { content: "Your sign-in is done.", friendId: "friend-1", channel: "voice" })))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))
    const execTool = vi.fn(async (_name: string, args: Record<string, string>) => args.channel === "voice" ? "delivered — voice call initiated" : notSent)

    const callbacks = makeCallbacks()
    await runAgent([{ role: "user", content: "an agent says Robin's sign-in is done" }], callbacks, "inner", undefined, {
      tools: [surfaceTestTool],
      execTool,
      toolContext: { currentSession: { friendId: "self", channel: "inner", key: "dialog" }, delegatedOrigins: [] },
    })

    expect(mockCreate).toHaveBeenCalledTimes(3)
    const restEnds = (callbacks.onToolEnd as any).mock.calls.filter((c: any[]) => c[0] === "rest")
    expect(restEnds.map((c: any[]) => c[2])).toEqual([true])
    // The call reached them, so the copy saved for their next message is withdrawn.
    expect(mockWithdrawDeferredReturn).toHaveBeenCalledWith("testagent", "friend-1", "Your sign-in is done.")
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
    // Second call: a valid sole rest ends the private-runtime loop
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

    // Rest was rejected as sole-call violation, then rested
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  // ── Tool filtering ──────────────────────────────────

  it("rest is available in private runtime tool set", async () => {
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

  it("settle is NOT available in private runtime tool set (replaced by rest)", async () => {
    // Settle in private runtime should be rejected -- it's not in the tool set
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

    // Check that the tools sent to the model don't include "settle" for private runtime
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

  it("rest rejects malformed JSON arguments before handling", async () => {
    // Stream a rest call with invalid JSON arguments
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_rest", function: { name: "rest", arguments: "" } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: "not json" } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream(restToolCallChunks()))

    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "heartbeat" }]
    const result = await runAgent(
      messages,
      callbacks,
      "inner",
      undefined,
      {
        toolContext: {
          currentSession: { friendId: "self", channel: "inner", key: "dialog" },
        },
      },
    )

    expect(JSON.stringify(messages)).not.toContain("malformed JSON")
    expect(JSON.stringify(mockCreate.mock.calls[1][0].messages)).toContain("malformed JSON")
    expect(result.outcome).toBe("rested")
  })

  it("rest from private runtime with no toolContext succeeds (no attention queue)", async () => {
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

  it("forces the unresolved mutation from the exact five-request Sanctuary chronology until it succeeds", async () => {
    const request = "Books can stay off when I'm not using it. Stop treating that as broken."
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("Got it. The minute the policy lane is healthy, I'll write the rule and confirm done.", undefined),
    ]))
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_current_policy_read", function: { name: "steward_policy_manage", arguments: JSON.stringify({ action: "read" }) } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_current_policy", function: { name: "steward_policy_manage", arguments: "" } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: JSON.stringify({ action: "set_desired_state", key: "container:calibre", value: "intentionally_off", provenance: "stated", source: request, expectedVersion: 0 }) } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Got it. Books may stay quietly off until you ask for it.")))

    const execTool = vi.fn(async (name: string, args: Record<string, string>) => name === "steward_policy_manage"
      ? args.action === "read"
        ? JSON.stringify({ version: 0, desiredStates: {} })
        : JSON.stringify({ version: 1, desiredStates: { "container:calibre": { value: "intentionally_off" } } })
      : "unexpected")
    const callbacks = makeCallbacks({ settleOutputMode: "retractable_buffer" })
    const messages: any[] = [
      { role: "user", content: request },
      { role: "assistant", tool_calls: [{ id: "call_old_custom", type: "custom", custom: { name: "legacy_custom", input: "probe" } }] },
      { role: "tool", tool_call_id: "call_old_custom", content: "error: unrelated custom failure" },
      { role: "assistant", tool_calls: [{ id: "call_old_policy_read", type: "function", function: { name: "steward_policy_manage", arguments: JSON.stringify({ action: "read" }) } }] },
      { role: "tool", tool_call_id: "call_old_policy_read", content: JSON.stringify({ version: 0, desiredStates: {} }) },
      { role: "assistant", tool_calls: [{ id: "call_old_policy", type: "function", function: { name: "steward_policy_manage", arguments: JSON.stringify({ action: "set_desired_state", key: "container:calibre", value: "intentionally_off", provenance: "stated", source: request }) } }] },
      { role: "tool", tool_call_id: "call_old_policy", content: "error: expectedVersion must be a nonnegative integer" },
      { role: "assistant", content: "The policy runtime is down; I tried twice." },
      { role: "user", content: request },
      { role: "assistant", content: "I still can't write the official policy because the policy runtime is down." },
      { role: "user", content: request },
      { role: "assistant", content: "The lane still looks unavailable to me." },
      { role: "user", content: request },
      { role: "assistant", content: "I'll write it when the lane is healthy." },
      { role: "user", content: request },
    ]

    await runAgent(messages, callbacks, "telegram", undefined, {
      tools: [{
        type: "function",
        function: {
          name: "steward_policy_manage",
          description: "Manage steward policy",
          parameters: { type: "object", properties: { action: { type: "string" }, key: { type: "string" }, value: { type: "string" }, provenance: { type: "string" }, source: { type: "string" }, expectedVersion: { type: "integer" } }, required: ["action"], additionalProperties: false },
        },
      }],
      execTool,
      toolContext: {
        currentSession: { friendId: "ari", channel: "telegram", key: "direct" },
      },
    })

    expect(mockCreate).toHaveBeenCalledTimes(4)
    expect(execTool).toHaveBeenNthCalledWith(1, "steward_policy_manage", { action: "read" }, expect.anything())
    expect(execTool).toHaveBeenCalledWith("steward_policy_manage", expect.objectContaining({ action: "set_desired_state" }), expect.anything())
    const retryMessages = mockCreate.mock.calls[1]?.[0]?.messages as any[]
    const corrective = retryMessages.find((message) => message.role === "user" && String(message.content).startsWith("this exact request previously reached"))
    expect(corrective?.content).toContain("steward_policy_manage")
    expect(corrective?.content).toContain("historical")
    expect(mockCreate.mock.calls[0]?.[0]?.tools.map((tool: any) => tool.function.name)).toEqual(["steward_policy_manage"])
    expect(mockCreate.mock.calls[0]?.[0]?.tool_choice).toBe("required")
    expect(mockCreate.mock.calls[2]?.[0]?.tools.map((tool: any) => tool.function.name)).toEqual(["steward_policy_manage"])
    expect(mockCreate.mock.calls[3]?.[0]?.tools.map((tool: any) => tool.function.name)).toContain("settle")
    expect(callbacks.onClearText).toHaveBeenCalled()
    expect(vi.mocked(emitNervesEvent).mock.calls.some(([event]) => (event as any).event === "engine.historical_tool_failure_retry")).toBe(true)
  })

  it("fails closed instead of delivering stale prose when an unresolved historical mutation never produces a tool call", async () => {
    const request = "Keep Books off."
    for (let index = 0; index < 3; index += 1) {
      mockCreate.mockReturnValueOnce(makeStream([makeChunk("I'll update that when the lane is healthy.", undefined)]))
    }
    const callbacks = makeCallbacks({ settleOutputMode: "retractable_buffer" })
    const result = await runAgent([
      { role: "user", content: request },
      { role: "assistant", tool_calls: [{ id: "call_failed", type: "function", function: { name: "steward_policy_manage", arguments: JSON.stringify({ action: "set_desired_state", key: "container:calibre", value: "intentionally_off", provenance: "stated", source: request }) } }] },
      { role: "tool", tool_call_id: "call_failed", content: "error: expectedVersion must be a nonnegative integer" },
      { role: "assistant", content: "It failed." },
      { role: "user", content: request },
    ] as any[], callbacks, "telegram", undefined, {
      tools: [{ type: "function", function: { name: "steward_policy_manage", description: "Manage steward policy", parameters: { type: "object", properties: {} } } }],
      execTool: vi.fn(),
    })

    expect(mockCreate).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ outcome: "blocked", completion: { intent: "blocked" } })
    expect(callbacks.onTextChunk).toHaveBeenCalledWith(expect.stringContaining("I could not finish the change that failed earlier"))
    expect(result.completion?.answer).not.toContain("lane is healthy")
    // People never see raw tool names, and Telegram would render their underscores as italics.
    expect(result.completion?.answer).not.toContain("steward_policy_manage")
    expect(result.completion?.answer).not.toContain("_")
  })

  const restartTool = { type: "function" as const, function: { name: "unraid_restart_container", description: "Restart one container", parameters: { type: "object", properties: { container: { type: "string" } }, required: ["container"] } } }
  const restartRequest = "please restart flaresolverr"
  const restartCall = (id: string) => ({ role: "assistant", tool_calls: [{ id, type: "function", function: { name: "unraid_restart_container", arguments: JSON.stringify({ container: "flaresolverr" }) } }] })
  const earlierFailedRestart = [
    { role: "user", content: restartRequest },
    restartCall("call_old"),
    { role: "tool", tool_call_id: "call_old", content: "error: restart approval authority is invalid" },
    { role: "assistant", content: "I couldn't restart flaresolverr." },
    { role: "user", content: restartRequest },
  ]

  it("treats an effect the approval runtime already ran in this turn as resolved, so the reply can report it", async () => {
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("restarted flaresolverr. it's back up.")))
    const callbacks = makeCallbacks()
    const result = await runAgent([
      ...earlierFailedRestart,
      restartCall("call_approved"),
      { role: "tool", tool_call_id: "call_approved", content: JSON.stringify({ ok: true, data: { container: { name: "flaresolverr" }, observedRestart: true } }) },
    ] as any[], callbacks, "telegram", undefined, { tools: [restartTool], execTool: vi.fn() })

    // Not narrowed to re-running the restart: settle is on offer, so the model can report the result.
    expect(mockCreate.mock.calls[0]?.[0]?.tools.map((tool: any) => tool.function.name)).toContain("settle")
    expect(result).toMatchObject({ outcome: "settled", completion: { answer: "restarted flaresolverr. it's back up." } })
    expect(vi.mocked(emitNervesEvent).mock.calls.some(([event]) => (event as any).event === "engine.historical_tool_failure_retry")).toBe(false)
  })

  it("still forces the effect when its run in this turn failed again", async () => {
    for (let index = 0; index < 3; index += 1) mockCreate.mockReturnValueOnce(makeStream([makeChunk("it'll work later.", undefined)]))
    const callbacks = makeCallbacks({ settleOutputMode: "retractable_buffer" })
    const result = await runAgent([
      ...earlierFailedRestart,
      restartCall("call_again"),
      { role: "tool", tool_call_id: "call_again", content: "error: restart approval authority is invalid" },
    ] as any[], callbacks, "telegram", undefined, { tools: [restartTool], execTool: vi.fn() })

    expect(mockCreate.mock.calls[0]?.[0]?.tools.map((tool: any) => tool.function.name)).toEqual(["unraid_restart_container"])
    expect(result).toMatchObject({ outcome: "blocked", completion: { intent: "blocked" } })
  })

  it("rejects a different mutation while forcing an unresolved historical effect", async () => {
    const request = "Keep Books off."
    const desiredEffect = { action: "set_desired_state", key: "container:calibre", value: "intentionally_off", provenance: "stated", source: request }
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_wrong_policy", function: { name: "steward_policy_manage", arguments: JSON.stringify({ ...desiredEffect, key: "container:jellyfin" }) } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_right_policy", function: { name: "steward_policy_manage", arguments: JSON.stringify({ ...desiredEffect, expectedVersion: 3 }) } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Books may stay off.")))
    const execTool = vi.fn(async () => JSON.stringify({ version: 4 }))
    const generated: any[][] = []

    await runAgent([
      { role: "user", content: request },
      { role: "assistant", tool_calls: [{ id: "call_failed", type: "function", function: { name: "steward_policy_manage", arguments: JSON.stringify(desiredEffect) } }] },
      { role: "tool", tool_call_id: "call_failed", content: "error: expectedVersion must be a nonnegative integer" },
      { role: "assistant", content: "It failed." },
      { role: "user", content: request },
    ] as any[], makeCallbacks(), "telegram", undefined, {
      tools: [{ type: "function", function: { name: "steward_policy_manage", description: "Manage steward policy", parameters: { type: "object", properties: { action: { type: "string" }, key: { type: "string" }, value: { type: "string" }, provenance: { type: "string" }, source: { type: "string" }, expectedVersion: { type: "integer" } }, required: ["action"], additionalProperties: false } } }],
      execTool,
      captureGeneratedMessages: (messages) => generated.push(messages as any[]),
    })

    expect(execTool).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledWith("steward_policy_manage", expect.objectContaining({ key: "container:calibre", expectedVersion: 3 }), expect.anything())
    expect(JSON.stringify(generated)).not.toContain("call_wrong_policy")
    expect(JSON.stringify(mockCreate.mock.calls[1][0].messages)).toContain("call_wrong_policy")
    expect(JSON.stringify(mockCreate.mock.calls[1][0].messages)).toContain("do not match")
  })

  it("keeps forcing a matching effect after a non-throwing relationship denial", async () => {
    const request = "Keep Books off."
    const desiredEffect = { action: "set_desired_state", key: "container:calibre", value: "intentionally_off", provenance: "stated", source: request }
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_denied_policy", function: { name: "steward_policy_manage", arguments: JSON.stringify(desiredEffect) } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_retried_policy", function: { name: "steward_policy_manage", arguments: JSON.stringify({ ...desiredEffect, expectedVersion: 4 }) } }]),
    ]))
    mockCreate.mockReturnValueOnce(makeStream(settleChunks("Books may stay off.")))
    const execTool = vi.fn()
      .mockResolvedValueOnce("relationship authorization required: revoked")
      .mockResolvedValueOnce(JSON.stringify({ version: 5 }))

    await runAgent([
      { role: "user", content: request },
      { role: "assistant", tool_calls: [{ id: "call_failed", type: "function", function: { name: "steward_policy_manage", arguments: JSON.stringify(desiredEffect) } }] },
      { role: "tool", tool_call_id: "call_failed", content: "error: expectedVersion must be a nonnegative integer" },
      { role: "assistant", content: "It failed." },
      { role: "user", content: request },
    ] as any[], makeCallbacks(), "telegram", undefined, {
      tools: [{ type: "function", function: { name: "steward_policy_manage", description: "Manage steward policy", parameters: { type: "object", properties: { action: { type: "string" }, key: { type: "string" }, value: { type: "string" }, provenance: { type: "string" }, source: { type: "string" }, expectedVersion: { type: "integer" } }, required: ["action"], additionalProperties: false } } }],
      execTool,
    })

    expect(execTool).toHaveBeenCalledTimes(2)
    expect(mockCreate.mock.calls[1]?.[0]?.tools.map((tool: any) => tool.function.name)).toEqual(["steward_policy_manage"])
    expect(mockCreate.mock.calls[2]?.[0]?.tools.map((tool: any) => tool.function.name)).toContain("settle")
  })

  it("does not retry a historical tool failure for a different current request", async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("Here is a plain answer for the new request.", undefined),
    ]))
    const execTool = vi.fn()
    await runAgent([
      { role: "user", content: "Keep Books off." },
      { role: "assistant", tool_calls: [{ id: "call_old_policy", type: "function", function: { name: "steward_policy_manage", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_old_policy", content: "error: old failure" },
      { role: "assistant", content: "It failed." },
      { role: "user", content: "How much storage is free?" },
    ] as any[], makeCallbacks(), "telegram", undefined, {
      tools: [{ type: "function", function: { name: "steward_policy_manage", description: "Manage steward policy", parameters: { type: "object", properties: {} } } }],
      execTool,
    })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(vi.mocked(emitNervesEvent).mock.calls.some(([event]) => (event as any).event === "engine.historical_tool_failure_retry")).toBe(false)
  })

  it("does not retry an exact historical failure when the failed tool is no longer advertised", async () => {
    const request = "Keep Books off."
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("I cannot change that from this turn.", undefined),
    ]))
    const execTool = vi.fn()
    await runAgent([
      { role: "user", content: request },
      { role: "assistant", tool_calls: [{ id: "call_old_policy", type: "function", function: { name: "steward_policy_manage", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_old_policy", content: "error: old failure" },
      { role: "assistant", content: "It failed." },
      { role: "user", content: request },
    ] as any[], makeCallbacks(), "telegram", undefined, {
      tools: [{ type: "function", function: { name: "unraid_list_containers", description: "List containers", parameters: { type: "object", properties: {} } } }],
      execTool,
    })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(vi.mocked(emitNervesEvent).mock.calls.some(([event]) => (event as any).event === "engine.historical_tool_failure_retry")).toBe(false)
  })

  it("ignores malformed and non-object historical mutation arguments", async () => {
    const request = "Keep Books off."
    mockCreate.mockReturnValueOnce(makeStream([makeChunk("Please try that again.", undefined)]))
    const execTool = vi.fn()

    await runAgent([
      { role: "user", content: request },
      { role: "assistant", tool_calls: [
        { id: "call_malformed", type: "function", function: { name: "steward_policy_manage", arguments: "{" } },
        { id: "call_null", type: "function", function: { name: "steward_policy_manage", arguments: "null" } },
        { id: "call_scalar", type: "function", function: { name: "steward_policy_manage", arguments: JSON.stringify("text") } },
        { id: "call_array", type: "function", function: { name: "steward_policy_manage", arguments: "[]" } },
      ] },
      { role: "tool", tool_call_id: "call_malformed", content: "invalid tool arguments: malformed JSON (code: invalid-arguments)" },
      { role: "tool", tool_call_id: "call_null", content: "invalid tool arguments: expected object (code: invalid-arguments)" },
      { role: "tool", tool_call_id: "call_scalar", content: "invalid tool arguments: expected object (code: invalid-arguments)" },
      { role: "tool", tool_call_id: "call_array", content: "invalid tool arguments: expected object (code: invalid-arguments)" },
      { role: "assistant", content: "It failed." },
      { role: "user", content: request },
    ] as any[], makeCallbacks(), "telegram", undefined, {
      tools: [{ type: "function", function: { name: "steward_policy_manage", description: "Manage steward policy", parameters: { type: "object", properties: {} } } }],
      execTool,
    })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
  })

  it("does not retry an exact request when the failed tool later succeeded", async () => {
    const request = "Keep Books off."
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("The steward runtime is down again.", undefined),
    ]))
    const execTool = vi.fn()
    await runAgent([
      { role: "user", content: request },
      { role: "assistant", tool_calls: [{ id: "call_failed", type: "function", function: { name: "steward_policy_manage", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_failed", content: "error: transient failure" },
      { role: "assistant", tool_calls: [{ id: "call_succeeded", type: "function", function: { name: "steward_policy_manage", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_succeeded", content: JSON.stringify({ version: 1, desiredStates: { "container:calibre": { value: "intentionally_off" } } }) },
      { role: "assistant", content: "Books may stay off." },
      { role: "user", content: request },
      { role: "assistant", content: "The steward runtime is down again." },
      { role: "user", content: request },
    ] as any[], makeCallbacks(), "telegram", undefined, {
      tools: [{ type: "function", function: { name: "steward_policy_manage", description: "Manage steward policy", parameters: { type: "object", properties: {} } } }],
      execTool,
    })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(vi.mocked(emitNervesEvent).mock.calls.some(([event]) => (event as any).event === "engine.historical_tool_failure_retry")).toBe(false)
  })

  it("retries with the private-runtime corrective when channel is inner", async () => {
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
    // The pushed corrective message should reference rest (private-runtime wording),
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
