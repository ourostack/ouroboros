# Doing: Layer 1 — Rollup Vocabulary Fix (`healthy/partial/degraded/safe-mode/down`)

**Status**: done
**Execution Mode**: direct (strict-TDD)
**Created**: 2026-04-28 19:30 UTC
**Planning**: ../planning/2026-04-28-1900-planning-harness-hardening-and-repairguide.md
**Artifacts**: ./2026-04-28-1930-doing-layer-1-rollup-vocabulary/

**PR shape**: Standalone PR. First in the four-PR sequence (1 → 4 → 2 → 3). No prior dependencies.
**Downstream consumers**: Layers 4, 2, and 3 all inherit this vocabulary. Once merged, layer 4 begins; that branch must be cut from main *after* this PR lands.

## Execution Mode

- **direct** with strict TDD enforced. Single-session execution. Sequential units. Commit per phase (1a/1b/1c). Push when unit complete.

## Objective

Replace today's binary `"degraded" | "ok"` daemon-wide rollup — written at `daemon-entry.ts:164` (`status: degraded.length > 0 ? "degraded" : "ok"`) — with the locked five-state vocabulary: `healthy` / `partial` / `degraded` / `safe-mode` / `down`.

The current rollup merges two sources into one `degraded[]` array:
1. `degradedComponents[]` — written by `recordRecoverableBootstrapFailure` (`daemon-entry.ts:183-217`) for bootstrap-time failures.
2. `agentDegradedComponents[]` — derived from `processManager.listAgentSnapshots()` for agents whose `status !== "running"`.

Today the rollup is "any entry in either source promotes daemon to `degraded`." This is the slugger-symptom: one sick agent tips the whole harness to `degraded`. The fix is to compute a richer rollup that distinguishes "zero agents serving" (genuinely `degraded`) from "some agents unhealthy, others serving" (`partial`).

The per-agent live-check loop in `cli-exec.ts:287` is already try/catch-isolated. **Do NOT redesign that loop.** This PR changes how the output of `processManager.listAgentSnapshots()` + `degradedComponents[]` roll up into the daemon-wide `status` field at `daemon-entry.ts:163-180`'s `buildDaemonHealthState`.

After this PR: `degraded` means "zero enabled agents serving" (genuinely no working agents), not "any one agent is unhealthy."

## Completion Criteria

- [x] `DaemonHealthState.status` (`src/heart/daemon/daemon-health.ts:30-40`) accepts the five-state vocabulary as a union literal type. The current `string` typing is replaced with `"healthy" | "partial" | "degraded" | "safe-mode" | "down"`.
- [x] Rollup decision function exists (`computeDaemonRollup` or similar — name decided during implementation): given the per-agent status array + bootstrap-degradedComponents array + safe-mode flag, returns the correct rollup state per the table below.
- [x] All call sites that read or write `DaemonHealthState.status` use the new vocabulary. No string literals like `"running"` / `"degraded"` floating around without source-of-truth in the new type.
- [x] Real consumers of `DaemonHealthState.status` render the new vocabulary correctly (text labels, color/emoji conventions match the existing degraded affordances). The actual consumers — confirmed during Unit 0 — are `cli-render.ts:566` (`daemonUnavailableStatusOutput` "Last known status: ..." line) and `runtime-readers.ts:281` (`readDaemonHealthDeep` parse guard for the outlook surface). The planning doc's mention of `inner-status.ts` / `startup-tui.ts` was based on a misread; those files render per-agent runtime/worker status, not the daemon-wide rollup, and stay out of scope here.
- [x] Existing safe-mode crash-loop semantics from `safe-mode.ts` still work; the rollup just surfaces them through the new `safe-mode` state name.
- [x] No regression: `serpentguide-bootstrap.test.ts` and similar daemon-bootstrap tests still pass.
- [x] 100% test coverage on all new code (rollup function, type predicates, render-path branches).
- [x] All tests pass.
- [x] No warnings.
- [x] PR description (`./2026-04-28-1930-doing-layer-1-rollup-vocabulary/pr-description.md`) drafted before merger.

### Rollup state table (the contract this PR must encode)

| Daemon-wide state | Owner | When it fires |
| --- | --- | --- |
| `healthy` | rollup fn | All enabled agents healthy. No bootstrap-degraded components. No safe-mode. |
| `partial` | rollup fn | At least one enabled agent healthy AND at least one enabled agent unhealthy. (Today's incorrect "degraded".) |
| `degraded` | rollup fn | Zero enabled agents serving — covers BOTH "no enabled agents configured" (fresh install) AND "all enabled agents failed live-check." Same status, distinct UX copy at render time (Unit 4b). |
| `safe-mode` | rollup fn | Crash-loop tripped (3 in 5min) per `safe-mode.ts`. Overrides everything else. |
| `down` | **caller** | Daemon process itself can't start / can't read agent inventory / fatal pre-rollup error. **NOT returned by `computeDaemonRollup` — by the time the rollup function is called, the daemon has reached post-inventory state. `down` is set elsewhere in the daemon-entry flow before the rollup is reachable.** |

Type structure (encoded in Unit 1):
- `RollupStatus = "healthy" | "partial" | "degraded" | "safe-mode"` — what `computeDaemonRollup` returns.
- `DaemonStatus = RollupStatus | "down"` — what `DaemonHealthState.status` accepts.

Bootstrap-degraded components (`degradedComponents[]` from `recordRecoverableBootstrapFailure`) influence the rollup but never escalate it past `partial` on their own — they downgrade `healthy` to `partial`, never below. If a bootstrap failure is severe enough to halt inventory or startup, that's `down`, set by the caller, not the rollup function.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- No `[ExcludeFromCodeCoverage]` or equivalent on new code.
- All branches of the rollup function (each entry in the table above is its own branch).
- All error paths tested (empty agents array, all agents unhealthy, mixed, safe-mode trumps everything).
- Edge cases:
  - Zero enabled agents on a fresh install → `degraded` (no agents to serve).
  - One enabled agent, healthy → `healthy`.
  - One enabled agent, unhealthy → `degraded` (zero serving).
  - Two enabled agents, both healthy → `healthy`.
  - Two enabled agents, one healthy + one unhealthy → `partial`.
  - Two enabled agents, both unhealthy → `degraded`.
  - Any of the above + bootstrap-degraded components → still respects healthy→partial downgrade rule but never escalates past `partial`.
  - Safe-mode flag → `safe-mode` regardless of agent state.

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

### ✅ Unit 0: Mapping survey
**What**: Read all current consumers of `DaemonHealthState.status` and the `degradedComponents[]` rollup. Build a map (in `./2026-04-28-1930-doing-layer-1-rollup-vocabulary/status-callsites.md`) of every read/write of these values.
**Files to grep**: `src/heart/daemon/daemon-entry.ts`, `daemon-health.ts`, `inner-status.ts`, `startup-tui.ts`, `cli-exec.ts`, `cli-render.ts`, `daemon-cli.ts`, plus any test under `src/__tests__/heart/daemon/`.
**Output**: `status-callsites.md` listing each file:line, what it reads or writes, and the proposed new-vocabulary value at that site.
**Acceptance**: Map is complete; every site is accounted for. No "unknown — TBD" items.
**Outcome**: Survey surfaced a scope correction. The planning doc named `inner-status.ts` and `startup-tui.ts` as "consumers of the daemon status string," but neither file currently reads `DaemonHealthState.status` — they render per-agent inner-runtime and per-agent worker status respectively (different concepts). The real consumers of the rollup `status` field are `cli-render.ts:566` (`daemonUnavailableStatusOutput`) and `runtime-readers.ts:281` (`readDaemonHealthDeep`). Confirmed with ouroboros 2026-04-28; Unit 4 retargeted accordingly. Test fixtures in `daemon-health.test.ts`, `daemon-status-health.test.ts`, and `daemon-entry-health-state.test.ts` will need vocabulary updates as part of Unit 5.

### ✅ Unit 1a: Type definition — Tests
**What**: Write failing tests for the new `RollupStatus` and `DaemonStatus` union types AND their type guards (`isRollupStatus`, `isDaemonStatus`). Tests in `src/__tests__/heart/daemon/daemon-health-status.test.ts` (new file).
**Acceptance**: Tests exist and FAIL (red). Test cases include:
- `isRollupStatus`: each of the four literals (`healthy`, `partial`, `degraded`, `safe-mode`) validates; `"down"` is rejected (it's not a valid rollup output); junk strings fail; undefined/null fail.
- `isDaemonStatus`: each of the five literals validates including `"down"`; junk strings fail; undefined/null fail.

### ✅ Unit 1b: Type definition — Implementation
**What**: Add to `src/heart/daemon/daemon-health.ts`:
- `export type RollupStatus = "healthy" | "partial" | "degraded" | "safe-mode"` — what `computeDaemonRollup` returns. The four states the rollup function decides.
- `export type DaemonStatus = RollupStatus | "down"` — what `DaemonHealthState.status` accepts. Caller assigns `"down"` outside the rollup function (pre-inventory failure path).
- `export function isRollupStatus(value: unknown): value is RollupStatus` and `export function isDaemonStatus(value: unknown): value is DaemonStatus` guards.
- Update `DaemonHealthState.status` to type `DaemonStatus`.
**Acceptance**: Tests PASS (green). `tsc --noEmit` clean.

### ✅ Unit 1c: Type definition — Coverage & refactor
**What**: Verify coverage is 100% for the new type/guard. Refactor if needed.
**Acceptance**: Coverage report shows 100% for new lines. Tests still green.

### ✅ Unit 2a: Rollup function — Tests
**What**: Write failing tests for `computeDaemonRollup(input: { enabledAgents: AgentLiveCheckResult[]; bootstrapDegraded: DegradedComponent[]; safeMode: boolean }): RollupStatus`. Tests in `src/__tests__/heart/daemon/daemon-rollup.test.ts` (new file). Cover every row of the rollup state table above + every edge case from "Code Coverage Requirements".

**Input contract — pin explicitly**: `enabledAgents` contains ONLY agents whose `enabled` flag is true. The rollup function does NOT filter — the caller is responsible for filtering via `listEnabledBundleAgents` (or equivalent) before invoking. This keeps the function purely declarative on the data it receives.

**Required truth-table coverage** (each its own test):
1. All enabled agents healthy + no bootstrap-degraded + no safe-mode → `healthy`.
2. All enabled agents healthy + ≥1 bootstrap-degraded component + no safe-mode → `partial` (downgrade rule).
3. ≥1 healthy + ≥1 unhealthy enabled agent → `partial`.
4. Zero enabled agents in input (fresh install, none configured) → `degraded`.
5. ≥1 enabled agent, all unhealthy → `degraded`.
6. Any input with `safeMode: true` → `safe-mode` (overrides everything).
7. Empty enabled-agents + bootstrap-degraded + no safe-mode → `degraded` (zero serving wins; bootstrap-degraded can't escalate past partial but partial requires ≥1 healthy).
8. All unhealthy + bootstrap-degraded → `degraded` (zero serving wins).

**Acceptance**: Tests exist and FAIL (red). All eight scenarios above are present as named test cases.

### ✅ Unit 2b: Rollup function — Implementation
**What**: Implement `computeDaemonRollup` in `src/heart/daemon/daemon-rollup.ts` (new file). Place it next to `daemon-health.ts`. Pure function — no I/O, no side effects, deterministic on inputs. Returns `RollupStatus` (4-state union — never `"down"`; that's caller-owned, set elsewhere in the daemon-entry flow before this function is reachable).
**Acceptance**: Tests PASS (green). Function is < ~50 lines (rollup is genuinely a small decision tree).

### ✅ Unit 2c: Rollup function — Coverage & refactor
**What**: Verify 100% branch coverage on the rollup function. Refactor for readability if needed.
**Acceptance**: Coverage 100%. Tests green. No mutation observed (function is pure).

### ✅ Unit 3a: Wire rollup into `daemon-entry.ts` — Tests
**What**: Write failing integration tests that boot the daemon (test-level, not subprocess) with seeded agent inventory and assert the rolled-up status reflects the new vocabulary. Place in `src/__tests__/heart/daemon/daemon-entry-rollup.test.ts` (new file). Use `serpentguide-bootstrap.test.ts` as structural precedent.
**Coverage targets**:
- Boot with two healthy agents → status `"healthy"`.
- Boot with one healthy + one whose live-check fails → status `"partial"`.
- Boot with all live-checks failing → status `"degraded"`.
- Boot with bootstrap-degraded component (e.g., recordable failure) but agents healthy → status `"partial"` (downgrade rule).
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 3b: Wire rollup into `daemon-entry.ts` — Implementation
**What**:
- In `buildDaemonHealthState()` at `daemon-entry.ts:143-181`, replace the literal `status: degraded.length > 0 ? "degraded" : "ok"` at line 164 with a call to `computeDaemonRollup({ snapshots, bootstrapDegraded: degradedComponents, safeMode: ... })`.
- Keep `recordRecoverableBootstrapFailure` (line 183-217) as-is — it still records into `degradedComponents[]`; only the rollup interpretation changes.
- Keep `agentDegradedComponents` derivation as-is — `computeDaemonRollup` reads `snapshots` directly and applies its own logic.
- Note: today's rollup includes both bootstrap-degraded and agent-snapshot-derived entries in the unified `degraded[]` field of `DaemonHealthState`. Preserve that field for backwards-compatible inspection (consumers may still read it). The `status` field is what changes meaning.
**Acceptance**: Tests from 3a now PASS (green). Existing daemon-bootstrap tests (`serpentguide-bootstrap.test.ts` and similar) still pass.

### ✅ Unit 3c: Wire rollup into `daemon-entry.ts` — Coverage & refactor
**What**: Verify coverage on the changed rollup code path. Run full test suite.
**Acceptance**: 100% coverage on changed lines. All tests green.

### ✅ Unit 4a: Update consumers (`cli-render.ts`, `runtime-readers.ts`) — Tests
**Scope correction (Unit 0 outcome)**: planning-doc-named files `inner-status.ts` / `startup-tui.ts` do not actually consume `DaemonHealthState.status`. Real consumers per `status-callsites.md` are `cli-render.ts:566` (`daemonUnavailableStatusOutput`) and `runtime-readers.ts:281` (`readDaemonHealthDeep`). Tests target those.
**What**: Write failing tests that render each rollup state via `daemonUnavailableStatusOutput` and assert label/dot color is appropriate. Add a parse-validation test for `readDaemonHealthDeep` confirming it now uses `isDaemonStatus` to gate the parsed status field. Place tests in `src/__tests__/heart/daemon/cli-render-rollup-vocabulary.test.ts` and `src/__tests__/heart/outlook/readers/runtime-readers-rollup-vocabulary.test.ts` (new files).
**Coverage**:
- `daemonUnavailableStatusOutput`: render each of the five `DaemonStatus` literals (`healthy` / `partial` / `degraded` / `safe-mode` / `down`) with the appropriate label.
- `degraded` two-copy split: zero-enabled-agents fresh-install vs all-enabled-failed. The render input here is the cached health file — when the daemon is down, the cached file's `agents` map is the only signal we have for which sub-case we're in. Empty `agents` map → "no agents configured" copy. Non-empty `agents` map with all crashed → "agents configured but none ready" copy.
- `runtime-readers.ts`: parse a health file with each of the five literals → carries the typed `DaemonStatus` through. Parse a health file with junk status (`"banana"`) → defensive fallback to `"unknown"` (existing behavior preserved; the new layer is type-narrowing of the valid path).
**Acceptance**: Tests exist and FAIL (red). All five rollup states are exercised in `daemonUnavailableStatusOutput`. Both `degraded` sub-cases are present.

### ✅ Unit 4b: Update consumers — Implementation
**What**:
- In `cli-render.ts`: replace the `\`Last known status: ${health.status} ...\`` line with a status-specific render switch. Map each `DaemonStatus` literal to a label + a colored dot (reusing the existing `statusDot` helper or via a dedicated rollup-color map). For `degraded`, branch on `health.agents` map size to pick the copy variant — empty map → fresh-install copy, non-empty → all-failed copy. Default branch must be `never`-typed.
- In `runtime-readers.ts`: tighten the `health.status` read to use `isDaemonStatus` (newly exported from `daemon-health.ts` in Unit 1b). The existing `"unknown"` fallback for genuinely missing/corrupt status is preserved; the typed path now produces a typed `DaemonStatus`. The DTO field's TypeScript type widens to `DaemonStatus | "unknown"` so downstream Outlook code carries the new vocabulary forward.

Affordances per state:
- `healthy` — green dot + "healthy" label (replaces today's `"ok"`).
- `partial` — yellow dot + "partial" label (NEW; the case today's incorrect "degraded" rendering covered when ≥1 healthy + ≥1 unhealthy).
- `degraded` — red dot + label. **Two sub-cases distinguished by render copy** (NOT by status field):
  - "no agents configured" — when the cached `health.agents` map is empty (fresh install, nothing wired up). Copy: e.g. "no agents configured — run `ouro hatch` to add one".
  - "all agents failed" — when the map is non-empty but the rollup says zero serving. Copy: e.g. "agents configured but none ready — run `ouro doctor`".
- `safe-mode` — red dot + "safe mode" label (existing safeMode handling already prints a SAFE MODE line; the rollup status itself just uses the labeled dot).
- `down` — red dot + "down" label.

The render layer reads `health.agents` (already a field on `DaemonHealthState`) to pick the right copy variant for `degraded`. This avoids inflating the status enum just to express a UX nuance.
**Acceptance**: Tests from 4a PASS (green). Tests cover BOTH `degraded` sub-cases (zero-enabled vs all-unhealthy) and assert distinct rendered copy. The render switch's default is `never`-typed.

### ✅ Unit 4c: Update consumers — Coverage & refactor
**What**: Verify 100% coverage on touched render paths.
**Acceptance**: Coverage 100%. Tests green.

### ✅ Unit 5: Sweep remaining call sites — compiler-forced exhaustiveness
**What**: Walk the `status-callsites.md` map from Unit 0. For every call site:
1. Update to the new vocabulary using `RollupStatus` or `DaemonStatus` typed values — no string literals.
2. **Every switch/match on a status value MUST be exhaustive with a `never`-typed default branch:**
   ```ts
   switch (status) {
     case "healthy": return ...
     case "partial":  return ...
     case "degraded": return ...
     case "safe-mode": return ...
     case "down":      return ...   // only for DaemonStatus consumers
     default: {
       const _exhaustive: never = status
       throw new Error(`unhandled daemon status: ${_exhaustive as string}`)
     }
   }
   ```
   The `never` cast at default forces a compile error if the union ever grows and a consumer isn't updated. **No `default` branch that returns a fallback value or coerces unknown values to a "best-guess" status.** That kind of permissiveness is exactly how the old "ok | degraded" semantics will leak through.
3. String-literal writes outside `daemon-entry.ts` / `computeDaemonRollup` are rule violations — file a follow-up issue and fix in this PR if trivial.

**Acceptance**:
- Every entry in `status-callsites.md` is checked off.
- `grep -rn '"running"\|"degraded"\|"healthy"\|"ok"' src/heart/daemon/ src/heart/cli/` produces only references through the type system, in tests, or inside the new `computeDaemonRollup` body itself.
- `grep -rn 'default:.*return\|default:.*=>' src/heart/daemon/inner-status.ts src/heart/daemon/startup-tui.ts src/heart/daemon/cli-render.ts` shows zero non-`never`-typed default branches in status-rendering paths.
- A deliberate "add a hypothetical 6th state" experiment confirms `tsc --noEmit` errors at every consumer (test artifact: a comment in `status-callsites.md` describing the experiment + which files errored).

### ✅ Unit 6: Full-suite green + PR description
**What**:
- Run full test suite (`npm test` or repo-equivalent). All green.
- Run typecheck (`tsc --noEmit`). Clean.
- Run linter. No new warnings.
- Draft `./2026-04-28-1930-doing-layer-1-rollup-vocabulary/pr-description.md` per worker's `pr-surface-hygiene` conventions: summary of the vocabulary change, the rollup state table, the no-loop-redesign disclaimer, and a "next: layer 4 builds on this" pointer.
**Acceptance**: Suite green. Typecheck clean. Lint clean. PR description drafted in artifacts directory.

## Execution
- TDD strictly enforced — tests → red → implement → green → refactor.
- Commit after each phase (1a, 1b, 1c, 2a, 2b, 2c, ...).
- Push after each unit completes.
- Run full test suite before marking unit done.
- All artifacts (status-callsites map, PR description) saved to `./2026-04-28-1930-doing-layer-1-rollup-vocabulary/`.
- Fixes / blockers: spawn sub-agent immediately — don't ask, just do it.
- Decisions made: update this doc immediately, commit right away.

## Reference: load-bearing source paths

- `src/heart/daemon/daemon-health.ts` (lines 30-40 for `DaemonHealthState`)
- `src/heart/daemon/daemon-entry.ts:143-181` (`buildDaemonHealthState` — the rollup writer; line 164 is the literal `status: degraded.length > 0 ? "degraded" : "ok"` that this PR replaces)
- `src/heart/daemon/daemon-entry.ts:141` (`degradedComponents[]` declaration)
- `src/heart/daemon/daemon-entry.ts:183-217` (`recordRecoverableBootstrapFailure` — DO NOT MODIFY, only the rollup interpretation of its output changes)
- `src/heart/daemon/cli-exec.ts:287` (per-agent live-check loop — DO NOT MODIFY in this PR)
- `src/heart/daemon/inner-status.ts` (consumer)
- `src/heart/daemon/startup-tui.ts` (consumer)
- `src/heart/daemon/safe-mode.ts` (existing crash-loop semantics; surfaces as new `safe-mode` rollup state)
- `src/heart/daemon/agent-discovery.ts` (`listEnabledBundleAgents` — read-only here; relevant because rollup needs the enabled-agent count)
- `src/__tests__/heart/daemon/serpentguide-bootstrap.test.ts` (precedent for daemon-bootstrap test shape)

## Progress Log
- 2026-04-28 19:30 UTC Created from planning doc as PR 1 of 4 in the sequential rollout (1 → 4 → 2 → 3).
- 2026-04-28 19:55 UTC Post-planner review pass with ouroboros surfaced four refinements applied to this doc:
  - Split type union: `RollupStatus` (4-state, function output) + `DaemonStatus = RollupStatus | "down"` (full daemon-status, caller-owned).
  - `computeDaemonRollup` returns `RollupStatus`, not `DaemonStatus` — `down` is set by the daemon-entry caller path before the rollup function is reachable. The function is post-inventory and cannot represent pre-inventory failure.
  - Pinned input contract: `enabledAgents` is pre-filtered by the caller; the function does not re-filter.
  - Render-layer copy split for `degraded` ("no enabled agents configured" vs "all enabled agents failed") so the same status surfaces distinct UX without inflating the type union.
- 2026-04-28 20:10 UTC Second ouroboros review surfaced one more refinement, applied:
  - Unit 5 strengthened from "grep-based sweep" to "compiler-forced exhaustiveness." Every switch on a status value MUST have a `never`-typed default branch. No fallback `default:` returning a guess value. A deliberate add-a-hypothetical-state experiment is required to prove every consumer compile-errors when the union grows.
- 2026-04-28 13:04 Unit 0 complete: status-callsites map written; scope correction confirmed with ouroboros. Real consumers of `DaemonHealthState.status` are `cli-render.ts:566` and `runtime-readers.ts:281`, not `inner-status.ts` / `startup-tui.ts`. Unit 4 retargeted; Completion Criteria entry rephrased to match. Test fixtures in `daemon-health.test.ts`, `daemon-status-health.test.ts`, and `daemon-entry-health-state.test.ts` flagged for vocabulary update during Unit 5.
- 2026-04-28 13:16 Unit 1a/1b/1c complete: introduced `RollupStatus` (4-state) + `DaemonStatus` (5-state) unions and `isRollupStatus` / `isDaemonStatus` runtime guards. Tightened `DaemonHealthState.status` to `DaemonStatus` and tightened `readHealth` to use the guard so corrupt or old-vocabulary cached files fail parse. Bumped the `daemon-entry.ts:164` literal from `"ok"`/`"degraded"` to `"healthy"`/`"degraded"` so tsc passes — Unit 3b will replace this literal entirely with `computeDaemonRollup`. Updated existing test fixtures across daemon-health, daemon-status-health, daemon-cli-defaults, daemon-entry-health-state, and prompt rhythm tests to use the new vocabulary. 100% coverage on `daemon-health.ts`. Full suite: 9716 tests green; tsc/lint/build clean.
- 2026-04-28 13:24 Unit 2a/2b/2c complete: `computeDaemonRollup` pure decision function in `daemon-rollup.ts`. Truth table fully covered (8 rows + permutation/order-independence + non-mutation + determinism + return-type-narrowing). `AgentRollupInput` is the minimal projection — `name + status` — kept decoupled from `DaemonAgentSnapshot` so the function stays trivially testable. Caller will project at the daemon-entry call site in Unit 3b. 100% coverage on `daemon-rollup.ts`; 21 new truth-table tests; tsc/lint/build clean.
- 2026-04-28 14:31 Unit 3a/3b/3c complete: replaced `daemon-entry.ts:164` placeholder literal with a real `computeDaemonRollup` call. Per-agent snapshots project into `AgentRollupInput`; bootstrap-degraded array passes through; safe-mode wired as `false` since safe-mode detection runs at the daemon-up boot path before this rollup is reachable. Updated the existing "no degraded → ok" daemon-entry-health-state test to seed a running agent (the old test was implicitly testing the now-incorrect "no entries means healthy" semantic — empty inventory under the new rollup is correctly classified as `degraded`). Five new integration tests cover the rollup state table at the daemon-entry layer. Added `daemon-rollup` to the file-completeness exempt list (pure function, observability owned by `DaemonHealthWriter`). Coverage gate: pass; 9742 tests green; tsc/lint/build clean.
- 2026-04-28 15:24 Unit 4a/4b/4c complete: added `renderRollupStatusLine` to `cli-render.ts` with a compiler-forced exhaustive switch on `DaemonStatus` (never-typed default; `degraded` two-copy split by inspecting cached `health.agents` map size). Tightened `runtime-readers.ts:readDaemonHealthDeep` parse to use `isDaemonStatus` so stale legacy status strings fall back to `"unknown"`. Widened `OutlookDaemonHealthDeep.status` to `DaemonStatus | "unknown"` (re-exported `DaemonStatus`/`RollupStatus` from `nerves/observation.ts`). Two new test files exercise both consumers — 16 tests total (5 literal carry-throughs + 5 fallbacks for runtime-readers; 5 literal renders + degraded two-sub-case copy split for cli-render). Wrapped the never-typed default in `/* v8 ignore */` since by construction the dead-code branch can never fire — coverage gate would otherwise flag the unreachable instrumented site. 9758 tests green; coverage gate: pass; tsc/lint/build clean.
- 2026-04-28 15:32 Unit 5 complete: refactored `daemon-health.ts` so the rollup unions and the runtime guard sets are both projected from a single source-of-truth literal tuple (`ROLLUP_STATUS_LITERALS as const`). Future widening of the vocabulary requires touching just one site, and the type / set / guards stay in lockstep automatically. Performed the add-a-hypothetical-state experiment (added `"experimental"` to the tuple, ran tsc, recorded which sites errored, reverted) and documented results in `status-callsites.md`. Result: exactly one consumer compile-errors — `renderRollupStatusLine`'s never-typed default — proving Layer 1's compiler-forced exhaustiveness contract holds. Status-callsites map fully checked off; sweep grep produces no offending references (every rollup-vocab use is through the type system or in tests). 9758 tests green; coverage gate: pass; tsc/lint/build clean.
- 2026-04-28 15:42 Unit 6 complete: full suite green (508 test files / 9758 tests pass, 33 skipped); tsc clean; lint clean; build clean; coverage gate clean (code coverage + nerves source coverage + nerves file completeness all pass). PR description drafted at `./2026-04-28-1930-doing-layer-1-rollup-vocabulary/pr-description.md` per worker's `pr-surface-hygiene` conventions — no test-count parentheticals, no file:line refs, no decorative SHAs; uses method/class names as stable anchors; the test-plan section is human-validation only (pipeline boilerplate prepended). Status: done.
- 2026-04-28 15:50 UTC Post-implementation review with ouroboros surfaced one load-bearing diff-level concern, addressed in this commit:
  - Pre-Layer-1 daemons wrote `status: "degraded"` under the old "any sick component" semantics. A cached `daemon-health.json` from such a daemon may have `status: "degraded"` AND a running agent in the cached agents map — mutually exclusive under post-Layer-1 semantics. The original Unit 4b render branched only on `agents` map size, so it falsely claimed "agents configured but none ready" for legacy stale caches that actually had at least one healthy agent.
  - `renderRollupStatusLine`'s `degraded` branch is now three-way: empty map → fresh-install copy; non-empty + any agent reports `"running"` → "stale cache, run `ouro up` to refresh"; non-empty + zero running → "agents configured but none ready" (the original all-failed copy). New test in `cli-render-rollup-vocabulary.test.ts` covers the legacy stale-cache case; existing tests still pass. 9759 tests green; tsc clean.
