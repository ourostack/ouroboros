import { describe, expect, it, vi } from "vitest"

import { ensureCurrentDaemonRuntime } from "../../../heart/daemon/daemon-runtime-sync"

describe("ensureCurrentDaemonRuntime", () => {
  it("keeps the current daemon when versions match", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock)",
      verifyStartupStatus: true,
      startedPid: null,
      startupFailureReason: null,
    })
    expect(deps.stopDaemon).not.toHaveBeenCalled()
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("restarts the daemon when the running version is stale", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(777)
    expect(result.message).toContain("replaced an older background service")
    expect(result.message).toContain("0.1.0-alpha.6")
    expect(result.message).toContain("0.1.0-alpha.20")
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("disables daemon auto-restart after stopping a stale daemon and before starting its replacement", async () => {
    const calls: string[] = []
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => { calls.push("stop") }),
      prepareDaemonRuntimeReplacement: vi.fn(async () => { calls.push("prepare") }),
      cleanupStaleSocket: vi.fn(() => { calls.push("cleanup") }),
      startDaemonProcess: vi.fn(async () => {
        calls.push("start")
        return { pid: 777 }
      }),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.ok).toBe(true)
    expect(calls).toEqual(["stop", "prepare", "cleanup", "start"])
  })

  it("continues replacement when auto-restart preparation fails", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {}),
      prepareDaemonRuntimeReplacement: vi.fn(async () => {
        throw new Error("launchd unavailable")
      }),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.ok).toBe(true)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("restarts the daemon when the running code path drifts even if the version matches", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localLastUpdated: "2026-03-09T11:00:00.000Z",
      localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
      localConfigFingerprint: "cfg-local",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-cross-chat-bridge-orchestration",
        configFingerprint: "cfg-local",
      })),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    } as any

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(777)
    expect(result.message).toContain("runtime drift")
    expect(result.message).toContain("code path")
    expect(result.message).not.toContain("/Users/arimendelow/Projects")
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("restarts the daemon when the running config fingerprint drifts even if the version matches", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localLastUpdated: "2026-03-09T11:00:00.000Z",
      localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
      localConfigFingerprint: "cfg-local",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
        configFingerprint: "cfg-running",
      })),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    } as any

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(777)
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("restarts the daemon when the managed agent roster drifts even if runtime metadata matches", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localLastUpdated: "2026-03-09T11:00:00.000Z",
      localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
      localConfigFingerprint: "cfg-local",
      localManagedAgents: "slugger",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
        configFingerprint: "cfg-local",
        managedAgents: "ouroboros,slugger",
      })),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    } as any

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(777)
    expect(result.message).toContain("managed agents")
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("restarts the daemon when lastUpdated drifts and versions match", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localLastUpdated: "2026-03-09T11:00:00.000Z",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-08T00:00:00.000Z",
      })),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    } as any

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(777)
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("falls back to fetchRunningVersion when runtime metadata omits the version", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({})),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(777)
    expect(deps.fetchRunningVersion).toHaveBeenCalledTimes(1)
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("formats unknown pid when same-version drift restart returns null pid", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({
        version: "0.1.0-alpha.20",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-cross-chat-bridge-orchestration",
      })),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
    } as any

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(null)
    expect(result.message).toContain("pid unknown")
  })

  it("formats unknown pid when stale daemon restart returns null pid", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.verifyStartupStatus).toBe(true)
    expect(result.startedPid).toBe(null)
    expect(result.message).toContain("pid unknown")
  })

  it("passes a pre-start boot timestamp to the replacement startup monitor", async () => {
    let nowMs = 10_000
    const waitForDaemonStartup = vi.fn(async () => ({ ok: true as const }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      now: () => nowMs,
      startDaemonProcess: vi.fn(async () => {
        nowMs = 20_000
        return { pid: 777 }
      }),
      waitForDaemonStartup,
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result.ok).toBe(true)
    expect(waitForDaemonStartup).toHaveBeenCalledWith({ pid: 777, bootStartedAtMs: 10_000 })
  })

  it("uses the replacement startup check result when the restarted daemon never answers", async () => {
    const waitForDaemonStartup = vi.fn(async () => ({ ok: false as const }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      waitForDaemonStartup,
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(waitForDaemonStartup).toHaveBeenCalledWith({ pid: null, bootStartedAtMs: expect.any(Number) })
    expect(result).toEqual({
      ok: false,
      alreadyRunning: false,
      message: "replaced an older background service 0.1.0-alpha.6 -> 0.1.0-alpha.20 (pid unknown)\nreplacement background service did not answer in time; check logs with `ouro logs` or run `ouro doctor`.",
      verifyStartupStatus: false,
      startedPid: null,
      startupFailureReason: "replacement background service did not answer in time",
    })
  })

  it("keeps the daemon when the local version is unknown", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "unknown",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; unable to verify version)",
    })
  })

  it("keeps the daemon when the running version is unknown", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "unknown"),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; unable to verify version)",
    })
  })

  it("keeps the daemon when version lookup throws an Error", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => {
        throw new Error("status unavailable")
      }),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; unable to verify version: status unavailable)",
    })
  })

  it("keeps the daemon when version lookup throws a non-Error value", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => {
        throw "non-error-status-failure"
      }),
      stopDaemon: vi.fn(async () => {}),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; unable to verify version: non-error-status-failure)",
    })
  })

  it("keeps the daemon when stale replacement fails with an Error", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {
        throw new Error("permission denied")
      }),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: false,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; could not replace the older background service 0.1.0-alpha.6 -> 0.1.0-alpha.20: permission denied)",
      startupFailureReason: "could not replace the older background service",
    })
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps the daemon when same-version drift replacement fails", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.20"),
      fetchRunningRuntimeMetadata: vi.fn(async () => ({
        version: "0.1.0-alpha.20",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-cross-chat-bridge-orchestration",
      })),
      stopDaemon: vi.fn(async () => {
        throw new Error("permission denied")
      }),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    } as any

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      alreadyRunning: true,
      message: expect.stringContaining("could not replace the older background service after runtime drift"),
      startupFailureReason: "could not replace the older background service after runtime drift",
    }))
    expect(result.message).toContain("permission denied")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps the daemon when stale replacement fails with a non-Error value", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      fetchRunningVersion: vi.fn(async () => "0.1.0-alpha.6"),
      stopDaemon: vi.fn(async () => {
        throw "string-stop-failure"
      }),
      cleanupStaleSocket: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
    }

    const result = await ensureCurrentDaemonRuntime(deps)

    expect(result).toEqual({
      ok: false,
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; could not replace the older background service 0.1.0-alpha.6 -> 0.1.0-alpha.20: string-stop-failure)",
      startupFailureReason: "could not replace the older background service",
    })
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })
})
