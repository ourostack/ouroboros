import { beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"

import {
  DaemonProcessManager,
  type DaemonManagedAgent,
} from "../../../heart/daemon/process-manager"

class MockChild extends EventEmitter {
  connected = true
  pid = 4321
  kill = vi.fn((_signal?: string) => {
    this.connected = false
    this.emit("exit", 0, null)
    return true
  })
  send = vi.fn(() => true)
}

describe("cooldown recovery", () => {
  const spawn = vi.fn()
  const now = vi.fn()
  const timers: Array<{ delay: number; cb: () => void }> = []

  const setTimeoutFn = vi.fn((cb: () => void, delay: number) => {
    timers.push({ delay, cb })
    return timers.length
  })
  const clearTimeoutFn = vi.fn()
  const agents: DaemonManagedAgent[] = [
    { name: "slugger", entry: "heart/agent-entry.js", channel: "inner-dialog", autoStart: true },
  ]

  beforeEach(() => {
    spawn.mockReset()
    now.mockReset()
    setTimeoutFn.mockClear()
    clearTimeoutFn.mockReset()
    timers.length = 0
  })

  it("schedules cooldown recovery after restart exhaustion", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      cooldownRecoveryMs: 30_000,
      maxCooldownRetries: 3,
    })

    await manager.startAgent("slugger")
    child.emit("exit", 1, null)

    // Should be crashed
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")

    // A cooldown timer should be scheduled
    // First timer is the cooldown (no restart timer was scheduled since maxRestartsPerHour was 0)
    const cooldownTimer = timers.find((t) => t.delay === 30_000)
    expect(cooldownTimer).toBeDefined()
  })

  it("recovery attempt resets crash history and restarts agent", async () => {
    const first = new MockChild()
    const second = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      cooldownRecoveryMs: 30_000,
      maxCooldownRetries: 3,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)

    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")

    // Fire the cooldown timer
    const cooldownTimer = timers.find((t) => t.delay === 30_000)
    cooldownTimer!.cb()

    // Should attempt restart
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("stops recovery after maxCooldownRetries exhausted", async () => {
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      cooldownRecoveryMs: 10_000,
      maxCooldownRetries: 2,
    })

    // Simulate 2 complete cooldown recovery cycles (each cycle = start -> crash -> cooldown -> recovery restart)
    for (let i = 0; i < 2; i++) {
      const child = new MockChild()
      spawn.mockReturnValueOnce(child)

      await manager.startAgent("slugger")
      child.emit("exit", 1, null)

      expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")

      // Find and fire the cooldown timer for this cycle
      const cooldownIdx = timers.findIndex((t) => t.delay === 10_000)
      expect(cooldownIdx).toBeGreaterThanOrEqual(0)

      // The cooldown cb calls startAgent which needs a child
      const recoveryChild = new MockChild()
      spawn.mockReturnValueOnce(recoveryChild)

      timers[cooldownIdx]!.cb()
      // Wait for async startAgent to complete
      await Promise.resolve()

      // Should be running after recovery
      expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")

      // Crash again to trigger next cycle
      recoveryChild.emit("exit", 1, null)

      // Remove processed timers
      timers.splice(0, timers.length)
    }

    // After 2 cooldown retries, the agent should be crashed with NO new cooldown timer
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    const newCooldownTimer = timers.find((t) => t.delay === 10_000)
    expect(newCooldownTimer).toBeUndefined()
  })

  it("clearCooldownTimer is called on stopAgent", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      cooldownRecoveryMs: 60_000,
      maxCooldownRetries: 3,
    })

    await manager.startAgent("slugger")
    child.emit("exit", 1, null)

    // Cooldown timer should be scheduled
    expect(timers.some((t) => t.delay === 60_000)).toBe(true)

    // Stop the agent — should clear the cooldown timer
    await manager.stopAgent("slugger")
    expect(clearTimeoutFn).toHaveBeenCalled()
  })

  it("defaults to 5 minutes cooldown and 3 max retries", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      // No cooldownRecoveryMs or maxCooldownRetries — use defaults
    })

    await manager.startAgent("slugger")
    child.emit("exit", 1, null)

    // Default cooldown is 5 minutes (300,000ms)
    const cooldownTimer = timers.find((t) => t.delay === 5 * 60 * 1_000)
    expect(cooldownTimer).toBeDefined()
  })

  it("resets backoff to initial on cooldown recovery", async () => {
    const first = new MockChild()
    const second = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      cooldownRecoveryMs: 10_000,
      maxCooldownRetries: 3,
      initialBackoffMs: 500,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)

    // Fire cooldown
    const cooldownTimer = timers.find((t) => t.delay === 10_000)
    cooldownTimer!.cb()

    // backoff should be reset to initial
    expect(manager.getAgentSnapshot("slugger")?.backoffMs).toBe(500)
  })
})
