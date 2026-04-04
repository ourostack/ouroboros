import { execSync } from "child_process";
import { spawnBackgroundShell, getShellSession, listShellSessions, tailShellSession, detectDestructivePatterns } from "./shell-sessions";
import { loadAgentConfig } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";
import type { ToolDefinition } from "./tools-base";

export const shellToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "shell",
        description: "Run a shell command and return stdout/stderr. Working directory persists between calls. Use dedicated tools instead of shell when available: read_file instead of cat, edit_file instead of sed, glob instead of find, grep instead of grep/rg. Reserve shell for operations that genuinely need the shell: installing packages, running builds/tests, git operations, process management. Be careful with destructive commands -- consider reversibility before running. If a command fails, read the error output before retrying with a different approach.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout_ms: {
              type: "number",
              description: "Timeout in milliseconds. Default: 30000. Max: 600000.",
            },
            background: {
              type: "boolean",
              description: "Run in background. Returns immediately with a process ID. Use shell_status/shell_tail to monitor.",
            },
          },
          required: ["command"],
        },
      },
    },
    handler: (a) => {
      // Destructive pattern detection (friction, not a block)
      const destructivePatterns = detectDestructivePatterns(a.command)
      if (destructivePatterns.length > 0) {
        emitNervesEvent({
          level: "warn",
          event: "tool.shell.destructive_detected",
          component: "tools",
          message: `destructive pattern detected: ${destructivePatterns.join(", ")}`,
          meta: { command: a.command, patterns: destructivePatterns },
        })
      }

      // Background mode: spawn and return immediately
      if (a.background === "true") {
        const session = spawnBackgroundShell(a.command)
        return JSON.stringify({ id: session.id, command: session.command, status: session.status })
      }

      const MAX_TIMEOUT = 600000
      const requestedTimeout = Number(a.timeout_ms) || 0
      let configDefault = 30000
      try { configDefault = loadAgentConfig().shell?.defaultTimeout ?? 30000 } catch { /* test env: no --agent flag */ }
      const baseTimeout = requestedTimeout > 0 ? requestedTimeout : configDefault
      const timeout = Math.min(baseTimeout, MAX_TIMEOUT)
      const output = execSync(a.command, {
        encoding: "utf-8",
        timeout,
      })

      if (destructivePatterns.length > 0) {
        return `${output}\n\n--- destructive pattern detected: ${destructivePatterns.join(", ")} ---`
      }
      return output
    },
    summaryKeys: ["command"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "shell_status",
        description: "Check status of background shell processes. Omit id to list all.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Background shell process ID" },
          },
        },
      },
    },
    handler: (a) => {
      if (!a.id) {
        return JSON.stringify(listShellSessions())
      }
      const session = getShellSession(a.id)
      if (!session) return `process not found: ${a.id}`
      return JSON.stringify(session)
    },
    summaryKeys: ["id"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "shell_tail",
        description: "Show recent output from a background shell process.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Background shell process ID" },
          },
          required: ["id"],
        },
      },
    },
    handler: (a) => {
      /* v8 ignore next -- schema requires id, defensive guard @preserve */
      if (!a.id) return "id is required"
      const output = tailShellSession(a.id)
      if (output === undefined) return `process not found: ${a.id}`
      return output || "(no output yet)"
    },
    summaryKeys: ["id"],
  },
]
