import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeEvolutionCase,
  createEvolutionCase,
  deferEvolutionCase,
  readEvolutionCase,
  recordEvolutionRatification,
  type EvolutionCase,
} from "../../arc/evolution"

const { nervesEvents } = vi.hoisted(() => ({
  nervesEvents: [] as Array<Record<string, unknown>>,
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

let agentRoot = ""

vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => agentRoot,
}))

import { evolutionToolDefinitions, getOpenEvolutionCasesForActiveWork } from "../../repertoire/tools-evolution"

function findTool(name: string) {
  const def = evolutionToolDefinitions.find((candidate) => candidate.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

async function invoke(name: string, args: Record<string, string> = {}) {
  const raw = await findTool(name).handler(args)
  return JSON.parse(raw)
}

function makeCase(overrides: Partial<Parameters<typeof createEvolutionCase>[1]> = {}): EvolutionCase {
  return createEvolutionCase(agentRoot, {
    title: "Improve harness self-repair loop",
    problemStatement: "Ouro notices harness friction but loses the evidence before fixing it.",
    desiredBehavior: "Ouro should capture evidence, decide under budget, delegate implementation, verify, and ratify.",
    origin: { kind: "runtime", label: "test harness", locator: "test://evolution" },
    ...overrides,
  })
}

describe("evolution tools", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-evolution-tools-"))
    nervesEvents.length = 0
  })

  it("registers the expected tool names", () => {
    expect(evolutionToolDefinitions.map((definition) => definition.tool.function.name)).toEqual([
      "evolution_status",
      "evolution_case",
      "evolution_capture",
      "evolution_decide",
      "evolution_verify",
      "evolution_deliver",
      "evolution_ratify",
      "evolution_close",
    ])
  })

  it("marks read tools low-risk and mutating tools high-risk durable writes", () => {
    const readTools = ["evolution_status", "evolution_case"]
    const writeTools = [
      "evolution_capture",
      "evolution_decide",
      "evolution_verify",
      "evolution_deliver",
      "evolution_ratify",
      "evolution_close",
    ]

    for (const name of readTools) {
      expect(findTool(name).riskProfile).toMatchObject({ mutates: "none", risk: "low" })
    }
    for (const name of writeTools) {
      expect(findTool(name).riskProfile).toMatchObject({ mutates: "durable_state_write", risk: "high" })
    }
  })

  it("emits a tool-level nerves event when invoked", async () => {
    await invoke("evolution_status")

    expect(nervesEvents).toContainEqual(expect.objectContaining({
      component: "repertoire",
      event: "repertoire.evolution_tool_call",
      meta: expect.objectContaining({ toolName: "evolution_status" }),
    }))
  })

  it("evolution_status returns open case summaries and omits closed cases", async () => {
    const openCase = makeCase({ title: "Open case" })
    const closedCase = makeCase({ title: "Closed case" })
    recordEvolutionRatification(agentRoot, closedCase.id, {
      destination: "none_needed",
      locator: "none",
      landedAt: "2026-05-23T00:00:00.000Z",
      reason: "test closure",
    })
    closeEvolutionCase(agentRoot, closedCase.id, { reason: "complete" })

    const result = await invoke("evolution_status")

    expect(result).toMatchObject({ ok: true, count: 1 })
    expect(result.openCases).toEqual([
      {
        id: openCase.id,
        title: "Open case",
        status: "noticed",
        nextAction: "scope and budget the case",
        budgetProfile: "conservative",
      },
    ])
  })

  it("evolution_case returns a case and its trace", async () => {
    const item = makeCase()

    const result = await invoke("evolution_case", { caseId: item.id })

    expect(result.ok).toBe(true)
    expect(result.case.id).toBe(item.id)
    expect(result.trace.map((event: { type: string }) => event.type)).toContain("noticed")
  })

  it("returns structured JSON for missing or unknown case ids", async () => {
    expect(await invoke("evolution_case", {})).toEqual({
      ok: false,
      error: "caseId is required",
    })

    expect(await invoke("evolution_case", { caseId: "evo-missing" })).toEqual({
      ok: false,
      error: "Evolution case not found: evo-missing",
    })
  })

  it("evolution_capture creates a case with optional evidence", async () => {
    const result = await invoke("evolution_capture", {
      title: "Desk plugin fallback is degraded",
      problemStatement: "Semantic search failed and lexical fallback took over.",
      desiredBehavior: "Desk search should report semantic fallback clearly and keep working.",
      originKind: "desk",
      originLabel: "desk-plugin/semantic-search-fallback",
      originLocator: "/Users/arimendelow/desk/desk-plugin/semantic-search-fallback/task.md",
      budgetProfile: "capture",
      evidenceKind: "desk_doc",
      evidenceLocator: "desk-plugin/semantic-search-fallback/task.md",
      evidenceReason: "source backlog task",
      evidenceRedaction: "none",
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.case).toMatchObject({
      title: "Desk plugin fallback is degraded",
      status: "noticed",
      origin: { kind: "desk", label: "desk-plugin/semantic-search-fallback" },
      budget: { profile: "capture" },
      evidenceRefs: [
        {
          kind: "desk_doc",
          locator: "desk-plugin/semantic-search-fallback/task.md",
          redaction: "none",
          reason: "source backlog task",
        },
      ],
    })
    expect(readEvolutionCase(agentRoot, result.case.id)?.id).toBe(result.case.id)
  })

  it("evolution_capture defaults evidence redaction to summary", async () => {
    const result = await invoke("evolution_capture", {
      title: "Default evidence redaction",
      problemStatement: "p",
      desiredBehavior: "d",
      originKind: "runtime",
      originLabel: "l",
      originLocator: "x",
      evidenceKind: "desk_doc",
      evidenceLocator: "desk/task.md",
      evidenceReason: "source",
    })

    expect(result.case.evidenceRefs[0].redaction).toBe("summary")
  })

  it("evolution_capture can create a case without optional evidence", async () => {
    const result = await invoke("evolution_capture", {
      title: "No evidence yet",
      problemStatement: "The agent noticed a pattern but has not attached evidence.",
      desiredBehavior: "The case still exists so evidence can be added later.",
      originKind: "runtime",
      originLabel: "self-observation",
      originLocator: "runtime://self",
      frictionSignature: "runtime:self-observation",
      packetId: "packet-123",
      obligationId: "ob-123",
    })

    expect(result.case.evidenceRefs).toEqual([])
    expect(result.case.budget.profile).toBe("conservative")
    expect(result.case).toMatchObject({
      frictionSignature: "runtime:self-observation",
      packetId: "packet-123",
      obligationId: "ob-123",
    })
  })

  it("evolution_capture validates required fields and enums", async () => {
    expect(await invoke("evolution_capture", {})).toEqual({ ok: false, error: "title is required" })
    expect(await invoke("evolution_capture", {
      title: "Missing problem",
    })).toEqual({ ok: false, error: "problemStatement is required" })
    expect(await invoke("evolution_capture", {
      title: "Missing desired behavior",
      problemStatement: "p",
    })).toEqual({ ok: false, error: "desiredBehavior is required" })
    expect(await invoke("evolution_capture", {
      title: "Missing origin kind",
      problemStatement: "p",
      desiredBehavior: "d",
    })).toEqual({ ok: false, error: "originKind is required" })
    expect(await invoke("evolution_capture", {
      title: "Missing origin label",
      problemStatement: "p",
      desiredBehavior: "d",
      originKind: "runtime",
    })).toEqual({ ok: false, error: "originLabel is required" })
    expect(await invoke("evolution_capture", {
      title: "Missing origin locator",
      problemStatement: "p",
      desiredBehavior: "d",
      originKind: "runtime",
      originLabel: "l",
    })).toEqual({ ok: false, error: "originLocator is required" })
    expect(await invoke("evolution_capture", {
      title: "Bad origin",
      problemStatement: "p",
      desiredBehavior: "d",
      originKind: "dream",
      originLabel: "l",
      originLocator: "x",
    })).toEqual({ ok: false, error: "invalid originKind: dream" })
    expect(await invoke("evolution_capture", {
      title: "Bad budget",
      problemStatement: "p",
      desiredBehavior: "d",
      originKind: "runtime",
      originLabel: "l",
      originLocator: "x",
      budgetProfile: "infinite",
    })).toEqual({ ok: false, error: "invalid budgetProfile: infinite" })
  })

  it("evolution_capture validates partial and invalid evidence fields", async () => {
    const base = {
      title: "Evidence validation",
      problemStatement: "p",
      desiredBehavior: "d",
      originKind: "runtime",
      originLabel: "l",
      originLocator: "x",
    }

    expect(await invoke("evolution_capture", {
      ...base,
      evidenceLocator: "desk/task.md",
      evidenceReason: "source",
    })).toEqual({ ok: false, error: "evidenceKind is required when evidence is provided" })
    expect(await invoke("evolution_capture", {
      ...base,
      evidenceKind: "desk_doc",
      evidenceReason: "source",
    })).toEqual({ ok: false, error: "evidenceLocator is required when evidence is provided" })
    expect(await invoke("evolution_capture", {
      ...base,
      evidenceKind: "desk_doc",
      evidenceLocator: "desk/task.md",
    })).toEqual({ ok: false, error: "evidenceReason is required when evidence is provided" })
    expect(await invoke("evolution_capture", {
      ...base,
      evidenceKind: "desk_task",
      evidenceLocator: "desk/task.md",
      evidenceReason: "source",
    })).toEqual({ ok: false, error: "invalid evidenceKind: desk_task" })
    expect(await invoke("evolution_capture", {
      ...base,
      evidenceKind: "desk_doc",
      evidenceLocator: "desk/task.md",
      evidenceReason: "source",
      evidenceRedaction: "opaque",
    })).toEqual({ ok: false, error: "invalid evidenceRedaction: opaque" })
  })

  it("evolution_decide records an allowed decision for an action", async () => {
    const item = makeCase()

    const result = await invoke("evolution_decide", {
      caseId: item.id,
      decision: "delegate",
      action: "spawn_coding",
      reason: "implementation is complex enough for a coding harness",
    })

    expect(result).toMatchObject({ ok: true, action: "spawn_coding" })
    expect(result.case.decision).toMatchObject({
      decision: "delegate",
      reason: "implementation is complex enough for a coding harness",
      authorityMode: "allowed",
    })
  })

  it("evolution_decide rejects invalid action names before recording", async () => {
    const item = makeCase()

    const result = await invoke("evolution_decide", {
      caseId: item.id,
      decision: "delegate",
      action: "rewrite_soul",
      reason: "not a real action",
    })

    expect(result).toEqual({ ok: false, error: "invalid action: rewrite_soul" })
    expect(readEvolutionCase(agentRoot, item.id)?.decision).toBeNull()
  })

  it("evolution_decide blocks sensitive actions that default to human-required authority", async () => {
    const item = makeCase()

    const result = await invoke("evolution_decide", {
      caseId: item.id,
      decision: "act",
      action: "mutate_identity",
      reason: "identity changes require explicit human review",
    })

    expect(result).toMatchObject({
      ok: false,
      blocked: true,
      caseId: item.id,
      action: "mutate_identity",
      code: "human_required",
      reason: "mutate_identity is human_required",
    })
    expect(readEvolutionCase(agentRoot, item.id)?.decision).toBeNull()
  })

  it("evolution_decide validates required fields and nonexistent cases", async () => {
    const item = makeCase()

    expect(await invoke("evolution_decide", {})).toEqual({ ok: false, error: "caseId is required" })
    expect(await invoke("evolution_decide", {
      caseId: item.id,
      action: "spawn_coding",
      reason: "missing decision",
    })).toEqual({ ok: false, error: "decision is required" })
    expect(await invoke("evolution_decide", {
      caseId: item.id,
      decision: "levitate",
      action: "spawn_coding",
      reason: "bad decision",
    })).toEqual({ ok: false, error: "invalid decision: levitate" })
    expect(await invoke("evolution_decide", {
      caseId: item.id,
      decision: "delegate",
      reason: "missing action",
    })).toEqual({ ok: false, error: "action is required" })
    expect(await invoke("evolution_decide", {
      caseId: item.id,
      decision: "delegate",
      action: "spawn_coding",
    })).toEqual({ ok: false, error: "reason is required" })
    expect(await invoke("evolution_decide", {
      caseId: "evo-missing",
      decision: "delegate",
      action: "spawn_coding",
      reason: "unknown case",
    })).toMatchObject({ ok: false, blocked: true, code: "case_not_found" })
  })

  it("evolution_verify records verification evidence and advances passed cases to ratifying", async () => {
    const item = makeCase()

    const result = await invoke("evolution_verify", {
      caseId: item.id,
      status: "passed",
      objective: "Active work renders open evolution cases.",
      commands: JSON.stringify(["npx vitest run src/__tests__/heart/active-work-rendering.test.ts"]),
      evidenceRefs: JSON.stringify(["test-output://active-work"]),
      residualRisk: "",
      missingChecks: JSON.stringify([]),
    })

    expect(result.case.status).toBe("ratifying")
    expect(result.case.verification).toMatchObject({
      status: "passed",
      objective: "Active work renders open evolution cases.",
      commands: ["npx vitest run src/__tests__/heart/active-work-rendering.test.ts"],
      evidenceRefs: ["test-output://active-work"],
      residualRisk: null,
      missingChecks: [],
    })
  })

  it("evolution_verify validates inputs and supports newline/comma list parsing", async () => {
    const item = makeCase()

    expect(await invoke("evolution_verify", {})).toEqual({ ok: false, error: "caseId is required" })
    expect(await invoke("evolution_verify", {
      caseId: item.id,
      objective: "missing status",
    })).toEqual({ ok: false, error: "status is required" })
    expect(await invoke("evolution_verify", {
      caseId: item.id,
      status: "excellent",
      objective: "bad status",
    })).toEqual({ ok: false, error: "invalid status: excellent" })
    expect(await invoke("evolution_verify", {
      caseId: item.id,
      status: "partial",
    })).toEqual({ ok: false, error: "objective is required" })

    const result = await invoke("evolution_verify", {
      caseId: item.id,
      status: "partial",
      objective: "List parser works.",
      commands: "npm test\nnpx tsc --noEmit",
      evidenceRefs: "test://one,test://two",
      missingChecks: JSON.stringify(["release preflight"]),
      residualRisk: "release not run",
    })
    expect(result.case.verification).toMatchObject({
      commands: ["npm test", "npx tsc --noEmit"],
      evidenceRefs: ["test://one", "test://two"],
      missingChecks: ["release preflight"],
      residualRisk: "release not run",
    })

    expect(await invoke("evolution_verify", {
      caseId: item.id,
      status: "partial",
      objective: "bad commands",
      commands: JSON.stringify({ command: "npm test" }),
    })).toEqual({ ok: false, error: "commands must be a JSON string array, newline list, or comma list" })
    expect(await invoke("evolution_verify", {
      caseId: item.id,
      status: "partial",
      objective: "bad evidence refs",
      evidenceRefs: JSON.stringify({ ref: "test://one" }),
    })).toEqual({ ok: false, error: "evidenceRefs must be a JSON string array, newline list, or comma list" })
    expect(await invoke("evolution_verify", {
      caseId: item.id,
      status: "partial",
      objective: "bad missing checks",
      missingChecks: JSON.stringify({ check: "release" }),
    })).toEqual({ ok: false, error: "missingChecks must be a JSON string array, newline list, or comma list" })
  })

  it("evolution_deliver merges delivery state from JSON", async () => {
    const item = makeCase()

    const result = await invoke("evolution_deliver", {
      caseId: item.id,
      delivery: JSON.stringify({
        pullRequest: { url: "https://github.com/ourostack/ouroboros/pull/123", openedAt: "2026-05-23T01:00:00.000Z" },
        commits: [{ sha: "abc1234", message: "feat: add evolution tools" }],
      }),
    })

    expect(result.case.delivery).toMatchObject({
      pullRequest: { url: "https://github.com/ourostack/ouroboros/pull/123" },
      commits: [{ sha: "abc1234", message: "feat: add evolution tools" }],
    })
  })

  it("evolution_deliver returns parseable JSON errors for malformed delivery JSON", async () => {
    const item = makeCase()

    const result = await invoke("evolution_deliver", {
      caseId: item.id,
      delivery: "{not json",
    })

    expect(result).toEqual({ ok: false, error: "delivery must be valid JSON" })
  })

  it("evolution_deliver validates missing and non-object delivery input", async () => {
    const item = makeCase()

    expect(await invoke("evolution_deliver", {})).toEqual({ ok: false, error: "caseId is required" })
    expect(await invoke("evolution_deliver", { caseId: item.id })).toEqual({ ok: false, error: "delivery is required" })
    expect(await invoke("evolution_deliver", {
      caseId: item.id,
      delivery: JSON.stringify(["not", "object"]),
    })).toEqual({ ok: false, error: "delivery must be a JSON object" })
  })

  it("evolution_ratify records the durable lesson destination", async () => {
    const item = makeCase()

    const result = await invoke("evolution_ratify", {
      caseId: item.id,
      destination: "desk_lesson",
      locator: "ouro-evolution-loop/_lessons/trace-substrate.md",
      reason: "Future runs need the trace-substrate invariant.",
      landedAt: "2026-05-23T02:00:00.000Z",
    })

    expect(result.case.status).toBe("ratifying")
    expect(result.case.ratification).toMatchObject({
      destination: "desk_lesson",
      locator: "ouro-evolution-loop/_lessons/trace-substrate.md",
      reason: "Future runs need the trace-substrate invariant.",
      landedAt: "2026-05-23T02:00:00.000Z",
    })
  })

  it("evolution_ratify validates required and enum fields", async () => {
    const item = makeCase()

    expect(await invoke("evolution_ratify", {})).toEqual({ ok: false, error: "caseId is required" })
    expect(await invoke("evolution_ratify", {
      caseId: item.id,
      locator: "x",
      reason: "missing destination",
    })).toEqual({ ok: false, error: "destination is required" })
    expect(await invoke("evolution_ratify", {
      caseId: item.id,
      destination: "memory_palace",
      locator: "x",
      reason: "bad destination",
    })).toEqual({ ok: false, error: "invalid destination: memory_palace" })
    expect(await invoke("evolution_ratify", {
      caseId: item.id,
      destination: "desk_lesson",
      reason: "missing locator",
    })).toEqual({ ok: false, error: "locator is required" })
    expect(await invoke("evolution_ratify", {
      caseId: item.id,
      destination: "desk_lesson",
      locator: "x",
    })).toEqual({ ok: false, error: "reason is required" })
  })

  it("evolution_close closes a ratified case", async () => {
    const item = makeCase()
    await invoke("evolution_ratify", {
      caseId: item.id,
      destination: "none_needed",
      locator: "none",
      reason: "No durable lesson needed for this narrow case.",
    })

    const result = await invoke("evolution_close", {
      caseId: item.id,
      reason: "verified and ratified",
    })

    expect(result.case.status).toBe("closed")
    expect(result.case.closedAt).toEqual(expect.any(String))
    expect(result.case.latestNote).toBe("verified and ratified")
  })

  it("evolution_close rejects closure without ratification or none_needed", async () => {
    const item = makeCase()

    const result = await invoke("evolution_close", {
      caseId: item.id,
      reason: "trying to skip the lesson",
    })

    expect(result).toEqual({
      ok: false,
      error: "Evolution case closure requires ratification or none_needed",
    })
    expect(readEvolutionCase(agentRoot, item.id)?.status).not.toBe("closed")
  })

  it("evolution_close can close with inline none_needed ratification", async () => {
    const item = makeCase()

    const result = await invoke("evolution_close", {
      caseId: item.id,
      reason: "verified; no durable lesson needed",
      destination: "none_needed",
      locator: "none",
    })

    expect(result.case.status).toBe("closed")
    expect(result.case.ratification).toMatchObject({
      destination: "none_needed",
      locator: "none",
      reason: "verified; no durable lesson needed",
    })
  })

  it("evolution_close validates required fields and inline ratification fields", async () => {
    const item = makeCase()

    expect(await invoke("evolution_close", {})).toEqual({ ok: false, error: "caseId is required" })
    expect(await invoke("evolution_close", { caseId: item.id })).toEqual({ ok: false, error: "reason is required" })
    expect(await invoke("evolution_close", {
      caseId: item.id,
      reason: "bad inline destination",
      destination: "somewhere_else",
      locator: "x",
    })).toEqual({ ok: false, error: "invalid destination: somewhere_else" })
    expect(await invoke("evolution_close", {
      caseId: item.id,
      reason: "missing inline locator",
      destination: "none_needed",
    })).toEqual({ ok: false, error: "locator is required" })
  })

  it("getOpenEvolutionCasesForActiveWork returns compact summaries for non-terminal cases only", () => {
    const open = makeCase({ title: "Visible case", budgetProfile: "trusted-local" })
    const deferred = makeCase({ title: "Deferred case" })
    deferEvolutionCase(agentRoot, deferred.id, { reason: "wait for later" })

    expect(getOpenEvolutionCasesForActiveWork(agentRoot)).toEqual([
      {
        id: open.id,
        title: "Visible case",
        status: "noticed",
        nextAction: "scope and budget the case",
        budgetProfile: "trusted-local",
      },
    ])
  })
})
