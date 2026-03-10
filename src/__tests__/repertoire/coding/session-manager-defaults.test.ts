import { describe, expect, it, vi } from "vitest"

class FakeProcess {
  readonly pid: number | undefined
  readonly stdin = {
    write: vi.fn(),
  }
  readonly stdout = {
    on: vi.fn(),
  }
  readonly stderr = {
    on: vi.fn(),
  }
  readonly on = vi.fn()
  readonly kill = vi.fn(() => true)

  constructor(pid?: number) {
    this.pid = pid
  }
}

const noPersistence = {
  existsSync: () => false,
  readFileSync: () => "",
  writeFileSync: () => undefined,
  mkdirSync: () => undefined,
}

describe("coding session manager defaults", () => {
  it("persists to bundle-local state by default", async () => {
    vi.resetModules()

    vi.doMock("../../../heart/identity", () => ({
      getAgentName: vi.fn(() => "slugger"),
      getAgentRoot: vi.fn((agentName = "slugger") => `/mock/AgentBundles/${agentName}.ouro`),
    }))
    vi.doMock("../../../repertoire/coding/spawner", () => ({
      spawnCodingProcess: vi.fn(() => ({
        process: new FakeProcess(321),
        command: "claude",
        args: ["-p"],
        prompt: "hello",
      })),
    }))

    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()

    const { CodingSessionManager } = await import("../../../repertoire/coding/manager")
    const manager = new CodingSessionManager({
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync,
      mkdirSync,
      nowIso: () => "2026-03-05T23:49:00.000Z",
    })

    await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "do it",
      taskRef: "task-do-it",
    })

    expect(mkdirSync).toHaveBeenCalledWith("/mock/AgentBundles/slugger.ouro/state/coding", { recursive: true })
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock/AgentBundles/slugger.ouro/state/coding/sessions.json",
      expect.any(String),
      "utf-8",
    )
  })

  it("uses default spawnCodingProcess wiring when spawnProcess override is omitted", async () => {
    vi.resetModules()

    const fake = new FakeProcess(123)
    const spawnCodingProcess = vi.fn(() => ({
      process: fake,
      command: "claude",
      args: ["-p"],
      prompt: "hello",
    }))

    vi.doMock("../../../repertoire/coding/spawner", () => ({
      spawnCodingProcess,
    }))

    const { CodingSessionManager } = await import("../../../repertoire/coding/manager")
    const manager = new CodingSessionManager({
      ...noPersistence,
      nowIso: () => "2026-03-05T23:50:00.000Z",
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "do it",
      taskRef: "task-do-it",
    })

    expect(session.pid).toBe(123)
    expect(spawnCodingProcess).toHaveBeenCalledWith(
      expect.objectContaining({ runner: "claude", taskRef: "task-do-it" }),
    )
  })

  it("uses default pid liveness checks during restore", async () => {
    vi.resetModules()

    vi.doMock("../../../repertoire/coding/spawner", () => ({
      spawnCodingProcess: vi.fn(() => ({
        process: new FakeProcess(1),
        command: "claude",
        args: [],
        prompt: "",
      })),
    }))

    const { CodingSessionManager } = await import("../../../repertoire/coding/manager")

    const persisted = {
      sequence: 2,
      records: [
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "alive",
            taskRef: "task-alive",
            sessionId: "coding-001",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-001",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-alive",
            status: "running",
            pid: process.pid,
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
          },
        },
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "dead",
            taskRef: "task-dead",
            sessionId: "coding-002",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-002",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-dead",
            status: "running",
            pid: 999_999_999,
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
          },
        },
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(333)),
      nowIso: () => "2026-03-07T00:10:00.000Z",
      stateFilePath: "/tmp/coding-default-pid-check.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(persisted),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })

    expect(manager.getSession("coding-001")?.status).toBe("running")
    expect(manager.getSession("coding-002")?.status).toBe("failed")
  })
})
