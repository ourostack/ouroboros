import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { getAgentName, getAgentStateRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "../heart/daemon/socket-client"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * `restart_runtime` is the agent-callable counterpart to `ouro down && ouro up`.
 *
 * Agents used to ask the human to restart their daemon over BlueBubbles because
 * they had no primitive to do it themselves. With launchctl's KeepAlive policy the
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

export const RESTART_COOLDOWN_MS = 6 * 60 * 60 * 1000

function restartCooldownPath(agentName: string): string {
  return path.join(getAgentStateRoot(agentName), "daemon", "restart-runtime-cooldown.json")
}

function readLastRestartMs(agentName: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(restartCooldownPath(agentName), "utf8")) as { requestedAtMs?: unknown }
    return typeof parsed.requestedAtMs === "number" ? parsed.requestedAtMs : null
  } catch {
    return null
  }
}

// The cooldown is stored per agent, but the restart it limits is daemon-wide.
function recordRestart(agentName: string, nowMs: number): void {
  try {
    const file = restartCooldownPath(agentName)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
    fs.writeFileSync(temporary, JSON.stringify({ requestedAtMs: nowMs }), "utf8")
    fs.renameSync(temporary, file)
  } catch {
    // A failed cooldown write must not block an otherwise allowed restart.
  }
}

async function restartRuntime(args: RestartRuntimeArgs, agentName: string, ctx?: ToolContext): Promise<string> {
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    return JSON.stringify({ error: "reason is required (one-line audit string)" })
  }
  const reason = args.reason.trim()

  if (ctx?.autonomousTurnKind) {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.runtime_restart_refused",
      message: "restart_runtime refused in an autonomous turn",
      meta: { agent: agentName, turnKind: ctx.autonomousTurnKind, reason },
    })
    return JSON.stringify({
      refused: true,
      code: "autonomous_turn_restart_refused",
      error: `restart_runtime is not allowed from an autonomous ${ctx.autonomousTurnKind} turn: restarting the daemon kills in-flight work for every agent and habit. A tool error or missing capability is not evidence of a dead runtime. Record or report the problem (note it, surface it to the owner) instead of restarting.`,
    })
  }
  const lastMs = readLastRestartMs(agentName)
  const nowMs = Date.now()
  if (lastMs !== null && lastMs <= nowMs && nowMs - lastMs < RESTART_COOLDOWN_MS) {
    return JSON.stringify({
      refused: true,
      code: "restart_cooldown",
      error: `a restart was already requested ${Math.round((nowMs - lastMs) / 60000)} minutes ago; agent-requested restarts are limited to one per 6 hours. Record or report the problem instead.`,
      retryAfterMs: RESTART_COOLDOWN_MS - (nowMs - lastMs),
    })
  }

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
    // Only a daemon that accepted the command starts the cooldown; a failed attempt must not lock the owner out.
    if (response.ok) recordRestart(agentName, nowMs)
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
    handler: async (args, ctx) => {
      const agentName = getAgentName()
      return restartRuntime({ reason: args.reason }, agentName, ctx)
    },
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "restarts the hosting runtime" },
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
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "revives a managed runtime sense" },
  },
]
