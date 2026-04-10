import { afterEach, describe, expect, it, vi } from "vitest"

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
          })
        }
      }
    }),
    getDefaultHealthPath: () => "/tmp/mock-daemon-health.json",
  }
})

describe("daemon entry health state wiring", () => {
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
  })

  function setupDaemonMocks() {
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
        listAgentSnapshots = vi.fn(() => [])
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

  it("captures an ok health snapshot when no components are degraded", async () => {
    vi.resetModules()
    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(registerGlobalLogSinkMock).toHaveBeenCalledTimes(1)
    registeredHealthSinks[0]!({ event: "daemon.agent_started" })

    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]).toMatchObject({
      status: "ok",
      pid: process.pid,
      safeMode: null,
      degraded: [],
    })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.entry_start",
    }))
  })

  it("deduplicates repeated degraded components and keeps the latest reason", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger", "slugger"])
    migrateHabitsFromTaskSystemMock
      .mockImplementationOnce(() => {
        throw new Error("first failure")
      })
      .mockImplementationOnce(() => {
        throw new Error("second failure")
      })

    setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    registeredHealthSinks[0]!({ event: "daemon.bootstrap_degraded" })

    expect(capturedHealthStates).toHaveLength(1)
    expect(capturedHealthStates[0]?.status).toBe("degraded")
    expect(capturedHealthStates[0]?.degraded).toEqual([
      expect.objectContaining({
        component: "habits:slugger",
        reason: expect.stringContaining("second failure"),
      }),
    ])
  })

  it("stringifies non-Error scheduler.start failures in degraded bootstrap events", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    habitSchedulerStartMock.mockImplementationOnce(() => {
      throw "raw start failure" // eslint-disable-line no-throw-literal
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "daemon.bootstrap_degraded",
      meta: expect.objectContaining({
        error: "raw start failure",
      }),
    }))
  })
})
