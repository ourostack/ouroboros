import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPonderPacket } from "../../arc/packets"
import {
  readEvolutionCase,
  readEvolutionTrace,
  setEvolutionAuthority,
  setEvolutionBudget,
} from "../../arc/evolution"
import { evolutionToolDefinitions, getOpenEvolutionCasesForActiveWork } from "../../repertoire/tools-evolution"

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

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => mockRuntime.agentRoot),
}))

vi.mock("../../repertoire/coding", () => ({
  getCodingSessionManager: vi.fn(() => mockRuntime.manager),
  attachCodingSessionFeedback: vi.fn(),
  formatCodingTail: vi.fn(() => "tail"),
}))

vi.mock("../../arc/obligations", () => ({
  createObligation: vi.fn(() => ({ id: "ob-flow" })),
  findPendingObligationForOrigin: vi.fn(() => undefined),
  advanceObligation: vi.fn(),
}))

vi.mock("../../repertoire/coding/context-pack", () => ({
  prepareCodingContextPack: vi.fn(() => ({
    contextKey: "ctx-flow",
    scopeFile: "/tmp/generated-flow-scope.md",
    stateFile: "/tmp/generated-flow-state.md",
    scopeContent: "# scope",
    stateContent: "# state",
  })),
}))

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-evolution-flow-"))
  tempDirs.push(dir)
  return dir
}

function findEvolutionTool(name: string) {
  const definition = evolutionToolDefinitions.find((item) => item.tool.function.name === name)
  if (!definition) throw new Error(`missing evolution tool ${name}`)
  return definition
}

async function invokeEvolutionTool(name: string, args: Record<string, string> = {}) {
  return JSON.parse(await findEvolutionTool(name).handler(args))
}

async function invokeCodingSpawn(args: Record<string, string>) {
  const { codingToolDefinitions } = await import("../../repertoire/coding/tools")
  const definition = codingToolDefinitions.find((item) => item.tool.function.name === "coding_spawn")
  if (!definition) throw new Error("coding_spawn tool definition missing")
  return JSON.parse(await definition.handler(args))
}

describe("local evolution loop flow", () => {
  beforeEach(() => {
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

  it("carries harness friction from packet to budgeted delegation, verification, delivery, ratification, and closure", async () => {
    const packet = createPonderPacket(mockRuntime.agentRoot, {
      kind: "harness_friction",
      objective: "Make evolution loops survive long-running work",
      summary: "Ouro needs a trace-backed loop instead of ad-hoc self-fix notes.",
      successCriteria: [
        "Friction creates a durable evolution case",
        "Coding delegation is attached to the case",
        "Closure requires verification and ratification",
      ],
      origin: { friendId: "ari", channel: "cli", key: "evolution-loop" },
      payload: {
        frictionSignature: "evolution-loop:lost-self-fix-evidence",
        userObjective: "Build the Ouro evolution loop foundation",
      },
    })
    const evolutionCaseId = packet.payload.evolutionCaseId as string

    expect(evolutionCaseId).toMatch(/^evo-/)
    expect(readEvolutionCase(mockRuntime.agentRoot, evolutionCaseId)).toMatchObject({
      id: evolutionCaseId,
      packetId: packet.id,
      frictionSignature: "evolution-loop:lost-self-fix-evidence",
      evidenceRefs: [expect.objectContaining({ kind: "ponder_packet", locator: `arc/packets/${packet.id}.json` })],
    })

    setEvolutionBudget(mockRuntime.agentRoot, evolutionCaseId, {
      profile: "trusted-local",
      reason: "local implementation is allowed one delegated coding pass",
    })
    setEvolutionAuthority(mockRuntime.agentRoot, evolutionCaseId, {
      actions: { spawn_coding: "allowed", merge_pr: "ask_before_action", mutate_identity: "human_required" },
      reason: "delegate implementation, keep merge and sensitive surfaces gated",
    })

    const decision = await invokeEvolutionTool("evolution_decide", {
      caseId: evolutionCaseId,
      decision: "delegate",
      action: "spawn_coding",
      reason: "implementation crosses enough files to delegate",
    })
    expect(decision.case.decision).toMatchObject({ decision: "delegate", authorityMode: "allowed" })

    mockRuntime.manager.spawnSession.mockResolvedValue({
      id: "coding-flow-1",
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "Implement the evolution-loop foundation.",
      taskRef: "evolution-loop-flow",
      evolutionCaseId,
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      status: "running",
      stdoutTail: "",
      stderrTail: "",
      pid: 701,
      startedAt: "2026-05-23T22:00:00.000Z",
      lastActivityAt: "2026-05-23T22:00:00.000Z",
      endedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastSignal: null,
      failure: null,
    })

    const session = await invokeCodingSpawn({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "Implement the evolution-loop foundation.",
      taskRef: "evolution-loop-flow",
      scopeFile: "/tmp/scope.md",
      stateFile: "/tmp/state.md",
      evolutionCaseId,
    })

    expect(session).toMatchObject({ id: "coding-flow-1", evolutionCaseId })
    expect(mockRuntime.manager.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ evolutionCaseId }))
    expect(readEvolutionCase(mockRuntime.agentRoot, evolutionCaseId)?.budget.spent.codingSessions).toBe(1)

    const verification = await invokeEvolutionTool("evolution_verify", {
      caseId: evolutionCaseId,
      status: "passed",
      objective: "The packet-linked case can delegate, verify, deliver, ratify, and close.",
      commands: JSON.stringify(["npx vitest run src/__tests__/repertoire/evolution-loop-flow.test.ts"]),
      evidenceRefs: JSON.stringify(["test://evolution-loop-flow"]),
      missingChecks: JSON.stringify([]),
      residualRisk: "",
    })
    expect(verification.case.status).toBe("ratifying")

    const delivered = await invokeEvolutionTool("evolution_deliver", {
      caseId: evolutionCaseId,
      delivery: JSON.stringify({
        commits: [{ sha: "abc1234", message: "feat(evolution): local loop foundation" }],
        pullRequest: { url: "https://github.com/ourostack/ouroboros/pull/123", openedAt: "2026-05-23T22:10:00.000Z" },
      }),
    })
    expect(delivered.case.delivery).toMatchObject({ commits: [{ sha: "abc1234" }] })

    const ratified = await invokeEvolutionTool("evolution_ratify", {
      caseId: evolutionCaseId,
      destination: "repo_doc",
      locator: "docs/evolution-loop.md",
      reason: "The loop invariant is now captured in repo documentation.",
      landedAt: "2026-05-23T22:15:00.000Z",
    })
    expect(ratified.case.ratification).toMatchObject({ destination: "repo_doc", locator: "docs/evolution-loop.md" })

    const closed = await invokeEvolutionTool("evolution_close", {
      caseId: evolutionCaseId,
      reason: "verified, delivered, and ratified",
    })
    expect(closed.case.status).toBe("closed")
    expect(getOpenEvolutionCasesForActiveWork(mockRuntime.agentRoot)).toEqual([])

    const traceTypes = readEvolutionTrace(mockRuntime.agentRoot, evolutionCaseId).map((event) => event.type)
    expect(traceTypes).toEqual(expect.arrayContaining([
      "noticed",
      "budget_set",
      "authority_set",
      "decision_recorded",
      "delegated",
      "verification_recorded",
      "delivery_recorded",
      "ratification_recorded",
      "closed",
    ]))
  })
})
