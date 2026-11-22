import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { readDigestText } from "../senses/app-sessions/digest"
import { restartEnqueue, restartStatus, type AppSessionsOptions } from "../senses/app-sessions/client"
import { shepherd, ShepherdFailure, ShepherdUnavailableError } from "../senses/app-sessions/shepherd-cli"
import { addArchiveLog, readWatches, watchSession } from "../senses/app-sessions/store"
import type { ToolContext, ToolDefinition, ToolDoorCard, ToolErrorCard, ToolRiskProfile } from "./tools-base"

/**
 * The app-sessions tools: what a coordinating session of the GitHub Copilot app can do with its client tools, under the
 * app's own names and in its shapes. Each one runs the matching verb of Shepherd's `shepherd` CLI with `--json`
 * (see `senses/app-sessions/shepherd-cli.ts`), which owns the app's socket and database. Beside them, `app_sessions_tail`
 * reads a session's last messages and `app_sessions_restart` restarts the app through Housesitter, which the app's own
 * tools do not do. Every write is logged as a nerves event; none is gated beyond the harness's trust rule (family only).
 */

/** This Mac's app, in `~/.copilot`; the restart goes through Housesitter. */
const clientOptions: AppSessionsOptions = {}

/** The status fields a session row carries beyond its identity; `list_sessions_and_chats` leaves them out, as it always has. */
const STATUS_KEYS = ["activity", "awaiting_user_input", "awaiting_plan_approval", "awaiting_permission", "awaiting_input", "was_interrupted"]

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
type Row = Record<string, unknown>

const READ: ToolRiskProfile = { mutates: "none", risk: "low" }
const write = (reason: string): ToolRiskProfile => ({ mutates: "external_side_effect", risk: "high", reason })

const sessionId = (args: Args): string => String(args.session_id)
/** The arguments without `skip`, as the verb's JSON input; undefined when nothing is left, so the verb reads instead. */
function bodyOf(args: Args, ...skip: string[]): Row | undefined {
  const body = Object.fromEntries(Object.entries(args).filter(([key]) => !skip.includes(key)))
  return Object.keys(body).length ? body : undefined
}
/** The `--why` Shepherd records with a write verb: what Ouroboros is doing, then the intent already in the call (a message, a prompt), kept to one line. */
function because(action: string, ...detail: unknown[]): { why: string } {
  const gist = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : "")
  return { why: [action, ...detail.map(gist).filter(Boolean)].join(": ") }
}
const short = (id: unknown): string => String(id).slice(0, 8)
/** Whether a watch answers the session's replies: `never` does not, `always` keeps watching for a day, `once` (the default) stops at the first reply. */
const watchMode = (value: unknown): "once" | "always" | null => (value === "never" ? null : value === "always" ? "always" : "once")

/** A refusal of this module's own, with the code its card names. */
class AppSessionsRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** The code a failed call ends with: Shepherd's own, or one of this module's. */
function codeOf(error: unknown): string {
  if (error instanceof ShepherdFailure || error instanceof AppSessionsRefusal) return error.code
  return error instanceof ShepherdUnavailableError ? "shepherd-not-installed" : "app-sessions-failed"
}

/**
 * An app-sessions tool's card: Shepherd missing (unless the tool doesn't run Shepherd), then the tool's own refusal if
 * it has one, then any other failure.
 */
function card(name: string, effect: "read" | "write", when: string, fix: string, extra: { idempotent?: true; destructive?: true; refusal?: ToolErrorCard; withoutShepherd?: true } = {}): ToolDoorCard {
  const errors: ToolErrorCard[] = [
    ...(extra.withoutShepherd ? [] : [{ code: "shepherd-not-installed", means: "Shepherd isn't installed on this Mac, so the Copilot app can't be reached.", fix: `Tell the owner ${name} needs Shepherd installed; don't reach the app another way.` }]),
    ...(extra.refusal ? [extra.refusal] : []),
    { code: "app-sessions-failed", means: "The call failed outside Shepherd; the error says why. A Shepherd refusal carries Shepherd's own code and fix instead.", fix },
    { code: "no-agent-runtime", means: "The call ran outside an agent's runtime, so the app can't be reached.", fix: `Don't retry; report that ${name} was called without an agent runtime.` },
  ]
  return {
    id: `tool:${name}`, group: "turn-app-sessions", when, effect, errors,
    ...(extra.idempotent ? { idempotent: true as const } : {}), ...(extra.destructive ? { destructive: true as const } : {}),
  }
}

function define(
  name: string, description: string, ax: ToolDoorCard, properties: Record<string, unknown>, required: string[], risk: ToolRiskProfile,
  body: (args: Args, agentRoot: string, ctx: ToolContext) => Promise<Record<string, unknown>>, summaryKeys: string[] = [],
): ToolDefinition {
  return {
    tool: { type: "function", function: { name, description, parameters: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } } },
    ax,
    handler: async (args, ctx?: ToolContext) => {
      if (!ctx?.agentRoot) return JSON.stringify({ error: "the app-sessions tools need an agent runtime", code: "no-agent-runtime" })
      try {
        const result = await body(args as Args, ctx.agentRoot, ctx)
        emitNervesEvent({ component: "repertoire", event: "repertoire.app_sessions_tool", message: "ran an app-sessions tool", meta: { tool: name } })
        return JSON.stringify(result)
      } catch (error) {
        emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.app_sessions_tool_error", message: "app-sessions tool call failed", meta: { tool: name, error: (error as Error).message } })
        return JSON.stringify({ error: (error as Error).message, code: codeOf(error) })
      }
    },
    summaryKeys,
    riskProfile: risk,
  }
}

const session = { type: "string", description: "A session's id from list_sessions_and_chats; a unique start of it (the first 8 characters) works." }
const notifyOnIdle = { type: "string", enum: ["once", "always", "never"], description: "Whether the session's finished replies come back to you as inbound messages: once (default, the next one), always (for a day), or never. The app does not report back to an outside client, so this is how replies reach you." }

export const listSessionsAndChatsTool = define("list_sessions_and_chats", "Every open coding session and chat in this Mac's GitHub Copilot app: id, app_url, name, project, branch, who created and coordinates it. Read-only.", card("list_sessions_and_chats", "read", "Pick this to find a session's id or app_url by name, project or branch; get_sessions_status says what each is doing.", "Call list_sessions_and_chats once more; if it fails again, tell the owner the app can't be listed."), {}, [], READ, async () => {
  const picture = await shepherd(["sessions"])
  return { total: (picture.summary as Row).total, items: (picture.sessions as Row[]).map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !STATUS_KEYS.includes(key)))) }
})

export const getSessionsStatusTool = define(
  "get_sessions_status", "What every session is doing now, with counts: busy, idle, stuck, blocked, and what each blocked one waits on. awaiting_input carries the request_id and the question that answer_session_input or respond_to_session_plan_v2 needs. Read-only.", card("get_sessions_status", "read", "Pick this to see which sessions are busy, stuck or waiting on someone, and on what, across the whole app at once.", "Call get_session for the one you care about, or try get_sessions_status again shortly."),
  { state: { type: "string", enum: ["busy", "idle", "waiting", "stuck"], description: "Only sessions in this state." } }, [], READ,
  args => shepherd(["sessions", ...(typeof args.state === "string" ? ["--state", args.state] : [])]), ["state"],
)

export const getSessionTool = define("get_session", "One session's details and what it is doing now, including what it waits on (awaiting_input). Read-only.", card("get_session", "read", "Pick this to check one session's state and the exact question it waits on before you answer or message it.", "Check the id with list_sessions_and_chats and call get_session again."), { session_id: session }, ["session_id"], READ, args => shepherd(["session", sessionId(args)]), ["session_id"])

export const sendSessionMessageTool = define(
  "send_session_message", "Send a message to a session as a peer: the session sees it as a cross-session message from Ouroboros (Shepherd's own Ouroboros session is the sender and relays it, so the sender is not this runtime itself), never as the owner's turn. Write as yourself, Ouroboros, not as the owner or the owner's agent; the sender already says who you are. Replies come back to that Ouroboros session (read it with shepherd messages). Waits up to 2 minutes for the app to accept it (a session that is not loaded loads first). immediate (default) is admitted at the session's next turn boundary; enqueue waits behind its work.", card("send_session_message", "write", "Pick this to tell or ask another session something as yourself; answer_session_input fits a question it is blocked on.", "Read the session with get_session; resend only if your message isn't in app_sessions_tail."),
  { session_id: session, message: { type: "string", description: "What to send." }, delivery_mode: { type: "string", enum: ["immediate", "enqueue"] }, notify_on_idle: notifyOnIdle }, ["session_id", "message"],
  write("sends a message into another agent session in the owner's Copilot app"),
  async (args, agentRoot) => {
    // The session is resolved and the send time taken before the send, so the watch's cursor sits before any reply to it.
    const row = await shepherd(["session", sessionId(args)])
    const id = String(row.id)
    const mode = watchMode(args.notify_on_idle)
    const sentAt = new Date().toISOString()
    const sent = await shepherd(["send", id], bodyOf(args, "session_id", "notify_on_idle"), because(`Ouroboros messages ${String(row.name)}`, args.message))
    if (mode !== null) watchSession(agentRoot, id, String(row.name), sentAt, Date.now(), mode === "once")
    return { ...sent, watching: mode !== null }
  }, ["session_id"],
)

export const createSessionTool = define(
  "create_session", "Start a session. With project_id (a project's id or name): a project session in its own worktree (workspace_type branch uses the project's checkout instead), kicked off with kickoff.prompt and allow-all permissions unless kickoff.permission_mode says otherwise. Without it: a standalone chat, which shows to peers as \"General Chat\" and has no repository, so use it only for talk that is not repository work. Any work in a repository (for the harness itself: the ouroboros project) must pass project_id, never a chat. Waits for the session to exist (a worktree takes about two minutes). It has no coordinator: the app does not let an outside client be one. You may archive what you create.", card("create_session", "write", "Pick this to start new work in the app: a project session for anything in a repository, a chat only for talk.", "Check list_sessions_and_chats for a half-made session before you create another."),
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
  }, [], write("opens a new agent session in the owner's Copilot app"),
  async (args, agentRoot) => {
    const kickoff = (args.kickoff && typeof args.kickoff === "object" ? args.kickoff : {}) as Row
    const created = await shepherd(["create"], bodyOf(args, "notify_on_idle"), because(`Ouroboros opens ${typeof args.name === "string" && args.name ? args.name : "a session"}`, kickoff.prompt))
    const mode = watchMode(args.notify_on_idle)
    const prompted = Boolean(kickoff.prompt)
    // A new session has no replies before this, so its first one is read from the time it was made.
    if (prompted && mode !== null) watchSession(agentRoot, String(created.session_id), typeof args.name === "string" ? args.name : null, new Date().toISOString(), Date.now(), mode === "once")
    return prompted ? { ...created, watching: mode !== null } : created
  }, ["name"],
)

export const answerSessionInputTool = define(
  "answer_session_input", "Answer the question a session asked with ask_user and is blocked on. get_session shows it (awaiting_input.question, choices). A choice or free text. A question asked while this agent was not connected has no request id and cannot be answered here.", card("answer_session_input", "write", "Pick this when a session is blocked on an ask_user question and the person has told you the answer.", "Call get_session to see whether the question is still open and what choices it takes."),
  { session_id: session, answer: { type: "string" } }, ["session_id", "answer"], write("answers a question for the person in another agent session"),
  args => shepherd(["answer", sessionId(args)], bodyOf(args, "session_id"), because(`Ouroboros answers the question session ${short(args.session_id)} asked`, args.answer)), ["session_id"],
)

export const respondToSessionPlanTool = define(
  "respond_to_session_plan_v2", "Approve or reject the plan a session paused on (awaiting_plan_approval). feedback is sent to the session as a message after the decision.", card("respond_to_session_plan_v2", "write", "Pick this when a session waits for its plan to be approved or rejected and the person has decided.", "Call get_session to see whether the plan still waits, then respond to what it shows."),
  { session_id: session, approved: { type: "boolean" }, selected_action: { type: "string", description: "One of awaiting_input.actions; the recommended one by default." }, feedback: { type: "string" } }, ["session_id", "approved"],
  write("approves or rejects another agent session's plan for the person"), args => shepherd(["plan", sessionId(args)], bodyOf(args, "session_id"), because(`Ouroboros ${args.approved === true ? "approves" : "rejects"} the plan of session ${short(args.session_id)}`, args.feedback)), ["session_id"],
)

export const archiveSessionTool = define(
  "archive_session", "Archive a session you created with create_session (a project session's worktree goes with it). A session you did not create is archived only when the owner asked for that session in this conversation (owner_asked: true) or when it is over the size limit and a newer session names it as handed off. Archiving can be undone, and each such archive is logged and shown in the next digest.", card("archive_session", "write", "Pick this to put away a session you started, or one the owner named for archiving in this conversation.", "Leave the session as it is and tell the owner it couldn't be archived, with the reason.", { destructive: true }), { session_id: session, owner_asked: { type: "boolean", description: "True only when the owner asked in this conversation for this session to be archived." } }, ["session_id"],
  write("archives a session in the owner's Copilot app"),
  async (args, agentRoot) => {
    const ownerAsked = args.owner_asked === true
    const row = await shepherd(["session", sessionId(args)])
    const archived = await shepherd(["archive", String(row.id)], ownerAsked ? { owner_asked: true } : undefined, because(ownerAsked ? `The owner asked Ouroboros to archive ${String(row.name)}` : `Ouroboros archives ${String(row.name)}, which it created or which was handed off`))
    // Shepherd logs the archives it makes itself; the owner-asked ones are logged here for the digest.
    if (ownerAsked) addArchiveLog(agentRoot, { id: String(row.id), name: String(row.name), at: new Date().toISOString(), reason: "owner-asked" })
    return archived
  }, ["session_id"],
)

export const navigateToTool = define("navigate_to", "Show a session in the app's window, as following its app_url does.", card("navigate_to", "write", "Pick this when the owner wants a particular session brought up on screen in the app's window.", "Give the owner the session's app_url from list_sessions_and_chats instead.", { idempotent: true }), { id: session }, ["id"], write("changes what the owner's Copilot app shows"), args => shepherd(["open", String(args.id)]), ["id"])

export const saveSessionAutomationTool = define(
  "save_session_automation", "Create or replace the automation that wakes a session on a schedule, or clear it. interval is once (run_at), minutes (every_minutes), daily or weekly (schedule_hour, schedule_minute, schedule_day), or cron (cron_expression, five fields, local time).", card("save_session_automation", "write", "Pick this to schedule a session to wake with a prompt later or on repeat, or to stop that schedule.", "Read the current schedule with get_session_automation before trying again."),
  {
    session_id: session, prompt: { type: "string" }, interval: { type: "string", enum: ["once", "minutes", "daily", "weekly", "cron"] }, run_at: { type: "string" }, every_minutes: { type: "number" },
    schedule_hour: { type: "number" }, schedule_minute: { type: "number" }, schedule_day: { type: "number" }, cron_expression: { type: "string" }, name: { type: "string" },
    clear: { type: "boolean", description: "Remove the session's automation instead." },
  }, ["session_id"], write("schedules wake-ups for an agent session in the owner's Copilot app"), args => {
    const body = bodyOf(args, "session_id")
    return shepherd(["automation", sessionId(args)], body, because(body ? (args.clear === true ? `Ouroboros clears the wake-ups of session ${short(args.session_id)}` : `Ouroboros schedules a wake-up for session ${short(args.session_id)}`) : `Ouroboros reads the wake-ups of session ${short(args.session_id)}`, args.prompt))
  }, ["session_id"],
)

export const getSessionAutomationTool = define("get_session_automation", "The automation attached to a session. Read-only.", card("get_session_automation", "read", "Pick this to check whether and when a session is set to wake on its own, before changing that.", "Check the session id with list_sessions_and_chats and read it again."), { session_id: session }, ["session_id"], READ, args => shepherd(["automation", sessionId(args)], undefined, because(`Ouroboros reads the wake-ups of session ${short(args.session_id)}`)), ["session_id"])

export const listWorkflowsTool = define("list_workflows", "The app's automations (workflows), with their ids and schedules. Read-only.", card("list_workflows", "read", "Pick this to find the app's saved automations and their ids before running one with run_workflow.", "Call list_workflows again shortly; say the automations can't be listed if it keeps failing."), {}, [], READ, () => shepherd(["workflows"]))

export const runWorkflowTool = define("run_workflow", "Run one of the app's automations now, in a new session.", card("run_workflow", "write", "Pick this to start one of the app's saved automations right now in a fresh session.", "Check the id with list_workflows, and look for a session it already started before running it again."), { id: { type: "string", description: "From list_workflows." } }, ["id"], write("starts a session in the owner's Copilot app"), args => shepherd(["run-workflow", String(args.id)], undefined, because(`Ouroboros runs workflow ${String(args.id)}`)), ["id"])

export const appSessionsTailTool = define(
  "app_sessions_tail", "A session's last visible prompts and replies, oldest first, with its current name and state and how much of the local log was read. Re-read before reporting current progress: older messages are not live status. Read-only.", card("app_sessions_tail", "read", "Pick this to read what a session said and was asked most recently, before reporting its progress.", "Fall back to get_session for its state, and say the latest messages couldn't be read."),
  { session_id: session, count: { type: "number", description: "How many messages, 1-50. Default 6." } }, ["session_id"], READ,
  async (args, agentRoot) => {
    const history = await shepherd(["messages", sessionId(args)], { count: Math.min(50, Math.max(1, Math.trunc(Number(args.count) || 6))) })
    const watchedName = readWatches(agentRoot)[String(history.session_id)]?.name
    return { ...history, ...(watchedName && watchedName !== history.name ? { renamed_from: watchedName } : {}) }
  }, ["session_id"],
)

export const appSessionsRestartTool = define(
  "app_sessions_restart", "Restart the Copilot app and lose no session's work, through Housesitter on this Mac (it restarts the app from outside, as a launchd job). status: the restart in progress or the last one: state, step, start time, result, log. enqueue: start one now; every working session is asked to reach a safe point, the app is quit through its Quit menu (it waits while a person is using the Mac), relaunched, and every session that was working gets a resume message and is checked to have taken a turn. Starting one while another runs is refused. Says so plainly when Housesitter is not on this Mac.", card("app_sessions_restart", "write", "Pick this when the Copilot app itself is hung or needs restarting; it keeps every session's work and resumes them.", "Call app_sessions_restart with action status to see whether a restart is already running.", { withoutShepherd: true, refusal: { code: "why-required", means: "action enqueue came without a reason.", fix: "Call again with why set to what the restart is for; every session sees it in its resume message." } }),
  { action: { type: "string", enum: ["status", "enqueue"], description: "Default status." }, why: { type: "string", description: "enqueue: the reason; it completes \"restarted at 11:40 for …\" in the resume message each session gets." } }, [],
  { mutates: "external_side_effect", risk: "high", reason: "restarts the owner's Copilot app" },
  async (args, _agentRoot, ctx) => {
    if (args.action !== "enqueue") return await restartStatus(clientOptions) as unknown as Record<string, unknown>
    const why = typeof args.why === "string" ? args.why.trim() : ""
    if (!why) throw new AppSessionsRefusal("why-required", "say why the app needs a restart; every session is told in its resume message")
    return await restartEnqueue(why, ctx.agentName ?? "an agent", clientOptions) as unknown as Record<string, unknown>
  }, ["action"],
)

export const appSessionsDigestTool = define(
  "app_sessions_digest", "How everything is going, already worked out with no model: what needs the owner, what is broken, each working session with its card's next step, the Mac's health, the drains and what merged today. Read-only.", card("app_sessions_digest", "read", "Pick this for one precomputed picture of how all the work is going, what needs the owner, and what broke.", "Build the picture from get_sessions_status instead.", { withoutShepherd: true, refusal: { code: "no-digest-yet", means: "No status digest exists, because agent.json gives the app-sessions sense no digest block.", fix: "Tell the owner the digest isn't set up; answer from get_sessions_status meanwhile." } }),
  {}, [], READ,
  async (_args, agentRoot) => {
    const digest = readDigestText(agentRoot, Date.now())
    if (!digest) throw new AppSessionsRefusal("no-digest-yet", "no status digest yet: it is built when agent.json gives the app-sessions sense a digest block")
    return { digest }
  },
)

export const appSessionsToolDefinitions: ToolDefinition[] = [
  listSessionsAndChatsTool, getSessionsStatusTool, getSessionTool, sendSessionMessageTool, createSessionTool, answerSessionInputTool, respondToSessionPlanTool, archiveSessionTool,
  navigateToTool, saveSessionAutomationTool, getSessionAutomationTool, listWorkflowsTool, runWorkflowTool, appSessionsTailTool, appSessionsRestartTool, appSessionsDigestTool,
]
