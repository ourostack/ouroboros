import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createEvolutionCase, readEvolutionCase, readEvolutionTrace, setEvolutionAuthority } from "../../../arc/evolution"
import { CodingSessionManager } from "../../../repertoire/coding/manager"

const mockRuntime = vi.hoisted(() => ({
  agentRoot: "",
  manager: {
    spawnSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    killSession: vi.fn(),
  },
}))

vi.mock("../../../repertoire/coding", () => ({
  getCodingSessionManager: vi.fn(() => mockRuntime.manager),
  attachCodingSessionFeedback: vi.fn(),
  formatCodingTail: vi.fn((session: { stdoutTail?: string; stderrTail?: string }) =>
    `tail\n${session.stdoutTail ?? ""}\n${session.stderrTail ?? ""}`.trim(),
  ),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => mockRuntime.agentRoot),
}))

vi.mock("../../../arc/obligations", () => ({
  createObligation: vi.fn(),
  findPendingObligationForOrigin: vi.fn(() => undefined),
  advanceObligation: vi.fn(),
}))

vi.mock("../../../repertoire/coding/context-pack", () => ({
  prepareCodingContextPack: vi.fn(() => ({
    contextKey: "ctx-evolution",
    scopeFile: "/tmp/generated-evolution-scope.md",
    stateFile: "/tmp/generated-evolution-state.md",
    scopeContent: "# scope",
    stateContent: "# state",
  })),
}))

class FakeProcess {
  readonly pid: number
  readonly stdin = { write: vi.fn() }
  readonly stdout = { on: vi.fn() }
  readonly stderr = { on: vi.fn() }
  readonly on = vi.fn()
  readonly kill = vi.fn(() => true)

  constructor(pid: number) {
    this.pid = pid
  }
}

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-evolution-"))
  tempDirs.push(dir)
  return dir
}

function makeEvolutionCase(agentRoot: string, title = "Fix delegated harness friction"): string {
  return createEvolutionCase(agentRoot, {
    title,
    problemStatement: "A material harness failure needs delegated implementation",
    desiredBehavior: "Delegation is budgeted and traceable",
    origin: {
      kind: "runtime",
      label: "unit test",
      locator: "test://coding-evolution",
    },
    budgetProfile: "trusted-local",
  }).id
}

async function execCodingSpawn(args: Record<string, string>): Promise<string> {
  const { codingToolDefinitions } = await import("../../../repertoire/coding/tools")
  const definition = codingToolDefinitions.find((item) => item.tool.function.name === "coding_spawn")
  if (!definition) throw new Error("coding_spawn tool definition missing")
  return await definition.handler(args)
}

beforeEach(() => {
  vi.resetModules()
  mockRuntime.agentRoot = makeAgentRoot()
  mockRuntime.manager.spawnSession.mockReset()
  mockRuntime.manager.getSession.mockReset()
  mockRuntime.manager.listSessions.mockReset()
  mockRuntime.manager.listSessions.mockReturnValue([])
  mockRuntime.manager.subscribe.mockReset()
  mockRuntime.manager.subscribe.mockReturnValue(() => {})
  mockRuntime.manager.sendInput.mockReset()
  mockRuntime.manager.killSession.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("coding evolution binding", () => {
  it("persists evolutionCaseId on coding session requests and sessions", async () => {
    let persisted = ""
    const manager = new CodingSessionManager({
      agentName: "test-coding-agent",
      spawnProcess: vi.fn(() => new FakeProcess(4312)),
      nowIso: () => "2026-05-23T21:30:00.000Z",
      stateFilePath: "/tmp/coding-evolution-state.json",
      artifactDirPath: "/tmp/coding-evolution-artifacts",
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: (target, content) => {
        if (target === "/tmp/coding-evolution-state.json") {
          persisted = content
        }
      },
      mkdirSync: () => undefined,
    })

    const session = await manager.spawnSession({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute the doing doc",
      taskRef: "task-evolution",
      evolutionCaseId: "evo-123",
    })
    const state = JSON.parse(persisted)

    expect(session.evolutionCaseId).toBe("evo-123")
    expect(manager.getSession(session.id)?.evolutionCaseId).toBe("evo-123")
    expect(state.records[0].request.evolutionCaseId).toBe("evo-123")
    expect(state.records[0].session.evolutionCaseId).toBe("evo-123")
  })

  it("coding_spawn attaches spawned sessions to an allowed evolution case and spends its coding budget", async () => {
    const evolutionCaseId = makeEvolutionCase(mockRuntime.agentRoot)
    mockRuntime.manager.spawnSession.mockResolvedValue({
      id: "coding-700",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-evolution",
      evolutionCaseId,
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 700,
      startedAt: "2026-05-23T21:31:00.000Z",
      lastActivityAt: "2026-05-23T21:31:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    })

    const result = await execCodingSpawn({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-evolution",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      evolutionCaseId,
    })

    expect(mockRuntime.manager.spawnSession).toHaveBeenCalledWith({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-evolution",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      evolutionCaseId,
    })
    expect(JSON.parse(result)).toMatchObject({ id: "coding-700", evolutionCaseId })
    expect(readEvolutionCase(mockRuntime.agentRoot, evolutionCaseId)?.budget.spent.codingSessions).toBe(1)
    expect(readEvolutionTrace(mockRuntime.agentRoot, evolutionCaseId)).toContainEqual(expect.objectContaining({
      type: "delegated",
      target: "coding-700",
    }))
  })

  it("coding_spawn returns a blocked JSON result without spawning when the evolution case budget is exhausted", async () => {
    const evolutionCaseId = createEvolutionCase(mockRuntime.agentRoot, {
      title: "Capture-only case",
      problemStatement: "No coding budget has been granted",
      desiredBehavior: "The tool refuses to spawn before budget is granted",
      origin: {
        kind: "runtime",
        label: "unit test",
        locator: "test://coding-evolution",
      },
      budgetProfile: "capture",
    }).id
    mockRuntime.manager.spawnSession.mockResolvedValue({
      id: "coding-should-not-spawn",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-blocked-budget",
      evolutionCaseId,
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 701,
      startedAt: "2026-05-23T21:32:00.000Z",
      lastActivityAt: "2026-05-23T21:32:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    })

    const result = await execCodingSpawn({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-blocked-budget",
      evolutionCaseId,
    })

    expect(mockRuntime.manager.spawnSession).not.toHaveBeenCalled()
    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      blocked: true,
      action: "spawn_coding",
      evolutionCaseId,
      code: "budget_exhausted",
    })
  })

  it("coding_spawn returns a blocked JSON result without spawning when evolution authority disallows coding delegation", async () => {
    const evolutionCaseId = makeEvolutionCase(mockRuntime.agentRoot, "Authority-blocked case")
    setEvolutionAuthority(mockRuntime.agentRoot, evolutionCaseId, {
      actions: { spawn_coding: "human_required" },
      reason: "operator wants to approve this delegation manually",
    })
    mockRuntime.manager.spawnSession.mockResolvedValue({
      id: "coding-should-not-spawn",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-blocked-authority",
      evolutionCaseId,
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 702,
      startedAt: "2026-05-23T21:33:00.000Z",
      lastActivityAt: "2026-05-23T21:33:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    })

    const result = await execCodingSpawn({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "execute",
      taskRef: "task-blocked-authority",
      evolutionCaseId,
    })

    expect(mockRuntime.manager.spawnSession).not.toHaveBeenCalled()
    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      blocked: true,
      action: "spawn_coding",
      evolutionCaseId,
      code: "human_required",
    })
  })
})
