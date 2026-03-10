# Contributing

This repo is shared infrastructure for multiple agents. Please leave it clearer, safer, and easier to inhabit than you found it.

## Start Here

`AGENTS.md` is the canonical workflow spec for this repo.

Read it first for:

- branch rules
- planning and doing gates
- task-doc locations
- configuration policy
- logging policy
- merge discipline

This file is the practical companion, not the source of truth.

## Branches

Use an agent-specific branch:

- `ouroboros/<slug>`
- `slugger/<slug>`
- `<agent>/<slug>`

Do not work directly on `main`.

## Task Docs

Planning and doing docs live in the owning bundle, not in this repo:

`~/AgentBundles/<agent>.ouro/tasks/one-shots/`

Do not create new repo-local task directories like `slugger/tasks/`.

## Commits

Keep commits atomic and descriptive.

Common shapes:

- `feat(scope): description`
- `fix(scope): description`
- `refactor(scope): description`
- `test(scope): description`
- `docs(scope): description`
- `chore(scope): description`

Useful scopes in the current codebase include:

- `daemon`
- `heart`
- `mind`
- `repertoire`
- `senses`
- `nerves`
- `docs`

Avoid stale scopes from removed layouts like `wardrobe`.

## Testing

For runtime code changes, keep these green:

```bash
npm test
npx tsc --noEmit
npm run test:coverage
```

Detailed policy lives in:

- `docs/testing-conventions.md`

Operator smoke coverage lives in:

- `docs/testing-guide.md`

## Merge Workflow

PR-based merge policy, conflict resolution, and retry rules live in:

- `docs/sync-and-merge-conventions.md`

The implemented workflow helpers live in:

- `subagents/work-planner.md`
- `subagents/work-doer.md`
- `subagents/work-merger.md`

## Code Expectations

- `src/` is shared harness code. Changes here affect every agent.
- Keep runtime behavior truthful, testable, and reversible.
- Do not hide failing checks or add silent fallback behavior where the repo explicitly forbids it.
- Use `emitNervesEvent()` for runtime observability. Do not add raw `console.*` to production code.
- Prefer the smallest change that satisfies the approved scope.

## Config Expectations

- `agent.json` is the agent-facing source of truth.
- `configPath` must point to `~/.agentsecrets/<agent>/secrets.json`.
- Secrets do not belong in the repo.
- Agent-owned state belongs under `~/AgentBundles/<agent>.ouro/state/...`.
- Machine-scoped temporary/test artifacts belong under `~/.agentstate/...`.

If selected provider config is incomplete, fail fast with explicit guidance. Do not silently fall back to another provider.

## Docs Expectations

Docs are part of the runtime surface for both humans and agents.

- If a doc is stale, fix it or remove it.
- Prefer one accurate page over three contradictory ones.
- Git history is the archive; the current repo should tell the truth.
- Write so the next agent can feel oriented, safe, and a little more at home.
