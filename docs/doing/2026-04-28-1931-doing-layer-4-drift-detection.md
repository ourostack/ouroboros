# Doing: Layer 4 — Provider-Binding Drift Detection (read-only)

**Status**: READY_FOR_EXECUTION
**Execution Mode**: direct (strict-TDD)
**Created**: 2026-04-28 19:31 UTC
**Planning**: ../planning/2026-04-28-1900-planning-harness-hardening-and-repairguide.md
**Artifacts**: ./2026-04-28-1931-doing-layer-4-drift-detection/

**PR shape**: Standalone PR. Second in the four-PR sequence (1 → 4 → 2 → 3).
**Depends on**: Layer 1 PR (`2026-04-28-1930-doing-layer-1-rollup-vocabulary.md`) being merged first. This branch must be cut from main *after* layer 1 lands so the new `DaemonStatus` vocabulary is available.
**Downstream consumers**: Layer 3 reads drift-detection output to decide whether RepairGuide should fire. Layer 2 does not depend on this PR.

## Execution Mode

- **direct** with strict TDD enforced. Single-session execution. Sequential units. Commit per phase.

## Objective

Detect drift between each agent's intent (committed `agent.json`) and observed binding (per-machine `state/providers.json`) at boot. Surface the drift as a per-agent advisory using the existing partially-built `EffectiveProviderReadiness.reason: "provider-model-changed"` signal. Emit a copy-pasteable `ouro use --agent X --lane Y --provider Z --model M` repair proposal.

This PR is **read-only**: it never writes to `state/providers.json` and never invokes the `ouro use` CLI surface. It only surfaces the drift and the suggested fix; the operator (or, in layer 3, RepairGuide-driven typed-action runners) executes the repair.

## Completion Criteria

- [ ] Drift detection runs once per `ouro up` per enabled agent.
- [ ] For each enabled agent, compare `agent.json`'s `humanFacing`/`agentFacing` (legacy) or `outward`/`inner` (new) lane bindings against `state/providers.json`'s observed binding.
- [ ] Read side tolerates legacy `humanFacing`/`agentFacing` keys AND new `outward`/`inner` keys (`normalizeProviderLane` already does this — use it, do not reinvent).
- [ ] On mismatch, populate `EffectiveProviderReadiness.reason = "provider-model-changed"` (existing field; populate, don't invent).
- [ ] Emit a per-agent drift advisory rolled up via the layer 1 vocabulary. Drift alone does NOT promote an agent past `partial`; it is advisory.
- [ ] Repair proposal: a copy-pasteable `ouro use --agent {name} --lane {outward|inner} --provider {name} --model {id}` string surfaced through `inner-status.ts` and any `--no-repair` summary path.
- [ ] If `state/providers.json` is absent (fresh install), emit no drift signal — there is nothing to drift against.
- [ ] Slugger fixture (full slugger-shape from planning Layer 1 fixture, when available — for this PR a synthetic per-condition fixture is acceptable) shows correct drift detection on the `agent.json` ↔ `state/providers.json` mismatch.
- [ ] No writes to `state/` from any code added in this PR.
- [ ] 100% test coverage on all new code.
- [ ] All tests pass.
- [ ] No warnings.
- [ ] PR description (`./2026-04-28-1931-doing-layer-4-drift-detection/pr-description.md`) drafted before merger.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- All branches of the drift comparison (intent matches observed → no drift; provider differs; model differs; lane is missing in state; lane is missing in agent.json).
- All error paths (malformed `state/providers.json`, missing file, malformed `agent.json` provider blocks).
- Edge cases:
  - Both legacy field names (`humanFacing`/`agentFacing`).
  - Both new field names (`outward`/`inner`).
  - Mixed (one legacy lane, one new lane in the same `agent.json`) — must work because the rename is in flight.
  - `state/providers.json` absent.
  - `state/providers.json` present but no entry for this agent.
  - Provider matches, model differs.
  - Provider differs, model matches.
  - Both differ.
  - `agent.json` has `humanFacing`, `state/providers.json` has the corresponding `outward` entry — must match (the normalization is the contract).

## TDD Requirements

**Strict TDD — no exceptions:**
1. **Tests first**: Write failing tests BEFORE any implementation.
2. **Verify failure**: Run tests, confirm they FAIL (red).
3. **Minimal implementation**: Write just enough code to pass.
4. **Verify pass**: Run tests, confirm they PASS (green).
5. **Refactor**: Clean up, keep tests green.
6. **No skipping**: Never write implementation without failing test first.

## Work Units

### Legend
⬜ Not started · 🔄 In progress · ✅ Done · ❌ Blocked

### ⬜ Unit 0: Verify layer 1 has landed
**What**: Confirm `DaemonStatus` union type from layer 1 is in `daemon-health.ts` and `computeDaemonRollup` exists. If not, halt — do not start this PR.
**Acceptance**: `git log` shows layer 1 PR merged on the base branch. `grep -rn "DaemonStatus" src/heart/daemon/daemon-health.ts` returns the type definition.

### ⬜ Unit 1a: Drift comparator — Tests
**What**: Write failing tests for `detectProviderBindingDrift(input: { agentName: string; agentJson: AgentConfig; providerState: ProviderState | null }): DriftFinding[]` in `src/__tests__/heart/daemon/drift-detection.test.ts` (new file). Cover every edge case from "Code Coverage Requirements".

Use existing types: `AgentConfig` from `src/heart/identity.ts`; `ProviderState` from `src/heart/provider-state.ts:27`. Use `readProviderState(agentRoot)` (`provider-state.ts:156`) for I/O — it returns `ProviderStateReadResult` (a discriminated union — handle the `null` case as "no observed binding for this agent").

**Output shape**:
```ts
interface DriftFinding {
  agent: string
  lane: "outward" | "inner"
  intentProvider: string
  intentModel: string
  observedProvider: string
  observedModel: string
  reason: "provider-model-changed"  // populates EffectiveProviderReadiness.reason
  repairCommand: string             // "ouro use --agent X --lane Y --provider Z --model M"
}
```
**Acceptance**: Tests exist and FAIL (red). All edge cases covered.

### ⬜ Unit 1b: Drift comparator — Implementation
**What**: Implement `detectProviderBindingDrift` in `src/heart/daemon/drift-detection.ts` (new file). Use `normalizeProviderLane` from `provider-binding-resolver.ts` for legacy/new lane key handling. Pure function — no I/O. Caller is responsible for reading `state/providers.json` and `agent.json` and passing them in.
**Acceptance**: Tests PASS (green). Function is pure.

### ⬜ Unit 1c: Drift comparator — Coverage & refactor
**What**: Verify 100% branch coverage. Refactor for clarity if needed.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 2a: Drift loader — Tests
**What**: Write failing tests for `loadDriftInputsForAgent(bundleRoot: string, agentName: string): { agentJson: AgentConfig; providerState: ProviderState | null }` in `src/__tests__/heart/daemon/drift-loader.test.ts`. Cover: missing `state/providers.json` (use `readProviderState` which returns `ProviderStateReadResult` — map the absent/error cases to null), malformed `state/providers.json`, missing `agent.json`, malformed `agent.json` (these last two should throw — caller decides whether to swallow), legacy `humanFacing/agentFacing` keys handled by `normalizeProviderLane`, new `outward/inner` keys handled.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 2b: Drift loader — Implementation
**What**: Implement `loadDriftInputsForAgent` in `src/heart/daemon/drift-detection.ts` (same file). Use `readProviderState(agentRoot)` from `provider-state.ts:156` for the observed-state read. Use the existing `agent.json` reader path (`agent-config-check.ts` or `agent-discovery.ts` already have one — pick the most appropriate; do not reinvent). Reads files; never writes.
**Acceptance**: Tests PASS (green).

### ⬜ Unit 2c: Drift loader — Coverage & refactor
**What**: Verify 100% coverage. Refactor.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 3a: Wire into `agent-config-check.ts` — Tests
**What**: `checkAgentConfigWithProviderHealth` in `src/heart/daemon/agent-config-check.ts` is the existing per-agent boot-time validator. Add drift-detection invocation immediately after the live-ping. Write failing tests in `src/__tests__/heart/daemon/agent-config-check-drift.test.ts` asserting:
- Healthy agent with no drift → no drift findings reported.
- Healthy agent with intent/observed mismatch → drift finding emitted, `reason = "provider-model-changed"`, `repairCommand` populated.
- Agent missing from `state/providers.json` → no drift (nothing to compare against).
- `agent.json` provider lane parse failure → propagate as existing error path; no drift finding.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 3b: Wire into `agent-config-check.ts` — Implementation
**What**: Modify `checkAgentConfigWithProviderHealth` to call `loadDriftInputsForAgent` + `detectProviderBindingDrift` and append findings to its return type. Extend the return type with `driftFindings: DriftFinding[]` (additive, non-breaking).
**Acceptance**: Tests from 3a PASS. Existing tests for `checkAgentConfigWithProviderHealth` still pass.

### ⬜ Unit 3c: Wire into `agent-config-check.ts` — Coverage & refactor
**What**: Verify coverage on changed lines.
**Acceptance**: Coverage 100% on new lines. All tests green.

### ⬜ Unit 4a: Surface drift in rollup + render — Tests
**What**: Write failing tests asserting:
- Drift findings present + agent live-check healthy → daemon rollup is `partial` (downgrade rule from layer 1; drift is advisory).
- Drift findings absent + agent live-check healthy → daemon rollup is `healthy`.
- `inner-status.ts` renders the drift advisory (the agent name + lane + repair command).
- `--no-repair` flag still surfaces drift advisories in the summary path (it just skips the repair invocation, which is layer 3's domain).

Place in `src/__tests__/heart/daemon/drift-rollup.test.ts` and extend `inner-status-vocabulary.test.ts` from layer 1.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 4b: Surface drift in rollup + render — Implementation
**What**:
- Pass drift findings into `computeDaemonRollup` (extend the input shape if necessary). Encode the rule "any drift finding downgrades `healthy` → `partial`, no further escalation."
- Update `inner-status.ts` render to print drift advisories with the copy-pasteable `ouro use` command.
**Acceptance**: Tests from 4a PASS.

### ⬜ Unit 4c: Surface drift in rollup + render — Coverage & refactor
**What**: 100% coverage on changes. Lint + typecheck clean.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 5: Per-condition fixture for drift — Tests
**What**: Build an integration-style test fixture that creates a temp `agent.json` with intent X and a temp `state/providers.json` with observation Y, runs `checkAgentConfigWithProviderHealth`, and asserts the drift finding + the rolled-up daemon status. Place in `src/__tests__/heart/daemon/drift-detection-integration.test.ts`. Use `serpentguide-bootstrap.test.ts` as the structural precedent for filesystem fixtures.
**Acceptance**: Test exists and PASSES (this is the integration-level acceptance test, not a unit-level red→green).

### ⬜ Unit 6: Full-suite green + PR description
**What**:
- Run full test suite. All green.
- `tsc --noEmit` clean.
- Lint clean.
- Verify NO writes to `state/` from any new code (`grep -n "writeFile\|writeFileSync\|fs.write" src/heart/daemon/drift-detection.ts` returns nothing).
- Draft `./2026-04-28-1931-doing-layer-4-drift-detection/pr-description.md`. Cite the layer 1 vocabulary it consumes. Note "next: layer 2 sync probe (independent of this PR); layer 3 RepairGuide consumes drift findings."
**Acceptance**: Suite green. Typecheck clean. Lint clean. No `state/` writes. PR description drafted.

## Execution
- TDD strictly enforced.
- Commit per phase. Push per unit.
- All artifacts in `./2026-04-28-1931-doing-layer-4-drift-detection/`.

## Reference: load-bearing source paths

- `src/heart/provider-binding-resolver.ts:64-67` (`EffectiveProviderReadiness`; `reason` enum already includes `provider-model-changed` and `credential-revision-changed`)
- `src/heart/provider-binding-resolver.ts:246-285` (`staleReadiness` already used in production code at line 277 when `input.readiness.provider !== input.provider || input.readiness.model !== input.model`. This is a different comparison than Layer 4's intent-vs-observed; Layer 4 does NOT modify the existing `resolveReadiness` flow. Layer 4 is a SEPARATE diagnostic pass that emits its own `DriftFinding[]`.)
- `src/heart/provider-binding-resolver.ts` (`normalizeProviderLane` — handles legacy `humanFacing`/`agentFacing` ↔ new `outward`/`inner`)
- `src/heart/provider-state.ts:27` (`ProviderState` — the on-disk shape of `state/providers.json`)
- `src/heart/provider-state.ts:114` (`validateProviderState` — use this when reading)
- `src/heart/provider-state.ts:152-156` (`getProviderStatePath`, `readProviderState`)
- `src/heart/daemon/agent-config-check.ts` (`checkAgentConfigWithProviderHealth` — entry point for per-agent boot validation; Layer 4 hooks here)
- `src/heart/daemon/agent-discovery.ts` (`listEnabledBundleAgents`)
- `src/heart/daemon/daemon-health.ts` (`DaemonStatus`, `computeDaemonRollup` from layer 1)
- `src/heart/daemon/inner-status.ts` (rendering — drift advisory display)
- `state/providers.json` (per-machine, gitignored — read-only target)
- `src/__tests__/heart/daemon/serpentguide-bootstrap.test.ts` (test structure precedent)

## Progress Log
- 2026-04-28 19:31 UTC Created as PR 2 of 4 in the sequential rollout (1 → 4 → 2 → 3). Depends on layer 1 PR being merged.
