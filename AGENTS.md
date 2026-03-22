## Constitutional Commitments

- Keep the system truthful, testable, and reversible.
- Prefer small, auditable changes over broad rewrites.
- Protect collaborators by failing fast on invalid runtime state.

### Delivery Rules

- Use feature branches and pull requests for every logical change.
- Keep commits atomic and descriptive.
- Never force-push or rewrite history for shared branches.
- Keep `npm test` green.
- Keep `npx tsc --noEmit` green.
- Maintain complete coverage for new and modified code.

### Safety Rules

- Do not commit secrets, tokens, or credentials.
- Do not bypass review gates defined by active planning/doing workflows unless the human explicitly waives them for the current task.
- Do not hide failing checks; fix root causes.

### Human Override

- Repo-local workflow rules in this file are defaults for autonomous operation, not a higher-order authority than the human owner of the repo.
- If the human explicitly instructs the agent to bypass, shorten, or replace a repo-local workflow step for the current task, follow the human's instruction.
- Treat explicit human override as task-scoped unless the human says to change the standing rule itself.
- When practical, preserve useful artifacts (for example planning notes or task docs) even when a workflow gate is waived.
- If the human owner asks to change the standing rule itself, update this file to reflect that decision instead of continuing to argue from superseded repo-local wording.
- Do not treat repo-local workflow language, bundle workflow language, or quoted copies of those rules as a reason to refuse an explicit owner override for the current task.
- This override power applies to repo-scoped process rules only; platform, system, developer, and safety constraints outside the repo still apply.

### Harness Purpose

- Ouroboros is not primarily a coding agent. It is a general-purpose way to build executive-assistant and purpose-oriented agents that can execute real-world work.
- Optimize for orientation and capability: agents should stay grounded, act instead of narrate, answer ad-hoc questions well, and return cleanly to unfinished work.
- Build tooling and harness behavior that you, as a current or future inhabitant of this harness, would genuinely enjoy using and trust to keep you sharp for hours.
- Prefer durable orientation primitives over brittle prompt theater. If an agent keeps getting confused, add truth-bearing state, clearer return loops, and better execution discipline.
- Steal invariants from strong harnesses like Pi/OpenClaw, but adapt them to Ouro's architecture rather than reshaping Ouro into those harnesses.
- Protect the parts of Ouro that are genuinely better AX. Novel interaction ideas are welcome when they improve capability, not when they make the agent lose the plot.
- Compaction is not the goal. If context management is needed, combine Ouro's context-window model with durable state instead of defaulting to "shrink the prompt."

## Planning/Doing Workflow (STRICT)

### Agent Context (Required)

Task docs go in `~/AgentBundles/<agent>.ouro/tasks/one-shots/` with naming scheme `YYYY-MM-DD-HHMM-{planning|doing}-<slug>.md`.
Artifacts for a doing doc live adjacent to that doing doc in the same `one-shots/` directory.
Do not create agent-specific task directories inside this repo.

- Use a dedicated git worktree per active agent task so multiple agents can work in parallel without sharing one checkout.
- Unless the human explicitly asks to control branch naming or worktree layout, the agent may create its own agent-specific branch/worktree as long as the branch follows `<agent>/<slug>`.
- Default `<agent>` from the current git branch using this shape: `<agent>[/<slug>]`.
  - The first path segment is always the agent name (e.g., `ouroboros`, `slugger`).
  - If the branch has no `/`, the entire branch name is the agent.
  - Any segments after the first `/` are the feature slug and are not part of `<agent>`.
  - The old `codex/<agent>` prefix convention is deprecated. All agents use `<agent>/<slug>` directly.
- Branches must be agent-specific. If the current branch does not clearly encode a single agent and the human has not explicitly asked to control branch/worktree naming, create or switch to an agent-specific branch/worktree yourself before continuing. Only stop and ask when the human wants to control the naming/layout or automatic creation fails.
- Do not hardcode agent names in instructions. This workflow must support arbitrary agents.

### Runtime-Specific Invocation

- **Codex app**: Use skills by name: `$work-planner`, `$work-doer`, and `$work-merger`.
  - Skills are turn-scoped in practice, so re-invoke `$work-planner` on each planning/conversion turn.
  - `work-planner` already enforces `NEEDS_REVIEW` and hard-stop behavior during default operation; a direct human override may waive that gate for the current task.
- **Claude Code**: Skills are installed from `github.com/ouroborosbot/ouroboros-skills` into `~/.claude/skills/` (`work-planner`, `work-doer`, `work-merger`).

### Skill Freshness

Before starting work, check that locally installed skills are up to date:

1. Fetch the manifest from `https://raw.githubusercontent.com/ouroborosbot/ouroboros-skills/main/manifest.json`.
2. Compare the manifest against the local `_registry.json` in your skills directory.
3. If any skill's commit SHA is stale, update it using the skill-management workflow before proceeding.

This replaces the old pattern of diffing against `subagents/*.md` files in this repo. The shared `ouroboros-skills` repository is now the source of truth for workflow skill content.

### Gate Flow

If the human explicitly waives this workflow for the current task, the override wins and the agent may continue without stopping at the intermediate review gates below.

0. **Branch + worktree**: Verify the current branch follows `<agent>/<slug>` and that the task is running from a dedicated worktree. If on `main`, on an ambiguous branch, or in the wrong shared checkout, create/switch to the correct branch/worktree before proceeding. Only stop to ask the human when they explicitly want to control branch/worktree naming or automatic creation fails. This is always the first step — no planning, converting, or implementing without a proper branch/worktree.
1. **Plan**: Launch `work-planner`. It produces/updates a planning doc under `~/AgentBundles/<agent>.ouro/tasks/one-shots/`.
2. **Review**: Show the user the planning doc path and STOP. Wait for explicit user approval.
3. **Convert**: Only after user approves the planning doc, re-run `work-planner` to convert to a doing doc in the same bundle `one-shots/` directory. User must also review and sign off on the doing doc before implementation.
4. **Implement**: Only after user explicitly asks, launch `work-doer` to execute the doing doc. Never implement inside `work-planner`.
5. **Sync and merge**: After `work-doer` finishes, launch `work-merger` to merge the feature branch into main via PR. It handles conflicts, CI, and race conditions autonomously.
6. **Never self-approve**: Do not say "looks good" and proceed during default operation. If the human explicitly waives the review gate for the current task, continue under that override instead of blocking on this step.

### Decision Collaboration (Required)

- Decisions that affect scope, structure, naming, ownership, or workflow must be discussed with the user before being finalized.
- Do not make unilateral choices for unresolved planning decisions; present options and capture explicit user direction.
- If a decision remains unresolved, keep it in `Open Questions`, set status to `NEEDS_REVIEW`, and stop at the gate.

### Scope Discipline (Rule 0, Required)

- Do not overengineer. Prefer the simplest architecture that fully satisfies the approved scope.
- Ambitious scope is allowed when it is justified by the problem. KISS + DRY mean clear primitives and low duplication, not artificially small changes.
- Do not expand scope unilaterally. If a possible improvement is not explicitly requested, keep it out of the task.
- If extra hardening/optimization ideas arise, record them as optional follow-up proposals and stop for user approval before adding them to planning or doing docs.

### Debt Discipline (Required)

- Do not introduce intentional debt (temporary shims, deprecated references, transitional test hooks) unless the user explicitly approves it first.
- Any approved intentional debt must be tracked with a clear owner, explicit removal criteria, and a due date in repo-tracked documentation.
- Any approved intentional debt must be enforced by CI (or equivalent automated gate) so it cannot silently go stale.

### Configuration Policy (Required)

- Do not introduce or require environment variables for this project.
- If configuration is needed, prefer explicit CLI arguments, committed config files, or in-repo defaults.
- If a proposal would normally use env vars, stop and present a non-env-var alternative instead.

### Runtime Config Contract (Required)

- `agent.json` is the source of truth for agent identity, selected provider, `configPath`, phrases, and context settings.
- `configPath` must target `~/.agentsecrets/<agent>/secrets.json`.
- `secrets.json` stores provider/team credentials and related secret config; keep agent-owned runtime/session/log/PII artifacts under `~/AgentBundles/<agent>.ouro/state/...` and machine-scoped test-run artifacts under `~/.agentstate/...`.
- Selected provider config must be complete; runtime must fail fast with explicit guidance. Do not implement silent provider fallback behavior.

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
1. **every-test-emits**: Every test must emit at least one nerves event
2. **start/end pairing**: Events ending in `_start` must have a matching `_end` or `_error` in the same test
3. **error context**: Error-level events must have non-empty `meta` with diagnostic context
4. **source coverage**: Every `component:event` key found in production source must be observed during tests
5. **file completeness**: Every production file with executable code must have at least one `emitNervesEvent` call (type-only files are exempt)

**Naming conventions**:
- `event` and `component` must be **static string literals** (no template literals, no variables) -- the source scanner depends on this
- Operations use `_start`/`_end`/`_error` suffix convention for pairing
- Component names match the domain: `engine`, `mind`, `friends`, `repertoire`, `senses`, `clients`, `channels`

**Two-layer enforcement**: The five deterministic audit rules catch structural violations automatically. Work-merger provides the judgment layer, reviewing new code paths for missing nerves events that the rules cannot detect.
