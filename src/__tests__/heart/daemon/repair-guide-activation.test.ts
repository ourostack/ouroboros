import { describe, expect, it } from "vitest"
import { shouldFireRepairGuide } from "../../../heart/daemon/agentic-repair"
import type { DegradedAgent } from "../../../heart/daemon/interactive-repair"

/**
 * Layer 3 — RepairGuide activation contract.
 *
 * The pre-existing gate at `cli-exec.ts:6706` fires `runAgenticRepair` when
 * `untypedDegraded.length > 0`. This PR extends the gate to also fire when
 * `typedDegraded.length >= 3` (compound situations). The threshold is 3, not
 * 2 — common pairs like vault-locked + provider-auth-needed should NOT
 * trigger the new path on every boot.
 *
 * `--no-repair` short-circuits the entire decision regardless of finding mix.
 */
describe("shouldFireRepairGuide", () => {
  function deg(agent: string, issue: string): DegradedAgent {
    // Cast: tests pass arbitrary issue strings through; the activation
    // function does not inspect the issue field.
    return {
      agent,
      errorReason: `${agent}: ${issue}`,
      fixHint: "",
      issue: issue as unknown as DegradedAgent["issue"],
    }
  }

  it("returns false when noRepair is true regardless of finding mix", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [deg("a", "x"), deg("b", "y")],
        typedDegraded: [deg("c", "vault-locked"), deg("d", "provider-auth-needed"), deg("e", "drift")],
        noRepair: true,
      }),
    ).toBe(false)
  })

  it("returns true when any untyped degraded entry exists (preserves today's behavior)", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [deg("a", "weird-error")],
        typedDegraded: [],
        noRepair: false,
      }),
    ).toBe(true)
  })

  it("returns false when there are zero typed degraded entries and zero untyped", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [],
        typedDegraded: [],
        noRepair: false,
      }),
    ).toBe(false)
  })

  it("returns false when there is one typed degraded entry and no untyped", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [],
        typedDegraded: [deg("a", "vault-locked")],
        noRepair: false,
      }),
    ).toBe(false)
  })

  it("returns false for the canonical common pair (2 typed, no untyped)", () => {
    // Lock: vault-locked + provider-auth-needed should NOT fire RepairGuide
    // on every boot. Two is below the threshold by design.
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [],
        typedDegraded: [deg("a", "vault-locked"), deg("a", "provider-auth-needed")],
        noRepair: false,
      }),
    ).toBe(false)
  })

  it("returns true at the threshold (exactly 3 typed degraded entries, no untyped)", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [],
        typedDegraded: [
          deg("a", "vault-locked"),
          deg("a", "provider-auth-needed"),
          deg("a", "drift"),
        ],
        noRepair: false,
      }),
    ).toBe(true)
  })

  it("returns true for high-stack typed degraded counts (5)", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [],
        typedDegraded: [
          deg("a", "x1"),
          deg("a", "x2"),
          deg("a", "x3"),
          deg("a", "x4"),
          deg("a", "x5"),
        ],
        noRepair: false,
      }),
    ).toBe(true)
  })

  it("returns false when noRepair is false and typed=2 and untyped=0", () => {
    // Explicit symmetric case to the common-pair test, written from the
    // 'noRepair: false' angle — defends against future refactors that
    // change branch ordering.
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [],
        typedDegraded: [deg("a", "x"), deg("b", "y")],
        noRepair: false,
      }),
    ).toBe(false)
  })

  it("respects noRepair even when conditions otherwise satisfy the contract", () => {
    expect(
      shouldFireRepairGuide({
        untypedDegraded: [deg("a", "weird")],
        typedDegraded: [],
        noRepair: true,
      }),
    ).toBe(false)
  })
})
