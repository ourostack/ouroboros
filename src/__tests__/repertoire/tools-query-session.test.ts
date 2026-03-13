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
  vi.mocked(fs.readdirSync).mockReset()
})

describe("query_session tool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("is registered in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")
    expect(tool).toBeDefined()
    expect(tool!.tool.function.parameters).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["friendId", "channel"]),
    })
  })

  it("loads session messages and returns formatted summary", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "how is the billing fix?" },
          { role: "assistant", content: "I finished it an hour ago." },
          { role: "user", content: "great, any issues?" },
          { role: "assistant", content: "No, all tests pass." },
        ],
      }),
    )

    const result = await tool.handler({
      friendId: "friend-uuid-1",
      channel: "teams",
      key: "thread1",
    })

    expect(result).toContain("how is the billing fix?")
    expect(result).toContain("I finished it an hour ago.")
    expect(result).toContain("No, all tests pass.")
  })

  it("limits messages to messageCount parameter", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "first message" },
          { role: "assistant", content: "first reply" },
          { role: "user", content: "second message" },
          { role: "assistant", content: "second reply" },
          { role: "user", content: "third message" },
          { role: "assistant", content: "third reply" },
        ],
      }),
    )

    const result = await tool.handler({
      friendId: "friend-uuid-1",
      channel: "cli",
      key: "session",
      messageCount: "2",
    })

    expect(result).toContain("third message")
    expect(result).toContain("third reply")
    expect(result).not.toContain("first message")
  })

  it("returns error message when session file does not exist", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })

    const result = await tool.handler({
      friendId: "nonexistent",
      channel: "cli",
      key: "session",
    })

    expect(result).toContain("no session found")
  })

  it("handles session with no messages array", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1 }),
    )

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      key: "session",
    })

    expect(result).toContain("no non-system messages")
  })

  it("returns message when session has only system messages", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
        ],
      }),
    )

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      key: "session",
    })

    expect(result).toContain("no non-system messages")
  })

  it("defaults key to 'session' when not provided", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
      }),
    )

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
    })

    expect(result).toContain("hello")
    expect(fs.readFileSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      "utf-8",
    )
  })

  it("calls summarize when ctx.summarize is provided", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "how is the billing fix?" },
          { role: "assistant", content: "I finished it an hour ago." },
        ],
      }),
    )

    const mockSummarize = vi.fn().mockResolvedValue("Summary: billing fix completed 1h ago.")
    const ctx = {
      signin: async () => undefined,
      summarize: mockSummarize,
      context: {
        friend: { trustLevel: "friend" as const },
        channel: { channel: "cli" as const, supportsMarkdown: true, supportsStreaming: true, supportsRichCards: false },
      },
    }

    const result = await tool.handler(
      { friendId: "friend-uuid-1", channel: "cli", key: "session" },
      ctx as any,
    )

    expect(result).toBe("Summary: billing fix completed 1h ago.")
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.stringContaining("billing fix"),
      expect.stringContaining("friend"),
    )
  })

  it("uses fully transparent summarization for self-queries", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "inner dialog bootstrap" },
          { role: "assistant", content: "working on billing fix" },
        ],
      }),
    )

    const mockSummarize = vi.fn().mockResolvedValue("Summary: autonomous work on billing fix.")
    const ctx = {
      signin: async () => undefined,
      summarize: mockSummarize,
    }

    const result = await tool.handler(
      { friendId: "self", channel: "inner", key: "dialog" },
      ctx as any,
    )

    expect(result).toBe("Summary: autonomous work on billing fix.")
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("inner dialog"),
    )
    // Should NOT contain trust level for self-queries
    expect(mockSummarize.mock.calls[0][1]).not.toContain("trust level")
  })

  it("falls back to raw transcript when summarize is not available", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
      }),
    )

    // No ctx.summarize — should return raw transcript
    const result = await tool.handler({ friendId: "friend-1", channel: "cli" })
    expect(result).toContain("[user] hello")
    expect(result).toContain("[assistant] hi there")
  })

  it("delegates transcript recall to the shared session-recall helper", async () => {
    const mockRecallSession = vi.fn().mockResolvedValue({
      kind: "ok",
      transcript: "[user] hello",
      summary: "Summary: hello",
      snapshot: "recent focus: hello",
    })
    vi.doMock("../../heart/session-recall", () => ({
      recallSession: mockRecallSession,
    }))

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler(
      { friendId: "friend-1", channel: "cli", key: "session" },
      {
        signin: async () => undefined,
        summarize: vi.fn().mockResolvedValue("Summary: hello"),
        context: {
          friend: { trustLevel: "friend" as const },
          channel: { channel: "cli" as const, supportsMarkdown: true, supportsStreaming: true, supportsRichCards: false },
        },
      } as any,
    )

    expect(mockRecallSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
    }))
    expect(result).toBe("Summary: hello")
  })

  it("falls back to a missing-session message when shared recall throws unexpectedly", async () => {
    const mockRecallSession = vi.fn().mockRejectedValue(new Error("recall failed"))
    vi.doMock("../../heart/session-recall", () => ({
      recallSession: mockRecallSession,
    }))

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      key: "session",
    })

    expect(mockRecallSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
    }))
    expect(result).toBe("no session found for that friend/channel/key combination.")
  })

  it("supports a lightweight status mode for self/inner checks", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    expect(tool.tool.function.parameters).toMatchObject({
      properties: {
        mode: { type: "string", enum: ["transcript", "status"] },
      },
    })

    vi.mocked(fs.existsSync).mockImplementation((filePath) => (
      String(filePath) === "/mock/agent-root/state/pending/self/inner/dialog"
    ))
    vi.mocked(fs.readdirSync).mockReturnValue(["123-pending.json"] as any)
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith("/state/pending/self/inner/dialog/123-pending.json")) {
        return JSON.stringify({
          from: "testagent",
          content: "think about penguins",
          timestamp: 123,
        })
      }
      throw new Error("ENOENT")
    })

    const result = await tool.handler({
      friendId: "self",
      channel: "inner",
      mode: "status",
    })

    expect(result).toBe([
      "queue: queued to inner/dialog",
      "wake: awaiting inner session",
      "processing: pending",
      "surfaced: nothing yet",
    ].join("\n"))
  })

  it("surfaces the latest processed preview in status mode without dumping the full transcript", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([] as any)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: "## pending messages\n[pending from testagent]: think about penguins\n\n...time passing. anything stirring?",
          },
          { role: "assistant", content: "formal little blokes." },
        ],
      }),
    )

    const result = await tool.handler({
      friendId: "self",
      channel: "inner",
      mode: "status",
    })

    expect(result).toBe([
      "queue: clear",
      "wake: completed",
      "processing: processed",
      'surfaced: "formal little blokes."',
    ].join("\n"))
  })

  it("reports live processing when runtime state says an inner turn is still running", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.existsSync).mockImplementation((filePath) => (
      String(filePath) === "/mock/agent-root/state/sessions/self/inner/runtime.json"
    ))
    vi.mocked(fs.readdirSync).mockReturnValue([] as any)
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith("/state/sessions/self/inner/dialog.json")) {
        return JSON.stringify({
          version: 1,
          messages: [
            { role: "system", content: "sys" },
            {
              role: "user",
              content: "## pending messages\n[pending from testagent]: think about penguins\n\n...time passing. anything stirring?",
            },
            { role: "assistant", content: "formal little blokes." },
          ],
        })
      }

      if (String(filePath).endsWith("/state/sessions/self/inner/runtime.json")) {
        return JSON.stringify({
          status: "running",
          reason: "instinct",
          startedAt: "2026-03-12T00:00:00.000Z",
        })
      }

      throw new Error(`ENOENT: ${String(filePath)}`)
    })

    const result = await tool.handler({
      friendId: "self",
      channel: "inner",
      mode: "status",
    })

    expect(result).toBe([
      "queue: clear",
      "wake: in progress",
      "processing: started",
      "surfaced: nothing yet",
    ].join("\n"))
  })

  it("reports queued-behind-active-turn when pending work exists during a running inner turn", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.existsSync).mockImplementation((filePath) => (
      String(filePath) === "/mock/agent-root/state/sessions/self/inner/runtime.json"
      || String(filePath) === "/mock/agent-root/state/pending/self/inner/dialog"
    ))
    vi.mocked(fs.readdirSync).mockReturnValue(["123-pending.json"] as any)
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith("/state/pending/self/inner/dialog/123-pending.json")) {
        return JSON.stringify({
          from: "testagent",
          content: "think about penguins",
          timestamp: 123,
        })
      }

      if (String(filePath).endsWith("/state/sessions/self/inner/dialog.json")) {
        return JSON.stringify({
          version: 1,
          messages: [
            { role: "system", content: "sys" },
            {
              role: "user",
              content: "## pending messages\n[pending from testagent]: earlier thought\n\n...time passing. anything stirring?",
            },
            { role: "assistant", content: "older surfaced thought." },
          ],
        })
      }

      if (String(filePath).endsWith("/state/sessions/self/inner/runtime.json")) {
        return JSON.stringify({
          status: "running",
          reason: "instinct",
          startedAt: "2026-03-12T00:00:00.000Z",
        })
      }

      throw new Error(`ENOENT: ${String(filePath)}`)
    })

    const result = await tool.handler({
      friendId: "self",
      channel: "inner",
      mode: "status",
    })

    expect(result).toBe([
      "queue: queued to inner/dialog",
      "wake: queued behind active turn",
      "processing: pending",
      "surfaced: nothing yet",
    ].join("\n"))
  })

  it("rejects status mode for non-self sessions instead of pretending it can inspect them", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "status",
    })

    expect(result).toBe("status mode is only available for self/inner dialog.")
  })
})
