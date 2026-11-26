import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
  return { ...actual, getAgentRoot: vi.fn(() => "/bundles/test-agent.ouro") }
})

import {
  ORCA_MISSES_BEFORE_GONE,
  OrcaCodingSessionManager,
  orcaWorktreeName,
  statusFromOrcaAgent,
  type OrcaCodingSessionManagerOptions,
} from "../../../repertoire/coding/orca-manager"
import type { OrcaAgent, OrcaLaunch, OrcaTerminal } from "../../../repertoire/coding/orca-client"
import type { CodingSessionRequest, CodingSessionUpdate } from "../../../repertoire/coding/types"
import { createLogger, type LogEvent } from "../../../nerves"
import { setRuntimeLogger } from "../../../nerves/runtime"

const worktree = { id: "repo::/wt/fix-login", path: "/wt/fix-login", branch: "ari/fix-login", isMainWorktree: false }
const launch: OrcaLaunch = { worktree, terminalHandle: "term_1", promptDelivered: true, detail: "terminal per settings" }
const terminal: OrcaTerminal = { handle: "term_1", tabId: "tab", leafId: "leaf", agentIdentity: "claude", lastOutputAt: Date.parse("2026-11-23T01:00:00.000Z") }

function fakeCli() {
  return {
    showWorktree: vi.fn(async (): Promise<typeof worktree | null> => null),
    ensureRepo: vi.fn(async () => "repo-id"),
    createWorktreeWithAgent: vi.fn(async () => launch),
    launchAgent: vi.fn(async () => launch),
    listTerminals: vi.fn(async (): Promise<OrcaTerminal[]> => [terminal]),
    listAgents: vi.fn(async (): Promise<OrcaAgent[]> => [{ state: "working", paneKey: "tab:leaf" }]),
    readTerminal: vi.fn(async () => ({ status: "running" as const, tail: "screen text" })),
    sendText: vi.fn(async () => undefined),
    closeTerminal: vi.fn(async () => undefined),
  }
}

function setup(overrides: Partial<OrcaCodingSessionManagerOptions> = {}) {
  const cli = fakeCli()
  const files = new Map<string, string>()
  const options: OrcaCodingSessionManagerOptions = {
    agentName: "test-agent",
    cli,
    stateFilePath: "/state/orca-sessions.json",
    nowIso: () => "2026-11-23T00:00:00.000Z",
    newId: () => "orca-abc12345",
    existsSync: (target) => files.has(target),
    readFileSync: (target) => files.get(target)!,
    writeFileSync: (target, data) => {
      files.set(target, data)
    },
    mkdirSync: vi.fn(),
    sleep: async () => undefined,
    launchStartTimeoutMs: 0,
    ...overrides,
  }
  return { manager: new OrcaCodingSessionManager(options), cli, files, options }
}

async function missTerminal(manager: OrcaCodingSessionManager, cli: ReturnType<typeof fakeCli>, times = ORCA_MISSES_BEFORE_GONE) {
  for (let i = 0; i < times; i++) {
    cli.listTerminals.mockResolvedValueOnce([])
    await manager.refreshSessions()
  }
}

const request: CodingSessionRequest = { runner: "claude", workdir: "/repo", prompt: "Fix the login bug", taskRef: "Fix Login!" }

afterEach(() => {
  vi.useRealTimers()
})

describe("orca coding helpers", () => {
  it("names a worktree from the task, falling back to the session id", () => {
    expect(orcaWorktreeName("Fix Login! (urgent)", "orca-1")).toBe("fix-login-urgent")
    expect(orcaWorktreeName(`${"a".repeat(47)} bcd`, "orca-1")).toBe("a".repeat(47))
    expect(orcaWorktreeName("!!!", "orca-1")).toBe("orca-1")
    expect(orcaWorktreeName(undefined, "orca-1")).toBe("orca-1")
  })

  it("reads Orca's done as the end of a turn, not of the job", () => {
    expect(statusFromOrcaAgent("working")).toBe("running")
    expect(statusFromOrcaAgent(undefined)).toBe("running")
    expect(statusFromOrcaAgent("blocked")).toBe("waiting_input")
    expect(statusFromOrcaAgent("waiting")).toBe("waiting_input")
    expect(statusFromOrcaAgent("done")).toBe("waiting_input")
  })
})

describe("OrcaCodingSessionManager spawn", () => {
  it("creates a new Orca worktree from a repo checkout and records where it lives", async () => {
    const { manager, cli, files } = setup()

    const session = await manager.spawnSession(request)

    expect(cli.showWorktree).toHaveBeenCalledWith("/repo")
    expect(cli.ensureRepo).toHaveBeenCalledWith("/repo")
    expect(cli.createWorktreeWithAgent).toHaveBeenCalledWith(expect.objectContaining({ repoDir: "/repo", repoId: "repo-id", name: "fix-login", agent: "claude" }))
    const prompt = cli.createWorktreeWithAgent.mock.calls[0][0].prompt as string
    expect(prompt).toContain("sessionId: orca-abc12345")
    expect(prompt).toContain("parentAgent: test-agent")
    expect(prompt).toContain("Fix the login bug")
    expect(session).toEqual(expect.objectContaining({
      id: "orca-abc12345",
      backend: "orca",
      workdir: "/wt/fix-login",
      status: "running",
      checkpoint: "terminal per settings",
      orca: {
        requestedWorkdir: "/repo",
        worktreeId: "repo::/wt/fix-login",
        worktreePath: "/wt/fix-login",
        branch: "ari/fix-login",
        terminalHandle: "term_1",
        paneKey: "tab:leaf",
      },
    }))
    expect(JSON.parse(files.get("/state/orca-sessions.json")!).records[0].session.id).toBe("orca-abc12345")
    expect(manager.getSession("orca-abc12345")?.orca?.terminalHandle).toBe("term_1")
    expect(manager.getSession("nope")).toBeNull()
  })

  it("creates a worktree when workdir is a repo's main checkout", async () => {
    const { manager, cli } = setup()
    cli.showWorktree.mockResolvedValueOnce({ ...worktree, isMainWorktree: true })

    await manager.spawnSession({ ...request, parentAgent: "boss", originSession: { friendId: "f", channel: "cli", key: "k" } })

    expect(cli.createWorktreeWithAgent).toHaveBeenCalled()
    expect(cli.launchAgent).not.toHaveBeenCalled()
    expect(manager.listSessions()[0].originSession).toEqual({ friendId: "f", channel: "cli", key: "k" })
  })

  it("opens a new agent tab when workdir is already an Orca worktree", async () => {
    const { manager, cli } = setup()
    cli.showWorktree.mockResolvedValueOnce(worktree)

    await manager.spawnSession({ ...request, runner: "codex" })

    expect(cli.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ worktree, agent: "codex" }))
    expect(cli.createWorktreeWithAgent).not.toHaveBeenCalled()
    expect(cli.ensureRepo).not.toHaveBeenCalled()
  })

  it("relaunches once in the same worktree when the agent never shows up in its pane", async () => {
    const { manager, cli } = setup()
    const retried = { ...launch, terminalHandle: "term_2" }
    cli.launchAgent.mockResolvedValueOnce(retried)
    cli.listTerminals.mockImplementation(async () => [terminal, { handle: "term_2", tabId: "tab2", leafId: "leaf2" }])
    cli.listAgents.mockImplementation(async () => (cli.launchAgent.mock.calls.length > 0 ? [{ state: "working", paneKey: "tab2:leaf2" }] : []))
    cli.readTerminal.mockResolvedValueOnce({ status: "running", tail: "zsh: command not found: laude" })

    const session = await manager.spawnSession(request)

    expect(cli.closeTerminal).toHaveBeenCalledWith("term_1")
    expect(cli.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ worktree, agent: "claude" }))
    expect(session.orca).toEqual(expect.objectContaining({ terminalHandle: "term_2", paneKey: "tab2:leaf2" }))
    expect(session.checkpoint).toBe("terminal per settings")
  })

  it("fails the spawn with what the terminal showed when the relaunch starts no agent either", async () => {
    const { manager, cli } = setup()
    cli.listAgents.mockResolvedValue([])
    cli.readTerminal.mockResolvedValue({ status: "running", tail: "zsh: permission denied: /tmp/orca-launch-1.sh" })
    cli.closeTerminal.mockRejectedValue(new Error("already gone"))

    await expect(manager.spawnSession(request)).rejects.toThrow(
      "Orca opened claude in /wt/fix-login twice but the agent never started, so its tabs were closed; the worktree stays. Its terminal showed: zsh: permission denied: /tmp/orca-launch-1.sh. Spawn again with workdir /wt/fix-login",
    )
    expect(cli.closeTerminal).toHaveBeenCalledTimes(2)
    expect(manager.listSessions()).toEqual([])
  })

  it("relaunches at once when Orca says the prompt was not delivered, and says so when the terminal is unreadable", async () => {
    const { manager, cli } = setup()
    cli.createWorktreeWithAgent.mockResolvedValueOnce({ ...launch, promptDelivered: false })
    cli.launchAgent.mockResolvedValueOnce({ ...launch, promptDelivered: false })
    cli.readTerminal.mockRejectedValue(new Error("gone"))

    await expect(manager.spawnSession(request)).rejects.toThrow("Its terminal showed: (nothing).")
    expect(cli.listAgents).not.toHaveBeenCalled()
  })

  it("keeps looking while Orca is busy, and trusts the pane over Orca's unconfirmed receipt", async () => {
    let now = 0
    const { manager, cli } = setup({ launchStartTimeoutMs: 90_000, nowMs: () => now, sleep: async (ms) => { now += ms } })
    cli.createWorktreeWithAgent.mockResolvedValueOnce({ ...launch, promptDelivered: null })
    cli.listTerminals.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce([{ handle: "term_1" }])

    const session = await manager.spawnSession(request)

    expect(session.orca?.paneKey).toBe("tab:leaf")
    expect(cli.listTerminals).toHaveBeenCalledTimes(3)
    expect(now).toBe(4_000)
    expect(cli.launchAgent).not.toHaveBeenCalled()
  })

  it("counts an agent waiting with its task on screen, or after it has replied, as started", async () => {
    const { manager, cli } = setup()
    cli.listAgents.mockResolvedValueOnce([{ state: "waiting", paneKey: "tab:leaf" }])
    cli.readTerminal.mockResolvedValueOnce({ status: "running", tail: "❯ Execution   contract:\n- You are a subordinate\n⏺ Which login page?" })
    const onScreen = await manager.spawnSession(request)

    cli.listAgents.mockResolvedValueOnce([{ state: "blocked", paneKey: "tab:leaf", lastAssistantMessage: "Which login page?" }])
    const replied = await manager.spawnSession(request)

    expect([onScreen.status, replied.status]).toEqual(["running", "running"])
    expect(cli.readTerminal).toHaveBeenCalledTimes(1)
    expect(cli.launchAgent).not.toHaveBeenCalled()
  })

  it("keeps an agent that asks a question before taking its task, without relaunching, and says a person must answer", async () => {
    let now = 0
    const { manager, cli } = setup({ launchStartTimeoutMs: 4_000, nowMs: () => now, sleep: async (ms) => { now += ms } })
    cli.listAgents.mockResolvedValue([{ state: "waiting", paneKey: "tab:leaf" }])
    cli.readTerminal.mockResolvedValue({ status: "running", tail: "Hooks need review\n6 hooks are new or changed." })

    const session = await manager.spawnSession({ ...request, runner: "codex" })

    expect(cli.launchAgent).not.toHaveBeenCalled()
    expect(cli.closeTerminal).not.toHaveBeenCalled()
    expect(cli.readTerminal).toHaveBeenCalledTimes(3)
    expect(session.status).toBe("waiting_input")
    expect(session.orca?.paneKey).toBe("tab:leaf")
    expect(session.checkpoint).toBe(
      "codex is asking a question before it takes its task; a person has to answer it in its Orca tab. Its terminal showed: Hooks need review\n6 hooks are new or changed.",
    )
    cli.listAgents.mockResolvedValueOnce([{ state: "working", paneKey: "tab:leaf" }])
    await manager.refreshSessions()
    expect(manager.getSession(session.id)?.status).toBe("running")
  })

  it("tells subscribers it spawned", async () => {
    const { manager } = setup({ newId: () => "orca-x" })
    const seen: CodingSessionUpdate[] = []
    manager.subscribe("orca-x", (update) => {
      seen.push(update)
    })
    await manager.spawnSession(request)
    expect(seen.map((update) => update.kind)).toEqual(["spawned"])
    manager.shutdown()
  })
})

describe("OrcaCodingSessionManager refresh", () => {
  it("reads state from Orca's agent list and tail from the terminal screen", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listAgents.mockResolvedValueOnce([{ state: "waiting", paneKey: "tab:leaf", lastAssistantMessage: `Need a decision ${"x".repeat(400)}` }])

    const session = await manager.refreshSession("orca-abc12345")

    expect(session?.status).toBe("waiting_input")
    expect(session?.checkpoint?.length).toBe(280)
    expect(session?.stdoutTail).toBe("screen text")
    expect(session?.lastActivityAt).toBe("2026-11-23T01:00:00.000Z")
    expect(cli.readTerminal).toHaveBeenCalledWith("term_1")
    expect(await manager.refreshSession("missing")).toBeNull()
  })

  it("tells listeners when a waiting agent goes back to work, with its short last message", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    const seen: string[] = []
    manager.subscribe("orca-abc12345", (update) => {
      seen.push(update.kind)
    })
    cli.listAgents.mockResolvedValueOnce([{ state: "done", paneKey: "tab:leaf" }])
    await manager.refreshSessions()
    cli.listAgents.mockResolvedValueOnce([{ state: "working", paneKey: "tab:leaf", lastAssistantMessage: "  on it  " }])
    const [session] = await manager.refreshSessions()

    expect(seen).toEqual(["waiting_input", "progress"])
    expect(session.checkpoint).toBe("on it")
    manager.shutdown()
  })

  it("keeps running when the agent has not reported, and notes no output time it lacks", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listTerminals.mockResolvedValueOnce([{ handle: "term_1", tabId: "tab", leafId: "leaf" }])
    cli.listAgents.mockResolvedValueOnce([])

    const [session] = await manager.refreshSessions()

    expect(session.status).toBe("running")
    expect(session.lastActivityAt).toBe("2026-11-23T00:00:00.000Z")
  })

  it("finds its pane again after Orca restarts and hands out new terminal handles", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listTerminals.mockResolvedValueOnce([{ handle: "someone_else", tabId: "tab2", leafId: "leaf", agentIdentity: "claude" }, { ...terminal, handle: "term_new" }])

    await manager.refreshSessions()

    expect(manager.getSession("orca-abc12345")?.orca?.terminalHandle).toBe("term_new")
  })

  it("never takes over a terminal another session holds, and adopts nothing without a pane key", async () => {
    let n = 0
    const { manager, cli } = setup({ newId: () => `orca-${++n}` })
    cli.listTerminals.mockResolvedValueOnce([terminal])
    await manager.spawnSession(request)
    cli.createWorktreeWithAgent.mockResolvedValueOnce({ ...launch, terminalHandle: "term_2" })
    cli.listTerminals.mockResolvedValueOnce([{ ...terminal, handle: "term_2" }])
    await manager.spawnSession({ ...request, taskRef: "second" })
    // A session saved before launches were checked can lack a pane key.
    ;(manager as unknown as { records: Map<string, { session: { orca: { paneKey?: string } } }> }).records.get("orca-2")!.session.orca.paneKey = undefined

    // orca-1's handle went stale; its pane now shows term_2, which orca-2 already holds.
    cli.listTerminals.mockResolvedValueOnce([{ ...terminal, handle: "term_2" }])
    await manager.refreshSessions()

    expect(manager.getSession("orca-1")?.orca?.terminalHandle).toBe("term_1")
    expect(manager.getSession("orca-2")?.orca?.paneKey).toBe("tab:leaf")
  })

  it("waits for several missed refreshes before calling a session's terminal gone", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    const seen: CodingSessionUpdate[] = []
    manager.subscribe("orca-abc12345", (update) => {
      seen.push(update)
    })

    await missTerminal(manager, cli, ORCA_MISSES_BEFORE_GONE - 1)
    expect(manager.getSession("orca-abc12345")?.status).toBe("running")
    await manager.refreshSessions()
    await missTerminal(manager, cli, ORCA_MISSES_BEFORE_GONE - 1)
    expect(manager.getSession("orca-abc12345")?.endedAt).toBeNull()

    await missTerminal(manager, cli, 1)
    const session = manager.getSession("orca-abc12345")
    expect(session).toEqual(expect.objectContaining({
      status: "failed",
      endedAt: "2026-11-23T00:00:00.000Z",
      checkpoint: "its Orca terminal closed before the agent reported done",
    }))
    expect(session?.failure?.stderrTail).toBe("its Orca terminal closed before the agent reported done")
    expect(seen.map((update) => update.kind)).toEqual(["failed"])

    cli.listTerminals.mockClear()
    cli.readTerminal.mockClear()
    await manager.refreshSessions()
    await manager.refreshSession("orca-abc12345")
    expect(cli.listTerminals).not.toHaveBeenCalled()
    expect(cli.readTerminal).not.toHaveBeenCalled()
    manager.shutdown()
  })

  it("completes a session whose terminal closes after the agent reported done", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listAgents.mockResolvedValueOnce([{ state: "done", paneKey: "tab:leaf" }])
    expect((await manager.refreshSession("orca-abc12345"))?.status).toBe("waiting_input")

    await missTerminal(manager, cli)

    const session = manager.getSession("orca-abc12345")
    expect(session).toEqual(expect.objectContaining({ status: "completed", checkpoint: "finished; its Orca terminal has closed" }))
    expect(session?.failure).toBeNull()
  })

  it("shows the last known state when Orca cannot be reached", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listTerminals.mockRejectedValueOnce(new Error("runtime not reachable"))
    cli.readTerminal.mockRejectedValueOnce("socket closed")

    const session = await manager.refreshSession("orca-abc12345")

    expect(session?.status).toBe("running")
    expect(session?.stdoutTail).toBe("")
  })

  it("reports a refresh error that is not an Error", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listAgents.mockRejectedValueOnce("plain")
    expect((await manager.refreshSessions())[0].status).toBe("running")
  })

  it("groups sessions in one worktree into one Orca read", async () => {
    let n = 0
    const { manager, cli } = setup({ newId: () => `orca-${++n}` })
    cli.showWorktree.mockResolvedValue(worktree)
    await manager.spawnSession(request)
    await manager.spawnSession({ ...request, taskRef: "second" })
    cli.listTerminals.mockClear()

    await manager.refreshSessions()

    expect(cli.listTerminals).toHaveBeenCalledTimes(1)
    expect(manager.listSessions().map((session) => session.id)).toEqual(["orca-1", "orca-2"])
  })
})

describe("OrcaCodingSessionManager input and kill", () => {
  it("types input into the session's terminal", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    const seen: string[] = []
    manager.subscribe("orca-abc12345", (update) => {
      seen.push(update.kind)
    })

    expect(await manager.sendInput("orca-abc12345", "yes, ship it")).toEqual({ ok: true, message: "input sent to orca-abc12345" })
    expect(cli.sendText).toHaveBeenCalledWith("term_1", "yes, ship it")
    expect(seen).toEqual(["progress"])
    expect(await manager.sendInput("missing", "x")).toEqual({ ok: false, message: "session not found: missing" })
    manager.shutdown()
  })

  it("reports Orca refusing input", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.sendText.mockRejectedValueOnce(new Error("terminal_handle_stale")).mockRejectedValueOnce("odd")
    expect((await manager.sendInput("orca-abc12345", "x")).message).toBe("Orca refused input for orca-abc12345: terminal_handle_stale")
    expect((await manager.sendInput("orca-abc12345", "x")).message).toBe("Orca refused input for orca-abc12345: odd")
  })

  it("closes the terminal tab on kill and keeps the worktree", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    const seen: string[] = []
    const unsubscribe = manager.subscribe("orca-abc12345", (update) => {
      seen.push(update.kind)
    })

    expect(await manager.killSession("orca-abc12345")).toEqual({ ok: true, message: "killed orca-abc12345; its worktree stays at /wt/fix-login" })
    expect(cli.closeTerminal).toHaveBeenCalledWith("term_1")
    expect(manager.getSession("orca-abc12345")).toEqual(expect.objectContaining({ status: "killed", endedAt: "2026-11-23T00:00:00.000Z" }))
    expect(seen).toEqual(["killed"])
    unsubscribe()
    unsubscribe()

    expect(await manager.killSession("orca-abc12345")).toEqual({ ok: true, message: "session orca-abc12345 has already ended (killed)" })
    expect(await manager.sendInput("orca-abc12345", "x")).toEqual({ ok: false, message: "session orca-abc12345 has ended (killed); its Orca terminal is closed" })
    expect(await manager.killSession("missing")).toEqual({ ok: false, message: "session not found: missing" })
  })

  it("asks Orca again when closing fails, and calls a tab that is already gone ended", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.closeTerminal.mockRejectedValueOnce(new Error("terminal_handle_stale"))
    cli.listTerminals.mockResolvedValueOnce([])

    expect(await manager.killSession("orca-abc12345")).toEqual({ ok: true, message: "session orca-abc12345 had already ended (failed)" })
  })

  it("reports Orca failing to close a terminal that is still there", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.closeTerminal.mockRejectedValueOnce(new Error("busy")).mockRejectedValueOnce("odd")
    expect((await manager.killSession("orca-abc12345")).message).toBe("Orca could not close orca-abc12345: busy")
    expect((await manager.killSession("orca-abc12345")).message).toBe("Orca could not close orca-abc12345: odd")
    expect(manager.getSession("orca-abc12345")?.status).toBe("running")
  })

  it("has no stall detection of its own", () => {
    expect(setup().manager.checkStalls()).toBe(0)
  })
})

describe("OrcaCodingSessionManager polling and persistence", () => {
  it("polls Orca while someone listens, one refresh at a time, and stops when the last listener leaves", async () => {
    vi.useFakeTimers()
    const { manager, cli } = setup({ pollIntervalMs: 1000 })
    await manager.spawnSession(request)
    const seen: string[] = []
    const first = manager.subscribe("orca-abc12345", (update) => {
      seen.push(update.kind)
    })
    const second = manager.subscribe("orca-abc12345", () => {})
    cli.listAgents.mockResolvedValue([{ state: "done", paneKey: "tab:leaf" }])

    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(["waiting_input"])

    // A refresh still running when the next tick comes is not started twice.
    let release: (value: OrcaTerminal[]) => void = () => {}
    cli.listTerminals.mockClear()
    cli.listTerminals.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(cli.listTerminals).toHaveBeenCalledTimes(1)
    release([terminal])
    await vi.advanceTimersByTimeAsync(1000)
    expect(cli.listTerminals).toHaveBeenCalledTimes(2)

    // With no one listening it keeps polling while the session is open, so a finish is still heard.
    first()
    second()
    cli.listTerminals.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cli.listTerminals).toHaveBeenCalledTimes(1)

    // Once the session's terminal is gone for good, polling stops.
    cli.listTerminals.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(ORCA_MISSES_BEFORE_GONE * 1000)
    expect(manager.getSession("orca-abc12345")?.status).toBe("completed")
    cli.listTerminals.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cli.listTerminals).not.toHaveBeenCalled()
  })

  it("polls sessions it restores from its state file, and reports every update to onUpdate, logging a listener that fails", async () => {
    vi.useFakeTimers()
    const { manager: first, files } = setup()
    await first.spawnSession(request)
    first.shutdown()

    const reported: string[] = []
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
    const onUpdate = vi.fn(async (update: CodingSessionUpdate) => {
      reported.push(update.kind)
      if (update.kind === "waiting_input") throw new Error("queue full")
    })
    const { manager, cli } = setup({ pollIntervalMs: 1000, onUpdate, existsSync: (target) => files.has(target), readFileSync: (target) => files.get(target)! })
    cli.listAgents.mockResolvedValue([{ state: "done", paneKey: "tab:leaf" }])
    manager.subscribe("orca-abc12345", () => {
      throw "plain"
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reported).toEqual(["waiting_input"])
    expect(events.filter((event) => event.event === "repertoire.orca_coding_listener_error").map((event) => event.meta?.reason).sort())
      .toEqual(["plain", "queue full"])
    manager.shutdown()
    setRuntimeLogger(null)
  })

  it("keeps sessions in memory when its state file can't be written", async () => {
    const { manager } = setup({
      writeFileSync: () => {
        throw new Error("disk full")
      },
    })
    await manager.spawnSession(request)
    const other = setup({
      mkdirSync: () => {
        throw "denied"
      },
    })
    await other.manager.spawnSession(request)
    expect(manager.listSessions()).toHaveLength(1)
    expect(other.manager.listSessions()).toHaveLength(1)
  })

  it("restores sessions from its state file and skips malformed ones", async () => {
    const first = setup()
    await first.manager.spawnSession(request)
    const saved = JSON.parse(first.files.get("/state/orca-sessions.json")!)
    saved.records.push({ session: { id: 5 } }, { session: { id: "no-orca" } }, null)
    first.files.set("/state/orca-sessions.json", JSON.stringify(saved))

    const restored = new OrcaCodingSessionManager({ ...first.options })

    expect(restored.listSessions().map((session) => [session.id, session.backend])).toEqual([["orca-abc12345", "orca"]])
  })

  it("starts empty when the state file has no records or cannot be parsed", () => {
    const empty = setup()
    empty.files.set("/state/orca-sessions.json", "{}")
    expect(new OrcaCodingSessionManager({ ...empty.options }).listSessions()).toEqual([])

    empty.files.set("/state/orca-sessions.json", "{not json")
    expect(new OrcaCodingSessionManager({ ...empty.options }).listSessions()).toEqual([])

    const thrower = setup({ readFileSync: () => {
      throw "denied"
    }, existsSync: () => true })
    expect(thrower.manager.listSessions()).toEqual([])
  })

  it("defaults to the bundle's state folder and real dependencies", async () => {
    const manager = new OrcaCodingSessionManager({ agentName: "test-agent", existsSync: () => false })
    expect(manager.listSessions()).toEqual([])
    manager.shutdown()

    const written: string[] = []
    const cli = fakeCli()
    cli.listAgents.mockResolvedValueOnce([])
    const live = new OrcaCodingSessionManager({
      agentName: "test-agent",
      cli,
      launchStartPollMs: 1,
      existsSync: () => false,
      mkdirSync: () => undefined,
      writeFileSync: (target) => {
        written.push(target)
      },
    })
    const session = await live.spawnSession(request)
    expect(session.id).toMatch(/^orca-[0-9a-f]{8}$/)
    expect(Date.parse(session.startedAt)).not.toBeNaN()
    expect(written).toEqual(["/bundles/test-agent.ouro/state/coding/orca-sessions.json"])
    expect(new OrcaCodingSessionManager({ agentName: "test-agent", cli: fakeCli(), stateFilePath: "/definitely/missing/orca.json" }).listSessions()).toEqual([])
  })
})
