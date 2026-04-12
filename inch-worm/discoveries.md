## [D-001] — `ouro up` does not ping selected providers

**Source**: observed-during-seed
**What**: `ouro up` reports startup as healthy after structural config checks even when a selected provider token is expired or the provider ping would fail.
**Where**: `src/heart/daemon/process-manager.ts`, `src/heart/daemon/agent-config-check.ts`, `src/heart/provider-ping.ts`
**Why it matters**: Users get an "all okay" startup followed by turn-time authentication errors, which makes the repair path feel random and late.
**Evidence**: Running `ouro up` previously passed while the next Slugger turn surfaced provider authentication failures; code inspection showed the startup config check only verified required credential fields, not live selected-provider reachability.
**Severity**: high-value
**Blast radius**: affects multiple modules
**Fix shape**: Add a bounded live provider verification step for unique selected facings during startup health/config checks, with clear degraded status and repair guidance.
**Status**: fixed
**Linked work**: https://github.com/ouroborosbot/ouroboros/pull/439

---

## [D-002] — Prompt hides runtime flow tools when tool choice is optional

**Source**: observed-during-seed
**What**: `buildSystem()` renders `## my tools` from channel/custom tools and only adds `settle` when `toolChoiceRequired` is true, while `runAgent()` always exposes `ponder` plus the channel terminal tool (`settle` or `rest`) and only uses `toolChoiceRequired` to decide whether to force a tool call.
**Where**: `src/mind/prompt.ts:508`; `src/heart/core.ts:725`
**Why it matters**: The model can see tools at the provider layer that the system prompt did not teach it about, recreating the same kind of prompt/runtime mismatch that made inner dialogue try the wrong delivery tool.
**Evidence**: Code inspection on `origin/main` after PR #439 showed `core.ts` comments and active tool assembly keep flow tools available regardless of `toolChoiceRequired`, while prompt tests still expected `settle` to disappear when `toolChoiceRequired:false`.
**Severity**: high-value
**Blast radius**: self-contained
**Fix shape**: Make prompt tool rendering derive the same flow-tool additions as runtime, and update prompt tests so optional tool choice means "not forced" rather than "terminal tools absent."
**Status**: fixed
**Linked work**: https://github.com/ouroborosbot/ouroboros/pull/441

---

## [D-003] — Prompt tool list omits `observe` when runtime exposes it

**Source**: observed-during-seed
**What**: Group/reaction turns get `observe` in `runAgent()` active tools, but `toolsSection()` does not add `observe` to `## my tools` for group or reaction contexts.
**Where**: `src/mind/prompt.ts:508`; `src/heart/core.ts:736`
**Why it matters**: Group/reaction prompts can discuss silence/observation in prose without showing the actual `observe` tool in the canonical tool list, another prompt/runtime mismatch at the handoff point.
**Evidence**: Code inspection on the `D-002` seed showed runtime appends `observeTool` when `currentContext?.isGroupChat || options?.isReactionSignal`, while prompt tool rendering never imports or appends `observeTool`.
**Severity**: high-value
**Blast radius**: self-contained
**Fix shape**: Reuse the prompt/runtime parity helper from D-002 so group/reaction prompt tools include `observe` exactly when runtime would expose it.
**Prerequisites**: D-002
**Status**: fixed
**Linked work**: https://github.com/ouroborosbot/ouroboros/pull/441

---

## [D-004] — Coverage gate intermittently loses nerves capture artifacts

**Source**: observed-during-seed
**What**: Full `npm run test:coverage` can pass all Vitest files and 100% code coverage while the post-run nerves audit sees zero events because the run directory lacks `vitest-events.ndjson` and `vitest-events-per-test.json`.
**Where**: `scripts/run-coverage-gate.cjs`; `src/__tests__/nerves/global-capture.ts`; temp run artifacts under `/tmp/ouroboros-test-runs/ouroboros-agent-harness`
**Why it matters**: A valid full test run can fail the final gate for missing capture artifacts, creating rerun friction and weakening trust in the coverage gate as a production readiness signal.
**Evidence**: Observed during D-002 verification on run `2026-04-12T02-15-22-017Z`: 422 test files and 8,147 tests passed with 100% code coverage, but `nerves-coverage.json` reported `checked_events: 0`, `total_tests: 0`, `observed_keys: 0`, and the run directory contained only `nerves-coverage.json` plus `coverage-gate-summary.json`.
**Severity**: high-value
**Blast radius**: affects multiple modules
**Fix shape**: Make the coverage gate fail fast or self-diagnose when capture files are missing, then fix the underlying active-run/capture lifecycle so successful Vitest runs cannot silently skip artifact writes.
**Status**: fixed
**Linked work**: https://github.com/ouroborosbot/ouroboros/pull/442

---

## [D-005] — PATH can still resolve a stale `ouro` shim after npm publish/update

**Source**: observed-during-seed
**What**: After publishing and smoke-testing `0.1.0-alpha.340`, a clean temp-directory `npx --package @ouro.bot/cli@0.1.0-alpha.340 ouro --version` reported `.340`, but this shell's PATH-resolved `ouro` command still resolved to `/opt/homebrew/bin/ouro` and reported `0.1.0-alpha.323`.
**Where**: `/opt/homebrew/bin/ouro`; install/update path resolution
**Why it matters**: A user can successfully install or publish a newer runtime while their normal `ouro` command still points at an older shim, making update verification and repair guidance look contradictory.
**Evidence**: Observed immediately after PR #441 publish: `npm view @ouro.bot/cli@0.1.0-alpha.340 version` and `npm view ouro.bot@0.1.0-alpha.340 version` both returned `.340`, clean temp `npx` returned `.340`, `npx ouro.bot@0.1.0-alpha.340 --version` returned `.340`, but `which ouro && ouro --version` returned `/opt/homebrew/bin/ouro` and `0.1.0-alpha.323`.
**Severity**: high-value
**Blast radius**: self-contained
**Fix shape**: Teach install/update/doctor to detect when PATH resolves `ouro` to a stale external shim and either repair the shim or print exact path-specific remediation.
**Status**: in-progress
**Linked work**: branch `ouroboros/stale-path-shim`

---

## [D-006] — Per-test nerves audit is not currently enforceable against the full suite

**Source**: observed-during-seed
**What**: When per-test capture is made to aggregate completed tests across all Vitest workers/files, the post-run nerves audit reports thousands of silent tests and hundreds of unmatched `_start` events instead of passing.
**Where**: `src/__tests__/nerves/global-capture.ts`; `src/nerves/coverage/audit-rules.ts`; `src/nerves/coverage/audit.ts`
**Why it matters**: The current gate can only stay green because semantic per-test capture is effectively not representing the full suite; making it truthful requires either broad test instrumentation work or a narrower, explicitly enforced rule contract.
**Evidence**: During D-004, a full `npm run test:coverage` with cross-file per-test aggregation captured 15,143 events but failed with `4376 test(s) emitted zero events` and `794 unmatched _start event(s)` in run `2026-04-12T03-01-41-301Z`.
**Severity**: high-value
**Blast radius**: crosses trust boundaries
**Fix shape**: Decide whether per-test audit should enforce every test or a scoped subset, then update capture/audit/tests together so the rule is truthful and CI-enforceable without relying on empty per-test artifacts.
**Suggested supporting skills**: work-planner
**Status**: open
**Linked work**:

---
