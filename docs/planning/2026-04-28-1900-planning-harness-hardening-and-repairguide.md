# Planning: Four-Layer Hardening of the Daemon Agent-Loading Path + RepairGuide Library Bundle

**Status**: NEEDS_REVIEW
**Created**: 2026-04-28 19:14 UTC
**Ideation**: ./2026-04-28-1830-ideation-harness-hardening-and-repair-agent.md
**Open questions**: ALL RESOLVED (operator + ouroboros joint sign-off, 2026-04-28 19:30 UTC). See "Open Questions" section — each marked RESOLVED with locked answer.

## Goal

Make the ouroboros daemon's `ouro up` path resilient to a single bad agent bundle. Today, one sick agent (slugger-shaped: bootstrap drift + expired creds + 404 remote + dirty tree) tips the entire harness into a degraded rollup, even though the per-agent live-check loop already isolates the failure. Replace that overloaded rollup with explicit per-agent semantics, add sync probing and intent/state drift detection so the daemon emits richer per-agent diagnostics, and ship a `RepairGuide.ouro/` library bundle whose `psyche/` + `skills/` content drives the existing agentic-repair pipeline toward structured action proposals — without RepairGuide ever appearing as a peer agent.

## Scope

### In Scope

**Layer 1 — rollup semantics (not loop redesign)**
- Replace today's overloaded "degraded" daemon-wide signal with the five-state rollup defined in locked decision #7 (`healthy`, `partial`, `degraded`, `safe-mode`, `down`).
- Fix the rollup logic that today promotes any non-empty `degradedComponents[]` (set in `daemon-entry.ts:183-217`'s `recordRecoverableBootstrapFailure`) into a daemon-scope "degraded" status.
- Per-agent live-check loop in `cli-exec.ts:287` is already try/catch-isolated — leave it alone. The change is in how its output is rolled up.
- Update `DaemonHealthState.status` (`daemon-health.ts:30-40`) and the consumers that read it (`inner-status.ts`, `startup-tui.ts`) to use the new vocabulary.

**Layer 2 — pre-up sync probe**
- Wire the existing `preTurnPull` from `src/heart/sync.ts` into `ouro up`'s per-agent loop, gated on each bundle's `sync.enabled: true` (read from `agent-discovery.ts`'s `listBundleSyncRows`).
- Run the sync probe BEFORE per-agent live-checks, so live-check reads the post-pull `agent.json` if a pull succeeded.
- Surface (do not crash) on: 404 remote, no network, dirty working tree, non-fast-forward, merge conflict, auth failure (distinguished from genuine 404).
- Hard timeouts on every `git fetch`/`git pull` invocation (O1 RESOLVED): 8s soft (warn) / 15s hard (cut). `AbortSignal` threaded end-to-end so a stuck op cannot deadlock boot. Env override knobs: `OURO_BOOT_TIMEOUT_GIT_SOFT`, `OURO_BOOT_TIMEOUT_GIT_HARD` (env is override, not the design centre).
- Never touch `state/` (gitignored, per-machine).

**Layer 3 — `RepairGuide.ouro/` library bundle (NOT a real agent)**
- Sibling directory to `SerpentGuide.ouro/` at the repo root. Same shape: ships with the repo, has `agent.json` with `enabled: false`, contains markdown content under `psyche/` and `skills/`.
- Loaded as a *content source* by the existing `src/heart/daemon/agentic-repair.ts` pipeline. The pipeline already does one-shot LLM diagnostics during `ouro up` and already solves the chicken-and-egg via `discoverWorkingProvider()` — RepairGuide content rides in on top of that pipeline.
- RepairGuide must NOT be picked up by `agent-discovery.ts` as a regular agent. Concretely: confirmed absent from `listEnabledBundleAgents`, `ouro status`, daemon process spawn, and the `degraded[]` rollup. Mechanism (O3 RESOLVED): explicit `"kind": "library"` field in bundle's `agent.json`. `agent-discovery.ts` skips bundles where `kind === "library"`. SerpentGuide.ouro/agent.json gets `"kind": "library"` retroactively; RepairGuide ships with it from day one. Reasoning: don't conflate "agent off" (transient `enabled: false`) with "this isn't an agent" (architectural).
- RepairGuide's outputs flow through the existing typed `RepairAction` catalog in `readiness-repair.ts` (`vault-unlock`, `provider-auth`, `provider-use`, etc.). v1 introduces NO new action kinds.
- v1 has zero tool surface for the LLM. The persona produces structured proposals; the harness validates each against the typed catalog; unknown kinds drop with a warning. Fallback path on unparseable output: today's text-blob behavior in `agentic-repair.ts`.
- **Layer 3 v1 file shape (O5 RESOLVED)**: Bundle (`RepairGuide.ouro/`) + loader integrated directly into `src/heart/daemon/agentic-repair.ts`. NO standalone `repair-persona.ts` module unless the structured-output validator grows large enough on its own to deserve a separate file (judgment call during implementation; default = inline).
- **RepairGuide bundle contents (O2 RESOLVED — five skills, not four)**:
  - `RepairGuide.ouro/agent.json` — `enabled: false`, `kind: "library"`, no provider config (it doesn't run as an agent).
  - `RepairGuide.ouro/psyche/SOUL.md` — orientation: structured-proposal generator, never an actor.
  - `RepairGuide.ouro/psyche/IDENTITY.md` — diagnostician persona.
  - `RepairGuide.ouro/skills/diagnose-bootstrap-drift.md` — `agent.json` ↔ `state/providers.json` mismatch.
  - `RepairGuide.ouro/skills/diagnose-broken-remote.md` — 404, unreachable origin, auth-context errors.
  - `RepairGuide.ouro/skills/diagnose-sync-blocked.md` — merge conflicts, dirty working tree, non-FF (NEW; separate from broken-remote so git failures don't junk-drawer together).
  - `RepairGuide.ouro/skills/diagnose-vault-expired.md` — credential expiry.
  - `RepairGuide.ouro/skills/diagnose-stacked-typed-issues.md` — compound situations / catch-all.
- **Layer 3 activation contract (O4 RESOLVED)**: Fire RepairGuide repair when `untypedDegraded.length > 0` OR `typedIssues >= 3` (threshold bumped from the ideator's `>= 2` to prevent common pairs like vault-locked + provider-auth-needed from firing on every boot). NO new env flag for repair-agent-on/off — the existing `--no-repair` flag (`cli-parse.ts:1435`, `cli-exec.ts:6621,6680`) is the escape hatch.

**Layer 3a — remove `~/AgentBundles/` override fallback for library bundles**
- Modify `getSpecialistIdentitySourceDir()` in `src/heart/hatch/hatch-specialist.ts` to remove the `~/AgentBundles/SerpentGuide.ouro/` override path. In-repo is the only source.
- Apply the same constraint for RepairGuide: there is no override path; RepairGuide is read from in-repo only.
- Operator confirms no local override exists today, so removal is a clean drop, not a migration.

**Layer 4 — provider-binding drift detection**
- Use the half-built `EffectiveProviderReadiness.reason: "provider-model-changed"` signal in `src/heart/provider-binding-resolver.ts`.
- On every boot, compare each agent's `agent.json` intended provider/model (legacy `humanFacing`/`agentFacing`, mapped to `outward`/`inner` via `normalizeProviderLane`) against per-machine `state/providers.json` actual binding.
- On mismatch, surface a warning + offer a one-line repair proposal using the existing `ouro use --agent X --lane Y --provider Z --model M` surface.
- Read side tolerates legacy `humanFacing`/`agentFacing` keys; write side emits `outward`/`inner`.

**Cross-cutting**
- Hard timeouts on every external op in `ouro up` (O1 RESOLVED):
  - `git fetch` / `git pull`: 8s soft (warn) / 15s hard (cut).
  - Provider live-check: 10s.
  - `AbortSignal` threaded end-to-end through every external call so a single stuck op cannot deadlock boot.
  - Env override knobs (overrides only — env is not the design centre): `OURO_BOOT_TIMEOUT_GIT_SOFT`, `OURO_BOOT_TIMEOUT_GIT_HARD`, `OURO_BOOT_TIMEOUT_LIVECHECK`.
- Test fixture reproducing slugger-shaped compound failure (O6 RESOLVED): single compound integration fixture mirroring today's slugger incident — bad bootstrap state + expired creds + broken remote + drift between `agent.json` and `state/providers.json`. This is the primary acceptance test. Per-condition unit tests cover taxonomy/rollup classification logic. Precedent: `src/__tests__/heart/daemon/serpentguide-bootstrap.test.ts`.

### Out of Scope

- Promoting RepairGuide to a real agent bundle with vault, sync, providers, or `ouro status` presence. (Ideator's "v2 path" is a future conversation, not this task.)
- Auto-applying any repair. v1 is propose-then-confirm only. `--auto-repair` is explicitly deferred.
- Inventing new `RepairAction` kinds beyond what `readiness-repair.ts` already declares.
- Healing 404 remotes by guessing a new URL. RepairGuide proposes either "disable sync" or "ask the operator for the correct URL."
- Healing `state/` from `agent.json` automatically. RepairGuide proposes the `ouro use` command; the existing typed-action runners apply it after operator confirmation.
- A new TUI surface for repair. Re-use `interactive-repair.ts` / `terminal-ui.ts`.
- Cross-machine sync of RepairGuide content (it ships with the repo; no per-machine drift surface on it).
- Memory-of-declined-repairs across boots (ideator open question 7). Defer; revisit if the post-fix UX is noisy.
- Replacing `safe-mode.ts` or its crash-loop semantics. The new `safe-mode` rollup state is the existing concept, surfaced through the new vocabulary.
- Writes to `state/` from harness code outside the per-bundle rules already in place (notably: layer 2 must NOT write `state/providers.json` even if drift detection proposes a fix).

## Completion Criteria

- [ ] Slugger-shaped fixture (bootstrap drift + expired cred + 404 remote + dirty tree) processed by `ouro up`:
  - daemon rolls up to `partial` (other agents healthy), NOT `degraded`
  - slugger marked with structured per-agent diagnostics covering all four findings
  - RepairGuide-driven proposals emitted via existing `RepairAction` catalog
  - dirty tree surfaced as advisory, not blocker
- [ ] A second healthy agent in the same fixture comes up `healthy` with no per-agent degraded marker.
- [ ] `ouro up --no-repair` skips the RepairGuide-driven proposal step, surfaces structured per-agent diagnostics, exits 0.
- [ ] Existing `agentic-repair` text-blob fallback still works when the model returns unparseable output.
- [ ] RepairGuide does NOT appear in `ouro status`, `listEnabledBundleAgents`, or `degraded[]` regardless of its own internal state.
- [ ] `~/AgentBundles/SerpentGuide.ouro/` override path removed; `getSpecialistIdentitySourceDir()` returns only the in-repo path.
- [ ] Layer 4 drift detection surfaces a `provider-model-changed`-flavored proposal for the slugger fixture's `agent.json` vs `state/providers.json` mismatch, with a copy-pasteable `ouro use` command.
- [ ] Hard timeouts on every external `ouro up` operation (git ops, live-checks); no observed boot hang in the fixture even with simulated slow remote.
- [x] Five-state rollup vocabulary (`healthy` / `partial` / `degraded` / `safe-mode` / `down`) appears in `DaemonHealthState` and the real consumers of the rollup field. No remaining call sites use the old single-bit "degraded" semantic for the daemon-wide status. _Scope correction during execution_: planning-doc-named consumers `inner-status.ts` / `startup-tui.ts` render per-agent inner-runtime / worker statuses respectively (different concept from the daemon-wide rollup). The actual consumers identified during the Unit 0 mapping survey are `cli-render.ts:daemonUnavailableStatusOutput` (the "Last known status:" line in the daemon-down view) and `runtime-readers.ts:readDaemonHealthDeep` (the Outlook surface parser). Both retargeted in this PR.
- [ ] 100% test coverage on all new code.
- [ ] All tests pass.
- [ ] No warnings.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- No `[ExcludeFromCodeCoverage]` or equivalent on new code.
- All branches covered (sync classification taxonomy, rollup state transitions, drift comparison branches, RepairGuide-vs-agent-discovery filter).
- All error paths tested (timeout, 404 vs auth-failed, unparseable LLM output, missing `state/providers.json`, missing `RepairGuide.ouro/`).
- Edge cases: zero enabled agents (rollup → `degraded`?), one enabled agent that's healthy (rollup → `healthy`), some healthy + some failing (rollup → `partial`), legacy `humanFacing`/`agentFacing` field names on read, empty `psyche/` or `skills/` directories in RepairGuide, `state/providers.json` absent.

## Open Questions

All eight open questions resolved 2026-04-28 19:30 UTC by joint operator + ouroboros review (operator hands-off; review authority delegated). Summarized below; full lock detail also embedded inline in the relevant Scope and Decisions Made sections.

- [x] **O1 RESOLVED — Concrete timeout values.** `git fetch` / `git pull`: 8s soft (warn) / 15s hard (cut). Provider live-check: 10s. `AbortSignal` threaded end-to-end so a stuck op cannot deadlock boot. Env override knobs: `OURO_BOOT_TIMEOUT_GIT_SOFT`, `OURO_BOOT_TIMEOUT_GIT_HARD`, `OURO_BOOT_TIMEOUT_LIVECHECK` (overrides only; env is not the design centre).
- [x] **O2 RESOLVED — RepairGuide bundle contents (FIVE skills, not four).** `psyche/SOUL.md` (orientation: structured-proposal generator, never an actor) + `psyche/IDENTITY.md` (diagnostician persona) + five skills: `diagnose-bootstrap-drift.md`, `diagnose-broken-remote.md`, `diagnose-sync-blocked.md` (NEW — split out from broken-remote so git failures don't junk-drawer together), `diagnose-vault-expired.md`, `diagnose-stacked-typed-issues.md`.
- [x] **O3 RESOLVED — Library-bundle exclusion mechanism.** Add explicit `"kind": "library"` field to bundle's `agent.json`. Update `agent-discovery.ts` to skip bundles where `kind === "library"`. Set on SerpentGuide.ouro/agent.json retroactively; RepairGuide ships with it from day one. Reasoning: don't conflate "agent off" (transient `enabled: false`) with "this isn't an agent" (architectural). Today's slugger incident demonstrated the cost of overloaded semantics.
- [x] **O4 RESOLVED — Layer 3 activation contract.** Fire RepairGuide repair when `untypedDegraded.length > 0` OR `typedIssues >= 3`. No new env flag for repair-on/off — the existing `--no-repair` flag (`cli-parse.ts:1435`, `cli-exec.ts:6621,6680`) is the escape hatch. Bumping the threshold from the ideator's `>= 2` prevents common pairs (vault-locked + provider-auth-needed) from firing on every boot.
- [x] **O5 RESOLVED — v1 file shape.** Bundle (`RepairGuide.ouro/`) + loader integrated into `src/heart/daemon/agentic-repair.ts`. No standalone `repair-persona.ts` module unless the structured-output validator grows large enough on its own to deserve a separate file (judgment call during implementation; default = inline).
- [x] **O6 RESOLVED — Test fixtures.** Compound integration fixture mirroring today's slugger incident (bad bootstrap state + expired creds + broken remote + drift between `agent.json` and `state/providers.json`) as the primary acceptance signal. Per-condition unit tests for taxonomy / rollup classification logic. Precedent: `src/__tests__/heart/daemon/serpentguide-bootstrap.test.ts`.
- [x] **O7 RESOLVED — Sequential PRs, ordered: layer 1 → layer 4 → layer 2 → layer 3.** Reasoning:
  - Layer 1 (rollup vocabulary fix in `daemon-entry.ts:183-217` + `daemon-health.ts`): establishes the new `healthy/partial/degraded/safe-mode/down` vocabulary that everything inherits.
  - Layer 4 (drift detection, read-only): builds on layer 1's vocabulary to surface drift warnings; mutates nothing.
  - Layer 2 (sync probe wiring `preTurnPull` into `ouro up`): consumes layer 1's vocabulary; first layer that mutates working trees.
  - Layer 3 (RepairGuide bundle + `agentic-repair.ts` loader + `kind: library` exclusion + override-fallback removal): consumes outputs of all three preceding.
- [x] **O8 RESOLVED — Override-path removal scope.** Five files touch `getSpecialistIdentitySourceDir()` or the `~/AgentBundles/SerpentGuide.ouro/` override fallback path:
  - `src/heart/hatch/hatch-specialist.ts` — implementation; primary edit (remove the `userSource` branch).
  - `src/heart/hatch/hatch-flow.ts` — transitive caller; may need update.
  - `src/heart/daemon/cli-defaults.ts` — uses; comment at line 451 references the override; may need update.
  - `src/__tests__/heart/hatch/hatch-specialist.test.ts` — has explicit override-path tests at lines 78-92 (expects override to win when present, falls back when absent). These tests change.
  - `src/__tests__/heart/hatch/hatch-flow.test.ts` — transitive test; uses `~/AgentBundles/SerpentGuide.ouro/` paths in fixtures.
  - Override-removal lands as part of layer 3's PR (groups with the `kind: library` mechanism).

## Decisions Made

(Operator + ouroboros joint sign-off; carried forward as locked. Listed for traceability — do not re-open.)

- **All four layers in scope** (no slicing of layers).
- **Layer 1 is a rollup fix, not a loop redesign.** The per-agent live-check loop in `cli-exec.ts:287` is already try/catch-isolated. The bug is in how its output rolls up.
- **Layer 2 wires `preTurnPull` from `src/heart/sync.ts` into `ouro up`** for bundles with `sync.enabled: true`. Surface-don't-crash on 404 / no-network / dirty / non-FF / conflict. Never touch `state/`.
- **Layer 3 ships `RepairGuide.ouro/` as a library bundle.** Sibling to `SerpentGuide.ouro/`. Loaded as content into `agentic-repair.ts`. NOT a real agent — no senses, vault, providers, sync, or `ouro status` presence.
- **Layer 3a removes the `~/AgentBundles/` override path** in `getSpecialistIdentitySourceDir()`. In-repo is the only source. Applies symmetrically to RepairGuide.
- **Layer 4 uses `EffectiveProviderReadiness.reason: "provider-model-changed"`** for drift detection, comparing `agent.json` intent vs `state/providers.json` observed.
- **Five-state rollup**: `healthy` / `partial` / `degraded` / `safe-mode` / `down`. `degraded` now means *zero enabled agents serving* (not "any agent is unhealthy").
- **Source-of-truth model**: `agent.json` = intent (committed, portable). `state/providers.json` = observed/cache (gitignored, per-machine).
- **Hard timeouts on every external op in `ouro up`** are non-negotiable. Concrete values (O1 LOCKED): git 8s soft / 15s hard, live-check 10s, all wired through `AbortSignal`. Env override knobs available but env is not the design centre.

**Locks added 2026-04-28 19:30 UTC** (operator + ouroboros joint sign-off; resolves the eight open questions):

- **Library-bundle exclusion via explicit kind field (O3 LOCKED).** `agent.json` gains `"kind": "library"`. `agent-discovery.ts` skips library bundles. Applied retroactively to SerpentGuide.ouro; ships native on RepairGuide. Resolves the slugger-shaped semantic overload of `enabled: false`.
- **RepairGuide skill set is FIVE, not four (O2 LOCKED).** `diagnose-sync-blocked.md` is split out from `diagnose-broken-remote.md` so dirty-tree / non-FF / merge-conflict don't junk-drawer with 404 / auth-failed / unreachable.
- **Layer 3 activation threshold = `untypedDegraded.length > 0` OR `typedIssues >= 3` (O4 LOCKED).** No new env knob; existing `--no-repair` flag is the escape hatch.
- **Layer 3 v1 shape: bundle + loader inlined into `agentic-repair.ts` (O5 LOCKED).** Standalone `repair-persona.ts` only if the structured-output validator grows large.
- **Compound integration fixture is the primary acceptance test (O6 LOCKED).** Per-condition unit tests for taxonomy logic. Precedent: `serpentguide-bootstrap.test.ts`.
- **Sequential PRs in order layer 1 → 4 → 2 → 3 (O7 LOCKED).** Each PR is independently reviewable and mergeable. Each subsequent PR depends on prior PRs being merged.
- **Layer 3a (override-path removal) groups into the layer 3 PR (O8 LOCKED).** Five known files touched; explicit test fixture changes documented.

## Context / References

**Existing repair scaffolding**
- `src/heart/daemon/agentic-repair.ts` — one-shot LLM diagnostic call during `ouro up`. Already gated on `discoverWorkingProvider()` and operator opt-in. Output is currently a text blob between `--- AI Diagnosis ---` markers. RepairGuide content rides INTO this pipeline.
- `src/heart/daemon/readiness-repair.ts` — typed `AgentReadinessIssue` / `RepairAction` catalog. Action kinds: `vault-create`, `vault-unlock`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use`. Layer 3 emits through this; no new kinds in v1.
- `src/heart/daemon/interactive-repair.ts` — propose-then-confirm UI surface for repair flows.
- `src/heart/daemon/safe-mode.ts` — crash-loop detection (3 in 5 minutes). Bypass via `ouro up --force`. Becomes the `safe-mode` rollup state.
- `src/heart/daemon/agent-config-check.ts` — `checkAgentConfigWithProviderHealth`: reads `agent.json`, validates provider/model strings, runs live ping. Drift detection (layer 4) hooks in here.

**Per-agent loop and rollup**
- `src/heart/daemon/cli-exec.ts:287` — per-agent live-check loop, already try/catch isolated. NOT the bug site.
- `src/heart/daemon/daemon-entry.ts:183-217` — `recordRecoverableBootstrapFailure` writes into `degradedComponents[]`. The current overloaded rollup reads this and promotes to daemon-wide degraded.
- `src/heart/daemon/daemon-health.ts:30-40` — `DaemonHealthState` already has separated `status`, `degraded[]`, `agents[]` fields. Structure for the new five-state rollup is already there; rename + repopulate.
- `src/heart/daemon/inner-status.ts`, `startup-tui.ts` — consumers of the daemon status string. Update to render new vocabulary.
- `src/heart/daemon/agent-discovery.ts` — `listEnabledBundleAgents`, `listBundleSyncRows`. RepairGuide must not appear in the former.

**Sync surfaces**
- `src/heart/sync.ts` — `preTurnPull` already exists, currently called only from per-turn agent path. Layer 2 wires it into `ouro up`. `PendingSyncRecord` schema (lines 20-25) has `classification: "push_rejected" | "pull_rebase_conflict" | "unknown"` — layer 2 may need to extend this taxonomy (auth-failed, not-found-404, network-down, dirty-working-tree, non-fast-forward, merge-conflict).
- `src/heart/sync.ts:44-63` — `collectRebaseConflictFiles` is a working primitive for conflict-file enumeration.

**Drift signal**
- `src/heart/provider-binding-resolver.ts` — `EffectiveProviderReadiness.reason` enum already includes `provider-model-changed` and `credential-revision-changed`. Layer 4 reads, doesn't invent.
- `normalizeProviderLane` — accepts both legacy `humanFacing`/`agentFacing` and new `outward`/`inner`. Read side must tolerate both; write side emits new names.

**Library bundle precedent (SerpentGuide)**
- `SerpentGuide.ouro/agent.json` — `"enabled": false`, includes `humanFacing`/`agentFacing` provider config (legacy keys), `phrases` and `identityPhrases` blocks. This IS a library bundle today; the operator has confirmed it's the model for RepairGuide.
- `SerpentGuide.ouro/psyche/{SOUL.md, identities/}` — current shape. RepairGuide adds `skills/` (which SerpentGuide doesn't have).
- `src/heart/hatch/hatch-specialist.ts:21-31` — `getSpecialistIdentitySourceDir()` and `getRepoSpecialistIdentitiesDir()`. Layer 3a removes the `userSource` (homedir) branch from `getSpecialistIdentitySourceDir`.
- `src/__tests__/heart/daemon/serpentguide-bootstrap.test.ts` — precedent for bundle-bootstrap tests; pattern for the slugger fixture.

**Existing flags and escape hatches**
- `--no-repair` — skips repair. RepairGuide must honor this.
- `--force` — bypasses safe-mode crash-loop check. RepairGuide ignores; `--force` is about crash-loop, not repair.

**Architecture rules**
- `state/` is gitignored, per-machine runtime cache. Never touched by sync. `agent.json` is committed intent.
- Repo-root `skills/` is shared across all agents (per `ARCHITECTURE.md:337-338`). Bundle-local `skills/` is agent-specific. RepairGuide's `skills/` is bundle-local.

## Notes

**Per-machine adoption boundary.** Layer 4 drift detection is the only place we read `state/providers.json` cross-bundle during `ouro up`. The proposed repair (`ouro use --agent X --lane Y --provider Z --model M`) intentionally writes through the existing CLI surface — no direct write to `state/` from new code. This preserves the source-of-truth model.

**Why RepairGuide content load is into `agentic-repair.ts`, not parallel.** The chicken-and-egg is already solved there: when provider config IS the failure, `discoverWorkingProvider()` finds a working provider for the diagnostic call. Loading RepairGuide content into a fresh pipeline would re-invent that solution, badly. The minimal change is "agentic-repair.ts reads RepairGuide.ouro/{psyche,skills}/*.md as system-prompt-shaped content before its existing LLM call."

**Why not v2 (real agent bundle) now.** A real agent bundle gets vault, providers, sync, identity, daemon presence, drift risk, and a slot in `degraded[]` — all things the operator does NOT want for repair-time content. The library-bundle shape is the right shape because it lets us ship `psyche/` + `skills/` content WITH the repo (visible in PR diffs, version-controlled) without paying the agent-runtime tax.

**Recursion base case (RepairGuide self-failure).** Because RepairGuide is a library bundle (not an agent), it can't fail in the agent-runtime sense. It can only fail in two ways: (a) markdown content malformed/missing (graceful: agentic-repair.ts uses today's text-blob fallback); (b) the LLM call itself fails (graceful: `discoverWorkingProvider` already handles this and the typed-action repair fires anyway). No new recursion handling needed.

**Lane rename in flight.** `humanFacing`/`agentFacing` → `outward`/`inner`. Layer 4 read side must tolerate both. Write side (the `ouro use` command we propose, not new write code) already emits new names.

**Slugger fixture as the canonical regression guard.** The compound case is the test that proves the four layers compose correctly. Per-condition unit tests are useful but the integration fixture is the operative acceptance signal.

**Slugger as the artifact we're protecting against.** The bundle has all three drift surfaces simultaneously (intent, observed binding, vault revision). Layer 4 detects the intent-vs-observed gap. Vault revision drift is already detected (`credential-revision-changed`). Sync can't fix `state/` drift — that's by design.

## Progress Log

- 2026-04-28 19:14 UTC Created from ideation handoff (locked decisions + 8 open questions surfaced)
- 2026-04-28 19:30 UTC All 8 open questions RESOLVED (joint operator + ouroboros sign-off). Status moved drafting → NEEDS_REVIEW. Locks integrated into Scope (Layer 2 timeouts, Layer 3 kind:library mechanism + bundle contents + activation contract + v1 shape) and Decisions Made (eight new locks). Test strategy + PR shape + override-path removal scope all settled.
