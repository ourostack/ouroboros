import { afterEach, describe, expect, it, vi } from "vitest"
import * as os from "os"
import * as path from "path"

// ── hoisted mock fns ──
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn().mockResolvedValue(undefined),
  getPackageVersion: vi.fn().mockReturnValue("0.1.0-alpha.20"),
  registerUpdateHook: vi.fn(),
}))

vi.mock("../../../heart/versioning/update-hooks", () => ({
  applyPendingUpdates: mocks.applyPendingUpdates,
  registerUpdateHook: mocks.registerUpdateHook,
  clearRegisteredHooks: vi.fn(),
  getRegisteredHooks: vi.fn().mockReturnValue([]),
}))

vi.mock("../../../mind/bundle-manifest", () => ({
  getPackageVersion: mocks.getPackageVersion,
  getChangelogPath: vi.fn().mockReturnValue("/tmp/changelog.json"),
  createBundleMeta: vi.fn().mockReturnValue({
    runtimeVersion: "0.1.0-alpha.20",
    bundleSchemaVersion: 1,
    lastUpdated: "2026-01-01T00:00:00Z",
  }),
  backfillBundleMeta: vi.fn(),
  resetBackfillTracking: vi.fn(),
  CANONICAL_BUNDLE_MANIFEST: [],
  isCanonicalBundlePath: vi.fn().mockReturnValue(true),
  findNonCanonicalBundlePaths: vi.fn().mockReturnValue([]),
}))

import { OuroDaemon } from "../../../heart/daemon/daemon"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

describe("daemon update wiring", () => {
  const makeDaemon = (bundlesRoot?: string) => {
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    }

    const scheduler = {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async () => ({ ok: true, message: "ok" })),
      reconcile: vi.fn(async () => undefined),
      recordTaskRun: vi.fn(async () => undefined),
    }

    const healthMonitor = {
      runChecks: vi.fn(async () => []),
    }

    const router = {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-01-01T00:00:00Z" })),
      pollInbox: vi.fn(() => []),
    }

    const senseManager = {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    }

    const socketPath = tmpSocketPath("daemon-update-wiring")
    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      senseManager,
      bundlesRoot: bundlesRoot ?? "/tmp/test-bundles",
    } as any)

    return { daemon, processManager, socketPath }
  }

  afterEach(async () => {
    vi.clearAllMocks()
  })

  it("calls applyPendingUpdates during start() before startAutoStartAgents", async () => {
    const { daemon, processManager, socketPath } = makeDaemon("/tmp/test-bundles")
    const callOrder: string[] = []

    mocks.applyPendingUpdates.mockImplementation(async () => {
      callOrder.push("applyPendingUpdates")
    })
    processManager.startAutoStartAgents.mockImplementation(async () => {
      callOrder.push("startAutoStartAgents")
    })

    try {
      await daemon.start()

      expect(mocks.applyPendingUpdates).toHaveBeenCalledTimes(1)
      expect(mocks.applyPendingUpdates).toHaveBeenCalledWith(
        "/tmp/test-bundles",
        "0.1.0-alpha.20",
      )
      expect(callOrder.indexOf("applyPendingUpdates")).toBeLessThan(
        callOrder.indexOf("startAutoStartAgents"),
      )
    } finally {
      await daemon.stop()
    }
  })

  it("registers bundleMetaHook on start", async () => {
    const { daemon } = makeDaemon()

    try {
      await daemon.start()
      expect(mocks.registerUpdateHook).toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })
})
