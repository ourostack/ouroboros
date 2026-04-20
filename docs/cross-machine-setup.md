# Setting Up An Agent On A New Machine

This guide covers how to get an existing Ouroboros agent running on a second (or third, or fourth) machine. The agent's bundle — its identity, memory, habits, and state — lives in a git repo that syncs across machines. The agent's raw credentials live in the agent vault, which is the agent's password manager. The durable Ouro-owned story is bundle plus vault; local unlock material is recreated per machine.

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

## Step 2: Continue An Existing Agent Bundle

On first run with no existing agents in a human terminal, bare `ouro` opens the home deck and offers the first two moves: hatch a new agent or clone an existing bundle. Pick **clone** and enter the git remote URL for the bundle:

```
Enter the git remote URL for the agent bundle: https://github.com/you/youragent.ouro.git
```

Or run directly:

```bash
ouro clone <bundle-git-remote>
```

For example:

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

If you are not in an interactive terminal, run the direct command instead:

```bash
ouro clone <bundle-git-remote>
```

## Step 3: Unlock the agent vault

Each agent owns its own Bitwarden/Vaultwarden vault for provider credentials. Provider/model selection is per-machine (stored in `state/providers.json` inside the bundle). See [docs/auth-and-providers.md](auth-and-providers.md) for the full story.

If this is an existing bundle, unlock its vault on this machine before starting the daemon:

```bash
ouro vault unlock --agent <agent>
```

Ouro stores local unlock material in Keychain, DPAPI, Secret Service, or an explicit plaintext fallback if the human chooses it. Local unlock material is a machine-local cache, not a credential source of truth.

If `ouro vault status --agent <agent>` says the vault locator is not configured in `agent.json`, this agent has not set up its vault yet. Run `ouro vault create --agent <agent>`, enter the new unlock secret twice when prompted, save it outside Ouro, then re-enter provider credentials with `ouro auth --agent <agent>`.

When bundle sync is enabled, vault setup and guided connectors that edit `agent.json` run the existing bundle sync path after the change. Watch for the `bundle sync:` line in the command output; if it reports a push failure, the local vault action still succeeded, but the bundle change needs sync repair before another machine can see it.

Then refresh and verify the credentials this machine can use:

```bash
ouro repair --agent <agent>
ouro provider refresh --agent <agent>
ouro auth verify --agent <agent>
ouro vault config status --agent <agent> --scope all
```

If provider credentials are missing or stale, run:

```bash
ouro auth --agent <agent>
```

This walks you through authenticating with your model provider (Anthropic, Azure, GitHub Copilot, etc.). On WSL/Linux, vault unlock uses Linux Secret Service (`secret-tool`) by default. If that's not available, it falls back to explicit plaintext with user confirmation.

If this agent predates the vault-backed auth model, follow the **Old Auth-Style Agents** checklist in [docs/auth-and-providers.md](auth-and-providers.md) before relying on `ouro up`.

If the bundle already has vault coordinates but nobody ever saved an unlock secret, use the old-auth checklist instead of `ouro vault unlock`.

If the bundle already has vault coordinates but there is no local credential export because the agent predates vault-backed provider storage, create an empty agent vault and re-enter credentials:

```bash
ouro vault replace --agent <agent>
```

If the human does have a local JSON credential export, recover into the agent vault and import it once:

```bash
ouro vault recover --agent <agent> --from <json>
```

Both commands use the stable agent vault email by default, such as `<agent>@ouro.bot`. They do not invent timestamped `+replaced` or `+recovered` addresses. If that vault account already exists, unlock it if the secret exists; only use `--email <email>` when intentionally moving the agent to a different vault account.

For integrations and local senses, use the guided connector:

```bash
ouro connect --agent <agent>
ouro connect providers --agent <agent>
ouro connect perplexity --agent <agent>
ouro connect embeddings --agent <agent>
ouro connect teams --agent <agent>
ouro connect bluebubbles --agent <agent>
```

The connect bay is the easiest starting point when you do not remember the exact command. `providers`, `perplexity`, `embeddings`, and `teams` are portable agent runtime config. BlueBubbles is a local machine attachment; run the BlueBubbles connector only on machines that can reach the local BlueBubbles server. Guided connectors now show a short `checking current connections` preflight while they verify the selected providers live, read portable and machine-local settings, keep progress visible while they read/write the vault and reload the running agent, and do not print the entered secret. The root bay is a framed, responsive board with a recommended next move so the human can scan `Provider core`, portable capabilities, and this-machine attachments separately without getting buried in status prose. Each guided connector also opens with a short `Unlocks / What you need / Where it lives` board and closes with `What changed / Next moves`, so the human can tell at a glance whether the capability travels with the agent or only lives on this machine.

## Step 4: Start the daemon

If you skipped the guided prompt:

```bash
ouro repair --agent <agent>
ouro up
```

The daemon discovers your agent bundle, starts the inner dialog worker, and begins sync. You can now talk to your agent:

If `ouro up` has to replace an older or drifted daemon, it now says that plainly and keeps showing replacement progress until the new background service is actually answering.

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

Provider credentials and portable runtime credentials live in the agent's Bitwarden/Vaultwarden vault (one vault per agent). Local attachments such as BlueBubbles also live in the agent vault, under a machine-scoped item keyed by this machine's stable id. The vault itself is remote and shared; vault unlock material is local to each machine. The only Ouro-owned durable credential locations are the bundle and the agent vault. See [docs/auth-and-providers.md](auth-and-providers.md).

## For agents reading this doc

If someone asks you "how do I set you up on another computer?", you don't need to ask what OS they're on — you can check `detectPlatform()` (from `src/heart/platform.ts`) or just tell them the full picture and let them skip what doesn't apply. The platform detection module returns `"macos" | "linux" | "wsl" | "windows-native"` and is available at runtime via `process.platform` plus WSL detection.

The guided flow handles platform differences automatically: `ouro clone` works on all Unix-like platforms, and `ouro setup --tool claude-code` detects WSL and bridges to Windows-side Claude Code without the user needing to know the mechanics.

## Troubleshooting

**"git is not installed"** — Install git for your platform. The error message includes instructions.

**Clone fails with auth error** — Make sure you can access the remote. Run `gh auth login` or set up git credentials for the account that owns the bundle repo. If the bundle is on an Enterprise Managed User (EMU) GitHub account, you may need to switch accounts first: `gh auth switch` (or `gh auth login` with the EMU account if not yet added).

**"ouro: command not found" after install** — Open a new terminal or run the `source` command printed during install.

**Agent can't reach model provider** — Run `ouro repair --agent <name>` first. If you have the saved vault unlock secret, it will point you to `ouro vault unlock --agent <name>`, then `ouro provider refresh --agent <name>` and `ouro auth verify --agent <name>`. If the bundle has no vault locator yet, use `ouro vault create --agent <name>`. If the bundle already has vault coordinates but nobody ever saved the unlock secret, use `ouro vault replace --agent <name>`. Then re-enter credentials with `ouro auth --agent <name>`.

**WSL setup can't find `claude.exe`** — Make sure Claude Code is installed on Windows and that Windows executables are accessible from WSL (this is the default). Check that `/etc/wsl.conf` doesn't have `appendWindowsPath = false`.
