import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import {
  archiveAppSession, eventLogSize, listAppSessions, openAppChat, restartEnqueue, restartStatus, resumeAppSession,
  readAppSessionHistory, sendToAppSession, snapshot, type AppSessionRow, type AppSessionState, type AppSessionsOptions,
} from "../senses/app-sessions/client"
import { addProbe, readProbes, readWatches, removeProbe, unwatchSession, watchSession } from "../senses/app-sessions/store"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * The app-sessions tools: read and write this machine's GitHub Copilot app sessions. Every write is logged as a
 * nerves event; none is gated. A session the agent writes to is watched, so its next finished reply comes back to the
 * agent through the app-sessions sense.
 */
const STATES: readonly AppSessionState[] = ["working", "waiting", "stuck", "idle"]

/** This Mac's app, in `~/.copilot`. */
const clientOptions: AppSessionsOptions = {}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return fallback
}

export function appSessionsToolsEnabled(agentRoot: string | undefined): boolean {
  if (!agentRoot) return false
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as { senses?: Record<string, { enabled?: unknown } | undefined> }
    return config.senses?.["app-sessions"]?.enabled === true
  } catch {
    return false
  }
}

async function run(tool: string, ctx: ToolContext | undefined, body: (agentRoot: string) => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<string> {
  if (!ctx?.agentRoot) return JSON.stringify({ error: "the app-sessions tools need an agent runtime" })
  try {
    const result = await body(ctx.agentRoot)
    emitNervesEvent({ component: "repertoire", event: "repertoire.app_sessions_tool", message: "ran an app-sessions tool", meta: { tool } })
    return JSON.stringify(result)
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.app_sessions_tool_error", message: "app-sessions tool call failed", meta: { tool, error: (error as Error).message } })
    return JSON.stringify({ error: (error as Error).message })
  }
}

/** A full session id, or a unique prefix of one (the first 8 characters are enough). */
function resolveSession(value: unknown): AppSessionRow {
  const wanted = text(value)
  if (!wanted) throw new Error("name a session: its id, or the start of it, from app_sessions_list")
  const rows = listAppSessions(clientOptions)
  const exact = rows.find(row => row.id === wanted)
  if (exact) return exact
  const matches = rows.filter(row => row.id.startsWith(wanted))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`'${wanted}' matches ${matches.length} sessions; give more of the id`)
  throw new Error(`no session '${wanted}' in this Mac's Copilot app sidebar (app_sessions_list shows them)`)
}

function watch(agentRoot: string, id: string, name: string | null, offset: number): void {
  watchSession(agentRoot, id, name, offset, Date.now())
}

const sessionParam = { type: "string", description: "Session id from app_sessions_list (a unique prefix such as the first 8 characters works)." }

export const appSessionsListTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_list",
      description: "Every session in this Mac's GitHub Copilot app sidebar: id, name, state, why, last activity, actual kind/workspaceId/projectId and known creator/parent ids. Project association is not sidebar nesting; sidebarPlacement is unknown when the local schema cannot prove it. Refresh before reporting where work lives. Read-only.",
      parameters: {
        type: "object",
        properties: { state: { type: "string", enum: [...STATES], description: "Only sessions in this state." } },
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_list", ctx, () => {
    const state = text(args.state)
    const rows = listAppSessions(clientOptions)
    const picture = snapshot(clientOptions, rows)
    return {
      observedAt: picture.at,
      appRunning: picture.appRunning,
      counts: picture.counts,
      sessions: rows.filter(row => !state || row.state === state).map(row => ({
        id: row.id, name: row.name, state: row.state, why: row.detail, kind: row.kind, workspaceId: row.workspaceId,
        project: row.project, projectId: row.projectId, sidebarPlacement: row.sidebarPlacement,
        ...(row.parentSessionId !== undefined ? { parentSessionId: row.parentSessionId } : {}),
        ...(row.creatorSessionId !== undefined ? { creatorSessionId: row.creatorSessionId } : {}),
        ...(row.coordinatingCreatorSessionId !== undefined ? { coordinatingCreatorSessionId: row.coordinatingCreatorSessionId } : {}),
        lastActivity: row.lastActivity, ...(row.remote ? { remote: true } : {}),
      })),
    }
  }),
  summaryKeys: ["state"],
  riskProfile: { mutates: "none", risk: "low" },
}

export const appSessionsTailTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_tail",
      description: "A Copilot app session's last visible prompts and replies, oldest first, with current name/state, observation time and local-log coverage. Re-read before reporting current progress: older messages and watched names are not live status. Remote history is only what this Mac has received. Read-only.",
      parameters: {
        type: "object",
        properties: { session: sessionParam, count: { type: "number", description: "How many messages, 1-50. Default 6." } },
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_tail", ctx, (agentRoot) => {
    const session = resolveSession(args.session)
    const count = Math.min(50, Math.max(1, Math.trunc(Number(args.count) || 6)))
    const history = readAppSessionHistory(session.id, count, clientOptions)
    const watchedName = readWatches(agentRoot)[session.id]?.name
    return {
      session: session.id, name: session.name, state: session.state, lastActivity: session.lastActivity,
      kind: session.kind, workspaceId: session.workspaceId, projectId: session.projectId, sidebarPlacement: session.sidebarPlacement,
      ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
      ...(session.creatorSessionId !== undefined ? { creatorSessionId: session.creatorSessionId } : {}),
      ...(session.coordinatingCreatorSessionId !== undefined ? { coordinatingCreatorSessionId: session.coordinatingCreatorSessionId } : {}),
      ...history,
      ...(watchedName && watchedName !== session.name ? { renamedFrom: watchedName } : {}),
      coverage: history.missing ? "missing" : history.skippedEvents ? "incomplete" : session.remote ? "local-only" : "local",
      freshness: "point-in-time; re-read before reporting current progress",
    }
  }),
  summaryKeys: ["session"],
  riskProfile: { mutates: "none", risk: "low" },
}

export const appSessionsSendTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_send",
      description: "Deliver a message into a Copilot app session, the same request the app's own message box sends. Waits (up to 2 minutes) for the app to accept it: a session that is not loaded loads first. Its next finished reply comes back to you as an inbound message unless watch is false.",
      parameters: {
        type: "object",
        properties: {
          session: sessionParam,
          message: { type: "string", description: "What to send." },
          delivery: { type: "string", enum: ["immediate", "enqueue"], description: "immediate (default) steers the session now; enqueue waits behind its current work." },
          watch: { type: "boolean", description: "Bring the session's next reply back to you. Default true." },
        },
        required: ["session", "message"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_send", ctx, async (agentRoot) => {
    const session = resolveSession(args.session)
    const message = typeof args.message === "string" ? args.message : ""
    if (!message.trim()) throw new Error("say what to send")
    const offset = eventLogSize(session.id, clientOptions)
    const delivery = text(args.delivery) === "enqueue" ? "enqueue" : "immediate"
    const result = await sendToAppSession(session.id, message, { ...clientOptions, delivery })
    const watching = result.ok && flag(args.watch, true)
    if (watching) watch(agentRoot, session.id, session.name, offset)
    return { session: session.id, name: session.name, ...result, watching }
  }),
  summaryKeys: ["session"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends a message into another agent session in the owner's Copilot app" },
}

export const appSessionsResumeTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_resume",
      description: "Nudge a stuck or stopped Copilot app session to continue where it left off (the resume message the Mac's app keeper sends after a restart), with an optional note. Its next reply comes back to you.",
      parameters: {
        type: "object",
        properties: { session: sessionParam, note: { type: "string", description: "Anything to add to the resume message." } },
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_resume", ctx, async (agentRoot) => {
    const session = resolveSession(args.session)
    const offset = eventLogSize(session.id, clientOptions)
    const result = await resumeAppSession(session.id, text(args.note) || undefined, clientOptions)
    if (result.ok) watch(agentRoot, session.id, session.name, offset)
    return { session: session.id, name: session.name, ...result, watching: result.ok }
  }),
  summaryKeys: ["session"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "tells another agent session in the owner's Copilot app to continue" },
}

export const appSessionsNewTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_new",
      description: "Create a standalone general chat, NOT a project/workspace session and NOT a child under an existing workspace. cwd and prompt text do not choose sidebar placement. Workspace/project/parent targets are unsupported and refused without creating anything. Returns actual kind/association and verified or unknown placement; do not claim workspace placement from a project id or delegated child. Initial message acceptance is separate from creation. You may archive any session this tool created.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sidebar title." },
          prompt: { type: "string", description: "First message." },
          cwd: { type: "string", description: "Working folder. Default: the home folder." },
          agent: { type: "string", description: "Custom agent to run as, for example desk:worker." },
          model: { type: "string", description: "Model id." },
          target: { type: "string", enum: ["chat", "workspace"], description: "Default chat. workspace is unsupported and refused; use the app's native project-session creation instead." },
          project: { type: "string", description: "Project placement is unsupported by this tool and refused." },
          workspace: { type: "string", description: "Workspace placement is unsupported by this tool and refused." },
          parent_session: { type: "string", description: "Parent/child placement is unsupported by this tool and refused." },
        },
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_new", ctx, async (agentRoot) => {
    if ((text(args.target) && text(args.target) !== "chat") || args.project !== undefined || args.workspace !== undefined || args.parent_session !== undefined) {
      throw new Error("app_sessions_new supports only a standalone chat; workspace/project/parent placement is unsupported. Nothing was created. Use the Copilot app's native project-session creation and verify its actual sidebar placement.")
    }
    const name = text(args.name)
    const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : undefined
    const opened = await openAppChat({
      ...(name ? { name } : {}), ...(prompt ? { prompt } : {}),
      ...(text(args.cwd) ? { cwd: text(args.cwd) } : {}), ...(text(args.agent) ? { agent: text(args.agent) } : {}), ...(text(args.model) ? { model: text(args.model) } : {}),
    }, clientOptions)
    if (!opened.sessionId) return { ...opened }
    addProbe(agentRoot, opened.sessionId, opened.placement?.name ?? (name || null), Date.now())
    const watching = !!prompt && opened.sent?.ok === true
    if (watching) watch(agentRoot, opened.sessionId, opened.placement?.name ?? (name || null), 0)
    return { ...opened, watching }
  }),
  summaryKeys: ["name"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "opens a new agent session in the owner's Copilot app" },
}

export const appSessionsArchiveTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_archive",
      description: "Archive a Copilot app session that you opened with app_sessions_new (its workspace goes too).",
      parameters: { type: "object", properties: { session: sessionParam }, required: ["session"], additionalProperties: false },
    },
  },
  handler: (args, ctx) => run("app_sessions_archive", ctx, async (agentRoot) => {
    const id = text(args.session)
    const probes = readProbes(agentRoot)
    const match = Object.keys(probes).filter(probe => probe === id || (id.length > 0 && probe.startsWith(id)))
    if (match.length !== 1) throw new Error(`'${id}' is not one session you opened with app_sessions_new (yours: ${Object.keys(probes).join(", ") || "none"})`)
    const result = await archiveAppSession(match[0], clientOptions)
    if (result.ok) {
      removeProbe(agentRoot, match[0])
      unwatchSession(agentRoot, match[0])
    }
    return { session: match[0], name: probes[match[0]].name, ...result }
  }),
  summaryKeys: ["session"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "archives a session in the owner's Copilot app" },
}

export const appSessionsRestartTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_restart",
      description: "The Copilot app's courtesy restart, through this Mac's app keeper (it never restarts the app itself). status: the keeper's queue, panel, last restarts and resume state. enqueue: ask for a restart; the keeper restarts at once when nobody is at the Mac, otherwise shows the person a \"Restart now\" / \"Not now\" panel, and resumes every working session afterwards. Says so plainly when the keeper is not installed.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "enqueue"], description: "Default status." },
          why: { type: "string", description: "enqueue: the reason, shown to the person in the panel." },
        },
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_restart", ctx, async () => {
    if (text(args.action) !== "enqueue") return await restartStatus(clientOptions)
    const why = text(args.why)
    if (!why) throw new Error("say why the app needs a restart; the person sees it in the panel")
    return await restartEnqueue(why, ctx?.agentName ?? "an agent", clientOptions)
  }),
  summaryKeys: ["action"],
  riskProfile: (args) => text(args.action) === "enqueue"
    ? { mutates: "external_side_effect", risk: "high", reason: "queues a restart of the owner's Copilot app" }
    : { mutates: "none", risk: "low" },
}

export const appSessionsWatchTool: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "app_sessions_watch",
      description: "Start or stop bringing a Copilot app session's finished replies back to you as inbound messages (sending to a session starts it; it lasts a day after your last message).",
      parameters: {
        type: "object",
        properties: { session: sessionParam, watch: { type: "boolean", description: "true to start (default), false to stop." } },
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => run("app_sessions_watch", ctx, (agentRoot) => {
    const session = resolveSession(args.session)
    if (!flag(args.watch, true)) return { session: session.id, watching: false, wasWatching: unwatchSession(agentRoot, session.id) }
    watch(agentRoot, session.id, session.name, eventLogSize(session.id, clientOptions))
    return { session: session.id, name: session.name, watching: true }
  }),
  summaryKeys: ["session"],
  riskProfile: { mutates: "durable_state_write", risk: "high", reason: "changes which app sessions' replies wake the agent" },
}

export const appSessionsToolDefinitions: ToolDefinition[] = [
  appSessionsListTool, appSessionsTailTool, appSessionsSendTool, appSessionsResumeTool, appSessionsNewTool, appSessionsArchiveTool, appSessionsRestartTool, appSessionsWatchTool,
]
