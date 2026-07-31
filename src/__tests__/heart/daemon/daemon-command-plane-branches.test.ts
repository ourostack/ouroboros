import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import { OuroDaemon, handleAgentSenseTurn, messageFromHabitPokeError } from "../../../heart/daemon/daemon"
import { buildHabitPrivateWakeCommand } from "../../../heart/daemon/habit-private-wake"
import { readPrivateTurnLedger } from "../../../heart/private-runtime"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function sendRaw(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let raw = ""
    client.on("connect", () => {
      client.write(payload)
      client.end()
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("error", reject)
    client.on("end", () => resolve(raw))
  })
}

describe("daemon command plane branches", () => {
  const make = (
    socketPath: string,
    bundlesRoot?: string,
    options?: {
      onStopCommandComplete?: () => void
      privateRuntimePolicyDeps?: unknown
      externalEventRoot?: string
      rsvpHabitRunner?: unknown
    },
  ) => {
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      resetAgentFailureState: vi.fn(),
      sendToAgent: vi.fn(),
    }

    const scheduler = {
      listJobs: vi.fn(() => []),
      listDegradedJobs: vi.fn(() => []),
      triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
      reconcile: vi.fn(async () => undefined),
      recordTaskRun: vi.fn(async (_agent: string, _taskId: string) => undefined),
    }

    const healthMonitor = {
      runChecks: vi.fn(async () => [{ name: "agent-processes", status: "ok" as const, message: "good" }]),
      getLastResults: vi.fn(() => []),
      stopPeriodicChecks: vi.fn(),
    }

    const router = {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
      pollInbox: vi.fn(() => [{ id: "m", from: "slugger", content: "hello", queuedAt: "x", priority: "normal" }]),
    }

    const senseManager = {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
      reviveSense: vi.fn(),
    }

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      bundlesRoot,
      senseManager,
      privateRuntimePolicyDeps: options?.privateRuntimePolicyDeps,
      rsvpHabitRunner: options?.rsvpHabitRunner,
      externalEventRoot: options?.externalEventRoot,
      mailboxServerFactory: vi.fn(async () => ({
        url: "http://127.0.0.1:6876",
        stop: async () => undefined,
      })),
      onStopCommandComplete: options?.onStopCommandComplete,
    } as any)
    return { daemon, processManager, scheduler, healthMonitor, router, senseManager }
  }

  function registeredSnapshot(name = "slugger") {
    return {
      name,
      channel: "private-runtime",
      status: "running",
      pid: 1234,
      restartCount: 0,
      startedAt: "2026-07-03T00:00:00.000Z",
      lastCrashAt: null,
      backoffMs: 0,
    }
  }

  function privateRuntimePolicyDeps(ledgerPath: string, result: "allow" | "deny") {
    return {
      ledgerPath,
      now: () => "2026-07-03T00:00:00.000Z",
      resolveProviderLane: vi.fn(() => ({
        lane: "inner",
        provider: "minimax",
        model: "minimax-text-01",
        source: "agent.json",
        credentialRevision: "test-rev",
      })),
      evaluatePolicy: vi.fn(() => result === "allow"
        ? { result: "allow", reason: "test policy allow" }
        : { result: "deny", reason: "private runtime policy denies by default", deniedReason: "default policy deny" }),
    }
  }

  function writeHabitFile(options: {
    bundlesRoot: string
    agent: string
    habitName: string
    cadence: string | null
    lastRun: string | null
  }): void {
    const habitsDir = path.join(options.bundlesRoot, `${options.agent}.ouro`, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, `${options.habitName}.md`),
      [
        "---",
        `title: ${options.habitName}`,
        `cadence: ${options.cadence ?? "null"}`,
        "status: active",
        `lastRun: ${options.lastRun ?? "null"}`,
        "---",
        "",
        "Run the habit.",
      ].join("\n"),
      "utf-8",
    )
  }

  function writeRawHabitFile(options: {
    bundlesRoot: string
    agent: string
    habitName: string
    content: string
  }): void {
    const habitsDir = path.join(options.bundlesRoot, `${options.agent}.ouro`, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(path.join(habitsDir, `${options.habitName}.md`), options.content, "utf-8")
  }

  function lifecycleEvidenceEvents(): Array<Record<string, any>> {
    return mockEmitNervesEvent.mock.calls
      .map(([event]) => event as Record<string, any>)
      .filter((event) => event.event === "daemon.habit_dispatch_ready" || event.event === "daemon.habit_dispatch_skipped")
  }

  function lifecycleEvidenceInvocationOrder(eventName: "daemon.habit_dispatch_ready" | "daemon.habit_dispatch_skipped"): number {
    const callIndex = mockEmitNervesEvent.mock.calls.findIndex(([event]) => event.event === eventName)
    expect(callIndex).toBeGreaterThanOrEqual(0)
    return mockEmitNervesEvent.mock.invocationCallOrder[callIndex]!
  }

  afterEach(() => {
    vi.restoreAllMocks()
    mockEmitNervesEvent.mockReset()
  })

  it("formats non-Error habit poke failures defensively", () => {
    expect(messageFromHabitPokeError("string failure")).toBe("string failure")
    expect(messageFromHabitPokeError(new Error("typed failure"))).toBe("typed failure")
  })

  it("handles daemon start/stop and socket lifecycle", async () => {
    const socketPath = tmpSocketPath("daemon-start-stop")
    fs.writeFileSync(socketPath, "stale", "utf-8")

    const onStopCommandComplete = vi.fn()
    const { daemon, processManager, senseManager, healthMonitor } = make(socketPath, undefined, { onStopCommandComplete })

    const started = await daemon.handleCommand({ kind: "daemon.start" })
    expect(started).toEqual({ ok: true, message: "daemon started" })
    expect(processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    expect(senseManager.startAutoStartSenses).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(socketPath)).toBe(true)

    const stopped = await daemon.handleCommand({ kind: "daemon.stop" })
    expect(stopped).toEqual({ ok: true, message: "daemon stopped" })
    expect(processManager.stopAll).toHaveBeenCalled()
    expect(senseManager.stopAll).toHaveBeenCalled()
    expect(healthMonitor.stopPeriodicChecks).toHaveBeenCalledTimes(1)
    expect(onStopCommandComplete).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(socketPath)).toBe(false)
  })

  it("daemon.restart runs the stop pathway with a restart-requested audit log; launchctl respawn implied", async () => {
    const socketPath = tmpSocketPath("daemon-restart")
    const onStopCommandComplete = vi.fn()
    const { daemon, processManager, senseManager } = make(socketPath, undefined, { onStopCommandComplete })

    await daemon.handleCommand({ kind: "daemon.start" })
    const restarted = await daemon.handleCommand({
      kind: "daemon.restart",
      reason: "bluebubbles recovery queue wedged",
      requestedBy: "slugger",
    })

    expect(restarted).toEqual({
      ok: true,
      message: "daemon restarting — launchctl will respawn",
    })
    // Stop pathway exercised — same shutdown semantics as daemon.stop.
    expect(processManager.stopAll).toHaveBeenCalled()
    expect(senseManager.stopAll).toHaveBeenCalled()
    expect(onStopCommandComplete).toHaveBeenCalledTimes(1)
  })

  it("daemon.restart tolerates missing reason + requestedBy (both optional in audit log)", async () => {
    const socketPath = tmpSocketPath("daemon-restart-no-reason")
    const { daemon } = make(socketPath, undefined, { onStopCommandComplete: vi.fn() })
    await daemon.handleCommand({ kind: "daemon.start" })

    const restarted = await daemon.handleCommand({ kind: "daemon.restart" })
    expect(restarted.ok).toBe(true)
    expect(restarted.message).toContain("daemon restarting")
  })

  it("opens the command socket even when autostart workers are still blocked", async () => {
    const socketPath = tmpSocketPath("daemon-start-before-autostart")
    const { daemon, processManager, senseManager } = make(socketPath)
    processManager.startAutoStartAgents.mockImplementation(() => new Promise<void>(() => {}))
    senseManager.startAutoStartSenses.mockImplementation(() => new Promise<void>(() => {}))

    await daemon.start()

    expect(processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    expect(senseManager.startAutoStartSenses).toHaveBeenCalledTimes(1)
    const raw = await sendRaw(socketPath, JSON.stringify({ kind: "daemon.status" }))
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({ ok: true }))

    await daemon.stop()
  })

  it("uses nonblocking autostart trigger hooks when managers provide them", async () => {
    const socketPath = tmpSocketPath("daemon-start-trigger-hooks")
    const { daemon, processManager, senseManager } = make(socketPath)
    ;(processManager as any).triggerAutoStartAgents = vi.fn()
    ;(senseManager as any).triggerAutoStartSenses = vi.fn()

    await daemon.start()

    expect((processManager as any).triggerAutoStartAgents).toHaveBeenCalledTimes(1)
    expect((senseManager as any).triggerAutoStartSenses).toHaveBeenCalledTimes(1)
    expect(processManager.startAutoStartAgents).not.toHaveBeenCalled()
    expect(senseManager.startAutoStartSenses).not.toHaveBeenCalled()

    await daemon.stop()
  })

  it("waits to autostart senses until agent startup has settled", async () => {
    vi.useFakeTimers()
    const socketPath = tmpSocketPath("daemon-start-senses-after-agents")
    const { daemon, processManager, senseManager } = make(socketPath)
    let agentStatus = "starting"
    processManager.listAgentSnapshots.mockImplementation(() => [{
      name: "slugger",
      channel: "private-runtime",
      status: agentStatus,
      pid: null,
      restartCount: 0,
      startedAt: null,
      lastCrashAt: null,
      backoffMs: 1000,
      errorReason: null,
      fixHint: null,
    }])

    try {
      await daemon.start()

      expect(processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
      expect(senseManager.startAutoStartSenses).not.toHaveBeenCalled()

      agentStatus = "running"
      await vi.advanceTimersByTimeAsync(250)

      expect(senseManager.startAutoStartSenses).toHaveBeenCalledTimes(1)
    } finally {
      await daemon.stop()
      vi.useRealTimers()
    }
  })

  it("cancels deferred sense autostart when the daemon stops first", async () => {
    vi.useFakeTimers()
    const socketPath = tmpSocketPath("daemon-start-senses-cancelled")
    const { daemon, processManager, senseManager } = make(socketPath)
    processManager.listAgentSnapshots.mockImplementation(() => [{
      name: "slugger",
      channel: "private-runtime",
      status: "starting",
      pid: null,
      restartCount: 0,
      startedAt: null,
      lastCrashAt: null,
      backoffMs: 1000,
      errorReason: null,
      fixHint: null,
    }])

    try {
      await daemon.start()
      await daemon.stop()
      await vi.advanceTimersByTimeAsync(250)

      expect(senseManager.startAutoStartSenses).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("contains fallback autostart errors after opening the command socket", async () => {
    const firstSocketPath = tmpSocketPath("daemon-start-autostart-error-a")
    const first = make(firstSocketPath)
    first.processManager.startAutoStartAgents.mockRejectedValueOnce(new Error("agent start boom"))
    first.senseManager.startAutoStartSenses.mockRejectedValueOnce("sense start raw")

    try {
      await first.daemon.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(first.processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    } finally {
      await first.daemon.stop()
    }

    const secondSocketPath = tmpSocketPath("daemon-start-autostart-error-b")
    const second = make(secondSocketPath)
    second.processManager.startAutoStartAgents.mockRejectedValueOnce("agent start raw")
    second.senseManager.startAutoStartSenses.mockRejectedValueOnce(new Error("sense start boom"))

    try {
      await second.daemon.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(second.processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    } finally {
      await second.daemon.stop()
    }
  })

  it("starts cleanly when no sense manager is installed", async () => {
    const socketPath = tmpSocketPath("daemon-start-no-sense-manager")
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    }
    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler: {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async () => ({ ok: true, message: "triggered" })),
        reconcile: vi.fn(async () => undefined),
        recordTaskRun: vi.fn(async () => undefined),
      },
      healthMonitor: {
        runChecks: vi.fn(async () => []),
      },
      router: {
        send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
        pollInbox: vi.fn(() => []),
      },
      mailboxServerFactory: vi.fn(async () => ({
        url: "http://127.0.0.1:6876",
        stop: async () => undefined,
      })),
    } as any)

    try {
      await daemon.start()
      expect(processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    } finally {
      await daemon.stop()
    }
  })

  it("returns structured status data with separate senses and workers", async () => {
    const socketPath = tmpSocketPath("daemon-status")
    // Use an empty bundlesRoot so listBundleSyncRows returns [] (no leak to real ~/AgentBundles)
    const isolatedBundles = path.join(os.tmpdir(), `daemon-status-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.mkdirSync(isolatedBundles, { recursive: true })
    const { daemon, processManager, senseManager } = make(socketPath, isolatedBundles)

    const emptyStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(emptyStatus.data).toEqual({
      overview: expect.objectContaining({
        daemon: "running",
        workerCount: 0,
        senseCount: 0,
        mailboxUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
        entryPath: expect.any(String),
        mode: expect.stringMatching(/^(dev|production)$/),
      }),
      senses: [],
      workers: [],
      sync: [],
      agents: [],
    })

    senseManager.listSenseRows.mockReturnValueOnce([
      {
        agent: "slugger",
        sense: "teams",
        label: "Teams",
        enabled: false,
        status: "disabled",
        detail: "not enabled in agent.json",
      },
    ])

    const disabledOnlyStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(disabledOnlyStatus.summary).toBe("daemon=running\tworkers=0\tsenses=1\thealth=ok")

    senseManager.listSenseRows.mockReturnValueOnce([
      {
        agent: "slugger",
        sense: "bluebubbles",
        label: "BlueBubbles",
        enabled: true,
        status: "not_attached",
        detail: "not attached on this machine",
      },
    ])

    const notAttachedStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(notAttachedStatus.summary).toContain("health=ok")
    expect(notAttachedStatus.summary).toContain("items=slugger/bluebubbles:not_attached")

    senseManager.listSenseRows.mockReturnValueOnce([
      {
        agent: "slugger",
        sense: "bluebubbles",
        label: "BlueBubbles",
        enabled: true,
        status: "error",
        detail: "listener unreachable",
      },
    ])

    const unhealthySenseStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(unhealthySenseStatus.summary).toBe(
      "daemon=running\tworkers=0\tsenses=1\thealth=warn\tdegraded=sense:slugger/bluebubbles:error",
    )
    expect(unhealthySenseStatus.data).toEqual(expect.objectContaining({
      overview: expect.objectContaining({ health: "warn" }),
    }))

    senseManager.listSenseRows.mockReturnValueOnce([
      {
        agent: "slugger",
        sense: "mail",
        label: "Mail",
        enabled: true,
        status: "ready",
        detail: "configured but worker has no proof yet",
      },
    ])

    const readyOnlySenseStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(readyOnlySenseStatus.summary).toContain("health=warn")
    expect(readyOnlySenseStatus.summary).toContain("sense:slugger/mail:ready")

    processManager.listAgentSnapshots.mockReturnValueOnce([
      {
        name: "slugger",
        channel: "private-runtime",
        autoStart: false,
        status: "stopped",
        pid: null,
        restartCount: 0,
        startedAt: null,
        lastCrashAt: null,
        backoffMs: 1000,
      },
    ])
    senseManager.listSenseRows.mockReturnValueOnce([])

    const passiveWorkerStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(passiveWorkerStatus.summary).toBe(
      "daemon=running\tworkers=1\tsenses=0\thealth=ok\titems=slugger/private-runtime:stopped",
    )
    expect(passiveWorkerStatus.data).toEqual(expect.objectContaining({
      overview: expect.objectContaining({ health: "ok", workerCount: 1 }),
      workers: [
        expect.objectContaining({
          agent: "slugger",
          worker: "private-runtime",
          autoStart: false,
          status: "stopped",
        }),
      ],
    }))

    processManager.listAgentSnapshots.mockReturnValueOnce([
      {
        name: "slugger",
        channel: "private-runtime",
        status: "running",
        pid: null,
        restartCount: 2,
        startedAt: null,
        lastCrashAt: null,
        backoffMs: 1000,
      },
    ])
    senseManager.listSenseRows.mockReturnValueOnce([
      {
        agent: "slugger",
        sense: "cli",
        label: "CLI",
        enabled: true,
        status: "interactive",
        detail: "local interactive terminal",
      },
      {
        agent: "slugger",
        sense: "teams",
        label: "Teams",
        enabled: false,
        status: "disabled",
        detail: "not enabled in agent.json",
      },
      {
        agent: "slugger",
        sense: "bluebubbles",
        label: "BlueBubbles",
        enabled: true,
        status: "running",
        detail: ":18790 /bluebubbles-webhook",
      },
    ])

    const populatedStatus = await daemon.handleCommand({ kind: "daemon.status" })
    expect(populatedStatus.summary).toContain("workers=1")
    expect(populatedStatus.summary).toContain("senses=3")
    expect(populatedStatus.data).toEqual({
      overview: expect.objectContaining({
        daemon: "running",
        workerCount: 1,
        senseCount: 3,
        mailboxUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      }),
      workers: [
        expect.objectContaining({
          agent: "slugger",
          worker: "private-runtime",
          status: "running",
          restartCount: 2,
        }),
      ],
      senses: [
        expect.objectContaining({ agent: "slugger", sense: "cli", status: "interactive" }),
        expect.objectContaining({ agent: "slugger", sense: "teams", status: "disabled" }),
        expect.objectContaining({ agent: "slugger", sense: "bluebubbles", status: "running" }),
      ],
      sync: [],
      agents: [],
    })
  })

  it("rolls last health monitor canary failures into daemon status", async () => {
    const socketPath = tmpSocketPath("daemon-status-health-checks")
    const isolatedBundles = path.join(os.tmpdir(), `daemon-status-health-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.mkdirSync(isolatedBundles, { recursive: true })
    const { daemon, healthMonitor } = make(socketPath, isolatedBundles)
    const canaryFailure = {
      name: "sense-probe:mcp-canary:slugger",
      status: "critical" as const,
      message: "mcp canary failed: transport closed",
    }
    healthMonitor.getLastResults.mockReturnValueOnce([canaryFailure])

    const status = await daemon.handleCommand({ kind: "daemon.status" })

    expect(status.summary).toContain("health=warn")
    expect(status.summary).toContain("health-check:sense-probe:mcp-canary:slugger:critical")
    expect(status.data).toEqual(expect.objectContaining({
      overview: expect.objectContaining({ health: "warn" }),
      healthChecks: [canaryFailure],
    }))
  })

  it("overlays degraded scheduler jobs into daemon status before health monitor runs", async () => {
    const socketPath = tmpSocketPath("daemon-status-cron-degraded")
    const isolatedBundles = path.join(os.tmpdir(), `daemon-status-cron-degraded-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.mkdirSync(isolatedBundles, { recursive: true })
    const { daemon, scheduler, healthMonitor } = make(socketPath, isolatedBundles)
    healthMonitor.getLastResults.mockReturnValueOnce([])
    scheduler.listDegradedJobs.mockReturnValueOnce([
      { id: "habit:rsvp-wedding", reason: "cron registration failed — using timer fallback" },
    ])

    const status = await daemon.handleCommand({ kind: "daemon.status" })

    expect(status.summary).toContain("health=warn")
    expect(status.summary).toContain("health-check:cron-health:warn")
    expect(status.data).toEqual(expect.objectContaining({
      overview: expect.objectContaining({ health: "warn" }),
      healthChecks: [
        {
          name: "cron-health",
          status: "warn",
          message: "cron jobs degraded; timer fallback active: habit:rsvp-wedding (cron registration failed — using timer fallback)",
        },
      ],
    }))
  })

  it("replaces cached cron-health status when scheduler jobs are degraded", async () => {
    const socketPath = tmpSocketPath("daemon-status-cron-health-replace")
    const isolatedBundles = path.join(os.tmpdir(), `daemon-status-cron-health-replace-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.mkdirSync(isolatedBundles, { recursive: true })
    const { daemon, scheduler, healthMonitor } = make(socketPath, isolatedBundles)
    healthMonitor.getLastResults.mockReturnValueOnce([
      { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
    ])
    scheduler.listDegradedJobs.mockReturnValueOnce([
      { id: "await:vendor-reply", reason: "cron registration failed — using timer fallback" },
    ])

    const status = await daemon.handleCommand({ kind: "daemon.status" })

    expect(status.data).toEqual(expect.objectContaining({
      healthChecks: [
        {
          name: "cron-health",
          status: "warn",
          message: "cron jobs degraded; timer fallback active: await:vendor-reply (cron registration failed — using timer fallback)",
        },
      ],
    }))
  })

  it("includes provider rows in status when bundle agents exist", async () => {
    const socketPath = tmpSocketPath("daemon-status-providers")
    const isolatedBundles = path.join(os.tmpdir(), `daemon-status-provider-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const agentRoot = path.join(isolatedBundles, "slugger.ouro")
    const scaffoldRoot = path.join(isolatedBundles, "fresh-agent.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.mkdirSync(scaffoldRoot, { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
      enabled: true,
      vault: { email: "slugger@ouro.bot", serverUrl: "https://vault.ouro.bot" },
    })}\n`, "utf-8")
    fs.writeFileSync(path.join(scaffoldRoot, "agent.json"), `${JSON.stringify({
      enabled: true,
      senses: { cli: { enabled: true } },
    })}\n`, "utf-8")
    const { daemon } = make(socketPath, isolatedBundles)

    try {
      const status = await daemon.handleCommand({ kind: "daemon.status" })

      expect(status.data).toMatchObject({
        providers: [
          expect.objectContaining({
            agent: "slugger",
            lane: "outward",
            provider: "anthropic",
            model: "claude-opus-4-6",
            source: "agent.json",
            readiness: "unknown",
            credential: "checked previously",
          }),
          expect.objectContaining({
            agent: "slugger",
            lane: "inner",
            provider: "anthropic",
            model: "claude-opus-4-6",
            source: "agent.json",
            readiness: "unknown",
            credential: "checked previously",
          }),
        ],
      })
      expect(status.data).toMatchObject({
        agents: expect.arrayContaining([
          expect.objectContaining({
            name: "fresh-agent",
            managementBlockedReason: "inactive scaffold: no vault locator, sync, or enabled external sense",
          }),
        ]),
      })
      expect(JSON.stringify(status.data)).not.toContain("\"agent\":\"fresh-agent\"")
    } finally {
      fs.rmSync(isolatedBundles, { recursive: true, force: true })
    }
  })

  it("handles logs, chat connect, message, task poke, and hatch commands", async () => {
    const socketPath = tmpSocketPath("daemon-command-set")
    const { daemon, processManager, router, scheduler } = make(socketPath)

    const logs = await daemon.handleCommand({ kind: "daemon.logs" })
    expect(logs.ok).toBe(true)
    expect(logs.summary).toContain("logs")
    expect(logs.data).toEqual({ logDir: "~/AgentBundles/<agent>.ouro/state/daemon/logs" })

    const chat = await daemon.handleCommand({ kind: "chat.connect", agent: "slugger" })
    expect(chat.ok).toBe(true)
    expect(chat.message).toContain("connected")
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")

    const queued = await daemon.handleCommand({
      kind: "message.send",
      from: "ouro-cli",
      to: "ouroboros",
      content: "hi",
      sessionId: "session-1",
      taskRef: "task-7",
    })
    expect(queued.message).toContain("queued message")
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "ouro-cli",
      to: "ouroboros",
      content: "hi",
      sessionId: "session-1",
      taskRef: "task-7",
    }))
    // Regression guard (2026-05-11 wake-storm fix): message.send is now
    // queue-only. The handler MUST NOT auto-start or auto-wake the recipient.
    // Callers that want immediate processing must send `inner.wake`
    // separately. The previous behavior — calling startAgent + sendToAgent
    // here — defeated the post-tool-use hook's intentional "queue-only,
    // don't wake on every tool call" design and burned ~$50 in API cost.
    expect(processManager.startAgent).not.toHaveBeenCalledWith("ouroboros")
    expect(processManager.sendToAgent).not.toHaveBeenCalledWith("ouroboros", { type: "message" })

    const polled = await daemon.handleCommand({ kind: "message.poll", agent: "ouroboros" })
    expect(polled.summary).toBe("1 messages")
    expect(router.pollInbox).toHaveBeenCalledWith("ouroboros")

    const poke = await daemon.handleCommand({ kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" })
    expect(poke.ok).toBe(true)
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "slugger",
      taskRef: "habit-heartbeat",
    }))
    expect(scheduler.recordTaskRun).toHaveBeenCalledWith("slugger", "habit-heartbeat")
    expect(processManager.sendToAgent).not.toHaveBeenCalledWith("slugger", { type: "poke", taskId: "habit-heartbeat" })

    const hatch = await daemon.handleCommand({ kind: "hatch.start" })
    expect(hatch.ok).toBe(true)
    expect(hatch.message).toContain("hatch flow is stubbed")
  })

  it("keeps high-frequency ordinary message sends queue-only with no private-runtime policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-message-send-storm")
    const ledgerPath = path.join(os.tmpdir(), `message-send-storm-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    router.send.mockImplementation(async ({ content }: { content: string }) => {
      const match = content.match(/(\d+)$/)
      const sequence = match ? match[1] : "0"
      return { id: `storm-${sequence}`, queuedAt: "2026-07-04T03:00:00.000Z" }
    })

    const responses = []
    for (let index = 1; index <= 25; index += 1) {
      responses.push(await daemon.handleCommand({
        kind: "message.send",
        from: "claude-code:storm-session",
        to: "slugger",
        content: `post-tool-use ${index}`,
        sessionId: "storm-session",
      }))
    }

    expect(responses).toHaveLength(25)
    expect(responses[0]).toMatchObject({ ok: true, message: "queued message storm-1" })
    expect(responses[24]).toMatchObject({ ok: true, message: "queued message storm-25" })
    expect(router.send).toHaveBeenCalledTimes(25)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
    expect(policyDeps.resolveProviderLane).not.toHaveBeenCalled()
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
  })

  it("routes task pokes through private-runtime policy and denies without direct poke delivery", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-denied")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-denied-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    const { daemon, processManager, router, scheduler } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({ kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" })

    expect(poke).toMatchObject({
      ok: true,
      message: "queued poke msg-1",
      data: { id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" },
    })
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "ouro-poke",
      to: "slugger",
      content: "poke habit-heartbeat",
      priority: "high",
      taskRef: "habit-heartbeat",
    }))
    expect(scheduler.recordTaskRun).toHaveBeenCalledWith("slugger", "habit-heartbeat")
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "slugger",
        origin: "daemon.private.wake",
        reason: "task poke habit-heartbeat",
        triggerSource: "task-poke",
        budgetClass: "scheduled",
        idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-1",
        originRefs: [
          { kind: "task", id: "habit-heartbeat" },
          { kind: "queue-receipt", id: "msg-1" },
          { kind: "daemon-command", id: "task.poke" },
        ],
      }),
      expect.any(Object),
    )
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("routes external events through receipts, queued evidence, and idempotent private wakes", async () => {
    const socketPath = tmpSocketPath("daemon-external-event")
    const ledgerPath = path.join(os.tmpdir(), `external-event-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const externalEventRoot = path.join(os.tmpdir(), `external-events-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-external-event-bundles-"))
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps, externalEventRoot })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const command = {
      kind: "external.event.submit",
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      summary: "Feedback arrived",
      evidence: ["/tmp/feedback/screenshot-1.jpg"],
      payloadPath: "/tmp/feedback/event.json",
      priority: "high",
    } as const

    const first = await daemon.handleCommand(command)
    const duplicate = await daemon.handleCommand(command)

    expect(first).toMatchObject({
      ok: true,
      message: expect.stringContaining("queued external event app-store-connect/feedback-1 as msg-1"),
      data: {
        event: expect.objectContaining({
          agent: "slugger",
          source: "app-store-connect",
          eventType: "feedback.created",
          eventId: "feedback-1",
          duplicateCount: 0,
        }),
        wake: expect.objectContaining({
          message: "woke private runtime for slugger",
        }),
      },
    })
    expect(duplicate).toMatchObject({
      ok: true,
      data: {
        event: expect.objectContaining({ duplicateCount: 1 }),
        wake: expect.objectContaining({
          message: "private-runtime wake denied for slugger: duplicate private-turn decision already recorded",
        }),
      },
    })

    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "ouro-external-event",
      to: "slugger",
      priority: "high",
      taskRef: "app-store-connect:feedback-1",
      content: expect.stringContaining("source: app-store-connect"),
    }))
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("/tmp/feedback/screenshot-1.jpg"),
    }))
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "slugger",
        origin: "daemon.private.wake",
        reason: "external event app-store-connect/feedback.created",
        triggerSource: "external-event",
        budgetClass: "interactive",
        idempotencyKey: "external-event:slugger:app-store-connect:feedback-1",
        originRefs: [
          { kind: "external-event", id: "feedback-1", source: "app-store-connect", eventType: "feedback.created" },
          { kind: "queue-receipt", id: "msg-1" },
          { kind: "daemon-command", id: "external.event.submit" },
        ],
      }),
      expect.any(Object),
    )
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", expect.objectContaining({
      type: "message",
      privateTurnDecision: expect.objectContaining({
        idempotencyKey: "external-event:slugger:app-store-connect:feedback-1",
      }),
    }))

    const recordPath = path.join(externalEventRoot, "slugger", "app-store-connect", "feedback-1.json")
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as { duplicateCount: number; payloadPath: string }
    expect(record).toMatchObject({
      duplicateCount: 1,
      payloadPath: "/tmp/feedback/event.json",
    })
    const pendingDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "self", "inner", "dialog")
    const pendingFiles = fs.readdirSync(pendingDir).filter((entry) => entry.endsWith(".json"))
    expect(pendingFiles).toHaveLength(1)
    const pending = JSON.parse(fs.readFileSync(path.join(pendingDir, pendingFiles[0]), "utf-8"))
    expect(pending).toMatchObject({
      from: "ouro-external-event",
      friendId: "ouro-external-event",
      channel: "external-event",
      key: "app-store-connect:feedback-1",
      delegatedFrom: {
        friendId: "ouro-external-event",
        channel: "external-event",
        key: "app-store-connect:feedback-1",
      },
      obligationStatus: "pending",
      mode: "relay",
    })
    expect(pending.content).toContain("[External Event]")
    expect(pending.content).toContain("type: feedback.created")
    expect(pending.content).toContain("/tmp/feedback/screenshot-1.jpg")
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("queues external events without waking and uses the default CLI receipt root", async () => {
    const socketPath = tmpSocketPath("daemon-external-event-no-wake")
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-external-event-home-"))
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const { daemon, processManager, router } = make(socketPath)
      const response = await daemon.handleCommand({
        kind: "external.event.submit",
        agent: "slugger",
        source: "app-store-connect",
        eventType: "feedback.created",
        eventId: "feedback-no-wake",
        wake: false,
      } as const)

      expect(response).toMatchObject({
        ok: true,
        message: "queued external event app-store-connect/feedback-no-wake as msg-1",
        data: {
          wake: null,
          event: expect.objectContaining({
            recordPath: path.join(home, ".ouro-cli", "daemon", "external-events", "slugger", "app-store-connect", "feedback-no-wake.json"),
          }),
        },
      })
      expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
        taskRef: "app-store-connect:feedback-no-wake",
      }))
      expect(processManager.startAgent).not.toHaveBeenCalled()
      expect(processManager.sendToAgent).not.toHaveBeenCalled()
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("falls back to Date.now when queuing external events with malformed timestamps", async () => {
    const socketPath = tmpSocketPath("daemon-external-event-invalid-timestamp")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-external-event-invalid-timestamp-bundles-"))
    const { daemon } = make(socketPath, bundlesRoot)
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(123456)

    ;(daemon as any).queueExternalEventForPrivateRuntime({
      schemaVersion: 1,
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-bad-time",
      summary: null,
      evidence: [],
      payloadPath: null,
      priority: "high",
      receivedAt: "not-a-date",
      recordPath: "/tmp/feedback-bad-time.json",
      duplicateCount: 0,
      updatedAt: "2026-07-07T00:00:00.000Z",
    })

    const pendingDir = path.join(bundlesRoot, "slugger.ouro", "state", "pending", "self", "inner", "dialog")
    const pendingFiles = fs.readdirSync(pendingDir).filter((entry) => entry.endsWith(".json"))
    expect(pendingFiles).toHaveLength(1)
    const pending = JSON.parse(fs.readFileSync(path.join(pendingDir, pendingFiles[0]), "utf-8"))
    expect(pending.timestamp).toBe(123456)

    nowSpy.mockRestore()
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("uses a defensive wake-skipped label when an external-event wake has no message", async () => {
    const socketPath = tmpSocketPath("daemon-external-event-wake-fallback")
    const externalEventRoot = path.join(os.tmpdir(), `external-events-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const { daemon, processManager } = make(socketPath, undefined, { externalEventRoot })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    vi.spyOn(daemon as any, "handlePrivateRuntimeWake").mockResolvedValue({ ok: true })

    const response = await daemon.handleCommand({
      kind: "external.event.submit",
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-wake-fallback",
    } as const)

    expect(response).toMatchObject({
      ok: true,
      message: "queued external event app-store-connect/feedback-wake-fallback as msg-1; wake skipped",
      data: {
        wake: { ok: true },
      },
    })
    fs.rmSync(externalEventRoot, { recursive: true, force: true })
  })

  it("records one task-poke allow decision before starting model-backed private work", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-allowed")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-allowed-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    processManager.startAgent.mockImplementationOnce(async () => {
      expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    })

    const poke = await daemon.handleCommand({ kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" })

    expect(poke).toMatchObject({
      ok: true,
      message: "queued poke msg-1",
      data: { id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(1)
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-1",
        triggerSource: "task-poke",
        originRefs: [
          { kind: "task", id: "habit-heartbeat" },
          { kind: "queue-receipt", id: "msg-1" },
          { kind: "daemon-command", id: "task.poke" },
        ],
      }),
      expect.any(Object),
    )
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      agent: "slugger",
      origin: "daemon.private.wake",
      result: "allow",
      executable: true,
      triggerSource: "task-poke",
      idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-1",
      ledgerLocator: { path: ledgerPath, line: 1 },
    })
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).not.toHaveBeenCalledWith("slugger", { type: "poke", taskId: "habit-heartbeat" })
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "poke",
      taskId: "habit-heartbeat",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        triggerSource: "task-poke",
        idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-1",
      }),
    })
    expect(policyDeps.evaluatePolicy.mock.invocationCallOrder[0]).toBeLessThan(
      processManager.startAgent.mock.invocationCallOrder[0]!,
    )
  })

  it("does not execute duplicate allowed task-poke private wakes for the same idempotency key", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-duplicate")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-duplicate-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router, scheduler } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = { kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" } as const

    const firstPoke = await daemon.handleCommand(command)
    const duplicatePoke = await daemon.handleCommand(command)

    expect(firstPoke).toMatchObject({ ok: true, message: "queued poke msg-1" })
    expect(duplicatePoke).toMatchObject({ ok: true, message: "queued poke msg-1" })
    expect(router.send).toHaveBeenCalledTimes(2)
    expect(scheduler.recordTaskRun).toHaveBeenCalledTimes(2)
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(2)
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).not.toHaveBeenCalledWith("slugger", { type: "poke", taskId: "habit-heartbeat" })
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", expect.objectContaining({
      type: "poke",
      taskId: "habit-heartbeat",
      privateTurnDecision: expect.objectContaining({
        idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-1",
      }),
    }))
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
  })

  it("executes later task pokes with distinct queue receipts instead of duplicate-denying the task forever", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-distinct-receipts")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-distinct-receipts-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router, scheduler } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    router.send
      .mockResolvedValueOnce({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })
      .mockResolvedValueOnce({ id: "msg-2", queuedAt: "2026-03-05T23:05:00.000Z" })

    const firstPoke = await daemon.handleCommand({ kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" })
    const laterPoke = await daemon.handleCommand({ kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" })

    expect(firstPoke).toMatchObject({ ok: true, message: "queued poke msg-1" })
    expect(laterPoke).toMatchObject({ ok: true, message: "queued poke msg-2" })
    expect(router.send).toHaveBeenCalledTimes(2)
    expect(scheduler.recordTaskRun).toHaveBeenCalledTimes(2)
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(2)
    expect(processManager.startAgent).toHaveBeenCalledTimes(2)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(2)
    expect(processManager.sendToAgent).toHaveBeenNthCalledWith(1, "slugger", expect.objectContaining({
      type: "poke",
      taskId: "habit-heartbeat",
      privateTurnDecision: expect.objectContaining({
        idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-1",
      }),
    }))
    expect(processManager.sendToAgent).toHaveBeenNthCalledWith(2, "slugger", expect.objectContaining({
      type: "poke",
      taskId: "habit-heartbeat",
      privateTurnDecision: expect.objectContaining({
        idempotencyKey: "task-poke:slugger:habit-heartbeat:msg-2",
      }),
    }))
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(2)
    expect(ledgerRows.map((row) => row.idempotencyKey)).toEqual([
      "task-poke:slugger:habit-heartbeat:msg-1",
      "task-poke:slugger:habit-heartbeat:msg-2",
    ])
  })

  it("keeps task pokes queue-only for unknown private-runtime agents before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-unknown")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-unknown-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router, scheduler } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot("slugger")])

    const poke = await daemon.handleCommand({ kind: "task.poke", agent: "ghost", taskId: "habit-heartbeat" })

    expect(poke).toMatchObject({ ok: true, message: "queued poke msg-1" })
    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "ghost",
      taskRef: "habit-heartbeat",
    }))
    expect(scheduler.recordTaskRun).toHaveBeenCalledWith("ghost", "habit-heartbeat")
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("rejects malformed task-poke payloads before queueing or policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-invalid")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router, scheduler } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({ kind: "task.poke", agent: "slugger" } as unknown as never)

    expect(poke).toEqual({
      ok: false,
      error: "Invalid task.poke payload: expected non-empty string fields 'agent' and 'taskId'.",
    })
    expect(router.send).not.toHaveBeenCalled()
    expect(scheduler.recordTaskRun).not.toHaveBeenCalled()
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("records a task-poke allow decision but does not notify the worker when start fails", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-start-fails")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-start-fails-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager, router, scheduler } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    processManager.startAgent.mockRejectedValueOnce(new Error("agent start boom"))

    await expect(daemon.handleCommand({ kind: "task.poke", agent: "slugger", taskId: "habit-heartbeat" }))
      .rejects.toThrow("agent start boom")

    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "slugger",
      taskRef: "habit-heartbeat",
    }))
    expect(scheduler.recordTaskRun).toHaveBeenCalledWith("slugger", "habit-heartbeat")
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(1)
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("routes habit pokes through private-runtime policy and denies without direct habit delivery", async () => {
    const socketPath = tmpSocketPath("daemon-habit-poke-denied")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-habit-poke-denied-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `habit-poke-denied-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    writeHabitFile({
      bundlesRoot,
      agent: "slugger",
      habitName: "heartbeat",
      cadence: "30m",
      lastRun: null,
    })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "overdue",
    })

    expect(poke).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: default policy deny",
      data: {
        decision: expect.objectContaining({
          agent: "slugger",
          origin: "daemon.private.wake",
          result: "deny",
          executable: false,
          triggerSource: "habit-overdue",
          budgetClass: "scheduled",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "slugger",
        origin: "daemon.private.wake",
        reason: "habit heartbeat fired by overdue",
        triggerSource: "habit-overdue",
        budgetClass: "scheduled",
        idempotencyKey: "habit:slugger:heartbeat:overdue:overdue:first-run:30m",
        originRefs: [
          { kind: "habit", id: "heartbeat" },
          { kind: "habit-trigger", id: "overdue" },
          { kind: "habit-occurrence", id: "overdue:first-run:30m" },
          { kind: "daemon-command", id: "habit.poke" },
        ],
      }),
      expect.any(Object),
    )
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("deduplicates repeated scheduled habit pokes while lastRun has not advanced", async () => {
    const socketPath = tmpSocketPath("daemon-habit-poke-stable-occurrence")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-habit-poke-stable-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `habit-poke-stable-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    writeHabitFile({
      bundlesRoot,
      agent: "slugger",
      habitName: "heartbeat",
      cadence: "30m",
      lastRun: "2026-07-03T23:30:00.000Z",
    })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = {
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "launchd",
    } as const

    const firstPoke = await daemon.handleCommand(command)
    const duplicatePoke = await daemon.handleCommand(command)

    expect(firstPoke).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: true,
          idempotencyKey: "habit:slugger:heartbeat:launchd:launchd:last-run:2026-07-03T23:30:00.000Z:cadence:30m",
        }),
      },
    })
    expect(duplicatePoke).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: duplicate private-turn decision already recorded",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: false,
          deniedReason: "duplicate private-turn decision already recorded",
          idempotencyKey: "habit:slugger:heartbeat:launchd:launchd:last-run:2026-07-03T23:30:00.000Z:cadence:30m",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(2)
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "habit:slugger:heartbeat:launchd:launchd:last-run:2026-07-03T23:30:00.000Z:cadence:30m",
        originRefs: [
          { kind: "habit", id: "heartbeat" },
          { kind: "habit-trigger", id: "launchd" },
          { kind: "habit-occurrence", id: "launchd:last-run:2026-07-03T23:30:00.000Z:cadence:30m" },
          { kind: "daemon-command", id: "habit.poke" },
        ],
      }),
      expect.any(Object),
    )
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "habit",
      habitName: "heartbeat",
      trigger: "launchd",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        triggerSource: "habit-launchd",
      }),
    })
  })

  it("skips scheduled habit pokes with missing habit files before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-habit-poke-missing")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-habit-poke-missing-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `habit-poke-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = {
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "cron",
    } as const

    const poke = await daemon.handleCommand(command)
    const duplicatePoke = await daemon.handleCommand(command)

    expect(poke).toEqual({
      ok: true,
      message: "skipped scheduled habit heartbeat for slugger: habit file not found",
    })
    expect(duplicatePoke).toEqual({
      ok: true,
      message: "skipped scheduled habit heartbeat for slugger: habit file not found",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it.each([
    ["manual", "paused", "---\nstatus: paused\ntools: [shell, send_message]\n---\n\nDo not run.", null],
    ["poke", "cancelled", "---\nstatus: cancelled\ntools: [shell, send_message]\n---\n\nDo not run.", null],
    ["launchd", "degraded", "---\nstatus: retired\ncadence: 30m\ntools: [shell, send_message]\n---\n\nDo not run.", "invalid_status"],
    ["cron", "degraded", "---\nstatus: active\ncadence: 30m\ntools: [shell, send_message]\nThis frontmatter never closes.", "unterminated_frontmatter"],
  ] as const)(
    "rejects a %s habit poke whose current lifecycle state is %s before policy or dispatch",
    async (trigger, runtimeStatus, content, degradedReason) => {
      const socketPath = tmpSocketPath(`daemon-habit-${trigger}-${runtimeStatus}`)
      const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-habit-${trigger}-${runtimeStatus}-bundles-`))
      const ledgerPath = path.join(os.tmpdir(), `habit-${trigger}-${runtimeStatus}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
      const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
      writeRawHabitFile({ bundlesRoot, agent: "slugger", habitName: "lifecycle-check", content })
      const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
      processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

      const response = await daemon.handleCommand({
        kind: "habit.poke",
        agent: "slugger",
        habitName: "lifecycle-check",
        trigger,
      })

      expect(response).toEqual({
        ok: true,
        message: expect.stringMatching(new RegExp(`skipped scheduled habit lifecycle-check for slugger: habit status ${runtimeStatus} is non-executable`)),
      })
      expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
      expect(fs.existsSync(ledgerPath)).toBe(false)
      expect(processManager.startAgent).not.toHaveBeenCalled()
      expect(processManager.sendToAgent).not.toHaveBeenCalled()
      expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
        event: "daemon.habit_dispatch_skipped",
        level: "warn",
        meta: expect.objectContaining({
          agent: "slugger",
          habitName: "lifecycle-check",
          trigger,
          status: runtimeStatus,
          degradedReason,
        }),
      })])
    },
  )

  it.each([
    ["cron", "paused", "---\nstatus: paused\ncadence: 30m\n---\n\nDo not run."],
    ["launchd", "cancelled", "---\nstatus: cancelled\ncadence: 30m\n---\n\nDo not run."],
    ["overdue", "degraded", "---\nstatus: active\ncadence: 30m\nThis frontmatter never closes."],
  ] as const)("rejects a canonical scheduled %s private wake whose current lifecycle state is %s", async (trigger, status, content) => {
    const socketPath = tmpSocketPath(`daemon-private-wake-${trigger}-${status}`)
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-private-wake-${trigger}-${status}-bundles-`))
    const ledgerPath = path.join(os.tmpdir(), `habit-private-wake-${trigger}-${status}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    writeRawHabitFile({ bundlesRoot, agent: "slugger", habitName: "scheduled-check", content })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const response = await daemon.handleCommand(buildHabitPrivateWakeCommand({
      agent: "slugger",
      habitName: "scheduled-check",
      trigger,
      sourceRef: { kind: "daemon-entry", id: "habit-scheduler" },
      occurrenceId: `${trigger}:occurrence`,
    }))

    expect(response).toEqual({
      ok: true,
      message: expect.stringMatching(new RegExp(`skipped scheduled habit scheduled-check for slugger: habit status ${status} is non-executable`)),
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_skipped",
      meta: expect.objectContaining({
        agent: "slugger",
        habitName: "scheduled-check",
        trigger,
        status,
      }),
    })])
  })

  it.each([
    ["cron", "missing", false],
    ["overdue", "unreadable", true],
  ] as const)("rejects a canonical scheduled %s private wake with a %s definition", async (trigger, habitName, makeUnreadable) => {
    const socketPath = tmpSocketPath(`daemon-private-wake-${trigger}-${habitName}`)
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-private-wake-${trigger}-${habitName}-bundles-`))
    const ledgerPath = path.join(os.tmpdir(), `habit-private-wake-${trigger}-${habitName}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    if (makeUnreadable) {
      fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro", "habits", `${habitName}.md`), { recursive: true })
    }
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const response = await daemon.handleCommand(buildHabitPrivateWakeCommand({
      agent: "slugger",
      habitName,
      trigger,
      sourceRef: { kind: "daemon-entry", id: "habit-scheduler" },
      occurrenceId: `${trigger}:occurrence`,
    }))

    expect(response).toEqual({
      ok: true,
      message: expect.stringMatching(new RegExp(`skipped scheduled habit ${habitName} for slugger: habit status degraded is non-executable`)),
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_skipped",
      meta: expect.objectContaining({
        agent: "slugger",
        habitName,
        trigger,
        status: "degraded",
        degradedReason: "read_error",
      }),
    })])
  })

  it("records active canonical scheduled private-wake evidence before policy and worker dispatch", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-active")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-private-wake-active-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `habit-private-wake-active-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    writeHabitFile({ bundlesRoot, agent: "slugger", habitName: "scheduled-active", cadence: "30m", lastRun: null })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const response = await daemon.handleCommand(buildHabitPrivateWakeCommand({
      agent: "slugger",
      habitName: "scheduled-active",
      trigger: "launchd",
      sourceRef: { kind: "daemon-entry", id: "habit-scheduler" },
      occurrenceId: "launchd:occurrence",
    }))

    expect(response).toMatchObject({ ok: true, message: "woke private runtime for slugger" })
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_ready",
      meta: expect.objectContaining({
        agent: "slugger",
        habitName: "scheduled-active",
        trigger: "launchd",
        status: "active",
      }),
    })])
    expect(lifecycleEvidenceInvocationOrder("daemon.habit_dispatch_ready"))
      .toBeLessThan(policyDeps.evaluatePolicy.mock.invocationCallOrder[0]!)
    expect(lifecycleEvidenceInvocationOrder("daemon.habit_dispatch_ready"))
      .toBeLessThan(processManager.sendToAgent.mock.invocationCallOrder[0]!)
  })

  it.each([
    ["manual", "missing", false],
    ["poke", "unreadable", true],
  ] as const)("rejects a %s %s habit definition as degraded before policy or dispatch", async (trigger, habitName, makeUnreadable) => {
    const socketPath = tmpSocketPath(`daemon-habit-${habitName}`)
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-habit-${habitName}-bundles-`))
    const ledgerPath = path.join(os.tmpdir(), `habit-${habitName}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    if (makeUnreadable) {
      fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro", "habits", `${habitName}.md`), { recursive: true })
    }
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const response = await daemon.handleCommand({ kind: "habit.poke", agent: "slugger", habitName, trigger })

    expect(response).toEqual({
      ok: true,
      message: expect.stringMatching(new RegExp(`skipped scheduled habit ${habitName} for slugger: habit status degraded is non-executable`)),
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_skipped",
      meta: expect.objectContaining({
        agent: "slugger",
        habitName,
        trigger,
        status: "degraded",
        degradedReason: "read_error",
      }),
    })])
  })

  it("records active habit dispatch evidence before entering private-runtime policy", async () => {
    const socketPath = tmpSocketPath("daemon-habit-active-evidence")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-habit-active-evidence-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `habit-active-evidence-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    writeHabitFile({ bundlesRoot, agent: "slugger", habitName: "heartbeat", cadence: "30m", lastRun: null })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const response = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "manual",
    })

    expect(response.ok).toBe(true)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_ready",
      meta: expect.objectContaining({
        agent: "slugger",
        habitName: "heartbeat",
        trigger: "manual",
        status: "active",
      }),
    })])
    expect(lifecycleEvidenceInvocationOrder("daemon.habit_dispatch_ready"))
      .toBeLessThan(policyDeps.evaluatePolicy.mock.invocationCallOrder[0]!)
    expect(lifecycleEvidenceInvocationOrder("daemon.habit_dispatch_ready"))
      .toBeLessThan(processManager.sendToAgent.mock.invocationCallOrder[0]!)
  })

  it.each([
    ["missing", null, "read_error", "RSVP habit file not found"],
    ["unreadable", "directory", "read_error", "RSVP habit metadata invalid"],
    ["unterminated", "---\nstatus: active\ncadence: 0 10 * * *\nThis frontmatter never closes.", "unterminated_frontmatter", "RSVP habit metadata invalid"],
    ["paused", "paused", null, "habit status paused is non-executable"],
    ["cancelled", "cancelled", null, "habit status cancelled is non-executable"],
    ["invalid", "retired", "invalid_status", "RSVP habit metadata invalid"],
  ] as const)("rejects a typed RSVP %s definition before the native runner", async (fixture, fixtureState, degradedReason, messageFragment) => {
    const socketPath = tmpSocketPath(`daemon-rsvp-${fixture}`)
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `daemon-rsvp-${fixture}-bundles-`))
    const rsvpHabitRunner = vi.fn()
    const habitPath = path.join(bundlesRoot, "slugger.ouro", "habits", "rsvp-wedding.md")
    if (fixtureState === "directory") {
      fs.mkdirSync(habitPath, { recursive: true })
    } else if (fixtureState !== null) {
      const content = fixture === "unterminated"
        ? fixtureState
        : [
            "---",
            `status: ${fixtureState}`,
            "cadence: 0 10 * * *",
            "rsvp:",
            "  policyVersion: rsvp-habit/v1",
            "  mode: shadow",
            "  sense: bluebubbles",
            "  source: aisleplanner",
            "  routeRef: rsvp/config.json#bluebubblesRoute",
            "  snapshotRef: state/rsvp/snapshots/latest.json",
            "  outboundStateRef: state/rsvp/outbound-state.json",
            "  budgetRef: state/rsvp/spend-ledger.json",
            "  idempotencyRef: state/rsvp/outbound-state.json",
            "  liveSendEligible: false",
            "---",
            "",
            "Do not run.",
          ].join("\n")
      writeRawHabitFile({ bundlesRoot, agent: "slugger", habitName: "rsvp-wedding", content })
    }
    const { daemon } = make(socketPath, bundlesRoot, { rsvpHabitRunner })

    const response = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "manual",
    })

    expect(response).toEqual({
      ok: true,
      message: expect.stringContaining(messageFragment),
    })
    expect(rsvpHabitRunner).not.toHaveBeenCalled()
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_skipped",
      meta: expect.objectContaining({
        habitName: "rsvp-wedding",
        status: fixture === "paused" || fixture === "cancelled" ? fixture : "degraded",
        degradedReason,
      }),
    })])
  })

  it("skips RSVP habit pokes with missing habit files before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-missing")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-missing-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "manual",
    })

    expect(poke).toEqual({
      ok: true,
      message: "skipped scheduled habit rsvp-wedding for slugger: RSVP habit file not found",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("skips scheduled habit pokes without cadence before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-habit-poke-no-cadence")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-habit-poke-no-cadence-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `habit-poke-no-cadence-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    writeHabitFile({
      bundlesRoot,
      agent: "slugger",
      habitName: "heartbeat",
      cadence: null,
      lastRun: null,
    })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
      trigger: "launchd",
    })

    expect(poke).toEqual({
      ok: true,
      message: "skipped scheduled habit heartbeat for slugger: habit has no cadence",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("skips manual RSVP habit pokes with untyped metadata before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-untyped")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-untyped-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-untyped-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    writeHabitFile({
      bundlesRoot,
      agent: "slugger",
      habitName: "rsvp-wedding",
      cadence: "0 10 * * *",
      lastRun: null,
    })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "manual",
    })

    expect(poke).toEqual({
      ok: true,
      message: "skipped scheduled habit rsvp-wedding for slugger: RSVP habit metadata is required before private runtime wake",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("skips manual RSVP habit pokes with malformed typed metadata before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-malformed")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-malformed-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-malformed-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const habitsDir = path.join(bundlesRoot, "slugger.ouro", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "rsvp-wedding.md"),
      [
        "---",
        "title: rsvp-wedding",
        "cadence: 0 10 * * *",
        "status: active",
        "rsvp:",
        "  policyVersion: rsvp-habit/v1",
        "  mode: shadow",
        "  channel: bluebubbles",
        "---",
        "",
        "Run the RSVP habit.",
      ].join("\n"),
      "utf-8",
    )
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "manual",
    })

    expect(poke).toEqual({
      ok: true,
      message: "skipped scheduled habit rsvp-wedding for slugger: RSVP habit metadata invalid: RSVP habit metadata requires sense, not channel",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("skips manual RSVP habit pokes when the definition becomes unreadable", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-unreadable")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-unreadable-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-unreadable-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const habitsDir = path.join(bundlesRoot, "slugger.ouro", "habits")
    fs.mkdirSync(path.join(habitsDir, "rsvp-wedding.md"), { recursive: true })
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "manual",
    })

    expect(poke.ok).toBe(true)
    expect(poke.message).toMatch(/skipped scheduled habit rsvp-wedding.*RSVP habit metadata invalid/i)
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("runs manual RSVP habit pokes through the native RSVP runner with valid typed metadata", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-valid")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-valid-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-valid-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const rsvpHabitRunner = vi.fn(async () => ({
      ok: true,
      message: "native RSVP habit rsvp-wedding completed for slugger",
      lifecycle: "completed",
      runId: "rsvp-native-manual-run",
    }))
    const habitsDir = path.join(bundlesRoot, "slugger.ouro", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "rsvp-wedding.md"),
      [
        "---",
        "title: rsvp-wedding",
        "cadence: 0 10 * * *",
        "status: active",
        "rsvp:",
        "  policyVersion: rsvp-habit/v1",
        "  mode: shadow",
        "  sense: bluebubbles",
        "  source: aisleplanner",
        "  routeRef: rsvp/config.json#bluebubblesRoute",
        "  snapshotRef: state/rsvp/snapshots/latest.json",
        "  outboundStateRef: state/rsvp/outbound-state.json",
        "  budgetRef: state/rsvp/spend-ledger.json",
        "  idempotencyRef: state/rsvp/outbound-state.json",
        "  liveSendEligible: false",
        "---",
        "",
        "Run the RSVP habit.",
      ].join("\n"),
      "utf-8",
    )
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps, rsvpHabitRunner })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "manual",
    })

    expect(poke).toMatchObject({
      ok: true,
      message: "native RSVP habit rsvp-wedding completed for slugger",
      data: {
        lifecycle: "completed",
      },
    })
    expect(rsvpHabitRunner).toHaveBeenCalledWith(expect.objectContaining({
      agent: "slugger",
      bundlesRoot,
      habitName: "rsvp-wedding",
      trigger: "manual",
    }))
    expect(lifecycleEvidenceEvents()).toEqual([expect.objectContaining({
      event: "daemon.habit_dispatch_ready",
      meta: expect.objectContaining({
        agent: "slugger",
        habitName: "rsvp-wedding",
        trigger: "manual",
        status: "active",
      }),
    })])
    expect(lifecycleEvidenceInvocationOrder("daemon.habit_dispatch_ready"))
      .toBeLessThan(rsvpHabitRunner.mock.invocationCallOrder[0]!)
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("uses the production native RSVP runner when no daemon test seam is injected", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-production-runner")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-production-runner-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-production-runner-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    const habitsDir = path.join(bundlesRoot, "slugger.ouro", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "rsvp-wedding.md"),
      [
        "---",
        "title: rsvp-wedding",
        "cadence: 0 10 * * *",
        "status: active",
        "rsvp:",
        "  policyVersion: rsvp-habit/v1",
        "  mode: live",
        "  sense: bluebubbles",
        "  source: aisleplanner",
        "  routeRef: rsvp/config.json#bluebubblesRoute",
        "  snapshotRef: state/rsvp/snapshots/latest.json",
        "  outboundStateRef: state/rsvp/outbound-state.json",
        "  budgetRef: state/rsvp/spend-ledger.json",
        "  idempotencyRef: state/rsvp/outbound-state.json",
        "  liveSendEligible: true",
        "---",
        "",
        "Run the RSVP habit.",
      ].join("\n"),
      "utf-8",
    )
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "launchd",
    })

    expect(poke).toMatchObject({
      ok: false,
      message: "native RSVP habit rsvp-wedding failed for slugger: RSVP refresh requires native RSVP config before live work can run",
      data: expect.objectContaining({
        lifecycle: "error",
        payload: expect.objectContaining({
          command: "rsvp.refresh",
          requires: "native RSVP config",
        }),
      }),
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("preserves scheduler-supplied RSVP occurrence ids for native habit pokes", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-supplied-occurrence")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-supplied-occurrence-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-supplied-occurrence-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    const rsvpHabitRunner = vi.fn(async () => ({
      ok: true,
      message: "native RSVP habit rsvp-wedding completed for slugger",
      lifecycle: "completed",
      runId: "rsvp-native-supplied-occurrence-run",
    }))
    const habitsDir = path.join(bundlesRoot, "slugger.ouro", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "rsvp-wedding.md"),
      [
        "---",
        "title: rsvp-wedding",
        "cadence: 0 10 * * *",
        "status: active",
        "rsvp:",
        "  policyVersion: rsvp-habit/v1",
        "  mode: live",
        "  sense: bluebubbles",
        "  source: aisleplanner",
        "  routeRef: rsvp/config.json#bluebubblesRoute",
        "  snapshotRef: state/rsvp/snapshots/latest.json",
        "  outboundStateRef: state/rsvp/outbound-state.json",
        "  budgetRef: state/rsvp/spend-ledger.json",
        "  idempotencyRef: state/rsvp/outbound-state.json",
        "  liveSendEligible: true",
        "---",
        "",
        "Run the RSVP habit.",
      ].join("\n"),
      "utf-8",
    )
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps, rsvpHabitRunner })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "launchd",
      occurrenceId: "  launchd:explicit-occurrence  ",
    })

    expect(poke).toMatchObject({
      ok: true,
      data: expect.objectContaining({
        lifecycle: "completed",
      }),
    })
    expect(rsvpHabitRunner).toHaveBeenCalledWith(expect.objectContaining({
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "launchd",
      occurrenceId: "launchd:explicit-occurrence",
    }))
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("runs typed RSVP habit pokes natively even when default private-runtime policy denies", async () => {
    const socketPath = tmpSocketPath("daemon-rsvp-habit-poke-native")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-rsvp-habit-poke-native-bundles-"))
    const ledgerPath = path.join(os.tmpdir(), `rsvp-habit-poke-native-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    const rsvpHabitRunner = vi.fn(async () => ({
      ok: true,
      message: "native RSVP habit rsvp-wedding completed for slugger",
      lifecycle: "completed",
      runId: "rsvp-native-run",
    }))
    const habitsDir = path.join(bundlesRoot, "slugger.ouro", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "rsvp-wedding.md"),
      [
        "---",
        "title: rsvp-wedding",
        "cadence: 0 10 * * *",
        "status: active",
        "rsvp:",
        "  policyVersion: rsvp-habit/v1",
        "  mode: live",
        "  sense: bluebubbles",
        "  source: aisleplanner",
        "  routeRef: rsvp/config.json#bluebubblesRoute",
        "  snapshotRef: state/rsvp/snapshots/latest.json",
        "  outboundStateRef: state/rsvp/outbound-state.json",
        "  budgetRef: state/rsvp/spend-ledger.json",
        "  idempotencyRef: state/rsvp/outbound-state.json",
        "  liveSendEligible: true",
        "---",
        "",
        "Run the RSVP habit.",
      ].join("\n"),
      "utf-8",
    )
    const { daemon, processManager } = make(socketPath, bundlesRoot, { privateRuntimePolicyDeps: policyDeps, rsvpHabitRunner })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "rsvp-wedding",
      trigger: "launchd",
    })

    expect(poke).toMatchObject({
      ok: true,
      message: "native RSVP habit rsvp-wedding completed for slugger",
      data: expect.objectContaining({
        lifecycle: "completed",
      }),
    })
    expect(rsvpHabitRunner).toHaveBeenCalledWith(expect.objectContaining({
      agent: "slugger",
      bundlesRoot,
      habitName: "rsvp-wedding",
      trigger: "launchd",
      occurrenceId: "launchd:first-run:0 10 * * *",
    }))
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("rejects malformed habit-poke payloads before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-habit-poke-invalid")
    const ledgerPath = path.join(os.tmpdir(), `habit-poke-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const poke = await daemon.handleCommand({ kind: "habit.poke", agent: "slugger", habitName: " " } as never)

    expect(poke).toEqual({
      ok: false,
      error: "Invalid habit.poke payload: expected non-empty string fields 'agent' and 'habitName'.",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("rejects habit pokes for unknown private-runtime agents before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-habit-poke-unknown")
    const ledgerPath = path.join(os.tmpdir(), `habit-poke-unknown-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot("slugger")])

    const poke = await daemon.handleCommand({
      kind: "habit.poke",
      agent: "ghost",
      habitName: "heartbeat",
      trigger: "overdue",
    })

    expect(poke).toEqual({
      ok: false,
      error: "No managed agent 'ghost' is registered with daemon-managed private runtime.",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("revives a managed sense by resetting failure state, starting it, and returning its fresh snapshot", async () => {
    const socketPath = tmpSocketPath("daemon-sense-revive")
    const { daemon, processManager } = make(socketPath)
    const revivedSnapshot = {
      name: "slugger:bluebubbles",
      channel: "bluebubbles",
      status: "running",
      pid: 18790,
      restartCount: 0,
      startedAt: "2026-05-14T10:00:00.000Z",
      lastCrashAt: null,
      backoffMs: 1000,
      lastExitCode: null,
      lastSignal: null,
      errorReason: null,
      fixHint: null,
    }
    processManager.listAgentSnapshots
      .mockReturnValueOnce([
        {
          ...revivedSnapshot,
          status: "crashed",
          pid: null,
          startedAt: null,
          errorReason: "respawn loop detected",
          fixHint: "investigate the root cause then run `ouro up` to resume",
        },
      ])
      .mockReturnValueOnce([revivedSnapshot])
    processManager.resetAgentFailureState = vi.fn()

    const response = await daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: "slugger",
      sense: "bluebubbles",
      reason: "manual recovery after fixing BlueBubbles credentials",
    } as never)

    expect(processManager.resetAgentFailureState).toHaveBeenCalledWith("slugger:bluebubbles")
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger:bluebubbles")
    expect(response).toEqual({
      ok: true,
      message: "revived slugger/bluebubbles",
      data: revivedSnapshot,
    })
  })

  it("revives live sense-manager senses when worker snapshots do not contain sense processes", async () => {
    const socketPath = tmpSocketPath("daemon-sense-revive-sense-manager")
    const { daemon, processManager, senseManager } = make(socketPath)
    const revivedRow = {
      agent: "slugger",
      sense: "bluebubbles",
      label: "BlueBubbles",
      enabled: true,
      status: "running",
      detail: ":18789 /bluebubbles-webhook",
    }
    processManager.listAgentSnapshots.mockReturnValue([])
    senseManager.reviveSense.mockResolvedValue(revivedRow)

    const response = await daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: "slugger",
      sense: "bluebubbles",
      reason: "final-validation",
    } as never)

    expect(senseManager.reviveSense).toHaveBeenCalledWith("slugger", "bluebubbles")
    expect(processManager.resetAgentFailureState).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(response).toEqual({
      ok: true,
      message: "revived slugger/bluebubbles",
      data: revivedRow,
    })
  })

  it("returns the matched revive target when no fresh snapshot is available after restart", async () => {
    const socketPath = tmpSocketPath("daemon-sense-revive-stale-snapshot")
    const { daemon, processManager } = make(socketPath)
    const matchedSnapshot = {
      name: "slugger:bluebubbles",
      channel: "bluebubbles",
      status: "crashed",
      pid: null,
      restartCount: 3,
      startedAt: null,
      lastCrashAt: "2026-05-14T09:59:00.000Z",
      backoffMs: 1000,
      lastExitCode: 1,
      lastSignal: null,
      errorReason: "respawn loop detected",
      fixHint: "investigate the root cause then run `ouro up` to resume",
    }
    processManager.listAgentSnapshots
      .mockReturnValueOnce([matchedSnapshot])
      .mockReturnValueOnce([])
    processManager.resetAgentFailureState = vi.fn()

    const response = await daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: "slugger",
      sense: "bluebubbles",
      reason: "manual recovery after fixing BlueBubbles credentials",
    } as never)

    expect(processManager.resetAgentFailureState).toHaveBeenCalledWith("slugger:bluebubbles")
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger:bluebubbles")
    expect(response).toEqual({
      ok: true,
      message: "revived slugger/bluebubbles",
      data: matchedSnapshot,
    })
  })

  it("returns a friendly error for unknown sense revive targets without throwing or starting anything", async () => {
    const socketPath = tmpSocketPath("daemon-sense-revive-unknown")
    const { daemon, processManager } = make(socketPath)
    processManager.listAgentSnapshots.mockReturnValue([
      {
        name: "slugger:mail",
        channel: "mail",
        status: "running",
        pid: 4321,
        restartCount: 0,
        startedAt: "2026-05-14T10:00:00.000Z",
        lastCrashAt: null,
        backoffMs: 1000,
        lastExitCode: null,
        lastSignal: null,
        errorReason: null,
        fixHint: null,
      },
    ])
    processManager.resetAgentFailureState = vi.fn()

    await expect(daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: "slugger",
      sense: "bluebubbles",
      reason: "try missing sense",
    } as never)).resolves.toEqual({
      ok: false,
      error: "No managed sense 'bluebubbles' is registered for agent 'slugger'.",
    })

    await expect(daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: "ghost",
      sense: "bluebubbles",
      reason: "try missing agent",
    } as never)).resolves.toEqual({
      ok: false,
      error: "No managed agent 'ghost' is registered with daemon-managed senses.",
    })
    expect(processManager.resetAgentFailureState).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
  })

  it("returns a friendly invalid-payload response for malformed sense revive commands", async () => {
    const socketPath = tmpSocketPath("daemon-sense-revive-invalid-payload")
    const { daemon, processManager } = make(socketPath)

    await expect(daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: "slugger",
      reason: "try malformed payload",
    } as never)).resolves.toEqual({
      ok: false,
      error: "Invalid daemon.sense_revive payload: expected string fields 'agent', 'sense', and 'reason'.",
    })

    await expect(daemon.handleCommand({
      kind: "daemon.sense_revive",
      agent: 12,
      sense: "bluebubbles",
      reason: "try non-string agent",
    } as never)).resolves.toEqual({
      ok: false,
      error: "Invalid daemon.sense_revive payload: expected string fields 'agent', 'sense', and 'reason'.",
    })

    expect(processManager.listAgentSnapshots).not.toHaveBeenCalled()
    expect(processManager.resetAgentFailureState).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
  })

  it("denies canonical private wake by default without starting the worker", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-denied")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-denied-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
      originRefs: [{ kind: "cli", id: "manual" }],
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: default policy deny",
      data: {
        decision: expect.objectContaining({
          agent: "slugger",
          origin: "daemon.private.wake",
          result: "deny",
          executable: false,
          deniedReason: "default policy deny",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "slugger",
        origin: "daemon.private.wake",
        reason: "manual wake",
        triggerSource: "manual",
        budgetClass: "interactive",
        idempotencyKey: "manual-private-wake",
        originRefs: [{ kind: "cli", id: "manual" }],
      }),
      expect.any(Object),
    )
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("uses canonical private wake defaults and falls back to denial reason text", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-defaults")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-defaults-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    policyDeps.evaluatePolicy.mockReturnValueOnce({
      result: "deny",
      reason: "policy says wait",
    })
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: policy says wait",
      data: {
        decision: expect.objectContaining({
          result: "deny",
          executable: false,
          deniedReason: "policy says wait",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "slugger",
        origin: "daemon.private.wake",
        reason: "manual private-runtime wake",
        triggerSource: "manual",
        budgetClass: "interactive",
        idempotencyKey: expect.stringMatching(/^ptk_[0-9a-f]{64}$/),
        originRefs: [{ kind: "daemon-command", id: "private.wake" }],
      }),
      expect.any(Object),
    )
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("allows canonical private wake only after recording one policy decision", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-allowed")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-allowed-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
      originRefs: [{ kind: "cli", id: "manual" }],
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: {
        decision: expect.objectContaining({
          agent: "slugger",
          origin: "daemon.private.wake",
          result: "allow",
          executable: true,
          idempotencyKey: "manual-private-wake",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(1)
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      agent: "slugger",
      origin: "daemon.private.wake",
      result: "allow",
      executable: true,
      idempotencyKey: "manual-private-wake",
      requestFingerprint: expect.stringMatching(/^ptr_[0-9a-f]{64}$/),
      ledgerLocator: { path: ledgerPath, line: 1 },
    })
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "message",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        idempotencyKey: "manual-private-wake",
      }),
    })
  })

  it.each(["stopped", "crashed"])("wakes a %s registered private-runtime worker only after allow", async (status) => {
    const socketPath = tmpSocketPath(`daemon-private-wake-${status}`)
    const ledgerPath = path.join(os.tmpdir(), `private-wake-${status}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([{ ...registeredSnapshot(), status }])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: `manual wake for ${status} worker`,
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: `manual-private-wake-${status}`,
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: true,
          idempotencyKey: `manual-private-wake-${status}`,
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(1)
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "message",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        idempotencyKey: `manual-private-wake-${status}`,
      }),
    })
  })

  it("does not replay a previous allow when the current wake policy denies the same request", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-replay-denied")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-replay-denied-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = {
      kind: "private.wake",
      agent: "slugger",
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
      originRefs: [{ kind: "cli", id: "manual" }],
    } as unknown as never

    const firstWake = await daemon.handleCommand(command)
    policyDeps.evaluatePolicy.mockReturnValueOnce({
      result: "deny",
      reason: "private runtime policy denies refreshed wake",
      deniedReason: "refreshed policy deny",
    })
    const secondWake = await daemon.handleCommand(command)

    expect(firstWake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: { decision: expect.objectContaining({ result: "allow", executable: true }) },
    })
    expect(secondWake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: refreshed policy deny",
      data: {
        decision: expect.objectContaining({
          result: "deny",
          executable: false,
          deniedReason: "refreshed policy deny",
          idempotencyKey: "manual-private-wake",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(2)
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(2)
    expect(ledgerRows[1]).toMatchObject({
      result: "deny",
      executable: false,
      idempotencyKey: "manual-private-wake",
      requestFingerprint: ledgerRows[0]?.requestFingerprint,
      ledgerLocator: { path: ledgerPath, line: 2 },
    })
  })

  it("does not execute duplicate allowed wake decisions for the same request", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-duplicate-allowed")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-duplicate-allowed-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = {
      kind: "private.wake",
      agent: "slugger",
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
      originRefs: [{ kind: "cli", id: "manual" }],
    } as unknown as never

    const firstWake = await daemon.handleCommand(command)
    const duplicateWake = await daemon.handleCommand(command)

    expect(firstWake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: { decision: expect.objectContaining({ result: "allow", executable: true }) },
    })
    expect(duplicateWake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: duplicate private-turn decision already recorded",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: false,
          deniedReason: "duplicate private-turn decision already recorded",
          idempotencyKey: "manual-private-wake",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(2)
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      result: "allow",
      executable: true,
      idempotencyKey: "manual-private-wake",
      ledgerLocator: { path: ledgerPath, line: 1 },
    })
  })

  it("does not execute a wake after an allow then refreshed deny then allow replay", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-allow-deny-allow")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-allow-deny-allow-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = {
      kind: "private.wake",
      agent: "slugger",
      reason: "manual wake",
      triggerSource: "manual",
      budgetClass: "interactive",
      idempotencyKey: "manual-private-wake",
      originRefs: [{ kind: "cli", id: "manual" }],
    } as unknown as never

    const firstWake = await daemon.handleCommand(command)
    policyDeps.evaluatePolicy.mockReturnValueOnce({
      result: "deny",
      reason: "private runtime policy denies refreshed wake",
      deniedReason: "refreshed policy deny",
    })
    const deniedWake = await daemon.handleCommand(command)
    const replayedAllowWake = await daemon.handleCommand(command)

    expect(firstWake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: { decision: expect.objectContaining({ result: "allow", executable: true }) },
    })
    expect(deniedWake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: refreshed policy deny",
      data: { decision: expect.objectContaining({ result: "deny", executable: false }) },
    })
    expect(replayedAllowWake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: duplicate private-turn decision already recorded",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: false,
          deniedReason: "duplicate private-turn decision already recorded",
          idempotencyKey: "manual-private-wake",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(3)
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(2)
    expect(ledgerRows.map((row) => row.result)).toEqual(["allow", "deny"])
  })

  it("fails canonical private wake cleanly for unknown agents before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-private-wake-unknown")
    const ledgerPath = path.join(os.tmpdir(), `private-wake-unknown-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot("slugger")])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "ghost",
      reason: "manual wake",
    } as unknown as never)

    expect(wake).toEqual({
      ok: false,
      error: "No managed agent 'ghost' is registered with daemon-managed private runtime.",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("routes manual await pokes through private-runtime policy and denies without direct await delivery", async () => {
    const socketPath = tmpSocketPath("daemon-await-poke-denied")
    const ledgerPath = path.join(os.tmpdir(), `await-poke-denied-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "deny")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "await.poke",
      agent: "slugger",
      awaitName: "hey_export",
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: default policy deny",
      data: {
        decision: expect.objectContaining({
          agent: "slugger",
          origin: "daemon.private.wake",
          result: "deny",
          executable: false,
          deniedReason: "default policy deny",
          triggerSource: "await-poke",
          budgetClass: "scheduled",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "slugger",
        reason: "manual await condition check for hey_export",
        triggerSource: "await-poke",
        budgetClass: "scheduled",
        originRefs: [
          { kind: "await", id: "hey_export" },
          { kind: "daemon-command", id: "await.poke" },
        ],
      }),
      expect.any(Object),
    )
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("fails manual await pokes for unknown private-runtime agents before policy evaluation", async () => {
    const socketPath = tmpSocketPath("daemon-await-poke-unknown")
    const ledgerPath = path.join(os.tmpdir(), `await-poke-unknown-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot("slugger")])

    const wake = await daemon.handleCommand({
      kind: "await.poke",
      agent: "ghost",
      awaitName: "hey_export",
    } as unknown as never)

    expect(wake).toEqual({
      ok: false,
      error: "No managed agent 'ghost' is registered with daemon-managed private runtime.",
    })
    expect(policyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(processManager.startAgent).not.toHaveBeenCalled()
    expect(processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("records an await-poke allow decision before starting the model-backed private turn", async () => {
    const socketPath = tmpSocketPath("daemon-await-poke-allowed")
    const ledgerPath = path.join(os.tmpdir(), `await-poke-allowed-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "await.poke",
      agent: "slugger",
      awaitName: "hey_export",
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: {
        decision: expect.objectContaining({
          agent: "slugger",
          origin: "daemon.private.wake",
          result: "allow",
          executable: true,
          triggerSource: "await-poke",
          budgetClass: "scheduled",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(1)
    const ledgerRows = readPrivateTurnLedger(ledgerPath)
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      result: "allow",
      executable: true,
      triggerSource: "await-poke",
      ledgerLocator: { path: ledgerPath, line: 1 },
    })
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "await",
      awaitName: "hey_export",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        triggerSource: "await-poke",
      }),
    })
    const sentMessage = processManager.sendToAgent.mock.calls[0]?.[1] as Record<string, unknown>
    expect(sentMessage.privateTurnDecision).toBeDefined()
  })

  it("preserves await context on allowed scheduled private wakes", async () => {
    const socketPath = tmpSocketPath("daemon-await-scheduled-allowed")
    const ledgerPath = path.join(os.tmpdir(), `await-scheduled-allowed-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: "scheduled await condition check for hey_export",
      triggerSource: "await-scheduler",
      budgetClass: "scheduled",
      idempotencyKey: "await:slugger:hey_export:await-scheduler:2026-07-03T20:00:00.000Z",
      originRefs: [
        { kind: "await", id: "hey_export" },
        { kind: "scheduler", id: "await-scheduler" },
      ],
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: true,
          triggerSource: "await-scheduler",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(1)
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "await",
      awaitName: "hey_export",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        triggerSource: "await-scheduler",
      }),
    })
  })

  it("does not execute duplicate allowed await private wakes for the same idempotency key", async () => {
    const socketPath = tmpSocketPath("daemon-await-scheduled-duplicate")
    const ledgerPath = path.join(os.tmpdir(), `await-scheduled-duplicate-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])
    const command = {
      kind: "private.wake",
      agent: "slugger",
      reason: "scheduled await condition check for hey_export",
      triggerSource: "await-scheduler",
      budgetClass: "scheduled",
      idempotencyKey: "await:slugger:hey_export:await-scheduler:2026-07-03T20:00:00.000Z",
      originRefs: [
        { kind: "await", id: "hey_export" },
        { kind: "scheduler", id: "await-scheduler" },
      ],
    } as unknown as never

    const firstWake = await daemon.handleCommand(command)
    const duplicateWake = await daemon.handleCommand(command)

    expect(firstWake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: { decision: expect.objectContaining({ result: "allow", executable: true }) },
    })
    expect(duplicateWake).toMatchObject({
      ok: true,
      message: "private-runtime wake denied for slugger: duplicate private-turn decision already recorded",
      data: {
        decision: expect.objectContaining({
          result: "allow",
          executable: false,
          deniedReason: "duplicate private-turn decision already recorded",
          triggerSource: "await-scheduler",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledTimes(2)
    expect(processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", expect.objectContaining({
      type: "await",
      awaitName: "hey_export",
    }))
    expect(readPrivateTurnLedger(ledgerPath)).toHaveLength(1)
  })

  it("ignores blank await origin refs when selecting the worker wake mode", async () => {
    const socketPath = tmpSocketPath("daemon-await-blank-ref")
    const ledgerPath = path.join(os.tmpdir(), `await-blank-ref-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: "scheduled await condition check for blank ref",
      triggerSource: "await-scheduler",
      budgetClass: "scheduled",
      idempotencyKey: "await:slugger:blank:await-scheduler:2026-07-03T20:00:00.000Z",
      originRefs: [
        { kind: "await", id: "   " },
        { kind: "scheduler", id: "await-scheduler" },
      ],
    } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: { decision: expect.objectContaining({ result: "allow", executable: true }) },
    })
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(1)
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "message",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        triggerSource: "await-scheduler",
      }),
    })
  })

  it("ignores missing or blank task-poke origin refs when selecting the worker wake mode", async () => {
    const socketPath = tmpSocketPath("daemon-task-poke-blank-ref")
    const ledgerPath = path.join(os.tmpdir(), `task-poke-blank-ref-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const missingTaskRef = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: "task poke with missing task ref",
      triggerSource: "task-poke",
      budgetClass: "scheduled",
      idempotencyKey: "task-poke:slugger:missing-task-ref",
      originRefs: [{ kind: "queue-receipt", id: "msg-1" }],
    } as unknown as never)
    const blankTaskRef = await daemon.handleCommand({
      kind: "private.wake",
      agent: "slugger",
      reason: "task poke with blank task ref",
      triggerSource: "task-poke",
      budgetClass: "scheduled",
      idempotencyKey: "task-poke:slugger:blank-task-ref",
      originRefs: [
        { kind: "task", id: "   " },
        { kind: "queue-receipt", id: "msg-2" },
      ],
    } as unknown as never)

    expect(missingTaskRef).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
    })
    expect(blankTaskRef).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
    })
    expect(processManager.startAgent).toHaveBeenCalledTimes(2)
    expect(processManager.sendToAgent).toHaveBeenCalledTimes(2)
    expect(processManager.sendToAgent).toHaveBeenNthCalledWith(1, "slugger", {
      type: "message",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        idempotencyKey: "task-poke:slugger:missing-task-ref",
      }),
    })
    expect(processManager.sendToAgent).toHaveBeenNthCalledWith(2, "slugger", {
      type: "message",
      privateTurnDecision: expect.objectContaining({
        result: "allow",
        idempotencyKey: "task-poke:slugger:blank-task-ref",
      }),
    })
  })

  it("treats legacy inner.wake as a compatibility alias for private wake", async () => {
    const socketPath = tmpSocketPath("daemon-inner-wake")
    const ledgerPath = path.join(os.tmpdir(), `inner-wake-alias-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
    const policyDeps = privateRuntimePolicyDeps(ledgerPath, "allow")
    const { daemon, processManager } = make(socketPath, undefined, { privateRuntimePolicyDeps: policyDeps })
    processManager.listAgentSnapshots.mockReturnValue([registeredSnapshot()])

    const wake = await daemon.handleCommand({ kind: "inner.wake", agent: "slugger" } as unknown as never)

    expect(wake).toMatchObject({
      ok: true,
      message: "woke private runtime for slugger",
      data: {
        decision: expect.objectContaining({
          agent: "slugger",
          origin: "daemon.private.wake",
          result: "allow",
        }),
      },
    })
    expect(policyDeps.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "daemon.private.wake",
        reason: "legacy inner.wake compatibility alias",
        originRefs: [{ kind: "daemon-command", id: "inner.wake" }],
      }),
      expect.any(Object),
    )
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", {
      type: "message",
      privateTurnDecision: expect.objectContaining({ result: "allow" }),
    })
  })

  it("returns protocol errors for malformed payloads", async () => {
    const socketPath = tmpSocketPath("daemon-bad-raw")
    const { daemon } = make(socketPath)

    const notJson = JSON.parse(await daemon.handleRawPayload("not-json")) as { ok: boolean; error: string }
    expect(notJson.ok).toBe(false)
    expect(notJson.error).toContain("expected JSON object")

    const missingKind = JSON.parse(await daemon.handleRawPayload("{}")) as { ok: boolean; error: string }
    expect(missingKind.error).toContain("missing kind")

    const badKindType = JSON.parse(await daemon.handleRawPayload("{\"kind\":123}")) as { ok: boolean; error: string }
    expect(badKindType.error).toContain("kind must be a string")
  })

  it("stringifies non-Error throw values from command handling", async () => {
    const socketPath = tmpSocketPath("daemon-non-error-catch")
    const { daemon } = make(socketPath)
    vi.spyOn(daemon, "handleCommand").mockRejectedValueOnce("string-failure")

    const raw = await daemon.handleRawPayload("{\"kind\":\"daemon.status\"}")
    const parsed = JSON.parse(raw) as { ok: boolean; error: string }

    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe("string-failure")
  })

  it("builds status rows without a sense manager when none is configured", async () => {
    const socketPath = tmpSocketPath("daemon-no-sense-manager")
    const isolatedBundles = path.join(os.tmpdir(), `daemon-no-sense-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.mkdirSync(isolatedBundles, { recursive: true })
    const daemon = new OuroDaemon({
      socketPath,
      bundlesRoot: isolatedBundles,
      processManager: {
        listAgentSnapshots: () => [
          {
            name: "slugger",
            channel: "private-runtime",
            status: "crashed",
            pid: null,
            restartCount: 1,
            startedAt: null,
            lastCrashAt: null,
            backoffMs: 1000,
          },
        ],
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        startAgent: async () => undefined,
      },
      scheduler: {
        listJobs: () => [],
        triggerJob: async () => ({ ok: true, message: "triggered" }),
      },
      healthMonitor: {
        runChecks: async () => [],
      },
      router: {
        send: async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" }),
        pollInbox: () => [],
      },
    })

    const status = await daemon.handleCommand({ kind: "daemon.status" })
    expect(status.data).toEqual({
      overview: expect.objectContaining({
        daemon: "running",
        health: "warn",
        workerCount: 1,
        senseCount: 0,
      }),
      senses: [],
      workers: [expect.objectContaining({ agent: "slugger", worker: "private-runtime", status: "crashed" })],
      sync: [],
      agents: [],
    })
  })

  it("serves socket requests and can be started twice safely", async () => {
    const socketPath = tmpSocketPath("daemon-socket-integration")
    const { daemon } = make(socketPath)

    await daemon.start()
    await daemon.start()

    const raw = await sendRaw(socketPath, "{\"kind\":\"daemon.status\"}")
    const parsed = JSON.parse(raw) as { ok: boolean; summary?: string }

    expect(parsed.ok).toBe(true)
    expect(parsed.summary).toBe("no managed agents")

    await daemon.stop()
  })

  it("drains pending inbox fallback files on daemon start", async () => {
    const socketPath = tmpSocketPath("daemon-pending-drain")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-bundles-"))
    const pendingDir = path.join(bundlesRoot, "slugger.ouro", "inbox")
    fs.mkdirSync(pendingDir, { recursive: true })
    const pendingPath = path.join(pendingDir, "pending.jsonl")
    fs.writeFileSync(
      pendingPath,
      `${JSON.stringify({
        from: "ouro-cli",
        to: "slugger",
        content: "queued while daemon was down",
        priority: "normal",
        sessionId: "session-1",
        taskRef: "task-1",
      })}\n`,
      "utf-8",
    )

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).toHaveBeenCalledWith(expect.objectContaining({
      from: "ouro-cli",
      to: "slugger",
      content: "queued while daemon was down",
      sessionId: "session-1",
      taskRef: "task-1",
    }))
    expect(fs.readFileSync(pendingPath, "utf-8")).toBe("")

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("returns unknown-command error for unsupported kinds", async () => {
    const socketPath = tmpSocketPath("daemon-unknown-command")
    const { daemon } = make(socketPath)

    const result = await daemon.handleCommand({ kind: "unknown" } as unknown as never)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unknown daemon command")
  })

  it("does not delete a socket path when stop is called before this daemon ever owned it", async () => {
    const socketPath = tmpSocketPath("daemon-stop-no-server")
    fs.writeFileSync(socketPath, "stale", "utf-8")
    const { daemon, processManager } = make(socketPath)

    await daemon.stop()
    expect(processManager.stopAll).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(socketPath)).toBe(true)
  })

  it("handles health, agent lifecycle, and cron commands", async () => {
    const socketPath = tmpSocketPath("daemon-admin-commands")
    const { daemon, processManager, scheduler, healthMonitor } = make(socketPath)
    processManager.stopAgent = vi.fn(async (_agent: string) => undefined)
    processManager.restartAgent = vi.fn(async (_agent: string) => undefined)
    processManager.listAgentSnapshots.mockReturnValue([{ name: "slugger" }])
    scheduler.listJobs.mockReturnValue([
      { id: "habit-heartbeat", schedule: "daily", lastRun: "2026-03-06T08:00:00.000Z" },
    ])

    const health = await daemon.handleCommand({ kind: "daemon.health" })
    expect(health.ok).toBe(true)
    expect(health.summary).toContain("agent-processes:ok:good")
    expect(health.data).toEqual(await healthMonitor.runChecks())

    const started = await daemon.handleCommand({ kind: "agent.start", agent: "slugger" })
    expect(started.message).toBe("started slugger")
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")

    const stopped = await daemon.handleCommand({ kind: "agent.stop", agent: "slugger" })
    expect(stopped.message).toBe("stopped slugger")
    expect(processManager.stopAgent).toHaveBeenCalledWith("slugger")

    const restarted = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger" })
    expect(restarted.message).toBe("restart requested for slugger")
    expect(processManager.restartAgent).toHaveBeenCalledWith("slugger")

    const cronList = await daemon.handleCommand({ kind: "cron.list" })
    expect(cronList.summary).toContain("habit-heartbeat")

    scheduler.listJobs.mockReturnValueOnce([
      { id: "nightly", schedule: "daily", lastRun: null },
    ])
    const neverRunCronList = await daemon.handleCommand({ kind: "cron.list" })
    expect(neverRunCronList.summary).toContain("last=never")

    scheduler.listJobs.mockReturnValueOnce([])
    const emptyCronList = await daemon.handleCommand({ kind: "cron.list" })
    expect(emptyCronList.summary).toBe("no cron jobs")

    const cronTrigger = await daemon.handleCommand({ kind: "cron.trigger", jobId: "habit-heartbeat" })
    expect(cronTrigger).toEqual({ ok: true, message: "triggered habit-heartbeat" })
  })

  it("acks agent restart before the restart work settles", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-ack")
    const { daemon, processManager } = make(socketPath)
    processManager.listAgentSnapshots.mockReturnValue([{ name: "slugger" }])
    processManager.restartAgent = vi.fn(() => new Promise<void>(() => {}))

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger" })

    expect(response).toEqual({ ok: true, message: "restart requested for slugger" })
    expect(processManager.restartAgent).toHaveBeenCalledWith("slugger")
  })

  it("skips agent restart requests for parked non-autostart workers", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-parked")
    const { daemon, processManager } = make(socketPath)
    processManager.listAgentSnapshots.mockReturnValue([{
      ...registeredSnapshot("slugger"),
      autoStart: false,
      status: "stopped",
      pid: null,
      startedAt: null,
    }])
    processManager.restartAgent = vi.fn(async () => undefined)

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger" })

    expect(response).toEqual({ ok: true, message: "restart skipped for parked non-autostart agent 'slugger'" })
    expect(processManager.restartAgent).not.toHaveBeenCalled()
  })

  it("passes skipConfigCheck to acknowledged agent restarts when requested", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-skip-config")
    const { daemon, processManager } = make(socketPath)
    processManager.listAgentSnapshots.mockReturnValue([{ name: "slugger" }])
    processManager.restartAgent = vi.fn(async () => undefined)

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger", skipConfigCheck: true })

    expect(response).toEqual({ ok: true, message: "restart requested for slugger" })
    expect(processManager.restartAgent).toHaveBeenCalledWith("slugger", { skipConfigCheck: true })
  })

  it("reports unknown agent restarts without starting async work", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-unknown")
    const { daemon, processManager } = make(socketPath)
    processManager.restartAgent = vi.fn(async () => undefined)

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "ghost" })

    expect(response).toEqual({ ok: false, error: "Unknown managed agent 'ghost'." })
    expect(processManager.restartAgent).not.toHaveBeenCalled()
  })

  it("reports when managed agent restart is unavailable", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-unavailable")
    const { daemon } = make(socketPath)

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger" })

    expect(response).toEqual({ ok: false, error: "Managed agent restart is not available." })
  })

  it("logs restart failures that happen after acknowledgement", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-late-error")
    const { daemon, processManager } = make(socketPath)
    processManager.listAgentSnapshots.mockReturnValue([{ name: "slugger" }])
    processManager.restartAgent = vi.fn(async () => {
      throw new Error("restart blew up")
    })

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger" })
    await new Promise((resolve) => setImmediate(resolve))

    expect(response).toEqual({ ok: true, message: "restart requested for slugger" })
    expect(processManager.restartAgent).toHaveBeenCalledWith("slugger")
  })

  it("logs raw restart failure values that happen after acknowledgement", async () => {
    const socketPath = tmpSocketPath("daemon-agent-restart-late-raw-error")
    const { daemon, processManager } = make(socketPath)
    processManager.listAgentSnapshots.mockReturnValue([{ name: "slugger" }])
    processManager.restartAgent = vi.fn(async () => {
      throw "restart raw failure"
    })

    const response = await daemon.handleCommand({ kind: "agent.restart", agent: "slugger" })
    await new Promise((resolve) => setImmediate(resolve))

    expect(response).toEqual({ ok: true, message: "restart requested for slugger" })
    expect(processManager.restartAgent).toHaveBeenCalledWith("slugger")
  })

  it("retains malformed pending lines and tolerates unreadable bundle roots", async () => {
    const socketPath = tmpSocketPath("daemon-pending-invalid")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-bundles-invalid-"))
    const pendingDir = path.join(bundlesRoot, "slugger.ouro", "inbox")
    fs.mkdirSync(pendingDir, { recursive: true })
    const pendingPath = path.join(pendingDir, "pending.jsonl")
    fs.writeFileSync(
      pendingPath,
      [
        "{\"from\":\"ouro-cli\",\"to\":\"slugger\",\"content\":\"valid\",\"priority\":1,\"sessionId\":2,\"taskRef\":3}",
        "{\"from\":\"ouro-cli\",\"to\":\"slugger\"}",
        "{invalid-json",
      ].join("\n") + "\n",
      "utf-8",
    )

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).toHaveBeenCalledTimes(1)
    expect(router.send).toHaveBeenCalledWith({
      from: "ouro-cli",
      to: "slugger",
      content: "valid",
      priority: undefined,
      sessionId: undefined,
      taskRef: undefined,
    })
    const retained = fs.readFileSync(pendingPath, "utf-8")
    expect(retained).toContain("{\"from\":\"ouro-cli\",\"to\":\"slugger\"}")
    expect(retained).toContain("{invalid-json")

    const unreadableRoot = path.join(os.tmpdir(), `daemon-bundles-file-${Date.now()}`)
    fs.writeFileSync(unreadableRoot, "not-a-directory", "utf-8")
    const { daemon: unreadableDaemon } = make(tmpSocketPath("daemon-unreadable-bundles"), unreadableRoot)
    await expect(unreadableDaemon.start()).resolves.toBeUndefined()
    await unreadableDaemon.stop()

    const missingRoot = path.join(os.tmpdir(), `daemon-bundles-missing-${Date.now()}`)
    const { daemon: missingRootDaemon } = make(tmpSocketPath("daemon-missing-bundles"), missingRoot)
    await expect(missingRootDaemon.start()).resolves.toBeUndefined()
    await missingRootDaemon.stop()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
    fs.rmSync(unreadableRoot, { force: true })
  })

  it("daemon routes agent.senseTurn to handleAgentSenseTurn", async () => {
    const socketPath = tmpSocketPath("daemon-sense-turn-route")
    const { daemon } = make(socketPath)

    vi.doMock("../../../senses/shared-turn", () => ({
      runSenseTurn: vi.fn().mockResolvedValue({
        response: "routed correctly",
        ponderDeferred: false,
      }),
    }))

    const result = await daemon.handleCommand({
      kind: "agent.senseTurn",
      agent: "test-agent",
      friendId: "friend-1",
      channel: "mcp",
      sessionKey: "session-abc",
      message: "hello",
    })

    expect(result.ok).toBe(true)
    expect(result.message).toBe("routed correctly")
  })

  it("handleAgentSenseTurn runs a full turn and returns response", async () => {
    vi.doMock("../../../senses/shared-turn", () => ({
      runSenseTurn: vi.fn().mockResolvedValue({
        response: "hello from agent",
        ponderDeferred: false,
      }),
    }))

    const result = await handleAgentSenseTurn({
      kind: "agent.senseTurn",
      agent: "test-agent",
      friendId: "friend-1",
      channel: "mcp",
      sessionKey: "session-abc",
      message: "hello",
    })

    expect(result.ok).toBe(true)
    expect(result.message).toBe("hello from agent")
    expect(result.data).toEqual({ ponderDeferred: false })
  })

  it("handleAgentSenseTurn forwards command.runtimeMcp into runSenseTurn as runtimeMcpServers", async () => {
    const runSenseTurn = vi.fn().mockResolvedValue({
      response: "ok",
      ponderDeferred: false,
    })
    vi.doMock("../../../senses/shared-turn", () => ({ runSenseTurn }))

    const runtimeMcp = {
      ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] },
    }
    const result = await handleAgentSenseTurn({
      kind: "agent.senseTurn",
      agent: "boss",
      friendId: "friend-1",
      channel: "mcp",
      sessionKey: "session-abc",
      message: "hello",
      runtimeMcp,
    })

    expect(result.ok).toBe(true)
    expect(runSenseTurn).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMcpServers: runtimeMcp }),
    )
  })

  it("handleAgentSenseTurn omits runtimeMcpServers when the command has no runtimeMcp", async () => {
    const runSenseTurn = vi.fn().mockResolvedValue({
      response: "ok",
      ponderDeferred: false,
    })
    vi.doMock("../../../senses/shared-turn", () => ({ runSenseTurn }))

    await handleAgentSenseTurn({
      kind: "agent.senseTurn",
      agent: "boss",
      friendId: "friend-1",
      channel: "mcp",
      sessionKey: "session-abc",
      message: "hello",
    })

    const passed = runSenseTurn.mock.calls[0]?.[0] ?? {}
    expect("runtimeMcpServers" in passed).toBe(false)
  })

  it("handleAgentSenseTurn returns error on failure", async () => {
    vi.doMock("../../../senses/shared-turn", () => ({
      runSenseTurn: vi.fn().mockRejectedValue(new Error("provider down")),
    }))

    const result = await handleAgentSenseTurn({
      kind: "agent.senseTurn",
      agent: "test-agent",
      friendId: "friend-1",
      channel: "mcp",
      sessionKey: "session-abc",
      message: "hello",
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("sense turn failed")
    expect(result.error).toContain("provider down")
  })

  it("skips non-bundle directories and bundle dirs without pending files", async () => {
    const socketPath = tmpSocketPath("daemon-skip-non-bundles")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-bundles-skip-"))
    fs.mkdirSync(path.join(bundlesRoot, "scratch"), { recursive: true })
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro", "inbox"), { recursive: true })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
