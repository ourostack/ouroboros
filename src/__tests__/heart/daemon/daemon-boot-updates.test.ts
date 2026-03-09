import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// Mock update-hooks module
const mockApplyPendingUpdates = vi.fn(async () => undefined)
vi.mock("../../../heart/daemon/update-hooks", () => ({
  applyPendingUpdates: mockApplyPendingUpdates,
  registerUpdateHook: vi.fn(),
  getRegisteredHooks: vi.fn(() => []),
  clearRegisteredHooks: vi.fn(),
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
    mockApplyPendingUpdates.mockClear()
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

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      bundlesRoot,
      senseManager,
    } as any)
    return { daemon, processManager }
  }

  it("calls applyPendingUpdates with bundlesRoot and current version during start()", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-updates-"))
    const socketPath = tmpSocketPath("daemon-boot-updates")
    const { daemon } = makeDaemon(socketPath, bundlesRoot)

    await daemon.start()
    await daemon.stop()

    expect(mockApplyPendingUpdates).toHaveBeenCalledTimes(1)
    expect(mockApplyPendingUpdates).toHaveBeenCalledWith(bundlesRoot, "0.1.0-test")

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("calls applyPendingUpdates before startAutoStartAgents", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-order-"))
    const socketPath = tmpSocketPath("daemon-boot-order")
    const callOrder: string[] = []

    mockApplyPendingUpdates.mockImplementation(async () => {
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

  it("does not call applyPendingUpdates if daemon is already started", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-boot-idempotent-"))
    const socketPath = tmpSocketPath("daemon-boot-idempotent")
    const { daemon } = makeDaemon(socketPath, bundlesRoot)

    await daemon.start()
    mockApplyPendingUpdates.mockClear()
    await daemon.start() // second call should be no-op
    await daemon.stop()

    expect(mockApplyPendingUpdates).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
