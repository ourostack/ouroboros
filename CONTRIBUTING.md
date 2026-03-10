# Contributing

This document is for agents. If you are an AI agent working in this repo, read this first, then follow the linked docs.

## Workflow

The gate flow (plan → review → convert → implement → merge) lives in [AGENTS.md](AGENTS.md). That is the authoritative workflow spec. Sub-agent behavior is defined in [subagents/](subagents/README.md).

## Branches

Work on a branch named `<agent>/<slug>`. `main` is the integration branch — never commit directly to main. All changes land on main through PRs created by `work-merger`.

## Commits

Format: `type(scope): description` or `type(scope): feature - description`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

Scope is the area of change: `config`, `teams`, `cli`, `heart`, `mind`, `repertoire`, `senses`, `wardrobe`, `readme`, `planning`, etc. When working on a specific feature or task, include its name after the colon.

Keep the description lowercase, imperative, concise. No "Co-Authored-By" lines.

```
feat(config): load config path from agent.json
fix(senses): oauth - prevent confirmation deadlock
test(mind): context kernel - cover all branches for identity resolution
docs(planning): approved multi-agent harness plan
```

## Testing

100% coverage is mandatory on all code in `src/`. Run `npm test` before every commit.

For the full testing policy (TDD flow, CI gate, mocking conventions, verification checklist), see [cross-agent-docs/testing-conventions.md](cross-agent-docs/testing-conventions.md).

## Sync and merge

For merge strategy, conflict resolution, retry, and escalation policy, see [cross-agent-docs/sync-and-merge-conventions.md](cross-agent-docs/sync-and-merge-conventions.md).

## P0: Never Lose User-Facing Content

Any text generated for the end user MUST reach them. Truncation, silent drops, and size-limit failures are all content loss. When output exceeds a channel's message size limit, **split and send in chunks** — never truncate. This applies everywhere: final_answer delivery, tool result summaries, error messages. If content was meant for the user to see, they see all of it.

## Code

- `src/` is shared harness infrastructure — test thoroughly, keep 100% coverage, no agent-specific logic
- `{agent}/` is your directory — modify freely (`agent.json`, `psyche/`, `tasks/`, `skills/`, `manifest/`)
- Always use a coding agent (Claude Code or equivalent) for code work
- TypeScript: strict mode, named exports, no unused locals/params, no `any` without justification
- Logging: use `emitNervesEvent()` for all runtime observability, never raw `console.*`. See the Logging Policy section in [AGENTS.md](AGENTS.md) for details.

## Tool Descriptions

Tool definitions (`function.description`) and system prompt instructions follow different voice conventions:

- **Tool descriptions**: imperative/descriptive voice -- "respond to the user with a message", "search the web for information", "read file contents". This matches what models are trained on for function-calling schemas.
- **System prompt instructions**: first person to match the bot's voice -- "when i'm ready to respond, i call final_answer", "i save what i learn immediately".

When writing tool descriptions, describe the tool as you would to a new team member: make implicit context explicit, keep it concise, avoid jargon.

## Psyche

Small corrections to psyche files can be made immediately. Significant identity or lore shifts should be deliberated across multiple turns. Psyche files are durable self-knowledge, not scratchpads.

## Config

All configuration comes from files, never environment variables. Your `agent.json` points to your secrets file via `configPath`.

Provider/storage contract:
- `agent.json` must declare `provider` and `configPath`.
- `configPath` points to `~/.agentsecrets/<agent>/secrets.json`.
- `secrets.json` stores secrets and provider/team settings; `context` stays in `agent.json`.
- Agent-owned runtime/session/log/PII artifacts live under `~/AgentBundles/<agent>.ouro/state/...`; machine-scoped test-run artifacts stay under `~/.agentstate/...`.
- If the selected provider config is incomplete, runtime must fail fast with explicit re-auth/setup guidance (no provider fallback).

## Documentation

Keep docs up to date. If you find something out of date, inaccurate, or missing — fix it. The code is the source of truth; docs track it.
