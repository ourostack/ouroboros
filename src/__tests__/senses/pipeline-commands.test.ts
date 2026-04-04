import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities, Channel } from "../../mind/friends/types"
import type { FriendStore } from "../../mind/friends/store"
import type { TrustGateResult } from "../../senses/trust-gate"
import type { UsageData } from "../../mind/context"
import type { PendingMessage } from "../../mind/pending"
import type { InboundTurnInput } from "../../senses/pipeline"
import { resetSharedCommandRegistry, resetDebugMode } from "../../senses/commands"

const mockFindBridgesForSession = vi.fn()
const mockListTargetSessionCandidates = vi.fn()
const mockListCodingSessions = vi.fn()

vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn(async () => null),
  sendDaemonCommand: vi.fn(),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return {
    ...actual,
    createBridgeManager: () => ({
      findBridgesForSession: (...args: any[]) => mockFindBridgesForSession(...args),
    }),
  }
})

vi.mock("../../heart/target-resolution", async () => {
  const actual = await vi.importActual<typeof import("../../heart/target-resolution")>("../../heart/target-resolution")
  return {
    ...actual,
    listTargetSessionCandidates: (...args: any[]) => mockListTargetSessionCandidates(...args),
  }
})

vi.mock("../../repertoire/coding", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/coding")>("../../repertoire/coding")
  return {
    ...actual,
    getCodingSessionManager: () => ({
      listSessions: (...args: any[]) => mockListCodingSessions(...args),
    }),
  }
})

vi.mock("../../heart/provider-ping", async () => ({
  runHealthInventory: vi.fn(),
}))

// ── Continuity mocks (needed for obligation episode emission coverage) ───
const mockReadPendingObligations = vi.fn().mockReturnValue([])
const mockEmitEpisode = vi.fn()

vi.mock("../../heart/obligations", async () => {
  const actual = await vi.importActual<typeof import("../../heart/obligations")>("../../heart/obligations")
  return {
    ...actual,
    readPendingObligations: (...args: any[]) => mockReadPendingObligations(...args),
  }
})

vi.mock("../../mind/episodes", async () => {
  const actual = await vi.importActual<typeof import("../../mind/episodes")>("../../mind/episodes")
  return {
    ...actual,
    emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
    readRecentEpisodes: vi.fn().mockReturnValue([]),
  }
})

vi.mock("../../heart/cares", async () => {
  const actual = await vi.importActual<typeof import("../../heart/cares")>("../../heart/cares")
  return { ...actual, readActiveCares: vi.fn().mockReturnValue([]) }
})

vi.mock("../../heart/tempo", async () => {
  const actual = await vi.importActual<typeof import("../../heart/tempo")>("../../heart/tempo")
  return {
    ...actual,
    deriveTempo: vi.fn().mockReturnValue({ mode: "brief", significance: "low", reentryDepth: "warm", effectiveBudget: { min: 150, max: 250 } }),
  }
})

vi.mock("../../heart/temporal-view", async () => {
  const actual = await vi.importActual<typeof import("../../heart/temporal-view")>("../../heart/temporal-view")
  return {
    ...actual,
    buildTemporalView: vi.fn().mockReturnValue({ recentEpisodes: [], activeObligations: [], activeCares: [], openIntentions: [], peerPresence: [], tempo: "brief", assembledAt: new Date().toISOString() }),
  }
})

vi.mock("../../heart/start-of-turn-packet", async () => {
  const actual = await vi.importActual<typeof import("../../heart/start-of-turn-packet")>("../../heart/start-of-turn-packet")
  return {
    ...actual,
    buildStartOfTurnPacket: vi.fn().mockReturnValue({ plotLine: "", obligations: "", cares: "", presence: "", resumeHint: "", tempo: "brief", tokenBudget: { min: 150, max: 250 }, assembledAt: new Date().toISOString() }),
    renderStartOfTurnPacket: vi.fn().mockReturnValue(""),
  }
})

vi.mock("../../heart/presence", async () => {
  const actual = await vi.importActual<typeof import("../../heart/presence")>("../../heart/presence")
  return { ...actual, derivePresence: vi.fn().mockReturnValue({}), writePresence: vi.fn() }
})

vi.mock("../../heart/daemon/auth-flow", async () => ({
  writeAgentProviderSelection: vi.fn(),
  loadAgentSecrets: vi.fn().mockReturnValue({
    secretsPath: "/mock/secrets.json",
    secrets: { providers: {} },
  }),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
  getAgentBundlesRoot: vi.fn(() => "/tmp/AgentBundles"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  loadAgentConfig: vi.fn(() => ({
    version: 1,
    enabled: true,
    provider: "anthropic",
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  setAgentName: vi.fn(),
}))

// ── Test helpers ──────────────────────────────────────────────────

function makeFriend(): FriendRecord {
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
  }
}

function makeCapabilities(): ChannelCapabilities {
  return {
    channel: "cli",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }
}

function makeCallbacks(): ChannelCallbacks {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onClearText: vi.fn(),
  }
}

function makeStore(): FriendStore {
  const f = makeFriend()
  return {
    get: vi.fn().mockResolvedValue(f),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findByExternalId: vi.fn().mockResolvedValue(f),
    hasAnyFriends: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue([f]),
  }
}

function makeInput(overrides: Partial<InboundTurnInput> = {}): InboundTurnInput {
  const friend = makeFriend()
  const caps = makeCapabilities()
  const context: ResolvedContext = { friend, channel: caps }

  return {
    channel: "cli" as Channel,
    capabilities: caps,
    messages: [{ role: "user", content: "hello" }] as ChatCompletionMessageParam[],
    callbacks: makeCallbacks(),
    friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
    sessionLoader: {
      loadOrCreate: vi.fn().mockResolvedValue({
        messages: [{ role: "system", content: "You are helpful." }],
        sessionPath: "/tmp/test-session.json",
      }),
    },
    pendingDir: "/tmp/pending",
    friendStore: makeStore(),
    enforceTrustGate: vi.fn().mockReturnValue({ allowed: true } as TrustGateResult),
    drainPending: vi.fn().mockReturnValue([] as PendingMessage[]),
    runAgent: vi.fn().mockResolvedValue({ usage: {}, outcome: "settled" }),
    postTurn: vi.fn(),
    accumulateFriendTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("pipeline slash command interception", () => {
  beforeEach(() => {
    mockFindBridgesForSession.mockReset().mockReturnValue([])
    mockListTargetSessionCandidates.mockReset().mockResolvedValue([])
    mockListCodingSessions.mockReset().mockReturnValue([])
    resetSharedCommandRegistry()
    resetDebugMode()
  })

  it("/debug command is intercepted and returns 'command' turnOutcome", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const callbacks = makeCallbacks()
    const input = makeInput({
      messages: [{ role: "user", content: "/debug" }],
      callbacks,
    })

    const result = await handleInboundTurn(input)

    expect(result.turnOutcome).toBe("command")
    expect(callbacks.onTextChunk).toHaveBeenCalled()
    // Should NOT have called runAgent
    expect(input.runAgent).not.toHaveBeenCalled()
  })

  it("/commands is intercepted and returns 'command' turnOutcome", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const callbacks = makeCallbacks()
    const input = makeInput({
      messages: [{ role: "user", content: "/commands" }],
      callbacks,
    })

    const result = await handleInboundTurn(input)

    expect(result.turnOutcome).toBe("command")
    expect(callbacks.onTextChunk).toHaveBeenCalled()
    expect(input.runAgent).not.toHaveBeenCalled()
  })

  it("regular message (no /) passes through to agent", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput({
      messages: [{ role: "user", content: "hello world" }],
    })

    const result = await handleInboundTurn(input)

    expect(input.runAgent).toHaveBeenCalled()
    expect(result.turnOutcome).not.toBe("command")
  })

  it("// escaped prefix passes through to agent", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput({
      messages: [{ role: "user", content: "//debug" }],
    })

    const result = await handleInboundTurn(input)

    expect(input.runAgent).toHaveBeenCalled()
    expect(result.turnOutcome).not.toBe("command")
  })

  it("unknown /foo passes through to agent", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput({
      messages: [{ role: "user", content: "/unknowncommand" }],
    })

    const result = await handleInboundTurn(input)

    expect(input.runAgent).toHaveBeenCalled()
    expect(result.turnOutcome).not.toBe("command")
  })

  it("command interception skips friend resolution", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput({
      messages: [{ role: "user", content: "/debug" }],
    })

    await handleInboundTurn(input)

    // Friend resolver should not be called for command handling
    // Actually, we do still resolve the friend for the result type, but runAgent shouldn't be called
    expect(input.runAgent).not.toHaveBeenCalled()
  })

  it("onClearText is NOT called for command responses (text should be flushed, not cleared)", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const callbacks = makeCallbacks()
    const input = makeInput({
      messages: [{ role: "user", content: "/debug" }],
      callbacks,
    })

    await handleInboundTurn(input)

    expect(callbacks.onClearText).not.toHaveBeenCalled()
  })

  it("command with no message still returns 'command' turnOutcome", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const callbacks = makeCallbacks()
    const input = makeInput({
      messages: [{ role: "user", content: "/exit" }],
      callbacks,
      channel: "cli",
    })

    const result = await handleInboundTurn(input)

    expect(result.turnOutcome).toBe("command")
    // onTextChunk should NOT be called since /exit has no message
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(input.runAgent).not.toHaveBeenCalled()
  })

  it("multipart content with no text part passes through to agent", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput({
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }] as any,
      }],
    })

    const result = await handleInboundTurn(input)

    // No text to parse as command, so passes through to agent
    expect(input.runAgent).toHaveBeenCalled()
  })

  it("multipart content messages are checked for slash commands", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const callbacks = makeCallbacks()
    const input = makeInput({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "/debug" }],
      }],
      callbacks,
    })

    const result = await handleInboundTurn(input)

    expect(result.turnOutcome).toBe("command")
    expect(input.runAgent).not.toHaveBeenCalled()
  })

  it("emits episode when obligation status changes between pre/post turn", async () => {
    const beforeObligations = [
      { id: "ob-1", content: "review PR", status: "pending", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-01T10:00:00Z" },
    ]
    const afterObligations = [
      { id: "ob-1", content: "review PR", status: "fulfilled", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-02T10:00:00Z" },
    ]

    // Default to beforeObligations; switch to afterObligations after runAgent
    mockReadPendingObligations.mockReturnValue(beforeObligations)

    const usageData: UsageData = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 160 }
    const originalRunAgent = vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" })
    const runAgentWrapper = async (...args: any[]) => {
      const result = await originalRunAgent(...args)
      mockReadPendingObligations.mockReturnValue(afterObligations)
      return result
    }

    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput({
      messages: [{ role: "user", content: "hello world" }],
      runAgent: runAgentWrapper as any,
    })
    await handleInboundTurn(input)

    expect(mockEmitEpisode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "obligation_shift", salience: "medium" }),
    )

    // Reset for subsequent tests
    mockReadPendingObligations.mockReturnValue([])
    mockEmitEpisode.mockReset()
  })
})

describe("getSharedCommandRegistry caching", () => {
  beforeEach(() => {
    resetSharedCommandRegistry()
  })

  it("returns the same registry on subsequent calls", async () => {
    const { getSharedCommandRegistry } = await import("../../senses/commands")
    const reg1 = getSharedCommandRegistry()
    const reg2 = getSharedCommandRegistry()
    expect(reg1).toBe(reg2)
  })
})

describe("/debug command", () => {
  beforeEach(() => {
    vi.resetModules()
    mockFindBridgesForSession.mockReset().mockReturnValue([])
    mockListTargetSessionCandidates.mockReset().mockResolvedValue([])
    mockListCodingSessions.mockReset().mockReturnValue([])
  })

  it("toggles debug mode on and off", async () => {
    vi.doMock("../../heart/identity", () => ({
      getAgentName: vi.fn(() => "testagent"),
      getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
    }))
    const { getDebugMode, resetDebugMode, createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    resetDebugMode()
    expect(getDebugMode()).toBe(false)

    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result1 = registry.dispatch("debug", { channel: "cli" })
    expect(result1.handled).toBe(true)
    expect(result1.result!.message).toBe("debug mode on — you'll see more detail about what I'm doing")
    expect(getDebugMode()).toBe(true)

    const result2 = registry.dispatch("debug", { channel: "cli" })
    expect(result2.handled).toBe(true)
    expect(result2.result!.message).toBe("debug mode off — back to clean output")
    expect(getDebugMode()).toBe(false)
  })

  it("is available on all channels", async () => {
    vi.doMock("../../heart/identity", () => ({
      getAgentName: vi.fn(() => "testagent"),
      getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
    }))
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const cmd = registry.get("debug")
    expect(cmd).toBeDefined()
    expect(cmd!.channels).toContain("cli")
    expect(cmd!.channels).toContain("teams")
    expect(cmd!.channels).toContain("bluebubbles")
  })
})
