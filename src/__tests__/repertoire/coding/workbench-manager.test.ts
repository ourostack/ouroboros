import { describe, expect, it, vi } from "vitest"

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
      status: "running",
      pid: 4242,
    })
    expect(manager.listSessions()).toHaveLength(1)
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
        exitCode: 2,
        attentionPrompt: undefined,
        attentionReason: undefined,
        attention: undefined,
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
      checkpoint: "exit code 2",
      failure: expect.objectContaining({ command: "claude", code: 2, stderrTail: "exit code 2" }),
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
      ok: false,
      message: "sendInput queued for workbench-session-1 but not confirmed",
    })
    await expect(manager.killSession("workbench-session-1")).resolves.toEqual({
      ok: false,
      message: "session is not running",
    })
    expect(manager.checkStalls()).toBe(0)
    manager.shutdown()
  })
})
