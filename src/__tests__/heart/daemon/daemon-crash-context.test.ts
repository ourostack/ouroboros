import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  writeDaemonTombstone,
  readDaemonTombstone,
  setTombstonePath,
} from "../../../heart/daemon/daemon-tombstone"

import {
  DaemonProcessManager,
  type DaemonManagedAgent,
} from "../../../heart/daemon/process-manager"

import { EventEmitter } from "events"

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

describe("crash context in status output", () => {
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

  afterEach(() => {
    setTombstonePath(null)
    spawn.mockReset()
    now.mockReset()
    setTimeoutFn.mockClear()
    clearTimeoutFn.mockReset()
    timers.length = 0
  })

  it("process manager includes lastExitCode and lastSignal in snapshots after crash", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger")

    // Simulate a crash with SIGKILL
    child.emit("exit", 137, "SIGKILL")

    const snapshots = manager.listAgentSnapshots()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.lastExitCode).toBe(137)
    expect(snapshots[0]!.lastSignal).toBe("SIGKILL")
  })

  it("process manager includes lastExitCode and lastSignal as null initially", () => {
    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    const snapshots = manager.listAgentSnapshots()
    expect(snapshots[0]!.lastExitCode).toBeNull()
    expect(snapshots[0]!.lastSignal).toBeNull()
  })

  it("tombstone round-trip: write then read", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-ctx-"))
    setTombstonePath(path.join(tmpDir, "daemon-death.json"))

    writeDaemonTombstone("uncaughtException", new Error("segfault"))

    const tombstone = readDaemonTombstone()
    expect(tombstone).not.toBeNull()
    expect(tombstone!.reason).toBe("uncaughtException")
    expect(tombstone!.message).toBe("segfault")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("tombstone returns null when no tombstone exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-ctx-none-"))
    setTombstonePath(path.join(tmpDir, "nonexistent.json"))

    expect(readDaemonTombstone()).toBeNull()

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("process manager tracks exit code 0 and null signal for normal exits", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger")

    // Simulate stop then exit
    child.emit("exit", 0, null)

    const snapshot = manager.getAgentSnapshot("slugger")
    expect(snapshot?.lastExitCode).toBe(0)
    expect(snapshot?.lastSignal).toBeNull()
  })

  it("process manager tracks signal-only exits", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger")
    child.emit("exit", null, "SIGTERM")

    const snapshot = manager.getAgentSnapshot("slugger")
    expect(snapshot?.lastExitCode).toBeNull()
    expect(snapshot?.lastSignal).toBe("SIGTERM")
  })
})
