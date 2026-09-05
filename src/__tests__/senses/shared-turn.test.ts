import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks } from "../../heart/core"
import type { FriendRecord, ResolvedContext, Channel, ChannelCapabilities } from "@ouro.bot/friends"
import type { InboundTurnResult } from "../../senses/pipeline"

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

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: (...args: any[]) => mockGetAgentName(...args),
    getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
    loadAgentConfig: (...args: any[]) => mockLoadAgentConfig(...args),
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

vi.mock("../../repertoire/mcp-manager", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/mcp-manager")>("../../repertoire/mcp-manager")
  return {
    ...actual,
    getSharedMcpManager: (...args: any[]) => mockGetSharedMcpManager(...args),
  }
})

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
})

describe("runSenseTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadSession.mockReset()
    mockLoadSession.mockReturnValue(null)
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
      "session:load",
      "provider:start",
      "session:persist",
      "outward:delivered",
      "lease:released",
    ])
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
      { id: "evt-rematerialized", role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.", toolCalls: [] },
      { id: "evt-user", role: "user", content: "Can you see the library now?", toolCalls: [] },
      { id: "evt-draft", role: "assistant", content: "Yes, I can see titles like The Pitt.", toolCalls: [{ function: { name: "sanctuary_search_media_catalog" } }] },
      { id: "evt-tool", role: "tool", content: JSON.stringify({ totalItems: 11_870 }), toolCalls: [] },
      { id: "evt-synthetic", role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.", toolCalls: [], provenance: { captureKind: "synthetic" } },
      { id: "evt-final", role: "assistant", content: "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.", toolCalls: [] },
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
      { id: "evt-user", role: "user", content: "Can you see it?", toolCalls: [] },
      { id: "evt-draft", role: "assistant", content: "An early guess.", toolCalls: [{ function: { name: "sanctuary_search_media_catalog" } }] },
      { id: "evt-final", role: "assistant", content: null, toolCalls: [{ id: "settle-1", function: { name: "settle", arguments: JSON.stringify({ answer: "Yes—the shelf is visible.", intent: "direct_reply" }) } }] },
      { id: "evt-final-ack", role: "tool", content: "(delivered)", toolCallId: "settle-1", toolCalls: [] },
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
  })

  it.each(["observed", "rested", "suspended", "errored", "superseded", "aborted"] as const)("does not deliver discarded callback prose for a %s turn", async (turnOutcome) => {
    const delivered: string[] = []
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("Discarded intermediate prose.")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome, sessionPath: "/tmp/session.json", messages: [] }
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
      { id: "evt-user", role: "user", content: "hello", toolCalls: [] },
      { id: "evt-rejected", role: "assistant", content: null, toolCalls: [{ id: "settle-reused", function: { name: "settle", arguments: JSON.stringify({ answer: "unsupported", intent: "complete" }) } }] },
      { id: "evt-rejection", role: "tool", content: "Use current evidence.", toolCallId: "settle-reused", toolCalls: [] },
      { id: "evt-accepted", role: "assistant", content: null, toolCalls: [{ id: "settle-reused", function: { name: "settle", arguments: JSON.stringify({ answer: "Grounded final answer.", intent: "complete" }) } }] },
      { id: "evt-accepted-ack", role: "tool", content: "(delivered)", toolCallId: "settle-reused", toolCalls: [] },
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

  it("claims an exact precommitted ingress event without synthesizing a second user message", async () => {
    const reference = "telegram-admission:abc123"
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }, { role: "user", content: "approved original" }],
      events: [{ id: "evt-000002", role: "user", content: "approved original", relations: { references: [reference] } }],
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

  it("fails causal binding closed when a persisted snapshot omits the precommitted ingress boundary", async () => {
    const reference = "telegram-admission:abc123"
    mockLoadSession.mockReturnValue({
      messages: [{ role: "system", content: "system" }, { role: "user", content: "approved original" }],
      events: [{ id: "evt-000002", role: "user", content: "approved original", relations: { references: [reference] } }],
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
    })

    expect(mockGetSharedMcpManager).toHaveBeenCalledWith({ runtimeServers: runtimeMcpServers })
  })

  it("calls getSharedMcpManager with undefined when no runtimeMcpServers are supplied", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    await runSenseTurn({
      agentName: "test-agent",
      channel: "mcp",
      sessionKey: "session-123",
      friendId: "friend-1",
      userMessage: "hello",
    })

    expect(mockGetSharedMcpManager).toHaveBeenCalledWith(undefined)
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
      { id: "evt-wrong-kind", role: "assistant", content: "quick voice update", toolCalls: [] },
      { id: "evt-user", role: "user", content: "hello", toolCalls: [] },
      { id: "evt-000001", role: "assistant", content: null, toolCalls: [{ id: "speak-1", function: { name: "speak", arguments: JSON.stringify({ message: "quick voice update" }) } }] },
      { id: "evt-speak-ack", role: "tool", content: "(spoken)", toolCallId: "speak-1", toolCalls: [] },
      { id: "evt-unrelated", role: "assistant", content: "an unrelated rematerialized answer", toolCalls: [] },
      { id: "evt-000002", role: "assistant", content: null, toolCalls: [{ id: "settle-1", function: { name: "settle", arguments: JSON.stringify({ answer: "final voice answer", intent: "complete" }) } }] },
      { id: "evt-settle-ack", role: "tool", content: "(delivered)", toolCallId: "settle-1", toolCalls: [] },
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
    expect(result.response).toBe("quick voice update\nfinal voice answer")
  })

  it("returns the exact new plain-assistant coordinate without considering older or non-assistant events", async () => {
    mockLoadSession.mockReturnValue({
      messages: [{ role: "assistant", content: "old" }],
      events: [{ id: "evt-old", role: "assistant" }],
    })
    mockDeferPostTurnPersist.mockResolvedValue([
      { id: "evt-old", role: "assistant", content: "old", toolCalls: [] },
      { id: "evt-user", role: "user", content: "hello", toolCalls: [] },
      { id: "evt-empty", role: "assistant", content: null, toolCalls: [] },
      { id: "evt-new", role: "assistant", content: "new", toolCalls: [] },
    ])
    mockHandleInboundTurn.mockImplementation(async (input: any) => {
      input.callbacks.onTextChunk("new")
      await input.postTurn([], "/tmp/session.json")
      return { resolvedContext: makeResolvedContext(), gateResult: { allowed: true }, turnOutcome: "settled", completion: { answer: "new", intent: "complete" }, sessionPath: "/tmp/session.json", messages: [] }
    })
    const { runSenseTurn } = await import("../../senses/shared-turn")

    const result = await runSenseTurn({ agentName: "test-agent", channel: "mcp", sessionKey: "session-123", friendId: "friend-1", userMessage: "hello" })

    expect(result.causalSessionEventIds).toEqual(["evt-new"])
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

  it("falls back to session transcript when no text from callbacks but session has assistant message", async () => {
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
    // When no text comes from callbacks, runSenseTurn re-loads the session
    const persistedEvents = [
      { id: "evt-user", role: "user", content: "hello", toolCalls: [] },
      { id: "evt-answer", role: "assistant", content: "recovered answer from session", toolCalls: [] },
    ]
    mockDeferPostTurnPersist.mockResolvedValue(persistedEvents)
    mockLoadSession.mockReturnValueOnce(null).mockReturnValue({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "recovered answer from session" },
      ],
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
    expect(result.responseCausalSessionEventId).toBe("evt-answer")
    expect(result.ponderDeferred).toBe(false)
  })

  it("uses a current-turn plain assistant message when callbacks emitted no text", async () => {
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: makeResolvedContext(),
      gateResult: { allowed: true },
      turnOutcome: "settled",
      sessionPath: "/tmp/session.json",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "authoritative current-turn answer" },
      ],
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
  })

  it("recovers delivered settle text from a tool-required assistant message", async () => {
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
            tool_calls: [{
              id: "call_settle",
              type: "function",
              function: {
                name: "settle",
                arguments: JSON.stringify({ answer: "me - I'm here\n\nwhat's up?", intent: "direct_reply" }),
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

    expect(result.response).toBe("me - I'm here\n\nwhat's up?")
  })

  it("recovers spoken tool text only after a spoken delivery ack", async () => {
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
              id: "call_speak",
              type: "function",
              function: {
                name: "speak",
                arguments: JSON.stringify({ message: "I can say this out loud." }),
              },
            }],
          },
          { role: "tool", tool_call_id: "call_speak", content: "(spoken)" },
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

    expect(result.response).toBe("I can say this out loud.")
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
