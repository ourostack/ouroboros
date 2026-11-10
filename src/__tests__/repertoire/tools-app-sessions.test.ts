import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const client = vi.hoisted(() => ({
  listAppSessions: vi.fn(),
  snapshot: vi.fn(),
  tailAppSession: vi.fn(),
  eventLogSize: vi.fn(),
  sendToAppSession: vi.fn(),
  resumeAppSession: vi.fn(),
  openAppChat: vi.fn(),
  archiveAppSession: vi.fn(),
  restartStatus: vi.fn(),
  restartEnqueue: vi.fn(),
}))
vi.mock("../../senses/app-sessions/client", () => client)

import {
  appSessionsArchiveTool, appSessionsListTool, appSessionsNewTool, appSessionsRestartTool, appSessionsResumeTool, appSessionsSendTool,
  appSessionsTailTool, appSessionsToolDefinitions, appSessionsToolsEnabled, appSessionsWatchTool,
} from "../../repertoire/tools-app-sessions"
import { addProbe, readProbes, readWatches, watchSession } from "../../senses/app-sessions/store"
import type { ToolContext, ToolDefinition, ToolRiskProfileResolver } from "../../repertoire/tools-base"

const A = "11111111-aaaa-bbbb-cccc-000000000001"
const B = "11112222-aaaa-bbbb-cccc-000000000002"
const C = "33333333-aaaa-bbbb-cccc-000000000003"
let agentRoot: string
let ctx: ToolContext

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, kind: "workspace", workspaceId: "w", workspaceType: "branch", project: "desk", state: "idle", detail: "its turn ended",
  isRunning: false, wasInterrupted: false, remote: false, updatedAt: null, lastActivity: "t", ...extra,
})

async function call(tool: ToolDefinition, args: Record<string, unknown>, context: ToolContext | undefined = ctx): Promise<Record<string, unknown>> {
  return JSON.parse(await tool.handler(args as Record<string, string>, context)) as Record<string, unknown>
}

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "app-sessions-tools-"))
  ctx = { agentName: "slugger", agentRoot } as unknown as ToolContext
  for (const fn of Object.values(client)) fn.mockReset()
  client.listAppSessions.mockReturnValue([row(A, "Babysitter", { state: "stuck" }), row(B, "Other", { remote: true }), row(C, "Third")])
  client.snapshot.mockReturnValue({ at: "t", appRunning: true, counts: { working: 0, idle: 2, waiting: 0, stuck: 1 }, sessions: [] })
  client.eventLogSize.mockReturnValue(42)
})

afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

describe("app-sessions tools", () => {
  it("exist only for an agent that enabled the sense", () => {
    expect(appSessionsToolDefinitions.map(tool => tool.tool.function.name)).toEqual([
      "app_sessions_list", "app_sessions_tail", "app_sessions_send", "app_sessions_resume", "app_sessions_new", "app_sessions_archive", "app_sessions_restart", "app_sessions_watch",
    ])
    expect(appSessionsToolsEnabled(undefined)).toBe(false)
    expect(appSessionsToolsEnabled(agentRoot)).toBe(false)
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ senses: { "app-sessions": { enabled: true } } }))
    expect(appSessionsToolsEnabled(agentRoot)).toBe(true)
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ senses: {} }))
    expect(appSessionsToolsEnabled(agentRoot)).toBe(false)
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({}))
    expect(appSessionsToolsEnabled(agentRoot)).toBe(false)
  })

  it("join the tool selection only when the sense is on", async () => {
    const { selectToolsForChannel } = await import("../../repertoire/tools")
    const names = () => selectToolsForChannel(undefined, undefined, undefined, undefined, undefined, undefined, { agentName: "slugger", agentRoot })
      .ordinary.map((definition) => definition.tool.function.name).filter((name) => name.startsWith("app_sessions_"))
    expect(names()).toEqual([])
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ senses: { "app-sessions": { enabled: true } } }))
    expect(names()).toEqual(appSessionsToolDefinitions.map(definition => definition.tool.function.name))
  })

  it("need an agent runtime, and report failures as errors", async () => {
    expect(await call(appSessionsListTool, {}, null as unknown as ToolContext)).toEqual({ error: "the app-sessions tools need an agent runtime" })
    client.listAppSessions.mockImplementationOnce(() => { throw new Error("no GitHub Copilot app database") })
    expect(await call(appSessionsListTool, {})).toEqual({ error: "no GitHub Copilot app database" })
  })

  it("lists sessions with counts, optionally by state", async () => {
    const all = await call(appSessionsListTool, {})
    expect(all).toMatchObject({ appRunning: true, counts: { stuck: 1 } })
    expect(all.sessions).toEqual([
      { id: A, name: "Babysitter", state: "stuck", why: "its turn ended", kind: "workspace", project: "desk", lastActivity: "t" },
      expect.objectContaining({ id: B, remote: true }),
      expect.objectContaining({ id: C }),
    ])
    expect((await call(appSessionsListTool, { state: "stuck" })).sessions).toHaveLength(1)
  })

  it("resolves a session by id or unique prefix", async () => {
    client.tailAppSession.mockReturnValue([])
    expect(await call(appSessionsTailTool, { session: A })).toMatchObject({ session: A, name: "Babysitter" })
    expect(await call(appSessionsTailTool, { session: "3333" })).toMatchObject({ session: C })
    expect(await call(appSessionsTailTool, { session: "1111" })).toEqual({ error: "'1111' matches 2 sessions; give more of the id" })
    expect(await call(appSessionsTailTool, { session: "9999" })).toEqual({ error: expect.stringContaining("no session '9999'") })
    expect(await call(appSessionsTailTool, {})).toEqual({ error: expect.stringContaining("name a session") })
    expect(await call(appSessionsTailTool, { session: 5 })).toEqual({ error: expect.stringContaining("name a session") })
  })

  it("tails a bounded number of messages", async () => {
    client.tailAppSession.mockReturnValue([{ at: "t", role: "assistant", text: "hi" }])
    expect(await call(appSessionsTailTool, { session: A })).toEqual({ session: A, name: "Babysitter", messages: [{ at: "t", role: "assistant", text: "hi" }] })
    await call(appSessionsTailTool, { session: A, count: 500 })
    await call(appSessionsTailTool, { session: A, count: "3" })
    await call(appSessionsTailTool, { session: A, count: -1 })
    expect(client.tailAppSession.mock.calls.map(args => args[1])).toEqual([6, 50, 3, 1])
  })

  it("sends a message and watches for the reply", async () => {
    client.sendToAppSession.mockResolvedValue({ ok: true, reply: "session_message_sent", messageId: "m", error: null })
    expect(await call(appSessionsSendTool, { session: "1111-", message: "x" })).toEqual({ error: expect.stringContaining("no session") })
    expect(await call(appSessionsSendTool, { session: A, message: "  " })).toEqual({ error: "say what to send" })
    expect(await call(appSessionsSendTool, { session: A, message: 7 })).toEqual({ error: "say what to send" })
    expect(await call(appSessionsSendTool, { session: A, message: "hello" })).toEqual({ session: A, name: "Babysitter", ok: true, reply: "session_message_sent", messageId: "m", error: null, watching: true })
    expect(client.sendToAppSession).toHaveBeenLastCalledWith(A, "hello", { delivery: "immediate" })
    expect(readWatches(agentRoot)[A]).toMatchObject({ name: "Babysitter", offset: 42 })
    expect(await call(appSessionsSendTool, { session: C, message: "later", delivery: "enqueue", watch: false })).toMatchObject({ watching: false })
    expect(client.sendToAppSession).toHaveBeenLastCalledWith(C, "later", { delivery: "enqueue" })
    expect(await call(appSessionsSendTool, { session: C, message: "again", watch: "false" })).toMatchObject({ watching: false })
    expect(await call(appSessionsSendTool, { session: C, message: "again", watch: "true" })).toMatchObject({ watching: true })
    client.sendToAppSession.mockResolvedValue({ ok: false, reply: "error", messageId: null, error: "nope" })
    expect(await call(appSessionsSendTool, { session: B, message: "x", watch: "maybe" })).toMatchObject({ ok: false, watching: false })
    expect(Object.keys(readWatches(agentRoot)).sort()).toEqual([A, C])
  })

  it("resumes a session with an optional note, watching it when the nudge landed", async () => {
    client.resumeAppSession.mockResolvedValue({ ok: true, reply: "session_message_sent", messageId: null, error: null, stoppedWhile: "working" })
    expect(await call(appSessionsResumeTool, { session: A, note: " check CI " })).toMatchObject({ session: A, ok: true, watching: true })
    expect(client.resumeAppSession).toHaveBeenLastCalledWith(A, "check CI", {})
    client.resumeAppSession.mockResolvedValue({ ok: false, reply: "error", messageId: null, error: "x", stoppedWhile: "working" })
    expect(await call(appSessionsResumeTool, { session: B })).toMatchObject({ watching: false })
    expect(client.resumeAppSession).toHaveBeenLastCalledWith(B, undefined, {})
  })

  it("opens a chat it may later archive, watching it when it has a first message", async () => {
    client.openAppChat.mockResolvedValue({ ok: true, sessionId: C, sent: null, error: null })
    expect(await call(appSessionsNewTool, { name: " Probe ", prompt: "Reply OK", cwd: "/x", agent: "desk:worker", model: "m" })).toEqual({ ok: true, sessionId: C, sent: null, error: null, watching: true })
    expect(client.openAppChat).toHaveBeenLastCalledWith({ name: "Probe", prompt: "Reply OK", cwd: "/x", agent: "desk:worker", model: "m" }, {})
    expect(readProbes(agentRoot)[C].name).toBe("Probe")
    expect(readWatches(agentRoot)[C].offset).toBe(0)
    client.openAppChat.mockResolvedValue({ ok: true, sessionId: B, sent: null, error: null })
    expect(await call(appSessionsNewTool, { prompt: " " })).toMatchObject({ watching: false })
    expect(client.openAppChat).toHaveBeenLastCalledWith({}, {})
    expect(readProbes(agentRoot)[B].name).toBeNull()
    expect(await call(appSessionsNewTool, { prompt: "go" })).toMatchObject({ watching: true })
    expect(readWatches(agentRoot)[B].name).toBeNull()
    client.openAppChat.mockResolvedValue({ ok: false, sessionId: null, sent: null, error: "refused" })
    expect(await call(appSessionsNewTool, {})).toEqual({ ok: false, sessionId: null, sent: null, error: "refused" })
  })

  it("archives only sessions it opened", async () => {
    addProbe(agentRoot, C, "Probe", 0)
    watchSession(agentRoot, C, "Probe", 0, Date.now())
    client.archiveAppSession.mockResolvedValueOnce({ ok: false, reply: "error", error: "busy" }).mockResolvedValueOnce({ ok: true, reply: "archived", error: null })
    expect(await call(appSessionsArchiveTool, { session: A })).toEqual({ error: `'${A}' is not one session you opened with app_sessions_new (yours: ${C})` })
    expect(await call(appSessionsArchiveTool, { session: "3333" })).toEqual({ session: C, name: "Probe", ok: false, reply: "error", error: "busy" })
    expect(readProbes(agentRoot)[C]).toBeDefined()
    expect(await call(appSessionsArchiveTool, { session: C })).toEqual({ session: C, name: "Probe", ok: true, reply: "archived", error: null })
    expect(readProbes(agentRoot)).toEqual({})
    expect(readWatches(agentRoot)).toEqual({})
    expect(await call(appSessionsArchiveTool, {})).toEqual({ error: "'' is not one session you opened with app_sessions_new (yours: none)" })
    expect(client.archiveAppSession).toHaveBeenCalledTimes(2)
  })

  it("reads restart status and queues a courtesy restart through the keeper", async () => {
    client.restartStatus.mockResolvedValue({ installed: false, message: "The Copilot app keeper is not installed" })
    client.restartEnqueue.mockResolvedValue({ installed: true, request: { ok: true, id: "1" } })
    expect(await call(appSessionsRestartTool, {})).toEqual({ installed: false, message: "The Copilot app keeper is not installed" })
    expect(await call(appSessionsRestartTool, { action: "enqueue" })).toEqual({ error: expect.stringContaining("say why") })
    expect(await call(appSessionsRestartTool, { action: "enqueue", why: "new build" })).toEqual({ installed: true, request: { ok: true, id: "1" } })
    expect(client.restartEnqueue).toHaveBeenLastCalledWith("new build", "slugger", {})
    await call(appSessionsRestartTool, { action: "enqueue", why: "again" }, { agentRoot } as unknown as ToolContext)
    expect(client.restartEnqueue).toHaveBeenLastCalledWith("again", "an agent", {})
    const risk = appSessionsRestartTool.riskProfile as ToolRiskProfileResolver
    expect(risk({ action: "enqueue" })).toMatchObject({ risk: "high" })
    expect(risk({})).toEqual({ mutates: "none", risk: "low" })
  })

  it("starts and stops watching a session", async () => {
    expect(await call(appSessionsWatchTool, { session: A })).toEqual({ session: A, name: "Babysitter", watching: true })
    expect(readWatches(agentRoot)[A].offset).toBe(42)
    expect(await call(appSessionsWatchTool, { session: A, watch: false })).toEqual({ session: A, watching: false, wasWatching: true })
    expect(await call(appSessionsWatchTool, { session: A, watch: false })).toEqual({ session: A, watching: false, wasWatching: false })
  })
})
