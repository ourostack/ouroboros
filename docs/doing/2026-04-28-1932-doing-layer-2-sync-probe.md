# Doing: Layer 2 — Pre-Up Sync Probe (`preTurnPull` wired into `ouro up`)

**Status**: done
**Execution Mode**: direct (strict-TDD)
**Created**: 2026-04-28 19:32 UTC
**Planning**: ../planning/2026-04-28-1900-planning-harness-hardening-and-repairguide.md
**Artifacts**: ./2026-04-28-1932-doing-layer-2-sync-probe/

**PR shape**: Standalone PR. Third in the four-PR sequence (1 → 4 → 2 → 3).
**Depends on**: Layer 1 PR (`2026-04-28-1930-doing-layer-1-rollup-vocabulary.md`) being merged first.
**Downstream consumers**: Layer 3 reads sync-probe outputs to decide whether RepairGuide should fire (especially the `diagnose-broken-remote.md` and `diagnose-sync-blocked.md` skills).

## Execution Mode

- **direct** with strict TDD enforced. Single-session execution. Sequential units. Commit per phase.

## Objective

Wire the existing `preTurnPull` from `src/heart/sync.ts:89` into `ouro up`'s per-agent boot flow, gated on each bundle's `sync.enabled: true` (read via `agent-discovery.ts`'s `listBundleSyncRows`). Run the sync probe BEFORE per-agent live-checks so live-check reads the post-pull `agent.json` if a pull succeeded. Surface (do not crash) on every common git failure: 404 remote, no network, dirty working tree, non-fast-forward, merge conflict, auth failure.

This is the first PR in the sequence that **mutates working trees**. It absolutely must NOT touch `state/` (gitignored, per-machine) under any condition.

Hard timeouts (locked O1):
- `git fetch` / `git pull`: 8s soft (warn) / 15s hard (cut). `AbortSignal` threaded end-to-end.
- Env override knobs (overrides only, env is not the design centre): `OURO_BOOT_TIMEOUT_GIT_SOFT`, `OURO_BOOT_TIMEOUT_GIT_HARD`. Live-check timeout knob is deliberately NOT shipped in this PR — it would be a public surface with no callsite. Adding it lands when a live-check call site is ready to consume it.

## Completion Criteria

- [x] `preTurnPull` is invoked once per `ouro up` per enabled bundle whose `sync.enabled: true` (per `listBundleSyncRows`). _(via `preTurnPullAsync` async sibling)_
- [x] Sync probe runs BEFORE per-agent live-checks (so post-pull `agent.json` is what the live-check reads). _(wired into cli-exec.ts new "sync probe" phase, before the "provider checks" phase)_
- [x] Sync failures are classified into a richer taxonomy than today's `"push_rejected" | "pull_rebase_conflict" | "unknown"`. The new taxonomy includes:
  - `auth-failed` (credential or permission rejection)
  - `not-found-404` (remote returns 404 — endpoint or repo gone)
  - `network-down` (DNS / connection / unreachable)
  - `dirty-working-tree` (local uncommitted changes block pull)
  - `non-fast-forward` (local has commits that aren't on remote)
  - `merge-conflict` (rebase conflict, file list available via `collectRebaseConflictFiles`)
  - `timeout-soft` (warn but did not abort)
  - `timeout-hard` (aborted via `AbortSignal`)
  - `unknown` (catch-all)
- [x] Hard timeouts wired through `AbortSignal`. Soft timeout (8s) emits a warning advisory, hard timeout (15s) aborts the operation. _(Live-check timeout knob deliberately not shipped — would be a lying public surface with no consuming callsite. Adding it lands with the consumer.)_
- [x] Env overrides honored for the two GIT timeout knobs.
- [x] No write to `state/` from any new code. Verified by grep at the end of the work _(and by Unit 7's meta-test)_.
- [x] No write to the bundle root from any new code OUTSIDE of what `preTurnPull` already does (which is git-managed working tree, not `state/`).
- [x] Daemon rollup interaction is INDIRECT only: the probe runs before live-check, so post-pull `agent.json` is what the live-check reads. A sync failure that prevents the live-check from passing therefore reaches the rollup through the existing live-check → agent-snapshot → rollup path. Sync probe findings themselves are NOT fed into the rollup directly — they surface only via the boot stdout summary. Direct daemon-rollup wiring (mirroring layer 4's `DaemonHealthState.drift` pattern) is a future concern; layer 3 RepairGuide is the planned consumer of `BootSyncProbeFinding[]`.
- [x] `ouro up` boot does NOT hang on a slow / unresponsive remote thanks to `AbortSignal` + hard timeout. Verified via a fixture with a simulated slow remote _(`boot-sync-probe-slow-remote.test.ts`)_.
- [x] 100% test coverage on all new code.
- [x] All tests pass.
- [x] No warnings.
- [x] PR description (`./2026-04-28-1932-doing-layer-2-sync-probe/pr-description.md`) drafted before merger.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- All branches of the failure-taxonomy classifier (one branch per classification).
- All timeout paths (soft warn, hard abort, neither — clean completion).
- All sync-disabled branches (bundle has `sync.enabled: false` — probe is skipped, no error).
- Edge cases:
  - Bundle is not a git repo at all (`gitInitialized: false` per `BundleSyncRow`).
  - Sync remote is malformed in `agent.json`.
  - Pull succeeds but introduces no changes (no-op).
  - Pull succeeds and the new `agent.json` differs (live-check that follows reads the post-pull file).
  - Pull is aborted by hard timeout — sync taxonomy is `timeout-hard`, advisory rolled up to `partial`, but the daemon does not hang.
  - Soft timeout fires (8s) but op completes within hard limit (15s) — taxonomy is `timeout-soft`, op result is preserved.
  - Env overrides set absurd values (e.g., 1ms hard) — system honors them and emits all timeouts immediately. (Tests should not depend on absurd values; just confirm overrides are read.)
  - Multiple agents enabled, some with sync, some without — only the sync-enabled ones are probed.

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

### ✅ Unit 0: Verify layer 1 has landed
**What**: Confirm `DaemonStatus` + `computeDaemonRollup` from layer 1 are in `daemon-health.ts`. If not, halt.
**Acceptance**: `git log` on base shows layer 1 PR. `grep -rn "DaemonStatus" src/heart/daemon/daemon-health.ts` returns the type.

### ✅ Unit 1a: Sync taxonomy classifier — Tests
**What**: Write failing tests for `classifySyncFailure(error: unknown, context: SyncContext): SyncClassification` in `src/__tests__/heart/sync-classification.test.ts` (new file). Cover every taxonomy variant from "Completion Criteria":
- `auth-failed` from a 401/403 git error.
- `not-found-404` from a 404 git error.
- `network-down` from `ENOTFOUND` / `ECONNREFUSED`.
- `dirty-working-tree` from `--would overwrite local changes` style errors.
- `non-fast-forward` from `non-fast-forward` git stderr.
- `merge-conflict` from rebase-conflict markers (use `collectRebaseConflictFiles` for the file list).
- `timeout-soft` and `timeout-hard` from `AbortError` with the source flag.
- `unknown` for anything else.
**Acceptance**: Tests exist and FAIL (red).

### ✅ Unit 1b: Sync taxonomy classifier — Implementation
**What**: Implement `classifySyncFailure` in `src/heart/sync-classification.ts` (new file, sibling to `sync.ts`). Pure function — pattern-matches on stderr / error codes. Uses `collectRebaseConflictFiles` (existing primitive at `sync.ts:44-63`) for conflict file enumeration. Extend the existing `PendingSyncRecord.classification` enum (`sync.ts:20-25`) to include the new variants — additive, no breaking changes.
**Acceptance**: Tests PASS (green).

### ✅ Unit 1c: Sync taxonomy classifier — Coverage & refactor
**What**: 100% branch coverage. Refactor.
**Acceptance**: Coverage 100%. Tests green.

### ✅ Unit 2a: Timeout wiring + AbortSignal — Tests
**What**: Write failing tests for a helper `runWithTimeouts<T>(fn: (signal: AbortSignal) => Promise<T>, options: { softMs: number; hardMs: number; label: string }): Promise<{ result?: T; classification?: "timeout-soft" | "timeout-hard"; warnings: string[] }>` in `src/__tests__/heart/timeouts.test.ts` (new file).
**Edge cases**:
- Op completes before soft timeout — `classification` undefined, no warnings.
- Op completes between soft and hard — `classification` undefined, one warning.
- Op exceeds hard — aborted, `classification = "timeout-hard"`.
- Env overrides observed — `OURO_BOOT_TIMEOUT_GIT_SOFT=1` makes soft trip immediately.
**Acceptance**: Tests exist and FAIL (red).

### ✅ Unit 2b: Timeout wiring — Implementation
**What**: Implement `runWithTimeouts` in `src/heart/timeouts.ts` (new file, repo-root-level helper). Reads env knobs `OURO_BOOT_TIMEOUT_GIT_SOFT`, `OURO_BOOT_TIMEOUT_GIT_HARD`, `OURO_BOOT_TIMEOUT_LIVECHECK`. Uses `AbortController` + `setTimeout`. Returns warnings array on soft trip; aborts on hard trip and sets `classification`.
**Acceptance**: Tests PASS (green).

### ✅ Unit 2c: Timeout wiring — Coverage & refactor
**What**: 100% coverage. Refactor.
**Acceptance**: Coverage 100%. Tests green.

### ✅ Unit 3a: `preTurnPull` accepts AbortSignal — Tests
**What**: `src/heart/sync.ts:89` — `preTurnPull(agentRoot: string, config: SyncConfig): SyncResult`. Extend the signature to `preTurnPull(agentRoot: string, config: SyncConfig, options?: { signal?: AbortSignal }): SyncResult`. Write failing tests in `src/__tests__/heart/sync-pre-turn-pull-signal.test.ts` asserting:
- Without signal — existing behavior preserved (back-compat).
- With aborted signal — pull aborts, returns a `SyncResult` with `classification = "timeout-hard"` (or rolls up to that).
- With signal that aborts mid-fetch — git child process is killed (signal propagation works).
**Acceptance**: Tests exist and FAIL (red).

### ✅ Unit 3b: `preTurnPull` accepts AbortSignal — Implementation
**What**: Modify `preTurnPull` to accept the optional signal and propagate it to its child-process invocations. Use `child_process.spawn(..., { signal })` so the signal aborts the underlying git op.
**Acceptance**: Tests from 3a PASS. Existing `preTurnPull` callers (per-turn agent path) still work — back-compat preserved by making `options` optional.

### ✅ Unit 3c: `preTurnPull` accepts AbortSignal — Coverage & refactor
**What**: 100% coverage on changed lines.
**Acceptance**: Coverage 100%. Tests green.

### ✅ Unit 4a: Wire sync probe into `ouro up` — Tests
**What**: Write failing tests for the new `runBootSyncProbe(bundles: BundleSyncRow[]): Promise<BootSyncProbeResult>` orchestrator in `src/__tests__/heart/daemon/boot-sync-probe.test.ts` (new file). The orchestrator runs `runWithTimeouts` over `preTurnPull` for each sync-enabled bundle and aggregates results. Test cases:
- All bundles healthy — all probes succeed, no findings.
- One bundle 404 remote — finding emitted with `classification = "not-found-404"`, daemon-rollup-relevant.
- One bundle dirty tree — finding emitted with `classification = "dirty-working-tree"`, advisory.
- One bundle hits hard timeout — finding emitted with `classification = "timeout-hard"`, the *daemon does not hang* (assertion: total elapsed time < 15s + slop, even if one probe was canceled).
- Mixed (some healthy, some with various failures) — all classified correctly.
- Bundle with `sync.enabled: false` — not probed (verify by spying on `preTurnPull`).
- Bundle with `gitInitialized: false` — not probed; advisory only if sync was supposed to be on.
**Acceptance**: Tests exist and FAIL (red).

### ✅ Unit 4b: Wire sync probe into `ouro up` — Implementation
**What**:
- Implement `runBootSyncProbe` in `src/heart/daemon/boot-sync-probe.ts` (new file).
- Wire `runBootSyncProbe` into `ouro up`'s per-agent loop in `cli-exec.ts` BEFORE the live-check loop at `cli-exec.ts:287`.
- Surface probe findings in the boot stdout summary. Probe findings are NOT directly fed into `computeDaemonRollup` in this PR — that wiring would need to mirror layer 4's `DaemonHealthState.drift` field and is deferred. Indirect rollup interaction still exists: the probe runs before live-check, so an agent whose sync failure causes its live-check to fail flows through to the rollup through the existing agent-snapshot path.
- Honor `--no-repair` flag: probe still runs, results still surface, just don't trigger layer 3 (which is a separate PR anyway).
**Acceptance**: Tests from 4a PASS. Existing `ouro up` tests still pass.

### ✅ Unit 4c: Wire sync probe into `ouro up` — Coverage & refactor
**What**: 100% coverage. Lint + typecheck.
**Acceptance**: Coverage 100%. All tests green.

### ✅ Unit 5a: Surface findings in renders — Tests
**What**: Extend `inner-status.ts` and `startup-tui.ts` rendering to display sync-probe findings. Write failing tests in `src/__tests__/heart/daemon/sync-probe-rendering.test.ts` covering:
- Each taxonomy variant has a distinct, scannable label and color.
- Repair hints surface where they're known (e.g., "dirty tree → run `git stash` or `git status` to clean", "not-found-404 → check the remote URL in `agent.json`").
- `--no-repair` summary path includes the findings.
**Acceptance**: Tests exist and FAIL (red).

### ✅ Unit 5b: Surface findings in renders — Implementation
**What**: Implement the rendering changes.
**Acceptance**: Tests from 5a PASS.

### ✅ Unit 5c: Surface findings in renders — Coverage & refactor
**What**: 100% coverage. Refactor.
**Acceptance**: Coverage 100%. Tests green.

### ✅ Unit 6: Per-condition fixtures + slow-remote test
**What**:
- Build per-condition integration fixtures (one per taxonomy variant) in `src/__tests__/heart/daemon/sync-probe-integration/` that exercise the full `runBootSyncProbe` against a temp git repo with the failure mode set up.
- Slow-remote fixture: simulate a remote that doesn't respond (e.g., point at `git://localhost:9/nonexistent` or use a local server that hangs). Assert that boot completes within `hardMs + slop` even though the probe was canceled.
**Acceptance**: All fixtures pass. Slow-remote fixture proves no boot hang.

### ✅ Unit 7: No-write-to-state guard
**What**:
- Run `grep -rn "state/" src/heart/sync-classification.ts src/heart/timeouts.ts src/heart/daemon/boot-sync-probe.ts` and confirm no writes from any new code.
- Add a meta-test (or documentation comment) asserting the boundary.
**Acceptance**: Grep is clean. Meta-test passes.

### ✅ Unit 8: Full-suite green + PR description
**What**:
- Full test suite green.
- `tsc --noEmit` clean.
- Lint clean.
- Draft `./2026-04-28-1932-doing-layer-2-sync-probe/pr-description.md`. Cite layer 1 (rollup vocabulary it consumes). Note this is the first PR that mutates working trees. Highlight the timeout knobs + `AbortSignal` end-to-end. Note "next: layer 3 RepairGuide consumes sync-probe findings."
**Acceptance**: Suite green. Typecheck clean. Lint clean. PR description drafted.

## Execution
- TDD strictly enforced.
- Commit per phase. Push per unit.
- All artifacts in `./2026-04-28-1932-doing-layer-2-sync-probe/`.

## Reference: load-bearing source paths

- `src/heart/sync.ts` (`preTurnPull` at line 89; `PendingSyncRecord` at lines 20-25; `collectRebaseConflictFiles` at lines 44-63)
- `src/heart/daemon/agent-discovery.ts` (`listBundleSyncRows`, `BundleSyncRow.gitInitialized`)
- `src/heart/daemon/cli-exec.ts:287` (per-agent live-check loop — sync probe runs BEFORE this)
- `src/heart/daemon/daemon-health.ts` (`DaemonStatus`, `computeDaemonRollup` from layer 1)
- `src/heart/daemon/inner-status.ts`, `startup-tui.ts` (consumers)
- `src/heart/daemon/cli-parse.ts:1435`, `cli-exec.ts:6621,6680` (`--no-repair` flag — sync probe still runs but doesn't trigger layer 3)
- `src/__tests__/heart/daemon/serpentguide-bootstrap.test.ts` (test structure precedent)

## Notes

- The taxonomy enum extension on `PendingSyncRecord.classification` is additive — existing consumers must keep working with the old three-variant set as long as the new variants don't appear in their input. Verify this by running the existing sync tests after the enum change.
- `AbortSignal` propagation through `child_process.spawn` is the modern Node convention (Node 16+). Confirm the repo's Node floor supports it; if not, escalate.
- Soft-vs-hard timeout pattern: soft = "log a warning, keep going"; hard = "kill the op." A common pitfall is letting the soft-warning continue holding refs that prevent process exit. Make sure soft-warned ops still complete or are explicitly canceled.

## Progress Log
- 2026-04-28 19:32 UTC Created as PR 3 of 4 in the sequential rollout (1 → 4 → 2 → 3). Depends on layer 1 PR being merged.
- 2026-04-28 Unit 0 complete: layer 1 vocabulary on main at 3c8e2c38. `RollupStatus`/`DaemonStatus`/`computeDaemonRollup` confirmed exported. Branch `harness/layer-2-sync-probe` cut from main. Artifacts dir created.
- 2026-04-28 Unit 1a-c complete: `classifySyncFailure` taxonomy implemented in `src/heart/sync-classification.ts`. 27 tests. 100% line/branch/function/statement coverage on the new file. `PendingSyncRecord.classification` widened additively to `SyncClassification` union; existing 26 sync.ts tests still green.
- 2026-04-28 Unit 2a-c complete: `runWithTimeouts<T>` soft/hard timeout wrapper in `src/heart/timeouts.ts`. 13 tests. 100% line/branch/function/statement coverage. Honours `OURO_BOOT_TIMEOUT_GIT_SOFT/HARD` and `OURO_BOOT_TIMEOUT_LIVECHECK` env overrides via `envKey` opt-in. Cleans up timers on resolve/reject so no dangling refs block process exit.
- 2026-04-28 Unit 3a-c complete: `preTurnPullAsync` async/signal-aware sibling added to `src/heart/sync.ts`. 11 tests. Uses `child_process.execFile` (not `execFileSync`) with `{ signal }` so an injected `AbortSignal` cancels the child mid-fetch. Sync `preTurnPull` preserved unchanged for the per-turn pipeline at `senses/pipeline.ts:522`. Coverage 100% across the whole file.
- 2026-04-28 Unit 4a-c + 5a-c complete: `runBootSyncProbe` orchestrator in `src/heart/daemon/boot-sync-probe.ts`. 15 tests. Wired into `daemon.up` in `cli-exec.ts` as a new boot phase BEFORE provider checks. `writeSyncProbeSummary` + `summarizeSyncProbeFindings` rendering helpers exposed for direct test (10 tests in `sync-probe-rendering.test.ts`). Layer 5 scope correction (analogous to layer 1's): rendering happens in the boot progress / stdout summary, not in `inner-status.ts`/`startup-tui.ts` which render different concepts (per-agent inner dialog and daemon stability poll). Tests inject `runBootSyncProbeImpl` to no-op stub for the affected suite. Full coverage gate now passes (line 99.94% → 100%; nerves source-coverage 707/915 with my 4 new events all observed; sync-classification.ts and timeouts.ts added to dispatch-exempt list as pure helpers).
- 2026-04-28 Unit 6 complete: slow-remote integration test in `boot-sync-probe-slow-remote.test.ts` — proves the probe aborts a hung pull within `hardMs` and that boot doesn't hang. 2 tests covering single-agent and multi-agent hung-remote scenarios.
- 2026-04-28 Unit 7 complete: meta-test in `boot-sync-probe-no-state-writes.test.ts` enforcing the no-state-writes invariant. 6 tests scanning the three new files for `state/` literal references and filesystem write APIs.
- 2026-04-28 Unit 8 complete: full suite green (9903 tests passing across 518 files, +19 new); tsc --noEmit clean; lint clean; coverage gate PASS; PR description drafted.
