import { getAgentName } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "../heart/daemon/socket-client"
import type { ToolDefinition } from "./tools-base"

/**
 * `restart_runtime` is the agent-callable counterpart to `ouro down && ouro up`.
 *
 * Slugger had been asking Ari to restart his daemon over BlueBubbles because
 * he had no primitive to do it himself. With launchctl's KeepAlive policy the
 * daemon auto-respawns on exit, so this tool simply sends `daemon.restart`:
 * the daemon logs the reason, runs its normal stop path, and exits — launchctl
 * brings it back. In dev mode (no launchctl) the daemon just exits; the
 * developer brings it back manually.
 *
 * Note on response delivery: when the daemon exits, the agent's process exits
 * with it. The agent will not see this tool's result — it experiences a fresh
 * boot on the other side. That's the expected UX: "I asked for a restart,
 * I came back fresh."
 */

interface RestartRuntimeArgs {
  reason: string
}

interface ReviveSenseArgs {
  agent?: unknown
  sense: string
  reason: string
}

async function restartRuntime(args: RestartRuntimeArgs, agentName: string): Promise<string> {
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    return JSON.stringify({ error: "reason is required (one-line audit string)" })
  }
  const reason = args.reason.trim()

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.runtime_restart_requested",
    message: "agent requested runtime restart",
    meta: { agent: agentName, reason },
  })

  try {
    const response = await sendDaemonCommand(DEFAULT_DAEMON_SOCKET_PATH, {
      kind: "daemon.restart",
      reason,
      requestedBy: agentName,
    })
    return JSON.stringify({
      requested: true,
      reason,
      detail: response.message ?? "daemon restart requested",
    })
  } catch (error) {
    return JSON.stringify({
      error: "failed to reach daemon socket",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

async function reviveSense(args: ReviveSenseArgs, agentName: string): Promise<string> {
  if (args.agent !== undefined) {
    return "cross-agent revive is unsupported; revive_sense can only revive this agent's own senses."
  }
  if (typeof args.sense !== "string" || args.sense.trim().length === 0) {
    return JSON.stringify({ error: "sense is required (for example, 'bluebubbles')" })
  }
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    return JSON.stringify({ error: "reason is required (one-line audit string)" })
  }

  const sense = args.sense.trim()
  const reason = args.reason.trim()

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.sense_revive_requested",
    message: "agent requested sense revive",
    meta: { agent: agentName, sense, reason },
  })

  try {
    const response = await sendDaemonCommand(DEFAULT_DAEMON_SOCKET_PATH, {
      kind: "daemon.sense_revive",
      agent: agentName,
      sense,
      reason,
    })

    if (!response.ok) {
      if (response.error === "Unknown daemon command kind 'daemon.sense_revive'.") {
        return JSON.stringify({
          error: "daemon does not support this command; try restart_runtime",
          detail: response.error,
          agent: agentName,
          sense,
        })
      }
      return JSON.stringify({
        error: response.error ?? "daemon failed to revive sense",
        agent: agentName,
        sense,
      })
    }

    return JSON.stringify({
      revived: true,
      agent: agentName,
      sense,
      detail: response.message ?? "sense revive requested",
      snapshot: response.data,
    })
  } catch (error) {
    return JSON.stringify({
      error: "failed to reach daemon socket",
      detail: error instanceof Error ? error.message : String(error),
      agent: agentName,
      sense,
    })
  }
}

export const runtimeToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "restart_runtime",
        description:
          "ask my runtime (the daemon hosting me) to restart itself. for when something is wedged — stale state, recovery queue jammed, version mismatch, or i just need a fresh boot. under launchctl the daemon auto-respawns, so i come back on the other side with a clean slate. takes a one-line reason that lands in the audit log. i will NOT see this tool's response — my process exits with the daemon and i wake up fresh.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "one-line audit reason (e.g. 'bluebubbles recovery queue wedged for 4h', 'picking up daemon version update').",
            },
          },
          required: ["reason"],
        },
      },
    },
    handler: async (args) => {
      const agentName = getAgentName()
      return restartRuntime({ reason: args.reason }, agentName)
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "revive_sense",
        description:
          "revive one of my managed senses after it has wedged or landed in permanent failure. this only works for my own senses, requires family trust, and sends the daemon a one-line reason for the audit log. use restart_runtime instead if the daemon is too old to support sense-level revive.",
        parameters: {
          type: "object",
          properties: {
            sense: {
              type: "string",
              description: "managed sense name to revive, for example 'bluebubbles'.",
            },
            reason: {
              type: "string",
              description: "one-line audit reason for the revive request.",
            },
          },
          required: ["sense", "reason"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (ctx?.context?.friend?.trustLevel !== "family") {
        return "revive_sense requires family trust before I can revive runtime senses."
      }
      const agentName = getAgentName()
      return reviveSense({ agent: args.agent, sense: args.sense, reason: args.reason }, agentName)
    },
  },
]
