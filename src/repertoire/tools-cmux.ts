import * as fs from "node:fs"
import * as path from "node:path"
import { resolveCmuxConnection } from "../heart/cmux-config"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { pendingFeedItems, readCmuxState, surfaceForSession } from "../senses/cmux/attention"
import { createCmuxClient, type CmuxClient } from "../senses/cmux/client"
import { redactSecrets } from "../senses/cmux/redact"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * The cmux sense's tools: who needs the human (`cmux_overview`), what a terminal shows
 * (`cmux_read`), and a one-line status or desktop notification for the human (`cmux_signal`).
 * They talk to cmux's control socket directly with this machine's cmux credential.
 */
export const CMUX_STATUS_KEY = "ouro"
const STATUS_MAX_CHARS = 120
const READ_MAX_CHARS = 16_000
const REQUEST_PREVIEW_CHARS = 600

interface Workspace { id: string; ref: string; title: string; selected: boolean; surfaces: Array<{ id: string; ref: string; title: string; type: string }> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function cmuxToolsEnabled(agentRoot: string | undefined): boolean {
  if (!agentRoot) return false
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as { senses?: { cmux?: { enabled?: unknown } } }
    return config.senses?.cmux?.enabled === true
  } catch {
    return false
  }
}

function clientFor(ctx: ToolContext | undefined): CmuxClient | string {
  if (!ctx?.agentName || !ctx.agentRoot) return "the cmux tools need an agent runtime"
  const machine = readMachineRuntimeCredentialConfig(ctx.agentName)
  const resolved = resolveCmuxConnection(ctx.agentName, machine.ok ? machine.config : {})
  return resolved.ok ? createCmuxClient(resolved.connection, { agentName: ctx.agentName }) : resolved.error
}

function workspacesFrom(tree: Record<string, unknown>): Workspace[] {
  return list(tree.windows).flatMap((window) => list(window.workspaces)).map((workspace) => ({
    id: text(workspace.id),
    ref: text(workspace.ref),
    title: text(workspace.title),
    selected: workspace.selected === true,
    surfaces: list(workspace.panes).flatMap((pane) => list(pane.surfaces)).map((surface) => ({
      id: text(surface.id), ref: text(surface.ref), title: text(surface.title), type: text(surface.type),
    })),
  }))
}

async function readTree(client: CmuxClient): Promise<Workspace[]> {
  return workspacesFrom(await client.call("system.tree", { all_windows: true }))
}

function failure(tool: string, error: unknown): string {
  const message = (error as Error).message
  emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.cmux_tool_error", message: "cmux tool call failed", meta: { tool, error: message } })
  return JSON.stringify({ error: message })
}

async function overview(ctx: ToolContext | undefined): Promise<string> {
  const client = clientFor(ctx)
  if (typeof client === "string") return JSON.stringify({ error: client })
  const state = readCmuxState(path.join(ctx!.agentRoot!, "state", "senses", "cmux", "state.json"), new Date().toISOString())
  try {
    const workspaces = await readTree(client)
    const pending = pendingFeedItems(await client.call("feed.list", { pending_only: true }))
    const refFor = (surfaceId: string | undefined): { workspace: string | null; surface: string | null } => {
      for (const workspace of workspaces) {
        const surface = workspace.surfaces.find((entry) => entry.id === surfaceId)
        if (surface) return { workspace: workspace.ref, surface: surface.ref }
      }
      return { workspace: null, surface: null }
    }
    emitNervesEvent({ component: "repertoire", event: "repertoire.cmux_overview", message: "read cmux overview", meta: { workspaces: workspaces.length, waiting: pending.length } })
    return JSON.stringify({
      sense: { connected: state.connected, lastError: state.lastError },
      waitingOnHuman: pending.map((item) => {
        const where = refFor(surfaceForSession(state, item.workstreamId)?.surfaceId)
        return {
          requestId: item.requestId,
          kind: item.kind,
          agent: item.source,
          tool: item.toolName,
          cwd: item.cwd,
          createdAt: item.createdAt,
          workspace: where.workspace,
          surface: where.surface,
          request: item.toolInput ? redactSecrets(item.toolInput).slice(0, REQUEST_PREVIEW_CHARS) : null,
          requestTruncated: item.toolInputTruncated || (item.toolInput?.length ?? 0) > REQUEST_PREVIEW_CHARS,
        }
      }),
      workspaces: workspaces.map((workspace) => ({
        ref: workspace.ref,
        title: workspace.title,
        selected: workspace.selected,
        surfaces: workspace.surfaces.map((surface) => {
          const activity = state.surfaces[surface.id]
          return {
            ref: surface.ref,
            title: surface.title,
            type: surface.type,
            ...(activity ? { agent: activity.agent, lifecycle: activity.lifecycle, lastHook: activity.lastHook, lastTool: activity.lastTool, lastActivityAt: activity.at, cwd: activity.cwd } : {}),
          }
        }),
      })),
    })
  } catch (error) {
    return failure("cmux_overview", error)
  }
}

export const cmuxOverviewToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "cmux_overview",
      description: "Who needs the human, across every coding agent running in cmux on this Mac. Returns the decisions cmux is holding open (permission requests, questions, plan approvals: which agent, tool, folder, terminal, and a redacted preview of the request), and every workspace and terminal with what its agent was last doing (working, idle = finished its turn and waiting for a prompt, waiting = blocked on the human, ended). Read-only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  handler: (_args, ctx) => overview(ctx),
  summaryKeys: [],
  riskProfile: { mutates: "none", risk: "low" },
}

function boundedLines(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(text(value), 10)
  return Number.isFinite(parsed) ? Math.min(400, Math.max(1, Math.trunc(parsed))) : 60
}

export const cmuxReadToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "cmux_read",
      description: "Read the text on one cmux terminal (what a coding agent session shows now, or with scrollback what it did recently). Secret-shaped strings are redacted and the text is bounded. Read-only. Take the surface ref (for example surface:12) from cmux_overview.",
      parameters: {
        type: "object",
        properties: {
          surface: { type: "string", description: "Surface ref (surface:12) or id from cmux_overview." },
          lines: { type: "number", description: "How many lines, 1-400. Default 60." },
          scrollback: { type: "boolean", description: "Include scrollback above the visible screen." },
        },
        required: ["surface"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    const surface = text(args.surface).trim()
    if (!surface) return JSON.stringify({ error: "name a surface ref or id from cmux_overview" })
    const client = clientFor(ctx)
    if (typeof client === "string") return JSON.stringify({ error: client })
    try {
      const scrollback = (args.scrollback as unknown) === true || args.scrollback === "true"
      const result = await client.call("surface.read_text", { surface_id: surface, lines: boundedLines(args.lines), scrollback })
      const screen = redactSecrets(text(result.text))
      emitNervesEvent({ component: "repertoire", event: "repertoire.cmux_read", message: "read cmux terminal text", meta: { chars: screen.length, scrollback } })
      return JSON.stringify({
        surface: text(result.surface_ref) || surface,
        workspace: text(result.workspace_ref) || null,
        text: screen.length > READ_MAX_CHARS ? screen.slice(-READ_MAX_CHARS) : screen,
        truncated: screen.length > READ_MAX_CHARS,
      })
    } catch (error) {
      return failure("cmux_read", error)
    }
  },
  summaryKeys: ["surface"],
  riskProfile: { mutates: "none", risk: "low" },
}

/** A v1 socket argument: quoted, with the characters cmux's tokenizer treats as special escaped. */
function socketQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`
}

export const cmuxSignalToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "cmux_signal",
      description: `Tell the human something through cmux on this Mac. status sets this agent's one-line status pill on a workspace's sidebar entry (at most ${STATUS_MAX_CHARS} characters; an empty string clears it). notify_title with notify_body posts a desktop notification tied to that workspace. Give at least one. It changes only what cmux shows; it never types into a terminal or answers an agent.`,
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace ref (workspace:3) or id from cmux_overview." },
          status: { type: "string", description: "One line for the sidebar status, or an empty string to clear it." },
          notify_title: { type: "string", description: "Desktop notification title." },
          notify_body: { type: "string", description: "Desktop notification body." },
        },
        required: ["workspace"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    const target = text(args.workspace).trim()
    const status = typeof args.status === "string" ? args.status.trim() : null
    const title = text(args.notify_title).trim()
    if (!target) return JSON.stringify({ error: "name a workspace ref or id from cmux_overview" })
    if (status === null && !title) return JSON.stringify({ error: "give a status, a notify_title, or both" })
    if (status !== null && (status.length > STATUS_MAX_CHARS || /[\r\n]/.test(status))) return JSON.stringify({ error: `status must be one line of at most ${STATUS_MAX_CHARS} characters` })
    const client = clientFor(ctx)
    if (typeof client === "string") return JSON.stringify({ error: client })
    try {
      const workspace = (await readTree(client)).find((entry) => entry.ref === target || entry.id === target)
      if (!workspace) return JSON.stringify({ error: `no cmux workspace ${target}; see cmux_overview` })
      const done: string[] = []
      if (status !== null) {
        await client.command(status
          ? `set_status ${CMUX_STATUS_KEY} ${socketQuote(status)} --tab=${workspace.id}`
          : `clear_status ${CMUX_STATUS_KEY} --tab=${workspace.id}`)
        done.push(status ? "status set" : "status cleared")
      }
      if (title) {
        await client.call("notification.create", { title, subtitle: "", body: text(args.notify_body), workspace_id: workspace.id })
        done.push("notification sent")
      }
      emitNervesEvent({ component: "repertoire", event: "repertoire.cmux_signal", message: "signalled the human through cmux", meta: { done } })
      return JSON.stringify({ workspace: workspace.ref, done })
    } catch (error) {
      return failure("cmux_signal", error)
    }
  },
  summaryKeys: ["workspace", "status", "notify_title"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "changes what cmux shows the human (sidebar status or a desktop notification)" },
}

export const cmuxToolDefinitions: ToolDefinition[] = [cmuxOverviewToolDefinition, cmuxReadToolDefinition, cmuxSignalToolDefinition]
