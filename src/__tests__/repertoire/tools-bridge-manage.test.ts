import { beforeEach, describe, expect, it, vi } from "vitest"

const mockBeginBridge = vi.fn()
const mockAttachSession = vi.fn()
const mockGetBridge = vi.fn()
const mockPromoteBridgeToTask = vi.fn()
const mockCompleteBridge = vi.fn()
const mockCancelBridge = vi.fn()

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return {
    ...actual,
    createBridgeManager: () => ({
      beginBridge: (...args: any[]) => mockBeginBridge(...args),
      attachSession: (...args: any[]) => mockAttachSession(...args),
      getBridge: (...args: any[]) => mockGetBridge(...args),
      promoteBridgeToTask: (...args: any[]) => mockPromoteBridgeToTask(...args),
      completeBridge: (...args: any[]) => mockCompleteBridge(...args),
      cancelBridge: (...args: any[]) => mockCancelBridge(...args),
    }),
  }
})

vi.mock("../../heart/session-transcript", () => ({
  summarizeSessionTail: vi.fn().mockResolvedValue({
    kind: "ok",
    transcript: "user: hi\nassistant: hello",
    summary: "recent focus: relay setup",
    snapshot: "recent focus: relay setup",
    tailMessages: [],
  }),
}))

vi.mock("../../heart/config", async () => {
  const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config")
  return {
    ...actual,
    resolveSessionPath: vi.fn((_friendId: string, _channel: string, _key: string) =>
      "/mock/agent-root/state/sessions/friend-2/teams/conv-2.json"),
  }
})

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

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("bridge_manage tool", () => {
  beforeEach(async () => {
    vi.resetModules()
    mockBeginBridge.mockReset()
    mockAttachSession.mockReset()
    mockGetBridge.mockReset()
    mockPromoteBridgeToTask.mockReset()
    mockCompleteBridge.mockReset()
    mockCancelBridge.mockReset()
    const search_notes = await import("../../heart/session-transcript")
    vi.mocked(search_notes.summarizeSessionTail).mockReset()
    vi.mocked(search_notes.summarizeSessionTail).mockResolvedValue({
      kind: "ok",
      transcript: "user: hi\nassistant: hello",
      summary: "recent focus: relay setup",
      snapshot: "recent focus: relay setup",
      tailMessages: [],
    } as any)
  })

  it("is registered in baseToolDefinitions with the approved action contract", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")

    expect(tool).toBeDefined()
    expect(tool!.tool.function.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          enum: ["begin", "attach", "status", "promote_task", "complete", "cancel"],
        },
      },
      required: expect.arrayContaining(["action"]),
    })
  })

  it("begins a bridge from the current live session", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    mockBeginBridge.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "active",
      runtime: "idle",
      attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
      task: null,
    })

    const result = await tool.handler(
      {
        action: "begin",
        objective: "relay Ari between cli and teams",
      },
      {
        signin: vi.fn(),
        currentSession: {
          friendId: "friend-1",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/session.json",
        },
      } as any,
    )

    expect(mockBeginBridge).toHaveBeenCalledWith({
      objective: "relay Ari between cli and teams",
      summary: "relay Ari between cli and teams",
      session: {
        friendId: "friend-1",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/session.json",
      },
    })
    expect(result).toContain("bridge: bridge-1")
    expect(result).toContain("state: active-idle")
  })

  it("attaches another existing session by canonical identity and reuses session search_notes snapshotting", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    mockAttachSession.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "active",
      runtime: "idle",
      attachedSessions: [
        { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" },
        {
          friendId: "friend-2",
          channel: "teams",
          key: "conv-2",
          sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/conv-2.json",
          snapshot: "recent focus: relay setup",
        },
      ],
      task: null,
    })

    const result = await tool.handler(
      {
        action: "attach",
        bridgeId: "bridge-1",
        friendId: "friend-2",
        channel: "teams",
        key: "conv-2",
      },
      {
        signin: vi.fn(),
      } as any,
    )

    expect(mockAttachSession).toHaveBeenCalledWith("bridge-1", {
      friendId: "friend-2",
      channel: "teams",
      key: "conv-2",
      sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/conv-2.json",
      snapshot: "recent focus: relay setup",
    })
    expect(result).toContain("bridge: bridge-1")
    expect(result).toContain("sessions: 2")
  })

  it("can attach a candidate chat from a different outward relationship without forcing a same-friend shortcut", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    mockAttachSession.mockReturnValue({
      id: "bridge-1",
      objective: "carry Ari between the 1:1 and the project group",
      lifecycle: "active",
      runtime: "idle",
      attachedSessions: [
        { friendId: "friend-1", channel: "bluebubbles", key: "chat-any", sessionPath: "/tmp/session.json" },
        {
          friendId: "group-1",
          channel: "bluebubbles",
          key: "chat:any;+;project-group-123",
          sessionPath: "/mock/agent-root/state/sessions/group-1/bluebubbles/chat:any;+;project-group-123.json",
          snapshot: "recent focus: waiting on Ari",
        },
      ],
      task: null,
    })

    const result = await tool.handler(
      {
        action: "attach",
        bridgeId: "bridge-1",
        friendId: "group-1",
        channel: "bluebubbles",
        key: "chat:any;+;project-group-123",
      },
      {
        signin: vi.fn(),
      } as any,
    )

    expect(mockAttachSession).toHaveBeenCalledWith("bridge-1", {
      friendId: "group-1",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/conv-2.json",
      snapshot: "recent focus: relay setup",
    })
    expect(result).toContain("sessions: 2")
  })

  it("falls back to the raw search_notes snapshot when summarization fails during attach", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    const search_notes = await import("../../heart/session-transcript")

    vi.mocked(search_notes.summarizeSessionTail)
      .mockRejectedValueOnce(new Error("summary failed"))
      .mockResolvedValueOnce({
        kind: "ok",
        transcript: "user: hi\nassistant: hello",
        summary: "user: hi\nassistant: hello",
        snapshot: "recent focus: user: hi",
        tailMessages: [],
      } as any)

    mockAttachSession.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "active",
      runtime: "idle",
      attachedSessions: [
        { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" },
        {
          friendId: "friend-2",
          channel: "teams",
          key: "conv-2",
          sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/conv-2.json",
          snapshot: "recent focus: user: hi",
        },
      ],
      task: null,
    })

    const result = await tool.handler(
      {
        action: "attach",
        bridgeId: "bridge-1",
        friendId: "friend-2",
        channel: "teams",
        key: "conv-2",
      },
      {
        signin: vi.fn(),
        summarize: vi.fn().mockRejectedValue(new Error("summary failed")),
      } as any,
    )

    expect(search_notes.summarizeSessionTail).toHaveBeenNthCalledWith(1, expect.objectContaining({
      friendId: "friend-2",
      channel: "teams",
      key: "conv-2",
      summarize: expect.any(Function),
    }))
    expect(search_notes.summarizeSessionTail).toHaveBeenNthCalledWith(2, expect.objectContaining({
      friendId: "friend-2",
      channel: "teams",
      key: "conv-2",
      summarize: undefined,
    }))
    expect(mockAttachSession).toHaveBeenCalledWith("bridge-1", expect.objectContaining({
      snapshot: "recent focus: user: hi",
    }))
    expect(result).toContain("sessions: 2")
  })

  it("still reports missing when both summarized and raw search_notes fail during attach", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    const search_notes = await import("../../heart/session-transcript")

    vi.mocked(search_notes.summarizeSessionTail)
      .mockRejectedValueOnce(new Error("summary failed"))
      .mockRejectedValueOnce(new Error("raw session tail failed"))

    const result = await tool.handler(
      {
        action: "attach",
        bridgeId: "bridge-1",
        friendId: "friend-2",
        channel: "teams",
        key: "conv-2",
      },
      {
        signin: vi.fn(),
        summarize: vi.fn().mockRejectedValue(new Error("summary failed")),
      } as any,
    )

    expect(result).toBe("no session found for that friend/channel/key combination.")
    expect(mockAttachSession).not.toHaveBeenCalled()
  })

  it("requires a non-empty objective when beginning a bridge", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    expect(
      await tool.handler(
        { action: "begin", objective: "   " },
        {
          signin: vi.fn(),
          currentSession: {
            friendId: "friend-1",
            channel: "cli",
            key: "session",
            sessionPath: "/tmp/session.json",
          },
        } as any,
      ),
    ).toBe("objective is required for bridge begin.")
  })

  it("requires an objective when begin omits it entirely", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    expect(
      await tool.handler(
        { action: "begin" },
        {
          signin: vi.fn(),
          currentSession: {
            friendId: "friend-1",
            channel: "cli",
            key: "session",
            sessionPath: "/tmp/session.json",
          },
        } as any,
      ),
    ).toBe("objective is required for bridge begin.")
  })

  it("uses an explicit empty-session snapshot when attaching a session with no non-system messages", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    const search_notes = await import("../../heart/session-transcript")
    vi.mocked(search_notes.summarizeSessionTail).mockResolvedValueOnce({ kind: "empty" } as any)
    mockAttachSession.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "active",
      runtime: "idle",
      attachedSessions: [
        { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" },
        {
          friendId: "friend-2",
          channel: "teams",
          key: "conv-2",
          sessionPath: "/mock/agent-root/state/sessions/friend-2/teams/conv-2.json",
          snapshot: "session exists but has no non-system messages.",
        },
      ],
      task: null,
    })

    await tool.handler(
      {
        action: "attach",
        bridgeId: "bridge-1",
        friendId: "friend-2",
        channel: "teams",
        key: "conv-2",
      },
      { signin: vi.fn() } as any,
    )

    expect(mockAttachSession).toHaveBeenCalledWith("bridge-1", expect.objectContaining({
      snapshot: "session exists but has no non-system messages.",
    }))
  })

  it("requires friendId when attach omits it entirely", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    expect(
      await tool.handler(
        { action: "attach", bridgeId: "bridge-1", channel: "teams", key: "conv-2" },
        { signin: vi.fn() } as any,
      ),
    ).toBe("friendId and channel are required for bridge attach.")
  })

  it("supports status, promote_task, complete, and cancel actions through the shared manager", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "active",
      runtime: "idle",
      summary: "keep the two live surfaces aligned",
      attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
      task: null,
    })
    mockPromoteBridgeToTask.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "active",
      runtime: "idle",
      summary: "keep the two live surfaces aligned",
      attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
      task: { taskName: "2026-03-13-1600-shared-relay", path: "/tmp/task.md", mode: "promoted", boundAt: "2026-03-13T16:00:00.000Z" },
    })
    mockCompleteBridge.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "completed",
      runtime: "idle",
      summary: "keep the two live surfaces aligned",
      attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
      task: { taskName: "2026-03-13-1600-shared-relay", path: "/tmp/task.md", mode: "promoted", boundAt: "2026-03-13T16:00:00.000Z" },
    })
    mockCancelBridge.mockReturnValue({
      id: "bridge-1",
      objective: "relay Ari between cli and teams",
      lifecycle: "cancelled",
      runtime: "idle",
      summary: "keep the two live surfaces aligned",
      attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
      task: null,
    })

    expect(
      await tool.handler({ action: "status", bridgeId: "bridge-1" }, { signin: vi.fn() } as any),
    ).toContain("state: active-idle")

    expect(
      await tool.handler({ action: "promote_task", bridgeId: "bridge-1", title: "Shared Relay" }, { signin: vi.fn() } as any),
    ).toContain("task: 2026-03-13-1600-shared-relay")
    expect(mockPromoteBridgeToTask).toHaveBeenCalledWith("bridge-1", {
      title: "Shared Relay",
      category: undefined,
      body: undefined,
    })

    expect(
      await tool.handler({ action: "complete", bridgeId: "bridge-1" }, { signin: vi.fn() } as any),
    ).toContain("state: completed")
    expect(
      await tool.handler({ action: "cancel", bridgeId: "bridge-1" }, { signin: vi.fn() } as any),
    ).toContain("state: cancelled")
  })

  it("formats active bridge runtime labels for processing and queued follow-up states", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    mockGetBridge
      .mockReturnValueOnce({
        id: "bridge-1",
        objective: "relay Ari between cli and teams",
        lifecycle: "active",
        runtime: "processing",
        summary: "keep the two live surfaces aligned",
        attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
        task: null,
      })
      .mockReturnValueOnce({
        id: "bridge-1",
        objective: "relay Ari between cli and teams",
        lifecycle: "active",
        runtime: "awaiting-follow-up",
        summary: "keep the two live surfaces aligned",
        attachedSessions: [{ friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/session.json" }],
        task: null,
      })

    expect(
      await tool.handler({ action: "status", bridgeId: "bridge-1" }, { signin: vi.fn() } as any),
    ).toContain("state: active-processing")
    expect(
      await tool.handler({ action: "status", bridgeId: "bridge-1" }, { signin: vi.fn() } as any),
    ).toContain("state: awaiting-follow-up")
  })

  it("returns a clear status error when the bridge id is unknown", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    mockGetBridge.mockReturnValue(null)

    expect(
      await tool.handler({ action: "status", bridgeId: "bridge-missing" }, { signin: vi.fn() } as any),
    ).toBe("bridge not found: bridge-missing")
  })

  it("falls back to a bridgeId error when action is omitted", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    expect(
      await tool.handler({}, { signin: vi.fn() } as any),
    ).toBe("bridgeId is required for this bridge action.")
  })

  it("returns clear errors for missing bridge context, bridge ids, attach inputs, and missing sessions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    expect(await tool.handler({ action: "begin", objective: "bridge it" }, { signin: vi.fn() } as any)).toBe(
      "bridge_manage begin requires an active session context.",
    )
    expect(await tool.handler({ action: "status" }, { signin: vi.fn() } as any)).toBe(
      "bridgeId is required for this bridge action.",
    )
    expect(await tool.handler({ action: "attach", bridgeId: "bridge-1", friendId: "friend-2" }, { signin: vi.fn() } as any)).toBe(
      "friendId and channel are required for bridge attach.",
    )

    const search_notes = await import("../../heart/session-transcript")
    vi.mocked(search_notes.summarizeSessionTail).mockResolvedValueOnce({ kind: "missing" } as any)
    expect(
      await tool.handler(
        { action: "attach", bridgeId: "bridge-1", friendId: "friend-2", channel: "teams", key: "conv-2" },
        { signin: vi.fn() } as any,
      ),
    ).toBe("no session found for that friend/channel/key combination.")
  })

  it("falls back to the same missing-session response when shared search_notes throws during attach", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!
    const search_notes = await import("../../heart/session-transcript")
    vi.mocked(search_notes.summarizeSessionTail).mockRejectedValueOnce(new Error("boom"))

    expect(
      await tool.handler(
        { action: "attach", bridgeId: "bridge-1", friendId: "friend-2", channel: "teams", key: "conv-2" },
        { signin: vi.fn() } as any,
      ),
    ).toBe("no session found for that friend/channel/key combination.")
  })

  it("returns an explicit fallback for unknown bridge actions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "bridge_manage")!

    expect(
      await tool.handler({ action: "reroute", bridgeId: "bridge-1" }, { signin: vi.fn() } as any),
    ).toBe("unknown bridge action: reroute")
  })
})
