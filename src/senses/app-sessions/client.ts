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
 * token in `<stateDir>/run/`). A courtesy app restart is asked of the Mac's app keeper, never done here.
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
  /** Runs the keeper and launchctl; tests replace it. */
  runFile?: RunFile
  /** The user id whose launch agents hold the keeper. */
  uid?: number
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
  parentSessionId?: string | null
  creatorSessionId?: string | null
  coordinatingCreatorSessionId?: string | null
  sidebarPlacement: "unknown"
  state: AppSessionState
  /** What the session's own state rests on, in a few words. */
  detail: string
  isRunning: boolean
  wasInterrupted: boolean
  remote: boolean
  updatedAt: string | null
  lastActivity: string | null
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

export interface SendResult {
  ok: boolean
  reply: string
  messageId: string | null
  error: string | null
}

/** The most a send waits: a session whose runtime is not in memory loads first, often for more than 20 s. */
export const SEND_WAIT_MS = 120_000
export const KEEPER_LABEL = "com.arimendelow.copilot-app-keeper"
const REQUEST_WAIT_MS = 30_000
const ARCHIVE_WAIT_MS = 60_000
const CHAT_ARCHIVE_WAIT_MS = 20_000
const RENAME_WAIT_MS = 1_500
const KEEPER_WAIT_MS = 20_000
const STATUS_TAIL_BYTES = 512 * 1024
const EVENT_CHUNK_BYTES = 256 * 1024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MESSAGE_MAX_CHARS = 4_000
/** A cut loop this fresh may just be a turn the database has not marked running yet. */
const STUCK_GRACE_MS = 120_000
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

interface DbRow {
  id: string
  workspace_id: string | null
  workspace_type: string | null
  name: string | null
  title: string | null
  project: string | null
  project_id: string | null
  parent_session_id?: string | null
  creator_session_id?: string | null
  coordinating_creator_session_id?: string | null
  is_running: number | null
  was_interrupted: number | null
  execution_location: string | null
  host_id: string | null
  updated_at: string | null
}

const WORKSPACE_ROWS = `
SELECT w.session_id AS id, w.id AS workspace_id, w.workspace_type, w.name, s.title, p.name AS project, w.project_id,
  s.is_running, s.was_interrupted, s.execution_location, w.host_id, coalesce(s.updated_at, w.updated_at) AS updated_at
FROM workspaces w LEFT JOIN sessions s ON s.id = w.session_id LEFT JOIN projects p ON p.id = w.project_id
WHERE w.archived_at IS NULL AND w.session_id IS NOT NULL`

const CHAT_ROWS = `
SELECT s.id, NULL AS workspace_id, NULL AS workspace_type, NULL AS name, s.title, NULL AS project, NULL AS project_id,
  s.is_running, s.was_interrupted, s.execution_location, NULL AS host_id, s.updated_at
FROM sessions s
WHERE s.archived_at IS NULL AND s.session_type IN ('general_chat', 'agent')`

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).some(row => row.name === column)
}

function databaseRows(stateDir: string): DbRow[] {
  return withDatabase(stateDir, (db) => {
    // Older app builds have no host_id on workspaces.
    const workspaces = hasColumn(db, "workspaces", "host_id") ? WORKSPACE_ROWS : WORKSPACE_ROWS.replace("w.host_id", "NULL AS host_id")
    const withHierarchy = (query: string, table: "workspaces" | "sessions", alias: "w" | "s") => {
      const columns = ["parent_session_id", "creator_session_id", "coordinating_creator_session_id"]
        .filter(column => hasColumn(db, table, column)).map(column => `${alias}.${column}`)
      return columns.length ? query.replace("SELECT ", `SELECT ${columns.join(", ")}, `) : query
    }
    return [...db.prepare(withHierarchy(workspaces, "workspaces", "w")).all() as DbRow[], ...db.prepare(withHierarchy(CHAT_ROWS, "sessions", "s")).all() as DbRow[]]
  })
}

interface SessionRecord { id: string; archived_at: string | null; workspace_id: string | null; workspace_type: string | null; workspace_archived_at: string | null }

function sessionRecord(stateDir: string, id: string): SessionRecord | null {
  return withDatabase(stateDir, (db) => (db.prepare(`
    SELECT s.id, s.archived_at, w.id AS workspace_id, w.workspace_type, w.archived_at AS workspace_archived_at
    FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id WHERE s.id = ?`).get(id) as SessionRecord | undefined) ?? null)
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

export interface TailFacts {
  awaiting: "input" | "plan" | "permission" | null
  /** The agent loop stopped mid-turn, or between turns after asking for tools. */
  loopCut: boolean
  detail: string
  lastActivity: string | null
}

/** What the session's own history says about its agent loop. Sub-agent events are their parent's business. */
export function tailFacts(events: Frame[]): TailFacts {
  const tools = new Map<string, string>()
  const permissions = new Set<string>()
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
    if (type === "permission.requested" && str(data.requestId) && data.resolvedByHook !== true) permissions.add(data.requestId as string)
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
  return { awaiting, loopCut, detail, lastActivity }
}

const factsCache = new Map<string, { key: string; facts: TailFacts }>()

/** The tail facts, re-read only when the log changed, so a periodic snapshot stays cheap. */
function cachedTailFacts(stateDir: string, id: string): TailFacts {
  const file = eventLogPath(id, { stateDir })
  let key = "missing"
  try {
    const stat = fs.statSync(file)
    key = `${stat.size}:${stat.mtimeMs}`
  } catch {
    // No log yet: the facts of an empty history.
  }
  const cached = factsCache.get(file)
  if (cached?.key === key) return cached.facts
  const facts = tailFacts(tailEvents(stateDir, id, STATUS_TAIL_BYTES))
  factsCache.set(file, { key, facts })
  return facts
}

export function classify(isRunning: boolean, facts: TailFacts, nowMs: number): { state: AppSessionState; detail: string } {
  if (facts.awaiting === "permission") return { state: "waiting", detail: "waiting for a permission answer" }
  if (facts.awaiting) return { state: "waiting", detail: `waiting for the person's ${facts.awaiting === "plan" ? "plan approval" : "answer"}` }
  if (isRunning) return { state: "working", detail: "the app says it is running" }
  if (facts.loopCut) {
    const at = Date.parse(facts.lastActivity ?? "")
    if (!Number.isNaN(at) && nowMs - at < STUCK_GRACE_MS) return { state: "working", detail: `starting up (${facts.detail})` }
    return { state: "stuck", detail: `not running, but its loop stopped ${facts.detail}` }
  }
  return { state: "idle", detail: facts.detail }
}

/** Every session in this Mac's Copilot app sidebar, with what it is doing now. */
export function listAppSessions(options: AppSessionsOptions = {}): AppSessionRow[] {
  const stateDir = stateDirOf(options)
  const now = (options.now ?? Date.now)()
  const seen = new Set<string>()
  const rows: AppSessionRow[] = []
  for (const row of databaseRows(stateDir)) {
    if (seen.has(row.id) || !SESSION_ID.test(row.id)) continue
    seen.add(row.id)
    const facts = cachedTailFacts(stateDir, row.id)
    const isRunning = row.is_running === 1
    const { state, detail } = classify(isRunning, facts, now)
    rows.push({
      id: row.id,
      name: row.name || row.title || (row.workspace_id ? "(unnamed)" : "(unnamed chat)"),
      kind: row.workspace_id ? "workspace" : "chat",
      workspaceId: row.workspace_id,
      workspaceType: row.workspace_type,
      project: row.project,
      projectId: row.project_id,
      ...("parent_session_id" in row ? { parentSessionId: row.parent_session_id } : {}),
      ...("creator_session_id" in row ? { creatorSessionId: row.creator_session_id } : {}),
      ...("coordinating_creator_session_id" in row ? { coordinatingCreatorSessionId: row.coordinating_creator_session_id } : {}),
      sidebarPlacement: "unknown",
      state,
      detail,
      isRunning,
      wasInterrupted: row.was_interrupted === 1,
      remote: (!!row.host_id && row.host_id !== "local") || (!!row.execution_location && row.execution_location !== "local"),
      updatedAt: row.updated_at,
      lastActivity: facts.lastActivity ?? row.updated_at,
    })
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_listed", message: "listed the Copilot app's sessions", meta: { sessions: rows.length } })
  return rows
}

/** Counts by state and every session's id, name and state: the cheap picture a sense or a fleet view carries. */
export function snapshot(options: AppSessionsOptions = {}, rows: AppSessionRow[] = listAppSessions(options)): AppSessionsSnapshot {
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
  done?: (frame: Frame) => boolean
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
      if (done(frame)) finish()
    })
    socket.on("error", (error) => {
      got.push({ type: "socket_error", message: error.message })
      finish()
    })
    socket.on("close", finish)
  })
}

function lastError(got: Frame[], fallback: string): string {
  const last = got.at(-1)
  return String(str(last?.message) ?? str(last?.reason) ?? str(last?.detail) ?? str(last?.type) ?? fallback).slice(0, 300)
}

/**
 * Deliver a message into a session, as the sidebar's message box does. It always waits for the app's answer: a
 * session whose runtime is not loaded loads first, and closing the socket before the app answers cancels the send.
 */
export async function sendToAppSession(id: string, text: string, options: AppSessionsOptions & { delivery?: "immediate" | "enqueue" } = {}): Promise<SendResult> {
  assertSessionId(id)
  const known = sessionRecord(stateDirOf(options), id)
  if (!known) return { ok: false, reply: "not found", messageId: null, error: `no Copilot app session ${id} on this Mac` }
  if (known.archived_at || known.workspace_archived_at) return { ok: false, reply: "archived", messageId: null, error: `session ${id} is archived` }
  const requestId = randomUUID()
  const got = await exchange(
    [{ type: "send_message", session_id: id, prompt: text, delivery_mode: options.delivery ?? "immediate", request_id: requestId }],
    {
      keep: (frame) => frame.request_id === requestId || (frame.session_id === id && /message_(sent|queued|delivery)/.test(String(frame.type))) || frame.type === "socket_error",
      done: (frame) => /^(session_message_sent|session_message_queued|session_message_delivery_unknown|session_resume_failed|error|socket_error)$/.test(String(frame.type)),
      waitMs: options.sendWaitMs ?? SEND_WAIT_MS,
    },
    options,
  )
  const last = got.at(-1)
  const ok = !!last && /^session_message_(sent|queued)$/.test(String(last.type))
  const result: SendResult = {
    ok,
    reply: str(last?.type) ?? "no reply",
    messageId: str(last?.message_id),
    error: ok ? null : last ? lastError(got, "error") : "the app did not answer in time",
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_sent", message: "sent a message into a Copilot app session", meta: { session: id, chars: text.length, ok, reply: result.reply } })
  return result
}

/** The nudge the desk's keeper sends a session that stopped mid-work. */
export function resumePrompt(state: string, note?: string): string {
  return [
    `This session stopped while it was ${state}. Continue exactly where you left off. Anything that was in flight (a shell command, a subagent, a send or a push) was interrupted: re-check its real state before relying on it, and redo it if it did not finish.`,
    ...(note?.trim() ? ["", note.trim()] : []),
  ].join("\n")
}

/** Send a resume nudge to a stuck or stopped session. */
export async function resumeAppSession(id: string, note: string | undefined, options: AppSessionsOptions = {}): Promise<SendResult & { stoppedWhile: string }> {
  assertSessionId(id)
  const facts = tailFacts(tailEvents(stateDirOf(options), id, STATUS_TAIL_BYTES))
  const stoppedWhile = facts.loopCut ? facts.detail.replace(/^mid-turn/, "in the middle of a turn") : "working"
  const sent = await sendToAppSession(id, resumePrompt(stoppedWhile, note), options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_resumed", message: "sent a resume nudge to a Copilot app session", meta: { session: id, ok: sent.ok } })
  return { ...sent, stoppedWhile }
}

export interface OpenChatResult {
  ok: boolean
  sessionId: string | null
  sent: SendResult | null
  error: string | null
  created?: boolean
  placement?: {
    verified: boolean
    associationVerified: boolean
    kind?: AppSessionRow["kind"]
    name?: string
    workspaceId?: string | null
    projectId?: string | null
    parentSessionId?: string | null
    creatorSessionId?: string | null
    coordinatingCreatorSessionId?: string | null
    sidebarPlacement: AppSessionRow["sidebarPlacement"]
  }
}

/** A new chat session in the sidebar (`create_session`), named, with an optional first message. */
export async function openAppChat(
  request: { name?: string; prompt?: string; cwd?: string; agent?: string; model?: string },
  options: AppSessionsOptions = {},
): Promise<OpenChatResult> {
  const requestId = randomUUID()
  const got = await exchange(
    [{ type: "create_session", cwd: request.cwd ?? os.homedir(), session_type: "general_chat", ...(request.model ? { model: request.model } : {}), ...(request.agent ? { agent: request.agent } : {}), request_id: requestId }],
    {
      keep: (frame) => frame.request_id === requestId || frame.type === "socket_error",
      done: (frame) => /^(session_created|error|socket_error)$/.test(String(frame.type)),
      waitMs: REQUEST_WAIT_MS,
    },
    options,
  )
  const made = got.find(frame => frame.type === "session_created" && str(frame.session_id))
  if (!made) {
    const error = got.length ? lastError(got, "error") : "the app did not create a session in time"
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.app_sessions_open_error", message: "the Copilot app did not create a session", meta: { error } })
    return { ok: false, sessionId: null, sent: null, error }
  }
  const id = assertSessionId(made.session_id as string)
  let sent: SendResult | null = null
  let placement: NonNullable<OpenChatResult["placement"]> = { verified: false, associationVerified: false, sidebarPlacement: "unknown" }
  let error: string | null = null
  try {
    const row = listAppSessions(options).find(session => session.id === id)
    if (!row) error = "session created but not observable in the current sidebar; placement is unverified"
    else {
      placement = {
        verified: false, associationVerified: true, kind: row.kind, name: row.name, workspaceId: row.workspaceId, projectId: row.projectId,
        sidebarPlacement: row.sidebarPlacement,
        ...(row.parentSessionId !== undefined ? { parentSessionId: row.parentSessionId } : {}),
        ...(row.creatorSessionId !== undefined ? { creatorSessionId: row.creatorSessionId } : {}),
        ...(row.coordinatingCreatorSessionId !== undefined ? { coordinatingCreatorSessionId: row.coordinatingCreatorSessionId } : {}),
      }
      if (row.kind !== "chat") error = "session created with unexpected workspace association; inspect its actual placement"
      else {
        if (request.name) {
          await exchange([{ type: "rename_session", session_id: id, title: request.name }], { waitMs: RENAME_WAIT_MS }, options)
          const renamed = listAppSessions(options).find(session => session.id === id)
          if (!renamed) throw new Error("created session is no longer observable after rename")
          placement.name = renamed.name
        }
        sent = request.prompt ? await sendToAppSession(id, request.prompt, options) : null
        if (sent && !sent.ok) error = `session created but initial message was not accepted: ${sent.error}`
      }
    }
  } catch (cause) {
    error = `session created but follow-up or placement could not be verified: ${(cause as Error).message}`
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_opened", message: "created a Copilot app session and checked actual association", meta: { session: id, named: !!request.name, prompted: !!request.prompt, associationVerified: placement.associationVerified, error } })
  return { ok: error === null, created: true, sessionId: id, sent, placement, error }
}

/** Archive one session: its workspace when it has one, else the chat itself. */
export async function archiveAppSession(id: string, options: AppSessionsOptions = {}): Promise<{ ok: boolean; reply: string; error: string | null }> {
  assertSessionId(id)
  const stateDir = stateDirOf(options)
  const known = sessionRecord(stateDir, id)
  if (!known) return { ok: false, reply: "not found", error: `no Copilot app session ${id} on this Mac` }
  const requestId = randomUUID()
  let result: { ok: boolean; reply: string; error: string | null }
  if (known.workspace_id) {
    const got = await exchange(
      [{ type: "archive_workspace", workspace_id: known.workspace_id, delete_worktree: known.workspace_type === "worktree", request_id: requestId }],
      {
        keep: (frame) => frame.request_id === requestId || frame.type === "socket_error",
        done: (frame) => /^(workspace_archived|error|socket_error)$/.test(String(frame.type)),
        waitMs: ARCHIVE_WAIT_MS,
      },
      options,
    )
    const ok = got.at(-1)?.type === "workspace_archived"
    result = { ok, reply: str(got.at(-1)?.type) ?? "no reply", error: ok ? null : lastError(got, "the app did not archive it in time") }
  } else {
    const got = await exchange(
      [{ type: "archive_session", session_id: id, request_id: requestId }],
      {
        keep: (frame) => frame.request_id === requestId || frame.type === "general_chat_sessions_changed" || frame.type === "socket_error",
        done: (frame) => frame.type === "error" || frame.type === "socket_error" || frame.type === "general_chat_sessions_changed",
        waitMs: CHAT_ARCHIVE_WAIT_MS,
      },
      options,
    )
    const archived = !!sessionRecord(stateDir, id)?.archived_at
    result = { ok: archived, reply: archived ? "archived" : "not archived", error: archived ? null : lastError(got, "the app did not archive it") }
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_archived", message: "asked the Copilot app to archive a session", meta: { session: id, ok: result.ok, reply: result.reply } })
  return result
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

// ---------- the app keeper (courtesy restarts) ----------

export const realRunFile: RunFile = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") })
  })
})

export type KeeperResult<T> = { installed: false; message: string } | ({ installed: true } & T)

/** The keeper's launch agent: the node it runs under and its script, from `launchctl print`. */
export async function findKeeper(options: AppSessionsOptions = {}): Promise<{ node: string; script: string } | null> {
  const run = options.runFile ?? realRunFile
  /* v8 ignore next -- tests always pass a uid; process.getuid exists on every platform the keeper runs on @preserve */
  const uid = options.uid ?? process.getuid?.() ?? 0
  const printed = await run("/bin/launchctl", ["print", `gui/${uid}/${KEEPER_LABEL}`], KEEPER_WAIT_MS)
  if (printed.code !== 0) return null
  const block = printed.stdout.match(/\barguments = \{([\s\S]*?)\n\s*\}/)
  const args = block ? block[1].split("\n").map(line => line.trim()).filter(Boolean) : []
  const script = args.find(arg => arg.endsWith("app-keeper.mjs"))
  const node = printed.stdout.match(/\bprogram = (.+)/)?.[1]?.trim() ?? args[0]
  return script && node ? { node, script } : null
}

const keeperMissing = (): { installed: false; message: string } => ({
  installed: false,
  message: `The Copilot app keeper (${KEEPER_LABEL}) is not installed on this Mac, so nothing was queued and the app was not restarted. Install it with \`node app-keeper.mjs install\` from the desk's machine setup.`,
})

async function runKeeper(args: string[], options: AppSessionsOptions): Promise<KeeperResult<{ output: unknown }>> {
  const run = options.runFile ?? realRunFile
  const keeper = await findKeeper({ ...options, runFile: run })
  if (!keeper) return keeperMissing()
  const result = await run(keeper.node, [keeper.script, ...args], KEEPER_WAIT_MS)
  if (result.code !== 0) throw new Error(`the app keeper failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return { installed: true, output: JSON.parse(result.stdout) as unknown }
}

/** Queue a courtesy restart of the app: the keeper restarts now if nobody is at the Mac, else shows its "Restart now" / "Not now" panel. */
export async function restartEnqueue(why: string, by: string, options: AppSessionsOptions = {}): Promise<KeeperResult<{ request: unknown }>> {
  const result = await runKeeper(["enqueue", "--why", why, "--by", by], options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_restart_enqueued", message: "asked the app keeper for a courtesy restart", meta: { installed: result.installed, why } })
  return result.installed ? { installed: true, request: result.output } : result
}

/** The keeper's queue, panel, last restarts and resume state. */
export async function restartStatus(options: AppSessionsOptions = {}): Promise<KeeperResult<{ status: unknown }>> {
  const result = await runKeeper(["status", "--json"], options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_restart_status", message: "read the app keeper's restart status", meta: { installed: result.installed } })
  return result.installed ? { installed: true, status: result.output } : result
}
