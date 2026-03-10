import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
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

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn(),
    createTask: vi.fn(),
    updateStatus: vi.fn(),
    boardStatus: vi.fn(),
    boardAction: vi.fn(),
    boardDeps: vi.fn(),
    boardSessions: vi.fn(),
  }),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "testagent"),
  loadAgentConfig: vi.fn(() => ({
    provider: "anthropic",
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
}))

import * as fs from "fs"

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset()
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  vi.mocked(fs.mkdirSync).mockReset()
})

describe("send_message tool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("is registered in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")
    expect(tool).toBeDefined()
    expect(tool!.tool.function.parameters).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["friendId", "channel", "content"]),
    })
  })

  it("writes a pending message file", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const result = await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: "hey, how's the build going?",
    })

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/pending/friend-uuid-1/cli/session",
      { recursive: true },
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/friend-uuid-1\/cli\/session\/\d+-.+\.json$/),
      expect.any(String),
    )
    // Verify the written content
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.from).toBe("testagent")
    expect(written.content).toBe("hey, how's the build going?")
    expect(written.channel).toBe("cli")
    expect(result).toContain("queued")
  })

  it("uses custom key when provided", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    await tool.handler({
      friendId: "friend-uuid-1",
      channel: "teams",
      key: "thread-42",
      content: "check this out",
    })

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/pending/friend-uuid-1/teams/thread-42",
      { recursive: true },
    )
  })

  it("defaults key to 'session'", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: "hello",
    })

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/pending/friend-uuid-1/cli/session",
      { recursive: true },
    )
  })

  it("includes timestamp in pending file content", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: "time check",
    })

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.timestamp).toBeDefined()
    expect(typeof written.timestamp).toBe("number")
  })

  it("truncates long content in confirmation preview", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

    const longContent = "a".repeat(100)
    const result = await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      content: longContent,
    })

    expect(result).toContain("…")
    expect(result).not.toContain("a".repeat(100))
  })
})
