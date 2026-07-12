import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildAlertId } from "../../../heart/daemon/pulse"

const { listEnabledBundleAgentsMock, readPrivateRuntimeConfigMock } = vi.hoisted(() => ({
  listEnabledBundleAgentsMock: vi.fn(() => [] as string[]),
  readPrivateRuntimeConfigMock: vi.fn(() => ({ autoStart: false, source: "default" })),
}))

vi.mock("../../../heart/daemon/agent-discovery", () => ({
  listEnabledBundleAgents: listEnabledBundleAgentsMock,
  readPrivateRuntimeConfig: readPrivateRuntimeConfigMock,
}))

const { refreshProviderCredentialPoolMock } = vi.hoisted(() => ({
  refreshProviderCredentialPoolMock: vi.fn(async () => ({
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: { schemaVersion: 1, updatedAt: "2026-04-13T00:00:00.000Z", providers: {} },
  })),
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: refreshProviderCredentialPoolMock,
  }
})

const { habitSchedulerOptionsMock, habitSchedulerStartMock, habitSchedulerStopMock, habitSchedulerWatchMock, habitSchedulerStopWatchMock, habitSchedulerStartPeriodicReconciliationMock, habitSchedulerListJobsMock, habitSchedulerGetDegradedHabitsMock, habitSchedulerTriggerJobMock } = vi.hoisted(() => ({
  habitSchedulerOptionsMock: vi.fn(),
  habitSchedulerStartMock: vi.fn(),
  habitSchedulerStopMock: vi.fn(),
  habitSchedulerWatchMock: vi.fn(),
  habitSchedulerStopWatchMock: vi.fn(),
  habitSchedulerStartPeriodicReconciliationMock: vi.fn(),
  habitSchedulerListJobsMock: vi.fn(),
  habitSchedulerGetDegradedHabitsMock: vi.fn(() => [] as Array<{ name: string; reason: string }>),
  habitSchedulerTriggerJobMock: vi.fn(),
}))

const { awaitSchedulerOptionsMock, awaitSchedulerStartMock, awaitSchedulerStopMock, awaitSchedulerWatchMock, awaitSchedulerStopWatchMock, awaitSchedulerStartPeriodicReconciliationMock, awaitSchedulerGetDegradedAwaitsMock } = vi.hoisted(() => ({
  awaitSchedulerOptionsMock: vi.fn(),
  awaitSchedulerStartMock: vi.fn(),
  awaitSchedulerStopMock: vi.fn(),
  awaitSchedulerWatchMock: vi.fn(),
  awaitSchedulerStopWatchMock: vi.fn(),
  awaitSchedulerStartPeriodicReconciliationMock: vi.fn(),
  awaitSchedulerGetDegradedAwaitsMock: vi.fn(() => [] as Array<{ name: string; reason: string }>),
}))

const { migrateHabitsFromTaskSystemMock } = vi.hoisted(() => ({
  migrateHabitsFromTaskSystemMock: vi.fn(),
}))

vi.mock("../../../heart/habits/habit-scheduler", () => ({
  HabitScheduler: class MockHabitScheduler {
    constructor(public options: unknown) {
      habitSchedulerOptionsMock(options)
    }
    start = habitSchedulerStartMock
    stop = habitSchedulerStopMock
    watchForChanges = habitSchedulerWatchMock
    stopWatching = habitSchedulerStopWatchMock
    startPeriodicReconciliation = habitSchedulerStartPeriodicReconciliationMock
    listJobs = habitSchedulerListJobsMock
    getDegradedHabits = habitSchedulerGetDegradedHabitsMock
    triggerJob = habitSchedulerTriggerJobMock
  },
}))

vi.mock("../../../heart/awaiting/await-scheduler", () => ({
  AwaitScheduler: class MockAwaitScheduler {
    constructor(public options: unknown) {
      awaitSchedulerOptionsMock(options)
    }
    start = awaitSchedulerStartMock
    stop = awaitSchedulerStopMock
    watchForChanges = awaitSchedulerWatchMock
    stopWatching = awaitSchedulerStopWatchMock
    startPeriodicReconciliation = awaitSchedulerStartPeriodicReconciliationMock
    getDegradedAwaits = awaitSchedulerGetDegradedAwaitsMock
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

const { createMcpStatusCanaryProbeMock } = vi.hoisted(() => ({
  createMcpStatusCanaryProbeMock: vi.fn(),
}))

vi.mock("../../../heart/daemon/mcp-canary", () => ({
  createMcpStatusCanaryProbe: (options: { agent: string; ignoreOverviewHealth?: boolean }) => {
    createMcpStatusCanaryProbeMock(options)
    return {
      name: `mcp-canary:${options.agent}`,
      check: async () => ({ ok: true }),
    }
  },
}))

vi.mock("../../../heart/config", () => ({
  getBlueBubblesChannelConfig: vi.fn(() => ({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  })),
}))

describe("daemon entrypoint", () => {
  let testHomeRoot: string
  let originalHome: string | undefined

  function writeAgentConfig(
    agentName: string,
    options: {
      humanProvider?: string
      humanModel?: string
      agentProvider?: string
      agentModel?: string
    } = {},
  ): void {
    const agentRoot = path.join(testHomeRoot, "AgentBundles", `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: {
        provider: options.humanProvider ?? "minimax",
        model: options.humanModel ?? "MiniMax-M2.5",
      },
      agentFacing: {
        provider: options.agentProvider ?? "minimax",
        model: options.agentModel ?? "MiniMax-M2.5",
      },
      phrases: { thinking: ["thinking"], tool: ["tool"], followup: ["followup"] },
    }, null, 2)}\n`, "utf-8")
  }

  beforeEach(() => {
    originalHome = process.env.HOME
    testHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-entry-test-home-"))
    process.env.HOME = testHomeRoot
    refreshProviderCredentialPoolMock.mockReset()
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-04-13T00:00:00.000Z",
        providers: {
          minimax: {
            provider: "minimax",
            revision: "vault_preload",
            updatedAt: "2026-04-13T00:00:00.000Z",
            credentials: { apiKey: "test-key" },
            config: {},
            provenance: { source: "manual", updatedAt: "2026-04-13T00:00:00.000Z" },
          },
        },
      },
    })
    habitSchedulerListJobsMock.mockReturnValue([])
    habitSchedulerGetDegradedHabitsMock.mockReturnValue([])
    awaitSchedulerGetDegradedAwaitsMock.mockReturnValue([])
    habitSchedulerTriggerJobMock.mockResolvedValue({ ok: false, message: "unhandled habit trigger" })
  })

  afterEach(() => {
    listEnabledBundleAgentsMock.mockReset()
    listEnabledBundleAgentsMock.mockReturnValue([])
    readPrivateRuntimeConfigMock.mockReset()
    readPrivateRuntimeConfigMock.mockReturnValue({ autoStart: false, source: "default" })
    refreshProviderCredentialPoolMock.mockClear()
    habitSchedulerStartMock.mockReset()
    habitSchedulerStopMock.mockReset()
    habitSchedulerOptionsMock.mockReset()
    habitSchedulerWatchMock.mockReset()
    habitSchedulerStopWatchMock.mockReset()
    habitSchedulerStartPeriodicReconciliationMock.mockReset()
    habitSchedulerListJobsMock.mockReset()
    habitSchedulerGetDegradedHabitsMock.mockReset()
    habitSchedulerGetDegradedHabitsMock.mockReturnValue([])
    habitSchedulerTriggerJobMock.mockReset()
    awaitSchedulerOptionsMock.mockReset()
    awaitSchedulerStartMock.mockReset()
    awaitSchedulerStopMock.mockReset()
    awaitSchedulerWatchMock.mockReset()
    awaitSchedulerStopWatchMock.mockReset()
    awaitSchedulerStartPeriodicReconciliationMock.mockReset()
    awaitSchedulerGetDegradedAwaitsMock.mockReset()
    awaitSchedulerGetDegradedAwaitsMock.mockReturnValue([])
    migrateHabitsFromTaskSystemMock.mockReset()
    writeDaemonTombstoneMock.mockReset()
    createMcpStatusCanaryProbeMock.mockReset()
    vi.doUnmock("os")
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    fs.rmSync(testHomeRoot, { recursive: true, force: true })
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
  })

  async function importDaemonEntryWithPrivateRuntimeConfig(privateRuntimeConfig: { autoStart: boolean; source: string }) {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    readPrivateRuntimeConfigMock.mockReturnValue(privateRuntimeConfig)
    writeAgentConfig("slugger")

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const daemonCtor = vi.fn()
    const processManagerCtor = vi.fn()
    const checkAgentConfig = vi.fn(() => ({ ok: true }))
    const checkAgentConfigWithProviderHealth = vi.fn(async () => {
      throw new Error("passive daemon startup must not run live provider health checks")
    })

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        constructor(_opts: unknown) {
          daemonCtor(_opts)
        }
        start = start
        stop = stop
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
        constructor(_opts: unknown) {
          processManagerCtor(_opts)
        }
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../heart/daemon/agent-config-check", () => ({
      checkAgentConfig,
      checkAgentConfigWithProviderHealth,
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const runtimeCredentials = await import("../../../heart/runtime-credentials")
    const providerCredentials = await import("../../../heart/provider-credentials")
    const { loadOrCreateMachineIdentity } = await import("../../../heart/machine-identity")
    const machineId = loadOrCreateMachineIdentity().machineId
    runtimeCredentials.resetRuntimeCredentialConfigCache()
    providerCredentials.resetProviderCredentialCache()
    runtimeCredentials.cacheRuntimeCredentialConfig("slugger", { mailroom: { mailboxAddress: "slugger@ouro.bot" } }, new Date("2026-07-07T00:00:00.000Z"))
    runtimeCredentials.cacheMachineRuntimeCredentialConfig("slugger", { bluebubbles: { port: 18790 } }, new Date("2026-07-07T00:00:00.000Z"), machineId)
    providerCredentials.cacheProviderCredentialRecords("slugger", [
      providerCredentials.createProviderCredentialRecord({
        provider: "minimax",
        credentials: { apiKey: "test-key" },
        config: {},
        provenance: { source: "manual" },
        now: new Date("2026-07-07T00:00:00.000Z"),
      }),
    ], new Date("2026-07-07T00:00:00.000Z"))

    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    expect(daemonCtor).toHaveBeenCalledTimes(1)
    expect(processManagerCtor).toHaveBeenCalledTimes(1)

    return {
      checkAgentConfig,
      checkAgentConfigWithProviderHealth,
      processManagerOptions: processManagerCtor.mock.calls[0]?.[0] as {
        agents: Array<{
          name: string
          entry: string
          channel: string
          autoStart: boolean
          getRuntimeCredentialBootstrap: () => unknown
        }>
        configCheck: (agent: string) => Promise<{ ok: boolean }>
      },
    }
  }

  async function importDaemonEntryWithPulseDispatch(options: {
    socketPath: string
    sendDaemonCommand?: ReturnType<typeof vi.fn>
  }) {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger", "ouroboros"])

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const processManagerCtor = vi.fn()
    const sendDaemonCommand = options.sendDaemonCommand ?? vi.fn(async () => ({ ok: true }))
    const expectedAlertId = buildAlertId("ouroboros", "missing github-copilot creds")

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = start
        stop = stop
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        constructor(_opts: unknown) {
          processManagerCtor(_opts)
        }
        listAgentSnapshots = vi.fn(() => [
          {
            name: "slugger",
            channel: "private-runtime",
            autoStart: false,
            status: "running",
            pid: 123,
            restartCount: 0,
            startedAt: "2026-04-08T22:00:00.000Z",
            lastCrashAt: null,
            backoffMs: 1000,
            lastExitCode: null,
            lastSignal: null,
            errorReason: null,
            fixHint: null,
          },
          {
            name: "ouroboros",
            channel: "private-runtime",
            autoStart: false,
            status: "crashed",
            pid: null,
            restartCount: 1,
            startedAt: null,
            lastCrashAt: "2026-04-08T21:59:00.000Z",
            backoffMs: 1000,
            lastExitCode: 1,
            lastSignal: null,
            errorReason: "missing github-copilot creds",
            fixHint: "run `ouro auth ouroboros`",
          },
        ])
      },
    }))
    vi.doMock("../../../heart/daemon/socket-client", () => ({
      sendDaemonCommand,
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js", "--socket", options.socketPath])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()

    const processManagerOptions = processManagerCtor.mock.calls[0]?.[0] as {
      onSnapshotChange: () => void
    }
    processManagerOptions.onSnapshotChange()

    return { emitNervesEvent, expectedAlertId, sendDaemonCommand }
  }

  async function importDaemonEntryWithHabitDispatch(options: {
    socketPath: string
    sendDaemonCommand?: ReturnType<typeof vi.fn>
  }) {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const processManagerSendToAgent = vi.fn()
    const sendDaemonCommand = options.sendDaemonCommand ?? vi.fn(async () => ({ ok: true }))

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = start
        stop = stop
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [{
          name: "slugger",
          channel: "private-runtime",
          autoStart: false,
          status: "running",
          pid: 123,
          restartCount: 0,
          startedAt: "2026-07-04T00:00:00.000Z",
          lastCrashAt: null,
          backoffMs: 1000,
          lastExitCode: null,
          lastSignal: null,
          errorReason: null,
          fixHint: null,
        }])
        sendToAgent = processManagerSendToAgent
      },
    }))
    vi.doMock("../../../heart/daemon/socket-client", () => ({
      sendDaemonCommand,
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js", "--socket", options.socketPath])

    await import("../../../heart/daemon/daemon-entry")
    await vi.waitFor(() => expect(habitSchedulerOptionsMock).toHaveBeenCalled())

    const schedulerOptions = habitSchedulerOptionsMock.mock.calls[0]?.[0] as {
      onHabitFire: (habitName: string, trigger: string, context?: { occurrenceId: string }) => void
    }
    return { emitNervesEvent, processManagerSendToAgent, schedulerOptions, sendDaemonCommand }
  }

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
        listHealthProbes = vi.fn(() => [
          {
            name: "bluebubbles:slugger",
            check: async () => ({ ok: true }),
          },
        ])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
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
        triggerHabitJob: (jobId: string) => Promise<{ ok: boolean; message: string }>
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
    const healthResults = await daemonOptions.healthMonitor.runChecks()
    expect(healthResults).toEqual([
      { name: "agent-processes", status: "critical", message: "non-running agents: slugger" },
      { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
      { name: "disk-space", status: "ok", message: "disk usage healthy (0%)" },
      { name: "sense-probe:bluebubbles:slugger", status: "ok", message: "bluebubbles:slugger healthy" },
      { name: "sense-probe:mcp-canary:slugger", status: "ok", message: "mcp-canary:slugger healthy" },
      { name: "sense-probe:mcp-canary:ouroboros", status: "ok", message: "mcp-canary:ouroboros healthy" },
      { name: "context-loss-sentinel:slugger", status: "ok", message: "Sentinel ready: deterministic recovery is ready" },
      { name: "context-loss-sentinel:ouroboros", status: "ok", message: "Sentinel ready: deterministic recovery is ready" },
    ])
    expect(createMcpStatusCanaryProbeMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "slugger", ignoreOverviewHealth: true }),
    )
    expect(createMcpStatusCanaryProbeMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "ouroboros", ignoreOverviewHealth: true }),
    )
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
    expect(fs.existsSync(path.join(testHomeRoot, ".ouro-cli", "daemon", "messages"))).toBe(true)
    expect(fs.existsSync(path.join(testHomeRoot, "AgentBundles", "default.ouro"))).toBe(false)

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
    await vi.waitFor(() => expect(habitSchedulerStartMock).toHaveBeenCalled())
    // Migration should be called before scheduler start
    expect(migrateHabitsFromTaskSystemMock).toHaveBeenCalled()
    expect(habitSchedulerOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ execForVerify: expect.any(Function) }),
    )
    const habitSchedulerOptions = habitSchedulerOptionsMock.mock.calls[0][0] as {
      osCronManager: { ownsLabel: (label: string) => boolean }
    }
    expect(habitSchedulerOptions.osCronManager.ownsLabel("bot.ouro.slugger.heartbeat")).toBe(true)
    expect(habitSchedulerOptions.osCronManager.ownsLabel("bot.ouro.slugger.await.vendor-reply")).toBe(false)
    expect(habitSchedulerOptions.osCronManager.ownsLabel("bot.ouro.other.heartbeat")).toBe(false)
    await vi.waitFor(() => expect(awaitSchedulerOptionsMock).toHaveBeenCalled())
    const awaitSchedulerOptions = awaitSchedulerOptionsMock.mock.calls[0][0] as {
      osCronManager: { ownsLabel: (label: string) => boolean }
    }
    expect(awaitSchedulerOptions.osCronManager.ownsLabel("bot.ouro.slugger.await.vendor-reply")).toBe(true)
    expect(awaitSchedulerOptions.osCronManager.ownsLabel("bot.ouro.slugger.heartbeat")).toBe(false)
    habitSchedulerGetDegradedHabitsMock.mockReturnValueOnce([
      { name: "heartbeat", reason: "cron registration failed — using timer fallback" },
    ])
    awaitSchedulerGetDegradedAwaitsMock.mockReturnValueOnce([
      { name: "vendor-reply", reason: "cron registration failed — using timer fallback" },
    ])
    expect(daemonOptions.scheduler.listDegradedJobs()).toEqual([
      { id: "habit:heartbeat", reason: "cron registration failed — using timer fallback" },
      { id: "await:vendor-reply", reason: "cron registration failed — using timer fallback" },
    ])
    habitSchedulerTriggerJobMock.mockResolvedValueOnce({
      ok: true,
      message: "triggered habit slugger:heartbeat:cadence",
    })
    await expect(daemonOptions.scheduler.triggerHabitJob("slugger:heartbeat:cadence")).resolves.toEqual({
      ok: true,
      message: "triggered habit slugger:heartbeat:cadence",
    })
    expect(habitSchedulerTriggerJobMock).toHaveBeenCalledWith("slugger:heartbeat:cadence", "cron")

    const originalSetTimeout = globalThis.setTimeout
    const forcedExitTimers: Array<ReturnType<typeof setTimeout>> = []
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args)
      if (timeout === 5_000) forcedExitTimers.push(timer)
      return timer
    }) as typeof setTimeout)
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    onHandlers.SIGINT?.()
    await Promise.resolve()
    expect(stop).toHaveBeenCalled()
    // HabitScheduler should be stopped on SIGINT
    expect(habitSchedulerStopMock).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(forcedExitTimers).toHaveLength(1)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(forcedExitTimers[0])
    // Tombstone is now written on SIGINT (regression: previous behavior was
    // to set _gracefulShutdown=true and skip the tombstone, leaving signal-driven
    // shutdowns invisible in the death log)
    expect(writeDaemonTombstoneMock).toHaveBeenCalledWith("sigint", expect.any(Error))

    writeDaemonTombstoneMock.mockClear()
    clearTimeoutSpy.mockClear()
    forcedExitTimers.splice(0)
    onHandlers.SIGTERM?.()
    await Promise.resolve()
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(forcedExitTimers).toHaveLength(1)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(forcedExitTimers[0])
    // Same fix for SIGTERM — was the more common silent-death cause because
    // killOrphanProcesses, launchd policies, and the OOM killer all use SIGTERM
    expect(writeDaemonTombstoneMock).toHaveBeenCalledWith("sigterm", expect.any(Error))

    argvSpy.mockRestore()
  }, 10_000)

  it("wires private-runtime workers as passive by default and uses offline config validation", async () => {
    const { checkAgentConfig, checkAgentConfigWithProviderHealth, processManagerOptions } =
      await importDaemonEntryWithPrivateRuntimeConfig({ autoStart: false, source: "default" })

    expect(processManagerOptions.agents).toEqual([expect.objectContaining({
      name: "slugger",
      entry: "heart/agent-entry.js",
      channel: "private-runtime",
      autoStart: false,
      getRuntimeCredentialBootstrap: expect.any(Function),
    })])

    await expect(processManagerOptions.configCheck("slugger")).resolves.toEqual({ ok: true })
    expect(checkAgentConfig).toHaveBeenCalledWith("slugger", expect.any(String))
    expect(checkAgentConfigWithProviderHealth).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(refreshProviderCredentialPoolMock).toHaveBeenCalledWith("slugger", {
        preserveCachedOnFailure: true,
        providers: ["minimax"],
      })
    })
    expect(processManagerOptions.agents[0]?.getRuntimeCredentialBootstrap()).toMatchObject({
      agentName: "slugger",
      runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
      machineRuntimeConfig: { bluebubbles: { port: 18790 } },
      machineId: expect.any(String),
      providerCredentialRecords: [expect.objectContaining({
        provider: "minimax",
        revision: expect.any(String),
      })],
    })
    const runtimeCredentials = await import("../../../heart/runtime-credentials")
    const providerCredentials = await import("../../../heart/provider-credentials")
    runtimeCredentials.resetRuntimeCredentialConfigCache()
    providerCredentials.resetProviderCredentialCache()
    expect(processManagerOptions.agents[0]?.getRuntimeCredentialBootstrap()).toBeNull()
  })

  it("opens the daemon before provider credential warm-up resolves", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    writeAgentConfig("slugger")
    let resolveProviderRefresh!: (value: {
      ok: true
      poolPath: string
      pool: { schemaVersion: 1; updatedAt: string; providers: {} }
    }) => void
    refreshProviderCredentialPoolMock.mockImplementation(() => new Promise((resolve) => {
      resolveProviderRefresh = resolve
    }))

    const start = vi.fn(async () => undefined)
    const refreshContextLossSentinel = vi.fn(async () => ({
      verdict: "ready",
      summary: "deterministic recovery is ready",
    }))

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = start
        stop = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel,
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))

    await import("../../../heart/daemon/daemon-entry")

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(refreshProviderCredentialPoolMock).toHaveBeenCalledWith("slugger", {
        preserveCachedOnFailure: true,
        providers: ["minimax"],
      })
    })
    expect(refreshContextLossSentinel).not.toHaveBeenCalled()

    resolveProviderRefresh({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: { schemaVersion: 1, updatedAt: "2026-04-13T00:00:00.000Z", providers: {} },
    })
    await vi.waitFor(() => {
      expect(refreshContextLossSentinel).toHaveBeenCalledWith("slugger", expect.any(String), expect.objectContaining({ trigger: "daemon_startup" }))
    })
  })

  it("skips provider credential warm-up when agent config is unreadable", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    const emitNervesEvent = vi.fn()

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = vi.fn(async () => undefined)
        stop = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))

    await import("../../../heart/daemon/daemon-entry")

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.provider_preload_skipped",
      }))
    })
    expect(refreshProviderCredentialPoolMock).not.toHaveBeenCalled()
  })

  it("logs provider credential warm-up failures after daemon startup", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    writeAgentConfig("slugger")
    refreshProviderCredentialPoolMock.mockRejectedValue(new Error("vault timeout"))
    const emitNervesEvent = vi.fn()

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = vi.fn(async () => undefined)
        stop = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))

    await import("../../../heart/daemon/daemon-entry")

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "daemon.provider_preload_error",
        meta: { error: "vault timeout" },
      }))
    })
  })

  it("logs unavailable provider credential warm-up results after daemon startup", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    writeAgentConfig("slugger")
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:slugger:providers/*",
      error: "vault timeout",
    })
    const emitNervesEvent = vi.fn()

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = vi.fn(async () => undefined)
        stop = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))

    await import("../../../heart/daemon/daemon-entry")

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        event: "daemon.provider_preload_unavailable",
        meta: {
          agent: "slugger",
          reason: "unavailable",
          error: "vault timeout",
        },
      }))
    })
  })

  it("does not replace the provider cache when warm-up returns incomplete selected providers", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    writeAgentConfig("slugger", { humanProvider: "minimax", agentProvider: "openai-codex" })
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-04-13T00:00:00.000Z",
        providers: {
          minimax: {
            provider: "minimax",
            revision: "vault_partial",
            updatedAt: "2026-04-13T00:00:00.000Z",
            credentials: { apiKey: "partial-key" },
            config: {},
            provenance: { source: "manual", updatedAt: "2026-04-13T00:00:00.000Z" },
          },
        },
      },
    })
    const emitNervesEvent = vi.fn()

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = vi.fn(async () => undefined)
        stop = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => ({
        verdict: "ready",
        summary: "deterministic recovery is ready",
      })),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))

    const providerCredentials = await import("../../../heart/provider-credentials")
    providerCredentials.resetProviderCredentialCache()
    const minimax = providerCredentials.createProviderCredentialRecord({
      provider: "minimax",
      credentials: { apiKey: "cached-minimax-key" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-13T12:00:00.000Z"),
    })
    const openaiCodex = providerCredentials.createProviderCredentialRecord({
      provider: "openai-codex",
      credentials: { oauthAccessToken: "cached-openai-token" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-13T12:01:00.000Z"),
    })
    const cached = providerCredentials.cacheProviderCredentialRecords("slugger", [minimax, openaiCodex])

    await import("../../../heart/daemon/daemon-entry")

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        event: "daemon.provider_preload_unavailable",
        meta: {
          agent: "slugger",
          reason: "missing",
          error: "missing selected providers: openai-codex",
        },
      }))
    })
    expect(providerCredentials.readProviderCredentialPool("slugger")).toBe(cached)
  })

  it("logs startup Sentinel failures after provider credential warm-up settles", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    writeAgentConfig("slugger")
    const emitNervesEvent = vi.fn()

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    vi.spyOn(process, "on").mockImplementation(((_event: string, _cb: () => void) => process) as any)
    vi.spyOn(process.stdout, "on").mockImplementation(((_event: string, _cb: () => void) => process.stdout) as any)
    vi.spyOn(process.stderr, "on").mockImplementation(((_event: string, _cb: () => void) => process.stderr) as any)

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: class MockOuroDaemon {
        start = vi.fn(async () => undefined)
        stop = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel: vi.fn(async () => {
        throw "sentinel offline"
      }),
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))

    await import("../../../heart/daemon/daemon-entry")

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "daemon.startup_sentinel_error",
        meta: {
          agent: "slugger",
          error: "Sentinel refresh failed: sentinel offline",
        },
      }))
    })
  })

  it("routes pulse alerts through canonical private wake commands", async () => {
    const { expectedAlertId, sendDaemonCommand } = await importDaemonEntryWithPulseDispatch({
      socketPath: "/tmp/ouro-pulse-private-wake.sock",
    })

    expect(sendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/ouro-pulse-private-wake.sock",
      {
        kind: "private.wake",
        agent: "slugger",
        reason: "pulse alert for ouroboros: missing github-copilot creds",
        triggerSource: "pulse-alert",
        budgetClass: "scheduled",
        idempotencyKey: `pulse:slugger:${expectedAlertId}`,
        originRefs: [
          { kind: "pulse-alert", id: expectedAlertId },
          { kind: "agent", id: "ouroboros" },
        ],
      },
    )
    expect(sendDaemonCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "inner.wake" }),
    )
  })

  it("records failed pulse private wake dispatches", async () => {
    const { emitNervesEvent, expectedAlertId, sendDaemonCommand } = await importDaemonEntryWithPulseDispatch({
      socketPath: "/tmp/ouro-pulse-failed-wake.sock",
      sendDaemonCommand: vi.fn(async () => {
        throw new Error("pulse socket write failed")
      }),
    })

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.pulse_private_wake_dispatch_error",
        meta: {
          agent: "slugger",
          triggerSource: "pulse-alert",
          idempotencyKey: `pulse:slugger:${expectedAlertId}`,
          originRefs: [
            { kind: "pulse-alert", id: expectedAlertId },
            { kind: "agent", id: "ouroboros" },
          ],
          socketPath: "/tmp/ouro-pulse-failed-wake.sock",
          error: "pulse socket write failed",
        },
      }))
    })
    expect(sendDaemonCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "inner.wake" }),
    )
  })

  it("records raw failed pulse private wake dispatch values", async () => {
    const { emitNervesEvent, expectedAlertId } = await importDaemonEntryWithPulseDispatch({
      socketPath: "/tmp/ouro-pulse-raw-failed-wake.sock",
      sendDaemonCommand: vi.fn(async () => {
        throw "raw pulse socket failure"
      }),
    })

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.pulse_private_wake_dispatch_error",
        meta: {
          agent: "slugger",
          triggerSource: "pulse-alert",
          idempotencyKey: `pulse:slugger:${expectedAlertId}`,
          originRefs: [
            { kind: "pulse-alert", id: expectedAlertId },
            { kind: "agent", id: "ouroboros" },
          ],
          socketPath: "/tmp/ouro-pulse-raw-failed-wake.sock",
          error: "raw pulse socket failure",
        },
      }))
    })
  })

  it("routes habit scheduler fires through canonical private wake commands", async () => {
    const { processManagerSendToAgent, schedulerOptions, sendDaemonCommand } = await importDaemonEntryWithHabitDispatch({
      socketPath: "/tmp/ouro-habit-private-wake.sock",
    })

    schedulerOptions.onHabitFire("heartbeat", "overdue", {
      occurrenceId: "overdue:first-run:30m",
    })

    expect(sendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/ouro-habit-private-wake.sock",
      expect.objectContaining({
        kind: "private.wake",
        agent: "slugger",
        reason: "habit heartbeat fired by overdue",
        triggerSource: "habit-overdue",
        budgetClass: "scheduled",
        originRefs: [
          { kind: "habit", id: "heartbeat" },
          { kind: "habit-trigger", id: "overdue" },
          { kind: "habit-occurrence", id: "overdue:first-run:30m" },
          { kind: "daemon-entry", id: "habit-scheduler" },
        ],
      }),
    )
    expect(sendDaemonCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        idempotencyKey: "habit:slugger:heartbeat:overdue:overdue:first-run:30m",
      }),
    )
    expect(sendDaemonCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "inner.wake" }),
    )
    expect(processManagerSendToAgent).not.toHaveBeenCalled()
  })

  it("records failed habit private wake dispatches", async () => {
    const { emitNervesEvent, processManagerSendToAgent, schedulerOptions, sendDaemonCommand } =
      await importDaemonEntryWithHabitDispatch({
        socketPath: "/tmp/ouro-habit-failed-wake.sock",
        sendDaemonCommand: vi.fn(async () => {
          throw new Error("habit socket write failed")
        }),
      })

    schedulerOptions.onHabitFire("heartbeat", "overdue", {
      occurrenceId: "overdue:first-run:30m",
    })

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_private_wake_dispatch_error",
        meta: expect.objectContaining({
          agent: "slugger",
          habitName: "heartbeat",
          trigger: "overdue",
          triggerSource: "habit-overdue",
          socketPath: "/tmp/ouro-habit-failed-wake.sock",
          error: "habit socket write failed",
        }),
      }))
    })
    expect(sendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/ouro-habit-failed-wake.sock",
      expect.objectContaining({ kind: "private.wake" }),
    )
    expect(processManagerSendToAgent).not.toHaveBeenCalled()
  })

  it("records raw failed habit private wake dispatch values", async () => {
    const { emitNervesEvent, schedulerOptions } =
      await importDaemonEntryWithHabitDispatch({
        socketPath: "/tmp/ouro-habit-raw-failed-wake.sock",
        sendDaemonCommand: vi.fn(async () => {
          throw "raw habit socket failure"
        }),
      })

    schedulerOptions.onHabitFire("heartbeat", "overdue", {
      occurrenceId: "overdue:first-run:30m",
    })

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        component: "daemon",
        event: "daemon.habit_private_wake_dispatch_error",
        meta: expect.objectContaining({
          agent: "slugger",
          habitName: "heartbeat",
          trigger: "overdue",
          triggerSource: "habit-overdue",
          socketPath: "/tmp/ouro-habit-raw-failed-wake.sock",
          error: "raw habit socket failure",
        }),
      }))
    })
  })

  it("routes RSVP scheduler fires through typed habit pokes instead of private-runtime wakes", async () => {
    const { processManagerSendToAgent, schedulerOptions, sendDaemonCommand } = await importDaemonEntryWithHabitDispatch({
      socketPath: "/tmp/ouro-rsvp-habit-poke.sock",
    })

    schedulerOptions.onHabitFire("rsvp-ari-rachel", "overdue", {
      occurrenceId: "overdue:first-run:0 10 * * *",
    })

    expect(sendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/ouro-rsvp-habit-poke.sock",
      {
        kind: "habit.poke",
        agent: "slugger",
        habitName: "rsvp-ari-rachel",
        trigger: "overdue",
        occurrenceId: "overdue:first-run:0 10 * * *",
      },
    )
    expect(sendDaemonCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: "private.wake",
        originRefs: expect.arrayContaining([{ kind: "habit", id: "rsvp-ari-rachel" }]),
      }),
    )
    expect(processManagerSendToAgent).not.toHaveBeenCalled()
  })

  it("lets privateRuntime explicitly allow autonomous private-runtime startup", async () => {
    const { processManagerOptions } =
      await importDaemonEntryWithPrivateRuntimeConfig({ autoStart: true, source: "privateRuntime" })

    expect(processManagerOptions.agents).toEqual([expect.objectContaining({
      name: "slugger",
      entry: "heart/agent-entry.js",
      channel: "private-runtime",
      autoStart: true,
      getRuntimeCredentialBootstrap: expect.any(Function),
    })])
  })

  it("wires daemon.stop command cleanup to stop entrypoint timers before exiting", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const daemonCtor = vi.fn()
    const healthMonitorStopPeriodicChecks = vi.fn()
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

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
        sendToAgent = vi.fn()
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => testHomeRoot }
    })
    vi.doMock("../../../heart/daemon/health-monitor", () => ({
      HealthMonitor: class MockHealthMonitor {
        runChecks = vi.fn(async () => [])
        startPeriodicChecks = vi.fn()
        stopPeriodicChecks = healthMonitorStopPeriodicChecks
      },
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    try {
      await import("../../../heart/daemon/daemon-entry")
      await Promise.resolve()
      await Promise.resolve()

      const daemonOptions = daemonCtor.mock.calls[0]?.[0] as {
        onStopCommandComplete: () => void
      }
      expect(typeof daemonOptions.onStopCommandComplete).toBe("function")

      daemonOptions.onStopCommandComplete()
      daemonOptions.onStopCommandComplete()

      expect(habitSchedulerStopWatchMock).toHaveBeenCalledTimes(1)
      expect(habitSchedulerStopMock).toHaveBeenCalledTimes(1)
      expect(healthMonitorStopPeriodicChecks).toHaveBeenCalledTimes(1)
      const healthPath = path.join(testHomeRoot, ".ouro-cli", "daemon-health.json")
      const healthState = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as { status: string }
      expect(healthState.status).toBe("down")
      expect(writeDaemonTombstoneMock).not.toHaveBeenCalled()
      expect(exitSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)

      expect(exitSpy).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      argvSpy.mockRestore()
      vi.useRealTimers()
    }
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
    const daemonCtor = vi.fn()
    const processManagerCtor = vi.fn()
    const schedulerCtor = vi.fn()
    const schedulerStart = vi.fn()
    const schedulerStop = vi.fn()
    const schedulerReconcile = vi.fn(async () => undefined)
    const schedulerRecordTaskRun = vi.fn(async () => undefined)
    const senseManagerCtor = vi.fn()

    vi.spyOn(process, "on").mockImplementation(((
      _event: string,
      _cb: () => void,
    ) => process) as any)

    class MockOuroDaemon {
      constructor(options: unknown) {
        daemonCtor(options)
      }
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
      listJobs = vi.fn(() => [{ id: "slugger:nightly", schedule: "0 8 * * *", lastRun: null }])
      triggerJob = vi.fn(async (jobId: string) => ({ ok: true, message: `triggered scheduled job: ${jobId}` }))
      start = schedulerStart
      stop = schedulerStop
      reconcile = schedulerReconcile
      recordTaskRun = schedulerRecordTaskRun
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

    const daemonOptions = daemonCtor.mock.calls[0]?.[0] as {
      scheduler: {
        listJobs: () => unknown[]
        triggerJob: (jobId: string) => Promise<{ ok: boolean; message: string }>
        triggerHabitJob: (jobId: string) => Promise<{ ok: boolean; message: string }>
        start: () => void
        stop: () => void
        reconcile: () => Promise<void>
        recordTaskRun: (agent: string, taskId: string) => Promise<void>
      }
    }
    expect(daemonOptions.scheduler.listJobs()).toEqual([
      { id: "slugger:nightly", schedule: "0 8 * * *", lastRun: null },
    ])
    await expect(daemonOptions.scheduler.triggerJob("slugger:nightly")).resolves.toEqual({
      ok: true,
      message: "triggered scheduled job: slugger:nightly",
    })
    await expect(daemonOptions.scheduler.triggerHabitJob("slugger:missing:cadence")).resolves.toEqual({
      ok: false,
      message: "unknown habit job: slugger:missing:cadence",
    })
    daemonOptions.scheduler.start()
    daemonOptions.scheduler.stop()
    await daemonOptions.scheduler.reconcile()
    await daemonOptions.scheduler.recordTaskRun("slugger", "nightly")
    expect(schedulerStart).toHaveBeenCalledTimes(1)
    expect(schedulerStop).toHaveBeenCalledTimes(1)
    expect(schedulerReconcile).toHaveBeenCalledTimes(1)
    expect(schedulerRecordTaskRun).toHaveBeenCalledWith("slugger", "nightly")

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

  it("refreshes Sentinel on daemon startup and wires daemon-health Sentinel checks", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger", "ouroboros"])

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const healthMonitorCtor = vi.fn()
    const refreshContextLossSentinel = vi.fn(async () => ({
      verdict: "ready",
      summary: "Sentinel ready",
    }))
    vi.spyOn(process, "on").mockImplementation(((
      _event: string,
      _cb: () => void,
    ) => process) as any)

    class MockOuroDaemon {
      start = start
      stop = stop
    }

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        listAgentSnapshots = vi.fn(() => [])
        sendToAgent = vi.fn()
      },
    }))
    vi.doMock("../../../heart/daemon/sense-manager", () => ({
      DaemonSenseManager: class MockSenseManager {
        listSenseRows = vi.fn(() => [])
        listHealthProbes = vi.fn(() => [])
        startAutoStartSenses = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
      },
    }))
    vi.doMock("../../../heart/daemon/health-monitor", () => ({
      HealthMonitor: class MockHealthMonitor {
        constructor(options: unknown) {
          healthMonitorCtor(options)
        }
        runChecks = vi.fn(async () => [])
        startPeriodicChecks = vi.fn()
        stopPeriodicChecks = vi.fn()
      },
    }))
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => testHomeRoot }
    })
    vi.doMock("../../../heart/context-loss-sentinel", () => ({
      refreshContextLossSentinel,
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "daemon-entry.js"])

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await Promise.resolve()

    const bundlesRoot = path.join(testHomeRoot, "AgentBundles")
    expect(refreshContextLossSentinel).toHaveBeenCalledWith(
      "slugger",
      path.join(bundlesRoot, "slugger.ouro"),
      expect.objectContaining({ trigger: "daemon_startup" }),
    )
    expect(refreshContextLossSentinel).toHaveBeenCalledWith(
      "ouroboros",
      path.join(bundlesRoot, "ouroboros.ouro"),
      expect.objectContaining({ trigger: "daemon_startup" }),
    )

    const healthOptions = healthMonitorCtor.mock.calls[0]?.[0] as {
      sentinelChecker?: (resultsSoFar?: unknown[]) => Promise<Array<{ name: string; status: string; message: string }>>
    }
    expect(typeof healthOptions.sentinelChecker).toBe("function")

    refreshContextLossSentinel.mockClear()
    await healthOptions.sentinelChecker?.()
    expect(refreshContextLossSentinel).toHaveBeenCalledWith(
      "slugger",
      path.join(bundlesRoot, "slugger.ouro"),
      expect.objectContaining({ trigger: "daemon_health" }),
    )
    expect(refreshContextLossSentinel).toHaveBeenCalledWith(
      "ouroboros",
      path.join(bundlesRoot, "ouroboros.ouro"),
      expect.objectContaining({ trigger: "daemon_health" }),
    )

    refreshContextLossSentinel.mockClear()
    refreshContextLossSentinel.mockImplementation(async (agent: string) => ({
      verdict: agent === "slugger" ? "watch" : "blocked",
      summary: agent === "slugger" ? "provider readiness is stale" : "recovery checkpoint is blocked",
    }))
    const daemonHealthResults = [{ name: "disk-space", status: "ok", message: "disk ok" }]
    await expect(healthOptions.sentinelChecker?.(daemonHealthResults)).resolves.toEqual([
      {
        name: "context-loss-sentinel:slugger",
        status: "warn",
        message: "Sentinel watch: provider readiness is stale",
      },
      {
        name: "context-loss-sentinel:ouroboros",
        status: "critical",
        message: "Sentinel blocked: recovery checkpoint is blocked",
      },
    ])
    expect(refreshContextLossSentinel).toHaveBeenCalledWith(
      "slugger",
      path.join(bundlesRoot, "slugger.ouro"),
      { trigger: "daemon_health", daemonHealthResults },
    )

    refreshContextLossSentinel.mockClear()
    refreshContextLossSentinel.mockImplementation(async (agent: string) => {
      throw agent === "slugger" ? new Error("sentinel exploded") : "offline"
    })
    await expect(healthOptions.sentinelChecker?.()).resolves.toEqual([
      {
        name: "context-loss-sentinel:slugger",
        status: "critical",
        message: "Sentinel refresh failed: sentinel exploded",
      },
      {
        name: "context-loss-sentinel:ouroboros",
        status: "critical",
        message: "Sentinel refresh failed: offline",
      },
    ])

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
    const originalSetTimeout = globalThis.setTimeout
    const forcedExitTimers: Array<ReturnType<typeof setTimeout>> = []
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args)
      if (timeout === 5_000) forcedExitTimers.push(timer)
      return timer
    }) as typeof setTimeout)
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
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
    expect(forcedExitTimers).toHaveLength(1)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(forcedExitTimers[0])
    expect(exitSpy).toHaveBeenCalledWith(1)

    argvSpy.mockRestore()
  })

  it("degrades recoverable habit bootstrap failures instead of taking the fatal startupFailure path", async () => {
    vi.resetModules()
    listEnabledBundleAgentsMock.mockReturnValue(["slugger"])
    habitSchedulerStartMock.mockImplementationOnce(() => {
      throw new Error("launchctl unavailable")
    })

    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const healthMonitorStartPeriodicChecks = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
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
      sendToAgent = vi.fn()
    }

    vi.doMock("../../../heart/daemon/daemon", () => ({
      OuroDaemon: MockOuroDaemon,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: MockProcessManager,
    }))
    vi.doMock("../../../heart/daemon/health-monitor", () => ({
      HealthMonitor: class MockHealthMonitor {
        runChecks = vi.fn(async () => [])
        startPeriodicChecks = healthMonitorStartPeriodicChecks
        stopPeriodicChecks = vi.fn()
      },
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    await import("../../../heart/daemon/daemon-entry")
    await Promise.resolve()
    await Promise.resolve()

    expect(start).toHaveBeenCalledTimes(1)
    expect(habitSchedulerStartMock).toHaveBeenCalledTimes(1)
    expect(habitSchedulerStartPeriodicReconciliationMock).not.toHaveBeenCalled()
    expect(habitSchedulerWatchMock).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "daemon.bootstrap_degraded",
      meta: expect.objectContaining({
        component: "habits:slugger",
        error: "launchctl unavailable",
        guidance: expect.stringContaining("slugger"),
      }),
    }))
    expect(emitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.entry_error",
    }))
    expect(healthMonitorStartPeriodicChecks).toHaveBeenCalledWith(60_000)
    expect(writeDaemonTombstoneMock).not.toHaveBeenCalledWith(
      "startupFailure",
      expect.anything(),
    )
    expect(stop).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalledWith(1)
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
