import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addEvolutionEvidence,
  appendEvolutionTraceEvent,
  blockEvolutionCase,
  closeEvolutionCase,
  consumeEvolutionBudget,
  createEvolutionCase,
  deferEvolutionCase,
  evaluateEvolutionAction,
  findOpenEvolutionCaseByFrictionSignature,
  listEvolutionCases,
  listOpenEvolutionCases,
  readEvolutionCase,
  readEvolutionTrace,
  recordEvolutionDecision,
  recordEvolutionDelivery,
  recordEvolutionRatification,
  recordEvolutionVerification,
  setEvolutionAuthority,
  setEvolutionBudget,
  summarizeOpenEvolutionCases,
} from "../../arc/evolution"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-"))
  tempDirs.push(dir)
  return dir
}

function casePath(agentRoot: string, id: string): string {
  return path.join(agentRoot, "arc", "evolution", "cases", `${id}.json`)
}

function tracePath(agentRoot: string, id: string): string {
  return path.join(agentRoot, "arc", "evolution", "traces", `${id}.jsonl`)
}

function baseCaseInput() {
  return {
    title: "Desk semantic fallback",
    problemStatement: "Desk search falls back to lexical results",
    desiredBehavior: "Semantic search is either available or explains its degraded mode",
    origin: {
      kind: "mcp" as const,
      label: "codex desk_search",
      locator: "mcp://desk/desk_search",
    },
    evidenceRefs: [
      {
        kind: "desk_friction" as const,
        locator: "/Users/arimendelow/desk/ouro-evolution-loop/_friction/2026-05-23-desk-semantic-search-fallback.md",
        capturedAt: "2026-05-23T20:00:00.000Z",
        redaction: "none" as const,
        reason: "Records semantic_unavailable true after app restart",
      },
    ],
    frictionSignature: "desk-search:semantic-unavailable",
    packetId: "pkt-1",
    obligationId: "obl-1",
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("evolution case store", () => {
  it("creates a conservative case with bundle storage, trace event, and default authority", () => {
    const agentRoot = makeAgentRoot()
    const now = vi.spyOn(Date.prototype, "toISOString")
    now.mockReturnValueOnce("2026-05-23T20:00:00.000Z")
      .mockReturnValueOnce("2026-05-23T20:00:00.000Z")
      .mockReturnValueOnce("2026-05-23T20:00:00.000Z")

    const created = createEvolutionCase(agentRoot, baseCaseInput())

    expect(created.id).toMatch(/^evo-/)
    expect(created.status).toBe("noticed")
    expect(created.budget.profile).toBe("conservative")
    expect(created.budget.limits.codingSessions).toBe(1)
    expect(created.budget.spent.codingSessions).toBe(0)
    expect(created.authority.actions.spawn_coding).toBe("allowed")
    expect(created.authority.actions.merge_pr).toBe("ask_before_action")
    expect(created.authority.actions.mutate_identity).toBe("human_required")
    expect(created.packetId).toBe("pkt-1")
    expect(created.obligationId).toBe("obl-1")
    expect(fs.existsSync(casePath(agentRoot, created.id))).toBe(true)
    expect(fs.existsSync(tracePath(agentRoot, created.id))).toBe(true)

    const trace = readEvolutionTrace(agentRoot, created.id)
    expect(trace.map((event) => event.type)).toEqual(["noticed"])
    expect(trace[0]).toMatchObject({
      caseId: created.id,
      type: "noticed",
      reason: "case created",
    })
  })

  it("lists only valid cases, omits malformed JSON, and summarizes open cases", () => {
    const agentRoot = makeAgentRoot()
    const first = createEvolutionCase(agentRoot, baseCaseInput())
    const second = createEvolutionCase(agentRoot, {
      ...baseCaseInput(),
      title: "Premature handoff",
      frictionSignature: "workflow:premature-handoff",
    })
    closeEvolutionCase(agentRoot, second.id, {
      reason: "Superseded by shared-skill update",
      ratification: {
        destination: "none_needed",
        locator: "case://none",
        landedAt: "2026-05-23T20:05:00.000Z",
        reason: "No durable lesson needed for this synthetic case",
      },
    })

    fs.writeFileSync(path.join(agentRoot, "arc", "evolution", "cases", "bad.json"), "{bad", "utf-8")

    expect(listEvolutionCases(agentRoot).map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(listOpenEvolutionCases(agentRoot).map((item) => item.id)).toEqual([first.id])
    expect(summarizeOpenEvolutionCases(agentRoot)).toEqual([
      {
        id: first.id,
        title: "Desk semantic fallback",
        status: "noticed",
        nextAction: "scope and budget the case",
        budgetProfile: "conservative",
      },
    ])
  })

  it("finds open cases by friction signature and ignores terminal matches", () => {
    const agentRoot = makeAgentRoot()
    const open = createEvolutionCase(agentRoot, baseCaseInput())
    const terminal = createEvolutionCase(agentRoot, {
      ...baseCaseInput(),
      title: "Closed duplicate",
      frictionSignature: "closed-signature",
    })
    blockEvolutionCase(agentRoot, terminal.id, { reason: "No authority" })

    expect(findOpenEvolutionCaseByFrictionSignature(agentRoot, "desk-search:semantic-unavailable")?.id).toBe(open.id)
    expect(findOpenEvolutionCaseByFrictionSignature(agentRoot, "closed-signature")).toBeNull()
    expect(findOpenEvolutionCaseByFrictionSignature(agentRoot, "missing")).toBeNull()
  })

  it("appends evidence and trace events without copying private payloads into required fields", () => {
    const agentRoot = makeAgentRoot()
    const created = createEvolutionCase(agentRoot, baseCaseInput())

    const updated = addEvolutionEvidence(agentRoot, created.id, {
      kind: "session_event",
      locator: "state/sessions/ari/mcp/codex.json#event-1",
      capturedAt: "2026-05-23T20:10:00.000Z",
      redaction: "private_ref",
      reason: "Pointer to the session event; content intentionally not copied",
    })
    appendEvolutionTraceEvent(agentRoot, created.id, {
      type: "evidence_added",
      reason: "Added private session evidence pointer",
      evidenceRefs: [updated.evidenceRefs[1]!.locator],
    })

    expect(updated.evidenceRefs).toHaveLength(2)
    expect(updated.evidenceRefs[1]).not.toHaveProperty("payload")
    expect(readEvolutionTrace(agentRoot, created.id).map((event) => event.type)).toEqual(["noticed", "evidence_added", "evidence_added"])
  })

  it("records decisions, verification, delivery, and ratification as distinct state", () => {
    const agentRoot = makeAgentRoot()
    const created = createEvolutionCase(agentRoot, baseCaseInput())

    recordEvolutionDecision(agentRoot, created.id, {
      decision: "delegate",
      reason: "Low-risk tooling repair",
      authorityMode: "delegate_allowed",
    })
    recordEvolutionVerification(agentRoot, created.id, {
      status: "partial",
      checkedAt: "2026-05-23T20:15:00.000Z",
      objective: "Semantic search works or degraded mode is documented",
      commands: ["desk_search semantic query"],
      evidenceRefs: ["mcp://desk/desk_search"],
      residualRisk: "Ollama may still be stopped on another machine",
      missingChecks: ["fresh machine smoke"],
    })
    recordEvolutionDelivery(agentRoot, created.id, {
      pullRequest: { url: "https://github.com/ourostack/ouroboros-skills/pull/61", openedAt: "2026-05-23T20:20:00.000Z" },
      merged: null,
      released: null,
      installedLocal: null,
    })
    const ratified = recordEvolutionRatification(agentRoot, created.id, {
      destination: "desk_lesson",
      locator: "/Users/arimendelow/desk/_meta/tips/desk-semantic-search.md",
      landedAt: "2026-05-23T20:25:00.000Z",
      reason: "Future agents need repair guidance",
    })

    expect(ratified.decision?.decision).toBe("delegate")
    expect(ratified.verification?.status).toBe("partial")
    expect(ratified.delivery.pullRequest?.url).toContain("pull/61")
    expect(ratified.delivery.merged).toBeNull()
    expect(ratified.ratification?.destination).toBe("desk_lesson")
  })

  it("enforces coding-session budget and action authority before spending", () => {
    const agentRoot = makeAgentRoot()
    const created = createEvolutionCase(agentRoot, baseCaseInput())

    expect(evaluateEvolutionAction(agentRoot, created.id, "spawn_coding")).toMatchObject({
      allowed: true,
      code: "allowed",
    })
    const spent = consumeEvolutionBudget(agentRoot, created.id, "spawn_coding", {
      target: "coding-001",
      reason: "delegated implementation",
    })
    expect(spent.budget.spent.codingSessions).toBe(1)
    expect(evaluateEvolutionAction(agentRoot, created.id, "spawn_coding")).toMatchObject({
      allowed: false,
      code: "budget_exhausted",
    })
    expect(() => consumeEvolutionBudget(agentRoot, created.id, "spawn_coding", { reason: "second worker" })).toThrow(/budget/i)

    setEvolutionAuthority(agentRoot, created.id, {
      actions: { open_pr: "ask_before_action", merge_pr: "human_required" },
      reason: "tighten authority",
    })
    expect(evaluateEvolutionAction(agentRoot, created.id, "open_pr")).toMatchObject({
      allowed: false,
      code: "ask_before_action",
    })
    expect(evaluateEvolutionAction(agentRoot, created.id, "merge_pr")).toMatchObject({
      allowed: false,
      code: "human_required",
    })
  })

  it("supports explicit capture budget and terminal close/block/defer transitions", () => {
    const agentRoot = makeAgentRoot()
    const created = createEvolutionCase(agentRoot, {
      ...baseCaseInput(),
      budgetProfile: "capture",
    })

    expect(readEvolutionCase(agentRoot, created.id)?.budget.limits.codingSessions).toBe(0)
    expect(evaluateEvolutionAction(agentRoot, created.id, "spawn_coding")).toMatchObject({
      allowed: false,
      code: "budget_exhausted",
    })

    const budgeted = setEvolutionBudget(agentRoot, created.id, {
      profile: "trusted-local",
      reason: "Operator granted a stronger local budget",
    })
    expect(budgeted.budget.profile).toBe("trusted-local")
    expect(budgeted.budget.limits.codingSessions).toBe(2)

    const deferred = deferEvolutionCase(agentRoot, created.id, { reason: "Waiting for desk plugin repair" })
    expect(deferred.status).toBe("deferred")
    expect(evaluateEvolutionAction(agentRoot, created.id, "spawn_coding")).toMatchObject({
      allowed: false,
      code: "terminal_case",
    })
  })
})
