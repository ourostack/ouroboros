import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  readAttentionView,
  readBridgeInventory,
  readCodingDeep,
  readDaemonHealthDeep,
  readDeskPrefs,
  readFriendView,
  readHabitView,
  readLogView,
  readNotesView,
  readNeedsMeView,
} from "../../../heart/outlook/readers/runtime-readers"
import {
  readChangesView,
  readNoteDecisionView,
  readObligationDetailView,
  readOrientationView,
  readSelfFixView,
} from "../../../heart/outlook/readers/continuity-readers"

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function writeTask(
  tasksRoot: string,
  collection: "one-shots" | "ongoing",
  stem: string,
  frontmatter: Record<string, unknown>,
  body = "Task body.",
): void {
  fs.mkdirSync(path.join(tasksRoot, collection), { recursive: true })
  const lines = ["---"]
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`)
        continue
      }
      lines.push(`${key}:`)
      for (const item of value) {
        lines.push(`- ${String(item)}`)
      }
      continue
    }

    lines.push(`${key}: ${String(value)}`)
  }
  lines.push("---", "", body, "")
  fs.writeFileSync(path.join(tasksRoot, collection, `${stem}.md`), lines.join("\n"), "utf-8")
}

function writeAgentConfig(agentRoot: string, overrides: Record<string, unknown> = {}): void {
  writeJson(path.join(agentRoot, "agent.json"), {
    version: 1,
    enabled: true,
    provider: "anthropic",
    senses: {
      cli: { enabled: true },
      teams: { enabled: false },
      bluebubbles: { enabled: false },
    },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
    ...overrides,
  })
}

function writeCodingState(agentRoot: string, records: unknown[]): void {
  writeJson(path.join(agentRoot, "state", "coding", "sessions.json"), {
    sequence: records.length,
    records,
  })
}

function buildCodingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const session = {
    id: "coding-001",
    runner: "codex",
    workdir: "/tmp/workdir",
    taskRef: "outlook",
    originSession: { friendId: "friend-1", channel: "cli", key: "session" },
    checkpoint: "needs human input on daemon wiring",
    artifactPath: "/tmp/coding-001.md",
    status: "waiting_input",
    stdoutTail: "needs human input on daemon wiring",
    stderrTail: "",
    pid: null,
    startedAt: "2026-03-29T11:20:00.000Z",
    lastActivityAt: "2026-03-29T11:58:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
  }

  const request = {
    runner: "codex",
    workdir: "/tmp/workdir",
    prompt: "Work the Outlook slice.",
    originSession: { friendId: "friend-1", channel: "cli", key: "session" },
    sessionId: "coding-001",
    parentAgent: "alpha",
  }

  return {
    request,
    session: {
      ...session,
      ...overrides,
    },
  }
}

function makeBundleRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "outlook-read-"))
}

describe("outlook direct reads", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reads machine and per-agent Outlook state directly from existing bundle truth", async () => {
    const bundlesRoot = makeBundleRoot()
    const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
    const betaRoot = path.join(bundlesRoot, "beta.ouro")

    writeAgentConfig(alphaRoot, {
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: false },
      },
    })
    writeAgentConfig(betaRoot)

    writeTask(path.join(alphaRoot, "tasks"), "one-shots", "2026-03-29-1100-agent-dashboard", {
      type: "one-shot",
      category: "infrastructure",
      title: "Build Outlook",
      status: "processing",
      created: "2026-03-29",
      updated: "2026-03-29",
      depends_on: [],
    })
    writeTask(path.join(alphaRoot, "tasks"), "ongoing", "2026-03-29-1115-cross-session-followup", {
      type: "ongoing",
      category: "coordination",
      title: "Watch live collaborator threads",
      status: "blocked",
      created: "2026-03-29",
      updated: "2026-03-29",
    })
    writeJson(path.join(alphaRoot, "arc", "obligations", "ob-1.json"), {
      id: "ob-1",
      origin: { friendId: "friend-1", channel: "cli", key: "session" },
      content: "Bring daemon hosting back with tests.",
      status: "investigating",
      createdAt: "2026-03-29T11:10:00.000Z",
      updatedAt: "2026-03-29T11:56:00.000Z",
      nextAction: "finish the read layer and move to daemon hosting",
    })
    writeJson(path.join(alphaRoot, "arc", "obligations", "ob-0.json"), {
      id: "ob-0",
      origin: { friendId: "friend-2", channel: "teams", key: "thread" },
      content: "Older open thread.",
      status: "pending",
      createdAt: "2026-03-29T09:10:00.000Z",
    })
    writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
      version: 1,
      messages: [],
      state: { lastFriendActivityAt: "2026-03-29T11:59:00.000Z" },
    })
    writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })
    writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "The daemon seam is the next honest move." },
        { role: "user", content: "[pending from friend-1/cli/session]: Please think through the daemon seam." },
        { role: "assistant", content: "The daemon seam should stay local-only and loopback-bound." },
      ],
    })
    writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
      lastCompletedAt: "2026-03-29T11:57:00.000Z",
    })
    writeJson(path.join(alphaRoot, "state", "pending", "self", "inner", "dialog", "000.json"), {
      from: "friend-1",
      content: "Please think through the daemon seam.",
      timestamp: Date.parse("2026-03-29T11:55:00.000Z"),
      delegatedFrom: { friendId: "friend-1", channel: "cli", key: "session" },
      obligationStatus: "pending",
      mode: "plan",
    })
    writeCodingState(alphaRoot, [buildCodingRecord()])

    writeTask(path.join(betaRoot, "tasks"), "one-shots", "2026-03-20-0900-old-task", {
      type: "one-shot",
      category: "infrastructure",
      title: "Old stale work",
      status: "paused",
      created: "2026-03-20",
      updated: "2026-03-20",
    })
    fs.mkdirSync(path.join(betaRoot, "tasks", "one-shots"), { recursive: true })
    fs.writeFileSync(path.join(betaRoot, "tasks", "one-shots", "2026-03-21-0901-bad-task.md"), "---\ntype: one-shot\nstatus: nope\n---\n", "utf-8")
    fs.writeFileSync(path.join(betaRoot, "tasks", "one-shots", "badname.md"), "---\ntype: one-shot\ncategory: infrastructure\ntitle: Bad filename\nstatus: paused\ncreated: 2026-03-21\nupdated: 2026-03-21\n---\n", "utf-8")
    writeJson(path.join(betaRoot, "state", "sessions", "friend-2", "cli", "session.json"), {
      version: 1,
      messages: [],
      state: { lastFriendActivityAt: "2026-03-21T10:00:00.000Z" },
    })
    writeJson(path.join(betaRoot, "friends", "friend-2.json"), { name: "Sam" })
    writeJson(path.join(betaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(betaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
      lastCompletedAt: "2026-03-21T10:00:00.000Z",
    })
    fs.mkdirSync(path.join(betaRoot, "state", "coding"), { recursive: true })
    fs.writeFileSync(path.join(betaRoot, "state", "coding", "sessions.json"), "{not-json", "utf-8")

    const { readOutlookMachineState, readOutlookAgentState } = await import("../../../heart/outlook/outlook-read")

    const machine = readOutlookMachineState({
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
      runtimeMetadata: {
        version: "0.1.0-test",
        lastUpdated: "2026-03-29T11:30:00.000Z",
        repoRoot: "/tmp/repo",
        configFingerprint: "cfg-test",
      },
    })

    expect(machine.productName).toBe("Ouro Mailbox")
    expect(machine.agentCount).toBe(2)
    expect(machine.degraded.status).toBe("degraded")
    expect(machine.agents.map((agent) => agent.agentName)).toEqual(["alpha", "beta"])
    expect(machine.agents[0]).toMatchObject({
      agentName: "alpha",
      freshness: { status: "fresh" },
      tasks: { liveCount: 2, blockedCount: 1 },
      obligations: { openCount: 2 },
      coding: { activeCount: 1, blockedCount: 1 },
    })
    expect(machine.agents[1]).toMatchObject({
      agentName: "beta",
      freshness: { status: "stale" },
      degraded: { status: "degraded" },
    })

    const alpha = readOutlookAgentState("alpha", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })

    expect(alpha.agentName).toBe("alpha")
    expect(alpha.senses).toEqual(["cli", "teams"])
    expect(alpha.tasks.liveTaskNames).toEqual([
      "agent-dashboard",
      "cross-session-followup",
    ])
    expect(alpha.obligations.items.map((item) => item.id)).toEqual(["ob-1", "ob-0"])
    expect(alpha.sessions.liveCount).toBe(1)
    expect(alpha.sessions.items[0]).toMatchObject({
      friendId: "friend-1",
      friendName: "Ari",
      channel: "cli",
    })
    expect(alpha.inner).toMatchObject({
      visibility: "summary",
      status: "queued",
      hasPending: true,
      surfacedSummary: null,
    })
    expect(alpha.coding.items[0]).toMatchObject({
      id: "coding-001",
      status: "waiting_input",
    })
  })

  it("re-reads request-time truth instead of holding hidden dashboard state", async () => {
    const bundlesRoot = makeBundleRoot()
    const alphaRoot = path.join(bundlesRoot, "alpha.ouro")

    writeAgentConfig(alphaRoot)
    writeTask(path.join(alphaRoot, "tasks"), "one-shots", "2026-03-29-1100-agent-dashboard", {
      type: "one-shot",
      category: "infrastructure",
      title: "Build Outlook",
      status: "processing",
      created: "2026-03-29",
      updated: "2026-03-29",
    })
    writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })

    const { readOutlookAgentState } = await import("../../../heart/outlook/outlook-read")

    const first = readOutlookAgentState("alpha", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })
    expect(first.tasks.liveCount).toBe(1)

    writeTask(path.join(alphaRoot, "tasks"), "one-shots", "2026-03-29-1100-agent-dashboard", {
      type: "one-shot",
      category: "infrastructure",
      title: "Build Outlook",
      status: "done",
      created: "2026-03-29",
      updated: "2026-03-29",
    }, "Task body is now complete.")

    const second = readOutlookAgentState("alpha", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })
    expect(second.tasks.liveCount).toBe(0)
    expect(second.tasks.byStatus.done).toBe(1)
  })

  it("handles sparse or malformed direct-read inputs without inventing state", async () => {
    const bundlesRoot = makeBundleRoot()
    const gammaRoot = path.join(bundlesRoot, "gamma.ouro")
    const deltaRoot = path.join(bundlesRoot, "delta.ouro")
    const epsilonRoot = path.join(bundlesRoot, "epsilon.ouro")
    const zetaRoot = path.join(bundlesRoot, "zeta.ouro")
    const thetaRoot = path.join(bundlesRoot, "theta.ouro")

    fs.mkdirSync(gammaRoot, { recursive: true })
    fs.writeFileSync(path.join(gammaRoot, "agent.json"), "{not-json", "utf-8")
    writeJson(path.join(gammaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up.\n\nwhat needs my attention?" },
        { role: "assistant", content: "Nothing is on fire, but there is no fresh outer activity." },
      ],
    })
    writeJson(path.join(gammaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })
    writeCodingState(gammaRoot, [
      { session: { runner: "codex" } },
      buildCodingRecord({
        id: "coding-002",
        checkpoint: null,
        originSession: { friendId: 42 },
        taskRef: null,
        stdoutTail: "stdout fallback checkpoint",
        stderrTail: "",
        lastActivityAt: "2026-03-29T09:00:00.000Z",
      }),
      buildCodingRecord({
        id: "coding-003",
        checkpoint: null,
        originSession: { friendId: 42 },
        taskRef: null,
        stdoutTail: "",
        stderrTail: "stderr fallback checkpoint",
        lastActivityAt: "2026-03-29T09:05:00.000Z",
      }),
      buildCodingRecord({
        id: "coding-004",
        checkpoint: null,
        originSession: { friendId: 42 },
        taskRef: null,
        stdoutTail: "",
        stderrTail: "",
        lastActivityAt: "2026-03-29T09:10:00.000Z",
      }),
    ])
    writeAgentConfig(deltaRoot)
    writeJson(path.join(deltaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(deltaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })
    writeAgentConfig(epsilonRoot)
    writeJson(path.join(epsilonRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(epsilonRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })
    writeJson(path.join(epsilonRoot, "state", "coding", "sessions.json"), {
      sequence: 1,
      records: { bad: true },
    })
    writeAgentConfig(zetaRoot)
    writeJson(path.join(zetaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "[pending from friend-7/cli/session]: Please think about the daemon seam." },
        { role: "assistant", content: "The daemon seam should stay loopback-only." },
      ],
    })
    writeJson(path.join(zetaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })
    writeJson(path.join(thetaRoot, "agent.json"), {
      version: 1,
      provider: 42,
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    })
    writeJson(path.join(thetaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(thetaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })

    const { readOutlookAgentState, readOutlookMachineState } = await import("../../../heart/outlook/outlook-read")

    const gamma = readOutlookAgentState("gamma", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })

    expect(gamma.enabled).toBe(false)
    expect(gamma.degraded.status).toBe("degraded")
    expect(gamma.degraded.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "agent-config-unreadable" }),
      ]),
    )
    expect(gamma.freshness.status).toBe("fresh")
    expect(gamma.inner).toMatchObject({
      status: "idle",
      hasPending: false,
      surfacedSummary: null,
    })
    expect(gamma.coding.items).toHaveLength(3)
    expect(gamma.coding.items[0]).toMatchObject({
      id: "coding-002",
      checkpoint: "stdout fallback checkpoint",
      originSession: null,
      taskRef: null,
    })
    expect(gamma.coding.items[1]).toMatchObject({
      id: "coding-003",
      checkpoint: "stderr fallback checkpoint",
      originSession: null,
    })
    expect(gamma.coding.items[2]).toMatchObject({
      id: "coding-004",
      checkpoint: null,
      originSession: null,
    })

    const delta = readOutlookAgentState("delta", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })

    expect(delta.freshness.status).toBe("unknown")
    expect(delta.degraded.status).toBe("ok")

    const machine = readOutlookMachineState({
      bundlesRoot,
      agentNames: ["delta"],
      now: () => new Date("2026-03-29T12:00:00.000Z"),
      runtimeMetadata: {
        version: "0.1.0-test",
        lastUpdated: "2026-03-29T11:30:00.000Z",
        repoRoot: "/tmp/repo",
        configFingerprint: "cfg-test",
      },
    })

    expect(machine.agentCount).toBe(1)
    expect(machine.freshness.status).toBe("unknown")
    expect(machine.degraded.status).toBe("ok")

    const epsilon = readOutlookAgentState("epsilon", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })
    expect(epsilon.coding.items).toEqual([])

    const zeta = readOutlookAgentState("zeta", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })
    expect(zeta.inner).toMatchObject({
      status: "surfaced",
      surfacedSummary: "\"The daemon seam should stay loopback-only.\"",
    })

    const theta = readOutlookAgentState("theta", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })
    expect(theta.enabled).toBe(true)
    expect(theta.provider).toBeNull()
    expect(theta.senses).toEqual([])
  })

  it("records non-Error coding read failures truthfully", async () => {
    const bundlesRoot = makeBundleRoot()
    const etaRoot = path.join(bundlesRoot, "eta.ouro")
    const iotaRoot = path.join(bundlesRoot, "iota.ouro")
    writeAgentConfig(etaRoot)
    writeJson(path.join(etaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(etaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })
    writeJson(path.join(etaRoot, "state", "coding", "sessions.json"), {
      sequence: 1,
      records: [],
    })
    writeAgentConfig(iotaRoot)
    writeJson(path.join(iotaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(iotaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })

    vi.resetModules()
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        readFileSync: ((filePath: fs.PathOrFileDescriptor, encoding?: unknown) => {
          if (typeof filePath === "string" && filePath.endsWith(path.join("eta.ouro", "state", "coding", "sessions.json"))) {
            throw "boom-string"
          }
          if (typeof filePath === "string" && filePath.endsWith(path.join("iota.ouro", "agent.json"))) {
            throw "config-string"
          }
          return actual.readFileSync(filePath, encoding as BufferEncoding)
        }) as typeof fs.readFileSync,
      }
    })
    const { readOutlookAgentState } = await import("../../../heart/outlook/outlook-read")
    const eta = readOutlookAgentState("eta", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })

    expect(eta.degraded.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "coding-state-unreadable",
          detail: expect.stringContaining("boom-string"),
        }),
      ]),
    )

    const iota = readOutlookAgentState("iota", {
      bundlesRoot,
      now: () => new Date("2026-03-29T12:00:00.000Z"),
    })
    expect(iota.degraded.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "agent-config-unreadable",
          detail: expect.stringContaining("config-string"),
        }),
      ]),
    )
    vi.doUnmock("fs")
  })

  it("uses default discovery and runtime dependencies when options are omitted", async () => {
    const bundlesRoot = makeBundleRoot()
    const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
    writeAgentConfig(alphaRoot)
    writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
      version: 1,
      messages: [],
    })
    writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "runtime.json"), {
      status: "idle",
    })

    vi.resetModules()

    const getAgentBundlesRootMock = vi.fn(() => bundlesRoot)
    const getRuntimeMetadataMock = vi.fn(() => ({
      version: "0.1.0-test",
      lastUpdated: "2026-03-29T11:30:00.000Z",
      repoRoot: "/tmp/repo",
      configFingerprint: "cfg-test",
    }))
    const listEnabledBundleAgentsMock = vi.fn(() => ["alpha"])

    vi.doMock("../../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
      return {
        ...actual,
        getAgentBundlesRoot: getAgentBundlesRootMock,
      }
    })
    vi.doMock("../../../heart/daemon/runtime-metadata", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/daemon/runtime-metadata")>("../../../heart/daemon/runtime-metadata")
      return {
        ...actual,
        getRuntimeMetadata: getRuntimeMetadataMock,
      }
    })
    vi.doMock("../../../heart/daemon/agent-discovery", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/daemon/agent-discovery")>("../../../heart/daemon/agent-discovery")
      return {
        ...actual,
        listEnabledBundleAgents: listEnabledBundleAgentsMock,
      }
    })

    const { readOutlookAgentState, readOutlookMachineState } = await import("../../../heart/outlook/outlook-read")

    const agent = readOutlookAgentState("alpha")
    const machine = readOutlookMachineState()

    expect(agent.agentRoot).toBe(path.join(bundlesRoot, "alpha.ouro"))
    expect(machine.runtime.version).toBe("0.1.0-test")
    expect(getAgentBundlesRootMock).toHaveBeenCalled()
    expect(getRuntimeMetadataMock).toHaveBeenCalledWith({ bundlesRoot })
    expect(listEnabledBundleAgentsMock).toHaveBeenCalledWith({ bundlesRoot })

    vi.doUnmock("../../../heart/identity")
    vi.doUnmock("../../../heart/daemon/runtime-metadata")
    vi.doUnmock("../../../heart/daemon/agent-discovery")
  })
})

// ---------------------------------------------------------------------------
// Deep reader tests
// ---------------------------------------------------------------------------

describe("outlook deep readers", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("readSessionInventory", () => {
    it("enumerates all sessions with message counts, usage, excerpts, and tool call names", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")

      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })
      writeJson(path.join(alphaRoot, "friends", "friend-2.json"), { name: "Sam" })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [
          { role: "system", content: "You are a helpful agent." },
          { role: "user", content: "Hello, what can you do?" },
          { role: "assistant", content: null, tool_calls: [{ id: "tc-1", type: "function", function: { name: "list_tasks", arguments: "{}" } }] },
          { role: "tool", content: "No active tasks.", tool_call_id: "tc-1" },
          { role: "assistant", content: "I have no active tasks right now." },
        ],
        lastUsage: { input_tokens: 500, output_tokens: 120, reasoning_tokens: 10, total_tokens: 630 },
        state: { lastFriendActivityAt: "2026-03-30T10:00:00.000Z", mustResolveBeforeHandoff: true },
      })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-2", "teams", "thread.json"), {
        version: 1,
        messages: [
          { role: "user", content: "Quick question about the deploy." },
          { role: "assistant", content: "Sure, what's up?" },
        ],
        state: { lastFriendActivityAt: "2026-03-29T08:00:00.000Z" },
      })
      // Inner session should be excluded
      writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "dialog.json"), {
        version: 1,
        messages: [{ role: "system", content: "inner" }],
      })

      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inventory = readSessionInventory("alpha", {
        bundlesRoot,
        now: () => new Date("2026-03-30T12:00:00.000Z"),
      })

      expect(inventory.totalCount).toBe(2)
      expect(inventory.activeCount).toBe(1) // friend-1 is within 24h
      expect(inventory.staleCount).toBe(1)  // friend-2 is beyond 24h

      // Sorted by lastActivityAt descending
      expect(inventory.items[0]!.friendName).toBe("Ari")
      expect(inventory.items[0]!.messageCount).toBe(5)
      expect(inventory.items[0]!.lastUsage).toEqual({
        input_tokens: 500, output_tokens: 120, reasoning_tokens: 10, total_tokens: 630,
      })
      expect(inventory.items[0]!.continuity).toEqual({
        mustResolveBeforeHandoff: true,
        lastFriendActivityAt: "2026-03-30T10:00:00.000Z",
      })
      expect(inventory.items[0]!.latestUserExcerpt).toBe("Hello, what can you do?")
      expect(inventory.items[0]!.latestAssistantExcerpt).toBe("I have no active tasks right now.")
      expect(inventory.items[0]!.latestToolCallNames).toEqual(["list_tasks"])
      expect(inventory.items[0]!.estimatedTokens).toBeGreaterThan(0)

      expect(inventory.items[1]!.friendName).toBe("Sam")
      expect(inventory.items[1]!.messageCount).toBe(2)
      expect(inventory.items[1]!.lastUsage).toBeNull()
    })

    it("handles empty sessions directory gracefully", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)

      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inventory = readSessionInventory("alpha", { bundlesRoot })

      expect(inventory.totalCount).toBe(0)
      expect(inventory.items).toEqual([])
    })

    it("derives needs-reply state when last message is from user", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [
          { role: "assistant", content: "Hello." },
          { role: "user", content: "What are you working on?" },
        ],
        state: { lastFriendActivityAt: "2026-03-30T10:00:00.000Z" },
      })
      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inv = readSessionInventory("alpha", { bundlesRoot })
      expect(inv.items[0]!.replyState).toBe("needs-reply")
    })

    it("derives on-hold state when mustResolveBeforeHandoff is set", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
        state: { lastFriendActivityAt: "2026-03-30T10:00:00.000Z", mustResolveBeforeHandoff: true },
      })
      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inv = readSessionInventory("alpha", { bundlesRoot })
      expect(inv.items[0]!.replyState).toBe("on-hold")
    })

    it("returns idle state for empty sessions", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [],
      })
      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inv = readSessionInventory("alpha", { bundlesRoot })
      expect(inv.items[0]!.replyState).toBe("idle")
    })

    it("handles sessions with no usage and no continuity", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [{ role: "user", content: "test" }],
      })
      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inv = readSessionInventory("alpha", { bundlesRoot })
      expect(inv.items[0]!.lastUsage).toBeNull()
      expect(inv.items[0]!.continuity).toBeNull()
      expect(inv.items[0]!.replyState).toBe("needs-reply")
    })

    it("handles obligations without origin or currentSurface", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "dialog.json"), { version: 1, messages: [] })
      writeJson(path.join(alphaRoot, "state", "sessions", "self", "inner", "runtime.json"), { status: "idle" })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-no-origin.json"), {
        id: "ob-no-origin",
        content: "test obligation",
        status: "pending",
        createdAt: "2026-03-30T10:00:00.000Z",
      })
      const { readOutlookAgentState } = await import("../../../heart/outlook/outlook-read")
      const state = readOutlookAgentState("alpha", { bundlesRoot, now: () => new Date("2026-03-30T12:00:00.000Z") })
      expect(state.obligations.items[0]!.origin).toBeNull()
      expect(state.obligations.items[0]!.currentSurface).toBeNull()
    })

    it("handles malformed session files without crashing", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      fs.mkdirSync(path.join(alphaRoot, "state", "sessions", "friend-1", "cli"), { recursive: true })
      fs.writeFileSync(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), "{bad-json", "utf-8")

      const { readSessionInventory } = await import("../../../heart/outlook/outlook-read")
      const inventory = readSessionInventory("alpha", { bundlesRoot })

      expect(inventory.totalCount).toBe(1)
      expect(inventory.items[0]!.messageCount).toBe(0)
      expect(inventory.items[0]!.lastUsage).toBeNull()
    })
  })

  describe("readSessionTranscript", () => {
    it("returns full transcript with tool calls and tool results", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [
          { role: "system", content: "You are a helpful agent." },
          { role: "user", content: "Run the tests." },
          { role: "assistant", content: null, tool_calls: [
            { id: "tc-1", type: "function", function: { name: "run_tests", arguments: '{"suite":"unit"}' } },
          ] },
          { role: "tool", content: "All 42 tests passed.", tool_call_id: "tc-1" },
          { role: "assistant", content: "All tests pass." },
        ],
        lastUsage: { input_tokens: 200, output_tokens: 50, reasoning_tokens: 0, total_tokens: 250 },
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: "2026-03-30T10:00:00.000Z" },
      })

      const { readSessionTranscript } = await import("../../../heart/outlook/outlook-read")
      const transcript = readSessionTranscript("alpha", "friend-1", "cli", "session", { bundlesRoot })

      expect(transcript).not.toBeNull()
      expect(transcript!.friendName).toBe("Ari")
      expect(transcript!.messageCount).toBe(5)
      expect(transcript!.messages[0]).toMatchObject({
        id: "evt-000001",
        sequence: 1,
        role: "system",
        content: "You are a helpful agent.",
      })
      expect(transcript!.messages[2]).toMatchObject({
        id: "evt-000003",
        sequence: 3,
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc-1", type: "function", function: { name: "run_tests", arguments: '{"suite":"unit"}' } }],
      })
      expect(transcript!.messages[3]).toMatchObject({
        id: "evt-000004",
        sequence: 4,
        role: "tool",
        content: "All 42 tests passed.",
        toolCallId: "tc-1",
      })
      expect(transcript!.lastUsage!.total_tokens).toBe(250)
      expect(transcript!.continuity!.mustResolveBeforeHandoff).toBe(false)
    })

    it("surfaces visible per-message timing from canonical session events", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 2,
        events: [
          {
            id: "evt-000001",
            sequence: 1,
            role: "user",
            content: "hello",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: null,
              authoredAtSource: "unknown",
              observedAt: "2026-04-09T17:40:00.000Z",
              observedAtSource: "ingest",
              recordedAt: "2026-04-09T17:40:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
        ],
        projection: {
          eventIds: ["evt-000001"],
          trimmed: false,
          maxTokens: 80000,
          contextMargin: 20,
          inputTokens: null,
          projectedAt: "2026-04-09T17:40:00.000Z",
        },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: "2026-04-09T17:40:00.000Z" },
      })

      const { readSessionTranscript } = await import("../../../heart/outlook/outlook-read")
      const transcript = readSessionTranscript("alpha", "friend-1", "cli", "session", { bundlesRoot })

      expect(transcript).not.toBeNull()
      expect(transcript!.messages[0]).toMatchObject({
        id: "evt-000001",
        time: {
          observedAt: "2026-04-09T17:40:00.000Z",
          recordedAt: "2026-04-09T17:40:00.000Z",
        },
      })
    })

    it("returns null for nonexistent sessions", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)

      const { readSessionTranscript } = await import("../../../heart/outlook/outlook-read")
      const transcript = readSessionTranscript("alpha", "nobody", "cli", "session", { bundlesRoot })
      expect(transcript).toBeNull()
    })
  })

  describe("readCodingDeep", () => {
    it("exposes full coding session diagnostics including failure details", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeCodingState(alphaRoot, [
        buildCodingRecord({
          id: "c-001",
          status: "failed",
          obligationId: "ob-1",
          scopeFile: "/tmp/scope.md",
          stateFile: "/tmp/state.json",
          artifactPath: "/tmp/artifact.md",
          failure: {
            command: "npm",
            args: ["test"],
            code: 1,
            signal: null,
            stdoutTail: "test output",
            stderrTail: "ERR: test failed",
          },
        }),
        buildCodingRecord({
          id: "c-002",
          status: "running",
        }),
      ])

      const deep = readCodingDeep(alphaRoot)

      expect(deep.totalCount).toBe(2)
      expect(deep.activeCount).toBe(1) // running
      expect(deep.blockedCount).toBe(0)

      const failed = deep.items.find((i) => i.id === "c-001")!
      expect(failed.failure).toEqual({
        command: "npm",
        args: ["test"],
        code: 1,
        signal: null,
        stdoutTail: "test output",
        stderrTail: "ERR: test failed",
      })
      expect(failed.obligationId).toBe("ob-1")
      expect(failed.scopeFile).toBe("/tmp/scope.md")
    })

    it("handles missing coding state file", async () => {
      const deep = readCodingDeep("/tmp/nonexistent-agent.ouro")
      expect(deep.totalCount).toBe(0)
      expect(deep.items).toEqual([])
    })
  })

  describe("readAttentionView", () => {
    it("scans pending channels non-destructively and builds attention queue", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })

      // Write pending messages
      writeJson(path.join(alphaRoot, "state", "pending", "friend-1", "cli", "session", "1000-abc.json"), {
        from: "friend-1",
        content: "Can you check the deploy?",
        timestamp: 1000,
        delegatedFrom: { friendId: "friend-1", channel: "cli", key: "session", bridgeId: "bridge-1" },
        obligationId: "ob-1",
      })
      writeJson(path.join(alphaRoot, "state", "pending", "friend-1", "cli", "session", "2000-def.json"), {
        from: "friend-1",
        content: "Also check the logs.",
        timestamp: 2000,
      })

      // Write obligation for return obligations
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-1.json"), {
        id: "ob-1",
        origin: { friendId: "friend-1", channel: "cli", key: "session" },
        content: "Deploy check requested.",
        status: "investigating",
        createdAt: "2026-03-30T10:00:00.000Z",
        updatedAt: "2026-03-30T10:30:00.000Z",
        nextAction: "check deploy status",
      })

      const attention = readAttentionView("alpha", { bundlesRoot })

      expect(attention.queueLength).toBe(2)
      expect(attention.queueItems[0]!.timestamp).toBe(1000) // FIFO
      expect(attention.queueItems[0]!.friendName).toBe("Ari")
      expect(attention.queueItems[0]!.bridgeId).toBe("bridge-1")
      expect(attention.queueItems[0]!.obligationId).toBe("ob-1")
      expect(attention.queueItems[1]!.delegatedContent).toBe("Also check the logs.")
      expect(attention.pendingChannels).toHaveLength(1)
      expect(attention.pendingChannels[0]!.messageCount).toBe(2)
      expect(attention.returnObligations).toHaveLength(1)
    })

    it("uses default bundle discovery, ignores pending tree junk, and normalizes sparse messages", async () => {
      const originalHome = process.env.HOME
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "attention-home-"))
      try {
        process.env.HOME = tempHome
        const agentRoot = path.join(tempHome, "AgentBundles", "alpha.ouro")
        writeAgentConfig(agentRoot)
        writeJson(path.join(agentRoot, "friends", "friend-1.json"), { name: "Ari" })

        fs.mkdirSync(path.join(agentRoot, "state", "pending"), { recursive: true })
        fs.writeFileSync(path.join(agentRoot, "state", "pending", "friend-note.txt"), "ignore me\n", "utf-8")
        fs.mkdirSync(path.join(agentRoot, "state", "pending", "friend-1"), { recursive: true })
        fs.writeFileSync(path.join(agentRoot, "state", "pending", "friend-1", "ignore.txt"), "ignore me\n", "utf-8")
        fs.mkdirSync(path.join(agentRoot, "state", "pending", "friend-1", "cli"), { recursive: true })
        fs.writeFileSync(path.join(agentRoot, "state", "pending", "friend-1", "cli", "not-a-dir.txt"), "ignore me\n", "utf-8")
        fs.mkdirSync(path.join(agentRoot, "state", "pending", "friend-1", "cli", "empty"), { recursive: true })
        fs.writeFileSync(path.join(agentRoot, "state", "pending", "friend-1", "cli", "empty", "note.txt"), "ignore me\n", "utf-8")
        writeJson(path.join(agentRoot, "state", "pending", "friend-1", "cli", "session", "000.json.processing"), {
          content: false,
          timestamp: "soon",
          delegatedFrom: { bridgeId: 7 },
          obligationId: 9,
        })

        const attention = readAttentionView("alpha")

        expect(attention.pendingChannels).toEqual([{
          friendId: "friend-1",
          channel: "cli",
          key: "session",
          messageCount: 1,
        }])
        expect(attention.queueItems).toHaveLength(1)
        expect(attention.queueItems[0]).toMatchObject({
          id: expect.stringMatching(/^pending-/),
          friendId: "friend-1",
          friendName: "Ari",
          delegatedContent: "",
          bridgeId: null,
          obligationId: null,
          timestamp: 0,
        })
      } finally {
        process.env.HOME = originalHome
        fs.rmSync(tempHome, { recursive: true, force: true })
      }
    })

    it("handles empty pending state", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)

      const attention = readAttentionView("alpha", { bundlesRoot })

      expect(attention.queueLength).toBe(0)
      expect(attention.pendingChannels).toEqual([])
    })
  })

  describe("readBridgeInventory", () => {
    it("reads all bridge records with attached sessions and task links", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeJson(path.join(alphaRoot, "state", "bridges", "bridge-1.json"), {
        id: "bridge-1",
        objective: "Deploy the feature",
        summary: "Coordinated deploy between Ari and Sam",
        lifecycle: "active",
        runtime: "stable",
        createdAt: "2026-03-30T09:00:00.000Z",
        updatedAt: "2026-03-30T10:00:00.000Z",
        attachedSessions: [
          { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/path/to/session.json", snapshot: "checkpoint A" },
        ],
        task: { taskName: "deploy-feature", path: "/tasks/deploy.md", mode: "bound", boundAt: "2026-03-30T09:00:00.000Z" },
      })
      writeJson(path.join(alphaRoot, "state", "bridges", "bridge-2.json"), {
        id: "bridge-2",
        objective: "Old bridge",
        lifecycle: "completed",
        createdAt: "2026-03-28T09:00:00.000Z",
        updatedAt: "2026-03-28T10:00:00.000Z",
        attachedSessions: [],
        task: null,
      })

      const bridges = readBridgeInventory(alphaRoot)

      expect(bridges.totalCount).toBe(2)
      expect(bridges.activeCount).toBe(1)
      expect(bridges.items[0]!.id).toBe("bridge-1") // sorted by updatedAt desc
      expect(bridges.items[0]!.attachedSessions).toHaveLength(1)
      expect(bridges.items[0]!.task!.taskName).toBe("deploy-feature")
    })

    it("handles missing bridges directory", async () => {
      const bridges = readBridgeInventory("/tmp/nonexistent-agent.ouro")
      expect(bridges.totalCount).toBe(0)
    })
  })

  describe("readDaemonHealthDeep", () => {
    it("reads full daemon health state", async () => {
      const tmpDir = makeBundleRoot()
      const healthPath = path.join(tmpDir, "daemon-health.json")
      writeJson(healthPath, {
        status: "ok",
        mode: "dev",
        pid: 12345,
        startedAt: "2026-03-30T08:00:00.000Z",
        uptimeSeconds: 3600,
        safeMode: { active: false, reason: "", enteredAt: "" },
        degraded: [
          { component: "bluebubbles", reason: "connection lost", since: "2026-03-30T09:00:00.000Z" },
        ],
        agents: {
          slugger: { status: "running", pid: 12346, crashes: 0 },
        },
        habits: {
          checkup: { cronStatus: "registered", lastFired: "2026-03-30T10:00:00.000Z", fallback: false },
        },
      })

      const health = readDaemonHealthDeep(healthPath)

      expect(health).not.toBeNull()
      expect(health!.pid).toBe(12345)
      expect(health!.degradedComponents).toHaveLength(1)
      expect(health!.degradedComponents[0]!.component).toBe("bluebubbles")
      expect(health!.agentHealth.slugger).toEqual({ status: "running", pid: 12346, crashes: 0 })
      expect(health!.habitHealth.checkup.cronStatus).toBe("registered")
    })

    it("returns null for missing health file", async () => {
      const health = readDaemonHealthDeep("/tmp/nonexistent-health.json")
      expect(health).toBeNull()
    })
  })

  describe("readNotesView", () => {
    it("reads diary facts and journal index", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")

      // Write diary facts
      fs.mkdirSync(path.join(agentRoot, "diary"), { recursive: true })
      const facts = [
        { id: "f1", text: "User prefers concise answers.", source: "session", createdAt: "2026-03-30T10:00:00.000Z", embedding: [] },
        { id: "f2", text: "Deploy pipeline uses GitHub Actions.", source: "observation", createdAt: "2026-03-29T10:00:00.000Z", embedding: [] },
      ]
      fs.writeFileSync(path.join(agentRoot, "diary", "facts.jsonl"), facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf-8")

      // Write journal index
      fs.mkdirSync(path.join(agentRoot, "journal"), { recursive: true })
      writeJson(path.join(agentRoot, "journal", ".index.json"), [
        { filename: "2026-03-30.md", preview: "Today I worked on Outlook", mtime: 1711800000000, embedding: [] },
        { filename: "2026-03-29.md", preview: "Daemon hosting design", mtime: 1711713600000, embedding: [] },
      ])

      const notes = readNotesView(agentRoot)

      expect(notes.diaryEntryCount).toBe(2)
      expect(notes.recentDiaryEntries[0]!.text).toBe("User prefers concise answers.")
      expect(notes.journalEntryCount).toBe(2)
      expect(notes.recentJournalEntries[0]!.filename).toBe("2026-03-30.md")
    })

    it("handles missing diary and journal directories", async () => {
      const notes = readNotesView("/tmp/nonexistent-agent.ouro")
      expect(notes.diaryEntryCount).toBe(0)
      expect(notes.journalEntryCount).toBe(0)
    })

    it("does NOT read from legacy psyche/notes path -- only diary/", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")

      fs.mkdirSync(path.join(agentRoot, "psyche", "notes"), { recursive: true })
      const facts = [{ id: "f1", text: "Legacy fact.", source: "legacy", createdAt: "2026-03-28T10:00:00.000Z", embedding: [] }]
      fs.writeFileSync(path.join(agentRoot, "psyche", "notes", "facts.jsonl"), facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf-8")

      const notes = readNotesView(agentRoot)

      // Should NOT find entries in psyche/notes since we no longer fall back
      expect(notes.diaryEntryCount).toBe(0)
    })

    it("skips malformed diary entries and normalizes optional fields", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")

      fs.mkdirSync(path.join(agentRoot, "diary"), { recursive: true })
      fs.writeFileSync(path.join(agentRoot, "diary", "facts.jsonl"), [
        JSON.stringify({ id: "f1", text: "Valid but sparse", source: 7, createdAt: false }),
        JSON.stringify({ id: "f2", text: "Fully valid", source: "session", createdAt: "2026-03-30T10:00:00.000Z" }),
        JSON.stringify({ id: 3, text: "Skip me" }),
      ].join("\n") + "\n", "utf-8")

      fs.mkdirSync(path.join(agentRoot, "journal"), { recursive: true })
      writeJson(path.join(agentRoot, "journal", ".index.json"), [
        { filename: "2026-03-30.md", preview: 7, mtime: "later" },
        { preview: "skip me", mtime: 1 },
      ])

      const notes = readNotesView(agentRoot)

      expect(notes.diaryEntryCount).toBe(2)
      expect(notes.recentDiaryEntries.find((entry) => entry.id === "f1")).toEqual({
        id: "f1",
        text: "Valid but sparse",
        source: "",
        createdAt: "",
      })
      expect(notes.journalEntryCount).toBe(1)
      expect(notes.recentJournalEntries[0]).toEqual({
        filename: "2026-03-30.md",
        preview: "",
        mtime: 0,
      })
    })
  })

  describe("readFriendView", () => {
    it("reads friend records with token spend and session counts", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari", totalTokens: 50000 })
      writeJson(path.join(alphaRoot, "friends", "friend-2.json"), { name: "Sam" })

      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), { version: 1, messages: [] })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "teams", "thread.json"), { version: 1, messages: [] })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-2", "cli", "session.json"), { version: 1, messages: [] })

      const friends = readFriendView("alpha", { bundlesRoot })

      expect(friends.totalFriends).toBe(2)
      // Sorted by totalTokens descending
      expect(friends.friends[0]!.friendName).toBe("Ari")
      expect(friends.friends[0]!.totalTokens).toBe(50000)
      expect(friends.friends[0]!.sessionCount).toBe(2)
      expect(friends.friends[0]!.channels).toEqual(["cli", "teams"])
      expect(friends.friends[1]!.friendName).toBe("Sam")
      expect(friends.friends[1]!.totalTokens).toBe(0)
      expect(friends.friends[1]!.sessionCount).toBe(1)
    })

    it("uses default bundle discovery and skips non-json or non-directory session junk", async () => {
      const originalHome = process.env.HOME
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "friend-view-home-"))
      try {
        process.env.HOME = tempHome
        const agentRoot = path.join(tempHome, "AgentBundles", "alpha.ouro")
        writeAgentConfig(agentRoot)
        writeJson(path.join(agentRoot, "friends", "friend-1.json"), { name: "Ari", totalTokens: 50_000 })
        writeJson(path.join(agentRoot, "friends", "friend-2.json"), { name: false })
        fs.writeFileSync(path.join(agentRoot, "friends", "ignore.txt"), "ignore me\n", "utf-8")

        writeJson(path.join(agentRoot, "state", "sessions", "friend-1", "cli", "session.json"), { version: 1, messages: [] })
        fs.writeFileSync(path.join(agentRoot, "state", "sessions", "friend-1", "cli", "notes.txt"), "ignore me\n", "utf-8")
        fs.writeFileSync(path.join(agentRoot, "state", "sessions", "friend-1", "not-a-channel"), "ignore me\n", "utf-8")

        const friends = readFriendView("alpha")

        expect(friends.totalFriends).toBe(2)
        expect(friends.friends.find((friend) => friend.friendId === "friend-1")).toMatchObject({
          friendName: "Ari",
          sessionCount: 1,
          channels: ["cli"],
        })
        expect(friends.friends.find((friend) => friend.friendId === "friend-2")).toMatchObject({
          friendName: "friend-2",
          sessionCount: 0,
          channels: [],
        })
      } finally {
        process.env.HOME = originalHome
        fs.rmSync(tempHome, { recursive: true, force: true })
      }
    })

    it("keeps friend session counts when a session file mtime cannot be read", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      const sessionDir = path.join(alphaRoot, "state", "sessions", "friend-1", "cli")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })
      fs.mkdirSync(sessionDir, { recursive: true })
      fs.symlinkSync(path.join(sessionDir, "missing-target.json"), path.join(sessionDir, "broken.json"))

      const friends = readFriendView("alpha", { bundlesRoot })

      expect(friends.friends[0]).toMatchObject({
        friendId: "friend-1",
        sessionCount: 1,
        lastActivityAt: null,
      })
    })
  })

  describe("readLogView", () => {
    it("reads recent NDJSON log entries", async () => {
      const tmpDir = makeBundleRoot()
      const logPath = path.join(tmpDir, "nerves.ndjson")
      const entries = [
        { ts: "2026-03-30T09:00:00.000Z", level: "info", event: "daemon.started", component: "daemon", message: "Daemon started", trace_id: "t1", meta: {} },
        { ts: "2026-03-30T09:01:00.000Z", level: "warn", event: "sense.degraded", component: "bluebubbles", message: "Connection lost", trace_id: "t2", meta: { reason: "timeout" } },
      ]
      fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8")

      const logs = readLogView(logPath)

      expect(logs.totalLines).toBe(2)
      expect(logs.entries).toHaveLength(2)
      expect(logs.entries[0]!.event).toBe("daemon.started")
      expect(logs.entries[1]!.meta).toEqual({ reason: "timeout" })
    })

    it("normalizes malformed log fields to safe defaults", async () => {
      const tmpDir = makeBundleRoot()
      const logPath = path.join(tmpDir, "nerves.ndjson")
      fs.writeFileSync(logPath, `${JSON.stringify({
        ts: 9,
        level: false,
        event: null,
        component: 7,
        message: 3,
        trace_id: 4,
        meta: "oops",
      })}\n`, "utf-8")

      const logs = readLogView(logPath)

      expect(logs.entries).toEqual([{
        ts: "",
        level: "info",
        event: "",
        component: "",
        message: "",
        trace_id: "",
        meta: {},
      }])
    })

    it("returns empty for null log path", async () => {
      const logs = readLogView(null)
      expect(logs.totalLines).toBe(0)
    })

    it("returns empty when the log path cannot be read as a file", async () => {
      const tmpDir = makeBundleRoot()
      const logs = readLogView(tmpDir)
      expect(logs).toEqual({ logPath: tmpDir, totalLines: 0, entries: [] })
    })

    it("respects limit parameter for large logs", async () => {
      const tmpDir = makeBundleRoot()
      const logPath = path.join(tmpDir, "nerves.ndjson")
      const lines: string[] = []
      for (let i = 0; i < 200; i++) {
        lines.push(JSON.stringify({ ts: `2026-03-30T09:${String(i).padStart(2, "0")}:00.000Z`, level: "info", event: `event-${i}`, component: "test", message: `msg ${i}`, trace_id: `t${i}`, meta: {} }))
      }
      fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf-8")

      const logs = readLogView(logPath, 10)

      expect(logs.totalLines).toBe(200)
      expect(logs.entries).toHaveLength(10)
      // Should be the last 10 entries
      expect(logs.entries[0]!.event).toBe("event-190")
    })
  })

  describe("readCodingDeep edge cases", () => {
    it("handles malformed coding records with missing fields", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeCodingState(alphaRoot, [
        { session: { id: "c1", status: "running", runner: 42, workdir: null, lastActivityAt: null, failure: { command: "test" } } },
        { session: { id: "c2", status: "completed", originSession: { friendId: "f", channel: 42 }, obligationId: 123, scopeFile: 456 } },
      ])
      const deep = readCodingDeep(alphaRoot)
      expect(deep.items.length).toBe(2)
      expect(deep.items[0]!.runner).toBe("claude")
      expect(deep.items[0]!.workdir).toBe("")
      expect(deep.items[0]!.failure).toBeTruthy()
      expect(deep.items[1]!.originSession).toBeNull()
      expect(deep.items[1]!.obligationId).toBeNull()
    })

    it("handles unparseable coding state", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      fs.mkdirSync(path.join(alphaRoot, "state", "coding"), { recursive: true })
      fs.writeFileSync(path.join(alphaRoot, "state", "coding", "sessions.json"), "{bad", "utf-8")
      const deep = readCodingDeep(alphaRoot)
      expect(deep.totalCount).toBe(0)
    })
  })

  describe("readBridgeInventory edge cases", () => {
    it("handles malformed bridge records", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeJson(path.join(alphaRoot, "state", "bridges", "b1.json"), { id: "b1", attachedSessions: [{ friendId: 42 }], task: { taskName: 42 } })
      writeJson(path.join(alphaRoot, "state", "bridges", "b2.json"), { noId: true })
      fs.writeFileSync(path.join(alphaRoot, "state", "bridges", "b3.json"), "{bad", "utf-8")
      const inv = readBridgeInventory(alphaRoot)
      expect(inv.totalCount).toBe(1)
      expect(inv.items[0]!.attachedSessions).toEqual([])
      expect(inv.items[0]!.task).toBeNull()
    })
  })

  describe("readDaemonHealthDeep edge cases", () => {
    it("handles minimal/sparse health data", async () => {
      const tmpDir = makeBundleRoot()
      const healthPath = path.join(tmpDir, "health.json")
      writeJson(healthPath, { status: "ok" })
      const health = readDaemonHealthDeep(healthPath)
      expect(health).not.toBeNull()
      expect(health!.degradedComponents).toEqual([])
      expect(health!.agentHealth).toEqual({})
      expect(health!.habitHealth).toEqual({})
      expect(health!.safeMode).toBeNull()
    })

    it("normalizes safe mode, degraded components, and agent habit maps", async () => {
      const tmpDir = makeBundleRoot()
      const healthPath = path.join(tmpDir, "health.json")
      writeJson(healthPath, {
        status: "degraded",
        mode: "safe",
        pid: 1234,
        startedAt: "2026-03-30T08:00:00.000Z",
        uptimeSeconds: 90,
        safeMode: {
          active: true,
          reason: 404,
          enteredAt: false,
        },
        degraded: [
          { component: "daemon", reason: "needs repair", since: "2026-03-30T09:00:00.000Z" },
          { component: 7, reason: null, since: 9 },
        ],
        agents: {
          alpha: { status: "ok", pid: 42, crashes: 0 },
          beta: { status: false, pid: "oops", crashes: "many" },
        },
        habits: {
          checkup: { cronStatus: "ok", lastFired: "2026-03-30T09:30:00.000Z", fallback: true },
          reflect: { cronStatus: 7, lastFired: 9, fallback: false },
        },
      })

      const health = readDaemonHealthDeep(healthPath)

      expect(health).not.toBeNull()
      expect(health!.safeMode).toEqual({
        active: true,
        reason: "",
        enteredAt: "",
      })
      expect(health!.degradedComponents).toEqual([
        { component: "daemon", reason: "needs repair", since: "2026-03-30T09:00:00.000Z" },
        { component: "", reason: "", since: "" },
      ])
      expect(health!.agentHealth).toEqual({
        alpha: { status: "ok", pid: 42, crashes: 0 },
        beta: { status: "unknown", pid: null, crashes: 0 },
      })
      expect(health!.habitHealth).toEqual({
        checkup: { cronStatus: "ok", lastFired: "2026-03-30T09:30:00.000Z", fallback: true },
        reflect: { cronStatus: "unknown", lastFired: null, fallback: false },
      })
    })
  })

  describe("readHabitView", () => {
    it("reads habit files with cadence, overdue detection, and status", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })

      fs.writeFileSync(path.join(agentRoot, "habits", "checkup.md"), [
        "---",
        "name: checkup",
        "title: Regular checkup",
        "cadence: 30m",
        "status: active",
        "lastRun: 2026-03-30T08:00:00.000Z",
        "---",
        "",
        "Run a health check on all active systems.",
      ].join("\n"), "utf-8")

      fs.writeFileSync(path.join(agentRoot, "habits", "reflect.md"), [
        "---",
        "name: reflect",
        "title: Daily reflection",
        "cadence: 1d",
        "status: paused",
        "---",
        "",
        "Reflect on recent activity.",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(agentRoot, "habits", "steady.md"), [
        "---",
        "name: steady",
        "title: Steady check",
        "cadence: 1d",
        "status: active",
        "lastRun: 2026-03-30T09:30:00.000Z",
        "---",
        "",
        "Stay current.",
      ].join("\n"), "utf-8")

      // Set now to 2 hours after lastRun — checkup is overdue (cadence 30m)
      const habits = readHabitView(agentRoot, {
        now: () => new Date("2026-03-30T10:00:00.000Z"),
      })

      expect(habits.totalCount).toBe(3)
      expect(habits.activeCount).toBe(2)
      expect(habits.pausedCount).toBe(1)

      const checkup = habits.items.find((h) => h.name === "checkup")!
      expect(checkup.isOverdue).toBe(true)
      expect(checkup.overdueMs).toBeGreaterThan(0)
      expect(checkup.cadence).toBe("30m")
      expect(checkup.bodyExcerpt).toContain("health check")

      const reflect = habits.items.find((h) => h.name === "reflect")!
      expect(reflect.status).toBe("paused")
      expect(reflect.isOverdue).toBe(false) // paused habits can't be overdue

      const steady = habits.items.find((h) => h.name === "steady")!
      expect(steady.status).toBe("active")
      expect(steady.isOverdue).toBe(false)
    })

    it("handles missing habits directory", async () => {
      const habits = readHabitView("/tmp/nonexistent-agent.ouro")
      expect(habits.totalCount).toBe(0)
    })

    it("sorts non-overdue habits alphabetically by name", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })

      fs.writeFileSync(path.join(agentRoot, "habits", "zeta.md"), [
        "---",
        "name: zeta",
        "title: Zeta",
        "cadence: 1d",
        "status: paused",
        "---",
        "",
        "Later.",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(agentRoot, "habits", "alpha.md"), [
        "---",
        "name: alpha",
        "title: Alpha",
        "cadence: 1d",
        "status: paused",
        "---",
        "",
        "Sooner.",
      ].join("\n"), "utf-8")

      const habits = readHabitView(agentRoot, {
        now: () => new Date("2026-03-30T10:00:00.000Z"),
      })

      expect(habits.items.map((habit) => habit.name)).toEqual(["alpha", "zeta"])
    })

    it("handles missing and invalid cadence values while reading last_run aliases", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })

      fs.writeFileSync(path.join(agentRoot, "habits", "alias.md"), [
        "---",
        "title: Alias cadence",
        "cadence: 2hr",
        "status: active",
        "last_run: 2026-03-30T08:00:00.000Z",
        "---",
        "",
        "Alias body.",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(agentRoot, "habits", "invalid.md"), [
        "---",
        "title: Invalid cadence",
        "cadence: someday",
        "status: active",
        "---",
        "",
        "Invalid body.",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(agentRoot, "habits", "missing.md"), [
        "---",
        "title: Missing cadence",
        "status: active",
        "---",
        "",
        "Missing body.",
      ].join("\n"), "utf-8")

      const habits = readHabitView(agentRoot, {
        now: () => new Date("2026-03-30T10:30:00.000Z"),
      })

      const alias = habits.items.find((habit) => habit.name === "alias")!
      expect(alias.lastRun).toBe("2026-03-30T08:00:00.000Z")
      expect(alias.isOverdue).toBe(true)

      const invalid = habits.items.find((habit) => habit.name === "invalid")!
      expect(invalid.isOverdue).toBe(false)

      const missing = habits.items.find((habit) => habit.name === "missing")!
      expect(missing.cadence).toBeNull()
      expect(missing.isOverdue).toBe(false)
    })

    it("prefers runtime habit state over legacy frontmatter lastRun", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })
      fs.mkdirSync(path.join(agentRoot, "state", "habits"), { recursive: true })

      fs.writeFileSync(path.join(agentRoot, "habits", "checkup.md"), [
        "---",
        "title: Checkup",
        "cadence: 30m",
        "status: active",
        "lastRun: 2026-03-30T08:00:00.000Z",
        "---",
        "",
        "Run the checkup.",
      ].join("\n"), "utf-8")

      fs.writeFileSync(path.join(agentRoot, "state", "habits", "checkup.json"), JSON.stringify({
        schemaVersion: 1,
        name: "checkup",
        lastRun: "2026-03-30T09:50:00.000Z",
        updatedAt: "2026-03-30T09:50:00.000Z",
      }, null, 2), "utf-8")

      const habits = readHabitView(agentRoot, {
        now: () => new Date("2026-03-30T10:00:00.000Z"),
      })

      const checkup = habits.items.find((habit) => habit.name === "checkup")!
      expect(checkup.lastRun).toBe("2026-03-30T09:50:00.000Z")
      expect(checkup.isOverdue).toBe(false)
    })

    it("skips habit markdown files without frontmatter", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })
      fs.writeFileSync(path.join(agentRoot, "habits", "ignore.txt"), "ignore me\n", "utf-8")
      fs.writeFileSync(path.join(agentRoot, "habits", "notes.md"), "Just some notes.\n", "utf-8")

      const habits = readHabitView(agentRoot)

      expect(habits.totalCount).toBe(0)
    })

    it("falls back to the filename when title is missing and keeps empty bodies null", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })

      fs.writeFileSync(path.join(agentRoot, "habits", "z-overdue.md"), [
        "---",
        "name: z-overdue",
        "cadence: 30m",
        "status: active",
        "lastRun: 2026-03-30T08:00:00.000Z",
        "---",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(agentRoot, "habits", "a-steady.md"), [
        "---",
        "name: a-steady",
        "title: A steady habit",
        "cadence: 1d",
        "status: active",
        "lastRun: 2026-03-30T11:30:00.000Z",
        "---",
        "",
        "Still steady.",
      ].join("\n"), "utf-8")

      const habits = readHabitView(agentRoot, {
        now: () => new Date("2026-03-30T12:00:00.000Z"),
      })

      expect(habits.items[0]).toMatchObject({
        name: "z-overdue",
        title: "z-overdue",
        bodyExcerpt: null,
        isOverdue: true,
      })
    })
  })

  describe("readDeskPrefs", () => {
    it("returns defaults when the prefs file is missing", async () => {
      const prefs = readDeskPrefs("/tmp/nonexistent-agent.ouro")

      expect(prefs).toEqual({
        carrying: null,
        statusLine: null,
        tabOrder: null,
        starredFriends: [],
        pinnedConstellations: [],
        dismissedObligations: [],
      })
    })

    it("reads and filters structured desk prefs", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      writeJson(path.join(agentRoot, "state", "outlook-prefs.json"), {
        carrying: "daemon restart",
        statusLine: "watching merges",
        tabOrder: ["sessions", 42, "work"],
        starredFriends: ["ari", 99],
        pinnedConstellations: [
          { label: "deploy", friendIds: ["ari", 7], taskRefs: ["deploy"], bridgeIds: ["bridge-1"], codingIds: ["coding-1"] },
        ],
        dismissedObligations: ["ob-1", false],
      })

      const prefs = readDeskPrefs(agentRoot)

      expect(prefs.carrying).toBe("daemon restart")
      expect(prefs.tabOrder).toEqual(["sessions", "work"])
      expect(prefs.starredFriends).toEqual(["ari"])
      expect(prefs.pinnedConstellations[0]).toEqual({
        label: "deploy",
        friendIds: ["ari"],
        taskRefs: ["deploy"],
        bridgeIds: ["bridge-1"],
        codingIds: ["coding-1"],
      })
      expect(prefs.dismissedObligations).toEqual(["ob-1"])
    })

    it("falls back to empty collections when parsed desk prefs use the wrong shapes", async () => {
      const tmpRoot = makeBundleRoot()
      const agentRoot = path.join(tmpRoot, "agent.ouro")
      writeJson(path.join(agentRoot, "state", "outlook-prefs.json"), {
        tabOrder: "sessions",
        starredFriends: "ari",
        pinnedConstellations: "deploy",
        dismissedObligations: { id: "ob-1" },
      })

      const prefs = readDeskPrefs(agentRoot)

      expect(prefs.tabOrder).toBeNull()
      expect(prefs.starredFriends).toEqual([])
      expect(prefs.pinnedConstellations).toEqual([])
      expect(prefs.dismissedObligations).toEqual([])
    })
  })

  describe("readNeedsMeView", () => {
    it("aggregates reply, obligation, pending, and habit work while respecting desk prefs", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "friends", "friend-1.json"), { name: "Ari" })
      writeJson(path.join(alphaRoot, "friends", "friend-2.json"), { name: "Sam" })
      writeJson(path.join(alphaRoot, "state", "outlook-prefs.json"), {
        dismissedObligations: ["ob-dismiss"],
      })
      writeJson(path.join(alphaRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [
          { role: "assistant", content: "Morning." },
          { role: "user", content: "Can you check the deploy lane for me?" },
        ],
        state: { lastFriendActivityAt: "2026-03-30T10:00:00.000Z" },
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-block.json"), {
        id: "ob-block",
        status: "investigating",
        content: "Figure out the deploy issue",
        nextAction: "inspect the failed job",
        createdAt: "2026-03-30T09:00:00.000Z",
        updatedAt: "2026-03-30T11:00:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-return.json"), {
        id: "ob-return",
        status: "pending",
        content: "Return the deployment answer",
        currentSurface: { kind: "artifact", label: "deploy report" },
        createdAt: "2026-03-30T09:30:00.000Z",
        updatedAt: "2026-03-30T11:30:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-stale.json"), {
        id: "ob-stale",
        status: "pending",
        content: "Older unresolved task",
        createdAt: "2026-03-29T07:00:00.000Z",
        updatedAt: "2026-03-29T07:00:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-empty.json"), {
        id: "ob-empty",
        status: "pending",
        content: "",
        createdAt: "2026-03-30T09:15:00.000Z",
        updatedAt: "2026-03-30T09:15:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-merge.json"), {
        id: "ob-merge",
        status: "waiting_for_merge",
        content: "Merge gate pending",
        createdAt: "2026-03-30T10:45:00.000Z",
        updatedAt: "2026-03-30T10:45:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-runtime.json"), {
        id: "ob-runtime",
        status: "updating_runtime",
        content: "Runtime update still moving",
        createdAt: "2026-03-30T10:50:00.000Z",
        updatedAt: "2026-03-30T10:50:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-closed.json"), {
        id: "ob-closed",
        status: "fulfilled",
        content: "Already closed",
        createdAt: "2026-03-30T10:55:00.000Z",
        updatedAt: "2026-03-30T10:55:00.000Z",
      })
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-dismiss.json"), {
        id: "ob-dismiss",
        status: "pending",
        content: "Should stay dismissed",
        createdAt: "2026-03-30T09:00:00.000Z",
        updatedAt: "2026-03-30T09:00:00.000Z",
      })
      writeJson(path.join(alphaRoot, "state", "pending", "friend-2", "cli", "session", "000.json"), {
        from: "friend-2",
        content: "Waiting on follow-up",
        timestamp: 1000,
      })
      writeJson(path.join(alphaRoot, "state", "pending", "self", "inner", "dialog", "000.json"), {
        from: "self",
        content: "internal",
        timestamp: 999,
      })
      fs.mkdirSync(path.join(alphaRoot, "habits"), { recursive: true })
      fs.writeFileSync(path.join(alphaRoot, "habits", "checkup.md"), [
        "---",
        "name: checkup",
        "title: Checkup",
        "cadence: 30m",
        "status: active",
        "lastRun: 2026-03-30T08:00:00.000Z",
        "---",
        "",
        "Watch the system.",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(alphaRoot, "habits", "steady.md"), [
        "---",
        "name: steady",
        "title: Steady",
        "cadence: 1d",
        "status: active",
        "lastRun: 2026-03-30T11:30:00.000Z",
        "---",
        "",
        "Stay ready.",
      ].join("\n"), "utf-8")

      const view = readNeedsMeView("alpha", {
        bundlesRoot,
        now: () => new Date("2026-03-30T12:00:00.000Z"),
      })

      expect(view.items[0]!.urgency).toBe("owed-reply")
      expect(view.items.some((item) => item.urgency === "blocking-obligation")).toBe(true)
      expect(view.items.some((item) => item.urgency === "return-ready")).toBe(true)
      expect(view.items.filter((item) => item.urgency === "stale-delegation").length).toBeGreaterThanOrEqual(2)
      expect(view.items.some((item) => item.urgency === "overdue-habit")).toBe(true)
      expect(view.items.some((item) => item.label === "ob-empty")).toBe(true)
      expect(view.items.some((item) => item.label.includes("Merge gate pending"))).toBe(true)
      expect(view.items.some((item) => item.label.includes("Runtime update still moving"))).toBe(true)
      expect(view.items.some((item) => item.label.includes("Should stay dismissed"))).toBe(false)
      expect(view.items.some((item) => item.label.includes("Already closed"))).toBe(false)
    })

    it("uses default bundle discovery and empty excerpts when options are omitted", async () => {
      const originalHome = process.env.HOME
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "needs-me-home-"))
      try {
        process.env.HOME = tempHome
        const agentRoot = path.join(tempHome, "AgentBundles", "alpha.ouro")
        writeAgentConfig(agentRoot)
        writeJson(path.join(agentRoot, "friends", "friend-1.json"), { name: "Ari" })
        writeJson(path.join(agentRoot, "friends", "friend-2.json"), { name: "Sam" })
        writeJson(path.join(agentRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
          version: 1,
          messages: [
            { role: "assistant", content: "Checking in." },
            { role: "user", content: "" },
          ],
          state: { lastFriendActivityAt: new Date(Date.now() - 60_000).toISOString() },
        })
        writeJson(path.join(agentRoot, "state", "sessions", "friend-2", "cli", "session.json"), {
          version: 1,
          messages: [
            { role: "user", content: "Here is the update." },
            { role: "assistant", content: "Thanks." },
          ],
          state: { lastFriendActivityAt: new Date(Date.now() - 30_000).toISOString() },
        })

        const view = readNeedsMeView("alpha")

        expect(view.items).toHaveLength(1)
        expect(view.items[0]).toMatchObject({
          urgency: "owed-reply",
          label: "Ari is waiting for a reply",
          detail: "via cli · ",
        })
      } finally {
        process.env.HOME = originalHome
        fs.rmSync(tempHome, { recursive: true, force: true })
      }
    })

    it("does not mislabel a stale dead coding surface as return-ready", async () => {
      const bundlesRoot = makeBundleRoot()
      const alphaRoot = path.join(bundlesRoot, "alpha.ouro")
      writeAgentConfig(alphaRoot)
      writeJson(path.join(alphaRoot, "arc", "obligations", "ob-stale-coding.json"), {
        id: "ob-stale-coding",
        status: "investigating",
        content: "Finish the delegated mail import and bring the result back",
        currentSurface: { kind: "coding", label: "claude coding-087" },
        nextAction: "check the live session and continue",
        createdAt: "2026-03-29T08:00:00.000Z",
        updatedAt: "2026-03-29T08:05:00.000Z",
      })

      const view = readNeedsMeView("alpha", {
        bundlesRoot,
        now: () => new Date("2026-03-30T12:00:00.000Z"),
      })

      expect(view.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          urgency: "stale-delegation",
          label: "Finish the delegated mail import and bring the result back",
          detail: "investigating · next: check the live session and continue",
        }),
      ]))
      expect(view.items.some((item) =>
        item.label === "Finish the delegated mail import and bring the result back"
        && item.urgency === "return-ready",
      )).toBe(false)
    })
  })

  describe("readOrientationView", () => {
    let agentRoot: string
    let agentName: string

    afterEach(() => {
      if (agentRoot) fs.rmSync(agentRoot, { recursive: true, force: true })
    })

    it("returns empty orientation when no state exists", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-empty-"))
      agentName = "test-agent"
      const orientation = readOrientationView(agentRoot, agentName)
      expect(orientation.currentSession).toBeNull()
      expect(orientation.centerOfGravity).toBeTruthy()
      expect(orientation.primaryObligation).toBeNull()
      expect(orientation.resumeHandle).toBeNull()
      expect(orientation.otherActiveSessions).toEqual([])
    })

    it("derives orientation from obligations and sessions", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-full-"))
      agentName = "test-agent"
      // Write obligation
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-1.json"), {
        id: "ob-1",
        status: "pending",
        content: "Deploy the new version",
        nextAction: "Run deploy script",
        origin: { friendId: "ari", channel: "cli", key: "chat" },
        currentSurface: { kind: "coding", label: "deploy lane" },
        meaning: { waitingOn: { detail: "CI pipeline" } },
        currentArtifact: "dist/deploy.sh",
        updatedAt: "2026-04-03T10:00:00Z",
      })

      const orientation = readOrientationView(agentRoot, agentName)
      expect(orientation.primaryObligation).not.toBeNull()
      expect(orientation.primaryObligation?.content).toBe("Deploy the new version")
      expect(orientation.centerOfGravity).toBeTruthy()
    })

    it("prefers the most advanced obligation status in orientation", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-advanced-"))
      agentName = "test-agent"
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-returning.json"), {
        id: "ob-returning",
        status: "returning",
        content: "Ready to return",
        createdAt: "2026-04-03T09:00:00Z",
        updatedAt: "2026-04-03T09:30:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-pending.json"), {
        id: "ob-pending",
        status: "pending",
        content: "Still pending",
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T10:00:00Z",
      })

      const orientation = readOrientationView(agentRoot, agentName)

      expect(orientation.primaryObligation?.id).toBe("ob-returning")
    })

    it("breaks orientation ties by most recent update when statuses match", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-tie-"))
      agentName = "test-agent"
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-older.json"), {
        id: "ob-older",
        status: "pending",
        content: "Older pending",
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T09:00:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-newer.json"), {
        id: "ob-newer",
        status: "pending",
        content: "Newer pending",
        createdAt: "2026-04-03T08:30:00Z",
        updatedAt: "2026-04-03T10:00:00Z",
      })

      const orientation = readOrientationView(agentRoot, agentName)

      expect(orientation.primaryObligation?.id).toBe("ob-newer")
    })

    it("includes session and multi-obligation context in the orientation summary", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-context-"))
      agentName = "test-agent"
      const recentActivityAt = new Date(Date.now() - 60_000).toISOString()
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-1.json"), {
        id: "ob-1",
        status: "pending",
        content: "First obligation",
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T09:00:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-2.json"), {
        id: "ob-2",
        status: "pending",
        content: "Second obligation",
        createdAt: "2026-04-03T08:30:00Z",
        updatedAt: "2026-04-03T10:00:00Z",
      })
      writeJson(path.join(agentRoot, "friends", "friend-1.json"), { name: "Ari" })
      writeJson(path.join(agentRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [{ role: "user", content: "hello" }],
        state: { lastFriendActivityAt: recentActivityAt },
      })

      const orientation = readOrientationView(agentRoot, agentName)

      expect(orientation.centerOfGravity).toContain("2 open obligations")
      expect(orientation.centerOfGravity).toContain("1 active sessions")
      expect(orientation.currentSession?.friendId).toBe("friend-1")
    })

    it("falls back to createdAt and unknown status priority when orientation sorts open obligations", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-created-"))
      agentName = "test-agent"
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-unknown.json"), {
        id: "ob-unknown",
        status: "mystery",
        content: "Unknown status task",
        createdAt: "2026-04-03T10:00:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-pending.json"), {
        id: "ob-pending",
        status: "pending",
        content: "Known pending task",
        createdAt: "2026-04-03T09:00:00Z",
      })

      const orientation = readOrientationView(agentRoot, agentName)

      expect(orientation.primaryObligation?.id).toBe("ob-pending")
    })

    it("tracks the most recent session separately from other active sessions", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orient-sessions-"))
      agentName = "test-agent"
      const currentActivityAt = new Date(Date.now() - 60_000).toISOString()
      const otherActivityAt = new Date(Date.now() - 120_000).toISOString()
      writeJson(path.join(agentRoot, "friends", "friend-1.json"), { name: "Ari" })
      writeJson(path.join(agentRoot, "friends", "friend-2.json"), { name: "Sam" })
      writeJson(path.join(agentRoot, "state", "sessions", "friend-1", "cli", "session.json"), {
        version: 1,
        messages: [{ role: "user", content: "Need help" }],
        state: { lastFriendActivityAt: currentActivityAt },
      })
      writeJson(path.join(agentRoot, "state", "sessions", "friend-2", "teams", "thread.json"), {
        version: 1,
        messages: [{ role: "user", content: "Following up" }],
        state: { lastFriendActivityAt: otherActivityAt },
      })

      const orientation = readOrientationView(agentRoot, agentName)

      expect(orientation.currentSession).toEqual({
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        lastActivityAt: currentActivityAt,
      })
      expect(orientation.otherActiveSessions).toEqual([{
        friendId: "friend-2",
        friendName: "Sam",
        channel: "teams",
        key: "thread",
        lastActivityAt: otherActivityAt,
      }])
    })
  })

  describe("readChangesView", () => {
    let agentRoot: string

    afterEach(() => {
      if (agentRoot) fs.rmSync(agentRoot, { recursive: true, force: true })
    })

    it("returns empty changes when no prior snapshot exists", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "changes-empty-"))
      const view = readChangesView(agentRoot)
      expect(view.changeCount).toBe(0)
      expect(view.items).toEqual([])
      expect(view.snapshotAge).toBeNull()
    })

    it("detects changes when obligations shift between snapshots", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "changes-drift-"))
      // Write a prior snapshot
      const snapshotDir = path.join(agentRoot, "state", "outlook")
      fs.mkdirSync(snapshotDir, { recursive: true })
      fs.writeFileSync(path.join(snapshotDir, "active-work-snapshot.json"), JSON.stringify({
        obligationSnapshots: [
          { id: "ob-1", status: "pending", artifact: null, nextAction: null },
        ],
        codingSnapshots: [],
        timestamp: "2026-04-03T09:00:00Z",
      }), "utf-8")

      // Write current obligation with different status
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-1.json"), {
        id: "ob-1",
        status: "in_progress",
        content: "Deploy v2",
        origin: { friendId: "ari", channel: "cli", key: "chat" },
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T10:00:00Z",
      })

      const view = readChangesView(agentRoot)
      expect(view.changeCount).toBeGreaterThan(0)
      expect(view.items.some((c) => c.kind === "obligation_status_changed")).toBe(true)
      expect(view.snapshotAge).toBeTruthy()
    })

    it("handles malformed snapshot gracefully", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "changes-malformed-"))
      const snapshotDir = path.join(agentRoot, "state", "outlook")
      fs.mkdirSync(snapshotDir, { recursive: true })
      fs.writeFileSync(path.join(snapshotDir, "active-work-snapshot.json"), "not json", "utf-8")

      const view = readChangesView(agentRoot)
      expect(view.changeCount).toBe(0)
    })

    it("treats incomplete snapshots as missing history", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "changes-incomplete-"))
      const snapshotDir = path.join(agentRoot, "state", "outlook")
      fs.mkdirSync(snapshotDir, { recursive: true })
      fs.writeFileSync(path.join(snapshotDir, "active-work-snapshot.json"), JSON.stringify({
        obligationSnapshots: [],
        timestamp: "2026-04-03T09:00:00Z",
      }), "utf-8")

      const view = readChangesView(agentRoot)

      expect(view).toEqual({ changeCount: 0, items: [], snapshotAge: null, formatted: "" })
    })
  })

  describe("readObligationDetailView", () => {
    let agentRoot: string

    afterEach(() => {
      if (agentRoot) fs.rmSync(agentRoot, { recursive: true, force: true })
    })

    it("returns empty detail view when no obligations exist", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-empty-"))
      const view = readObligationDetailView(agentRoot)
      expect(view.openCount).toBe(0)
      expect(view.primaryId).toBeNull()
      expect(view.items).toEqual([])
    })

    it("returns obligations with primary selection", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-full-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-1.json"), {
        id: "ob-1",
        status: "pending",
        content: "Primary task",
        nextAction: "Do the thing",
        origin: { friendId: "ari", channel: "cli", key: "chat" },
        currentSurface: { kind: "artifact", label: "deploy notes" },
        meaning: { waitingOn: { detail: "nothing" } },
        updatedAt: "2026-04-03T10:00:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-2.json"), {
        id: "ob-2",
        status: "pending",
        content: "Secondary task",
        nextAction: null,
        origin: { friendId: "bob", channel: "teams", key: "meeting" },
        currentSurface: null,
        meaning: null,
        updatedAt: "2026-04-03T09:00:00Z",
      })
      // Fulfilled obligations should be excluded
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-3.json"), {
        id: "ob-3",
        status: "fulfilled",
        content: "Done task",
        nextAction: null,
        origin: { friendId: "ari", channel: "cli", key: "chat" },
        currentSurface: null,
        meaning: null,
        updatedAt: "2026-04-03T08:00:00Z",
      })
      const view = readObligationDetailView(agentRoot)
      expect(view.openCount).toBe(2)
      expect(view.primaryId).toBeTruthy()
      expect(view.items.length).toBe(2)
      expect(view.items.some((i) => i.isPrimary)).toBe(true)
      expect(view.items.find((i) => i.id === "ob-1")).toMatchObject({
        currentSurface: { kind: "artifact", label: "deploy notes" },
        meaning: { waitingOn: "nothing" },
      })
      // Fulfilled obligation should not be in the list
      expect(view.items.find((i) => i.id === "ob-3")).toBeUndefined()
    })

    it("reports the most advanced primary selection reason when a non-pending obligation wins", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-advanced-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-returning.json"), {
        id: "ob-returning",
        status: "returning",
        content: "Ready to hand back",
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T10:00:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-pending.json"), {
        id: "ob-pending",
        status: "pending",
        content: "Less advanced",
        createdAt: "2026-04-03T08:30:00Z",
        updatedAt: "2026-04-03T10:30:00Z",
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.primaryId).toBe("ob-returning")
      expect(view.primarySelectionReason).toBe("most advanced status: returning")
    })

    it("falls back to createdAt and null waitingOn details when updatedAt is missing", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-created-at-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-older.json"), {
        id: "ob-older",
        status: "pending",
        content: "Older task",
        createdAt: "2026-04-03T08:00:00Z",
        meaning: { waitingOn: {} },
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-newer.json"), {
        id: "ob-newer",
        status: "pending",
        content: "Newer task",
        createdAt: "2026-04-03T09:00:00Z",
        meaning: { waitingOn: {} },
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.primaryId).toBe("ob-newer")
      expect(view.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "ob-older",
          updatedAt: "2026-04-03T08:00:00Z",
          meaning: { waitingOn: null },
          isPrimary: false,
        }),
        expect.objectContaining({
          id: "ob-newer",
          updatedAt: "2026-04-03T09:00:00Z",
          meaning: { waitingOn: null },
          isPrimary: true,
        }),
      ]))
    })

    it("sorts unknown statuses after known priorities in obligation detail", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-unknown-status-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-unknown.json"), {
        id: "ob-unknown",
        status: "mystery",
        content: "Unknown status task",
        createdAt: "2026-04-03T10:00:00Z",
      })
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-pending.json"), {
        id: "ob-pending",
        status: "pending",
        content: "Known pending task",
        createdAt: "2026-04-03T09:00:00Z",
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.primaryId).toBe("ob-pending")
      expect(view.items.find((item) => item.id === "ob-unknown")?.isPrimary).toBe(false)
    })

    it("suppresses stale coding surfaces that are no longer backed by active coding", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-stale-coding-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-stale.json"), {
        id: "ob-stale",
        status: "investigating",
        content: "Bring back the mail import result",
        currentSurface: { kind: "coding", label: "claude coding-087" },
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T08:05:00Z",
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.items.find((item) => item.id === "ob-stale")).toMatchObject({
        currentSurface: null,
      })
    })

    it("suppresses whitespace-only coding surface labels", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-blank-coding-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-blank.json"), {
        id: "ob-blank",
        status: "investigating",
        content: "Bring back the mail import result",
        currentSurface: { kind: "coding", label: "   " },
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T08:05:00Z",
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.items.find((item) => item.id === "ob-blank")).toMatchObject({
        currentSurface: null,
      })
    })

    it("keeps a fresh coding surface visible while the handoff is still warm", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-fresh-coding-"))
      const recentIso = new Date().toISOString()
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-fresh.json"), {
        id: "ob-fresh",
        status: "investigating",
        content: "Bring back the mail import result",
        currentSurface: { kind: "coding", label: "claude coding-088" },
        createdAt: recentIso,
        updatedAt: recentIso,
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.items.find((item) => item.id === "ob-fresh")).toMatchObject({
        currentSurface: { kind: "coding", label: "claude coding-088" },
      })
    })

    it("keeps a coding surface visible when it is still backed by an active coding session", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-live-coding-"))
      writeCodingState(agentRoot, [buildCodingRecord()])
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-live.json"), {
        id: "ob-live",
        status: "investigating",
        content: "Bring back the mail import result",
        currentSurface: { kind: "coding", label: "codex coding-001" },
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T08:05:00Z",
      })

      const view = readObligationDetailView(agentRoot)

      expect(view.items.find((item) => item.id === "ob-live")).toMatchObject({
        currentSurface: { kind: "coding", label: "codex coding-001" },
      })
    })

    it("falls back to the raw obligation currentSurface when normalized summary omits that obligation", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-summary-fallback-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-fallback.json"), {
        id: "ob-fallback",
        status: "pending",
        content: "Fallback task",
        currentSurface: { kind: "artifact", label: "deploy notes" },
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T08:05:00Z",
      })

      vi.resetModules()
      vi.doMock("../../../heart/outlook/readers/agent-machine", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../../../heart/outlook/readers/agent-machine")>()
        return {
          ...actual,
          readObligationSummary: () => ({ items: [] }),
        }
      })

      try {
        const { readObligationDetailView: readWithFallback } = await import("../../../heart/outlook/readers/continuity-readers")
        const view = readWithFallback(agentRoot)
        expect(view.items[0]).toMatchObject({
          id: "ob-fallback",
          currentSurface: { kind: "artifact", label: "deploy notes" },
        })
      } finally {
        vi.doUnmock("../../../heart/outlook/readers/agent-machine")
        vi.resetModules()
      }
    })

    it("falls back to null when normalized summary omits an obligation with no raw currentSurface", async () => {
      agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oblig-summary-null-fallback-"))
      writeJson(path.join(agentRoot, "arc", "obligations", "ob-fallback-null.json"), {
        id: "ob-fallback-null",
        status: "pending",
        content: "Fallback task",
        currentSurface: null,
        createdAt: "2026-04-03T08:00:00Z",
        updatedAt: "2026-04-03T08:05:00Z",
      })

      vi.resetModules()
      vi.doMock("../../../heart/outlook/readers/agent-machine", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../../../heart/outlook/readers/agent-machine")>()
        return {
          ...actual,
          readObligationSummary: () => ({ items: [] }),
        }
      })

      try {
        const { readObligationDetailView: readWithFallback } = await import("../../../heart/outlook/readers/continuity-readers")
        const view = readWithFallback(agentRoot)
        expect(view.items[0]).toMatchObject({
          id: "ob-fallback-null",
          currentSurface: null,
        })
      } finally {
        vi.doUnmock("../../../heart/outlook/readers/agent-machine")
        vi.resetModules()
      }
    })
  })

  describe("readSelfFixView", () => {
    it("returns inactive state when no self-fix tasks exist", async () => {
      const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-empty-"))
      try {
        const view = readSelfFixView(agentRoot)
        expect(view).toEqual({ active: false, currentStep: null, steps: [] })
      } finally {
        fs.rmSync(agentRoot, { recursive: true, force: true })
      }
    })

    it("derives active self-fix steps from matching tasks", async () => {
      const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-full-"))
      try {
        writeTask(path.join(agentRoot, "tasks"), "one-shots", "2026-04-03-0900-self-fix-daemon", {
          type: "one-shot",
          category: "infrastructure",
          title: "Self-fix daemon startup",
          status: "processing",
          created: "2026-04-03",
          updated: "2026-04-03",
        })
        writeTask(path.join(agentRoot, "tasks"), "one-shots", "2026-04-03-0915-fix-coverage-gap", {
          type: "one-shot",
          category: "infrastructure",
          title: "Fix coverage gap",
          status: "done",
          created: "2026-04-03",
          updated: "2026-04-03",
        })

        const view = readSelfFixView(agentRoot)

        expect(view.active).toBe(true)
        expect(view.currentStep).toBe("Self-fix daemon startup")
        expect(view.steps).toHaveLength(2)
        expect(view.steps[1]).toMatchObject({ status: "done" })
      } finally {
        fs.rmSync(agentRoot, { recursive: true, force: true })
      }
    })

    it("returns pending self-fix steps when matching tasks exist but none are active", async () => {
      const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-pending-"))
      try {
        writeTask(path.join(agentRoot, "tasks"), "one-shots", "2026-04-03-0930-fix-followup", {
          type: "one-shot",
          category: "infrastructure",
          title: "Fix followup",
          status: "paused",
          created: "2026-04-03",
          updated: "2026-04-03",
        })

        const view = readSelfFixView(agentRoot)

        expect(view.active).toBe(false)
        expect(view.currentStep).toBeNull()
        expect(view.steps).toEqual([
          {
            label: "Fix followup",
            status: "pending",
            detail: "task 2026-04-03-0930-fix-followup.md: paused",
          },
        ])
      } finally {
        fs.rmSync(agentRoot, { recursive: true, force: true })
      }
    })
  })

  describe("readNoteDecisionView", () => {
    it("returns empty state when the decision log is missing", async () => {
      const view = readNoteDecisionView("/tmp/nonexistent-agent.ouro")
      expect(view).toEqual({ totalCount: 0, items: [] })
    })

    it("reads reverse-chronological note decisions and skips malformed lines", async () => {
      const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-decisions-"))
      try {
        const logPath = path.join(agentRoot, "state", "outlook", "note-decisions.jsonl")
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, [
          JSON.stringify({ kind: "friend", decision: "promote", timestamp: "2026-04-03T09:00:00Z", id: "m-1" }),
          "not-json",
          JSON.stringify({ kind: "fact", decision: "ignore", timestamp: "2026-04-03T10:00:00Z", id: "m-2" }),
        ].join("\n") + "\n", "utf-8")

        const view = readNoteDecisionView(agentRoot, 1)

        expect(view.totalCount).toBe(2)
        expect(view.items).toHaveLength(1)
        expect(view.items[0]).toMatchObject({ id: "m-2", decision: "ignore" })
      } finally {
        fs.rmSync(agentRoot, { recursive: true, force: true })
      }
    })
  })
})
