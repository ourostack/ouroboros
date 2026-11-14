import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type WebSocket from "ws"

import {
  appRunning, archiveAppSession, assertSessionId, classify, defaultStateDir, describePermission, eventLogSize, exchange, findKeeper, KEEPER_LABEL,
  listAppSessions, listSessionQueue, messageDelivered, messagesIn, openAppChat, parseEventLines, readEventLog, realRunFile, restartEnqueue, restartStatus,
  readAppSessionHistory, readNewAppEvents, resumeAppSession, resumePrompt, sendToAppSession, snapshot, tailAppSession, tailFacts, withdrawQueuedMessages, type RunFile,
} from "../../../senses/app-sessions/client"

type Frame = Record<string, unknown>

/** One WebSocket to the app; `FakeApp` plays the app's side. */
class FakeSocket extends EventEmitter {
  readyState = 0
  closedAt: number | null = null
  constructor(readonly url: string, private readonly app: FakeApp) {
    super()
    setImmediate(() => {
      if (app.refuse) {
        this.emit("error", new Error("ECONNREFUSED"))
        this.close()
        return
      }
      this.readyState = 1
      this.emit("open")
      this.push({ type: "server_hello" })
    })
  }
  send(line: string): void {
    const frame = JSON.parse(line) as Frame
    this.app.requests.push(frame)
    this.app.handlers.get(frame.type as string)?.(frame, this)
  }
  push(frame: Frame | string): void {
    if (this.readyState === 3) return
    this.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closedAt = Date.now()
    this.emit("close")
  }
}

class FakeApp {
  sockets: FakeSocket[] = []
  requests: Frame[] = []
  refuse = false
  handlers = new Map<string, (frame: Frame, socket: FakeSocket) => void>()
  open = (url: string): WebSocket => {
    const socket = new FakeSocket(url, this)
    this.sockets.push(socket)
    return socket as unknown as WebSocket
  }
  on(type: string, handler: (frame: Frame, socket: FakeSocket) => void): void {
    this.handlers.set(type, handler)
  }
}

const WS = "11111111-aaaa-bbbb-cccc-000000000001"
const CHAT = "22222222-aaaa-bbbb-cccc-000000000002"
const STUCK = "33333333-aaaa-bbbb-cccc-000000000003"
const NOW = Date.parse("2026-11-10T03:00:00Z")
const OLD = "2026-11-10T02:00:00.000Z"
const iso = (ms: number) => new Date(ms).toISOString()

let stateDir: string
let app: FakeApp

function db(): Database.Database {
  return new Database(path.join(stateDir, "data.db"))
}

function makeDb(hostColumn = true): void {
  const handle = db()
  handle.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, session_type TEXT NOT NULL DEFAULT 'project', is_running INTEGER NOT NULL DEFAULT 0,
      was_interrupted INTEGER NOT NULL DEFAULT 0, updated_at TEXT, archived_at TEXT, execution_location TEXT NOT NULL DEFAULT 'local');
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, workspace_type TEXT, name TEXT, session_id TEXT, archived_at TEXT, updated_at TEXT${hostColumn ? ", host_id TEXT" : ""});
  `)
  handle.close()
}

function addSession(row: { id: string; title?: string | null; type?: string; running?: number; interrupted?: number; archived?: string | null; location?: string; updated?: string }): void {
  const handle = db()
  handle.prepare("INSERT INTO sessions (id, title, session_type, is_running, was_interrupted, updated_at, archived_at, execution_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.title ?? null, row.type ?? "project", row.running ?? 0, row.interrupted ?? 0, row.updated ?? OLD, row.archived ?? null, row.location ?? "local")
  handle.close()
}

function addWorkspace(row: { id: string; session: string | null; name?: string | null; type?: string; project?: string | null; archived?: string | null; host?: string | null }, hostColumn = true): void {
  const handle = db()
  if (hostColumn) handle.prepare("INSERT INTO workspaces (id, project_id, workspace_type, name, session_id, archived_at, updated_at, host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.project ?? "p1", row.type ?? "branch", row.name ?? null, row.session, row.archived ?? null, OLD, row.host ?? null)
  else handle.prepare("INSERT INTO workspaces (id, project_id, workspace_type, name, session_id, archived_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.project ?? "p1", row.type ?? "branch", row.name ?? null, row.session, row.archived ?? null, OLD)
  handle.close()
}

function writeEvents(id: string, events: unknown[]): string {
  const dir = path.join(stateDir, "session-state", id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "events.jsonl")
  fs.writeFileSync(file, events.map(event => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + "\n")
  return file
}

const event = (type: string, data: Frame = {}, extra: Frame = {}) => ({ type, data, timestamp: OLD, ...extra })
const options = (extra: Record<string, unknown> = {}) => ({ stateDir, openSocket: app.open, now: () => NOW, ...extra })

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-sessions-"))
  fs.mkdirSync(path.join(stateDir, "run"))
  fs.writeFileSync(path.join(stateDir, "run", "ws.port"), `51234\n${process.pid}\n`)
  fs.writeFileSync(path.join(stateDir, "run", "ws.token"), "tok\n")
  app = new FakeApp()
  makeDb()
  const handle = db()
  handle.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'personal-desk')").run()
  handle.close()
})

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe("app-sessions client basics", () => {
  it("defaults to ~/.copilot and checks session ids", () => {
    expect(defaultStateDir()).toBe(path.join(os.homedir(), ".copilot"))
    expect(assertSessionId(WS)).toBe(WS)
    expect(() => assertSessionId("../etc")).toThrow("is not a Copilot app session id")
  })

  it("knows whether the app is running from its server files", () => {
    expect(appRunning({ stateDir })).toBe(true)
    expect(appRunning()).toBe(false)
    fs.rmSync(path.join(stateDir, "run"), { recursive: true })
    expect(appRunning({ stateDir })).toBe(false)
  })

  it("parses event lines, skipping cut and non-object lines", () => {
    expect(parseEventLines('{"type":"a"}\n{cut\n[1]\nnot json\n{"type":"b"}')).toEqual([{ type: "a" }, { type: "b" }])
    expect(parseEventLines("{\"x\":1}\n\"str\"")).toEqual([{ x: 1 }])
  })
})

describe("what a session's history says", () => {
  it("sees a session mid-turn, between turns after tools, finished, stopped, or untouched", () => {
    expect(tailFacts([])).toMatchObject({ loopCut: false, detail: "no agent activity", awaiting: null, lastActivity: null })
    expect(tailFacts([event("user.message", { content: "go" })])).toMatchObject({ loopCut: true, detail: "mid-turn (last user.message)", lastActivity: OLD })
    expect(tailFacts([event("assistant.message", { content: "x", toolRequests: [{}] }), event("assistant.turn_end")])).toMatchObject({ loopCut: true, detail: expect.stringContaining("between turns") })
    expect(tailFacts([event("assistant.message", { content: "done" }), event("assistant.turn_end")])).toMatchObject({ loopCut: false, detail: "its turn ended" })
    expect(tailFacts([event("session.task_complete"), event("assistant.turn_end")])).toMatchObject({ loopCut: false, detail: "task complete" })
    expect(tailFacts([event("session.task_complete")])).toMatchObject({ detail: "task complete" })
    expect(tailFacts([event("user.message"), event("abort", { reason: "user_initiated" })])).toMatchObject({ loopCut: false, detail: "stopped by the person" })
    expect(tailFacts([event("user.message"), event("abort")])).toMatchObject({ detail: "stopped by the person" })
    // A runtime shutdown's sub-agent cancellations are not the person's stop.
    expect(tailFacts([event("user.message"), event("abort", { reason: "subagent_cancelled" })])).toMatchObject({ loopCut: true })
    // Sub-agents' own events are their parent's business; untimed events keep the last time.
    expect(tailFacts([event("assistant.turn_end"), event("user.message", {}, { agentId: "a1" }), { type: "assistant.turn_start" }])).toMatchObject({ loopCut: true, lastActivity: OLD })
    expect(tailFacts([{ data: "x" }, event("session.task_complete")])).toMatchObject({ detail: "task complete" })
  })

  it("sees what the session waits on: an answer, a plan approval, or a permission", () => {
    expect(tailFacts([event("tool.execution_start", { toolCallId: "t1", toolName: "ask_user" })]).awaiting).toBe("input")
    expect(tailFacts([event("tool.execution_start", { toolCallId: "t1", toolName: "desk-ask_user" })]).awaiting).toBe("input")
    expect(tailFacts([event("tool.execution_start", { toolCallId: "t1", toolName: "exit_plan_mode" })]).awaiting).toBe("plan")
    expect(tailFacts([event("tool.execution_start", { toolCallId: "t1" })]).awaiting).toBe(null)
    expect(tailFacts([event("tool.execution_start", { toolCallId: "t1", toolName: "ask_user" }), event("tool.execution_complete", { toolCallId: "t1" })]).awaiting).toBe(null)
    expect(tailFacts([event("tool.execution_start", { toolCallId: "t1", toolName: "ask_user" }), event("session.resume")]).awaiting).toBe(null)
    expect(tailFacts([event("tool.execution_start", {}), event("tool.execution_complete", {})]).awaiting).toBe(null)
    expect(tailFacts([event("permission.requested", { requestId: "r1" })]).awaiting).toBe("permission")
    expect(tailFacts([event("permission.requested", { requestId: "r1", resolvedByHook: true })]).awaiting).toBe(null)
    expect(tailFacts([event("permission.requested", {}), event("permission.completed", {})]).awaiting).toBe(null)
    expect(tailFacts([event("permission.requested", { requestId: "r1" }), event("permission.completed", { requestId: "r1" })]).awaiting).toBe(null)
  })

  it("keeps the oldest open permission request, with its time and a plain description, whatever else the session waits on", () => {
    const ask = { permissionRequest: { kind: "shell", intention: "Run required Desk boot", fullCommandText: "secret-token" } }
    expect(tailFacts([event("permission.requested", { requestId: "r1", ...ask }), event("permission.requested", { requestId: "r2" })]).prompt)
      .toEqual({ requestId: "r1", what: "run a shell command (Run required Desk boot)", at: OLD })
    expect(tailFacts([event("permission.requested", { requestId: "r1" }), event("permission.completed", { requestId: "r1" }), event("permission.requested", { requestId: "r2" })]).prompt?.requestId).toBe("r2")
    expect(tailFacts([event("permission.requested", { requestId: "r1" }), event("permission.completed", { requestId: "r1" })])).not.toHaveProperty("prompt")
    expect(tailFacts([{ type: "permission.requested", data: { requestId: "r1" } }]).prompt?.at).toBe(null)
    const both = tailFacts([event("tool.execution_start", { toolCallId: "t1", toolName: "ask_user" }), event("permission.requested", { requestId: "r1" })])
    expect(both.awaiting).toBe("input")
    expect(both.prompt?.requestId).toBe("r1")
  })

  it("describes a permission request without echoing a command", () => {
    expect(describePermission({ kind: "extension-permission-access", extensionName: "plugin:desk:session-label", capabilities: ["register hooks"] })).toBe("let the extension plugin:desk:session-label register hooks")
    expect(describePermission({ kind: "extension-permission-access" })).toBe("let the extension (unnamed) ask for access")
    expect(describePermission({ kind: "write" })).toBe("change a file")
    expect(describePermission({ kind: "folder-trust" })).toBe("a folder-trust permission")
    expect(describePermission(undefined)).toBe("a permission")
  })

  it("classifies: waiting first, then running, then a cut loop as stuck once it is not fresh", () => {
    const facts = { awaiting: null, loopCut: false, detail: "its turn ended", lastActivity: OLD }
    expect(classify(false, { ...facts, awaiting: "permission" }, NOW)).toEqual({ state: "waiting", detail: "waiting for a permission answer" })
    expect(classify(true, { ...facts, awaiting: "plan" }, NOW)).toEqual({ state: "waiting", detail: "waiting for the person's plan approval" })
    expect(classify(false, { ...facts, awaiting: "input" }, NOW).detail).toBe("waiting for the person's answer")
    expect(classify(true, facts, NOW).state).toBe("working")
    expect(classify(false, { ...facts, loopCut: true, detail: "mid-turn (last user.message)" }, NOW)).toEqual({ state: "stuck", detail: "not running, but its loop stopped mid-turn (last user.message)" })
    expect(classify(false, { ...facts, loopCut: true, lastActivity: null }, NOW).state).toBe("stuck")
    expect(classify(false, { ...facts, loopCut: true, lastActivity: iso(NOW - 10_000) }, NOW)).toMatchObject({ state: "working", detail: expect.stringContaining("starting up") })
    expect(classify(false, facts, NOW)).toEqual({ state: "idle", detail: "its turn ended" })
  })
})

describe("whether a sent message reached the session", () => {
  const SID = "58fbd57e-e371-4169-b013-2f413ab4a046"
  const wake = "New or changed issues in a/b: #1038 Title.\n\nDrain them (the why)."
  const sentAt = Date.parse(OLD)

  it("finds a user message with the same text at or after the send, ignoring whitespace and its wrapper", () => {
    writeEvents(SID, [
      event("user.message", { content: "something else" }),
      event("user.message", { content: `[app message]\n${wake.replace("\n\n", "\n   ")} extra` }, { timestamp: "2026-11-10T02:30:00.000Z" }),
    ])
    expect(messageDelivered(SID, wake, sentAt, { stateDir })).toBe(true)
  })

  it("does not count an assistant echo, an older message, a missing log or an unrelated message", () => {
    expect(messageDelivered(SID, wake, sentAt, { stateDir })).toBe(false)
    writeEvents(SID, [
      event("assistant.message", { content: wake }),
      event("user.message", { content: wake }, { timestamp: "2026-11-10T01:00:00.000Z" }),
      { type: "user.message", data: { content: wake } },
      event("user.message", {}),
      { type: "user.message", timestamp: OLD, data: "x" },
    ])
    expect(messageDelivered(SID, wake, sentAt, { stateDir })).toBe(false)
  })
})

describe("listing the sidebar", () => {
  beforeEach(() => {
    addSession({ id: WS, title: "Title", running: 1 })
    addWorkspace({ id: "w1", session: WS, name: "Fix the thing" })
    addSession({ id: CHAT, title: "A chat", type: "general_chat", interrupted: 1 })
    addSession({ id: STUCK, title: null })
    addWorkspace({ id: "w3", session: STUCK, name: null, project: "gone", host: "remote-host", type: "worktree" })
    writeEvents(STUCK, [event("user.message", { content: "go" })])
  })

  it("lists workspaces and chats with their state", () => {
    const rows = listAppSessions(options())
    expect(rows.map(row => [row.id, row.name, row.kind, row.state])).toEqual([
      [WS, "Fix the thing", "workspace", "working"],
      [STUCK, "(unnamed)", "workspace", "stuck"],
      [CHAT, "A chat", "chat", "idle"],
    ])
    expect(rows[0]).toMatchObject({ workspaceId: "w1", workspaceType: "branch", project: "personal-desk", isRunning: true, remote: false, lastActivity: OLD })
    expect(rows[1]).toMatchObject({ remote: true, project: null, lastActivity: OLD, workspaceType: "worktree" })
    expect(rows[2]).toMatchObject({ wasInterrupted: true, workspaceId: null, kind: "chat" })
  })

  it("carries a session's open permission prompt on its row", () => {
    writeEvents(CHAT, [event("permission.requested", { requestId: "r1", permissionRequest: { kind: "url" } })])
    const rows = listAppSessions(options())
    expect(rows.find(row => row.id === CHAT)).toMatchObject({ state: "waiting", prompt: { requestId: "r1", what: "open a web address", at: OLD } })
    expect(rows.find(row => row.id === WS)).not.toHaveProperty("prompt")
  })

  it("skips archived, session-less, duplicate and malformed rows, and names what has no name", () => {
    addSession({ id: "44444444-aaaa", title: null, type: "agent", location: "cloud" })
    addSession({ id: "bad id", type: "general_chat" })
    addSession({ id: "55555555-aaaa", type: "general_chat", archived: OLD })
    addWorkspace({ id: "w5", session: null })
    addWorkspace({ id: "w6", session: WS, archived: OLD })
    addWorkspace({ id: "w7", session: WS, name: "Again" })
    const rows = listAppSessions(options())
    expect(rows.map(row => row.id)).toEqual([WS, STUCK, CHAT, "44444444-aaaa"])
    expect(rows[3]).toMatchObject({ name: "(unnamed chat)", remote: true })
  })

  it("re-reads a session's history only when it changed", () => {
    expect(listAppSessions(options()).find(row => row.id === STUCK)!.state).toBe("stuck")
    expect(listAppSessions(options()).find(row => row.id === STUCK)!.state).toBe("stuck")
    writeEvents(STUCK, [event("user.message"), event("assistant.message", { content: "done" }), event("assistant.turn_end"), "{\"type\":\"assistant.turn_start\""])
    expect(listAppSessions(options()).find(row => row.id === STUCK)!.state).toBe("idle")
  })

  it("reads an older app's database with no host column", () => {
    fs.rmSync(path.join(stateDir, "data.db"))
    makeDb(false)
    addSession({ id: WS, title: "Old" })
    addWorkspace({ id: "w1", session: WS, name: null }, false)
    expect(listAppSessions({ stateDir })).toMatchObject([{ id: WS, name: "Old", remote: false, project: null }])
  })

  it("keeps project association, creator provenance and observable parent placement distinct", () => {
    const handle = db()
    handle.exec("ALTER TABLE workspaces ADD COLUMN creator_session_id TEXT; ALTER TABLE workspaces ADD COLUMN coordinating_creator_session_id TEXT")
    handle.prepare("UPDATE workspaces SET creator_session_id = ?, coordinating_creator_session_id = ? WHERE session_id = ?").run(CHAT, CHAT, WS)
    expect(listAppSessions(options()).find(row => row.id === WS)).toMatchObject({ projectId: "p1", creatorSessionId: CHAT, coordinatingCreatorSessionId: CHAT, sidebarPlacement: "unknown" })
    expect(listAppSessions(options()).find(row => row.id === CHAT)).not.toHaveProperty("parentSessionId")
    handle.exec("ALTER TABLE workspaces ADD COLUMN parent_session_id TEXT; ALTER TABLE sessions ADD COLUMN parent_session_id TEXT; ALTER TABLE sessions ADD COLUMN creator_session_id TEXT")
    handle.prepare("UPDATE workspaces SET parent_session_id = ? WHERE session_id = ?").run(CHAT, WS)
    expect(listAppSessions(options()).find(row => row.id === WS)).toMatchObject({ parentSessionId: CHAT, sidebarPlacement: "unknown" })
    expect(listAppSessions(options()).find(row => row.id === CHAT)).toMatchObject({ parentSessionId: null, creatorSessionId: null, sidebarPlacement: "unknown" })
    expect(listAppSessions(options()).find(row => row.id === STUCK)).toMatchObject({ parentSessionId: null, sidebarPlacement: "unknown" })
    handle.close()
  })

  it("throws plainly when the app has no database here", () => {
    fs.rmSync(path.join(stateDir, "data.db"))
    expect(() => listAppSessions({ stateDir })).toThrow("no GitHub Copilot app database")
  })

  it("snapshots counts and every session's id, name and state", () => {
    expect(snapshot(options())).toEqual({
      at: iso(NOW), appRunning: true,
      counts: { working: 1, idle: 1, waiting: 0, stuck: 1 },
      sessions: [{ id: WS, name: "Fix the thing", state: "working" }, { id: STUCK, name: "(unnamed)", state: "stuck" }, { id: CHAT, name: "A chat", state: "idle" }],
    })
    expect(snapshot({ stateDir }).at).toMatch(/^\d{4}-/)
  })

  it("derives counts and sessions from one observed sidebar rather than reading a different revision", () => {
    const rows = listAppSessions(options())
    fs.rmSync(path.join(stateDir, "data.db"))
    expect(snapshot(options(), rows)).toMatchObject({
      counts: { working: 1, idle: 1, waiting: 0, stuck: 1 },
      sessions: rows.map(({ id, name, state }) => ({ id, name, state })),
    })
  })
})

describe("reading a session", () => {
  it("tails the last user and assistant messages, top level only", () => {
    writeEvents(WS, [
      event("user.message", { content: "hi" }, { timestamp: "t1" }),
      event("assistant.message", { content: "  " }),
      event("assistant.message", { content: "sub" }, { agentId: "a" }),
      event("tool.execution_start"),
      event("assistant.message", { content: "hello" }, { timestamp: "t2" }),
      event("user.message", {}),
      event("user.message", { content: "x".repeat(5000) }, { timestamp: undefined }),
    ])
    const messages = tailAppSession(WS, 3, { stateDir })
    expect(messages.map(message => [message.role, message.text.length])).toEqual([["user", 2], ["assistant", 5], ["user", 4000]])
    expect(messages[2].truncated).toBe(true)
    expect(messages[2].at).toBeNull()
    expect(tailAppSession(WS, 0, { stateDir })).toHaveLength(1)
    expect(tailAppSession(CHAT, 5, { stateDir })).toEqual([])
    expect(messagesIn([{ type: "assistant.message" }])).toEqual([])
  })

  it("finds the requested conversation across large non-message events", () => {
    const conversation = Array.from({ length: 12 }, (_, index) =>
      event(index % 2 ? "assistant.message" : "user.message", { content: `turn ${index}` }))
    writeEvents(WS, [
      ...conversation.slice(0, 11),
      event("model.messages_snapshot", { padding: "x".repeat(3 * 1024 * 1024) }),
      event("session.binary_asset", { padding: "x".repeat(9 * 1024 * 1024) }),
      ...conversation.slice(11),
    ])
    expect(tailAppSession(WS, 12, { stateDir }).map(message => message.text))
      .toEqual(conversation.map(item => item.data.content))
    expect(readAppSessionHistory(WS, 12, { stateDir })).toMatchObject({ requestedCount: 12, returnedCount: 12, skippedEvents: 1, source: "local_event_log" })
  })

  it("reports short, missing, malformed and truncated history without fabricating completeness", () => {
    expect(readAppSessionHistory(CHAT, 12, options())).toMatchObject({ missing: true, returnedCount: 0, beginningReached: false })
    const file = writeEvents(WS, ["", "not json", event("assistant.message", { content: "é".repeat(300_000) })])
    const history = readAppSessionHistory(WS, 12, options())
    expect(history).toMatchObject({ missing: false, beginningReached: true, returnedCount: 1, skippedEvents: 1, observedAt: iso(NOW) })
    expect(history.messages[0]).toMatchObject({ text: "é".repeat(4000), truncated: true })
    fs.writeFileSync(file, "")
    expect(readAppSessionHistory(WS, 12, options())).toMatchObject({ beginningReached: true, logBytes: 0, returnedCount: 0 })
    fs.writeFileSync(file, JSON.stringify(event("user.message", { content: "no final newline" })))
    expect(tailAppSession(WS, 12, options())[0].text).toBe("no final newline")
    fs.rmSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(path.dirname(file), "not a directory")
    expect(() => readAppSessionHistory(WS, 12, options())).toThrow()
  })

  it("does not discard a preceding message when an oversized line aligns with a chunk boundary or starts the file", () => {
    const first = JSON.stringify(event("user.message", { content: "first" })) + "\n"
    const last = JSON.stringify(event("assistant.message", { content: "last" })) + "\n"
    const empty = JSON.stringify(event("session.binary_asset", { padding: "" })) + "\n"
    const huge = JSON.stringify(event("session.binary_asset", { padding: "x".repeat(9 * 1024 * 1024 - Buffer.byteLength(last) - Buffer.byteLength(empty)) })) + "\n"
    const file = writeEvents(WS, [])
    fs.writeFileSync(file, first + huge + last)
    expect(readAppSessionHistory(WS, 12, options())).toMatchObject({ returnedCount: 2, skippedEvents: 1, beginningReached: true })
    expect(tailAppSession(WS, 12, options()).map(message => message.text)).toEqual(["first", "last"])
    fs.writeFileSync(file, huge + last)
    expect(readAppSessionHistory(WS, 12, options())).toMatchObject({ returnedCount: 1, skippedEvents: 1 })
  })

  it("reads forward in bounded complete-event batches and survives oversized or incomplete lines", () => {
    const file = writeEvents(WS, [
      event("assistant.message", { content: "first" }),
      event("session.binary_asset", { padding: "x".repeat(9 * 1024 * 1024) }),
      "malformed", "", event("assistant.message", { content: "last" }),
    ])
    const seen: Frame[] = []
    const first = readNewAppEvents(WS, 0, 1, item => seen.push(item), options())
    expect(first.offset).toBeLessThan(first.logBytes)
    const next = readNewAppEvents(WS, first.offset, 20 * 1024 * 1024, item => seen.push(item), options())
    expect(next).toMatchObject({ offset: fs.statSync(file).size, skippedEvents: 2 })
    expect(messagesIn(seen).map(message => message.text)).toEqual(["first", "last"])
    fs.appendFileSync(file, '{"type":"assistant.message"')
    expect(readNewAppEvents(WS, next.offset, 100, item => seen.push(item), options()).offset).toBe(next.offset)
    expect(readNewAppEvents(CHAT, 0, 100, () => undefined, options())).toEqual({ offset: 0, logBytes: 0, skippedEvents: 0 })
  })

  it("reads the log from an offset, bounded, and knows its size", () => {
    const file = writeEvents(WS, [event("user.message", { content: "one" }), event("user.message", { content: "two" })])
    const size = fs.statSync(file).size
    expect(eventLogSize(WS, { stateDir })).toBe(size)
    expect(eventLogSize(CHAT, { stateDir })).toBe(0)
    expect(eventLogSize("bad id", { stateDir })).toBe(0)
    expect(readEventLog(WS, { stateDir, from: size - 5, maxBytes: 100 })).toEqual({ text: fs.readFileSync(file, "utf-8").slice(size - 5), start: size - 5, end: size })
    expect(readEventLog(WS, { stateDir, maxBytes: 4 }).start).toBe(size - 4)
    expect(readEventLog(CHAT, { stateDir, maxBytes: 4 })).toEqual({ text: "", start: 0, end: 0 })
  })
})

describe("the app's socket", () => {
  it("collects the kept replies until done, ignoring frames that are not JSON objects", async () => {
    app.on("ping", (_frame, socket) => {
      socket.push("not json")
      socket.push("[1]")
      socket.push({ type: "noise" })
      socket.push({ type: "pong" })
    })
    const got = await exchange([{ type: "ping" }], { keep: frame => frame.type !== "noise", done: frame => frame.type === "pong", waitMs: 1_000 }, options())
    expect(got).toEqual([{ type: "pong" }])
    expect(app.sockets[0].url).toBe("ws://127.0.0.1:51234?token=tok&observer=1")
  })

  it("ends on a socket error, on the app closing the socket, and on the wait running out", async () => {
    app.refuse = true
    expect(await exchange([{ type: "x" }], { waitMs: 1_000 }, options())).toEqual([{ type: "socket_error", message: "ECONNREFUSED" }])
    app.refuse = false
    app.on("bye", (_frame, socket) => socket.close())
    expect(await exchange([{ type: "bye" }], { waitMs: 1_000 }, options())).toEqual([])
    expect(await exchange([], { waitMs: 20 }, options())).toEqual([{ type: "server_hello" }])
  })

  it("opens a real WebSocket by default", async () => {
    // Nothing listens on this port: the real socket fails and the exchange says so.
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "1\n")
    expect(await exchange([{ type: "x" }], { waitMs: 5_000 }, { stateDir })).toEqual([{ type: "socket_error", message: expect.any(String) }])
  })

  it("throws when the app is not running", () => {
    fs.rmSync(path.join(stateDir, "run"), { recursive: true })
    expect(() => exchange([], { waitMs: 10 }, options())).toThrow("the GitHub Copilot app is not running")
  })
})

describe("a session's own queue", () => {
  beforeEach(() => addSession({ id: WS, title: "Title" }))
  const row = (id: string, text: string, source = "user", kind = "message") => ({ id, source, kind, display_text: text })

  it("lists the queued messages, and nothing when the app has none or answers with something else", async () => {
    app.on("get_session_queue", (frame, socket) => socket.push({ type: "command_result", request_id: frame.request_id, data: { items: [row("5", "one"), row("6", "steer", "user", "steering"), { id: 7 }, row("8", "agent says", "agent-x"), "junk"] } }))
    expect(await listSessionQueue(WS, options())).toEqual([{ id: "5", source: "user", text: "one" }, { id: "8", source: "agent-x", text: "agent says" }])
    app.on("get_session_queue", (frame, socket) => socket.push({ type: "command_result", request_id: frame.request_id, data: {} }))
    expect(await listSessionQueue(WS, options())).toEqual([])
    app.on("get_session_queue", (frame, socket) => socket.push({ type: "command_result", request_id: frame.request_id, error: "no such session" }))
    expect(await listSessionQueue(WS, options())).toEqual([])
    app.on("get_session_queue", (_frame, socket) => socket.push({ type: "socket_error", message: "reset" }))
    expect(await listSessionQueue(WS, options())).toEqual([])
  })

  it("takes back only the user-side messages that start with the prefix, and counts the ones the app removed", async () => {
    const queue = [row("5", "New or changed issues in a/b: #1. Drain them."), row("6", "New or changed issues in c/d: #2. Drain them."), row("7", "New or changed issues in a/b: #3. Drain them."), row("8", "New or changed issues in a/b: from an agent", "agent-x"), row("9", "New or changed issues in a/b: #9. Drain them.")]
    app.on("get_session_queue", (frame, socket) => socket.push({ type: "command_result", request_id: frame.request_id, data: { items: queue } }))
    app.on("remove_session_queue_item", (frame, socket) => socket.push({ type: "command_result", request_id: frame.request_id, ...(frame.id === "7" ? { error: "unknown queue item id", error_code: "item_not_found" } : { data: {} }) }))
    expect(await withdrawQueuedMessages(WS, "New or changed issues in a/b:", options({ sendWaitMs: 2_000 }))).toBe(2)
    expect(app.requests.filter(request => request.type === "remove_session_queue_item").map(request => request.id)).toEqual(["5", "7", "9"])
    queue.splice(0, queue.length, { id: "11", kind: "message", source: "user", display_text: "New or changed issues in a/b: bare" })
    expect(await withdrawQueuedMessages(WS, "New or changed issues in a/b:", options())).toBe(1)
    app.on("remove_session_queue_item", (_frame, socket) => socket.push({ type: "socket_error", message: "reset" }))
    queue.splice(0, queue.length, { id: "13", kind: "message", source: "user", display_text: "New or changed issues in a/b: x" })
    expect(await withdrawQueuedMessages(WS, "New or changed issues in a/b:", options())).toBe(0)
    queue.splice(0, queue.length, { id: "12", kind: "message" })
    expect(await listSessionQueue(WS, options())).toEqual([{ id: "12", source: "", text: "" }])
  })
})

describe("sending", () => {
  beforeEach(() => {
    addSession({ id: WS, title: "Title" })
    addWorkspace({ id: "w1", session: WS, name: "Fix the thing" })
  })

  it("waits for the app's answer instead of closing early, which would cancel the send", async () => {
    app.on("send_message", (frame, socket) => {
      setTimeout(() => socket.push({ type: "session_message_sent", request_id: frame.request_id, message_id: "m1" }), 60)
    })
    const started = Date.now()
    const result = await sendToAppSession(WS, "hello", options({ sendWaitMs: 5_000 }))
    expect(result).toEqual({ ok: true, reply: "session_message_sent", messageId: "m1", error: null })
    expect(app.sockets[0].closedAt! - started).toBeGreaterThanOrEqual(50)
    expect(app.requests).toEqual([expect.objectContaining({ type: "send_message", session_id: WS, prompt: "hello", delivery_mode: "immediate" })])
  })

  it("counts a queued message as delivered, matched by session when the app drops the request id", async () => {
    app.on("send_message", (_frame, socket) => {
      socket.push({ type: "session_message_queued", request_id: "other" })
      socket.push({ type: "session_message_queued", session_id: WS })
    })
    expect(await sendToAppSession(WS, "later", options({ delivery: "enqueue" }))).toEqual({ ok: true, reply: "session_message_queued", messageId: null, error: null })
    expect(app.requests[0].delivery_mode).toBe("enqueue")
  })

  it("reports what the app said when it did not deliver", async () => {
    app.on("send_message", (frame, socket) => socket.push({ type: "session_message_delivery_unknown", request_id: frame.request_id, detail: "runtime busy" }))
    expect(await sendToAppSession(WS, "x", options())).toEqual({ ok: false, reply: "session_message_delivery_unknown", messageId: null, error: "runtime busy" })
    app.on("send_message", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id, message: "nope" }))
    expect((await sendToAppSession(WS, "x", options())).error).toBe("nope")
    app.on("send_message", (frame, socket) => socket.push({ type: "session_resume_failed", request_id: frame.request_id, reason: "evicted" }))
    expect((await sendToAppSession(WS, "x", options())).error).toBe("evicted")
    app.on("send_message", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id }))
    expect((await sendToAppSession(WS, "x", options())).error).toBe("error")
    app.on("send_message", (frame, socket) => socket.push({ request_id: frame.request_id, type: "session_message_delivery_unknown", message_id: 5 }))
    expect((await sendToAppSession(WS, "x", options())).error).toBe("session_message_delivery_unknown")
  })

  it("says so when the app does not answer in time, or the socket fails", async () => {
    app.on("send_message", () => undefined)
    expect(await sendToAppSession(WS, "x", options({ sendWaitMs: 20 }))).toEqual({ ok: false, reply: "no reply", messageId: null, error: "the app did not answer in time" })
    app.refuse = true
    expect(await sendToAppSession(WS, "x", options())).toMatchObject({ ok: false, reply: "socket_error", error: "ECONNREFUSED" })
  })

  it("refuses sessions that are not in this app or are archived", async () => {
    expect(await sendToAppSession(CHAT, "x", options())).toMatchObject({ ok: false, reply: "not found", error: expect.stringContaining("no Copilot app session") })
    addSession({ id: CHAT, archived: OLD })
    expect(await sendToAppSession(CHAT, "x", options())).toMatchObject({ ok: false, reply: "archived" })
    addSession({ id: STUCK })
    addWorkspace({ id: "w3", session: STUCK, archived: OLD })
    expect(await sendToAppSession(STUCK, "x", options())).toMatchObject({ ok: false, reply: "archived" })
    expect(app.requests).toEqual([])
  })

  it("resumes with the keeper's nudge, naming where the loop stopped, plus a note", async () => {
    app.on("send_message", (frame, socket) => socket.push({ type: "session_message_sent", request_id: frame.request_id }))
    writeEvents(WS, [event("user.message", { content: "go" })])
    const result = await resumeAppSession(WS, "  Check PR 12 first.  ", options())
    expect(result).toMatchObject({ ok: true, stoppedWhile: "in the middle of a turn (last user.message)" })
    expect(app.requests[0].prompt).toBe(resumePrompt("in the middle of a turn (last user.message)", "Check PR 12 first."))
    expect(String(app.requests[0].prompt)).toContain("\n\nCheck PR 12 first.")
    writeEvents(WS, [event("assistant.turn_end")])
    expect(await resumeAppSession(WS, undefined, options())).toMatchObject({ stoppedWhile: "working" })
    expect(resumePrompt("working", " ")).not.toContain("\n")
  })
})

describe("opening and archiving", () => {
  it("opens a named chat with a first message", async () => {
    app.on("create_session", (frame, socket) => {
      addSession({ id: CHAT, type: "general_chat" })
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
    })
    app.on("send_message", (frame, socket) => socket.push({ type: "session_message_sent", request_id: frame.request_id }))
    const result = await openAppChat({ name: "Probe", prompt: "Reply PROBE-OK", cwd: "/tmp/x", agent: "desk:worker", model: "m1" }, options())
    expect(result).toMatchObject({ ok: true, created: true, sessionId: CHAT, sent: { ok: true, reply: "session_message_sent", messageId: null, error: null }, error: null, placement: { kind: "chat", verified: false, associationVerified: true, workspaceId: null, sidebarPlacement: "unknown" } })
    expect(app.requests.map(frame => frame.type)).toEqual(["create_session", "rename_session", "send_message"])
    expect(app.requests[0]).toMatchObject({ cwd: "/tmp/x", session_type: "general_chat", agent: "desk:worker", model: "m1" })
    expect(app.requests[1]).toEqual({ type: "rename_session", session_id: CHAT, title: "Probe" })
  })

  it("does not claim creation success when the app's acknowledgement has no observable session", async () => {
    app.on("create_session", (frame, socket) => socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT }))
    const result = await openAppChat({}, options())
    expect(result).toMatchObject({ ok: false, created: true, sessionId: CHAT, placement: { verified: false } })
    expect(result.error).toContain("not observable")
  })

  it("keeps creation distinct from initial prompt delivery and verified chat placement", async () => {
    const handle = db()
    handle.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT; ALTER TABLE sessions ADD COLUMN creator_session_id TEXT; ALTER TABLE sessions ADD COLUMN coordinating_creator_session_id TEXT")
    handle.close()
    app.on("create_session", (frame, socket) => {
      addSession({ id: CHAT, title: "Probe", type: "general_chat" })
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
    })

    app.on("send_message", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id, message: "rejected" }))
    const result = await openAppChat({ prompt: "go" }, options())
    expect(result).toMatchObject({ ok: false, created: true, sessionId: CHAT, sent: { ok: false }, placement: { kind: "chat", workspaceId: null, parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, sidebarPlacement: "unknown" } })
  })

  it("reports placement verification errors and unexpected workspace association without hiding created resources", async () => {
    app.on("create_session", (frame, socket) => {
      addSession({ id: WS })
      addWorkspace({ id: "created-workspace", session: WS })
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: WS })
    })
    expect(await openAppChat({ name: "Probe", prompt: "go" }, options())).toMatchObject({ ok: false, created: true, placement: { kind: "workspace", verified: false, associationVerified: true }, error: expect.stringContaining("unexpected workspace") })
    expect(app.requests.map(frame => frame.type)).toEqual(["create_session"])
    app.on("create_session", (frame, socket) => {
      fs.rmSync(path.join(stateDir, "data.db"))
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
    })
    expect(await openAppChat({}, options())).toMatchObject({ ok: false, created: true, placement: { verified: false }, error: expect.stringContaining("could not be verified") })
  })

  it("retains the created session when a rename or initial-send operation throws", async () => {
    app.on("create_session", (frame, socket) => {
      addSession({ id: CHAT, type: "general_chat" })
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
      fs.rmSync(path.join(stateDir, "run", "ws.port"))
    })
    expect(await openAppChat({ name: "Probe" }, options())).toMatchObject({ ok: false, created: true, sessionId: CHAT, error: expect.stringContaining("not running") })
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), `51234\n${process.pid}\n`)
    app.on("create_session", (frame, socket) => {
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
      fs.rmSync(path.join(stateDir, "data.db"))
    })
    expect(await openAppChat({ prompt: "go" }, options())).toMatchObject({ ok: false, created: true, sessionId: CHAT, error: expect.stringContaining("database") })
  })

  it("retains creation custody when the session disappears after rename", async () => {
    app.on("create_session", (frame, socket) => {
      addSession({ id: CHAT, type: "general_chat" })
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
    })
    app.on("rename_session", (_frame, socket) => {
      const handle = db()
      handle.prepare("DELETE FROM sessions WHERE id = ?").run(CHAT)
      handle.close()
      socket.close()
    })
    expect(await openAppChat({ name: "Probe", prompt: "go" }, options())).toMatchObject({
      ok: false, created: true, sessionId: CHAT, sent: null, error: expect.stringContaining("no longer observable after rename"),
    })
    expect(app.requests.map(frame => frame.type)).toEqual(["create_session", "rename_session"])
  })
  it("opens a bare chat in the home folder", async () => {
    app.on("create_session", (frame, socket) => {
      addSession({ id: CHAT, type: "general_chat" })
      socket.push({ type: "session_created", request_id: frame.request_id, session_id: CHAT })
    })
    expect(await openAppChat({}, options())).toMatchObject({ ok: true, created: true, sessionId: CHAT, sent: null, error: null })
    expect(app.requests).toEqual([expect.objectContaining({ type: "create_session", cwd: os.homedir() })])
    expect(app.requests[0]).not.toHaveProperty("agent")
  })

  it("reports a chat the app would not create", async () => {
    app.on("create_session", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id, message: "missing field `cwd`" }))
    expect(await openAppChat({ name: "x" }, options())).toEqual({ ok: false, sessionId: null, sent: null, error: "missing field `cwd`" })
    app.on("create_session", () => undefined)
    // No answer at all within the wait: the exchange ends with the server hello only.
    app.sockets.length = 0
    const pending = openAppChat({}, options())
    await new Promise(resolve => setTimeout(resolve, 5))
    app.sockets[0].close()
    expect(await pending).toEqual({ ok: false, sessionId: null, sent: null, error: "the app did not create a session in time" })
  })

  it("archives a workspace session through its workspace, deleting a worktree", async () => {
    addSession({ id: WS })
    addWorkspace({ id: "w1", session: WS, type: "worktree" })
    app.on("archive_workspace", (frame, socket) => socket.push({ type: "workspace_archived", request_id: frame.request_id }))
    expect(await archiveAppSession(WS, options())).toEqual({ ok: true, reply: "workspace_archived", error: null })
    expect(app.requests[0]).toMatchObject({ type: "archive_workspace", workspace_id: "w1", delete_worktree: true })
    app.on("archive_workspace", (frame, socket) => {
      socket.push({ type: "noise" })
      socket.push({ type: "error", request_id: frame.request_id, message: "busy" })
    })
    expect(await archiveAppSession(WS, options())).toEqual({ ok: false, reply: "error", error: "busy" })
    app.on("archive_workspace", (_frame, socket) => socket.close())
    expect(await archiveAppSession(WS, options())).toEqual({ ok: false, reply: "no reply", error: "the app did not archive it in time" })
  })

  it("archives a chat and checks the database says so", async () => {
    addSession({ id: CHAT, type: "general_chat" })
    app.on("archive_session", (_frame, socket) => {
      const handle = db()
      handle.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(OLD, CHAT)
      handle.close()
      socket.push({ type: "general_chat_sessions_changed" })
    })
    expect(await archiveAppSession(CHAT, options())).toEqual({ ok: true, reply: "archived", error: null })
    addSession({ id: STUCK, type: "general_chat" })
    app.on("archive_session", (frame, socket) => {
      socket.push({ type: "noise" })
      socket.push({ type: "error", request_id: frame.request_id, message: "no" })
    })
    expect(await archiveAppSession(STUCK, options())).toEqual({ ok: false, reply: "not archived", error: "no" })
    app.on("archive_session", (_frame, socket) => socket.close())
    expect((await archiveAppSession(STUCK, options())).error).toBe("the app did not archive it")
  })

  it("does not archive what is not in this app", async () => {
    expect(await archiveAppSession(WS, options())).toEqual({ ok: false, reply: "not found", error: expect.stringContaining("no Copilot app session") })
  })
})

describe("the app keeper", () => {
  const printed = `gui/501/${KEEPER_LABEL} = {\n\tprogram = /opt/node/bin/node\n\targuments = {\n\t\t/opt/node/bin/node\n\t\t/Users/me/setup/app-keeper.mjs\n\t\trun\n\t}\n}`
  function runner(answers: Record<string, { code: number; stdout: string; stderr?: string }>): RunFile & { calls: string[][] } {
    const calls: string[][] = []
    const run = (async (file: string, args: string[]) => {
      calls.push([file, ...args])
      const answer = answers[args[0] === "print" ? "print" : args[1]]
      return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" }
    }) as RunFile & { calls: string[][] }
    run.calls = calls
    return run
  }

  it("finds the keeper's node and script from its launch agent", async () => {
    expect(await findKeeper({ uid: 501, runFile: runner({ print: { code: 0, stdout: printed } }) })).toEqual({ node: "/opt/node/bin/node", script: "/Users/me/setup/app-keeper.mjs" })
    expect(await findKeeper({ uid: 501, runFile: runner({ print: { code: 0, stdout: printed.replace(/\tprogram = .*\n/, "") } }) })).toEqual({ node: "/opt/node/bin/node", script: "/Users/me/setup/app-keeper.mjs" })
    expect(await findKeeper({ uid: 501, runFile: runner({ print: { code: 0, stdout: "state = running" } }) })).toBeNull()
    expect(await findKeeper({ uid: 501, runFile: runner({ print: { code: 113, stdout: "" } }) })).toBeNull()
  })

  it("asks the keeper for its status and queues a courtesy restart", async () => {
    const run = runner({ print: { code: 0, stdout: printed }, status: { code: 0, stdout: '{"keeper":{"loaded":true},"pending":[]}' }, enqueue: { code: 0, stdout: '{"ok":true,"id":"1-a","queued":1}' } })
    expect(await restartStatus({ uid: 501, runFile: run })).toEqual({ installed: true, status: { keeper: { loaded: true }, pending: [] } })
    expect(await restartEnqueue("pick up the new build", "slugger", { uid: 501, runFile: run })).toEqual({ installed: true, request: { ok: true, id: "1-a", queued: 1 } })
    expect(run.calls).toContainEqual(["/opt/node/bin/node", "/Users/me/setup/app-keeper.mjs", "enqueue", "--why", "pick up the new build", "--by", "slugger"])
    expect(run.calls).toContainEqual(["/bin/launchctl", "print", `gui/501/${KEEPER_LABEL}`])
  })

  it("says plainly when the keeper is not installed, and nothing is queued", async () => {
    const run = runner({ print: { code: 113, stdout: "" } })
    const status = await restartStatus({ uid: 501, runFile: run })
    expect(status).toEqual({ installed: false, message: expect.stringContaining("is not installed on this Mac") })
    expect(await restartEnqueue("x", "y", { uid: 501, runFile: run })).toEqual(status)
    expect(run.calls).toHaveLength(2)
  })

  it("throws when the keeper itself fails", async () => {
    await expect(restartStatus({ uid: 501, runFile: runner({ print: { code: 0, stdout: printed }, status: { code: 1, stdout: "", stderr: "boom\n" } }) })).rejects.toThrow("the app keeper failed: boom")
    await expect(restartStatus({ uid: 501, runFile: runner({ print: { code: 0, stdout: printed }, status: { code: 1, stdout: "out" } }) })).rejects.toThrow("the app keeper failed: out")
  })

  it("runs commands for real, reporting failure as a non-zero code", async () => {
    expect(await realRunFile(process.execPath, ["-e", "process.stdout.write('ok')"], 10_000)).toEqual({ code: 0, stdout: "ok", stderr: "" })
    const failed = await realRunFile(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"], 10_000)
    expect(failed).toMatchObject({ code: 1, stderr: "bad" })
    expect((await realRunFile("/nonexistent/launchctl", [], 1_000)).stderr).toContain("ENOENT")
    expect(await findKeeper({ uid: 999_999 })).toBeNull()
    expect(await restartStatus({ uid: 999_999 })).toMatchObject({ installed: false })
  })
})
