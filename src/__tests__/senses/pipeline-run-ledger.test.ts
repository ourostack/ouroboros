import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions } from "../../heart/core"
import type { Channel, ChannelCapabilities, FriendRecord, FriendStore, ResolvedContext } from "@ouro.bot/friends"
import type { TrustGateResult } from "../../senses/trust-gate"
import type { PendingMessage } from "../../mind/pending"
import type { UsageData } from "../../mind/context"

const mockBuildTurnContext = vi.hoisted(() => vi.fn())
const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
const mockGetAgentName = vi.hoisted(() => vi.fn(() => "slugger"))
const mockGetAgentRoot = vi.hoisted(() => vi.fn())
const mockRecordFlightRecorderEvent = vi.hoisted(() => vi.fn())
const mockRefreshContextLossSentinel = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
}))

vi.mock("../../heart/config", () => ({
  getSyncConfig: () => ({ enabled: false, remote: "origin" }),
}))

vi.mock("../../heart/turn-context", () => ({
  buildTurnContext: (...args: any[]) => mockBuildTurnContext(...args),
}))

vi.mock("../../heart/tempo", () => ({
  deriveTempo: () => ({ mode: "steady" }),
}))

vi.mock("../../heart/temporal-view", () => ({
  buildTemporalView: () => ({}),
}))

vi.mock("../../heart/start-of-turn-packet", () => ({
  buildStartOfTurnPacket: () => ({}),
  renderStartOfTurnPacket: () => "",
  buildCapabilitiesSection: () => undefined,
}))

vi.mock("../../heart/bundle-state", () => ({
  detectBundleState: () => [],
}))

vi.mock("../../heart/sync", () => ({
  preTurnPull: () => ({ ok: true }),
  postTurnPush: () => ({ ok: true }),
}))

vi.mock("../../arc/presence", () => ({
  derivePresence: () => ({}),
  writePresence: vi.fn(),
}))

vi.mock("../../arc/obligations", () => ({
  isOpenObligation: () => false,
  readPendingObligations: () => [],
  listActiveReturnObligationsForRoot: () => [],
}))

vi.mock("../../arc/packets", () => ({
  listActivePonderPackets: () => [],
}))

vi.mock("../../arc/evolution", () => ({
  listOpenEvolutionCases: () => [],
}))

vi.mock("../../arc/episodes", () => ({
  emitEpisode: vi.fn(),
}))

vi.mock("../../arc/flight-recorder", () => ({
  readFlightRecorderResume: () => ({
    schemaVersion: 1,
    hasCompleteState: false,
    canContinue: false,
    missing: [],
    gaps: [],
    currentAsk: { value: null, confidence: "unknown", sourceEventIds: [] },
    nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
    blockedBecause: [],
    activeObligationIds: [],
    activeReturnObligationIds: [],
    activePacketIds: [],
    openEvolutionCaseIds: [],
    recentClaimIds: [],
    unverifiedClaimIds: [],
    lastSafeCheckpoint: { turnId: null, sessionRef: null, recordedAt: null, sourceEventIds: [] },
    recorderHealth: { status: "healthy", issues: [] },
  }),
  recordFlightRecorderEvent: (...args: any[]) => mockRecordFlightRecorderEvent(...args),
}))

vi.mock("../../heart/context-loss-sentinel", () => ({
  refreshContextLossSentinel: (...args: any[]) => mockRefreshContextLossSentinel(...args),
}))

import { readRunLedger } from "../../heart/run-ledger"
import { handleInboundTurn, type InboundTurnInput } from "../../senses/pipeline"

const usageData: UsageData = {
  input_tokens: 100,
  output_tokens: 50,
  reasoning_tokens: 10,
  total_tokens: 160,
}

function tempAgentRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-pipeline-run-ledger-"))
}

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
    channel: "bluebubbles" as Channel,
    senseType: "closed",
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

function makeStore(friend: FriendRecord): FriendStore {
  return {
    get: vi.fn().mockResolvedValue(friend),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findByExternalId: vi.fn().mockResolvedValue(friend),
    hasAnyFriends: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue([friend]),
  }
}

function defaultTurnContext() {
  return {
    activeBridges: [] as any[],
    sessionActivity: [] as any[],
    targetCandidates: [] as any[],
    pendingObligations: [] as any[],
    codingSessions: [] as any[],
    otherCodingSessions: [] as any[],
    backgroundOperations: [] as any[],
    innerWorkState: {
      status: "idle" as const,
      hasPending: false,
      job: {
        status: "idle" as const,
        content: null,
        origin: null,
        mode: "reflect" as const,
        obligationStatus: null,
        surfacedResult: null,
        queuedAt: null,
        startedAt: null,
        surfacedAt: null,
      },
    },
    returnObligations: [] as any[],
    recentEpisodes: [] as any[],
    activeCares: [] as any[],
    syncConfig: { enabled: false, remote: "origin" },
    syncFailure: undefined,
    daemonRunning: false,
    senseStatusLines: [] as string[],
    bundleMeta: null,
    daemonHealth: null,
    flightRecorderResume: {
      schemaVersion: 1 as const,
      hasCompleteState: false,
      canContinue: false,
      missing: [],
      gaps: [],
      currentAsk: { value: null, confidence: "unknown" as const, sourceEventIds: [] },
      nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
      blockedBecause: [],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: null, recordedAt: null, sourceEventIds: [] },
      recorderHealth: { status: "healthy" as const, issues: [] },
    },
  }
}

function makeInput(overrides: Partial<InboundTurnInput> = {}): InboundTurnInput {
  const friend = makeFriend()
  const caps = makeCapabilities()
  const context: ResolvedContext = { friend, channel: caps }

  return {
    channel: "bluebubbles" as Channel,
    capabilities: caps,
    sessionKey: "chat-ari-rachel",
    messages: [{ role: "user", content: "who is pending?" }] as ChatCompletionMessageParam[],
    continuityIngressTexts: ["who is pending?"],
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
    runAgentOptions: {
      traceId: "trace-rsvp-question",
      contextPacketIds: ["scp_same_thread"],
    } as RunAgentOptions,
    ...overrides,
  }
}

describe("handleInboundTurn run ledger attribution", () => {
  beforeEach(() => {
    mockBuildTurnContext.mockReset().mockResolvedValue(defaultTurnContext())
    mockEmitNervesEvent.mockReset()
    mockGetAgentName.mockReset().mockReturnValue("slugger")
    mockGetAgentRoot.mockReset()
    mockRecordFlightRecorderEvent.mockReset()
    mockRefreshContextLossSentinel.mockReset().mockResolvedValue(undefined)
  })

  it("records content-free started/completed provider rows with usage and context packet ids", async () => {
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const result = await handleInboundTurn(makeInput())

    expect(result.turnOutcome).toBe("settled")
    const rows = readRunLedger(agentRoot)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "started",
      contentStored: false,
      provider: "unknown",
      model: "unknown",
      contextPacketIds: ["scp_same_thread"],
    })
    expect(rows[1]).toMatchObject({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "completed",
      usage: {
        source: "provider",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        totalTokens: 160,
      },
      contextPacketIds: ["scp_same_thread"],
    })
    expect(rows[1]?.runId).toBe(rows[0]?.runId)
    expect(rows[1]?.rootRunId).toBe(rows[0]?.rootRunId)

    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("who is pending")
    expect(serialized).not.toContain("You are helpful")
    expect(mockRecordFlightRecorderEvent).toHaveBeenCalled()
  })

  it("records content-free error rows when the model turn throws", async () => {
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)

    await expect(handleInboundTurn(makeInput({
      runAgent: vi.fn().mockRejectedValue(new Error("model blew up")),
    }))).rejects.toThrow("model blew up")

    const rows = readRunLedger(agentRoot)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "started",
      contentStored: false,
      contextPacketIds: ["scp_same_thread"],
    })
    expect(rows[1]).toMatchObject({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "error",
      contentStored: false,
      usage: {
        source: "reported-unavailable",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      errorName: "Error",
      contextPacketIds: ["scp_same_thread"],
    })
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("who is pending")
    expect(serialized).not.toContain("model blew up")
  })

  it("records non-Error thrown model turns without storing thrown content", async () => {
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)

    await expect(handleInboundTurn(makeInput({
      runAgent: vi.fn().mockRejectedValue("string failure"),
    }))).rejects.toBe("string failure")

    const rows = readRunLedger(agentRoot)
    expect(rows[1]).toMatchObject({
      lifecycle: "error",
      contentStored: false,
      usage: { source: "reported-unavailable" },
      errorName: "NonErrorThrown",
    })
    expect(JSON.stringify(rows)).not.toContain("string failure")
  })

  it("rethrows model errors when run ledger preparation is unavailable", async () => {
    mockGetAgentRoot.mockImplementation(() => {
      throw new Error("bundle root unavailable")
    })

    await expect(handleInboundTurn(makeInput({
      runAgent: vi.fn().mockRejectedValue(new Error("model blew up without ledger")),
    }))).rejects.toThrow("model blew up without ledger")
  })
})
