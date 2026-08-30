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
      cancelled: [],
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
    lastInboundAt: "2026-03-21T17:36:03.760Z",
    lastOutboundAt: "2026-03-21T17:40:03.760Z",
    unansweredInboundCount: 0,
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
    lastInboundAt: "2026-03-21T19:36:03.760Z",
    lastOutboundAt: null,
    unansweredInboundCount: 1,
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
const listVisibleBackgroundOperationsMock = vi.fn(() => [])
const listTelegramEffectsMock = vi.fn(() => [{
  id: "a".repeat(64),
  authorClass: "butler",
  target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:8541786263:42" },
  parts: [{ state: "session_recorded" }],
  updatedAt: "2026-08-29T00:00:00.000Z",
}])
const listTelegramAdmissionsMock = vi.fn(() => [{
  id: "b".repeat(20),
  status: "pending",
  displayCode: "PINE-4821",
  createdAt: Date.parse("2026-08-29T00:00:00.000Z"),
  expiresAt: Date.parse("2026-08-30T00:00:00.000Z"),
}])

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

vi.mock("../../heart/session-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/session-activity")>()
  return {
    ...actual,
    listSessionActivity: listSessionActivityMock,
  }
})

vi.mock("../../heart/daemon/thoughts", () => ({
  extractThoughtResponseFromMessages: vi.fn(() => null),
  formatSurfacedValue: vi.fn((value) => value),
  getPrivateRuntimeSessionPath: vi.fn(() => "/mock/agent-root/state/sessions/self/inner/dialog.json"),
  readPrivateRuntimeStatus: vi.fn(() => ({
    queue: "clear",
    wake: "clear",
    processing: "started",
    surfaced: "nothing recent",
  })),
  readPrivateRuntimeRawData: vi.fn(() => ({
    pendingMessages: [],
    turns: [],
    runtimeState: null,
  })),
  derivePrivateRuntimeStatus: vi.fn(() => ({
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

vi.mock("../../arc/obligations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../arc/obligations")>()
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

vi.mock("../../heart/mail-import-discovery", () => ({
  listVisibleBackgroundOperations: listVisibleBackgroundOperationsMock,
}))

vi.mock("../../senses/telegram-effect-adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../senses/telegram-effect-adapter")>(),
  FileTelegramEffectJournal: class {
    list() { return listTelegramEffectsMock() }
    close() {}
  },
}))

vi.mock("../../senses/telegram-admission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../senses/telegram-admission")>(),
  FileTelegramAdmissionStore: class {
    list() { return listTelegramAdmissionsMock() }
    close() {}
  },
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
        lastInboundAt: "2026-03-21T17:36:03.760Z",
        lastOutboundAt: "2026-03-21T17:40:03.760Z",
        unansweredInboundCount: 0,
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
        lastInboundAt: "2026-03-21T19:36:03.760Z",
        lastOutboundAt: null,
        unansweredInboundCount: 1,
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
    listVisibleBackgroundOperationsMock.mockReset()
    listVisibleBackgroundOperationsMock.mockImplementation(() => [])
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
    expect(result).toContain("## contact timing")
    expect(result).toContain("freshest friend-facing contact: Jordan/teams/thread-1")
    expect(result).toContain("1 unanswered inbound message")
    expect(result).toContain("## live coding work")
    expect(result).toContain("codex coding-083")
    expect(result).toContain("## other active sessions")
    expect(result).toContain("Ari/bluebubbles/chat:any;-;ari@mendelow.me")
    expect(result).not.toContain("coding-001")
  })

  it("adds the bounded operational projection only for the Sanctuary Butler", async () => {
    const identity = await import("../../heart/identity")
    vi.mocked(identity.getAgentName).mockReturnValue("sanctuary")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "query_active_work")!
    const result = await tool.handler({}, { signin: async () => undefined } as any)
    expect(result).toContain("## butler operational visibility")
    expect(result).toContain("unavailable")
    vi.mocked(identity.getAgentName).mockReturnValue("slugger")
  })

  it("renders full Butler visibility from the existing event, policy, await, effect, admission, daemon, and sense owners", async () => {
    const { formatButlerOperationalVisibility } = await import("../../repertoire/tools-session")
    const result = formatButlerOperationalVisibility({
      agentName: "sanctuary",
      daemonHealth: { status: "partial", mode: "production", pid: 11, startedAt: "2026-08-29T00:00:00.000Z", uptimeSeconds: 30, safeMode: null, degraded: [], agents: { sanctuary: { status: "running", pid: 12, crashes: 0 } }, habits: {} },
      senseStatusLines: ["- Telegram: ready", "- Mail: disabled"],
      stewardPolicy: { schemaVersion: 1, version: 4, desiredStates: { "container:books": { value: "intentionally_off", provenance: "stated", version: 4, source: "telegram" } }, routineActionGrants: { restart: { action: "unraid.container.restart", targets: ["jellyfin"], maxCount: 2, windowMs: 60000, verificationRequired: true, exclusions: [], provenance: "stated", issuer: "ari", authorizedAt: "2026-08-29T00:00:00.000Z", authorizingSessionEvent: "evt", version: 4 } }, updatedAt: "2026-08-29T00:00:00.000Z" },
      awaits: [{ name: "top-up", condition: "Ari says the account is topped up", cadence: "1h", alert: "telegram", mode: "full", max_age: null, status: "pending", created_at: "2026-08-29T00:00:00.000Z", filed_from: "telegram", filed_for_friend_id: "ari", filed_from_key: "owner", request_id: "req", obligation_id: null, body: "check credit", resolved_at: null, resolution_observation: null, expired_at: null, last_observation_at_expiry: null, canceled_at: null, cancel_reason: null }],
      telegramEffects: [{ id: "effect-1", authorClass: "butler", targetKind: "approved_relationship", state: "accepted", updatedAt: "2026-08-29T00:00:00.000Z" }],
      telegramAdmissions: [{ id: "admission-1", status: "pending", displayCode: "WARM-OWL", createdAt: 1_777_000_000_000, expiresAt: 1_777_003_600_000 }],
      externalEvents: [{ recordPath: "/event", corrupt: false, agent: "sanctuary", source: "health", eventId: "media-down", eventType: "service", observationRevision: "r1", transition: "unchanged", executionState: "handled", generation: 1, attemptCount: 1, updatedAt: "2026-08-29T00:00:00.000Z", classification: "expected", decision: "silent", reason: "Books is intentionally off", stewardPolicy: { kind: "current", key: "container:books", version: 4 }, nextWake: { kind: "on_change" }, careId: null, awaitId: null, lastError: null, nextAttemptAt: null, claimOwner: null, claimExpiresAt: null, dispatchEnabled: true, undispatched: false, retentionSummary: null }],
      sourceErrors: {},
    })
    expect(result).toContain("disposition expected/silent; reason Books is intentionally off")
    expect(result).toContain("steward container:books@4")
    expect(result).toContain("pending awaits: 1")
    expect(result).toContain("container:books = intentionally_off")
    expect(result).toContain("restart: unraid.container.restart on jellyfin")
    expect(result).toContain("Telegram effects: 1")
    expect(result).toContain("effect-1: accepted; butler; approved_relationship")
    expect(result).toContain("Telegram admissions: 1")
    expect(result).toContain("admission-1: pending; code WARM-OWL")
    expect(result).toContain("daemon: partial")
    expect(result).toContain("Telegram: ready")
  })

  it("surfaces unavailable owners and bounds operational history", async () => {
    const { formatButlerOperationalVisibility } = await import("../../repertoire/tools-session")
    const event = { recordPath: "/event", corrupt: false, agent: "sanctuary", source: "health", eventId: "media-down", eventType: "service", observationRevision: "r1", transition: "unchanged" as const, executionState: "handled" as const, generation: 1, attemptCount: 1, updatedAt: "2026-08-29T00:00:00.000Z", classification: "expected" as const, decision: "silent" as const, reason: "x".repeat(500), stewardPolicy: { kind: "none" as const }, nextWake: { kind: "on_change" as const }, careId: null, awaitId: null, lastError: null, nextAttemptAt: null, claimOwner: null, claimExpiresAt: null, dispatchEnabled: true, undispatched: false, retentionSummary: null }
    const result = formatButlerOperationalVisibility({
      agentName: "sanctuary", daemonHealth: null, senseStatusLines: [],
      stewardPolicy: { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null },
      awaits: [], telegramEffects: [], telegramAdmissions: [],
      externalEvents: Array.from({ length: 25 }, (_, index) => ({ ...event, eventId: `event-${index}` })),
      sourceErrors: { daemon_health: "health file unreadable", telegram_effects: "state corrupt", telegram_admissions: "admissions unreadable", senses: "credentials unavailable" },
    })
    expect(result).toContain("daemon: unavailable (health file unreadable)")
    expect(result).toContain("Telegram effects: unavailable (state corrupt)")
    expect(result).toContain("Telegram admissions: unavailable (admissions unreadable)")
    expect(result).toContain("unavailable (credentials unavailable)")
    expect(result).toContain("5 more; ouro status --json")
    expect(result.length).toBeLessThan(10_000)
  })

  it("reads pending awaits plus canonical Telegram journals and daemon state", async () => {
    const fs = await import("fs")
    const existsSync = vi.mocked(fs.existsSync)
    const readdirSync = vi.mocked(fs.readdirSync)
    const readFileSync = vi.mocked(fs.readFileSync)
    existsSync.mockImplementation((candidate) => {
      const filePath = String(candidate)
      return filePath.endsWith("/awaiting")
        || filePath.endsWith("/state/telegram/effects")
        || filePath.endsWith("/state/senses/telegram/admissions")
    })
    readdirSync.mockImplementation(((candidate: string) => String(candidate).endsWith("/awaiting") ? [
      { name: "pending.md", isFile: () => true },
      { name: "resolved.md", isFile: () => true },
      { name: "ignored.txt", isFile: () => true },
      { name: "nested.md", isFile: () => false },
    ] : []) as any)
    readFileSync.mockImplementation(((candidate: string) => {
      const filePath = String(candidate)
      if (filePath.endsWith("pending.md")) return "---\ncondition: Ari confirms the top-up\nstatus: pending\n---\ncheck credit\n"
      if (filePath.endsWith("resolved.md")) return "---\nstatus: resolved\n---\ndone\n"
      return JSON.stringify({ status: "healthy", mode: "production", pid: 41, startedAt: "2026-08-29T00:00:00.000Z", uptimeSeconds: 60, safeMode: null, degraded: [], agents: {}, habits: {} })
    }) as any)

    try {
      const { readButlerOperationalVisibility } = await import("../../repertoire/tools-session")
      const status = readButlerOperationalVisibility("/mock/butler", "sanctuary")
      expect(status.awaits).toEqual([expect.objectContaining({ name: "pending", status: "pending" })])
      expect(status.telegramEffects).toEqual([expect.objectContaining({ state: "session_recorded", updatedAt: "2026-08-29T00:00:00.000Z" })])
      expect(status.telegramAdmissions).toEqual([expect.objectContaining({ status: "pending", displayCode: "PINE-4821" })])
      expect(status.daemonHealth).toMatchObject({ status: "healthy", pid: 41 })
    } finally {
      existsSync.mockReset()
      readdirSync.mockReset()
      readFileSync.mockReset()
    }
  })

  it("renders bounded await and event detail including wake, return, care, and unavailable sources", async () => {
    const { formatButlerOperationalVisibility } = await import("../../repertoire/tools-session")
    const awaits = Array.from({ length: 21 }, (_, index) => ({
      name: `await-${index}`,
      condition: index === 0 ? null : `condition-${index}`,
      cadence: null,
      alert: null,
      mode: "full" as const,
      max_age: null,
      wake_at: index === 0 ? "2026-08-30T00:00:00.000Z" : null,
      status: "pending" as const,
      created_at: null,
      filed_from: null,
      filed_for_friend_id: null,
      filed_from_key: null,
      request_id: null,
      obligation_id: null,
      body: index === 0 ? "body fallback" : "",
      resolved_at: null,
      resolution_observation: null,
      expired_at: null,
      last_observation_at_expiry: null,
      canceled_at: null,
      cancel_reason: null,
    }))
    const event = {
      recordPath: "/event", corrupt: false, agent: "sanctuary", source: "health", eventId: "needs-detail", eventType: "service", observationRevision: "r1", transition: "changed" as const,
      executionState: "handled" as const, generation: 1, attemptCount: 1, updatedAt: "2026-08-29T00:00:00.000Z", classification: null, decision: null,
      reason: null, stewardPolicy: { kind: "none" as const }, nextWake: null, careId: "care-1", awaitId: "await-1", lastError: "still investigating", nextAttemptAt: null,
      claimOwner: null, claimExpiresAt: null, dispatchEnabled: true, undispatched: false, retentionSummary: null,
    }
    const result = formatButlerOperationalVisibility({
      agentName: "sanctuary",
      daemonHealth: { status: "healthy", mode: "production", pid: 1, startedAt: "2026-08-29T00:00:00.000Z", uptimeSeconds: 1, safeMode: null, degraded: [], agents: {}, habits: {} },
      senseStatusLines: [],
      stewardPolicy: { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null },
      awaits,
      telegramEffects: [],
      telegramAdmissions: [],
      externalEvents: [event],
      sourceErrors: { awaits: "await store unavailable", external_events: "event store unavailable", steward_policy: "policy unavailable" },
    })
    expect(result).toContain("body fallback; wake 2026-08-30T00:00:00.000Z")
    expect(result).toContain("1 more; inspect awaiting/")
    expect(result).toContain("still investigating")
    expect(result).toContain("await await-1; care care-1")
    expect(result).toContain("event store unavailable")
    expect(result).toContain("steward policy: unavailable (policy unavailable)")
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
    vi.mocked(thoughts.derivePrivateRuntimeStatus).mockImplementation(() => ({
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

  it("filters out stale obligation surfaces that are no longer backed by live work", async () => {
    readPendingObligationsMock.mockImplementation(() => [
      {
        id: "ob-stale-coding",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "finish harness-maintenance-live-status-loop and bring the result back",
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-083" },
        latestNote: "coding session completed; merge/update still pending",
        createdAt: "2020-03-21T20:00:00.000Z",
        updatedAt: "2020-03-21T20:27:30.594Z",
      },
      {
        id: "ob-stale-pending",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "status-block injection is still active",
        status: "pending",
        createdAt: "2020-03-21T20:00:00.000Z",
        updatedAt: "2020-03-21T20:28:30.594Z",
      },
    ])
    listCodingSessionsMock.mockImplementation(() => [])

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

    expect(result).toContain("i'm in a conversation on cli/session.")
    expect(result).not.toContain("coding-083")
    expect(result).not.toContain("status-block injection is still active")
    expect(result).not.toContain("## return obligations")
  })

  it("keeps a recent coding obligation visible even before a merge artifact exists", async () => {
    const recentIso = new Date().toISOString()
    readPendingObligationsMock.mockImplementation(() => [
      {
        id: "ob-recent-coding",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "inspect the current family-status issue",
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-083" },
        latestNote: "coding session completed; merge/update still pending",
        createdAt: recentIso,
        updatedAt: recentIso,
      },
    ])
    listCodingSessionsMock.mockImplementation(() => [])

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

    expect(result).toContain("codex coding-083")
    expect(result).toContain("## return obligations")
  })

  it("reports whole-self status including active background operations", async () => {
    listVisibleBackgroundOperationsMock.mockReturnValue([
      {
        schemaVersion: 1,
        id: "op_mail_import_1",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "running",
        agentName: "slugger",
        summary: "importing Ari's HEY archive",
        detail: "scanned 500 of 16616 messages",
        progress: {
          current: 500,
          total: 16616,
          unit: "messages",
        },
        failure: {
          class: "transient-storage-read",
          retryDisposition: "retry-safe",
          hint: "likely transient hosted read failure",
        },
        spec: {
          ownerEmail: "ari@mendelow.me",
          source: "hey",
          filePath: "/tmp/.playwright-mcp/HEY-emails-ari-mendelow-me.mbox",
          fileOriginLabel: "browser sandbox (.playwright-mcp)",
        },
        createdAt: "2026-04-23T22:40:00.000Z",
        startedAt: "2026-04-23T22:40:05.000Z",
        updatedAt: "2026-04-23T22:40:30.000Z",
        remediation: [
          "retry the import from the same archive after fixing the failure",
        ],
      },
      {
        schemaVersion: 1,
        id: "op_mail_import_done",
        kind: "mail.import-mbox",
        title: "mail import",
        status: "succeeded",
        agentName: "slugger",
        summary: "imported Ari's HEY archive",
        createdAt: "2026-04-23T22:00:00.000Z",
        finishedAt: "2026-04-23T22:10:00.000Z",
        updatedAt: "2026-04-23T22:10:00.000Z",
      },
    ])

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

    expect(result).toContain("## background operations")
    expect(result).toContain("[running] mail import")
    expect(result).toContain("operation: op_mail_import_1")
    expect(result).toContain("importing Ari's HEY archive")
    expect(result).toContain("scanned 500 of 16616 messages")
    expect(result).toContain("file: /tmp/.playwright-mcp/HEY-emails-ari-mendelow-me.mbox")
    expect(result).toContain("origin: browser sandbox (.playwright-mcp)")
    expect(result).toContain("owner/source: ari@mendelow.me / hey")
    expect(result).toContain("started: 2026-04-23T22:40:05.000Z")
    expect(result).toContain("updated: 2026-04-23T22:40:30.000Z")
    expect(result).toContain("failure class: transient-storage-read")
    expect(result).toContain("retry: retry-safe")
    expect(result).toContain("recovery: likely transient hosted read failure")
    expect(result).toContain("recovery universe: transient dependency/read issue — safe to retry once storage/network answers again")
    expect(result).toContain("retry the import from the same archive after fixing the failure")
    expect(result).toContain("[succeeded] mail import")
    expect(result).toContain("imported Ari's HEY archive")
    expect(result).toContain("next: in flight — no action unless it stalls or i need live status")
    expect(result).toContain("next: caught up — no rerun needed unless a newer archive appears")
  })
})
