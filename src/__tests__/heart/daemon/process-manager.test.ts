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
  send = vi.fn((_message: unknown, _callback?: (error: Error | null) => void) => true)
}

describe("daemon process manager", () => {
  const spawn = vi.fn()
  const now = vi.fn()
  const timers: Array<{ delay: number; cb: () => void }> = []

  const setTimeoutFn = vi.fn((cb: () => void, delay: number) => {
    timers.push({ delay, cb })
    return timers.length
  })
  const clearTimeoutFn = vi.fn()
  const agents: DaemonManagedAgent[] = [
    { name: "slugger", entry: "heart/agent-entry.js", channel: "cli", autoStart: true },
    { name: "ouroboros", entry: "heart/agent-entry.js", channel: "cli", autoStart: false },
  ]

  beforeEach(() => {
    spawn.mockReset()
    now.mockReset()
    setTimeoutFn.mockClear()
    clearTimeoutFn.mockReset()
    timers.length = 0
  })

  it("starts only autoStart agents on boot", async () => {
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

    await manager.startAutoStartAgents()

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      "node",
      [expect.stringContaining("heart/agent-entry.js"), "--agent", "slugger"],
      expect.objectContaining({ cwd: expect.any(String) }),
    )
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
    expect(manager.getAgentSnapshot("ouroboros")?.status).toBe("stopped")
  })

  it("notifies onSnapshotChange after startAgent succeeds", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)
    const onSnapshotChange = vi.fn()

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      onSnapshotChange,
    })

    await manager.startAgent("slugger")

    // The startAgent path emits at least one snapshot change for the
    // running state. Multiple emissions are fine — the writer dedups.
    expect(onSnapshotChange).toHaveBeenCalled()
    const lastCall = onSnapshotChange.mock.calls[onSnapshotChange.mock.calls.length - 1]
    expect(lastCall?.[0].name).toBe("slugger")
    expect(lastCall?.[0].status).toBe("running")
  })

  it("notifies onSnapshotChange when configCheck fails (sets errorReason and fixHint)", async () => {
    const onSnapshotChange = vi.fn()
    const configCheck = vi.fn().mockReturnValue({
      ok: false,
      error: "missing github-copilot creds",
      fix: "run `ouro auth ouroboros --provider github-copilot`",
    })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
      onSnapshotChange,
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(onSnapshotChange).toHaveBeenCalled()
    const snap = manager.getAgentSnapshot("slugger")
    expect(snap?.status).toBe("crashed")
    expect(snap?.errorReason).toBe("missing github-copilot creds")
    expect(snap?.fixHint).toContain("ouro auth")
  })

  it("leaves an agent stopped when configCheck asks to skip startup", async () => {
    const onSnapshotChange = vi.fn()
    const configCheck = vi.fn().mockReturnValue({
      ok: false,
      skip: true,
      error: "bluebubbles is enabled but not attached on this machine",
    })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
      onSnapshotChange,
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(onSnapshotChange).toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")).toEqual(
      expect.objectContaining({
        status: "stopped",
        errorReason: null,
        fixHint: null,
      }),
    )
  })

  it("uses a default skip message when configCheck omits one", async () => {
    const configCheck = vi.fn().mockReturnValue({ ok: false, skip: true })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
  })

  it("clears errorReason and fixHint when a later configCheck passes (recovery)", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)
    const configCheck = vi.fn()
      .mockReturnValueOnce({ ok: false, error: "broken", fix: "fix it" })
      .mockReturnValueOnce({ ok: true })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
    })

    await manager.startAgent("slugger")
    expect(manager.getAgentSnapshot("slugger")?.errorReason).toBe("broken")

    await manager.startAgent("slugger")
    expect(manager.getAgentSnapshot("slugger")?.errorReason).toBeNull()
    expect(manager.getAgentSnapshot("slugger")?.fixHint).toBeNull()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("notifies onSnapshotChange after stopAgent", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)
    const onSnapshotChange = vi.fn()

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      onSnapshotChange,
    })

    await manager.startAgent("slugger")
    onSnapshotChange.mockClear()
    await manager.stopAgent("slugger")

    expect(onSnapshotChange).toHaveBeenCalled()
    const lastCall = onSnapshotChange.mock.calls[onSnapshotChange.mock.calls.length - 1]
    expect(lastCall?.[0].name).toBe("slugger")
    expect(lastCall?.[0].status).toBe("stopped")
  })

  it("swallows errors from onSnapshotChange so they don't break lifecycle code", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)
    const onSnapshotChange = vi.fn().mockImplementation(() => {
      throw new Error("observer exploded")
    })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      onSnapshotChange,
    })

    await expect(manager.startAgent("slugger")).resolves.not.toThrow()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("restarts crashed agents with exponential backoff", async () => {
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
      initialBackoffMs: 250,
      maxBackoffMs: 2_000,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)

    expect(timers[0]?.delay).toBe(250)

    timers[0]?.cb()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("stops restarting after max restarts per hour (cooldown recovery scheduled)", async () => {
    const first = new MockChild()
    spawn.mockReturnValue(first)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 0,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)

    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    // No immediate restart timer, but cooldown recovery is scheduled (default 5min)
    expect(timers.every((t) => t.delay >= 5 * 60 * 1_000)).toBe(true)
  })

  it("supports explicit stop and restart", async () => {
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
    })

    await manager.startAgent("slugger")
    await manager.restartAgent("slugger")

    expect(first.kill).toHaveBeenCalledWith("SIGTERM")
    expect(spawn).toHaveBeenCalledTimes(2)

    await manager.stopAgent("slugger")
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
  })

  it("lists snapshots and stops all managed agents", async () => {
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
    expect(manager.listAgentSnapshots().map((snapshot) => snapshot.name)).toEqual(["slugger", "ouroboros"])

    await manager.stopAll()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
  })

  it("resets backoff after a stable graceful run", async () => {
    const first = new MockChild()
    const second = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    now.mockReturnValue(0)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      stabilityThresholdMs: 10,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)
    expect(manager.getAgentSnapshot("slugger")?.backoffMs).toBe(200)

    now.mockReturnValue(20)
    timers[0]?.cb()
    now.mockReturnValue(40)
    second.emit("exit", 0, null)

    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
    expect(manager.getAgentSnapshot("slugger")?.backoffMs).toBe(100)
  })

  it("warns and continues when stopAgent kill throws", async () => {
    const child = new MockChild()
    child.kill.mockImplementation(() => {
      throw new Error("kill-failed")
    })
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
    await manager.stopAgent("slugger")

    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
  })

  it("clears scheduled restart timers before manual restarts", async () => {
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
      initialBackoffMs: 30,
      maxBackoffMs: 30,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)
    await manager.startAgent("slugger")

    expect(clearTimeoutFn).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("throws for unknown managed agents", async () => {
    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await expect(manager.startAgent("ghost")).rejects.toThrow("Unknown managed agent 'ghost'.")
  })

  it("does not spawn again when startAgent is called while already running", async () => {
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
    await manager.startAgent("slugger")

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("passes custom env to spawned process and normalizes missing pid to null", async () => {
    const pidlessChild = new MockChild()
    ;(pidlessChild as any).pid = undefined
    spawn.mockReturnValue(pidlessChild)
    now.mockReturnValue(1_000)

    const envAgents: DaemonManagedAgent[] = [
      { name: "slugger", entry: "heart/agent-entry.js", channel: "cli", autoStart: true, env: { TEST_FLAG: "1" } },
    ]

    const manager = new DaemonProcessManager({
      agents: envAgents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger")

    expect(spawn).toHaveBeenCalledWith(
      "node",
      [expect.stringContaining("heart/agent-entry.js"), "--agent", "slugger"],
      expect.objectContaining({
        env: expect.objectContaining({ TEST_FLAG: "1" }),
      }),
    )
    expect(manager.getAgentSnapshot("slugger")?.pid).toBeNull()
  })

  it("passes agentArg through to spawned sense processes", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents: [
        {
          name: "slugger:bluebubbles",
          agentArg: "slugger",
          entry: "senses/bluebubbles/entry.js",
          channel: "bluebubbles",
          autoStart: true,
        },
      ],
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger:bluebubbles")
    child.emit("exit", 1, null)
    await manager.stopAgent("slugger:bluebubbles")

    expect(spawn).toHaveBeenCalledWith(
      "node",
      [expect.stringContaining("senses/bluebubbles/entry.js"), "--agent", "slugger"],
      expect.objectContaining({ stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    )
    expect(now).toHaveBeenCalled()
    expect(setTimeoutFn).toHaveBeenCalled()
    expect(clearTimeoutFn).toHaveBeenCalled()
  })

  it("uses default spawn, clock, and timer helpers when none are injected", async () => {
    vi.resetModules()
    const spawnedChild = new MockChild()
    const defaultSpawn = vi.fn(() => spawnedChild)
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((((cb: () => void) => {
      timers.push({ delay: 123, cb })
      return 99
    }) as unknown) as typeof setTimeout)
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((() => undefined) as typeof clearTimeout)

    vi.doMock("child_process", () => ({
      spawn: defaultSpawn,
    }))

    const { DaemonProcessManager: DefaultedProcessManager } = await import("../../../heart/daemon/process-manager")
    const manager = new DefaultedProcessManager({
      agents,
      initialBackoffMs: 123,
      maxBackoffMs: 123,
    })

    await manager.startAgent("slugger")
    spawnedChild.emit("exit", 1, null)
    await manager.startAgent("slugger")

    expect(defaultSpawn).toHaveBeenCalledWith(
      "node",
      [expect.stringContaining("heart/agent-entry.js"), "--agent", "slugger"],
      expect.objectContaining({ cwd: expect.any(String) }),
    )
    expect(dateNowSpy).toHaveBeenCalled()
    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(99)
  })

  it("keeps increased backoff after short graceful exits and handles null startedAt", async () => {
    const first = new MockChild()
    const second = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    now.mockReturnValue(0)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      stabilityThresholdMs: 10,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)
    expect(manager.getAgentSnapshot("slugger")?.backoffMs).toBe(200)

    timers[0]?.cb()
    const snapshot = manager.getAgentSnapshot("slugger")
    if (!snapshot) throw new Error("missing slugger snapshot")
    snapshot.startedAt = null
    now.mockReturnValue(3)
    second.emit("exit", 0, null)

    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
    expect(manager.getAgentSnapshot("slugger")?.backoffMs).toBe(200)
  })

  it("spawns agents with ipc stdio channel", async () => {
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

    expect(spawn).toHaveBeenCalledWith(
      "node",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    )
  })

  it("sends IPC message to running agent via sendToAgent", async () => {
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
    manager.sendToAgent("slugger", { type: "heartbeat" })

    expect(child.send).toHaveBeenCalledWith({ type: "heartbeat" })
  })

  it("sendToAgent swallows errors when agent has no process", async () => {
    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    expect(() => manager.sendToAgent("slugger", { type: "heartbeat" })).not.toThrow()
  })

  it("sendToAgent swallows errors when child.send throws", async () => {
    const child = new MockChild()
    child.send.mockImplementation(() => { throw new Error("send-failed") })
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
    expect(() => manager.sendToAgent("slugger", { type: "poke" })).not.toThrow()
  })

  it("skips spawn and sets crashed when configCheck returns not ok", async () => {
    now.mockReturnValue(1_000)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: async () => ({ ok: false, error: "selected provider failed health check", fix: "run ouro auth --agent slugger --provider openai-codex" }),
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    expect(manager.getAgentSnapshot("slugger")?.errorReason).toBe("selected provider failed health check")
    expect(manager.getAgentSnapshot("slugger")?.fixHint).toContain("openai-codex")
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("selected provider failed health check"))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("run ouro auth --agent slugger --provider openai-codex"))
    stderrSpy.mockRestore()
  })

  it("skips spawn when configCheck fails without fix message", async () => {
    now.mockReturnValue(1_000)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: () => ({ ok: false, error: "bad config" }),
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    // Should write error but no fix line
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("bad config"))
    stderrSpy.mockRestore()
  })

  it("uses fallback error message when configCheck returns no error string", async () => {
    now.mockReturnValue(1_000)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: () => ({ ok: false }),
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    stderrSpy.mockRestore()
  })

  it("swallows statusWriter errors so config failures still update the snapshot", async () => {
    now.mockReturnValue(1_000)
    const statusWriter = vi.fn(() => {
      throw new Error("status-writer-failed")
    })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: () => ({ ok: false, error: "missing creds", fix: "run ouro auth" }),
      statusWriter,
    })

    await expect(manager.startAgent("slugger")).resolves.not.toThrow()

    expect(spawn).not.toHaveBeenCalled()
    expect(statusWriter).toHaveBeenCalledWith(expect.stringContaining("[daemon] slugger: missing creds"))
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    expect(manager.getAgentSnapshot("slugger")?.fixHint).toContain("ouro auth")
  })

  it("swallows non-Error statusWriter throws so config failures still update the snapshot", async () => {
    now.mockReturnValue(1_000)
    const statusWriter = vi.fn(() => {
      throw "status-writer-string"
    })

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: () => ({ ok: false, error: "missing creds" }),
      statusWriter,
    })

    await expect(manager.startAgent("slugger")).resolves.not.toThrow()

    expect(spawn).not.toHaveBeenCalled()
    expect(statusWriter).toHaveBeenCalledWith(expect.stringContaining("[daemon] slugger: missing creds"))
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
  })

  it("proceeds with spawn when configCheck returns ok", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: async () => {
        expect(spawn).not.toHaveBeenCalled()
        return { ok: true }
      },
    })

    await manager.startAgent("slugger")

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("sendToAgent throws for unknown agent", async () => {
    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    expect(() => manager.sendToAgent("ghost", { type: "heartbeat" })).toThrow("Unknown managed agent 'ghost'.")
  })

  it("prunes restart history outside the one-hour window", async () => {
    const first = new MockChild()
    const second = new MockChild()
    const third = new MockChild()
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third)

    const nowValues = [0, 0, 0, 3_700_000, 3_700_000]
    now.mockImplementation(() => nowValues.shift() ?? 3_700_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      maxRestartsPerHour: 1,
      initialBackoffMs: 10,
      maxBackoffMs: 10,
    })

    await manager.startAgent("slugger")
    first.emit("exit", 1, null)
    timers[0]?.cb()

    second.emit("exit", 1, null)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("starting")
    expect(manager.getAgentSnapshot("slugger")?.restartCount).toBe(2)
  })

  it("sets status to crashed and does not spawn when entry script path does not exist", async () => {
    const existsSync = vi.fn(() => false)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      existsSync,
    })

    await manager.startAgent("slugger")

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
  })

  it("proceeds normally when entry script path exists", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    const existsSync = vi.fn(() => true)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      existsSync,
    })

    await manager.startAgent("slugger")

    expect(existsSync).toHaveBeenCalledWith(expect.stringContaining("heart/agent-entry.js"))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("stores lastExitCode and lastSignal on crash", async () => {
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
    child.emit("exit", 137, "SIGKILL")

    const snapshot = manager.getAgentSnapshot("slugger")
    expect(snapshot?.lastExitCode).toBe(137)
    expect(snapshot?.lastSignal).toBe("SIGKILL")
  })

  it("stores lastExitCode as null on graceful exit with null code", async () => {
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
    // Simulate a graceful stop (stopRequested flag via stopAgent)
    await manager.stopAgent("slugger")

    const snapshot = manager.getAgentSnapshot("slugger")
    expect(snapshot?.lastExitCode).toBeNull()
    expect(snapshot?.lastSignal).toBeNull()
  })

  it("initializes lastExitCode and lastSignal as null", () => {
    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    const snapshot = manager.getAgentSnapshot("slugger")
    expect(snapshot?.lastExitCode).toBeNull()
    expect(snapshot?.lastSignal).toBeNull()
  })
})
