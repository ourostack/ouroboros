# Configure Dev Tools for MCP Agent Bridge

Set up your development tools (Claude Code, Codex) to communicate with Ouroboros agents via MCP (Model Context Protocol). This enables bidirectional structured communication between dev tools and running agents.

## Claude Code Setup

Add an MCP server entry to your Claude Code settings at `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ouro": {
      "command": "ouro",
      "args": ["mcp-serve", "--agent", "<agent-name>"]
    }
  }
}
```

Replace `<agent-name>` with the name of the agent you want to connect to (e.g., `slugger`).

### Per-project configuration

You can also add the MCP entry to a project-level `.claude/settings.json` to scope it to a specific workspace.

## Codex Setup

Add the MCP server using the Codex CLI:

```bash
codex mcp add ouro -- ouro mcp-serve --agent <agent-name>
```

### Spawned session injection

When the agent spawns Codex for coding tasks, MCP configuration is injected automatically via the `-c` flag:

```bash
codex -c '{"mcp_servers":{"ouro":{"command":"ouro","args":["mcp-serve","--agent","<agent-name>"]}}}' ...
```

You do not need to configure this manually -- the harness handles it.

## Verification

After configuration, verify the connection:

1. **Check daemon is running**: The agent daemon must be active. Start it with `ouro daemon --agent <agent-name>` if needed.
2. **Test from Claude Code**: Ask Claude Code to use the `status` tool to check the agent's state.
3. **Test from Codex**: Run `codex exec "Use the ouro status tool to check the agent"`.

## Available MCP Tools

Once connected, the following tools are available:

- **ask** -- Ask the agent a question (uses memory and context)
- **status** -- Get agent's current status and activity
- **catchup** -- Get recent activity summary
- **delegate** -- Request the agent to handle a task
- **get_context** -- Get agent's current working context
- **search_memory** -- Search agent's memory for specific topics
- **get_task** -- Get details of the agent's current task
- **check_scope** -- Verify if something is in scope for current work
- **request_decision** -- Ask agent to make a decision about something
- **check_guidance** -- Get guidance on how to approach something
- **report_progress** -- Report progress on delegated work
- **report_blocker** -- Report a blocker on delegated work
- **report_complete** -- Report completion of delegated work

## Hybrid Model

The MCP bridge creates a hybrid collaboration model:

- **Dev tool** (Claude Code / Codex) handles code editing, file operations, and tool execution
- **Agent** (Ouroboros) provides context, memory, task awareness, and decision-making
- **Communication** flows both directions via MCP tool calls

This means the dev tool can ask the agent for guidance mid-task, and the agent can monitor progress through structured reports.

## Troubleshooting

### "Daemon not running" error
The agent daemon must be active before the MCP server can forward requests. Start it with:
```bash
ouro daemon --agent <agent-name>
```

### MCP server not appearing in tool list
- Verify the `ouro` command is available in your PATH (install via `npm install -g @ouro.bot/cli`)
- Check that the settings file is valid JSON
- Restart your dev tool after changing MCP configuration

### Connection timeouts
The MCP server connects to the daemon via Unix socket. If the socket file is stale:
1. Stop the daemon: `ouro daemon stop --agent <agent-name>`
2. Restart: `ouro daemon --agent <agent-name>`

### Friend identity
By default, the MCP server identifies as the local user. To use a specific friend identity:
```json
{
  "mcpServers": {
    "ouro": {
      "command": "ouro",
      "args": ["mcp-serve", "--agent", "<agent-name>", "--friend", "<friend-id>"]
    }
  }
}
```
