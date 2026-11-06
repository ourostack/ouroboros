# Doing: Layer 3 — RepairGuide Library Bundle + Loader + `kind: library` Exclusion + Override-Path Removal

**Status**: READY_FOR_EXECUTION
**Execution Mode**: direct (strict-TDD)
**Created**: 2026-04-28 19:33 UTC
**Planning**: ../planning/2026-04-28-1900-planning-harness-hardening-and-repairguide.md
**Artifacts**: ./2026-04-28-1933-doing-layer-3-repairguide-bundle/

**PR shape**: Standalone PR. Fourth and final in the sequence (1 → 4 → 2 → 3).
**Depends on**:
- Layer 1 PR (`2026-04-28-1930-doing-layer-1-rollup-vocabulary.md`) merged.
- Layer 4 PR (`2026-04-28-1931-doing-layer-4-drift-detection.md`) merged — drift findings feed the activation contract.
- Layer 2 PR (`2026-04-28-1932-doing-layer-2-sync-probe.md`) merged — sync findings feed the activation contract and the `diagnose-broken-remote.md` / `diagnose-sync-blocked.md` skills.
- Cut this branch from main *after* all three preceding PRs land.

## Execution Mode

- **direct** with strict TDD enforced. Single-session execution. Sequential units. Commit per phase.

## Objective

Ship four distinct things in a single coherent PR (because they all trade in the same `kind: library` mechanism):

1. **`RepairGuide.ouro/` library bundle** — sibling to `SerpentGuide.ouro/` at repo root. Ships with `agent.json` (`enabled: false`, `kind: "library"`), `psyche/SOUL.md`, `psyche/IDENTITY.md`, and five skills under `skills/`.
2. **Loader integrated into `src/heart/daemon/agentic-repair.ts`** — reads `RepairGuide.ouro/{psyche,skills}/*.md` as content and feeds it into the existing one-shot LLM diagnostic call. Output flows through the typed `RepairAction` catalog (`readiness-repair.ts`). v1 introduces no new action kinds.
3. **`kind: library` agent-discovery exclusion** — `agent.json` gains an optional `kind` field. `agent-discovery.ts` (`listAllBundleAgents`, `listEnabledBundleAgents`, `listBundleSyncRows`) skips bundles where `kind === "library"`. SerpentGuide.ouro gets `"kind": "library"` retroactively.
4. **`~/AgentBundles/` override-path removal** — `getSpecialistIdentitySourceDir()` in `hatch-specialist.ts` drops the `userSource` branch. In-repo is the only source. Symmetric for RepairGuide (no override path exists). Five files touched (per planning O8).

## Activation contract (LOCKED — O4)

The existing code already partitions degraded findings into typed vs untyped at `cli-exec.ts:6693-6694`:
```ts
const typedDegraded   = daemonResult.stability.degraded.filter((entry) =>  isKnownReadinessIssue(entry.issue))
const untypedDegraded = daemonResult.stability.degraded.filter((entry) => !isKnownReadinessIssue(entry.issue))
```
And today's `runAgenticRepair` is gated at `cli-exec.ts:6706` on `untypedDegraded.length > 0`.

**This PR extends that gate to**: fire when `untypedDegraded.length > 0` **OR** `typedDegraded.length >= 3`.

Threshold of 3 (not 2) prevents common pairs (vault-locked + provider-auth-needed) from firing on every boot.

`--no-repair` flag (`cli-parse.ts:1435`, `cli-exec.ts:6621,6680`) is the existing escape hatch. NO new env knob.

**Naming**: the doing doc occasionally uses the term `typedIssues` for ergonomics. The actual existing variable is `typedDegraded`. Wherever the activation function refers to "typed issue count," it means `typedDegraded.length`.

## Completion Criteria

### RepairGuide bundle
- [ ] `RepairGuide.ouro/agent.json` ships with `"enabled": false`, `"kind": "library"`. No provider config, no senses, no sync block.
- [ ] `RepairGuide.ouro/psyche/SOUL.md` exists — orientation: structured-proposal generator, never an actor.
- [ ] `RepairGuide.ouro/psyche/IDENTITY.md` exists — diagnostician persona.
- [ ] Five skills under `RepairGuide.ouro/skills/`:
  - `diagnose-bootstrap-drift.md` — `agent.json` ↔ `state/providers.json` mismatch (consumes layer 4 drift findings).
  - `diagnose-broken-remote.md` — 404, unreachable origin, auth-context errors (consumes layer 2 sync findings: `not-found-404`, `auth-failed`, `network-down`).
  - `diagnose-sync-blocked.md` — merge conflicts, dirty working tree, non-FF (consumes layer 2 sync findings: `dirty-working-tree`, `non-fast-forward`, `merge-conflict`). NEW — split out from broken-remote per O2 lock.
  - `diagnose-vault-expired.md` — credential expiry (consumes existing `credential-revision-changed` signal from `provider-binding-resolver.ts`).
  - `diagnose-stacked-typed-issues.md` — compound situations / catch-all when ≥3 typed issues stack.

### Loader
- [ ] Loader integrated DIRECTLY into `src/heart/daemon/agentic-repair.ts` (per O5 lock — no standalone `repair-persona.ts` unless validator grows large during implementation).
- [ ] Loader reads `RepairGuide.ouro/{psyche,skills}/*.md` and concatenates them as system-prompt-shaped content prepended to the existing one-shot LLM diagnostic call.
- [ ] Activation contract honored (`untypedDegraded.length > 0 OR typedIssues >= 3`).
- [ ] `--no-repair` flag continues to skip the entire RepairGuide-driven step. Verified.
- [ ] Output flows through `RepairAction` catalog from `readiness-repair.ts`. v1 introduces NO new action kinds.
- [ ] Unparseable LLM output falls back to the existing text-blob behavior in `agentic-repair.ts`. Verified.
- [ ] If `RepairGuide.ouro/` is missing or any of its content files are absent, the loader logs a warning and falls back to today's pre-RepairGuide pipeline behavior. (Graceful degradation — RepairGuide content is additive.)

### `kind: library` exclusion
- [ ] `agent.json` schema gains optional `"kind": "library" | undefined`. (Other kinds may be added in the future; keep this open.)
- [ ] `agent-discovery.ts`:
  - `listAllBundleAgents` returns library bundles tagged with `kind`. (Or splits: `listAllAgentBundles` excludes library, `listAllBundles` includes everything. Decide during implementation; lean toward exclusion-by-default.)
  - `listEnabledBundleAgents` excludes library bundles unconditionally.
  - `listBundleSyncRows` excludes library bundles unconditionally.
- [ ] SerpentGuide.ouro/agent.json gets `"kind": "library"` retroactively.
- [ ] RepairGuide.ouro/agent.json ships with `"kind": "library"` from day one.
- [ ] Verified: RepairGuide does NOT appear in `ouro status`, daemon process spawn list, or `degradedComponents[]`.
- [ ] Verified: SerpentGuide remains absent from these surfaces (it was already absent via `enabled: false`; the new mechanism is the architectural reason now, not the transient `enabled` flag).

### Override-path removal (Layer 3a — O8)
- [ ] `src/heart/hatch/hatch-specialist.ts:21-31` — `getSpecialistIdentitySourceDir()` no longer reads `~/AgentBundles/SerpentGuide.ouro/psyche/identities`. In-repo is the only source.
- [ ] `src/heart/hatch/hatch-flow.ts` — transitive caller; verify no override-dependent code.
- [ ] `src/heart/daemon/cli-defaults.ts` — comment at line ~451 referencing the override is updated or removed; any code that depended on the override is updated.
- [ ] `src/__tests__/heart/hatch/hatch-specialist.test.ts:78-92` — override-path tests removed or rewritten to assert in-repo is the only source.
- [ ] `src/__tests__/heart/hatch/hatch-flow.test.ts` — fixture paths updated where they assumed the `~/AgentBundles/SerpentGuide.ouro/` override.
- [ ] No remaining reference to the override path: `grep -rn "AgentBundles.*SerpentGuide.*psyche/identities\|AgentBundles.*SerpentGuide.*identities" src/ src/__tests__/` returns nothing for the override pattern (general `AgentBundles` references are legitimate — just the override-specific ones are gone).

### Slugger fixture (compound integration test — O6 LOCKED)
- [ ] One compound integration fixture at `src/__tests__/heart/daemon/slugger-compound.test.ts` mirrors today's slugger incident:
  - Bundle on disk with bootstrap drift (`agent.json` and `state/providers.json` disagree).
  - Mocked vault state with expired credential revision (`credential-revision-changed`).
  - Mocked git remote returning 404 (`not-found-404`).
  - Dirty working tree (uncommitted changes).
- [ ] Fixture verifies:
  - Daemon rolls up to `partial` (other agents healthy), NOT `degraded`.
  - Slugger marked with structured per-agent diagnostics covering all four findings.
  - RepairGuide-driven proposals emitted via existing `RepairAction` catalog.
  - Dirty tree surfaced as advisory, not a blocker.
  - A second healthy agent in the same fixture comes up `healthy` with no per-agent degraded marker.
- [ ] Per-condition unit tests for taxonomy/rollup classification logic remain (created in layers 1, 2, 4) and still pass.

### Cross-cutting completion gates
- [ ] `ouro up --no-repair` skips the RepairGuide-driven proposal step, surfaces structured per-agent diagnostics, exits 0.
- [ ] `ouro up` boot does not hang on any of the slugger-fixture failure modes (timeouts from layer 2 enforce this).
- [ ] All existing tests pass, plus all new tests in this PR.
- [ ] 100% test coverage on all new code.
- [ ] No warnings.
- [ ] PR description (`./2026-04-28-1933-doing-layer-3-repairguide-bundle/pr-description.md`) drafted before merger.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- All branches of the activation-contract decision (`untypedDegraded.length > 0` true/false, `typedIssues >= 3` true/false, both, neither, `--no-repair` set).
- All branches of the loader (RepairGuide present + valid, missing, partially missing, malformed markdown).
- All branches of the `kind: library` filter (`kind === "library"` excludes; `kind === undefined` includes; future `kind === "x"` propagation).
- All branches of the LLM output parser (typed `RepairAction` extracted; unknown kind dropped with warning; entire output unparseable → text-blob fallback).
- Edge cases:
  - Empty `psyche/` directory in RepairGuide.ouro.
  - Empty `skills/` directory in RepairGuide.ouro.
  - Bundle root missing entirely.
  - SerpentGuide.ouro is the only library bundle on the system → no regression.
  - Mixed kinds: SerpentGuide (library), RepairGuide (library), real agents (no kind or `kind === "agent"`) → discovery returns only the real agents.

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

### ⬜ Unit 0: Verify layers 1, 4, 2 have landed
**What**:
- Confirm `DaemonStatus` + `computeDaemonRollup` from layer 1 in `daemon-health.ts`.
- Confirm `detectProviderBindingDrift` from layer 4 in `drift-detection.ts`.
- Confirm `runBootSyncProbe` from layer 2 in `boot-sync-probe.ts`.
- If any is missing, halt — do NOT start this PR. Re-cut the branch from a base where all three have landed.
**Acceptance**: All three symbols exist on the base. `git log` shows all three PRs merged.

### ⬜ Unit 1a: `kind: library` exclusion in `agent-discovery.ts` — Tests
**What**: Write failing tests in `src/__tests__/heart/daemon/agent-discovery-kind.test.ts` (new file) covering:
- A bundle with `"kind": "library"` is excluded from `listEnabledBundleAgents` and `listBundleSyncRows`.
- A bundle with no `kind` field continues to be discovered (back-compat).
- A bundle with `"kind": "agent"` (explicit) is discovered.
- Mixed inventory: discovery returns only non-library bundles.
- The `listAllBundleAgents` behavior (whether it includes library bundles or not — decide here based on the tests you write; recommend: it returns ALL bundles with their `kind`, and the filter happens in `listEnabledBundleAgents` / `listBundleSyncRows`).
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 1b: `kind: library` exclusion — Implementation
**What**:
- Extend the `agent.json` parse type in `agent-discovery.ts` with `kind?: string`.
- Extend `BundleAgentRow` (or whatever the existing inventory row type is) with `kind?: string`.
- Update `listEnabledBundleAgents` to filter `kind === "library"`.
- Update `listBundleSyncRows` to filter `kind === "library"`.
- Optionally export a typed predicate `isLibraryKind(kind: unknown): boolean`.
**Acceptance**: Tests from 1a PASS. No regression in existing `agent-discovery` tests.

### ⬜ Unit 1c: `kind: library` exclusion — Coverage & refactor
**What**: 100% branch coverage. Refactor.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 2a: Tag SerpentGuide.ouro as library — Tests
**What**: Write failing test in `src/__tests__/heart/daemon/serpentguide-library-kind.test.ts` (new file) asserting:
- `SerpentGuide.ouro/agent.json` parses with `kind === "library"`.
- `listEnabledBundleAgents` does not return SerpentGuide regardless of its `enabled` flag.
- An override of SerpentGuide's `enabled` to true (in-test fixture) still does NOT promote it to discovery (because `kind === "library"` overrides `enabled`).
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 2b: Tag SerpentGuide.ouro as library — Implementation
**What**: Edit `SerpentGuide.ouro/agent.json` — add `"kind": "library"` field (alongside `"enabled": false`). Both fields stay; `kind: library` is the architectural reason, `enabled: false` is preserved for back-compat with anything that still reads it.
**Acceptance**: Tests from 2a PASS. Existing SerpentGuide-related tests still pass.

### ⬜ Unit 2c: Tag SerpentGuide.ouro as library — Coverage & refactor
**What**: Coverage on the changed agent.json parse path.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 3: Build RepairGuide.ouro bundle skeleton
**What**: Create the bundle on disk:
- `RepairGuide.ouro/agent.json` with `{"version": 2, "enabled": false, "kind": "library"}`.
- `RepairGuide.ouro/psyche/SOUL.md` with orientation content (see "Content drafting notes" below).
- `RepairGuide.ouro/psyche/IDENTITY.md` with diagnostician persona content.
- `RepairGuide.ouro/skills/diagnose-bootstrap-drift.md`
- `RepairGuide.ouro/skills/diagnose-broken-remote.md`
- `RepairGuide.ouro/skills/diagnose-sync-blocked.md`
- `RepairGuide.ouro/skills/diagnose-vault-expired.md`
- `RepairGuide.ouro/skills/diagnose-stacked-typed-issues.md`
**Acceptance**: All files exist on disk in repo. `git status` shows them as untracked. `agent.json` parses cleanly as JSON.

### ⬜ Unit 4a: RepairGuide loader — Tests
**What**: Write failing tests for the loader function (call it `loadRepairGuideContent(repoRoot: string): RepairGuideContent | null`) in `src/__tests__/heart/daemon/repair-guide-loader.test.ts` (new file).
**Test cases**:
- All files present → returns concatenated content with section markers.
- `RepairGuide.ouro/` directory missing → returns null, no throw.
- `psyche/SOUL.md` present, others missing → returns partial content, no throw.
- Skill file empty → skipped silently.
- Skill file with only frontmatter → still concatenated (caller decides).
- Multiple psyche files (future-proofing) → concatenated in alphabetical order.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 4b: RepairGuide loader — Implementation
**What**: Implement `loadRepairGuideContent` in `src/heart/daemon/agentic-repair.ts` (per O5 lock — inlined unless validator grows). Use `getRepoRoot()` from `identity.ts` to find the bundle.
**Output shape**:
```ts
interface RepairGuideContent {
  psyche: { soul?: string; identity?: string }
  skills: Record<string, string>  // filename → content
}
```
**Acceptance**: Tests from 4a PASS.

### ⬜ Unit 4c: RepairGuide loader — Coverage & refactor
**What**: 100% coverage. Refactor.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 5a: Activation contract — Tests
**What**: Write failing tests for `shouldFireRepairGuide(input: { untypedDegraded: DegradedAgent[]; typedDegraded: DegradedAgent[]; noRepair: boolean }): boolean` in `src/__tests__/heart/daemon/repair-guide-activation.test.ts` (new file). Use the existing `DegradedAgent` type from `cli-exec.ts` for the input shape so the function plugs in cleanly at the existing call site.
**Test cases**:
- `noRepair: true` → false unconditionally.
- `untypedDegraded.length > 0` → true (matches today's behavior — preserved).
- `typedDegraded.length === 0` → false.
- `typedDegraded.length === 1` → false.
- `typedDegraded.length === 2` → false (threshold is 3, not 2 — this is the lock; canonical "common pair" case from the lock — vault-locked + provider-auth-needed).
- `typedDegraded.length === 3` → true.
- `typedDegraded.length === 5` → true.
- `untypedDegraded.length === 0 && typedDegraded.length === 2 && noRepair: false` → false.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 5b: Activation contract — Implementation
**What**: Implement `shouldFireRepairGuide` in `agentic-repair.ts`. Pure function.
**Acceptance**: Tests from 5a PASS.

### ⬜ Unit 5c: Activation contract — Coverage & refactor
**What**: 100% coverage.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 6a: LLM output parser → typed `RepairAction` — Tests
**What**: Write failing tests for `parseRepairProposals(llmOutput: string): { actions: RepairAction[]; warnings: string[]; fallbackBlob?: string }` in `src/__tests__/heart/daemon/repair-proposal-parser.test.ts` (new file).
**Test cases**:
- LLM output contains a structured `vault-unlock` action → parsed correctly.
- LLM output contains an `unknown-action-kind` action → dropped with warning.
- LLM output is entirely unparseable → no actions, `fallbackBlob` populated with the raw output.
- LLM output contains multiple actions → all parsed.
- Each existing action kind in `readiness-repair.ts` (`vault-create`, `vault-unlock`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use`) is parseable.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 6b: LLM output parser — Implementation
**What**: Implement `parseRepairProposals` in `agentic-repair.ts`. Decide structured-output format during implementation: a JSON block in the LLM output is the simplest. The persona content (SOUL.md / skills) instructs the LLM to emit JSON in a specific shape.
**Acceptance**: Tests from 6a PASS.

### ⬜ Unit 6c: LLM output parser — Coverage & refactor
**What**: 100% coverage. If the parser grows large enough that it dominates `agentic-repair.ts`, split into a sibling file (`repair-proposal-parser.ts`) — operator's O5 lock allows this judgment call.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 7a: Wire RepairGuide into existing `agentic-repair.ts` flow — Tests
**What**: Write failing integration tests in `src/__tests__/heart/daemon/agentic-repair-with-repairguide.test.ts` covering:
- `agentic-repair.ts` is invoked during `ouro up`. Loader runs. Activation contract evaluated. If fired, RepairGuide content prepended to system prompt. LLM output parsed. Typed actions surfaced.
- `--no-repair` short-circuits the entire RepairGuide path. Diagnostics still surface.
- Activation false (only 2 typed issues, no untyped) → today's pre-RepairGuide `agentic-repair.ts` flow runs unchanged.
- LLM call fails → `discoverWorkingProvider` already handles this; verify the typed-action repair from `readiness-repair.ts` still fires regardless.
**Acceptance**: Tests exist and FAIL (red).

### ⬜ Unit 7b: Wire RepairGuide — Implementation
**What**:
- Modify the gate at `cli-exec.ts:6706` from `if (untypedDegraded.length > 0)` to `if (shouldFireRepairGuide({ untypedDegraded, typedDegraded, noRepair: command.noRepair === true }))`. This is the single-line gate change that activates the new contract.
- Inside the existing one-shot LLM diagnostic call in `agentic-repair.ts`, load RepairGuide content via `loadRepairGuideContent` and prepend `psyche/SOUL.md` + `psyche/IDENTITY.md` + relevant skills (selected based on the finding mix — skills act as instructions for the LLM) to the system prompt.
- Pass `runAgenticRepair`'s output through `parseRepairProposals`. If actions extracted, hand them to `interactive-repair.ts` (existing surface). If only `fallbackBlob`, surface that as today.
- Honor `--no-repair` — already encoded in the gate function via the `noRepair` arg.
**Acceptance**: Tests from 7a PASS. Existing `agentic-repair` tests still pass. Existing `cli-exec.ts:6706` regression tests still pass.

### ⬜ Unit 7c: Wire RepairGuide — Coverage & refactor
**What**: 100% coverage on changed lines.
**Acceptance**: Coverage 100%. Tests green.

### ⬜ Unit 8a: Override-path removal — Tests
**What**: Write tests asserting the new behavior in `src/__tests__/heart/hatch/hatch-specialist.test.ts` (modified file):
- `getSpecialistIdentitySourceDir()` returns the in-repo path unconditionally.
- Even when `~/AgentBundles/SerpentGuide.ouro/psyche/identities` exists on disk (test fixture), the function ignores it and returns the in-repo path.
- The existing fallback test ("falls back to __dirname-relative path when ~/AgentBundles/ does not exist") becomes a positive test: "always returns __dirname-relative path."
- Existing override-path test (lines 78-85 in current test file) is removed or rewritten.
**Acceptance**: Updated tests exist and FAIL (red) against the current (override-honoring) implementation.

### ⬜ Unit 8b: Override-path removal — Implementation
**What**:
- `src/heart/hatch/hatch-specialist.ts:21-31` — remove the `userSource` branch from `getSpecialistIdentitySourceDir()`. Keep only the in-repo path (`getRepoSpecialistIdentitiesDir()`).
- `src/heart/hatch/hatch-flow.ts` — verify nothing depends on the override; update if needed.
- `src/heart/daemon/cli-defaults.ts:451` — update the comment that references the override; remove any code that depended on it.
- `src/__tests__/heart/hatch/hatch-flow.test.ts` — fixture paths that used `~/AgentBundles/SerpentGuide.ouro/` to populate identities should now write to the in-repo path (or the test should mock `getRepoSpecialistIdentitiesDir`).
**Acceptance**: Tests from 8a PASS. All existing hatch tests still pass.

### ⬜ Unit 8c: Override-path removal — Coverage & refactor
**What**: 100% coverage on the changed lines. Run `grep -rn "AgentBundles.*SerpentGuide.*identities\|AgentBundles.*SerpentGuide.*psyche" src/ src/__tests__/` and confirm only legitimate references remain (i.e., not the removed override).
**Acceptance**: Coverage 100%. Tests green. Grep is clean of the override pattern.

### ⬜ Unit 9: Compound integration fixture — slugger-shaped acceptance test (O6 LOCKED)
**What**: Build the canonical compound fixture in `src/__tests__/heart/daemon/slugger-compound.test.ts`.
**Fixture setup**:
- Two agents in the test inventory: a "slugger" agent with all four findings, and a "healthy" agent.
- Slugger's `agent.json` references provider/model X.
- Slugger's `state/providers.json` (in fixture) references provider/model Y (DIFFERENT — drift).
- Slugger's vault has an expired credential revision (mocked).
- Slugger's git remote returns 404 (mocked or pointed at a non-existent remote).
- Slugger's working tree is dirty (uncommitted changes seeded into the fixture repo).
**Assertions**:
- Daemon rollup is `partial` (NOT `degraded`).
- Slugger has structured per-agent diagnostics covering: drift, vault expiry, broken remote, dirty tree.
- RepairGuide-driven proposals are emitted via `RepairAction` catalog (at least one action per finding where the catalog supports it).
- Healthy agent rolls up `healthy` with no per-agent degraded marker.
- Boot completes within the timeout budget (no hang).
- `--no-repair` variant of the same fixture: same diagnostics surface, no RepairGuide call, exit 0.
**Acceptance**: Fixture passes.

### ⬜ Unit 10: Final-pass full-suite green + PR description
**What**:
- Run full test suite. All green (this PR's tests + every prior PR's tests + every pre-existing test).
- `tsc --noEmit` clean.
- Lint clean.
- Verify `ouro status` does NOT list RepairGuide regardless of its internal state. Manual check + automated test.
- Verify daemon process spawn does NOT include RepairGuide. Manual check + automated test.
- Verify the override-path removal grep is clean.
- Draft `./2026-04-28-1933-doing-layer-3-repairguide-bundle/pr-description.md`. This PR description is the most consequential of the four — it explains the new `kind: library` mechanism, the activation contract, the bundle shape, and the override removal. Cite all three preceding PRs as dependencies.
**Acceptance**: Suite green. Typecheck clean. Lint clean. Manual + automated visibility checks pass. PR description drafted.

## Content drafting notes (for unit 3)

The `psyche/` and `skills/` markdown is content the LLM consumes during the diagnostic call. It is NOT executed code. Draft each file with these properties:

**`psyche/SOUL.md`** — orientation:
- "You are RepairGuide. You produce structured proposals only. You are NEVER an actor."
- "Your output is parsed against a typed catalog of repair actions. Use the action kinds the harness recognizes: `vault-unlock`, `vault-create`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use`. Do not invent new kinds."
- "Output format: a JSON block (delimited by triple-backtick `json`) inside your response. The harness extracts the JSON; surrounding prose is ignored."
- "If you can't classify a finding, say so plainly. Do not guess."

**`psyche/IDENTITY.md`** — persona:
- "You are a diagnostician. You look at the inventory of findings, classify each, and propose a fix."
- "You do not execute repairs. You do not write to disk. You do not call tools. You generate a JSON proposal."

**Skills** — each skill is a recipe for one class of failure. Draft each as:
- Heading: skill name + one-line summary.
- Inputs section: what fields in the finding inventory this skill cares about.
- Diagnosis section: how to classify when this skill applies.
- Proposed action section: what `RepairAction` kind(s) to emit. Include literal action-shape examples.

The exact prose can be drafted iteratively during implementation. The shape of the markdown is what matters to the loader — the LLM consumes the prose.

## Execution
- TDD strictly enforced.
- Commit per phase. Push per unit.
- All artifacts in `./2026-04-28-1933-doing-layer-3-repairguide-bundle/`.
- This is the largest PR in the sequence. Resist the urge to skip the per-condition tests in favor of just the slugger fixture — both are required.

## Reference: load-bearing source paths

- `SerpentGuide.ouro/agent.json` (precedent for library-bundle shape; gets `"kind": "library"` retroactively)
- `SerpentGuide.ouro/psyche/{SOUL.md, identities/}` (current shape; RepairGuide adds `IDENTITY.md` and a `skills/` directory not present in SerpentGuide)
- `src/heart/daemon/agentic-repair.ts` (loader integration site — O5 LOCKED inlined here)
- `src/heart/daemon/readiness-repair.ts` (typed `RepairAction` catalog: `vault-create`, `vault-unlock`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use` — no new kinds in v1)
- `src/heart/daemon/interactive-repair.ts` (propose-then-confirm UI — re-used)
- `src/heart/daemon/agent-discovery.ts` (`listAllBundleAgents`, `listEnabledBundleAgents`, `listBundleSyncRows` — get the `kind: library` filter)
- `src/heart/daemon/cli-parse.ts:1435`, `cli-exec.ts:6621,6680` (`--no-repair` flag — escape hatch, no new env knob)
- `src/heart/hatch/hatch-specialist.ts:21-31` (`getSpecialistIdentitySourceDir` — `userSource` branch removed)
- `src/heart/hatch/hatch-flow.ts:182` (transitive caller of override path)
- `src/heart/daemon/cli-defaults.ts:451` (comment + workaround referencing the override)
- `src/__tests__/heart/hatch/hatch-specialist.test.ts:78-92` (override-path tests — removed/rewritten)
- `src/__tests__/heart/hatch/hatch-flow.test.ts` (transitive test fixtures)
- `src/heart/daemon/daemon-health.ts` (layer 1 vocabulary)
- `src/heart/daemon/drift-detection.ts` (layer 4 — drift findings feed `diagnose-bootstrap-drift.md` skill)
- `src/heart/daemon/boot-sync-probe.ts` (layer 2 — sync findings feed `diagnose-broken-remote.md` and `diagnose-sync-blocked.md` skills)
- `src/heart/provider-binding-resolver.ts` (`credential-revision-changed` — feeds `diagnose-vault-expired.md` skill)
- `ARCHITECTURE.md:337-338` (skills boundaries — repo-root `skills/` is shared; bundle-local `skills/` is agent-specific; RepairGuide's `skills/` is bundle-local content for the LLM, not executable skills)

## Notes

- The activation contract is a single decision function. Do not scatter the `>= 3` threshold across multiple sites — encode it once in `shouldFireRepairGuide`.
- The skill files are content; the loader reads them as markdown and prepends them to the system prompt. They are NOT executable. The Skill tool integration (worker / claude-code skills) is a different system entirely.
- Recursion base case: RepairGuide is a library bundle, not an agent. It cannot fail in the agent-runtime sense. It can fail only in two ways: (a) markdown content malformed/missing — graceful: text-blob fallback; (b) the LLM call itself fails — graceful: `discoverWorkingProvider` already handles this and the typed-action repair from `readiness-repair.ts` fires anyway.
- The override-path removal is a CLEAN drop, not a migration (per planning O8 lock — operator confirms no local override exists today). If a local override is discovered post-merge, the recovery is "delete `~/AgentBundles/SerpentGuide.ouro/psyche/identities` and the in-repo source takes over."
- This PR's review surface is large. Reviewers should focus on: (1) the `kind: library` mechanism semantics, (2) the activation-contract threshold (the 3-not-2 lock is non-obvious), (3) the slugger compound fixture as the operative acceptance signal.

## Progress Log
- 2026-04-28 19:33 UTC Created as PR 4 of 4 in the sequential rollout (1 → 4 → 2 → 3). Depends on layers 1, 4, and 2 PRs all merged.
