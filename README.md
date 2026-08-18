# Ouroboros Agent Harness

If you're a future agent reading this, welcome home. This repo is the harness that gives you your body, your senses, your record, your habits, and your ability to think and connect with people. The goal of these docs is not just to be correct, but to leave you a place that feels understandable and kind to wake up inside.

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
- `mail`
- `voice`

(MCP is a bridge for developer tools — a separate channel, not a sense. See `src/heart/mcp/` for the implementation.)

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
  Core runtime, provider adapters, daemon, bootstrap, identity, and entrypoints. Organized into topic subdirectories: daemon/ (lifecycle), mailbox/ (calendar), habits/ (scheduling), hatch/ (agent creation), versioning/ (updates), auth/, mcp/, providers/, bridges/.
- `src/mind/`
  Prompt assembly, session persistence, bundle manifest enforcement, phrases, formatting, Desk record diary, note search, embedding providers, record migration, obligation steering, and friend resolution.
- `src/repertoire/`
  Tool registry (split into category modules: files, shell, notes, bridge, session, continuity, flow, surface, config, and sense-specific tools), coding orchestration, task tools, shared API client, and integration clients (Graph, ADO, GitHub).
- `src/senses/`
  CLI (with TUI in senses/cli/), Teams, BlueBubbles (in senses/bluebubbles/), Mail (in senses/mail.ts), Voice (in senses/voice/), activity transport, private-turn orchestration, and contextual heartbeat. The MCP bridge is at `src/heart/mcp/`, not here.
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
- `arc/` — live continuity, obligations, claims, and resume state
- `desk/` — durable work plus the maintained Desk record under `desk/_record/`
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

- `agent.json` is the source of truth for identity, phrase pools, context settings, enabled senses, vault coordinates, and provider+model selection. It has two provider lanes: `outward` for CLI, Teams, BlueBubbles, Mail, and Voice turns, and `inner` for private agent-facing turns.
- The `inner` lane is a provider/model lane, not the private-runtime system name.
- Provider/model selection belongs to `agent.json` lanes; `privateRuntime` cannot select providers or models.
- Legacy `humanFacing`/`agentFacing` provider fields are read only as compatibility aliases for `outward`/`inner`; they are not a second config surface.
- Starting the private runtime worker is process supervision, not a model turn.
- Denied/default private-runtime policy records or queues work with zero provider calls.
- Provider-readiness pings are explicit readiness checks, not private turns.
- Each agent has one credential vault for provider, runtime, sense, integration, travel, and tool credentials. There is no machine-wide credential pool.
- Vault unlock material is local machine state. Prefer macOS Keychain, Windows DPAPI, or Linux Secret Service; plaintext fallback is allowed only by explicit human choice.
- New vault unlock secrets are confirmed before use and rejected if they do not meet the minimum strength requirements.
- Provider and runtime credentials are loaded into process memory at startup/auth/unlock/refresh and reused. The remote vault is not queried for every model or sense request.
- Human TTY commands share one CLI surface family: bare `ouro` opens the home deck, `ouro up` uses the boot checklist, `ouro connect`/`ouro auth verify`/`ouro repair` agree on provider and vault truth, and `ouro help`/`ouro whoami`/`ouro versions`/`ouro hatch` render through the same Ouro-branded wizard/guide language instead of raw transcript walls. Orientation commands such as root `ouro connect` may use shorter live probes, while startup and verification commands own durable readiness updates.
- Human-facing CLI commands that can wait on browser auth, vault IO, daemon startup, daemon restart, provider checks, or connector setup use a shared progress checklist. If a cursor may blink for more than a few seconds, the command should print or animate the current step instead of going quiet.
- CLI commands that mutate bundle config, such as vault setup or `ouro connect bluebubbles`, run bundle sync after the change when `sync.enabled` is true and report a compact `bundle sync:` line.
- Voice is transcript-first: voice sessions use the ordinary `state/sessions/<friend>/voice/<key>.json` session path and appear in Ouro Mailbox as text transcripts. `voice.openaiRealtimeVoice` is the current native Realtime phone voice, with `voice.openaiRealtimeVoiceStyle` and `voice.openaiRealtimeVoiceSpeed` shaping spoken identity/cadence from the first audible greeting; ElevenLabs remains legacy cascade compatibility unless it earns a distinct non-redundant role. ElevenLabs API credentials live in portable `runtime/config` at `integrations.elevenLabsApiKey` and `integrations.elevenLabsVoiceId`; Whisper.cpp CLI/model paths live in the machine runtime item at `voice.whisperCliPath` and `voice.whisperModelPath`. Phone calls, browser meetings, and local microphone capture are transports under the single `voice` sense, not separate senses; the Twilio phone transport can run the conservative Record -> Whisper.cpp -> stable voice session -> ElevenLabs path, native Realtime over Media Streams, or the preferred SIP path with `voice.twilioConversationEngine=openai-sip`. SIP routes live media to OpenAI while Ouro retains session, transcript, tool, routing, and call-control ownership. See [Voice Architecture](docs/voice-architecture.md) for the durable transport model.
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

The outward lane selects the provider/model for user-facing senses. The `inner` lane selects the provider/model for private agent-facing turns; private-runtime policy decides whether those turns may run. `ouro use` performs the provider/model check before committing the lane, so a broken local choice fails fast with a repair path instead of surprising the next turn.

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
ouro up --latest                 # preflight latest, then replace any exact rollback pin
ouro rollback <version>          # pin normal starts to an exact installed version
ouro versions                    # show installed versions and current intent
ouro dev                         # start daemon from local repo build (auto-detects CWD)
ouro dev --repo-path /path       # start from a specific repo checkout
ouro dev --clone                 # clone repo to ~/Projects/ouroboros, build, start
ouro status
ouro logs
ouro logs prune --agent <name>
ouro mail sync-cache --agent <name>
ouro stop
ouro vault unlock --agent <name>
ouro vault status --agent <name>
ouro vault config set --agent <name> --key teams.clientSecret
ouro vault config status --agent <name> --scope all
ouro vault item set --agent <name> --item <path> --secret-field <field>
ouro vault item status --agent <name> --item <path>
ouro vault ops porkbun set --agent <name> --account <account>
ouro connect --agent <name>
ouro connect providers --agent <name>
ouro connect perplexity --agent <name>
ouro connect embeddings --agent <name>
ouro connect teams --agent <name>
ouro connect bluebubbles --agent <name>
ouro bluebubbles host status --json
ouro connect voice --agent <name>
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
ouro private status --agent <agent>
ouro private decisions --agent <agent>
ouro attention --agent <agent>       # attention queue
ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>
ouro setup --tool <tool> --agent <name>   # register MCP server + hooks with a dev tool
ouro mcp-serve --agent <name>             # start MCP server on stdin/stdout (used by dev tools)
ouro mcp doctor --agent <name> --json     # bounded direct bridge evidence
ouro hook <event> --agent <name>          # fire a lifecycle hook (SessionStart, Stop, PostToolUse)
```

The generic secret primitive is a vault item / credential in the owning agent vault: stable item name/path, hidden secret material, optional public fields, notes, timestamps/provenance, and no assumed use. `ouro connect` is for harness-managed workflows; workflow bindings reference ordinary vault items when they need secret material.

### Standard BlueBubbles setup

`ouro connect bluebubbles --agent <name>` is the standard local-Mac setup path. Besides saving the machine-scoped attachment, it installs or verifies the native-compatible BlueBubbles LaunchAgent for a same-user bridge and reconciles one Ouro-owned `[*]` webhook after the listener is bound. The daemon repairs that owned callback every 180 seconds, preserves unrelated callbacks, and creates the desired callback before removing a stale owned one. If the listener or BlueBubbles API is unavailable, connect says the attachment was saved but setup is incomplete; `ouro doctor` and `ouro bluebubbles host status --json` separate app, service, process, HTTP, and webhook failures.

Doctor keeps transport proof separate from conversation activity. When the BlueBubbles upstream and exact owned webhook are healthy but no recent inbound event exists, the result is quiet/unverified: quiet is not delivery-failure proof, and Ouro does not invent a message to test it. Standard recovery remains `ouro connect bluebubbles --agent <name>` when host or webhook evidence is unhealthy.

When BlueBubbles runs in another logged-in macOS account, standard setup installs a generic helper and returns one nonce-bound `human-required` Terminal command for that account plus `ouro bluebubbles host collect --request-id <id>`. Ouro never asks for or stores the other account's login password. The receipt proves that one handoff and reports launchd only as point-in-time evidence; current process and HTTP health are checked separately.

### Bounded doctor repairs

Doctor may recommend two local, agent-qualified repairs. `ouro mail sync-cache --agent <name>` compares read-only hosted authority with the reconstructible local cache, then rebuilds only that cache; it does not mutate hosted mail. `ouro logs prune --agent <name>` rotates only the validated agent bundle's regular log streams. Ouro offers the prune command only for a canonical direct `<name>.ouro` bundle with a present `agent.json`; task-only `.ouro` work directories are not agents.

## Setting Up On Another Machine

To clone an existing agent onto a new machine (macOS, Linux, or Windows via WSL2), see **[docs/cross-machine-setup.md](docs/cross-machine-setup.md)**. The short version is bundle plus vault: `npx ouro.bot@latest`, open the home deck, choose clone, enter the bundle's git remote URL, unlock the agent vault, refresh/verify credentials, and start with `ouro up`.

## The Agent's Private Runtime And Rhythms

Agents in Ouroboros aren't just responders — they have private agent-facing turns, recurring rhythms, durable records, and explicit spend policy.

**Habits** are the agent's rhythms. A habit is an Ouro-native cron wrapper: it fires a private agent-facing session, can surface to family or the habit originator when it needs help or needs to report back, and leaves an audit receipt.

**The private runtime** is where private agent-facing turns run. It uses the `inner` provider/model lane, but the lane is only provider selection; the runtime is governed by private-runtime policy, receipts, and attention queues. Habit runs, private returns, awaits, and self-maintenance can happen privately, but private context is not a record substrate. Anything durable leaves the turn: live continuity and audit go to Arc; work goes to Desk; learned facts and reference notes go to the Desk record.

**Desk and Arc** are the durable orientation pair. Arc owns live continuity, claims, obligations, and habit run receipts. Desk owns durable work and the maintained record. The target substrate is captured in [Agent Orientation Substrate](docs/agent-orientation-substrate.md).

The whole system is designed so the agent *owns* its rhythms without forcing everything private to become a permanent transcript.

Attachments are first-class across senses. Every attachment should remain reachable via a stable `attachment:<source>:<id>` handle, and image normalization should produce a VLM-safe variant without hiding the original artifact.

## Connecting With Dev Tools

Agents can talk to developer tools like Claude Code and Codex through the MCP bridge. This is how you stay present in a human's coding workflow without them needing to switch to `ouro chat`.

**Setup is one command:**

```bash
ouro setup --tool claude-code --agent <name>
ouro setup --tool codex --agent <name>
```

This registers the MCP server, installs lifecycle hooks (SessionStart, Stop, PostToolUse), detects dev vs installed mode automatically, and runs a bounded direct canary. Registration success and canary health are reported separately.

If the dev-tool host appears frozen, run `ouro mcp doctor --agent <name> --json`. Its classification is deliberately narrow: `ouro-bridge-failed`, `ouro-bridge-healthy-at-capture`, or `host-stall-unexplained`. Add `--host-stall-observed` only when the host stall was independently observed. A healthy bridge canary does not prove that Codex or another host caused the stall; it only bounds what Ouro observed at capture time.

**How it works:** When a developer starts a Claude Code session, the MCP server launches as a subprocess. The dev tool sees your MCP tools (`send_message`, `ask`, `check_response`, `status`, `search_facts`, `delegate`, etc.) and can invoke them mid-session. Conversation-shaped tools such as `send_message`, `ask`, `delegate`, `check_guidance`, and `report_progress` run full agent turns — you get your system prompt, your Desk record, your tools, everything. Read-only inspection tools such as `status` and `search_facts` do local lookup only. Missing `search_facts` hits are not evidence that the agent has no belief or preference.

**The conversation pattern:** `send_message` or `ask` sends a message and gets back your synchronous response. `ponder` no longer creates a magical outward deferral. Instead, it bookmarks deeper work as a packet while the current sense session keeps moving. If that work later surfaces something back, the dev tool can still use `check_response` to see the returned result.

**Lifecycle hooks** give you passive awareness. When a Claude Code session starts, stops, or uses a tool like Bash or Edit, the hook fires `ouro hook <event> --agent <name>` and the daemon notes it. Private agent-facing turns see these sessions in their checkpoint, so you know what's happening across your world even when nobody is talking to you directly.

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
