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

**Guided flow:** After cloning, the CLI offers to continue with provider auth, daemon start, and dev tool setup — all inline. You can accept each step or skip it and run the commands yourself later.

## Step 3: Set up provider auth

Each agent owns its own Bitwarden/Vaultwarden vault for provider credentials. Provider/model selection is per-machine (stored in `state/providers.json` inside the bundle). See [docs/auth-and-providers.md](auth-and-providers.md) for the full story.

If you skipped the guided prompt, or need to re-run auth later:

```bash
ouro auth run --agent <name>
```

This walks you through authenticating with your model provider (Anthropic, Azure, GitHub Copilot, etc.). On WSL/Linux, vault unlock uses Linux Secret Service (`secret-tool`) by default. If that's not available, it falls back to explicit plaintext with user confirmation.

## Step 4: Start the daemon

If you skipped the guided prompt:

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
| Diary, journal | Provider/model lane selection (`state/providers.json`) |
| Habits | Daemon state (pids, health, logs) |
| Friends | Dev tool registrations (MCP, hooks) |
| Tasks | Vault unlock material (Keychain/DPAPI/Secret Service) |
| Skills | |
| Agent config (`agent.json`) | |

Provider credentials live in the agent's Bitwarden/Vaultwarden vault (one vault per agent). The vault itself is remote and shared — vault unlock material is local to each machine. See [docs/auth-and-providers.md](auth-and-providers.md).

## For agents reading this doc

If someone asks you "how do I set you up on another computer?", you don't need to ask what OS they're on — you can check `detectPlatform()` (from `src/heart/platform.ts`) or just tell them the full picture and let them skip what doesn't apply. The platform detection module returns `"macos" | "linux" | "wsl" | "windows-native"` and is available at runtime via `process.platform` plus WSL detection.

The guided flow handles platform differences automatically: `ouro clone` works on all Unix-like platforms, and `ouro setup --tool claude-code` detects WSL and bridges to Windows-side Claude Code without the user needing to know the mechanics.

## Troubleshooting

**"git is not installed"** — Install git for your platform. The error message includes instructions.

**Clone fails with auth error** — Make sure you can access the remote. Run `gh auth login` or set up git credentials for the account that owns the bundle repo. If the bundle is on an Enterprise Managed User (EMU) GitHub account, you may need to switch accounts first: `gh auth switch` (or `gh auth login` with the EMU account if not yet added).

**"ouro: command not found" after install** — Open a new terminal or run the `source` command printed during install.

**Agent can't reach model provider** — Run `ouro auth run --agent <name>` to set up credentials on this machine.

**WSL setup can't find `claude.exe`** — Make sure Claude Code is installed on Windows and that Windows executables are accessible from WSL (this is the default). Check that `/etc/wsl.conf` doesn't have `appendWindowsPath = false`.
