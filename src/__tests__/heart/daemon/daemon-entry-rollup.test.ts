/**
 * Unit 3a: integration-shaped tests that boot the daemon (test-level —
 * no subprocess) with seeded agent snapshots + bootstrap-degraded
 * entries and assert that `buildDaemonHealthState` rolls up to the new
 * vocabulary via `computeDaemonRollup`.
 *
 * Structural precedent: daemon-entry-health-state.test.ts. We reuse its
 * vi.mock setup pattern — process-manager / sense-manager / etc. all
 * stubbed; we drive listAgentSnapshots via the seeded `snapshots`
 * argument; we drive bootstrap-degraded by making
 * migrateHabitsFromTaskSystem throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const { listEnabledBundleAgentsMock } = vi.hoisted(() => ({
  listEnabledBundleAgentsMock: vi.fn(() => [] as string[]),
}))

const {
  habitSchedulerStartMock,
  habitSchedulerStopMock,
  habitSchedulerWatchMock,
  habitSchedulerStopWatchMock,
  habitSchedulerStartPeriodicReconciliationMock,
} = vi.hoisted(() => ({
  habitSchedulerStartMock: vi.fn(),
  habitSchedulerStopMock: vi.fn(),
  habitSchedulerWatchMock: vi.fn(),
  habitSchedulerStopWatchMock: vi.fn(),
  habitSchedulerStartPeriodicReconciliationMock: vi.fn(),
}))

const { migrateHabitsFromTaskSystemMock } = vi.hoisted(() => ({
  migrateHabitsFromTaskSystemMock: vi.fn(),
}))

const { writeDaemonTombstoneMock } = vi.hoisted(() => ({
  writeDaemonTombstoneMock: vi.fn(),
}))

const { registerGlobalLogSinkMock, registeredHealthSinks, capturedHealthStates } = vi.hoisted(() => ({
  registerGlobalLogSinkMock: vi.fn((sink: (entry: { event: string }) => void) => {
    registeredHealthSinks.push(sink)
    return () => {}
  }),
  registeredHealthSinks: [] as Array<(entry: { event: string }) => void>,
  capturedHealthStates: [] as Array<{
    status: string
    pid: number
    safeMode: null
    degraded: Array<{ component: string; reason: string }>
    agents: Record<string, { status: string; pid: number | null; crashes: number }>
  }>,
}))

vi.mock("../../../heart/daemon/agent-discovery", () => ({
  listEnabledBundleAgents: listEnabledBundleAgentsMock,
}))

vi.mock("../../../heart/habits/habit-scheduler", () => ({
  HabitScheduler: class MockHabitScheduler {
    constructor(public options: { agent: string }) {}
    start = habitSchedulerStartMock
    stop = habitSchedulerStopMock
    watchForChanges = habitSchedulerWatchMock
    stopWatching = habitSchedulerStopWatchMock
    startPeriodicReconciliation = habitSchedulerStartPeriodicReconciliationMock
  },
}))

vi.mock("../../../heart/habits/habit-migration", () => ({
  migrateHabitsFromTaskSystem: migrateHabitsFromTaskSystemMock,
}))

vi.mock("../../../heart/daemon/os-cron-deps", () => ({
  createRealOsCronDeps: vi.fn(() => ({
    exec: vi.fn(),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    existsFile: vi.fn(() => false),
    listDir: vi.fn(() => []),
    mkdirp: vi.fn(),
    homeDir: "/mock/home",
  })),
  resolveOuroBinaryPath: vi.fn(() => "/usr/local/bin/ouro"),
}))

vi.mock("../../../heart/daemon/daemon-tombstone", () => ({
  writeDaemonTombstone: writeDaemonTombstoneMock,
}))

vi.mock("../../../heart/config", () => ({
  getBlueBubblesChannelConfig: vi.fn(() => ({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  })),
}))

vi.mock("../../../nerves/index", () => ({
  registerGlobalLogSink: (...args: unknown[]) => registerGlobalLogSinkMock(...args),
}))

vi.mock("../../../heart/daemon/daemon-health", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/daemon/daemon-health")>(
    "../../../heart/daemon/daemon-health",
  )

  return {
    ...actual,
    DaemonHealthWriter: class MockDaemonHealthWriter {
      constructor(_healthPath: string) {}
      writeHealth(_state: unknown): void {}
    },
    createHealthNervesSink: vi.fn((_writer: unknown, getState: () => unknown) => {
      return (entry: { event: string }) => {
        if (actual.HEALTH_TRACKED_EVENTS.has(entry.event)) {
          capturedHealthStates.push(getState() as {
            status: string
            pid: number
            safeMode: null
            degraded: Array<{ component: string; reason: string }>
            agents: Record<string, { status: string; pid: number | null; crashes: number }>
          })
        }
      }
    }),
    getDefaultHealthPath: () => "/tmp/mock-daemon-health.json",
  }
})

describe("daemon-entry rollup vocabulary", () => {
  let testHomeRoot: string
  let originalHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    testHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-entry-rollup-home-"))
    process.env.HOME = testHomeRoot
  })

  afterEach(() => {
    listEnabledBundleAgentsMock.mockReset()
    listEnabledBundleAgentsMock.mockReturnValue([])
    habitSchedulerStartMock.mockReset()
    habitSchedulerStopMock.mockReset()
    habitSchedulerWatchMock.mockReset()
    habitSchedulerStopWatchMock.mockReset()
    habitSchedulerStartPeriodicReconciliationMock.mockReset()
    migrateHabitsFromTaskSystemMock.mockReset()
    writeDaemonTombstoneMock.mockReset()
    registerGlobalLogSinkMock.mockClear()
    registeredHealthSinks.splice(0, registeredHealthSinks.length)
    capturedHealthStates.splice(0, capturedHealthStates.length)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    fs.rmSync(testHomeRoot, { recursive: true, force: true })
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
  })

  function setupDaemonMocks(snapshots: Array<{
    name: string
    channel: string
    status: string
    pid: number | null
    restartCount: number
    lastCrashAt: string | null
    errorReason: string | null
    fixHint: string | null
  }> = []) {
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as never)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as never)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class {
        start = start
        stop = stop
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class {
        listAgentSnapshots = vi.fn(() => snapshots)
        sendToAgent = vi.fn()
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class {
        listSenseRows = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/task-scheduler", () => ({
      TaskDrivenScheduler: class {
        listJobs = vi.fn(() => [])
        triggerJob = vi.fn(async (jobId: string) => ({ ok: false, message: `unknown scheduled job: ${jobId}` }))
      },
    }))
    vi.doMock("../../../heart/daemon/health-monitor", () => ({
      HealthMonitor: class {
        runChecks = vi.fn(async () => [])
        startPeriodicChecks = vi.fn()
        stopPeriodicChecks = vi.fn()
      },
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    return { emitNervesEvent }
  }

  it("returns 'healthy' when two enabled agents are running and there are no bootstrap-degraded entries", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha", "beta"])
    setupDaemonMocks([
      { name: "alpha", channel: "inner-dialog", status: "running", pid: 100, restartCount: 0, lastCrashAt: null, errorReason: null, fixHint: null },
      { name: "beta",  channel: "inner-dialog", status: "running", pid: 101, restartCount: 0, lastCrashAt: null, errorReason: null, fixHint: null },
    ])
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    registeredHealthSinks[0]!({ event: "daemon.agent_started" })
    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]?.status).toBe("healthy")
  })

  it("returns 'partial' when one enabled agent is running and one is crashed", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha", "beta"])
    setupDaemonMocks([
      { name: "alpha", channel: "inner-dialog", status: "running", pid: 100, restartCount: 0, lastCrashAt: null, errorReason: null, fixHint: null },
      { name: "beta",  channel: "inner-dialog", status: "crashed", pid: null, restartCount: 3, lastCrashAt: "2026-04-28T19:30:00.000Z", errorReason: "live-check failed", fixHint: "ouro doctor" },
    ])
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    registeredHealthSinks[0]!({ event: "daemon.agent_exit" })
    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]?.status).toBe("partial")
  })

  it("returns 'degraded' when every enabled agent's live-check fails (zero serving)", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha", "beta"])
    setupDaemonMocks([
      { name: "alpha", channel: "inner-dialog", status: "crashed", pid: null, restartCount: 3, lastCrashAt: null, errorReason: "boom", fixHint: null },
      { name: "beta",  channel: "inner-dialog", status: "stopped", pid: null, restartCount: 0, lastCrashAt: null, errorReason: null, fixHint: null },
    ])
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    registeredHealthSinks[0]!({ event: "daemon.agent_exit" })
    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]?.status).toBe("degraded")
  })

  it("returns 'degraded' when no enabled agents are configured (fresh install — empty inventory)", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue([])
    setupDaemonMocks([])
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    registeredHealthSinks[0]!({ event: "daemon.agent_started" })
    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]?.status).toBe("degraded")
  })

  it("returns 'partial' when agents are healthy but a bootstrap-degraded component was recorded (downgrade rule)", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha"])
    // Force recordRecoverableBootstrapFailure to be called by making
    // migrateHabitsFromTaskSystem throw — same trick as the existing
    // daemon-entry-health-state.test.ts uses to populate
    // degradedComponents[].
    migrateHabitsFromTaskSystemMock.mockImplementationOnce(() => {
      throw new Error("habit migration failed")
    })
    setupDaemonMocks([
      { name: "alpha", channel: "inner-dialog", status: "running", pid: 100, restartCount: 0, lastCrashAt: null, errorReason: null, fixHint: null },
    ])
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // bootstrap_degraded fires after recordRecoverableBootstrapFailure populates
    // degradedComponents[]. The captured state should reflect the partial
    // downgrade (alpha is running, but cron/habits bootstrap failed).
    registeredHealthSinks[0]!({ event: "daemon.bootstrap_degraded" })
    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]?.status).toBe("partial")
    // Sanity: the bootstrap-degraded entry made it into the degraded[] array
    // unchanged — preserving backwards-compatible inspection per the doing doc.
    expect(capturedHealthStates[0]?.degraded.some((d) => d.component === "habits:alpha")).toBe(true)
  })
})
