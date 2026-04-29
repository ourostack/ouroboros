# Layer 4 — Provider-Binding Drift Detection (read-only)

Detects per-lane drift between each agent's intent (committed `agent.json`) and the observed binding on this machine (`state/providers.json`), surfaces the drift through the existing `EffectiveProviderReadiness.reason: "provider-model-changed"` vocabulary, and emits a copy-pasteable `ouro use` repair proposal. This PR is **read-only** — it never mutates `state/providers.json` and never invokes the `ouro use` CLI surface. The operator (or, in Layer 3, RepairGuide) is responsible for executing the repair.

This is PR 2 of 4 in the harness-hardening sequence (1 → 4 → 2 → 3). Builds on the Layer 1 rollup vocabulary (`#644`).

## What lands

- **`src/heart/daemon/drift-detection.ts`** — new module:
  - `detectProviderBindingDrift(input)` — pure intent-vs-observed comparator. Tolerates legacy `humanFacing`/`agentFacing` AND new `outward`/`inner` keys in `agent.json`, with "new key wins, fall back to legacy" precedence (the rename is in flight; mixed `agent.json` files must work).
  - `loadDriftInputsForAgent(bundlesRoot, agentName)` — I/O wrapper that reads `agent.json` + `state/providers.json` off disk. Maps the `missing` and `invalid` `state/providers.json` cases to `null` (the comparator interprets `null` as "no observation, nothing to drift against").
- **`src/heart/daemon/agent-config-check.ts`** — `checkAgentConfigWithProviderHealth` gains an additive optional `driftFindings: DriftFinding[]` field on `ConfigCheckResult`. Drift detection runs once after state setup and rides along with both success and failure return paths. Drift is advisory and never flips `ok` to false.
- **`src/heart/daemon/daemon-rollup.ts`** — `ComputeDaemonRollupInput` gains an optional `driftDetected: boolean`. When true, `healthy` → `partial` (same downgrade rule as `bootstrapDegraded`). `degraded` and `safe-mode` rollups are unaffected — drift never escalates past `partial`.
- **`src/heart/daemon/daemon-entry.ts`** — `buildDaemonHealthState` probes each enabled agent for drift before computing the rollup. A single agent's read failure does not block the rest of the scan (best-effort).
- **`src/heart/daemon/inner-status.ts`** — `BuildInnerStatusInput` gains an optional `driftFindings: DriftFinding[]`. When non-empty, a "drift advisory" section renders per-finding lines with intent vs observed bindings and the copy-pasteable `ouro use` repair command. Pre-Layer-4 callers (callers that don't pass the field) see unchanged output.
- **`src/heart/daemon/daemon-health.ts`** — `DaemonHealthState` gains a required `drift: DriftFinding[]` field. `readHealth` tolerates legacy cached health files missing the field (defaults to `[]`). Required by post-review fix below to give `ouro status` a daemon-level explanation when rollup is `partial` due to drift.
- **`src/heart/daemon/cli-render.ts:renderRollupStatusLine`** — `partial` branch now distinguishes three sub-cases by inspecting agent statuses + `health.drift`:
  - agents-unhealthy-only → `"N agent(s) unhealthy"` (existing copy, refined to count)
  - drift-only → `"drift on N agent(s)"` (NEW — the load-bearing fix)
  - both → `"N agent(s) unhealthy; drift on M agent(s)"` (NEW)
  - neither (legacy file with `partial` status but no visible cause) → `"stale cache, run `ouro up` to refresh"` fallback (NEW)
- **`src/heart/daemon/cli-exec.ts`** —
  - New `collectAgentDriftAdvisories(deps)` and `writeDriftAdvisorySummary(deps, advisories)` helpers.
  - Wired into the `--no-repair` boot path (both preflight provider-degraded and post-startup paths) so drift advisories ride along with provider-repair summaries — the operator sees them without running `ouro inner status` per agent.
  - Wired into the `inner.status` command handler so `ouro inner status` shows drift advisories.

## Vocabulary it consumes (Layer 1)

- `RollupStatus` and `DaemonStatus` from `daemon-health.ts` (`#644`).
- `computeDaemonRollup` from `daemon-rollup.ts` — extended additively with `driftDetected`.
- `EffectiveProviderReadiness.reason = "provider-model-changed"` from `provider-binding-resolver.ts` (already existed pre-Layer-4; this PR populates it via the new comparator).
- `normalizeProviderLane` from `provider-binding-resolver.ts` — referenced for the legacy/new lane semantics; the comparator embeds the same precedence rule directly so it can read raw `agent.json` shapes (which may carry either or both key sets during the rename).

## Read-only invariant

`grep -nE "writeFile|writeFileSync|fs\.write" src/heart/daemon/drift-detection.ts` returns nothing. The integration test (Unit 5) explicitly asserts that `state/providers.json` bytes are unchanged before and after a `checkAgentConfigWithProviderHealth` call against a drift fixture.

## Layered downgrade rule (Layer 1 vocabulary)

Drift inherits the existing "advisory-only" rule:

| rollup     | with drift detected → | with drift absent → |
| ---------- | --------------------- | ------------------- |
| healthy    | partial               | healthy             |
| partial    | partial               | partial             |
| degraded   | degraded              | degraded            |
| safe-mode  | safe-mode             | safe-mode           |

Drift can downgrade `healthy` → `partial`; it cannot escalate further and cannot un-downgrade `degraded` → `partial`.

## Tests

- `drift-detection.test.ts` (14 tests) — comparator unit tests covering all lane-key combinations + missing-intent edge cases.
- `drift-loader.test.ts` (11 tests) — loader unit tests covering missing/malformed/structurally-invalid `state/providers.json`, missing/malformed `agent.json`, and read-only invariant.
- `agent-config-check-drift.test.ts` (6 tests) — integration with the existing `checkAgentConfigWithProviderHealth` flow.
- `drift-rollup.test.ts` (8 tests) — `computeDaemonRollup` × `driftDetected` table.
- `inner-status-drift.test.ts` (5 tests) — drift advisory rendering in `buildInnerStatusOutput`.
- `drift-no-repair-summary.test.ts` (3 tests) — `writeDriftAdvisorySummary` helper.
- `daemon-entry-rollup.test.ts` (extended, 1 new test) — end-to-end drift downgrade through `daemon-entry`.
- `drift-detection-integration.test.ts` (4 tests) — fixture-driven on-disk integration test, including the read-only invariant assertion.
- All pre-existing `agent-config-check` and `agent-config-provider-state` tests pass; the additive `driftFindings` field required loosening a few `toEqual({ok: true})` assertions to `toMatchObject({ok: true})`.

100% coverage on all new and changed source files. Full test suite green (9871 passing). Typecheck clean. Lint clean. Coverage gate passes.

## What this PR does NOT do (next layers)

- **Layer 2** (sync probe): independent of this PR. Touches `ouro up` boot path and `preTurnPull` wiring.
- **Layer 3** (RepairGuide): consumes the `driftFindings` array surfaced here to decide whether to fire its repair action. Layer 3 is where drift findings cease to be advisory and become actionable.
