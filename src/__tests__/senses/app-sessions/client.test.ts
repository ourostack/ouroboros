import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type WebSocket from "ws"

import {
  appRunning, assertSessionId, classify, defaultStateDir, describePermission, eventLogSize, exchange, findHousesitter, HOUSESITTER_ENV, HUNG_MS,
  listAppSessions, listSessionQueue, messageDelivered, messagesIn, parseEventLines, readEventLog, realRunFile, restartEnqueue, restartStatus,
  readAppSessionHistory, readNewAppEvents, snapshot, tailAppSession, tailFacts, withdrawQueuedMessages, type RunFile,
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

  it("calls a running session stuck once its history has not grown for half an hour", () => {
    const facts = { awaiting: null, loopCut: false, detail: "its turn ended", lastActivity: OLD }
    expect(classify(true, facts, NOW, NOW - HUNG_MS + 1).state).toBe("working")
    expect(classify(true, facts, NOW, null).state).toBe("working")
    expect(classify(true, facts, NOW, NOW - HUNG_MS)).toEqual({ state: "stuck", detail: "the app says it is running, but its history has not grown for 30 min" })
    expect(classify(true, { ...facts, awaiting: "permission" }, NOW, NOW - 5 * HUNG_MS).state).toBe("waiting")
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
  const session = (id: string, extra: Frame = {}) => ({ sessionId: id, isRunning: false, ...extra })
  const serve = (workspaces: Frame[], chats: Frame[]) => {
    app.on("list_workspaces", (_, socket) => socket.push({ type: "workspace_list", workspaces }))
    app.on("list_general_chat_sessions", (_, socket) => socket.push({ type: "general_chat_sessions_list", sessions: chats }))
  }
  const sidebar = () => serve(
    [
      { id: "w1", name: "Fix the thing", workspaceType: "branch", projectName: "personal-desk", projectId: "p1", branch: "main", checkoutBindings: [{ repoFullName: "a/b" }], session: session(WS, { isRunning: true }) },
      { id: "w3", workspaceType: "worktree", hostId: "remote-host", session: session(STUCK, { title: "Title" }) },
    ],
    [{ id: CHAT, title: "A chat", wasInterrupted: true, coordinatingCreatorSessionId: WS, parentSessionId: WS, executionLocation: "cloud" }],
  )

  it("lists workspaces and chats as the app lists them, with their state", async () => {
    sidebar()
    writeEvents(STUCK, [event("user.message", { content: "go" })])
    const rows = await listAppSessions(options())
    expect(rows.map(row => [row.id, row.name, row.kind, row.state])).toEqual([
      [WS, "Fix the thing", "workspace", "working"],
      [STUCK, "Title", "workspace", "stuck"],
      [CHAT, "A chat", "chat", "idle"],
    ])
    expect(rows[0]).toMatchObject({ workspaceId: "w1", workspaceType: "branch", project: "personal-desk", projectRepo: "a/b", isRunning: true, remote: false })
    expect(rows[1]).toMatchObject({ remote: true, project: null, lastActivity: OLD, workspaceType: "worktree" })
    expect(rows[2]).toMatchObject({ wasInterrupted: true, workspaceId: null, remote: true, coordinatingCreatorSessionId: WS, parentSessionId: WS })
  })

  it("carries a session's open permission prompt on its row", async () => {
    sidebar()
    writeEvents(CHAT, [event("permission.requested", { requestId: "r1", permissionRequest: { kind: "url" } })])
    const rows = await listAppSessions(options())
    expect(rows.find(row => row.id === CHAT)).toMatchObject({ state: "waiting", awaiting: "permission", prompt: { requestId: "r1", what: "open a web address", at: OLD } })
    expect(rows.find(row => row.id === WS)).not.toHaveProperty("prompt")
  })

  it("skips archived, session-less, duplicate and malformed rows, and names what has no name", async () => {
    serve(
      [{ id: "w5" }, { id: "w6", archivedAt: OLD, session: session(WS) }, { id: "w7", activeSessionId: WS }, { id: "w8", session: session(WS) }, { id: "w9", session: session("bad id") }],
      [{ id: CHAT }, { id: STUCK, archivedAt: OLD }, "x"] as Frame[],
    )
    const rows = await listAppSessions(options())
    expect(rows.map(row => [row.id, row.name])).toEqual([[WS, "(unnamed)"], [CHAT, "(unnamed chat)"]])
  })

  it("reads a running session's log time, sub-agent writes included, to tell hung from working", async () => {
    sidebar()
    const file = writeEvents(WS, [event("user.message"), event("assistant.turn_start")])
    expect((await listAppSessions(options())).find(row => row.id === WS)!.state).toBe("working")
    fs.utimesSync(file, new Date(NOW - HUNG_MS - 60_000), new Date(NOW - HUNG_MS - 60_000))
    expect((await listAppSessions(options())).find(row => row.id === WS)).toMatchObject({ state: "stuck", detail: expect.stringContaining("has not grown for 31 min") })
  })

  it("re-reads a session's history only when it changed", async () => {
    sidebar()
    writeEvents(STUCK, [event("user.message")])
    expect((await listAppSessions(options())).find(row => row.id === STUCK)!.state).toBe("stuck")
    expect((await listAppSessions(options())).find(row => row.id === STUCK)!.state).toBe("stuck")
    writeEvents(STUCK, [event("user.message"), event("assistant.message", { content: "done" }), event("assistant.turn_end"), "{\"type\":\"assistant.turn_start\""])
    expect((await listAppSessions(options())).find(row => row.id === STUCK)!.state).toBe("idle")
  })

  it("says why when the app does not list its sessions", async () => {
    app.refuse = true
    await expect(listAppSessions(options())).rejects.toThrow("ECONNREFUSED")
    app.refuse = false
    app.on("list_workspaces", (_, socket) => socket.push({ type: "socket_error" }))
    await expect(listAppSessions(options())).rejects.toThrow("did not list its sessions")
  })

  it("snapshots counts and every session's id, name and state, from the rows it is given or a fresh listing", async () => {
    sidebar()
    writeEvents(STUCK, [event("user.message")])
    const want = {
      at: iso(NOW), appRunning: true,
      counts: { working: 1, idle: 1, waiting: 0, stuck: 1 },
      sessions: [{ id: WS, name: "Fix the thing", state: "working" }, { id: STUCK, name: "Title", state: "stuck" }, { id: CHAT, name: "A chat", state: "idle" }],
    }
    const rows = await listAppSessions(options())
    expect(snapshot(options(), rows)).toEqual(want)
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

describe("restarting the app through housesitter", () => {
  const bin = path.join(os.tmpdir(), "ouro-housesitter-test", "bin", "housesitter.mjs")
  function runner(answer: { code: number; stdout: string; stderr?: string }): RunFile & { calls: string[][] } {
    const calls: string[][] = []
    const run = (async (file: string, args: string[]) => {
      calls.push([file, ...args])
      return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" }
    }) as RunFile & { calls: string[][] }
    run.calls = calls
    return run
  }
  const there = { housesitterPaths: [bin] }
  beforeAll(() => { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, "") })
  afterAll(() => { fs.rmSync(path.dirname(path.dirname(bin)), { recursive: true, force: true }) })

  it("finds housesitter from the explicit paths, HOUSESITTER_BIN, the checkout or PATH, and runs a script with node", () => {
    expect(findHousesitter(there)).toEqual({ file: process.execPath, args: [bin] })
    expect(findHousesitter({ housesitterPaths: ["", "/nonexistent/housesitter", bin] })).toEqual({ file: process.execPath, args: [bin] })
    const exe = path.join(path.dirname(bin), "housesitter")
    fs.writeFileSync(exe, "")
    expect(findHousesitter({ housesitterPaths: [exe] })).toEqual({ file: exe, args: [] })
    expect(findHousesitter({ housesitterPaths: ["/nonexistent/housesitter"] })).toBeNull()
    fs.rmSync(exe)
    const home = path.join(path.dirname(path.dirname(bin)), "home")
    const saved = { env: process.env[HOUSESITTER_ENV], path: process.env.PATH }
    try {
      process.env[HOUSESITTER_ENV] = bin
      expect(findHousesitter()).toEqual({ file: process.execPath, args: [bin] })
      delete process.env[HOUSESITTER_ENV]
      expect(findHousesitter({ homeDir: home, housesitterPaths: undefined })).toBeNull()
      fs.mkdirSync(path.join(home, "code", "housesitter", "bin"), { recursive: true })
      fs.writeFileSync(path.join(home, "code", "housesitter", "bin", "housesitter.mjs"), "")
      expect(findHousesitter({ homeDir: home })).toEqual({ file: process.execPath, args: [path.join(home, "code", "housesitter", "bin", "housesitter.mjs")] })
      fs.rmSync(path.join(home, "code"), { recursive: true })
      process.env.PATH = path.dirname(bin)
      fs.writeFileSync(exe, "")
      expect(findHousesitter({ homeDir: home })).toEqual({ file: exe, args: [] })
      fs.rmSync(exe)
      delete process.env.PATH
      expect(findHousesitter({ homeDir: home })).toBeNull()
    } finally {
      if (saved.env === undefined) delete process.env[HOUSESITTER_ENV]; else process.env[HOUSESITTER_ENV] = saved.env
      process.env.PATH = saved.path
    }
  })

  it("runs the real command when no runner is given", async () => {
    const script = path.join(path.dirname(bin), "fake-housesitter.mjs")
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ state: 'none', argv: process.argv.slice(2) }))")
    expect(await restartStatus({ housesitterPaths: [script] })).toEqual({ installed: true, status: { state: "none", argv: ["restart-copilot", "--status", "--json"] } })
    fs.rmSync(script)
  })

  it("starts a detached restart that resumes every working session, naming who asked", async () => {
    const run = runner({ code: 0, stdout: '{"ok":true,"log":"/l","plist":"/p","error":""}' })
    expect(await restartEnqueue("pick up the new build", "slugger", { ...there, runFile: run })).toEqual({ installed: true, request: { ok: true, log: "/l", plist: "/p", error: "" } })
    expect(run.calls).toEqual([[process.execPath, bin, "restart-copilot", "--resume", "--detach", "--why", "pick up the new build (asked by slugger)", "--json"]])
  })

  it("reports a job launchd would not start", async () => {
    await expect(restartEnqueue("x", "y", { ...there, runFile: runner({ code: 1, stdout: '{"ok":false,"error":"Bootstrap failed"}' }) })).rejects.toThrow("housesitter did not start the restart: Bootstrap failed")
    await expect(restartEnqueue("x", "y", { ...there, runFile: runner({ code: 1, stdout: '{"ok":false}' }) })).rejects.toThrow("no reason given")
  })

  it("reads the restart's state, step and result, including a failed run that exits 1", async () => {
    const running = '{"state":"running","step":"quit sent","started":"2026-11-14T19:49:26.576Z"}'
    const run = runner({ code: 0, stdout: running })
    expect(await restartStatus({ ...there, runFile: run })).toEqual({ installed: true, status: JSON.parse(running) })
    expect(run.calls[0].slice(2)).toEqual(["restart-copilot", "--status", "--json"])
    expect(await restartStatus({ ...there, runFile: runner({ code: 1, stdout: '{"state":"failed","step":"failed at quit"}' }) })).toEqual({ installed: true, status: { state: "failed", step: "failed at quit" } })
  })

  it("says plainly when housesitter is not on this Mac, and runs nothing", async () => {
    const run = runner({ code: 0, stdout: "{}" })
    const none = { housesitterPaths: ["/nonexistent/housesitter"], runFile: run }
    const status = await restartStatus(none)
    expect(status).toEqual({ installed: false, message: expect.stringContaining("Housesitter is not on this Mac") })
    expect(await restartEnqueue("x", "y", none)).toEqual(status)
    expect(run.calls).toHaveLength(0)
  })

  it("throws when housesitter refuses or fails", async () => {
    await expect(restartStatus({ ...there, runFile: runner({ code: 2, stdout: "", stderr: "a restart is already running\n" }) })).rejects.toThrow("housesitter failed: a restart is already running")
    await expect(restartStatus({ ...there, runFile: runner({ code: 2, stdout: "not json" }) })).rejects.toThrow("housesitter failed: not json")
    await expect(restartStatus({ ...there, runFile: runner({ code: 2, stdout: '{"code":"action-unavailable"}' }) })).rejects.toThrow("housesitter failed")
  })

  it("runs commands for real, reporting failure as a non-zero code", async () => {
    expect(await realRunFile(process.execPath, ["-e", "process.stdout.write('ok')"], 10_000)).toEqual({ code: 0, stdout: "ok", stderr: "" })
    const failed = await realRunFile(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"], 10_000)
    expect(failed).toMatchObject({ code: 1, stderr: "bad" })
    expect((await realRunFile("/nonexistent/housesitter", [], 1_000)).stderr).toContain("ENOENT")
  })
})
