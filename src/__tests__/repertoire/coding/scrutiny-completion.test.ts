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

vi.mock("../../../arc/obligations", () => ({
  createObligation: vi.fn(),
  findPendingObligationForOrigin: vi.fn(),
  advanceObligation: vi.fn(),
}))

vi.mock("../../../repertoire/coding/context-pack", () => ({
  prepareCodingContextPack: vi.fn(),
}))

import { getCodingSessionManager, formatCodingTail } from "../../../repertoire/coding"
import { prepareCodingContextPack } from "../../../repertoire/coding/context-pack"
import { advanceObligation, createObligation, findPendingObligationForOrigin } from "../../../arc/obligations"

describe("coding completion scrutiny", () => {
  const manager = {
    spawnSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    killSession: vi.fn(),
  }

  let execTool: (name: string, args: Record<string, string>, ctx?: Record<string, unknown>) => Promise<string>

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(getCodingSessionManager).mockReturnValue(manager as unknown as ReturnType<typeof getCodingSessionManager>)
    vi.mocked(formatCodingTail).mockClear()
    vi.mocked(createObligation).mockReset()
    vi.mocked(createObligation).mockReturnValue({
      id: "ob-created",
      origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      content: "finish task",
      status: "pending",
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
    } as any)
    vi.mocked(findPendingObligationForOrigin).mockReset()
    vi.mocked(findPendingObligationForOrigin).mockReturnValue(undefined)
    vi.mocked(advanceObligation).mockReset()
    vi.mocked(prepareCodingContextPack).mockReset()
    vi.mocked(prepareCodingContextPack).mockReturnValue({
      contextKey: "ctx-123",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      scopeContent: "# scope",
      stateContent: "# state",
    })
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
  })

  it("coding_status includes full scrutiny prompts when completed session touched 3+ files", async () => {
    const session = {
      id: "sess-1",
      runner: "claude",
      workdir: "/tmp",
      status: "completed",
      stdoutTail: "Modified src/a.ts\nModified src/b.ts\nModified src/c.ts\nAll tests pass.",
      stderrTail: "",
      pid: 123,
      startedAt: "2026-03-31T00:00:00Z",
      lastActivityAt: "2026-03-31T00:01:00Z",
      endedAt: "2026-03-31T00:01:00Z",
      restartCount: 0,
      lastExitCode: 0,
      lastSignal: null,
      failure: null,
    }
    manager.getSession.mockReturnValue(session)

    const result = await execTool("coding_status", { sessionId: "sess-1" })
    expect(result).toContain("stranger-with-candy pass")
    expect(result).toContain("tinfoil-hat pass")
  })

  it("coding_status includes short checklist when completed session touched 1-2 files", async () => {
    const session = {
      id: "sess-2",
      runner: "claude",
      workdir: "/tmp",
      status: "completed",
      stdoutTail: "Modified src/a.ts\nAll tests pass.",
      stderrTail: "",
      pid: 123,
      startedAt: "2026-03-31T00:00:00Z",
      lastActivityAt: "2026-03-31T00:01:00Z",
      endedAt: "2026-03-31T00:01:00Z",
      restartCount: 0,
      lastExitCode: 0,
      lastSignal: null,
      failure: null,
    }
    manager.getSession.mockReturnValue(session)

    const result = await execTool("coding_status", { sessionId: "sess-2" })
    expect(result).toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })

  it("coding_status does NOT include scrutiny when session is still running", async () => {
    const session = {
      id: "sess-3",
      runner: "claude",
      workdir: "/tmp",
      status: "running",
      stdoutTail: "Working on src/a.ts\nWorking on src/b.ts\nWorking on src/c.ts",
      stderrTail: "",
      pid: 123,
      startedAt: "2026-03-31T00:00:00Z",
      lastActivityAt: "2026-03-31T00:01:00Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    }
    manager.getSession.mockReturnValue(session)

    const result = await execTool("coding_status", { sessionId: "sess-3" })
    expect(result).not.toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })

  it("coding_tail includes full scrutiny when completed session touched 3+ files", async () => {
    const session = {
      id: "sess-4",
      runner: "claude",
      workdir: "/tmp",
      status: "completed",
      stdoutTail: "Edited src/a.ts\nEdited src/b.ts\nEdited src/c.ts\nDone.",
      stderrTail: "",
      pid: 123,
      startedAt: "2026-03-31T00:00:00Z",
      lastActivityAt: "2026-03-31T00:01:00Z",
      endedAt: "2026-03-31T00:01:00Z",
      restartCount: 0,
      lastExitCode: 0,
      lastSignal: null,
      failure: null,
    }
    manager.getSession.mockReturnValue(session)
    vi.mocked(formatCodingTail).mockReturnValue("tail output with file changes")

    const result = await execTool("coding_tail", { sessionId: "sess-4" })
    expect(result).toContain("stranger-with-candy pass")
    expect(result).toContain("tinfoil-hat pass")
  })

  it("file count is based on distinct file paths in session output", async () => {
    // Same file mentioned multiple times should count as 1
    const session = {
      id: "sess-5",
      runner: "claude",
      workdir: "/tmp",
      status: "completed",
      stdoutTail: "Edited src/a.ts\nUpdated src/a.ts\nFixed src/a.ts",
      stderrTail: "",
      pid: 123,
      startedAt: "2026-03-31T00:00:00Z",
      lastActivityAt: "2026-03-31T00:01:00Z",
      endedAt: "2026-03-31T00:01:00Z",
      restartCount: 0,
      lastExitCode: 0,
      lastSignal: null,
      failure: null,
    }
    manager.getSession.mockReturnValue(session)

    const result = await execTool("coding_status", { sessionId: "sess-5" })
    // Only 1 distinct file -- should be short checklist, not full
    expect(result).toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })

  it("coding_status does NOT include scrutiny when completed session has no file paths", async () => {
    const session = {
      id: "sess-nofiles",
      runner: "claude",
      workdir: "/tmp",
      status: "completed",
      stdoutTail: "Task complete. No files changed.",
      stderrTail: "",
      pid: 123,
      startedAt: "2026-03-31T00:00:00Z",
      lastActivityAt: "2026-03-31T00:01:00Z",
      endedAt: "2026-03-31T00:01:00Z",
      restartCount: 0,
      lastExitCode: 0,
      lastSignal: null,
      failure: null,
    }
    manager.getSession.mockReturnValue(session)

    const result = await execTool("coding_status", { sessionId: "sess-nofiles" })
    expect(result).not.toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })

  it("coding_status without sessionId (list mode) does NOT include scrutiny", async () => {
    manager.listSessions.mockReturnValue([])
    const result = await execTool("coding_status", {})
    expect(result).not.toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })
})
