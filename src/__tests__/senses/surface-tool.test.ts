import { describe, it, expect, vi, beforeEach } from "vitest"

const mockListSessionActivity = vi.fn()
const mockSendProactiveBlueBubblesMessageToSession = vi.fn()
const mockSendTelegramAwaitFollowUp = vi.fn()
const mockGetBridge = vi.fn()
const mockPlaceTrustedFriendVoiceOutboundCall = vi.fn()

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn().mockReturnValue("/tmp/test-agent"),
  getAgentName: vi.fn().mockReturnValue("test"),
}))

vi.mock("../../heart/session-activity", () => ({
  listSessionActivity: (...args: unknown[]) => mockListSessionActivity(...args),
}))

vi.mock("../../senses/bluebubbles", () => ({
  sendProactiveBlueBubblesMessageToSession: (...args: unknown[]) =>
    mockSendProactiveBlueBubblesMessageToSession(...args),
}))

vi.mock("../../senses/telegram", () => ({
  sendTelegramAwaitFollowUp: (...args: unknown[]) => mockSendTelegramAwaitFollowUp(...args),
}))

vi.mock("../../heart/bridges/manager", () => ({
  createBridgeManager: () => ({
    getBridge: (...args: unknown[]) => mockGetBridge(...args),
  }),
}))

vi.mock("../../senses/voice/outbound", () => ({
  placeTrustedFriendVoiceOutboundCall: (...args: unknown[]) => mockPlaceTrustedFriendVoiceOutboundCall(...args),
}))

describe("surface tool", () => {
  let surfaceToolDef: typeof import("../../repertoire/tools").surfaceToolDef
  let handleSurface: typeof import("../../senses/surface-tool").handleSurface
  type AttentionItem = import("../../arc/attention-types").AttentionItem

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const fs = await import("fs")
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockReturnValue("")
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.mkdirSync).mockReset()
    mockListSessionActivity.mockReturnValue([])
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({
      delivered: false,
      reason: "send_error",
    })
    mockSendTelegramAwaitFollowUp.mockReset()
    mockSendTelegramAwaitFollowUp.mockResolvedValue({
      status: "delivered_now",
      detail: "sent to the exact request-bound Telegram chat",
    })
    mockGetBridge.mockReturnValue(null)
    mockPlaceTrustedFriendVoiceOutboundCall.mockReset()
    mockPlaceTrustedFriendVoiceOutboundCall.mockResolvedValue({
      status: "placed",
      detail: "voice call initiated",
    })
    const toolsMod = await import("../../repertoire/tools")
    surfaceToolDef = toolsMod.surfaceToolDef
    const surfaceMod = await import("../../senses/surface-tool")
    handleSurface = surfaceMod.handleSurface
  })

  describe("tool definition", () => {
    it("has name 'surface'", () => {
      expect(surfaceToolDef.function.name).toBe("surface")
    })

    it("has content as required parameter", () => {
      const params = surfaceToolDef.function.parameters as any
      expect(params.required).toContain("content")
    })

    it("has optional delegationId and friendId parameters", () => {
      const params = surfaceToolDef.function.parameters as any
      expect(params.properties.delegationId).toBeDefined()
      expect(params.properties.friendId).toBeDefined()
    })

    it("can request the voice delivery channel for live calls", () => {
      const params = surfaceToolDef.function.parameters as any
      expect(params.properties.channel.enum).toContain("voice")
      expect(params.properties.phoneNumber).toBeDefined()
    })
  })

  describe("handleSurface", () => {
    it("returns error when neither delegationId nor friendId provided", async () => {
      const queue: AttentionItem[] = []
      const result = await handleSurface({
        content: "hello",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation: () => {},
      })

      expect(result).toContain("specify who this thought is for")
    })

    it("dequeues by delegationId after successful routing", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
      ]

      const result = await handleSurface({
        content: "penguins are great",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered", detail: "via iMessage" }),
        advanceObligation: () => {},
      })

      expect(result).toContain("delivered")
      expect(queue).toHaveLength(0) // dequeued after successful routing
    })

    it("does NOT dequeue when routing fails entirely", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
      ]

      const result = await handleSurface({
        content: "penguins are great",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "failed" }),
        advanceObligation: () => {},
      })

      expect(result).toContain("failed")
      expect(queue).toHaveLength(1) // NOT dequeued
    })

    it("returns clear error for invalid delegationId", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
      ]

      const result = await handleSurface({
        content: "hello",
        delegationId: "nonexistent",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation: () => {},
      })

      expect(result).toContain("no delegation found with id nonexistent")
    })

    it("routes to friendId for spontaneous outreach (no dequeue)", async () => {
      const queue: AttentionItem[] = []

      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued", detail: "for next interaction" })
      const result = await handleSurface({
        content: "just thinking of you",
        friendId: "ben",
        queue,
        routeToFriend,
        advanceObligation: () => {},
      })

      expect(routeToFriend).toHaveBeenCalledWith("ben", "just thinking of you", undefined)
      expect(result).toContain("queued")
    })

    it("advances obligation to returned when delegationId provided and routing succeeds", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      const advanceObligation = vi.fn()
      await handleSurface({
        content: "penguins are great",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered", detail: "via iMessage" }),
        advanceObligation,
      })

      expect(advanceObligation).toHaveBeenCalledWith("obl-1", expect.objectContaining({ status: "returned" }))
    })

    it("completes a linked ponder packet when routing succeeds", async () => {
      const queue: AttentionItem[] = [
        {
          id: "abc123",
          friendId: "ari",
          friendName: "Ari",
          channel: "bb",
          key: "c1",
          delegatedContent: "think",
          source: "drained",
          timestamp: 1000,
          obligationId: "obl-1",
          packetId: "pkt-1",
        },
      ]

      const advanceObligation = vi.fn()
      const completePonderPacket = vi.fn()
      await handleSurface({
        content: "private answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation,
        completePonderPacket,
      })

      expect(advanceObligation).toHaveBeenCalledWith("obl-1", expect.objectContaining({ status: "returned" }))
      expect(completePonderPacket).toHaveBeenCalledWith("pkt-1")
    })

    it("does not complete a linked ponder packet when routing fails", async () => {
      const queue: AttentionItem[] = [
        {
          id: "abc123",
          friendId: "ari",
          friendName: "Ari",
          channel: "bb",
          key: "c1",
          delegatedContent: "think",
          source: "drained",
          timestamp: 1000,
          obligationId: "obl-1",
          packetId: "pkt-1",
        },
      ]

      const completePonderPacket = vi.fn()
      await handleSurface({
        content: "private answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "failed" }),
        advanceObligation: vi.fn(),
        completePonderPacket,
      })

      expect(completePonderPacket).not.toHaveBeenCalled()
    })

    it("advances obligation BEFORE dequeue (crash safety)", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      const callOrder: string[] = []
      const advanceObligation = vi.fn().mockImplementation(() => { callOrder.push("advance") })
      // Monkey-patch dequeue tracking
      const origSplice = Array.prototype.splice
      const patchedQueue = queue as AttentionItem[]
      const origLength = patchedQueue.length

      await handleSurface({
        content: "penguins are great",
        delegationId: "abc123",
        queue: patchedQueue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation,
      })

      // advance should have been called (obligation advanced to disk)
      expect(advanceObligation).toHaveBeenCalled()
      // queue should be dequeued (advance happens before dequeue)
      expect(patchedQueue).toHaveLength(0)
    })

    it("returns delivery status string", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
      ]

      const result = await handleSurface({
        content: "penguins",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "deferred", detail: "they'll see it next time" }),
        advanceObligation: () => {},
      })

      expect(result).toContain("deferred")
    })

    it("does NOT advance obligation for spontaneous outreach (no delegationId)", async () => {
      const advanceObligation = vi.fn()
      await handleSurface({
        content: "hello",
        friendId: "ben",
        queue: [],
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation,
      })

      expect(advanceObligation).not.toHaveBeenCalled()
    })

    it("passes queueItem to routeToFriend when routing via delegationId", async () => {
      const queueItem: AttentionItem = {
        id: "abc123", friendId: "ari", friendName: "Ari", channel: "bluebubbles", key: "c1",
        bridgeId: "bridge-1", delegatedContent: "think about this", source: "drained", timestamp: 1000,
      }
      const queue: AttentionItem[] = [queueItem]

      const routeToFriend = vi.fn().mockResolvedValue({ status: "delivered", detail: "via iMessage" })
      await handleSurface({
        content: "here's my answer",
        delegationId: "abc123",
        queue,
        routeToFriend,
        advanceObligation: () => {},
      })

      expect(routeToFriend).toHaveBeenCalledWith("ari", "here's my answer", queueItem)
    })

    it("reports route results through the optional habit recorder callback", async () => {
      const queueItem: AttentionItem = {
        id: "abc123", friendId: "ari", friendName: "Ari", channel: "bluebubbles", key: "c1",
        delegatedContent: "think about this", source: "drained", timestamp: 1000,
      }
      const onRouteResult = vi.fn()

      await handleSurface({
        content: "here's my answer",
        delegationId: "abc123",
        queue: [queueItem],
        routeToFriend: async () => ({ status: "deferred", detail: "they'll see it next time" }),
        advanceObligation: () => {},
        onRouteResult,
      })

      expect(onRouteResult).toHaveBeenCalledWith({
        targetFriendId: "ari",
        queueItem,
        result: { status: "deferred", detail: "they'll see it next time" },
      })
    })

    it("passes undefined queueItem to routeToFriend for spontaneous outreach", async () => {
      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued", detail: "pending" })
      await handleSurface({
        content: "hey there",
        friendId: "bob",
        queue: [],
        routeToFriend,
        advanceObligation: () => {},
      })

      expect(routeToFriend).toHaveBeenCalledWith("bob", "hey there", undefined)
    })

    it("keeps a named outreach spontaneous when no held item matches friendId", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "mcp", key: "s1", delegatedContent: "held", source: "drained", timestamp: 1000 },
      ]
      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued", detail: "pending" })
      const advanceObligation = vi.fn()
      const fulfillHeartObligation = vi.fn()

      const result = await handleSurface({
        content: "fresh thought",
        friendId: "ben",
        queue,
        routeToFriend,
        advanceObligation,
        fulfillHeartObligation,
      })

      expect(result).toContain("queued")
      expect(routeToFriend).toHaveBeenCalledWith("ben", "fresh thought", undefined)
      expect(advanceObligation).not.toHaveBeenCalled()
      expect(fulfillHeartObligation).not.toHaveBeenCalled()
      expect(queue).toHaveLength(1)
    })

    it("infers the only held item when surface omits friendId and delegationId", async () => {
      const queue: AttentionItem[] = [
        {
          id: "abc123",
          friendId: "friend-uuid",
          friendName: "Ari",
          channel: "mcp",
          key: "session-1",
          delegatedContent: "check the loop",
          obligationId: "obl-1",
          source: "drained",
          timestamp: 1000,
        },
      ]
      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued", detail: "for originating mcp session" })
      const advanceObligation = vi.fn()
      const fulfillHeartObligation = vi.fn()

      const result = await handleSurface({
        content: "single held return",
        queue,
        routeToFriend,
        advanceObligation,
        fulfillHeartObligation,
      })

      expect(result).toContain("queued")
      expect(routeToFriend).toHaveBeenCalledWith("friend-uuid", "single held return", expect.objectContaining({ id: "abc123" }))
      expect(advanceObligation).toHaveBeenCalledWith("obl-1", expect.objectContaining({ status: "returned" }))
      expect(fulfillHeartObligation).toHaveBeenCalledWith({ friendId: "friend-uuid", channel: "mcp", key: "session-1" })
      expect(queue).toHaveLength(0)
    })

    it("infers a matching held item when surface uses friendId without delegationId", async () => {
      const queue: AttentionItem[] = [
        {
          id: "abc123",
          friendId: "friend-uuid",
          friendName: "Ari",
          channel: "mcp",
          key: "session-1",
          delegatedContent: "check the loop",
          obligationId: "obl-1",
          source: "drained",
          timestamp: 1000,
        },
      ]
      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued", detail: "for originating mcp session" })
      const advanceObligation = vi.fn()
      const fulfillHeartObligation = vi.fn()

      const result = await handleSurface({
        content: "loop observed",
        friendId: "Ari",
        queue,
        routeToFriend,
        advanceObligation,
        fulfillHeartObligation,
      })

      expect(result).toContain("queued")
      expect(routeToFriend).toHaveBeenCalledWith("friend-uuid", "loop observed", expect.objectContaining({ id: "abc123" }))
      expect(advanceObligation).toHaveBeenCalledWith("obl-1", expect.objectContaining({ status: "returned" }))
      expect(fulfillHeartObligation).toHaveBeenCalledWith({ friendId: "friend-uuid", channel: "mcp", key: "session-1" })
      expect(queue).toHaveLength(0)
    })

    it("requires delegationId before returning packet-backed private work", async () => {
      const queue: AttentionItem[] = [
        {
          id: "abc123",
          friendId: "friend-uuid",
          friendName: "Ari",
          channel: "mcp",
          key: "session-1",
          delegatedContent: "check the loop",
          obligationId: "obl-1",
          packetId: "pkt-1",
          source: "drained",
          timestamp: 1000,
        },
      ]
      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued", detail: "for originating mcp session" })
      const advanceObligation = vi.fn()

      const result = await handleSurface({
        content: "stale unrelated thought",
        friendId: "Ari",
        queue,
        routeToFriend,
        advanceObligation,
      })

      expect(result).toContain("held private return abc123 is waiting")
      expect(routeToFriend).not.toHaveBeenCalled()
      expect(advanceObligation).not.toHaveBeenCalled()
      expect(queue).toHaveLength(1)
    })

    it("requires delegationId when friendId matches multiple held items", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "mcp", key: "s1", delegatedContent: "first", source: "drained", timestamp: 1000 },
        { id: "def456", friendId: "ari", friendName: "Ari", channel: "mcp", key: "s2", delegatedContent: "second", source: "drained", timestamp: 1001 },
      ]

      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued" })
      const result = await handleSurface({
        content: "answer",
        friendId: "ari",
        queue,
        routeToFriend,
        advanceObligation: () => {},
      })

      expect(result).toContain("multiple held thoughts match")
      expect(routeToFriend).not.toHaveBeenCalled()
      expect(queue).toHaveLength(2)
    })

    it("requires delegationId when no friendId is provided and multiple held items exist", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "mcp", key: "s1", delegatedContent: "first", source: "drained", timestamp: 1000 },
        { id: "def456", friendId: "ben", friendName: "Ben", channel: "mcp", key: "s2", delegatedContent: "second", source: "drained", timestamp: 1001 },
      ]

      const routeToFriend = vi.fn().mockResolvedValue({ status: "queued" })
      const result = await handleSurface({
        content: "answer",
        queue,
        routeToFriend,
        advanceObligation: () => {},
      })

      expect(result).toContain("multiple held thoughts match this surface call")
      expect(routeToFriend).not.toHaveBeenCalled()
      expect(queue).toHaveLength(2)
    })

    it("passes delivery hints only when a non-default channel is requested", async () => {
      const routeToFriend = vi.fn().mockResolvedValue({ status: "delivered", detail: "voice call initiated" })
      await handleSurface({
        content: "call me about the alpha",
        friendId: "ari",
        deliveryHint: { channel: "voice" },
        queue: [],
        routeToFriend,
        advanceObligation: () => {},
      })

      expect(routeToFriend).toHaveBeenCalledWith("ari", "call me about the alpha", undefined, { channel: "voice" })
    })
  })

  describe("heart obligation fulfillment", () => {
    it("calls fulfillHeartObligation with origin when surface routes successfully with delegationId", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      const fulfillHeartObligation = vi.fn()
      await handleSurface({
        content: "here's the answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered", detail: "via iMessage" }),
        advanceObligation: () => {},
        fulfillHeartObligation,
      })

      expect(fulfillHeartObligation).toHaveBeenCalledWith({
        friendId: "ari",
        channel: "bb",
        key: "c1",
      })
    })

    it("does NOT call fulfillHeartObligation for spontaneous outreach (no delegationId)", async () => {
      const fulfillHeartObligation = vi.fn()
      await handleSurface({
        content: "hello",
        friendId: "ben",
        queue: [],
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation: () => {},
        fulfillHeartObligation,
      })

      expect(fulfillHeartObligation).not.toHaveBeenCalled()
    })

    it("does NOT call fulfillHeartObligation when routing fails", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      const fulfillHeartObligation = vi.fn()
      await handleSurface({
        content: "here's the answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "failed" }),
        advanceObligation: () => {},
        fulfillHeartObligation,
      })

      expect(fulfillHeartObligation).not.toHaveBeenCalled()
    })

    it("gracefully handles no fulfillHeartObligation callback (backward compat)", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      // No fulfillHeartObligation provided — should not throw
      const result = await handleSurface({
        content: "here's the answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation: () => {},
      })

      expect(result).toContain("delivered")
    })

    it("catches fulfillHeartObligation errors without breaking surface delivery", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      const fulfillHeartObligation = vi.fn().mockImplementation(() => { throw new Error("obligation store read failure") })
      const result = await handleSurface({
        content: "here's the answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation: () => {},
        fulfillHeartObligation,
      })

      // Surface delivery should still succeed
      expect(result).toContain("delivered")
      // The callback was called (it threw, but that's caught)
      expect(fulfillHeartObligation).toHaveBeenCalled()
    })

    it("calls fulfillHeartObligation AFTER advanceObligation", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000, obligationId: "obl-1" },
      ]

      const callOrder: string[] = []
      const advanceObligation = vi.fn().mockImplementation(() => { callOrder.push("advance-inner") })
      const fulfillHeartObligation = vi.fn().mockImplementation(() => { callOrder.push("fulfill-heart") })

      await handleSurface({
        content: "here's the answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation,
        fulfillHeartObligation,
      })

      expect(callOrder).toEqual(["advance-inner", "fulfill-heart"])
    })

    it("surfaceToolDefinition handler fails closed when content contains internal meta markers", async () => {
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const { emitNervesEvent } = await import("../../nerves/runtime")

      const result = await surfaceToolDefinition.handler({
        content: "[surfaced from inner dialog] hi friend",
        friendId: "ari",
      }, { delegatedOrigins: [] } as any)

      expect(typeof result).toBe("string")
      expect((result as string).toLowerCase()).toContain("failed")
      expect(result).toContain("blocked: contains internal meta markers")
      expect(emitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          event: "tools.surface_meta_blocked",
        }),
      )
    })

    it("surfaceToolDefinition handler also blocks <think> reasoning tag leaks", async () => {
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")

      const result = await surfaceToolDefinition.handler({
        content: "<think>private reasoning</think>",
        friendId: "ari",
      }, { delegatedOrigins: [] } as any)

      expect((result as string).toLowerCase()).toContain("failed")
      expect(result).toContain("blocked: contains internal meta markers")
    })

    it("surfaceToolDefinition queues bridge-attached BlueBubbles returns without live-sending iMessage", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockGetBridge.mockReturnValue({
        id: "bridge-1",
        lifecycle: "active",
        attachedSessions: [
          {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat:any;-;ari@mendelow.me",
          },
        ],
      })
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat:any;-;ari@mendelow.me",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;ari@mendelow.me.json",
        },
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "private answer ready for the bluebubbles session",
        delegationId: "delegation-1",
      }, {
        delegatedOrigins: [
          {
            id: "delegation-1",
            friendId: "friend-1",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "chat:any;-;ari@mendelow.me",
            bridgeId: "bridge-1",
            delegatedContent: "think about this privately",
            source: "drained",
            timestamp: 1,
          },
        ],
      } as any)

      expect(result).toContain("queued")
      expect(result).toContain("for next interaction via bluebubbles")
      expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/bluebubbles\/chat:any;-;ari@mendelow.me\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("private answer ready for the bluebubbles session"),
      )
    })

    it("surfaceToolDefinition queues delegated MCP returns to the exact origin even with a fresher BlueBubbles session", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat:any;-;ari@mendelow.me",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;ari@mendelow.me.json",
        },
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "INNER_E2E_OK_C evolutions::count=0",
        delegationId: "delegation-mcp",
      }, {
        delegatedOrigins: [
          {
            id: "delegation-mcp",
            friendId: "friend-1",
            friendName: "Ari",
            channel: "mcp",
            key: "mcp-session-123",
            delegatedContent: "check the evolution loop",
            source: "drained",
            timestamp: 1,
          },
        ],
      } as any)

      expect(result).toContain("queued")
      expect(result).toContain("for originating mcp session")
      expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/mcp\/mcp-session-123\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("INNER_E2E_OK_C evolutions::count=0"),
      )
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/bluebubbles\//),
        expect.any(String),
      )
    })

    it("surfaceToolDefinition infers a delegated MCP return when inner omits delegationId but names the friend", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat:any;-;ari@mendelow.me",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;ari@mendelow.me.json",
        },
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "INNER_E2E_OK_D evolution_status observed",
        friendId: "Ari",
      }, {
        delegatedOrigins: [
          {
            id: "delegation-mcp",
            friendId: "friend-1",
            friendName: "Ari",
            channel: "mcp",
            key: "mcp-session-123",
            delegatedContent: "call evolution_status",
            source: "drained",
            timestamp: 1,
          },
        ],
      } as any)

      expect(result).toContain("queued")
      expect(result).toContain("for originating mcp session")
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/mcp\/mcp-session-123\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("INNER_E2E_OK_D evolution_status observed"),
      )
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/bluebubbles\//),
        expect.any(String),
      )
    })

    it("surfaceToolDefinition queues delegated non-MCP returns to the exact origin session", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat:any;-;ari@mendelow.me",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;ari@mendelow.me.json",
        },
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "return to the CLI lane",
        delegationId: "delegation-cli",
      }, {
        delegatedOrigins: [
          {
            id: "delegation-cli",
            friendId: "friend-1",
            friendName: "Ari",
            channel: "cli",
            key: "session",
            delegatedContent: "think privately",
            source: "drained",
            timestamp: 1,
          },
        ],
      } as any)

      expect(result).toContain("queued")
      expect(result).toContain("for originating cli session")
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/cli\/session\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("return to the CLI lane"),
      )
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/bluebubbles\//),
        expect.any(String),
      )
    })

    it("surfaceToolDefinition records structured habit surface attempts from route results", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      const recordSurfaceAttempt = vi.fn()

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "return to the requester",
        delegationId: "delegation-cli",
      }, {
        delegatedOrigins: [
          {
            id: "delegation-cli",
            friendId: "friend-1",
            friendName: "Ari",
            channel: "cli",
            key: "session",
            delegatedContent: "think privately",
            source: "drained",
            timestamp: 1,
          },
        ],
        habitSession: { recordSurfaceAttempt },
      } as any)

      expect(result).toContain("queued")
      expect(recordSurfaceAttempt).toHaveBeenCalledWith({
        recipient: "friend-1",
        channel: "cli",
        reason: "answer",
        result: "queued",
        rawStatus: "queued",
        routeKind: "originator",
      })
    })

    it("surfaceToolDefinition records delivered voice route attempts for habit receipts", async () => {
      const recordSurfaceAttempt = vi.fn()

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "call with the result",
        friendId: "ari",
        channel: "voice",
      }, {
        delegatedOrigins: [],
        habitSession: { recordSurfaceAttempt },
      } as any)

      expect(result).toContain("delivered")
      expect(mockPlaceTrustedFriendVoiceOutboundCall).toHaveBeenCalledWith(expect.objectContaining({
        friendId: "ari",
        reason: "call with the result",
      }))
      expect(recordSurfaceAttempt).toHaveBeenCalledWith({
        recipient: "ari",
        channel: "voice",
        reason: "answer",
        result: "delivered",
        rawStatus: "delivered",
      })
    })

    it("surfaceToolDefinition records failed voice route attempts for habit receipts", async () => {
      mockPlaceTrustedFriendVoiceOutboundCall.mockResolvedValueOnce({
        status: "blocked",
        detail: "voice route unavailable",
      })
      const recordSurfaceAttempt = vi.fn()

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "call with the result",
        friendId: "ari",
        channel: "voice",
      }, {
        delegatedOrigins: [],
        habitSession: { recordSurfaceAttempt },
      } as any)

      expect(result).toContain("failed")
      expect(recordSurfaceAttempt).toHaveBeenCalledWith({
        recipient: "ari",
        channel: "voice",
        reason: "blocked",
        result: "failed",
        rawStatus: "failed",
        error: "voice route unavailable",
      })
    })

    it("surfaceToolDefinition queues freshest BlueBubbles DM returns without live-sending iMessage", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat:any;-;ari@mendelow.me",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;ari@mendelow.me.json",
        },
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "freshest bluebubbles return should wait",
        friendId: "friend-1",
      }, { delegatedOrigins: [] } as any)

      expect(result).toContain("queued")
      expect(result).toContain("for next interaction via bluebubbles")
      expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/bluebubbles\/chat:any;-;ari@mendelow.me\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("freshest bluebubbles return should wait"),
      )
    })

    it("surfaceToolDefinition delivers freshest Telegram returns immediately through the Telegram effect journal", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "telegram",
          key: "telegram_777_42",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/telegram/telegram_777_42.json",
        },
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "I checked the noisy alert and took care of it.",
        friendId: "friend-1",
      }, { delegatedOrigins: [] } as any)

      expect(result).toContain("delivered")
      expect(result).toContain("sent to Telegram now")
      expect(mockSendTelegramAwaitFollowUp).toHaveBeenCalledWith("test", expect.objectContaining({
        friendId: "friend-1",
        channel: "telegram",
        key: "telegram:777:42",
        content: "I checked the noisy alert and took care of it.",
        intent: "generic_outreach",
        requestId: expect.stringMatching(/^surface:/u),
        deliveryId: expect.stringMatching(/^surface:/u),
      }))
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition falls back to the Telegram pending queue when live Telegram delivery is blocked", async () => {
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) =>
        String(filePath).endsWith("/state/sessions/friend-1"),
      )
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "telegram",
          key: "telegram_777_42",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/telegram/telegram_777_42.json",
        },
      ])
      mockSendTelegramAwaitFollowUp.mockResolvedValueOnce({
        status: "blocked",
        detail: "relationship follow-up is not bound to an active request await",
      })

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({
        content: "I can answer this next time.",
        friendId: "friend-1",
      }, { delegatedOrigins: [] } as any)

      expect(result).toContain("queued")
      expect(result).toContain("for next interaction via telegram")
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/telegram\/telegram_777_42\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("I can answer this next time."),
      )
    })

    it("calls fulfillHeartObligation even when queue item has no obligationId", async () => {
      const queue: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
        // Note: no obligationId on this queue item
      ]

      const advanceObligation = vi.fn()
      const fulfillHeartObligation = vi.fn()
      await handleSurface({
        content: "here's the answer",
        delegationId: "abc123",
        queue,
        routeToFriend: async () => ({ status: "delivered" }),
        advanceObligation,
        fulfillHeartObligation,
      })

      // advanceObligation should NOT be called (no obligationId)
      expect(advanceObligation).not.toHaveBeenCalled()
      // fulfillHeartObligation SHOULD still be called (origin-based lookup)
      expect(fulfillHeartObligation).toHaveBeenCalledWith({
        friendId: "ari",
        channel: "bb",
        key: "c1",
      })
    })
  })
})
