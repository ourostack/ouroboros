/**
 * Unit 4a: tests for the `--no-repair` drift-summary path.
 *
 * When `ouro up --no-repair` runs and an agent has drift findings, the
 * summary written to stdout must include a per-agent drift advisory
 * with the copy-pasteable `ouro use` repair command. The advisory rides
 * alongside (or instead of, when there are no degraded providers) the
 * existing provider-repair summary.
 *
 * This test pins the helper `writeDriftAdvisorySummary(deps, advisories)`
 * which renders the drift block. The integration test (Unit 5) covers
 * the end-to-end ouro-up --no-repair flow.
 */

import { describe, expect, it, vi } from "vitest"
import { writeDriftAdvisorySummary } from "../../../heart/daemon/cli-exec"
import type { DriftFinding } from "../../../heart/daemon/drift-detection"

function finding(overrides: Partial<DriftFinding> = {}): DriftFinding {
  return {
    agent: "slugger",
    lane: "outward",
    intentProvider: "openai",
    intentModel: "claude-opus-4-7",
    observedProvider: "anthropic",
    observedModel: "claude-opus-4-6",
    reason: "provider-model-changed",
    repairCommand: "ouro use --agent slugger --lane outward --provider openai --model claude-opus-4-7",
    ...overrides,
  }
}

describe("writeDriftAdvisorySummary (Unit 4a)", () => {
  it("writes nothing when advisories array is empty", () => {
    const writeStdout = vi.fn()
    writeDriftAdvisorySummary({ writeStdout }, [])
    expect(writeStdout).not.toHaveBeenCalled()
  })

  it("writes a single advisory block with intent/observed and repair command", () => {
    const writeStdout = vi.fn()
    writeDriftAdvisorySummary({ writeStdout }, [finding()])
    expect(writeStdout).toHaveBeenCalledTimes(1)
    const output = writeStdout.mock.calls[0][0] as string
    expect(output).toMatch(/drift/i)
    expect(output).toContain("slugger")
    expect(output).toContain("outward")
    expect(output).toContain("openai/claude-opus-4-7")
    expect(output).toContain("anthropic/claude-opus-4-6")
    expect(output).toContain("ouro use --agent slugger --lane outward --provider openai --model claude-opus-4-7")
  })

  it("writes multiple advisory blocks separated visibly when multiple findings exist", () => {
    const writeStdout = vi.fn()
    const findings: DriftFinding[] = [
      finding({
        agent: "alpha",
        lane: "outward",
        repairCommand: "ouro use --agent alpha --lane outward --provider openai --model claude-opus-4-7",
      }),
      finding({
        agent: "beta",
        lane: "inner",
        intentProvider: "minimax",
        intentModel: "minimax-m2.5",
        repairCommand: "ouro use --agent beta --lane inner --provider minimax --model minimax-m2.5",
      }),
    ]
    writeDriftAdvisorySummary({ writeStdout }, findings)
    expect(writeStdout).toHaveBeenCalledTimes(1)
    const output = writeStdout.mock.calls[0][0] as string
    expect(output).toContain("alpha")
    expect(output).toContain("beta")
    expect(output).toContain("ouro use --agent alpha")
    expect(output).toContain("ouro use --agent beta --lane inner --provider minimax --model minimax-m2.5")
  })
})
