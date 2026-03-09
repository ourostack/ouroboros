import { describe, expect, it, vi } from "vitest"

import { CodingSessionManager } from "../../../repertoire/coding/manager"

class FakeStream {
  private listeners = new Map<string, Array<(chunk: Buffer | string) => void>>()

  on(event: string, cb: (chunk: Buffer | string) => void): this {
    const current = this.listeners.get(event) ?? []
    current.push(cb)
    this.listeners.set(event, current)
    return this
  }

  emit(event: string, chunk: Buffer | string): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(chunk)
    }
  }
}

class FakeProcess {
  pid?: number
  readonly stdin = {
    write: vi.fn(),
  }
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  readonly kill = vi.fn(() => true)

  constructor(pid?: number) {
    this.pid = pid
  }

  on(event: string, cb: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    if (event === "exit") {
      this.exitListeners.push(cb)
    }
    return this
  }

  emitStdout(text: string): void {
    this.stdout.emit("data", text)
  }

  emitStderr(text: string): void {
    this.stderr.emit("data", text)
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const cb of this.exitListeners) {
      cb(code, signal)
    }
  }
}

function nowFactory(start = "2026-03-05T23:40:00.000Z"): () => string {
  let value = Date.parse(start)
  return () => {
    const next = new Date(value).toISOString()
    value += 1_000
    return next
  }
}

const noPersistence = {
  existsSync: () => false,
  readFileSync: () => "",
  writeFileSync: () => undefined,
  mkdirSync: () => undefined,
}

describe("coding session manager branch coverage", () => {
  it("normalizes missing pid to null on first spawn", async () => {
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => new FakeProcess()),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "no pid",
    })

    expect(session.pid).toBeNull()
  })

  it("covers manager default option branches and null pid paths", async () => {
    const first = new FakeProcess(700)
    const second = new FakeProcess()
    const third = new FakeProcess()
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third)

    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: spawn,
      defaultStallThresholdMs: 1,
    })

    expect(manager.getSession("coding-missing")).toBeNull()

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "defaults",
      autoRestartOnCrash: true,
    })
    expect(session.pid).toBe(700)

    first.emitExit(1, null)
    const restarted = manager.getSession(session.id)
    expect(restarted?.pid).toBeNull()

    const stalled = manager.checkStalls(Date.parse(restarted!.lastActivityAt) + 10)
    expect(stalled).toBe(1)
    expect(manager.getSession(session.id)?.pid).toBeNull()
  })

  it("lists sessions in deterministic id order", async () => {
    const first = new FakeProcess(10)
    const second = new FakeProcess(11)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      nowIso: nowFactory(),
    })

    await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "first",
    })
    await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "second",
    })

    expect(manager.listSessions().map((session) => session.id)).toEqual(["coding-001", "coding-002"])
  })

  it("updates waiting_input/completed statuses from output markers", async () => {
    const proc = new FakeProcess(111)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => proc),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "plan",
    })

    proc.emitStdout("status: NEEDS_REVIEW")
    expect(manager.getSession(session.id)?.status).toBe("waiting_input")
    expect(manager.getSession(session.id)?.stdoutTail).toContain("status: NEEDS_REVIEW")

    proc.emitStderr("❌ blocked")
    expect(manager.getSession(session.id)?.status).toBe("waiting_input")
    expect(manager.getSession(session.id)?.stderrTail).toContain("❌ blocked")
    expect(manager.listSessions()[0]?.stdoutTail).toContain("status: NEEDS_REVIEW")
    expect(manager.listSessions()[0]?.stderrTail).toContain("❌ blocked")

    proc.emitStdout("✅ all units complete")
    expect(manager.getSession(session.id)?.status).toBe("completed")
    expect(manager.getSession(session.id)?.endedAt).not.toBeNull()

    const inputResult = manager.sendInput(session.id, "continue")
    expect(inputResult.ok).toBe(true)
    expect(proc.stdin.write).toHaveBeenCalledWith("continue\n")
  })

  it("returns not found for kill/send on unknown sessions", () => {
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => new FakeProcess(1)),
      nowIso: nowFactory(),
    })

    expect(manager.sendInput("coding-404", "x")).toEqual({ ok: false, message: "session not found: coding-404" })
    expect(manager.killSession("coding-404")).toEqual({ ok: false, message: "session not found: coding-404" })
  })

  it("notifies subscribed listeners for progress and terminal updates", async () => {
    const proc = new FakeProcess(515)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => proc),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "do it",
    })

    const listener = vi.fn()
    manager.subscribe(session.id, listener)

    proc.emitStdout("thinking")
    proc.emitExit(0, null)

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "progress",
        stream: "stdout",
        text: "thinking",
      }),
    )
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "completed",
        session: expect.objectContaining({ id: session.id, status: "completed" }),
      }),
    )
  })

  it("removes listeners on unsubscribe and tolerates listener failures", async () => {
    const proc = new FakeProcess(516)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => proc),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "do it",
    })

    const stableListener = vi.fn()
    const failingListener = vi.fn(() => Promise.reject(new Error("listener boom")))
    const stringFailingListener = vi.fn(() => Promise.reject("listener boom string"))
    const unsubscribe = manager.subscribe(session.id, stableListener)
    manager.subscribe(session.id, failingListener)
    manager.subscribe(session.id, stringFailingListener)

    unsubscribe()
    unsubscribe()
    proc.emitStdout("thinking")
    await Promise.resolve()
    await Promise.resolve()

    expect(stableListener).not.toHaveBeenCalled()
    expect(failingListener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "progress", text: "thinking" }),
    )
    expect(stringFailingListener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "progress", text: "thinking" }),
    )
  })

  it("drops empty listener sets and tolerates redundant unsubscribe calls", async () => {
    const proc = new FakeProcess(517)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => proc),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "do it",
    })

    const listener = vi.fn()
    const unsubscribe = manager.subscribe(session.id, listener)
    unsubscribe()
    unsubscribe()

    proc.emitStdout("thinking")
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it("marks status as running when sending input from waiting_input/stalled", async () => {
    const proc = new FakeProcess(222)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => proc),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "do",
    })

    ;(manager as any).records.get(session.id).session.status = "waiting_input"
    manager.sendInput(session.id, "a")
    expect(manager.getSession(session.id)?.status).toBe("running")

    ;(manager as any).records.get(session.id).session.status = "stalled"
    manager.sendInput(session.id, "b")
    expect(manager.getSession(session.id)?.status).toBe("running")
  })

  it("handles crash exits with restart and final failure", async () => {
    const first = new FakeProcess(300)
    const second = new FakeProcess(301)
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)

    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: spawn,
      nowIso: nowFactory(),
      maxRestarts: 1,
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "implement",
    })

    first.emitExit(1, null)
    const restarted = manager.getSession(session.id)
    expect(restarted?.status).toBe("running")
    expect(restarted?.restartCount).toBe(1)
    expect(restarted?.pid).toBe(301)

    second.emitExit(1, null)
    const failed = manager.getSession(session.id)
    expect(failed?.status).toBe("failed")
    expect(failed?.endedAt).not.toBeNull()
    expect(failed?.lastExitCode).toBe(1)
  })

  it("marks clean exits as completed and preserves killed/completed exits", async () => {
    const procA = new FakeProcess(401)
    const procB = new FakeProcess(402)
    const procC = new FakeProcess(403)
    const spawn = vi.fn().mockReturnValueOnce(procA).mockReturnValueOnce(procB).mockReturnValueOnce(procC)

    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: spawn,
      nowIso: nowFactory(),
    })

    const a = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "a",
    })
    procA.emitExit(0, null)
    expect(manager.getSession(a.id)?.status).toBe("completed")

    const b = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "b",
    })
    manager.killSession(b.id)
    procB.emitExit(1, null)
    expect(manager.getSession(b.id)?.status).toBe("killed")

    const c = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "c",
    })
    ;(manager as any).records.get(c.id).session.status = "completed"
    procC.emitExit(1, null)
    expect(manager.getSession(c.id)?.status).toBe("completed")
  })

  it("supports stall detection with and without auto-restart", async () => {
    const first = new FakeProcess(500)
    const second = new FakeProcess(501)
    const third = new FakeProcess(502)
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third)

    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: spawn,
      nowIso: nowFactory(),
      maxRestarts: 1,
    })

    const restartable = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "r",
      stallThresholdMs: 1,
      autoRestartOnStall: true,
    })
    const nonRestartable = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "n",
      stallThresholdMs: 1,
      autoRestartOnStall: false,
    })

    const latestActivity = Math.max(
      Date.parse(manager.getSession(restartable.id)!.lastActivityAt),
      Date.parse(manager.getSession(nonRestartable.id)!.lastActivityAt),
    )
    const stalledCount = manager.checkStalls(latestActivity + 10)
    expect(stalledCount).toBe(2)

    expect(manager.getSession(restartable.id)?.status).toBe("running")
    expect(manager.getSession(restartable.id)?.restartCount).toBe(1)
    expect(manager.getSession(nonRestartable.id)?.status).toBe("stalled")

    expect(manager.checkStalls(latestActivity)).toBe(0)
  })

  it("shutdown kills running sessions and keeps non-running records untouched", async () => {
    const procA = new FakeProcess(600)
    const procB = new FakeProcess(601)
    const spawn = vi.fn().mockReturnValueOnce(procA).mockReturnValueOnce(procB)

    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: spawn,
      nowIso: nowFactory(),
    })

    const running = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "run",
    })
    const nullProcess = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "skip",
    })

    ;(manager as any).records.get(running.id).session.status = "spawning"
    ;(manager as any).records.get(nullProcess.id).process = null

    manager.shutdown()
    expect(procA.kill).toHaveBeenCalledWith("SIGTERM")
    expect(procB.kill).not.toHaveBeenCalled()
    expect(manager.getSession(running.id)?.status).toBe("killed")
  })

  it("shutdown does not overwrite completed sessions after kill signal", async () => {
    const proc = new FakeProcess(910)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => proc),
      nowIso: nowFactory(),
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "done",
    })
    ;(manager as any).records.get(session.id).session.status = "completed"

    manager.shutdown()
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
    expect(manager.getSession(session.id)?.status).toBe("completed")
  })

  it("covers private no-op guard branches", () => {
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => new FakeProcess(1)),
      nowIso: nowFactory(),
    })

    const record = {
      request: {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/x",
        prompt: "x",
      },
      session: {
        id: "coding-guard",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/x",
        status: "running",
        pid: null,
        startedAt: "2026-03-05T23:40:00.000Z",
        lastActivityAt: "2026-03-05T23:40:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
      },
      process: null,
    }

    ;(manager as any).attachProcessListeners(record)
    ;(manager as any).onExit(record, 1, null)
  })

  it("trims captured output tails when process output exceeds max length", async () => {
    const proc = new FakeProcess(999)
    const manager = new CodingSessionManager({
      ...noPersistence,
      spawnProcess: vi.fn(() => ({
        process: proc,
        command: "claude",
        args: ["-p"],
        prompt: "tail",
      })),
      nowIso: nowFactory(),
      maxRestarts: 0,
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "long output",
    })

    proc.emitStdout("a".repeat(2105))
    proc.emitStderr("b".repeat(2200))
    proc.emitExit(1, null)

    const failed = manager.getSession(session.id)
    expect(failed?.failure?.stdoutTail.length).toBe(2000)
    expect(failed?.failure?.stderrTail.length).toBe(2000)
  })
})
