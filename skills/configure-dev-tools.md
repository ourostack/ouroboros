# Configure Dev Tools for MCP Agent Bridge

Set up your development tools (Claude Code, Codex) to communicate with Ouroboros agents via MCP. One command does everything — including cross-platform WSL2 bridging on Windows.

## Setup

### Claude Code

```bash
ouro setup --tool claude-code --agent <agent-name>
```

This command:
1. Registers the MCP server with Claude Code via `claude mcp add`
2. Configures lifecycle hooks (SessionStart, Stop, PostToolUse) for passive awareness
3. Detects dev vs installed mode automatically and uses the correct command path

**On WSL2 (Windows):** The command automatically detects the WSL environment and:
- Calls `claude.exe` (the Windows binary) instead of `claude`
- Prefixes MCP serve and hook commands with `wsl` so Windows-side Claude Code spawns them through WSL
- Resolves the Windows-side home directory and writes config to the Windows-side `~/.claude/`
- After setup, open Claude Code in PowerShell — the agent is there

**On native Windows (no WSL):** Not yet supported. The command prints a message directing you to install WSL2.

For the full cross-machine setup flow (including cloning an agent to a new machine), see `docs/cross-machine-setup.md` in the harness repo.

### Codex

```bash
ouro setup --tool codex --agent <agent-name>
```

This command:
1. Registers the MCP server with Codex via `codex mcp add`
2. Detects dev vs installed mode automatically

## Verification

After setup, verify the connection:

1. **Check daemon is running**: `ouro up` (installed) or `ouro dev --repo-path <path>` (dev mode).
2. **Test from Claude Code**: Start a new session and use the `status` tool.
3. **Test from Codex**: Run `codex exec "Use the <agent-name> status tool"`.
4. **Check registration**: `claude mcp list` or `codex mcp list`.

## Available MCP Tools

Once connected, these tools are available:

### Conversation tools (new)
- **send_message** -- Send a message and get a synchronous agent response (full turn with tools)
- **check_response** -- Check for pending messages from the agent (after ponder or proactive surface)

### Read-only tools
- **ask** -- Ask the agent a question (uses diary, journal, and context)
- **status** -- Get agent's current status and activity
- **catchup** -- Get recent activity summary
- **get_context** -- Get agent's current working context
- **search_notes** -- Search the agent's diary for specific topics
- **get_task** -- Get details of the agent's current task
- **check_scope** -- Verify if something is in scope for current work
- **check_guidance** -- Get guidance on how to approach something

### Write tools
- **delegate** -- Request the agent to handle a task (runs full conversation turn)
- **request_decision** -- Ask agent to make a decision about something
- **report_progress** -- Report progress on delegated work
- **report_blocker** -- Report a blocker on delegated work
- **report_complete** -- Report completion of delegated work

## Troubleshooting

### "Daemon not running" error
Most read-only tools work without the daemon (reads filesystem directly). For write operations and `send_message`, start the daemon with `ouro up` or `ouro dev`.

### MCP server not appearing
- Run `claude mcp list` or `codex mcp list` to verify registration
- Re-run `ouro setup` to fix
- Restart your dev tool (MCP loads at session start)

### Connection timeouts
- Ensure `dist/` is built: `npm run build`
- Check that the entry point path is correct (setup auto-detects this)

### WSL2-specific issues

**`claude.exe` not found** — Windows executables must be accessible from WSL. This is the default, but enterprise environments may disable it via `/etc/wsl.conf` setting `appendWindowsPath = false`. Check with `which claude.exe`. If missing, add Claude Code's install directory to WSL's PATH manually or update `wsl.conf`.

**`cmd.exe` or `wslpath` fails** — The setup command resolves the Windows home directory using `cmd.exe /C echo %USERPROFILE%` piped through `wslpath`. If either is unavailable, the setup will fail. `wslpath` ships with all standard WSL distributions. `cmd.exe` requires Windows executables to be on PATH (see above).

**MCP server hangs or returns empty** — The MCP server runs inside WSL via `wsl ouro mcp-serve --agent <name>`. If stdio piping between Windows and WSL is broken, check that the WSL distribution is running (`wsl --status`) and that no other process has claimed stdin.

**Hooks not firing** — Claude Code hooks use `wsl ouro hook <event> --agent <name>`. If hooks fail silently, check that `ouro` is on PATH inside WSL (run `wsl ouro --version` from PowerShell to verify).

### Removing
```bash
claude mcp remove ouro-<agent-name>
# or
codex mcp remove ouro-<agent-name>
```
