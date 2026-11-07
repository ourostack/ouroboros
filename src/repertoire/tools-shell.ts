import { exec } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawnBackgroundShell, getShellSession, listShellSessions, tailShellSession, detectDestructivePatterns, type ShellSessionOwner } from "./shell-sessions";
import { getAgentName, getAgentRoot, loadAgentConfig } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { assertRelationshipToolOwner } from "./tool-arguments";
import { TOOL_MAX_CHARS, TOOL_MAX_LINES, cutNotice } from "./tool-limits";

const MAX_BUFFER = 16 * 1024 * 1024

/** The agent's home, or the process directory for a legacy caller that has no agent. */
function shellHome(ctx?: ToolContext): string {
  try {
    return ctx?.agentRoot ?? getAgentRoot()
  } catch {
    return process.cwd()
  }
}

/**
 * Keep the last 2000 lines or 30,000 characters of a command's output. When something is cut, the whole output
 * is saved under the home's state/tool-output folder (owner-only) and the notice names that file.
 */
function tailWithNotice(output: string, home: string): string {
  const body = output.endsWith("\n") ? output.slice(0, -1) : output
  const lines = body.split("\n")
  let tail = lines.slice(-TOOL_MAX_LINES).join("\n")
  if (tail.length > TOOL_MAX_CHARS) {
    tail = tail.slice(tail.length - TOOL_MAX_CHARS)
    const firstBreak = tail.indexOf("\n")
    if (firstBreak >= 0) tail = tail.slice(firstBreak + 1)
  }
  if (tail.length === body.length) return output
  const dir = path.join(home, "state", "tool-output")
  const file = path.join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.txt`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, output, { mode: 0o600 })
  const shown = tail.split("\n").length
  return `${cutNotice("shell", `[output cut to its last ${shown} of ${lines.length} lines; full output saved to ${file}; read_file it with an offset]`, { file })}\n${tail}`
}

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
        description: "Run a shell command in your home; cd does not persist between calls. Keeps the last 2000 lines or 30,000 characters of output and saves the full output to a file it names when it cuts.",
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
    handler: async (a, ctx) => {
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
      const home = shellHome(ctx)
      const raw = await new Promise<string>((resolve, reject) => {
        const child = exec(a.command, { encoding: "utf-8", timeout, cwd: home, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }))
          else resolve(stdout)
        })
        child.stdin?.end()
      })

      const output = tailWithNotice(raw, home)
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
