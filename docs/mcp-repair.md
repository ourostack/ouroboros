# MCP Bridge Repair

This runbook is for Ouro agent MCP bridges registered into dev tools such as Codex and Claude Code.

## Symptoms

- The dev tool does not expose the expected `ouro-<agent>` MCP tools.
- The `status` tool reports `versionMismatch=mcp:<old>,daemon:<new>`.
- `ouro setup --tool ... --agent <agent>` says setup completed, but an already-open dev-tool session still reports the old MCP bridge.

## Diagnose

Run the direct bridge doctor for the affected agent:

```bash
ouro mcp doctor --agent <agent>
```

This launches `ouro mcp-serve` directly, calls the MCP `status` tool, and reports daemon health, sense health, MCP/daemon version alignment, and the repair commands.

For CI-style checks, use:

```bash
ouro mcp canary --agent <agent> --require-sense <sense>
```

## Repair

For Codex:

```bash
ouro setup --tool codex --agent <agent>
```

For Claude Code:

```bash
ouro setup --tool claude-code --agent <agent>
```

Then open a fresh dev-tool session. Existing MCP stdio processes keep the runtime they were launched with, so registration updates cannot hot-reload an already-running MCP child process.

If the doctor reports `daemon=unreachable`, start or refresh the daemon first:

```bash
ouro up
ouro mcp doctor --agent <agent>
```

## Any-Agent Rule

Do not special-case Slugger or any other personal bundle. Replace `<agent>` with the bundle name and use the same commands for every Ouro agent.
