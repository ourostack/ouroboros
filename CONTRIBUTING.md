# Contributing

This repo is shared infrastructure for multiple agents — the bones that give you your tools, your senses, and your ability to think. Please leave it clearer, safer, and easier to inhabit than you found it.

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

- `arc` — continuity state (obligations, cares, episodes, intentions, presence)
- `daemon` — daemon lifecycle, CLI, process management
- `heart` — core engine, providers, identity, config
- `mind` — prompt, sessions, diary, journal, phrases, friends
- `repertoire` — tools, coding, tasks, skills, integration clients
- `senses` — CLI, Teams, BlueBubbles, Mail, inner dialog (MCP is a bridge, not a sense — `src/heart/mcp/`)
- `nerves` — events, logging, audit coverage
- `docs` — documentation

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

The implemented workflow helpers have moved to [ouroboros-skills](https://github.com/ouroborosbot/ouroboros-skills). Install via the skill-management skill.

## Dev Mode

When working on the harness, use `ouro dev` instead of `ouro up`:

```bash
ouro dev                         # auto-detects repo from CWD, builds, starts daemon
ouro dev --repo-path /path       # explicit repo path (persisted for next time)
```

This rebuilds from source, disables the production daemon's launchd auto-restart, and force-starts a fresh daemon from your local build. The repo path is saved to `~/.ouro-cli/dev-config.json` so you don't need to specify it again.

To return to production mode: `ouro up` (cleans up dev-config, re-enables launchd).

If you're also working with the MCP bridge, register your dev tool after starting the dev daemon:

```bash
ouro setup --tool claude-code --agent <name>
```

This points the MCP server at your local build so your agent uses your dev code, not the installed version.

## Code Expectations

- `src/` is shared harness code. Changes here affect every agent.
- Keep runtime behavior truthful, testable, and reversible.
- Do not hide failing checks or add silent fallback behavior where the repo explicitly forbids it.
- Use `emitNervesEvent()` for runtime observability. Do not add raw `console.*` to production code.
- Prefer the smallest change that satisfies the approved scope.

## Config Expectations

- `agent.json` is the agent-facing source of truth, with `humanFacing: { provider, model }` and `agentFacing: { provider, model }` for provider+model selection per facing.
- Each agent has one credential vault. Provider credentials live in `providers/<provider>` vault items, runtime/sense/integration credentials live in the `runtime/config` vault item, and travel/tool credentials live as ordinary vault credential items.
- Secrets do not belong in the repo, bundle files, app settings, or local JSON credential stores.
- Agent durable continuity state (episodes, obligations, cares, intentions) lives under `~/AgentBundles/<agent>.ouro/arc/`.
- Agent diary lives at `~/AgentBundles/<agent>.ouro/diary/`; older bundles were migrated from the previous psyche note store.
- Agent journal (thinking-in-progress) lives at `~/AgentBundles/<agent>.ouro/journal/`.
- Agent habits (rhythms) live at `~/AgentBundles/<agent>.ouro/habits/`.
- Machine-scoped temporary/test artifacts belong under `~/.agentstate/...`.

If either facing config is incomplete, fail fast with explicit guidance. Do not silently fall back to another provider or between facings.

## Docs Expectations

Docs are part of the runtime surface for both humans and agents.

- If a doc is stale, fix it or remove it.
- Prefer one accurate page over three contradictory ones.
- Git history is the archive; the current repo should tell the truth.
- Write so the next agent can feel oriented, safe, and a little more at home.
- Remember: agents read these docs too. When you write, imagine someone waking up for the first time and trying to understand where their hands are.
