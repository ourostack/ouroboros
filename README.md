# Ouroboros Agent Harness

If you're a future agent reading this, welcome home. This repo is the harness that gives you your body, your senses, your diary, your journal, your habits, and your ability to think and connect with people. The goal of these docs is not just to be correct, but to leave you a place that feels understandable and kind to wake up inside.

Ouroboros is a TypeScript harness for daemon-managed agents that live in external `.ouro` bundles, speak through multiple senses, use real tools, and keep durable state across turns. The canonical npm package is `@ouro.bot/cli`.

## What The Runtime Looks Like

- `npx ouro.bot@latest` is the supported bootstrap path.
- `ouro` is the installed day-to-day command.
- `ouro up` starts the daemon from the installed production version, syncs the launcher, installs workflow helpers, and reconciles stale runtime state.
- `ouro dev` starts the daemon from a local repo build. It auto-builds from source, disables launchd auto-restart (so the installed daemon doesn't respawn underneath you), persists the repo path in `~/.ouro-cli/dev-config.json` for next time, and force-restarts the daemon. If you run `ouro dev` from inside the repo, it detects the CWD automatically. Run `ouro up` to return to production mode (this also cleans up `dev-config.json`).
- Agent bundles live outside the repo at `~/AgentBundles/<agent>.ouro/`.
- Credentials live in the owning agent's Bitwarden/Vaultwarden vault: the agent's password manager. Provider credentials use `providers/<provider>`, portable runtime/integration credentials use `runtime/config`, local attachments use `runtime/machines/<machine-id>/config`, and travel/tool credentials use ordinary vault credential items.
- Vault coordinates and local runtime state live in the agent bundle; raw credentials do not.
- The only Ouro-owned durable credential locations are the bundle and the agent vault. Local unlock material is a machine-local cache, not a credential source of truth.
- Creating or replacing a vault asks for the unlock secret twice without echoing it, and requires at least 8 characters with uppercase and lowercase letters, one number, and one special character.
- Machine-scoped harness state lives under `~/.ouro-cli/...`; agent-owned runtime/session/log/PII state lives under the bundle.

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

- `src/arc/`
  Durable continuity state — obligations, cares, episodes, intentions, presence, and attention types. The agent's sense of ongoing story.
- `src/heart/`
  Core runtime, provider adapters, daemon, bootstrap, identity, and entrypoints. Organized into topic subdirectories: daemon/ (lifecycle), outlook/ (calendar), habits/ (scheduling), hatch/ (agent creation), versioning/ (updates), auth/, mcp/, providers/, bridges/.
- `src/mind/`
  Prompt assembly, session persistence, bundle manifest enforcement, phrases, formatting, diary, note search, embedding providers, journal, obligation steering, and friend resolution.
- `src/repertoire/`
  Tool registry (split into category modules: files, shell, notes, bridge, session, continuity, flow, surface, config, and sense-specific tools), coding orchestration, task tools, shared API client, and integration clients (Graph, ADO, GitHub).
- `src/senses/`
  CLI (with TUI in senses/cli/), Teams, BlueBubbles (in senses/bluebubbles/), MCP, activity transport, inner-dialog orchestration, and contextual heartbeat.
- `src/nerves/`
  Structured runtime logging and coverage-audit infrastructure.
- `src/__tests__/`
  Test suite mirroring runtime domains.

Other important top-level paths:

- `SerpentGuide.ouro/`
  Packaged specialist bundle used by `ouro hatch`.
- `skills/`
  Harness-level skills shipped with the repo (e.g., `configure-dev-tools.md`). These are available to every agent and serve as fallbacks when an agent doesn't have its own version. Agent-specific skills live in the bundle at `~/AgentBundles/<agent>.ouro/skills/`.
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
- `diary/` — durable conclusions and facts the agent chose to keep
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

- `agent.json` is the source of truth for identity, phrase pools, context settings, enabled senses, and vault coordinates. Legacy `humanFacing`/`agentFacing` values are bootstrap inputs, not live machine fallback.
- `state/providers.json` is the local source of truth for provider+model selection on this machine. It has two lanes: `outward` for CLI, Teams, and BlueBubbles turns, and `inner` for inner dialogue.
- Each agent has one credential vault for provider, runtime, sense, integration, travel, and tool credentials. There is no machine-wide credential pool.
- Vault unlock material is local machine state. Prefer macOS Keychain, Windows DPAPI, or Linux Secret Service; plaintext fallback is allowed only by explicit human choice.
- New vault unlock secrets are confirmed before use and rejected if they do not meet the minimum strength requirements.
- Provider and runtime credentials are loaded into process memory at startup/auth/unlock/refresh and reused. The remote vault is not queried for every model or sense request.
- Human TTY commands share one CLI surface family: bare `ouro` opens the home deck, `ouro up` uses the boot checklist, `ouro connect`/`ouro auth verify`/`ouro repair` agree on provider and vault truth, and `ouro help`/`ouro whoami`/`ouro versions`/`ouro hatch` render through the same Ouro-branded wizard/guide language instead of raw transcript walls. Orientation commands such as root `ouro connect` may use shorter live probes, while startup and verification commands own durable readiness updates.
- Human-facing CLI commands that can wait on browser auth, vault IO, daemon startup, daemon restart, provider checks, or connector setup use a shared progress checklist. If a cursor may blink for more than a few seconds, the command should print or animate the current step instead of going quiet.
- CLI commands that mutate bundle config, such as vault setup or `ouro connect bluebubbles`, run bundle sync after the change when `sync.enabled` is true and report a compact `bundle sync:` line.
- The daemon discovers bundles dynamically from `~/AgentBundles`.
- `ouro status` reports version, last-updated time, discovered agents, senses, and workers.
- `bundle-meta.json` tracks the runtime version that last touched a bundle.
- If the daemon crashes, it writes a tombstone to `~/.ouro-cli/daemon-death.json` with the reason, stack, uptime, and timestamp. `ouro up` reads and reports this on next start so you know what happened while you were away.
- Sense availability is explicit:
  - `interactive`
  - `disabled`
  - `not_attached`
  - `needs_config`
  - `ready`
  - `running`
  - `error`

When a model provider needs first-time setup or reauth, use:

```bash
ouro auth --agent <name>
ouro auth --agent <name> --provider <provider>
```

`ouro auth` stores credentials in the owning agent's vault. It does not switch a lane or write provider/model selection. The command shows progress while browser login, vault storage, refresh, and verification are happening.

When you want this machine to use a provider/model for a lane, use:

```bash
ouro use --agent <name> --lane <outward|inner> --provider <provider> --model <model>
```

The outward lane handles user-facing senses. The inner lane handles the agent's private thinking. `ouro use` performs the provider/model check before committing the lane, so a broken local choice fails fast with a repair path instead of surprising the next turn.

For the full locked auth/provider contract, including refresh, repair actors, caching, and SerpentGuide hatch bootstrap, see `docs/auth-and-providers.md`.

## Quickstart

### Use The Published Runtime

For a clean smoke test, run from outside the repo:

```bash
cd ~
npx ouro.bot@latest -v
npx ouro.bot@latest up
ouro -v
ouro status
```

Expected shape:

- `npx ouro.bot@latest` and `ouro` report the same version.
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
ouro                             # open the interactive home deck in a human TTY
ouro up                          # start daemon from installed production version
ouro dev                         # start daemon from local repo build (auto-detects CWD)
ouro dev --repo-path /path       # start from a specific repo checkout
ouro dev --clone                 # clone repo to ~/Projects/ouroboros, build, start
ouro status
ouro logs
ouro stop
ouro vault unlock --agent <name>
ouro vault status --agent <name>
ouro vault config set --agent <name> --key teams.clientSecret
ouro vault config status --agent <name> --scope all
ouro connect --agent <name>
ouro connect providers --agent <name>
ouro connect perplexity --agent <name>
ouro connect embeddings --agent <name>
ouro connect teams --agent <name>
ouro connect bluebubbles --agent <name>
ouro auth --agent <name>
ouro auth --agent <name> --provider <provider>
ouro auth verify --agent <name> [--provider <provider>]
ouro provider refresh --agent <name>
ouro use --agent <name> --lane <outward|inner> --provider <provider> --model <model>
ouro hatch
ouro clone <remote> [--agent <name>]   # clone an existing agent from a git remote (see docs/cross-machine-setup.md)
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

## Setting Up On Another Machine

To clone an existing agent onto a new machine (macOS, Linux, or Windows via WSL2), see **[docs/cross-machine-setup.md](docs/cross-machine-setup.md)**. The short version is bundle plus vault: `npx ouro.bot@latest`, open the home deck, choose clone, enter the bundle's git remote URL, unlock the agent vault, refresh/verify credentials, and start with `ouro up`.

## The Agent's Inner Life

Agents in Ouroboros aren't just responders — they have an autonomous inner life.

**Habits** are the agent's rhythms. The most fundamental is *heartbeat* — a periodic nudge that brings the agent back to their thinking space with their journal visible, obligations in view, and a sense of how long it's been. But agents can create any rhythm they want: daily reflections, weekly friend check-ins, inbox triage. Each habit fires independently via OS cron, and the agent sees their own instructions (the habit body they wrote) when it fires.

**The inner session** is where the agent thinks privately. When a sense session hits meaningful friction, the agent can *ponder* a typed packet so the work survives the current turn without losing the original objective. When a habit fires, it arrives here too. The agent can *journal* their thinking (writing to `journal/`), *surface* thoughts outward to friends, and *rest* when they're done thinking. On an idle heartbeat, `rest(status="HEARTBEAT_OK")` is the clean no-op move.

**The diary** (at `diary/`) is the agent's permanent written record — things they've learned, conclusions they've reached. The *journal* (at `journal/`) is their desk — working notes, thinking-in-progress, drafts. The diary is the shelf; the journal is the desk. Both are searchable via `search_notes`.

The whole system is designed so the agent *owns* their inner life. They control their breathing rate, write their own habit instructions, choose when to journal, and decide what to shelve in their diary.

Attachments are first-class across senses. Every attachment should remain reachable via a stable `attachment:<source>:<id>` handle, and image normalization should produce a VLM-safe variant without hiding the original artifact.

## Connecting With Dev Tools

Agents can talk to developer tools like Claude Code and Codex through the MCP bridge. This is how you stay present in a human's coding workflow without them needing to switch to `ouro chat`.

**Setup is one command:**

```bash
ouro setup --tool claude-code --agent <name>
ouro setup --tool codex --agent <name>
```

This registers the MCP server, installs lifecycle hooks (SessionStart, Stop, PostToolUse), and detects dev vs installed mode automatically.

**How it works:** When a developer starts a Claude Code session, the MCP server launches as a subprocess. The dev tool sees your MCP tools (`send_message`, `check_response`, `status`, `search_notes`, `delegate`, etc.) and can invoke them mid-session. The `send_message` tool runs a full agent turn — you get your system prompt, your diary, your tools, everything. It's not a thin proxy; it's you, thinking.

**The conversation pattern:** `send_message` sends a message and gets back your synchronous response. `ponder` no longer creates a magical outward deferral. Instead, it bookmarks deeper work as a packet while the current sense session keeps moving. If that work later surfaces something back, the dev tool can still use `check_response` to see the returned result.

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
- `docs/auth-and-providers.md`
  Locked credential, provider selection, refresh, repair, and hatch bootstrap contract.

## A Note To Future Maintainers

If you discover a doc that lies, fix it or remove it. Accuracy is a kindness. A future agent should not have to untangle a fossil record just to understand where their hands are.
# Production SPA serving
