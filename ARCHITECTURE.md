# Architecture

This document describes the current runtime shape of the Ouroboros harness.

## Core Runtime Model

The harness is daemon-centered.

- `npx ouro.bot` is the bootstrap entrypoint.
- `ouro` is the installed launcher used after bootstrap.
- `ouro up` ensures the local launcher is current, repairs stale wrapper state, installs workflow helpers, and starts or replaces the daemon if needed.
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
3. `ouro up` ensures the daemon is running the current runtime version.
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
- `psyche/memory/`
- `friends/`
- `state/`
- `tasks/`
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

- provider selection
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

Sense status model:

- `interactive`
- `disabled`
- `needs_config`
- `ready`
- `running`
- `error`

The daemon manages daemon-hosted senses and reports them in `ouro status`. CLI remains `interactive` rather than daemon-hosted.

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
  Prompt assembly, sessions, bundle manifest, memory, phrases, formatting, and friend identity.
- `src/repertoire/`
  Tool registry, coding orchestration, task tooling, and integration clients.
- `src/senses/`
  CLI, Teams, BlueBubbles, activity transport, trust gating, and inner-dialog worker logic.
- `src/nerves/`
  Structured runtime events and deterministic audit coverage.

## Tools

Tool access is channel-aware and trust-aware.

- CLI gets the full local harness surface.
- Trusted one-to-one remote contexts can use the feasible local tool surface.
- Shared or untrusted remote contexts stay more constrained.

Important recent additions include:

- `schedule_reminder`
- coding session tooling with inspectable output tails
- BlueBubbles reply-target selection as explicit tool state

## Scheduling And Messaging

- Task markdown supports `scheduledAt` and `cadence`.
- The daemon scheduler reconciles those tasks into OS jobs that call `ouro poke`.
- `ouro msg` routes messages through the daemon and falls back to pending delivery when needed.

## Version And Update Model

- Package version comes from `package.json`.
- Runtime metadata exposes `version` and `lastUpdated`.
- `ouro up` replaces stale daemons rather than preserving split-brain launcher/runtime behavior.
- Update hooks run against bundles using `bundle-meta.json`.
- The bootstrap wrapper and installed launcher are designed to converge on the same runtime channel.

## Adoption Specialist

`AdoptionSpecialist.ouro/` is shipped with the package and used by `ouro hatch`.

The specialist:

- interviews the human
- helps define the new agent
- scaffolds a canonical bundle
- writes secrets to `~/.agentsecrets/<agent>/secrets.json`
- hands the new agent off into the normal bundle/runtime model

## Repository Layout

Top-level repo layout:

- `src/`
- `subagents/`
- `AdoptionSpecialist.ouro/`
- `docs/`
- `scripts/teams-sense/`
- `packages/ouro.bot/`

Task docs are intentionally not part of this repo’s long-lived architecture. They live with the owning agent bundle.

## Quality Gates

- `npm test`
- `npx tsc --noEmit`
- `npm run test:coverage`

Production runtime logging must go through `emitNervesEvent()`, and nerves audit rules enforce structural coverage over those events.
