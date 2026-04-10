import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities } from "../../mind/friends/types"
import type { InboundTurnResult } from "../../senses/pipeline"

// ── Mocks ──────────────────────────────────────────────────────

const mockHandleInboundTurn = vi.fn()

vi.mock("../../senses/pipeline", async () => {
  const actual = await vi.importActual<typeof import("../../senses/pipeline")>("../../senses/pipeline")
  return {
    ...actual,
    handleInboundTurn: (...args: any[]) => mockHandleInboundTurn(...args),
  }
})

const mockGetProvider = vi.fn().mockReturnValue("anthropic")
const mockRunAgent = vi.fn()
const mockBuildSystem = vi.fn().mockResolvedValue("system prompt")

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

vi.mock("../../mind/context", async () => {
  const actual = await vi.importActual<typeof import("../../mind/context")>("../../mind/context")
  return {
    ...actual,
    loadSession: (...args: any[]) => mockLoadSession(...args),
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

vi.mock("../../mind/friends/channel", async () => {
  const actual = await vi.importActual<typeof import("../../mind/friends/channel")>("../../mind/friends/channel")
  return {
    ...actual,
    getChannelCapabilities: (...args: any[]) => mockGetChannelCapabilities(...args),
  }
})

const mockFriendResolve = vi.fn()

vi.mock("../../mind/friends/resolver", async () => {
  const actual = await vi.importActual<typeof import("../../mind/friends/resolver")>("../../mind/friends/resolver")
  return {
    ...actual,
    FriendResolver: vi.fn().mockImplementation(function () { return { resolve: (...args: any[]) => mockFriendResolve(...args) } }),
  }
})

const mockStoreInstance = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  findByExternalId: vi.fn().mockResolvedValue(null),
  hasAnyFriends: vi.fn().mockResolvedValue(true),
  listAll: vi.fn().mockResolvedValue([]),
}

vi.mock("../../mind/friends/store-file", async () => {
  const actual = await vi.importActual<typeof import("../../mind/friends/store-file")>("../../mind/friends/store-file")
  return {
    ...actual,
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

describe("runSenseTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSettledTurn()
    mockFriendResolve.mockResolvedValue(makeResolvedContext())
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

  it("handles gate rejection gracefully", async () => {
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
    // Should return empty or error message, not throw
    expect(result.response).toBeDefined()
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
    mockHandleInboundTurn.mockImplementation(async () => {
      return {
        resolvedContext: makeResolvedContext(),
        gateResult: { allowed: true },
        turnOutcome: "settled",
        sessionPath: "/tmp/session.json",
        messages: [],
      }
    })
    // When no text comes from callbacks, runSenseTurn re-loads the session
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "recovered answer from session" },
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
    expect(result.response).toBe("recovered answer from session")
    expect(result.ponderDeferred).toBe(false)
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
})
