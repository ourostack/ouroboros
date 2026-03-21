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
  createObligation: vi.fn(),
  findPendingObligationForOrigin: vi.fn(),
  advanceObligation: vi.fn(),
}))

import { attachCodingSessionFeedback, formatCodingTail, getCodingSessionManager } from "../../../repertoire/coding"
import { advanceObligation, createObligation, findPendingObligationForOrigin } from "../../../heart/obligations"

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
    vi.mocked(createObligation).mockReset()
    vi.mocked(createObligation).mockReturnValue({
      id: "ob-created",
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      content: "finish task and bring the result back",
      status: "pending",
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
    } as any)
    vi.mocked(findPendingObligationForOrigin).mockReset()
    vi.mocked(findPendingObligationForOrigin).mockReturnValue(undefined)
    vi.mocked(advanceObligation).mockReset()
    manager.spawnSession.mockReset()
    manager.getSession.mockReset()
    manager.listSessions.mockReset()
    manager.listSessions.mockReturnValue([])
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

  it("coding_spawn reuses an active matching session instead of spawning another one", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-123",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-123",
        scopeFile: "/tmp/scope.md",
        stateFile: "/tmp/state.md",
        status: "running",
        stdoutTail: "still working",
        stderrTail: "",
        pid: 4321,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:55:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
    ])

    const result = await execTool("coding_spawn", {
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-123",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
    })

    expect(manager.spawnSession).not.toHaveBeenCalled()
    expect(JSON.parse(result)).toMatchObject({
      id: "coding-123",
      reused: true,
      status: "running",
    })
  })

  it("coding_spawn prefers the newest matching active session when duplicates already exist", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-010",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-123",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 410,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:54:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
      {
        id: "coding-011",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-123",
        status: "waiting_input",
        stdoutTail: "needs review",
        stderrTail: "",
        pid: 411,
        startedAt: "2026-03-05T23:51:00.000Z",
        lastActivityAt: "2026-03-05T23:56:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
    ])

    const result = await execTool("coding_spawn", {
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-123",
    })

    expect(manager.spawnSession).not.toHaveBeenCalled()
    expect(JSON.parse(result)).toMatchObject({ id: "coding-011", reused: true, status: "waiting_input" })
  })

  it("coding_spawn breaks same-activity ties by newer session id", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-020",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-tie",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 420,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:56:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
      {
        id: "coding-021",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-tie",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 421,
        startedAt: "2026-03-05T23:51:00.000Z",
        lastActivityAt: "2026-03-05T23:56:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
    ])

    const result = await execTool("coding_spawn", {
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-tie",
    })

    expect(manager.spawnSession).not.toHaveBeenCalled()
    expect(JSON.parse(result)).toMatchObject({ id: "coding-021", reused: true })
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

  it("coding_spawn attaches coding feedback relay when reusing an active session", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-333",
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-333",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 333,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:55:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
    ])
    const feedback = { send: vi.fn().mockResolvedValue(undefined) }

    const result = await execTool(
      "coding_spawn",
      {
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-333",
      },
      { codingFeedback: feedback },
    )

    expect(manager.spawnSession).not.toHaveBeenCalled()
    expect(attachCodingSessionFeedback).toHaveBeenCalledWith(manager, expect.objectContaining({ id: "coding-333" }), feedback)
    expect(JSON.parse(result)).toMatchObject({ id: "coding-333", reused: true })
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
      obligationId: "ob-created",
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
      obligationId: "ob-created",
    })
    expect(createObligation).toHaveBeenCalledWith("/Users/test/AgentBundles/slugger.ouro", {
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      content: "finish task-779 and bring the result back",
    })
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-created",
      expect.objectContaining({
        status: "investigating",
        currentSurface: { kind: "coding", label: "claude coding-779" },
      }),
    )
  })

  it("coding_spawn does not reuse sessions from another origin thread", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-900",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-900",
        status: "running",
        stdoutTail: "still working",
        stderrTail: "",
        pid: 900,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:55:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "other", channel: "bluebubbles", key: "chat" },
      },
    ])
    manager.spawnSession.mockResolvedValue({
      id: "coding-901",
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-900",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 901,
      startedAt: "2026-03-05T23:56:00.000Z",
      lastActivityAt: "2026-03-05T23:56:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
    })

    const result = await execTool(
      "coding_spawn",
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-900",
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
      taskRef: "task-900",
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      obligationId: "ob-created",
    })
    expect(JSON.parse(result)).toMatchObject({ id: "coding-901" })
  })

  it("coding_spawn does not reuse inactive matching sessions", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-902",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-902",
        status: "completed",
        stdoutTail: "done",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:55:00.000Z",
        endedAt: "2026-03-05T23:56:00.000Z",
        restartCount: 0,
        lastExitCode: 0,
        lastSignal: null,
        failure: null,
      },
    ])
    manager.spawnSession.mockResolvedValue({
      id: "coding-903",
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-902",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 903,
      startedAt: "2026-03-05T23:57:00.000Z",
      lastActivityAt: "2026-03-05T23:57:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    })

    const result = await execTool("coding_spawn", {
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-902",
    })

    expect(manager.spawnSession).toHaveBeenCalledWith({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-902",
    })
    expect(JSON.parse(result)).toMatchObject({ id: "coding-903" })
  })

  it("coding_spawn reuses matching sessions when origin provenance matches", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-904",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-904",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 904,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:55:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
    ])

    const result = await execTool(
      "coding_spawn",
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-904",
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

    expect(manager.spawnSession).not.toHaveBeenCalled()
    expect(JSON.parse(result)).toMatchObject({ id: "coding-904", reused: true })
  })

  it("coding_spawn does not reuse sessions when origin provenance is missing on one side", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-905",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "task-905",
        status: "running",
        stdoutTail: "",
        stderrTail: "",
        pid: 905,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:55:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
    ])
    manager.spawnSession.mockResolvedValue({
      id: "coding-906",
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      taskRef: "task-905",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 906,
      startedAt: "2026-03-05T23:56:00.000Z",
      lastActivityAt: "2026-03-05T23:56:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      obligationId: "ob-created",
    })

    const result = await execTool(
      "coding_spawn",
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        taskRef: "task-905",
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
      taskRef: "task-905",
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      obligationId: "ob-created",
    })
    expect(JSON.parse(result)).toMatchObject({ id: "coding-906" })
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

  it("coding_status prefers active sessions for the current origin and hides stale closed history by default", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-001",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        taskRef: "old-task",
        status: "completed",
        stdoutTail: "done",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:40:00.000Z",
        lastActivityAt: "2026-03-05T23:41:00.000Z",
        endedAt: "2026-03-05T23:41:00.000Z",
        restartCount: 0,
        lastExitCode: 0,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
      {
        id: "coding-012",
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "other-thread",
        status: "running",
        stdoutTail: "working elsewhere",
        stderrTail: "",
        pid: 12,
        startedAt: "2026-03-05T23:52:00.000Z",
        lastActivityAt: "2026-03-05T23:58:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "other", channel: "cli", key: "session" },
      },
      {
        id: "coding-013",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "current-thread",
        status: "waiting_input",
        stdoutTail: "needs review",
        stderrTail: "",
        pid: 13,
        startedAt: "2026-03-05T23:53:00.000Z",
        lastActivityAt: "2026-03-05T23:59:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
    ])

    const result = await execTool("coding_status", {}, {
      currentSession: {
        friendId: "ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
      },
    })

    expect(JSON.parse(result)).toMatchObject([
      expect.objectContaining({ id: "coding-013", status: "waiting_input" }),
      expect.objectContaining({ id: "coding-012", status: "running" }),
    ])
    expect(result).not.toContain("\"coding-001\"")
  })

  it("coding_status falls back to the newest relevant closed sessions when nothing is active", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-001",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        taskRef: "old-task",
        status: "completed",
        stdoutTail: "done",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:40:00.000Z",
        lastActivityAt: "2026-03-05T23:41:00.000Z",
        endedAt: "2026-03-05T23:41:00.000Z",
        restartCount: 0,
        lastExitCode: 0,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
      {
        id: "coding-020",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        taskRef: "unrelated-thread",
        status: "completed",
        stdoutTail: "done elsewhere",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:58:00.000Z",
        endedAt: "2026-03-05T23:58:00.000Z",
        restartCount: 0,
        lastExitCode: 0,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "other", channel: "cli", key: "session" },
      },
      {
        id: "coding-021",
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        taskRef: "current-thread",
        status: "killed",
        stdoutTail: "interrupted",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:54:00.000Z",
        lastActivityAt: "2026-03-06T00:01:00.000Z",
        endedAt: "2026-03-06T00:01:00.000Z",
        restartCount: 0,
        lastExitCode: null,
        lastSignal: "SIGTERM",
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
    ])

    const result = await execTool("coding_status", {}, {
      currentSession: {
        friendId: "ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
      },
    })

    expect(JSON.parse(result)).toMatchObject([
      expect.objectContaining({ id: "coding-021", status: "killed" }),
      expect.objectContaining({ id: "coding-001", status: "completed" }),
    ])
    expect(result).not.toContain("\"coding-020\"")
  })

  it("coding_status breaks same-rank active ties by latest activity and newer session id", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-013",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "current-thread",
        status: "running",
        stdoutTail: "working",
        stderrTail: "",
        pid: 13,
        startedAt: "2026-03-05T23:53:00.000Z",
        lastActivityAt: "2026-03-05T23:59:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
      {
        id: "coding-014",
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "current-thread",
        status: "waiting_input",
        stdoutTail: "needs answer",
        stderrTail: "",
        pid: 14,
        startedAt: "2026-03-05T23:54:00.000Z",
        lastActivityAt: "2026-03-05T23:59:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      },
    ])

    const result = await execTool("coding_status", {}, {
      currentSession: {
        friendId: "ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
      },
    })

    expect(JSON.parse(result)).toMatchObject([
      expect.objectContaining({ id: "coding-014", status: "waiting_input" }),
      expect.objectContaining({ id: "coding-013", status: "running" }),
    ])
  })

  it("coding_status falls back to newest global history when the current thread has no matching sessions", async () => {
    manager.listSessions.mockReturnValue([
      {
        id: "coding-020",
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "other-thread",
        status: "completed",
        stdoutTail: "done elsewhere",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:50:00.000Z",
        lastActivityAt: "2026-03-05T23:58:00.000Z",
        endedAt: "2026-03-05T23:58:00.000Z",
        restartCount: 0,
        lastExitCode: 0,
        lastSignal: null,
        failure: null,
        originSession: { friendId: "other", channel: "cli", key: "session" },
      },
      {
        id: "coding-021",
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        taskRef: "another-thread",
        status: "killed",
        stdoutTail: "interrupted",
        stderrTail: "",
        pid: null,
        startedAt: "2026-03-05T23:54:00.000Z",
        lastActivityAt: "2026-03-06T00:01:00.000Z",
        endedAt: "2026-03-06T00:01:00.000Z",
        restartCount: 0,
        lastExitCode: null,
        lastSignal: "SIGTERM",
        failure: null,
        originSession: { friendId: "someone-else", channel: "teams", key: "thread" },
      },
    ])

    const result = await execTool("coding_status", {}, {
      currentSession: {
        friendId: "ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
      },
    })

    expect(JSON.parse(result)).toMatchObject([
      expect.objectContaining({ id: "coding-021", status: "killed" }),
      expect.objectContaining({ id: "coding-020", status: "completed" }),
    ])
  })

  it("coding_status returns an empty list when there are no sessions", async () => {
    manager.listSessions.mockReturnValue([])

    const result = await execTool("coding_status", {}, {
      currentSession: {
        friendId: "ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/ari/bluebubbles/chat.json",
      },
    })

    expect(JSON.parse(result)).toEqual([])
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
