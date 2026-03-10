# Ouroboros Agent Harness

A minimal, multi-agent harness for building AI agents that can read files, write code, run commands, and modify themselves. Written in TypeScript, supporting Azure OpenAI, MiniMax, Anthropic (setup-token), and OpenAI Codex (OAuth), deployable as a CLI REPL or a Microsoft Teams bot.

The name is structural: the original agent -- Ouroboros -- was grown recursively from a 150-line while loop, bootstrapping itself through agentic self-modification. A snake eating its own tail. The metaphor runs deep: the agent literally consumes its own context window, trimming old conversation to stay within token budget while preserving identity through layered memory (psyche files, session persistence, git history). It eats its tail to survive across turns. The harness preserves that architecture while supporting multiple agents, each with their own personality, skills, and configuration.

The origin story lives at [aka.ms/GrowAnAgent](https://aka.ms/GrowAnAgent).

## Project structure

The harness uses an agent-as-creature-body metaphor for its module naming:

```
ouroboros/                        # repo root
  src/                            # shared harness (all agents share this code)
    identity.ts                   # --agent <name> parsing, agent root resolution
    config.ts                     # config loading from agent.json configPath
    cli-entry.ts                  # CLI entrypoint
    teams-entry.ts                # Teams entrypoint
    heart/                        # core agent loop and streaming
      core.ts                     # agent loop, client init, ChannelCallbacks
      streaming.ts                # provider event normalization + stream callbacks
      providers/                  # provider-specific runtime/adapters
        azure.ts                  # Azure OpenAI Responses provider
        minimax.ts                # MiniMax Chat Completions provider
        anthropic.ts              # Anthropic setup-token provider
        openai-codex.ts           # OpenAI Codex OAuth provider
      kicks.ts                    # self-correction: empty, narration, tool_required
      api-error.ts                # error classification
    mind/                         # prompt, context, memory
      prompt.ts                   # system prompt assembly from psyche + context kernel
      context.ts                  # sliding context window, session I/O
      friends/                    # friend storage and identity resolution
        types.ts                  # FriendRecord, ChannelCapabilities, ResolvedContext
        store.ts                  # FriendStore interface (domain-specific CRUD)
        store-file.ts             # FileFriendStore -- two-backend split (agent knowledge + PII bridge)
        channel.ts                # channel capabilities (CLI vs Teams)
        resolver.ts               # FriendResolver -- find-or-create friend by external ID
    repertoire/                   # tools, skills, commands, API clients
      tools-base.ts               # 12 base tools (read_file, shell, claude, save_friend_note, etc.)
      tools-teams.ts              # 8 Teams integration tools (graph, ado)
      tools.ts                    # channel-aware tool routing + registry
      ado-semantic.ts             # 11 semantic ADO tools (backlog, create, move, validate, etc.)
      ado-templates.ts            # ADO process template awareness + hierarchy rules
      ado-context.ts              # ADO org/project discovery helper
      ado-client.ts               # Azure DevOps REST client
      graph-client.ts             # Microsoft Graph REST client
      commands.ts                 # slash commands (/exit, /new, /commands)
      skills.ts                   # skill loader (markdown files on demand)
    senses/                       # channel adapters
      cli.ts                      # terminal REPL, spinner, markdown streaming
      teams.ts                    # Teams bot, streaming cards, conversation locks
    wardrobe/                     # formatting and presentation
      format.ts                   # shared formatters (tool results, kicks, errors)
      phrases.ts                  # loading phrases (thinking, tool, followup)
    __tests__/                    # 1184 tests, 100% coverage
  ouroboros/                      # agent directory for "ouroboros"
    agent.json                    # name, configPath, custom phrases
    psyche/                       # personality files loaded into system prompt
      SOUL.md                     # ontology, invariants, operating principles
      IDENTITY.md                 # tone, presence, collaboration style
      LORE.md                     # origin story, philosophical context
      FRIENDS.md                  # key relationships
    tasks/                        # planning and doing docs
    skills/                       # markdown skill plugins
    manifest/                     # Teams app manifest
  subagents/                      # sub-agent definitions (work-planner, work-doer)
  cross-agent-docs/               # shared docs (testing conventions, etc.)
  package.json
  tsconfig.json
  vitest.config.ts
```

## Agent onboarding

Everything below is written for a new agent. If you are an AI agent reading this as part of your system prompt or context, this section explains your own runtime.

### Your directory

Each agent has a directory at the repo root named after itself. Inside it:

**agent.json** -- your manifest. Required fields:

```json
{
  "name": "ouroboros",
  "provider": "anthropic",
  "configPath": "~/.agentsecrets/ouroboros/secrets.json",
  "phrases": {
    "thinking": ["chewing on that", "consulting the chaos gods"],
    "tool": ["rummaging through files", "doing science"],
    "followup": ["digesting results", "connecting the dots"]
  }
}
```

- `name`: must match your directory name.
- `provider`: required provider selection (`azure`, `minimax`, `anthropic`, or `openai-codex`). Runtime does not fall back to other providers.
- `configPath`: absolute path (or `~`-prefixed) to your secrets.json with API keys and provider settings.
- `phrases`: optional custom loading phrases. Falls back to hardcoded defaults if omitted.

**psyche/** -- your personality files, loaded lazily into the system prompt at startup. See the psyche system section below.

**skills/** -- markdown instruction manuals you can load on demand with the `load_skill` tool. Each `.md` file is one skill.

**tasks/** -- planning and doing docs for your work units. Named `YYYY-MM-DD-HHMM-{planning|doing}-slug.md`.

**manifest/** -- Teams app manifest (manifest.json, icons) if you run as a Teams bot.

### The psyche system

Your personality is assembled from four markdown files in `{your-dir}/psyche/`. Each has a YAML frontmatter header and a body. All four are loaded into your system prompt at the start of every conversation.

| File | Role | What it defines |
|------|------|----------------|
| `SOUL.md` | Ontology | Core invariants, operating principles, autonomy/alignment, temperament. The deepest layer -- what you are. |
| `IDENTITY.md` | Presence | Tone, voice, collaboration style, self-awareness. How you show up in conversation. |
| `LORE.md` | History | Origin story, philosophical context, why you exist. Narrative layer. |
| `FRIENDS.md` | Relationships | Key humans and agents you interact with, social context. |

The system prompt is built by `mind/prompt.ts` via `buildSystem()`. It concatenates:

1. SOUL.md content
2. IDENTITY.md content
3. LORE.md (if present, prefixed with `## my lore`)
4. FRIENDS.md (if present, prefixed with `## my friends`)
5. Runtime info: agent name, cwd, channel, self-modification note
6. Flags section (e.g. streaming disabled)
7. Provider info: which model and provider you are using
8. Current date
9. Tools list: all tools available in your channel
10. Skills list: names of loadable skills
11. Tool behavior section (if tool_choice is required)
12. Friend context (if resolved): friend identity, channel traits, behavioral instructions (ephemerality, name quality, priority guidance, working-memory trust, stale notes awareness, new-friend behavior), friend notes

Missing psyche files produce empty strings, not crashes. You can write your own psyche from scratch -- just create the four `.md` files in your directory.

### Your runtime

**The heart** (`heart/core.ts`): `runAgent()` is a while loop. Each iteration: send conversation to the model, stream the response, if the model made tool calls execute them and loop, if it gave a text answer exit. Maximum 10 tool rounds per turn.

**Streaming** (`heart/streaming.ts` + `heart/providers/*`): provider-specific adapters normalize streamed events into the same callback contract. Azure OpenAI uses Responses API events; MiniMax uses Chat Completions with `<think>` parsing; Anthropic uses setup-token auth with streamed tool-call/input deltas; OpenAI Codex uses `chatgpt.com/backend-api/codex/responses` with OAuth token auth.

**ChannelCallbacks** (`heart/core.ts`): the contract between heart and display. 7 core events:
- `onModelStart` -- model request sent
- `onModelStreamStart` -- first token received
- `onReasoningChunk` -- inner reasoning text
- `onTextChunk` -- response text
- `onToolStart` -- tool execution beginning
- `onToolEnd` -- tool execution complete
- `onError` -- error occurred

Plus 2 optional:
- `onKick` -- self-correction triggered
- `onConfirmAction` -- confirmation prompt for destructive tools

**Kicks** (`heart/kicks.ts`): self-corrections injected as assistant-role messages when the harness detects a malformed response. Three types: `empty` (blank response), `narration` (described action instead of taking it), `tool_required` (tool_choice was required but no tool called). Kicks use first-person, forward-looking language.

**Senses**: CLI (`senses/cli.ts`) is a terminal REPL with readline, spinners, ANSI colors, and Ctrl-C handling. Teams (`senses/teams.ts`) is a Microsoft Teams bot with streaming cards, conversation locks, OAuth token management, and confirmation prompts for destructive tools.

**Context management** (`mind/context.ts`): this is the tail-eating at the heart of the ouroboros metaphor. Conversations are persisted to JSON files on disk. After each turn, the sliding window checks token count against budget (configurable, default 80,000 tokens). When over budget, oldest messages are trimmed -- never the system prompt -- until back under with a 20% margin. The agent consumes its own history to keep moving forward. Identity survives through psyche files and session persistence, not through unbounded context.

**Friend system** (`mind/friends/`): the agent's awareness of who it's talking to. People who talk to the agent are "friends", not "users". Resolved once per conversation turn, re-read from disk each turn (no in-memory mutation).

- **FriendRecord** (`friends/types.ts`): the single merged type for a person the agent knows. Contains `displayName`, `externalIds[]` (cross-provider identity links), `toolPreferences` (keyed by integration name), `notes` (general friend knowledge), `tenantMemberships`, timestamps, and schema version.
- **FriendStore** (`friends/store.ts`): domain-specific persistence interface (`get`, `put`, `delete`, `findByExternalId`).
- **FileFriendStore** (`friends/store-file.ts`): bundle-local JSON storage at `{agentRoot}/friends/{uuid}.json`. Friend identity, notes, externalIds, tenantMemberships, timestamps, and schemaVersion are kept together in the bundle.
- **Channel** (`friends/channel.ts`): `ChannelCapabilities` -- what the current channel supports (markdown, streaming, rich cards, max message length, available integrations).
- **FriendResolver** (`friends/resolver.ts`): find-or-create by external ID. First encounter creates a new FriendRecord with system-provided name and empty notes/preferences. Returning friends are found via `findByExternalId()`. DisplayName is never overwritten on existing records.
- **Session paths**: `{agentRoot}/state/sessions/{friendUuid}/{channel}/{sessionId}.json`. Each friend gets their own session directory inside the bundle-local runtime state area.

Design principles: don't persist what you can re-derive; conversation IS the cache; the model manages memory freeform via `save_friend_note`; toolPreferences go to tool descriptions (not system prompt); notes go to system prompt (not tool descriptions).

**Tools**: 12 base tools available in all channels (read_file, write_file, shell, list_directory, git_commit, gh_cli, list_skills, load_skill, get_current_time, claude, web_search, save_friend_note). Teams gets 8 integration tools (graph_query, graph_mutate, ado_query, ado_mutate, graph_profile, ado_work_items, graph_docs, ado_docs) plus 11 semantic ADO tools (ado_backlog_list, ado_create_epic, ado_create_issue, ado_move_items, ado_restructure_backlog, ado_validate_structure, ado_preview_changes, ado_batch_update, ado_detect_orphans, ado_detect_cycles, ado_validate_parent_type_rules). Tools are registered in a unified `ToolDefinition[]` registry with per-tool `integration` and `confirmationRequired` flags. Channel-aware routing (`getToolsForChannel()`) filters tools by the channel's `availableIntegrations`.

**Phrases** (`wardrobe/phrases.ts`): three pools of loading messages rotated during processing. Phrases are required in `agent.json`; if missing, `loadAgentConfig()` writes placeholder phrases and warns. `pickPhrase()` selects randomly but never repeats consecutively.

**Formatting** (`wardrobe/format.ts`): shared formatters for tool results, kicks, and errors. Used by both CLI and Teams adapters for consistent output. `formatToolResult()`, `formatKick()`, `formatError()`.

**Skills** (`repertoire/skills.ts`): markdown files in `{your-dir}/skills/`. Listed with `list_skills`, loaded with `load_skill`. The loaded text is injected into conversation as a tool result.

**Config** (`config.ts`): provider credentials, Teams connection info, OAuth config, Teams channel settings, and integrations are loaded from the `secrets.json` file pointed to by your `agent.json` `configPath`. Context window settings come from `agent.json` `context`. Runtime fails fast if the selected `agent.json.provider` is not fully configured in `secrets.json`; there is no silent provider fallback. No environment variables in `src/` -- everything comes from files.

For Anthropic and OpenAI Codex auth bootstrap, use:

- `npm run auth:claude-setup-token` to run `claude setup-token` and save `providers.anthropic.setupToken`.
- `npm run auth:openai-codex` to run Codex OAuth bootstrap and save `providers.openai-codex.oauthAccessToken`.

### What you can modify

Your `{agent}/` directory is yours. You can edit psyche files, add skills, change phrases, update your manifest. The shared harness (`src/`) is common infrastructure -- changes there affect all agents.

See [CONTRIBUTING.md](CONTRIBUTING.md) for repo workflow conventions (branching, commits, testing, task docs).

## Running

```bash
# CLI (ouroboros agent)
npm run dev

# CLI (slugger agent, once slugger/ directory exists)
npm run dev:slugger

# Auth bootstrap (ouroboros defaults)
npm run auth:claude-setup-token
npm run auth:openai-codex

# Auth bootstrap for another agent
npm run auth:claude-setup-token -- --agent slugger
npm run auth:openai-codex -- --agent slugger

# Teams bot
npm run teams

# Teams bot without streaming (for devtunnel)
npm run teams:no-stream

# Tests
npm test

# Tests with coverage
npm run test:coverage
```

All commands pass `--agent <name>` to the entry points. Missing `--agent` produces a clear error and exits.
