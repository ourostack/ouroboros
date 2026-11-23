import { describe, expect, it, vi } from "vitest"

import type { OuroCliDeps } from "../../../heart/daemon/cli-types"
import { ensureDaemonRunning } from "../../../heart/daemon/daemon-cli"

// 2026-11-23 00:42:05Z: a replacement daemon answered three probes, then one
// probe hit its 800 ms timeout while the new daemon was busy starting its
// senses. `ouro up` called that "answered once and then disappeared" and
// exited 1, though the daemon (launchd runs=1) never exited and was healthy.
function startupDeps(probes: boolean[], extra: Partial<OuroCliDeps> = {}) {
  let nowMs = Date.parse("2026-11-23T00:41:54.000Z")
  const bootMs = nowMs
  let probe = 0
  const startDaemonProcess = vi.fn(async () => ({ pid: 20519 }))
  // After the scripted probes the daemon keeps answering.
  const checkSocketAlive = vi.fn(async () => {
    if (startDaemonProcess.mock.calls.length === 0) return false
    return probes[probe++] ?? true
  })
  const deps = {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess,
    writeStdout: vi.fn(),
    checkSocketAlive,
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    healthFilePath: "/tmp/ouro-health.json",
    readHealthState: vi.fn(() => ({
      status: "ok",
      mode: "normal",
      pid: 20519,
      startedAt: new Date(bootMs + 1).toISOString(),
      uptimeSeconds: 1,
      safeMode: null,
      degraded: [],
      agents: {},
      habits: {},
    })),
    readHealthUpdatedAt: vi.fn(() => nowMs),
    readRecentDaemonLogLines: vi.fn(() => []),
    sleep: vi.fn(async (ms: number) => { nowMs += ms }),
    now: () => nowMs,
    startupPollIntervalMs: 5,
    startupStabilityWindowMs: 15,
    startupTimeoutMs: 200,
    ...extra,
  } as unknown as OuroCliDeps
  return { deps, startDaemonProcess }
}

describe("daemon startup: a probe that misses after the daemon answered", () => {
  it("keeps waiting through one or two slow probes and reports the daemon started", async () => {
    for (const probes of [[true, false, true], [true, true, false, false, true]]) {
      const { deps, startDaemonProcess } = startupDeps(probes)

      const result = await ensureDaemonRunning(deps)

      expect(result.message).not.toContain("disappeared")
      expect(result.ok).toBe(true)
      expect(startDaemonProcess).toHaveBeenCalledTimes(1)
    }
  })

  it("never calls a daemon whose process is still alive disappeared", async () => {
    const { deps, startDaemonProcess } = startupDeps([true, false, false, false, false, false, true], {
      isProcessAlive: vi.fn(() => true),
    })

    const result = await ensureDaemonRunning(deps)

    expect(result.message).not.toContain("disappeared")
    expect(result.ok).toBe(true)
    expect(startDaemonProcess).toHaveBeenCalledTimes(1)
  })

  it("still reports a daemon that stops answering for three probes in a row", async () => {
    // No retry, so the first attempt's own reason is the result.
    const { deps } = startupDeps([true, ...Array<boolean>(200).fill(false)], { startupRetryLimit: 0 })

    const result = await ensureDaemonRunning(deps)

    expect(result.message).toContain("answered once and then disappeared during startup")
  })
})
