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
    { name: "test-agent", entry: "heart/agent-entry.js", channel: "inner-dialog", autoStart: true },
  ]

  // Existing cooldown tests need run duration > 5s to avoid triggering fast-crash detection.
  // This helper returns a now() that advances 10s on each call.
  function stableTime() {
    let t = 0
    return () => (t += 10_000)
  }

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
    now.mockImplementation(stableTime())

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

    await manager.startAgent("test-agent")
    child.emit("exit", 1, null)

    // Should be crashed
    expect(manager.getAgentSnapshot("test-agent")?.status).toBe("crashed")

    // A cooldown timer should be scheduled
    // First timer is the cooldown (no restart timer was scheduled since maxRestartsPerHour was 0)
    const cooldownTimer = timers.find((t) => t.delay === 30_000)
    expect(cooldownTimer).toBeDefined()
  })

  it("recovery attempt resets crash history and restarts agent", async () => {
    const first = new MockChild()
    const second = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    now.mockImplementation(stableTime())

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

    await manager.startAgent("test-agent")
    first.emit("exit", 1, null)

    expect(manager.getAgentSnapshot("test-agent")?.status).toBe("crashed")

    // Fire the cooldown timer
    const cooldownTimer = timers.find((t) => t.delay === 30_000)
    cooldownTimer!.cb()

    // Should attempt restart
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(manager.getAgentSnapshot("test-agent")?.status).toBe("running")
  })

  it("stops recovery after maxCooldownRetries exhausted", async () => {
    now.mockImplementation(stableTime())
    // Default spawn for any unexpected startAgent calls (e.g., from async timer callbacks)
    spawn.mockReturnValue(new MockChild())

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

      await manager.startAgent("test-agent")
      child.emit("exit", 1, null)

      expect(manager.getAgentSnapshot("test-agent")?.status).toBe("crashed")

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
      expect(manager.getAgentSnapshot("test-agent")?.status).toBe("running")

      // Crash again to trigger next cycle
      recoveryChild.emit("exit", 1, null)

      // Remove processed timers
      timers.splice(0, timers.length)
    }

    // After 2 cooldown retries, the agent should be crashed with NO new cooldown timer
    expect(manager.getAgentSnapshot("test-agent")?.status).toBe("crashed")
    const newCooldownTimer = timers.find((t) => t.delay === 10_000)
    expect(newCooldownTimer).toBeUndefined()
  })

  it("clearCooldownTimer is called on stopAgent", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockImplementation(stableTime())

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

    await manager.startAgent("test-agent")
    child.emit("exit", 1, null)

    // Cooldown timer should be scheduled
    expect(timers.some((t) => t.delay === 60_000)).toBe(true)

    // Stop the agent — should clear the cooldown timer
    await manager.stopAgent("test-agent")
    expect(clearTimeoutFn).toHaveBeenCalled()
  })

  it("defaults to 5 minutes cooldown and 3 max retries", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockImplementation(stableTime())

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
      // No cooldownRecoveryMs or maxCooldownRetries — use defaults
    })

    await manager.startAgent("test-agent")
    child.emit("exit", 1, null)

    // Default cooldown is 5 minutes (300,000ms)
    const cooldownTimer = timers.find((t) => t.delay === 5 * 60 * 1_000)
    expect(cooldownTimer).toBeDefined()
  })

  it("resets backoff to initial on cooldown recovery", async () => {
    const first = new MockChild()
    const second = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    now.mockImplementation(stableTime())

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

    await manager.startAgent("test-agent")
    first.emit("exit", 1, null)

    // Fire cooldown
    const cooldownTimer = timers.find((t) => t.delay === 10_000)
    cooldownTimer!.cb()

    // backoff should be reset to initial
    expect(manager.getAgentSnapshot("test-agent")?.backoffMs).toBe(500)
  })

  it("marks agent as crashed after 3 consecutive fast crashes (config failure detection)", async () => {
    // Fast crash = exits within 5 seconds of starting
    // After 3 consecutive fast crashes, stop retrying (likely config issue)
    let currentTime = 1_000
    now.mockImplementation(() => currentTime)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 100, // high limit so we hit fast-crash detection first
    })

    // 3 consecutive fast crashes (each runs for 100ms)
    for (let i = 0; i < 3; i++) {
      const child = new MockChild()
      spawn.mockReturnValueOnce(child)
      await manager.startAgent("test-agent")
      currentTime += 100 // 100ms run = fast crash
      child.emit("exit", 1, null)

      if (i < 2) {
        // First two: should schedule restart
        expect(manager.getAgentSnapshot("test-agent")?.status).toBe("starting")
        const timer = timers[timers.length - 1]
        timer.cb() // fire restart timer
      }
    }

    // After 3rd fast crash: should be marked crashed, no more restarts
    expect(manager.getAgentSnapshot("test-agent")?.status).toBe("crashed")
  })

  it("resets fast-crash counter after a stable run", async () => {
    let currentTime = 1_000
    now.mockImplementation(() => currentTime)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 100,
    })

    // 2 fast crashes
    for (let i = 0; i < 2; i++) {
      const child = new MockChild()
      spawn.mockReturnValueOnce(child)
      await manager.startAgent("test-agent")
      currentTime += 100
      child.emit("exit", 1, null)
      const timer = timers[timers.length - 1]
      timer.cb()
    }

    // Then a stable run (10 seconds)
    const stableChild = new MockChild()
    spawn.mockReturnValueOnce(stableChild)
    await manager.startAgent("test-agent")
    currentTime += 10_000 // 10s = stable
    stableChild.emit("exit", 1, null)

    // Should still be restarting (fast-crash counter reset by stable run)
    expect(manager.getAgentSnapshot("test-agent")?.status).toBe("starting")
  })
})
