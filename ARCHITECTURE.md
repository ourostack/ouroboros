# Architecture

This document describes the current runtime shape of the Ouroboros harness.

## Core Runtime Model

The harness is daemon-centered.

- `npx ouro.bot` is the bootstrap entrypoint.
- `ouro` is the installed launcher used after bootstrap.
- `ouro up` starts the daemon from the installed production version, repairs stale wrapper state, installs workflow helpers, and replaces the daemon if needed.
- `ouro dev` starts the daemon from a local repo build (for development — skips update checker, always force-restarts).
- The daemon discovers bundles from `~/AgentBundles/*.ouro`.
- Enabled bundles become managed runtime participants.

The important design goal is one coherent runtime truth:

- launcher truth
- daemon truth
- bundle truth
- sense truth

## Runtime Topology

1. Human enters through `npx ouro.bot` or `ouro`.
2. CLI setup verifies launcher, bundle registration, and helper installs.
3. `ouro up` starts the daemon from the installed version; `ouro dev` starts from a local repo build.
4. Daemon discovers bundles under `~/AgentBundles`.
5. Daemon reports:
   - discovered agents
   - senses
   - workers
   - runtime version
   - last updated time
6. Agent work arrives through:
   - `ouro chat`
   - `ouro msg`
   - `ouro poke`
   - daemon-managed senses like Teams and BlueBubbles
   - MCP bridge (dev tools like Claude Code and Codex)
   - lifecycle hooks (SessionStart, Stop, PostToolUse)

## External State Layout

### Agent bundles

`~/AgentBundles/<agent>.ouro/`

Bundle contents are enforced by `src/mind/bundle-manifest.ts`.

Canonical paths:

- `agent.json`
- `bundle-meta.json`
- `psyche/SOUL.md`
- `psyche/IDENTITY.md`
- `psyche/LORE.md`
- `psyche/TACIT.md`
- `psyche/ASPIRATIONS.md`
- `diary/` — durable facts, conclusions, things worth recalling (renamed from `psyche/memory/`; legacy path still works as fallback)
- `journal/` — thinking-in-progress, working notes, drafts (the agent's desk)
- `habits/` — autonomous rhythms: heartbeat, reflections, check-ins (extracted from `tasks/habits/`)
- `friends/`
- `state/`
- `tasks/` — one-shots and ongoing work (habits no longer live here)
- `skills/`
- `senses/`
- `senses/teams/`

### Secrets

`~/.agentsecrets/<agent>/secrets.json`

Secrets stay out of bundles and out of the repo.

### Machine-scoped runtime/test spillover

`~/.agentstate/...`

This is for machine-level artifacts, not bundle-owned identity.

## Bundle Truth

`agent.json` is the runtime-facing contract for:

- provider+model selection per facing (`humanFacing` and `agentFacing`)
- phrases
- context settings
- sense enablement
- `configPath`

`bundle-meta.json` tracks the runtime version that last touched the bundle and supports version-aware behavior on startup.

## Senses

Current senses:

- `cli`
- `teams`
- `bluebubbles`
- `mcp`

Sense status model:

- `interactive`
- `disabled`
- `needs_config`
- `ready`
- `running`
- `error`

The daemon manages daemon-hosted senses and reports them in `ouro status`. CLI remains `interactive` rather than daemon-hosted.

### MCP Sense

The MCP sense is how agents talk to developer tools like Claude Code and Codex. It works like this:

- `ouro mcp-serve --agent <name>` starts a JSON-RPC 2.0 server on stdin/stdout. The dev tool launches this as a subprocess.
- The MCP server exposes tools (e.g., `send_message`, `check_response`, `status`, `search_memory`, `delegate`) that map to daemon commands.
- `send_message` runs a full agent turn via `runSenseTurn()` — the agent gets their complete system prompt, diary, tools, everything. It's not a thin read-only proxy; it's a real conversation turn.
- Sessions are keyed by the dev tool's session ID (e.g., Claude Code's session ID). This means each Claude Code session gets its own conversation thread with the agent.
- Read-only tools like `status` and `search_memory` work even without the daemon running (they read the filesystem directly). Write operations and `send_message` require the daemon.

The `ouro setup --tool <tool> --agent <name>` command handles registration automatically, including lifecycle hooks.

### BlueBubbles-specific behavior

BlueBubbles now uses:

- one persisted chat trunk per chat
- current-turn lane metadata for thread awareness
- agent-chosen outbound lane targeting
- typing/read behavior coordinated through the sense transport

Threads are treated as routing/context metadata, not as separate long-lived memory worlds.

## Subsystems

- `src/heart/`
  Core engine, provider runtimes, identity/config loading, daemon, bootstrap, and entrypoints.
- `src/mind/`
  Prompt assembly, sessions, bundle manifest, diary (memory), journal indexing, phrases, formatting, and friend identity.
- `src/repertoire/`
  Tool registry, coding orchestration, task tooling, skills (agent-level and harness-level), and integration clients.
- `src/senses/`
  CLI, Teams, BlueBubbles, MCP bridge, activity transport, trust gating, inner-dialog worker logic, and contextual heartbeat.
- `src/nerves/`
  Structured runtime events, log rotation, and deterministic audit coverage.

## Tools

Tool access is channel-aware and trust-aware.

- CLI gets the full local harness surface.
- Trusted one-to-one remote contexts can use the feasible local tool surface.
- Shared or untrusted remote contexts stay more constrained.

The metacognitive tool vocabulary:

- **settle** — deliver a response to a friend (outer sessions)
- **ponder** — "I need to think about this" (takes thought inward, or continues thinking)
- **rest** — "I'm putting this down" (inner dialog only, ends the turn)
- **surface** — share a thought outward from inner dialog
- **observe** — stay quiet in group chats
- **diary_write** — record something to the diary for later recall
- **recall** — search both diary and journal for relevant facts and notes

Other important tools include coding session orchestration, bridge management, and BlueBubbles reply-target selection.

### MCP Conversation Channel

The MCP bridge adds bidirectional conversation tools:

- **send_message** — a dev tool sends a message and gets a synchronous agent response (full turn with tools, system prompt, diary — everything)
- **check_response** — polls for pending messages from the agent (e.g., after the agent ponders something and later surfaces a thought back)

This creates a natural conversation rhythm between agents and developer tools. The agent is a full participant, not a thin lookup proxy.

## Habits And Rhythms

Habits are the agent's autonomous rhythms — recurring patterns that fire independently.

- Habits live at `~/AgentBundles/<agent>.ouro/habits/` as simple markdown files.
- Each habit has: title, cadence (e.g., `"30m"`, `"1d"`), status (`active`/`paused`), lastRun, created, and a body (the agent's instructions to themselves).
- The `HabitScheduler` registers each active habit as an OS cron entry (launchd on macOS, crontab on Linux).
- When a cron fires, it pokes the daemon, which routes it to the agent's inner dialog.
- The agent sees their own habit body as the prompt, plus an "also due" line showing other overdue habits.
- `lastRun` is updated in the habit's frontmatter after each turn.
- `fs.watch` + CLI notifications provide event-driven discovery (no polling).
- On daemon startup, the scheduler auto-migrates any old `tasks/habits/` files and fires overdue habits.

The heartbeat is just one habit among many — the agent's breathing. But agents can create any rhythm they want.

## Inner Dialog

The inner dialog is the agent's private thinking space.

- **ponder**: From any conversation, the agent can *ponder* something — it goes to inner dialog with the thought as context. From inner dialog, *ponder* triggers another turn (the wheel keeps turning).
- **rest**: When thinking is done, the agent *rests*. The wheel stops until the next habit fires.
- **surface**: From inner dialog, the agent can *surface* thoughts outward to friends.
- **settle**: In outer conversations, the agent *settles* on a response (not available in inner dialog).
- **observe**: In group chats, the agent can choose to stay quiet.

The inner dialog session is continuous — different habits and delegations are different prompts into the same stream of thought.

**Cross-session awareness:** When activity happens on any other channel (CLI, Teams, BlueBubbles, MCP), the pipeline notifies the inner dialog. The next time the inner dialog wakes — whether from a habit, a ponder, or a delegation — its checkpoint includes awareness of those other active sessions. This means the agent's private thinking space knows about MCP conversations happening in Claude Code, messages arriving on Teams, and CLI chats in progress. The agent sees their whole world, not just the channel they're currently on.

## Diary And Journal

- **Diary** (`diary/`): The agent's permanent record. `diary_write` saves entries with embeddings for associative recall. `recall` searches both diary and journal.
- **Journal** (`journal/`): The agent's desk. Freeform files the agent writes with `write_file`. The heartbeat shows a journal index (recent files, previews) so the agent sees where they left off.

Both are searchable. The diary is the shelf; the journal is the desk.

## Daemon Resilience

The daemon is designed to keep running and to leave useful evidence when it can't.

- **Tombstone on crash:** If the daemon process dies unexpectedly, it writes a tombstone to `~/.ouro-cli/daemon-death.json` with the reason, error message, stack trace, PID, and uptime at death. `ouro up` reads this on next start and reports what happened.
- **Log rotation:** Runtime logs use an NDJSON file sink with automatic rotation. When a log file exceeds the size threshold, it's rotated so logs don't grow unbounded.
- **Cooldown recovery:** When a managed agent's sense crashes, the process manager schedules a cooldown recovery rather than immediately restarting. After a configurable delay (default 5 minutes), it retries. If retries are exhausted, the agent is permanently stopped for that daemon lifetime.
- **Error isolation:** Individual agent failures don't take down the daemon. Each managed agent runs in its own error boundary — one agent crashing doesn't affect the others.

## Scheduling And Messaging

- Task markdown supports `scheduledAt` and `cadence` for one-shot timed events.
- The daemon task scheduler reconciles those into OS jobs that call `ouro poke`.
- Habits have their own scheduler (see above) — they don't go through the task system.
- `ouro msg` routes messages through the daemon and falls back to pending delivery when needed.

## Dev Mode

`ouro dev` is the development counterpart to `ouro up`. It's designed for working on the harness itself.

- **Auto-build:** `ouro dev` always runs `npm run build` before starting the daemon, so `dist/` matches your current source.
- **Path persistence:** The repo path is saved to `~/.ouro-cli/dev-config.json`. Next time you run `ouro dev` from anywhere, it remembers where your repo is. If you run from inside the repo, it detects the CWD automatically.
- **Launchd management:** Before starting the dev daemon, `ouro dev` disables the launchd auto-restart agent for the installed production daemon. This prevents the installed version from respawning while you're running dev code. `ouro up` restores production mode and cleans up `dev-config.json`.
- **Force-restart:** Dev mode always kills any existing daemon and starts fresh. You rebuilt — you want this code running.
- **Wrapper dispatch:** The `ouro` launcher checks for `dev-config.json`. If it exists, commands are dispatched to the dev repo's entry point instead of the installed version. `ouro up` deletes `dev-config.json` to return to normal dispatch.

## Hooks

Lifecycle hooks give agents passive awareness of activity in developer tools.

- `ouro setup --tool <tool> --agent <name>` registers hooks alongside the MCP server.
- Three hook events are supported: **SessionStart**, **Stop**, and **PostToolUse**.
- Hooks fire via `ouro hook <event> --agent <name>`, which forwards the event to the daemon over the Unix socket.
- Hooks are designed to never block the dev tool — they always exit 0, even if the daemon is unavailable.
- PostToolUse hooks fire on Bash, Edit, and Write tool calls, giving the agent awareness of file changes happening in their codebase.
- The daemon records hook events so the agent's inner dialog can include them in its next checkpoint.

## Harness-Level Skills

Skills are markdown files that extend an agent's capabilities. They live in two places:

- **Agent skills:** `~/AgentBundles/<agent>.ouro/skills/` — specific to one agent.
- **Harness skills:** `skills/` at the repo root — shipped with every installation, available to all agents.

When resolving skills, agent-level skills take priority. Harness skills are fallbacks. This means an agent can override a harness skill by placing their own version in their bundle. The skill loader deduplicates by name.

## Version And Update Model

- Package version comes from `package.json`.
- Runtime metadata exposes `version` and `lastUpdated`.
- `ouro up` replaces stale daemons rather than preserving split-brain launcher/runtime behavior. `ouro dev` always force-restarts.
- Dev mode suppresses the npm update checker. Production mode checks every 30 minutes.
- Update hooks run against bundles using `bundle-meta.json`.
- The bootstrap wrapper and installed launcher are designed to converge on the same runtime channel.

## Serpent Guide

`SerpentGuide.ouro/` is shipped with the package and used by `ouro hatch`.

The serpent guide:

- interviews the human
- helps define the new agent
- scaffolds a canonical bundle with `humanFacing` and `agentFacing` provider configs
- writes credentials to `~/.agentsecrets/<agent>/secrets.json`
- hands the new agent off into the normal bundle/runtime model

## Repository Layout

Top-level repo layout:

- `src/`
- `subagents/`
- `SerpentGuide.ouro/`
- `docs/`
- `scripts/teams-sense/`
- `packages/ouro.bot/`

Task docs are intentionally not part of this repo’s long-lived architecture. They live with the owning agent bundle.

## Quality Gates

- `npm test`
- `npx tsc --noEmit`
- `npm run test:coverage`

Production runtime logging must go through `emitNervesEvent()`, and nerves audit rules enforce structural coverage over those events.
