import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type WebSocket from "ws"

import {
  COPILOT_APP_HOST, copilotAppFrontmost, copilotAppRequest, copilotAppUrl, createCopilotAppHost, readConversation,
} from "../../../senses/shepherd/copilot-app"
import type { ReturnedControl, ShepherdHostObservation } from "../../../senses/shepherd/host"

type Frame = Record<string, unknown>

/** A stand-in for one WebSocket to the app: `reply` is the app's side. */
class FakeSocket extends EventEmitter {
  readyState = 0
  sent: Frame[] = []
  constructor(readonly url: string, private readonly app: FakeApp) {
    super()
    setImmediate(() => {
      if (this.readyState !== 0) return
      if (app.refuse) {
        this.readyState = 3
        this.emit("error", new Error("ECONNREFUSED"))
        this.emit("close")
        return
      }
      this.readyState = 1
      this.emit("open")
      this.push({ type: "server_hello", instance_id: "i", connection_id: "c" })
    })
  }
  send(line: string): void {
    const frame = JSON.parse(line) as Frame
    this.sent.push(frame)
    this.app.requests.push(frame)
    this.app.handle(frame, this)
  }
  push(frame: Frame | string): void {
    this.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit("close")
  }
}

class FakeApp {
  sockets: FakeSocket[] = []
  requests: Frame[] = []
  refuse = false
  workspaces: unknown = []
  handlers = new Map<string, (frame: Frame, socket: FakeSocket) => void>()
  open = (url: string): WebSocket => {
    const socket = new FakeSocket(url, this)
    this.sockets.push(socket)
    return socket as unknown as WebSocket
  }
  constructor() {
    this.on("list_workspaces", (frame, socket) => socket.push({ type: "workspace_list", request_id: frame.request_id, persisted_only: true, workspaces: this.workspaces }))
  }
  on(type: string, handler: (frame: Frame, socket: FakeSocket) => void): void {
    this.handlers.set(type, handler)
  }
  handle(frame: Frame, socket: FakeSocket): void {
    this.handlers.get(frame.type as string)?.(frame, socket)
  }
  /** The newest watch connection. */
  get stream(): FakeSocket {
    return this.sockets.at(-1)!
  }
  broadcast(frame: Frame): void {
    this.stream.push(frame)
  }
}

interface Task { fn: () => void; ms: number; cancelled: boolean }
function manualScheduler() {
  const tasks: Task[] = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const task = { fn, ms, cancelled: false }
      tasks.push(task)
      return () => { task.cancelled = true }
    },
    due: (ms: number) => tasks.filter((task) => !task.cancelled && task.ms === ms).length,
    run: async (ms: number) => {
      for (const task of tasks.filter((entry) => !entry.cancelled && entry.ms === ms)) {
        task.cancelled = true
        task.fn()
      }
      await tick()
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const GRACE_MS = 3_000
const SESSION = "11111111-aaaa-bbbb-cccc-000000000001"
const OTHER = "22222222-aaaa-bbbb-cccc-000000000002"

let stateDir: string
let app: FakeApp
let scheduler: ReturnType<typeof manualScheduler>
let front: boolean
let clock: number

function workspace(id: string, session: Frame | null, extra: Frame = {}): Frame {
  return { id: `w-${id}`, projectName: "personal-desk", name: "branch-name", displayPath: "/Users/me/desk", ...extra, ...(session ? { session: { sessionId: id, title: "Fix the thing", isRunning: true, ...session } } : {}) }
}

function writeEvents(sessionId: string, events: unknown[]): void {
  const dir = path.join(stateDir, "session-state", sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map(event => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + "\n")
}

const host = () => createCopilotAppHost({ stateDir }, { schedule: scheduler.schedule, now: () => clock, appFrontmost: async () => front, openSocket: app.open })

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-app-"))
  fs.mkdirSync(path.join(stateDir, "run"))
  fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "51234\n4321\n")
  fs.writeFileSync(path.join(stateDir, "run", "ws.token"), "tok en\n")
  app = new FakeApp()
  app.workspaces = [workspace(SESSION, {}), workspace(OTHER, { isRunning: false, title: "" }, { projectName: null, name: "Other" })]
  scheduler = manualScheduler()
  front = true
  clock = 1_000_000
})

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe("Copilot app connection", () => {
  it("reads the current port and token, as an observer", () => {
    expect(copilotAppUrl(stateDir)).toBe("ws://127.0.0.1:51234?token=tok%20en&observer=1")
  })

  it("says the app is not running when its server files are missing, and refuses unreadable ones", () => {
    expect(() => copilotAppUrl(path.join(stateDir, "nope"))).toThrow("the GitHub Copilot app is not running")
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "abc\n")
    expect(() => copilotAppUrl(stateDir)).toThrow("unreadable")
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "1\n")
    fs.writeFileSync(path.join(stateDir, "run", "ws.token"), "\n")
    expect(() => copilotAppUrl(stateDir)).toThrow("unreadable")
  })

  it("knows whether the app is frontmost, and holds back when it cannot tell", async () => {
    const run = (answers: Array<[Error | null, string]>) => (_file: string, _args: string[], done: (error: Error | null, stdout: string) => void) => done(...answers.shift()!)
    expect(await copilotAppFrontmost(run([[null, "ASN:0x0-0x1\n"], [null, "\"GitHub Copilot\" ASN:0x0-0x1"]]))).toBe(true)
    expect(await copilotAppFrontmost(run([[null, "ASN:0x0-0x1\n"], [null, "\"Finder\" ASN:0x0-0x1"]]))).toBe(false)
    expect(await copilotAppFrontmost(run([[new Error("no"), ""]]))).toBe(true)
    expect(await copilotAppFrontmost(run([[null, "  "]]))).toBe(true)
    expect(await copilotAppFrontmost(run([[null, "ASN"], [new Error("no"), ""]]))).toBe(true)
  })

  it("uses real sockets, timers and the frontmost check by default", async () => {
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "1\n")
    await expect(createCopilotAppHost({ stateDir }).list()).rejects.toThrow("Copilot app list_workspaces")
    const watcher = createCopilotAppHost({ stateDir: path.join(stateDir, "nope") }).watch({ returned: vi.fn(), focused: vi.fn() })
    watcher.close()
  })

  it("runs lsappinfo by default", async () => {
    expect(typeof await copilotAppFrontmost()).toBe("boolean")
  })

  it("settles a request on the first matching frame, ignoring other frames", async () => {
    app.on("ping", (_frame, socket) => {
      socket.push("not json")
      socket.push("[1]")
      socket.push({ type: "other" })
      socket.push({ type: "pong", value: 7 })
    })
    await expect(copilotAppRequest(stateDir, { type: "ping" }, (frame) => frame.type === "pong" ? frame.value : undefined, { openSocket: app.open })).resolves.toBe(7)
    expect(app.sockets[0]!.readyState).toBe(3)
  })

  it("rejects when the match throws, on timeout, on close, and without server files", async () => {
    app.on("ping", (_frame, socket) => socket.push({ type: "bad" }))
    await expect(copilotAppRequest(stateDir, { type: "ping" }, () => { throw new Error("refused") }, { openSocket: app.open })).rejects.toThrow("refused")
    await expect(copilotAppRequest(stateDir, { type: "silent" }, () => undefined, { openSocket: app.open, timeoutMs: 20 })).rejects.toThrow("Copilot app silent timed out")
    app.on("drop", (_frame, socket) => socket.close())
    await expect(copilotAppRequest(stateDir, { type: "drop" }, () => undefined, { openSocket: app.open })).rejects.toThrow("Copilot app drop: connection closed")
    app.refuse = true
    await expect(copilotAppRequest(stateDir, { type: "ping" }, () => undefined, { openSocket: app.open })).rejects.toThrow("Copilot app ping: ECONNREFUSED")
    await expect(copilotAppRequest(path.join(stateDir, "nope"), { type: "ping" }, () => undefined)).rejects.toThrow("not running")
  })

  it("uses a real WebSocket by default", async () => {
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "1\n")
    await expect(copilotAppRequest(stateDir, { type: "ping" }, () => undefined, { timeoutMs: 2_000 })).rejects.toThrow("Copilot app ping")
  })
})

describe("Copilot app conversation", () => {
  it("renders the recent conversation and the permission still waiting", () => {
    writeEvents(SESSION, [
      "not json", "3",
      { type: "user.message", data: { content: "Fix the build" } },
      { type: "user.message", data: { content: "" } },
      { type: "assistant.message", data: { content: "" } },
      { type: "assistant.message", data: { content: "Looking.\nTwo lines." } },
      { type: "tool.execution_start", data: { toolName: "bash", arguments: { description: "Run   tests", command: "npm test" } } },
      { type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "ls" } } },
      { type: "tool.execution_start", data: { toolName: "ask_user", arguments: { question: "Which one?" } } },
      { type: "tool.execution_start", data: { toolName: "view", arguments: { path: "/a" } } },
      { type: "tool.execution_start", data: { toolName: "apply_patch" } },
      { type: "tool.execution_start", data: {} },
      { type: "session.task_complete", data: { summary: "Done." } },
      { type: "session.task_complete", data: {} },
      { type: "session.error", data: { message: "quota" } },
      { type: "session.error", data: { errorType: "network" } },
      { type: "session.error" },
      { type: "permission.requested", data: { requestId: "p1", permissionRequest: { intention: "Run the deploy" } } },
      { type: "permission.requested", data: { requestId: "p2", permissionRequest: { fullCommandText: "rm x" } } },
      { type: "permission.requested", data: { requestId: "p3", permissionRequest: { kind: "write" } } },
      { type: "permission.requested", data: { requestId: "p4" } },
      { type: "permission.requested", data: { requestId: "p5", resolvedByHook: true } },
      { type: "permission.requested", data: {} },
      { type: "permission.completed", data: { requestId: "p2" } },
      { type: "permission.completed", data: { requestId: "p3" } },
      { type: "permission.completed", data: { requestId: "p4" } },
      { type: "permission.completed", data: {} },
    ])
    expect(readConversation(stateDir, SESSION)).toEqual({
      lines: [
        "› Fix the build", "Looking.", "Two lines.", "• bash: Run tests", "• bash: ls", "• ask_user: Which one?", "• view: /a", "• apply_patch", "• tool",
        "Task complete: Done.", "Error: quota", "Error: network", "Error: unknown", "Waiting for permission: Run the deploy",
      ],
      pendingPermission: "p1",
    })
  })

  it("reads only the end of a long log, dropping the partial first line", () => {
    const filler = { type: "assistant.message", data: { content: "x".repeat(1_000) } }
    writeEvents(SESSION, [...Array.from({ length: 600 }, () => filler), { type: "user.message", data: { content: "last" } }])
    const { lines } = readConversation(stateDir, SESSION)
    expect(lines.at(-1)).toBe("› last")
    expect(lines.length).toBeLessThan(600)
  })

  it("refuses a session id that could leave the state directory", () => {
    expect(() => readConversation(stateDir, "../etc")).toThrow("invalid Copilot app session id")
  })
})

describe("Copilot app host: sessions and input", () => {
  it("lists workspace sessions; only running ones have an agent", async () => {
    app.workspaces = [...app.workspaces as unknown[], workspace("archived", {}, { archivedAt: "2026" }), workspace("none", null), { id: "w-bad", session: { sessionId: "" } }, { id: "w-untitled", session: { sessionId: "33333333" } }, "junk"]
    const sessions = await host().list()
    expect(host().name).toBe(COPILOT_APP_HOST)
    expect(sessions).toEqual([
      { id: SESSION, ref: "11111111", workspace: `w-${SESSION}`, workspaceTitle: "personal-desk", title: "Fix the thing", cwd: "/Users/me/desk", agent: "copilot", focused: false },
      { id: OTHER, ref: "22222222", workspace: `w-${OTHER}`, workspaceTitle: "Other", title: "Other", cwd: "/Users/me/desk", agent: null, focused: false },
      { id: "33333333", ref: "33333333", workspace: "w-untitled", workspaceTitle: null, title: "", cwd: null, agent: null, focused: false },
    ])
    app.workspaces = "bad"
    expect(await host().list()).toEqual([])
  })

  it("gives a strict inventory for retirement", async () => {
    expect(await host().retirementInventory!()).toEqual([SESSION, OTHER])
    app.workspaces = [workspace(SESSION, {}), workspace(SESSION, {})]
    await expect(host().retirementInventory!()).rejects.toThrow("invalid Copilot app session inventory identity")
    app.workspaces = null
    await expect(host().retirementInventory!()).rejects.toThrow("invalid Copilot app session inventory")
  })

  it("reads the conversation tail", async () => {
    writeEvents(SESSION, [{ type: "user.message", data: { content: "a" } }, { type: "assistant.message", data: { content: "b\nc" } }])
    expect(await host().read(SESSION, 2)).toBe("b\nc")
    expect(await host().read(SESSION, 0)).toBe("c")
  })

  it("queues a message and waits for the app to accept it", async () => {
    app.on("send_message", (frame, socket) => {
      socket.push({ type: "session_message_sent", request_id: "someone-else" })
      socket.push({ type: "workspace_activity_updated", request_id: frame.request_id })
      socket.push({ type: "session_message_sent", session_id: frame.session_id, request_id: frame.request_id })
    })
    await host().prompt(SESSION, "[Ouro for Ari] keep going")
    expect(app.requests.at(-1)).toMatchObject({ type: "send_message", session_id: SESSION, prompt: "[Ouro for Ari] keep going", delivery_mode: "enqueue" })
  })

  it("reports a refused or unconfirmed message", async () => {
    const reply = (frame: Frame) => app.on("send_message", (request, socket) => socket.push({ ...frame, request_id: request.request_id }))
    reply({ type: "error", message: "no such session" })
    await expect(host().prompt(SESSION, "x")).rejects.toThrow("Copilot app refused the message: no such session")
    reply({ type: "session_resume_failed", reason: "checkout_missing" })
    await expect(host().prompt(SESSION, "x")).rejects.toThrow("refused the message: checkout_missing")
    reply({ type: "error" })
    await expect(host().prompt(SESSION, "x")).rejects.toThrow("refused the message: error")
    reply({ type: "session_message_delivery_unknown", detail: "socket lost" })
    await expect(host().prompt(SESSION, "x")).rejects.toThrow("could not confirm delivery: socket lost")
    reply({ type: "session_message_delivery_unknown" })
    await expect(host().prompt(SESSION, "x")).rejects.toThrow("could not confirm delivery: unknown")
  })

  it("stops a turn for ctrl-c and escape", async () => {
    app.on("abort_session", (frame, socket) => {
      socket.push({ type: "error", request_id: "someone-else" })
      socket.push({ type: "session_event", session_id: frame.session_id, event: { type: "assistant.turn_start" } })
      socket.push({ type: "session_event", session_id: OTHER, event: { type: "abort" } })
      socket.push({ type: "session_event", session_id: frame.session_id, event: "x" })
      socket.push({ type: "session_event", session_id: frame.session_id, event: { type: "abort", data: { reason: "user" } } })
    })
    await host().key(SESSION, "ctrl-c")
    await host().key(SESSION, "escape")
    expect(app.requests.filter(frame => frame.type === "abort_session")).toHaveLength(2)
    app.on("abort_session", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id, message: "not running" }))
    await expect(host().key(SESSION, "ctrl-c")).rejects.toThrow("refused to stop the session: not running")
    app.on("abort_session", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id }))
    await expect(host().key(SESSION, "ctrl-c")).rejects.toThrow("refused to stop the session: error")
  })

  it("answers the waiting permission for y, 1, 2, n and 3", async () => {
    writeEvents(SESSION, [{ type: "permission.requested", data: { requestId: "p9", permissionRequest: { intention: "Deploy" } } }])
    app.on("respond_to_permission", (frame, socket) => {
      socket.push({ type: "error", request_id: "x", session_id: OTHER })
      socket.push({ type: "session_event", session_id: SESSION, event: { type: "permission.completed", data: { requestId: "other" } } })
      socket.push({ type: "session_event", session_id: SESSION, event: { type: "permission.completed" } })
      socket.push({ type: "other" })
      socket.push({ type: "session_event", session_id: SESSION, event: { type: "permission.completed", data: { requestId: frame.request_id } } })
    })
    for (const key of ["y", "1", "2", "n", "3"] as const) await host().key(SESSION, key)
    expect(app.requests.filter(frame => frame.type === "respond_to_permission").map(frame => frame.result)).toEqual(["approve-once", "approve-once", "approve-for-session", "reject", "reject"])
    app.on("respond_to_permission", (frame, socket) => socket.push({ type: "error", request_id: frame.request_id, message: "stale" }))
    await expect(host().key(SESSION, "y")).rejects.toThrow("refused the answer: stale")
    app.on("respond_to_permission", (_frame, socket) => socket.push({ type: "error", session_id: SESSION }))
    await expect(host().key(SESSION, "y")).rejects.toThrow("refused the answer: error")
  })

  it("refuses keys it cannot honestly press", async () => {
    await expect(host().key(SESSION, "tab")).rejects.toThrow("the Copilot app has no 'tab' key")
    writeEvents(SESSION, [{ type: "assistant.message", data: { content: "hi" } }])
    await expect(host().key(SESSION, "y")).rejects.toThrow("not waiting for a permission; nothing was sent")
    expect(app.requests.some(frame => frame.type === "respond_to_permission")).toBe(false)
  })

  it("keeps status to itself: the app has no status line", async () => {
    await expect(host().signal(SESSION, "answered")).resolves.toBeUndefined()
    await expect(host().signal(SESSION, null)).resolves.toBeUndefined()
  })
})

describe("Copilot app host: watching for returns", () => {
  async function watching(options: { observed?: boolean } = {}) {
    const returned = vi.fn<(event: ReturnedControl) => void>()
    const focused = vi.fn<(id: string) => void>()
    const observed = vi.fn<(observation: ShepherdHostObservation) => void>()
    const h = host()
    const watcher = h.watch({ returned, focused, ...(options.observed === false ? {} : { observed }) })
    await tick()
    return { h, watcher, returned, focused, observed }
  }
  const event = (sessionId: string, type: string, data: Frame = {}, extra: Frame = {}) =>
    app.broadcast({ type: "session_event", session_id: sessionId, event: { type, id: `e-${type}`, data }, ...extra })

  it("reports a session that went idle and stayed idle through the grace period", async () => {
    const { watcher, returned, observed } = await watching()
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ activity: "unknown" }), expect.objectContaining({ activity: "idle" })] }))
    event(SESSION, "assistant.turn_start")
    event(SESSION, "assistant.message", { content: "All done here." })
    event(SESSION, "assistant.message", { content: "" })
    event(SESSION, "assistant.turn_end")
    event(SESSION, "session.idle", {})
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(1)
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenCalledWith({
      sessionId: SESSION, transitionId: `copilot-app:${SESSION}:e-session.idle`, agent: "copilot", cwd: "/Users/me/desk",
      workspaceTitle: "personal-desk", title: "Fix the thing", lastBody: "All done here.", backgroundWork: false,
    })
    watcher.close()
  })

  it("cancels the stop when work resumes, and ignores bookkeeping, deltas and turn ends", async () => {
    const { watcher, returned } = await watching()
    event(SESSION, "permission.completed", { requestId: "never-asked" })
    event(SESSION, "session.idle", { backgroundTasks: { agents: [], shells: [] } })
    event(SESSION, "session.usage_record")
    event(SESSION, "assistant.message_delta")
    event(SESSION, "assistant.turn_end")
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(1)
    event(SESSION, "assistant.turn_start")
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(0)
    event(SESSION, "session.idle", { backgroundTasks: { agents: [{ id: "a" }] } })
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenCalledTimes(1)
    expect(returned.mock.calls[0]![0]).toMatchObject({ backgroundWork: true, lastBody: null })
    watcher.close()
  })

  it("leaves an aborted turn to the human", async () => {
    const { watcher, returned, focused } = await watching()
    event(SESSION, "session.idle", { aborted: true })
    await tick()
    expect(focused).toHaveBeenCalledWith(SESSION)
    expect(scheduler.due(GRACE_MS)).toBe(0)
    expect(returned).not.toHaveBeenCalled()
    watcher.close()
  })

  it("reports a permission waiting on the human until it is answered", async () => {
    const { watcher, returned } = await watching()
    event(SESSION, "permission.requested", { requestId: "p1" })
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({ transitionId: `copilot-app:${SESSION}:p1`, backgroundWork: null }))
    event(SESSION, "permission.requested", { requestId: "p2" })
    // Other events while a permission waits do not count as work.
    event(SESSION, "hook.start")
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(1)
    event(SESSION, "permission.completed", { requestId: "p2" })
    event(SESSION, "permission.completed", {})
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(0)
    event(SESSION, "permission.requested", { requestId: "p3", resolvedByHook: true })
    event(SESSION, "permission.requested", {})
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(0)
    watcher.close()
  })

  it("reports question, plan and elicitation requests, and their resolution", async () => {
    const { watcher, returned } = await watching()
    app.broadcast({ type: "user_input_request", session_id: SESSION, request_id: "q1" })
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({ transitionId: `copilot-app:${SESSION}:q1` }))
    app.broadcast({ type: "exit_plan_mode_request", session_id: SESSION })
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({ transitionId: `copilot-app:${SESSION}:exit_plan_mode_request@${clock}` }))
    app.broadcast({ type: "exit_plan_mode_resolved", session_id: SESSION })
    app.broadcast({ type: "user_input_resolved", session_id: SESSION, request_id: "q1" })
    // Both cleared, so new work counts again and the next idle is a fresh stop.
    event(SESSION, "assistant.turn_start")
    event(SESSION, "session.idle")
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(1)
    watcher.close()
  })

  it("reports a terminal error but not one the app retries on another model", async () => {
    const { watcher, returned } = await watching()
    event(SESSION, "session.error", { eligibleForAutoSwitch: true })
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(0)
    event(SESSION, "session.error", { message: "quota exceeded" })
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({ lastBody: "Error: quota exceeded" }))
    event(SESSION, "session.error", { errorType: "network" })
    await tick()
    await scheduler.run(GRACE_MS)
    event(SESSION, "session.error")
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned.mock.calls.map(call => call[0].lastBody)).toEqual(["Error: quota exceeded", "Error: network", "Error: unknown"])
    event(SESSION, "session.task_complete", { summary: "Shipped." })
    event(SESSION, "session.task_complete", {})
    event(SESSION, "session.idle")
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({ lastBody: "Shipped." }))
    watcher.close()
  })

  it("judges only top-level running sessions, and nothing after close", async () => {
    const { watcher, returned } = await watching()
    event("sub-agent", "session.idle")
    event(OTHER, "session.idle")
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).not.toHaveBeenCalled()
    event(SESSION, "session.idle")
    await tick()
    const fire = scheduler.due(GRACE_MS)
    watcher.close()
    expect(fire).toBe(1)
    expect(scheduler.due(GRACE_MS)).toBe(0)
    expect(returned).not.toHaveBeenCalled()
  })

  it("reports a bare session with no path or titles", async () => {
    app.workspaces = [{ id: "w", session: { sessionId: SESSION, isRunning: true } }]
    const { watcher, returned } = await watching()
    event(SESSION, "session.idle")
    await tick()
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveBeenCalledWith(expect.objectContaining({ cwd: null, workspaceTitle: null, title: "" }))
    watcher.close()
  })

  it("skips frames that are history, malformed, or not about a session", async () => {
    const { watcher } = await watching()
    app.broadcast({ type: "session_event", session_id: SESSION, history_request_id: "h", event: { type: "session.idle" } })
    app.broadcast({ type: "session_event", session_id: SESSION, event: "x" })
    app.broadcast({ type: "session_event", event: { type: "session.idle" } })
    app.broadcast({ type: "session_title_updated", session_id: SESSION, title: "x" })
    app.broadcast({ type: "session_event", session_id: SESSION, event: { data: "x" } })
    app.broadcast({ session_id: SESSION })
    await tick()
    expect(scheduler.due(GRACE_MS)).toBe(0)
    watcher.close()
  })

  it("holds back from a session someone else just messaged while the app is in front", async () => {
    const { h, watcher, focused, observed } = await watching()
    event(SESSION, "user.message", { content: "[Slugger for Ari] keep going" })
    await tick()
    expect(focused).not.toHaveBeenCalled()
    front = false
    event(SESSION, "user.message", { content: "from a coordinator" })
    await tick()
    expect(focused).not.toHaveBeenCalled()
    front = true
    event(SESSION, "user.message", {})
    await tick()
    expect(focused).toHaveBeenCalledWith(SESSION)
    expect((await h.list()).find(s => s.id === SESSION)!.focused).toBe(true)
    await scheduler.run(10_000)
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ session: expect.objectContaining({ id: SESSION, focused: true }), activity: "working" })]) }))
    front = false
    expect((await h.list()).find(s => s.id === SESSION)!.focused).toBe(false)
    front = true
    clock += 5 * 60_000
    expect((await h.list()).find(s => s.id === SESSION)!.focused).toBe(false)
    watcher.close()
  })

  it("logs a failed event handler instead of crashing", async () => {
    const failing = createCopilotAppHost({ stateDir }, { schedule: scheduler.schedule, appFrontmost: async () => { throw new Error("boom") }, openSocket: app.open })
    const watcher = failing.watch({ returned: vi.fn(), focused: vi.fn() })
    await tick()
    event(SESSION, "user.message", { content: "hi" })
    await tick()
    watcher.close()
  })

  it("refreshes the inventory, drops sessions that left, and works without an observer", async () => {
    const { watcher, observed } = await watching()
    event(SESSION, "assistant.turn_start")
    await tick()
    app.workspaces = [workspace(OTHER, {})]
    await scheduler.run(10_000)
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ activity: "unknown" })] }))
    watcher.close()
    const quiet = await watching({ observed: false })
    quiet.watcher.close()
    await scheduler.run(10_000)
  })

  it("reconnects with backoff when the app closes or is not running, reading the new address", async () => {
    const { watcher, observed } = await watching()
    const first = app.stream
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "60000\n1\n")
    first.close()
    await tick()
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ error: "host_unavailable" }))
    expect(scheduler.due(1_000)).toBe(1)
    await scheduler.run(1_000)
    expect(app.stream).not.toBe(first)
    expect(app.stream.url).toContain(":60000?")
    fs.rmSync(path.join(stateDir, "run"), { recursive: true })
    app.stream.close()
    await tick()
    await scheduler.run(1_000)
    expect(scheduler.due(2_000)).toBe(1)
    for (const delay of [2_000, 5_000, 10_000, 30_000]) await scheduler.run(delay)
    expect(scheduler.due(30_000)).toBe(1)
    watcher.close()
    await scheduler.run(30_000)
    expect(scheduler.due(30_000)).toBe(0)
  })

  it("stops reconnecting once closed, even mid-connect", async () => {
    const { watcher } = await watching({ observed: false })
    const stream = app.stream
    watcher.close()
    stream.push({ type: "session_event", session_id: SESSION, event: { type: "session.idle" } })
    stream.emit("close")
    await tick()
    expect(scheduler.due(1_000)).toBe(0)
  })
})
