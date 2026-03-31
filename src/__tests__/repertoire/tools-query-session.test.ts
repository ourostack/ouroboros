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
  vi.doUnmock("../../heart/session-recall")
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

  it("falls back to the raw transcript when summarization fails", async () => {
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

    const result = await tool.handler(
      { friendId: "friend-uuid-1", channel: "cli", key: "session" },
      {
        signin: async () => undefined,
        summarize: vi.fn().mockRejectedValue(new Error("summary failed")),
        context: {
          friend: { trustLevel: "friend" as const },
          channel: { channel: "cli" as const, supportsMarkdown: true, supportsStreaming: true, supportsRichCards: false },
        },
      } as any,
    )

    expect(result).toContain("how is the billing fix?")
    expect(result).toContain("I finished it an hour ago.")
    expect(result).not.toContain("no session found")
  })

  it("falls back to the raw transcript when summarization fails with a string rejection", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "did the relay stick?" },
          { role: "assistant", content: "yes, bridge attach persisted." },
        ],
      }),
    )

    const result = await tool.handler(
      { friendId: "friend-uuid-1", channel: "cli", key: "session" },
      {
        signin: async () => undefined,
        summarize: vi.fn().mockRejectedValue("summary failed as string"),
        context: {
          friend: { trustLevel: "friend" as const },
          channel: { channel: "cli" as const, supportsMarkdown: true, supportsStreaming: true, supportsRichCards: false },
        },
      } as any,
    )

    expect(result).toContain("did the relay stick?")
    expect(result).toContain("yes, bridge attach persisted.")
    expect(result).not.toContain("no session found")
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
        mode: { type: "string", enum: ["transcript", "status", "search"] },
        query: { type: "string" },
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

    expect(result).toBe("i've queued this thought for private attention. it'll come up when my inner dialog is free.")
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

    expect(result).toContain("thought about this privately and came to something")
    expect(result).toContain("formal little blokes")
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

    expect(result).toBe("i'm working through this privately right now.")
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

    expect(result).toBe("i've queued this thought for private attention. it'll come up when my inner dialog is free.")
  })

  it("reports completed idle status when nothing recent has surfaced", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith("/state/sessions/self/inner/dialog.json")) {
        return JSON.stringify({ version: 1, messages: [{ role: "system", content: "sys" }] })
      }
      throw new Error(`ENOENT: ${String(filePath)}`)
    })

    const result = await tool.handler({
      friendId: "self",
      channel: "inner",
      mode: "status",
    })

    expect(result).toContain("thought about this privately")
    expect(result).toContain("bring it back when the time is right")
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

  it("requires a non-empty query in search mode", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "search",
      query: "   ",
    })

    expect(result).toBe("search mode requires a non-empty query.")
  })

  it("rejects search mode when the query field is omitted entirely", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "search",
    })

    expect(result).toBe("search mode requires a non-empty query.")
  })

  it("searches full session history for older context without relying on transcript tail only", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "billing was failing in staging earlier" },
        { role: "assistant", content: "billing is green now after the fix" },
        { role: "user", content: "latest unrelated question" },
        { role: "assistant", content: "latest unrelated answer" },
      ],
    }))

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "search",
      query: "billing",
    })

    expect(result).toContain('history search: "billing"')
    expect(result).toContain("[user] billing was failing in staging earlier")
    expect(result).toContain("[assistant] billing is green now after the fix")
    expect(result).not.toContain("latest unrelated answer")
  })

  it("reports when a history search has no matches while still surfacing the latest turn context", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "still working the release thread" },
      ],
    }))

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "search",
      query: "billing",
    })

    expect(result).toContain('no matches for "billing" in that session.')
    expect(result).toContain("latest assistant: still working the release thread")
  })

  it("returns the missing-session message when history search fails unexpectedly", async () => {
    vi.doMock("../../heart/session-recall", () => ({
      recallSession: vi.fn(),
      searchSessionTranscript: vi.fn().mockRejectedValue(new Error("search failed")),
    }))

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "search",
      query: "billing",
    })

    expect(result).toBe("no session found for that friend/channel/key combination.")
  })

  it("returns the empty-session message when history search finds no non-system content", async () => {
    vi.doMock("../../heart/session-recall", () => ({
      recallSession: vi.fn(),
      searchSessionTranscript: vi.fn().mockResolvedValue({ kind: "empty" }),
    }))

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    const result = await tool.handler({
      friendId: "friend-1",
      channel: "cli",
      mode: "search",
      query: "billing",
    })

    expect(result).toBe("session exists but has no non-system messages.")
  })

  it("resolves friend name to UUID via ctx.friendStore.listAll", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "test message" },
          { role: "assistant", content: "test reply" },
        ],
      }),
    )

    const ctx = {
      friendStore: {
        listAll: vi.fn().mockResolvedValue([
          { id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789", name: "Jordan" },
          { id: "f1f2f3f4-a5b6-7890-cdef-1234567890ab", name: "Ari" },
        ]),
      },
    }

    const result = await tool.handler(
      { friendId: "Jordan", channel: "cli", key: "session" },
      ctx as any,
    )

    // Should resolve "Jordan" to the UUID and read session at the resolved path
    expect(fs.readFileSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/sessions/a1b2c3d4-e5f6-7890-abcd-ef0123456789/cli/session.json",
      "utf-8",
    )
    expect(result).toContain("test message")
  })

  it("keeps friend name as-is when no match found in friendStore", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find(d => d.tool.function.name === "query_session")!

    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })

    const ctx = {
      friendStore: {
        listAll: vi.fn().mockResolvedValue([
          { id: "f1f2f3f4-a5b6-7890-cdef-1234567890ab", name: "Ari" },
        ]),
      },
    }

    const result = await tool.handler(
      { friendId: "Unknown Name", channel: "cli", key: "session" },
      ctx as any,
    )

    // Name not found — should use the original name as friendId
    expect(fs.readFileSync).toHaveBeenCalledWith(
      "/mock/agent-root/state/sessions/Unknown Name/cli/session.json",
      "utf-8",
    )
    expect(result).toContain("no session found")
  })
})
