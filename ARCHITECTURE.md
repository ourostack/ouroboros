# Architecture

This document describes the current runtime shape of the Ouroboros harness.

## Core Runtime Model

The harness is daemon-centered.

- `npx ouro.bot@latest` is the supported bootstrap entrypoint.
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

1. Human enters through `npx ouro.bot@latest` or `ouro`.
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
- `diary/` — durable facts and conclusions the agent chose to keep
- `journal/` — thinking-in-progress, working notes, drafts (the agent's desk)
- `habits/` — autonomous rhythms: heartbeat, reflections, check-ins (extracted from `tasks/habits/`)
- `friends/`
- `state/`
- `tasks/` — one-shots and ongoing work (habits no longer live here)
- `skills/`
- `senses/`
- `senses/teams/`

### Credentials

Each agent has one Bitwarden/Vaultwarden credential vault. Raw provider,
sense, integration, travel, and tool credentials stay in that vault. Bundle
files carry non-secret configuration, state, and vault coordinates only.

Vault unlock material is machine-local cache, not a second credential source.

### Machine-scoped runtime/test spillover

`~/.ouro-cli/...`

This is for machine-level artifacts, not bundle-owned identity.

## Bundle Truth

`agent.json` is the runtime-facing contract for:

- phrases
- context settings
- sense enablement
- vault coordinates

`state/providers.json` is the machine-local source of truth for provider/model selection. It owns the `outward` and `inner` lanes for this machine after bootstrap; `agent.json` may seed missing local state, but it is not the ongoing lane authority.

`bundle-meta.json` tracks the runtime version that last touched the bundle and supports version-aware behavior on startup.

## Human CLI Surfaces

Human-facing CLI commands share one terminal surface family instead of each command printing its own transcript.

- `src/heart/daemon/terminal-ui.ts` owns the shared Ouro masthead, board layout, wrapping, and action rendering.
- `src/heart/daemon/human-readiness.ts` owns the canonical human-readable readiness snapshot and recommended next actions.
- `src/heart/daemon/human-command-screens.ts` owns shared boards for the home deck, agent picker, and readiness screens.
- `ouro`, `ouro up`, `ouro connect`, `ouro auth verify`, `ouro repair`, `ouro help`, `ouro whoami`, `ouro versions`, and the `ouro hatch` welcome shell should read like one CLI family in a TTY.
- Non-TTY and automation paths should stay compact and deterministic.
- Long-running human flows keep visible progress on screen; replacing a daemon stays unresolved until the new background service is actually answering.

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
- The MCP server exposes tools (e.g., `send_message`, `check_response`, `status`, `search_notes`, `delegate`) that map to daemon commands.
- `send_message` runs a full agent turn via `runSenseTurn()` — the agent gets their complete system prompt, diary, tools, everything. It's not a thin read-only proxy; it's a real conversation turn.
- Sessions are keyed by the dev tool's session ID (e.g., Claude Code's session ID). This means each Claude Code session gets its own conversation thread with the agent.
- Read-only tools like `status` and `search_notes` work even without the daemon running (they read the filesystem directly). Write operations and `send_message` require the daemon.

The `ouro setup --tool <tool> --agent <name>` command handles registration automatically, including lifecycle hooks.

### BlueBubbles-specific behavior

BlueBubbles now uses:

- one persisted chat trunk per chat
- current-turn lane metadata for thread awareness
- agent-chosen outbound lane targeting
- typing/read behavior coordinated through the sense transport

Threads are treated as routing/context metadata, not as separate long-lived worlds.

## Subsystems

- `src/arc/`
  Durable continuity state — obligations, cares, episodes, intentions, presence, and attention types. This is the agent's sense of ongoing story: what they owe, what they care about, what happened, and what they intend to do next. Dependency rules: arc/ may import nerves/ (events) and heart/identity (paths) and heart/sync (write tracking); arc/ must not import mind/, senses/, or repertoire/.
- `src/heart/`
  Core engine, provider runtimes, identity/config loading, daemon, bootstrap, and entrypoints. Organized into topic subdirectories:
  - `heart/daemon/` — daemon lifecycle, CLI routing, process management, health, sockets (~37 files)
  - `heart/outlook/` — Outlook/calendar integration (HTTP, read, render, types, view)
  - `heart/habits/` — habit parsing, scheduling, and migration
  - `heart/hatch/` — agent creation flow, specialist orchestration, animation
  - `heart/versioning/` — version management, update checking, staged restart, wrapper publishing
  - `heart/auth/` — OAuth/auth flow
  - `heart/mcp/` — MCP server implementation
  - `heart/providers/` — provider runtime adapters
  - `heart/bridges/` — bridge state management
- `src/mind/`
  Prompt assembly, sessions, bundle manifest, diary, note search, journal indexing, embedding providers, phrases, formatting, obligation steering, and friend identity.
- `src/repertoire/`
  Tool registry (split into category modules: tools-files, tools-shell, tools-notes, tools-bridge, tools-session, tools-continuity, tools-flow, tools-surface, tools-config, tools-bluebubbles, tools-teams, tools-github), coding orchestration, task tooling, skills, shared API client, and integration clients (Graph, ADO, GitHub).
- `src/senses/`
  CLI (with TUI in senses/cli/), Teams, BlueBubbles (in senses/bluebubbles/), MCP bridge, activity transport, trust gating, inner-dialog worker logic, and contextual heartbeat.
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
- **diary_write** — record something to the diary for later use
- **search_notes** — search both diary and journal for relevant facts and notes

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

- **Diary** (`diary/`): The agent's permanent written record. `diary_write` saves entries with embeddings for note search. `search_notes` searches both diary and journal.
- **Journal** (`journal/`): The agent's desk. Freeform files the agent writes with `write_file`. The heartbeat shows a journal index (recent files, previews) so the agent sees where they left off.

Both are searchable. The diary is the shelf; the journal is the desk.

## Daemon Resilience

The daemon is designed to be unkillable under normal conditions and to leave useful evidence when something truly fatal happens.

### Error boundary and circuit breaker

The daemon's `uncaughtException` handler does NOT exit on errors. Instead:

- **EPIPE** is silently ignored (normal when the parent CLI exits and stdio pipes close).
- **Any other uncaught exception** is logged to nerves and written to the tombstone, but the daemon **continues running**.
- **Circuit breaker:** If 10+ uncaught exceptions occur within 60 seconds, the daemon exits — the process is in a bad state and needs a fresh start. launchd KeepAlive (or the next `ouro up`) restarts it.

This means a stray error from an MCP server, a bad JSON parse, or a flaky network call won't kill the daemon. Only a sustained crash loop triggers exit.

### Force-exit timeouts

`daemon.stop()` can hang if a child process or MCP server won't die. All shutdown paths have a 5-second force-exit timeout:

- SIGINT/SIGTERM signal handlers
- Startup failure catch handler
- Circuit breaker exit path

If graceful shutdown doesn't complete in 5 seconds, the process force-exits.

### Self-spawning staged restart

When the update checker finds a new version, `performStagedRestart`:

1. Installs the new version via npm
2. Resolves the new code path
3. Runs update hooks from the new code
4. Gracefully shuts down the old daemon (releases the socket)
5. **Self-spawns the new daemon** as a detached process

The daemon does NOT rely on launchd KeepAlive for restart — it spawns its own replacement. This works whether or not launchd is configured.

### launchd KeepAlive

`ouro up` installs a launchd LaunchAgent (`bot.ouro.daemon`) with `KeepAlive: true` and `RunAtLoad: true`. This provides:

- Automatic restart if the daemon crashes outside of a staged restart
- Automatic start on login

`ouro dev` explicitly uninstalls the LaunchAgent to prevent the production daemon from fighting the dev daemon. `ouro up` reinstalls it.

### Crash forensics

- **Tombstone:** `~/.ouro-cli/daemon-death.json` records the reason, error, stack trace, PID, uptime, and recent crash timestamps.
- **Health file:** `~/.ouro-cli/daemon-health.json` is updated by a nerves sink with daemon status, mode, PID, and uptime.
- **Pidfile:** `~/.ouro-cli/daemon.pids` tracks all managed PIDs. On startup, the new daemon reads and kills stale PIDs before taking over.

### Process isolation

- **Agent isolation:** Each managed agent runs in its own error boundary. One agent crashing doesn't affect others.
- **MCP server isolation:** MCP servers are managed by `McpManager` with per-server crash handling and automatic restart (up to 5 retries with 1-second backoff). Servers can be added/removed at runtime via `reconcile()` without restarting the daemon.
- **Sense isolation:** Each sense (Teams, BlueBubbles, etc.) runs as a separate child process with its own crash recovery.
- **Cooldown recovery:** When a managed process crashes, the process manager schedules a cooldown recovery rather than immediately restarting.

### Log rotation

Runtime logs use an NDJSON file sink with automatic rotation. When a log file exceeds the size threshold (~50MB), it's rotated so logs don't grow unbounded.

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
- creates the hatchling's vault, stores selected provider credentials there,
  and prints the generated unlock secret once for the human to save
- hands the new agent off into the normal bundle/runtime model

## Repository Layout

Top-level repo layout:

- `src/` — the shared harness code (arc, heart, mind, repertoire, senses, nerves)
- `SerpentGuide.ouro/` — packaged specialist bundle used by `ouro hatch`
- `skills/` — harness-level skills shipped with the repo
- `docs/` — shared repo documentation
- `scripts/teams-sense/` — operator scripts for the Teams deployment path
- `packages/ouro.bot/` — bootstrap wrapper package

Task docs are intentionally not part of this repo’s long-lived architecture. They live with the owning agent bundle.

## Quality Gates

- `npm test`
- `npx tsc --noEmit`
- `npm run test:coverage`

Production runtime logging must go through `emitNervesEvent()`, and nerves audit rules enforce structural coverage over those events.
