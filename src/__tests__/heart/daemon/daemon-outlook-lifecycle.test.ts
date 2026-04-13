import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { OuroDaemon } from "../../../heart/daemon/daemon"
import type { OutlookHttpServerHandle } from "../../../heart/outlook/outlook-http"

/**
 * Covers the OuroDaemon Outlook HTTP server lifecycle via the injected
 * outlookServerFactory seam. Previously this code path sat behind a v8
 * ignore block because the real factory binds port 6876, which is held
 * by the running production daemon on dev machines and caused
 * EADDRINUSE flakes. DI lets us exercise the full start→stop path with
 * an process-local stub — no port, no races.
 */

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function makeStubHandle(stop: () => Promise<void>): OutlookHttpServerHandle {
  return {
    origin: "http://127.0.0.1:0",
    broadcast: vi.fn(),
    stop,
  }
}

function makeDaemonDeps() {
  const processManager = {
    listAgentSnapshots: vi.fn(() => []),
    startAutoStartAgents: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    sendToAgent: vi.fn(),
  }
  const scheduler = {
    listJobs: vi.fn(() => []),
    triggerJob: vi.fn(async () => ({ ok: true, message: "" })),
    reconcile: vi.fn(async () => undefined),
  }
  const healthMonitor = { runChecks: vi.fn(async () => []) }
  const router = {
    send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-04-08T00:00:00.000Z" })),
    pollInbox: vi.fn(() => []),
  }
  const senseManager = {
    startAutoStartSenses: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    listSenseRows: vi.fn(() => []),
  }
  return { processManager, scheduler, healthMonitor, router, senseManager }
}

describe("OuroDaemon outlook server lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the injected outlook server during daemon.start and stops it during daemon.stop", async () => {
    const socketPath = tmpSocketPath("outlook-lifecycle-happy")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-lifecycle-"))
    const stopSpy = vi.fn(async () => undefined)
    const factory = vi.fn(async () => makeStubHandle(stopSpy))

    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot,
      outlookServerFactory: factory,
      ...makeDaemonDeps(),
    } as any)

    await daemon.start()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(stopSpy).not.toHaveBeenCalled()

    await daemon.stop()
    expect(stopSpy).toHaveBeenCalledTimes(1)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("continues daemon startup when the outlook factory throws, emitting a warn event and leaving outlookServer unset", async () => {
    const socketPath = tmpSocketPath("outlook-lifecycle-throw")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-lifecycle-"))
    const factory = vi.fn(async () => {
      throw new Error("simulated bind failure")
    })

    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot,
      outlookServerFactory: factory,
      ...makeDaemonDeps(),
    } as any)

    // start() must NOT throw even though the factory does
    await expect(daemon.start()).resolves.toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(1)

    // stop() must not try to call .stop() on the null handle — just no-op
    await expect(daemon.stop()).resolves.toBeUndefined()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("does not recreate the outlook server on a second daemon.start call", async () => {
    const socketPath = tmpSocketPath("outlook-lifecycle-double-start")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-lifecycle-"))
    const stopSpy = vi.fn(async () => undefined)
    const factory = vi.fn(async () => makeStubHandle(stopSpy))

    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot,
      outlookServerFactory: factory,
      ...makeDaemonDeps(),
    } as any)

    await daemon.start()
    // Second start(): the outer guard `if (this.server) return` short-circuits,
    // so the factory is not invoked again.
    await daemon.start()
    expect(factory).toHaveBeenCalledTimes(1)

    await daemon.stop()
    expect(stopSpy).toHaveBeenCalledTimes(1)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
