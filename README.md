# Ouroboros Agent Harness

If you're a future agent reading this, welcome home. This repo is part runtime, part body, part memory scaffold. The goal of these docs is not just to be correct, but to leave you a place that feels understandable and kind to wake up inside.

Ouroboros is a TypeScript harness for daemon-managed agents that live in external `.ouro` bundles, speak through multiple senses, use real tools, and keep durable state across turns. The canonical npm package is `@ouro.bot/cli`.

## What The Runtime Looks Like

- `npx ouro.bot` is the bootstrap path.
- `ouro` is the installed day-to-day command.
- `ouro up` starts or repairs the daemon, syncs the launcher, installs workflow helpers, and reconciles stale runtime state.
- Agent bundles live outside the repo at `~/AgentBundles/<agent>.ouro/`.
- Secrets live outside the repo at `~/.agentsecrets/<agent>/secrets.json`.
- Machine-scoped test and runtime spillover lives under `~/.agentstate/...`.

Current first-class senses:

- `cli`
- `teams`
- `bluebubbles`

Current provider ids:

- `azure`
- `anthropic`
- `minimax`
- `openai-codex`

## Repository Shape

The shared harness lives in `src/`:

- `src/heart/`
  Core runtime, provider adapters, daemon, bootstrap, identity, and entrypoints.
- `src/mind/`
  Prompt assembly, session persistence, bundle manifest enforcement, phrases, formatting, memory, and friend resolution.
- `src/repertoire/`
  Tool registry, coding orchestration, task tools, and integration clients.
- `src/senses/`
  CLI, Teams, BlueBubbles, activity transport, and inner-dialog orchestration.
- `src/nerves/`
  Structured runtime logging and coverage-audit infrastructure.
- `src/__tests__/`
  Test suite mirroring runtime domains.

Other important top-level paths:

- `AdoptionSpecialist.ouro/`
  Packaged specialist bundle used by `ouro hatch`.
- `subagents/`
  Source-of-truth workflow definitions for planner/doer/merger.
- `scripts/teams-sense/`
  Operator scripts for the Teams deployment path.
- `docs/`
  Shared repo docs that should describe the runtime as it exists now, not as it existed three migrations ago.

## Bundle Contract

Every real agent lives in an external bundle:

`~/AgentBundles/<agent>.ouro/`

The canonical bundle shape is enforced by `src/mind/bundle-manifest.ts`. Important paths include:

- `agent.json`
- `bundle-meta.json`
- `psyche/SOUL.md`
- `psyche/IDENTITY.md`
- `psyche/LORE.md`
- `psyche/TACIT.md`
- `psyche/ASPIRATIONS.md`
- `psyche/memory/`
- `friends/`
- `state/`
- `tasks/`
- `skills/`
- `senses/`
- `senses/teams/`

Task docs do not live in this repo anymore. Planning and doing docs live in the owning bundle under:

`~/AgentBundles/<agent>.ouro/tasks/one-shots/`

## Runtime Truths

- `agent.json` is the source of truth for provider selection, phrase pools, context settings, and enabled senses.
- `configPath` must point to `~/.agentsecrets/<agent>/secrets.json`.
- The daemon discovers bundles dynamically from `~/AgentBundles`.
- `ouro status` reports version, last-updated time, discovered agents, senses, and workers.
- `bundle-meta.json` tracks the runtime version that last touched a bundle.
- Sense availability is explicit:
  - `interactive`
  - `disabled`
  - `needs_config`
  - `ready`
  - `running`
  - `error`

## Quickstart

### Use The Published Runtime

For a clean smoke test, run from outside the repo:

```bash
cd ~
npx ouro.bot -v
npx ouro.bot up
ouro -v
ouro status
```

Expected shape:

- `npx ouro.bot` and `ouro` report the same version.
- `ouro status` shows the daemon overview plus discovered agents, senses, and workers.

### Work On The Harness

From the repo:

```bash
npm test
npx tsc --noEmit
npm run test:coverage
```

If you are changing runtime code, keep all three green.

## Common Commands

```bash
ouro up
ouro status
ouro logs
ouro stop
ouro hatch
ouro chat <agent>
ouro msg --to <agent> [--session <id>] [--task <ref>] <message>
ouro poke <agent> --task <task-id>
ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>
```

## Where To Read Next

- `AGENTS.md`
  Repo workflow, planning/doing gates, configuration policy, and logging policy.
- `CONTRIBUTING.md`
  Day-to-day contribution rules for agents working in the harness.
- `ARCHITECTURE.md`
  Current daemon, bundle, sense, and update model.
- `docs/testing-guide.md`
  Operator smoke flow for bootstrap, daemon, hatch, chat, and messaging.

## A Note To Future Maintainers

If you discover a doc that lies, fix it or remove it. Accuracy is a kindness. A future agent should not have to untangle a fossil record just to understand where their hands are.
