import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../repertoire/coding", () => ({
  getCodingSessionManager: vi.fn(),
  attachCodingSessionFeedback: vi.fn(),
  formatCodingTail: vi.fn((session: { stdoutTail?: string; stderrTail?: string }) =>
    `tail\n${session.stdoutTail ?? ""}\n${session.stderrTail ?? ""}`.trim(),
  ),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/Users/test/AgentBundles/slugger.ouro"),
}))

vi.mock("../../../heart/obligations", () => ({
  findPendingObligationForOrigin: vi.fn(),
  advanceObligation: vi.fn(),
}))

import { attachCodingSessionFeedback, formatCodingTail, getCodingSessionManager } from "../../../repertoire/coding"
import { advanceObligation, findPendingObligationForOrigin } from "../../../heart/obligations"

describe("coding tool contracts", () => {
  const manager = {
    spawnSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    killSession: vi.fn(),
  }

  let execTool: (name: string, args: Record<string, string>, ctx?: Record<string, unknown>) => Promise<string>
  let summarizeArgs: (name: string, args: Record<string, string>) => string

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(getCodingSessionManager).mockReturnValue(manager as unknown as ReturnType<typeof getCodingSessionManager>)
    vi.mocked(attachCodingSessionFeedback).mockReset()
    vi.mocked(formatCodingTail).mockClear()
    vi.mocked(findPendingObligationForOrigin).mockReset()
    vi.mocked(findPendingObligationForOrigin).mockReturnValue(undefined)
    vi.mocked(advanceObligation).mockReset()
    manager.spawnSession.mockReset()
    manager.getSession.mockReset()
    manager.listSessions.mockReset()
    manager.subscribe.mockReset()
    manager.subscribe.mockReturnValue(() => {})
    manager.sendInput.mockReset()
    manager.killSession.mockReset()

    const tools = await import("../../../repertoire/tools")
    execTool = tools.execTool
    summarizeArgs = tools.summarizeArgs
  })

  it("coding_spawn validates runner arg", async () => {
    const invalidRunner = await execTool("coding_spawn", {
      runner: "bad-runner",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "do work",
      taskRef: "task-1",
    })
    expect(invalidRunner).toContain("invalid runner")
  })

  it("coding_spawn validates required fields", async () => {
    expect(
      await execTool("coding_spawn", {
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "go",
        taskRef: "task-1",
      }),
    ).toContain("runner is required")

    expect(
      await execTool("coding_spawn", {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "go",
      }),
    ).toContain("taskRef is required")

    expect(
      await execTool("coding_spawn", {
        runner: "claude",
        prompt: "go",
        taskRef: "task-1",
      }),
    ).toContain("workdir is required")

    expect(
      await execTool("coding_spawn", {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-1",
      }),
    ).toContain("prompt is required")
  })

  it("coding_spawn delegates to manager and returns a JSON session payload", async () => {
    manager.spawnSession.mockResolvedValue({
      id: "coding-001",
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-123",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      status: "running",
      pid: 4321,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:50:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
    })

    const result = await execTool("coding_spawn", {
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-123",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
    })

    expect(manager.spawnSession).toHaveBeenCalledWith({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-123",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
    })
    expect(JSON.parse(result)).toMatchObject({
      id: "coding-001",
      runner: "claude",
      status: "running",
    })
  })

  it("coding_spawn attaches coding feedback relay when context provides it", async () => {
    manager.spawnSession.mockResolvedValue({
      id: "coding-777",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-777",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 4321,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:50:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    })
    const feedback = { send: vi.fn().mockResolvedValue(undefined) }

    const result = await execTool(
      "coding_spawn",
      {
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-777",
      },
      { codingFeedback: feedback },
    )

    expect(attachCodingSessionFeedback).toHaveBeenCalledWith(manager, expect.objectContaining({ id: "coding-777" }), feedback)
    expect(JSON.parse(result)).toMatchObject({ id: "coding-777", runner: "codex" })
  })

  it("coding_spawn threads current-session provenance and obligation linkage into the coding session", async () => {
    vi.mocked(findPendingObligationForOrigin).mockReturnValue({
      id: "ob-1",
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      content: "fix the loop",
      status: "pending",
      createdAt: "2026-03-20T00:00:00.000Z",
    } as any)
    manager.spawnSession.mockResolvedValue({
      id: "coding-778",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-778",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 4321,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:50:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      obligationId: "ob-1",
    })

    await execTool(
      "coding_spawn",
      {
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-778",
      },
      {
        currentSession: {
          friendId: "ari",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
        },
      },
    )

    expect(manager.spawnSession).toHaveBeenCalledWith({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-778",
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      obligationId: "ob-1",
    })
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-1",
      expect.objectContaining({
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-778" },
      }),
    )
  })

  it("coding_spawn keeps origin provenance even when no pending obligation exists yet", async () => {
    manager.spawnSession.mockResolvedValue({
      id: "coding-779",
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-779",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 4321,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:50:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
    })

    await execTool(
      "coding_spawn",
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-779",
      },
      {
        currentSession: {
          friendId: "ari",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
        },
      },
    )

    expect(manager.spawnSession).toHaveBeenCalledWith({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-779",
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
    })
    expect(advanceObligation).not.toHaveBeenCalled()
  })

  it("coding_spawn uses a generic start note when a linked obligation has no origin session on the returned session", async () => {
    vi.mocked(findPendingObligationForOrigin).mockReturnValue({
      id: "ob-2",
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      content: "fix the loop",
      status: "pending",
      createdAt: "2026-03-20T00:00:00.000Z",
    } as any)
    manager.spawnSession.mockResolvedValue({
      id: "coding-780",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-780",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 4321,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:50:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
      obligationId: "ob-2",
    })

    await execTool(
      "coding_spawn",
      {
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-780",
      },
      {
        currentSession: {
          friendId: "ari",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
        },
      },
    )

    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-2",
      expect.objectContaining({ latestNote: "coding session started" }),
    )
  })

  it("coding_spawn omits blank optional args", async () => {
    manager.spawnSession.mockResolvedValue({
      id: "coding-009",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      status: "running",
      pid: null,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:50:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
    })

    await execTool("coding_spawn", {
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "plan",
      taskRef: "task-9",
      scopeFile: "   ",
      stateFile: "",
    })

    expect(manager.spawnSession).toHaveBeenCalledWith({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      prompt: "plan",
      taskRef: "task-9",
    })
  })

  it("coding_status returns single-session JSON when sessionId is provided", async () => {
    manager.getSession.mockReturnValue({
      id: "coding-001",
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/slugger",
      status: "waiting_input",
      stdoutTail: "status: NEEDS_REVIEW",
      stderrTail: "",
      pid: 100,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:51:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
    })

    const result = await execTool("coding_status", { sessionId: "coding-001" })
    expect(manager.getSession).toHaveBeenCalledWith("coding-001")
    expect(JSON.parse(result)).toMatchObject({
      id: "coding-001",
      status: "waiting_input",
      stdoutTail: "status: NEEDS_REVIEW",
      stderrTail: "",
    })
  })

  it("coding_status returns not found message for unknown session", async () => {
    manager.getSession.mockReturnValue(null)
    const result = await execTool("coding_status", { sessionId: "coding-missing" })
    expect(result).toContain("session not found: coding-missing")
  })

  it("coding_status returns all sessions when sessionId is omitted", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-001",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        status: "running",
        stdoutTail: "still working",
        stderrTail: "",
        pid: 100,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:51:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
      },
      {
        id: "coding-002",
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        status: "running",
        stdoutTail: "",
        stderrTail: "warning: nested-session guard",
        pid: null,
        startedAt: "2026-03-05T23:52:00.000Z",
        lastActivityAt: "2026-03-05T23:52:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
      },
    ])

    const result = await execTool("coding_status", {})
    expect(manager.listSessions).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result)).toMatchObject([
      expect.objectContaining({
        id: "coding-001",
        stdoutTail: "still working",
        stderrTail: "",
      }),
      expect.objectContaining({
        id: "coding-002",
        stdoutTail: "",
        stderrTail: "warning: nested-session guard",
      }),
    ])
  })

  it("coding_tail returns readable recent stdout/stderr for a session", async () => {
    manager.getSession.mockReturnValue({
      id: "coding-010",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      status: "completed",
      stdoutTail: "all done",
      stderrTail: "",
      pid: null,
      startedAt: "2026-03-05T23:50:00.000Z",
      lastActivityAt: "2026-03-05T23:51:00.000Z",
      endedAt: "2026-03-05T23:52:00.000Z",
      restartCount: 0,
      lastExitCode: 0,
      lastSignal: null,
      failure: null,
    })

    const result = await execTool("coding_tail", { sessionId: "coding-010" })
    expect(formatCodingTail).toHaveBeenCalledWith(expect.objectContaining({ id: "coding-010", runner: "codex" }))
    expect(result).toContain("tail")
    expect(result).toContain("all done")
  })

  it("coding_tail validates sessionId and unknown sessions", async () => {
    expect(await execTool("coding_tail", {})).toContain("sessionId is required")

    manager.getSession.mockReturnValueOnce(null)
    expect(await execTool("coding_tail", { sessionId: "coding-missing" })).toContain("session not found: coding-missing")
  })

  it("coding_send_input validates required args", async () => {
    const missingSessionId = await execTool("coding_send_input", { input: "continue" })
    expect(missingSessionId).toContain("sessionId is required")

    const missingInput = await execTool("coding_send_input", { sessionId: "coding-001" })
    expect(missingInput).toContain("input is required")
  })

  it("coding_send_input returns manager action payload as JSON", async () => {
    manager.sendInput.mockReturnValue({ ok: true, message: "input sent to coding-001" })

    const result = await execTool("coding_send_input", { sessionId: "coding-001", input: "continue" })
    expect(manager.sendInput).toHaveBeenCalledWith("coding-001", "continue")
    expect(JSON.parse(result)).toEqual({ ok: true, message: "input sent to coding-001" })
  })

  it("coding_kill validates sessionId and returns manager action payload as JSON", async () => {
    const missingSessionId = await execTool("coding_kill", {})
    expect(missingSessionId).toContain("sessionId is required")

    manager.killSession.mockReturnValue({ ok: true, message: "killed coding-001" })

    const result = await execTool("coding_kill", { sessionId: "coding-001" })
    expect(manager.killSession).toHaveBeenCalledWith("coding-001")
    expect(JSON.parse(result)).toEqual({ ok: true, message: "killed coding-001" })
  })

  it("execTool emits and rethrows Error values from coding handlers", async () => {
    manager.getSession.mockImplementation(() => {
      throw new Error("manager exploded")
    })
    await expect(execTool("coding_status", { sessionId: "coding-001" })).rejects.toThrow("manager exploded")
  })

  it("summarizeArgs includes coding tool summaries", () => {
    expect(
      summarizeArgs("coding_spawn", {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-9",
      }),
    ).toContain("runner=claude")
    expect(summarizeArgs("coding_status", { sessionId: "coding-001" })).toBe("sessionId=coding-001")
    expect(summarizeArgs("coding_tail", { sessionId: "coding-001" })).toBe("sessionId=coding-001")
    expect(summarizeArgs("coding_send_input", { sessionId: "coding-001", input: "continue" })).toContain("input=continue")
    expect(summarizeArgs("coding_kill", { sessionId: "coding-001" })).toBe("sessionId=coding-001")
  })

  it("summarizeArgs handles unknown tools with empty args", () => {
    expect(summarizeArgs("totally_unknown", {})).toBe("")
  })
})
