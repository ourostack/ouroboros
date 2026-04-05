import { describe, expect, it, vi } from "vitest"
import type { CodingSession, CodingSessionRequest } from "../../../repertoire/coding/types"
import { prepareCodingContextPack, emitCodingEpisode } from "../../../repertoire/coding/context-pack"

const mockEmitEpisode = vi.fn()
vi.mock("../../../arc/episodes", () => ({
  emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
}))

function makeRequest(overrides: Partial<CodingSessionRequest> = {}): CodingSessionRequest {
  return {
    task: "fix the bug",
    workdir: "/Users/test/Projects/ouro",
    runner: "codex",
    parentAgent: "ouroboros",
    ...overrides,
  }
}

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "coding-001",
    runner: "codex",
    workdir: "/Users/test/Projects/ouro",
    taskRef: "task-123",
    checkpoint: "working",
    artifactPath: "/tmp/test-artifact.md",
    status: "running",
    stdoutTail: "",
    stderrTail: "",
    pid: 1234,
    startedAt: "2026-03-21T00:00:00.000Z",
    lastActivityAt: "2026-03-21T00:05:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
    ...overrides,
  }
}

function makeDeps() {
  return {
    agentRoot: "/mock/agent-root",
    agentName: "ouroboros",
    nowIso: () => "2026-04-02T10:00:00.000Z",
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    listSkills: vi.fn(() => []),
    runCommand: vi.fn(() => ({ status: 0, stdout: "/Users/test/Projects/ouro\n", stderr: "" })),
  }
}

describe("coding context pack continuity integration", () => {
  it("includes compact start-of-turn packet in state content when startOfTurnPacket provided", () => {
    const deps = makeDeps()
    const result = prepareCodingContextPack(
      {
        request: makeRequest(),
        startOfTurnPacket: "next: review PR | owed: deploy fix",
      },
      deps,
    )

    expect(result.stateContent).toContain("next: review PR | owed: deploy fix")
  })

  it("state content omits start-of-turn packet section when no startOfTurnPacket provided", () => {
    const deps = makeDeps()
    const result = prepareCodingContextPack(
      { request: makeRequest() },
      deps,
    )

    // Should not contain any start-of-turn packet marker
    expect(result.stateContent).not.toContain("## Continuity")
  })

  it("gracefully handles empty start-of-turn packet string", () => {
    const deps = makeDeps()
    const result = prepareCodingContextPack(
      { request: makeRequest(), startOfTurnPacket: "" },
      deps,
    )

    // Empty string should not add a continuity section
    expect(result.stateContent).not.toContain("## Continuity")
  })
})

describe("emitCodingEpisode", () => {
  it("emits a coding_milestone episode on session completion", () => {
    const session = makeSession({ id: "coding-042", status: "completed" })
    emitCodingEpisode("/mock/agent-root", session, "task completed successfully")
    expect(mockEmitEpisode).toHaveBeenCalledWith(
      "/mock/agent-root",
      expect.objectContaining({
        kind: "coding_milestone",
        salience: "medium",
      }),
    )
  })

  it("emits high salience for failed sessions", () => {
    const session = makeSession({ id: "coding-042", status: "failed" })
    emitCodingEpisode("/mock/agent-root", session, "compilation error")
    expect(mockEmitEpisode).toHaveBeenCalledWith(
      "/mock/agent-root",
      expect.objectContaining({
        kind: "coding_milestone",
        salience: "high",
      }),
    )
  })
})
