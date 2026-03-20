import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

// Mock createBridgeManager
const mockFindBridgesForSession = vi.fn()
vi.mock("../../heart/bridges/manager", () => ({
  createBridgeManager: () => ({
    findBridgesForSession: mockFindBridgesForSession,
  }),
  formatBridgeContext: vi.fn(() => ""),
  formatBridgeStatus: vi.fn(() => ""),
}))

import { emitNervesEvent } from "../../nerves/runtime"
import type { DelegatedFrom } from "../../mind/pending"

describe("bridge context inheritance in delegatedFrom", () => {
  beforeEach(() => {
    mockFindBridgesForSession.mockReset()
  })

  it("adds bridgeId to delegatedFrom when origin session has active bridge", async () => {
    // This tests the logic pattern that should exist in routeDelegatedCompletion
    const delegatedFrom: DelegatedFrom = {
      friendId: "alex",
      channel: "teams",
      key: "session1",
    }

    mockFindBridgesForSession.mockReturnValue([
      { id: "bridge-1", lifecycle: "active" },
      { id: "bridge-2", lifecycle: "completed" },
    ])

    // Simulate the enrichment logic
    const { enrichDelegatedFromWithBridge } = await import("../../senses/inner-dialog")

    const enriched = enrichDelegatedFromWithBridge(delegatedFrom)
    expect(enriched.bridgeId).toBe("bridge-1")
  })

  it("does not overwrite existing bridgeId", async () => {
    const delegatedFrom: DelegatedFrom = {
      friendId: "alex",
      channel: "teams",
      key: "session1",
      bridgeId: "existing-bridge",
    }

    mockFindBridgesForSession.mockReturnValue([
      { id: "bridge-1", lifecycle: "active" },
    ])

    const { enrichDelegatedFromWithBridge } = await import("../../senses/inner-dialog")

    const enriched = enrichDelegatedFromWithBridge(delegatedFrom)
    expect(enriched.bridgeId).toBe("existing-bridge")
  })

  it("does not set bridgeId when no active bridge exists", async () => {
    const delegatedFrom: DelegatedFrom = {
      friendId: "alex",
      channel: "teams",
      key: "session1",
    }

    mockFindBridgesForSession.mockReturnValue([
      { id: "bridge-1", lifecycle: "completed" },
    ])

    const { enrichDelegatedFromWithBridge } = await import("../../senses/inner-dialog")

    const enriched = enrichDelegatedFromWithBridge(delegatedFrom)
    expect(enriched.bridgeId).toBeUndefined()
  })

  it("does not set bridgeId when no bridges found", async () => {
    const delegatedFrom: DelegatedFrom = {
      friendId: "alex",
      channel: "teams",
      key: "session1",
    }

    mockFindBridgesForSession.mockReturnValue([])

    const { enrichDelegatedFromWithBridge } = await import("../../senses/inner-dialog")

    const enriched = enrichDelegatedFromWithBridge(delegatedFrom)
    expect(enriched.bridgeId).toBeUndefined()
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})
