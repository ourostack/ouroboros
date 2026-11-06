import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const { listEnabledBundleAgentsMock } = vi.hoisted(() => ({
  listEnabledBundleAgentsMock: vi.fn(() => [] as string[]),
}))

vi.mock("../../../heart/daemon/agent-discovery", () => ({
  listEnabledBundleAgents: listEnabledBundleAgentsMock,
}))

const {
  habitSchedulerStartMock,
  habitSchedulerStopMock,
  habitSchedulerWatchMock,
  habitSchedulerStopWatchMock,
  habitSchedulerStartPeriodicReconciliationMock,
  habitSchedulerCtorHook,
} = vi.hoisted(() => ({
  habitSchedulerStartMock: vi.fn(),
  habitSchedulerStopMock: vi.fn(),
  habitSchedulerWatchMock: vi.fn(),
  habitSchedulerStopWatchMock: vi.fn(),
  habitSchedulerStartPeriodicReconciliationMock: vi.fn(),
  habitSchedulerCtorHook: vi.fn(),
}))

const { migrateHabitsFromTaskSystemMock } = vi.hoisted(() => ({
  migrateHabitsFromTaskSystemMock: vi.fn(),
}))

vi.mock("../../../heart/habits/habit-scheduler", () => ({
  HabitScheduler: class MockHabitScheduler {
    constructor(public options: { agent: string }) {
      // Allow tests to throw from the constructor by configuring habitSchedulerCtorHook
      habitSchedulerCtorHook(options)
    }
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

const { writeDaemonTombstoneMock } = vi.hoisted(() => ({
  writeDaemonTombstoneMock: vi.fn(),
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

describe("daemon entry error boundary — per-agent habit setup isolation", () => {
  let testHomeRoot: string
  let originalHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    testHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-entry-error-home-"))
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
    habitSchedulerCtorHook.mockReset()
    migrateHabitsFromTaskSystemMock.mockReset()
    writeDaemonTombstoneMock.mockReset()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    fs.rmSync(testHomeRoot, { recursive: true, force: true })
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
  })

  /**
   * Helper: set up standard mocks for daemon-entry import.
   * Returns the emitNervesEvent spy so callers can inspect what events were emitted.
   */
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
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    return { emitNervesEvent, start, stop }
  }

  it("continues setting up remaining agents when HabitScheduler constructor throws for one agent", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha", "bravo", "charlie"])

    // Make the HabitScheduler constructor throw only for "bravo"
    habitSchedulerCtorHook.mockImplementation((options: { agent: string }) => {
      if (options.agent === "bravo") {
        throw new Error("HabitScheduler init failed for bravo")
      }
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => {
      expect(habitSchedulerStartMock).toHaveBeenCalledTimes(2)
      expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(2)
    })

    // alpha and charlie should have had their schedulers started
    expect(habitSchedulerStartMock).toHaveBeenCalledTimes(2)
    expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(2)

    // Error should have been logged for bravo
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_setup_error",
        meta: expect.objectContaining({
          agent: "bravo",
        }),
      }),
    )

    // process.exit should NOT have been called (daemon stays alive)
    expect(process.exit).not.toHaveBeenCalled()
  })

  it("continues when migrateHabitsFromTaskSystem throws for one agent", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha", "bravo"])

    // Make migration throw only for alpha
    migrateHabitsFromTaskSystemMock.mockImplementation((bundleRoot: string) => {
      if (bundleRoot.includes("alpha")) {
        throw new Error("migration failed for alpha")
      }
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => {
      expect(habitSchedulerStartMock).toHaveBeenCalledTimes(1)
      expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(1)
    })

    // bravo should still have its scheduler started
    expect(habitSchedulerStartMock).toHaveBeenCalledTimes(1)
    expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(1)

    // Error logged for alpha
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_setup_error",
        meta: expect.objectContaining({
          agent: "alpha",
        }),
      }),
    )
  })

  it("continues when scheduler.start() throws for one agent", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["alpha", "bravo"])

    // Make start() throw only on first call (alpha)
    let startCallCount = 0
    habitSchedulerStartMock.mockImplementation(() => {
      startCallCount++
      if (startCallCount === 1) {
        throw new Error("start failed for alpha")
      }
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => {
      expect(habitSchedulerStartMock).toHaveBeenCalledTimes(2)
      expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(1)
    })

    // Both agents had their constructors called, both had start() called
    expect(habitSchedulerStartMock).toHaveBeenCalledTimes(2)
    // Only bravo's watchForChanges should have been called (alpha threw during start)
    expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(1)

    // Error logged for alpha
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_setup_error",
        meta: expect.objectContaining({
          agent: "alpha",
        }),
      }),
    )
  })

  it("emits nerves event with the failing agent name in the error metadata", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["failbot"])

    habitSchedulerStartMock.mockImplementation(() => {
      throw new Error("scheduler kaboom")
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          component: "daemon",
          event: "daemon.habit_setup_error",
          message: expect.stringContaining("failbot"),
          meta: expect.objectContaining({
            agent: "failbot",
            error: "scheduler kaboom",
          }),
        }),
      )
    })

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_setup_error",
        message: expect.stringContaining("failbot"),
        meta: expect.objectContaining({
          agent: "failbot",
          error: "scheduler kaboom",
        }),
      }),
    )
  })

  it("all non-failing agents still get their habit schedulers started when multiple agents fail", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["a1", "a2", "a3", "a4"])

    // a2 migration fails
    migrateHabitsFromTaskSystemMock.mockImplementation((bundleRoot: string) => {
      if (bundleRoot.includes("a2")) {
        throw new Error("migration failed")
      }
    })

    // a3 start fails (it's the 2nd successful constructor: a1, a3, a4 get constructed; a2 fails at migration)
    let startCount = 0
    habitSchedulerStartMock.mockImplementation(() => {
      startCount++
      if (startCount === 2) {
        throw new Error("start failed")
      }
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => {
      expect(habitSchedulerStartMock).toHaveBeenCalledTimes(3)
      expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(2)
    })

    // a1 and a4 should have watchForChanges called (a2 failed at migration, a3 failed at start)
    expect(habitSchedulerWatchMock).toHaveBeenCalledTimes(2)

    // Two error events should have been emitted
    const errorEvents = (emitNervesEvent.mock.calls as Array<[{ event?: string }]>).filter(
      (call) => call[0].event === "daemon.habit_setup_error",
    )
    expect(errorEvents).toHaveLength(2)

    // process.exit should NOT have been called
    expect(process.exit).not.toHaveBeenCalled()
  })

  it("handles non-Error throws by converting to string in the error metadata", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["stringbot"])

    // Throw a raw string instead of an Error object
    habitSchedulerCtorHook.mockImplementation(() => {
      throw "raw string failure"  // eslint-disable-line no-throw-literal
    })

    const { emitNervesEvent } = setupDaemonMocks()
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          component: "daemon",
          event: "daemon.habit_setup_error",
          meta: expect.objectContaining({
            agent: "stringbot",
            error: "raw string failure",
          }),
        }),
      )
    })

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_setup_error",
        meta: expect.objectContaining({
          agent: "stringbot",
          error: "raw string failure",
        }),
      }),
    )
  })
})
