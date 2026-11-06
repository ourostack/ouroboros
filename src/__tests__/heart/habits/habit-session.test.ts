import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { HabitFile } from "../../../heart/habits/habit-parser"
import type { FriendRecord, TrustLevel, FriendStore } from "@ouro.bot/friends"
import type { ToolDefinition, ToolRiskProfile } from "../../../repertoire/tools-base"
import {
  buildHabitRunReceipt,
  completeHabitRun,
  createHabitSessionPaths,
  filterHabitToolsForEnvelope,
  isSafeHabitRunId,
  normalizeHabitPermissionEnvelope,
  readLatestHabitSessionState,
  resolveHabitReturnRoute,
} from "../../../heart/habits/habit-session"
import { readHabitRunReceipt, writeHabitRunReceipt } from "../../../arc/flight-recorder"

const mockEmitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

function makeHabit(overrides: Partial<HabitFile> = {}): HabitFile {
  return {
    name: "heartbeat",
    title: "Heartbeat",
    cadence: "30m",
    status: "active",
    lastRun: "2026-06-11T17:00:00.000Z",
    created: "2026-06-01T00:00:00.000Z",
    tools: undefined,
    origin: null,
    surface: { family: true, originator: true, extra: [] },
    body: "Check in.",
    ...overrides,
  }
}

function makeFriend(id: string, name: string, trustLevel: TrustLevel): FriendRecord {
  return {
    id,
    name,
    trustLevel,
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    schemaVersion: 1,
  }
}

function makeFriendStore(records: FriendRecord[]): FriendStore {
  return {
    get: vi.fn(async (id: string) => records.find((record) => record.id === id) ?? null),
    put: vi.fn(),
    delete: vi.fn(),
    findByExternalId: vi.fn(async () => null),
    listAll: vi.fn(async () => [...records]),
  }
}

function makeTool(
  name: string,
  riskProfile?: ToolRiskProfile | ((args: Record<string, string>) => ToolRiskProfile),
): ToolDefinition {
  return {
    tool: {
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object", properties: {} },
      },
    },
    handler: () => "ok",
    ...(riskProfile ? { riskProfile } : {}),
  }
}

describe("habit-session helpers", () => {
  let agentRoot: string

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "habit-session-"))
    mockEmitNervesEvent.mockReset()
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("creates per-run session paths and rejects unsafe run ids before path joining", () => {
    const runId = "2026-06-11T17-00-00-000Z-heartbeat-abc123ef"

    expect(isSafeHabitRunId(runId)).toBe(true)
    for (const unsafe of ["", "/", "\\", "..", "ok/../bad", "bad%2fvalue", "bad%2Fvalue", "bad%5cvalue"]) {
      expect(isSafeHabitRunId(unsafe)).toBe(false)
    }

    expect(createHabitSessionPaths(agentRoot, runId)).toEqual({
      runDir: path.join(agentRoot, "state", "habit-sessions", runId),
      sessionPath: path.join(agentRoot, "state", "habit-sessions", runId, "session.json"),
      pendingDir: path.join(agentRoot, "state", "habit-sessions", runId, "pending"),
      runtimeStatePath: path.join(agentRoot, "state", "habits", "heartbeat.json"),
      receiptPath: path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", `${runId}.json`),
      sessionLocator: `state/habit-sessions/${runId}/session.json`,
      pendingLocator: `state/habit-sessions/${runId}/pending`,
      runtimeStateLocator: "state/habits/heartbeat.json",
      receiptLocator: `arc/flight-recorder/habit-receipts/${runId}.json`,
    })
    expect(() => createHabitSessionPaths(agentRoot, "../escape")).toThrow("unsafe habit run id")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.habit_session_unsafe_run_id",
    }))
  })

  it("normalizes return-route permissions from parser defaults, origin, and exact extra specs", async () => {
    const ari = makeFriend("ari", "Ari", "family")
    const teammate = makeFriend("teammate-id", "Teammate", "friend")
    const loop = makeFriend("self", "Loop", "friend")
    const friendStore = makeFriendStore([ari, teammate, loop])

    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "ari", channel: "cli", key: "main" },
      surface: {
        family: true,
        originator: true,
        extra: ["Teammate/mcp/thread-1", "malformed", "self/inner/dialog", "Unknown/mcp/thread-2", "Loop/mcp/thread-3", "ari/../main", "ari/bad%ZZ/main"],
      },
    }), { agentRoot, friendStore })

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      canMessageOutward: true,
      deniedTools: [],
    })
    expect(envelope.returnRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "family", recipient: "family", status: "allowed" }),
      expect.objectContaining({ kind: "originator", recipient: "ari", status: "allowed", friendId: "ari", channel: "cli", key: "main" }),
      expect.objectContaining({ kind: "extra", recipient: "Teammate", status: "allowed", friendId: "teammate-id", channel: "mcp", key: "thread-1" }),
      expect.objectContaining({ kind: "extra", recipient: "malformed", status: "unresolved" }),
      expect.objectContaining({ kind: "extra", recipient: "self/inner/dialog", status: "unresolved" }),
      expect.objectContaining({ kind: "extra", recipient: "Unknown", status: "unresolved" }),
      expect.objectContaining({ kind: "extra", recipient: "Loop/mcp/thread-3", status: "unresolved" }),
      expect.objectContaining({ kind: "extra", recipient: "ari/../main", status: "unresolved" }),
      expect.objectContaining({ kind: "extra", recipient: "ari/bad%ZZ/main", status: "unresolved" }),
    ]))
    expect(envelope.warnings.join("\n")).toContain("malformed")
    expect(envelope.warnings.join("\n")).toContain("self/inner")
    expect(envelope.warnings.join("\n")).toContain("Unknown")
    expect(envelope.warnings.join("\n")).toContain("unsafe")
  })

  it("removes outward messaging tools when every return route is disabled or unresolved", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: null,
      surface: { family: false, originator: false, extra: [] },
    }), { agentRoot })

    expect(envelope.canMessageOutward).toBe(false)
    expect(envelope.deniedTools).toEqual(expect.arrayContaining(["send_message", "surface"]))
    expect(envelope.returnRoutes).toEqual([])
  })

  it("records unresolved originator routes when origin is missing", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: null,
      surface: { family: false, originator: true, extra: [] },
    }), { agentRoot })

    expect(envelope.canMessageOutward).toBe(false)
    expect(envelope.returnRoutes).toEqual([
      expect.objectContaining({ kind: "originator", recipient: "originator", status: "unresolved" }),
    ])
    expect(envelope.warnings.join("\n")).toContain("no origin")
  })

  it("handles malformed originators and no-store exact extra routes", async () => {
    const malformed = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "", channel: "cli", key: "main" },
      surface: { family: false, originator: true, extra: [] },
    }), { agentRoot })
    expect(malformed.returnRoutes).toEqual([
      expect.objectContaining({ kind: "originator", recipient: "", status: "unresolved" }),
    ])

    const permissive = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: null,
      surface: { family: false, originator: false, extra: ["Peer/mcp/thread-1"] },
    }), { agentRoot })
    expect(permissive.returnRoutes).toEqual([
      expect.objectContaining({ kind: "extra", recipient: "Peer", status: "allowed", friendId: "Peer" }),
    ])
  })

  it("records originator warnings when the stated origin cannot be resolved", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "missing", channel: "cli", key: "main" },
      surface: { family: false, originator: true, extra: [] },
    }), { agentRoot, friendStore: makeFriendStore([]) })

    expect(envelope.returnRoutes).toEqual([
      expect.objectContaining({ kind: "originator", recipient: "missing", status: "unresolved" }),
    ])
    expect(envelope.warnings.join("\n")).toContain("missing")
  })

  it("rejects unsafe origin route path segments before they can become pending paths", async () => {
    const friendStore = makeFriendStore([makeFriend("ari", "Ari", "family")])
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "ari", channel: "..", key: "main" },
      surface: { family: false, originator: true, extra: [] },
    }), { agentRoot, friendStore })

    expect(envelope.canMessageOutward).toBe(false)
    expect(envelope.returnRoutes).toEqual([
      expect.objectContaining({ kind: "originator", recipient: "ari/../main", status: "unresolved" }),
    ])
    expect(envelope.warnings.join("\n")).toContain("unsafe")
  })

  it("rejects routes whose resolved friend id is unsafe even when the label is safe", async () => {
    const friendStore = makeFriendStore([makeFriend("../bad", "Bad", "family")])
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: null,
      surface: { family: false, originator: false, extra: ["Bad/mcp/thread-1"] },
    }), { agentRoot, friendStore })

    expect(envelope.canMessageOutward).toBe(false)
    expect(envelope.returnRoutes).toEqual([
      expect.objectContaining({ kind: "extra", recipient: "Bad/mcp/thread-1", status: "unresolved" }),
    ])
    expect(envelope.warnings.join("\n")).toContain("unsafe")
  })

  it("resolves route attempts before handlers run and denies non-family, self, and live voice routes", async () => {
    const friendStore = makeFriendStore([
      makeFriend("ari", "Ari", "family"),
      makeFriend("casey", "Casey", "friend"),
    ])
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "ari", channel: "cli", key: "main" },
      surface: { family: true, originator: true, extra: ["casey/mcp/thread-1"] },
    }), { agentRoot, friendStore })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "ari", channel: "bluebubbles", key: "chat", content: "checking in" },
      friendStore,
    })).resolves.toMatchObject({ allowed: true, routeKind: "family", friendId: "ari" })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { friendId: "ari", channel: "bluebubbles", key: "chat", content: "checking in" },
      friendStore,
    })).resolves.toMatchObject({ allowed: true, routeKind: "family", friendId: "ari", channel: "bluebubbles", key: "chat" })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "ari", content: "checking in" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("target") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "casey", channel: "bluebubbles", key: "chat", content: "checking in" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("family") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "self", channel: "inner", key: "dialog", content: "loop" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("self/inner") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { delegationId: "held-1", content: "answer" },
      friendStore,
      delegatedOrigins: [{
        id: "held-1",
        friendId: "ari",
        friendName: "Ari",
        channel: "cli",
        key: "main",
        delegatedContent: "question",
        source: "drained",
        timestamp: 1,
      }],
    })).resolves.toMatchObject({ allowed: true, routeKind: "originator", friendId: "ari", channel: "cli", key: "main" })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { friendId: "ari", channel: "voice", content: "live call" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("voice") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "ari", channel: "..", key: "main", content: "escape" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("unsafe") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "casey", channel: "cli", key: "bad%ZZ", content: "escape" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("unsafe") })
  })

  it("rejects route targets whose resolved friend id is unsafe", async () => {
    const friendStore = makeFriendStore([makeFriend("../bad", "Bad", "family")])
    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope: {
        schemaVersion: 1,
        canMessageOutward: true,
        returnRoutes: [{ kind: "family", recipient: "family", status: "allowed" }],
        deniedTools: [],
        warnings: [],
      },
      toolName: "send_message",
      args: { friendId: "Bad", channel: "cli", key: "main", content: "escape" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("unsafe") })
  })

  it("rejects missing, unsupported, unresolved, self-resolved, and no-route tool targets", async () => {
    const friendStore = makeFriendStore([
      makeFriend("ari", "Ari", "family"),
      makeFriend("self", "Loop", "friend"),
    ])
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: null,
      surface: { family: false, originator: false, extra: [] },
    }), { agentRoot, friendStore })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { channel: "cli", key: "main" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no permitted return route target") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "shell",
      args: { command: "echo ok" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no permitted return route target") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { delegationId: "missing" },
      delegatedOrigins: [],
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no permitted return route target") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { content: "floating answer" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no permitted return route target") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { friendId: "ari", content: "floating answer" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no permitted return route target") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "missing", channel: "cli", key: "main" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("unresolved") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "Loop", channel: "cli", key: "main" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("self/inner") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "send_message",
      args: { friendId: "ari", channel: "cli", key: "main" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no habit return route") })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope: {
        schemaVersion: 1,
        canMessageOutward: true,
        returnRoutes: [{ kind: "extra", recipient: "ari/cli/other", status: "allowed", friendId: "ari", channel: "cli", key: "other" }],
        deniedTools: [],
        warnings: [],
      },
      toolName: "send_message",
      args: { friendId: "ari", channel: "cli", key: "main" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no habit return route") })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.habit_return_route_denied",
    }))
  })

  it("denies exact routes with omitted keys before handlers run", async () => {
    const friendStore = makeFriendStore([makeFriend("ari", "Ari", "family")])
    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope: {
        schemaVersion: 1,
        canMessageOutward: true,
        returnRoutes: [{ kind: "extra", recipient: "Ari", status: "allowed", friendId: "ari", channel: "cli" }],
        deniedTools: [],
        warnings: [],
      },
      toolName: "send_message",
      args: { friendId: "ari", channel: "cli", content: "checking in" },
      friendStore,
    })).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("no permitted return route target") })
  })

  it("resolves singleton delegated surface routes without mutating queues", async () => {
    const friendStore = makeFriendStore([makeFriend("ari", "Ari", "family")])
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "ari", channel: "cli", key: "main" },
    }), { agentRoot, friendStore })

    await expect(resolveHabitReturnRoute({
      agentRoot,
      envelope,
      toolName: "surface",
      args: { content: "answer" },
      friendStore,
      delegatedOrigins: [{
        id: "held-1",
        friendId: "ari",
        friendName: "Ari",
        channel: "cli",
        key: "main",
        delegatedContent: "question",
        source: "drained",
        timestamp: 1,
      }],
    })).resolves.toMatchObject({ allowed: true, routeKind: "originator", friendId: "ari", channel: "cli", key: "main" })
  })

  it("filters habit tools with the supplied executable risk classifier and route envelope", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: null,
      surface: { family: false, originator: false, extra: [] },
    }), { agentRoot })
    const shellRisk = vi.fn((args: Record<string, string>) =>
      args.command?.startsWith("echo")
        ? { mutates: "none", risk: "low" as const }
        : { mutates: "external_side_effect" as const, risk: "high" as const, reason: "mutating shell command" })
    const tools = [
      makeTool("read_file", { mutates: "none", risk: "low" }),
      makeTool("shell", shellRisk),
      makeTool("graph_mutate", { mutates: "external_side_effect", risk: "high", reason: "mutates graph" }),
      makeTool("send_message", { mutates: "external_side_effect", risk: "high", reason: "messages outward" }),
      makeTool("surface", { mutates: ["durable_state_write", "external_side_effect"], risk: "high", reason: "surfaces outward" }),
    ]

    const policy = filterHabitToolsForEnvelope(tools, null, envelope, (definition) => {
      if (typeof definition.riskProfile === "function") return definition.riskProfile({ command: "rm -rf /tmp/habit-policy-probe" })
      return definition.riskProfile ?? { mutates: "none", risk: "low" }
    })

    expect(shellRisk).toHaveBeenCalled()
    expect(policy.grantedTools).toEqual(["read_file"])
    expect(policy.deniedTools).toEqual(expect.arrayContaining(["shell", "graph_mutate", "send_message", "surface"]))
    expect(policy.outwardMessagingAllowed).toBe(false)
  })

  it("filters requested tools while preserving route-checked outward messaging exceptions", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const tools = [
      makeTool("read_file", { mutates: "none", risk: "low" }),
      makeTool("send_message", { mutates: "external_side_effect", risk: "high", reason: "messages outward" }),
      makeTool("shell", { mutates: "none", risk: "low" }),
    ]

    const policy = filterHabitToolsForEnvelope(tools, ["send_message"], envelope, (definition) =>
      definition.riskProfile as ToolRiskProfile)

    expect(policy).toMatchObject({
      requestedTools: ["send_message"],
      grantedTools: ["send_message"],
      deniedTools: [],
      outwardMessagingAllowed: true,
    })
  })

  it("builds complete schema v2 receipts without writing them", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: ["read_file"],
      deniedTools: ["shell"],
      outwardMessagingAllowed: true,
    }

    const receipt = buildHabitRunReceipt({
      agentRoot,
      habit: makeHabit({ name: "heartbeat", cadence: "30m" }),
      runId: "2026-06-11T17-00-00-000Z-heartbeat-abc123ef",
      trigger: "poke",
      startedAt: "2026-06-11T17:00:00.000Z",
      endedAt: "2026-06-11T17:01:00.000Z",
      outcome: "surfaced",
      permissionEnvelope: envelope,
      toolPolicy: policy,
      producedRefs: [{ kind: "surface", locator: "state/pending/ari/cli/main" }],
      surfaceAttempts: [{ recipient: "ari", channel: "cli", reason: "status", result: "queued", routeKind: "family" }],
      errors: [],
    })

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      runId: "2026-06-11T17-00-00-000Z-heartbeat-abc123ef",
      sessionId: "2026-06-11T17-00-00-000Z-heartbeat-abc123ef",
      definitionLocator: "habits/heartbeat.md",
      sessionLocator: "state/habit-sessions/2026-06-11T17-00-00-000Z-heartbeat-abc123ef/session.json",
      pendingLocator: "state/habit-sessions/2026-06-11T17-00-00-000Z-heartbeat-abc123ef/pending",
      runtimeStateLocator: "state/habits/heartbeat.json",
      receiptLocator: "arc/flight-recorder/habit-receipts/2026-06-11T17-00-00-000Z-heartbeat-abc123ef.json",
      nextRunAt: "2026-06-11T17:31:00.000Z",
      permissionEnvelope: envelope,
      toolPolicy: policy,
      summarySnapshot: {
        summary: "Habit heartbeat surfaced via ari/cli.",
        decisions: [],
        nextLikelyStep: null,
      },
    })
    expect(fs.existsSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", `${receipt.runId}.json`))).toBe(false)
  })

  it("completes habit runs through the habit-session helper before advancing runtime state", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: ["desk"],
      deniedTools: [],
      outwardMessagingAllowed: true,
    }

    const result = completeHabitRun({
      agentRoot,
      habit: makeHabit({ name: "heartbeat", cadence: "30m" }),
      runId: "2026-06-11T17-00-00-000Z-heartbeat-abc123ef",
      trigger: "poke",
      startedAt: "2026-06-11T17:00:00.000Z",
      endedAt: "2026-06-11T17:01:00.000Z",
      permissionEnvelope: envelope,
      toolPolicy: policy,
      producedRefs: [{ kind: "desk_task", locator: "desk/tasks/check-in" }],
      surfaceAttempts: [],
      errors: [],
      summarySnapshot: {
        summary: "Reviewed stale work and updated the desk task.",
        decisions: ["Keep the check-in task open."],
        nextLikelyStep: "Wait for the next cadence.",
      },
    })

    expect(result).toMatchObject({
      outcome: "updated_desk",
      producedRefs: [{ kind: "desk_task", locator: "desk/tasks/check-in" }],
      receiptWritten: true,
      runtimeStateRecorded: true,
    })
    expect(readHabitRunReceipt(agentRoot, "2026-06-11T17-00-00-000Z-heartbeat-abc123ef")).toMatchObject({
      habitName: "heartbeat",
      outcome: "updated_desk",
      producedRefs: [{ kind: "desk_task", locator: "desk/tasks/check-in" }],
      summarySnapshot: {
        summary: "Reviewed stale work and updated the desk task.",
        decisions: ["Keep the check-in task open."],
        nextLikelyStep: "Wait for the next cadence.",
      },
    })
    expect(JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "habits", "heartbeat.json"), "utf-8"))).toMatchObject({
      schemaVersion: 1,
      name: "heartbeat",
      lastRun: "2026-06-11T17:01:00.000Z",
    })

    const receiptWriteIndex = mockEmitNervesEvent.mock.calls.findIndex(([event]) => event.event === "mind.flight_recorder_habit_receipt_written")
    const runtimeWriteIndex = mockEmitNervesEvent.mock.calls.findIndex(([event]) => event.event === "daemon.habit_runtime_state_write")
    expect(receiptWriteIndex).toBeGreaterThanOrEqual(0)
    expect(runtimeWriteIndex).toBeGreaterThan(receiptWriteIndex)
  })

  it("defaults omitted completion refs, attempts, and errors to a no-change receipt", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: true,
    }

    const result = completeHabitRun({
      agentRoot,
      habit: makeHabit({ name: "quiet-heartbeat", cadence: null }),
      runId: "2026-06-11T17-02-00-000Z-quiet-heartbeat-abc123ef",
      trigger: "overdue",
      startedAt: "2026-06-11T17:02:00.000Z",
      endedAt: "2026-06-11T17:02:10.000Z",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    })

    expect(result).toMatchObject({
      outcome: "no_change",
      producedRefs: [],
      receiptWritten: true,
      runtimeStateRecorded: true,
    })
    expect(readHabitRunReceipt(agentRoot, "2026-06-11T17-02-00-000Z-quiet-heartbeat-abc123ef")).toMatchObject({
      habitName: "quiet-heartbeat",
      outcome: "no_change",
      producedRefs: [],
      surfaceAttempts: [],
      errors: [],
    })
  })

  it("sets null nextRunAt for inactive, unparseable, and invalid-ended runs unless explicitly provided", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }
    const base = {
      agentRoot,
      habit: makeHabit(),
      runId: "2026-06-11T17-00-00-000Z-heartbeat-abc123ef",
      trigger: "poke" as const,
      startedAt: "2026-06-11T17:00:00.000Z",
      endedAt: "not-a-date",
      outcome: "no_change" as const,
      permissionEnvelope: envelope,
      toolPolicy: policy,
    }

    expect(buildHabitRunReceipt({ ...base, habit: makeHabit({ status: "paused" }) }).nextRunAt).toBeNull()
    expect(buildHabitRunReceipt({ ...base, habit: makeHabit({ cadence: "someday" }) }).nextRunAt).toBeNull()
    expect(buildHabitRunReceipt(base).nextRunAt).toBeNull()
    expect(buildHabitRunReceipt({ ...base, nextRunAt: "2026-06-12T00:00:00.000Z" }).nextRunAt)
      .toBe("2026-06-12T00:00:00.000Z")
  })

  it("reconstructs latest habit session state from Arc receipts and runtime state without reading transcripts", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit({
      origin: { friendId: "ari", channel: "cli", key: "main" },
      surface: { family: true, originator: true, extra: [] },
    }), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: ["send_message", "surface"],
      deniedTools: ["shell"],
      outwardMessagingAllowed: true,
    }
    writeHabitRunReceipt(agentRoot, buildHabitRunReceipt({
      agentRoot,
      habit: makeHabit({ name: "heartbeat" }),
      runId: "run-old",
      trigger: "launchd",
      startedAt: "2026-06-11T10:00:00.000Z",
      endedAt: "2026-06-11T10:01:00.000Z",
      outcome: "no_change",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    }))
    const latest = buildHabitRunReceipt({
      agentRoot,
      habit: makeHabit({ name: "heartbeat" }),
      runId: "run-cron",
      trigger: "cron",
      startedAt: "2026-06-11T12:00:00.000Z",
      endedAt: "2026-06-11T12:01:00.000Z",
      outcome: "blocked",
      permissionEnvelope: envelope,
      toolPolicy: policy,
      producedRefs: [{ kind: "surface", locator: "state/pending/ari/cli/main" }],
      surfaceAttempts: [{
        recipient: "ari",
        channel: "cli",
        reason: "blocked",
        result: "blocked",
        routeKind: "originator",
        rawStatus: "blocked",
        error: "needs input",
      }],
      errors: ["needs input"],
    })
    writeHabitRunReceipt(agentRoot, latest)

    const transcriptPath = path.join(agentRoot, "state", "habit-sessions", latest.runId, "session.json")
    fs.mkdirSync(transcriptPath, { recursive: true })
    const runtimeStatePath = path.join(agentRoot, "state", "habits", "heartbeat.json")
    fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true })
    fs.writeFileSync(runtimeStatePath, JSON.stringify({
      schemaVersion: 1,
      name: "heartbeat",
      lastRun: latest.endedAt,
      updatedAt: latest.endedAt,
    }, null, 2), "utf-8")

    const state = readLatestHabitSessionState(agentRoot)

    expect(state).toMatchObject({
      receipt: {
        runId: latest.runId,
        habitName: "heartbeat",
        trigger: "cron",
        outcome: "blocked",
        permissionEnvelope: envelope,
        toolPolicy: policy,
        producedRefs: latest.producedRefs,
        surfaceAttempts: latest.surfaceAttempts,
        errors: ["needs input"],
        nextRunAt: "2026-06-11T12:31:00.000Z",
      },
      runtimeState: {
        schemaVersion: 1,
        name: "heartbeat",
        lastRun: latest.endedAt,
        updatedAt: latest.endedAt,
        activeOperationId: null,
        latestRunId: null,
        latestReceiptLocator: null,
      },
    })
  })

  it("normalizes runtime cursor snapshots and rejects malformed cursor fields", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }
    const receipt = buildHabitRunReceipt({
      agentRoot,
      habit: makeHabit({ name: "heartbeat" }),
      runId: "run-cursor",
      trigger: "poke",
      startedAt: "2026-06-11T13:00:00.000Z",
      endedAt: "2026-06-11T13:01:00.000Z",
      outcome: "no_change",
      operationId: "op-cursor",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    })
    writeHabitRunReceipt(agentRoot, receipt)
    const runtimeStatePath = path.join(agentRoot, "state", "habits", "heartbeat.json")
    fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true })
    fs.writeFileSync(runtimeStatePath, JSON.stringify({
      schemaVersion: 1,
      name: "heartbeat",
      lastRun: receipt.endedAt,
      updatedAt: receipt.endedAt,
      activeOperationId: " op-cursor ",
      latestRunId: ` ${receipt.runId} `,
      latestReceiptLocator: ` ${receipt.receiptLocator} `,
    }, null, 2), "utf-8")

    expect(readLatestHabitSessionState(agentRoot)).toMatchObject({
      runtimeState: {
        activeOperationId: "op-cursor",
        latestRunId: receipt.runId,
        latestReceiptLocator: receipt.receiptLocator,
      },
    })

    fs.writeFileSync(runtimeStatePath, JSON.stringify({
      schemaVersion: 1,
      name: "heartbeat",
      lastRun: receipt.endedAt,
      updatedAt: receipt.endedAt,
      activeOperationId: 42,
      latestRunId: receipt.runId,
      latestReceiptLocator: receipt.receiptLocator,
    }), "utf-8")

    expect(readLatestHabitSessionState(agentRoot)).toMatchObject({
      receipt: { runId: "run-cursor" },
      runtimeState: null,
    })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.habit_runtime_state_malformed",
    }))
  })

  it("keeps the receipt when runtime state recording fails after write", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }
    const stateDir = path.join(agentRoot, "state", "habits")
    fs.mkdirSync(path.dirname(stateDir), { recursive: true })
    fs.writeFileSync(stateDir, "not a directory", "utf-8")

    const result = completeHabitRun({
      agentRoot,
      habit: makeHabit({ name: "heartbeat", cadence: null }),
      runId: "run-partial",
      trigger: "poke",
      startedAt: "2026-06-11T14:00:00.000Z",
      endedAt: "2026-06-11T14:01:00.000Z",
      operationId: "op-partial",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    })

    expect(result).toMatchObject({
      outcome: "no_change",
      receiptWritten: true,
      runtimeStateRecorded: false,
    })
    expect(readHabitRunReceipt(agentRoot, "run-partial")).toMatchObject({
      operationId: "op-partial",
      receiptLocator: "arc/flight-recorder/habit-receipts/run-partial.json",
    })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "senses.habit_runtime_state_record_error",
    }))
  })

  it("does not advance runtime state when receipt writing fails", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }

    const result = completeHabitRun({
      agentRoot,
      habit: makeHabit({ name: "heartbeat", cadence: null }),
      runId: "../bad-run",
      trigger: "poke",
      startedAt: "2026-06-11T14:10:00.000Z",
      endedAt: "2026-06-11T14:11:00.000Z",
      operationId: "op-bad-run",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    })

    expect(result).toMatchObject({
      outcome: "no_change",
      receiptWritten: false,
      runtimeStateRecorded: false,
    })
    expect(fs.existsSync(path.join(agentRoot, "state", "habits", "heartbeat.json"))).toBe(false)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.habit_receipt_write_error",
    }))
  })

  it("classifies completion outcomes across refs, attempts, and errors", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }
    const base = {
      agentRoot,
      habit: makeHabit({ name: "heartbeat", cadence: null }),
      trigger: "poke" as const,
      startedAt: "2026-06-11T15:00:00.000Z",
      endedAt: "2026-06-11T15:01:00.000Z",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    }

    expect(completeHabitRun({ ...base, runId: "run-error", errors: ["boom"] }).outcome).toBe("error")
    expect(completeHabitRun({
      ...base,
      runId: "run-surfaced-from-attempt",
      surfaceAttempts: [{ recipient: "ari", channel: "cli", reason: "status", result: "queued" }],
    }).outcome).toBe("surfaced")
    expect(readHabitRunReceipt(agentRoot, "run-surfaced-from-attempt")?.producedRefs)
      .toEqual([{ kind: "surface", locator: "surface/ari/cli" }])
    expect(completeHabitRun({ ...base, runId: "run-record", producedRefs: [{ kind: "desk_record", locator: "desk/record" }] }).outcome)
      .toBe("wrote_record")
    expect(completeHabitRun({ ...base, runId: "run-arc", producedRefs: [{ kind: "arc", locator: "arc/claim" }] }).outcome)
      .toBe("wrote_arc")
    expect(completeHabitRun({ ...base, runId: "run-claim", producedRefs: [{ kind: "claim", locator: "arc/claim-2" }] }).outcome)
      .toBe("wrote_arc")
    expect(completeHabitRun({
      ...base,
      runId: "run-blocked",
      surfaceAttempts: [
        { recipient: "ari", channel: "cli", reason: "blocked", result: "blocked" },
        { recipient: "ari", channel: "cli", reason: "blocked", result: "failed" },
        { recipient: "ari", channel: "cli", reason: "blocked", result: "unavailable" },
      ],
    }).outcome).toBe("blocked")
  })

  it("returns null for no receipts and skips malformed receipts when runtime state is missing", async () => {
    expect(readLatestHabitSessionState(agentRoot)).toBeNull()

    const receiptDir = path.join(agentRoot, "arc", "flight-recorder", "habit-receipts")
    fs.mkdirSync(receiptDir, { recursive: true })
    fs.writeFileSync(path.join(receiptDir, "run-malformed-late.json"), "{\"schemaVersion\":2}", "utf-8")

    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }
    const good = buildHabitRunReceipt({
      agentRoot,
      habit: makeHabit({ name: "heartbeat" }),
      runId: "run-good",
      trigger: "poke",
      startedAt: "2026-06-11T09:00:00.000Z",
      endedAt: "2026-06-11T09:01:00.000Z",
      outcome: "no_change",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    })
    writeHabitRunReceipt(agentRoot, good)

    expect(readLatestHabitSessionState(agentRoot)).toMatchObject({
      receipt: { runId: "run-good", trigger: "poke" },
      runtimeState: null,
    })
  })

  it("keeps recovery available when runtime state exists but is malformed", async () => {
    const envelope = await normalizeHabitPermissionEnvelope(makeHabit(), { agentRoot })
    const policy = {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    }
    const receipt = buildHabitRunReceipt({
      agentRoot,
      habit: makeHabit({ name: "heartbeat" }),
      runId: "run-bad-runtime",
      trigger: "launchd",
      startedAt: "2026-06-11T08:00:00.000Z",
      endedAt: "2026-06-11T08:01:00.000Z",
      outcome: "no_change",
      permissionEnvelope: envelope,
      toolPolicy: policy,
    })
    writeHabitRunReceipt(agentRoot, receipt)
    const runtimeStatePath = path.join(agentRoot, "state", "habits", "heartbeat.json")
    fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true })
    fs.writeFileSync(runtimeStatePath, JSON.stringify([]), "utf-8")

    expect(readLatestHabitSessionState(agentRoot)).toMatchObject({
      receipt: { runId: "run-bad-runtime", trigger: "launchd" },
      runtimeState: null,
    })
    expect(readLatestHabitSessionState(agentRoot, { habitName: "other-habit" })).toBeNull()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.habit_runtime_state_malformed",
    }))
  })
})
