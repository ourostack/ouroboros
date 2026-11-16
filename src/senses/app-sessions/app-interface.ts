import { randomUUID } from "node:crypto"
import * as os from "node:os"
import { emitNervesEvent } from "../../nerves/runtime"
import { assertSessionId, eventLogSize, exchange, listAppSessions, SEND_WAIT_MS, type AppSessionRow, type AppSessionsOptions, type Frame, type PermissionPrompt } from "./client"
import { isHandedOff } from "./handoff"
import { addArchiveLog, addProbe, readPending, readProbes, removeProbe, watchSession, type ArchiveLogEntry, type PendingRequest } from "./store"

/**
 * The GitHub Copilot app's own interface, used the way a coordinating session uses its client tools: the same twelve
 * operations, under the app's names, answering in the app's shapes. Each one is a request on the app's local WebSocket,
 * the socket its own window speaks, and a reply read back from it. Nothing here reads the app's database or files.
 *
 * Three things a session gets from the app are not reachable from outside it. An outside client is anonymous: the app
 * takes its messages for the person's, and ignores the creator and coordination fields on a create request, so a session
 * made here has no coordinator and nothing reports back unless the sender watches it. A question or plan approval is
 * announced once, to the clients connected then (see `prompts.ts`). `relay_session_input` and `publish_chat_update` act
 * on the calling session's own conversation, which a client outside the app has none of.
 */
const REQUEST_WAIT_MS = 30_000
const CREATE_WAIT_MS = 300_000
const ARCHIVE_WAIT_MS = 60_000
const ANSWER_WAIT_MS = 15_000
const COORDINATION_NOTE = "an outside client cannot be a session's coordinator, so the app will not report back: replies come back to you through the app-sessions sense instead"

type Result = Record<string, unknown>
type Verdict = "ok" | "fail" | "wait" | "ignore"

const isRecord = (value: unknown): value is Frame => !!value && typeof value === "object" && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null)
const compact = (value: Result): Result => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))
const appUrl = (id: string): string => `ghapp://sessions/${id}`
const reasonOf = (frame: Frame): string => str(frame.error) ?? str(frame.message) ?? str(frame.reason) ?? str(frame.detail) ?? String(frame.type)

/** Whether a sender wants a session's reply back, and for how long: once (the default), always, or never. */
const notifyMode = (value: unknown): "once" | "always" | null => (value === "never" ? null : value === "always" ? "always" : "once")

export interface Asked { ok: boolean; frame: Frame | null; error: string | null }

/** One request and its answer: the frame `settle` calls "ok", or the reason it was refused, or that the app did not answer in time. */
async function ask(frame: Frame, settle: (reply: Frame, requestId: string) => Verdict, waitMs: number, options: AppSessionsOptions): Promise<Asked> {
  // An answer carries the id of the request it answers; every other request gets its own.
  const requestId = str(frame.request_id) ?? randomUUID()
  const verdict = (reply: Frame): Verdict => (reply.type === "socket_error" || reply.type === "error" ? "fail" : settle(reply, requestId))
  const got = await exchange([{ ...frame, request_id: requestId }], { keep: reply => verdict(reply) !== "ignore", done: reply => /^(ok|fail)$/.test(verdict(reply)), waitMs }, options)
  const last = got.at(-1)
  if (last && verdict(last) === "ok") return { ok: true, frame: last, error: null }
  return { ok: false, frame: last ?? null, error: last && verdict(last) === "fail" ? reasonOf(last) : "the app did not answer in time" }
}

/** A session by its id or its project-session (workspace) id, or a unique start of either; the first eight characters are enough. */
export function findSession(rows: AppSessionRow[], value: unknown): AppSessionRow {
  const wanted = str(value)?.trim() ?? ""
  if (!wanted) throw new Error("name a session: its id, or the start of it, from list_sessions_and_chats")
  const exact = rows.find(row => row.id === wanted) ?? rows.find(row => row.workspaceId === wanted)
  if (exact) return exact
  const matches = rows.filter(row => row.id.startsWith(wanted) || row.workspaceId?.startsWith(wanted))
  if (matches.length === 1) return matches[0]!
  throw new Error(matches.length ? `'${wanted}' matches ${matches.length} sessions; give more of the id` : `no session '${wanted}' in the Copilot app (list_sessions_and_chats shows them)`)
}

const resolve = async (value: unknown, options: AppSessionsOptions): Promise<AppSessionRow> => findSession(await listAppSessions(options), value)

function item(row: AppSessionRow): Result {
  return compact({
    type: row.kind === "chat" ? "chat" : "session", id: row.id, app_url: appUrl(row.id), name: row.name, project_id: row.projectId, project_name: row.project, project_repo: row.projectRepo,
    branch: row.branch, path: row.path, created_at: row.createdAt, updated_at: row.updatedAt, creator_session_id: row.creatorSessionId,
    coordinating_creator_session_id: row.coordinatingCreatorSessionId, parent_session_id: row.parentSessionId, is_running: row.isRunning, ...(row.remote ? { remote: true } : {}),
  })
}

/** What an answer needs from a session blocked on something: the request's id and what it asks, or why the id is unknown. */
function awaitingInput(row: AppSessionRow, pending: Record<string, PendingRequest>): Result | undefined {
  const request = pending[row.id]
  if (row.awaiting === "permission") return { kind: "permission", request_id: (row.prompt as PermissionPrompt).requestId, what: (row.prompt as PermissionPrompt).what, note: "answer it in the app; the app's own tools do not answer permissions either" }
  if (row.awaiting === "input" || row.awaiting === "plan") {
    const kind = row.awaiting === "plan" ? "plan" : "user_input"
    if (request && (request.kind === "plan") === (kind === "plan")) {
      return compact({ kind, request_id: request.requestId, question: request.question, choices: request.choices, allow_freeform: request.allowFreeform, summary: request.summary, actions: request.actions })
    }
    return { kind, request_id: null, note: "it was asked while this agent was not connected to the app, which announces a question only once; the person can answer it in the app" }
  }
  return undefined
}

function status(row: AppSessionRow, pending: Record<string, PendingRequest>): Result {
  const input = awaitingInput(row, pending)
  return compact({
    ...item(row), was_interrupted: row.wasInterrupted || null,
    activity: compact({ status: row.state === "working" ? "busy" : row.state, why: row.detail, last_activity: row.lastActivity }),
    awaiting_user_input: row.awaiting === "input", awaiting_plan_approval: row.awaiting === "plan", awaiting_permission: row.awaiting === "permission",
    awaiting_input: input,
  })
}

// ---------- reading ----------

export async function listSessionsAndChats(options: AppSessionsOptions = {}): Promise<Result> {
  const rows = await listAppSessions(options)
  return { total: rows.length, items: rows.map(item) }
}

export async function getSessionsStatus(agentRoot: string, state: string | undefined, options: AppSessionsOptions = {}): Promise<Result> {
  const rows = await listAppSessions(options)
  const pending = readPending(agentRoot)
  const count = (keep: (row: AppSessionRow) => boolean): number => rows.filter(keep).length
  return {
    summary: {
      total: rows.length, running: count(row => row.isRunning), busy: count(row => row.state === "working"), blocked: count(row => row.state === "waiting"), stuck: count(row => row.state === "stuck"),
      awaiting_user_input: count(row => row.awaiting === "input"), awaiting_plan_approval: count(row => row.awaiting === "plan"),
    },
    sessions: rows.filter(row => !state || row.state === state || (state === "busy" && row.state === "working")).map(row => status(row, pending)),
  }
}

export async function getSession(agentRoot: string, id: unknown, options: AppSessionsOptions = {}): Promise<Result> {
  return status(await resolve(id, options), readPending(agentRoot))
}

// ---------- writing ----------

/** Put a message into a session, as its message box does, and wait for the app to accept it (a session that is not loaded loads first). */
export async function deliverMessage(id: string, message: string, mode: "immediate" | "enqueue", options: AppSessionsOptions = {}): Promise<Asked> {
  assertSessionId(id)
  let interim = false
  const sent = await ask(
    { type: "send_message", session_id: id, prompt: message, delivery_mode: mode },
    (reply, requestId) => {
      if (/^session_message_(sent|queued)$/.test(String(reply.type)) && reply.request_id === requestId) return "ok"
      if (reply.type === "session_dispatch_state" && reply.request_id === requestId) {
        interim ||= reply.dispatch_may_have_started === true
        return "wait"
      }
      return reply.request_id === requestId || (reply.session_id === id && /^session_(message_delivery_unknown|resume_failed)$/.test(String(reply.type))) ? "fail" : "ignore"
    },
    options.sendWaitMs ?? SEND_WAIT_MS,
    options,
  )
  const unconfirmed = !sent.ok && interim && sent.frame?.type === "session_dispatch_state"
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_sent", message: "sent a message into a Copilot app session", meta: { session: id, chars: message.length, ok: sent.ok } })
  return unconfirmed ? { ...sent, error: "the app began delivering the message but had not confirmed it in time; read the session before sending it again" } : sent
}

/** `send_session_message`. `notify_on_idle` brings the session's finished reply back to the sender. */
export async function sendSessionMessage(
  agentRoot: string,
  args: { session_id: unknown; message: unknown; delivery_mode?: unknown; notify_on_idle?: unknown },
  options: AppSessionsOptions = {},
): Promise<Result> {
  const message = typeof args.message === "string" ? args.message : ""
  if (!message.trim()) throw new Error("say what to send")
  const row = await resolve(args.session_id, options)
  const offset = eventLogSize(row.id, options)
  const sent = await deliverMessage(row.id, message, args.delivery_mode === "enqueue" ? "enqueue" : "immediate", options)
  const notify = notifyMode(args.notify_on_idle)
  const watching = sent.ok && notify !== null
  if (watching) watchSession(agentRoot, row.id, row.name, offset, Date.now(), notify === "once")
  return compact({ ok: sent.ok, status: sent.ok ? (sent.frame?.type === "session_message_queued" ? "queued" : "accepted") : "failed", session_id: row.id, name: row.name, message_id: str(sent.frame?.message_id), watching, error: sent.error })
}

/** The project a create request names: its id, or its name or repository as the app lists it. */
async function projectId(value: string, options: AppSessionsOptions): Promise<string> {
  const listed = await ask({ type: "list_projects" }, reply => (reply.type === "project_list" ? "ok" : "ignore"), REQUEST_WAIT_MS, options)
  const projects = Array.isArray(listed.frame?.projects) ? listed.frame.projects.filter(isRecord) : []
  const found = projects.find(project => project.id === value) ?? projects.find(project => project.name === value)
  if (!found) throw new Error(`no project '${value}' in the Copilot app${projects.length ? ` (it has: ${projects.map(project => str(project.name) ?? "?").join(", ")})` : ""}`)
  return found.id as string
}

/** Start a session: a project session in its own worktree (or on the project's checkout), or a standalone chat. */
export async function createSession(
  agentRoot: string,
  args: { name?: unknown; project_id?: unknown; session_kind?: unknown; workspace_type?: unknown; branch_name?: unknown; kickoff?: unknown; notify_on_idle?: unknown },
  options: AppSessionsOptions = {},
): Promise<Result> {
  const kickoff = isRecord(args.kickoff) ? args.kickoff : {}
  const prompt = str(kickoff.prompt)
  const name = str(args.name)
  const project = str(args.project_id)
  const chat = args.session_kind === "chat" || (!project && args.session_kind !== "project")
  if (!chat && !project) throw new Error("a project session needs project_id (a project's id or name; list_sessions_and_chats shows project_id on its sessions)")
  let created: Asked
  if (chat) {
    created = await ask({ type: "create_session", cwd: os.homedir(), session_type: "general_chat", ...(str(kickoff.model) ? { model: str(kickoff.model) } : {}), ...(str(kickoff.agent) ? { agent: str(kickoff.agent) } : {}) },
      (reply, id) => (reply.request_id === id ? (reply.type === "session_created" ? "ok" : "fail") : "ignore"), REQUEST_WAIT_MS, options)
  } else {
    const worktree = args.workspace_type !== "branch"
    created = await ask({
      type: worktree ? "create_worktree_workspace" : "create_branch_workspace", project_id: await projectId(project!, options),
      ...(worktree ? { branch_name: str(args.branch_name) ?? `ouro-${randomUUID().slice(0, 8)}`, checkout_existing_branch: false } : {}),
      ...(name ? { name } : {}), kickoff_permission_mode: str(kickoff.permission_mode) ?? "allow-all",
      ...(str(kickoff.model) ? { kickoff_model: str(kickoff.model) } : {}),
      ...(str(kickoff.agent) ? { kickoff_agent: str(kickoff.agent) } : {}), ...(str(kickoff.reasoning_effort) ? { kickoff_reasoning_effort: str(kickoff.reasoning_effort) } : {}),
    }, (reply, id) => (reply.request_id === id ? (reply.type === "workspace_created" ? "ok" : reply.type === "workspace_changed" ? "wait" : "fail") : reply.type === "session_creation_failed" ? "fail" : "ignore"), CREATE_WAIT_MS, options)
    // The app opens the workspace's session only for its own window, so an outside client opens it.
    if (created.ok) {
      const workspace = isRecord(created.frame!.workspace) ? created.frame!.workspace : {}
      const workspaceId = str(workspace.id)
      const cwd = str(workspace.displayPath)
      if (workspaceId && cwd) created = await ask({ type: "create_session", workspace_id: workspaceId, cwd }, (reply, id) => (reply.request_id === id ? (reply.type === "session_created" ? "ok" : "fail") : "ignore"), REQUEST_WAIT_MS, options)
    }
  }
  const id = str(created.frame?.session_id)
  if (!created.ok || !id) return { ok: false, created: false, error: created.error ?? "the app did not name the session it made" }
  assertSessionId(id)
  addProbe(agentRoot, id, name, Date.now())
  // The app does not run a kickoff for a client that is not its window ("ready for first message"), so the first message and mode are set here.
  let sent: Result | null = null
  if (chat && name) await ask({ type: "rename_session", session_id: id, title: name }, reply => (reply.type === "session_title_updated" && reply.session_id === id ? "ok" : "ignore"), REQUEST_WAIT_MS, options)
  const mode = str(kickoff.mode)
  if (mode && mode !== "interactive") await ask({ type: "set_session_mode", session_id: id, mode }, reply => (reply.type === "session_mode_result" && reply.session_id === id ? "ok" : "ignore"), REQUEST_WAIT_MS, options)
  if (prompt) sent = await sendSessionMessage(agentRoot, { session_id: id, message: prompt, notify_on_idle: args.notify_on_idle }, options)
  const error = sent && !sent.ok ? `created, but the first message was not accepted: ${String(sent.error)}` : null
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_created", message: "created a Copilot app session", meta: { session: id, chat, prompted: !!prompt } })
  return compact({ ok: error === null, created: true, session_id: id, app_url: appUrl(id), kind: chat ? "chat" : "session", workspace_id: str(created.frame?.workspace_id), watching: sent?.watching, coordination: COORDINATION_NOTE, error })
}

/** Answer a question a session asked with its ask_user tool. */
export async function answerSessionInput(agentRoot: string, args: { session_id: unknown; answer: unknown }, options: AppSessionsOptions = {}): Promise<Result> {
  const answer = typeof args.answer === "string" ? args.answer : ""
  if (!answer) throw new Error("give the answer")
  const row = await resolve(args.session_id, options)
  const request = readPending(agentRoot)[row.id]
  if (row.awaiting !== "input" || request?.kind !== "input") throw new Error(`session ${row.id} is not waiting on a question this agent heard asked (get_session shows what it waits on)`)
  const answered = await ask(
    { type: "respond_to_user_input", session_id: row.id, request_id: request.requestId, answer, was_freeform: !(request.choices ?? []).includes(answer) },
    reply => (reply.type === "user_input_resolved" && reply.request_id === request.requestId ? "ok" : "ignore"), ANSWER_WAIT_MS, options,
  )
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_answered", message: "answered a Copilot app session's question", meta: { session: row.id, ok: answered.ok } })
  return compact({ ok: answered.ok, session_id: row.id, error: answered.error })
}

/** Approve or reject a plan a session is paused on. */
export async function respondToSessionPlan(
  agentRoot: string,
  args: { session_id: unknown; approved: unknown; selected_action?: unknown; feedback?: unknown },
  options: AppSessionsOptions = {},
): Promise<Result> {
  const row = await resolve(args.session_id, options)
  const request = readPending(agentRoot)[row.id]
  if (row.awaiting !== "plan" || request?.kind !== "plan") throw new Error(`session ${row.id} is not waiting on a plan this agent heard presented (get_session shows what it waits on)`)
  const approved = args.approved === true || args.approved === "true"
  const responded = await ask(
    { type: "respond_to_exit_plan_mode", session_id: row.id, request_id: request.requestId, approved, ...(str(args.selected_action) ? { selected_action: str(args.selected_action) } : {}) },
    reply => (reply.request_id === request.requestId ? (reply.type === "exit_plan_mode_resolved" ? "ok" : reply.type === "exit_plan_mode_response_failed" ? "fail" : "ignore") : "ignore"), ANSWER_WAIT_MS, options,
  )
  const feedback = str(args.feedback)
  const told = responded.ok && feedback ? await sendSessionMessage(agentRoot, { session_id: row.id, message: feedback, notify_on_idle: "never" }, options) : null
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_plan_answered", message: "answered a Copilot app session's plan", meta: { session: row.id, ok: responded.ok, approved } })
  return compact({ ok: responded.ok, approved, session_id: row.id, feedback_sent: told ? told.ok : undefined, error: responded.error })
}

/** Archive a session this agent created: its workspace when it has one (and the worktree with it), else the chat. */
export async function archiveSession(agentRoot: string, id: unknown, options: AppSessionsOptions = {}, ownerAsked = false): Promise<Result> {
  const row = await resolve(id, options)
  const made = readProbes(agentRoot)
  let reason: ArchiveLogEntry["reason"] | null = null
  if (!made[row.id]) {
    reason = ownerAsked ? "owner-asked" : isHandedOff(agentRoot, row, options) ? "handed-off" : null
    if (!reason) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.app_sessions_archive_declined", message: "declined to archive a session this agent did not create", meta: { session: row.id } })
      throw new Error(`session ${row.id} was not created by this agent, so it will not archive it unless the owner asked for it or it is oversize and a newer session names it as handed off (yours: ${Object.keys(made).join(", ") || "none"})`)
    }
  }
  const archived = row.workspaceId
    ? await ask({ type: "archive_workspace", workspace_id: row.workspaceId, delete_worktree: row.workspaceType === "worktree" }, (reply, requestId) => (reply.request_id === requestId ? (reply.type === "workspace_archived" ? "ok" : "fail") : "ignore"), ARCHIVE_WAIT_MS, options)
    : await ask({ type: "archive_session", session_id: row.id }, (reply, requestId) => (reply.type === "general_chat_sessions_changed" ? "ok" : reply.request_id === requestId ? "fail" : "ignore"), ARCHIVE_WAIT_MS, options)
  if (archived.ok) {
    removeProbe(agentRoot, row.id)
    if (reason) {
      addArchiveLog(agentRoot, { id: row.id, name: row.name, at: new Date(options.now?.() ?? Date.now()).toISOString(), reason })
      emitNervesEvent({ component: "senses", event: "senses.app_sessions_archived_not_created", message: "archived a session this agent did not create", meta: { session: row.id, reason } })
    }
  }
  else emitNervesEvent({ level: "warn", component: "senses", event: "senses.app_sessions_archive_refused", message: "the Copilot app did not archive a session", meta: { session: row.id, error: archived.error } })
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_archived", message: "asked the Copilot app to archive a session", meta: { session: row.id, ok: archived.ok } })
  return compact({ ok: archived.ok, session_id: row.id, error: archived.error })
}

/** Show a session in the app's window, as following its link does. */
export async function navigateTo(id: unknown, options: AppSessionsOptions = {}): Promise<Result> {
  const row = await resolve(id, options)
  const shown = await ask({ type: "handle_deep_link", url: appUrl(row.id) }, reply => (reply.type === "deep_link_received" ? "ok" : "ignore"), REQUEST_WAIT_MS, options)
  return compact({ ok: shown.ok, session_id: row.id, app_url: appUrl(row.id), error: shown.error })
}

// ---------- automations and workflows ----------

/** Create or replace the automation that wakes a session, or clear it. */
export async function saveSessionAutomation(args: Result, options: AppSessionsOptions = {}): Promise<Result> {
  const row = await resolve(args.session_id, options)
  const settle = (reply: Frame, id: string): Verdict => (reply.request_id === id && /^session_automation_mutation_result$/.test(String(reply.type)) ? (reply.error ? "fail" : "ok") : "ignore")
  if (args.clear === true) {
    const owned = await ownedAutomations(row.id, options)
    const first = Array.isArray(owned.frame?.automations) ? owned.frame.automations.filter(isRecord)[0] : undefined
    if (!str(first?.id)) return { ok: false, error: owned.error ?? "that session has no automation to clear" }
    const cleared = await ask({ type: "cancel_session_automation", session_id: row.id, automation_id: first!.id }, settle, REQUEST_WAIT_MS, options)
    return compact({ ok: cleared.ok, session_id: row.id, cleared: cleared.ok, error: cleared.error })
  }
  const keys = ["prompt", "interval", "run_at", "every_minutes", "schedule_hour", "schedule_day", "schedule_minute", "cron_expression", "name"]
  const saved = await ask({ type: "save_session_automation", session_id: row.id, ...Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]])) }, settle, REQUEST_WAIT_MS, options)
  return compact({ ok: saved.ok, session_id: row.id, automation: saved.frame?.automation, error: saved.error })
}

const ownedAutomations = (session: string, options: AppSessionsOptions): Promise<Asked> =>
  ask({ type: "list_owned_session_automations", session_id: session }, (reply, id) => (reply.request_id === id && reply.type === "owned_session_automations_result" ? "ok" : "ignore"), REQUEST_WAIT_MS, options)

export async function getSessionAutomation(id: unknown, options: AppSessionsOptions = {}): Promise<Result> {
  const row = await resolve(id, options)
  const owned = await ownedAutomations(row.id, options)
  return compact({ ok: owned.ok, session_id: row.id, automations: owned.frame?.automations, schedules: owned.frame?.legacy_schedules, error: owned.error })
}

export async function listWorkflows(options: AppSessionsOptions = {}): Promise<Result> {
  const listed = await ask({ type: "list_workflows" }, (reply, id) => (reply.request_id === id && reply.type === "workflow_list" ? "ok" : "ignore"), REQUEST_WAIT_MS, options)
  return compact({ ok: listed.ok, workflows: listed.frame?.tasks, error: listed.error })
}

export async function runWorkflow(id: unknown, options: AppSessionsOptions = {}): Promise<Result> {
  const workflow = str(id)
  if (!workflow) throw new Error("name the workflow: its id, from list_workflows")
  const started = await ask({ type: "run_workflow_now", id: workflow }, reply => (reply.type === "workflow_run_started" ? "ok" : reply.type === "workflow_run_rejected" ? "fail" : "ignore"), REQUEST_WAIT_MS, options)
  return compact({ ok: started.ok, run: started.frame?.run, error: started.error })
}
