import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// Hoisted mocks (available before vi.mock factories run)
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  startUpdateChecker: vi.fn(),
  stopUpdateChecker: vi.fn(),
}))

// Mock update-hooks module
vi.mock("../../../heart/versioning/update-hooks", () => ({
  applyPendingUpdates: (...a: any[]) => mocks.applyPendingUpdates(...a),
  registerUpdateHook: vi.fn(),
  getRegisteredHooks: vi.fn(() => []),
  clearRegisteredHooks: vi.fn(),
}))

// Mock bundle-meta hook (daemon imports this)
vi.mock("../../../heart/daemon/hooks/bundle-meta", () => ({
  bundleMetaHook: vi.fn(),
}))

// Mock update-checker
vi.mock("../../../heart/versioning/update-checker", () => ({
  startUpdateChecker: (...a: any[]) => mocks.startUpdateChecker(...a),
  stopUpdateChecker: (...a: any[]) => mocks.stopUpdateChecker(...a),
}))

// Mock staged-restart (daemon imports this)
vi.mock("../../../heart/versioning/staged-restart", () => ({
  performStagedRestart: vi.fn(),
}))

// Mock bundle-manifest to control getPackageVersion
vi.mock("../../../mind/bundle-manifest", () => ({
  getPackageVersion: vi.fn(() => "0.1.0-test"),
  getChangelogPath: vi.fn(() => "/mock/changelog.json"),
  backfillBundleMeta: vi.fn(),
  createBundleMeta: vi.fn(),
}))

import { OuroDaemon } from "../../../heart/daemon/daemon"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

describe("daemon boot: applyPendingUpdates wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mocks.applyPendingUpdates.mockClear()
    mocks.startUpdateChecker.mockClear()
    mocks.stopUpdateChecker.mockClear()
  })

  function makeDaemon(socketPath: string, bundlesRoot?: string) {
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    }

    const scheduler = {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
      reconcile: vi.fn(async () => undefined),
      recordTaskRun: vi.fn(async () => undefined),
    }

    const healthMonitor = {
      runChecks: vi.fn(async () => []),
    }

    const router = {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
      pollInbox: vi.fn(() => []),
    }

    const senseManager = {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    }
    const outlookServerFactory = vi.fn(async () => ({
      origin: "http://127.0.0.1:0",
      stop: vi.fn(async () => undefined),
    }))

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      bundlesRoot,
      senseManager,
      outlookServerFactory,
    } as any)
    return { daemon, processManager }
  }

  it("calls applyPendingUpdates with bundlesRoot and current version during start()", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-updates-"))
    const socketPath = tmpSocketPath("daemon-boot-updates")
    const { daemon } = makeDaemon(socketPath, bundlesRoot)

    await daemon.start()
    await daemon.stop()

    expect(mocks.applyPendingUpdates).toHaveBeenCalledTimes(1)
    expect(mocks.applyPendingUpdates).toHaveBeenCalledWith(bundlesRoot, "0.1.0-test")

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("calls applyPendingUpdates before startAutoStartAgents", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-order-"))
    const socketPath = tmpSocketPath("daemon-boot-order")
    const callOrder: string[] = []

    mocks.applyPendingUpdates.mockImplementation(async () => {
      callOrder.push("applyPendingUpdates")
    })

    const { daemon, processManager } = makeDaemon(socketPath, bundlesRoot)
    processManager.startAutoStartAgents.mockImplementation(async () => {
      callOrder.push("startAutoStartAgents")
    })

    await daemon.start()
    await daemon.stop()

    expect(callOrder).toEqual(["applyPendingUpdates", "startAutoStartAgents"])

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("starts update checker during start()", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-checker-"))
    const socketPath = tmpSocketPath("daemon-boot-checker")
    const { daemon } = makeDaemon(socketPath, bundlesRoot)

    await daemon.start()
    await daemon.stop()

    expect(mocks.startUpdateChecker).toHaveBeenCalledTimes(1)
    expect(mocks.startUpdateChecker).toHaveBeenCalledWith(
      expect.objectContaining({
        currentVersion: "0.1.0-test",
        deps: expect.objectContaining({ distTag: "latest" }),
      }),
    )

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("stops update checker during stop()", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-stop-checker-"))
    const socketPath = tmpSocketPath("daemon-boot-stop-checker")
    const { daemon } = makeDaemon(socketPath, bundlesRoot)

    await daemon.start()
    mocks.stopUpdateChecker.mockClear()
    await daemon.stop()

    expect(mocks.stopUpdateChecker).toHaveBeenCalledTimes(1)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("does not call applyPendingUpdates if daemon is already started", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-idempotent-"))
    const socketPath = tmpSocketPath("daemon-boot-idempotent")
    const { daemon } = makeDaemon(socketPath, bundlesRoot)

    await daemon.start()
    mocks.applyPendingUpdates.mockClear()
    await daemon.start() // second call should be no-op
    await daemon.stop()

    expect(mocks.applyPendingUpdates).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("skips update checker when daemon mode is dev", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-dev-mode-"))
    const socketPath = tmpSocketPath("daemon-boot-dev-mode")

    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    }
    const scheduler = {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
      reconcile: vi.fn(async () => undefined),
      recordTaskRun: vi.fn(async () => undefined),
    }
    const healthMonitor = { runChecks: vi.fn(async () => []) }
    const router = {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
      pollInbox: vi.fn(() => []),
    }
    const senseManager = {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    }
    const outlookServerFactory = vi.fn(async () => ({
      origin: "http://127.0.0.1:0",
      stop: vi.fn(async () => undefined),
    }))

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      bundlesRoot,
      senseManager,
      mode: "dev",
      outlookServerFactory,
    } as any)

    await daemon.start()
    await daemon.stop()

    expect(mocks.startUpdateChecker).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("starts update checker when daemon mode is production", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-prod-mode-"))
    const socketPath = tmpSocketPath("daemon-boot-prod-mode")

    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    }
    const scheduler = {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
      reconcile: vi.fn(async () => undefined),
      recordTaskRun: vi.fn(async () => undefined),
    }
    const healthMonitor = { runChecks: vi.fn(async () => []) }
    const router = {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
      pollInbox: vi.fn(() => []),
    }
    const senseManager = {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    }
    const outlookServerFactory = vi.fn(async () => ({
      origin: "http://127.0.0.1:0",
      stop: vi.fn(async () => undefined),
    }))

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      bundlesRoot,
      senseManager,
      mode: "production",
      outlookServerFactory,
    } as any)

    await daemon.start()
    await daemon.stop()

    expect(mocks.startUpdateChecker).toHaveBeenCalledTimes(1)

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
