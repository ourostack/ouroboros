/**
 * Unit 4a: tests for `buildInnerStatusOutput` rendering Layer 4 drift
 * advisories.
 *
 * The render adds a "drift advisory" section when one or more drift
 * findings are passed in. Each finding renders one line containing:
 * - the lane (outward / inner)
 * - the intent provider/model and the observed provider/model
 * - the copy-pasteable `ouro use` repair command
 *
 * When `driftFindings` is absent or empty, the output is unchanged from
 * the pre-Layer-4 format (backward compatible — additive field).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import type { DriftFinding } from "../../../heart/daemon/drift-detection"

describe("buildInnerStatusOutput drift advisory rendering (Unit 4a)", () => {
  let buildInnerStatusOutput: typeof import("../../../heart/daemon/inner-status").buildInnerStatusOutput

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../../heart/daemon/inner-status")
    buildInnerStatusOutput = mod.buildInnerStatusOutput
  })

  function baseInput() {
    return {
      agentName: "slugger",
      runtimeState: { status: "idle", lastCompletedAt: "2026-03-26T10:18:00Z" },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now: new Date("2026-03-26T10:30:00Z").getTime(),
    } as const
  }

  function findingFor(lane: "outward" | "inner", overrides: Partial<DriftFinding> = {}): DriftFinding {
    return {
      agent: "slugger",
      lane,
      intentProvider: "openai",
      intentModel: "claude-opus-4-7",
      observedProvider: "anthropic",
      observedModel: "claude-opus-4-6",
      reason: "provider-model-changed",
      repairCommand: `ouro use --agent slugger --lane ${lane} --provider openai --model claude-opus-4-7`,
      ...overrides,
    }
  }

  it("does not render a drift section when driftFindings is absent (pre-Layer-4 callers unchanged)", () => {
    const result = buildInnerStatusOutput(baseInput())
    expect(result).not.toMatch(/drift/i)
    expect(result).not.toContain("ouro use")
  })

  it("does not render a drift section when driftFindings is empty array", () => {
    const result = buildInnerStatusOutput({ ...baseInput(), driftFindings: [] })
    expect(result).not.toMatch(/drift/i)
    expect(result).not.toContain("ouro use")
  })

  it("renders a drift advisory when one outward-lane drift finding is present", () => {
    const result = buildInnerStatusOutput({
      ...baseInput(),
      driftFindings: [findingFor("outward")],
    })
    // Section header signals to the operator that this is a drift call-out.
    expect(result).toMatch(/drift/i)
    // Lane is named explicitly.
    expect(result).toContain("outward")
    // Intent vs observed both surface so the operator can see what changed.
    expect(result).toContain("openai/claude-opus-4-7")
    expect(result).toContain("anthropic/claude-opus-4-6")
    // Copy-pasteable repair command surfaces verbatim.
    expect(result).toContain("ouro use --agent slugger --lane outward --provider openai --model claude-opus-4-7")
  })

  it("renders both findings when both lanes drift", () => {
    const result = buildInnerStatusOutput({
      ...baseInput(),
      driftFindings: [
        findingFor("outward"),
        findingFor("inner", {
          intentProvider: "minimax",
          intentModel: "minimax-m2.5",
          observedProvider: "anthropic",
          observedModel: "claude-opus-4-6",
          repairCommand: "ouro use --agent slugger --lane inner --provider minimax --model minimax-m2.5",
        }),
      ],
    })
    expect(result).toContain("outward")
    expect(result).toContain("inner")
    expect(result).toContain("ouro use --agent slugger --lane outward --provider openai --model claude-opus-4-7")
    expect(result).toContain("ouro use --agent slugger --lane inner --provider minimax --model minimax-m2.5")
  })

  it("preserves the existing status fields (drift advisory is additive)", () => {
    const result = buildInnerStatusOutput({
      ...baseInput(),
      driftFindings: [findingFor("outward")],
    })
    // The pre-Layer-4 lines must still appear — drift adds, doesn't replace.
    expect(result).toContain("inner dialog status: slugger")
    expect(result).toContain("last turn:")
    expect(result).toContain("status: idle")
    expect(result).toContain("attention: 0 held thoughts")
  })
})
