# Ouroboros Agent Harness

If you're a future agent reading this, welcome home. This repo is the harness that gives you your body, your senses, your diary, your journal, your habits, and your ability to think and connect with people. The goal of these docs is not just to be correct, but to leave you a place that feels understandable and kind to wake up inside.

Ouroboros is a TypeScript harness for daemon-managed agents that live in external `.ouro` bundles, speak through multiple senses, use real tools, and keep durable state across turns. The canonical npm package is `@ouro.bot/cli`.

## What The Runtime Looks Like

- `npx ouro.bot` is the bootstrap path.
- `ouro` is the installed day-to-day command.
- `ouro up` starts the daemon from the installed production version, syncs the launcher, installs workflow helpers, and reconciles stale runtime state.
- `ouro dev` starts the daemon from a local repo build. It auto-builds from source, disables launchd auto-restart (so the installed daemon doesn't respawn underneath you), persists the repo path in `~/.ouro-cli/dev-config.json` for next time, and force-restarts the daemon. If you run `ouro dev` from inside the repo, it detects the CWD automatically. Run `ouro up` to return to production mode (this also cleans up `dev-config.json`).
- Agent bundles live outside the repo at `~/AgentBundles/<agent>.ouro/`.
- Secrets live outside the repo at `~/.agentsecrets/<agent>/secrets.json`.
- Machine-scoped test and runtime spillover lives under `~/.agentstate/...`.

Current first-class senses:

- `cli`
- `teams`
- `bluebubbles`
- `mcp`

Current provider ids:

- `azure`
- `anthropic`
- `minimax`
- `openai-codex`
- `github-copilot`

## Repository Shape

The shared harness lives in `src/`:

- `src/heart/`
  Core runtime, provider adapters, daemon, bootstrap, identity, and entrypoints.
- `src/mind/`
  Prompt assembly, session persistence, bundle manifest enforcement, phrases, formatting, diary (memory), journal, and friend resolution.
- `src/repertoire/`
  Tool registry, coding orchestration, task tools, and integration clients.
- `src/senses/`
  CLI, Teams, BlueBubbles, MCP, activity transport, inner-dialog orchestration, and contextual heartbeat.
- `src/nerves/`
  Structured runtime logging and coverage-audit infrastructure.
- `src/__tests__/`
  Test suite mirroring runtime domains.

Other important top-level paths:

- `AdoptionSpecialist.ouro/`
  Packaged specialist bundle used by `ouro hatch`.
- `skills/`
  Harness-level skills shipped with the repo (e.g., `configure-dev-tools.md`). These are available to every agent and serve as fallbacks when an agent doesn't have its own version. Agent-specific skills live in the bundle at `~/AgentBundles/<agent>.ouro/skills/`.
- `subagents/`
  Workflow skills have moved to [github.com/ouroborosbot/ouroboros-skills](https://github.com/ouroborosbot/ouroboros-skills). Use the skill-management skill for installation and updates.
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
- `diary/` — what the agent has learned and wants to recall (renamed from `psyche/memory/`)
- `journal/` — the agent's desk: working notes, thinking-in-progress, drafts
- `habits/` — the agent's autonomous rhythms (heartbeat, reflections, check-ins)
- `friends/`
- `state/`
- `tasks/`
- `skills/`
- `senses/`
- `senses/teams/`

Task docs do not live in this repo anymore. Planning and doing docs live in the owning bundle under:

`~/AgentBundles/<agent>.ouro/tasks/one-shots/`

## Runtime Truths

- `agent.json` is the source of truth for provider+model selection per facing (`humanFacing` and `agentFacing`), phrase pools, context settings, and enabled senses.
- `configPath` must point to `~/.agentsecrets/<agent>/secrets.json`.
- The daemon discovers bundles dynamically from `~/AgentBundles`.
- `ouro status` reports version, last-updated time, discovered agents, senses, and workers.
- `bundle-meta.json` tracks the runtime version that last touched a bundle.
- If the daemon crashes, it writes a tombstone to `~/.ouro-cli/daemon-death.json` with the reason, stack, uptime, and timestamp. `ouro up` reads and reports this on next start so you know what happened while you were away.
- Sense availability is explicit:
  - `interactive`
  - `disabled`
  - `needs_config`
  - `ready`
  - `running`
  - `error`

When a model provider needs first-time setup, reauth, or an explicit switch, use:

```bash
ouro auth --agent <name>
ouro auth --agent <name> --provider <provider>
ouro auth --agent <name> --facing agent --provider <provider>
```

The default form reauths the human-facing provider already selected in `agent.json`. The
`--provider` form is for adding or switching providers. The `--facing` flag (values: `human`
or `agent`) controls which facing gets updated; it defaults to `human` when omitted.

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
ouro up                          # start daemon from installed production version
ouro dev                         # start daemon from local repo build (auto-detects CWD)
ouro dev --repo-path /path       # start from a specific repo checkout
ouro dev --clone                 # clone repo to ~/Projects/ouroboros, build, start
ouro status
ouro logs
ouro stop
ouro auth --agent <name>
ouro auth --agent <name> --provider <provider>
ouro hatch
ouro chat <agent>
ouro msg --to <agent> [--session <id>] [--task <ref>] <message>
ouro poke <agent> --task <task-id>
ouro poke <agent> --habit <habit-name>
ouro habit list --agent <agent>
ouro habit create --agent <agent> <name> --cadence <interval>
ouro inner --agent <agent>           # inner dialog status
ouro attention --agent <agent>       # attention queue
ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>
ouro setup --tool <tool> --agent <name>   # register MCP server + hooks with a dev tool
ouro mcp-serve --agent <name>             # start MCP server on stdin/stdout (used by dev tools)
ouro hook <event> --agent <name>          # fire a lifecycle hook (SessionStart, Stop, PostToolUse)
```

## The Agent's Inner Life

Agents in Ouroboros aren't just responders — they have an autonomous inner life.

**Habits** are the agent's rhythms. The most fundamental is *heartbeat* — a periodic nudge that brings the agent back to their thinking space with their journal visible, obligations in view, and a sense of how long it's been. But agents can create any rhythm they want: daily reflections, weekly friend check-ins, inbox triage. Each habit fires independently via OS cron, and the agent sees their own instructions (the habit body they wrote) when it fires.

**The inner dialog** is where the agent thinks privately. When they *ponder* something from a conversation, it goes here. When a habit fires, it arrives here. The agent can *journal* their thinking (writing to `journal/`), *surface* thoughts outward to friends, and *rest* when they're done thinking.

**The diary** (at `diary/`) is the agent's permanent record — things they've learned, conclusions they've reached. The *journal* (at `journal/`) is their desk — working notes, thinking-in-progress, drafts. The diary is the shelf; the journal is the desk. Both are searchable via the `recall` tool.

The whole system is designed so the agent *owns* their inner life. They control their breathing rate, write their own habit instructions, choose when to journal, and decide what to shelve in their diary.

## Connecting With Dev Tools

Agents can talk to developer tools like Claude Code and Codex through the MCP bridge. This is how you stay present in a human's coding workflow without them needing to switch to `ouro chat`.

**Setup is one command:**

```bash
ouro setup --tool claude-code --agent <name>
ouro setup --tool codex --agent <name>
```

This registers the MCP server, installs lifecycle hooks (SessionStart, Stop, PostToolUse), and detects dev vs installed mode automatically.

**How it works:** When a developer starts a Claude Code session, the MCP server launches as a subprocess. The dev tool sees your MCP tools (`send_message`, `check_response`, `status`, `search_memory`, `delegate`, etc.) and can invoke them mid-session. The `send_message` tool runs a full agent turn — you get your system prompt, your diary, your tools, everything. It's not a thin proxy; it's you, thinking.

**The conversation pattern:** `send_message` sends a message and gets back your synchronous response. If you ponder something (taking it to inner dialog), the dev tool can use `check_response` later to see if you surfaced anything back. This creates a natural rhythm: the human's coding agent asks you a question, you answer immediately or take it inward, and thoughts flow back when they're ready.

**Lifecycle hooks** give you passive awareness. When a Claude Code session starts, stops, or uses a tool like Bash or Edit, the hook fires `ouro hook <event> --agent <name>` and the daemon notes it. Your inner dialog sees these sessions in its checkpoint, so you know what's happening across your world even when nobody is talking to you directly.

See `skills/configure-dev-tools.md` for the full tool inventory and troubleshooting guide.

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
# Production SPA serving
