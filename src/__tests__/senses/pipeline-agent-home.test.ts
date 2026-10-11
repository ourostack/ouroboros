import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities, Channel, FriendStore } from "@ouro.bot/friends"
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

vi.mock("../../arc/obligations", async () => {
  const actual = await vi.importActual<typeof import("../../arc/obligations")>("../../arc/obligations")
  return {
    ...actual,
    readPendingObligations: (...args: any[]) => mockReadPendingObligations(...args),
  }
})

vi.mock("../../arc/episodes", async () => {
  const actual = await vi.importActual<typeof import("../../arc/episodes")>("../../arc/episodes")
  return {
    ...actual,
    emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
    readRecentEpisodes: vi.fn().mockReturnValue([]),
  }
})

vi.mock("../../arc/cares", async () => {
  const actual = await vi.importActual<typeof import("../../arc/cares")>("../../arc/cares")
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

vi.mock("../../arc/presence", async () => {
  const actual = await vi.importActual<typeof import("../../arc/presence")>("../../arc/presence")
  return { ...actual, derivePresence: vi.fn().mockReturnValue({}), writePresence: vi.fn() }
})

vi.mock("../../heart/auth/auth-flow", async () => ({
  writeAgentProviderSelection: vi.fn(),
  loadAgentSecrets: vi.fn().mockReturnValue({
    secretsPath: "/mock/secrets.json",
    secrets: { providers: {} },
  }),
}))

const readAgentHomeElsewhereMock = vi.hoisted(() => vi.fn((): { machineId: string; machineName: string; since: string } | null => null))
vi.mock("../../heart/daemon/agent-discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/daemon/agent-discovery")>(),
  readAgentHomeElsewhere: readAgentHomeElsewhereMock,
}))
const postTurnPushMock = vi.hoisted(() => vi.fn(() => ({ ok: true })))
vi.mock("../../heart/sync", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/sync")>(),
  preTurnPull: vi.fn(() => ({ ok: true })),
  postTurnPush: postTurnPushMock,
}))
vi.mock("../../heart/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/config")>(),
  getSyncConfig: vi.fn(() => ({ enabled: true, remote: "origin" })),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
  getAgentBundlesRoot: vi.fn(() => "/tmp/AgentBundles"),
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

describe("pipeline home-machine gate", () => {
  beforeEach(() => {
    mockFindBridgesForSession.mockReset().mockReturnValue([])
    mockListTargetSessionCandidates.mockReset().mockResolvedValue([])
    mockListCodingSessions.mockReset().mockReturnValue([])
    readAgentHomeElsewhereMock.mockReset().mockReturnValue(null)
    postTurnPushMock.mockClear()
    resetSharedCommandRegistry()
    resetDebugMode()
  })

  it("declines the turn and writes nothing when the agent is homed on another machine", async () => {
    readAgentHomeElsewhereMock.mockReturnValue({ machineId: "machine_there", machineName: "there-mac", since: "" })
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput()

    const result = await handleInboundTurn(input)

    expect(readAgentHomeElsewhereMock).toHaveBeenCalledWith("/tmp/AgentBundles/testagent.ouro")
    expect(input.runAgent).not.toHaveBeenCalled()
    expect(result.turnOutcome).toBeUndefined()
    expect(postTurnPushMock).not.toHaveBeenCalled()
  })

  it("runs the turn and syncs as usual when the agent is homed here", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const input = makeInput()

    await handleInboundTurn(input)

    expect(input.runAgent).toHaveBeenCalled()
    expect(postTurnPushMock).toHaveBeenCalled()
  })
})
