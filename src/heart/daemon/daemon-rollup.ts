import type { DegradedComponent, RollupStatus } from "./daemon-health"

/**
 * Minimal per-agent input shape consumed by `computeDaemonRollup`. The
 * caller (daemon-entry's `buildDaemonHealthState`) projects from
 * `DaemonAgentSnapshot` (process-manager) into this shape — the rollup
 * function only needs `name` (for diagnostics) and `status` (the live
 * state). It deliberately does NOT depend on the full snapshot type so
 * that the function stays trivially testable and decoupled from
 * process-manager internals.
 *
 * `status` is the per-agent worker status. The rollup treats `"running"`
 * as "serving" / healthy. Any other value (`"crashed"`, `"stopped"`,
 * `"starting"`, or future additions) is treated as "not serving" /
 * unhealthy. This intentional broad classification mirrors the existing
 * `daemon-entry.ts:144-146` filter (`snapshot.status !== "running"`)
 * — the rollup function inherits that boundary; widening or narrowing
 * it is out of scope for this PR.
 */
export interface AgentRollupInput {
  name: string
  status: string
}

export interface ComputeDaemonRollupInput {
  /**
   * The set of agents whose `enabled` flag is `true`, projected to the
   * minimal `AgentRollupInput` shape. The caller is responsible for
   * filtering — `computeDaemonRollup` does NOT re-filter. An empty
   * array means "no enabled agents are configured" (fresh install).
   */
  enabledAgents: AgentRollupInput[]
  /**
   * Bootstrap-degraded components from
   * `daemon-entry.ts`'s `degradedComponents[]`. These influence the
   * rollup but never escalate it past `partial` on their own — they
   * downgrade `healthy` to `partial` and never below.
   */
  bootstrapDegraded: DegradedComponent[]
  /**
   * Whether the safe-mode crash-loop detector has tripped. When true,
   * the rollup is forced to `"safe-mode"` regardless of agent or
   * bootstrap state. Caller-owned signal — comes from `safe-mode.ts`
   * via the daemon-entry boot path.
   */
  safeMode: boolean
  /**
   * Layer 4: whether drift was detected on at least one enabled agent
   * (intent in `agent.json` does not match observed binding in
   * `state/providers.json`). Drift downgrades `healthy` → `partial`
   * (same downgrade rule as `bootstrapDegraded`) but never escalates
   * past `partial`: a `degraded` rollup stays `degraded` and a
   * `safe-mode` rollup stays `safe-mode`. Drift is advisory.
   *
   * Optional for backward compatibility: pre-Layer-4 callers omit it,
   * which the rollup treats as "no drift detected."
   */
  driftDetected?: boolean
}

/**
 * Pure rollup decision function — given the post-inventory daemon
 * surface, returns the daemon-wide rollup state per the locked Layer 1
 * vocabulary table:
 *
 *   | rollup     | when                                                      |
 *   | ---------- | --------------------------------------------------------- |
 *   | healthy    | every enabled agent serving + no bootstrap-degraded + no safe-mode |
 *   | partial    | (≥1 serving + ≥1 not serving) OR (all serving + ≥1 bootstrap-degraded) |
 *   | degraded   | zero enabled agents serving (fresh install OR all unhealthy)        |
 *   | safe-mode  | `safeMode === true` overrides everything else                       |
 *
 * The function NEVER returns `"down"`. By the time `computeDaemonRollup`
 * is reachable, the daemon process has started, opened its socket, and
 * read its agent inventory — pre-inventory failure is the caller's
 * domain. `daemon-entry.ts`'s startup-failure path assigns `"down"` to
 * `DaemonHealthState.status` directly without consulting this function.
 */
export function computeDaemonRollup(input: ComputeDaemonRollupInput): RollupStatus {
  // Safe mode wins, period. Crash-loop detection trumps everything —
  // we want the human to see SAFE MODE, not a noisy partial/degraded.
  if (input.safeMode) {
    return "safe-mode"
  }

  // Count serving agents. "Serving" = "running" worker status.
  // Anything else (crashed/stopped/starting/etc) is not serving.
  let serving = 0
  let notServing = 0
  for (const agent of input.enabledAgents) {
    if (agent.status === "running") {
      serving++
    } else {
      notServing++
    }
  }

  // Zero-serving wins over bootstrap-degraded — we have no working
  // agents to surface a "partially working" story about. This covers
  // both fresh-install (`enabledAgents.length === 0`) and
  // all-failed-live-check (`serving === 0` with `notServing > 0`).
  // Render layer (cli-render.ts) splits the UX copy by inspecting the
  // agents map; the rollup itself doesn't carry the distinction.
  if (serving === 0) {
    return "degraded"
  }

  // From here we have ≥1 serving agent. The remaining choice is
  // healthy vs partial.
  const hasUnhealthyAgent = notServing > 0
  const hasBootstrapDegraded = input.bootstrapDegraded.length > 0
  const hasDrift = input.driftDetected === true

  if (hasUnhealthyAgent || hasBootstrapDegraded || hasDrift) {
    return "partial"
  }

  return "healthy"
}
