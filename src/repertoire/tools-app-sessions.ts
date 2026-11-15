import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import {
  answerSessionInput, archiveSession, createSession, findSession, getSession, getSessionAutomation, getSessionsStatus, listSessionsAndChats, listWorkflows, navigateTo,
  respondToSessionPlan, runWorkflow, saveSessionAutomation, sendSessionMessage,
} from "../senses/app-sessions/app-interface"
import { listAppSessions, readAppSessionHistory, restartEnqueue, restartStatus, type AppSessionsOptions } from "../senses/app-sessions/client"
import { readWatches } from "../senses/app-sessions/store"
import type { ToolContext, ToolDefinition, ToolRiskProfile } from "./tools-base"

/**
 * The app-sessions tools: what a coordinating session of the GitHub Copilot app can do with its client tools, under the
 * app's own names and in its shapes (see `senses/app-sessions/app-interface.ts` for how each reaches the app, and which
 * parts of the app are not reachable from outside it). Beside them, `app_sessions_tail` reads a session's transcript and
 * `app_sessions_restart` restarts the app through Housesitter, which the app's own tools do not do. Every write is
 * logged as a nerves event; none is gated beyond the harness's trust rule (family only).
 */

/** This Mac's app, in `~/.copilot`. */
const clientOptions: AppSessionsOptions = {}

export function appSessionsToolsEnabled(agentRoot: string | undefined): boolean {
  if (!agentRoot) return false
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as { senses?: Record<string, { enabled?: unknown } | undefined> }
    return config.senses?.["app-sessions"]?.enabled === true
  } catch {
    return false
  }
}

type Args = Record<string, unknown>

const READ: ToolRiskProfile = { mutates: "none", risk: "low" }
const write = (reason: string): ToolRiskProfile => ({ mutates: "external_side_effect", risk: "high", reason })

function define(
  name: string, description: string, properties: Record<string, unknown>, required: string[], risk: ToolRiskProfile,
  body: (args: Args, agentRoot: string, ctx: ToolContext) => Promise<Record<string, unknown>>, summaryKeys: string[] = [],
): ToolDefinition {
  return {
    tool: { type: "function", function: { name, description, parameters: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } } },
    handler: async (args, ctx?: ToolContext) => {
      if (!ctx?.agentRoot) return JSON.stringify({ error: "the app-sessions tools need an agent runtime" })
      try {
        const result = await body(args as Args, ctx.agentRoot, ctx)
        emitNervesEvent({ component: "repertoire", event: "repertoire.app_sessions_tool", message: "ran an app-sessions tool", meta: { tool: name } })
        return JSON.stringify(result)
      } catch (error) {
        emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.app_sessions_tool_error", message: "app-sessions tool call failed", meta: { tool: name, error: (error as Error).message } })
        return JSON.stringify({ error: (error as Error).message })
      }
    },
    summaryKeys,
    riskProfile: risk,
  }
}

const session = { type: "string", description: "A session's id from list_sessions_and_chats; a unique start of it (the first 8 characters) works." }
const notifyOnIdle = { type: "string", enum: ["once", "always", "never"], description: "Whether the session's finished replies come back to you as inbound messages: once (default, the next one), always (for a day), or never. The app does not report back to an outside client, so this is how replies reach you." }

export const listSessionsAndChatsTool = define("list_sessions_and_chats", "Every open coding session and chat in this Mac's GitHub Copilot app: id, app_url, name, project, branch, who created and coordinates it. Read-only.", {}, [], READ, () => listSessionsAndChats(clientOptions))

export const getSessionsStatusTool = define(
  "get_sessions_status", "What every session is doing now, with counts: busy, idle, stuck, blocked, and what each blocked one waits on. awaiting_input carries the request_id and the question that answer_session_input or respond_to_session_plan_v2 needs. Read-only.",
  { state: { type: "string", enum: ["busy", "idle", "waiting", "stuck"], description: "Only sessions in this state." } }, [], READ,
  (args, agentRoot) => getSessionsStatus(agentRoot, typeof args.state === "string" ? args.state : undefined, clientOptions), ["state"],
)

export const getSessionTool = define("get_session", "One session's details and what it is doing now, including what it waits on (awaiting_input). Read-only.", { session_id: session }, ["session_id"], READ, (args, agentRoot) => getSession(agentRoot, args.session_id, clientOptions), ["session_id"])

export const sendSessionMessageTool = define(
  "send_session_message", "Send a message into a session, as its message box does; waits up to 2 minutes for the app to accept it (a session that is not loaded loads first). The app takes it for the person's, so say who you are in it. immediate (default) is admitted at the session's next turn boundary; enqueue waits behind its work.",
  { session_id: session, message: { type: "string", description: "What to send." }, delivery_mode: { type: "string", enum: ["immediate", "enqueue"] }, notify_on_idle: notifyOnIdle }, ["session_id", "message"],
  write("sends a message into another agent session in the owner's Copilot app"), (args, agentRoot) => sendSessionMessage(agentRoot, args as never, clientOptions), ["session_id"],
)

export const createSessionTool = define(
  "create_session", "Start a session. With project_id (a project's id or name): a project session in its own worktree (workspace_type branch uses the project's checkout instead), kicked off with kickoff.prompt and allow-all permissions unless kickoff.permission_mode says otherwise. Without it: a standalone chat. Waits for the session to exist (a worktree takes about two minutes). It has no coordinator: the app does not let an outside client be one. You may archive what you create.",
  {
    name: { type: "string", description: "Sidebar title." }, project_id: { type: "string", description: "The project's id or name." }, session_kind: { type: "string", enum: ["chat", "project"] },
    workspace_type: { type: "string", enum: ["worktree", "branch"] }, branch_name: { type: "string", description: "Branch for a worktree; a fresh ouro-… name by default." },
    kickoff: {
      type: "object", description: "The first work.", additionalProperties: false,
      properties: {
        prompt: { type: "string" }, mode: { type: "string", enum: ["interactive", "plan", "autopilot"] }, model: { type: "string" }, agent: { type: "string", description: "Custom agent, for example desk:worker." },
        reasoning_effort: { type: "string" }, permission_mode: { type: "string", description: "allow-all (default) or manual." },
      },
    },
    notify_on_idle: notifyOnIdle,
  }, [], write("opens a new agent session in the owner's Copilot app"), (args, agentRoot) => createSession(agentRoot, args, clientOptions), ["name"],
)

export const answerSessionInputTool = define(
  "answer_session_input", "Answer the question a session asked with ask_user and is blocked on. get_session shows it (awaiting_input.question, choices). A choice or free text. A question asked while this agent was not connected has no request id and cannot be answered here.",
  { session_id: session, answer: { type: "string" } }, ["session_id", "answer"], write("answers a question for the person in another agent session"), (args, agentRoot) => answerSessionInput(agentRoot, args as never, clientOptions), ["session_id"],
)

export const respondToSessionPlanTool = define(
  "respond_to_session_plan_v2", "Approve or reject the plan a session paused on (awaiting_plan_approval). feedback is sent to the session as a message after the decision.",
  { session_id: session, approved: { type: "boolean" }, selected_action: { type: "string", description: "One of awaiting_input.actions; the recommended one by default." }, feedback: { type: "string" } }, ["session_id", "approved"],
  write("approves or rejects another agent session's plan for the person"), (args, agentRoot) => respondToSessionPlan(agentRoot, args as never, clientOptions), ["session_id"],
)

export const archiveSessionTool = define(
  "archive_session", "Archive a session you created with create_session (a project session's worktree goes with it).", { session_id: session }, ["session_id"],
  write("archives a session in the owner's Copilot app"), (args, agentRoot) => archiveSession(agentRoot, args.session_id, clientOptions), ["session_id"],
)

export const navigateToTool = define("navigate_to", "Show a session in the app's window, as following its app_url does.", { id: session }, ["id"], write("changes what the owner's Copilot app shows"), args => navigateTo(args.id, clientOptions), ["id"])

export const saveSessionAutomationTool = define(
  "save_session_automation", "Create or replace the automation that wakes a session on a schedule, or clear it. interval is once (run_at), minutes (every_minutes), daily or weekly (schedule_hour, schedule_minute, schedule_day), or cron (cron_expression, five fields, local time).",
  {
    session_id: session, prompt: { type: "string" }, interval: { type: "string", enum: ["once", "minutes", "daily", "weekly", "cron"] }, run_at: { type: "string" }, every_minutes: { type: "number" },
    schedule_hour: { type: "number" }, schedule_minute: { type: "number" }, schedule_day: { type: "number" }, cron_expression: { type: "string" }, name: { type: "string" },
    clear: { type: "boolean", description: "Remove the session's automation instead." },
  }, ["session_id"], write("schedules wake-ups for an agent session in the owner's Copilot app"), args => saveSessionAutomation(args, clientOptions), ["session_id"],
)

export const getSessionAutomationTool = define("get_session_automation", "The automation attached to a session. Read-only.", { session_id: session }, ["session_id"], READ, args => getSessionAutomation(args.session_id, clientOptions), ["session_id"])

export const listWorkflowsTool = define("list_workflows", "The app's automations (workflows), with their ids and schedules. Read-only.", {}, [], READ, () => listWorkflows(clientOptions))

export const runWorkflowTool = define("run_workflow", "Run one of the app's automations now, in a new session.", { id: { type: "string", description: "From list_workflows." } }, ["id"], write("starts a session in the owner's Copilot app"), args => runWorkflow(args.id, clientOptions), ["id"])

export const appSessionsTailTool = define(
  "app_sessions_tail", "A session's last visible prompts and replies, oldest first, with its current name and state and how much of the local log was read. Re-read before reporting current progress: older messages are not live status. Read-only.",
  { session_id: session, count: { type: "number", description: "How many messages, 1-50. Default 6." } }, ["session_id"], READ,
  async (args, agentRoot) => {
    const row = findSession(await listAppSessions(clientOptions), args.session_id)
    const history = readAppSessionHistory(row.id, Math.min(50, Math.max(1, Math.trunc(Number(args.count) || 6))), clientOptions)
    const watchedName = readWatches(agentRoot)[row.id]?.name
    return {
      session_id: row.id, name: row.name, state: row.state, last_activity: row.lastActivity, ...history, ...(watchedName && watchedName !== row.name ? { renamed_from: watchedName } : {}),
      coverage: history.missing ? "missing" : history.skippedEvents ? "incomplete" : row.remote ? "local-only" : "local", freshness: "point-in-time; re-read before reporting current progress",
    }
  }, ["session_id"],
)

export const appSessionsRestartTool = define(
  "app_sessions_restart", "Restart the Copilot app and lose no session's work, through Housesitter on this Mac (it restarts the app from outside, as a launchd job). status: the restart in progress or the last one: state, step, start time, result, log. enqueue: start one now; every working session is asked to reach a safe point, the app is quit through its Quit menu (it waits while a person is using the Mac), relaunched, and every session that was working gets a resume message and is checked to have taken a turn. Starting one while another runs is refused. Says so plainly when Housesitter is not on this Mac.",
  { action: { type: "string", enum: ["status", "enqueue"], description: "Default status." }, why: { type: "string", description: "enqueue: the reason; it completes \"restarted at 11:40 for …\" in the resume message each session gets." } }, [],
  { mutates: "external_side_effect", risk: "high", reason: "restarts the owner's Copilot app" },
  async (args, _agentRoot, ctx) => {
    if (args.action !== "enqueue") return await restartStatus(clientOptions) as unknown as Record<string, unknown>
    const why = typeof args.why === "string" ? args.why.trim() : ""
    if (!why) throw new Error("say why the app needs a restart; every session is told in its resume message")
    return await restartEnqueue(why, ctx.agentName ?? "an agent", clientOptions) as unknown as Record<string, unknown>
  }, ["action"],
)

export const appSessionsToolDefinitions: ToolDefinition[] = [
  listSessionsAndChatsTool, getSessionsStatusTool, getSessionTool, sendSessionMessageTool, createSessionTool, answerSessionInputTool, respondToSessionPlanTool, archiveSessionTool,
  navigateToTool, saveSessionAutomationTool, getSessionAutomationTool, listWorkflowsTool, runWorkflowTool, appSessionsTailTool, appSessionsRestartTool,
]
