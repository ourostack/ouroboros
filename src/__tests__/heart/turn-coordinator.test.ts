import { describe, it, expect } from "vitest"

describe("turn coordinator", () => {
  it("serializes turn execution for the same conversation key", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()
    const order: string[] = []
    let callCount = 0

    await Promise.all([
      coordinator.withTurnLock("teams:conv-1", async () => {
        const id = callCount++
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${id}`)
      }),
      coordinator.withTurnLock("teams:conv-1", async () => {
        const id = callCount++
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${id}`)
      }),
    ])

    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1"])
  })

  it("allows parallel turn execution for different conversation keys", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()
    const order: string[] = []

    await Promise.all([
      coordinator.withTurnLock("teams:conv-1", async () => {
        order.push("start-1")
        await new Promise((r) => setTimeout(r, 10))
        order.push("end-1")
      }),
      coordinator.withTurnLock("teams:conv-2", async () => {
        order.push("start-2")
        await new Promise((r) => setTimeout(r, 10))
        order.push("end-2")
      }),
    ])

    expect(order[0]).toBe("start-1")
    expect(order[1]).toBe("start-2")
  })

  it("preserves steering follow-ups as ordered discrete messages", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()
    const key = "teams:conv-order"

    coordinator.enqueueFollowUp(key, { conversationId: "conv-order", text: "step 1", receivedAt: 1, effect: "none" })
    coordinator.enqueueFollowUp(key, { conversationId: "conv-order", text: "step 2", receivedAt: 2, effect: "none" })
    coordinator.enqueueFollowUp(key, { conversationId: "conv-order", text: "step 3", receivedAt: 3, effect: "none" })

    const drained = coordinator.drainFollowUps(key)
    expect(drained.map((m) => m.text)).toEqual(["step 1", "step 2", "step 3"])
    expect(drained.map((m) => m.conversationId)).toEqual(["conv-order", "conv-order", "conv-order"])
  })

  it("keeps buffered follow-ups available across turn boundaries until drained", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()
    const key = "teams:conv-carry"

    await coordinator.withTurnLock(key, async () => {
      coordinator.enqueueFollowUp(key, { conversationId: "conv-carry", text: "carry me", receivedAt: 1, effect: "none" })
    })

    const carried = coordinator.drainFollowUps(key)
    expect(carried).toHaveLength(1)
    expect(carried[0].text).toBe("carry me")

    const emptyAfterDrain = coordinator.drainFollowUps(key)
    expect(emptyAfterDrain).toEqual([])
  })

  it("does not dedupe steering follow-ups in this task scope", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()
    const key = "teams:conv-no-dedupe"

    coordinator.enqueueFollowUp(key, { conversationId: "conv-no-dedupe", text: "same", receivedAt: 1, effect: "none" })
    coordinator.enqueueFollowUp(key, { conversationId: "conv-no-dedupe", text: "same", receivedAt: 2, effect: "none" })

    const drained = coordinator.drainFollowUps(key)
    expect(drained).toHaveLength(2)
    expect(drained[0].text).toBe("same")
    expect(drained[1].text).toBe("same")
  })

  it("reports active turn state during execution", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()

    await coordinator.withTurnLock("teams:conv-active", async () => {
      expect(coordinator.isTurnActive("teams:conv-active")).toBe(true)
    })

    expect(coordinator.isTurnActive("teams:conv-active")).toBe(false)
  })

  it("tryBeginTurn blocks re-entry until endTurn releases the key", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()

    expect(coordinator.tryBeginTurn("teams:conv-manual")).toBe(true)
    expect(coordinator.tryBeginTurn("teams:conv-manual")).toBe(false)
    expect(coordinator.isTurnActive("teams:conv-manual")).toBe(true)

    coordinator.endTurn("teams:conv-manual")

    expect(coordinator.isTurnActive("teams:conv-manual")).toBe(false)
    expect(coordinator.tryBeginTurn("teams:conv-manual")).toBe(true)
  })

  it("continues processing future turns after a turn fails", async () => {
    const { createTurnCoordinator } = await import("../../heart/turn-coordinator")
    const coordinator = createTurnCoordinator()

    await expect(
      coordinator.withTurnLock("teams:conv-error", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    let ran = false
    await coordinator.withTurnLock("teams:conv-error", async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it("serializes shared turn locks by scoped key", async () => {
    const { withSharedTurnLock } = await import("../../heart/turn-coordinator")
    const order: string[] = []
    let callCount = 0

    await Promise.all([
      withSharedTurnLock("bluebubbles", "chat-1", async () => {
        const id = callCount++
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${id}`)
      }),
      withSharedTurnLock("bluebubbles", "chat-1", async () => {
        const id = callCount++
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${id}`)
      }),
    ])

    expect(order).toEqual(["start-0", "end-0", "start-1", "end-1"])
  })

  it("reports shared scoped activity for manual turn lifecycles", async () => {
    const { tryBeginSharedTurn, endSharedTurn, isSharedTurnActive } = await import("../../heart/turn-coordinator")

    expect(isSharedTurnActive("bridge", "bridge-1")).toBe(false)
    expect(tryBeginSharedTurn("bridge", "bridge-1")).toBe(true)
    expect(isSharedTurnActive("bridge", "bridge-1")).toBe(true)

    endSharedTurn("bridge", "bridge-1")

    expect(isSharedTurnActive("bridge", "bridge-1")).toBe(false)
  })
})
