import { describe, expect, it, vi } from "vitest"

import { createLogger, type LogEvent } from "../../../nerves"
import { setRuntimeLogger } from "../../../nerves/runtime"

import { WorkbenchCodingSessionManager } from "../../../repertoire/coding/workbench-manager"
import type {
  WorkbenchActionAck,
  WorkbenchActionResult,
  WorkbenchCreateCodingSessionResult,
  WorkbenchMcpClient,
  WorkbenchSession,
} from "../../../repertoire/coding/workbench-client"

function fakeWorkbenchSession(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: "workbench-session-1",
    name: "coding-codex-task-123-20260708T010203004Z",
    owner: { kind: "agent", name: "slugger" },
    status: "running",
    pid: 4242,
    workingDirectory: "/repo",
    startedAt: "2026-07-08T01:02:03.004Z",
    lastOutputAt: "2026-07-08T01:02:04.000Z",
    ...overrides,
  }
}

function fakeClient() {
  return {
    createCodingSession: vi.fn<WorkbenchMcpClient["createCodingSession"]>(),
    listSessions: vi.fn<WorkbenchMcpClient["listSessions"]>(),
    transcriptTail: vi.fn<WorkbenchMcpClient["transcriptTail"]>(),
    requestAction: vi.fn<WorkbenchMcpClient["requestAction"]>(),
    waitForAction: vi.fn<WorkbenchMcpClient["waitForAction"]>(),
  }
}

describe("Workbench coding session manager", () => {
  it("creates a Workbench-owned coding session with the expected command and prompt", async () => {
    const client = fakeClient()
    const session = fakeWorkbenchSession()
    client.createCodingSession.mockResolvedValue({
      session,
      createAck: { queued: true, requestId: "create-1" },
      promptAck: { ok: true, requestId: "prompt-1" },
      promptResult: { requestId: "prompt-1", state: "applied", succeeded: true },
    } satisfies WorkbenchCreateCodingSessionResult)

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:02:03.004Z",
      existsSync: (target) => target === "/tmp/scope.md",
      readFileSync: () => "Scope says ship through Workbench.",
    })

    const result = await manager.spawnSession({
      runner: "codex",
      workdir: "/repo",
      prompt: "Fix the Workbench coding path.",
      taskRef: "Task 123",
      scopeFile: "/tmp/scope.md",
      autoRestartOnCrash: false,
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
    })

    expect(client.createCodingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "slugger",
        name: "coding-codex-task-123-20260708T010203004Z",
        command: "codex",
        workingDirectory: "/repo",
        group: "repo",
        trust: "trusted",
        autoResume: false,
        source: "ouro-coding",
      }),
    )
    const outbound = client.createCodingSession.mock.calls[0][0]
    expect(outbound.prompt).toContain("Execution contract:")
    expect(outbound.prompt).toContain("Scope says ship through Workbench.")
    expect(outbound.prompt).toContain("Fix the Workbench coding path.")
    expect(result).toMatchObject({
      id: "workbench-session-1",
      runner: "codex",
      workdir: "/repo",
      taskRef: "Task 123",
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      status: "running",
      pid: 4242,
    })
    expect(manager.listSessions()).toHaveLength(1)
  })

  it("sanitizes missing and noisy task refs when naming Workbench sessions", async () => {
    const client = fakeClient()
    client.createCodingSession
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "fallback-task", name: "coding-codex-task-20260708T010203004Z" }),
        createAck: { queued: true },
        promptAck: { ok: true, requestId: "prompt-fallback" },
        promptResult: { requestId: "prompt-fallback", state: "applied", succeeded: true },
      } satisfies WorkbenchCreateCodingSessionResult)
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "noisy-task", name: "coding-codex-task-20260708T010203004Z" }),
        createAck: { queued: true },
        promptAck: { ok: true, requestId: "prompt-noisy" },
        promptResult: { requestId: "prompt-noisy", state: "appliedUnconfirmed", succeeded: true },
      } satisfies WorkbenchCreateCodingSessionResult)

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:02:03.004Z",
    })

    await manager.spawnSession({ runner: "codex", workdir: "/repo", prompt: "no task ref" })
    await manager.spawnSession({
      runner: "codex",
      workdir: "/repo",
      prompt: "noisy task ref",
      taskRef: "!!!",
      parentAgent: "boss",
    })

    expect(client.createCodingSession).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "coding-codex-task-20260708T010203004Z" }))
    expect(client.createCodingSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      owner: "boss",
      name: "coding-codex-task-20260708T010203004Z",
    }))
  })

  it("fails closed when Workbench does not confirm initial prompt delivery", async () => {
    const client = fakeClient()
    client.createCodingSession
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "denied" }),
        createAck: { queued: true },
        promptAck: { ok: false, message: "denied by Workbench" },
      } satisfies WorkbenchCreateCodingSessionResult)
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "queued" }),
        createAck: { queued: true },
        promptAck: { ok: true, requestId: "prompt-queued" },
        promptResult: { requestId: "prompt-queued", state: "queued" },
      } satisfies WorkbenchCreateCodingSessionResult)
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "failed" }),
        createAck: { queued: true },
        promptAck: { ok: true, requestId: "prompt-failed" },
        promptResult: { requestId: "prompt-failed", state: "failed", result: "session is not running" },
      } satisfies WorkbenchCreateCodingSessionResult)
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "unknown" }),
        createAck: { queued: true },
        promptAck: { ok: true, requestId: "prompt-unknown" },
        promptResult: { requestId: "prompt-unknown", state: "unknown" },
      } satisfies WorkbenchCreateCodingSessionResult)
      .mockResolvedValueOnce({
        session: fakeWorkbenchSession({ id: "missing-confirmation" }),
        createAck: { queued: true },
        promptAck: { ok: true },
      } satisfies WorkbenchCreateCodingSessionResult)

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:02:03.004Z",
    })
    const request = { runner: "codex" as const, workdir: "/repo", prompt: "do the task" }

    await expect(manager.spawnSession(request)).rejects.toThrow("Workbench denied initial prompt for denied")
    await expect(manager.spawnSession(request)).rejects.toThrow(
      "Workbench queued initial prompt for queued but did not confirm delivery",
    )
    await expect(manager.spawnSession(request)).rejects.toThrow("Workbench failed initial prompt for failed")
    await expect(manager.spawnSession(request)).rejects.toThrow(
      "Workbench did not confirm initial prompt delivery for unknown",
    )
    await expect(manager.spawnSession(request)).rejects.toThrow(
      "Workbench did not confirm initial prompt delivery for missing-confirmation",
    )
    expect(manager.listSessions()).toEqual([])
  })

  it("refreshes Workbench sessions into the local coding-session snapshot cache", async () => {
    const client = fakeClient()
    client.listSessions.mockResolvedValue([
      fakeWorkbenchSession({
        id: "workbench-session-2",
        name: "coding-claude-audit-20260708T010203004Z",
        status: "waitingForInput",
        attentionPrompt: "Approve the focused test plan?",
        workingDirectory: "/repo/audit",
      }),
    ])
    client.transcriptTail.mockResolvedValue("waiting for input\n")

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:03:00.000Z",
    })

    const refreshed = await manager.refreshSessions()
    expect(client.listSessions).toHaveBeenCalledWith({ owner: "slugger", includeArchived: true })
    expect(refreshed[0]).toMatchObject({
      id: "workbench-session-2",
      runner: "claude",
      workdir: "/repo/audit",
      status: "waiting_input",
      checkpoint: "Approve the focused test plan?",
    })

    const withTail = await manager.refreshSession("workbench-session-2")
    expect(client.transcriptTail).toHaveBeenCalledWith("workbench-session-2")
    expect(withTail?.stdoutTail).toBe("waiting for input\n")
    expect(manager.getSession("workbench-session-2")?.stdoutTail).toBe("waiting for input\n")
    expect(manager.getSession("missing")).toBeNull()

    client.transcriptTail.mockResolvedValueOnce("\n")
    const emptyTail = await manager.refreshSession("workbench-session-2")
    expect(emptyTail?.checkpoint).toBe("Approve the focused test plan?")

    await expect(manager.refreshSession("missing")).resolves.toBeNull()
  })

  it("queues Workbench control actions for input and termination", async () => {
    const client = fakeClient()
    client.listSessions.mockResolvedValue([fakeWorkbenchSession()])
    client.requestAction
      .mockResolvedValueOnce({ ok: true, requestId: "input-1" } satisfies WorkbenchActionAck)
      .mockResolvedValueOnce({ ok: true, requestId: "kill-1" } satisfies WorkbenchActionAck)
    client.waitForAction
      .mockResolvedValueOnce({ requestId: "input-1", state: "applied", succeeded: true } satisfies WorkbenchActionResult)
      .mockResolvedValueOnce({ requestId: "kill-1", state: "applied", succeeded: true } satisfies WorkbenchActionResult)

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:04:00.000Z",
    })
    const listener = vi.fn()

    await manager.refreshSessions()
    const unsubscribe = manager.subscribe("workbench-session-1", listener)
    const secondListener = vi.fn()
    const unsubscribeSecond = manager.subscribe("workbench-session-1", secondListener)
    unsubscribeSecond()
    await expect(manager.sendInput("workbench-session-1", "continue")).resolves.toEqual({
      ok: true,
      message: "sendInput applied for workbench-session-1",
    })
    unsubscribe()
    unsubscribe()
    await expect(manager.killSession("workbench-session-1")).resolves.toEqual({
      ok: true,
      message: "terminate applied for workbench-session-1",
    })

    expect(client.requestAction).toHaveBeenNthCalledWith(1, {
      source: "ouro-coding",
      action: "sendInput",
      entry: "workbench-session-1",
      text: "continue",
      appendNewline: true,
    })
    expect(client.requestAction).toHaveBeenNthCalledWith(2, {
      source: "ouro-coding",
      action: "terminate",
      entry: "workbench-session-1",
    })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "progress",
        session: expect.objectContaining({ id: "workbench-session-1", status: "running" }),
      }),
    )
    expect(manager.getSession("workbench-session-1")?.status).toBe("killed")
  })

  it("maps terminal Workbench statuses and ignores sessions outside the coding backend", async () => {
    const client = fakeClient()
    client.listSessions.mockResolvedValue([
      fakeWorkbenchSession({ id: "shell-1", name: "manual-shell", status: "running" }),
      fakeWorkbenchSession({
        id: "configured",
        name: "coding-codex-configured",
        status: "configured",
        attentionReason: "booting",
        workingDirectory: undefined,
      }),
      fakeWorkbenchSession({
        id: "completed",
        name: "coding-codex-complete",
        status: "exited",
        exitCode: 0,
        lastOutputAt: undefined,
        startedAt: undefined,
      }),
      fakeWorkbenchSession({
        id: "failed",
        name: "coding-claude-failed",
        status: "exited",
        exitCode: undefined,
        attentionPrompt: undefined,
        attentionReason: undefined,
        attention: undefined,
      }),
      fakeWorkbenchSession({
        id: "failed-code",
        name: "coding-codex-failed-code",
        status: "exited",
        exitCode: 2,
      }),
      fakeWorkbenchSession({
        id: "recovery",
        name: "coding-codex-recovery",
        status: "needsRecovery",
      }),
      fakeWorkbenchSession({
        id: "manual",
        name: "coding-codex-manual",
        status: "manualActionNeeded",
        attention: "blocked",
      }),
      fakeWorkbenchSession({
        id: "unknown-runner",
        name: "coding-worker-custom",
        status: undefined,
        workingDirectory: undefined,
        lastOutputAt: undefined,
        pid: undefined,
      }),
    ])

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:05:00.000Z",
    })

    const sessions = await manager.refreshSessions()
    expect(sessions.map((session) => session.id)).toEqual([
      "completed",
      "configured",
      "failed",
      "failed-code",
      "manual",
      "recovery",
      "unknown-runner",
    ])
    expect(sessions.find((session) => session.id === "configured")).toMatchObject({
      status: "running",
      checkpoint: "booting",
      workdir: "",
    })
    expect(sessions.find((session) => session.id === "completed")).toMatchObject({
      status: "completed",
      checkpoint: "completed",
      endedAt: "2026-07-08T01:05:00.000Z",
    })
    expect(sessions.find((session) => session.id === "failed")).toMatchObject({
      runner: "claude",
      status: "failed",
      checkpoint: "exited",
      failure: expect.objectContaining({ command: "claude", code: null, stderrTail: "exited" }),
    })
    expect(sessions.find((session) => session.id === "failed-code")).toMatchObject({
      status: "failed",
      checkpoint: "exit code 2",
      failure: expect.objectContaining({ code: 2, stderrTail: "exit code 2" }),
    })
    expect(sessions.find((session) => session.id === "recovery")).toMatchObject({
      status: "stalled",
      checkpoint: "needs Workbench recovery",
    })
    expect(sessions.find((session) => session.id === "manual")).toMatchObject({
      status: "stalled",
      checkpoint: "blocked",
    })
    expect(sessions.find((session) => session.id === "unknown-runner")).toMatchObject({
      runner: "codex",
      workdir: "",
      status: "running",
      pid: null,
    })
  })

  it("returns conservative action results for missing, denied, queued, and failed actions", async () => {
    const client = fakeClient()
    client.listSessions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fakeWorkbenchSession({ id: "workbench-session-1" })])
      .mockResolvedValue([fakeWorkbenchSession({ id: "workbench-session-1" })])
    client.requestAction
      .mockResolvedValueOnce({ ok: false, message: "denied by Workbench" } satisfies WorkbenchActionAck)
      .mockResolvedValueOnce({ ok: true } satisfies WorkbenchActionAck)
      .mockResolvedValueOnce({ ok: true, requestId: "queued-1" } satisfies WorkbenchActionAck)
      .mockResolvedValueOnce({ ok: true, requestId: "failed-1" } satisfies WorkbenchActionAck)
    client.waitForAction
      .mockResolvedValueOnce({ requestId: "queued-1", state: "queued" } satisfies WorkbenchActionResult)
      .mockResolvedValueOnce({
        requestId: "failed-1",
        state: "failed",
        result: "session is not running",
        succeeded: false,
      } satisfies WorkbenchActionResult)
      .mockResolvedValueOnce({
        requestId: "failed-2",
        state: "unknown",
      } satisfies WorkbenchActionResult)

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      nowIso: () => "2026-07-08T01:06:00.000Z",
    })

    await expect(manager.sendInput("missing", "continue")).resolves.toEqual({
      ok: false,
      message: "session not found: missing",
    })
    await expect(manager.sendInput("workbench-session-1", "continue")).resolves.toEqual({
      ok: false,
      message: "denied by Workbench",
    })
    await expect(manager.sendInput("workbench-session-1", "continue")).resolves.toEqual({
      ok: true,
      message: "sendInput queued for workbench-session-1",
    })
    await expect(manager.sendInput("workbench-session-1", "continue")).resolves.toEqual({
      ok: false,
      message: "sendInput queued for workbench-session-1 but not confirmed",
    })
    await expect(manager.killSession("workbench-session-1")).resolves.toEqual({
      ok: false,
      message: "session is not running",
    })
    client.requestAction.mockResolvedValueOnce({ ok: true, requestId: "failed-2" } satisfies WorkbenchActionAck)
    await expect(manager.sendInput("workbench-session-1", "again")).resolves.toEqual({
      ok: false,
      message: "sendInput unknown for workbench-session-1",
    })
    expect(manager.checkStalls()).toBe(0)
    manager.shutdown()
  })

  it("uses default timing and filesystem dependencies when options omit them", async () => {
    const client = fakeClient()
    client.listSessions.mockResolvedValue([
      fakeWorkbenchSession({
        id: "undated",
        name: "coding-codex-undated",
        startedAt: undefined,
        lastOutputAt: undefined,
      }),
    ])

    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
    })

    const [session] = await manager.refreshSessions()
    expect(Date.parse(session.startedAt)).not.toBeNaN()
    expect(Date.parse(session.lastActivityAt)).not.toBeNaN()
  })
})

describe("Workbench coding sessions report status changes without anyone asking", () => {
  function manualScheduler() {
    const tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
    return {
      tasks,
      schedule: vi.fn((fn: () => void, ms: number) => {
        const task = { fn, ms, cancelled: false }
        tasks.push(task)
        return () => { task.cancelled = true }
      }),
      live: () => tasks.filter((task) => !task.cancelled),
      fire: async () => {
        for (const task of tasks.filter((entry) => !entry.cancelled)) {
          task.cancelled = true
          task.fn()
        }
        for (let index = 0; index < 5; index += 1) await Promise.resolve()
      },
    }
  }

  it("polls while a session is active, notifies each status change, and stops once nothing is active", async () => {
    const client = fakeClient()
    const scheduler = manualScheduler()
    const onUpdate = vi.fn()
    const listener = vi.fn()
    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-1", status: "running" })])
    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      onUpdate,
      pollMs: 1_000,
      schedule: scheduler.schedule,
    })

    await manager.watch()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(scheduler.live()).toHaveLength(1)
    expect(scheduler.live()[0]!.ms).toBe(1_000)
    manager.subscribe("wb-1", listener)

    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-1", status: "waitingForInput", attentionPrompt: "Which branch?" })])
    await scheduler.fire()
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "waiting_input", session: expect.objectContaining({ checkpoint: "Which branch?" }) }))
    expect(listener).toHaveBeenCalledTimes(1)

    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-1", status: "running" })])
    await scheduler.fire()
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "progress" }))

    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-1", status: "running" })])
    await scheduler.fire()
    expect(onUpdate).toHaveBeenCalledTimes(2)

    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-1", status: "exited", exitCode: 0 })])
    await scheduler.fire()
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "completed" }))
    expect(onUpdate).toHaveBeenCalledTimes(3)
    expect(scheduler.live()).toHaveLength(0)
  })

  it("starts polling when it spawns a session, and shutdown stops it", async () => {
    const client = fakeClient()
    const scheduler = manualScheduler()
    client.createCodingSession.mockResolvedValue({
      session: fakeWorkbenchSession(),
      createAck: { queued: true, requestId: "create-1" },
      promptAck: { ok: true, requestId: "prompt-1" },
      promptResult: { requestId: "prompt-1", state: "applied", succeeded: true },
    } satisfies WorkbenchCreateCodingSessionResult)
    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      schedule: scheduler.schedule,
    })
    await manager.spawnSession({ runner: "codex", workdir: "/repo", prompt: "go", taskRef: "t" })
    await manager.spawnSession({ runner: "codex", workdir: "/repo", prompt: "go", taskRef: "t" })
    expect(scheduler.schedule).toHaveBeenCalledTimes(1)
    expect(scheduler.live()[0]!.ms).toBe(30_000)
    manager.shutdown()
    expect(scheduler.live()).toHaveLength(0)
    manager.shutdown()
  })

  it("keeps polling after Workbench can't be read, and logs a listener that fails", async () => {
    const client = fakeClient()
    const scheduler = manualScheduler()
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error("queue full")).mockRejectedValueOnce("plain")
    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-2", status: "running" })])
    const manager = new WorkbenchCodingSessionManager({
      agentName: "slugger",
      client: client as unknown as WorkbenchMcpClient,
      onUpdate,
      schedule: scheduler.schedule,
    })
    await manager.watch()

    client.listSessions.mockRejectedValueOnce(new Error("workbench down"))
    await scheduler.fire()
    client.listSessions.mockRejectedValueOnce("offline")
    await scheduler.fire()
    expect(events.filter((event) => event.event === "repertoire.workbench_coding_poll_error").map((event) => event.meta?.reason)).toEqual(["workbench down", "offline"])
    expect(scheduler.live()).toHaveLength(1)

    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-2", status: "needsRecovery" })])
    await scheduler.fire()
    client.listSessions.mockResolvedValueOnce([fakeWorkbenchSession({ id: "wb-2", status: "exited", exitCode: 1 })])
    await scheduler.fire()
    expect(events.filter((event) => event.event === "repertoire.workbench_coding_listener_error").map((event) => event.meta?.reason)).toEqual(["queue full", "plain"])
    setRuntimeLogger(null)
  })

  it("does not poll after a failed first read when nothing is known to be active", async () => {
    const client = fakeClient()
    const scheduler = manualScheduler()
    client.listSessions.mockRejectedValueOnce(new Error("workbench down"))
    const manager = new WorkbenchCodingSessionManager({ agentName: "slugger", client: client as unknown as WorkbenchMcpClient, schedule: scheduler.schedule })
    await manager.watch()
    expect(scheduler.schedule).not.toHaveBeenCalled()
  })
})
