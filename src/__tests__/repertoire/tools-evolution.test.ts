import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeEvolutionCase,
  createEvolutionCase,
  readEvolutionCase,
  recordEvolutionRatification,
  type EvolutionCase,
} from "../../arc/evolution"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

let agentRoot = ""

vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => agentRoot,
}))

import { evolutionToolDefinitions } from "../../repertoire/tools-evolution"

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
})
