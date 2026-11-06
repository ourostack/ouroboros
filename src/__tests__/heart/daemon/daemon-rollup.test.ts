/**
 * Unit 2a: tests for computeDaemonRollup — the locked Layer 1 rollup
 * decision function. Each row of the rollup state table from the doing
 * doc gets its own test case.
 *
 * Pinned input contract:
 * - enabledAgents is pre-filtered. The caller (daemon-entry) is
 *   responsible for filtering out disabled bundles via
 *   listEnabledBundleAgents (or equivalent) before invoking. The rollup
 *   function does NOT re-filter — it treats every entry in the array as
 *   an enabled agent that should be serving.
 * - bootstrapDegraded is the daemon-entry-tracked degradedComponents
 *   list. Bootstrap-degraded entries influence the rollup but never
 *   escalate it past `partial` on their own (downgrade rule: healthy →
 *   partial, never below).
 * - safeMode is the boolean from safe-mode.ts crash-loop detection.
 *   When true, rollup is forced to `safe-mode` regardless of agent or
 *   bootstrap state.
 *
 * The function returns RollupStatus (4-state). It NEVER returns
 * `"down"` — that is caller-owned, set elsewhere in the daemon-entry
 * flow before the rollup is reachable.
 */

import { describe, expect, it } from "vitest"
import { computeDaemonRollup, type AgentRollupInput } from "../../../heart/daemon/daemon-rollup"
import type { RollupStatus, DegradedComponent } from "../../../heart/daemon/daemon-health"

function healthyAgent(name: string): AgentRollupInput {
  return { name, status: "running" }
}

function unhealthyAgent(name: string, status: AgentRollupInput["status"] = "crashed"): AgentRollupInput {
  return { name, status }
}

function bootstrapEntry(component: string, reason = "boot failure"): DegradedComponent {
  return { component, reason, since: "2026-04-28T19:30:00.000Z" }
}

describe("computeDaemonRollup — rollup state table", () => {
  describe("Row 1: all healthy → healthy", () => {
    it("returns 'healthy' when every enabled agent is running and there are no bootstrap-degraded entries and no safe-mode", () => {
      const result: RollupStatus = computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha"), healthyAgent("beta")],
        bootstrapDegraded: [],
        safeMode: false,
      })
      expect(result).toBe("healthy")
    })

    it("returns 'healthy' for a single healthy agent", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("solo")],
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("healthy")
    })
  })

  describe("Row 2: all healthy + bootstrap-degraded → partial (downgrade rule)", () => {
    it("downgrades 'healthy' to 'partial' when ≥1 bootstrap-degraded component exists, even if every enabled agent is healthy", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha"), healthyAgent("beta")],
        bootstrapDegraded: [bootstrapEntry("habits:alpha")],
        safeMode: false,
      })).toBe("partial")
    })

    it("treats multiple bootstrap-degraded entries the same way (still 'partial', not escalated past)", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha")],
        bootstrapDegraded: [bootstrapEntry("habits:alpha"), bootstrapEntry("cron:alpha")],
        safeMode: false,
      })).toBe("partial")
    })
  })

  describe("Row 3: ≥1 healthy + ≥1 unhealthy → partial", () => {
    it("returns 'partial' when at least one agent is healthy and at least one is unhealthy", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha"), unhealthyAgent("beta")],
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("partial")
    })

    it("returns 'partial' regardless of which slot is healthy/unhealthy", () => {
      // Permutation guard: order independence
      expect(computeDaemonRollup({
        enabledAgents: [unhealthyAgent("alpha"), healthyAgent("beta")],
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("partial")
    })

    it("returns 'partial' for any non-running unhealthy state (crashed/stopped/starting)", () => {
      for (const badStatus of ["crashed", "stopped", "starting"] as const) {
        expect(computeDaemonRollup({
          enabledAgents: [healthyAgent("alpha"), unhealthyAgent("beta", badStatus)],
          bootstrapDegraded: [],
          safeMode: false,
        })).toBe("partial")
      }
    })
  })

  describe("Row 4: zero enabled agents → degraded", () => {
    it("returns 'degraded' for an empty enabledAgents array (fresh install — no agents configured)", () => {
      expect(computeDaemonRollup({
        enabledAgents: [],
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("degraded")
    })
  })

  describe("Row 5: ≥1 enabled, all unhealthy → degraded", () => {
    it("returns 'degraded' when one enabled agent is unhealthy (zero serving)", () => {
      expect(computeDaemonRollup({
        enabledAgents: [unhealthyAgent("solo")],
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("degraded")
    })

    it("returns 'degraded' when every enabled agent is unhealthy", () => {
      expect(computeDaemonRollup({
        enabledAgents: [unhealthyAgent("alpha"), unhealthyAgent("beta", "stopped")],
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("degraded")
    })
  })

  describe("Row 6: safeMode=true overrides everything", () => {
    it("returns 'safe-mode' when safeMode is true, even if all agents are healthy", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha"), healthyAgent("beta")],
        bootstrapDegraded: [],
        safeMode: true,
      })).toBe("safe-mode")
    })

    it("returns 'safe-mode' when safeMode is true and the agent state would otherwise be 'partial'", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha"), unhealthyAgent("beta")],
        bootstrapDegraded: [],
        safeMode: true,
      })).toBe("safe-mode")
    })

    it("returns 'safe-mode' when safeMode is true and the agent state would otherwise be 'degraded'", () => {
      expect(computeDaemonRollup({
        enabledAgents: [unhealthyAgent("solo")],
        bootstrapDegraded: [],
        safeMode: true,
      })).toBe("safe-mode")
    })

    it("returns 'safe-mode' when safeMode is true even with bootstrap-degraded entries", () => {
      expect(computeDaemonRollup({
        enabledAgents: [healthyAgent("alpha")],
        bootstrapDegraded: [bootstrapEntry("habits:alpha")],
        safeMode: true,
      })).toBe("safe-mode")
    })

    it("returns 'safe-mode' when safeMode is true with zero enabled agents", () => {
      // Edge: even an empty inventory is overridden by safe mode.
      expect(computeDaemonRollup({
        enabledAgents: [],
        bootstrapDegraded: [],
        safeMode: true,
      })).toBe("safe-mode")
    })
  })

  describe("Row 7: empty enabled-agents + bootstrap-degraded → degraded", () => {
    it("returns 'degraded' (zero serving wins over bootstrap-degraded; partial requires ≥1 healthy)", () => {
      expect(computeDaemonRollup({
        enabledAgents: [],
        bootstrapDegraded: [bootstrapEntry("habits:alpha")],
        safeMode: false,
      })).toBe("degraded")
    })
  })

  describe("Row 8: all unhealthy + bootstrap-degraded → degraded", () => {
    it("returns 'degraded' when zero enabled agents are serving, regardless of bootstrap-degraded entries", () => {
      expect(computeDaemonRollup({
        enabledAgents: [unhealthyAgent("alpha"), unhealthyAgent("beta", "stopped")],
        bootstrapDegraded: [bootstrapEntry("habits:alpha"), bootstrapEntry("cron:beta")],
        safeMode: false,
      })).toBe("degraded")
    })
  })

  describe("input contract — does NOT re-filter", () => {
    it("treats every entry in enabledAgents as enabled (does not filter on a hypothetical 'enabled' field)", () => {
      // The input shape is intentionally minimal — name + status. There is
      // no `enabled` flag; callers filter before invoking. Passing two
      // healthy agents is treated as two enabled-and-healthy.
      const inputs: AgentRollupInput[] = [
        { name: "alpha", status: "running" },
        { name: "beta", status: "running" },
      ]
      expect(computeDaemonRollup({
        enabledAgents: inputs,
        bootstrapDegraded: [],
        safeMode: false,
      })).toBe("healthy")
    })

    it("does not mutate its inputs (pure function)", () => {
      const enabledAgents: AgentRollupInput[] = [healthyAgent("alpha")]
      const bootstrapDegraded: DegradedComponent[] = [bootstrapEntry("habits:alpha")]
      const inputSnapshot = {
        agents: JSON.stringify(enabledAgents),
        bootstrap: JSON.stringify(bootstrapDegraded),
      }
      computeDaemonRollup({ enabledAgents, bootstrapDegraded, safeMode: false })
      expect(JSON.stringify(enabledAgents)).toBe(inputSnapshot.agents)
      expect(JSON.stringify(bootstrapDegraded)).toBe(inputSnapshot.bootstrap)
    })

    it("is deterministic on its inputs (same input → same output)", () => {
      const input = {
        enabledAgents: [healthyAgent("alpha"), unhealthyAgent("beta")],
        bootstrapDegraded: [],
        safeMode: false,
      }
      expect(computeDaemonRollup(input)).toBe(computeDaemonRollup(input))
    })
  })

  describe("return-type contract", () => {
    it("never returns 'down' (caller-owned)", () => {
      // Exercise every input branch and assert no 'down' is produced.
      const cases = [
        { enabledAgents: [], bootstrapDegraded: [], safeMode: false },
        { enabledAgents: [], bootstrapDegraded: [], safeMode: true },
        { enabledAgents: [healthyAgent("a")], bootstrapDegraded: [], safeMode: false },
        { enabledAgents: [healthyAgent("a")], bootstrapDegraded: [bootstrapEntry("x")], safeMode: false },
        { enabledAgents: [unhealthyAgent("a")], bootstrapDegraded: [], safeMode: false },
        { enabledAgents: [healthyAgent("a"), unhealthyAgent("b")], bootstrapDegraded: [], safeMode: false },
      ]
      for (const c of cases) {
        const result = computeDaemonRollup(c)
        expect(result).not.toBe("down")
        expect(["healthy", "partial", "degraded", "safe-mode"]).toContain(result)
      }
    })
  })
})
