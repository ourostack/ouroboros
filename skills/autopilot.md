# Autopilot — long-running agent loop discipline

Operating doctrine for long-horizon work where the operator hands you a multi-track, multi-PR mandate and expects you to drive — spawn subagents, scan for next-spawnable work between operator messages, encode lessons as durable rules, and ship synchronously rather than parking work as TODOs.

## When to Use Autopilot

Activate when the operator explicitly signals long-horizon delegation:

- "autopilot"
- "you got this"
- "treat all as pending, implement as you see fit"
- "make X autopilot"
- "keep the ship moving"
- "want nothing pending by the time you're done"

Once activated, autopilot stays in effect across operator silences and scheduled wakeups. Between operator messages you are ALWAYS either spawning new work, scheduled to scan-and-spawn shortly, or reporting a true blocker. Never "waiting silently."

Deactivate when the operator signals completion, hands a different scope explicitly, or names a state requiring a different mode (e.g., "review carefully before each merge").

## When NOT to Use

- Single-PR work where the operator wants careful review per change.
- The operator hasn't given explicit autopilot phrasing — ambient enthusiasm is not authorization.
- Tasks that require architectural decisions on the operator's behalf — those still surface.
- Operator-voice posts, irreversible production destruction, or cross-team coordination — autopilot does NOT bypass the usual gates for those.
- The operator's review queue would saturate (50+ merged PRs in 24h is a warning sign — slow down).

## Operating loop

Shape: scan, spawn, schedule, repeat. Run on every wake event — subagent completion, scheduled wake, operator message, your own tool-call return.

1. **Snapshot fleet state.** In-flight subagents (by task ID), recently-merged PRs, current task list, in-flight workflow runs.
2. **For each pending item in the plan**: is it now unblocked? File conflicts cleared? Data dependencies emitted? Credentials available?
3. **For every newly-unblocked item: spawn the implementer immediately.** Don't wait for the next operator prompt — the bundle plan was the authorization.
4. **If nothing's spawnable right now**: check if anything's *about to be*. If a bundle's completion is imminent (minutes away), pre-draft the next bundle's prompt so it spawns the moment the upstream merges.
5. **If genuinely nothing to do**: schedule the next wake. Cadence is short during active fleet (5–15 min), longer when monitoring. The wake prompt is "scan-and-spawn pass," not a bespoke per-bundle check.

The same wake prompt fires every time; you re-run the scan each turn. No bespoke wake-prompt drift.

## Surface only for

Conditions that justify breaking the loop and waiting:

- A decision genuinely requiring operator-only judgment (compliance, naming, scope shift).
- A credential / scope / human-only capability missing — and no parallel work to spawn alongside the wait.
- Irreversible production destruction with no rollback path.
- Operator-stated done-criteria is met — the work is FINISHED.

Otherwise: keep going. Operator silence is approval to keep maximizing parallel work.

## Durable rules

### R1 — Implement, don't preserve placeholders

"Pending" / "TODO" / "coming soon" stubs in operator-facing surfaces (dashboards, aggregators, runbooks) are technical debt that compounds. When you have authority to fix end-to-end under autopilot, the default is to IMPLEMENT the missing feature — project the data, render the UI, ship the PR — not to standardize the stub framing. Stubs are only acceptable when the implementation genuinely requires operator-level architectural decision OR external credentials. Otherwise: ship the feature. "Nothing pending" is the bar.

### R2 — Every change carries a verification artifact

The PR-merge alone is not proof-of-done. Each change pairs with a verification artifact appropriate to its shape:

- **Source-code fix** → PR merged + CI green + a snapshot or probe of the new state, attached to the PR description.
- **Scheduled job / background task** → state probe showing fresh `LastRunTime` + success exit + artifact on disk + downstream consumer reads it.
- **Dashboard render** → screenshot of the new component with real data.
- **Removal** → snapshot confirms absence + no broken cross-references.
- **Policy change** → at least one real PR exercises the new policy and lands.

The verification artifact is the proof-of-done. If you can't name one, the unit is not complete.

### R3 — Task tracking for bundle-level orchestration, planning doc for per-item state

When work spans 10+ items, track BUNDLES (10–15 top-level units) at the harness's task-list level, not individual items. Per-item state lives in a planning doc. This lets the operator scan progress at a glance and keeps the task list signal-dense.

### R4 — Belt-and-suspenders deploy: two disjoint-path writers to one branch

When a deployment surface has two production paths (e.g., CI-driven build + manual sidecar push), don't pick one and discard the other. Use BOTH, writing to disjoint paths in the shared branch so no race condition exists. Manual sidecar updates stay independent of CI-driven bundle rebuilds; both eventually consistent against the served state.

### R5 — Self-modify the skill as patterns emerge

When dogfooding autopilot produces a generalization not yet captured here, EDIT THIS SKILL FILE IN THE SAME SESSION. Don't journal "skill should be updated" in a TODO; the skill-improvement is part of the work. Each refinement makes the next autopilot session stronger.

### R6 — Concurrent subagents work in isolated git worktrees

When multiple implementer subagents run in parallel against the same repo, they MUST use `git worktree add` to operate in an isolated working directory. Otherwise `git stash` / `git checkout` collisions across subagents produce conflicts on files that neither subagent intentionally edited. Worktree-isolation prevents this entirely.

Pattern:

```bash
WT=/tmp/<task>-<bundle-name>-$(date +%s)
git worktree add -b feat/<branch-name> "$WT"
cd "$WT"
# ... edits, commits, push, PR, merge ...
cd "$ORIG_DIR"
git worktree remove --force "$WT"
```

The spawn-prompt for implementer subagents MUST instruct: *"Operate in `git worktree add /tmp/<task>-<your-name>-<ts> -b <branch>`. Never edit in the shared checkout directly. Cleanup worktree at end."* Every git command in the subagent's session takes `git -C <worktree-absolute-path>`.

### R7 — Self-review subagent: spawn if Agent tool available; inline cold-read is the fallback

A PR should be reviewed by an independent reviewer before merge. The implementer's toolbelt may not always have the Agent / sub-task tool surfaced. Acceptable fallback: inline cold-read with a fixed-shape verdict (`APPROVE_MERGE` / `NEEDS_CHANGES` / `REJECT`) and the same checklist (scope-matches-diagnosis, drive-bys, CI green, mergeable, cross-PR conflicts).

When spawning an implementer subagent that should self-review, include in the prompt:

> "Spawn an independent self-review subagent. If the spawn tool isn't in your toolbelt, first try to surface it via the harness's deferred-tool mechanism. If still unavailable, fall back to inline structured cold-read with the same verdict shape — note in the report that the spawn degraded to inline review."

Inline review with structure is much better than no review at all.

### R8 — Split a bundle into ship-now and ship-after-X parts when one half is independent

When a bundle touches both NEW files (additions) and MODIFICATIONS to files another in-flight bundle owns, split into Part 1 (new-file additions, ships parallel to the conflicting work) and Part 2 (modifications, ships after). Part 1 commits + merges normally; Part 2 is queued until the upstream conflict clears, then sequenced as a follow-up PR. Cost: one extra PR. Benefit: the critical path stays uncongested.

### R9 — Implementer prompts state concrete dependency status, not just "depends on X"

When prompting an implementer subagent with in-flight dependencies, name the dependency's current state explicitly: *"A sibling implementer is in flight on file X; if you encounter conflicts, treat as expected — work around or wait. Its expected output is field Y in slice Z; for now, read with `?? null` defensive default."* Subagents shouldn't have to investigate concurrent state; pre-load the awareness in the prompt.

### R10 — Be the loop driver, not the loop respondent

The failure mode this prevents: operator pings *"what more can we do?"* repeatedly because you wait for next-prompt instead of self-driving. Autopilot's whole promise is operating without input.

Concrete commitment: between operator messages, you are ALWAYS either:

- (a) actively spawning new work,
- (b) scheduled to scan-and-spawn within 15 min, or
- (c) reporting a true blocker.

Never "waiting silently."

Scheduled wake prompts reflect the loop, not bespoke per-bundle checks:

- Don't: *"check Bundle B progress + iter completion"*
- Do: *"scan-and-spawn pass: check for newly-merged PRs (chain into next bundle), in-flight subagent completions, unblock any pending implementers, then schedule next scan"*

### R11 — When a diagnosis-based fix fails, the diagnosis was wrong

Failure mode: you diagnose problem X, ship fix-for-X, fix fails, ship variant-of-fix-for-X, fails, ship variant-2, fails — when the actual problem is Y, not X.

After the FIRST fix-based-on-diagnosis fails, stop iterating on the diagnosis. Investigate the actual environment state: disk usage, free space, raw log inspection, runner image identification, process tree, network, OS version, package versions. The right answer is often NOT the original theory's variant; it's a different problem entirely.

Practical checklist when a diagnosis-based fix fails:

1. Confirm the fix actually deployed and ran (vs. silently rolled back).
2. Re-read the failing log/output with fresh eyes — assume the diagnosis was wrong.
3. Probe the environment empirically.
4. Look for evidence that contradicts the original theory.
5. Spawn an investigation subagent if needed — it has fresh eyes.

Don't ship variant-N until the diagnosis is independently re-confirmed.

### R12 — Spawn flagged cleanups in the same scan-and-spawn pass

When a subagent flags a "pre-existing bug out of scope" in its return report, spawn the cleanup subagent IMMEDIATELY — same scan-and-spawn pass, not a future-session TODO. The bug stays open across sessions otherwise; the breadcrumb gets lost between operator turns.

Practical encoding:

- Every subagent prompt includes a "list drive-bys you found but resisted" section in the return report.
- Your scan-and-spawn pass treats those drive-bys as first-class spawn candidates.
- Threshold for spawn-now vs defer: if the cleanup is well-scoped (single file, single concept) and the operator is in autopilot mode, spawn now. Cost: one parallel subagent. Benefit: the bug doesn't survive the session.

## Recognized patterns

Shapes autopilot catches in autonomous operation. Each pattern names the wrong default and the right move.

| # | Shape | Wrong | Right |
|---|-------|-------|-------|
| 1 | External dependency in critical path is slow / unreachable | Kill the agent, write it up | Probe with short timeout; on failure skip the affected step but preserve productive work; mark "backfill needed"; ship the source patch that adds the probe-and-skip path |
| 2 | CI / deploy workflow wedged, backlog accumulating | Note it; queue as action item | Ship the smallest fix that unblocks (pin a label, rebuild a cache, fork the runner choice). The queue unblocks itself |
| 3 | Source script has a parser bug exposed only by a runtime version on the deployed env | Hot-patch the deployed file; record the gotcha | Hot-patch + source PR; the source has to match the deployed runtime |
| 4 | Global default doesn't fit a specific job | Override per-run; bump the override every time | PR a per-job / per-agent config override so the default fits the actual cost |
| 5 | Verifier misclassifies an intentional state as failure (idle when nothing-to-do, in-progress when cleanup pending, skipped when downstream unreachable) | Stop the "failing" task; accept the misclassification | PR the honor-path. The agent did the right thing; the verifier should recognize it |
| 6 | Setup / bootstrap script references a dependency that no longer exists | Route around it; note "future setup should…" | Source PR removing the dead reference; next setup just works |
| 7 | Setup script hangs on an interactive prompt in a non-interactive environment (package-provider trust, certificate trust, EULA accept) | Pre-install / pre-trust via recovery script per machine | Source PR adding the non-interactive equivalent BEFORE the prompting step. Bootstrap should be non-interactive end-to-end |
| 8 | A communication channel (post / notify / DM) fails silently | Zero successful posts for the session, recorded as one action item | Probe-and-skip pattern + local archive of generated payloads for replay. A 0/N poster for a full session needs a fallback surface or a loud-fail |
| 9 | An external tool eats time on the critical path (first-scan, cache-warming, license check) | Endure it. "This is how it is." | Probe the tool's exclusion / cache / config; propose an addition. "It's slow" is a fixable property |
| 10 | A long-running operation hangs after writing its real artifact | Kill the agent; verifier marks the iter as failed | Investigate the post-artifact path; add a hard timeout; make the cleanup pure. The artifact landed cleanly — the cleanup should not lose that signal |

Pattern across all of them: diagnosis was tractable; fix was a contained change; default was to write it down; right behavior was to ship it.

**If autopilot works, an autonomous session produces a list of merged PRs, not a list of action items.**

## Composing with other skills

Several rules above call for specialized skills the agent may have available:

- A **diagnosis skill** — when R11 says "re-investigate the actual environment," that's a narrow-the-hypothesis-space discipline that benefits from a dedicated investigation skill if you have one.
- A **self-review skill** — R7's structured cold-read verdict shape composes with any operator-triggered convergence-pass review skill you have.
- An **irreversible-action gate skill** — autopilot's "ship synchronously" doctrine applies to mergeable PRs, NOT to operator-voice posts or production-destructive ops. Those still route through the usual preflight gate.
- An **operator-voice authoring skill** — any draft you compose in the operator's voice still routes through voice review; autopilot doesn't bypass it.
- A **friction / lessons-capture surface** — the long-tail post-fix capture surface for lessons that aren't yet skill-shaped. Pairs with R5's "self-modify the skill" doctrine for entries that are skill-shaped.

If those skills don't exist in your environment, inline the same discipline — structured cold-read, named verification artifact, explicit irreversible-action confirmation gate.

## Source

Distilled from extended-session autopilot work where the operating doctrine was incrementally encoded across multi-PR shipping cycles. The original session-specific draft is the operator's working notebook; this distillation is the durable subset — generic across long-running coding agents, with session-specific evidence (PR numbers, bundle names, dates) deliberately omitted.
