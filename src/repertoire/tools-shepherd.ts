import * as fs from "node:fs"
import * as path from "node:path"
import { resolveCmuxConnection } from "../heart/cmux-config"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { pendingFeedItems, readCmuxState, surfaceForSession } from "../senses/shepherd/attention"
import { answerOnce, cmuxStateDir, feedItemStatus, judgeFeedItem, recordDecision, type AnswerContext } from "../senses/shepherd/answer"
import { addCase, cmuxCasebookPath, cmuxDecisionLogPath, isShape, readDecisions } from "../senses/shepherd/casebook"
import { createCmuxClient, type CmuxClient } from "../senses/shepherd/client"
import { readCmuxPrinciples } from "../senses/shepherd/principles"
import { redactSecrets } from "../senses/shepherd/redact"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * The cmux sense's tools: who needs the human (`shepherd_overview`), what a terminal shows
 * (`shepherd_read`), and a one-line status or desktop notification for the human (`shepherd_signal`).
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

export function shepherdToolsEnabled(agentRoot: string | undefined): boolean {
  if (!agentRoot) return false
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as { senses?: { shepherd?: { enabled?: unknown } } }
    return config.senses?.shepherd?.enabled === true
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
  emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_tool_error", message: "cmux tool call failed", meta: { tool, error: message } })
  return JSON.stringify({ error: message })
}

async function overview(ctx: ToolContext | undefined): Promise<string> {
  const client = clientFor(ctx)
  if (typeof client === "string") return JSON.stringify({ error: client })
  const state = readCmuxState(path.join(ctx!.agentRoot!, "state", "senses", "shepherd", "state.json"), new Date().toISOString())
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
    emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_overview", message: "read cmux overview", meta: { workspaces: workspaces.length, waiting: pending.length } })
    return JSON.stringify({
      sense: { connected: state.connected, lastError: state.lastError, cmuxVersion: state.cmuxVersion },
      principles: readCmuxPrinciples(ctx!.agentRoot!),
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
    return failure("shepherd_overview", error)
  }
}

export const cmuxOverviewToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_overview",
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
      name: "shepherd_read",
      description: "Read the text on one cmux terminal (what a coding agent session shows now, or with scrollback what it did recently). Secret-shaped strings are redacted and the text is bounded. Read-only. Take the surface ref (for example surface:12) from shepherd_overview.",
      parameters: {
        type: "object",
        properties: {
          surface: { type: "string", description: "Surface ref (surface:12) or id from shepherd_overview." },
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
    if (!surface) return JSON.stringify({ error: "name a surface ref or id from shepherd_overview" })
    const client = clientFor(ctx)
    if (typeof client === "string") return JSON.stringify({ error: client })
    try {
      const scrollback = (args.scrollback as unknown) === true || args.scrollback === "true"
      const result = await client.call("surface.read_text", { surface_id: surface, lines: boundedLines(args.lines), scrollback })
      const screen = redactSecrets(text(result.text))
      emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_read", message: "read cmux terminal text", meta: { chars: screen.length, scrollback } })
      return JSON.stringify({
        surface: text(result.surface_ref) || surface,
        workspace: text(result.workspace_ref) || null,
        text: screen.length > READ_MAX_CHARS ? screen.slice(-READ_MAX_CHARS) : screen,
        truncated: screen.length > READ_MAX_CHARS,
      })
    } catch (error) {
      return failure("shepherd_read", error)
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
      name: "shepherd_signal",
      description: `Tell the human something through cmux on this Mac. status sets this agent's one-line status pill on a workspace's sidebar entry (at most ${STATUS_MAX_CHARS} characters; an empty string clears it). notify_title with notify_body posts a desktop notification tied to that workspace. Give at least one. It changes only what cmux shows; it never types into a terminal or answers an agent.`,
      parameters: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace ref (workspace:3) or id from shepherd_overview." },
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
    if (!target) return JSON.stringify({ error: "name a workspace ref or id from shepherd_overview" })
    if (status === null && !title) return JSON.stringify({ error: "give a status, a notify_title, or both" })
    if (status !== null && (status.length > STATUS_MAX_CHARS || /[\r\n]/.test(status))) return JSON.stringify({ error: `status must be one line of at most ${STATUS_MAX_CHARS} characters` })
    const client = clientFor(ctx)
    if (typeof client === "string") return JSON.stringify({ error: client })
    try {
      const workspace = (await readTree(client)).find((entry) => entry.ref === target || entry.id === target)
      if (!workspace) return JSON.stringify({ error: `no cmux workspace ${target}; see shepherd_overview` })
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
      emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_signal", message: "signalled the human through cmux", meta: { done } })
      return JSON.stringify({ workspace: workspace.ref, done })
    } catch (error) {
      return failure("shepherd_signal", error)
    }
  },
  summaryKeys: ["workspace", "status", "notify_title"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "changes what cmux shows the human (sidebar status or a desktop notification)" },
}

function answerContext(ctx: ToolContext, client: CmuxClient): AnswerContext {
  const stateDir = cmuxStateDir(ctx.agentRoot!)
  return { agentRoot: ctx.agentRoot!, stateDir, client, now: Date.now, cmuxVersion: () => readCmuxState(path.join(stateDir, "state.json"), new Date().toISOString()).cmuxVersion }
}

export const cmuxReplyOnceToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_reply_once",
      description: "Record your judgment that a coding agent's pending permission request is routine and fine to allow once. Your judgment alone never sends anything: the reply goes out only when the code floor, the human's exact precedent and a standing owner grant all allow it, and then only as 'once'. Otherwise your judgment is logged in shadow for the human to review and the request stays with them. Questions, plan approvals, Codex and Copilot requests always stay with the human.",
      parameters: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "The Feed request id from the escalation or shepherd_overview." },
          reasoning: { type: "string", description: "Why this is routine under the cmux principles, in one or two sentences." },
        },
        required: ["request_id", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    const requestId = text(args.request_id).trim()
    const reasoning = text(args.reasoning).trim()
    if (!requestId || !reasoning) return JSON.stringify({ error: "give the request_id and your reasoning" })
    const client = clientFor(ctx)
    if (typeof client === "string") return JSON.stringify({ error: client })
    try {
      const item = pendingFeedItems(await client.call("feed.list", { pending_only: true })).find((entry) => entry.requestId === requestId)
      if (!item) return JSON.stringify({ error: `request ${requestId} is no longer pending` })
      const answers = answerContext(ctx!, client)
      const judgment = judgeFeedItem(answers, item)
      if (judgment.reply) {
        const outcome = await answerOnce(answers, item, judgment)
        return JSON.stringify({ sent: outcome === "replied_once", outcome, authority: judgment.authority, ...(outcome === "replied_once" || outcome === "race" ? {} : { next: "The request stays with the human; tell them with shepherd_signal if it is urgent." }) })
      }
      recordDecision(answers, item, judgment, "shadow", `agent would allow once: ${reasoning}`)
      emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_shadow_judgment", message: "logged the agent's would-be cmux answer in shadow", meta: { tool: item.toolName } })
      return JSON.stringify({ sent: false, outcome: "shadow", reason: judgment.reason, next: "The request stays with the human; tell them with shepherd_signal if it is urgent." })
    } catch (error) {
      return failure("shepherd_reply_once", error)
    }
  },
  summaryKeys: ["request_id"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "may answer a coding agent's permission request once when the floor, a precedent and a standing grant allow it" },
}

export const cmuxCorrectToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_correct",
      description: "Record the human's answer or correction for a coding-agent request the cmux sense judged, as an exact precedent on this machine. 'once' means the human is fine with exactly this request being allowed once next time, and is accepted only when cmux shows the human allowed that request themselves; 'ask' means always ask them about exactly this request. Use it only for what the human actually said, in conversation with them; it is refused in autonomous turns and while handling an external event. A precedent never overrides the code floor, and live replies still need a standing owner grant.",
      parameters: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "The Feed request id the human answered or corrected." },
          verdict: { type: "string", enum: ["once", "ask"], description: "once: fine to allow once next time. ask: always ask." },
          note: { type: "string", description: "What the human said, briefly." },
        },
        required: ["request_id", "verdict", "note"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    const requestId = text(args.request_id).trim()
    const verdict = args.verdict
    if (!requestId || (verdict !== "once" && verdict !== "ask")) return JSON.stringify({ error: "give the request_id and a verdict of once or ask" })
    if (!ctx?.agentRoot) return JSON.stringify({ error: "the cmux tools need an agent runtime" })
    if (ctx.currentExternalEvent || ctx.autonomousTurnKind) return JSON.stringify({ error: "shepherd_correct records what the human said in conversation; it cannot run in an autonomous turn or while handling an external event" })
    const stateDir = cmuxStateDir(ctx.agentRoot)
    const decisions = readDecisions(cmuxDecisionLogPath(stateDir)).filter((entry) => entry.requestId === requestId)
    const decision = [...decisions].reverse().find((entry) => entry.shape)
    if (!decision) return JSON.stringify({ error: `no judged request ${requestId} with a precedent shape; the floor escalates it unconditionally or it was never seen` })
    const shape = decision.shape
    if (!isShape(shape)) return JSON.stringify({ error: `the logged shape for ${requestId} is from an older format and cannot become a precedent; record it again after the sense judges the request anew` })
    if (verdict === "once") {
      // A "once" precedent turns into live authority later, so it must rest on the human's own answer in cmux, not on ours.
      if (decisions.some((entry) => entry.outcome === "reply_sent" || entry.outcome === "replied_once")) return JSON.stringify({ error: `the sense itself replied to ${requestId}; only a request the human answered can become a once precedent` })
      const client = clientFor(ctx)
      if (typeof client === "string") return JSON.stringify({ error: client })
      try {
        const status = await feedItemStatus(client, requestId)
        if (status?.status !== "resolved" || status.kind !== "permission" || !status.mode || status.mode === "deny") {
          return JSON.stringify({ error: `cmux does not show the human allowing ${requestId} (${status ? `${status.status}${status.mode ? `, ${status.mode}` : ""}` : "not listed"}); record 'ask' instead, or wait until they answer it in cmux` })
        }
      } catch (error) {
        return failure("shepherd_correct", error)
      }
    }
    let entry: ReturnType<typeof addCase>
    try {
      entry = addCase(cmuxCasebookPath(stateDir), { verdict, shape, requestId, note: text(args.note), at: new Date().toISOString() })
    } catch (error) {
      return failure("shepherd_correct", error)
    }
    emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_correct", message: "recorded the human's cmux precedent", meta: { verdict } })
    return JSON.stringify({ case: entry.id, verdict, tool: entry.shape.tool, repoRoot: entry.shape.repoRoot })
  },
  summaryKeys: ["request_id", "verdict"],
  riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records a precedent that later decides whether a coding agent's request is answered" },
}

export const shepherdToolDefinitions: ToolDefinition[] = [cmuxOverviewToolDefinition, cmuxReadToolDefinition, cmuxSignalToolDefinition, cmuxReplyOnceToolDefinition, cmuxCorrectToolDefinition]
