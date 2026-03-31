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

describe("coding session manager persistence", () => {
  it("persists session state on spawn", async () => {
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(101)),
      nowIso: () => "2026-03-07T00:00:00.000Z",
      stateFilePath: "/tmp/coding-persist.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync,
      mkdirSync,
    })

    await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/project",
      prompt: "do work",
      taskRef: "task-1",
    })

    expect(mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true })
    expect(writeFileSync).toHaveBeenCalledWith("/tmp/coding-persist.json", expect.any(String), "utf-8")
    expect(writeFileSync).toHaveBeenCalledWith("/tmp/coding-001.md", expect.any(String), "utf-8")
    const stateWrite = writeFileSync.mock.calls.find((call) => call[0] === "/tmp/coding-persist.json")
    const [, payload] = stateWrite as [string, string]
    const parsed = JSON.parse(payload) as {
      sequence: number
      records: Array<{ request: { sessionId: string; parentAgent: string }; session: { artifactPath: string; checkpoint: string | null } }>
    }
    expect(parsed.sequence).toBe(1)
    expect(parsed.records[0].request.sessionId).toBe("coding-001")
    expect(parsed.records[0].request.parentAgent).toBe("default")
    expect(parsed.records[0].session.artifactPath).toBe("/tmp/coding-001.md")
    expect(parsed.records[0].session.checkpoint).toBeNull()

    const artifactWrite = writeFileSync.mock.calls.find((call) => call[0] === "/tmp/coding-001.md")
    expect(artifactWrite?.[1]).toContain("# Coding Session Artifact")
    expect(artifactWrite?.[1]).toContain("checkpoint: none")
  })

  it("persists origin-session provenance and obligation linkage on spawn", async () => {
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(101)),
      nowIso: () => "2026-03-07T00:00:00.000Z",
      stateFilePath: "/tmp/coding-persist-provenance.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync,
      mkdirSync,
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/project",
      prompt: "do work",
      taskRef: "task-1",
      originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
      obligationId: "ob-1",
    } as any)

    expect((session as any).originSession).toEqual({ friendId: "ari", channel: "bluebubbles", key: "chat" })
    expect((session as any).obligationId).toBe("ob-1")

    const stateWrite = writeFileSync.mock.calls.find((call) => call[0] === "/tmp/coding-persist-provenance.json")
    const [, payload] = stateWrite as [string, string]
    const parsed = JSON.parse(payload)
    expect(parsed.records[0].request.originSession).toEqual({ friendId: "ari", channel: "bluebubbles", key: "chat" })
    expect(parsed.records[0].request.obligationId).toBe("ob-1")
    expect(parsed.records[0].session.originSession).toEqual({ friendId: "ari", channel: "bluebubbles", key: "chat" })
    expect(parsed.records[0].session.obligationId).toBe("ob-1")
    expect(parsed.records[0].session.artifactPath).toBe("/tmp/coding-001.md")
  })

  it("rehydrates persisted sessions and advances sequence", async () => {
    const persisted = {
      sequence: 3,
      records: [
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "resume",
            taskRef: "task-3",
            sessionId: "coding-003",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-003",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-3",
            status: "running",
            pid: 4242,
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
      spawnProcess: vi.fn(() => new FakeProcess(5000)),
      nowIso: () => "2026-03-07T00:05:00.000Z",
      stateFilePath: "/tmp/coding-rehydrate.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(persisted),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      pidAlive: () => true,
    })

    expect(manager.listSessions()).toHaveLength(1)
    expect(manager.getSession("coding-003")?.status).toBe("running")

    const spawned = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "new work",
      taskRef: "task-4",
    })
    expect(spawned.id).toBe("coding-004")
  })

  it("rehydrates origin-session provenance and obligation linkage", () => {
    const persisted = {
      sequence: 1,
      records: [
        {
          request: {
            runner: "codex",
            workdir: "/tmp/repo",
            prompt: "resume",
            taskRef: "task-1",
            sessionId: "coding-001",
            parentAgent: "slugger",
            originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
            obligationId: "ob-1",
          },
          session: {
            id: "coding-001",
            runner: "codex",
            workdir: "/tmp/repo",
            taskRef: "task-1",
            status: "running",
            pid: 4242,
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
            originSession: { friendId: "ari", channel: "bluebubbles", key: "chat" },
            obligationId: "ob-1",
          },
        },
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(5000)),
      nowIso: () => "2026-03-07T00:05:00.000Z",
      stateFilePath: "/tmp/coding-rehydrate-provenance.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(persisted),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      pidAlive: () => true,
    })

    expect((manager.getSession("coding-001") as any)?.originSession).toEqual({
      friendId: "ari",
      channel: "bluebubbles",
      key: "chat",
    })
    expect((manager.getSession("coding-001") as any)?.obligationId).toBe("ob-1")
  })

  it("marks stale running sessions as failed during restore", () => {
    const persisted = {
      sequence: 2,
      records: [
        {
          request: {
            runner: "codex",
            workdir: "/tmp/repo",
            prompt: "restore",
            taskRef: "task-2",
            sessionId: "coding-002",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-002",
            runner: "codex",
            workdir: "/tmp/repo",
            taskRef: "task-2",
            status: "running",
            pid: 9999,
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
      spawnProcess: vi.fn(() => new FakeProcess(123)),
      nowIso: () => "2026-03-07T00:10:00.000Z",
      stateFilePath: "/tmp/coding-stale.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(persisted),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      pidAlive: () => false,
    })

    const restored = manager.getSession("coding-002")
    expect(restored?.status).toBe("failed")
    expect(restored?.pid).toBeNull()
    expect(restored?.failure?.stderrTail).toContain("process not running")
  })

  it("ignores malformed persisted JSON", () => {
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(1)),
      stateFilePath: "/tmp/coding-invalid.json",
      existsSync: () => true,
      readFileSync: () => "{not valid",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })

    expect(manager.listSessions()).toEqual([])
  })

  it("ignores persisted payloads with non-array records and read errors", () => {
    const readErrorManager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(1)),
      stateFilePath: "/tmp/coding-read-error.json",
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("read denied")
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })
    expect(readErrorManager.listSessions()).toEqual([])

    const malformedRecordsManager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(2)),
      stateFilePath: "/tmp/coding-records-error.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ sequence: 9, records: null }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })
    expect(malformedRecordsManager.listSessions()).toEqual([])
  })

  it("skips invalid persisted entries and keeps valid records", () => {
    const payload = {
      sequence: 5,
      records: [
        {
          request: null,
          session: null,
        },
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "resume",
            taskRef: "task-good",
            sessionId: "coding-005",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-005",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-good",
            status: "completed",
            pid: null,
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: "2026-03-07T00:05:00.000Z",
            restartCount: 0,
            lastExitCode: 0,
            lastSignal: null,
            failure: null,
          },
        },
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(3)),
      stateFilePath: "/tmp/coding-skip-invalid.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(payload),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })

    expect(manager.listSessions()).toHaveLength(1)
    expect(manager.getSession("coding-005")?.status).toBe("completed")
  })

  it("normalizes missing persisted request identity fields and invalid sequence values", async () => {
    const payload = {
      sequence: "bad-sequence",
      records: [
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "restore",
            taskRef: "task-10",
          },
          session: {
            id: "coding-010",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-10",
            status: "completed",
            pid: null,
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: "2026-03-07T00:01:00.000Z",
            restartCount: 0,
            lastExitCode: 0,
            lastSignal: null,
            failure: null,
          },
        },
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(321)),
      stateFilePath: "/tmp/coding-normalize.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(payload),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      agentName: "fallback-agent",
    })

    const record = (manager as any).records.get("coding-010")
    expect(record.request.sessionId).toBe("coding-010")
    expect(record.request.parentAgent).toBe("fallback-agent")

    const spawned = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "new",
      taskRef: "task-11",
    })
    expect(spawned.id).toBe("coding-011")
  })

  it("handles non-standard restored ids and non-Error load failures", async () => {
    const payload = {
      sequence: -1,
      records: [
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "restore",
            taskRef: "task-manual",
          },
          session: {
            id: "manual-session",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-manual",
            status: "completed",
            pid: null,
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: "2026-03-07T00:01:00.000Z",
            restartCount: 0,
            lastExitCode: 0,
            lastSignal: null,
            failure: null,
          },
        },
      ],
    }

    const restored = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(901)),
      stateFilePath: "/tmp/coding-manual-id.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(payload),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })
    expect(restored.getSession("manual-session")?.status).toBe("completed")
    const spawned = await restored.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "new",
      taskRef: "task-next",
    })
    expect(spawned.id).toBe("coding-001")

    const readFailure = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(902)),
      stateFilePath: "/tmp/coding-read-string-error.json",
      existsSync: () => true,
      readFileSync: () => {
        throw "read-failed-string"
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    })
    expect(readFailure.listSessions()).toEqual([])

    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "parse-failed-string"
    })
    try {
      const parseFailure = new CodingSessionManager({
        spawnProcess: vi.fn(() => new FakeProcess(903)),
        stateFilePath: "/tmp/coding-parse-string-error.json",
        existsSync: () => true,
        readFileSync: () => "{\"sequence\":1,\"records\":[]}",
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      })
      expect(parseFailure.listSessions()).toEqual([])
    } finally {
      parseSpy.mockRestore()
    }
  })

  it("continues when persisting state fails", async () => {
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(77)),
      stateFilePath: "/tmp/coding-write-error.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: () => {
        throw new Error("disk full")
      },
      mkdirSync: () => undefined,
    })

    await expect(
      manager.spawnSession({
        runner: "claude",
        workdir: "/tmp/repo",
        prompt: "work",
        taskRef: "task-x",
      }),
    ).resolves.toBeDefined()
  })

  it("stringifies non-Error persist failures", async () => {
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(88)),
      stateFilePath: "/tmp/coding-write-string-error.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: () => {
        throw "disk-failure"
      },
      mkdirSync: () => undefined,
    })

    await expect(
      manager.spawnSession({
        runner: "claude",
        workdir: "/tmp/repo",
        prompt: "work",
        taskRef: "task-string-error",
      }),
    ).resolves.toBeDefined()
  })

  it("captures command and stderr/stdout tails on terminal failure", async () => {
    const proc = new FakeProcess(900)
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => ({
        process: proc,
        command: "claude",
        args: ["-p", "--input-format", "stream-json"],
        prompt: "hello",
      })),
      stateFilePath: "/tmp/coding-failure.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      maxRestarts: 0,
      nowIso: () => "2026-03-07T00:20:00.000Z",
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "do",
      taskRef: "task-fail",
    })

    proc.emitStdout("stdout payload")
    proc.emitStderr("stderr payload")
    proc.emitExit(1, "SIGTERM")

    const failed = manager.getSession(session.id)
    expect(failed?.status).toBe("failed")
    expect(failed?.failure).toMatchObject({
      command: "claude",
      args: ["-p", "--input-format", "stream-json"],
      code: 1,
      signal: "SIGTERM",
    })
    expect(failed?.failure?.stdoutTail).toContain("stdout payload")
    expect(failed?.failure?.stderrTail).toContain("stderr payload")
    expect(failed?.checkpoint).toBe("stderr payload")
    expect(failed?.artifactPath).toBe("/tmp/coding-001.md")
  })

  it("derives signal-based checkpoints and renders null exit codes in artifacts", async () => {
    const proc = new FakeProcess(905)
    const writeFileSync = vi.fn()
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => ({
        process: proc,
        command: "claude",
        args: ["-p"],
        prompt: "hello",
      })),
      stateFilePath: "/tmp/coding-null-code-failure.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync,
      mkdirSync: vi.fn(),
      maxRestarts: 0,
      nowIso: () => "2026-03-07T00:21:00.000Z",
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "do",
      taskRef: "task-null-code",
    })

    proc.emitExit(null, "SIGTERM")

    const failed = manager.getSession(session.id)
    expect(failed?.checkpoint).toBe("terminated by SIGTERM")

    const artifactWrite = writeFileSync.mock.calls.filter((call) => call[0] === "/tmp/coding-001.md").at(-1)
    expect(artifactWrite?.[1]).toContain("code: null")
    expect(artifactWrite?.[1]).toContain("signal: SIGTERM")
  })

  it("derives a fallback checkpoint when an output chunk has no meaningful line", async () => {
    const proc = new FakeProcess(901)
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => proc),
      stateFilePath: "/tmp/coding-empty-output.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      nowIso: () => "2026-03-07T00:20:00.000Z",
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "do",
      taskRef: "task-empty-output",
    })

    proc.emitStdout("   \n")

    expect(manager.getSession(session.id)?.checkpoint).toBeNull()
  })

  it("keeps an existing checkpoint when a later output chunk is blank", async () => {
    const proc = new FakeProcess(910)
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => proc),
      stateFilePath: "/tmp/coding-blank-followup.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      nowIso: () => "2026-03-07T00:20:00.000Z",
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "do",
      taskRef: "task-blank-followup",
    })

    proc.emitStdout("working on it\n")
    proc.emitStdout("   \n")

    expect(manager.getSession(session.id)?.checkpoint).toBe("working on it")
  })

  it("uses a no-output checkpoint when a running session stalls", async () => {
    const now = "2026-03-07T00:20:00.000Z"
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(906)),
      stateFilePath: "/tmp/coding-stall-fallback.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      nowIso: () => now,
      defaultStallThresholdMs: 10,
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "do",
      taskRef: "task-stall-fallback",
      autoRestartOnStall: false,
    })

    expect(manager.checkStalls(Date.parse(now) + 100)).toBe(1)
    expect(manager.getSession(session.id)?.checkpoint).toBe("no recent output")
  })

  it("continues when the artifact directory cannot be prepared", async () => {
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(902)),
      stateFilePath: "/tmp/coding-artifact-dir-error.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: vi.fn(),
      mkdirSync: (target: string) => {
        if (target === "/tmp/coding-artifacts") {
          throw new Error("artifact mkdir denied")
        }
      },
      artifactDirPath: "/tmp/coding-artifacts",
    })

    await expect(
      manager.spawnSession({
        runner: "claude",
        workdir: "/tmp/repo",
        prompt: "work",
        taskRef: "task-artifact-dir",
      }),
    ).resolves.toBeDefined()
  })

  it("stringifies non-Error artifact directory failures", async () => {
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(907)),
      stateFilePath: "/tmp/coding-artifact-dir-string-error.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: vi.fn(),
      mkdirSync: (target: string) => {
        if (target === "/tmp/coding-artifacts-string-error") {
          throw "artifact mkdir denied"
        }
      },
      artifactDirPath: "/tmp/coding-artifacts-string-error",
    })

    await expect(
      manager.spawnSession({
        runner: "claude",
        workdir: "/tmp/repo",
        prompt: "work",
        taskRef: "task-artifact-dir-string",
      }),
    ).resolves.toBeDefined()
  })

  it("continues when writing an individual artifact fails", async () => {
    const writeFileSync = vi.fn((target: string) => {
      if (target === "/tmp/coding-artifacts/coding-001.md") {
        throw new Error("artifact write denied")
      }
    })

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(903)),
      stateFilePath: "/tmp/coding-artifact-write-error.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync,
      mkdirSync: () => undefined,
      artifactDirPath: "/tmp/coding-artifacts",
    })

    await expect(
      manager.spawnSession({
        runner: "claude",
        workdir: "/tmp/repo",
        prompt: "work",
        taskRef: "task-artifact-write",
      }),
    ).resolves.toBeDefined()

    expect(writeFileSync).toHaveBeenCalledWith("/tmp/coding-artifact-write-error.json", expect.any(String), "utf-8")
    expect(writeFileSync).toHaveBeenCalledWith("/tmp/coding-artifacts/coding-001.md", expect.any(String), "utf-8")
  })

  it("recomputes missing artifact paths while persisting artifacts", async () => {
    const writeFileSync = vi.fn(() => {
      throw "artifact write denied"
    })
    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(908)),
      stateFilePath: "/tmp/coding-artifact-recompute.json",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync,
      mkdirSync: () => undefined,
      artifactDirPath: "/tmp/coding-artifacts-recompute",
    })

    const session = await manager.spawnSession({
      runner: "claude",
      workdir: "/tmp/repo",
      prompt: "work",
      taskRef: "task-artifact-recompute",
    })

    const record = (manager as any).records.get(session.id)
    Object.defineProperty(record.session, "artifactPath", {
      configurable: true,
      enumerable: true,
      get: () => undefined,
      set: () => undefined,
    })

    expect(() => (manager as any).persistArtifacts()).not.toThrow()
    expect(writeFileSync).toHaveBeenCalledWith(undefined, expect.any(String), "utf-8")
  })

  it("covers active-status restoration branches and taskRef fallback from request", () => {
    const makeRecord = (id: string, status: string) => ({
      request: {
        runner: "claude",
        workdir: "/tmp/repo",
        prompt: `restore ${id}`,
        taskRef: `request-${id}`,
        sessionId: id,
        parentAgent: "slugger",
      },
      session: {
        id,
        runner: "claude",
        workdir: "/tmp/repo",
        status,
        pid: 424242,
        startedAt: "2026-03-07T00:00:00.000Z",
        lastActivityAt: "2026-03-07T00:00:00.000Z",
        endedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastSignal: null,
        failure: null,
      },
    })

    const payload = {
      sequence: 5,
      records: [
        makeRecord("coding-101", "spawning"),
        makeRecord("coding-102", "running"),
        makeRecord("coding-103", "waiting_input"),
        makeRecord("coding-104", "stalled"),
        makeRecord("coding-105", "completed"),
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(111)),
      stateFilePath: "/tmp/coding-active-statuses.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(payload),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      pidAlive: () => false,
      nowIso: () => "2026-03-07T00:30:00.000Z",
    })

    expect(manager.getSession("coding-101")?.status).toBe("failed")
    expect(manager.getSession("coding-102")?.status).toBe("failed")
    expect(manager.getSession("coding-103")?.status).toBe("failed")
    expect(manager.getSession("coding-104")?.status).toBe("failed")
    expect(manager.getSession("coding-105")?.status).toBe("completed")
    expect(manager.getSession("coding-102")?.taskRef).toBe("request-coding-102")
  })

  it("restores fallback checkpoints for waiting_input and killed sessions", () => {
    const payload = {
      sequence: 2,
      records: [
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "restore waiting",
            taskRef: "task-waiting",
            sessionId: "coding-201",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-201",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-waiting",
            status: "waiting_input",
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
            stdoutTail: "",
            stderrTail: "",
          },
        },
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "restore killed",
            taskRef: "task-killed",
            sessionId: "coding-202",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-202",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-killed",
            status: "killed",
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:00:00.000Z",
            endedAt: "2026-03-07T00:10:00.000Z",
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
            stdoutTail: "",
            stderrTail: "",
          },
        },
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(904)),
      stateFilePath: "/tmp/coding-fallback-checkpoints.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(payload),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      pidAlive: () => true,
      nowIso: () => "2026-03-07T00:30:00.000Z",
    })

    expect(manager.getSession("coding-201")?.checkpoint).toBe("needs input")
    expect(manager.getSession("coding-202")?.checkpoint).toBe("terminated by parent agent")
  })

  it("preserves restored checkpoint and artifactPath strings", () => {
    const payload = {
      sequence: 1,
      records: [
        {
          request: {
            runner: "claude",
            workdir: "/tmp/repo",
            prompt: "restore",
            taskRef: "task-preserved",
            sessionId: "coding-301",
            parentAgent: "slugger",
          },
          session: {
            id: "coding-301",
            runner: "claude",
            workdir: "/tmp/repo",
            taskRef: "task-preserved",
            status: "completed",
            startedAt: "2026-03-07T00:00:00.000Z",
            lastActivityAt: "2026-03-07T00:05:00.000Z",
            endedAt: "2026-03-07T00:06:00.000Z",
            restartCount: 0,
            lastExitCode: 0,
            lastSignal: null,
            failure: null,
            stdoutTail: "",
            stderrTail: "",
            checkpoint: "waiting on review",
            artifactPath: "/tmp/custom-artifacts/coding-301.md",
          },
        },
      ],
    }

    const manager = new CodingSessionManager({
      spawnProcess: vi.fn(() => new FakeProcess(909)),
      stateFilePath: "/tmp/coding-preserved-fields.json",
      existsSync: () => true,
      readFileSync: () => JSON.stringify(payload),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      pidAlive: () => true,
    })

    expect(manager.getSession("coding-301")?.checkpoint).toBe("waiting on review")
    expect(manager.getSession("coding-301")?.artifactPath).toBe("/tmp/custom-artifacts/coding-301.md")
  })
})
