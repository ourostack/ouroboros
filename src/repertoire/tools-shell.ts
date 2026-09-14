import { execSync } from "child_process";
import { spawnBackgroundShell, getShellSession, listShellSessions, tailShellSession, detectDestructivePatterns, type ShellSessionOwner } from "./shell-sessions";
import { getAgentName, getAgentRoot, loadAgentConfig } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { assertRelationshipToolOwner } from "./tool-arguments";

function shellOwner(ctx?: ToolContext): ShellSessionOwner {
  assertRelationshipToolOwner(ctx)
  const agentName = ctx?.agentName ?? getAgentName()
  return { agentName, agentRoot: ctx?.agentRoot ?? getAgentRoot(agentName) }
}

export const shellToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "shell",
        description: "Run a shell command and return stdout/stderr. Each call starts in the runtime's working directory; cd does not persist between calls. Use dedicated tools instead of shell when available: read_file instead of cat, edit_file instead of sed, glob instead of find, grep instead of grep/rg. Reserve shell for operations that genuinely need the shell: installing packages, running builds/tests, git operations, process management. Be careful with destructive commands -- consider reversibility before running. If a command fails, read the error output before retrying with a different approach.",
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
              description: "Run in background and return immediately with a process ID. Records belong to the initiating agent and live only in process memory. Use separately authorized shell_status/shell_tail calls to monitor. Revocation does not kill a started process; runtime restart loses its record.",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    approvalPolicy: (args) => {
      const command = typeof args.command === "string" ? args.command.trim().split(/\s+/) : []
      if (command[0] === "docker" && command[1] === "restart" && command.length > 2) {
        return {
          kind: "required",
          policyId: "shell.docker-lifecycle.v1",
          actionClass: "service-control",
          requiresSoleCall: true,
        }
      }
      return { kind: "not_required" }
    },
    handler: (a, ctx) => {
      assertRelationshipToolOwner(ctx)
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
      if ((a as { background?: boolean }).background === true) {
        const session = spawnBackgroundShell(a.command, shellOwner(ctx))
        return JSON.stringify({ id: session.id, command: session.command, status: session.status })
      }

      const MAX_TIMEOUT = 600000
      const requestedTimeout = Number(a.timeout_ms) || 0
      let configDefault = 30000
      const owner = ctx?.agentName !== undefined || ctx?.agentRoot !== undefined ? shellOwner(ctx) : undefined
      try {
        configDefault = loadAgentConfig(owner).shell?.defaultTimeout ?? 30000
      } catch (error) {
        if (owner) throw error
        emitNervesEvent({
          level: "warn", component: "tools", event: "tool.shell_config_unavailable",
          message: "legacy shell caller has no configuration; using the default timeout",
          meta: { fallbackTimeout: configDefault },
        })
      }
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
        description: "Check separately authorized status of background shell processes owned by this agent. Omit id to list this agent's records. Records live only in process memory; runtime restart loses observability, and revoked access does not kill a started process.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Background shell process ID" },
          },
        },
      },
    },
    handler: (a, ctx) => {
      if (!a.id) {
        return JSON.stringify(listShellSessions(shellOwner(ctx)))
      }
      const session = getShellSession(a.id, shellOwner(ctx))
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
        description: "Show recent output from a background shell process owned by this agent. Access is reauthorized on each call. Revocation does not kill a started process, and runtime restart loses the in-memory record.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Background shell process ID" },
          },
          required: ["id"],
        },
      },
    },
    handler: (a, ctx) => {
      /* v8 ignore next -- schema requires id, defensive guard @preserve */
      if (!a.id) return "id is required"
      const output = tailShellSession(a.id, shellOwner(ctx))
      if (output === undefined) return `process not found: ${a.id}`
      return output || "(no output yet)"
    },
    summaryKeys: ["id"],
  },
]
