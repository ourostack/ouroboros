# Ideation: Four-Layer Hardening of the Daemon Agent-Loading Path

Status: ideation handoff for `work-planner`. Not a planning doc.
Author: work-ideator
Date: 2026-04-28 (UTC 18:30)
Working directory: `/Users/microsoft/code/ouroboros`

---

## Spark

The operator runs multiple ouroboros agents on one harness. Today a single bad agent (slugger, with a nonsensical bootstrap binding, expired creds, broken remote, and uncommitted local edits) tipped the entire daemon into degraded state during `ouro up`. The desired felt experience: when one agent is sick, the harness keeps a clear head, names what's wrong on that agent, and offers a competent local helper that knows how to read a bundle's diagnostics and propose repairs — without the operator becoming the integration runtime.

Constraint language to preserve: "degraded-on-that-agent, healthy-elsewhere"; "permanent sibling, not ephemeral hatch"; "propose-then-confirm"; "doesn't fix only the visible bug."

---

## Observed Terrain

Source-grounded findings from the actual repo, not memory.

### Existing repair scaffolding (load-bearing)

- `src/heart/daemon/agentic-repair.ts` (300 lines) — already runs a one-shot diagnostic LLM call against degraded agents during `ouro up`, gated on `discoverWorkingProvider()` succeeding and the operator answering "y" to "would you like AI-assisted diagnosis?" Output is plain text printed between `--- AI Diagnosis ---` markers. Not a chat loop, no tools, no follow-through.
- `src/heart/daemon/interactive-repair.ts` (479 lines) — deterministic repair flow. Detects `vault-unlock`, `provider-auth`, and `config-error` patterns from `errorReason` + `fixHint` and prompts `runAuthFlow` / `runVaultUnlock`.
- `src/heart/daemon/readiness-repair.ts` (486 lines) — typed issue catalog: `vault-unconfigured`, `vault-locked`, `provider-credentials-missing`, `provider-live-check-failed`, `generic`. Each issue carries `RepairAction[]` with kinds `vault-create`, `vault-unlock`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use`. This is the typed-action registry — sibling agent should emit through this surface, not invent its own.
- `src/heart/daemon/agent-config-check.ts` (613 lines) — `checkAgentConfigWithProviderHealth`: reads `agent.json`, validates provider/model strings, runs a live ping. This is where layer-1 isolation lives or fails.
- `src/heart/daemon/cli-exec.ts` line 6680ff — the `ouro up` end-of-startup wiring: splits degraded into `typedDegraded` (known issue kinds → `runReadinessRepairForDegraded`) and `untypedDegraded` (→ `runAgenticRepair`). Already a per-agent loop at line 287.
- `src/heart/daemon/safe-mode.ts` (151 lines) — crash-loop detection: 3 crashes in 5 minutes → safe mode. Bypassed by `ouro up --force`. This already exists at the harness scope.

### Sync surfaces

- `src/heart/sync.ts` (346 lines) — `preTurnPull(agentRoot, config)` and `postTurnPush(agentRoot, config)`. Has classification (`push_rejected`, `pull_rebase_conflict`, `unknown`), conflict-file detection, and writes `state/pending-sync.json` on irrecoverable failures. **`preTurnPull` is wired into the per-turn agent path but is NOT called from `ouro up`.** Confirmed: `grep "preTurnPull" src/heart/daemon/cli-exec.ts` returns nothing. Layer 2 is a genuine new wiring, not just exposing existing code.
- `src/heart/daemon/agent-discovery.ts` `listBundleSyncRows()` already reads each bundle's `sync.enabled`, `sync.remote`, `gitInitialized`, `remoteUrl`. Layer 2 has its enumeration primitive ready.

### Drift detection signal

- `src/heart/provider-binding-resolver.ts` `EffectiveProviderReadiness.reason` already enumerates `provider-model-changed` and `credential-revision-changed`. The drift-vs-state mismatch slugger exhibits (`agent.json humanFacing: openai-codex/gpt-5.4` vs `state/providers.json outward: openai-codex/claude-sonnet-4.6`) is exactly the case `provider-model-changed` was built to flag. Layer 4 is reading an existing signal and surfacing it to a repair offer, not inventing detection.
- The legacy lane rename (`humanFacing`/`agentFacing` → `outward`/`inner`) is still in flight. `normalizeProviderLane` accepts both. Drift detection MUST tolerate both names on the read side and emit the new names on the write side.

### Bundle structure for the sibling

- `SerpentGuide.ouro/` ships with the repo: `agent.json` (`enabled: false`, opus/opus default), `psyche/SOUL.md`, `psyche/identities/<persona>.md` × 13 personas. **No `skills/` directory.** It's a template/identity bundle, not a working agent.
- `~/AgentBundles/slugger.ouro/` (the operator's working agent) shows what a real bundle looks like: `psyche/{SOUL,IDENTITY,LORE,TACIT,ASPIRATIONS}.md`, `skills/<13 markdown files>`, `state/`, `vault/`, `inbox/`, `arc/`, `bundle-meta.json`. `state/` and `inbox/` are gitignored by design (per-machine).
- Per `ARCHITECTURE.md` lines 337-338: "Agent skills: `~/AgentBundles/<agent>.ouro/skills/` — specific to one agent. Harness skills: `skills/` at the repo root — shipped with every installation, available to all agents." There's a precedent for repo-root-shipped skills as a separate tier.

### Where the per-agent isolation gap is

`src/heart/daemon/cli-exec.ts` line 287:
```ts
for (const agent of [...new Set(agents)]) {
  try {
    const result = await checkAgentProviderHealth(agent, ...)
    if (result.ok) continue
    ... // appends to degraded[]
  } catch (error) {
    ... // appends to degraded[] with generic fix hint
  }
}
```
This loop already isolates `checkAgentProviderHealth` per-agent. So layer-1 isolation is **partly already present at the live-check layer**. The hole is downstream: `daemonResult.stability?.degraded` flows into a single `runAgenticRepair`/`runReadinessRepairForDegraded` call, and the daemon process itself signals "degraded" at the harness scope rather than per-agent. The visible-bug claim "the entire daemon went degraded" likely traces to the operator-facing rollup (`startup-tui.ts`, `inner-status.ts`) treating any degraded agent as a degraded daemon. Need the planning doc to verify this with the operator before scoping layer 1.

---

## Surviving Shape

A four-layer defense, in this dependency order:

```
[Layer 1: per-agent isolation]    catches throws/sync errors at agent scope
        ↓
[Layer 2: sync probe in `ouro up`]  enriches degraded[] with sync diagnostics
        ↓
[Layer 4: drift detection]          enriches degraded[] with intent-vs-state mismatch
        ↓
[Layer 3: sibling repair agent]     consumes the degraded[] surface, proposes fixes
```

Layers 1, 2, 4 expand the *information* the daemon emits about each agent's state. Layer 3 is the *consumer* of that information — it doesn't replace the existing typed-action repair (which handles known kinds locally and fast); it replaces and upgrades the `runAgenticRepair` LLM-diagnosis-blob fallback for the long tail of unmechanical, multi-cause failures.

Why this isn't theater: the typed-action catalog (`readiness-repair.ts`) already covers the easy cases (auth, vault, retry, use). The sibling exists to handle the messy compound cases — slugger today is a textbook example: bad bootstrap + expired cred + 404 remote + dirty tree, four findings that each have a different action kind. The current `runAgenticRepair` produces a paragraph; the sibling produces a structured action proposal the operator confirms one click at a time.

---

## Scrutiny Notes

### Tinfoil Hat: what's missing from the obvious design?

1. **The per-agent isolation hole isn't the live-check loop — it's the rollup.** Verified: `cli-exec.ts:287` already wraps each `checkAgentProviderHealth` in try/catch. The "single bad agent kills the harness" symptom must come from how `daemonResult.stability.degraded` is rendered in startup TUI / health, OR from a downstream phase (post-repair, agent process spawn) that doesn't tolerate one bad bundle. Layer 1 may not be a code change in the live-check loop — it may be a fix in `inner-status.ts` / `daemon-health.ts` / `startup-tui.ts`. **The planning doc must reproduce the bug before scoping the fix**, not assume the loop is wrong.

2. **Sync probe must run before live-check, but live-check determines the binding being used.** The legacy-vs-new lane field rename means `agent.json` could pull a remote that rewrites the `humanFacing`/`agentFacing` fields, which the live check then reads. A pull mid-startup that resolves drift could also introduce drift. Order matters: sync first, then drift detect against the post-pull tree, then live-check.

3. **`state/` is gitignored — but the slugger shows that the bug is in `state/providers.json`, which is per-machine and never pulled.** Sync cannot fix slugger's actual problem. Layer 2 fixes a different class (broken remote, dirty tree, non-FF, conflict). The planning doc must avoid implying sync solves bootstrap drift — it cannot.

4. **What if the sibling itself is in `degraded[]`?** The repair agent is a bundle. It has `agent.json`, providers, vault, sync. If it's broken, who repairs the repairer? Need a bootstrap rule: the sibling NEVER appears in its own degraded list; if its own live-check fails, it falls back to `runAgenticRepair`'s current behavior (single-shot diagnostic call) using the harness-discovered working provider. This is the recursion-base-case.

5. **A 404 remote on slugger is permanent until the operator changes the URL.** The repair agent must not propose `git remote set-url` blindly — it doesn't know what the right URL is. It must either ask the operator or propose disabling sync (`sync.enabled: false`). The "destructive surface" of the sibling is real and the design must constrain it.

6. **Three-way conflict between intended (agent.json), bound (state/providers.json), and live (credential vault) is the real shape.** Not two-way drift. The slugger has all three out of sync: agent.json says `gpt-5.4`, state says `claude-sonnet-4.6`, vault has an expired token for whichever provider was last used. Layer 4 needs to be three-way, not two-way, or it'll heal one mismatch and leave another.

7. **`ouro up --force` already bypasses safe-mode.** A confused operator who hits `--force` to skip a degraded boot will skip the sibling's offer too. Need to decide: does sibling activation respect `--force`, or is it a separate axis (`--no-repair` already exists)? Recommend: sibling honors `--no-repair` (existing flag, semantically right), ignores `--force` (which is about crash loop, not repair).

8. **The bundle remote might be `https://github.com/arimendelow/slugger.ouro.git` returning 404 because the repo is private and `gh auth` lapsed, not because it's deleted.** Layer 2's "404" classification must distinguish auth failure from genuine 404. `git ls-remote` exit codes: 128 = auth or DNS, plus stderr parse for "not found" / "could not read from remote" / "Permission denied". The current `sync.ts` doesn't classify; layer 2 needs a new classification taxonomy.

### Stranger With Candy: what looks correct but is wrong?

1. **"Sibling repair agent" — the word `agent`.** In ouroboros, `agent` means a bundle with identity, vault, providers, daemon presence. If the sibling is a real `.ouro` bundle that participates in `listEnabledBundleAgents`, it shows up in `ouro status`, has its own provider drift risk, can fail its own live-check, and increases `degraded[]` cardinality on every boot. It also has a `psyche/` directory implying continuous identity. **Is that what the operator wants?** Or is it a *helper persona*, loaded only when invoked, with a fixed system prompt and a tool kit, that uses the harness's discovered working provider? The latter is much closer to what `agentic-repair.ts` already does, just with structure. The word "sibling" implies the former, but the architectural fit is closer to the latter. **This is a real ambiguity the operator must resolve at planning time.** See Open Questions.

2. **"Live-check" failure as a sibling activation trigger.** Live-check failures are mostly already handled: expired creds → `provider-auth` action; live-check failed → `provider-retry` action. The sibling shouldn't take these — they're solved. The sibling should activate when (a) the typed-action repair declines to handle (`untypedDegraded`), OR (b) multiple typed actions stack on one agent and the operator wants advice on order, OR (c) sync diagnostics surface unmechanical issues (404 remote, conflicts).

3. **"Skill kit" framing.** The slugger bundle has 13 skill markdown files for *what slugger does for users*. The repair agent's skills aren't "how to write code" or "how to plan trips" — they're *recipes* for repair flows: "diagnose-bootstrap-drift.md", "diagnose-broken-remote.md", "diagnose-vault-expired.md". This is a different use of `skills/` than slugger's. Possibly closer to harness-level `skills/` at repo root than per-bundle. **The planning doc should pick a skill location: bundle-local `skills/` (portable, shipped) or harness-level `skills/` (already shipped, accessible to any agent).** Recommend bundle-local — it keeps the repair agent self-contained and shipped together.

4. **"Tools" for the sibling: bash, git, file-write, ouro-cli.** This is a footgun. A repair agent with `bash` and `git` and write access can do anything. The right primitive is a closed allowlist of *named repair actions*, not raw tools. The action catalog already exists in `readiness-repair.ts` (`RepairAction` types). The sibling proposes from this catalog plus a small extension set; never raw shell. v1 should not give it `bash`. v2 maybe.

5. **"Auto-apply vs propose-then-confirm".** The current `interactive-repair.ts` already uses propose-then-confirm (prompts "y/n" before each repair). The sibling must not regress on that. Default propose-only; auto-apply behind an explicit flag (`ouro up --auto-repair`?) and never for destructive kinds (`vault-replace`, `git remote set-url`).

6. **Where the sibling lives in the repo: "next to `SerpentGuide.ouro/`".** SerpentGuide is `enabled: false` template with no skills. If the sibling lives next to it as `Mender.ouro/` (or whatever name), is it `enabled: true` and self-bootstrapping? Or is it `enabled: false` and only "summoned" by the daemon when degraded? The latter is closer to "doesn't show up in ouro status as a peer," which is probably what the operator wants. Recommend: the sibling bundle is `enabled: false` to the harness lister, but the daemon has a hardcoded path to it for repair-mode dispatch. It's a *system bundle*, not a user agent.

### Failure modes that gang up

The slugger incident is three bugs compounded. Other realistic gangs:

- **Sync conflict + drift on the same file.** Operator edits `agent.json` locally, remote also changes it, pull rebase fails with `agent.json` unmerged. Now the bundle has both pending sync conflict AND undefined intended state. Repair must order: resolve git conflict first (or abort rebase), then re-read `agent.json`, then check drift.
- **Vault unlock + credential expiry on the same agent.** Operator's vault has been locked since boot AND the credentials inside are expired. Unlocking succeeds; live-check still fails. Need to chain: vault-unlock → re-check → provider-auth → re-check.
- **One agent's broken state poisons another agent's start-of-turn.** Today this doesn't happen (per-agent isolation in the live-check loop), but if a future shared resource (the repair agent itself, or a shared MCP server, or the credential vault) fails for one agent, it could affect peers. Layer 1 must define the isolation boundary explicitly (today it's "per-agent live-check"; needs to be "per-agent live-check AND per-agent sync AND per-agent process-spawn AND per-agent rollup-rendering").
- **Daemon crash during repair.** Sibling proposes `vault-unlock`, vault-unlock prompt blocks on tty, daemon receives shutdown signal, sibling's proposed-but-unapplied repair is lost. Need: the sibling's proposals are journaled to `~/.agentstate/daemon/repair-queue.json` so a re-`ouro up` can resume.
- **Sibling proposes a fix the operator already declined last boot.** Need a "declined repairs" memory so the operator isn't asked the same question every boot. The slugger's 404 remote is the obvious case — operator said no once, don't ask 100 times.
- **Sibling's own provider has drift / expired creds.** Recursion base case (#4 above). Sibling falls back to harness's `discoverWorkingProvider` rather than its own bound provider.
- **Two agents both broken with overlapping issue kinds.** Repair UI must batch sensibly: "3 agents need vault unlock — unlock all? [y/n/each]" rather than 3 separate prompts.

### Risks of the sibling itself

- **Destructive tool surface.** v1 tool allowlist: `read agent.json`, `read state/providers.json`, `read state/pending-sync.json`, `read agent.json sync.remote`, `git status`, `git ls-remote`, `git log -1`, `propose-repair-action(kind, params)`. NO writes, NO `git push/pull/reset`, NO file edits, NO shell. v2 may add `git fetch` (read-only on remote).
- **Auto-apply.** Default OFF. Even with a future `--auto-repair` flag, never auto-apply: `vault-replace`, `vault-recover`, any `git remote` mutation, any `agent.json` write that changes provider/model.
- **Misbehavior containment.** Sibling has a strict turn budget (1 LLM call for diagnosis, plus 1 follow-up for clarification = 2 total per `ouro up`). No tool loop. If sibling output is unparseable, fall back to printing it as a diagnosis blob (current `runAgenticRepair` behavior — graceful degradation).
- **Cost.** Each `ouro up` with degraded agents triggers an LLM call. Today `runAgenticRepair` already does this and the operator hasn't complained, but the sibling adds structure that may grow it. Cap: skip sibling if all degraded agents are typed-known (`isKnownReadinessIssue` returns true) AND the typed-action repair handled them.

### Naming

The sibling's name needs to fit the SerpentGuide / serpent-themed bundle vocabulary, signal *repair / diagnose / not autonomous*, and not be confused with operator-named user agents.

Candidates with reasoning:

1. **`Mender.ouro`** — direct, English-named, signals the function unambiguously. "Mender" suggests darning, patching, low-drama. Pairs well with `SerpentGuide` (both are role nouns). Risk: too plain, doesn't fit the repo's mythological-serpent palette.

2. **`Aesculapius.ouro`** — the Greek god of medicine, traditionally depicted with a serpent-entwined staff (literally the snake of healing). Fits the serpent palette, signals diagnostic/repair, and the staff-of-asclepius is the medical symbol. Risk: long, hard to spell, operator might shorten to `aesculapius` or `asclepius` and the slug-vs-pretty-name will diverge.

3. **`Shedder.ouro`** — serpents shed broken skin. Fits the palette. Signals "remove what's broken, regrow underneath" without claiming repair. Short, memorable. Risk: slightly negative connotation ("shedding" something).

Recommendation for the planning doc to put to the operator: **`Mender`** for clarity (the operator cares about names but also about not having to explain them in a year), with `Aesculapius` as the mythological-flavor alternative if the operator wants to maintain the serpent-theme purity. Avoid `Shedder` — it implies destruction, which conflicts with the propose-then-confirm constraint.

A fourth candidate to surface for the operator: **don't name it like a peer agent at all.** Call it `__repairer/` or `system/repairer.ouro/` and make it visibly a system component, not a sibling. This pushes hard on the "is it really an agent?" Stranger-With-Candy finding from above. The planning doc should ask the operator which framing they want.

---

## Thin Slice

The smallest first cut that delivers honest value:

**Layers 1, 2, 4: mechanical wiring**
1. Reproduce the slugger incident in a test fixture: bundle with bootstrap drift + expired creds + 404 remote + dirty tree.
2. Trace where the per-agent failure becomes a daemon-scope degraded signal. Fix the rollup so degraded count is per-agent and the daemon's overall state is "healthy with N agents degraded" not "degraded".
3. Add a `preUpFetch(agentRoot, syncConfig)` to `src/heart/sync.ts` that runs `git fetch` + `git pull --ff-only`, classifies failures (`auth-failed`, `not-found-404`, `network-down`, `dirty-working-tree`, `non-fast-forward`, `merge-conflict`), and writes results to `state/pending-sync.json` (re-using the existing schema's `classification` field with new variants, OR adding a parallel `state/pre-up-sync.json` file — planning doc decides).
4. Wire `preUpFetch` into `cli-exec.ts` `checkAgentProviders` loop — fetch first, then live-check, both per-agent isolated.
5. Extend `EffectiveProviderReadiness.reason` consumption: when the resolver returns `provider-model-changed`, surface as a new `AgentReadinessIssue` kind `intent-state-drift` with a `provider-use` action (one-line repair already exists).

**Layer 3 v1: structured-proposal repair persona (NOT a peer agent)**
1. Ship a single new file in the repo: `src/heart/daemon/repair-persona.ts`. It is NOT a `.ouro` bundle. It is a structured prompt + parsing layer that wraps the existing `runAgenticRepair`'s LLM call.
2. Input: `degraded[]` enriched with sync + drift diagnostics (from layers 1, 2, 4).
3. Tool surface: zero tools. The persona's job is to produce structured output of the form `{ proposals: [{ agent, issueKind, action: RepairAction, rationale }] }`. The harness validates each proposed `RepairAction` against the existing typed catalog; unknown kinds are dropped with a warning.
4. UI: existing propose-then-confirm flow consumes proposals and prompts the operator one at a time.
5. Skills/persona content lives at `src/heart/daemon/repair-persona-prompt.md` (or equivalent) — checked into the repo, visible in PR diffs, not bundled.
6. Fallback: if the model returns unparseable JSON, fall back to current `runAgenticRepair` text-blob behavior. No regression.
7. Provider: re-use `discoverWorkingProvider` (already exists) — solves the recursion base case for free.

**Layer 3 v2 path (NOT in MVP, called out for the operator):**
- Promote the persona to a real `.ouro` bundle (`Mender.ouro/` or chosen name) with `psyche/`, `skills/`, its own provider binding (which fails over to harness discovery), and its own sync. Only worth doing if the operator wants the repair persona to be cross-machine portable, have memory across boots, or be skinnable per-operator. Not load-bearing for the slugger fix.

---

## Non-Goals

- Auto-applying any repair. v1 is propose-then-confirm only; `--auto-repair` is a separate later question.
- Healing 404 remotes by guessing a new URL. The persona surfaces the broken remote and proposes either "disable sync" or "ask the human for the correct URL" — never guesses.
- Healing `state/` from `agent.json` automatically. That's `ouro use` territory; the persona proposes the command, doesn't run it.
- A new TUI surface. Re-use the existing repair prompt UI from `interactive-repair.ts` / `terminal-ui.ts`.
- Cross-machine sibling-bundle sync in v1. If the persona is a bundle later, it gets sync; for now it's an in-repo file.
- Replacing `runAgenticRepair`. The new persona-based proposer wraps it: same activation conditions, same fallback behavior, additive structure on top.
- Inventing new `RepairAction` kinds. The catalog (`vault-create`, `vault-unlock`, `vault-replace`, `vault-recover`, `provider-auth`, `provider-retry`, `provider-use`) is the v1 surface. New kinds gated on a real need.

---

## Open Questions (operator decides at planning time)

1. **Is the repair persona a real `.ouro` bundle or a structured-prompt-in-repo persona?** Strong recommendation: structured-prompt-in-repo for v1. Operator's "permanent sibling that ships with the repo and gets bundled" language fits both — needs disambiguation.
2. **Name.** `Mender`, `Aesculapius`, or `system/repairer` (i.e., not-a-peer-agent framing). Or operator-supplied.
3. **Sync probe scope.** `git fetch` only (read-only, safest), or `git fetch` + `git pull --ff-only` (closer to operator's stated layer-2 spec, can mutate working tree). Recommend `--ff-only` to match the spec, but flag that it can fail on dirty tree.
4. **Where pre-up sync diagnostics get written.** Re-use `state/pending-sync.json` (already gitignored, already has classification field) or add `state/pre-up-sync.json` (clearer separation, but two files). Recommend re-use with extended classification enum.
5. **Drift detection trigger surface.** New `AgentReadinessIssue` kind (`intent-state-drift`) consumed by the existing repair UI, or a separate banner in `inner-status.ts`? Recommend the issue-kind path — it composes with the rest of the design.
6. **Per-agent rollup boundary.** What does "daemon degraded" mean post-fix? Recommend: daemon is `healthy` if at least one agent is healthy AND the daemon process itself is responsive; daemon is `degraded` only if all agents fail OR the harness process can't serve commands. Operator should confirm this matches their mental model.
7. **Repair memory across boots.** Should the persona remember "operator said no to fixing slugger's 404 last boot, don't ask again" for some TTL? Where does that live? Recommend: yes, write to `state/repair-history.json` (per-bundle, gitignored), TTL 7 days, key on `(issueKind, fingerprint-of-error)`. Operator should sanity-check.
8. **Activation condition.** Today `runAgenticRepair` runs only on `untypedDegraded`. Should the new persona also opine on `typedDegraded` when *multiple* typed issues stack on one agent (slugger's case)? Recommend: yes, the persona is invoked when (`untypedDegraded.length > 0`) OR (any agent has ≥2 typed issues). Operator should confirm this isn't too noisy.
9. **`--no-repair` and `--force` semantics.** Recommend: persona honors `--no-repair` (skips entirely) and ignores `--force` (which is about crash-loop bypass, not repair skipping). Operator should confirm.
10. **Tests.** The slugger incident is a perfect golden-path test. Should the planning doc include a fixture-based integration test that reproduces the bug as a regression guard? Recommend: yes, gated as the primary acceptance signal for layer 1.

---

## Prior-Art Notes

- `agentic-repair.ts` is the prior art the operator's "sibling" idea structurally upgrades. The diagnostic-LLM-call pattern is already there; what's missing is structured output, action validation, and chaining into the existing `RepairAction` pipeline.
- `interactive-repair.ts` is the propose-then-confirm UI pattern. The persona's output feeds into this; no new UI needed.
- `readiness-repair.ts`'s typed-issue / typed-action catalog is the right vocabulary surface. Don't invent a parallel one.
- `safe-mode.ts` is the right precedent for "fail closed at the harness scope but recoverable." Layer 1's per-agent rollup should mirror this: a per-agent "degraded marker" file that boots clear themselves once the agent is healthy, similar to how `pruneOldCrashes` clears the tombstone.
- `provider-binding-resolver.ts`'s `EffectiveProviderReadiness.reason` enum already has `provider-model-changed` — drift is half-built.
- The slugger bundle's `sync` config (`{ enabled: true }` with no explicit `remote`) defaults to `origin` per `listBundleSyncRows`. Layer 2 needs to handle the implicit `origin` case — it already does in the existing code path.

---

## Planner Handoff

### Goal
Make the daemon resilient to a single bad bundle. When `ouro up` encounters slugger-shaped failures, the rest of the harness comes up clean, the bad agent is named with structured diagnostics, and a constrained repair persona proposes specific actions the operator confirms one at a time.

### Constraints
- Re-use existing `RepairAction` catalog, `interactive-repair` UI, `agentic-repair` provider-discovery wiring.
- Honor `--no-repair`. Default to propose-then-confirm — never auto-apply destructive actions.
- Do not write to `state/` from harness code outside the per-bundle rules already in place.
- Tolerate legacy `humanFacing`/`agentFacing` field names on read; emit `outward`/`inner` on write.
- Persona has zero tool surface in v1; no `bash`, no `git mutate`, no file writes.
- Persona uses harness-discovered working provider (`discoverWorkingProvider`), not a self-binding.

### Likely files / modules
- `src/heart/sync.ts` — add `preUpFetch` with classification taxonomy.
- `src/heart/daemon/cli-exec.ts` — wire `preUpFetch` into the per-agent loop near line 287; thread sync diagnostics into `degraded[]`.
- `src/heart/daemon/agent-config-check.ts` — surface `provider-model-changed` from the binding resolver as an `intent-state-drift` issue kind.
- `src/heart/daemon/readiness-repair.ts` — extend `AgentReadinessIssueKind` with `intent-state-drift` and `sync-broken` (with sub-classifications); extend `RepairAction` if needed (probably not — `provider-use` already covers drift).
- `src/heart/daemon/repair-persona.ts` (new) — structured-prompt persona, JSON-output validator, fallback to text blob.
- `src/heart/daemon/repair-persona-prompt.md` (new) — the persona's system prompt, version-controlled.
- `src/heart/daemon/agentic-repair.ts` — refactor to dispatch through `repair-persona.ts`; preserve current behavior as fallback.
- `src/heart/daemon/inner-status.ts`, `startup-tui.ts` — verify per-agent rollup; fix daemon-wide degraded signal if it conflates with per-agent.
- `tests/__tests__/heart/daemon/repair-persona.test.ts` (new) — golden-path test reproducing slugger.
- `tests/__tests__/heart/sync-pre-up.test.ts` (new) — sync classification tests.
- Possibly: `Mender.ouro/` (or chosen name) sibling bundle — gated on Open Question #1.

### Acceptance signals
- Slugger-shaped fixture (bootstrap drift + expired cred + 404 remote + dirty tree) processed by `ouro up` produces: daemon `healthy`, slugger marked `degraded` with 4 named issues, persona proposes 3 distinct actions (drift → `ouro use`, expired cred → `ouro auth`, 404 → "disable sync or set new remote"), dirty tree surfaced as advisory not blocker.
- A second healthy agent in the same fixture comes up `healthy` with no degraded marker.
- `ouro up --no-repair` skips persona, surfaces structured `degraded[]` with all classifications, exits 0.
- Persona never writes to disk in v1; every change goes through existing `interactive-repair` runners.
- Existing `agentic-repair` test suite still passes (no regression on text-blob fallback path).

### Risks
- **Per-agent rollup fix may be a larger refactor than expected** if `daemon-health.ts` / `inner-status.ts` deeply conflate per-agent and daemon-wide state. Recommend a separate spike before scoping.
- **The persona's structured-output reliability** depends on the model. The fallback to text-blob mitigates, but operators on weaker models will see the v1 sibling behave like today's `agentic-repair`. Acceptable for MVP; surface as a known limitation.
- **Sync probe + dirty tree** — operator's local edits to `agent.json` and `bundle-meta.json` in slugger today would block `git pull --ff-only`. The persona must classify this as advisory-not-blocker and never propose a destructive resolution.
- **Recursion base case** — sibling's own bundle/persona must never appear in its own `degraded[]`. Easy if v1 keeps the persona as in-repo code; becomes a real concern if v2 promotes it to a bundle.
- **Test fixture realism** — slugger's `vault_d5be48b687de0133` credential revision is real; tests must mock vault state without hitting the actual vault server. The existing test suite under `src/__tests__/heart/daemon/` has patterns for this; the planning doc should use those.

---

End of ideation handoff. work-planner: proceed to a planning doc that converts this brief into a phased work plan, surfacing the 10 open questions to the operator before locking scope.
