import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import { openDatabase } from "../../heart/sqlite"
import WebSocket from "ws"
import { emitNervesEvent } from "../../nerves/runtime"
import { copilotAppUrl } from "../shepherd/copilot-app"

/**
 * This Mac's GitHub Copilot app, read and written the way the app's own sidebar does it. The session list comes from
 * the app's database (`<stateDir>/data.db`, opened read-only), what a session said from its event log
 * (`<stateDir>/session-state/<id>/events.jsonl`), and every write is a request on the app's local WebSocket (port and
 * token in `<stateDir>/run/`). A restart of the app is asked of Housesitter (`housesitter restart-copilot`), never done here.
 *
 * This module is the per-machine client: it knows nothing about agents, tools or prompts, so the app-sessions sense,
 * its tools and the fleet sense all build on it.
 */
export type Frame = Record<string, unknown>
export type OpenSocket = (url: string) => WebSocket
export type RunFile = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

export interface AppSessionsOptions {
  /** The app's state folder, `~/.copilot` unless a test says otherwise. */
  stateDir?: string
  openSocket?: OpenSocket
  now?: () => number
  /** How long a send waits for the app's answer. Closing the socket before the app answers cancels the send. */
  sendWaitMs?: number
  /** Runs Housesitter; tests replace it. */
  runFile?: RunFile
  /** Where to look for Housesitter's `bin/housesitter.mjs` (or an executable named housesitter), first match wins; tests replace it. */
  housesitterPaths?: string[]
  /** The home folder whose `code/housesitter` checkout is looked in, `os.homedir()` unless a test says otherwise. */
  homeDir?: string
}

export type AppSessionState = "working" | "waiting" | "stuck" | "idle"

export interface AppSessionRow {
  id: string
  name: string
  kind: "workspace" | "chat"
  workspaceId: string | null
  workspaceType: string | null
  project: string | null
  projectId: string | null
  projectRepo: string | null
  branch: string | null
  path: string | null
  parentSessionId: string | null
  creatorSessionId: string | null
  coordinatingCreatorSessionId: string | null
  state: AppSessionState
  /** What the session's own state rests on, in a few words. */
  detail: string
  isRunning: boolean
  wasInterrupted: boolean
  remote: boolean
  createdAt: string | null
  updatedAt: string | null
  lastActivity: string | null
  /** What the session's history says it waits on: a question, a plan approval or a permission. */
  awaiting?: "input" | "plan" | "permission"
  /** The oldest permission request still open, whatever else the session waits on. */
  prompt?: PermissionPrompt
  /** The repository-trust decision the session is blocked on, which only the person can make. */
  repositoryTrust?: RepositoryTrustWait
}

/** An undecided repository-trust card, from the app's database. */
export interface RepositoryTrustWait {
  /** The app's id for the decision (`repository_trust:<project>:<host>:<revision>`); a new decision has a new id. */
  decisionId: string
  /** The repository the person is asked to trust, as `owner/name` when the app knows it. */
  repo: string
}

/** A permission request the person has not answered yet, from the session's own history. */
export interface PermissionPrompt {
  requestId: string
  /** What is being asked, in a few plain words. */
  what: string
  /** When the app recorded the request, if its event carries a time. */
  at: string | null
}

export interface AppSessionsSnapshot {
  at: string
  appRunning: boolean
  counts: Record<AppSessionState, number>
  sessions: Array<{ id: string; name: string; state: AppSessionState }>
}

export interface AppMessage {
  at: string | null
  role: "user" | "assistant"
  text: string
  truncated?: boolean
}


/** The most a send waits: a session whose runtime is not in memory loads first, often for more than 20 s. */
export const SEND_WAIT_MS = 120_000
/** Names the Housesitter command to run: the path of its `bin/housesitter.mjs`, or of an executable. */
export const HOUSESITTER_ENV = "HOUSESITTER_BIN"
const REQUEST_WAIT_MS = 30_000
const HOUSESITTER_WAIT_MS = 30_000
const STATUS_TAIL_BYTES = 512 * 1024
const EVENT_CHUNK_BYTES = 256 * 1024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MESSAGE_MAX_CHARS = 4_000
/** A cut loop this fresh may just be a turn the database has not marked running yet. */
const STUCK_GRACE_MS = 120_000
/** A session the app says is running whose history, sub-agents included, has not grown for this long is hung. */
export const HUNG_MS = 30 * 60_000
const SESSION_ID = /^[A-Za-z0-9-]+$/
const ASK_TOOLS = new Set(["ask_user", "ask_followup_question", "request_user_input"])
const PLAN_TOOLS = new Set(["exit_plan_mode"])
const LOOP = new Set([
  "user.message", "assistant.turn_start", "assistant.message", "assistant.turn_end", "abort", "session.task_complete",
  "tool.execution_start", "tool.execution_complete", "subagent.started", "subagent.completed",
])

export function defaultStateDir(): string {
  return path.join(os.homedir(), ".copilot")
}

function stateDirOf(options: AppSessionsOptions): string {
  return options.stateDir ?? defaultStateDir()
}

function isRecord(value: unknown): value is Frame {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function assertSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`'${id}' is not a Copilot app session id`)
  return id
}

// ---------- the app's database ----------

function withDatabase<T>(stateDir: string, read: (db: Database.Database) => T): T {
  const file = path.join(stateDir, "data.db")
  if (!fs.existsSync(file)) throw new Error(`no GitHub Copilot app database at ${file}`)
  const db = openDatabase(file, { readonly: true, fileMustExist: true, timeout: 3_000 })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).some(row => row.name === column)
}

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}

interface TrustClaimRow {
  watermark: string
  session_id: string
  project: string | null
  owner: string | null
  repo: string | null
  trusted: number
  current: number | null
}

/**
 * The sessions blocked on a repository-trust card. When a session that another session created reaches the card, the app
 * records a `repository_trust` notification claim for it, with the decision id as the watermark, and the claim stays after
 * the person decides. So a claim is an open wait only while the project has no trust grant for the session's host and no
 * newer trust revision. A session nobody coordinates leaves no claim and is not seen here.
 */
function repositoryTrustWaits(stateDir: string): Map<string, RepositoryTrustWait> {
  return withDatabase(stateDir, (db) => {
    const waits = new Map<string, RepositoryTrustWait & { revision: number }>()
    if (!["creator_notification_claims", "project_host_trust", "project_trust_revisions", "workspaces", "projects"].every(table => hasTable(db, table))) return waits
    const named = hasColumn(db, "projects", "github_owner") && hasColumn(db, "projects", "github_repo")
    const revision = hasColumn(db, "project_trust_revisions", "local_revision") ? "max(r.revision, r.local_revision)" : "r.revision"
    const claims = db.prepare(`
      SELECT c.watermark, w.session_id, p.name AS project, ${named ? "p.github_owner AS owner, p.github_repo AS repo" : "NULL AS owner, NULL AS repo"},
        EXISTS (SELECT 1 FROM project_host_trust h WHERE h.project_id = w.project_id AND h.host_id = coalesce(w.host_id, 'local')) AS trusted,
        (SELECT ${revision} FROM project_trust_revisions r WHERE r.project_id = w.project_id) AS current
      FROM creator_notification_claims c JOIN workspaces w ON w.id = c.workspace_id LEFT JOIN projects p ON p.id = w.project_id
      WHERE c.kind = 'repository_trust' AND w.session_id IS NOT NULL`).all() as TrustClaimRow[]
    for (const claim of claims) {
      const decided = Number(/:(\d+)$/.exec(claim.watermark)?.[1])
      if (claim.trusted || Number.isNaN(decided) || (claim.current ?? 0) > decided) continue
      if ((waits.get(claim.session_id)?.revision ?? -1) >= decided) continue
      waits.set(claim.session_id, { decisionId: claim.watermark, repo: claim.owner && claim.repo ? `${claim.owner}/${claim.repo}` : claim.project ?? "this repository", revision: decided })
    }
    return new Map([...waits].map(([session, { decisionId, repo }]) => [session, { decisionId, repo }]))
  })
}

// ---------- the session's event log ----------

export function eventLogPath(id: string, options: AppSessionsOptions = {}): string {
  return path.join(stateDirOf(options), "session-state", assertSessionId(id), "events.jsonl")
}

/** `length` bytes of the session's event log ending at `end` (default: its end), as text. */
export function readEventLog(id: string, options: AppSessionsOptions & { from?: number; maxBytes: number }): { text: string; start: number; end: number } {
  let fd: number
  try {
    fd = fs.openSync(eventLogPath(id, options), "r")
  } catch {
    return { text: "", start: 0, end: 0 }
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(options.from ?? 0, size - options.maxBytes, 0)
    const buffer = Buffer.alloc(Math.max(0, size - start))
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return { text: buffer.toString("utf-8"), start, end: size }
  } finally {
    fs.closeSync(fd)
  }
}

export function parseEventLines(text: string): Frame[] {
  const events: Frame[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue
    try {
      const event: unknown = JSON.parse(line)
      if (isRecord(event)) events.push(event)
    } catch {
      // A line cut by the tail window is not an event.
    }
  }
  return events
}

function tailEvents(stateDir: string, id: string, bytes: number): Frame[] {
  return parseEventLines(readEventLog(id, { stateDir, maxBytes: bytes }).text)
}

const DELIVERY_TAIL_BYTES = 4 * 1024 * 1024
const DELIVERY_CLOCK_SLACK_MS = 60_000
const squash = (text: string): string => text.replace(/\s+/g, " ").trim()

/**
 * Whether a message sent at `sinceMs` has reached the session: its log holds a user message that starts with the same
 * text. A message the app accepted but still holds in its own queue is not in the log yet.
 */
export function messageDelivered(id: string, text: string, sinceMs: number, options: AppSessionsOptions = {}): boolean {
  const probe = squash(text).slice(0, 160)
  return parseEventLines(readEventLog(id, { ...options, maxBytes: DELIVERY_TAIL_BYTES }).text).some(event => {
    const data = isRecord(event.data) ? event.data : {}
    return event.type === "user.message" && Date.parse(str(event.timestamp) ?? "") >= sinceMs - DELIVERY_CLOCK_SLACK_MS && squash(str(data.content) ?? "").includes(probe)
  })
}

export interface TailFacts {
  awaiting: "input" | "plan" | "permission" | null
  /** The agent loop stopped mid-turn, or between turns after asking for tools. */
  loopCut: boolean
  detail: string
  lastActivity: string | null
  /** The oldest permission request still open, whatever else the session waits on. */
  prompt?: PermissionPrompt
}

const PERMISSION_WHAT: Record<string, string> = {
  shell: "run a shell command",
  write: "change a file",
  read: "read a file",
  url: "open a web address",
  mcp: "use a connected tool",
  "custom-tool": "use a custom tool",
  "extension-management": "change an extension",
}

/** The request in a few plain words. A command's text stays out: it can carry secrets. */
export function describePermission(request: unknown): string {
  const record = isRecord(request) ? request : {}
  const kind = str(record.kind)
  if (kind === "extension-permission-access") {
    const capabilities = Array.isArray(record.capabilities) ? record.capabilities.filter((item): item is string => typeof item === "string").join(", ") : ""
    return `let the extension ${str(record.extensionName) ?? "(unnamed)"} ${capabilities || "ask for access"}`
  }
  const what = (kind && PERMISSION_WHAT[kind]) || (kind ? `a ${kind} permission` : "a permission")
  const intention = str(record.intention)
  return intention ? `${what} (${intention})` : what
}

/** What the session's own history says about its agent loop. Sub-agent events are their parent's business. */
export function tailFacts(events: Frame[]): TailFacts {
  const tools = new Map<string, string>()
  const permissions = new Map<string, PermissionPrompt>()
  let last: string | null = null
  let lastActivity: string | null = null
  let askedTools = false
  let finished = false
  for (const event of events) {
    if (event.agentId !== undefined) continue
    const type = str(event.type) ?? ""
    const data = isRecord(event.data) ? event.data : {}
    if (type === "session.shutdown" || type === "session.resume" || type === "session.start") {
      tools.clear()
      permissions.clear()
    }
    if (type === "tool.execution_start" && str(data.toolCallId)) tools.set(data.toolCallId as string, str(data.toolName) ?? "")
    if (type === "tool.execution_complete" && str(data.toolCallId)) tools.delete(data.toolCallId as string)
    if (type === "permission.requested" && str(data.requestId) && data.resolvedByHook !== true) permissions.set(data.requestId as string, { requestId: data.requestId as string, what: describePermission(data.permissionRequest), at: str(event.timestamp) })
    if (type === "permission.completed" && str(data.requestId)) permissions.delete(data.requestId as string)
    if (!LOOP.has(type)) continue
    // Only a person's stop counts; a runtime shutdown cancels sub-agents with other reasons.
    if (type === "abort" && str(data.reason) && data.reason !== "user_initiated") continue
    if (type === "assistant.message") {
      askedTools = Array.isArray(data.toolRequests) && data.toolRequests.length > 0
      finished = false
    }
    if (type === "session.task_complete") finished = true
    if (type === "user.message") {
      askedTools = false
      finished = false
    }
    last = type
    lastActivity = str(event.timestamp) ?? lastActivity
  }
  const pending = [...tools.values()].map(name => name.replace(/^[\w-]+?-(?=ask_|exit_)/, ""))
  const awaiting = pending.some(name => ASK_TOOLS.has(name)) ? "input" : pending.some(name => PLAN_TOOLS.has(name)) ? "plan" : permissions.size > 0 ? "permission" : null
  let loopCut = false
  let detail = "no agent activity"
  if (last === "abort") detail = "stopped by the person"
  else if (last === "session.task_complete" || (last === "assistant.turn_end" && finished)) detail = "task complete"
  else if (last === "assistant.turn_end") {
    loopCut = askedTools
    detail = askedTools ? "between turns (its last turn called tools and no next turn started)" : "its turn ended"
  } else if (last) {
    loopCut = true
    detail = `mid-turn (last ${last})`
  }
  const prompt = permissions.values().next().value
  return { awaiting, loopCut, detail, lastActivity, ...(prompt ? { prompt } : {}) }
}

const factsCache = new Map<string, { key: string; facts: TailFacts; writtenAtMs: number | null }>()

/** The tail facts and when the log was last written, re-read only when the log changed, so a periodic snapshot stays cheap. */
function cachedTailFacts(stateDir: string, id: string): { facts: TailFacts; writtenAtMs: number | null } {
  const file = eventLogPath(id, { stateDir })
  let key = "missing"
  let writtenAtMs: number | null = null
  try {
    const stat = fs.statSync(file)
    key = `${stat.size}:${stat.mtimeMs}`
    writtenAtMs = stat.mtimeMs
  } catch {
    // No log yet: the facts of an empty history.
  }
  const cached = factsCache.get(file)
  if (cached?.key === key) return cached
  const entry = { key, facts: tailFacts(tailEvents(stateDir, id, STATUS_TAIL_BYTES)), writtenAtMs }
  factsCache.set(file, entry)
  return entry
}

export function classify(isRunning: boolean, facts: TailFacts, nowMs: number, writtenAtMs: number | null = null): { state: AppSessionState; detail: string } {
  if (facts.awaiting === "permission") return { state: "waiting", detail: "waiting for a permission answer" }
  if (facts.awaiting) return { state: "waiting", detail: `waiting for the person's ${facts.awaiting === "plan" ? "plan approval" : "answer"}` }
  if (isRunning) {
    if (writtenAtMs !== null && nowMs - writtenAtMs >= HUNG_MS) return { state: "stuck", detail: `the app says it is running, but its history has not grown for ${Math.round((nowMs - writtenAtMs) / 60_000)} min` }
    return { state: "working", detail: "the app says it is running" }
  }
  if (facts.loopCut) {
    const at = Date.parse(facts.lastActivity ?? "")
    if (!Number.isNaN(at) && nowMs - at < STUCK_GRACE_MS) return { state: "working", detail: `starting up (${facts.detail})` }
    return { state: "stuck", detail: `not running, but its loop stopped ${facts.detail}` }
  }
  return { state: "idle", detail: facts.detail }
}

const arr = (value: unknown): Frame[] => (Array.isArray(value) ? value.filter(isRecord) : [])

/** The sidebar as the app itself lists it: its workspace sessions and its chats, in one exchange. */
async function sidebarItems(options: AppSessionsOptions): Promise<{ workspaces: Frame[]; chats: Frame[] }> {
  const got = await exchange(
    [{ type: "list_workspaces" }, { type: "list_general_chat_sessions" }],
    {
      keep: (frame) => /^(workspace_list|general_chat_sessions_list|socket_error)$/.test(String(frame.type)),
      done: (_frame, all) => all.some(frame => frame.type === "workspace_list") && all.some(frame => frame.type === "general_chat_sessions_list") || all.some(frame => frame.type === "socket_error"),
      waitMs: REQUEST_WAIT_MS,
    },
    options,
  )
  const workspaces = got.find(frame => frame.type === "workspace_list")
  const chats = got.find(frame => frame.type === "general_chat_sessions_list")
  if (!workspaces || !chats) throw new Error(str(got.find(frame => frame.type === "socket_error")?.message) ?? "the Copilot app did not list its sessions in time")
  return { workspaces: arr(workspaces.workspaces), chats: arr(chats.sessions) }
}

/** Every session in this Mac's Copilot app sidebar, with what it is doing now. */
export async function listAppSessions(options: AppSessionsOptions = {}): Promise<AppSessionRow[]> {
  const stateDir = stateDirOf(options)
  const now = (options.now ?? Date.now)()
  const { workspaces, chats } = await sidebarItems(options)
  const trusts = repositoryTrustWaits(stateDir)
  const rows: AppSessionRow[] = []
  const add = (id: string | null, row: Omit<AppSessionRow, "id" | "state" | "detail" | "lastActivity">, isRunning: boolean): void => {
    if (!id || !SESSION_ID.test(id) || rows.some(known => known.id === id)) return
    const { facts, writtenAtMs } = cachedTailFacts(stateDir, id)
    const repositoryTrust = trusts.get(id)
    const { state, detail } = repositoryTrust ? { state: "waiting" as const, detail: "waiting for a repository trust decision" } : classify(isRunning, facts, now, writtenAtMs)
    rows.push({
      id, ...row, state, detail, lastActivity: facts.lastActivity ?? row.updatedAt,
      ...(facts.awaiting ? { awaiting: facts.awaiting } : {}),
      ...(facts.prompt ? { prompt: facts.prompt } : {}),
      ...(repositoryTrust ? { repositoryTrust } : {}),
    })
  }
  for (const workspace of workspaces) {
    if (workspace.archivedAt) continue
    const session = isRecord(workspace.session) ? workspace.session : {}
    const binding = arr(workspace.checkoutBindings)[0]
    add(str(session.sessionId) ?? str(workspace.activeSessionId), {
      name: str(workspace.name) ?? str(session.title) ?? "(unnamed)", kind: "workspace", workspaceId: str(workspace.id), workspaceType: str(workspace.workspaceType),
      project: str(workspace.projectName), projectId: str(workspace.projectId), projectRepo: str(binding?.repoFullName), branch: str(workspace.branch), path: str(workspace.displayPath),
      creatorSessionId: str(workspace.creatorSessionId), coordinatingCreatorSessionId: str(workspace.coordinatingCreatorSessionId), parentSessionId: null,
      isRunning: session.isRunning === true, wasInterrupted: session.wasInterrupted === true,
      remote: (str(workspace.hostId) ?? "local") !== "local" || (str(session.executionLocation) ?? "local") !== "local",
      createdAt: str(workspace.createdAt), updatedAt: str(session.updatedAt) ?? str(workspace.updatedAt),
    }, session.isRunning === true)
  }
  for (const chat of chats) {
    if (chat.archivedAt) continue
    add(str(chat.id), {
      name: str(chat.title) ?? "(unnamed chat)", kind: "chat", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
      creatorSessionId: null, coordinatingCreatorSessionId: str(chat.coordinatingCreatorSessionId), parentSessionId: str(chat.parentSessionId),
      isRunning: chat.isRunning === true, wasInterrupted: chat.wasInterrupted === true, remote: (str(chat.executionLocation) ?? "local") !== "local",
      createdAt: str(chat.createdAt), updatedAt: str(chat.updatedAt),
    }, chat.isRunning === true)
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_listed", message: "listed the Copilot app's sessions", meta: { sessions: rows.length } })
  return rows
}

/** Counts by state and every session's id, name and state: the cheap picture a sense or a fleet view carries. */
export function snapshot(options: AppSessionsOptions, rows: AppSessionRow[]): AppSessionsSnapshot {
  const counts: Record<AppSessionState, number> = { working: 0, idle: 0, waiting: 0, stuck: 0 }
  for (const row of rows) counts[row.state] += 1
  return {
    at: new Date((options.now ?? Date.now)()).toISOString(),
    appRunning: appRunning(options),
    counts,
    sessions: rows.map(row => ({ id: row.id, name: row.name, state: row.state })),
  }
}

function openEventLog(id: string, options: AppSessionsOptions): number | null {
  try {
    return fs.openSync(eventLogPath(id, options), "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export interface AppSessionHistory {
  messages: AppMessage[]
  observedAt: string
  source: "local_event_log"
  requestedCount: number
  returnedCount: number
  logBytes: number
  scannedBytes: number
  beginningReached: boolean
  skippedEvents: number
  missing: boolean
}

/** Scan backwards until enough visible messages or the beginning, with bounded memory, not a fixed byte tail. */
export function readAppSessionHistory(id: string, count: number, options: AppSessionsOptions = {}): AppSessionHistory {
  const requestedCount = Math.min(50, Math.max(1, Math.trunc(count) || 1))
  const result: AppSessionHistory = {
    messages: [], observedAt: new Date((options.now ?? Date.now)()).toISOString(), source: "local_event_log",
    requestedCount, returnedCount: 0, logBytes: 0, scannedBytes: 0, beginningReached: false, skippedEvents: 0, missing: false,
  }
  const fd = openEventLog(id, options)
  if (fd === null) return { ...result, missing: true }
  try {
    let position = fs.fstatSync(fd).size
    result.logBytes = position
    let carry = Buffer.alloc(0)
    let dropping = false
    const keep = (line: Buffer): void => {
      if (dropping || line.length > MAX_EVENT_BYTES) {
        result.skippedEvents += 1
        dropping = false
        return
      }
      if (!line.length) return
      const events = parseEventLines(line.toString("utf-8"))
      if (!events.length) result.skippedEvents += 1
      result.messages.push(...messagesIn(events))
    }
    while (position > 0 && result.messages.length < requestedCount) {
      const length = Math.min(EVENT_CHUNK_BYTES, position)
      position -= length
      const chunk = Buffer.alloc(length)
      fs.readSync(fd, chunk, 0, length, position)
      result.scannedBytes += length
      const buffer = Buffer.concat([chunk, carry])
      let end = buffer.length
      for (let at = buffer.lastIndexOf(10, end - 1); at >= 0; at = end > 0 ? buffer.lastIndexOf(10, end - 1) : -1) {
        keep(buffer.subarray(at + 1, end))
        end = at
        if (result.messages.length >= requestedCount) break
      }
      carry = buffer.subarray(0, end)
      if (dropping || carry.length > MAX_EVENT_BYTES) {
        dropping = true
        carry = Buffer.alloc(0)
      }
    }
    if (position === 0 && result.messages.length < requestedCount) {
      keep(carry)
      result.beginningReached = true
    }
    result.messages.reverse()
    result.returnedCount = result.messages.length
    emitNervesEvent({ component: "senses", event: "senses.app_sessions_history_read", message: "read bounded conversation history", meta: { session: id, returned: result.returnedCount, scannedBytes: result.scannedBytes, skippedEvents: result.skippedEvents } })
    return result
  } finally {
    fs.closeSync(fd)
  }
}

/** Compatibility array view; tools also expose the read's coverage and observation time. */
export function tailAppSession(id: string, count: number, options: AppSessionsOptions = {}): AppMessage[] {
  return readAppSessionHistory(id, count, options).messages
}

/** Read forward from a watch cursor; stop at a complete event after the budget, never jump to the newest tail. */
export function readNewAppEvents(id: string, from: number, maxBytes: number, visit: (event: Frame) => void, options: AppSessionsOptions = {}): { offset: number; logBytes: number; skippedEvents: number } {
  const fd = openEventLog(id, options)
  if (fd === null) return { offset: 0, logBytes: 0, skippedEvents: 0 }
  try {
    const logBytes = fs.fstatSync(fd).size
    const result = { offset: Math.min(from, logBytes), logBytes, skippedEvents: 0 }
    let position = result.offset
    let carry = Buffer.alloc(0)
    let dropping = false
    while (position < logBytes) {
      const chunk = Buffer.alloc(Math.min(EVENT_CHUNK_BYTES, logBytes - position))
      fs.readSync(fd, chunk, 0, chunk.length, position)
      const buffer = Buffer.concat([carry, chunk])
      const start = position - carry.length
      position += chunk.length
      let lineStart = 0
      for (let at = buffer.indexOf(10); at >= 0; at = buffer.indexOf(10, lineStart)) {
        const line = buffer.subarray(lineStart, at)
        if (dropping || line.length > MAX_EVENT_BYTES) result.skippedEvents += 1
        else if (line.length) {
          const events = parseEventLines(line.toString("utf-8"))
          if (!events.length) result.skippedEvents += 1
          for (const event of events) visit(event)
        }
        dropping = false
        result.offset = start + at + 1
        lineStart = at + 1
        if (result.offset - from >= maxBytes) return result
      }
      carry = buffer.subarray(lineStart)
      if (dropping || carry.length > MAX_EVENT_BYTES) {
        dropping = true
        carry = Buffer.alloc(0)
      }
    }
    return result
  } finally {
    fs.closeSync(fd)
  }
}

/** The top-level user and assistant messages among `events`. */
export function messagesIn(events: Frame[]): AppMessage[] {
  const messages: AppMessage[] = []
  for (const event of events) {
    if (event.agentId !== undefined) continue
    const data = isRecord(event.data) ? event.data : {}
    const text = typeof data.content === "string" ? data.content : ""
    if ((event.type === "user.message" || event.type === "assistant.message") && text.trim()) {
      messages.push({ at: str(event.timestamp), role: event.type === "user.message" ? "user" : "assistant", text: text.slice(0, MESSAGE_MAX_CHARS), ...(text.length > MESSAGE_MAX_CHARS ? { truncated: true } : {}) })
    }
  }
  return messages
}

/** The size of the session's event log now: where a reply to a message sent now will start. */
export function eventLogSize(id: string, options: AppSessionsOptions = {}): number {
  try {
    return fs.statSync(eventLogPath(id, options)).size
  } catch {
    return 0
  }
}

// ---------- the app's socket ----------

export interface ExchangeOptions {
  done?: (frame: Frame, all: Frame[]) => boolean
  keep?: (frame: Frame) => boolean
  waitMs: number
}

/**
 * Send requests on one connection and collect the replies `keep` accepts until `done` says so or the wait runs out.
 * A socket error ends the exchange with a `socket_error` frame; the app not running throws.
 */
export function exchange(frames: Frame[], exchangeOptions: ExchangeOptions, options: AppSessionsOptions = {}): Promise<Frame[]> {
  const url = copilotAppUrl(stateDirOf(options))
  const openSocket = options.openSocket ?? ((target: string) => new WebSocket(target))
  const keep = exchangeOptions.keep ?? (() => true)
  const done = exchangeOptions.done ?? (() => false)
  return new Promise((resolve) => {
    const got: Frame[] = []
    let finished = false
    const socket = openSocket(url)
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.close()
      resolve(got)
    }
    const timer = setTimeout(finish, exchangeOptions.waitMs)
    socket.on("open", () => { for (const frame of frames) socket.send(JSON.stringify(frame)) })
    socket.on("message", (data) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(data))
      } catch {
        return
      }
      if (!isRecord(frame) || !keep(frame)) return
      got.push(frame)
      if (done(frame, got)) finish()
    })
    socket.on("error", (error) => {
      got.push({ type: "socket_error", message: error.message })
      finish()
    })
    socket.on("close", finish)
  })
}


/** A message waiting in a session's own queue, which the app releases one per turn boundary. */
export interface QueuedMessage { id: string; source: string; text: string }

/** The session's queued messages, oldest first. An empty list when the session has none or the app cannot say. */
export async function listSessionQueue(id: string, options: AppSessionsOptions = {}): Promise<QueuedMessage[]> {
  assertSessionId(id)
  const requestId = randomUUID()
  const got = await exchange(
    [{ type: "get_session_queue", session_id: id, request_id: requestId }],
    { keep: (frame) => frame.request_id === requestId || frame.type === "socket_error", done: (frame) => frame.request_id === requestId || frame.type === "socket_error", waitMs: options.sendWaitMs ?? SEND_WAIT_MS },
    options,
  )
  const data = isRecord(got.at(-1)?.data) ? got.at(-1)!.data as Frame : {}
  const items = Array.isArray(data.items) ? data.items : []
  return items.filter(isRecord).flatMap(item => (str(item.id) && item.kind === "message" ? [{ id: str(item.id)!, source: str(item.source) ?? "", text: str(item.display_text) ?? "" }] : []))
}

/**
 * Take back the messages of `source: "user"` (what the app's own box and Ouroboros send) that a session still holds in its
 * queue and that start with `prefix`. Only those: another session's or an agent's messages stay. Returns how many it removed.
 */
export async function withdrawQueuedMessages(id: string, prefix: string, options: AppSessionsOptions = {}): Promise<number> {
  const mine = (await listSessionQueue(id, options)).filter(item => item.source === "user" && item.text.startsWith(prefix))
  let removed = 0
  for (const item of mine) {
    const requestId = randomUUID()
    const got = await exchange(
      [{ type: "remove_session_queue_item", session_id: id, id: item.id, request_id: requestId }],
      { keep: (frame) => frame.request_id === requestId || frame.type === "socket_error", done: (frame) => frame.request_id === requestId || frame.type === "socket_error", waitMs: options.sendWaitMs ?? SEND_WAIT_MS },
      options,
    )
    if (got.at(-1)?.request_id === requestId && !got.at(-1)?.error) removed += 1
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_queue_withdrawn", message: "took back queued messages a newer one replaces", meta: { session: id, found: mine.length, removed } })
  return removed
}

/** Whether the app is up: its server files name a live process. */
export function appRunning(options: AppSessionsOptions = {}): boolean {
  try {
    copilotAppUrl(stateDirOf(options))
    return true
  } catch {
    return false
  }
}

// ---------- restarting the app (Housesitter) ----------

export const realRunFile: RunFile = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") })
  })
})

export type HousesitterResult<T> = { installed: false; message: string } | ({ installed: true } & T)

/** Housesitter's command on this Mac: `HOUSESITTER_BIN`, the checkout at `~/code/housesitter`, or `housesitter` on PATH. */
export function findHousesitter(options: AppSessionsOptions = {}): { file: string; args: string[] } | null {
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "housesitter"))
  const candidates = options.housesitterPaths ?? [process.env[HOUSESITTER_ENV] ?? "", path.join(options.homeDir ?? os.homedir(), "code", "housesitter", "bin", "housesitter.mjs"), ...onPath]
  const found = candidates.find(candidate => candidate && fs.existsSync(candidate))
  if (!found) return null
  return found.endsWith(".mjs") ? { file: process.execPath, args: [found] } : { file: found, args: [] }
}

const housesitterMissing = (): { installed: false; message: string } => ({
  installed: false,
  message: `Housesitter is not on this Mac, so the app was not restarted. Clone https://github.com/ourostack/housesitter to ~/code/housesitter, put \`housesitter\` on PATH, or set ${HOUSESITTER_ENV} to its bin/housesitter.mjs.`,
})

async function runHousesitter(args: string[], options: AppSessionsOptions): Promise<HousesitterResult<{ output: Record<string, unknown> }>> {
  const run = options.runFile ?? realRunFile
  const command = findHousesitter(options)
  if (!command) return housesitterMissing()
  const result = await run(command.file, [...command.args, "restart-copilot", ...args, "--json"], HOUSESITTER_WAIT_MS)
  let output: Record<string, unknown> | null = null
  try { output = JSON.parse(result.stdout) as Record<string, unknown> } catch { /* not JSON: housesitter refused or failed */ }
  // `--status` exits 1 for a failed run and `--detach` for a job launchd would not start; both still answer on stdout.
  const answered = output !== null && ("state" in output || output.ok === false)
  if (!output || (result.code !== 0 && !answered)) throw new Error(`housesitter failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return { installed: true, output }
}

/** Restart the app now, as a launchd job that outlives the app: Housesitter asks working sessions to reach a safe point, quits the app through its Quit menu (waiting while a person is using the Mac), relaunches it and resumes every session that was working. Read the outcome with {@link restartStatus}. */
export async function restartEnqueue(why: string, by: string, options: AppSessionsOptions = {}): Promise<HousesitterResult<{ request: unknown }>> {
  const result = await runHousesitter(["--resume", "--detach", "--why", `${why} (asked by ${by})`], options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_restart_enqueued", message: "asked housesitter to restart the app", meta: { installed: result.installed, why } })
  if (!result.installed) return result
  if (result.output.ok === false) throw new Error(`housesitter did not start the restart: ${String(result.output.error ?? "no reason given")}`)
  return { installed: true, request: result.output }
}

/** The restart in progress or the last one: state (running, done, failed, none), step, start time, result, log. */
export async function restartStatus(options: AppSessionsOptions = {}): Promise<HousesitterResult<{ status: unknown }>> {
  const result = await runHousesitter(["--status"], options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_restart_status", message: "read housesitter's restart status", meta: { installed: result.installed } })
  return result.installed ? { installed: true, status: result.output } : result
}
