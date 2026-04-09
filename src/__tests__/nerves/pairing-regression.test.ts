/**
 * Regression tests for nerves `start_end_pairing` audit rule.
 *
 * Three root causes previously caused intermittent audit failures:
 * 1. `applyPendingUpdates` had two early returns that skipped `_end`.
 * 2. `daemon.start()` had no try/catch wrapping ~380 lines of startup —
 *    any throw mid-startup orphaned `daemon.server_start`.
 * 3. `startUpdateChecker` only paired with `_end` if `stopUpdateChecker` was
 *    called.
 *
 * This file locks in the paired-emission contract for each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { applyPendingUpdates } from "../../heart/versioning/update-hooks"
import { startUpdateChecker, stopUpdateChecker } from "../../heart/versioning/update-checker"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"

function captureEvents(): { events: LogEvent[]; unregister: () => void } {
  const events: LogEvent[] = []
  const unregister = registerGlobalLogSink((entry) => {
    events.push(entry)
  })
  return { events, unregister }
}

function pairOk(events: LogEvent[], startEvent: string): boolean {
  const prefix = startEvent.slice(0, -"_start".length)
  const endEvent = `${prefix}_end`
  const errorEvent = `${prefix}_error`
  return events.some((e) => e.event === endEvent || e.event === errorEvent)
}

describe("nerves start_end_pairing — applyPendingUpdates", () => {
  let cap: ReturnType<typeof captureEvents>

  beforeEach(() => {
    cap = captureEvents()
  })

  afterEach(() => {
    cap.unregister()
  })

  it("emits paired _start + _end when bundlesRoot does not exist", async () => {
    const nonexistent = path.join(os.tmpdir(), `pairing-nonexistent-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await applyPendingUpdates(nonexistent, "1.0.0")

    const hasStart = cap.events.some((e) => e.event === "daemon.apply_pending_updates_start")
    expect(hasStart).toBe(true)
    expect(pairOk(cap.events, "daemon.apply_pending_updates_start")).toBe(true)
  })

  it("emits paired _start + _end when readdirSync throws", async () => {
    // Create a file where a directory is expected — readdirSync will throw ENOTDIR
    const notADir = path.join(os.tmpdir(), `pairing-notdir-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.writeFileSync(notADir, "not a directory", "utf-8")
    try {
      await applyPendingUpdates(notADir, "1.0.0")
    } finally {
      fs.unlinkSync(notADir)
    }

    expect(cap.events.some((e) => e.event === "daemon.apply_pending_updates_start")).toBe(true)
    expect(pairOk(cap.events, "daemon.apply_pending_updates_start")).toBe(true)
  })

  it("emits paired _start + _end on the happy path (empty bundles root)", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-happy-"))
    try {
      await applyPendingUpdates(bundlesRoot, "1.0.0")
    } finally {
      fs.rmSync(bundlesRoot, { recursive: true, force: true })
    }

    expect(cap.events.some((e) => e.event === "daemon.apply_pending_updates_start")).toBe(true)
    expect(pairOk(cap.events, "daemon.apply_pending_updates_start")).toBe(true)
  })
})

describe("nerves start_end_pairing — startUpdateChecker/stopUpdateChecker", () => {
  let cap: ReturnType<typeof captureEvents>

  beforeEach(() => {
    vi.useFakeTimers()
    cap = captureEvents()
  })

  afterEach(() => {
    stopUpdateChecker()
    cap.unregister()
    vi.useRealTimers()
  })

  it("emits paired _start + _end when stopUpdateChecker is called", () => {
    startUpdateChecker({
      currentVersion: "0.1.0-alpha.5",
      intervalMs: 1000,
      deps: {
        fetchRegistryJson: async () => ({ "dist-tags": { alpha: "0.1.0-alpha.5" } }),
        distTag: "alpha",
      },
    })
    stopUpdateChecker()

    expect(cap.events.some((e) => e.event === "daemon.update_checker_start")).toBe(true)
    expect(pairOk(cap.events, "daemon.update_checker_start")).toBe(true)
  })
})

describe("nerves start_end_pairing — daemon.start() error path", () => {
  // Use the OuroDaemon construction pattern from daemon-boot-updates.test.ts
  // which is already on the test-isolation allowlist.
  it("emits daemon.server_error when startInner throws, pairing server_start", async () => {
    const cap = captureEvents()
    try {
      // Import dynamically so we can re-mock per test
      vi.resetModules()
      const { OuroDaemon } = await import("../../heart/daemon/daemon")

      // Make applyPendingUpdates throw mid-startup to trigger the error path
      const { applyPendingUpdates: realApply } = await import("../../heart/versioning/update-hooks")
      void realApply // silence unused — we're patching the method directly below

      // Build a daemon with minimal deps and inject a processManager that throws
      const socketPath = path.join(os.tmpdir(), `pairing-throw-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
      const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-throw-bundles-"))

      const processManager = {
        listAgentSnapshots: vi.fn(() => []),
        startAutoStartAgents: vi.fn(async () => {
          throw new Error("simulated mid-startup failure")
        }),
        stopAll: vi.fn(async () => undefined),
        startAgent: vi.fn(async () => undefined),
        sendToAgent: vi.fn(),
      }
      const scheduler = {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async () => ({ ok: true, message: "" })),
        reconcile: vi.fn(async () => undefined),
        recordTaskRun: vi.fn(async () => undefined),
        start: vi.fn(),
        stop: vi.fn(),
      }
      const healthMonitor = { runChecks: vi.fn(async () => []) }
      const router = {
        send: vi.fn(async () => ({ id: "msg-1", queuedAt: new Date().toISOString() })),
        pollInbox: vi.fn(() => []),
      }
      const senseManager = {
        startAutoStartSenses: vi.fn(async () => undefined),
        stopAll: vi.fn(async () => undefined),
        listSenseRows: vi.fn(() => []),
      }

      const daemon = new OuroDaemon({
        socketPath,
        processManager,
        scheduler,
        healthMonitor,
        router,
        bundlesRoot,
        senseManager,
        mode: "dev", // skip update checker so we only test the startInner throw path
      } as any)

      await expect(daemon.start()).rejects.toThrow("simulated mid-startup failure")

      expect(cap.events.some((e) => e.event === "daemon.server_start")).toBe(true)
      expect(cap.events.some((e) => e.event === "daemon.server_error")).toBe(true)

      fs.rmSync(bundlesRoot, { recursive: true, force: true })
    } finally {
      cap.unregister()
    }
  })
})
