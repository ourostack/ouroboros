/**
 * Unit 4a: tests for `computeDaemonRollup`'s drift integration.
 *
 * Layer 4 adds drift findings as an additional input to the daemon rollup.
 * The rule is the same as the bootstrap-degraded downgrade: drift NEVER
 * escalates a rollup past `partial`. Concretely:
 *
 * | scenario                                           | rollup result |
 * | -------------------------------------------------- | ------------- |
 * | all serving + no bootstrap-degraded + no drift     | healthy       |
 * | all serving + no bootstrap-degraded + drift        | partial       |
 * | all serving + bootstrap-degraded + drift           | partial       |
 * | mixed serving + drift                              | partial       |
 * | zero serving + drift                               | degraded      |
 * | safe-mode + drift                                  | safe-mode     |
 *
 * `driftDetected` is a boolean (presence-only). The rollup function does
 * not consume the per-finding detail — that is the job of the render
 * layer (Unit 4b's inner-status changes) and Layer 3 RepairGuide.
 */

import { describe, expect, it } from "vitest"
import { computeDaemonRollup } from "../../../heart/daemon/daemon-rollup"

describe("computeDaemonRollup with drift detection (Unit 4a)", () => {
  it("returns 'partial' when all agents are serving but drift was detected", () => {
    expect(computeDaemonRollup({
      enabledAgents: [{ name: "alpha", status: "running" }],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: true,
    })).toBe("partial")
  })

  it("returns 'healthy' when all agents are serving and no drift was detected", () => {
    expect(computeDaemonRollup({
      enabledAgents: [{ name: "alpha", status: "running" }],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: false,
    })).toBe("healthy")
  })

  it("treats absent driftDetected as 'no drift' (backward compatibility — additive field)", () => {
    // Pre-Layer-4 callers don't set driftDetected. The rollup must still
    // return 'healthy' for them when everything else is fine.
    expect(computeDaemonRollup({
      enabledAgents: [{ name: "alpha", status: "running" }],
      bootstrapDegraded: [],
      safeMode: false,
    })).toBe("healthy")
  })

  it("stays 'partial' when bootstrap-degraded AND drift both exist (no escalation past partial)", () => {
    expect(computeDaemonRollup({
      enabledAgents: [{ name: "alpha", status: "running" }],
      bootstrapDegraded: [{ component: "habits:alpha", reason: "boot failure", since: "2026-04-28T19:30:00.000Z" }],
      safeMode: false,
      driftDetected: true,
    })).toBe("partial")
  })

  it("stays 'partial' when mixed serving + drift (drift is irrelevant when partial is already chosen)", () => {
    expect(computeDaemonRollup({
      enabledAgents: [
        { name: "alpha", status: "running" },
        { name: "beta", status: "crashed" },
      ],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: true,
    })).toBe("partial")
  })

  it("stays 'degraded' when zero agents serving + drift (drift never escalates past degraded → partial)", () => {
    // Drift is an advisory: it can downgrade healthy → partial, but it
    // cannot un-downgrade degraded → partial. A daemon with zero serving
    // agents stays degraded regardless of drift.
    expect(computeDaemonRollup({
      enabledAgents: [{ name: "alpha", status: "crashed" }],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: true,
    })).toBe("degraded")
  })

  it("stays 'degraded' when no enabled agents (fresh install) + drift", () => {
    expect(computeDaemonRollup({
      enabledAgents: [],
      bootstrapDegraded: [],
      safeMode: false,
      driftDetected: true,
    })).toBe("degraded")
  })

  it("stays 'safe-mode' when safeMode=true regardless of drift", () => {
    expect(computeDaemonRollup({
      enabledAgents: [{ name: "alpha", status: "running" }],
      bootstrapDegraded: [],
      safeMode: true,
      driftDetected: true,
    })).toBe("safe-mode")
  })
})
