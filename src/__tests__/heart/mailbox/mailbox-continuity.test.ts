import { describe, expect, it, vi } from "vitest"

// Mock continuity stores
const mockReadPresence = vi.fn()
const mockReadPeerPresence = vi.fn()
const mockReadActiveCares = vi.fn()
const mockReadRecentEpisodes = vi.fn()

vi.mock("../../../arc/presence", () => ({
  readPresence: (...args: any[]) => mockReadPresence(...args),
  readPeerPresence: (...args: any[]) => mockReadPeerPresence(...args),
}))

vi.mock("../../../arc/cares", () => ({
  readActiveCares: (...args: any[]) => mockReadActiveCares(...args),
}))

vi.mock("../../../arc/episodes", () => ({
  readRecentEpisodes: (...args: any[]) => mockReadRecentEpisodes(...args),
}))

describe("mailbox continuity types", () => {
  it("MailboxPresenceView interface is exported", async () => {
    const types = await import("../../../heart/mailbox/mailbox-types")
    // Type check: the interface should exist (we import and use it)
    const view: import("../../../heart/mailbox/mailbox-types").MailboxPresenceView = {
      self: null,
      peers: [],
    }
    expect(view.self).toBeNull()
    expect(view.peers).toEqual([])
  })

  it("MailboxCareSummary interface is exported", async () => {
    const _types = await import("../../../heart/mailbox/mailbox-types")
    const summary: import("../../../heart/mailbox/mailbox-types").MailboxCareSummary = {
      activeCount: 0,
      items: [],
    }
    expect(summary.activeCount).toBe(0)
  })

  it("MailboxEpisodeSummary interface is exported", async () => {
    const _types = await import("../../../heart/mailbox/mailbox-types")
    const summary: import("../../../heart/mailbox/mailbox-types").MailboxEpisodeSummary = {
      recentCount: 0,
      items: [],
    }
    expect(summary.recentCount).toBe(0)
  })
})

describe("mailbox continuity read", () => {
  it("readMailboxContinuity returns presence, cares, and episodes", async () => {
    const selfPresence = { agentName: "ouroboros", availability: "active", lane: "coding", tempo: "brief", updatedAt: "2026-04-02T10:00:00Z" }
    const peers = [{ agentName: "slugger", availability: "idle", lane: "thinking", tempo: "standard", updatedAt: "2026-04-02T09:00:00Z" }]
    const cares = [{ id: "c-1", label: "deploy health", status: "active", salience: "high", kind: "project" }]
    const episodes = [{ id: "ep-1", kind: "coding_milestone", summary: "deployed v2", timestamp: "2026-04-02T10:00:00Z", salience: "medium", relatedEntities: [], whyItMattered: "milestone" }]

    mockReadPresence.mockReturnValue(selfPresence)
    mockReadPeerPresence.mockReturnValue(peers)
    mockReadActiveCares.mockReturnValue(cares)
    mockReadRecentEpisodes.mockReturnValue(episodes)

    const { readMailboxContinuity } = await import("../../../heart/mailbox/readers/continuity-readers")
    const result = readMailboxContinuity("/mock/agent-root", "ouroboros")

    expect(result.presence.self).toEqual(selfPresence)
    expect(result.presence.peers).toHaveLength(1)
    expect(result.cares.activeCount).toBe(1)
    expect(result.episodes.recentCount).toBe(1)
  })

  it("returns empty state when no continuity data exists", async () => {
    mockReadPresence.mockReturnValue(null)
    mockReadPeerPresence.mockReturnValue([])
    mockReadActiveCares.mockReturnValue([])
    mockReadRecentEpisodes.mockReturnValue([])

    const { readMailboxContinuity } = await import("../../../heart/mailbox/readers/continuity-readers")
    const result = readMailboxContinuity("/mock/agent-root", "ouroboros")

    expect(result.presence.self).toBeNull()
    expect(result.presence.peers).toEqual([])
    expect(result.cares.activeCount).toBe(0)
    expect(result.episodes.recentCount).toBe(0)
  })
})
