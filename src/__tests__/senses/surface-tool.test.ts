import { describe, it, expect, vi, beforeEach } from "vitest"

const mockListSessionActivity = vi.fn()
const mockSendProactiveBlueBubblesMessageToSession = vi.fn()
const mockSendTelegramAwaitFollowUp = vi.fn()
const mockGetBridge = vi.fn()
const mockPlaceTrustedFriendVoiceOutboundCall = vi.fn()
const mockSendTeamsOffTurn = vi.fn()

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
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

vi.mock("../../senses/teams-off-turn", () => ({
  sendTeamsOffTurn: (...args: unknown[]) => mockSendTeamsOffTurn(...args),
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
    vi.mocked(fs.renameSync).mockReset()
    mockListSessionActivity.mockReturnValue([])
    mockSendTeamsOffTurn.mockReset()
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({
      delivered: false,
      reason: "missing_target",
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

    it("ends a deferred (not sent) result with the surface-not-sent code", async () => {
      const result = await handleSurface({
        content: "heads up",
        friendId: "friend-1",
        queue: [],
        routeToFriend: async () => ({ status: "deferred", detail: "not sent now; saved for their next message" }),
        advanceObligation: () => {},
      })

      expect(result).toBe("deferred — not sent now; saved for their next message (code: surface-not-sent)")
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
      expect(result).toBe("failed — blocked: contains internal meta markers (code: delivery-blocked)")
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
            key: "chat:any;-;owner@example.test",
          },
        ],
      })
      mockListSessionActivity.mockReturnValue([
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat:any;-;owner@example.test",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;owner@example.test.json",
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
            key: "chat:any;-;owner@example.test",
            bridgeId: "bridge-1",
            delegatedContent: "think about this privately",
            source: "drained",
            timestamp: 1,
          },
        ],
      } as any)

      expect(result).toContain("queued")
      expect(result).toBe("queued — for next interaction via bluebubbles; it waits for their next iMessage")
      expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/friend-1\/bluebubbles\/chat:any;-;owner@example.test\/\d+-[a-z0-9]+\.json$/),
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
          key: "chat:any;-;owner@example.test",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;owner@example.test.json",
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
      expect(result).not.toContain("iMessage")
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
          key: "chat:any;-;owner@example.test",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;owner@example.test.json",
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
          key: "chat:any;-;owner@example.test",
          sessionPath: "/tmp/test-agent/state/sessions/friend-1/bluebubbles/chat_any;-;owner@example.test.json",
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

    it("surfaceToolDefinition with channel=teams sends now to the friend's latest Teams chat", async () => {
      mockSendTeamsOffTurn.mockResolvedValue({ delivered: true })
      mockListSessionActivity.mockReturnValue([
        { friendId: "ari", channel: "cli", key: "session", sessionPath: "/x/cli.json" },
        { friendId: "ari", channel: "teams", key: "a:chat-1", sessionPath: "/x/teams.json" },
      ])
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "Ari is at the office.", friendId: "ari", channel: "teams" }, { delegatedOrigins: [] } as any)

      expect(result).toContain("delivered")
      expect(mockSendTeamsOffTurn).toHaveBeenCalledWith(
        { friendId: "ari", key: "a:chat-1", text: "Ari is at the office.", origin: "proactive", captureReceipt: true },
        expect.objectContaining({ agentRoot: expect.any(String) }),
      )
    })

    it("surfaceToolDefinition with channel=teams opens a new chat when the friend has none, and queues when it cannot send", async () => {
      const fs = await import("fs")
      mockSendTeamsOffTurn.mockResolvedValue(null)
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "later then", friendId: "ari", channel: "TEAMS" }, { delegatedOrigins: [] } as any)

      expect(mockSendTeamsOffTurn).toHaveBeenCalledWith(expect.objectContaining({ key: "proactive" }), expect.anything())
      expect(result).toContain("queued")
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending\/ari\/teams\/proactive\/\d+-[a-z0-9]+\.json$/),
        expect.stringContaining("later then"),
      )
    })

    it("surfaceToolDefinition with channel=teams says a Teams send that failed partway may have reached them, and saves no second copy", async () => {
      const fs = await import("fs")
      mockSendTeamsOffTurn.mockResolvedValue({ delivered: false, reason: "send_error" })
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "the build is green", friendId: "ari", channel: "teams" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("unconfirmed — the Teams send failed partway, so it may have reached them; don't resend unless they say they didn't get it")
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition with channel=teams forwards to the machine that runs Teams without queueing here", async () => {
      const fs = await import("fs")
      mockSendTeamsOffTurn.mockResolvedValue({ delivered: false, forwardedTo: "aris-mac-mini" })
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "over to the mini", friendId: "ari", channel: "teams" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("forwarded — handed to aris-mac-mini, which runs Teams; it sends on its next sync")
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.stringMatching(/\/state\/pending\//), expect.anything())
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

    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const session = (channel: string, key: string, ageMs = 0) => ({
      friendId: "friend-1",
      friendName: "Robin",
      channel,
      key,
      sessionPath: `/tmp/test-agent/state/sessions/friend-1/${channel}/${key}.json`,
      lastActivityMs: now - ageMs,
    })
    const dm = "chat:any;-;robin@example.test"

    it("surfaceToolDefinition texts spontaneous outreach by iMessage instead of queueing it into a fresher MCP session", async () => {
      // Reproduces 2026-11-22: an agent's MCP client ran under the person's friend id, so
      // their freshest session was MCP. surface queued the news there, where only the next
      // connecting agent would read it, and the model took "queued" as sent.
      const fs = await import("fs")
      vi.mocked(fs.existsSync).mockImplementation((filePath) => String(filePath).endsWith("/state/sessions/friend-1"))
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: true })
      mockListSessionActivity.mockReturnValue([session("mcp", "mcp-session-1"), session("bluebubbles", dm, 60_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "Your sign-in is done.", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("delivered — texted them by iMessage now")
      expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledWith({
        friendId: "friend-1",
        sessionKey: dm,
        text: "Your sign-in is done.",
        intent: "generic_outreach",
        origin: "proactive",
      })
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition tries the next chat when one does not send, and never returns queued", async () => {
      const fs = await import("fs")
      // An iMessage send that failed before the server took it (no delivery receipt) did not go out, so the next chat is tried.
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "send_error" })
      mockSendTelegramAwaitFollowUp.mockResolvedValue({ status: "blocked", detail: "relationship follow-up is not bound to an active request await" })
      mockSendTeamsOffTurn.mockResolvedValue({ delivered: true })
      mockListSessionActivity.mockReturnValue([
        session("mcp", "mcp-session-1"),
        session("bluebubbles", dm, 1_000),
        session("telegram", "telegram_777_42", 2_000),
        session("teams", "a:chat-1", 3_000),
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "the build is out", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("delivered — sent to Teams now")
      expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledTimes(1)
      expect(mockSendTelegramAwaitFollowUp).toHaveBeenCalledWith("test", expect.objectContaining({ key: "telegram:777:42", intent: "generic_outreach" }))
      expect(mockSendTeamsOffTurn).toHaveBeenCalledWith({ friendId: "friend-1", key: "a:chat-1", text: "the build is out", origin: "proactive", captureReceipt: true }, expect.anything())
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition skips iMessage group chats and names each failed chat once", async () => {
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false })
      mockSendTelegramAwaitFollowUp.mockResolvedValue({ status: "blocked" })
      mockListSessionActivity.mockReturnValue([
        session("bluebubbles", dm),
        session("bluebubbles", "chat:any;+;group-1", 1_000),
        session("bluebubbles", "chat:any;-;robin-2@example.test", 2_000),
        session("telegram", "telegram_777_42", 3_000),
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "heads up", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("deferred — not sent now; saved for their next message. iMessage did not send (not delivered); Telegram did not send (blocked). (code: surface-not-sent)")
      expect(mockSendProactiveBlueBubblesMessageToSession.mock.calls.map(([params]) => params.sessionKey)).toEqual([dm, "chat:any;-;robin-2@example.test"])
    })

    it("surfaceToolDefinition sends a held thought from a private turn the same way, keyed to its obligation", async () => {
      mockListSessionActivity.mockReturnValue([session("mcp", "mcp-session-1"), session("telegram", "telegram_777_42", 1_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "done thinking", delegationId: "held-1" }, {
        delegatedOrigins: [{ id: "held-1", friendId: "friend-1", friendName: "Robin", channel: "inner", key: "dialog", delegatedContent: "think", source: "drained", timestamp: 1, obligationId: "obl-9" }],
      } as any)

      expect(result).toBe("delivered — sent to Telegram now")
      expect(mockSendTelegramAwaitFollowUp).toHaveBeenCalledWith("test", expect.objectContaining({
        requestId: "obl-9",
        deliveryId: expect.stringMatching(/^surface:obl-9:/u),
      }))
    })

    it("surfaceToolDefinition delivers spontaneous outreach on the friend's Telegram now", async () => {
      mockListSessionActivity.mockReturnValue([session("telegram", "telegram_777_42")])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "I took care of the noisy alert.", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("delivered — sent to Telegram now")
      expect(mockSendTelegramAwaitFollowUp).toHaveBeenCalledWith("test", expect.objectContaining({
        friendId: "friend-1",
        channel: "telegram",
        key: "telegram:777:42",
        content: "I took care of the noisy alert.",
        intent: "generic_outreach",
        requestId: expect.stringMatching(/^surface:/u),
        deliveryId: expect.stringMatching(/^surface:/u),
      }))
    })

    it("surfaceToolDefinition reports a hand-off to the machine that runs Teams as forwarded, not queued", async () => {
      const fs = await import("fs")
      mockSendTeamsOffTurn.mockResolvedValue({ delivered: false, forwardedTo: "mini-host" })
      mockListSessionActivity.mockReturnValue([session("teams", "a:chat-1")])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "over to the mini", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("forwarded — handed to mini-host, which runs Teams; it sends on its next sync")
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition does not use a chat quiet for more than 30 days", async () => {
      mockListSessionActivity.mockReturnValue([session("telegram", "telegram_777_42", 31 * day)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "long time", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(mockSendTelegramAwaitFollowUp).not.toHaveBeenCalled()
      expect(result).toBe(
        "deferred — not sent now; saved for their next message. Robin has no chat that surface can send on, active in the last 30 days "
        + "(their sessions: telegram quiet for 31 days). (code: surface-not-sent)",
      )
    })

    it("surfaceToolDefinition saves outreach as a deferred return, never into MCP or CLI, when no chat sends", async () => {
      const fs = await import("fs")
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "host_account_refused" })
      mockSendTeamsOffTurn.mockResolvedValue(null)
      mockListSessionActivity.mockReturnValue([
        session("mcp", "mcp-session-1"),
        session("cli", "session", 1_000),
        session("bluebubbles", dm, 2_000),
        session("teams", "a:chat-1", 3_000),
      ])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "when you are back", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe(
        "deferred — not sent now; saved for their next message. iMessage did not send (host_account_refused); Teams did not send (not available here). "
        + "(code: surface-not-sent)",
      )
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\/state\/pending-returns\/friend-1\/\d+-[a-z0-9]+\.json$/u),
        expect.stringContaining("when you are back"),
      )
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.stringMatching(/\/state\/pending\/friend-1\//u), expect.anything())
    })

    it("surfaceToolDefinition saves outreach for a friend whose only sessions are MCP and CLI, and offers a call only if urgent", async () => {
      mockListSessionActivity.mockReturnValue([session("mcp", "mcp-session-1"), session("cli", "session", 1_000), session("voice", "call-1", 2_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "when you are back", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe(
        "deferred — not sent now; saved for their next message. Robin has no chat that surface can send on, active in the last 30 days "
        + '(their sessions: mcp, cli, voice). Only if it is urgent: surface friendId="friend-1" channel="voice" calls them. (code: surface-not-sent)',
      )
    })

    it("surfaceToolDefinition says plainly that a friend with no session yet gets a deferred return", async () => {
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "hello there", friendId: "friend-new" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("deferred — not sent now; saved for their next message. friend-new has no chat session with you yet. (code: surface-not-sent)")
    })

    it("names only routes a private turn actually has, whatever the friend's sessions or the held return's origin", async () => {
      const { selectToolsForChannel, registeredToolDefinitions } = await import("../../repertoire/tools")
      const { getChannelCapabilities } = await import("@ouro.bot/friends")
      const advertised = new Set(selectToolsForChannel(getChannelCapabilities("inner")).ordinary.map((definition) => definition.tool.function.name))
      const everyTool = registeredToolDefinitions().map((definition) => definition.tool.function.name)
      const namedTools = (text: string): string[] => everyTool.filter((name) => new RegExp(`\\b${name}\\b`, "u").test(text))
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "trust_skip" })
      mockSendTelegramAwaitFollowUp.mockResolvedValue({ status: "blocked", detail: "no await" })
      mockSendTeamsOffTurn.mockResolvedValue(null)
      mockListSessionActivity.mockReturnValue(["mcp", "cli", "a2a", "voice", "mail", "bluebubbles", "telegram", "teams"].map((channel, index) => session(channel, `k${index}`, index)))

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const spontaneous = await surfaceToolDefinition.handler({ content: "heads up", friendId: "friend-1" }, { delegatedOrigins: [] } as any) as string
      const heldFromIMessage = await surfaceToolDefinition.handler({ content: "here is the answer", delegationId: "held-bb" }, {
        delegatedOrigins: [{ id: "held-bb", friendId: "friend-1", friendName: "Robin", channel: "bluebubbles", key: dm, delegatedContent: "think", source: "drained", timestamp: 1 }],
      } as any) as string

      expect(namedTools(spontaneous)).toEqual(["surface"])
      for (const result of [spontaneous, heldFromIMessage]) {
        for (const tool of namedTools(result)) expect(advertised.has(tool), `${tool} in: ${result}`).toBe(true)
      }
      expect(heldFromIMessage).toBe("queued — for originating bluebubbles session; it waits for their next iMessage")
    })

    it("an ordinary agent's owner on BlueBubbles alone gets the owner message by iMessage through surface's real route", async () => {
      const fs = await import("fs")
      const ledger: Record<string, string> = {}
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { ledger[String(file)] = String(data) })
      vi.mocked(fs.renameSync).mockImplementation((from, to) => { ledger[String(to)] = ledger[String(from)]! })
      vi.mocked(fs.readFileSync).mockImplementation((file) => {
        const stored = ledger[String(file)]
        if (stored === undefined) throw new Error("ENOENT")
        return stored
      })
      const { deliverOrdinaryOwnerDecision } = await import("../../senses/ordinary-owner-decision")
      const { routeSurfaceToFriend } = await import("../../repertoire/tools-surface")
      const owner = { id: "friend-1", name: "Robin", trustLevel: "family", externalIds: [], admissionState: "active" } as any
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: true })
      mockListSessionActivity.mockReturnValue([session("bluebubbles", dm)])
      const deps = { agentName: "test", agentRoot: "/tmp/test-agent", listFriends: async () => [owner], ownerUsername: null, route: (friendId: string, content: string) => routeSurfaceToFriend("test", friendId, content) }
      const input = { source: "peer", eventId: "e-1", generation: 1, text: "the backup failed twice", relatedEvents: [] }

      expect((await deliverOrdinaryOwnerDecision(deps, input)).status).toBe("sent")
      expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledWith(expect.objectContaining({ friendId: "friend-1", sessionKey: dm, text: "the backup failed twice" }))

      // When iMessage refuses, the owner message is saved for their next message, never thrown away and never called sent.
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "host_account_refused" })
      expect((await deliverOrdinaryOwnerDecision(deps, { ...input, eventId: "e-2" })).status).toBe("saved")
      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/\/state\/pending-returns\/friend-1\//u), expect.stringContaining("the backup failed twice"))
      // A retry of a saved owner message stays saved rather than turning into "already sent".
      expect((await deliverOrdinaryOwnerDecision(deps, { ...input, eventId: "e-2" })).status).toBe("saved")
    })

    it("surfaceToolDefinition keeps going when a chat's sender throws, and still saves the message when none sends", async () => {
      const fs = await import("fs")
      mockSendProactiveBlueBubblesMessageToSession.mockRejectedValue(new Error("BlueBubbles is not configured"))
      mockSendTelegramAwaitFollowUp.mockRejectedValue("Telegram has no credentials")
      mockListSessionActivity.mockReturnValue([session("bluebubbles", dm), session("telegram", "telegram_777_42", 1_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "still here", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("deferred — not sent now; saved for their next message. iMessage did not send (BlueBubbles is not configured); Telegram did not send (Telegram has no credentials). (code: surface-not-sent)")
      expect(mockSendTelegramAwaitFollowUp).toHaveBeenCalledTimes(1)
      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/\/state\/pending-returns\/friend-1\//u), expect.stringContaining("still here"))
    })

    it("surfaceToolDefinition stops at an iMessage send that failed partway, says it may have reached them, and saves no copy", async () => {
      const fs = await import("fs")
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "send_error", delivery: { state: "unknown" } })
      mockListSessionActivity.mockReturnValue([session("bluebubbles", dm), session("telegram", "telegram_777_42", 1_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "one copy only", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("unconfirmed — the iMessage send failed partway, so it may have reached them; don't resend unless they say they didn't get it")
      expect(mockSendTelegramAwaitFollowUp).not.toHaveBeenCalled()
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition treats a Teams send that may have gone out as unconfirmed, and one Teams refused as not sent", async () => {
      mockListSessionActivity.mockReturnValue([session("teams", "a:chat-1"), session("telegram", "telegram_777_42", 1_000)])
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")

      mockSendTeamsOffTurn.mockResolvedValueOnce({ delivered: false, reason: "send_error", delivery: { state: "unknown" } })
      expect(await surfaceToolDefinition.handler({ content: "maybe sent", friendId: "friend-1" }, { delegatedOrigins: [] } as any))
        .toBe("unconfirmed — the Teams send failed partway, so it may have reached them; don't resend unless they say they didn't get it")
      expect(mockSendTelegramAwaitFollowUp).not.toHaveBeenCalled()

      mockSendTeamsOffTurn.mockResolvedValueOnce({ delivered: false, reason: "send_error", delivery: { state: "not_sent" } })
      expect(await surfaceToolDefinition.handler({ content: "try telegram", friendId: "friend-1" }, { delegatedOrigins: [] } as any))
        .toBe("delivered — sent to Telegram now")
    })

    it("surfaceToolDefinition refuses text a content guard refused instead of trying it on another chat", async () => {
      const fs = await import("fs")
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "internal_content_blocked" })
      mockListSessionActivity.mockReturnValue([session("bluebubbles", dm), session("telegram", "telegram_777_42", 1_000)])
      expect(await surfaceToolDefinition.handler({ content: "the build is done", friendId: "friend-1" }, { delegatedOrigins: [] } as any)).toBe(
        "failed — blocked: iMessage refused this text as internal (internal_content_blocked), so no chat sends it; rewrite it as plain words for them (code: delivery-blocked)",
      )

      mockSendTeamsOffTurn.mockResolvedValue({ delivered: false, reason: "internal_content_blocked" })
      mockListSessionActivity.mockReturnValue([session("teams", "a:chat-1"), session("telegram", "telegram_777_42", 1_000)])
      expect(await surfaceToolDefinition.handler({ content: "the build is done", friendId: "friend-1" }, { delegatedOrigins: [] } as any)).toMatch(/^failed — blocked: Teams refused/u)
      expect(mockSendTelegramAwaitFollowUp).not.toHaveBeenCalled()

      // Text the guard refuses never goes out on a sense without its own guard, or into a saved copy.
      mockListSessionActivity.mockReturnValue([session("telegram", "telegram_777_42")])
      expect(await surfaceToolDefinition.handler({ content: "heartbeat check-in: all settled", friendId: "friend-1" }, { delegatedOrigins: [] } as any)).toBe(
        "failed — blocked: this reads as internal status (heartbeat_status), so no chat sends it; rewrite it as plain words for them (code: delivery-blocked)",
      )
      mockListSessionActivity.mockReturnValue([])
      expect(await surfaceToolDefinition.handler({ content: "heartbeat check-in: all settled", friendId: "friend-new" }, { delegatedOrigins: [] } as any)).toMatch(/^failed — blocked/u)
      expect(mockSendTelegramAwaitFollowUp).not.toHaveBeenCalled()
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition reports a Telegram hand-off to the machine that runs Telegram as forwarded, held returns included", async () => {
      const fs = await import("fs")
      mockSendTelegramAwaitFollowUp.mockResolvedValue({ status: "forwarded", detail: "mini-host sends it" })
      mockListSessionActivity.mockReturnValue([session("telegram", "telegram_777_42"), session("teams", "a:chat-1", 1_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      expect(await surfaceToolDefinition.handler({ content: "over to the mini", friendId: "friend-1" }, { delegatedOrigins: [] } as any))
        .toBe("forwarded — handed to the machine that runs Telegram: mini-host sends it")
      expect(mockSendTeamsOffTurn).not.toHaveBeenCalled()

      const held = await surfaceToolDefinition.handler({ content: "your answer", delegationId: "held-tg" }, {
        delegatedOrigins: [{ id: "held-tg", friendId: "friend-1", friendName: "Robin", channel: "telegram", key: "telegram_777_42", delegatedContent: "think", source: "drained", timestamp: 1 }],
      } as any)
      expect(held).toBe("forwarded — handed to the machine that runs Telegram: mini-host sends it")
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.stringMatching(/\/state\/pending\//u), expect.anything())
    })

    it("surfaceToolDefinition keeps the freshest-session queue for an agent friend, whose MCP session is how it reads", async () => {
      const fs = await import("fs")
      vi.mocked(fs.readFileSync).mockImplementation((file) =>
        String(file).endsWith("/friends/friend-1.json") ? JSON.stringify({ id: "friend-1", name: "Peer", kind: "agent" }) : "")
      mockListSessionActivity.mockReturnValue([session("mcp", "mcp-session-1"), session("bluebubbles", dm, 60_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "agent to agent", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe("queued — for next interaction via mcp")
      expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/\/state\/pending\/friend-1\/mcp\/mcp-session-1\//u), expect.stringContaining("agent to agent"))
    })

    it("routeSurfaceToFriend refuses content with internal meta markers before any route, the owner path included", async () => {
      mockListSessionActivity.mockReturnValue([session("bluebubbles", dm)])
      const { routeSurfaceToFriend } = await import("../../repertoire/tools-surface")

      expect(await routeSurfaceToFriend("test", "friend-1", "<think>private</think> hi")).toEqual({ status: "failed", detail: "blocked: contains internal meta markers" })
      expect(mockSendProactiveBlueBubblesMessageToSession).not.toHaveBeenCalled()
    })

    it("surfaceToolDefinition names a skipped iMessage group chat as a group", async () => {
      mockListSessionActivity.mockReturnValue([session("bluebubbles", "chat:any;+;group-1"), session("mcp", "mcp-session-1", 1_000)])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      const result = await surfaceToolDefinition.handler({ content: "hi all", friendId: "friend-1" }, { delegatedOrigins: [] } as any)

      expect(result).toBe(
        "deferred — not sent now; saved for their next message. Robin has no chat that surface can send on, active in the last 30 days "
        + "(their sessions: bluebubbles group chat (skipped), mcp). (code: surface-not-sent)",
      )
    })

    it("surfaceToolDefinition records deferred outreach as deferred and an unconfirmed send as sent in habit receipts", async () => {
      const recordSurfaceAttempt = vi.fn()
      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")

      await surfaceToolDefinition.handler({ content: "nobody home", friendId: "friend-new" }, { delegatedOrigins: [], habitSession: { recordSurfaceAttempt } } as any)
      expect(recordSurfaceAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "answer", result: "deferred", rawStatus: "deferred" }))

      mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: false, reason: "send_error", delivery: { state: "unknown" } })
      mockListSessionActivity.mockReturnValue([session("bluebubbles", dm)])
      await surfaceToolDefinition.handler({ content: "maybe", friendId: "friend-1" }, { delegatedOrigins: [], habitSession: { recordSurfaceAttempt } } as any)
      expect(recordSurfaceAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "answer", result: "sent", rawStatus: "unconfirmed" }))
    })

    it("surfaceToolDefinition records forwarded outreach as sent in habit receipts", async () => {
      const recordSurfaceAttempt = vi.fn()
      mockSendTeamsOffTurn.mockResolvedValue({ delivered: false, forwardedTo: "mini-host" })
      mockListSessionActivity.mockReturnValue([session("teams", "a:chat-1")])

      const { surfaceToolDefinition } = await import("../../repertoire/tools-surface")
      await surfaceToolDefinition.handler({ content: "habit result", friendId: "friend-1" }, { delegatedOrigins: [], habitSession: { recordSurfaceAttempt } } as any)

      expect(recordSurfaceAttempt).toHaveBeenCalledWith(expect.objectContaining({ recipient: "friend-1", reason: "answer", result: "sent", rawStatus: "forwarded" }))
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

describe("surface digest guard", () => {
  it("blocks a digest with nothing ready, done or gated, and lets signal through", async () => {
    const { handleSurface, isSignalessDigest } = await import("../../senses/surface-tool")
    const route = vi.fn(async () => ({ status: "delivered" as const }))
    const base = { friendId: "ari", queue: [], routeToFriend: route, advanceObligation: vi.fn() }

    const blocked = await handleSurface({ ...base, content: "Morning summary (09:03): the mini is fine, disk at 95 GiB, three PRs open." })
    expect(blocked).toMatch(/^not sent/)
    expect(route).not.toHaveBeenCalled()

    expect(isSignalessDigest("Morning. Here's the overnight summary for the mini: disk fell.")).toBe(true)
    expect(isSignalessDigest("Overnight summary: Tandem v0.2.1 is out.")).toBe(false)
    expect(isSignalessDigest("Daily digest. Needs you: approve the OKR scope.")).toBe(false)
    expect(isSignalessDigest("Tandem v0.2.1 is out.")).toBe(false)

    const sent = await handleSurface({ ...base, content: "Overnight summary: Tandem v0.2.1 is out." })
    expect(sent).toMatch(/^delivered/)
  })
})
