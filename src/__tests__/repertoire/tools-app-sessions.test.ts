import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const digest = vi.hoisted(() => ({ readDigestText: vi.fn() }))
vi.mock("../../senses/app-sessions/digest", () => digest)
const client = vi.hoisted(() => ({ eventLogSize: vi.fn(() => 42), restartStatus: vi.fn(), restartEnqueue: vi.fn() }))
vi.mock("../../senses/app-sessions/client", () => client)

import * as tools from "../../repertoire/tools-app-sessions"
import { readArchiveLog, readWatches, watchSession } from "../../senses/app-sessions/store"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"

const FAKE = fileURLToPath(new URL("../senses/app-sessions/fake-shepherd.mjs", import.meta.url))
const SAVED = { SHEPHERD_BIN: process.env.SHEPHERD_BIN, PATH: process.env.PATH, HOME: process.env.HOME }

let root: string
let agentRoot: string
/** Where the fake shepherd in use lives: its reply.json and calls.jsonl sit beside it. */
let shepherdDir: string
let ctx: ToolContext

/** A fake Shepherd installed in `where`, returned as its folder. */
function install(where: string): string {
  fs.mkdirSync(where, { recursive: true })
  fs.copyFileSync(FAKE, path.join(where, "shepherd.mjs"))
  return where
}
const replies = (map: Record<string, unknown>): void => fs.writeFileSync(path.join(shepherdDir, "reply.json"), JSON.stringify(map))
const calls = (): Array<{ argv: string[]; input?: unknown }> => {
  const file = path.join(shepherdDir, "calls.jsonl")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").map(line => JSON.parse(line)) : []
}
const call = async (tool: ToolDefinition, args: Record<string, unknown> = {}, context: ToolContext | null = ctx) =>
  JSON.parse(await tool.handler(args as Record<string, string>, context ?? undefined)) as Record<string, unknown>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tools-app-"))
  agentRoot = path.join(root, "agent")
  fs.mkdirSync(agentRoot)
  shepherdDir = install(path.join(root, "bin"))
  process.env.SHEPHERD_BIN = path.join(shepherdDir, "shepherd.mjs")
  ctx = { agentRoot, agentName: "ouroboros" } as ToolContext
  vi.clearAllMocks()
  client.eventLogSize.mockReturnValue(42)
})
afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe("the tool set", () => {
  it("carries the app's own tool names, then the two this agent adds", () => {
    expect(tools.appSessionsToolDefinitions.map(tool => tool.tool.function.name)).toEqual([
      "list_sessions_and_chats", "get_sessions_status", "get_session", "send_session_message", "create_session", "answer_session_input", "respond_to_session_plan_v2",
      "archive_session", "navigate_to", "save_session_automation", "get_session_automation", "list_workflows", "run_workflow", "app_sessions_tail", "app_sessions_restart", "app_sessions_digest",
    ])
  })

  it("is on only when agent.json enables the sense", () => {
    expect(tools.appSessionsToolsEnabled(undefined)).toBe(false)
    expect(tools.appSessionsToolsEnabled(agentRoot)).toBe(false)
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ senses: { "app-sessions": { enabled: true } } }))
    expect(tools.appSessionsToolsEnabled(agentRoot)).toBe(true)
  })

  it("joins the tool selection only when the sense is on", async () => {
    const { selectToolsForChannel } = await import("../../repertoire/tools")
    const names = () => selectToolsForChannel(undefined, undefined, undefined, undefined, undefined, undefined, { agentName: "ouroboros", agentRoot })
      .ordinary.map((definition) => definition.tool.function.name).filter((name) => name === "app_sessions_tail")
    expect(names()).toEqual([])
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ senses: { "app-sessions": { enabled: true } } }))
    expect(names()).toEqual(["app_sessions_tail"])
  })

  it("needs an agent runtime, and reports a failed verb as an error with its code", async () => {
    expect(await call(tools.listWorkflowsTool, {}, null)).toEqual({ error: "the app-sessions tools need an agent runtime" })
    replies({ workflows: { code: 1, body: { ok: false, code: "app-down", error: "the app is not running. Fix: open it." } } })
    expect(await call(tools.listWorkflowsTool)).toEqual({ error: "the app is not running. Fix: open it.", code: "app-down" })
  })
})

describe("each tool runs its Shepherd verb", () => {
  it("lists sessions without their status fields", async () => {
    replies({ sessions: { body: { summary: { total: 1 }, sessions: [{ id: "s1", name: "Now", app_url: "ghapp://sessions/s1", activity: { status: "idle" } }] } } })
    expect(await call(tools.listSessionsAndChatsTool)).toEqual({ total: 1, items: [{ id: "s1", name: "Now", app_url: "ghapp://sessions/s1" }] })
    expect(calls()).toEqual([{ argv: ["sessions", "--json"] }])
  })

  it("passes a state filter to sessions, and a session id to session", async () => {
    replies({ sessions: { body: { summary: {}, sessions: [] } }, session: { body: { id: "s1", activity: { status: "busy" } } } })
    expect(await call(tools.getSessionsStatusTool, { state: "busy" })).toEqual({ summary: {}, sessions: [] })
    expect(await call(tools.getSessionsStatusTool)).toEqual({ summary: {}, sessions: [] })
    expect(await call(tools.getSessionTool, { session_id: "s1" })).toEqual({ id: "s1", activity: { status: "busy" } })
    expect(calls()).toEqual([{ argv: ["sessions", "--state", "busy", "--json"] }, { argv: ["sessions", "--json"] }, { argv: ["session", "s1", "--json"] }])
  })

  it("sends a message with its delivery mode, and watches the reply unless told never", async () => {
    replies({ session: { body: { id: "s1", name: "Now" } }, send: { body: { ok: true, status: "accepted", session_id: "s1" } } })
    expect(await call(tools.sendSessionMessageTool, { session_id: "s1", message: "hi", delivery_mode: "enqueue" })).toEqual({ ok: true, status: "accepted", session_id: "s1", watching: true })
    expect(calls()).toEqual([
      { argv: ["session", "s1", "--json"] },
      { argv: ["send", "s1", "--json", "--input", "-"], input: { message: "hi", delivery_mode: "enqueue" } },
    ])
    expect(readWatches(agentRoot).s1).toMatchObject({ name: "Now", offset: 42, once: true })
    expect(await call(tools.sendSessionMessageTool, { session_id: "s1", message: "again", notify_on_idle: "never" })).toMatchObject({ watching: false })
    expect(await call(tools.sendSessionMessageTool, { session_id: "s1", message: "always", notify_on_idle: "always" })).toMatchObject({ watching: true })
    expect(readWatches(agentRoot).s1).not.toHaveProperty("once")
  })

  it("creates a session with its kickoff, and watches the first reply from the start of its log only when prompted", async () => {
    replies({ create: { body: { ok: true, created: true, session_id: "n1", app_url: "ghapp://sessions/n1", kind: "session" } } })
    expect(await call(tools.createSessionTool, { name: "New", project_id: "proj", kickoff: { prompt: "go" }, notify_on_idle: "always" })).toMatchObject({ session_id: "n1", watching: true })
    expect(calls()).toEqual([{ argv: ["create", "--json", "--input", "-"], input: { name: "New", project_id: "proj", kickoff: { prompt: "go" } } }])
    expect(readWatches(agentRoot).n1).toMatchObject({ name: "New", offset: 0 })
    replies({ create: { body: { ok: true, created: true, session_id: "n3" } } })
    expect(await call(tools.createSessionTool, { project_id: "proj", kickoff: { prompt: "go" } })).toMatchObject({ watching: true })
    expect(readWatches(agentRoot).n3).toMatchObject({ name: null, offset: 0 })
    expect(await call(tools.createSessionTool, { name: "Quiet", session_kind: "chat" })).not.toHaveProperty("watching")
    expect(readWatches(agentRoot)).not.toHaveProperty("n2")
  })

  it("answers a question, and responds to a plan, through their verbs", async () => {
    replies({ answer: { body: { ok: true, session_id: "s1" } }, plan: { body: { ok: true, approved: true, session_id: "s1" } } })
    expect(await call(tools.answerSessionInputTool, { session_id: "s1", answer: "yes" })).toEqual({ ok: true, session_id: "s1" })
    expect(await call(tools.respondToSessionPlanTool, { session_id: "s1", approved: true, selected_action: "go", feedback: "f" })).toMatchObject({ approved: true })
    expect(calls()).toEqual([
      { argv: ["answer", "s1", "--json", "--input", "-"], input: { answer: "yes" } },
      { argv: ["plan", "s1", "--json", "--input", "-"], input: { approved: true, selected_action: "go", feedback: "f" } },
    ])
  })

  it("archives a session, and logs an archive the owner asked for", async () => {
    replies({ session: { body: { id: "s1", name: "Now" } }, archive: { body: { ok: true, session_id: "s1" } } })
    expect(await call(tools.archiveSessionTool, { session_id: "s1" })).toEqual({ ok: true, session_id: "s1" })
    expect(calls().at(-1)).toEqual({ argv: ["archive", "s1", "--json"] })
    expect(readArchiveLog(agentRoot)).toEqual([])
    expect(await call(tools.archiveSessionTool, { session_id: "s1", owner_asked: true })).toEqual({ ok: true, session_id: "s1" })
    expect(calls().at(-1)).toEqual({ argv: ["archive", "s1", "--json", "--input", "-"], input: { owner_asked: true } })
    expect(readArchiveLog(agentRoot)).toEqual([expect.objectContaining({ id: "s1", name: "Now", reason: "owner-asked" })])
  })

  it("opens, automates, and runs the app's workflows through their verbs", async () => {
    expect(await call(tools.navigateToTool, { id: "s1" })).toEqual({})
    expect(await call(tools.saveSessionAutomationTool, { session_id: "s1", interval: "minutes", every_minutes: 5, prompt: "p" })).toEqual({})
    expect(await call(tools.saveSessionAutomationTool, { session_id: "s1", clear: true })).toEqual({})
    expect(await call(tools.saveSessionAutomationTool, { session_id: "s1" })).toEqual({})
    expect(await call(tools.getSessionAutomationTool, { session_id: "s1" })).toEqual({})
    expect(await call(tools.listWorkflowsTool)).toEqual({})
    expect(await call(tools.runWorkflowTool, { id: "w1" })).toEqual({})
    expect(calls()).toEqual([
      { argv: ["open", "s1", "--json"] },
      { argv: ["automation", "s1", "--json", "--input", "-"], input: { interval: "minutes", every_minutes: 5, prompt: "p" } },
      { argv: ["automation", "s1", "--json", "--input", "-"], input: { clear: true } },
      { argv: ["automation", "s1", "--json"] },
      { argv: ["automation", "s1", "--json"] },
      { argv: ["workflows", "--json"] },
      { argv: ["run-workflow", "w1", "--json"] },
    ])
  })

  it("tails a session's messages with a clamped count, and names a rename", async () => {
    replies({ messages: { body: { session_id: "s1", name: "Now", state: "idle", messages: [], coverage: "local" } } })
    watchSession(agentRoot, "s1", "Before", 0, Date.now())
    expect(await call(tools.appSessionsTailTool, { session_id: "s1", count: 500 })).toMatchObject({ session_id: "s1", renamed_from: "Before", coverage: "local" })
    expect(calls()[0]).toEqual({ argv: ["messages", "s1", "--json", "--input", "-"], input: { count: 50 } })
    watchSession(agentRoot, "s1", "Now", 0, Date.now())
    expect(await call(tools.appSessionsTailTool, { session_id: "s1" })).not.toHaveProperty("renamed_from")
    expect(calls()[1]).toEqual({ argv: ["messages", "s1", "--json", "--input", "-"], input: { count: 6 } })
    expect(await call(tools.appSessionsTailTool, { session_id: "s2" })).not.toHaveProperty("renamed_from")
  })
})

describe("finding Shepherd", () => {
  it("says Shepherd is not installed, with how to install it, when none is found", async () => {
    delete process.env.SHEPHERD_BIN
    process.env.PATH = ""
    process.env.HOME = root
    expect(await call(tools.listSessionsAndChatsTool)).toEqual({ error: expect.stringContaining("Shepherd is not installed") })
    expect(await call(tools.listSessionsAndChatsTool)).toEqual({ error: expect.stringContaining("npx github:ourostack/shepherd#v0.8.1") })
  })

  it("names a SHEPHERD_BIN that does not exist", async () => {
    process.env.SHEPHERD_BIN = path.join(root, "missing", "shepherd.mjs")
    expect(await call(tools.getSessionsStatusTool)).toEqual({ error: expect.stringContaining("does not exist") })
  })

  it("runs the shepherd on PATH when SHEPHERD_BIN is not set", async () => {
    const pathDir = path.join(root, "on-path")
    fs.mkdirSync(pathDir)
    const wrapper = path.join(pathDir, "shepherd")
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(shepherdDir, "shepherd.mjs")}" "$@"\n`)
    fs.chmodSync(wrapper, 0o755)
    delete process.env.SHEPHERD_BIN
    process.env.PATH = pathDir
    replies({ session: { body: { id: "s1", name: "Now" } } })
    expect(await call(tools.getSessionTool, { session_id: "s1" })).toEqual({ id: "s1", name: "Now" })
  })

  it("runs Housesitter's bundled Shepherd when neither SHEPHERD_BIN nor PATH has one", async () => {
    const home = path.join(root, "home")
    shepherdDir = install(path.join(home, "Library", "Application Support", "housesitter", "releases", "shepherd", "current", "bin"))
    delete process.env.SHEPHERD_BIN
    process.env.PATH = ""
    process.env.HOME = home
    replies({ workflows: { body: { ok: true, workflows: [{ id: "w1" }] } } })
    expect(await call(tools.listWorkflowsTool)).toEqual({ ok: true, workflows: [{ id: "w1" }] })
    expect(calls()).toEqual([{ argv: ["workflows", "--json"] }])
  })
})

describe("app_sessions_restart", () => {
  it("reports the restart, and enqueues one only with a reason", async () => {
    client.restartStatus.mockResolvedValue({ state: "idle" })
    client.restartEnqueue.mockResolvedValue({ state: "queued" })
    expect(await call(tools.appSessionsRestartTool)).toEqual({ state: "idle" })
    expect(await call(tools.appSessionsRestartTool, { action: "enqueue", why: " " })).toMatchObject({ error: expect.stringContaining("say why") })
    expect(await call(tools.appSessionsRestartTool, { action: "enqueue", why: "update" })).toEqual({ state: "queued" })
    expect(client.restartEnqueue).toHaveBeenCalledWith("update", "ouroboros", {})
    await call(tools.appSessionsRestartTool, { action: "enqueue", why: "x" }, { agentRoot } as ToolContext)
    expect(client.restartEnqueue).toHaveBeenLastCalledWith("x", "an agent", {})
    await call(tools.appSessionsRestartTool, { action: "enqueue" })
  })
})

describe("app_sessions_digest", () => {
  it("returns the digest, or says there is none yet", async () => {
    digest.readDigestText.mockReturnValueOnce("all well")
    expect(await call(tools.appSessionsDigestTool)).toEqual({ digest: "all well" })
    digest.readDigestText.mockReturnValueOnce(null)
    expect(await call(tools.appSessionsDigestTool)).toMatchObject({ error: expect.stringContaining("no status digest") })
  })
})
