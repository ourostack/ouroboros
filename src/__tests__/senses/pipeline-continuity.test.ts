import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { FriendRecord, ResolvedContext, ChannelCapabilities, Channel } from "../../mind/friends/types"
import type { FriendStore } from "../../mind/friends/store"
import type { TrustGateResult } from "../../senses/trust-gate"
import type { UsageData } from "../../mind/context"
import type { PendingMessage } from "../../mind/pending"
import type { InboundTurnInput } from "../../senses/pipeline"
import * as identity from "../../heart/identity"
import * as pending from "../../mind/pending"
import * as daemonThoughts from "../../heart/daemon/thoughts"

// ── Continuity mocks ─────────────────────────────────────────────

const mockDeriveTempo = vi.fn()
const mockBuildTemporalView = vi.fn()
const mockBuildWakePacket = vi.fn()
const mockRenderWakePacket = vi.fn()
const mockDerivePresence = vi.fn()
const mockWritePresence = vi.fn()
const mockEmitEpisode = vi.fn()
const mockReadPendingObligations = vi.fn()
const mockReadRecentEpisodes = vi.fn()
const mockReadActiveCares = vi.fn()
const mockListSessionActivity = vi.fn()

vi.mock("../../heart/tempo", async () => {
  const actual = await vi.importActual<typeof import("../../heart/tempo")>("../../heart/tempo")
  return {
    ...actual,
    deriveTempo: (...args: any[]) => mockDeriveTempo(...args),
  }
})

vi.mock("../../heart/temporal-view", async () => {
  const actual = await vi.importActual<typeof import("../../heart/temporal-view")>("../../heart/temporal-view")
  return {
    ...actual,
    buildTemporalView: (...args: any[]) => mockBuildTemporalView(...args),
  }
})

vi.mock("../../heart/wake-packet", async () => {
  const actual = await vi.importActual<typeof import("../../heart/wake-packet")>("../../heart/wake-packet")
  return {
    ...actual,
    buildWakePacket: (...args: any[]) => mockBuildWakePacket(...args),
    renderWakePacket: (...args: any[]) => mockRenderWakePacket(...args),
  }
})

vi.mock("../../heart/presence", async () => {
  const actual = await vi.importActual<typeof import("../../heart/presence")>("../../heart/presence")
  return {
    ...actual,
    derivePresence: (...args: any[]) => mockDerivePresence(...args),
    writePresence: (...args: any[]) => mockWritePresence(...args),
  }
})

vi.mock("../../mind/episodes", async () => {
  const actual = await vi.importActual<typeof import("../../mind/episodes")>("../../mind/episodes")
  return {
    ...actual,
    emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
    readRecentEpisodes: (...args: any[]) => mockReadRecentEpisodes(...args),
  }
})

vi.mock("../../heart/cares", async () => {
  const actual = await vi.importActual<typeof import("../../heart/cares")>("../../heart/cares")
  return {
    ...actual,
    readActiveCares: (...args: any[]) => mockReadActiveCares(...args),
  }
})

vi.mock("../../heart/obligations", async () => {
  const actual = await vi.importActual<typeof import("../../heart/obligations")>("../../heart/obligations")
  return {
    ...actual,
    readPendingObligations: (...args: any[]) => mockReadPendingObligations(...args),
  }
})

// ── Standard pipeline mocks (same as pipeline.test.ts) ───────────

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
      findBridgesForSession: vi.fn().mockReturnValue([]),
    }),
  }
})

vi.mock("../../heart/target-resolution", async () => {
  const actual = await vi.importActual<typeof import("../../heart/target-resolution")>("../../heart/target-resolution")
  return {
    ...actual,
    listTargetSessionCandidates: vi.fn().mockResolvedValue([]),
  }
})

vi.mock("../../repertoire/coding", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/coding")>("../../repertoire/coding")
  return {
    ...actual,
    getCodingSessionManager: () => ({
      listSessions: vi.fn().mockReturnValue([]),
    }),
  }
})

vi.mock("../../mind/file-state", () => ({
  fileStateCache: { clear: vi.fn() },
}))

vi.mock("../../mind/scrutiny", () => ({
  resetSessionModifiedFiles: vi.fn(),
}))

vi.mock("../../heart/session-activity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/session-activity")>("../../heart/session-activity")
  return {
    ...actual,
    listSessionActivity: (...args: any[]) => mockListSessionActivity(...args),
  }
})

// ── Test helpers ─────────────────────────────────────────────────

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

function makeCapabilities(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    channel: "cli",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
    ...overrides,
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
  }
}

const usageData: UsageData = {
  input_tokens: 100,
  output_tokens: 50,
  reasoning_tokens: 10,
  total_tokens: 160,
}

function makeStore(friend?: FriendRecord): FriendStore {
  const f = friend ?? makeFriend()
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
    continuityIngressTexts: ["hello"],
    callbacks: makeCallbacks(),
    friendResolver: { resolve: vi.fn().mockResolvedValue(context) },
    sessionLoader: {
      loadOrCreate: vi.fn().mockResolvedValue({
        messages: [{ role: "system", content: "You are helpful." }],
        sessionPath: "/tmp/test-session.json",
      }),
    },
    pendingDir: "/tmp/pending",
    friendStore: makeStore(friend),
    enforceTrustGate: vi.fn().mockReturnValue({ allowed: true } as TrustGateResult),
    drainPending: vi.fn().mockReturnValue([] as PendingMessage[]),
    runAgent: vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" }),
    postTurn: vi.fn(),
    accumulateFriendTokens: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("pipeline continuity integration", () => {
  beforeEach(() => {
    vi.spyOn(identity, "getAgentName").mockReturnValue("ouroboros")
    vi.spyOn(identity, "getAgentRoot").mockReturnValue("/tmp/test-agent-root")
    vi.spyOn(identity, "loadAgentConfig").mockReturnValue({
      name: "ouroboros",
      displayName: "Ouroboros",
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      configPath: "~/.agentsecrets/ouroboros/secrets.json",
      context: {},
    } as ReturnType<typeof identity.loadAgentConfig>)
    vi.spyOn(daemonThoughts, "readInnerDialogRawData").mockReturnValue(null)
    vi.spyOn(daemonThoughts, "deriveInnerDialogStatus").mockReturnValue("idle")
    vi.spyOn(daemonThoughts, "deriveInnerJob").mockReturnValue(null)
    vi.spyOn(daemonThoughts, "getInnerDialogSessionPath").mockReturnValue(null)
    vi.spyOn(pending, "getInnerDialogPendingDir").mockReturnValue("/tmp/inner-pending")

    // Default continuity mock returns
    mockListSessionActivity.mockReturnValue([])
    mockReadRecentEpisodes.mockReturnValue([])
    mockReadActiveCares.mockReturnValue([])
    mockReadPendingObligations.mockReturnValue([])
    mockDeriveTempo.mockReturnValue({
      mode: "brief",
      significance: "low",
      reentryDepth: "warm",
      effectiveBudget: { min: 150, max: 250 },
    })
    mockBuildTemporalView.mockReturnValue({
      recentEpisodes: [],
      activeObligations: [],
      activeCares: [],
      openIntentions: [],
      peerPresence: [],
      tempo: "brief",
      assembledAt: new Date().toISOString(),
    })
    mockBuildWakePacket.mockReturnValue({
      plotLine: "",
      obligations: "",
      cares: "",
      presence: "",
      resumeHint: "",
      tempo: "brief",
      tokenBudget: { min: 150, max: 250 },
      assembledAt: new Date().toISOString(),
    })
    mockRenderWakePacket.mockReturnValue("**Next:** check inbox")
    mockDerivePresence.mockReturnValue({
      agentName: "ouroboros",
      availability: "active",
      lane: "conversation",
      mission: "helping",
      tempo: "brief",
      updatedAt: new Date().toISOString(),
    })
    mockWritePresence.mockReturnValue(undefined)
    mockEmitEpisode.mockReturnValue({ id: "ep-1", timestamp: new Date().toISOString() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockDeriveTempo.mockReset()
    mockBuildTemporalView.mockReset()
    mockBuildWakePacket.mockReset()
    mockRenderWakePacket.mockReset()
    mockDerivePresence.mockReset()
    mockWritePresence.mockReset()
    mockEmitEpisode.mockReset()
    mockReadRecentEpisodes.mockReset()
    mockReadActiveCares.mockReset()
    mockReadPendingObligations.mockReset()
    mockListSessionActivity.mockReset()
  })

  describe("wake packet threading", () => {
    it("calls deriveTempo during pipeline execution", async () => {
      const input = makeInput()
      await import("../../senses/pipeline").then((m) => m.handleInboundTurn(input))
      expect(mockDeriveTempo).toHaveBeenCalled()
    })

    it("calls buildTemporalView with agentRoot and tempo", async () => {
      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)
      expect(mockBuildTemporalView).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        expect.objectContaining({ tempo: expect.any(String) }),
      )
    })

    it("calls buildWakePacket with temporal view and canonical obligations from activeWorkFrame", async () => {
      const mockView = {
        recentEpisodes: [],
        activeObligations: [],
        activeCares: [],
        openIntentions: [],
        peerPresence: [],
        tempo: "standard",
        assembledAt: new Date().toISOString(),
      }
      mockBuildTemporalView.mockReturnValue(mockView)

      const testObligation = {
        id: "ob-pipeline",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "pipeline test obligation",
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      }
      mockReadPendingObligations.mockReturnValue([testObligation])

      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)
      expect(mockBuildWakePacket).toHaveBeenCalledWith(
        mockView,
        {
          canonicalObligations: {
            primary: expect.objectContaining({ id: "ob-pipeline" }),
            all: expect.arrayContaining([expect.objectContaining({ id: "ob-pipeline" })]),
          },
        },
      )
    })

    it("passes rendered wake packet to runAgent options", async () => {
      mockRenderWakePacket.mockReturnValue("**Next:** review PR #42")

      const runAgentSpy = vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" })
      const input = makeInput({ runAgent: runAgentSpy })
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)

      // runAgent is called with (messages, callbacks, channel, signal, options)
      const options = runAgentSpy.mock.calls[0][4] as RunAgentOptions
      expect(options.wakePacket).toBe("**Next:** review PR #42")
    })

    it("derives tempo with episode salience and care risk data", async () => {
      mockReadRecentEpisodes.mockReturnValue([
        { id: "ep-1", kind: "turning_point", salience: "high", summary: "breakthrough", whyItMattered: "changed approach", timestamp: new Date().toISOString(), relatedEntities: [] },
        { id: "ep-2", kind: "coding_milestone", salience: "low", summary: "minor fix", whyItMattered: "", timestamp: new Date().toISOString(), relatedEntities: [] },
      ])
      mockReadActiveCares.mockReturnValue([
        { id: "c-1", label: "deploy", currentRisk: "might fail", status: "active", salience: "high", kind: "project", steward: "mine", relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ])

      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)
      expect(mockDeriveTempo).toHaveBeenCalledWith(
        expect.objectContaining({
          highSalienceEpisodes: 1,
          activeCareCount: 1,
          atRiskCareCount: 1,
        }),
      )
    })

    it("gracefully handles continuity pipeline errors (Error instance)", async () => {
      mockDeriveTempo.mockImplementation(() => {
        throw new Error("tempo derivation failed")
      })

      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      // Should not throw -- continuity errors are non-fatal
      const result = await handleInboundTurn(input)
      expect(result.turnOutcome).toBe("settled")
    })

    it("gracefully handles continuity pipeline errors (non-Error thrown)", async () => {
      mockDeriveTempo.mockImplementation(() => {
        throw "string-error-not-Error-instance" // eslint-disable-line no-throw-literal
      })

      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      const result = await handleInboundTurn(input)
      expect(result.turnOutcome).toBe("settled")
    })

    it("computes lastActivityAgeMs from sessionActivity when sessions exist", async () => {
      mockListSessionActivity.mockReturnValue([
        { friendId: "f-1", channel: "cli", key: "s-1", lastActivityAt: new Date(Date.now() - 60_000).toISOString() },
      ])

      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)
      // deriveTempo should be called with lastActivityAgeMs > 0 and activeSessions = 2 (1 existing + 1 current)
      expect(mockDeriveTempo).toHaveBeenCalledWith(
        expect.objectContaining({
          activeSessions: 2,
          lastActivityAgeMs: expect.any(Number),
        }),
      )
      const tempoArgs = mockDeriveTempo.mock.calls[0][0]
      expect(tempoArgs.lastActivityAgeMs).toBeGreaterThan(0)
    })
  })

  describe("presence update", () => {
    it("calls derivePresence after turn", async () => {
      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)
      expect(mockDerivePresence).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        "ouroboros",
        expect.objectContaining({
          activeSessions: expect.any(Number),
          openObligations: expect.any(Number),
          activeBridges: expect.any(Number),
          codingLanes: expect.any(Number),
          currentTempo: expect.any(String),
        }),
      )
    })

    it("calls writePresence with derived presence", async () => {
      const mockPresence = {
        agentName: "ouroboros",
        availability: "active" as const,
        lane: "coding",
        mission: "building features",
        tempo: "standard" as const,
        updatedAt: new Date().toISOString(),
      }
      mockDerivePresence.mockReturnValue(mockPresence)

      const input = makeInput()
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)
      expect(mockWritePresence).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        "ouroboros",
        mockPresence,
      )
    })
  })

  describe("episode emission at obligation transitions", () => {
    it("emits episode when obligation status changes (direct function test)", async () => {
      const { emitObligationTransitionEpisodes } = await import("../../senses/pipeline")

      const preTurnIds = new Set(["ob-1:pending"])
      const postTurnObligations = [
        { id: "ob-1", content: "review PR", status: "fulfilled", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-02T10:00:00Z" },
      ] as any[]
      const preTurnObligations = [
        { id: "ob-1", content: "review PR", status: "pending", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-01T10:00:00Z" },
      ] as any[]

      emitObligationTransitionEpisodes("/tmp/test-agent-root", preTurnIds, postTurnObligations, preTurnObligations)

      expect(mockEmitEpisode).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        expect.objectContaining({
          kind: "obligation_shift",
          summary: expect.stringContaining("review PR"),
          salience: "medium",
        }),
      )
    })

    it("does not emit episode when obligation status unchanged", async () => {
      const { emitObligationTransitionEpisodes } = await import("../../senses/pipeline")

      const preTurnIds = new Set(["ob-1:pending"])
      const postTurnObligations = [
        { id: "ob-1", content: "review PR", status: "pending", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-01T10:00:00Z" },
      ] as any[]

      emitObligationTransitionEpisodes("/tmp/test-agent-root", preTurnIds, postTurnObligations, postTurnObligations)

      expect(mockEmitEpisode).not.toHaveBeenCalled()
    })

    it("falls back to preTurnObligations when obligation removed from post-turn", async () => {
      const { emitObligationTransitionEpisodes } = await import("../../senses/pipeline")

      const preTurnIds = new Set(["ob-1:pending"])
      const preTurnObligations = [
        { id: "ob-1", content: "deploy fix", status: "pending", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-01T10:00:00Z" },
      ] as any[]
      // Obligation fully removed from post-turn (e.g., deleted) — preTurnObligations.find() is the fallback
      emitObligationTransitionEpisodes("/tmp/test-agent-root", preTurnIds, [], preTurnObligations)

      expect(mockEmitEpisode).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        expect.objectContaining({
          summary: expect.stringContaining("deploy fix"),
        }),
      )
    })

    it("uses obligation id as fallback when not found in either list", async () => {
      const { emitObligationTransitionEpisodes } = await import("../../senses/pipeline")

      const preTurnIds = new Set(["ob-gone:pending"])
      // Obligation not found in either pre or post lists
      emitObligationTransitionEpisodes("/tmp/test-agent-root", preTurnIds, [], [])

      expect(mockEmitEpisode).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        expect.objectContaining({
          summary: expect.stringContaining("ob-gone"),
        }),
      )
    })

    it("emits episodes via pipeline when obligation state changes between turns", async () => {
      // Also test through the full pipeline to ensure the extracted function is wired correctly
      mockReadPendingObligations.mockReturnValue([
        { id: "ob-1", content: "review PR", status: "pending", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-01T10:00:00Z" },
      ])

      const originalRunAgent = vi.fn().mockResolvedValue({ usage: usageData, outcome: "settled" })
      const runAgentWrapper = async (...args: any[]) => {
        const result = await originalRunAgent(...args)
        mockReadPendingObligations.mockReturnValue([
          { id: "ob-1", content: "review PR", status: "fulfilled", createdAt: "2026-04-01T10:00:00Z", updatedAt: "2026-04-02T10:00:00Z" },
        ])
        return result
      }

      const input = makeInput({ runAgent: runAgentWrapper as any })
      const { handleInboundTurn } = await import("../../senses/pipeline")
      await handleInboundTurn(input)

      expect(mockEmitEpisode).toHaveBeenCalledWith(
        "/tmp/test-agent-root",
        expect.objectContaining({
          kind: "obligation_shift",
          salience: "medium",
        }),
      )
    })
  })
})
