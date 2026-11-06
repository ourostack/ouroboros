import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"

import { OuroDaemon, handleAgentSenseTurn } from "../../../heart/daemon/daemon"

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
    options?: { onStopCommandComplete?: () => void },
  ) => {
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
    }

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      bundlesRoot,
      senseManager,
      mailboxServerFactory: vi.fn(async () => ({
        url: "http://127.0.0.1:6876",
        stop: async () => undefined,
      })),
      onStopCommandComplete: options?.onStopCommandComplete,
    } as any)
    return { daemon, processManager, scheduler, healthMonitor, router, senseManager }
  }

  afterEach(() => {
    vi.restoreAllMocks()
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
      channel: "inner-dialog",
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
      channel: "inner-dialog",
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
        channel: "inner-dialog",
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
          worker: "inner-dialog",
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

  it("includes provider rows in status when bundle agents exist", async () => {
    const socketPath = tmpSocketPath("daemon-status-providers")
    const isolatedBundles = path.join(os.tmpdir(), `daemon-status-provider-bundles-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const agentRoot = path.join(isolatedBundles, "slugger.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({ enabled: true })}\n`, "utf-8")
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
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", { type: "poke", taskId: "habit-heartbeat" })

    const hatch = await daemon.handleCommand({ kind: "hatch.start" })
    expect(hatch.ok).toBe(true)
    expect(hatch.message).toContain("Gate 6")
  })

  it("starts the managed agent and wakes inner dialog via direct IPC", async () => {
    const socketPath = tmpSocketPath("daemon-inner-wake")
    const { daemon, processManager } = make(socketPath)

    const wake = await daemon.handleCommand({ kind: "inner.wake", agent: "slugger" } as unknown as never)

    expect(wake).toEqual({ ok: true, message: "woke inner dialog for slugger" })
    expect(processManager.startAgent).toHaveBeenCalledWith("slugger")
    expect(processManager.sendToAgent).toHaveBeenCalledWith("slugger", { type: "message" })
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
            channel: "inner-dialog",
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
      workers: [expect.objectContaining({ agent: "slugger", worker: "inner-dialog", status: "crashed" })],
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
    expect(restarted.message).toBe("restarted slugger")
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
    fs.mkdirSync(path.join(bundlesRoot, "notes"), { recursive: true })
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro", "inbox"), { recursive: true })

    const { daemon, router } = make(socketPath, bundlesRoot)
    await daemon.start()
    await daemon.stop()

    expect(router.send).not.toHaveBeenCalled()

    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })
})
