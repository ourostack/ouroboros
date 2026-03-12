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

const mockRunInnerDialogTurn = vi.fn()
const mockRequestInnerWake = vi.fn()

vi.mock("../../senses/inner-dialog", () => ({
  runInnerDialogTurn: (...args: any[]) => mockRunInnerDialogTurn(...args),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: (...args: any[]) => mockRequestInnerWake(...args),
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
  mockRunInnerDialogTurn.mockReset()
  mockRequestInnerWake.mockReset()
  mockRequestInnerWake.mockResolvedValue(null)
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

  describe("self-routing special case", () => {
    it("routes friendId='self' to inner dialog pending dir regardless of channel", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "teams",
        content: "note to self",
      })

      // Self always routes to inner dialog pending dir, NOT to the specified channel
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/agent-root\/state\/pending\/self\/inner\/dialog\/\d+-.+\.json$/),
        expect.any(String),
      )
    })

    it("routes friendId='self' with channel='cli' to inner dialog pending dir", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "remember this for later",
      })

      // Even when channel is 'cli', self goes to inner dialog
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
    })

    it("routes friendId='self' with channel='bluebubbles' to inner dialog pending dir", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "bluebubbles",
        content: "a thought for myself",
      })

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
    })

    it("preserves original friendId and channel in the written envelope even when self-routed", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "teams",
        content: "note to self",
      })

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
      expect(written.from).toBe("testagent")
      expect(written.friendId).toBe("self")
      expect(written.channel).toBe("teams")
      expect(written.content).toBe("note to self")
    })

    it("does NOT self-route when friendId is a regular UUID", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        content: "hey friend",
      })

      // Regular friend routes to the specified channel, NOT inner dialog
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/friend-uuid-1/bluebubbles/session",
        { recursive: true },
      )
    })

    it("self-routing ignores custom key and always uses 'dialog'", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      await tool.handler({
        friendId: "self",
        channel: "cli",
        key: "custom-key",
        content: "internal thought",
      })

      // Self always routes to inner/dialog, ignoring the custom key
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        "/mock/agent-root/state/pending/self/inner/dialog",
        { recursive: true },
      )
    })

    it("confirmation message mentions self routing", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      const result = await tool.handler({
        friendId: "self",
        channel: "teams",
        content: "remember this",
      })

      // Should indicate inner dialog routing, not the original channel
      expect(result).toContain("inner")
      expect(result).toContain("dialog")
    })

    it("falls back to an immediate inner turn when no daemon wake path is available", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "penguins surfaced." }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "think about penguins",
      })

      expect(mockRunInnerDialogTurn).toHaveBeenCalledTimes(1)
      expect(result).toContain("queue: queued to inner/dialog")
      expect(result).toContain("wake: inline fallback")
      expect(result).toContain("processing: processed")
      expect(result).toContain('surfaced: "penguins surfaced."')
    })

    it("uses daemon-managed wake when available and skips the inline fallback", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRequestInnerWake.mockResolvedValue({
        ok: true,
        message: "woke inner dialog for testagent",
      })

      const result = await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "notice this now",
      })

      expect(mockRequestInnerWake).toHaveBeenCalledWith("testagent")
      expect(mockRunInnerDialogTurn).not.toHaveBeenCalled()
      expect(result).toBe([
        "queue: queued to inner/dialog",
        "wake: daemon requested",
        "processing: pending",
        "surfaced: nothing yet",
      ].join("\n"))
    })

    it("falls back to an immediate inner turn when daemon wake rejects", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRequestInnerWake.mockRejectedValue(new Error("socket unavailable"))
      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "picked up inline." }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      await tool.handler({
        friendId: "self",
        channel: "cli",
        content: "keep thinking",
      })

      expect(mockRunInnerDialogTurn).toHaveBeenCalledTimes(1)
    })

    it("surfaces inline fallback failures instead of masking them as queued success", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!

      mockRunInnerDialogTurn.mockRejectedValue(new Error("inner dialog failed"))

      await expect(tool.handler({
        friendId: "self",
        channel: "cli",
        content: "keep going",
      })).rejects.toThrow("inner dialog failed")
    })

    it("defers the inline fallback to a microtask when already in inner dialog", async () => {
      const { baseToolDefinitions } = await import("../../repertoire/tools-base")
      const tool = baseToolDefinitions.find(d => d.tool.function.name === "send_message")!
      const queuedCallbacks: Array<() => void> = []
      const queueMicrotaskSpy = vi
        .spyOn(globalThis, "queueMicrotask")
        .mockImplementation((callback: VoidFunction) => {
          queuedCallbacks.push(callback)
        })

      mockRunInnerDialogTurn.mockResolvedValue({
        messages: [{ role: "assistant", content: "i kept the thread alive." }],
        sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      })

      await tool.handler(
        {
          friendId: "self",
          channel: "inner",
          content: "stay with this",
        },
        {
          context: {
            friend: {} as any,
            channel: { channel: "inner" } as any,
          },
          signin: async () => undefined,
        },
      )

      expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1)
      expect(mockRunInnerDialogTurn).not.toHaveBeenCalled()
      queuedCallbacks[0]?.()
      expect(mockRunInnerDialogTurn).toHaveBeenCalledTimes(1)
      queueMicrotaskSpy.mockRestore()
    })
  })
})
