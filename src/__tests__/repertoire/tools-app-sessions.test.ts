import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const digest = vi.hoisted(() => ({ readDigestText: vi.fn() }))
vi.mock("../../senses/app-sessions/digest", () => digest)
const client = vi.hoisted(() => ({ listAppSessions: vi.fn(), readAppSessionHistory: vi.fn(), restartStatus: vi.fn(), restartEnqueue: vi.fn() }))
const face = vi.hoisted(() => {
  const names = ["answerSessionInput", "archiveSession", "createSession", "getSession", "getSessionAutomation", "getSessionsStatus", "listSessionsAndChats", "listWorkflows", "navigateTo", "respondToSessionPlan", "runWorkflow", "saveSessionAutomation", "sendSessionMessage"]
  return { findSession: vi.fn(), ...Object.fromEntries(names.map(name => [name, vi.fn(async () => ({ ok: true }))])) } as Record<string, ReturnType<typeof vi.fn>>
})
vi.mock("../../senses/app-sessions/client", () => client)
vi.mock("../../senses/app-sessions/app-interface", () => face)

import * as tools from "../../repertoire/tools-app-sessions"
import { watchSession } from "../../senses/app-sessions/store"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"

let agentRoot: string
let ctx: ToolContext
const call = async (tool: ToolDefinition, args: Record<string, unknown> = {}, context: ToolContext | null = ctx) =>
  JSON.parse(await tool.handler(args as Record<string, string>, context ?? undefined)) as Record<string, unknown>

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-app-"))
  ctx = { agentRoot, agentName: "ouroboros" } as ToolContext
  vi.clearAllMocks()
  face.findSession!.mockImplementation((rows: Array<{ id: string }>, id: string) => rows.find(row => row.id.startsWith(id)))
})
afterEach(() => fs.rmSync(agentRoot, { recursive: true, force: true }))

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

  it("needs an agent runtime, and reports a failure as an error result", async () => {
    expect(await call(tools.listWorkflowsTool, {}, null)).toEqual({ error: "the app-sessions tools need an agent runtime" })
    face.listWorkflows!.mockRejectedValueOnce(new Error("app is not running"))
    expect(await call(tools.listWorkflowsTool)).toEqual({ error: "app is not running" })
  })

  it("hands each tool's arguments to the app interface", async () => {
    const args = { session_id: "s1", message: "hi", answer: "a", approved: true, id: "x" }
    const cases: Array<[ToolDefinition, string]> = [
      [tools.listSessionsAndChatsTool, "listSessionsAndChats"], [tools.getSessionsStatusTool, "getSessionsStatus"], [tools.getSessionTool, "getSession"],
      [tools.sendSessionMessageTool, "sendSessionMessage"], [tools.createSessionTool, "createSession"], [tools.answerSessionInputTool, "answerSessionInput"],
      [tools.respondToSessionPlanTool, "respondToSessionPlan"], [tools.archiveSessionTool, "archiveSession"], [tools.navigateToTool, "navigateTo"],
      [tools.saveSessionAutomationTool, "saveSessionAutomation"], [tools.getSessionAutomationTool, "getSessionAutomation"], [tools.runWorkflowTool, "runWorkflow"],
    ]
    for (const [tool, fn] of cases) {
      expect(await call(tool, args)).toEqual({ ok: true })
      expect(face[fn]).toHaveBeenCalled()
    }
    await call(tools.getSessionsStatusTool, { state: "busy" })
    expect(face.getSessionsStatus).toHaveBeenLastCalledWith(agentRoot, "busy", {})
  })
})

describe("app_sessions_tail", () => {
  const rows = [{ id: "abc12345", name: "Now", state: "idle", lastActivity: "t", remote: false }]

  it("reads a session's transcript with its coverage", async () => {
    client.listAppSessions.mockResolvedValue(rows)
    client.readAppSessionHistory.mockReturnValue({ messages: [] })
    watchSession(agentRoot, "abc12345", "Before", 0, Date.now())
    const result = await call(tools.appSessionsTailTool, { session_id: "abc1", count: 500 })
    expect(client.readAppSessionHistory).toHaveBeenCalledWith("abc12345", 50, {})
    expect(result).toMatchObject({ session_id: "abc12345", renamed_from: "Before", coverage: "local" })
    for (const [history, remote, coverage] of [[{ missing: true }, false, "missing"], [{ skippedEvents: 2 }, false, "incomplete"], [{}, true, "local-only"]] as const) {
      client.listAppSessions.mockResolvedValue([{ ...rows[0], remote }])
      client.readAppSessionHistory.mockReturnValue(history)
      expect(await call(tools.appSessionsTailTool, { session_id: "abc1" })).toMatchObject({ coverage })
    }
    expect(client.readAppSessionHistory).toHaveBeenLastCalledWith("abc12345", 6, {})
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
