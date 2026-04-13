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

describe("attention queue", () => {
  let buildAttentionQueue: typeof import("../../senses/attention-queue").buildAttentionQueue
  let dequeueAttentionItem: typeof import("../../senses/attention-queue").dequeueAttentionItem
  let attentionQueueEmpty: typeof import("../../senses/attention-queue").attentionQueueEmpty
  let buildAttentionQueueSummary: typeof import("../../senses/attention-queue").buildAttentionQueueSummary
  type AttentionItem = import("../../senses/attention-queue").AttentionItem
  type PendingMessage = import("../../mind/pending").PendingMessage

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../senses/attention-queue")
    buildAttentionQueue = mod.buildAttentionQueue
    dequeueAttentionItem = mod.dequeueAttentionItem
    attentionQueueEmpty = mod.attentionQueueEmpty
    buildAttentionQueueSummary = mod.buildAttentionQueueSummary
  })

  describe("buildAttentionQueue", () => {
    it("pushes delegated pending messages onto the queue", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think about penguins",
          timestamp: 1000,
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Ari",
      })

      expect(queue).toHaveLength(1)
      expect(queue[0].friendId).toBe("ari")
      expect(queue[0].friendName).toBe("Ari")
      expect(queue[0].channel).toBe("bluebubbles")
      expect(queue[0].key).toBe("chat-1")
      expect(queue[0].delegatedContent).toBe("think about penguins")
      expect(queue[0].source).toBe("drained")
    })

    it("does NOT push non-delegated messages (heartbeat, instinct)", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "heartbeat",
          timestamp: 1000,
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Unknown",
      })

      expect(queue).toHaveLength(0)
    })

    it("adds outstanding obligations from crash recovery", () => {
      const queue = buildAttentionQueue({
        drainedPending: [],
        outstandingObligations: [
          {
            id: "obl-1",
            origin: { friendId: "ben", channel: "teams", key: "session-2" },
            status: "running",
            delegatedContent: "review the deployment plan",
            createdAt: 500,
          },
        ],
        friendNameResolver: () => "Ben",
      })

      expect(queue).toHaveLength(1)
      expect(queue[0].friendId).toBe("ben")
      expect(queue[0].friendName).toBe("Ben")
      expect(queue[0].obligationId).toBe("obl-1")
      expect(queue[0].source).toBe("obligation-recovery")
    })

    it("deduplicates by origin (friendId + channel + key), prefers drained", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think about penguins",
          timestamp: 1000,
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
          obligationId: "obl-1",
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [
          {
            id: "obl-1",
            origin: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
            status: "running",
            delegatedContent: "think about penguins (stale)",
            createdAt: 500,
          },
        ],
        friendNameResolver: () => "Ari",
      })

      expect(queue).toHaveLength(1)
      expect(queue[0].source).toBe("drained")
      expect(queue[0].delegatedContent).toBe("think about penguins")
    })

    it("produces multiple queue items ordered FIFO (oldest first)", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "second thought",
          timestamp: 2000,
          delegatedFrom: { friendId: "ben", channel: "teams", key: "session-2" },
        },
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "first thought",
          timestamp: 1000,
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: (id) => id === "ari" ? "Ari" : "Ben",
      })

      expect(queue).toHaveLength(2)
      expect(queue[0].friendName).toBe("Ari") // oldest first
      expect(queue[1].friendName).toBe("Ben")
    })

    it("each queue item gets a stable id", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think",
          timestamp: 1000,
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Ari",
      })

      expect(queue[0].id).toBeTruthy()
      expect(typeof queue[0].id).toBe("string")
    })

    it("uses obligationId as item id when available", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think",
          timestamp: 1000,
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
          obligationId: "my-obligation-id",
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Ari",
      })

      expect(queue[0].id).toBe("my-obligation-id")
    })

    it("enriches items with linked packet metadata when available", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think",
          timestamp: 1000,
          packetId: "pkt-1",
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
          obligationId: "my-obligation-id",
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Ari",
        packetResolver: () => ({
          id: "pkt-1",
          kind: "harness_friction",
          sop: "harness_friction_v1",
          status: "drafting",
          objective: "Fix image retry behavior",
          summary: "Shared attachment repair work",
          successCriteria: ["No more dead-ends"],
          payload: {},
          createdAt: 1,
          updatedAt: 1,
        }),
      })

      expect(queue[0].packetId).toBe("pkt-1")
      expect(queue[0].packetKind).toBe("harness_friction")
      expect(queue[0].packetObjective).toBe("Fix image retry behavior")
    })

    it("keeps a packet id even when the resolver cannot currently load the packet", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think",
          timestamp: 1000,
          packetId: "pkt-missing",
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1" },
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Ari",
        packetResolver: () => null,
      })

      expect(queue[0].packetId).toBe("pkt-missing")
      expect(queue[0].packetKind).toBeUndefined()
    })

    it("falls back to friendId when name unavailable", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "think",
          timestamp: 1000,
          delegatedFrom: { friendId: "unknown-uuid", channel: "bluebubbles", key: "chat-1" },
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => null,
      })

      expect(queue[0].friendName).toBe("unknown-uuid")
    })

    it("includes bridgeId in drained items when present", () => {
      const drained: PendingMessage[] = [
        {
          from: "test",
          friendId: "self",
          channel: "inner",
          key: "dialog",
          content: "bridged thought",
          timestamp: 1000,
          delegatedFrom: { friendId: "ari", channel: "bluebubbles", key: "chat-1", bridgeId: "bridge-99" },
        },
      ]

      const queue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations: [],
        friendNameResolver: () => "Ari",
      })

      expect(queue).toHaveLength(1)
      expect(queue[0].bridgeId).toBe("bridge-99")
    })

    it("includes bridgeId in obligation-recovery items when present", () => {
      const queue = buildAttentionQueue({
        drainedPending: [],
        outstandingObligations: [
          {
            id: "obl-2",
            origin: { friendId: "ben", channel: "teams", key: "session-3", bridgeId: "bridge-77" },
            status: "running",
            delegatedContent: "check the pipeline",
            createdAt: 600,
          },
        ],
        friendNameResolver: () => "Ben",
      })

      expect(queue).toHaveLength(1)
      expect(queue[0].bridgeId).toBe("bridge-77")
      expect(queue[0].source).toBe("obligation-recovery")
    })

    it("falls back to friendId for obligation-recovery items when name unavailable", () => {
      const queue = buildAttentionQueue({
        drainedPending: [],
        outstandingObligations: [
          {
            id: "obl-3",
            origin: { friendId: "unknown-friend-id", channel: "cli", key: "session-x" },
            status: "queued",
            delegatedContent: "orphaned thought",
            createdAt: 700,
          },
        ],
        friendNameResolver: () => null,
      })

      expect(queue).toHaveLength(1)
      expect(queue[0].friendName).toBe("unknown-friend-id")
      expect(queue[0].source).toBe("obligation-recovery")
    })
  })

  describe("dequeueAttentionItem", () => {
    it("removes and returns item with matching id", () => {
      const items: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
        { id: "def456", friendId: "ben", friendName: "Ben", channel: "teams", key: "s1", delegatedContent: "review", source: "drained", timestamp: 2000 },
      ]

      const result = dequeueAttentionItem(items, "abc123")
      expect(result).toBeDefined()
      expect(result!.id).toBe("abc123")
      expect(items).toHaveLength(1)
      expect(items[0].id).toBe("def456")
    })

    it("returns null for unknown id", () => {
      const items: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
      ]

      const result = dequeueAttentionItem(items, "nonexistent")
      expect(result).toBeNull()
      expect(items).toHaveLength(1)
    })
  })

  describe("attentionQueueEmpty", () => {
    it("returns true for empty queue", () => {
      expect(attentionQueueEmpty([])).toBe(true)
    })

    it("returns false for non-empty queue", () => {
      const items: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think", source: "drained", timestamp: 1000 },
      ]
      expect(attentionQueueEmpty(items)).toBe(false)
    })
  })

  describe("buildAttentionQueueSummary", () => {
    it("formats queue items with IDs and friend names", () => {
      const items: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "think about penguins", source: "drained", timestamp: 1000 },
        { id: "def456", friendId: "ben", friendName: "Ben", channel: "teams", key: "s1", delegatedContent: "review the deployment plan", source: "drained", timestamp: 2000 },
      ]

      const summary = buildAttentionQueueSummary(items)
      expect(summary).toContain("[internal: held work items")
      expect(summary).not.toContain("you're holding:")
      expect(summary).toContain("[abc123]")
      expect(summary).toContain("Ari asked:")
      expect(summary).toContain("think about penguins")
      expect(summary).toContain("[def456]")
      expect(summary).toContain("Ben asked:")
      expect(summary).toContain("review the deployment plan")
    })

    it("prefers packet kind and objective when available", () => {
      const items: AttentionItem[] = [
        {
          id: "pkt-1",
          friendId: "ari",
          friendName: "Ari",
          channel: "bb",
          key: "c1",
          delegatedContent: "think about penguins",
          packetId: "pkt-1",
          packetKind: "harness_friction",
          packetObjective: "Fix image retry behavior",
          source: "drained",
          timestamp: 1000,
        },
      ]

      const summary = buildAttentionQueueSummary(items)
      expect(summary).toContain("Ari -> harness_friction: Fix image retry behavior")
      expect(summary).not.toContain("asked:")
    })

    it("returns empty string for empty queue", () => {
      expect(buildAttentionQueueSummary([])).toBe("")
    })

    it("truncates long content", () => {
      const items: AttentionItem[] = [
        { id: "abc123", friendId: "ari", friendName: "Ari", channel: "bb", key: "c1", delegatedContent: "a".repeat(200), source: "drained", timestamp: 1000 },
      ]

      const summary = buildAttentionQueueSummary(items)
      expect(summary.length).toBeLessThan(300)
      expect(summary).toContain("...")
    })
  })
})
