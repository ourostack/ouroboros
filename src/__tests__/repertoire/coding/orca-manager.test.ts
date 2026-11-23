import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
  return { ...actual, getAgentRoot: vi.fn(() => "/bundles/test-agent.ouro") }
})

import {
  OrcaCodingSessionManager,
  orcaWorktreeName,
  statusFromOrcaAgent,
  type OrcaCodingSessionManagerOptions,
} from "../../../repertoire/coding/orca-manager"
import type { OrcaAgent, OrcaLaunch, OrcaTerminal } from "../../../repertoire/coding/orca-client"
import type { CodingSessionRequest, CodingSessionUpdate } from "../../../repertoire/coding/types"

const worktree = { id: "repo::/wt/fix-login", path: "/wt/fix-login", branch: "ari/fix-login", isMainWorktree: false }
const launch: OrcaLaunch = { worktree, terminalHandle: "term_1", promptDelivered: true, detail: "terminal per settings" }
const terminal: OrcaTerminal = { handle: "term_1", tabId: "tab", leafId: "leaf", agentIdentity: "claude", lastOutputAt: Date.parse("2026-11-23T01:00:00.000Z") }

function fakeCli() {
  return {
    showWorktree: vi.fn(async (): Promise<typeof worktree | null> => null),
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
    ...overrides,
  }
  return { manager: new OrcaCodingSessionManager(options), cli, files, options }
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

  it("maps Orca agent states", () => {
    expect(statusFromOrcaAgent("working")).toBe("running")
    expect(statusFromOrcaAgent(undefined)).toBe("running")
    expect(statusFromOrcaAgent("blocked")).toBe("waiting_input")
    expect(statusFromOrcaAgent("waiting")).toBe("waiting_input")
    expect(statusFromOrcaAgent("done")).toBe("completed")
  })
})

describe("OrcaCodingSessionManager spawn", () => {
  it("creates a new Orca worktree from a repo checkout and records where it lives", async () => {
    const { manager, cli, files } = setup()

    const session = await manager.spawnSession(request)

    expect(cli.showWorktree).toHaveBeenCalledWith("/repo")
    expect(cli.createWorktreeWithAgent).toHaveBeenCalledWith(expect.objectContaining({ repoDir: "/repo", name: "fix-login", agent: "claude" }))
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
      orca: { worktreeId: "repo::/wt/fix-login", worktreePath: "/wt/fix-login", branch: "ari/fix-login", terminalHandle: "term_1" },
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
  })

  it("fails the spawn when Orca says the prompt was not delivered", async () => {
    const { manager, cli } = setup()
    cli.createWorktreeWithAgent.mockResolvedValueOnce({ ...launch, promptDelivered: false })

    await expect(manager.spawnSession(request)).rejects.toThrow("did not deliver its task prompt")
    expect(manager.listSessions()).toEqual([])
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
    cli.listAgents.mockResolvedValueOnce([{ state: "waiting", paneKey: "tab:leaf" }])
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

  it("adopts the new handle after Orca restarts and renames terminals", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listTerminals.mockResolvedValueOnce([{ ...terminal, handle: "term_new" }, { handle: "term_shell", agentIdentity: undefined }])

    await manager.refreshSessions()

    expect(manager.getSession("orca-abc12345")?.orca?.terminalHandle).toBe("term_new")
  })

  it("marks a session failed when its terminal is gone before it finished, and stops refreshing it", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    const seen: CodingSessionUpdate[] = []
    manager.subscribe("orca-abc12345", (update) => {
      seen.push(update)
    })
    cli.listTerminals.mockResolvedValueOnce([{ handle: "other", agentIdentity: "claude" }, { handle: "other2", agentIdentity: "claude" }])

    const session = await manager.refreshSession("orca-abc12345")

    expect(session).toEqual(expect.objectContaining({
      status: "failed",
      endedAt: "2026-11-23T00:00:00.000Z",
      checkpoint: "its Orca terminal closed before the agent reported done",
    }))
    expect(session?.failure?.stderrTail).toBe("its Orca terminal closed before the agent reported done")
    expect(seen.map((update) => update.kind)).toEqual(["failed"])
    expect(cli.readTerminal).not.toHaveBeenCalled()

    cli.listTerminals.mockClear()
    await manager.refreshSessions()
    await manager.refreshSession("orca-abc12345")
    expect(cli.listTerminals).not.toHaveBeenCalled()
    manager.shutdown()
  })

  it("keeps a finished session completed when its terminal later closes", async () => {
    const { manager, cli } = setup()
    await manager.spawnSession(request)
    cli.listAgents.mockResolvedValueOnce([{ state: "done", paneKey: "tab:leaf" }])
    expect((await manager.refreshSession("orca-abc12345"))?.status).toBe("completed")

    cli.listTerminals.mockResolvedValueOnce([])
    const session = await manager.refreshSession("orca-abc12345")

    expect(session).toEqual(expect.objectContaining({ status: "completed", checkpoint: "finished; its Orca terminal has since closed" }))
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

  it("reports Orca failing to close the terminal", async () => {
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
  it("polls Orca while someone listens, and stops when the last listener leaves", async () => {
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
    expect(seen).toEqual(["completed"])

    first()
    second()
    cli.listTerminals.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cli.listTerminals).not.toHaveBeenCalled()
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
    const live = new OrcaCodingSessionManager({
      agentName: "test-agent",
      cli: fakeCli(),
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
