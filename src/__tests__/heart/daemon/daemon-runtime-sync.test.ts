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
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock)",
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
    expect(result.message).toContain("restarted stale daemon")
    expect(result.message).toContain("0.1.0-alpha.6")
    expect(result.message).toContain("0.1.0-alpha.20")
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1)
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
    expect(result.message).toContain("pid unknown")
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
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; could not replace stale daemon 0.1.0-alpha.6 -> 0.1.0-alpha.20: permission denied)",
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

    expect(result).toEqual({
      alreadyRunning: true,
      message: expect.stringContaining("could not replace drifted daemon"),
    })
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
      alreadyRunning: true,
      message: "daemon already running (/tmp/ouro-test.sock; could not replace stale daemon 0.1.0-alpha.6 -> 0.1.0-alpha.20: string-stop-failure)",
    })
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })
})
