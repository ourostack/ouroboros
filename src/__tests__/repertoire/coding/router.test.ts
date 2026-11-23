import { describe, expect, it, vi } from "vitest"

import { CodingSessionRouter } from "../../../repertoire/coding/router"
import type {
  CodingBackend,
  CodingSession,
  CodingSessionManagerApi,
  CodingSessionRequest,
  CodingSessionUpdate,
} from "../../../repertoire/coding/types"

function session(id: string, overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id,
    runner: "claude",
    workdir: "/repo",
    status: "running",
    stdoutTail: "",
    stderrTail: "",
    pid: null,
    startedAt: "2026-11-23T00:00:00.000Z",
    lastActivityAt: "2026-11-23T00:00:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
    ...overrides,
  }
}

function fakeManager(initial: CodingSession[] = [], refreshable = false) {
  const sessions = new Map(initial.map((item) => [item.id, item]))
  const listeners: Array<(update: CodingSessionUpdate) => void> = []
  const manager = {
    spawnSession: vi.fn(async (request: CodingSessionRequest) => {
      const created = session(`new-${request.backend}`)
      sessions.set(created.id, created)
      return created
    }),
    listSessions: vi.fn(() => [...sessions.values()]),
    getSession: vi.fn((id: string) => sessions.get(id) ?? null),
    subscribe: vi.fn((_id: string, listener: (update: CodingSessionUpdate) => void) => {
      listeners.push(listener)
      return () => {}
    }),
    sendInput: vi.fn(async (id: string) => ({ ok: true, message: `sent ${id}` })),
    killSession: vi.fn(async (id: string) => ({ ok: true, message: `killed ${id}` })),
    checkStalls: vi.fn(() => 1),
    shutdown: vi.fn(),
    emit: (update: CodingSessionUpdate) => listeners.forEach((listener) => listener(update)),
    add: (item: CodingSession) => sessions.set(item.id, item),
  }
  if (refreshable) {
    Object.assign(manager, {
      refreshSessions: vi.fn(async () => [...sessions.values()]),
      refreshSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    })
  }
  return manager
}

function router(managers: Partial<Record<CodingBackend, ReturnType<typeof fakeManager>>>, preferred: CodingBackend = "orca", eager: CodingBackend[] = ["local", "orca"]) {
  const createManager = vi.fn((backend: CodingBackend) => {
    const manager = managers[backend]
    if (!manager) throw new Error(`no fake for ${backend}`)
    return manager as unknown as CodingSessionManagerApi
  })
  return { router: new CodingSessionRouter({ preferredBackend: preferred, createManager, eagerBackends: eager }), createManager }
}

const request: CodingSessionRequest = { runner: "claude", workdir: "/repo", prompt: "do it", taskRef: "t" }

describe("CodingSessionRouter", () => {
  it("spawns on the preferred backend when the request names none, and stamps the backend", async () => {
    const orca = fakeManager()
    const { router: r } = router({ local: fakeManager(), orca })

    const spawned = await r.spawnSession(request)

    expect(orca.spawnSession).toHaveBeenCalledWith({ ...request, backend: "orca" })
    expect(spawned).toEqual(expect.objectContaining({ id: "new-orca", backend: "orca" }))
  })

  it("spawns on the backend the request names, creating that manager only then", async () => {
    const workbench = fakeManager()
    const { router: r, createManager } = router({ local: fakeManager(), orca: fakeManager(), workbench })
    expect(createManager).not.toHaveBeenCalledWith("workbench")

    const spawned = await r.spawnSession({ ...request, backend: "workbench" })

    expect(createManager).toHaveBeenCalledWith("workbench")
    expect(spawned.backend).toBe("workbench")
    expect(r.listSessions().map((item) => [item.id, item.backend])).toEqual([["new-workbench", "workbench"]])
  })

  it("lists, gets and refreshes sessions from every backend in use", async () => {
    const local = fakeManager([session("coding-001")])
    const orca = fakeManager([session("orca-1")], true)
    const { router: r } = router({ local, orca })

    expect(r.listSessions().map((item) => [item.id, item.backend])).toEqual([["orca-1", "orca"], ["coding-001", "local"]])
    expect((await r.refreshSessions()).map((item) => item.backend)).toEqual(["orca", "local"])
    expect(r.getSession("orca-1")?.backend).toBe("orca")
    expect(r.getSession("missing")).toBeNull()
    expect((await r.refreshSession("orca-1"))?.backend).toBe("orca")
    expect((await r.refreshSession("coding-001"))?.backend).toBe("local")
    expect(await r.refreshSession("missing")).toBeNull()
  })

  it("keeps the other backends' sessions when one backend cannot refresh", async () => {
    const local = fakeManager([session("coding-001")], true)
    const orca = fakeManager([session("orca-1")], true)
    ;(orca as unknown as { refreshSessions: () => Promise<never> }).refreshSessions = vi.fn(async () => {
      throw new Error("orca down")
    })
    ;(local as unknown as { refreshSessions: () => Promise<never> }).refreshSessions = vi.fn(async () => {
      throw "plain"
    })
    const { router: r } = router({ local, orca })

    expect((await r.refreshSessions()).map((item) => [item.id, item.backend])).toEqual([["orca-1", "orca"], ["coding-001", "local"]])
  })

  it("refreshes once to find a session no manager knows yet", async () => {
    const orca = fakeManager([], true)
    orca.refreshSessions = vi.fn(async () => {
      orca.add(session("late"))
      return orca.listSessions()
    })
    const { router: r } = router({ local: fakeManager(), orca })

    expect(await r.sendInput("late", "hi")).toEqual({ ok: true, message: "sent late" })
    expect(orca.refreshSessions).toHaveBeenCalledTimes(1)
  })

  it("returns null when a refreshable manager loses the session", async () => {
    const orca = fakeManager([session("gone")], true)
    ;(orca as unknown as { refreshSession: () => Promise<null> }).refreshSession = vi.fn(async () => null)
    const { router: r } = router({ local: fakeManager(), orca })

    expect(await r.refreshSession("gone")).toBeNull()
  })

  it("sends input to and kills a session on its own backend", async () => {
    const local = fakeManager([session("coding-001")])
    const orca = fakeManager([session("orca-1")])
    const { router: r } = router({ local, orca })

    expect(await r.sendInput("orca-1", "go")).toEqual({ ok: true, message: "sent orca-1" })
    expect(orca.sendInput).toHaveBeenCalledWith("orca-1", "go")
    expect(await r.killSession("coding-001")).toEqual({ ok: true, message: "killed coding-001" })
    expect(local.killSession).toHaveBeenCalledWith("coding-001")
    expect(await r.sendInput("missing", "go")).toEqual({ ok: false, message: "session not found: missing" })
    expect(await r.killSession("missing")).toEqual({ ok: false, message: "session not found: missing" })
  })

  it("subscribes on the owning backend and stamps its updates", () => {
    const orca = fakeManager([session("orca-1")])
    const { router: r } = router({ local: fakeManager(), orca })
    const seen: CodingSessionUpdate[] = []

    r.subscribe("orca-1", (update) => {
      seen.push(update)
    })
    orca.emit({ kind: "completed", session: session("orca-1", { status: "completed" }) })

    expect(seen[0].session.backend).toBe("orca")
    expect(r.subscribe("missing", () => {})()).toBeUndefined()
  })

  it("sums stalls and shuts every backend down", async () => {
    const local = fakeManager()
    const orca = fakeManager()
    const { router: r } = router({ local, orca })

    expect(await r.checkStalls(5)).toBe(2)
    expect(local.checkStalls).toHaveBeenCalledWith(5)
    r.shutdown()
    expect(local.shutdown).toHaveBeenCalled()
    expect(orca.shutdown).toHaveBeenCalled()
    expect(r.listSessions()).toEqual([])
  })

  it("builds no manager at start without eager backends", () => {
    const createManager = vi.fn()
    const r = new CodingSessionRouter({ preferredBackend: "local", createManager })
    expect(createManager).not.toHaveBeenCalled()
    expect(r.listSessions()).toEqual([])
  })
})
