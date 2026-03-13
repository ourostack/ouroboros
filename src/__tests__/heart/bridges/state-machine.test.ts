import { describe, expect, it } from "vitest"

describe("bridge state machine", () => {
  it("walks the approved lifecycle and queued follow-up runtime states", async () => {
    const bridges = await import("../../../heart/bridges/state-machine")

    let state = bridges.createBridgeState()
    expect(bridges.bridgeStateLabel(state)).toBe("forming")

    state = bridges.activateBridge(state)
    expect(bridges.bridgeStateLabel(state)).toBe("active-idle")

    state = bridges.beginBridgeProcessing(state)
    expect(bridges.bridgeStateLabel(state)).toBe("active-processing")

    state = bridges.queueBridgeFollowUp(state)
    expect(bridges.bridgeStateLabel(state)).toBe("awaiting-follow-up")

    state = bridges.advanceBridgeAfterTurn(state)
    expect(bridges.bridgeStateLabel(state)).toBe("active-processing")

    state = bridges.advanceBridgeAfterTurn(state)
    expect(bridges.bridgeStateLabel(state)).toBe("active-idle")

    state = bridges.suspendBridge(state)
    expect(bridges.bridgeStateLabel(state)).toBe("suspended")

    state = bridges.activateBridge(state)
    expect(bridges.bridgeStateLabel(state)).toBe("active-idle")

    state = bridges.completeBridge(state)
    expect(bridges.bridgeStateLabel(state)).toBe("completed")
  })

  it("rejects invalid transitions once a bridge is terminal", async () => {
    const bridges = await import("../../../heart/bridges/state-machine")

    const completed = bridges.completeBridge(bridges.activateBridge(bridges.createBridgeState()))
    expect(() => bridges.beginBridgeProcessing(completed)).toThrow("cannot process")
    expect(() => bridges.queueBridgeFollowUp(completed)).toThrow("cannot queue")

    const cancelled = bridges.cancelBridge(bridges.activateBridge(bridges.createBridgeState()))
    expect(() => bridges.activateBridge(cancelled)).toThrow("cannot activate")
  })

  it("rejects invalid non-terminal transitions", async () => {
    const bridges = await import("../../../heart/bridges/state-machine")

    expect(() => bridges.activateBridge(bridges.activateBridge(bridges.createBridgeState()))).toThrow("cannot activate")
    expect(() => bridges.beginBridgeProcessing(bridges.createBridgeState())).toThrow("cannot process")
    expect(() => bridges.queueBridgeFollowUp(bridges.createBridgeState())).toThrow("cannot queue")
    expect(() => bridges.queueBridgeFollowUp(bridges.activateBridge(bridges.createBridgeState()))).toThrow("cannot queue")
    expect(() => bridges.advanceBridgeAfterTurn(bridges.createBridgeState())).toThrow("cannot advance")
    expect(() => bridges.advanceBridgeAfterTurn(bridges.activateBridge(bridges.createBridgeState()))).toThrow("cannot advance")
    expect(() => bridges.suspendBridge(bridges.beginBridgeProcessing(bridges.activateBridge(bridges.createBridgeState())))).toThrow("cannot suspend")
    expect(() => bridges.completeBridge(bridges.beginBridgeProcessing(bridges.activateBridge(bridges.createBridgeState())))).toThrow("cannot complete")
    expect(() => bridges.cancelBridge(bridges.beginBridgeProcessing(bridges.activateBridge(bridges.createBridgeState())))).toThrow("cannot cancel")
    const awaiting = bridges.queueBridgeFollowUp(
      bridges.beginBridgeProcessing(bridges.activateBridge(bridges.createBridgeState())),
    )
    expect(bridges.queueBridgeFollowUp(awaiting)).toBe(awaiting)
  })
})
