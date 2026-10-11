import * as fs from "node:fs"
import * as path from "node:path"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { resolveShepherdConnection } from "../heart/shepherd-config"
import { emitNervesEvent } from "../nerves/runtime"
import { createCmuxClient } from "../senses/shepherd/client"
import { createCmuxHost } from "../senses/shepherd/cmux"
import type { ShepherdHost } from "../senses/shepherd/host"
import { redactSecrets } from "../senses/shepherd/redact"
import { readReturns, type ReturnRecord } from "../senses/shepherd/returns"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * Shepherd's tools: every coding-agent session on this machine's terminal host with what Shepherd
 * last decided about it (`shepherd_overview`), what a session shows (`shepherd_read`), and a status
 * line or notification for the human (`shepherd_signal`).
 */
const STATUS_MAX_CHARS = 120
const READ_MAX_CHARS = 16_000

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function shepherdToolsEnabled(agentRoot: string | undefined): boolean {
  if (!agentRoot) return false
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as { senses?: { shepherd?: { enabled?: unknown } } }
    return config.senses?.shepherd?.enabled === true
  } catch {
    return false
  }
}

function hostFor(agentName: string): ShepherdHost | string {
  const machine = readMachineRuntimeCredentialConfig(agentName)
  const resolved = resolveShepherdConnection(agentName, machine.ok ? machine.config : {})
  return resolved.ok ? createCmuxHost(createCmuxClient(resolved.connection, { agentName })) : resolved.error
}

async function withHost(tool: string, ctx: ToolContext | undefined, run: (host: ShepherdHost) => Promise<Record<string, unknown>>): Promise<string> {
  if (!ctx?.agentName || !ctx.agentRoot) return JSON.stringify({ error: "the Shepherd tools need an agent runtime" })
  const host = hostFor(ctx.agentName)
  if (typeof host === "string") return JSON.stringify({ error: host })
  try {
    const result = await run(host)
    emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_tool", message: "ran a Shepherd tool", meta: { tool } })
    return JSON.stringify(result)
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_tool_error", message: "Shepherd tool call failed", meta: { tool, error: (error as Error).message } })
    return JSON.stringify({ error: (error as Error).message })
  }
}

export const shepherdOverviewToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_overview",
      description: "Every terminal session on this machine's terminal host (cmux), with the coding agent there when known, and the last time Shepherd judged a return of control in it: when, what kind (premature, gate, done, unclear, loop_guard, error), whether it answered, and why. Read-only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  handler: (_args, ctx) => withHost("shepherd_overview", ctx, async (host) => {
    const last = new Map<string, ReturnRecord>()
    for (const record of readReturns(ctx!.agentRoot!)) last.set(record.session, record)
    return {
      host: host.name,
      sessions: (await host.list()).map((session) => {
        const record = last.get(session.id)
        return { ...session, ...(record ? { lastReturn: { at: record.at, kind: record.kind, action: record.action, reason: record.reason, reply: record.reply, task: record.task } } : {}) }
      }),
    }
  }),
  summaryKeys: [],
  riskProfile: { mutates: "none", risk: "low" },
}

function boundedLines(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(text(value), 10)
  return Number.isFinite(parsed) ? Math.min(400, Math.max(1, Math.trunc(parsed))) : 60
}

export const shepherdReadToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_read",
      description: "Read the text of one terminal session (what a coding agent shows now and what it did recently). Secret-shaped strings are redacted and the text is bounded. Read-only. Take the session id or ref from shepherd_overview.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session id or ref (surface:12) from shepherd_overview." },
          lines: { type: "number", description: "How many lines, 1-400. Default 60." },
        },
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => {
    const session = text(args.session).trim()
    if (!session) return Promise.resolve(JSON.stringify({ error: "name a session id or ref from shepherd_overview" }))
    return withHost("shepherd_read", ctx, async (host) => {
      const screen = redactSecrets(await host.read(session, boundedLines(args.lines)))
      return { session, text: screen.slice(-READ_MAX_CHARS), truncated: screen.length > READ_MAX_CHARS }
    })
  },
  summaryKeys: ["session"],
  riskProfile: { mutates: "none", risk: "low" },
}

export const shepherdSignalToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_signal",
      description: `Tell the human something through the terminal host. status sets Shepherd's one-line status on that session's workspace (at most ${STATUS_MAX_CHARS} characters; an empty string clears it). notify_title with notify_body also posts a desktop notification there. It never types into a terminal.`,
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session id or ref from shepherd_overview." },
          status: { type: "string", description: "One line for the status, or an empty string to clear it." },
          notify_title: { type: "string", description: "Desktop notification title." },
          notify_body: { type: "string", description: "Desktop notification body." },
        },
        required: ["session", "status"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => {
    const session = text(args.session).trim()
    const status = text(args.status).trim()
    const title = text(args.notify_title).trim()
    if (!session) return Promise.resolve(JSON.stringify({ error: "name a session id or ref from shepherd_overview" }))
    if (status.length > STATUS_MAX_CHARS || /[\r\n]/.test(status)) return Promise.resolve(JSON.stringify({ error: `status must be one line of at most ${STATUS_MAX_CHARS} characters` }))
    return withHost("shepherd_signal", ctx, async (host) => {
      await host.signal(session, status || null, title ? { title, body: text(args.notify_body) } : undefined)
      return { session, status: status ? "set" : "cleared", notified: !!title }
    })
  },
  summaryKeys: ["session", "status"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "changes what the terminal host shows the human (a status line or a desktop notification)" },
}

export const shepherdToolDefinitions: ToolDefinition[] = [shepherdOverviewToolDefinition, shepherdReadToolDefinition, shepherdSignalToolDefinition]
