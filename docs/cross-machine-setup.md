# Setting Up An Agent On A New Machine

This guide covers how to get an existing Ouroboros agent running on a second (or third, or fourth) machine. The agent's bundle — its identity, memory, habits, and state — lives in a git repo that syncs across machines. The harness handles the rest.

## Prerequisites

You need:
- **git** installed on the target machine
- **Node.js** (LTS recommended — install via [nvm](https://github.com/nvm-sh/nvm) or your package manager)
- **Access to the bundle's git remote** (the repo where the agent's bundle is backed up)

If you're setting up on **Windows**, you also need:
- **WSL2** — install with `wsl --install` from an admin PowerShell. Native Windows is not yet supported; the agent daemon runs inside WSL.
- **Node.js installed inside WSL** (not the Windows-side Node)
- **Claude Code installed on the Windows side** if you want the agent available in Claude Code

## Step 1: Install the harness

On **macOS or Linux** (or inside WSL on Windows):

```bash
npx ouro.bot
```

On first run, this installs the `@ouro.bot/cli` package, creates the `ouro` command, and adds it to your PATH. Follow the shell hint it prints (`source ~/.zshrc`, `source ~/.bash_profile`, etc.) or open a new terminal.

## Step 2: Clone or hatch

On first run with no existing agents, the CLI offers a choice:

```
No agents found. Would you like to hatch a new agent or clone an existing one? (hatch/clone):
```

Pick **clone** and enter the git remote URL for the bundle:

```
Enter the git remote URL for the agent bundle: https://github.com/you/youragent.ouro.git
```

Or run directly:

```bash
ouro clone https://github.com/you/youragent.ouro.git
```

The clone command:
- Checks that git is installed (with platform-specific install instructions if not)
- Verifies the remote is accessible
- Clones the bundle to `~/AgentBundles/<name>.ouro/`
- Creates a fresh machine identity (each machine gets its own)
- Enables sync in `agent.json` so changes push/pull automatically
- Tells you what to do next

The agent name is inferred from the URL. Override with `--agent <name>` if needed.

**Already cloned manually?** If you `git clone`d the bundle yourself before running `ouro up`, the daemon will detect it and offer to enable sync.

## Step 3: Set up provider auth

The agent needs model provider credentials on each machine. These are never synced — you set them up per machine:

```bash
ouro auth run --agent <name>
```

This walks you through authenticating with your model provider (Anthropic, Azure, GitHub Copilot, etc.).

## Step 4: Start the daemon

```bash
ouro up
```

The daemon discovers your agent bundle, starts the inner dialog worker, and begins sync. You can now talk to your agent:

```bash
ouro chat <name>
```

## Step 5: Set up dev tool integration (optional)

If you want your agent available in Claude Code (or Codex), ask the agent directly:

> "Can you make it so Claude can talk to you?"

The agent will run `ouro setup --tool claude-code --agent <name>` via its shell tool. This registers the MCP server and lifecycle hooks.

Or run it yourself:

```bash
ouro setup --tool claude-code --agent <name>
```

### Windows (WSL2) specifics

When running from WSL, the setup command automatically:
- Detects the WSL environment
- Resolves the Windows-side home directory
- Calls `claude.exe` (the Windows binary) instead of `claude`
- Prefixes MCP and hook commands with `wsl` so Windows-side Claude Code spawns them through WSL
- Writes config to the Windows-side `~/.claude/` directory

After setup, open Claude Code in PowerShell — the agent is there.

## Platform support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Full support | Primary development platform |
| Linux | Full support | Uses crontab for scheduling |
| Windows (WSL2) | Supported | Daemon runs in WSL, dev tools bridge to Windows |
| Windows (native) | Not yet supported | Use WSL2 for now |

## What syncs vs. what stays local

| Syncs across machines | Per-machine (not synced) |
|---|---|
| Psyche (SOUL.md, IDENTITY.md, etc.) | Machine identity (`~/.ouro-cli/machine.json`) |
| Diary, journal | Provider credentials (`~/.agentsecrets/`) |
| Habits | Daemon state (pids, health, logs) |
| Friends | Dev tool registrations (MCP, hooks) |
| Tasks | Provider/model lane selection (`state/providers.json`) |
| Skills | |
| Agent config (`agent.json`) | |

## Troubleshooting

**"git is not installed"** — Install git for your platform. The error message includes instructions.

**Clone fails with auth error** — Make sure you can access the remote. Run `gh auth login` or set up git credentials for the account that owns the bundle repo.

**"ouro: command not found" after install** — Open a new terminal or run the `source` command printed during install.

**Agent can't reach model provider** — Run `ouro auth run --agent <name>` to set up credentials on this machine.

**WSL setup can't find `claude.exe`** — Make sure Claude Code is installed on Windows and that Windows executables are accessible from WSL (this is the default). Check that `/etc/wsl.conf` doesn't have `appendWindowsPath = false`.
