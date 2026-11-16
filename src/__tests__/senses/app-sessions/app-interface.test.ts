import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type WebSocket from "ws"

import {
  answerSessionInput, archiveRow, archiveSession, createSession, deliverMessage, findSession, getSession, getSessionAutomation, getSessionsStatus, listSessionsAndChats, listWorkflows,
  navigateTo, respondToSessionPlan, runWorkflow, saveSessionAutomation, sendSessionMessage,
} from "../../../senses/app-sessions/app-interface"
import { listAppSessions } from "../../../senses/app-sessions/client"
import { addProbe, readArchiveLog, readProbes, readWatches, writePending, type PendingRequest } from "../../../senses/app-sessions/store"

type Frame = Record<string, unknown>

class FakeSocket extends EventEmitter {
  readyState = 0
  constructor(private readonly app: FakeApp) {
    super()
    setImmediate(() => {
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
  push(frame: Frame): void {
    if (this.readyState !== 3) this.emit("message", Buffer.from(JSON.stringify(frame)))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit("close")
  }
}

class FakeApp {
  requests: Frame[] = []
  handlers = new Map<string, (frame: Frame, socket: FakeSocket) => void>()
  open = (): WebSocket => new FakeSocket(this) as unknown as WebSocket
  /** Answer a request type with frames built from the request (each carries its request_id). */
  reply(type: string, build: (frame: Frame) => Frame | Frame[]): void {
    this.handlers.set(type, (frame, socket) => {
      socket.push({ type: "noise" })
      for (const out of [build(frame)].flat()) socket.push({ request_id: frame.request_id, ...out })
    })
  }
  sent(type: string): Frame[] {
    return this.requests.filter(request => request.type === type)
  }
}

const WS = "11111111-aaaa-bbbb-cccc-000000000001"
const CHAT = "22222222-aaaa-bbbb-cccc-000000000002"
const NEW = "44444444-aaaa-bbbb-cccc-000000000004"
const OLD = "2026-11-10T02:00:00.000Z"
let stateDir: string
let agentRoot: string
let app: FakeApp

const options = (extra: Record<string, unknown> = {}) => ({ stateDir, openSocket: app.open, now: () => Date.parse("2026-11-10T03:00:00Z"), ...extra })
const event = (type: string, data: Frame = {}) => ({ type, data, timestamp: OLD })

function writeEvents(id: string, events: unknown[]): void {
  const dir = path.join(stateDir, "session-state", id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map(item => JSON.stringify(item)).join("\n") + "\n")
}

function sidebar(workspaces: Frame[] = [
  { id: "w1", name: "Fix it", workspaceType: "worktree", projectName: "personal-desk", projectId: "p1", branch: "ouro-1", session: { sessionId: WS, isRunning: true } },
  { id: "w2", name: "Far", workspaceType: "worktree", hostId: "remote-host", session: { sessionId: NEW } },
], chats: Frame[] = [{ id: CHAT, title: "A chat" }]): void {
  app.reply("list_workspaces", () => ({ type: "workspace_list", workspaces }))
  app.reply("list_general_chat_sessions", () => ({ type: "general_chat_sessions_list", sessions: chats }))
}

const ask = (tool: string, id: string) => writeEvents(id, [event("tool.execution_start", { toolCallId: "t1", toolName: tool })])
const request = (over: Partial<PendingRequest>): PendingRequest => ({ kind: "input", requestId: "q1", at: OLD, ...over })

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-interface-"))
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "app-interface-agent-"))
  fs.mkdirSync(path.join(stateDir, "run"))
  fs.writeFileSync(path.join(stateDir, "run", "ws.port"), `51234\n${process.pid}\n`)
  fs.writeFileSync(path.join(stateDir, "run", "ws.token"), "tok\n")
  app = new FakeApp()
  sidebar()
})
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

describe("reading", () => {
  it("lists sessions and chats in the app's shape", async () => {
    const listed = await listSessionsAndChats(options()) as { total: number; items: Frame[] }
    expect(listed.total).toBe(3)
    expect(listed.items[0]).toMatchObject({ type: "session", id: WS, app_url: `ghapp://sessions/${WS}`, name: "Fix it", project_name: "personal-desk", branch: "ouro-1", is_running: true })
    expect(listed.items.find(row => row.id === CHAT)).toMatchObject({ type: "chat" })
    expect(listed.items.find(row => row.id === NEW)).toMatchObject({ remote: true })
  })

  it("finds a session by id or a unique start of it, and says why not", () => {
    const rows = [{ id: WS }, { id: CHAT }, { id: "11111111-zzzz" }] as never
    expect(findSession(rows, WS).id).toBe(WS)
    expect(findSession(rows, "2222").id).toBe(CHAT)
    expect(() => findSession(rows, " ")).toThrow("name a session")
    expect(() => findSession(rows, 5)).toThrow("name a session")
    expect(() => findSession(rows, "1111")).toThrow("matches 2 sessions")
    expect(() => findSession(rows, "9999")).toThrow("no session '9999'")
    const withWorkspace = [{ id: WS, workspaceId: "9fe74d72-aaaa" }, { id: CHAT, workspaceId: null }] as never
    expect(findSession(withWorkspace, "9fe74d72-aaaa").id).toBe(WS)
    expect(findSession(withWorkspace, "9fe7").id).toBe(WS)
  })

  it("counts states and shows what a blocked session waits on, filtered by state", async () => {
    sidebar([
      { id: "w1", name: "Asker", workspaceType: "branch", session: { sessionId: WS } },
      { id: "w2", name: "Planner", workspaceType: "branch", session: { sessionId: NEW } },
      { id: "w3", name: "Gate", workspaceType: "branch", session: { sessionId: "55555555-aaaa" } },
    ], [{ id: CHAT, title: "Busy", isRunning: true }])
    ask("ask_user", WS)
    ask("exit_plan_mode", NEW)
    writeEvents("55555555-aaaa", [event("permission.requested", { requestId: "p1", permissionRequest: { kind: "write" } })])
    writePending(agentRoot, { [WS]: request({ question: "Which?", choices: ["a"], allowFreeform: true }), [NEW]: request({ kind: "plan", requestId: "pl", summary: "Do it", actions: ["autopilot"] }) })
    const all = await getSessionsStatus(agentRoot, undefined, options()) as { summary: Frame; sessions: Frame[] }
    expect(all.summary).toMatchObject({ total: 4, blocked: 3, awaiting_user_input: 1, awaiting_plan_approval: 1 })
    const byId = Object.fromEntries(all.sessions.map(row => [row.id, row]))
    expect(byId[WS]).toMatchObject({ awaiting_user_input: true, awaiting_input: { kind: "user_input", request_id: "q1", question: "Which?", choices: ["a"], allow_freeform: true } })
    expect(byId[NEW]).toMatchObject({ awaiting_plan_approval: true, awaiting_input: { kind: "plan", request_id: "pl", summary: "Do it", actions: ["autopilot"] } })
    expect(byId["55555555-aaaa"]).toMatchObject({ awaiting_permission: true, awaiting_input: { kind: "permission", request_id: "p1", what: "change a file" } })
    expect(byId[CHAT]).toMatchObject({ activity: { status: "busy" } })
    expect(((await getSessionsStatus(agentRoot, "busy", options())) as { sessions: Frame[] }).sessions.map(row => row.id)).toEqual([CHAT])
    expect(((await getSessionsStatus(agentRoot, "waiting", options())) as { sessions: Frame[] }).sessions).toHaveLength(3)
  })

  it("says a question asked while it was not connected cannot be answered, and a mismatched request does not count", async () => {
    ask("ask_user", WS)
    expect(await getSession(agentRoot, WS, options())).toMatchObject({ awaiting_input: { kind: "user_input", request_id: null, note: expect.stringContaining("not connected") } })
    writePending(agentRoot, { [WS]: request({ kind: "plan" }) })
    expect(await getSession(agentRoot, "1111", options())).toMatchObject({ awaiting_input: { request_id: null } })
    expect(await getSession(agentRoot, CHAT, options())).not.toHaveProperty("awaiting_input")
    writeEvents(WS, [event("permission.requested", { requestId: "p1" })])
    expect(await getSession(agentRoot, WS, options())).toMatchObject({ awaiting_input: { kind: "permission", request_id: "p1" } })
  })
})

describe("sending", () => {
  const accept = (type = "session_message_sent") => app.reply("send_message", () => ({ type, message_id: "m1" }))

  it("sends immediately or queued, and watches the reply once by default", async () => {
    accept()
    expect(await sendSessionMessage(agentRoot, { session_id: "1111", message: "hi" }, options())).toMatchObject({ ok: true, status: "accepted", session_id: WS, message_id: "m1", watching: true })
    expect(app.sent("send_message")[0]).toMatchObject({ session_id: WS, prompt: "hi", delivery_mode: "immediate" })
    expect(readWatches(agentRoot)[WS]).toMatchObject({ once: true })
    accept("session_message_queued")
    expect(await sendSessionMessage(agentRoot, { session_id: WS, message: "later", delivery_mode: "enqueue", notify_on_idle: "always" }, options())).toMatchObject({ status: "queued" })
    expect(app.sent("send_message")[1]).toMatchObject({ delivery_mode: "enqueue" })
    expect(readWatches(agentRoot)[WS]).not.toHaveProperty("once")
    fs.rmSync(path.join(agentRoot, "state"), { recursive: true, force: true })
    expect(await sendSessionMessage(agentRoot, { session_id: WS, message: "quiet", notify_on_idle: "never" }, options())).toMatchObject({ watching: false })
    expect(readWatches(agentRoot)).toEqual({})
  })

  it("refuses an empty message, and reports a refusal or a silent app", async () => {
    await expect(sendSessionMessage(agentRoot, { session_id: WS, message: " " }, options())).rejects.toThrow("say what to send")
    await expect(sendSessionMessage(agentRoot, { session_id: WS, message: 4 }, options())).rejects.toThrow("say what to send")
    app.reply("send_message", () => ({ type: "command_result", error: "archived" }))
    expect(await sendSessionMessage(agentRoot, { session_id: WS, message: "hi" }, options())).toMatchObject({ ok: false, status: "failed", watching: false })
    app.reply("send_message", () => ({ type: "other", message: "nope" }))
    expect(await deliverMessage(WS, "hi", "immediate", options())).toMatchObject({ ok: false, error: "nope" })
    app.reply("send_message", () => ({ type: "socket_error" }))
    expect((await deliverMessage(WS, "hi", "immediate", options())).error).toBe("socket_error")
    app.handlers.delete("send_message")
    expect(await deliverMessage(WS, "hi", "immediate", options({ sendWaitMs: 50 }))).toMatchObject({ ok: false, error: "the app did not answer in time" })
  })

  it("does not call a message lost when the app began delivering it, and fails when delivery is unknown", async () => {
    app.reply("send_message", () => ({ type: "session_dispatch_state", dispatch_may_have_started: true }))
    expect((await deliverMessage(WS, "hi", "immediate", options({ sendWaitMs: 50 }))).error).toContain("began delivering")
    app.reply("send_message", () => ({ type: "session_dispatch_state", dispatch_may_have_started: false }))
    expect((await deliverMessage(WS, "hi", "immediate", options({ sendWaitMs: 50 }))).error).toBe("the app did not answer in time")
    app.handlers.set("send_message", (_frame, socket) => socket.push({ type: "session_message_delivery_unknown", session_id: WS, reason: "reset" }))
    expect(await deliverMessage(WS, "hi", "immediate", options())).toMatchObject({ ok: false, error: "reset" })
    app.handlers.set("send_message", (_frame, socket) => { socket.push({ type: "session_resume_failed", session_id: CHAT }); socket.push({ type: "session_message_sent" }) })
    expect((await deliverMessage(WS, "hi", "immediate", options({ sendWaitMs: 50 }))).ok).toBe(false)
  })
})

describe("creating", () => {
  function accepting(): void {
    sidebar(undefined, [{ id: CHAT, title: "A chat" }, { id: NEW, title: "New" }])
    app.reply("create_session", () => ({ type: "session_created", session_id: NEW, workspace_id: "w9" }))
    app.reply("send_message", () => ({ type: "session_message_sent" }))
    app.reply("rename_session", () => ({ type: "session_title_updated", session_id: NEW }))
    app.reply("set_session_mode", () => ({ type: "session_mode_result", session_id: NEW }))
    app.reply("list_projects", () => ({ type: "project_list", projects: [{ id: "p1", name: "personal-desk" }, { id: "p2" }] }))
  }

  it("makes a chat, names it, sets its mode and sends the first message", async () => {
    accepting()
    const made = await createSession(agentRoot, { name: "Probe", kickoff: { prompt: "go", mode: "plan", model: "m", agent: "a" } }, options())
    expect(made).toMatchObject({ ok: true, created: true, session_id: NEW, kind: "chat", watching: true, coordination: expect.stringContaining("outside client") })
    expect(app.sent("create_session")[0]).toMatchObject({ session_type: "general_chat", model: "m", agent: "a" })
    expect(app.sent("rename_session")[0]).toMatchObject({ title: "Probe" })
    expect(app.sent("set_session_mode")[0]).toMatchObject({ mode: "plan" })
    expect(readProbes(agentRoot)[NEW]).toBeDefined()
  })

  it("makes a chat without a name, mode or message, and reports a failed or unnamed create", async () => {
    accepting()
    expect(await createSession(agentRoot, { kickoff: { mode: "interactive" } }, options())).toMatchObject({ ok: true, session_id: NEW })
    expect(app.sent("rename_session")).toHaveLength(0)
    expect(app.sent("set_session_mode")).toHaveLength(0)
    app.reply("create_session", () => ({ type: "command_result", error: "no" }))
    expect(await createSession(agentRoot, {}, options())).toMatchObject({ ok: false, created: false, error: "no" })
    app.reply("create_session", () => ({ type: "session_created" }))
    expect(await createSession(agentRoot, {}, options())).toMatchObject({ ok: false, error: "the app did not name the session it made" })
  })

  it("reports a first message the app did not accept", async () => {
    accepting()
    app.reply("send_message", () => ({ type: "command_result", error: "busy" }))
    expect(await createSession(agentRoot, { kickoff: { prompt: "go" } }, options())).toMatchObject({ ok: false, created: true, error: expect.stringContaining("busy") })
  })

  it("ignores frames that answer other requests while it waits", async () => {
    accepting()
    app.handlers.set("create_session", (frame, socket) => { socket.push({ type: "session_created", request_id: "someone-else" }); socket.push({ type: "session_created", request_id: frame.request_id, session_id: NEW }) })
    app.handlers.set("create_worktree_workspace", (frame, socket) => { socket.push({ type: "session_creation_failed" }); socket.push({ type: "unrelated", request_id: "x" }); socket.push({ type: "workspace_created", request_id: frame.request_id, workspace: { id: "w9", displayPath: "/w9" } }) })
    expect(await createSession(agentRoot, {}, options())).toMatchObject({ ok: true })
    expect(await createSession(agentRoot, { project_id: "p1" }, options())).toMatchObject({ created: false })
  })

  it("makes a project session in a worktree or on the checkout, finding the project by id or name", async () => {
    accepting()
    app.reply("create_worktree_workspace", () => [{ type: "workspace_changed" }, { type: "workspace_created", workspace: { id: "w9", displayPath: "/w9" } }])
    app.reply("create_branch_workspace", () => ({ type: "workspace_created", workspace: { id: "w9", displayPath: "/w9" } }))
    const made = await createSession(agentRoot, { project_id: "personal-desk", name: "N", branch_name: "b1", kickoff: { permission_mode: "manual", model: "m", agent: "desk:worker", reasoning_effort: "high" } }, options())
    expect(made).toMatchObject({ ok: true, kind: "session", workspace_id: "w9" })
    expect(app.sent("create_session").at(-1)).toMatchObject({ workspace_id: "w9", cwd: "/w9" })
    expect(app.sent("create_worktree_workspace")[0]).toMatchObject({ project_id: "p1", branch_name: "b1", name: "N", kickoff_permission_mode: "manual", kickoff_model: "m", kickoff_agent: "desk:worker", kickoff_reasoning_effort: "high" })
    await createSession(agentRoot, { project_id: "p2", session_kind: "project", workspace_type: "branch" }, options())
    expect(app.sent("create_branch_workspace")[0]).toMatchObject({ project_id: "p2", kickoff_permission_mode: "allow-all" })
    await createSession(agentRoot, { project_id: "p1" }, options())
    expect(String(app.sent("create_worktree_workspace")[1]!.branch_name)).toMatch(/^ouro-/)
  })

  it("refuses a project session without a project, an unknown project, and a refused workspace", async () => {
    accepting()
    await expect(createSession(agentRoot, { session_kind: "project" }, options())).rejects.toThrow("needs project_id")
    await expect(createSession(agentRoot, { project_id: "nope" }, options())).rejects.toThrow("no project 'nope' in the Copilot app (it has: personal-desk, ?)")
    app.reply("list_projects", () => ({ type: "project_list" }))
    await expect(createSession(agentRoot, { project_id: "nope" }, options())).rejects.toThrow("no project 'nope' in the Copilot app")
    app.reply("list_projects", () => ({ type: "project_list", projects: [{ id: "p1", name: "x" }] }))
    app.handlers.set("create_worktree_workspace", (_frame, socket) => socket.push({ type: "session_creation_failed", message: "disk full" }))
    expect(await createSession(agentRoot, { project_id: "p1" }, options())).toMatchObject({ ok: false, created: false, error: "disk full" })
    app.reply("create_worktree_workspace", () => ({ type: "workspace_created" }))
    expect(await createSession(agentRoot, { project_id: "p1" }, options())).toMatchObject({ ok: false, created: false, error: "the app did not name the session it made" })
    app.reply("create_worktree_workspace", () => ({ type: "workspace_created", workspace: { id: "w9", displayPath: "/w9" } }))
    app.reply("create_session", () => ({ type: "command_result", error: "no session" }))
    expect(await createSession(agentRoot, { project_id: "p1" }, options())).toMatchObject({ ok: false, created: false, error: "no session" })
    app.reply("create_worktree_workspace", () => ({ type: "workspace_created", workspace: { id: "w9" } }))
    expect(await createSession(agentRoot, { project_id: "p1" }, options())).toMatchObject({ ok: false, created: false })
    app.handlers.set("create_worktree_workspace", (_frame, socket) => socket.push({ type: "unrelated" }))
    app.reply("create_worktree_workspace", () => ({ type: "command_result", error: "refused" }))
    expect(await createSession(agentRoot, { project_id: "p1" }, options())).toMatchObject({ ok: false, error: "refused" })
  })
})

describe("answering", () => {
  it("answers a question with a choice or free text, under the id of the request the sense heard", async () => {
    ask("ask_user", WS)
    writePending(agentRoot, { [WS]: request({ choices: ["yes", "no"] }) })
    app.reply("respond_to_user_input", () => ({ type: "user_input_resolved", request_id: "q1" }))
    expect(await answerSessionInput(agentRoot, { session_id: WS, answer: "yes" }, options())).toEqual({ ok: true, session_id: WS })
    expect(app.sent("respond_to_user_input")[0]).toMatchObject({ request_id: "q1", answer: "yes", was_freeform: false })
    expect(await answerSessionInput(agentRoot, { session_id: WS, answer: "maybe" }, options())).toMatchObject({ ok: true })
    expect(app.sent("respond_to_user_input")[1]).toMatchObject({ was_freeform: true })
    writePending(agentRoot, { [WS]: request({}) })
    await answerSessionInput(agentRoot, { session_id: WS, answer: "x" }, options())
    expect(app.sent("respond_to_user_input")[2]).toMatchObject({ was_freeform: true })
    app.handlers.set("respond_to_user_input", (_frame, socket) => socket.push({ type: "error", message: "gone" }))
    expect(await answerSessionInput(agentRoot, { session_id: WS, answer: "x" }, options())).toMatchObject({ ok: false, error: "gone" })
  })

  it("refuses an empty answer and a session that waits on nothing it heard", async () => {
    await expect(answerSessionInput(agentRoot, { session_id: WS, answer: "" }, options())).rejects.toThrow("give the answer")
    await expect(answerSessionInput(agentRoot, { session_id: WS, answer: 3 }, options())).rejects.toThrow("give the answer")
    await expect(answerSessionInput(agentRoot, { session_id: WS, answer: "x" }, options())).rejects.toThrow("not waiting on a question")
    ask("ask_user", WS)
    await expect(answerSessionInput(agentRoot, { session_id: WS, answer: "x" }, options())).rejects.toThrow("not waiting on a question")
  })

  it("approves or rejects a plan, then tells the session its feedback", async () => {
    ask("exit_plan_mode", WS)
    writePending(agentRoot, { [WS]: request({ kind: "plan", requestId: "pl" }) })
    app.handlers.set("respond_to_exit_plan_mode", (_frame, socket) => { socket.push({ type: "exit_plan_mode_response_failed", request_id: "other" }); socket.push({ type: "exit_plan_mode_request", request_id: "pl" }); socket.push({ type: "exit_plan_mode_resolved", request_id: "pl" }) })
    app.reply("send_message", () => ({ type: "session_message_sent" }))
    expect(await respondToSessionPlan(agentRoot, { session_id: WS, approved: "true", selected_action: "autopilot", feedback: "go on" }, options())).toEqual({ ok: true, approved: true, session_id: WS, feedback_sent: true })
    expect(app.sent("respond_to_exit_plan_mode")[0]).toMatchObject({ approved: true, selected_action: "autopilot" })
    expect(app.sent("send_message")[0]).toMatchObject({ prompt: "go on" })
    expect(readWatches(agentRoot)).toEqual({})
    app.handlers.set("respond_to_exit_plan_mode", (_frame, socket) => socket.push({ type: "exit_plan_mode_response_failed", request_id: "pl", message: "stale" }))
    expect(await respondToSessionPlan(agentRoot, { session_id: WS, approved: false, feedback: "no" }, options())).toMatchObject({ ok: false, approved: false, error: "stale" })
    expect(app.sent("send_message")).toHaveLength(1)
    expect(app.sent("respond_to_exit_plan_mode")[1]).not.toHaveProperty("selected_action")
  })

  it("refuses a plan answer when no plan was heard", async () => {
    await expect(respondToSessionPlan(agentRoot, { session_id: WS, approved: true }, options())).rejects.toThrow("not waiting on a plan")
    ask("exit_plan_mode", WS)
    writePending(agentRoot, { [WS]: request({}) })
    await expect(respondToSessionPlan(agentRoot, { session_id: WS, approved: true }, options())).rejects.toThrow("not waiting on a plan")
  })
})

describe("archiving a session this agent did not create", () => {
  const flag = (): void => {
    const dir = path.join(agentRoot, "state", "senses", "app-sessions")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "oversize.json"), JSON.stringify({ sessions: { [WS]: { bytes: 1, name: "Fix it" } } }))
  }
  const successor = (text: string): void => {
    const dir = path.join(stateDir, "session-state", "99999999-0000-4000-8000-000000000009")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ type: "user.message", data: { content: text } })}\n`)
  }

  it("archives for the size watch keeping the worktree, and logs its note", async () => {
    const row = (await listAppSessions(options())).find(item => item.id === WS)!
    app.reply("archive_workspace", () => ({ type: "workspace_archived" }))
    expect(await archiveRow(agentRoot, row, "oversize-idle", options(), { note: "1.0 GB; branch b", keepWorktree: true })).toEqual({ ok: true, session_id: WS })
    expect(app.sent("archive_workspace")[0]).toMatchObject({ workspace_id: "w1", delete_worktree: false })
    expect(readArchiveLog(agentRoot)).toMatchObject([{ id: WS, reason: "oversize-idle", note: "1.0 GB; branch b" }])
  })

  it("archives and logs it when the owner asked for that session", async () => {
    app.reply("archive_workspace", () => ({ type: "workspace_archived" }))
    expect(await archiveSession(agentRoot, WS, options({ now: undefined }), true)).toEqual({ ok: true, session_id: WS })
    expect(readArchiveLog(agentRoot)).toMatchObject([{ id: WS, name: "Fix it", reason: "owner-asked" }])
  })

  it("archives an oversize session that a newer session names as handed off, and nothing else", async () => {
    successor(`Succeeds: ${WS}\n\nCarry on as the retired coordinator.`)
    await expect(archiveSession(agentRoot, WS, options())).rejects.toThrow("will not archive it unless")
    flag()
    app.reply("archive_workspace", () => ({ type: "workspace_archived" }))
    expect(await archiveSession(agentRoot, WS, options())).toEqual({ ok: true, session_id: WS })
    expect(readArchiveLog(agentRoot)).toMatchObject([{ id: WS, reason: "handed-off" }])
  })

  it("accepts a successor that names the session by its short id", async () => {
    flag()
    fs.mkdirSync(path.join(stateDir, "session-state", WS), { recursive: true })
    successor(`You are the successor of ${WS.slice(0, 8)}, which handed off.`)
    app.reply("archive_workspace", () => ({ type: "workspace_archived" }))
    expect(await archiveSession(agentRoot, WS, options())).toEqual({ ok: true, session_id: WS })
  })

  it("skips successors that are stale or unreadable, and a missing state directory", async () => {
    flag()
    const stale = path.join(stateDir, "session-state", "88888888-stale")
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, "events.jsonl"), `{"text":"successor of ${WS}"}\n`)
    fs.utimesSync(path.join(stale, "events.jsonl"), 1, 1)
    const self = path.join(stateDir, "session-state", WS)
    fs.mkdirSync(self, { recursive: true })
    fs.writeFileSync(path.join(self, "events.jsonl"), `{"text":"successor of ${WS}"}\n`)
    fs.mkdirSync(path.join(stateDir, "session-state", "77777777-broken", "events.jsonl"), { recursive: true })
    await expect(archiveSession(agentRoot, WS, options())).rejects.toThrow("will not archive it unless")
    fs.rmSync(path.join(stateDir, "session-state"), { recursive: true })
    await expect(archiveSession(agentRoot, WS, options())).rejects.toThrow("will not archive it unless")
  })

  it("refuses an oversize session that no newer session names, or that one only mentions", async () => {
    flag()
    await expect(archiveSession(agentRoot, WS, options())).rejects.toThrow("will not archive it unless")
    successor(`Unrelated work on ${WS}.`)
    await expect(archiveSession(agentRoot, WS, options())).rejects.toThrow("will not archive it unless")
    expect(readArchiveLog(agentRoot)).toEqual([])
  })
})

describe("archiving and showing", () => {
  it("archives only what this agent created: a workspace with its worktree, or a chat", async () => {
    await expect(archiveSession(agentRoot, WS, options())).rejects.toThrow("was not created by this agent, so it will not archive it unless")
    addProbe(agentRoot, WS, null, 1)
    addProbe(agentRoot, CHAT, null, 1)
    await expect(archiveSession(agentRoot, "9999", options())).rejects.toThrow("no session")
    app.reply("archive_workspace", () => ({ type: "workspace_archived" }))
    expect(await archiveSession(agentRoot, WS, options())).toEqual({ ok: true, session_id: WS })
    expect(app.sent("archive_workspace")[0]).toMatchObject({ workspace_id: "w1", delete_worktree: true })
    expect(readProbes(agentRoot)[WS]).toBeUndefined()
    app.handlers.set("archive_session", (_frame, socket) => socket.push({ type: "general_chat_sessions_changed" }))
    expect(await archiveSession(agentRoot, CHAT, options())).toMatchObject({ ok: true })
    expect(readProbes(agentRoot)).toEqual({})
    addProbe(agentRoot, CHAT, null, 1)
    app.handlers.set("archive_session", (frame, socket) => { socket.push({ type: "noise" }); socket.push({ type: "command_result", request_id: frame.request_id, error: "busy" }) })
    expect(await archiveSession(agentRoot, CHAT, options())).toMatchObject({ ok: false, error: "busy" })
    expect(readProbes(agentRoot)[CHAT]).toBeDefined()
    addProbe(agentRoot, WS, null, 1)
    app.handlers.set("archive_workspace", (frame, socket) => socket.push({ type: "command_result", request_id: frame.request_id, error: "dirty" }))
    expect(await archiveSession(agentRoot, WS, options())).toMatchObject({ ok: false, error: "dirty" })
    expect(readProbes(agentRoot)[WS]).toBeDefined()
  })

  it("shows a session in the app's window", async () => {
    app.reply("handle_deep_link", () => ({ type: "deep_link_received" }))
    expect(await navigateTo(WS, options())).toEqual({ ok: true, session_id: WS, app_url: `ghapp://sessions/${WS}` })
    expect(app.sent("handle_deep_link")[0]).toMatchObject({ url: `ghapp://sessions/${WS}` })
  })
})

describe("automations and workflows", () => {
  it("saves a session's automation with only the fields given", async () => {
    app.reply("save_session_automation", () => ({ type: "session_automation_mutation_result", automation: { id: "a1" } }))
    expect(await saveSessionAutomation({ session_id: WS, prompt: "wake", interval: "daily", schedule_hour: 9, bogus: 1 }, options())).toEqual({ ok: true, session_id: WS, automation: { id: "a1" } })
    expect(app.sent("save_session_automation")[0]).toMatchObject({ prompt: "wake", interval: "daily", schedule_hour: 9 })
    expect(app.sent("save_session_automation")[0]).not.toHaveProperty("bogus")
    app.reply("save_session_automation", () => ({ type: "session_automation_mutation_result", error: "bad cron" }))
    expect(await saveSessionAutomation({ session_id: WS, interval: "cron" }, options())).toMatchObject({ ok: false, error: "bad cron" })
  })

  it("clears the automation a session has, or says it has none", async () => {
    app.reply("list_owned_session_automations", () => ({ type: "owned_session_automations_result", automations: [{ id: "a1" }, { id: "a2" }] }))
    app.reply("cancel_session_automation", () => ({ type: "session_automation_mutation_result" }))
    expect(await saveSessionAutomation({ session_id: WS, clear: true }, options())).toEqual({ ok: true, session_id: WS, cleared: true })
    expect(app.sent("cancel_session_automation")[0]).toMatchObject({ automation_id: "a1" })
    app.reply("list_owned_session_automations", () => ({ type: "owned_session_automations_result", automations: [] }))
    expect(await saveSessionAutomation({ session_id: WS, clear: true }, options())).toEqual({ ok: false, error: "that session has no automation to clear" })
    app.reply("list_owned_session_automations", () => ({ type: "owned_session_automations_result" }))
    expect(await saveSessionAutomation({ session_id: WS, clear: true }, options())).toMatchObject({ ok: false })
    app.reply("list_owned_session_automations", () => ({ type: "socket_error", message: "down" }))
    expect(await saveSessionAutomation({ session_id: WS, clear: true }, options())).toEqual({ ok: false, error: "down" })
  })

  it("reads a session's automations", async () => {
    app.reply("list_owned_session_automations", () => ({ type: "owned_session_automations_result", automations: [{ id: "a1" }], legacy_schedules: [] }))
    expect(await getSessionAutomation(WS, options())).toEqual({ ok: true, session_id: WS, automations: [{ id: "a1" }], schedules: [] })
  })

  it("lists and runs the app's workflows", async () => {
    app.reply("list_workflows", () => ({ type: "workflow_list", tasks: [{ id: "t1" }] }))
    expect(await listWorkflows(options())).toEqual({ ok: true, workflows: [{ id: "t1" }] })
    app.reply("run_workflow_now", () => ({ type: "workflow_run_started", run: { id: "r1" } }))
    expect(await runWorkflow("t1", options())).toEqual({ ok: true, run: { id: "r1" } })
    app.reply("run_workflow_now", () => ({ type: "workflow_run_rejected", reason: "disabled" }))
    expect(await runWorkflow("t1", options())).toMatchObject({ ok: false, error: "disabled" })
    await expect(runWorkflow(null, options())).rejects.toThrow("name the workflow")
  })
})
