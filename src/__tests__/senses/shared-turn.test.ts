import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { a003Event, a003Marker } from "../fixtures/a003-session"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks } from "../../heart/core"
import type { FriendRecord, ResolvedContext, Channel, ChannelCapabilities } from "@ouro.bot/friends"
import type { InboundTurnResult } from "../../senses/pipeline"
import { getIngressRelations, type SessionEvent, type SessionEventToolCall } from "../../heart/session-events"

// ── Mocks ──────────────────────────────────────────────────────

const mockHandleInboundTurn = vi.fn()
const mockReadSessionTransaction = vi.fn(() => ({ bytes: "", value: null, revision: "revision-a" }))
const mockWithSessionTurnLease = vi.fn(async (_sessionPath: string, work: (lease: any) => Promise<any>) => work({
  sessionPath: "/tmp/session.json",
  ownerId: "owner-a",
  ownerToken: "token-a",
  release: vi.fn(),
}))

vi.mock("../../mind/session-transaction", () => ({
  withSessionTurnLease: (...args: any[]) => mockWithSessionTurnLease(...args),
  readSessionTransaction: (...args: any[]) => mockReadSessionTransaction(...args),
}))

vi.mock("../../senses/pipeline", async () => {
  const actual = await vi.importActual<typeof import("../../senses/pipeline")>("../../senses/pipeline")
  return {
    ...actual,
    handleInboundTurn: (...args: any[]) => mockHandleInboundTurn(...args),
  }
})

const mockGetProvider = vi.fn().mockReturnValue("anthropic")
const mockRunAgent = vi.fn()
const mockBuildSystem = vi.fn().mockResolvedValue({ stable: "system prompt", volatile: "" })

vi.mock("../../heart/core", async () => {
  const actual = await vi.importActual<typeof import("../../heart/core")>("../../heart/core")
  return {
    ...actual,
    getProvider: (...args: any[]) => mockGetProvider(...args),
    runAgent: (...args: any[]) => mockRunAgent(...args),
  }
})

vi.mock("../../mind/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../mind/prompt")>("../../mind/prompt")
  return {
    ...actual,
    buildSystem: (...args: any[]) => mockBuildSystem(...args),
  flattenSystemPrompt: (sp: any) => [sp?.stable, sp?.volatile].filter(Boolean).join("\n\n"),
  }
})

const mockSessionPath = vi.fn().mockReturnValue("/tmp/session.json")

vi.mock("../../heart/config", async () => {
  const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config")
  return {
    ...actual,
    sessionPath: (...args: any[]) => mockSessionPath(...args),
  }
})

const mockLoadSession = vi.fn().mockReturnValue(null)
const mockDeferPostTurnPersist = vi.fn().mockResolvedValue([])

vi.mock("../../mind/context", async () => {
  const actual = await vi.importActual<typeof import("../../mind/context")>("../../mind/context")
  return {
    ...actual,
    loadSession: (...args: any[]) => mockLoadSession(...args),
    deferPostTurnPersist: (...args: any[]) => mockDeferPostTurnPersist(...args),
  }
})

const mockGetPendingDir = vi.fn().mockReturnValue("/tmp/pending")
const mockDrainPending = vi.fn().mockReturnValue([])

vi.mock("../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../mind/pending")>("../../mind/pending")
  return {
    ...actual,
    getPendingDir: (...args: any[]) => mockGetPendingDir(...args),
    drainPending: (...args: any[]) => mockDrainPending(...args),
  }
})

const mockGetAgentName = vi.fn().mockReturnValue("test-agent")
const mockGetAgentRoot = vi.fn().mockReturnValue("/tmp/test-agent")
const mockLoadAgentConfig = vi.fn().mockReturnValue({ provider: "anthropic" })
const mockSetAgentName = vi.fn()

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: (...args: any[]) => mockGetAgentName(...args),
    getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
    loadAgentConfig: (...args: any[]) => mockLoadAgentConfig(...args),
    setAgentName: (...args: any[]) => mockSetAgentName(...args),
  }
})

const mockGetChannelCapabilities = vi.fn().mockReturnValue({
  channel: "mcp",
  senseType: "local",
  availableIntegrations: [],
  supportsMarkdown: false,
  supportsStreaming: false,
  supportsRichCards: false,
  maxMessageLength: Infinity,
})

const mockFriendResolve = vi.fn()

const mockStoreInstance = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  findByExternalId: vi.fn().mockResolvedValue(null),
  hasAnyFriends: vi.fn().mockResolvedValue(true),
  listAll: vi.fn().mockResolvedValue([]),
}

// The friend model now lives in the @ouro.bot/friends package, which exposes a
// single module (the barrel). The previously separate channel/resolver/store-file
// mocks are merged into one mock of the package, overriding the same three symbols.
vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    getChannelCapabilities: (...args: any[]) => mockGetChannelCapabilities(...args),
    FriendResolver: vi.fn().mockImplementation(function () { return { resolve: (...args: any[]) => mockFriendResolve(...args) } }),
    FileFriendStore: vi.fn().mockImplementation(function () { return mockStoreInstance }),
  }
})

const mockGetSharedMcpManager = vi.fn().mockResolvedValue(null)
const mockReleaseRuntimeMcpServers = vi.fn().mockResolvedValue(undefined)

vi.mock("../../repertoire/mcp-manager", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/mcp-manager")>("../../repertoire/mcp-manager")
  return {
    ...actual,
    getSharedMcpManager: (...args: any[]) => mockGetSharedMcpManager(...args),
    releaseRuntimeMcpServers: (...args: any[]) => mockReleaseRuntimeMcpServers(...args),
  }
})

beforeAll(async () => {
  await import("../../senses/shared-turn")
}, 120_000)

// ── Helpers ────────────────────────────────────────────────────

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

function makeMcpCapabilities(): ChannelCapabilities {
  return {
    channel: "mcp",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }
}

function makeResolvedContext(): ResolvedContext {
  return { friend: makeFriend(), channel: makeMcpCapabilities() }
}

function makeSessionEvent(input: {
  id: string
  sequence: number
  role: SessionEvent["role"]
  content?: SessionEvent["content"]
  toolCallId?: string | null
  toolCalls?: SessionEventToolCall[]
  captureKind?: SessionEvent["provenance"]["captureKind"]
  references?: string[]
}): SessionEvent {
  return {
    id: input.id,
    sequence: input.sequence,
    role: input.role,
    content: input.content ?? null,
    name: null,
    toolCallId: input.toolCallId ?? null,
    toolCalls: input.toolCalls ?? [],
    attachments: [],
    time: {
      authoredAt: null,
      authoredAtSource: "unknown",
      observedAt: null,
      observedAtSource: "unknown",
      recordedAt: "2026-09-06T16:00:00.000Z",
      recordedAtSource: "save",
    },
    relations: {
      replyToEventId: null,
      threadRootEventId: null,
      references: input.references ?? [],
      toolCallId: input.toolCallId ?? null,
      supersedesEventId: null,
      redactsEventId: null,
    },
    provenance: {
      captureKind: input.captureKind ?? "live",
      legacyVersion: null,
      sourceMessageIndex: null,
    },
  }
}

function makeToolCall(id: string, name: string, args: Record<string, unknown> | string): SessionEventToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }
}

function makeSessionEnvelopeValue(events: SessionEvent[]): Record<string, unknown> {
  return {
    version: 2,
    events,
    projection: { eventIds: events.map((event) => event.id), trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
    structuredOutputs: [],
    lastUsage: null,
    state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
  }
}

function mockSessionTransaction(events: SessionEvent[], projectionEventIds = events.map((event) => event.id)): void {
  const value = makeSessionEnvelopeValue(events)
  ;(value.projection as { eventIds: string[] }).eventIds = projectionEventIds
  mockReadSessionTransaction.mockReturnValue({ bytes: JSON.stringify(value), value, revision: "revision-a" })
}

async function mockActualSessionEnvelope(filePath: string, value: Record<string, unknown>): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value))
  const actualContext = await vi.importActual<typeof import("../../mind/context")>("../../mind/context")
  mockLoadSession.mockReset().mockImplementation((candidatePath: string) => actualContext.loadSession(candidatePath))
  mockReadSessionTransaction.mockReset().mockImplementation((candidatePath: string) => {
    const bytes = fs.readFileSync(candidatePath, "utf8")
    return { bytes, value: JSON.parse(bytes), revision: "revision-a" }
  })
}


// Set up default handleInboundTurn mock that simulates a settle with text response
function setupSettledTurn(text: string = "hello from the agent") {
  mockHandleInboundTurn.mockImplementation(async (input: any) => {
    // Simulate the pipeline calling onTextChunk and then settling
    if (input.callbacks?.onTextChunk) {
      input.callbacks.onTextChunk(text)
    }
    const result: InboundTurnResult = {
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 0, total_tokens: 150 },
      turnOutcome: "settled",
      completion: { answer: text, intent: "complete" },
      sessionPath: "/tmp/session.json",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
        { role: "assistant", content: text },
      ],
    }
    return result
  })
}

// ── Tests ──────────────────────────────────────────────────────

describe("extractOutwardSenseDeliveryText", () => {
  it("derives the session path from the canonical agent root when no override is supplied", async () => {
    const { getSenseSessionPath } = await import("../../senses/shared-turn")
    expect(getSenseSessionPath("test-agent", "friend", "telegram", "telegram:1:2"))
      .toBe("/tmp/test-agent/state/sessions/friend/telegram/telegram_1_2.json")
  })

  it("prefers latest assistant content when present", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "older answer" },
      { role: "user", content: "new question" },
      { role: "assistant", content: "latest visible answer" },
    ]

    expect(extractOutwardSenseDeliveryText(messages)).toBe("latest visible answer")
  })

  it("recovers tool-required outward delivery from acknowledged settle and speak calls", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_speak",
            type: "function",
            function: {
              name: "speak",
              arguments: JSON.stringify({ message: "quick update" }),
            },
          },
          {
            id: "call_settle",
            type: "function",
            function: {
              name: "settle",
              arguments: JSON.stringify({ answer: "final answer", intent: "complete" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_speak", content: "(spoken)" },
      { role: "tool", tool_call_id: "call_settle", content: "(delivered)" },
    ]

    expect(extractOutwardSenseDeliveryText(messages)).toBe("quick update\nfinal answer")
  })

  it("does not treat private-runtime settle ack as outward delivery", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_settle",
          type: "function",
          function: {
            name: "settle",
            arguments: JSON.stringify({ answer: "private inner text", intent: "complete" }),
          },
        }],
      },
      { role: "tool", tool_call_id: "call_settle", content: "(settled)" },
    ]

    expect(extractOutwardSenseDeliveryText(messages)).toBeNull()
  })

  it("rejects unacknowledged delivery tool calls once another message starts", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_speak",
          type: "function",
          function: {
            name: "speak",
            arguments: JSON.stringify({ message: "not actually spoken" }),
          },
        }],
      },
      { role: "user", content: "new turn before ack" },
      { role: "tool", tool_call_id: "call_speak", content: "(spoken)" },
    ]

    expect(extractOutwardSenseDeliveryText(messages)).toBeNull()
  })

  it("returns null when no assistant message exists", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")

    expect(extractOutwardSenseDeliveryText([{ role: "user", content: "hello" }])).toBeNull()
  })

  it("does not recover prose attached to an ordinary tool call as outward speech", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: "Current draft",
        tool_calls: [{ id: "read-1", type: "function", function: { name: "sanctuary_search_media_catalog", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "read-1", content: "{}" },
    ]

    expect(extractOutwardSenseDeliveryText(messages)).toBeNull()
  })

  it("treats non-text and blank assistant content as no outward speech", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")

    expect(extractOutwardSenseDeliveryText([{ role: "assistant", content: null }])).toBeNull()
    expect(extractOutwardSenseDeliveryText([{ role: "assistant", content: "   " }])).toBeNull()
  })

  it("rejects malformed outward tool entries and arguments", async () => {
    const { extractOutwardSenseDeliveryText } = await import("../../senses/shared-turn")
    const malformed = {
      role: "assistant",
      content: null,
      tool_calls: [
        null,
        { id: "array-args", type: "function", function: { name: "settle", arguments: "[]" } },
        { id: "blank-answer", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "   " }) } },
        { id: 17, type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "not acknowledged" }) } },
      ],
    } as unknown as ChatCompletionMessageParam

    expect(extractOutwardSenseDeliveryText([malformed])).toBeNull()
  })
})

describe("runSenseTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSessionTransaction.mockReset().mockReturnValue({ bytes: "", value: null, revision: "revision-a" })
    mockLoadSession.mockReset()
    mockLoadSession.mockReturnValue(null)
    mockDeferPostTurnPersist.mockReset().mockResolvedValue([])
    mockReleaseRuntimeMcpServers.mockReset().mockResolvedValue(undefined)
    setupSettledTurn()
    mockFriendResolve.mockResolvedValue(makeResolvedContext())
    mockWithSessionTurnLease.mockReset().mockImplementation(async (_sessionPath: string, work: (lease: any) => Promise<any>) => work({
      sessionPath: "/tmp/session.json",
      ownerId: "owner-a",
      ownerToken: "token-a",
      release: vi.fn(),
    }))
  })

  it("carries authenticated ingress relations on the synthesized user message", async () => {
    const ingressRelations = {
      replyToEventId: "evt-000010",
      threadRootEventId: "evt-000001",
      references: ["telegram-artifact:abc"],
    }
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-user", role: "user", content: "hello", relations: ingressRelations, toolCalls: [] },
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      const { getIngressRelations } = await import("../../heart/session-events")
      expect(getIngressRelations(input.messages[0])).toEqual(ingressRelations)
      input.callbacks.onTextChunk("hello from the agent")
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        completion: { answer: "hello from the agent", intent: "complete" },
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      ingressRelations,
    })

    expect(result.response).toBe("hello from the agent")
  })

  it("behaviorally holds the session lease before load through persistence and accepted delivery", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    mockWithSessionTurnLease.mockImplementationOnce(async (_sessionPath: string, work: (lease: any) => Promise<any>) => {
      order.push("lease:acquired")
      entered.resolve()
      await release.promise
      const result = await work({ sessionPath: "/tmp/session.json", ownerId: "owner-a", ownerToken: "token-a", release: vi.fn() })
      order.push("lease:released")
      return result
    })
    mockReadSessionTransaction.mockImplementation(() => { order.push("session:read"); return { bytes: "", value: null, revision: "revision-a" } })
    mockLoadSession.mockImplementation(() => { order.push("session:load"); return null })
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      order.push("provider:start")
      input.callbacks.onTextChunk("delivered")
      await input.postTurn([], "/tmp/session.json")
      order.push("session:persist")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "delivered", intent: "complete" }, messages: [] }
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const running = runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: () => { order.push("outward:delivered") } },
    })
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("lease was not acquired")), 100))])
    expect(mockLoadSession).not.toHaveBeenCalled()
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
    release.resolve()
    await running

    expect(order).toEqual([
      "lease:acquired",
      "session:read",
      "session:load",
      "provider:start",
      "session:persist",
      "session:read",
      "outward:delivered",
      "lease:released",
    ])
  })

  it("sets the requested agent identity inside the whole-turn execution lease", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(mockSetAgentName).toHaveBeenCalledWith("test-agent")
    expect(mockSetAgentName.mock.invocationCallOrder[0]).toBeLessThan(mockGetSharedMcpManager.mock.invocationCallOrder[0])
  })

  it("serializes MCP setup across concurrent shared turns", async () => {
    const firstMcpEntered = Promise.withResolvers<void>()
    const releaseFirstMcp = Promise.withResolvers<void>()
    let mcpCalls = 0
    mockGetSharedMcpManager.mockImplementation(async () => {
      mcpCalls += 1
      if (mcpCalls === 1) {
        firstMcpEntered.resolve()
        await releaseFirstMcp.promise
      }
      return null
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const first = runSenseTurn({
      agentName: "first-agent",
      channel: "mcp",
      sessionKey: "first-session",
      friendId: "friend-1",
      userMessage: "first",
    })
    await firstMcpEntered.promise

    const second = runSenseTurn({
      agentName: "second-agent",
      channel: "mcp",
      sessionKey: "second-session",
      friendId: "friend-1",
      userMessage: "second",
    })
    await Promise.resolve()
    expect(mcpCalls).toBe(1)

    releaseFirstMcp.resolve()
    await Promise.all([first, second])
    expect(mcpCalls).toBe(2)
  })

  it("returns response text from a settled turn", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toBe("hello from the agent")
    expect(result.ponderDeferred).toBe(false)
    expect(result.turnOutcome).toBe("settled")
  })

  it("passes cancellation to the pipeline and does not deliver partial aborted output", async () => {
    const controller = new AbortController()
    const onDelivery = vi.fn()
    const emptyResponseFallback = vi.fn(() => "fallback")
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      expect(input.signal).toBe(controller.signal)
      input.callbacks.onTextChunk("partial")
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "aborted",
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      signal: controller.signal,
      deliverySink: { onDelivery },
      emptyResponseFallback,
    })

    expect(result.turnOutcome).toBe("aborted")
    expect(result.response).toBe("")
    expect(result.deliveries).toEqual([])
    expect(onDelivery).not.toHaveBeenCalled()
    expect(emptyResponseFallback).not.toHaveBeenCalled()
    expect(mockDeferPostTurnPersist).toHaveBeenCalled()
  })

  it("emits normalized live frontend events and every outward delivery", async () => {
    const events: any[] = []
    const structuredOutput = {
      schemaVersion: 1,
      id: "structured-1",
      kind: "ordered_list",
      sourceEventId: "event-1",
      recordedAt: "2026-09-03T20:00:00.000Z",
      items: [{ label: "1", text: "First" }],
    }
    mockDeferPostTurnPersist.mockImplementationOnce(async () => {
      mockLoadSession.mockReturnValue({ messages: [], structuredOutputs: [structuredOutput] })
      return []
    })
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onModelStart()
      input.callbacks.onModelStreamStart()
      input.callbacks.onTextChunk("first")
      input.callbacks.onReasoningChunk("thinking")
      input.callbacks.onToolStart("read_file", { path: "/tmp/a" })
      input.callbacks.onToolEnd("read_file", "ok", true)
      input.callbacks.onError(new Error("transient"), "transient")
      await input.callbacks.flushNow()
      input.callbacks.onClearText()
      input.callbacks.onTextChunk("second")
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        completion: { answer: "second", intent: "direct_reply" },
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      frontendEventSink: { onEvent: (event) => events.push(event) },
    })

    expect(events).toEqual([
      { type: "model_started", data: {} },
      { type: "model_stream_started", data: {} },
      { type: "text_delta", data: { text: "first" } },
      { type: "reasoning_delta", data: { text: "thinking" } },
      { type: "tool_started", data: { name: "read_file", args: { path: "/tmp/a" } } },
      { type: "tool_completed", data: { name: "read_file", summary: "ok", success: true } },
      { type: "error", data: { message: "transient", severity: "transient" } },
      { type: "assistant_delivery", data: { kind: "speak", text: "first" } },
      { type: "text_cleared", data: {} },
      { type: "text_delta", data: { text: "second" } },
      { type: "structured_output", data: { output: structuredOutput } },
      { type: "assistant_delivery", data: { kind: "text", text: "second" } },
    ])
  })

  it("does not re-emit structured output that already existed before the turn", async () => {
    const existingOutput = {
      schemaVersion: 1,
      id: "structured-existing",
      kind: "ordered_list",
      sourceEventId: "event-existing",
      recordedAt: "2026-09-03T20:00:00.000Z",
      items: [{ label: "1", text: "Existing" }],
    }
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }],
      structuredOutputs: [existingOutput],
    })
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const events: any[] = []
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      frontendEventSink: { onEvent: (event) => events.push(event) },
    })

    expect(events.filter((event) => event.type === "structured_output")).toEqual([])
  })

  it("emits no structured output when post-persist readback is unavailable", async () => {
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const events: any[] = []
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      frontendEventSink: { onEvent: (event) => events.push(event) },
    })

    expect(events.filter((event) => event.type === "structured_output")).toEqual([])
  })

  it("returns an aborted outcome when the pipeline has no persistence work", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "aborted",
      sessionPath: "/tmp/session.json",
      messages: [],
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result).toMatchObject({ response: "", turnOutcome: "aborted" })
  })

  it("delivers only the authoritative text-only terminal answer after ordinary tool-call prose", async () => {
    const delivered: Array<{ kind: string; text: string }> = []
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "system" },
      { role: "user", content: "Can you see the library now?" },
      {
        role: "assistant",
        content: "Yes, I can see titles like The Pitt.",
        tool_calls: [{ id: "catalog-1", type: "function", function: { name: "sanctuary_search_media_catalog", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "catalog-1", content: JSON.stringify({ totalItems: 11_870 }) },
      { role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes." },
    ]
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-rematerialized", sequence: 1, role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes." }),
      makeSessionEvent({ id: "evt-user", sequence: 2, role: "user", content: "Can you see the library now?" }),
      makeSessionEvent({ id: "evt-draft", sequence: 3, role: "assistant", content: "Yes, I can see titles like The Pitt.", toolCalls: [makeToolCall("catalog-1", "sanctuary_search_media_catalog", {})] }),
      makeSessionEvent({ id: "evt-tool", sequence: 4, role: "tool", content: JSON.stringify({ totalItems: 11_870 }), toolCallId: "catalog-1" }),
      makeSessionEvent({ id: "evt-synthetic", sequence: 5, role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.", captureKind: "synthetic" }),
      makeSessionEvent({ id: "evt-final", sequence: 6, role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes." }),
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Yes, I can see titles like The Pitt.")
      input.callbacks.onTextChunk("Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.")
      await input.postTurn(messages, "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", sessionPath: "/tmp/session.json", messages }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "Can you see the library now?",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery) } },
    })

    expect(delivered).toEqual([{ kind: "text", text: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes." }])
    expect(result.response).toBe("Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.")
    expect(result.causalSessionEventIds).toEqual(["evt-final"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("never revives a prior answer when the current settled turn has only ordinary tool-call prose", async () => {
    const delivered: string[] = []
    const priorMessages: ChatCompletionMessageParam[] = [
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
    ]
    mockLoadSession.mockReturnValueOnce({
      messages: priorMessages,
      events: [
        { id: "evt-old-user", role: "user", content: "Old question" },
        { id: "evt-old-answer", role: "assistant", content: "Old answer" },
      ],
    })
    const messages: ChatCompletionMessageParam[] = [
      ...priorMessages,
      { role: "user", content: "Current question" },
      { role: "assistant", content: "Current draft", tool_calls: [{ id: "read-1", type: "function", function: { name: "sanctuary_search_media_catalog", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "read-1", content: "{}" },
    ]
    mockLoadSession.mockReturnValue({ messages })
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-old-user", role: "user", content: "Old question", toolCalls: [] },
      { id: "evt-old-answer", role: "assistant", content: "Old answer", toolCalls: [] },
      { id: "evt-current-user", role: "user", content: "Current question", toolCalls: [] },
      { id: "evt-current-draft", role: "assistant", content: "Current draft", toolCalls: [{ function: { name: "sanctuary_search_media_catalog" } }] },
      { id: "evt-current-tool", role: "tool", content: "{}", toolCalls: [] },
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Current draft")
      await input.postTurn(messages, "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", sessionPath: "/tmp/session.json", messages }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "Current question",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual([])
    expect(result.response).not.toContain("Old answer")
    expect(result.response).not.toContain("Current draft")
    expect(result.causalSessionEventIds).toBeUndefined()
  })

  it("prefers validated completion text over incidental callback prose", async () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "Can you see it?" },
      { role: "assistant", content: "An early guess.", tool_calls: [{ id: "read-1", type: "function", function: { name: "sanctuary_search_media_catalog", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "read-1", content: "{}" },
      { role: "assistant", content: null, tool_calls: [{ id: "settle-1", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "Yes—the shelf is visible.", intent: "direct_reply" }) } }] },
      { role: "tool", tool_call_id: "settle-1", content: "(delivered)" },
    ]
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-user", sequence: 1, role: "user", content: "Can you see it?" }),
      makeSessionEvent({ id: "evt-draft", sequence: 2, role: "assistant", content: "An early guess.", toolCalls: [makeToolCall("read-1", "sanctuary_search_media_catalog", {})] }),
      makeSessionEvent({ id: "evt-read-result", sequence: 3, role: "tool", content: "{}", toolCallId: "read-1" }),
      makeSessionEvent({ id: "evt-final", sequence: 4, role: "assistant", toolCalls: [makeToolCall("settle-1", "settle", { answer: "Yes—the shelf is visible.", intent: "direct_reply" })] }),
      makeSessionEvent({ id: "evt-final-ack", sequence: 5, role: "tool", content: "(delivered)", toolCallId: "settle-1" }),
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("An early guess.")
      input.callbacks.onToolEnd("settle", "Yes—the shelf is visible.", true)
      input.callbacks.onTextChunk("Yes—the shelf is visible.")
      await input.postTurn(messages, "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Yes—the shelf is visible.", intent: "direct_reply" }, sessionPath: "/tmp/session.json", messages }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "session-123", friendId: "friend-1", userMessage: "Can you see it?" })

    expect(result.response).toBe("Yes—the shelf is visible.")
    expect(result.causalSessionEventIds).toEqual(["evt-final"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it.each(["observed", "rested", "suspended", "errored", "superseded", "aborted"] as const)("does not deliver discarded callback prose for a %s turn", async (turnOutcome) => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Discarded intermediate prose.")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome,
        ...(turnOutcome === "suspended" ? {
          suspension: {
            approvalId: "approval-1",
            toolCallId: "call-1",
            checkpointDigest: "a".repeat(64),
            suspendedSessionRevision: "b".repeat(64),
          },
        } : {}),
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual([])
    expect(result.response).not.toContain("Discarded intermediate prose.")
  })

  it("delivers an intercepted command response without inventing a session coordinate", async () => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Started a fresh conversation.")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "command", commandAction: "new" }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "/new",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual(["Started a fresh conversation."])
    expect(result.response).toBe("Started a fresh conversation.")
    expect(result.causalSessionEventIds).toEqual([null])
  })

  it("delivers one validated blocked completion and discards earlier prose", async () => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Unverified early claim.")
      input.callbacks.onTextChunk("I could not verify the shelf because the catalog read failed.")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "blocked",
        completion: { answer: "I could not verify the shelf because the catalog read failed.", intent: "blocked" },
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "Can you see it?",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual(["I could not verify the shelf because the catalog read failed."])
    expect(result.response).toBe("I could not verify the shelf because the catalog read failed.")
  })

  it("ignores a rejected settle coordinate and binds the accepted settle", async () => {
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-user", sequence: 1, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-rejected", sequence: 2, role: "assistant", toolCalls: [makeToolCall("settle-reused", "settle", { answer: "unsupported", intent: "complete" })] }),
      makeSessionEvent({ id: "evt-rejection", sequence: 3, role: "tool", content: "Use current evidence.", toolCallId: "settle-reused" }),
      makeSessionEvent({ id: "evt-accepted", sequence: 4, role: "assistant", toolCalls: [makeToolCall("settle-reused", "settle", { answer: "Grounded final answer.", intent: "complete" })] }),
      makeSessionEvent({ id: "evt-accepted-ack", sequence: 5, role: "tool", content: "(delivered)", toolCallId: "settle-reused" }),
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onToolEnd("settle", "unsupported", false)
      input.callbacks.onClearText()
      input.callbacks.onToolEnd("settle", "grounded", true)
      input.callbacks.onTextChunk("Grounded final answer.")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Grounded final answer.", intent: "complete" }, sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "session-123", friendId: "friend-1", userMessage: "hello" })

    expect(result.causalSessionEventIds).toEqual(["evt-accepted"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("does not deliver an unvalidated blocked draft when no terminal completion exists", async () => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("An unsupported guess.")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "blocked", sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "Can you see it?",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual([])
    expect(result.response).not.toContain("unsupported guess")
  })

  it("does not deliver provisional callback text when a settled result has no terminal authority", async () => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Provisional text.")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual([])
    expect(result.response).not.toContain("Provisional text.")
  })

  it("delivers the pipeline failover message instead of errored callback prose", async () => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Discarded provider fragment.")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "errored", failoverMessage: "The model service is unavailable; I recorded the failure.", sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual(["The model service is unavailable; I recorded the failure."])
    expect(result.response).toBe("The model service is unavailable; I recorded the failure.")
  })

  it.each([false, true])("A003 selects the effective latest precommit and aligns its provider ID (redacted=%s)", async (redacted) => {
    const reference = "telegram-admission:a003"
    const ingress = a003Event(redacted ? 2 : 1, "user", "approved original")
    ingress.relations.references = [reference]
    const correction = a003Event(redacted ? 1 : 2, "user", "engine-only correction")
    const marker = a003Marker(redacted ? ingress : correction, 3)
    const events = [ingress, correction].sort((a, b) => a.sequence - b.sequence).concat(marker)
    mockSessionTransaction(events)
    mockLoadSession.mockReturnValue({
      messages: redacted
        ? [{ role: "user", content: correction.content }, { role: "user", content: ingress.content }, { role: "system", content: "" }]
        : [{ role: "user", content: ingress.content }],
      events,
      projectionEventIds: events.map((event) => event.id),
      state: undefined,
    })
    mockHandleInboundTurn.mockReset().mockImplementation(async (input: any) => {
      const loaded = await input.sessionLoader.loadOrCreate()
      if (!redacted) expect(getIngressRelations(loaded.messages[0])).toEqual({ replyToEventId: null, threadRootEventId: null, references: [reference] })
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const promise = runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "session", friendId: "ari", userMessage: "approved original", precommittedIngress: { eventId: ingress.id, reference } })
    if (redacted) {
      await expect(promise).rejects.toThrow("precommitted ingress")
      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
    } else {
      await promise
      expect(mockHandleInboundTurn).toHaveBeenCalledOnce()
    }
  })

  it("claims an exact precommitted ingress event without synthesizing a second user message", async () => {
    const reference = "telegram-admission:abc123"
    const system = makeSessionEvent({ id: "evt-000001", sequence: 1, role: "system", content: "system" })
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 2, role: "user", content: "approved original", references: [reference] })
    mockSessionTransaction([system, ingress])
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }, { role: "user", content: "approved original" }],
      events: [system, ingress],
      projectionEventIds: [system.id, ingress.id],
      state: undefined,
    })
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      expect(input.messages).toEqual([])
      expect(input.runAgentOptions.toolContext.currentUserMessage).toBe("approved original")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "telegram:approved",
      friendId: "friend-1",
      userMessage: "approved original",
      precommittedIngress: { eventId: "evt-000002", reference },
    })
    expect(mockHandleInboundTurn).toHaveBeenCalledOnce()
  })

  it("refuses precommitted ingress when the session itself is missing", async () => {
    mockLoadSession.mockReturnValue(null)
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await expect(runSenseTurn({
      agentName: "test-agent", channel: "telegram", sessionKey: "session", friendId: "ari", userMessage: "missing",
      precommittedIngress: { eventId: "evt-missing", reference: "telegram-admission:missing" },
    })).rejects.toThrow("precommitted ingress")
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
  })

  it("rejects a precommitted ingress missing from the provider projection before the agent turn", async () => {
    const reference = "telegram-admission:abc123"
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 1, role: "user", content: "approved original", references: [reference] })
    mockSessionTransaction([ingress], ["evt-projected-elsewhere"])
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }],
      events: [ingress],
      projectionEventIds: ["evt-projected-elsewhere"],
      state: undefined,
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "telegram:approved",
      friendId: "friend-1",
      userMessage: "approved original",
      precommittedIngress: { eventId: "evt-000002", reference },
    })).rejects.toThrow("precommitted ingress is absent from the provider projection")
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
  })

  it.each([
    { name: "omitted behind older identical text", projectionOrder: ["evt-000001"] },
    { name: "reordered before older identical text", projectionOrder: ["evt-000002", "evt-000001"] },
    { name: "duplicated within the ordered IDs", projectionOrder: ["evt-000001", "evt-000002", "evt-000002"] },
    { name: "mixed with an unresolved projected ID", projectionOrder: ["evt-000001", "evt-unresolved", "evt-000002"] },
  ])("rejects an exact precommitted ingress $name in a real v2 provider projection before the agent turn", async ({ projectionOrder }) => {
    const reference = "telegram-admission:abc123"
    const older = makeSessionEvent({ id: "evt-000001", sequence: 1, role: "user", content: "approved original" })
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 2, role: "user", content: "approved original", references: [reference] })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-turn-precommitted-projection-"))
    mockGetAgentRoot.mockReturnValue(root)
    const sessionPath = path.join(root, "state", "sessions", "friend-1", "telegram", "telegram_approved.json")
    const envelope = makeSessionEnvelopeValue([older, ingress])
    ;(envelope.projection as { eventIds: string[] }).eventIds = projectionOrder
    await mockActualSessionEnvelope(sessionPath, envelope)
    const observer = { providerInvocationCount: 0, toolInvocationCount: 0 }
    const { runSenseTurn } = await import("../../senses/shared-turn")

    try {
      await expect(runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "telegram:approved", friendId: "friend-1", userMessage: "approved original", precommittedIngress: { eventId: ingress.id, reference }, turnMetricsObserver: observer })).rejects.toThrow("precommitted ingress is absent from the provider projection")
      expect(observer.providerInvocationCount).toBe(0)
      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
    } finally {
      mockGetAgentRoot.mockReturnValue("/tmp/test-agent")
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("stamps only the exact latest precommitted ingress in an ordered duplicate-text projection", async () => {
    const reference = "telegram-admission:abc123"
    const older = makeSessionEvent({ id: "evt-000001", sequence: 1, role: "user", content: "approved original" })
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 2, role: "user", content: "approved original", references: [reference] })
    mockSessionTransaction([older, ingress])
    mockLoadSession.mockReturnValue({ messages: [{ role: "user", content: "approved original" }, { role: "user", content: "approved original" }], events: [older, ingress], projectionEventIds: [older.id, ingress.id], state: undefined })
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      const loaded = await input.sessionLoader.loadOrCreate()
      expect(getIngressRelations(loaded.messages[0])).toBeNull()
      expect(getIngressRelations(loaded.messages[1])).toEqual({ replyToEventId: null, threadRootEventId: null, references: [reference] })
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "telegram:approved", friendId: "friend-1", userMessage: "approved original", precommittedIngress: { eventId: ingress.id, reference } })

    expect(mockHandleInboundTurn).toHaveBeenCalledOnce()
  })

  it("rejects a precommitted projection whose user coordinates no longer align with provider messages", async () => {
    const reference = "telegram-admission:abc123"
    const older = makeSessionEvent({ id: "evt-000001", sequence: 1, role: "user", content: "approved original" })
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 2, role: "user", content: "approved original", references: [reference] })
    mockSessionTransaction([older, ingress])
    mockLoadSession.mockReturnValue({ messages: [{ role: "user", content: "approved original" }], events: [older, ingress], projectionEventIds: [older.id, ingress.id], state: undefined })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "telegram:approved", friendId: "friend-1", userMessage: "approved original", precommittedIngress: { eventId: ingress.id, reference } })).rejects.toThrow("precommitted ingress is absent from the provider projection")
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
  })

  it("rejects duplicate canonical event IDs before invoking the agent turn", async () => {
    const reference = "telegram-admission:abc123"
    const duplicateSystem = makeSessionEvent({ id: "evt-000001", sequence: 1, role: "system", content: "system" })
    const duplicateSystemLater = makeSessionEvent({ id: "evt-000001", sequence: 2, role: "system", content: "system again" })
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 3, role: "user", content: "approved original", references: [reference] })
    mockSessionTransaction([duplicateSystem, duplicateSystemLater, ingress])
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }, { role: "system", content: "system again" }, { role: "user", content: "approved original" }],
      events: [duplicateSystem, duplicateSystemLater, ingress],
      projectionEventIds: [duplicateSystem.id, duplicateSystemLater.id, ingress.id],
      state: undefined,
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "telegram:approved", friendId: "friend-1", userMessage: "approved original", precommittedIngress: { eventId: ingress.id, reference } })).rejects.toThrow("precommitted ingress is absent from the provider projection")
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
  })

  it("fails causal binding closed when a persisted snapshot omits the precommitted ingress boundary", async () => {
    const reference = "telegram-admission:abc123"
    const system = makeSessionEvent({ id: "evt-000001", sequence: 1, role: "system", content: "system" })
    const ingress = makeSessionEvent({ id: "evt-000002", sequence: 2, role: "user", content: "approved original", references: [reference] })
    mockSessionTransaction([system, ingress])
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }, { role: "user", content: "approved original" }],
      events: [system, ingress],
      projectionEventIds: [system.id, ingress.id],
    })
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-stale", role: "assistant", content: "Visible reply.", toolCalls: [] },
    ])
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onTextChunk("Visible reply.")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Visible reply.", intent: "complete" }, messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "telegram:approved",
      friendId: "friend-1",
      userMessage: "approved original",
      precommittedIngress: { eventId: "evt-000002", reference },
    })

    expect(result.causalSessionEventIds).toEqual([null])
  })

  it("fails closed when precommitted ingress is absent, mismatched, or no longer the latest user event", async () => {
    const reference = "telegram-admission:abc123"
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const options = {
      agentName: "test-agent",
      channel: "telegram" as const,
      sessionKey: "telegram:approved",
      friendId: "friend-1",
      userMessage: "approved original",
      precommittedIngress: { eventId: "evt-000002", reference },
    }
    mockLoadSession.mockReturnValue({ messages: [], events: [] })
    await expect(runSenseTurn(options)).rejects.toThrow("precommitted ingress")
    mockLoadSession.mockReturnValue({
      messages: [{ role: "user", content: "different" }],
      events: [{ id: "evt-000002", role: "user", content: "different", relations: { references: [reference] } }],
    })
    await expect(runSenseTurn(options)).rejects.toThrow("precommitted ingress")
    mockLoadSession.mockReturnValue({
      messages: [{ role: "user", content: "approved original" }, { role: "user", content: "newer" }],
      events: [
        { id: "evt-000002", role: "user", content: "approved original", relations: { references: [reference] } },
        { id: "evt-000003", role: "user", content: "newer", relations: { references: ["other"] } },
      ],
    })
    await expect(runSenseTurn(options)).rejects.toThrow("precommitted ingress")
    expect(mockHandleInboundTurn).not.toHaveBeenCalled()
  })

  it("preserves observed provider and tool counts when the shared turn rejects", async () => {
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onModelStart()
      input.callbacks.onToolStart()
      input.callbacks.onToolStart()
      throw new Error("provider failed")
    })
    const observer = { providerInvocationCount: 0, toolInvocationCount: 0 }
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      turnMetricsObserver: observer,
    })).rejects.toThrow("provider failed")

    expect(observer).toEqual({ providerInvocationCount: 1, toolInvocationCount: 2 })
  })

  it("declares shared-turn settle output as retractable before outward delivery", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.callbacks.settleOutputMode).toBe("retractable_buffer")
  })

  it("delivers the authoritative settle answer instead of concatenated buffered prose", async () => {
    const delivered: string[] = []
    const settleMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-settle",
            type: "function",
            function: {
              name: "settle",
              arguments: JSON.stringify({ answer: "Final answer only.", intent: "complete" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-settle", content: "(delivered)" },
    ]
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onTextChunk("Aww, thanks. Let me take a quick look.")
      input.callbacks.onTextChunk("Final answer only.")
      input.callbacks.onToolEnd("settle", "Final answer only.", true)
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 0, total_tokens: 150 },
        turnOutcome: "settled",
        completion: { answer: "Final answer only.", intent: "complete" },
        sessionPath: "/tmp/session.json",
        messages: settleMessages,
      }
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "telegram:777:42",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual(["Final answer only."])
    expect(result.response).toBe("Final answer only.")
  })

  it("does not fabricate a deferral message when a turn has no callback text", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 0, total_tokens: 150 },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
      ],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "think about this deeply",
    })
    expect(result.ponderDeferred).toBe(false)
    expect(result.response).not.toContain("check back shortly")
  })

  it("caps response at 50000 characters", async () => {
    const longText = "x".repeat(60000)
    setupSettledTurn(longText)
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "give me a lot of text",
    })
    expect(result.response.length).toBeLessThanOrEqual(50000 + 100) // allow for truncation message
    expect(result.response).toContain("[truncated")
  })

  it("passes channel and sessionKey to handleInboundTurn", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "my-session",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.channel).toBe("mcp")
    expect(input.sessionKey).toBe("my-session")
    expect(input.runAgentOptions.toolContext.currentUserMessage).toBe("hello")
    await expect(input.runAgentOptions.toolContext.signin("anything")).resolves.toBeUndefined()
  })

  it("uses explicit remote identity for A2A turns", async () => {
    const caps = { ...makeMcpCapabilities(), channel: "a2a", senseType: "open" } as ChannelCapabilities
    mockGetChannelCapabilities.mockReturnValueOnce(caps)
    mockFriendResolve.mockResolvedValueOnce({ friend: makeFriend({ kind: "agent" }), channel: caps })
    const { FriendResolver } = await import("@ouro.bot/friends")
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "a2a",
      sessionKey: "a2a-session",
      friendId: "storage-key",
      userMessage: "hello from peer",
      identity: {
        provider: "a2a-agent",
        externalId: "remote-agent-id",
        displayName: "Remote Agent",
        tenantId: "remote-tenant",
      },
    })
    expect(FriendResolver).toHaveBeenCalledWith(expect.anything(), {
      provider: "a2a-agent",
      externalId: "remote-agent-id",
      displayName: "Remote Agent",
      channel: "a2a",
      tenantId: "remote-tenant",
    })
  })

  it("uses explicit A2A identity without a tenant id", async () => {
    const caps = { ...makeMcpCapabilities(), channel: "a2a", senseType: "open" } as ChannelCapabilities
    mockGetChannelCapabilities.mockReturnValueOnce(caps)
    mockFriendResolve.mockResolvedValueOnce({ friend: makeFriend({ kind: "agent" }), channel: caps })
    const { FriendResolver } = await import("@ouro.bot/friends")
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "a2a",
      sessionKey: "a2a-session",
      friendId: "storage-key",
      userMessage: "hello from peer",
      identity: {
        provider: "a2a-agent",
        externalId: "remote-agent-id",
        displayName: "Remote Agent",
      },
    })
    expect(FriendResolver).toHaveBeenCalledWith(expect.anything(), {
      provider: "a2a-agent",
      externalId: "remote-agent-id",
      displayName: "Remote Agent",
      channel: "a2a",
    })
  })

  it.each(["mcp", "voice"] as Channel[])("delegates %s turns to the shared pipeline for orientation construction", async (channel) => {
    const caps = { ...makeMcpCapabilities(), channel } as ChannelCapabilities
    mockGetChannelCapabilities.mockReturnValueOnce(caps)
    mockFriendResolve.mockResolvedValueOnce({ friend: makeFriend(), channel: caps })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await runSenseTurn({
      agentName: "test-agent",
      channel,
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "same, number 4",
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.channel).toBe(channel)
    expect(input.messages).toEqual([
      expect.objectContaining({ role: "user", content: "same, number 4" }),
    ])
    expect(input.runAgentOptions?.orientationFrame).toBeUndefined()
    expect(input.runAgentOptions?.toolContext?.orientationFrame).toBeUndefined()
  })

  it("passes an explicitly resolved orientation frame through the shared turn boundary", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const orientationFrame = {
      frameId: "frame-1",
      source: { channel: "mcp", conversationKey: "session-123", speechKind: "utterance", speech: ["hello"] },
      candidates: [],
      status: "resolved",
      generatedAt: "2026-08-29T00:00:00.000Z",
    } as any

    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      orientationFrame,
    })

    expect(mockHandleInboundTurn.mock.calls[0][0].runAgentOptions.orientationFrame).toBe(orientationFrame)
  })

  it("passes transport tool context through to the agent turn", async () => {
    const voiceCall = { requestEnd: vi.fn() }
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "call-123",
      friendId: "friend-1",
      userMessage: "hello",
      toolContext: { voiceCall },
    })

    expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.runAgentOptions.toolContext.voiceCall).toBe(voiceCall)
  })

  it("passes runtimeMcpServers to getSharedMcpManager as per-turn runtimeServers", async () => {
    const runtimeMcpServers = {
      ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] },
    }
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      runtimeMcpServers,
      toolContext: { agentName: "other-agent", agentRoot: "/other/agent.ouro" },
    })

    const owner = { agentName: "test-agent", agentRoot: "/tmp/test-agent" }
    expect(mockGetSharedMcpManager).toHaveBeenCalledWith({ ...owner, runtimeServers: runtimeMcpServers })
    expect(mockReleaseRuntimeMcpServers).toHaveBeenCalledWith(owner)
    expect(mockHandleInboundTurn.mock.calls[0][0].runAgentOptions.toolContext).toMatchObject(owner)
  })

  it("releases each runtime MCP before the next queued turn starts", async () => {
    const firstEntered = Promise.withResolvers<void>()
    const finishFirst = Promise.withResolvers<void>()
    const order: string[] = []
    let runCount = 0
    let releaseCount = 0
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      runCount += 1
      const currentRun = runCount
      order.push(`turn:${currentRun}`)
      if (currentRun === 1) {
        firstEntered.resolve()
        await finishFirst.promise
      }
      input.callbacks.onTextChunk(`response ${currentRun}`)
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        messages: [],
      }
    })
    mockReleaseRuntimeMcpServers.mockImplementation(async () => {
      releaseCount += 1
      order.push(`release:${releaseCount}`)
    })
    const runtimeMcpServers = {
      ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] },
    }
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const first = runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-first",
      friendId: "friend-1",
      userMessage: "first",
      runtimeMcpServers,
    })
    await firstEntered.promise
    const second = runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-second",
      friendId: "friend-1",
      userMessage: "second",
      runtimeMcpServers,
    })

    await Promise.resolve()
    expect(order).toEqual(["turn:1"])
    finishFirst.resolve()
    await Promise.all([first, second])

    expect(order).toEqual(["turn:1", "release:1", "turn:2", "release:2"])
    expect(mockReleaseRuntimeMcpServers.mock.calls).toEqual([
      [{ agentName: "test-agent", agentRoot: "/tmp/test-agent" }],
      [{ agentName: "test-agent", agentRoot: "/tmp/test-agent" }],
    ])
  })

  it("releases runtime MCPs when a turn fails", async () => {
    mockHandleInboundTurn.mockRejectedValueOnce(new Error("provider failed"))
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-failed",
      friendId: "friend-1",
      userMessage: "hello",
      runtimeMcpServers: {
        ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] },
      },
    })).rejects.toThrow("provider failed")

    expect(mockReleaseRuntimeMcpServers).toHaveBeenCalledOnce()
    expect(mockReleaseRuntimeMcpServers).toHaveBeenCalledWith({ agentName: "test-agent", agentRoot: "/tmp/test-agent" })
  })

  it("keeps explicit owner coordinates when no runtimeMcpServers are supplied", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(mockGetSharedMcpManager).toHaveBeenCalledWith({
      agentName: "test-agent", agentRoot: "/tmp/test-agent", runtimeServers: undefined,
    })
    expect(mockReleaseRuntimeMcpServers).not.toHaveBeenCalled()
  })

  it("hard-disables native and MCP tools for observe-only turns", async () => {
    mockLoadSession.mockReturnValue(null)
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "observe",
      disableTools: true,
      runtimeMcpServers: {
        ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] },
      },
    })

    expect(mockGetSharedMcpManager).not.toHaveBeenCalled()
    expect(mockReleaseRuntimeMcpServers).not.toHaveBeenCalled()
    expect(mockBuildSystem.mock.calls[0][1]).toEqual({ tools: [], hardDisableTools: true })
    expect(mockHandleInboundTurn.mock.calls[0][0].runAgentOptions.tools).toEqual([])
    expect(mockHandleInboundTurn.mock.calls[0][0].runAgentOptions.hardDisableTools).toBe(true)
    expect(mockHandleInboundTurn.mock.calls[0][0].runAgentOptions.mcpManager).toBeUndefined()
  })

  it("keeps observe-only prompts out of normal session storage", async () => {
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("hold")
      const loaded = await input.sessionLoader.loadOrCreate()
      fs.writeFileSync(loaded.sessionPath, "temporary")
      fs.symlinkSync(loaded.sessionPath, path.join(path.dirname(loaded.sessionPath), "session-link"))
      await input.postTurn([
        { role: "system", content: "system" },
        { role: "user", content: "private worker evidence" },
        { role: "assistant", content: "hold" },
      ], loaded.sessionPath)
      await input.accumulateFriendTokens()
      input.drainPending()
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-ephemeral",
      friendId: "friend-1",
      userMessage: "private worker evidence",
      disableTools: true,
      disablePersistence: true,
    })

    const leasePath = mockWithSessionTurnLease.mock.calls[0][0]
    expect(leasePath).toContain("ouro-observe-only-")
    expect(mockSessionPath).not.toHaveBeenCalled()
    expect(mockLoadSession).not.toHaveBeenCalled()
    expect(mockDeferPostTurnPersist).not.toHaveBeenCalled()
    expect(mockDrainPending).not.toHaveBeenCalled()
    expect(result.sessionPath).toBeUndefined()
    expect(fs.existsSync(path.dirname(leasePath))).toBe(false)
  })

  it("fails closed when observe-only cleanup finds nested state", async () => {
    let ephemeralRoot = ""
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      const loaded = await input.sessionLoader.loadOrCreate()
      ephemeralRoot = path.dirname(loaded.sessionPath)
      fs.mkdirSync(path.join(ephemeralRoot, "unexpected"))
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    try {
      await expect(runSenseTurn({
        agentName: "test-agent",
        channel: "mcp",
        sessionKey: "session-ephemeral-invalid",
        friendId: "friend-1",
        userMessage: "private worker evidence",
        disableTools: true,
        disablePersistence: true,
      })).rejects.toThrow("observe-only session cleanup found unexpected entry: unexpected")
    } finally {
      if (ephemeralRoot) fs.rmSync(ephemeralRoot, { recursive: true, force: true })
    }
  })

  it("uses the explicit agentName for session storage instead of process argv", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "Voice/Session:123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(mockGetAgentRoot).toHaveBeenCalledWith("test-agent")
    expect(mockLoadSession).toHaveBeenCalledWith("/tmp/test-agent/state/sessions/friend-1/voice/Voice_Session_123.json")
  })

  it("passes user message to handleInboundTurn", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "what is 2+2?",
    })
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.messages).toMatchObject([{ role: "user", content: "what is 2+2?" }])
    expect(input.messages[0]._ingressAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("stamps explicit ingress relations on the user message", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "related",
      ingressRelations: {
        replyToEventId: null,
        threadRootEventId: null,
        references: ["event-1"],
      },
    })

    expect(mockHandleInboundTurn.mock.calls[0][0].messages[0]._ingressRelations).toEqual({
      replyToEventId: null,
      threadRootEventId: null,
      references: ["event-1"],
    })
  })

  it("drains pending messages before turn", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    const input = mockHandleInboundTurn.mock.calls[0][0]
    // drainPending is injected as dependency
    expect(input.drainPending).toBeDefined()
  })

  it("buildSystem is called without mcpManager (now passed via runAgentOptions)", async () => {
    const fakeMcpManager = { listAllTools: vi.fn().mockReturnValue([]) }
    mockGetSharedMcpManager.mockResolvedValue(fakeMcpManager)
    // Ensure fresh session so buildSystem is called
    mockLoadSession.mockReturnValue(null)

    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    // buildSystem should NOT receive mcpManager — it's now passed via runAgentOptions
    expect(mockBuildSystem).toHaveBeenCalled()
    const buildSystemCall = mockBuildSystem.mock.calls[0]
    expect(buildSystemCall[1]).toEqual({})
  })

  it("passes mcpManager in runAgentOptions to handleInboundTurn", async () => {
    const fakeMcpManager = { listAllTools: vi.fn().mockReturnValue([]) }
    mockGetSharedMcpManager.mockResolvedValue(fakeMcpManager)

    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.runAgentOptions).toBeDefined()
    expect(input.runAgentOptions.mcpManager).toBe(fakeMcpManager)
  })

  it("passes live latency mode through to the shared pipeline", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "phone",
      friendId: "friend-1",
      userMessage: "hello",
      latencyMode: "live",
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.latencyMode).toBe("live")
    expect(input.runAgentOptions.skipKeptNotes).toBe(true)
  })

  it("builds an approval coordinator from the leased session checkpoint", async () => {
    const approvalCoordinator = { coordinate: vi.fn() }
    const approvalCoordinatorFactory = vi.fn(() => approvalCoordinator)
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "approval-session",
      friendId: "friend-1",
      userMessage: "restart it",
      approvalCoordinatorFactory: approvalCoordinatorFactory as never,
    })

    expect(approvalCoordinatorFactory).toHaveBeenCalledWith({
      sessionPath: "/tmp/test-agent/state/sessions/friend-1/mcp/approval-session.json",
      baseSessionRevision: "revision-a",
    })
    expect(mockHandleInboundTurn.mock.calls[0][0].runAgentOptions.approvalCoordinator)
      .toBe(approvalCoordinator)
  })

  it("returns a durable approval suspension without fabricating a completed response", async () => {
    const suspension = {
      approvalId: "approval-1",
      toolCallId: "call-1",
      checkpointDigest: "a".repeat(64),
      suspendedSessionRevision: "b".repeat(64),
    }
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "suspended",
      suspension,
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "approval-session",
      friendId: "friend-1",
      userMessage: "restart it",
      approvalCoordinatorFactory: (() => ({ propose: vi.fn() })) as never,
    })).resolves.toMatchObject({
      response: "",
      turnOutcome: "suspended",
      suspension,
    })
    expect(mockDeferPostTurnPersist).not.toHaveBeenCalled()
  })

  it("rejects a suspended shared turn without durable suspension metadata", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "suspended",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "approval-session",
      friendId: "friend-1",
      userMessage: "restart it",
      approvalCoordinatorFactory: (() => ({ propose: vi.fn() })) as never,
    })).rejects.toThrow("omitted durable approval suspension")
  })

  it("handles null mcpManager gracefully (no MCP servers)", async () => {
    mockGetSharedMcpManager.mockResolvedValue(null)
    mockLoadSession.mockReturnValue(null)

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toBeDefined()
    // buildSystem should receive empty options (no mcpManager)
    const buildSystemCall = mockBuildSystem.mock.calls[0]
    expect(buildSystemCall[1]).toEqual({})
  })

  it("returns empty response when handleInboundTurn produces no text", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toContain("agent responded but response was empty")
    expect(result.ponderDeferred).toBe(false)
  })

  it("returns a truthful Sanctuary whole-status fallback only after the agent settles empty", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "sanctuary",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "ari",
      userMessage: "What's going on with Sanctuary?",
      emptyResponseFallback: () => "I couldn't finish a trustworthy Sanctuary status check because a current check was unavailable. I won't guess or reuse old alerts; please try again shortly.",
    })

    expect(result.response).toContain("won't guess or reuse old alerts")
    expect(result.response).not.toContain("response was empty")
  })

  it("handles gate rejection gracefully", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: false, reason: "untrusted", autoReply: "blocked politely" },
      turnOutcome: undefined,
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    // Should return empty or error message, not throw
    expect(result.response).toBe("blocked politely")
    expect(result.ponderDeferred).toBe(false)
  })

  it("renders trust gate reason when a blocked turn has no auto-reply", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: false, reason: "untrusted" },
      turnOutcome: undefined,
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toBe("(blocked by trust gate: untrusted)")
    expect(result.ponderDeferred).toBe(false)
  })

  it("accumulates text from multiple onTextChunk calls", async () => {
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("hello ")
      input.callbacks.onTextChunk("world")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        completion: { answer: "hello world", intent: "complete" },
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toBe("hello world")
  })

  it("delivers speak and settle segments through the outward delivery sink", async () => {
    const delivered: Array<{ kind: string; text: string }> = []
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-wrong-kind", sequence: 1, role: "assistant", content: "quick voice update" }),
      makeSessionEvent({ id: "evt-user", sequence: 2, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-000001", sequence: 3, role: "assistant", toolCalls: [makeToolCall("speak-1", "speak", { message: "quick voice update" })] }),
      makeSessionEvent({ id: "evt-speak-ack", sequence: 4, role: "tool", content: "(spoken)", toolCallId: "speak-1" }),
      makeSessionEvent({ id: "evt-unrelated", sequence: 5, role: "assistant", content: "an unrelated rematerialized answer" }),
      makeSessionEvent({ id: "evt-000002", sequence: 6, role: "assistant", toolCalls: [makeToolCall("settle-1", "settle", { answer: "final voice answer", intent: "complete" })] }),
      makeSessionEvent({ id: "evt-settle-ack", sequence: 7, role: "tool", content: "(delivered)", toolCallId: "settle-1" }),
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("quick voice update")
      await input.callbacks.flushNow()
      input.callbacks.onToolEnd("settle", "final answer", true)
      input.callbacks.onClearText()
      input.callbacks.onTextChunk("final voice answer")
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        completion: { answer: "final voice answer", intent: "complete" },
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: {
        onDelivery: async (delivery) => {
          delivered.push(delivery)
        },
      },
    })

    expect(delivered).toEqual([
      { kind: "speak", text: "quick voice update" },
      { kind: "settle", text: "final voice answer" },
    ])
    expect(result.deliveries).toEqual(delivered)
    expect(result.causalSessionEventIds).toEqual(["evt-000001", "evt-000002"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
    expect(result.response).toBe("quick voice update\nfinal voice answer")
  })

  it("returns the exact new plain-assistant coordinate without considering older or non-assistant events", async () => {
    const oldEvent = makeSessionEvent({ id: "evt-old", sequence: 1, role: "assistant", content: "old" })
    mockLoadSession.mockReturnValue({
      messages: [{ role: "assistant", content: "old" }],
      events: [oldEvent],
    })
    mockDeferPostTurnPersist.mockResolvedValue([
      oldEvent,
      makeSessionEvent({ id: "evt-user", sequence: 2, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-empty", sequence: 3, role: "assistant" }),
      makeSessionEvent({ id: "evt-new", sequence: 4, role: "assistant", content: "new" }),
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("new")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "new", intent: "complete" }, sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({ agentName: "test-agent", channel: "mcp", sessionKey: "session-123", friendId: "friend-1", userMessage: "hello" })

    expect(result.causalSessionEventIds).toEqual(["evt-new"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("returns no causal coordinate when failed and successful deliveries do not align with persisted events", async () => {
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-user", role: "user", content: "hello", toolCalls: [] },
      { id: "evt-speak", role: "assistant", content: null, toolCalls: [{ function: { name: "speak" } }] },
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("failed speak")
      await expect(input.callbacks.flushNow()).rejects.toThrow("speaker down")
      input.callbacks.onTextChunk("successful text")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "successful text", intent: "complete" }, sessionPath: "/tmp/session.json", messages: [] }
    })
    let delivery = 0
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent", channel: "mcp", sessionKey: "session-123", friendId: "friend-1", userMessage: "hello",
      deliverySink: { onDelivery: async () => { if (delivery++ === 0) throw new Error("speaker down") } },
    })

    expect(result.causalSessionEventIds).toEqual([null])
  })

  it("fails causal binding closed when the current ingress event cannot be resolved", async () => {
    mockLoadSession.mockReturnValue({
      messages: [{ role: "user", content: "prior question" }],
      events: [{ id: "evt-old-user", role: "user", content: "prior question" }],
    })
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-old-user", role: "user", content: "prior question", toolCalls: [] },
      { id: "evt-stale", role: "assistant", content: "Same visible answer.", toolCalls: [] },
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Failed update.")
      await expect(input.callbacks.flushNow()).rejects.toThrow("speaker down")
      input.callbacks.onTextChunk("Same visible answer.")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Same visible answer.", intent: "complete" }, sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    let delivery = 0
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: async () => { if (delivery++ === 0) throw new Error("speaker down") } },
    })

    expect(result.causalSessionEventIds).toEqual([null])
  })

  it("does not bind an acknowledged outward tool with malformed delivery arguments", async () => {
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-user", role: "user", content: "hello", toolCalls: [] },
      { id: "evt-speak", role: "assistant", content: null, toolCalls: [{ id: "speak-malformed", function: { name: "speak", arguments: "{" } }] },
      { id: "evt-speak-ack", role: "tool", content: "(spoken)", toolCallId: "speak-malformed", toolCalls: [] },
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Visible update.")
      await input.callbacks.flushNow()
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "observed", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({ agentName: "test-agent", channel: "mcp", sessionKey: "session-123", friendId: "friend-1", userMessage: "hello" })

    expect(result.causalSessionEventIds).toEqual([null])
  })

  it("records final outward delivery failures without losing settled text", async () => {
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onToolEnd("settle", "final answer", true)
      input.callbacks.onTextChunk("final voice answer")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        completion: { answer: "final voice answer", intent: "complete" },
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: {
        onDelivery: async () => {
          throw "speaker down"
        },
      },
    })

    expect(result.response).toBe("final voice answer")
    expect(result.deliveries).toEqual([])
    expect(result.deliveryFailures).toEqual([
      { kind: "settle", text: "final voice answer", error: "speaker down" },
    ])
  })

  it("propagates speak delivery failures during mid-turn flushes", async () => {
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("quick voice update")
      await expect(input.callbacks.flushNow()).rejects.toThrow("speaker down")
      input.callbacks.onTextChunk("final voice answer")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        completion: { answer: "final voice answer", intent: "complete" },
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: {
        onDelivery: async () => {
          throw new Error("speaker down")
        },
      },
    })

    expect(result.response).toBe("final voice answer")
    expect(result.deliveryFailures).toEqual([
      { kind: "speak", text: "quick voice update", error: "speaker down" },
      { kind: "text", text: "final voice answer", error: "speaker down" },
    ])
  })

  it("resolves UUID friendId with existing friend record", async () => {
    mockStoreInstance.get.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      name: "Jordan",
      externalIds: [{ provider: "imessage-handle", externalId: "jordan@example.com" }],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      userMessage: "hello",
    })
    expect(result.response).toBe("hello from the agent")
    expect(mockStoreInstance.get).toHaveBeenCalledWith("a1b2c3d4-e5f6-7890-abcd-ef0123456789")
  })

  it("resolves UUID friendId with existing friend but no external IDs (fallback defaults)", async () => {
    mockStoreInstance.get.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      name: null,
      externalIds: [],
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      userMessage: "hello",
    })
    expect(result.response).toBe("hello from the agent")
  })

  it("resolves UUID friendId with no existing friend record (fallback to local)", async () => {
    mockStoreInstance.get.mockResolvedValue(null)
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
      userMessage: "hello",
    })
    expect(result.response).toBe("hello from the agent")
    expect(mockStoreInstance.get).toHaveBeenCalledWith("a1b2c3d4-e5f6-7890-abcd-ef0123456789")
  })

  it("reloads session event truth when no text arrives from callbacks", async () => {
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      await input.postTurn([], "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    const persistedEvents = [
      makeSessionEvent({ id: "evt-user", sequence: 1, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-answer", sequence: 2, role: "assistant", content: "recovered answer from session" }),
    ]
    const reloadedEnvelope = makeSessionEnvelopeValue(persistedEvents)
    mockReadSessionTransaction.mockReturnValue({ bytes: JSON.stringify(reloadedEnvelope), value: reloadedEnvelope, revision: "revision-a" })
    mockDeferPostTurnPersist.mockResolvedValue([])
    mockLoadSession.mockReturnValueOnce(null).mockReturnValue({
      messages: [{ role: "assistant", content: "POISONED SESSION MESSAGE" }],
      events: persistedEvents,
      state: {},
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toBe("recovered answer from session")
    expect(result.causalSessionEventIds).toEqual(["evt-answer"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
    expect(result.ponderDeferred).toBe(false)
  })

  it("uses an immediate current-turn assistant event when callbacks emitted no text", async () => {
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-user", sequence: 1, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-answer", sequence: 2, role: "assistant", content: "authoritative current-turn answer" }),
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "authoritative current-turn answer" },
      ]
      await input.postTurn(messages, "/tmp/session.json")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        sessionPath: "/tmp/session.json",
        messages,
      }
    })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toBe("authoritative current-turn answer")
    expect(result.causalSessionEventIds).toEqual(["evt-answer"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("recovers delivered settle text from reloaded event truth", async () => {
    const settle = makeToolCall("call_settle", "settle", { answer: "me - I'm here\n\nwhat's up?", intent: "direct_reply" })
    const settleEvents = [
      makeSessionEvent({ id: "evt-user", sequence: 1, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-settle", sequence: 2, role: "assistant", toolCalls: [settle] }),
      makeSessionEvent({ id: "evt-settle-ack", sequence: 3, role: "tool", content: "(delivered)", toolCallId: "call_settle" }),
    ]
    const settleEnvelope = makeSessionEnvelopeValue(settleEvents)
    mockReadSessionTransaction.mockReturnValue({ bytes: JSON.stringify(settleEnvelope), value: settleEnvelope, revision: "revision-a" })
    mockHandleInboundTurn.mockImplementation(async () => ({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    }))
    mockLoadSession
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [settle],
          },
          { role: "tool", tool_call_id: "call_settle", content: "(delivered)" },
        ],
        events: settleEvents,
        state: {},
      })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toBe("me - I'm here\n\nwhat's up?")
    expect(result.causalSessionEventIds).toEqual(["evt-settle"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("recovers spoken tool text only after a reloaded event acknowledgement", async () => {
    const speak = makeToolCall("call_speak", "speak", { message: "I can say this out loud." })
    const speakEvents = [
      makeSessionEvent({ id: "evt-user", sequence: 1, role: "user", content: "hello" }),
      makeSessionEvent({ id: "evt-speak", sequence: 2, role: "assistant", toolCalls: [speak] }),
      makeSessionEvent({ id: "evt-speak-ack", sequence: 3, role: "tool", content: "(spoken)", toolCallId: "call_speak" }),
    ]
    const speakEnvelope = makeSessionEnvelopeValue(speakEvents)
    mockReadSessionTransaction.mockReturnValue({ bytes: JSON.stringify(speakEnvelope), value: speakEnvelope, revision: "revision-a" })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    mockLoadSession
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [speak],
          },
          { role: "tool", tool_call_id: "call_speak", content: "(spoken)" },
        ],
        events: speakEvents,
        state: {},
      })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toBe("I can say this out loud.")
    expect(result.causalSessionEventIds).toEqual(["evt-speak"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("does not recover rejected or private-runtime settle text as outward speech", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    mockLoadSession
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_settle",
              type: "function",
              function: {
                name: "settle",
                arguments: JSON.stringify({ answer: "private or rejected text", intent: "complete" }),
              },
            }],
          },
          { role: "tool", tool_call_id: "call_settle", content: "(settled)" },
        ],
        state: {},
      })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toContain("agent responded but response was empty")
    expect(result.response).not.toContain("private or rejected text")
  })

  it("does not recover malformed delivery tool arguments", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    mockLoadSession
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_settle",
              type: "function",
              function: {
                name: "settle",
                arguments: "{not-json",
              },
            }],
          },
          { role: "tool", tool_call_id: "call_settle", content: "(delivered)" },
        ],
        state: {},
      })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toContain("agent responded but response was empty")
  })

  it("does not recover malformed delivery tool shapes", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    mockLoadSession
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              null,
              {
                id: "call_array",
                type: "function",
                function: { name: "settle", arguments: "[]" },
              },
              {
                id: "call_non_string",
                type: "function",
                function: { name: "settle", arguments: JSON.stringify({ answer: 123 }) },
              },
              {
                id: "call_blank",
                type: "function",
                function: { name: "settle", arguments: JSON.stringify({ answer: "   " }) },
              },
              {
                type: "function",
                function: { name: "settle", arguments: JSON.stringify({ answer: "missing id" }) },
              },
              {
                id: "call_interrupted",
                type: "function",
                function: { name: "speak", arguments: JSON.stringify({ message: "not acknowledged" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_blank", content: "(delivered)" },
          { role: "user", content: "next turn started before tool ack" },
          { role: "tool", tool_call_id: "call_interrupted", content: "(spoken)" },
        ],
        state: {},
      })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toContain("agent responded but response was empty")
  })

  it("returns empty message when session readback has no assistant message", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [],
    })
    mockLoadSession
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
        ],
        state: {},
      })

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "voice",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toContain("agent responded but response was empty")
  })

  it("returns empty message when session has messages but no assistant content", async () => {
    mockHandleInboundTurn.mockImplementation(async () => {
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    // Session exists but assistant message is empty
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "   " },
      ],
      state: {},
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toContain("agent responded but response was empty")
  })

  describe("event-backed terminal authority", () => {
    const oldUser = makeSessionEvent({ id: "evt-old-user", sequence: 1, role: "user", content: "Old question" })
    const oldAnswer = makeSessionEvent({ id: "evt-old-answer", sequence: 2, role: "assistant", content: "Unmistakable old answer" })
    const existingMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: "system" },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Unmistakable old answer" },
    ]

    async function runTerminalFixture(input: {
      persistedEvents: SessionEvent[]
      turnMessages?: ChatCompletionMessageParam[]
      existingEvents?: SessionEvent[]
      existingMessages?: ChatCompletionMessageParam[]
      completionAnswer?: string
      actions?: (callbacks: ChannelCallbacks) => Promise<void> | void
      reload?: { messages?: ChatCompletionMessageParam[]; events?: SessionEvent[]; state?: Record<string, unknown> } | null
      failDelivery?: boolean
    }) {
      const delivered: Array<{ kind: string; text: string }> = []
      const initialSession = {
        messages: input.existingMessages ?? existingMessages,
        events: input.existingEvents ?? [oldUser, oldAnswer],
      }
      mockReadSessionTransaction.mockReset().mockReturnValue({
        bytes: input.reload ? JSON.stringify(makeSessionEnvelopeValue(input.reload.events ?? [])) : "",
        value: input.reload ? makeSessionEnvelopeValue(input.reload.events ?? []) : null,
        revision: "revision-a",
      })
      mockLoadSession.mockReset().mockReturnValueOnce(initialSession).mockReturnValue(input.reload ?? null)
      mockDeferPostTurnPersist.mockReset().mockResolvedValue(input.persistedEvents)
      mockHandleInboundTurn.mockImplementationOnce(async (turn: any) => {
        await input.actions?.(turn.callbacks)
        await turn.postTurn(input.turnMessages ?? [], "/tmp/session.json")
        return {
          resolvedContext: makeResolvedContext(),
          gateResult: { allowed: true },
          turnOutcome: "settled",
          sessionPath: "/tmp/session.json",
          messages: input.turnMessages ?? [],
          ...(input.completionAnswer === undefined ? {} : { completion: { answer: input.completionAnswer, intent: "complete" } }),
        }
      })
      const { runSenseTurn } = await import("../../senses/shared-turn")
      const result = await runSenseTurn({
        agentName: "test-agent",
        channel: "telegram",
        sessionKey: "terminal-authority",
        friendId: "friend-1",
        userMessage: "Current question",
        deliverySink: {
          onDelivery: async (delivery) => {
            if (input.failDelivery) throw new Error("telegram send failed before acceptance")
            delivered.push(delivery)
          },
        },
      })
      return { delivered, result }
    }

    it("selects the accepted final from events after substantial message-prefix replacement", async () => {
      const historyMessages: ChatCompletionMessageParam[] = [{ role: "system", content: "system" }]
      const historyEvents: SessionEvent[] = []
      for (let index = 0; index < 12; index++) {
        const sequence = index * 2 + 1
        historyMessages.push({ role: "user", content: `Old question ${index}` }, { role: "assistant", content: `Unmistakable old answer ${index}` })
        historyEvents.push(
          makeSessionEvent({ id: `evt-old-user-${index}`, sequence, role: "user", content: `Old question ${index}` }),
          makeSessionEvent({ id: `evt-old-answer-${index}`, sequence: sequence + 1, role: "assistant", content: `Unmistakable old answer ${index}` }),
        )
      }
      const ingress = makeSessionEvent({ id: "evt-current-user", sequence: 25, role: "user", content: "Current question" })
      const draftCall = makeToolCall("catalog-1", "sanctuary_search_media_catalog", { query: "" })
      const persistedEvents = [
        ...historyEvents,
        ingress,
        makeSessionEvent({ id: "evt-current-draft", sequence: 26, role: "assistant", content: "Current catalog draft", toolCalls: [draftCall] }),
        makeSessionEvent({ id: "evt-current-tool", sequence: 27, role: "tool", content: "{\"totalItems\":11870}", toolCallId: "catalog-1" }),
        makeSessionEvent({ id: "evt-current-final", sequence: 28, role: "assistant", content: "Current accepted final" }),
      ]
      const trimmedMessages: ChatCompletionMessageParam[] = [
        { role: "system", content: "system" },
        { role: "user", content: "Current question" },
        { role: "assistant", content: "Current catalog draft", tool_calls: [draftCall] },
        { role: "tool", tool_call_id: "catalog-1", content: "{\"totalItems\":11870}" },
        { role: "assistant", content: "Current accepted final" },
      ]

      const { delivered, result } = await runTerminalFixture({ persistedEvents, turnMessages: trimmedMessages, existingEvents: historyEvents, existingMessages: historyMessages })

      expect(delivered).toEqual([{ kind: "text", text: "Current accepted final" }])
      expect(result.response).toBe("Current accepted final")
      expect(result.causalSessionEventIds).toEqual(["evt-current-final"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(result.response).not.toContain("Unmistakable old answer")
      expect(result.response).not.toContain("Current catalog draft")
    })

    it("uses immediate persisted event truth despite contradictory turn messages", async () => {
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [
          oldUser,
          oldAnswer,
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-final", sequence: 4, role: "assistant", content: "Event-backed final" }),
        ],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "POISONED CONTRADICTORY MESSAGE" }],
      })

      expect(delivered).toEqual([{ kind: "text", text: "Event-backed final" }])
      expect(result.response).toBe("Event-backed final")
      expect(result.causalSessionEventIds).toEqual(["evt-final"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(result.response).not.toContain("POISONED CONTRADICTORY MESSAGE")
    })

    it("uses acknowledged settle event truth despite contradictory turn messages", async () => {
      const persistedSettle = makeToolCall("settle-1", "settle", { answer: "Event-backed settled final", intent: "complete" })
      const poisonedSettle = makeToolCall("settle-1", "settle", { answer: "POISONED CONTRADICTORY SETTLE", intent: "complete" })
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [
          oldUser,
          oldAnswer,
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-settle", sequence: 4, role: "assistant", toolCalls: [persistedSettle] }),
          makeSessionEvent({ id: "evt-settle-ack", sequence: 5, role: "tool", content: "(delivered)", toolCallId: "settle-1" }),
        ],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: null, tool_calls: [poisonedSettle] }, { role: "tool", tool_call_id: "settle-1", content: "(delivered)" }],
        actions: (callbacks) => { callbacks.onToolEnd("settle", "complete", true) },
      })

      expect(delivered).toEqual([{ kind: "settle", text: "Event-backed settled final" }])
      expect(result.response).toBe("Event-backed settled final")
      expect(result.causalSessionEventIds).toEqual(["evt-settle"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(result.response).not.toContain("POISONED CONTRADICTORY SETTLE")
    })

    it.each([
      {
        name: "think-only",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "<think>private reasoning</think>" }),
        message: { role: "assistant", content: "<think>private reasoning</think>" } as ChatCompletionMessageParam,
        trailingEvents: [] as SessionEvent[],
        trailingMessages: [] as ChatCompletionMessageParam[],
      },
      {
        name: "synthetic",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "Synthetic later answer", captureKind: "synthetic" }),
        message: { role: "assistant", content: "Synthetic later answer" } as ChatCompletionMessageParam,
        trailingEvents: [] as SessionEvent[],
        trailingMessages: [] as ChatCompletionMessageParam[],
      },
      {
        name: "ordinary-tool-bearing",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "Ordinary tool draft", toolCalls: [makeToolCall("read-1", "sanctuary_search_media_catalog", {})] }),
        message: { role: "assistant", content: "Ordinary tool draft", tool_calls: [makeToolCall("read-1", "sanctuary_search_media_catalog", {})] } as ChatCompletionMessageParam,
        trailingEvents: [makeSessionEvent({ id: "evt-read-result", sequence: 6, role: "tool", content: "{}", toolCallId: "read-1" })],
        trailingMessages: [{ role: "tool", tool_call_id: "read-1", content: "{}" }] as ChatCompletionMessageParam[],
      },
      {
        name: "malformed-speak",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", toolCalls: [makeToolCall("speak-1", "speak", "{")] }),
        message: { role: "assistant", content: null, tool_calls: [makeToolCall("speak-1", "speak", "{")] } as ChatCompletionMessageParam,
        trailingEvents: [makeSessionEvent({ id: "evt-speak-ack", sequence: 6, role: "tool", content: "(spoken)", toolCallId: "speak-1" })],
        trailingMessages: [{ role: "tool", tool_call_id: "speak-1", content: "(spoken)" }] as ChatCompletionMessageParam[],
      },
      {
        name: "malformed-settle",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", toolCalls: [makeToolCall("settle-1", "settle", { answer: 42 })] }),
        message: { role: "assistant", content: null, tool_calls: [makeToolCall("settle-1", "settle", { answer: 42 })] } as ChatCompletionMessageParam,
        trailingEvents: [makeSessionEvent({ id: "evt-settle-ack", sequence: 6, role: "tool", content: "(delivered)", toolCallId: "settle-1" })],
        trailingMessages: [{ role: "tool", tool_call_id: "settle-1", content: "(delivered)" }] as ChatCompletionMessageParam[],
      },
      {
        name: "missing-exact-ack",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", toolCalls: [makeToolCall("settle-1", "settle", { answer: "Unacknowledged later answer" })] }),
        message: { role: "assistant", content: null, tool_calls: [makeToolCall("settle-1", "settle", { answer: "Unacknowledged later answer" })] } as ChatCompletionMessageParam,
        trailingEvents: [] as SessionEvent[],
        trailingMessages: [] as ChatCompletionMessageParam[],
      },
      {
        name: "private-ack-token",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", toolCalls: [makeToolCall("settle-1", "settle", { answer: "Privately settled later answer" })] }),
        message: { role: "assistant", content: null, tool_calls: [makeToolCall("settle-1", "settle", { answer: "Privately settled later answer" })] } as ChatCompletionMessageParam,
        trailingEvents: [makeSessionEvent({ id: "evt-private-ack", sequence: 6, role: "tool", content: "(settled)", toolCallId: "settle-1" })],
        trailingMessages: [{ role: "tool", tool_call_id: "settle-1", content: "(settled)" }] as ChatCompletionMessageParam[],
      },
      {
        name: "right-token-wrong-tool-call-id",
        event: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", toolCalls: [makeToolCall("speak-1", "speak", { message: "Wrongly acknowledged later answer" })] }),
        message: { role: "assistant", content: null, tool_calls: [makeToolCall("speak-1", "speak", { message: "Wrongly acknowledged later answer" })] } as ChatCompletionMessageParam,
        trailingEvents: [makeSessionEvent({ id: "evt-wrong-ack", sequence: 6, role: "tool", content: "(spoken)", toolCallId: "different-call" })],
        trailingMessages: [{ role: "tool", tool_call_id: "different-call", content: "(spoken)" }] as ChatCompletionMessageParam[],
      },
    ])("fails closed on an ineligible newest assistant: $name", async ({ event, message, trailingEvents, trailingMessages }) => {
      const ingress = makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" })
      const draft = makeSessionEvent({ id: "evt-earlier-draft", sequence: 4, role: "assistant", content: "Earlier valid-looking draft" })
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [oldUser, oldAnswer, ingress, draft, event, ...trailingEvents],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Earlier valid-looking draft" }, message, ...trailingMessages],
      })

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(result.response).not.toContain("Earlier valid-looking draft")
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(result.causalSessionEventIds).toBeUndefined()
    })

    it("accepts a newest live plain assistant", async () => {
      const persistedEvents = [
        oldUser,
        oldAnswer,
        makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
        makeSessionEvent({ id: "evt-final", sequence: 4, role: "assistant", content: "Live plain final" }),
      ]
      const { delivered, result } = await runTerminalFixture({ persistedEvents, turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Live plain final" }] })

      expect(delivered).toEqual([{ kind: "text", text: "Live plain final" }])
      expect(result.causalSessionEventIds).toEqual(["evt-final"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("accepts one acknowledged speak without redelivering it", async () => {
      const speak = makeToolCall("speak-1", "speak", { message: "One spoken update" })
      const persistedEvents = [
        oldUser,
        oldAnswer,
        makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
        makeSessionEvent({ id: "evt-speak", sequence: 4, role: "assistant", toolCalls: [speak] }),
        makeSessionEvent({ id: "evt-speak-ack", sequence: 5, role: "tool", content: "(spoken)", toolCallId: "speak-1" }),
      ]
      const { delivered, result } = await runTerminalFixture({
        persistedEvents,
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: null, tool_calls: [speak] }, { role: "tool", tool_call_id: "speak-1", content: "(spoken)" }],
        actions: async (callbacks) => { callbacks.onTextChunk("One spoken update"); await callbacks.flushNow() },
      })

      expect(delivered).toEqual([{ kind: "speak", text: "One spoken update" }])
      expect(result.response).toBe("One spoken update")
      expect(result.causalSessionEventIds).toEqual(["evt-speak"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("reserves a retained duplicate terminal coordinate for the latest matching delivered effect", async () => {
      const repeated = "Same spoken update"
      const newestSpeak = makeToolCall("speak-newest", "speak", { message: repeated })
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-speak-newest", sequence: 4, role: "assistant", toolCalls: [newestSpeak] }),
          makeSessionEvent({ id: "evt-speak-newest-ack", sequence: 5, role: "tool", content: "(spoken)", toolCallId: "speak-newest" }),
        ],
        turnMessages: [{ role: "user", content: "Current question" }, { role: "assistant", content: null, tool_calls: [newestSpeak] }, { role: "tool", tool_call_id: "speak-newest", content: "(spoken)" }],
        actions: async (callbacks) => {
          callbacks.onTextChunk(repeated)
          await callbacks.flushNow()
          callbacks.onTextChunk(repeated)
          await callbacks.flushNow()
        },
      })

      expect(delivered).toEqual([{ kind: "speak", text: repeated }, { kind: "speak", text: repeated }])
      expect(result.causalSessionEventIds).toEqual([null, "evt-speak-newest"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("accepts a newest acknowledged settle", async () => {
      const settle = makeToolCall("settle-1", "settle", { answer: "One settled final", intent: "complete" })
      const persistedEvents = [
        oldUser,
        oldAnswer,
        makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
        makeSessionEvent({ id: "evt-settle", sequence: 4, role: "assistant", toolCalls: [settle] }),
        makeSessionEvent({ id: "evt-settle-ack", sequence: 5, role: "tool", content: "(delivered)", toolCallId: "settle-1" }),
      ]
      const { delivered, result } = await runTerminalFixture({
        persistedEvents,
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: null, tool_calls: [settle] }, { role: "tool", tool_call_id: "settle-1", content: "(delivered)" }],
        actions: (callbacks) => { callbacks.onToolEnd("settle", "complete", true) },
      })

      expect(delivered).toEqual([{ kind: "settle", text: "One settled final" }])
      expect(result.causalSessionEventIds).toEqual(["evt-settle"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("aligns one successful mid-turn speak and the newest final settle without redelivery", async () => {
      const speak = makeToolCall("speak-1", "speak", { message: "Mid-turn update" })
      const settle = makeToolCall("settle-1", "settle", { answer: "Final settled answer", intent: "complete" })
      const persistedEvents = [
        oldUser,
        oldAnswer,
        makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
        makeSessionEvent({ id: "evt-speak", sequence: 4, role: "assistant", toolCalls: [speak] }),
        makeSessionEvent({ id: "evt-speak-ack", sequence: 5, role: "tool", content: "(spoken)", toolCallId: "speak-1" }),
        makeSessionEvent({ id: "evt-settle", sequence: 6, role: "assistant", toolCalls: [settle] }),
        makeSessionEvent({ id: "evt-settle-ack", sequence: 7, role: "tool", content: "(delivered)", toolCallId: "settle-1" }),
      ]
      const { delivered, result } = await runTerminalFixture({
        persistedEvents,
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: null, tool_calls: [speak] }, { role: "tool", tool_call_id: "speak-1", content: "(spoken)" }, { role: "assistant", content: null, tool_calls: [settle] }, { role: "tool", tool_call_id: "settle-1", content: "(delivered)" }],
        completionAnswer: "Final settled answer",
        actions: async (callbacks) => {
          callbacks.onTextChunk("Mid-turn update")
          await callbacks.flushNow()
          callbacks.onToolEnd("settle", "complete", true)
          callbacks.onClearText()
          callbacks.onTextChunk("Final settled answer")
        },
      })

      expect(delivered).toEqual([{ kind: "speak", text: "Mid-turn update" }, { kind: "settle", text: "Final settled answer" }])
      expect(result.causalSessionEventIds).toEqual(["evt-speak", "evt-settle"])
      expect(result.response).toBe("Mid-turn update\nFinal settled answer")
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("keeps completion visible without persistence and leaves causality null", async () => {
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [],
        completionAnswer: "Validated completion survives",
        actions: (callbacks) => { callbacks.onTextChunk("Provisional callback"); callbacks.onTextChunk("Validated completion survives") },
      })

      expect(delivered).toEqual([{ kind: "text", text: "Validated completion survives" }])
      expect(result.response).toBe("Validated completion survives")
      expect(result.causalSessionEventIds).toEqual([null])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it.each([
      { name: "unresolved ingress", events: [oldUser, oldAnswer, makeSessionEvent({ id: "evt-unbound", sequence: 3, role: "assistant", content: "Different persisted text" })] },
      { name: "newest text mismatch", events: [oldUser, oldAnswer, makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }), makeSessionEvent({ id: "evt-mismatch", sequence: 4, role: "assistant", content: "Different persisted text" })] },
    ])("keeps completion visible but unbound with $name", async ({ events }) => {
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: events,
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Validated completion survives" }],
        completionAnswer: "Validated completion survives",
        actions: (callbacks) => { callbacks.onTextChunk("Validated completion survives") },
      })

      expect(delivered).toEqual([{ kind: "text", text: "Validated completion survives" }])
      expect(result.causalSessionEventIds).toEqual([null])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it.each([
      { name: "absent completion", completionAnswer: undefined },
      { name: "blank completion", completionAnswer: "   " },
    ])("does not search backward for old text when completion is $name", async ({ completionAnswer }) => {
      const ordinary = makeToolCall("read-1", "sanctuary_search_media_catalog", {})
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [
          oldUser,
          oldAnswer,
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-earlier-draft", sequence: 4, role: "assistant", content: "Earlier draft must stay hidden" }),
          makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "Ordinary tool draft", toolCalls: [ordinary] }),
          makeSessionEvent({ id: "evt-read-result", sequence: 6, role: "tool", content: "{}", toolCallId: "read-1" }),
        ],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Earlier draft must stay hidden" }, { role: "assistant", content: "Ordinary tool draft", tool_calls: [ordinary] }, { role: "tool", tool_call_id: "read-1", content: "{}" }],
        ...(completionAnswer === undefined ? {} : { completionAnswer }),
      })

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(result.causalSessionEventIds).toBeUndefined()
    })

    it("binds exact completion only to the eligible newest terminal coordinate", async () => {
      const { result } = await runTerminalFixture({
        persistedEvents: [
          oldUser,
          oldAnswer,
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-final", sequence: 4, role: "assistant", content: "Exact completion" }),
        ],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Exact completion" }],
        completionAnswer: "Exact completion",
        actions: (callbacks) => { callbacks.onTextChunk("Exact completion") },
      })

      expect(result.causalSessionEventIds).toEqual(["evt-final"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("binds duplicate terminal text only to the newest eligible event", async () => {
      const { result } = await runTerminalFixture({
        persistedEvents: [
          oldUser,
          oldAnswer,
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-earlier-same", sequence: 4, role: "assistant", content: "Same final text" }),
          makeSessionEvent({ id: "evt-newest-same", sequence: 5, role: "assistant", content: "Same final text" }),
        ],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Same final text" }, { role: "assistant", content: "Same final text" }],
        completionAnswer: "Same final text",
        actions: (callbacks) => { callbacks.onTextChunk("Same final text") },
      })

      expect(result.causalSessionEventIds).toEqual(["evt-newest-same"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it.each([
      {
        name: "newest event is synthetic",
        newest: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "Same final text", captureKind: "synthetic" }),
        trailing: [] as SessionEvent[],
      },
      {
        name: "newest coordinate differs by kind",
        newest: makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", toolCalls: [makeToolCall("settle-1", "settle", { answer: "Same final text" })] }),
        trailing: [makeSessionEvent({ id: "evt-newest-ack", sequence: 6, role: "tool", content: "(delivered)", toolCallId: "settle-1" })],
      },
    ])("does not bind an earlier duplicate when $name", async ({ newest, trailing }) => {
      const { result } = await runTerminalFixture({
        persistedEvents: [
          oldUser,
          oldAnswer,
          makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
          makeSessionEvent({ id: "evt-earlier-same", sequence: 4, role: "assistant", content: "Same final text" }),
          newest,
          ...trailing,
        ],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Same final text" }],
        completionAnswer: "Same final text",
        actions: (callbacks) => { callbacks.onTextChunk("Same final text") },
      })

      expect(result.response).toBe("Same final text")
      expect(result.causalSessionEventIds).toEqual([null])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    const validOrderedEvents = () => [
      structuredClone(oldUser),
      structuredClone(oldAnswer),
      makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
      makeSessionEvent({ id: "evt-final", sequence: 4, role: "assistant", content: "Ordered final" }),
    ]

    it.each([
      { name: "blank event ID", mutate: (events: SessionEvent[]) => { events[3]!.id = "   " } },
      { name: "duplicate event ID", mutate: (events: SessionEvent[]) => { events[3]!.id = events[2]!.id } },
      { name: "duplicate sequence", mutate: (events: SessionEvent[]) => { events[3]!.sequence = events[2]!.sequence } },
      { name: "zero sequence", mutate: (events: SessionEvent[]) => { events[3]!.sequence = 0 } },
      { name: "negative sequence", mutate: (events: SessionEvent[]) => { events[3]!.sequence = -1 } },
      { name: "fractional sequence", mutate: (events: SessionEvent[]) => { events[3]!.sequence = 3.5 } },
      { name: "non-finite sequence", mutate: (events: SessionEvent[]) => { events[3]!.sequence = Number.POSITIVE_INFINITY } },
      { name: "string-like sequence", mutate: (events: SessionEvent[]) => { (events[3] as unknown as { sequence: string }).sequence = "4" } },
      { name: "missing sequence", mutate: (events: SessionEvent[]) => { delete (events[3] as unknown as { sequence?: number }).sequence } },
      { name: "decreasing sequence", mutate: (events: SessionEvent[]) => { events[3]!.sequence = 2 } },
      { name: "duplicate ingress ID", mutate: (events: SessionEvent[]) => { events.splice(3, 0, makeSessionEvent({ id: "evt-current-user", sequence: 4, role: "user", content: "Current question" })); events[4]!.sequence = 5 } },
      { name: "two distinct matching ingresses", mutate: (events: SessionEvent[]) => { events.splice(3, 0, makeSessionEvent({ id: "evt-current-user-duplicate", sequence: 4, role: "user", content: "Current question" })); events[4]!.sequence = 5 } },
      { name: "missing ingress", mutate: (events: SessionEvent[]) => { events.splice(2, 1); events[2]!.sequence = 3 } },
      { name: "pre-turn ID after ingress", mutate: (events: SessionEvent[]) => { const old = structuredClone(events.splice(1, 1)[0]!); old.sequence = 4; events.splice(2, 0, old); events[3]!.sequence = 5 } },
      { name: "pre-ingress blank event ID", mutate: (events: SessionEvent[]) => { events[0]!.id = "   " } },
      { name: "pre-ingress duplicate sequence", mutate: (events: SessionEvent[]) => { events[1]!.sequence = events[0]!.sequence } },
    ])("rejects a corrupt terminal event stream: $name", async ({ mutate }) => {
      const events = validOrderedEvents()
      mutate(events)
      const { delivered, result } = await runTerminalFixture({ persistedEvents: events, turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Ordered final" }] })

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(result.causalSessionEventIds).toBeUndefined()
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(mockLoadSession).toHaveBeenCalledTimes(1)
    })

    it("accepts a strictly increasing event sequence with gaps", async () => {
      const gapOldUser = makeSessionEvent({ id: "evt-old-user", sequence: 10, role: "user", content: "Old question" })
      const gapOldAnswer = makeSessionEvent({ id: "evt-old-answer", sequence: 20, role: "assistant", content: "Unmistakable old answer" })
      const { delivered, result } = await runTerminalFixture({
        existingEvents: [gapOldUser, gapOldAnswer],
        persistedEvents: [gapOldUser, gapOldAnswer, makeSessionEvent({ id: "evt-current-user", sequence: 30, role: "user", content: "Current question" }), makeSessionEvent({ id: "evt-final", sequence: 50, role: "assistant", content: "Gapped final" })],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Gapped final" }],
      })

      expect(delivered).toEqual([{ kind: "text", text: "Gapped final" }])
      expect(result.causalSessionEventIds).toEqual(["evt-final"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it("reloads events only after an empty persisted snapshot and recomputes ingress", async () => {
      const reloadedEvents = validOrderedEvents()
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: [],
        turnMessages: [],
        reload: { events: reloadedEvents, messages: [{ role: "assistant", content: "POISONED STALE RELOAD MESSAGE" }], state: {} },
      })

      expect(delivered).toEqual([{ kind: "text", text: "Ordered final" }])
      expect(result.causalSessionEventIds).toEqual(["evt-final"])
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(mockLoadSession).toHaveBeenCalledTimes(1)
    })

    it.each([
      { name: "invalid", reloadEvents: (() => { const events = validOrderedEvents(); events[3]!.sequence = 0; return events })() },
      { name: "newest-ineligible", reloadEvents: [oldUser, oldAnswer, makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }), makeSessionEvent({ id: "evt-draft", sequence: 4, role: "assistant", content: "Earlier reload draft" }), makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "Synthetic reload answer", captureKind: "synthetic" })] },
    ])("fails closed when an empty snapshot reloads $name events despite tempting messages", async ({ reloadEvents }) => {
      const { delivered, result } = await runTerminalFixture({ persistedEvents: [], turnMessages: [], reload: { events: reloadEvents, messages: [{ role: "assistant", content: "TEMPTING RELOAD MESSAGE" }], state: {} } })

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(result.causalSessionEventIds).toBeUndefined()
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(mockLoadSession).toHaveBeenCalledTimes(1)
    })

    async function runRawReloadFixture(rawEvents: Array<Record<string, unknown>>, version = 2) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-turn-raw-reload-"))
      const originalRoot = "/tmp/test-agent"
      mockGetAgentRoot.mockReturnValue(root)
      const sessionPath = path.join(root, "state", "sessions", "friend-1", "telegram", "terminal-raw-reload.json")
      await mockActualSessionEnvelope(sessionPath, makeSessionEnvelopeValue([structuredClone(oldUser), structuredClone(oldAnswer)]))
      mockDeferPostTurnPersist.mockReset().mockImplementation(async () => {
        const envelope = makeSessionEnvelopeValue(rawEvents as unknown as SessionEvent[])
        envelope.version = version
        fs.writeFileSync(sessionPath, JSON.stringify(envelope))
        return []
      })
      mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
        await input.postTurn([], sessionPath)
        return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", messages: [] }
      })
      const delivered: string[] = []
      const { runSenseTurn } = await import("../../senses/shared-turn")

      try {
        const result = await runSenseTurn({ agentName: "test-agent", channel: "telegram", sessionKey: "terminal-raw-reload", friendId: "friend-1", userMessage: "Current question", deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } } })
        return { delivered, result, readCount: mockReadSessionTransaction.mock.calls.length, loadCount: mockLoadSession.mock.calls.length }
      } finally {
        mockGetAgentRoot.mockReturnValue(originalRoot)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }

    it.each([
      {
        name: "missing sequence",
        version: 2,
        mutate: (events: Array<Record<string, unknown>>) => { delete events.at(-1)!.sequence },
      },
      {
        name: "missing provenance",
        version: 2,
        mutate: (events: Array<Record<string, unknown>>) => { delete events.at(-1)!.provenance },
      },
      {
        name: "duplicate event IDs",
        version: 2,
        mutate: (events: Array<Record<string, unknown>>) => {
          const duplicate = structuredClone(events[1]!)
          duplicate.sequence = 3
          events[2]!.sequence = 4
          events[3]!.sequence = 5
          events.splice(2, 0, duplicate)
        },
      },
      {
        name: "non-v2 transaction envelope",
        version: 1,
        mutate: (events: Array<Record<string, unknown>>) => events,
      },
    ])("rejects $name in raw reloaded transaction bytes before session normalization", async ({ mutate, version }) => {
      const rawEvents = validOrderedEvents().map((event) => structuredClone(event) as unknown as Record<string, unknown>)
      mutate(rawEvents)
      const { delivered, result, readCount, loadCount } = await runRawReloadFixture(rawEvents, version)

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(result.causalSessionEventIds).toBeUndefined()
      expect(result.responseCausalSessionEventId).toBeUndefined()
      expect(readCount).toBe(2)
      expect(loadCount).toBe(1)
    })

    it.each([
      { name: "synthetic acknowledgement", mutate: (events: Array<Record<string, unknown>>) => { (events[4]!.provenance as Record<string, unknown>).captureKind = "synthetic" } },
      { name: "missing acknowledgement provenance", mutate: (events: Array<Record<string, unknown>>) => { delete events[4]!.provenance } },
      { name: "missing assistant call ID", mutate: (events: Array<Record<string, unknown>>) => { delete ((events[3]!.toolCalls as Array<Record<string, unknown>>)[0]!).id } },
      { name: "blank assistant call ID", mutate: (events: Array<Record<string, unknown>>) => { ((events[3]!.toolCalls as Array<Record<string, unknown>>)[0]!).id = "   " } },
      { name: "missing acknowledgement call ID", mutate: (events: Array<Record<string, unknown>>) => { delete events[4]!.toolCallId } },
      { name: "blank acknowledgement call ID", mutate: (events: Array<Record<string, unknown>>) => { events[4]!.toolCallId = "   " } },
      { name: "missing acknowledgement relation call ID", mutate: (events: Array<Record<string, unknown>>) => { delete (events[4]!.relations as Record<string, unknown>).toolCallId } },
      { name: "blank acknowledgement relation call ID", mutate: (events: Array<Record<string, unknown>>) => { (events[4]!.relations as Record<string, unknown>).toolCallId = "   " } },
      { name: "conflicting acknowledgement relation call ID", mutate: (events: Array<Record<string, unknown>>) => { (events[4]!.relations as Record<string, unknown>).toolCallId = "different-call" } },
      { name: "nested acknowledgement tool call", mutate: (events: Array<Record<string, unknown>>) => { events[4]!.toolCalls = [makeToolCall("nested", "settle", { answer: "not an acknowledgement" })] } },
      { name: "whitespace-padded acknowledgement token", mutate: (events: Array<Record<string, unknown>>) => { events[4]!.content = " (delivered) " } },
      { name: "non-tool event before acknowledgement", mutate: (events: Array<Record<string, unknown>>) => { events[4]!.role = "user" } },
      { name: "malformed matching acknowledgement before a later valid one", mutate: (events: Array<Record<string, unknown>>) => { events[4]!.content = "(settled)"; events.push(makeSessionEvent({ id: "evt-late-ack", sequence: 6, role: "tool", content: "(delivered)", toolCallId: "settle-1" }) as unknown as Record<string, unknown>) } },
    ])("rejects a structurally untrusted durable settle acknowledgement after raw reload: $name", async ({ mutate }) => {
      const settle = makeToolCall("settle-1", "settle", { answer: "Durable settled final", intent: "complete" })
      const rawEvents = [
        structuredClone(oldUser),
        structuredClone(oldAnswer),
        makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }),
        makeSessionEvent({ id: "evt-settle", sequence: 4, role: "assistant", toolCalls: [settle] }),
        makeSessionEvent({ id: "evt-settle-ack", sequence: 5, role: "tool", content: "(delivered)", toolCallId: "settle-1" }),
      ].map((event) => structuredClone(event) as unknown as Record<string, unknown>)
      mutate(rawEvents)

      const { delivered, result } = await runRawReloadFixture(rawEvents)

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(result.causalSessionEventIds).toBeUndefined()
      expect(result.responseCausalSessionEventId).toBeUndefined()
    })

    it.each([
      {
        name: "invalid",
        persistedEvents: (() => { const events = validOrderedEvents(); events[3]!.sequence = 0; return events })(),
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Ordered final" }] as ChatCompletionMessageParam[],
      },
      {
        name: "newest-ineligible",
        persistedEvents: [oldUser, oldAnswer, makeSessionEvent({ id: "evt-current-user", sequence: 3, role: "user", content: "Current question" }), makeSessionEvent({ id: "evt-draft", sequence: 4, role: "assistant", content: "Earlier draft" }), makeSessionEvent({ id: "evt-newest", sequence: 5, role: "assistant", content: "Synthetic final", captureKind: "synthetic" })],
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Earlier draft" }, { role: "assistant", content: "Synthetic final" }] as ChatCompletionMessageParam[],
      },
    ])("does not reload a nonempty $name snapshot", async ({ persistedEvents, turnMessages }) => {
      const { delivered, result } = await runTerminalFixture({ persistedEvents, turnMessages, reload: { events: validOrderedEvents(), messages: [{ role: "assistant", content: "Ordered final" }], state: {} } })

      expect(delivered).toEqual([])
      expect(result.response).toBe("(agent responded but response was empty)")
      expect(mockLoadSession).toHaveBeenCalledTimes(1)
    })

    it("keeps the selected terminal coordinate when the first final delivery fails", async () => {
      const { delivered, result } = await runTerminalFixture({
        persistedEvents: validOrderedEvents(),
        turnMessages: [...existingMessages, { role: "user", content: "Current question" }, { role: "assistant", content: "Ordered final" }],
        completionAnswer: "Ordered final",
        actions: (callbacks) => { callbacks.onTextChunk("Ordered final") },
        failDelivery: true,
      })

      expect(delivered).toEqual([])
      expect(result.response).toBe("Ordered final")
      expect(result.deliveryFailures).toEqual([{ kind: "text", text: "Ordered final", error: "telegram send failed before acceptance" }])
      expect(result.responseDeliveryFailure).toEqual({ kind: "text", text: "Ordered final", error: "telegram send failed before acceptance" })
      expect(result.responseCausalSessionEventId).toBe("evt-final")
      expect(result.causalSessionEventIds).toBeUndefined()
    })
  })

  it("propagates errors from handleInboundTurn", async () => {
    mockHandleInboundTurn.mockRejectedValue(new Error("pipeline explosion"))
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })).rejects.toThrow("pipeline explosion")
  })

  it("fails closed when an allowed pipeline result omits its outcome", async () => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Malformed incidental text.")
      const events = [{ role: "assistant", content: "Malformed incidental text." }]
      await input.postTurn?.(events, "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, messages: events }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      deliverySink: { onDelivery: (delivery) => { delivered.push(delivery.text) } },
    })

    expect(delivered).toEqual([])
    expect(result.response).toBe("")
    expect(result.causalSessionEventIds).toBeUndefined()
  })

  it("runs the sense authorization barrier at the pipeline pre-provider boundary", async () => {
    let providerInvocationCount = 0
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      await input.prepareRunAgentOptions?.({ messages: [], currentUserMessages: [], resolvedContext: makeResolvedContext(), runAgentOptions: {} })
      providerInvocationCount += 1
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await expect(runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
      prepareRunAgentOptions: async () => { throw new Error("relationship revoked before provider") },
    })).rejects.toThrow("relationship revoked before provider")
    expect(providerInvocationCount).toBe(0)
  })
})

describe("runSenseTurn terminal causality coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSessionTransaction.mockReset().mockReturnValue({ bytes: "", value: null, revision: "revision-a" })
    mockLoadSession.mockReset().mockReturnValue(null)
    mockDeferPostTurnPersist.mockReset().mockResolvedValue([])
    setupSettledTurn()
    mockFriendResolve.mockResolvedValue(makeResolvedContext())
    mockWithSessionTurnLease.mockReset().mockImplementation(async (_sessionPath: string, work: (lease: any) => Promise<any>) => work({
      sessionPath: "/tmp/session.json",
      ownerId: "owner-a",
      ownerToken: "token-a",
      release: vi.fn(),
    }))
  })

  it("binds a referenced ingress rematerialized after precommit", async () => {
    const reference = "telegram-admission:rematerialized"
    const ingress = makeSessionEvent({ id: "evt-precommitted", sequence: 1, role: "user", content: "Current question", references: [reference] })
    mockSessionTransaction([ingress])
    mockLoadSession.mockReturnValue({
      messages: [{ role: "user", content: "Current question" }],
      events: [ingress],
      projectionEventIds: [ingress.id],
    })
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-rematerialized-user", sequence: 1, role: "user", content: "Current question", references: [reference] }),
      makeSessionEvent({ id: "evt-final", sequence: 2, role: "assistant", content: "Final answer" }),
    ])
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onTextChunk("Final answer")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Final answer", intent: "complete" }, messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "terminal-reference-precommit",
      friendId: "friend-1",
      userMessage: "Current question",
      precommittedIngress: { eventId: "evt-precommitted", reference },
    })

    expect(result.response).toBe("Final answer")
    expect(result.causalSessionEventIds).toEqual(["evt-final"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("rejects an unreferenced ingress rematerialized after precommit", async () => {
    const reference = "telegram-admission:rematerialized"
    const ingress = makeSessionEvent({ id: "evt-precommitted", sequence: 1, role: "user", content: "Current question", references: [reference] })
    mockSessionTransaction([ingress])
    mockLoadSession.mockReturnValue({
      messages: [{ role: "user", content: "Current question" }],
      events: [ingress],
      projectionEventIds: [ingress.id],
    })
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-unreferenced-user", sequence: 1, role: "user", content: "Current question" }),
      makeSessionEvent({ id: "evt-final", sequence: 2, role: "assistant", content: "Unrelated final" }),
    ])
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "terminal-reference-precommit-missing",
      friendId: "friend-1",
      userMessage: "Current question",
      precommittedIngress: { eventId: "evt-precommitted", reference },
    })

    expect(result.response).toBe("(agent responded but response was empty)")
    expect(result.deliveries).toEqual([])
    expect(result.causalSessionEventIds).toBeUndefined()
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("binds a synthesized ingress carrying its authenticated reference", async () => {
    const reference = "telegram-artifact:current"
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-current-user", sequence: 1, role: "user", content: "Current question", references: [reference] }),
      makeSessionEvent({ id: "evt-final", sequence: 2, role: "assistant", content: "Final answer" }),
    ])
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onTextChunk("Final answer")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Final answer", intent: "complete" }, messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "terminal-reference-synthesized",
      friendId: "friend-1",
      userMessage: "Current question",
      ingressRelations: { references: [reference] },
    })

    expect(result.response).toBe("Final answer")
    expect(result.causalSessionEventIds).toEqual(["evt-final"])
    expect(result.responseCausalSessionEventId).toBeUndefined()
  })

  it("omits a failed final attempt from successful causality while retaining its retry coordinate", async () => {
    const delivered: Array<{ kind: string; text: string }> = []
    mockDeferPostTurnPersist.mockResolvedValue([
      makeSessionEvent({ id: "evt-current-user", sequence: 1, role: "user", content: "Current question" }),
      makeSessionEvent({ id: "evt-speak", sequence: 2, role: "assistant", toolCalls: [makeToolCall("call-speak", "speak", { message: "Mid-turn update" })] }),
      makeSessionEvent({ id: "evt-speak-ack", sequence: 3, role: "tool", content: "(spoken)", toolCallId: "call-speak" }),
      makeSessionEvent({ id: "evt-final", sequence: 4, role: "assistant", content: "Final answer" }),
    ])
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.callbacks.onTextChunk("Mid-turn update")
      await input.callbacks.flushNow()
      input.callbacks.onTextChunk("Final answer")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "Final answer", intent: "complete" }, messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "telegram",
      sessionKey: "terminal-mixed-delivery",
      friendId: "friend-1",
      userMessage: "Current question",
      deliverySink: {
        onDelivery: (delivery) => {
          if (delivery.text === "Final answer") throw new Error("telegram send failed before acceptance")
          delivered.push(delivery)
        },
      },
    })

    expect(delivered).toEqual([{ kind: "speak", text: "Mid-turn update" }])
    expect(result.response).toBe("Mid-turn update\nFinal answer")
    expect(result.deliveryFailures).toEqual([{ kind: "text", text: "Final answer", error: "telegram send failed before acceptance" }])
    expect(result.causalSessionEventIds).toEqual(["evt-speak"])
    expect(result.responseCausalSessionEventId).toBe("evt-final")
  })
})

describe("stripThinkBlocks", () => {
  it("strips a single closed think block", async () => {
    const { stripThinkBlocks } = await import("../../senses/shared-turn")
    expect(stripThinkBlocks("<think>reasoning</think>actual answer")).toBe("actual answer")
  })

  it("strips an unclosed think block (drops everything from <think> onward)", async () => {
    const { stripThinkBlocks } = await import("../../senses/shared-turn")
    // This is the bug Slugger hit: minimax closes the think tag but emits no
    // following text, OR the close tag never arrives. Either way we drop it.
    expect(stripThinkBlocks("preamble<think>reasoning that never closes")).toBe("preamble")
    expect(stripThinkBlocks("<think>only reasoning")).toBe("")
  })

  it("strips multiple sequential think blocks", async () => {
    const { stripThinkBlocks } = await import("../../senses/shared-turn")
    expect(stripThinkBlocks("a<think>r1</think>b<think>r2</think>c")).toBe("abc")
  })

  it("returns empty string when input is only a think block", async () => {
    const { stripThinkBlocks } = await import("../../senses/shared-turn")
    expect(stripThinkBlocks("<think>just reasoning</think>")).toBe("")
  })

  it("preserves text without think blocks unchanged (modulo trim)", async () => {
    const { stripThinkBlocks } = await import("../../senses/shared-turn")
    expect(stripThinkBlocks("just text")).toBe("just text")
    expect(stripThinkBlocks("  just text  ")).toBe("just text")
  })
})

describe("runSenseTurn — only-reasoning recovery", () => {
  beforeEach(() => {
    vi.resetModules()
    mockHandleInboundTurn.mockReset()
  })

  it("returns a clear diagnostic when the agent emits only <think> reasoning with no settle", async () => {
    mockHandleInboundTurn.mockImplementation(async ({ callbacks }: { callbacks: ChannelCallbacks }) => {
      // Simulate a model that emits a closed think block but no final answer.
      // The streaming layer would send the reasoning to onReasoningChunk and
      // nothing to onTextChunk. The session readback sees the saved
      // assistant content with the think tags.
      callbacks.onReasoningChunk("turning the question over...")
      // No onTextChunk — that's the bug shape.
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled" } as InboundTurnResult
    })
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "what's up?" },
        { role: "assistant", content: "<think>turning the question over...</think>" },
      ],
      state: {},
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-only-think",
      friendId: "friend-1",
      userMessage: "hello",
    })
    // Pre-fix: result.response would be "<think>turning the question over...</think>"
    // (raw think content surfaces to the MCP client, renders as empty/garbled)
    expect(result.response).toContain("agent produced reasoning but no final answer")
    expect(result.response).not.toContain("<think>")
    expect(result.response).not.toContain("</think>")
  })

  it("returns the diagnostic when reasoning has no saved session readback", async () => {
    mockHandleInboundTurn.mockImplementation(async ({ callbacks }: { callbacks: ChannelCallbacks }) => {
      callbacks.onReasoningChunk("thinking without a terminal answer")
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        messages: [],
      } as InboundTurnResult
    })
    mockLoadSession.mockReturnValue(null)

    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-only-think-no-readback",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(result.response).toContain("agent produced reasoning but no final answer")
  })

  it("strips think blocks from a normal settle response that happened to include reasoning", async () => {
    mockHandleInboundTurn.mockImplementation(async ({ callbacks }: { callbacks: ChannelCallbacks }) => {
      // Model emitted a think block followed by the actual answer through onTextChunk.
      callbacks.onTextChunk("<think>thinking out loud</think>here is the actual answer")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "<think>thinking out loud</think>here is the actual answer", intent: "complete" } } as InboundTurnResult
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-mixed",
      friendId: "friend-1",
      userMessage: "hello",
    })
    expect(result.response).toBe("here is the actual answer")
  })
})
