import { beforeEach, describe, expect, it, vi } from "vitest"

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "other" })
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(defaultReadFileSync),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80_000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

const mockCreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mockCreate } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic }
})

vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: vi.fn().mockResolvedValue(undefined),
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks } from "../../heart/core"

function makeStream(chunks: any[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk } }
}

function callChunk(name: string, args: Record<string, unknown>, id: string) {
  return [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }]
}

function makeCallbacks(): ChannelCallbacks {
  return {
    onModelStart: vi.fn(), onModelStreamStart: vi.fn(), onTextChunk: vi.fn(), onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(), onToolEnd: vi.fn(), onError: vi.fn(), onClearText: vi.fn(), flushNow: vi.fn(),
  }
}

const toolNames = (callIndex: number): string[] => (mockCreate.mock.calls[callIndex][0].tools ?? []).map((tool: any) => tool.function.name)

describe("the tool catalog in runAgent", () => {
  let runAgent: typeof import("../../heart/core").runAgent

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
    } as any)
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    runAgent = (await import("../../heart/core")).runAgent
  })

  const run = async (messages: any[]) => runAgent(messages, makeCallbacks(), "cli", undefined, { toolContext: { signin: async () => undefined } })

  it("holds back doors whose card isn't eager, loads them through find_tools, and advertises them on the next step", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("find_tools", { query: "spawn a coding agent" }, "f1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ready", intent: "complete" }, "s1")))
    const messages: any[] = [{ role: "user", content: "delegate this" }]
    const result = await run(messages)
    expect(result.outcome).toBe("settled")
    const first = toolNames(0)
    expect(first).toContain("find_tools")
    expect(first).toContain("shell")
    expect(first).not.toContain("coding_spawn")
    const second = toolNames(1)
    expect(second).toContain("coding_spawn")
    expect(second.indexOf("coding_spawn")).toBeGreaterThan(second.indexOf("find_tools"))
    const found = messages.find((message) => message.role === "tool" && message.tool_call_id === "f1")
    expect(found.content).toContain("coding_spawn")
  })

  it("runs a held-back door called by name and keeps it loaded", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("coding_status", {}, "c1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    const messages: any[] = [{ role: "user", content: "status?" }]
    await run(messages)
    expect(toolNames(0)).not.toContain("coding_status")
    expect(messages.find((message) => message.tool_call_id === "c1").content).not.toContain("was not advertised")
    expect(toolNames(1)).toContain("coding_status")
  })

  it("still refuses a call to a tool that isn't selected at all", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("no_such_tool", {}, "c1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    await run([{ role: "user", content: "x" }])
    expect(JSON.stringify(mockCreate.mock.calls[1][0].messages)).toContain("was not advertised")
  })

  it("loads the tools a skill declares when the skill loads", async () => {
    const skills = await import("../../repertoire/skills")
    vi.mocked(skills.loadSkill).mockReturnValue("---\nname: delegating\ntools: [coding_spawn, not_a_tool]\n---\nsteps")
    mockCreate.mockReturnValueOnce(makeStream(callChunk("load_skill", { name: "delegating" }, "l1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    const messages: any[] = [{ role: "user", content: "delegate this" }]
    await run(messages)
    expect(toolNames(0)).not.toContain("coding_spawn")
    expect(toolNames(1)).toContain("coding_spawn")
    const loaded = messages.find((message) => message.tool_call_id === "l1").content
    expect(loaded).toContain("steps")
    expect(loaded).toContain("- coding_spawn(")
    expect(loaded.slice(loaded.indexOf("loaded;"))).not.toContain("not_a_tool")
  })

  it("loads a skill's tools once when the skill loads twice", async () => {
    const skills = await import("../../repertoire/skills")
    vi.mocked(skills.loadSkill).mockReturnValue("---\ntools: [coding_spawn]\n---\nsteps")
    mockCreate.mockReturnValueOnce(makeStream(callChunk("load_skill", { name: "delegating" }, "l1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("load_skill", { name: "delegating" }, "l2")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    await run([{ role: "user", content: "delegate this" }])
    expect(toolNames(2).filter((name) => name === "coding_spawn")).toHaveLength(1)
  })

  it("leaves a skill's reply alone when it declares no tools", async () => {
    const skills = await import("../../repertoire/skills")
    vi.mocked(skills.loadSkill).mockReturnValue("just steps")
    mockCreate.mockReturnValueOnce(makeStream(callChunk("load_skill", { name: "plain" }, "l1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    const messages: any[] = [{ role: "user", content: "x" }]
    await run(messages)
    expect(messages.find((message) => message.tool_call_id === "l1").content).toBe("just steps")
  })

  it("keeps a door loaded that an earlier turn found but never called", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    await run([
      { role: "user", content: "earlier" },
      { role: "assistant", content: null, tool_calls: [{ id: "f0", type: "function", function: { name: "find_tools", arguments: "{\"query\":\"select:coding_spawn\"}" } }] },
      { role: "tool", tool_call_id: "f0", content: "loaded; callable on your next step:\n- coding_spawn(): spawn" },
      { role: "user", content: "again" },
    ])
    expect(toolNames(0)).toContain("coding_spawn")
  })

  it("keeps a deferred tool loaded when the conversation already called it", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    await run([
      { role: "user", content: "earlier" },
      { role: "assistant", content: null, tool_calls: [{ id: "h1", type: "function", function: { name: "coding_status", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "h1", content: "none" },
      { role: "user", content: "again" },
    ])
    expect(toolNames(0)).toContain("coding_status")
  })

  it("answers an unmatched query with guidance and loads nothing", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("find_tools", { query: "zzzz" }, "f1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    const messages: any[] = [{ role: "user", content: "x" }]
    await run(messages)
    expect(messages.find((message) => message.tool_call_id === "f1").content).toContain("no matching tools")
    expect(toolNames(1)).not.toContain("coding_spawn")
  })

  it("loads a tool only once across repeated selects", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("find_tools", { query: "select:coding_status" }, "f2")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("find_tools", { query: "select:coding_status" }, "f3")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    const messages: any[] = [{ role: "user", content: "x" }]
    await run(messages)
    expect(toolNames(2).filter((name) => name === "coding_status")).toHaveLength(1)
  })

  it("never defers when tools are hard-disabled", async () => {
    mockCreate.mockReturnValueOnce(makeStream([{ choices: [{ delta: { content: "ok" } }] }]))
    await runAgent([{ role: "user", content: "x" }], makeCallbacks(), "cli", undefined, { hardDisableTools: true, toolContext: { signin: async () => undefined } })
    expect(toolNames(0)).not.toContain("find_tools")
  })

  it("keeps a required tool loaded so its requirement can be met", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("coding_status", {}, "c1")))
    mockCreate.mockReturnValueOnce(makeStream(callChunk("settle", { answer: "ok", intent: "complete" }, "s1")))
    await runAgent([{ role: "user", content: "x" }], makeCallbacks(), "cli", undefined, {
      requiredToolCalls: { names: ["coding_status"], retryMessage: "unused" },
      toolContext: { signin: async () => undefined },
    } as any)
    expect(toolNames(0)).toContain("coding_status")
  })

  it("never defers for the Sanctuary health private profile", async () => {
    mockCreate.mockReturnValueOnce(makeStream(callChunk("rest", { status: "HEARTBEAT_OK" }, "r1")))
    await runAgent([{ role: "user", content: "x" }], makeCallbacks(), "inner", undefined, {
      toolProfile: "sanctuary-health-private",
      tools: [{ type: "function", function: { name: "send_message", description: "alert", parameters: { type: "object", properties: { friendId: { type: "string" }, channel: { type: "string" }, content: { type: "string" } }, required: ["friendId", "channel", "content"], additionalProperties: false } } }],
      execTool: vi.fn(),
      toolContext: { signin: async () => undefined },
    } as any)
    expect(toolNames(0)).toEqual(["send_message", "rest"])
  })
})
