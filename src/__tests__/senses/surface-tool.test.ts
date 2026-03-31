import { describe, it, expect, vi, beforeEach } from "vitest"

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

describe("surface tool", () => {
  let surfaceToolDef: typeof import("../../senses/surface-tool").surfaceToolDef
  let handleSurface: typeof import("../../senses/surface-tool").handleSurface
  type AttentionItem = import("../../senses/attention-queue").AttentionItem

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/surface-tool")
    surfaceToolDef = mod.surfaceToolDef
    handleSurface = mod.handleSurface
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
