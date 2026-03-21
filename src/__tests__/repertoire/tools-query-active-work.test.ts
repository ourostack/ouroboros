import { beforeEach, describe, expect, it, vi } from "vitest"

function makeEmptyBoard() {
  return {
    compact: "",
    full: "",
    byStatus: {
      drafting: [],
      processing: [],
      validating: [],
      collaborating: [],
      paused: [],
      blocked: [],
      done: [],
    },
    actionRequired: [],
    unresolvedDependencies: [],
    activeSessions: [],
    activeBridges: [],
  }
}

const getBoardMock = vi.fn(() => makeEmptyBoard())
const listSessionActivityMock = vi.fn(() => [
  {
    friendId: "friend-1",
    friendName: "Ari",
    channel: "bluebubbles",
    key: "chat:any;-;ari@mendelow.me",
    sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
    lastActivityAt: "2026-03-21T17:36:03.760Z",
    lastActivityMs: Date.parse("2026-03-21T17:36:03.760Z"),
    activitySource: "friend-facing",
  },
  {
    friendId: "friend-2",
    friendName: "Jordan",
    channel: "teams",
    key: "thread-1",
    sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/thread-1.json",
    lastActivityAt: "2026-03-21T19:36:03.760Z",
    lastActivityMs: Date.parse("2026-03-21T19:36:03.760Z"),
    activitySource: "friend-facing",
  },
])
const readPendingObligationsMock = vi.fn(() => [
  {
    id: "ob-current",
    origin: { friendId: "friend-1", channel: "cli", key: "session" },
    content: "close the loop visibly",
    status: "investigating",
    currentSurface: { kind: "coding", label: "codex coding-083" },
    currentArtifact: null,
    nextAction: "let coding-083 inspect and report back",
    latestNote: "coding lane opened",
    createdAt: "2026-03-21T20:00:00.000Z",
    updatedAt: "2026-03-21T20:01:00.000Z",
  },
])
const listCodingSessionsMock = vi.fn(() => [
  {
    id: "coding-083",
    runner: "codex",
    workdir: "/mock/workspaces/ouroboros",
    taskRef: "inspect-family-status",
    status: "running",
    stdoutTail: "",
    stderrTail: "",
    pid: 83,
    startedAt: "2026-03-21T20:00:00.000Z",
    lastActivityAt: "2026-03-21T20:02:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
    originSession: { friendId: "friend-1", channel: "cli", key: "session" },
  },
  {
    id: "coding-001",
    runner: "claude",
    workdir: "/mock/workspaces/ouroboros",
    taskRef: "old-fix",
    status: "completed",
    stdoutTail: "done",
    stderrTail: "",
    pid: 1,
    startedAt: "2026-03-21T10:00:00.000Z",
    lastActivityAt: "2026-03-21T10:10:00.000Z",
    endedAt: "2026-03-21T10:10:00.000Z",
    restartCount: 0,
    lastExitCode: 0,
    lastSignal: null,
    failure: null,
    originSession: { friendId: "friend-1", channel: "bluebubbles", key: "chat:any;-;ari@mendelow.me" },
  },
])

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
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

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: getBoardMock,
    createTask: vi.fn(),
    updateStatus: vi.fn(),
    boardStatus: vi.fn(),
    boardAction: vi.fn(),
    boardDeps: vi.fn(),
    boardSessions: vi.fn(),
  }),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "slugger"),
  loadAgentConfig: vi.fn(() => ({
    provider: "anthropic",
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
}))

vi.mock("../../heart/session-activity", () => ({
  listSessionActivity: listSessionActivityMock,
}))

vi.mock("../../heart/daemon/thoughts", () => ({
  extractThoughtResponseFromMessages: vi.fn(() => null),
  formatSurfacedValue: vi.fn((value) => value),
  getInnerDialogSessionPath: vi.fn(() => "/mock/agent-root/state/sessions/self/inner/dialog.json"),
  readInnerDialogStatus: vi.fn(() => ({
    queue: "clear",
    wake: "clear",
    processing: "started",
    surfaced: "nothing recent",
  })),
  readInnerDialogRawData: vi.fn(() => ({
    pendingMessages: [],
    turns: [],
    runtimeState: null,
  })),
  deriveInnerDialogStatus: vi.fn(() => ({
    queue: "clear",
    wake: "clear",
    processing: "started",
    surfaced: "nothing recent",
    origin: null,
    contentSnippet: null,
    obligationPending: false,
  })),
  deriveInnerJob: vi.fn(() => ({
    status: "running",
    content: "inspect family-status world-state",
    origin: null,
    mode: "reflect",
    obligationStatus: "active",
    surfacedResult: null,
    queuedAt: null,
    startedAt: "2026-03-21T20:00:00.000Z",
    surfacedAt: null,
  })),
}))

vi.mock("../../heart/bridges/manager", () => ({
  createBridgeManager: vi.fn(() => ({
    findBridgesForSession: vi.fn(() => []),
  })),
  formatBridgeStatus: vi.fn(() => "bridge"),
}))

vi.mock("../../heart/obligations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/obligations")>()
  return {
    ...actual,
    createObligation: vi.fn(),
    readPendingObligations: readPendingObligationsMock,
  }
})

vi.mock("../../repertoire/coding", () => ({
  getCodingSessionManager: vi.fn(() => ({
    listSessions: listCodingSessionsMock,
  })),
}))

describe("query_active_work tool", () => {
  beforeEach(() => {
    vi.resetModules()
    getBoardMock.mockReset()
    getBoardMock.mockImplementation(() => makeEmptyBoard())
    listSessionActivityMock.mockReset()
    listSessionActivityMock.mockImplementation(() => [
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        key: "chat:any;-;ari@mendelow.me",
        sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
        lastActivityAt: "2026-03-21T17:36:03.760Z",
        lastActivityMs: Date.parse("2026-03-21T17:36:03.760Z"),
        activitySource: "friend-facing",
      },
      {
        friendId: "friend-2",
        friendName: "Jordan",
        channel: "teams",
        key: "thread-1",
        sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/thread-1.json",
        lastActivityAt: "2026-03-21T19:36:03.760Z",
        lastActivityMs: Date.parse("2026-03-21T19:36:03.760Z"),
        activitySource: "friend-facing",
      },
    ])
    readPendingObligationsMock.mockReset()
    readPendingObligationsMock.mockImplementation(() => [
      {
        id: "ob-current",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "close the loop visibly",
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-083" },
        currentArtifact: null,
        nextAction: "let coding-083 inspect and report back",
        latestNote: "coding lane opened",
        createdAt: "2026-03-21T20:00:00.000Z",
        updatedAt: "2026-03-21T20:01:00.000Z",
      },
    ])
    listCodingSessionsMock.mockReset()
    listCodingSessionsMock.mockImplementation(() => [
      {
        id: "coding-083",
        runner: "codex",
        workdir: "/mock/workspaces/ouroboros",
        taskRef: "inspect-family-status",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 83,
        startedAt: "2026-03-21T20:00:00.000Z",
        lastActivityAt: "2026-03-21T20:02:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "friend-1", channel: "cli", key: "session" },
      },
      {
        id: "coding-001",
        runner: "claude",
        workdir: "/mock/workspaces/ouroboros",
        taskRef: "old-fix",
        status: "completed",
        stdoutTail: "done",
        stderrTail: "",
        pid: 1,
        startedAt: "2026-03-21T10:00:00.000Z",
        lastActivityAt: "2026-03-21T10:10:00.000Z",
        endedAt: "2026-03-21T10:10:00.000Z",
        restartCount: 0,
        lastExitCode: 0,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "friend-1", channel: "bluebubbles", key: "chat:any;-;ari@mendelow.me" },
      },
    ])
  })

  it("is registered in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "query_active_work")
    expect(tool).toBeDefined()
    expect(tool!.tool.function.parameters).toMatchObject({
      type: "object",
      properties: {},
    })
  })

  it("returns one top-level live world-state surface", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "query_active_work")!

    const result = await tool.handler({}, {
      signin: async () => undefined,
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
      },
    } as any)

    expect(result).toContain("this is my current top-level live world-state.")
    expect(result).toContain("## what i'm holding")
    expect(result).toContain("this is my top-level live world-state right now.")
    expect(result).toContain("## live coding work")
    expect(result).toContain("codex coding-083")
    expect(result).toContain("## other active sessions")
    expect(result).toContain("Ari/bluebubbles/chat:any;-;ari@mendelow.me")
    expect(result).not.toContain("coding-001")
  })

  it("shows other live work even without a current session", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "query_active_work")!

    const result = await tool.handler({}, {
      signin: async () => undefined,
    } as any)

    expect(result).toContain("this is my current top-level live world-state.")
    expect(result).toContain("## other active sessions")
    expect(result).toContain("friend-1/cli/session")
  })

  it("treats idle inner processing as idle instead of forcing a running lane", async () => {
    const thoughts = await import("../../heart/daemon/thoughts")
    vi.mocked(thoughts.deriveInnerDialogStatus).mockImplementation(() => ({
      queue: "clear",
      wake: "clear",
      processing: "clear",
      surfaced: "nothing recent",
      origin: null,
      contentSnippet: null,
      obligationPending: false,
    }))
    vi.mocked(thoughts.deriveInnerJob).mockImplementation(() => ({
      status: "idle",
      content: null,
      origin: null,
      mode: "reflect",
      obligationStatus: null,
      surfacedResult: null,
      queuedAt: null,
      startedAt: null,
      surfacedAt: null,
    }))

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "query_active_work")!

    const result = await tool.handler({}, {
      signin: async () => undefined,
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
      },
    } as any)

    expect(result).toContain("this is my current top-level live world-state.")
    expect(result).not.toContain("thinking through something privately")
  })

  it("falls back cleanly when obligations, coding, or task state cannot be read", async () => {
    listSessionActivityMock.mockImplementation(() => {
      throw new Error("activity unavailable")
    })
    readPendingObligationsMock.mockImplementation(() => {
      throw new Error("obligations unavailable")
    })
    listCodingSessionsMock.mockImplementation(() => {
      throw new Error("coding unavailable")
    })
    getBoardMock.mockImplementation(() => {
      throw new Error("board unavailable")
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "query_active_work")!

    const result = await tool.handler({}, {
      signin: async () => undefined,
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
      },
    } as any)

    expect(result).toContain("this is my current top-level live world-state.")
    expect(result).toContain("## what i'm holding")
    expect(result).not.toContain("## live coding work")
    expect(result).not.toContain("## return obligations")
  })
})
