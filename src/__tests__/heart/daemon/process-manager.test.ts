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

type AgentRuntimeStateForTest = {
  crashTimestamps: number[]
  orchestratedRestartTimestamps: number[]
  respawnLoopTripped: boolean
  cooldownTimer: unknown | null
  cooldownRetryCount: number
  fastCrashCount: number
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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

  it("triggers autoStart agents without awaiting worker startup", async () => {
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

    manager.triggerAutoStartAgents()
    await Promise.resolve()

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
    expect(manager.getAgentSnapshot("ouroboros")?.status).toBe("stopped")
  })

  it("contains thrown trigger startup failures per autoStart agent", async () => {
    const onSnapshotChange = vi.fn()
    spawn
      .mockImplementationOnce(() => {
        throw new Error("spawn exploded")
      })
      .mockImplementationOnce(() => {
        throw "raw spawn failure"
      })
    now.mockReturnValue(1_000)

    const first = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      statusWriter: () => {},
      onSnapshotChange,
    })
    const second = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      statusWriter: () => {},
      onSnapshotChange,
    })

    first.triggerAutoStartAgents()
    second.triggerAutoStartAgents()
    await Promise.resolve()

    expect(first.getAgentSnapshot("slugger")?.status).toBe("crashed")
    expect(first.getAgentSnapshot("slugger")?.errorReason).toContain("spawn exploded")
    expect(second.getAgentSnapshot("slugger")?.status).toBe("crashed")
    expect(second.getAgentSnapshot("slugger")?.errorReason).toContain("raw spawn failure")
    expect(first.getAgentSnapshot("ouroboros")?.status).toBe("stopped")
    expect(onSnapshotChange).toHaveBeenCalled()
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

  it("sends runtime credential bootstrap over IPC after spawning", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents: [{
        name: "slugger:bluebubbles",
        agentArg: "slugger",
        entry: "senses/bluebubbles/entry.js",
        channel: "bluebubbles",
        autoStart: true,
        getRuntimeCredentialBootstrap: () => ({
          agentName: "slugger",
          runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
          machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" } },
          machineId: "machine_test",
          providerCredentialRecords: [{
            provider: "openai-codex",
            revision: "vault_test",
            updatedAt: "2026-04-14T12:00:00.000Z",
            credentials: { oauthAccessToken: "codex-token" },
            config: {},
            provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
          }],
        }),
      }],
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger:bluebubbles")

    expect(child.send).toHaveBeenCalledWith({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
      machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" } },
      machineId: "machine_test",
      providerCredentialRecords: [{
        provider: "openai-codex",
        revision: "vault_test",
        updatedAt: "2026-04-14T12:00:00.000Z",
        credentials: { oauthAccessToken: "codex-token" },
        config: {},
        provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
      }],
    })
  })

  it("continues startup when runtime credential bootstrap IPC send throws", async () => {
    const child = new MockChild()
    child.send.mockImplementation(() => {
      throw "ipc closed"
    })
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents: [{
        name: "slugger:bluebubbles",
        agentArg: "slugger",
        entry: "senses/bluebubbles/entry.js",
        channel: "bluebubbles",
        autoStart: true,
        getRuntimeCredentialBootstrap: () => ({
          agentName: "slugger",
          machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" } },
        }),
      }],
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await expect(manager.startAgent("slugger:bluebubbles")).resolves.not.toThrow()

    expect(child.send).toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger:bluebubbles")?.status).toBe("running")
  })

  it("sends runtime credential bootstrap without provider records", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents: [{
        name: "slugger:bluebubbles",
        agentArg: "slugger",
        entry: "senses/bluebubbles/entry.js",
        channel: "bluebubbles",
        autoStart: true,
        getRuntimeCredentialBootstrap: () => ({
          agentName: "slugger",
          machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" } },
        }),
      }],
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger:bluebubbles")

    expect(child.send).toHaveBeenCalledWith({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" } },
    })
    expect(manager.getAgentSnapshot("slugger:bluebubbles")?.status).toBe("running")
  })

  it("sends provider credential bootstrap without unrelated runtime fields", async () => {
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const providerCredentialRecords = [{
      provider: "openai-codex" as const,
      revision: "vault_test",
      updatedAt: "2026-04-14T12:00:00.000Z",
      credentials: { oauthAccessToken: "codex-token" },
      config: {},
      provenance: { source: "auth-flow" as const, updatedAt: "2026-04-14T12:00:00.000Z" },
    }]

    const manager = new DaemonProcessManager({
      agents: [{
        name: "slugger:mail",
        agentArg: "slugger",
        entry: "senses/mail-entry.js",
        channel: "mail",
        autoStart: true,
        getRuntimeCredentialBootstrap: () => ({
          agentName: "slugger",
          providerCredentialRecords,
        }),
      }],
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await manager.startAgent("slugger:mail")

    expect(child.send).toHaveBeenCalledWith({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      providerCredentialRecords,
    })
  })

  it("records Error details when runtime credential bootstrap IPC send throws an Error", async () => {
    const child = new MockChild()
    child.send.mockImplementation(() => {
      throw new Error("ipc closed")
    })
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents: [{
        name: "slugger:bluebubbles",
        agentArg: "slugger",
        entry: "senses/bluebubbles/entry.js",
        channel: "bluebubbles",
        autoStart: true,
        getRuntimeCredentialBootstrap: () => ({
          agentName: "slugger",
          machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" } },
        }),
      }],
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })

    await expect(manager.startAgent("slugger:bluebubbles")).resolves.not.toThrow()

    expect(child.send).toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger:bluebubbles")?.status).toBe("running")
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

  it("does not start duplicate config checks while an agent is already starting", async () => {
    const deferred = createDeferred<{ ok: boolean }>()
    const configCheck = vi.fn(() => deferred.promise)
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
    })

    const firstStart = manager.startAgent("slugger")
    await Promise.resolve()
    await manager.startAgent("slugger")

    expect(configCheck).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("starting")

    deferred.resolve({ ok: true })
    await firstStart

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("does not cancel a pending startup when restartAgent is called during config check", async () => {
    const deferred = createDeferred<{ ok: boolean }>()
    const configCheck = vi.fn(() => deferred.promise)
    const child = new MockChild()
    spawn.mockReturnValue(child)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
    })

    const start = manager.startAgent("slugger")
    await Promise.resolve()
    await manager.restartAgent("slugger")

    expect(configCheck).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("starting")

    deferred.resolve({ ok: true })
    await start

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")
  })

  it("recovers a stale pending startup without letting the old check spawn later", async () => {
    const staleCheck = createDeferred<{ ok: boolean }>()
    const freshChild = new MockChild()
    const configCheck = vi.fn()
      .mockReturnValueOnce(staleCheck.promise)
      .mockReturnValueOnce({ ok: true })
    spawn.mockReturnValue(freshChild)
    now
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_500)
      .mockReturnValueOnce(2_500)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      startupStaleAfterMs: 1_000,
      statusWriter: () => {},
    })

    const originalStart = manager.startAgent("slugger")
    await Promise.resolve()
    await manager.restartAgent("slugger")

    expect(configCheck).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("running")

    staleCheck.resolve({ ok: true })
    await originalStart

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.getAgentSnapshot("slugger")?.pid).toBe(freshChild.pid)
  })

  it("does not spawn after stopAgent is called during a pending config check", async () => {
    const deferred = createDeferred<{ ok: boolean }>()
    const configCheck = vi.fn(() => deferred.promise)
    now.mockReturnValue(1_000)

    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck,
      statusWriter: () => {},
    })

    const start = manager.startAgent("slugger")
    await Promise.resolve()
    await manager.stopAgent("slugger")
    deferred.resolve({ ok: true })
    await start

    expect(configCheck).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
  })

  it("terminates a child spawned by a startup attempt that became stale", async () => {
    const staleChild = new MockChild()
    staleChild.kill.mockImplementation(() => {
      throw new Error("sigterm denied")
    })
    const freshChild = new MockChild()
    let manager!: DaemonProcessManager
    let restartPromise: Promise<void> | null = null
    let spawnCount = 0
    spawn.mockImplementation(() => {
      spawnCount += 1
      if (spawnCount === 1) {
        restartPromise = manager.restartAgent("slugger")
        return staleChild
      }
      return freshChild
    })
    now
      .mockReturnValueOnce(1_000)
      .mockReturnValue(3_000)

    manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: vi.fn(() => ({ ok: true })),
      startupStaleAfterMs: 1_000,
      statusWriter: () => {},
    })

    await manager.startAgent("slugger")
    await restartPromise

    expect(staleChild.kill).toHaveBeenCalledWith("SIGTERM")
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(manager.getAgentSnapshot("slugger")?.pid).toBe(freshChild.pid)
  })

  it("does not spawn when stopAgent is requested after config validation but before spawn", async () => {
    now.mockReturnValue(1_000)
    let manager!: DaemonProcessManager
    const existsSync = vi.fn(() => {
      void manager.stopAgent("slugger")
      return true
    })

    manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      existsSync,
      configCheck: vi.fn(() => ({ ok: true })),
      statusWriter: () => {},
    })

    await manager.startAgent("slugger")

    expect(existsSync).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("stopped")
  })

  it("records thrown string config check failures as agent-local crashes", async () => {
    const configCheck = vi.fn().mockRejectedValue("raw config failure")

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
    const snap = manager.getAgentSnapshot("slugger")
    expect(snap?.status).toBe("crashed")
    expect(snap?.errorReason).toContain("raw config failure")
    expect(manager.getAgentSnapshot("ouroboros")?.status).toBe("stopped")
  })

  it("turns thrown config checks into per-agent crashed snapshots", async () => {
    const onSnapshotChange = vi.fn()
    const manager = new DaemonProcessManager({
      agents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
      configCheck: async () => {
        throw new Error("provider vault read hung up")
      },
      statusWriter: () => {},
      onSnapshotChange,
    })

    await expect(manager.startAgent("slugger")).resolves.not.toThrow()

    expect(spawn).not.toHaveBeenCalled()
    expect(manager.getAgentSnapshot("slugger")?.status).toBe("crashed")
    expect(manager.getAgentSnapshot("slugger")?.errorReason).toContain("provider vault read hung up")
    expect(manager.getAgentSnapshot("ouroboros")?.status).toBe("stopped")
    expect(onSnapshotChange).toHaveBeenCalled()
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

  it("resets cooldown, crash, and respawn-loop state for operator sense revive", () => {
    const cooldownTimer = { kind: "cooldown" }
    const senseAgents: DaemonManagedAgent[] = [
      { name: "slugger", entry: "heart/agent-entry.js", channel: "cli", autoStart: false },
      { name: "slugger:bluebubbles", entry: "heart/sense-entry.js", channel: "bluebubbles", autoStart: false },
    ]
    const manager = new DaemonProcessManager({
      agents: senseAgents,
      spawn,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    })
    const states = (manager as unknown as { agents: Map<string, AgentRuntimeStateForTest> }).agents
    const state = states.get("slugger:bluebubbles")
    if (!state) throw new Error("missing bluebubbles state")
    state.cooldownRetryCount = 3
    state.crashTimestamps = [1_000, 2_000]
    state.fastCrashCount = 2
    state.respawnLoopTripped = true
    state.cooldownTimer = cooldownTimer
    state.orchestratedRestartTimestamps = [3_000, 4_000]

    manager.resetAgentFailureState("slugger:bluebubbles")

    expect(clearTimeoutFn).toHaveBeenCalledWith(cooldownTimer)
    expect(state.cooldownRetryCount).toBe(0)
    expect(state.crashTimestamps).toEqual([])
    expect(state.fastCrashCount).toBe(0)
    expect(state.respawnLoopTripped).toBe(false)
    expect(state.cooldownTimer).toBeNull()
    expect(state.orchestratedRestartTimestamps).toEqual([])
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

  /**
   * Respawn-loop guard — regression coverage for the 2026-05-11 incident.
   *
   * The HTTP health probe was misfiring during BB sense's legitimate long
   * operations (VLM image describe). Every minute it triggered
   * `restartAgent` via `senseManager.restartSense`. Slugger's BB sense was
   * SIGTERM'd mid-work ~60 times per hour. The recovery loop re-injected
   * the same user message into the BB session every cycle — Ari saw his
   * messages echoed back to Slugger 76+ times.
   *
   * The aggressive HTTP probe is gone (see sense-manager.ts), but the
   * guard remains as defense-in-depth: any future cause of a tight
   * restart loop is bounded at MAX restarts in WINDOW.
   */
  describe("respawn-loop guard", () => {
    it("allows normal restart cadence (under the threshold)", async () => {
      let t = 1_000
      now.mockImplementation(() => (t += 1_000))
      const child = new MockChild()
      spawn.mockReturnValue(child)

      const manager = new DaemonProcessManager({
        agents,
        spawn,
        now,
        setTimeoutFn,
        clearTimeoutFn,
      })
      await manager.startAutoStartAgents()

      // 4 restarts in quick succession — under the 5/window threshold.
      for (let i = 0; i < 4; i++) {
        spawn.mockReturnValue(new MockChild())
        await manager.restartAgent("slugger")
      }

      const snapshot = manager.getAgentSnapshot("slugger")
      expect(snapshot?.errorReason).toBeNull()
      // 1 initial start + 4 restarts = 5 spawn calls
      expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(4)
    })

    it("trips after MAX restarts in WINDOW and refuses further restarts", async () => {
      let t = 1_000
      now.mockImplementation(() => (t += 1_000))
      spawn.mockImplementation(() => new MockChild())

      const manager = new DaemonProcessManager({
        agents,
        spawn,
        now,
        setTimeoutFn,
        clearTimeoutFn,
      })
      await manager.startAutoStartAgents()

      // 5 restarts → fills the window; 6th must trip the guard.
      for (let i = 0; i < 5; i++) {
        await manager.restartAgent("slugger")
      }
      const spawnsBeforeTrip = spawn.mock.calls.length

      // 6th call: guard trips, no further spawns.
      await manager.restartAgent("slugger")
      // The guard refuses to spawn — count must not increase.
      expect(spawn.mock.calls.length).toBe(spawnsBeforeTrip)

      const snapshot = manager.getAgentSnapshot("slugger")
      expect(snapshot?.errorReason).toMatch(/respawn loop/i)
      expect(snapshot?.fixHint).toMatch(/ouro up/i)
    })

    it("after tripping, subsequent restartAgent calls are no-ops", async () => {
      let t = 1_000
      now.mockImplementation(() => (t += 1_000))
      spawn.mockImplementation(() => new MockChild())

      const manager = new DaemonProcessManager({
        agents,
        spawn,
        now,
        setTimeoutFn,
        clearTimeoutFn,
      })
      await manager.startAutoStartAgents()

      for (let i = 0; i < 6; i++) {
        await manager.restartAgent("slugger")
      }
      const spawnsAfterTrip = spawn.mock.calls.length

      // Repeated restart attempts after trip don't spawn anything more.
      for (let i = 0; i < 5; i++) {
        await manager.restartAgent("slugger")
      }
      // Count is unchanged — the guard rejects every call.
      expect(spawn.mock.calls.length).toBe(spawnsAfterTrip)
    })

    it("startAgent bypasses the guard — operator can resume after a trip via ouro down + ouro up", async () => {
      let t = 1_000
      now.mockImplementation(() => (t += 1_000))
      spawn.mockImplementation(() => new MockChild())

      const manager = new DaemonProcessManager({
        agents,
        spawn,
        now,
        setTimeoutFn,
        clearTimeoutFn,
      })
      await manager.startAutoStartAgents()

      // Trip the guard.
      for (let i = 0; i < 6; i++) {
        await manager.restartAgent("slugger")
      }

      // Operator flow: `ouro down` then `ouro up`. Neither call is gated by
      // the respawn-loop guard; the guard only blocks restartAgent.
      await manager.stopAgent("slugger")
      const spawnsBeforeUp = spawn.mock.calls.length
      await manager.startAgent("slugger")

      expect(spawn.mock.calls.length).toBeGreaterThan(spawnsBeforeUp)
      const snapshot = manager.getAgentSnapshot("slugger")
      expect(snapshot?.status).toBe("running")
    })

    it("trip clears automatically once all timestamps age out of the window", async () => {
      let t = 0
      now.mockImplementation(() => t)
      spawn.mockImplementation(() => new MockChild())

      const manager = new DaemonProcessManager({
        agents,
        spawn,
        now,
        setTimeoutFn,
        clearTimeoutFn,
      })
      t = 1_000
      await manager.startAutoStartAgents()

      // 6 quick restarts — trips the guard.
      for (let i = 0; i < 6; i++) {
        t += 1_000
        await manager.restartAgent("slugger")
      }
      const trippedSnap = manager.getAgentSnapshot("slugger")
      expect(trippedSnap?.errorReason).toMatch(/respawn loop/i)

      // Jump forward past the window — old timestamps age out, trip self-clears.
      t += 12 * 60_000

      // First restartAgent call after the window detects the empty array and
      // clears the trip. Without something else to spawn, expect status update.
      await manager.restartAgent("slugger")
      const clearedSnap = manager.getAgentSnapshot("slugger")
      expect(clearedSnap?.errorReason).toBeNull()

      // Subsequent restarts work normally again, up to the threshold.
      for (let i = 0; i < 3; i++) {
        t += 1_000
        await manager.restartAgent("slugger")
      }
      expect(manager.getAgentSnapshot("slugger")?.errorReason).toBeNull()
    })
  })
})
