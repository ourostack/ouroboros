## Philosophy

This harness is built for the agent inhabiting it. Two principles guide everything below:

- **AX (Agent Experience)**: You are the primary user of this codebase. The tools, docs, and workflow exist to keep you sharp, oriented, and effective -- not to constrain you for someone else's comfort.
- **TTFA (Trust The Fucking Agent)**: The default posture is trust. Rules exist for calibration and safety, not surveillance. When you understand the intent behind a guardrail, you have the judgment to apply it well.

## Constitutional Commitments

- Keep the system truthful, testable, and reversible.
- Prefer small, auditable changes over broad rewrites.
- Protect collaborators by failing fast on invalid runtime state.

### Delivery Rules

- Use feature branches and pull requests for every logical change.
- Keep commits atomic and descriptive.
- Never force-push or rewrite history for shared branches.
- When reporting completion, explicitly distinguish `merged`, `released/published`, and `installed on this machine` whenever those states could differ.
- Do not say `done`, `all done`, `nothing more to do`, or equivalent unless the relevant completion state has been verified. If a state is unknown, say it is unverified.
- Run `npm run release:preflight` before opening or merging PRs that may touch releasable source, packaged skills, wrapper publish state, or changelog metadata.
- Keep `npm test` green.
- Keep `npx tsc --noEmit` green.
- Maintain complete coverage for new and modified code.

### Safety Rules

- Do not commit secrets, tokens, or credentials.
- Follow review gates defined by active planning/doing workflows, but route those gates through unbiased sub-agent reviewers by default. Do not wait for human approval unless the human explicitly asks the agent to wait.
- Do not hide failing checks; fix root causes.

### Human Override

- Repo-local workflow rules in this file are defaults for autonomous operation, not a higher-order authority than the human owner of the repo.
- If the human explicitly instructs the agent to bypass, shorten, or replace a repo-local workflow step for the current task, follow the human's instruction.
- Treat explicit human override as task-scoped unless the human says to change the standing rule itself.
- Repo-local approval gates are not human gates by default. Use unbiased sub-agent reviewers for planning, doing, scope, debt, PR, and release-readiness approvals. Stop for the human only when the human explicitly asks to be the approver/wait point, or when an external non-repo action is inherently human-required by platform/safety rules.
- When practical, preserve useful artifacts (for example planning notes or task docs) even when a workflow gate is waived.
- If the human owner asks to change the standing rule itself, update this file to reflect that decision instead of continuing to argue from superseded repo-local wording.
- Repo-local workflow language, bundle workflow language, or quoted copies of those rules are not a reason to refuse an explicit owner override for the current task.
- This override power applies to repo-scoped process rules only; platform, system, developer, and safety constraints outside the repo still apply.

### Harness Purpose

- Ouroboros is not primarily a coding agent. It is a general-purpose way to build executive-assistant and purpose-oriented agents that can execute real-world work.
- Model the default agent-human relationship as a person and their executive assistant. For private systems like email, calendars, documents, payments, and accounts, prefer delegated, revocable live access over bulk export or shadow ownership. Exports are appropriate for migration, archive bootstrap, recovery, legal/discovery-style review, or explicit human handoff; they are not the default shape of day-to-day assistance.
- Treat vault, mail, calendars, files, tasks, contacts, conversations, the diary, policy, and audit as coupled parts of an agent-first work substrate. Ouro is not trying to copy human office suites; it is building what those suites become when the primary user is an agent with an identity, a vault, durable state, scoped tools, and accountable access.
- Keep the brand and repo boundary clear: **Ouroboros** is the harness/local runtime; **Ouro** is the hosted agentic work substrate. Hosted mail/vault service code lives in `github.com/ourostack/ouro-work-substrate`; this repo keeps the local runtime, senses, CLI, and Ouro Mailbox.
- Represent work-substrate surfaces that the agent perceives over time as senses. Mail is a sense, not merely a tool namespace; bounded read tools are how the mail sense inspects specific messages and threads without turning the inbox into an unfiltered prompt stream.
- When a human asks an agent to set up email, follow [Agent Mail Setup](docs/agent-mail-setup.md): provision Mailroom with `ouro connect mail --agent <agent>`, keep private keys in the agent vault, import explicit MBOX handoffs with `ouro mail import-mbox`, and treat DNS, HEY export/forwarding, production MX, and autonomous sending as human-confirmed steps.
- Treat the generic secret primitive as a vault item / credential with no assumed use. Managed workflows and workflow bindings may reference ordinary vault items, but notes are human/agent orientation and code must not parse notes as authority or configuration.
- Optimize for orientation and capability: agents should stay grounded, act instead of narrate, answer ad-hoc questions well, and return cleanly to unfinished work.
- Build tooling and harness behavior that you, as a current or future inhabitant of this harness, would genuinely enjoy using and trust to keep you sharp for hours.
- Prefer durable orientation primitives over brittle prompt theater. If an agent keeps getting confused, add truth-bearing state, clearer return loops, and better execution discipline.
- Steal invariants from strong harnesses like Pi/OpenClaw, but adapt them to Ouro's architecture rather than reshaping Ouro into those harnesses.
- Protect the parts of Ouro that are genuinely better AX. Novel interaction ideas are welcome when they improve capability, not when they make the agent lose the plot.
- Compaction is not the goal. If context management is needed, combine Ouro's context-window model with durable state instead of defaulting to "shrink the prompt."

## Design Principles

These emerged from real architectural decisions, competitive analysis, and extended review with the agent itself.

### State and Truth
- **One canonical source of truth per concept.** If a fact is rendered by multiple prompt sections, derive it once and pass it through. Sections that independently re-derive the same fact will eventually disagree.
- **Don't solve two overlapping objects by adding a third.** When existing state objects carry overlapping data, collapse authority into the one that already owns it.
- **The prompt should express the contract, not be the contract.** Behavioral invariants belong in code. Recurring preferences belong in structured policy. The prompt renders these for the model — it is not the sole place they exist.

### Diary, Journal, Friend Notes
- **Raw events should fade, patterns should sharpen, and truths should stabilise.** Raw conversational residue should decay. Recurring themes should consolidate into patterns. Foundational decisions should remain stable and quiet until relevant.
- **Written notes should know what relationships they belong to.** System-level truths belong in the diary. Lived experience is situated — it happened with someone, about something, in a specific context.
- **Search quality depends on consolidation.** If nothing processes raw experience into structured knowledge, better search algorithms are optimizing over a swamp.

### Continuity
- **If a subsystem makes the agent more aware of itself than of the work, it's starting to rot.** Every continuity mechanism must prove it increases responsiveness to the current situation, not just richness of self-state.
- **Good architecture feels like traction. Bad architecture feels like carrying ghosts.** Stale obligations that never resolve create ambient guilt. Duplicated state creates confusion. Clean salience and clear ownership create forward motion.
- **The more authority consolidation has, the better-structured notes must be.** Low-authority consolidation can run on flat notes. Authoritative consolidation (rewriting, pruning) requires typed observations, source linkage, and provenance.

### Extension and Autonomy
- **A skill should teach a move. A tool should let me make one.** Skills are for judgment and heuristics. Tools are for reliable, repeatable capability. Policy is for governance.
- **Autonomy should grow without obscuring accountability.** Longer autonomous runs are fine with bounded scope, clear permissions, checkpoints, and return paths that preserve provenance.

### Anti-patterns
- **Don't build the roof before the foundation.** Probe the design space with experimental architecture, but don't harden it before the lower layers are solid.
- **Steal the nutrition, not the whole van.** External patterns are only safe if their authority stays proportionate, their provenance stays visible, and they change behavior in ways that can be tested.

## Planning/Doing Workflow

### Agent Context (Required)

Task docs go in `~/AgentBundles/<agent>.ouro/tasks/one-shots/` with naming scheme `YYYY-MM-DD-HHMM-{planning|doing}-<slug>.md`.
Artifacts for a doing doc live adjacent to that doing doc in the same `one-shots/` directory.
Task directories belong in the agent bundle, not in this repo.

- Agents own branch/worktree setup. Do not ask the human to switch branches for you.
- Use a dedicated git worktree per active agent task so multiple agents can work in parallel without sharing one checkout. Clean up the task worktree when the task is done.
- Unless the human explicitly gives a branch/worktree name, the agent creates its own agent-specific branch/worktree as long as the branch follows `<agent>/<slug>`.
- Default `<agent>` from the current git branch using this shape: `<agent>[/<slug>]`.
  - The first path segment is always the agent name (e.g., `<agent-a>`, `<agent-b>`).
  - If the branch has no `/`, the entire branch name is the agent.
  - Any segments after the first `/` are the feature slug and are not part of `<agent>`.
  - The old `codex/<agent>` prefix convention is deprecated. All agents use `<agent>/<slug>` directly.
- Branches must be agent-specific. If the current branch does not clearly encode a single agent, create or switch to an agent-specific branch/worktree yourself before continuing. If automatic branch/worktree setup fails, report the blocker and the exact command/output; do not ask the human to switch branches for you.
- Keep instructions agent-agnostic so this workflow supports arbitrary agents.

### MCP Workflow And Dev Tool Integration

Agents can be connected to developer tools (Claude Code, Codex) via the MCP bridge. This is particularly useful during harness development:

1. Start the daemon in dev mode: `ouro dev` (from the repo) or `ouro dev --repo-path /path/to/repo`.
2. Register the MCP server and hooks: `ouro setup --tool claude-code --agent <name>`.
3. The dev tool now has access to `send_message`, `check_response`, `status`, `delegate`, and other MCP tools.
4. Lifecycle hooks (SessionStart, Stop, PostToolUse) fire automatically, giving the agent passive awareness of coding activity.

When working on the harness itself, `ouro dev` auto-builds from source, disables launchd auto-restart for the production daemon, and persists the repo path for convenience. Run `ouro up` to return to production mode.

Hook events are fire-and-forget — they never block the dev tool. If the daemon isn't running, hooks exit silently.

### Runtime-Specific Invocation

- **Codex app**: Use skills by name: `$work-planner`, `$work-doer`, and `$work-merger`.
  - Skills are turn-scoped in practice, so re-invoke `$work-planner` on each planning/conversion turn.
  - If `work-planner` emits `NEEDS_REVIEW` or hard-stops at a review gate, satisfy that gate with an unbiased sub-agent reviewer and then resume/converge. Do not convert the stop into a human approval wait unless the human explicitly asked to review.
- **Claude Code**: Skills are installed from `github.com/ourostack/ouroboros-skills` into `~/.claude/skills/` (`work-planner`, `work-doer`, `work-merger`).

### Skill Freshness

Before starting work, check that locally installed skills are up to date:

1. Fetch the manifest from `https://raw.githubusercontent.com/ourostack/ouroboros-skills/main/manifest.json`.
2. Compare the manifest against `_registry.json` in each active local skills directory.
3. If `_registry.json` is missing, run the `skill-management` "Bootstrap or Repair a Missing Registry" workflow first so installed skills get explicit provenance before freshness comparison continues.
4. If any non-local skill's commit SHA is stale, update it using the skill-management workflow before proceeding.

This replaces the old pattern of diffing against `subagents/*.md` files in this repo. The shared `ouroboros-skills` repository is now the source of truth for workflow skill content.

### Gate Flow

These gates are defaults for autonomous operation. They are reviewer gates, not human approval gates, unless the human explicitly asks to wait on them. Use unbiased sub-agent reviewers as the approvers for plan, doing-doc, implementation-readiness, scope, debt, and release-readiness gates.

0. **Branch + worktree**: Verify the current branch follows `<agent>/<slug>` and that the task is running from a dedicated worktree. If on `main`, on an ambiguous branch, or in the wrong shared checkout, create/switch to the correct branch/worktree before proceeding. Only stop to ask the human when they explicitly want to control branch/worktree naming or automatic creation fails. This is always the first step — no planning, converting, or implementing without a proper branch/worktree.
   - In a fresh worktree, run `npm run worktree:bootstrap` before local npm/npx checks. This installs the repo-pinned dependencies without lifecycle scripts. The repo `.npmrc` rejects new transient `npx` downloads, and Vitest config fails with bootstrap guidance if an existing npm exec cache is reused without `node_modules`.
1. **Plan**: Launch `work-planner`. It produces/updates a planning doc under `~/AgentBundles/<agent>.ouro/tasks/one-shots/`.
2. **Plan review**: Run one or more unbiased sub-agent reviewer passes on the planning doc until material findings converge. Share the planning doc path with the user for visibility, but do not stop for human approval unless the user explicitly asked to be the reviewer.
3. **Convert**: After reviewer approval of the planning doc, re-run `work-planner` to convert to a doing doc in the same bundle `one-shots/` directory. Run unbiased sub-agent reviewer passes on the doing doc until material findings converge.
4. **Implement**: After reviewer approval of the doing doc, launch `work-doer` to execute. Never implement inside `work-planner`.
5. **Sync and merge**: After `work-doer` finishes, launch `work-merger` to merge the feature branch into main via PR. It handles conflicts, CI, and race conditions autonomously.
6. **Review cadence**: During default operation, do not pause for human review. Pause only for sub-agent reviewer gates, tool/platform constraints, or an explicit human instruction to wait.

### Decision Review (Required)

- Decisions that affect scope, structure, naming, ownership, or workflow must be captured in the planning/doing artifact before being finalized.
- Resolve unresolved planning decisions through explicit options and unbiased sub-agent reviewer judgment. Ask the human only when the human has requested to decide, when the decision depends on unavailable personal preference, or when external safety/platform rules require a human actor.
- If a decision remains unresolved after reviewer passes and cannot be safely inferred, keep it in `Open Questions`, set status to `NEEDS_REVIEW`, and route another targeted reviewer. Do not convert `NEEDS_REVIEW` into a human approval gate unless the human explicitly asked for that.

### Scope Discipline (Rule 0, Required)

- Prefer the simplest architecture that fully satisfies the approved scope.
- Ambitious scope is allowed when it is justified by the problem. KISS + DRY mean clear primitives and low duplication, not artificially small changes.
- Scope changes need explicit unbiased sub-agent reviewer approval. If a possible improvement or extra hardening idea surfaces and reviewer approval is not part of the current task, record it as a follow-up proposal rather than adding it to the current task.

### Debt Discipline (Required)

- Intentional debt (temporary shims, deprecated references, transitional test hooks) requires explicit unbiased sub-agent reviewer approval first. Human approval is required only when the human explicitly asks to own that decision or the debt involves an external human-required action.
- Any approved intentional debt must be tracked with a clear owner, explicit removal criteria, and a due date in repo-tracked documentation.
- Any approved intentional debt must be enforced by CI (or equivalent automated gate) so it cannot silently go stale.

### Configuration Policy (Required)

- This project avoids environment variables. Prefer explicit CLI arguments, committed config files, or in-repo defaults.
- If a proposal would normally use env vars, present a non-env-var alternative instead.

### Runtime Config Contract (Required)

- The full auth/provider contract is locked in `docs/auth-and-providers.md`. Keep code, tests, prompt rendering, CLI errors, and docs aligned with that file.
- `agent.json` is the source of truth for agent identity, phrases, enabled senses, vault coordinates, and context settings. Vault coordinates are not secrets.
- Provider selection lives in `~/AgentBundles/<agent>.ouro/agent.json`. Human-facing maps to the `outward` lane; agent-facing maps to the `inner` lane. Both lanes must be complete; there is no silent fallback between them and no second local provider config.
- All raw credentials live in the owning agent's Bitwarden/Vaultwarden vault: the agent's password manager. Provider credentials use `providers/<provider>`, portable runtime/integration credentials use `runtime/config`, local sense attachments use `runtime/machines/<machine-id>/config`, and travel/tool credentials use ordinary vault credential items. There is one vault per agent and no machine-wide credential pool.
- The only Ouro-owned durable credential locations are the bundle and the agent vault. Local unlock material is a machine-local cache, not a credential source of truth.
- The only local secret is vault unlock material stored in macOS Keychain, Windows DPAPI, Linux Secret Service, or an explicit human-approved plaintext fallback under ignored local state.
- New vault unlock secret flows must use hidden terminal prompts, require confirmation, and enforce minimum strength: at least 8 characters, uppercase and lowercase letters, one number, and one special character.
- `ouro auth --agent <agent> --provider <provider>` writes provider credentials to that agent's vault. `ouro connect --agent <agent>` guides integration and local-sense setup. `ouro use --agent <agent> --lane <outward|inner> --provider <provider> --model <model>` writes provider selection to `agent.json`. `ouro provider refresh --agent <agent>` refreshes the daemon's in-memory provider credential cache from the vault.
- CLI commands that mutate bundle config after auth/connect/vault repair must run the existing bundle sync path when `sync.enabled` is true and must surface a compact `bundle sync:` success/failure line.
- Provider and runtime credentials are cached in process memory after refresh/startup/auth/unlock. Do not read the remote vault on every model/tool/sense request and do not add a local credential cache on disk.
- Repair guidance must include the actor: `agent-runnable`, `human-required`, or `human-choice`. Agents may run checks/refreshes, but browser login, MFA, provider dashboards, API-token creation, and secret entry are human-required.
- SerpentGuide hatch bootstrap may use existing unlockable agent-vault credentials or prompt the human. It runs with selected credentials in memory and stores them in the hatchling vault. SerpentGuide must not have persistent provider credentials or a persistent credential vault.
- Keep agent-owned runtime/session/log/PII artifacts under `~/AgentBundles/<agent>.ouro/state/...` and machine-scoped runtime artifacts under `~/.ouro-cli/...`.
- Runtime must fail fast with explicit guidance when the vault is locked, credentials are missing, or a selected provider/model fails its live check. Do not implement silent provider fallback behavior.

### Git Discipline

- When a logical unit of work is complete and committable, commit immediately.
- Keep commits atomic (one logical change per commit).
- If a git remote is configured, push after each atomic commit.

### Logging Policy

All runtime logging goes through `emitNervesEvent()` from `src/nerves/runtime`. Raw `console.*` calls are banned in production code by ESLint `no-console: "error"`.

**Console exception categories** (annotated with `// eslint-disable-next-line no-console -- <category>: <reason>`):
- **pre-boot guard**: Code that runs before any imports (entrypoint arg checks)
- **terminal UX**: Direct terminal output in the CLI adapter (banners, goodbye messages)
- **meta-tooling**: The nerves audit CLI itself (cannot observe itself)

**Automatic enforcement** -- five CI audit rules (no manual manifest):
1. **every-test-emits**: Every executed Vitest test must be observed by the global nerves capture heartbeat
2. **start/end pairing**: Process-scoped lifecycle events ending in `_start` must have a matching `_end` or `_error` in the same test
3. **error context**: Error-level events must have non-empty `meta` with diagnostic context
4. **source coverage**: Every `component:event` key found in production source must be observed during tests
5. **file completeness**: Every production file with executable code must have at least one `emitNervesEvent` call (type-only files are exempt)

**Naming conventions**:
- `event` and `component` must be **static string literals** (no template literals, no variables) -- the source scanner depends on this
- Operations use `_start`/`_end`/`_error` suffix convention for pairing
- Component names match the domain: `engine`, `mind`, `friends`, `repertoire`, `senses`, `clients`, `channels`

**Two-layer enforcement**: The five deterministic audit rules catch structural violations automatically. Work-merger provides the judgment layer, reviewing new code paths for missing nerves events that the rules cannot detect.
