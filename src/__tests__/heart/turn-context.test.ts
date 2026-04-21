import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

// ── Mocks ────────────────────────────────────────────────────────

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockGetAgentRoot = vi.fn().mockReturnValue("/mock/agent-root")
const mockGetAgentName = vi.fn().mockReturnValue("test-agent")
const mockLoadAgentConfig = vi.fn().mockReturnValue({
  senses: { cli: { enabled: true }, teams: { enabled: false }, bluebubbles: { enabled: false } },
})

vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => mockGetAgentRoot(),
  getAgentName: () => mockGetAgentName(),
  loadAgentConfig: () => mockLoadAgentConfig(),
}))

const mockFindBridgesForSession = vi.fn().mockReturnValue([])
vi.mock("../../heart/bridges/manager", () => ({
  createBridgeManager: () => ({ findBridgesForSession: mockFindBridgesForSession }),
}))

const mockListSessionActivity = vi.fn().mockReturnValue([])
vi.mock("../../heart/session-activity", () => ({
  listSessionActivity: (...args: any[]) => mockListSessionActivity(...args),
}))

const mockListTargetSessionCandidates = vi.fn().mockResolvedValue([])
vi.mock("../../heart/target-resolution", () => ({
  listTargetSessionCandidates: (...args: any[]) => mockListTargetSessionCandidates(...args),
}))

const mockReadPendingObligations = vi.fn().mockReturnValue([])
const mockListActiveReturnObligations = vi.fn().mockReturnValue([])
vi.mock("../../arc/obligations", () => ({
  readPendingObligations: (...args: any[]) => mockReadPendingObligations(...args),
  listActiveReturnObligations: (...args: any[]) => mockListActiveReturnObligations(...args),
}))

const mockListSessions = vi.fn().mockReturnValue([])
vi.mock("../../repertoire/coding", () => ({
  getCodingSessionManager: () => ({ listSessions: mockListSessions }),
}))

const mockReadInnerDialogRawData = vi.fn().mockReturnValue({
  pendingMessages: [],
  turns: [],
  runtimeState: null,
})
const mockDeriveInnerDialogStatus = vi.fn().mockReturnValue({
  processing: "idle",
  queue: "clear",
})
const mockDeriveInnerJob = vi.fn().mockReturnValue({
  status: "idle",
  content: null,
  origin: null,
  mode: "reflect",
  obligationStatus: null,
  surfacedResult: null,
  queuedAt: null,
  startedAt: null,
  surfacedAt: null,
})
const mockGetInnerDialogSessionPath = vi.fn().mockReturnValue("/mock/inner-session")
vi.mock("../../heart/daemon/thoughts", () => ({
  readInnerDialogRawData: (...args: any[]) => mockReadInnerDialogRawData(...args),
  deriveInnerDialogStatus: (...args: any[]) => mockDeriveInnerDialogStatus(...args),
  deriveInnerJob: (...args: any[]) => mockDeriveInnerJob(...args),
  getInnerDialogSessionPath: (...args: any[]) => mockGetInnerDialogSessionPath(...args),
}))

vi.mock("../../mind/pending", () => ({
  getInnerDialogPendingDir: () => "/mock/pending",
}))

const mockGetBoard = vi.fn().mockReturnValue({
  compact: "test",
  full: "test full",
  byStatus: {
    drafting: [], processing: [], validating: [], collaborating: [],
    paused: [], blocked: [], done: [], cancelled: [],
  },
  issues: [],
  actionRequired: [],
  unresolvedDependencies: [],
  activeSessions: [],
  activeBridges: [],
})
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({ getBoard: mockGetBoard }),
}))

const mockReadRecentEpisodes = vi.fn().mockReturnValue([])
vi.mock("../../arc/episodes", () => ({
  readRecentEpisodes: (...args: any[]) => mockReadRecentEpisodes(...args),
}))

const mockReadActiveCares = vi.fn().mockReturnValue([])
vi.mock("../../arc/cares", () => ({
  readActiveCares: (...args: any[]) => mockReadActiveCares(...args),
}))

const mockGetSyncConfig = vi.fn().mockReturnValue({ enabled: false, remote: "origin" })
const mockLoadConfig = vi.fn().mockReturnValue({
  teams: {},
  bluebubbles: {},
})
vi.mock("../../heart/config", () => ({
  getSyncConfig: () => mockGetSyncConfig(),
  loadConfig: () => mockLoadConfig(),
}))

const mockReadHealth = vi.fn().mockReturnValue(null)
const mockGetDefaultHealthPath = vi.fn().mockReturnValue("/mock/health.json")
vi.mock("../../heart/daemon/daemon-health", () => ({
  readHealth: (...args: any[]) => mockReadHealth(...args),
  getDefaultHealthPath: () => mockGetDefaultHealthPath(),
}))

const mockReadJournalFiles = vi.fn().mockReturnValue([])
vi.mock("../../mind/prompt", () => ({
  readJournalFiles: (...args: any[]) => mockReadJournalFiles(...args),
}))

const mockExistsSync = vi.fn().mockReturnValue(false)
const mockReadFileSync = vi.fn().mockImplementation((filePath: string) => {
  // Bundle-meta.json should not exist by default — throw to simulate missing file
  throw new Error("ENOENT: no such file or directory")
})
vi.mock("fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}))

// ── Import under test ────────────────────────────────────────────

const { buildTurnContext } = await import("../../heart/turn-context")

// ── Helpers ──────────────────────────────────────────────────────

function makeInput() {
  return {
    currentSession: {
      friendId: "friend-1",
      channel: "cli" as const,
      key: "session-key-1",
      sessionPath: "/mock/session.json",
    },
    channel: "cli" as const,
    friendStore: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      findByExternalId: vi.fn().mockResolvedValue(null),
      hasAnyFriends: vi.fn().mockResolvedValue(false),
      listAll: vi.fn().mockResolvedValue([]),
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("buildTurnContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAgentRoot.mockReturnValue("/mock/agent-root")
    mockGetAgentName.mockReturnValue("test-agent")
    mockFindBridgesForSession.mockReturnValue([])
    mockListSessionActivity.mockReturnValue([])
    mockListTargetSessionCandidates.mockResolvedValue([])
    mockReadPendingObligations.mockReturnValue([])
    mockListActiveReturnObligations.mockReturnValue([])
    mockListSessions.mockReturnValue([])
    mockGetBoard.mockReturnValue({
      compact: "", full: "",
      byStatus: {
        drafting: [], processing: [], validating: [], collaborating: [],
        paused: [], blocked: [], done: [], cancelled: [],
      },
      issues: [], actionRequired: [], unresolvedDependencies: [],
      activeSessions: [], activeBridges: [],
    })
    mockReadRecentEpisodes.mockReturnValue([])
    mockReadActiveCares.mockReturnValue([])
    mockGetSyncConfig.mockReturnValue({ enabled: false, remote: "origin" })
    mockLoadConfig.mockReturnValue({ teams: {}, bluebubbles: {} })
    mockReadHealth.mockReturnValue(null)
    mockReadJournalFiles.mockReturnValue([])
    mockReadInnerDialogRawData.mockReturnValue({
      pendingMessages: [],
      turns: [],
      runtimeState: null,
    })
    mockDeriveInnerDialogStatus.mockReturnValue({
      processing: "idle",
      queue: "clear",
    })
    mockDeriveInnerJob.mockReturnValue({
      status: "idle",
      content: null,
      origin: null,
      mode: "reflect",
      obligationStatus: null,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    })
  })

  it("returns a complete TurnContext with all default fields", async () => {
    const ctx = await buildTurnContext(makeInput())

    expect(ctx.activeBridges).toEqual([])
    expect(ctx.sessionActivity).toEqual([])
    expect(ctx.targetCandidates).toEqual([])
    expect(ctx.pendingObligations).toEqual([])
    expect(ctx.codingSessions).toEqual([])
    expect(ctx.otherCodingSessions).toEqual([])
    expect(ctx.innerWorkState.status).toBe("idle")
    expect(ctx.innerWorkState.hasPending).toBe(false)
    expect(ctx.taskBoard.compact).toBe("")
    expect(ctx.returnObligations).toEqual([])
    expect(ctx.recentEpisodes).toEqual([])
    expect(ctx.activeCares).toEqual([])
    expect(ctx.syncConfig).toEqual({ enabled: false, remote: "origin" })
    expect(ctx.syncFailure).toBeUndefined()
    expect(ctx.daemonRunning).toBe(false)
    expect(ctx.senseStatusLines).toEqual(expect.arrayContaining([expect.stringContaining("CLI")]))
    expect(ctx.bundleMeta).toBeNull()
    expect(ctx.daemonHealth).toBeNull()
    expect(ctx.journalFiles).toEqual([])
  })

  it("emits a nerves event with context metadata", async () => {
    await buildTurnContext(makeInput())

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "senses",
        event: "senses.turn_context_built",
        meta: expect.objectContaining({
          channel: "cli",
          obligationCount: 0,
          bridgeCount: 0,
          codingSessionCount: 0,
          episodeCount: 0,
        }),
      }),
    )
  })

  it("populates bridges from bridge manager", async () => {
    const bridge = { id: "b1", state: "active", targetSession: {} }
    mockFindBridgesForSession.mockReturnValue([bridge])

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.activeBridges).toEqual([bridge])
  })

  it("populates pending obligations", async () => {
    const obligation = { id: "ob1", status: "pending", description: "test" }
    mockReadPendingObligations.mockReturnValue([obligation])

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.pendingObligations).toEqual([obligation])
  })

  it("populates return obligations", async () => {
    const retOb = { id: "ro1", origin: "somewhere" }
    mockListActiveReturnObligations.mockReturnValue([retOb])

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.returnObligations).toEqual([retOb])
  })

  it("populates recent episodes and active cares", async () => {
    const episode = { id: "ep1", salience: "normal" }
    const care = { id: "c1", currentRisk: null }
    mockReadRecentEpisodes.mockReturnValue([episode])
    mockReadActiveCares.mockReturnValue([care])

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.recentEpisodes).toEqual([episode])
    expect(ctx.activeCares).toEqual([care])
  })

  it("filters coding sessions by origin session ownership", async () => {
    const input = makeInput()
    const ownSession = {
      id: "cs1",
      status: "running",
      originSession: {
        friendId: input.currentSession.friendId,
        channel: input.currentSession.channel,
        key: input.currentSession.key,
      },
    }
    const otherSession = {
      id: "cs2",
      status: "running",
      originSession: {
        friendId: "other-friend",
        channel: "teams",
        key: "other-key",
      },
    }
    mockListSessions.mockReturnValue([ownSession, otherSession])

    const ctx = await buildTurnContext(input)
    expect(ctx.codingSessions).toEqual([ownSession])
    expect(ctx.otherCodingSessions).toEqual([otherSession])
  })

  it("excludes non-live coding session statuses", async () => {
    mockListSessions.mockReturnValue([
      { id: "cs1", status: "completed", originSession: { friendId: "f", channel: "cli", key: "k" } },
      { id: "cs2", status: "failed", originSession: { friendId: "f", channel: "cli", key: "k" } },
    ])

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.codingSessions).toEqual([])
    expect(ctx.otherCodingSessions).toEqual([])
  })

  it("skips target candidates for inner channel", async () => {
    const input = makeInput()
    input.channel = "inner" as any

    await buildTurnContext(input)
    expect(mockListTargetSessionCandidates).not.toHaveBeenCalled()
  })

  it("handles inner work state with running dialog", async () => {
    mockDeriveInnerDialogStatus.mockReturnValue({
      processing: "started",
      queue: "pending",
      origin: { friendId: "f1", channel: "cli", key: "k1" },
      contentSnippet: "thinking about...",
      obligationPending: true,
    })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.innerWorkState.status).toBe("running")
    expect(ctx.innerWorkState.hasPending).toBe(true)
    expect(ctx.innerWorkState.origin).toEqual({ friendId: "f1", channel: "cli", key: "k1" })
  })

  it("handles errors in individual state reads gracefully", async () => {
    mockListSessionActivity.mockImplementation(() => { throw new Error("session read fail") })
    mockListTargetSessionCandidates.mockRejectedValue(new Error("target fail"))
    mockReadPendingObligations.mockImplementation(() => { throw new Error("obligation fail") })
    mockListSessions.mockImplementation(() => { throw new Error("coding fail") })
    mockGetBoard.mockImplementation(() => { throw new Error("task fail") })
    mockListActiveReturnObligations.mockImplementation(() => { throw new Error("return fail") })

    // Should not throw — graceful degradation
    const ctx = await buildTurnContext(makeInput())
    expect(ctx.sessionActivity).toEqual([])
    expect(ctx.targetCandidates).toEqual([])
    expect(ctx.pendingObligations).toEqual([])
    expect(ctx.codingSessions).toEqual([])
    expect(ctx.otherCodingSessions).toEqual([])
    expect(ctx.taskBoard.compact).toBe("")
    expect(ctx.returnObligations).toEqual([])
  })

  it("handles sync config read failure gracefully", async () => {
    mockGetSyncConfig.mockImplementation(() => { throw new Error("config fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.syncConfig).toEqual({ enabled: false, remote: "origin" })
  })

  it("reads daemon health and journal files for prompt pre-reads", async () => {
    const healthState = { habits: {}, degraded: [] }
    const journalEntry = { name: "entry.md", mtime: 12345, preview: "hello" }
    mockReadHealth.mockReturnValue(healthState)
    mockReadJournalFiles.mockReturnValue([journalEntry])

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.daemonHealth).toEqual(healthState)
    expect(ctx.journalFiles).toEqual([journalEntry])
  })

  it("handles daemon health read failure gracefully", async () => {
    mockReadHealth.mockImplementation(() => { throw new Error("health fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.daemonHealth).toBeNull()
  })

  it("handles journal files read failure gracefully", async () => {
    mockReadJournalFiles.mockImplementation(() => { throw new Error("journal fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.journalFiles).toEqual([])
  })

  it("handles inner work state read failure gracefully", async () => {
    mockReadInnerDialogRawData.mockImplementation(() => { throw new Error("inner dialog fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.innerWorkState.status).toBe("idle")
    expect(ctx.innerWorkState.hasPending).toBe(false)
  })

  it("handles daemon socket check failure gracefully", async () => {
    mockExistsSync.mockImplementation(() => { throw new Error("fs fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.daemonRunning).toBe(false)
  })

  it("handles runtime config read failure in sense status lines gracefully", async () => {
    mockLoadConfig.mockImplementation(() => { throw new Error("runtime config fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.senseStatusLines).toEqual([])
  })

  it("detects configured senses from runtime config and enabled config", async () => {
    mockLoadAgentConfig.mockReturnValue({
      senses: { cli: { enabled: true }, teams: { enabled: true }, bluebubbles: { enabled: true } },
    })
    mockLoadConfig.mockReturnValue({
      teams: { clientId: "cid", clientSecret: "csecret", tenantId: "tid" },
      bluebubbles: { serverUrl: "http://bb", password: "pass" },
    })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.senseStatusLines).toEqual([
      "- CLI: interactive",
      "- Teams: ready",
      "- BlueBubbles: ready",
      "- Mail: disabled",
    ])
  })

  it("detects needs_config when senses enabled but runtime config is incomplete", async () => {
    mockLoadAgentConfig.mockReturnValue({
      senses: { cli: { enabled: true }, teams: { enabled: true }, bluebubbles: { enabled: true } },
    })
    mockLoadConfig.mockReturnValue({ teams: {}, bluebubbles: {} })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.senseStatusLines).toEqual([
      "- CLI: interactive",
      "- Teams: needs_config",
      "- BlueBubbles: not_attached",
      "- Mail: disabled",
    ])
  })

  it("uses fallback senses config when config.senses is undefined", async () => {
    mockLoadAgentConfig.mockReturnValue({})

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.senseStatusLines).toEqual([
      "- CLI: interactive",
      "- Teams: disabled",
      "- BlueBubbles: disabled",
      "- Mail: disabled",
    ])
  })

  it("handles malformed runtime config gracefully", async () => {
    mockLoadConfig.mockReturnValue([])

    const ctx = await buildTurnContext(makeInput())
    // Should still produce lines — just with disabled/needs_config
    expect(ctx.senseStatusLines).toEqual(expect.arrayContaining([expect.stringContaining("CLI")]))
  })

  it("handles sense status lines read failure gracefully", async () => {
    mockLoadAgentConfig.mockImplementation(() => { throw new Error("config fail") })

    const ctx = await buildTurnContext(makeInput())
    expect(ctx.senseStatusLines).toEqual([])
  })

  it("includes live coding session statuses: spawning, running, waiting_input, stalled", async () => {
    const sessions = [
      { id: "1", status: "spawning", originSession: { friendId: "f", channel: "cli", key: "k" } },
      { id: "2", status: "running", originSession: { friendId: "f", channel: "cli", key: "k" } },
      { id: "3", status: "waiting_input", originSession: { friendId: "f", channel: "cli", key: "k" } },
      { id: "4", status: "stalled", originSession: { friendId: "f", channel: "cli", key: "k" } },
    ]
    mockListSessions.mockReturnValue(sessions)

    const input = makeInput()
    input.currentSession.friendId = "f"
    input.currentSession.channel = "cli" as any
    input.currentSession.key = "k"

    const ctx = await buildTurnContext(input)
    expect(ctx.codingSessions).toHaveLength(4)
  })
})
