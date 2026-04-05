import { describe, expect, it, vi } from "vitest"

// Mock continuity stores
const mockReadPresence = vi.fn()
const mockReadPeerPresence = vi.fn()
const mockReadActiveCares = vi.fn()
const mockReadRecentEpisodes = vi.fn()

vi.mock("../../../heart/presence", () => ({
  readPresence: (...args: any[]) => mockReadPresence(...args),
  readPeerPresence: (...args: any[]) => mockReadPeerPresence(...args),
}))

vi.mock("../../../heart/cares", () => ({
  readActiveCares: (...args: any[]) => mockReadActiveCares(...args),
}))

vi.mock("../../../mind/episodes", () => ({
  readRecentEpisodes: (...args: any[]) => mockReadRecentEpisodes(...args),
}))

describe("outlook continuity types", () => {
  it("OutlookPresenceView interface is exported", async () => {
    const types = await import("../../../heart/outlook/outlook-types")
    // Type check: the interface should exist (we import and use it)
    const view: import("../../../heart/outlook/outlook-types").OutlookPresenceView = {
      self: null,
      peers: [],
    }
    expect(view.self).toBeNull()
    expect(view.peers).toEqual([])
  })

  it("OutlookCareSummary interface is exported", async () => {
    const _types = await import("../../../heart/outlook/outlook-types")
    const summary: import("../../../heart/outlook/outlook-types").OutlookCareSummary = {
      activeCount: 0,
      items: [],
    }
    expect(summary.activeCount).toBe(0)
  })

  it("OutlookEpisodeSummary interface is exported", async () => {
    const _types = await import("../../../heart/outlook/outlook-types")
    const summary: import("../../../heart/outlook/outlook-types").OutlookEpisodeSummary = {
      recentCount: 0,
      items: [],
    }
    expect(summary.recentCount).toBe(0)
  })
})

describe("outlook continuity read", () => {
  it("readOutlookContinuity returns presence, cares, and episodes", async () => {
    const selfPresence = { agentName: "ouroboros", availability: "active", lane: "coding", tempo: "brief", updatedAt: "2026-04-02T10:00:00Z" }
    const peers = [{ agentName: "slugger", availability: "idle", lane: "thinking", tempo: "standard", updatedAt: "2026-04-02T09:00:00Z" }]
    const cares = [{ id: "c-1", label: "deploy health", status: "active", salience: "high", kind: "project" }]
    const episodes = [{ id: "ep-1", kind: "coding_milestone", summary: "deployed v2", timestamp: "2026-04-02T10:00:00Z", salience: "medium", relatedEntities: [], whyItMattered: "milestone" }]

    mockReadPresence.mockReturnValue(selfPresence)
    mockReadPeerPresence.mockReturnValue(peers)
    mockReadActiveCares.mockReturnValue(cares)
    mockReadRecentEpisodes.mockReturnValue(episodes)

    const { readOutlookContinuity } = await import("../../../heart/outlook/outlook-read")
    const result = readOutlookContinuity("/mock/agent-root", "ouroboros")

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

    const { readOutlookContinuity } = await import("../../../heart/outlook/outlook-read")
    const result = readOutlookContinuity("/mock/agent-root", "ouroboros")

    expect(result.presence.self).toBeNull()
    expect(result.presence.peers).toEqual([])
    expect(result.cares.activeCount).toBe(0)
    expect(result.episodes.recentCount).toBe(0)
  })
})
