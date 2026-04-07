import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const { listEnabledBundleAgentsMock } = vi.hoisted(() => ({
  listEnabledBundleAgentsMock: vi.fn(() => [] as string[]),
}))

vi.mock("../../../heart/daemon/agent-discovery", () => ({
  listEnabledBundleAgents: listEnabledBundleAgentsMock,
}))

const { habitSchedulerStartMock, habitSchedulerStopMock, habitSchedulerWatchMock, habitSchedulerStopWatchMock } = vi.hoisted(() => ({
  habitSchedulerStartMock: vi.fn(),
  habitSchedulerStopMock: vi.fn(),
  habitSchedulerWatchMock: vi.fn(),
  habitSchedulerStopWatchMock: vi.fn(),
}))

const { migrateHabitsFromTaskSystemMock } = vi.hoisted(() => ({
  migrateHabitsFromTaskSystemMock: vi.fn(),
}))

vi.mock("../../../heart/habits/habit-scheduler", () => ({
  HabitScheduler: class MockHabitScheduler {
    constructor(public options: unknown) {}
    start = habitSchedulerStartMock
    stop = habitSchedulerStopMock
    watchForChanges = habitSchedulerWatchMock
    stopWatching = habitSchedulerStopWatchMock
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

describe("daemon entrypoint", () => {
  afterEach(() => {
    listEnabledBundleAgentsMock.mockReset()
    listEnabledBundleAgentsMock.mockReturnValue([])
    habitSchedulerStartMock.mockReset()
    habitSchedulerStopMock.mockReset()
    habitSchedulerWatchMock.mockReset()
    habitSchedulerStopWatchMock.mockReset()
    migrateHabitsFromTaskSystemMock.mockReset()
    writeDaemonTombstoneMock.mockReset()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("boots daemon with default socket and wires signal handlers", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger", "ouroboros"])

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const daemonCtor = vi.fn()
    const processManagerCtor = vi.fn()
    const senseManagerCtor = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    const onHandlers: Record<string, () => void> = {}
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, cb: () => void) => {
      onHandlers[event] = cb
      return process
    }) as any)

    class MockOuroDaemon {
      constructor(_opts: unknown) {
        daemonCtor(_opts)
      }
      start = start
      stop = stop
    }

    class MockProcessManager {
      listAgentSnapshots = vi.fn(() => [{ name: "slugger", status: "crashed" }])
      constructor(_opts: unknown) {
        processManagerCtor(_opts)
      }
    }

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: MockProcessManager,
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        constructor(_opts: unknown) {
          senseManagerCtor(_opts)
        }
        listSenseRows = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()

    expect(start).toHaveBeenCalledTimes(1)
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("daemon")
    expect(processManagerCtor).toHaveBeenCalledTimes(1)
    expect(senseManagerCtor).toHaveBeenCalledTimes(1)
    expect(daemonCtor).toHaveBeenCalledTimes(1)

    const processManagerOptions = processManagerCtor.mock.calls[0]?.[0] as {
      agents: Array<{ entry: string }>
    }
    expect(processManagerOptions.agents.length).toBeGreaterThan(0)
    expect(processManagerOptions.agents.every((agent) => agent.entry === "heart/agent-entry.js")).toBe(true)

    const daemonOptions = daemonCtor.mock.calls[0]?.[0] as {
      senseManager: {
        listSenseRows: () => unknown[]
      }
      scheduler: {
        listJobs: () => unknown[]
        triggerJob: (jobId: string) => Promise<{ ok: boolean; message: string }>
      }
      healthMonitor: { runChecks: () => Promise<unknown[]> }
      router: {
        send: (message: { from: string; to: string; content: string; priority?: string }) => Promise<{ id: string; queuedAt: string }>
        pollInbox: (agent: string) => unknown[]
      }
    }
    expect(daemonOptions.senseManager.listSenseRows()).toEqual([])
    expect(daemonOptions.scheduler.listJobs()).toEqual([])
    await expect(daemonOptions.scheduler.triggerJob("nightly")).resolves.toEqual({
      ok: false,
      message: "unknown scheduled job: nightly",
    })
    await expect(daemonOptions.healthMonitor.runChecks()).resolves.toEqual([
      { name: "agent-processes", status: "critical", message: "non-running agents: slugger" },
      { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
      { name: "disk-space", status: "ok", message: "disk usage healthy (0%)" },
    ])
    await expect(daemonOptions.router.send({
      from: "slugger",
      to: "ouroboros",
      content: "hi",
    })).resolves.toEqual(
      expect.objectContaining({ id: expect.stringContaining("msg-") }),
    )
    expect(daemonOptions.router.pollInbox("ouroboros")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "slugger", to: "ouroboros", content: "hi" }),
      ]),
    )

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.entry_start",
        meta: expect.objectContaining({
          socketPath: "/tmp/ouroboros-daemon.sock",
          entryPath: expect.stringContaining("daemon-entry.js"),
          mode: expect.stringMatching(/^(dev|production)$/),
        }),
      }),
    )
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daemon.health_alert" }),
    )
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function))

    // HabitScheduler should be started (not HeartbeatTimer)
    expect(habitSchedulerStartMock).toHaveBeenCalled()
    // Migration should be called before scheduler start
    expect(migrateHabitsFromTaskSystemMock).toHaveBeenCalled()

    onHandlers.SIGINT?.()
    await Promise.resolve()
    expect(stop).toHaveBeenCalled()
    // HabitScheduler should be stopped on SIGINT
    expect(habitSchedulerStopMock).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
    // Tombstone is now written on SIGINT (regression: previous behavior was
    // to set _gracefulShutdown=true and skip the tombstone, leaving signal-driven
    // shutdowns invisible in the death log)
    expect(writeDaemonTombstoneMock).toHaveBeenCalledWith("sigint", expect.any(Error))

    writeDaemonTombstoneMock.mockClear()
    onHandlers.SIGTERM?.()
    await Promise.resolve()
    expect(exitSpy).toHaveBeenCalledWith(0)
    // Same fix for SIGTERM — was the more common silent-death cause because
    // killOrphanProcesses, launchd policies, and the OOM killer all use SIGTERM
    expect(writeDaemonTombstoneMock).toHaveBeenCalledWith("sigterm", expect.any(Error))

    argvSpy.mockRestore()
  })

  it("discovers managed agents from ~/AgentBundles instead of hardcoding them", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["Juno", "Northstar", "slugger"])

    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-entry-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    fs.mkdirSync(bundlesRoot, { recursive: true })
    for (const [name, enabled] of [
      ["Juno", true],
      ["Northstar", true],
      ["slugger", true],
      ["Disabled", false],
    ] as const) {
      const agentRoot = path.join(bundlesRoot, `${name}.ouro`)
      fs.mkdirSync(agentRoot, { recursive: true })
      fs.writeFileSync(
        path.join(agentRoot, "agent.json"),
        JSON.stringify({
          version: 1,
          enabled,
          provider: "anthropic",
          phrases: { thinking: ["t"], tool: ["x"], followup: ["f"] },
        }, null, 2) + "\n",
        "utf-8",
      )
    }

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const processManagerCtor = vi.fn()
    const schedulerCtor = vi.fn()
    const senseManagerCtor = vi.fn()

    vi.spyOn(process, "on").mockImplementation(((
      _event: string,
      _cb: () => void,
    ) => process) as any)

    class MockOuroDaemon {
      start = start
      stop = stop
    }

    class MockProcessManager {
      constructor(options: unknown) {
        processManagerCtor(options)
      }
      listAgentSnapshots = vi.fn(() => [])
    }

    class MockScheduler {
      constructor(options: unknown) {
        schedulerCtor(options)
      }
      listJobs = vi.fn(() => [])
      triggerJob = vi.fn(async (jobId: string) => ({ ok: false, message: `unknown scheduled job: ${jobId}` }))
    }

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => homeRoot }
    })
    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: MockProcessManager,
    }))
    vi.doMock("../../../heart/daemon/task-scheduler", () => ({
      TaskDrivenScheduler: MockScheduler,
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        constructor(options: unknown) {
          senseManagerCtor(options)
        }
        listSenseRows = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()

    expect(processManagerCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [
          expect.objectContaining({ name: "Juno" }),
          expect.objectContaining({ name: "Northstar" }),
          expect.objectContaining({ name: "slugger" }),
        ],
      }),
    )
    expect(schedulerCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ["Juno", "Northstar", "slugger"],
      }),
    )
    expect(senseManagerCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ["Juno", "Northstar", "slugger"],
      }),
    )

    argvSpy.mockRestore()
  })

  it("emits error and exits when daemon start fails", async () => {
    vi.resetModules()

    const start = vi.fn(async () => {
      throw new Error("boom")
    })
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const daemonCtor = vi.fn()
    const processManagerCtor = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((
      _event: string,
      _cb: () => void,
    ) => process) as any)

    class MockOuroDaemon {
      constructor(_opts: unknown) {
        daemonCtor(_opts)
      }
      start = start
      stop = stop
    }

    class MockProcessManager {
      listAgentSnapshots = vi.fn(() => [])
      constructor(_opts: unknown) {
        processManagerCtor(_opts)
      }
    }

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: MockProcessManager,
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "daemon-entry.js",
      "--socket",
      "/tmp/custom.sock",
    ])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daemon.entry_error" }),
    )
    expect(writeDaemonTombstoneMock).toHaveBeenCalledWith(
      "startupFailure",
      expect.objectContaining({ message: "boom" }),
    )
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("daemon")
    expect(processManagerCtor).toHaveBeenCalledTimes(1)
    expect(daemonCtor).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)

    argvSpy.mockRestore()
  })

  it("falls back to default socket when --socket value is blank", async () => {
    vi.resetModules()

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    vi.spyOn(process, "on").mockImplementation(((
      _event: string,
      _cb: () => void,
    ) => process) as any)

    class MockOuroDaemon {
      start = start
      stop = stop
    }

    class MockProcessManager {
      listAgentSnapshots = vi.fn(() => [])
    }

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: MockProcessManager,
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "daemon-entry.js",
      "--socket",
      "   ",
    ])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.entry_start",
        meta: expect.objectContaining({
          socketPath: "/tmp/ouroboros-daemon.sock",
          entryPath: expect.stringContaining("daemon-entry.js"),
          mode: expect.stringMatching(/^(dev|production)$/),
        }),
      }),
    )
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("daemon")

    argvSpy.mockRestore()
  })

  it("emits dev mode indicator event when running from a dev context", async () => {
    vi.resetModules()

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    vi.spyOn(process, "on").mockImplementation(((
      _event: string,
      _cb: () => void,
    ) => process) as any)

    class MockOuroDaemon {
      start = start
      stop = stop
    }

    class MockProcessManager {
      listAgentSnapshots = vi.fn(() => [])
    }

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: MockProcessManager,
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    vi.doMock("../../../heart/daemon/runtime-mode", () => ({
      detectRuntimeMode: () => "dev",
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.dev_mode_indicator",
        message: expect.stringContaining("[dev] running from"),
        meta: expect.objectContaining({
          repoRoot: expect.any(String),
        }),
      }),
    )

    argvSpy.mockRestore()
  })
})
