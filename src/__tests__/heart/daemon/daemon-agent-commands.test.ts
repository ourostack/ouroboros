import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"

const mockRunSenseTurn = vi.hoisted(() => vi.fn(async () => ({
  response: "full turn response",
  ponderDeferred: false,
})))

vi.mock("../../../senses/shared-turn", () => ({
  runSenseTurn: (...args: any[]) => mockRunSenseTurn(...args),
}))

import { OuroDaemon } from "../../../heart/daemon/daemon"

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

describe("daemon agent service command routing", () => {
  let originalHome: string | undefined
  let testHomeRoot: string

  beforeEach(() => {
    originalHome = process.env.HOME
    testHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-agent-commands-home-"))
    process.env.HOME = testHomeRoot
    mockRunSenseTurn.mockClear()
    mockRunSenseTurn.mockResolvedValue({
      response: "full turn response",
      ponderDeferred: false,
    })
  })

  const make = (socketPath: string, options?: { privatePolicyResult?: "allow" | "deny"; bundlesRoot?: string }) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0
    const habitProcessIdentitySource = {
      readBootId: vi.fn(() => "boot-test"),
      readProcess: vi.fn((pid: number) => ({
        uid,
        pid,
        startIdentity: `test-process:${pid}`,
        executableRealpath: path.resolve(process.execPath),
      })),
    }
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
      requestFromAgent: vi.fn(async (_agent: string, message: Record<string, unknown>) => {
        const request = message.executionRequest as Record<string, unknown>
        return {
          schemaVersion: 1,
          occurrenceId: request.occurrenceId,
          attemptId: request.attemptId,
          responseCapability: request.responseCapability,
          outcome: {
            version: 1,
            disposition: "settled",
            result: { version: 1, status: "completed", resultRef: "arc/habit-receipt.json" },
          },
        }
      }),
    }

    const scheduler = {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
      reconcile: vi.fn(async () => undefined),
    }

    const healthMonitor = {
      runChecks: vi.fn(async () => [{ name: "agent-processes", status: "ok" as const, message: "good" }]),
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
    const mailboxServerFactory = vi.fn(async () => ({
      origin: "http://127.0.0.1:0",
      stop: vi.fn(async () => undefined),
    }))

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      senseManager,
      bundlesRoot: options?.bundlesRoot,
      mailboxServerFactory,
      mode: "dev",
      privateRuntimePolicyDeps: {
        ledgerPath: path.join(os.tmpdir(), `agent-command-private-decisions-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`),
        now: () => "2026-07-03T00:00:00.000Z",
        resolveProviderLane: vi.fn(() => ({
          lane: "inner",
          provider: "minimax",
          model: "minimax-text-01",
          source: "agent.json",
        })),
        evaluatePolicy: vi.fn(() => options?.privatePolicyResult === "allow"
          ? {
              result: "allow",
              reason: "test policy allow",
            }
          : {
              result: "deny",
              reason: "private runtime policy denies by default",
              deniedReason: "default policy deny",
            }),
      },
      habitProcessIdentitySource,
      habitBarrierStorePath: `${socketPath}.activation-barriers.json`,
      habitMachineTimezone: "UTC",
      habitNow: () => "2026-07-23T10:00:00.000Z",
    } as any)
    return { daemon, processManager, scheduler }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(testHomeRoot, { recursive: true, force: true })
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
  })

  it("routes agent.status command through to agent service", async () => {
    const socketPath = tmpSocketPath("agent-status")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing agent.status routing",
      meta: {},
    })

    const raw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.status",
      agent: "test-agent",
      friendId: "friend-1",
    }))
    const response = JSON.parse(raw)
    expect(response.ok).toBe(true)
    expect(response.data.agent).toBe("test-agent")

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "agent.status routing test complete",
      meta: {},
    })
  })

  it("routes agent.ask command through a full sense turn", async () => {
    const socketPath = tmpSocketPath("agent-ask")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing agent.ask routing",
      meta: {},
    })

    const raw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.ask",
      agent: "test-agent",
      friendId: "friend-1",
      question: "What is the project about?",
    }))
    const response = JSON.parse(raw)
    expect(response.ok).toBe(true)
    expect(response.ok).toBe(true)
    expect(response.message).toBe("full turn response")
    expect(mockRunSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "test-agent",
      channel: "mcp",
      friendId: "friend-1",
      sessionKey: "agent-ask:friend-1",
      userMessage: "What is the project about?",
    }))

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "agent.ask routing test complete",
      meta: {},
    })
  })

  it("routes agent.delegate command and validates params", async () => {
    const socketPath = tmpSocketPath("agent-delegate")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing agent.delegate routing",
      meta: {},
    })

    // Missing task should fail
    const failRaw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.delegate",
      agent: "test-agent",
      friendId: "friend-1",
    }))
    const failResponse = JSON.parse(failRaw)
    expect(failResponse.ok).toBe(false)
    expect(failResponse.error).toContain("task")

    // With task should succeed
    const successRaw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.delegate",
      agent: "test-agent",
      friendId: "friend-1",
      task: "Fix the build",
    }))
    const successResponse = JSON.parse(successRaw)
    expect(successResponse.ok).toBe(true)

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "agent.delegate routing test complete",
      meta: {},
    })
  })

  it("routes all 13 agent command kinds", async () => {
    const socketPath = tmpSocketPath("agent-all-commands")
    const bundlesRoot = fs.mkdtempSync(path.join(testHomeRoot, "agent-all-commands-bundles-"))
    const habitsDir = path.join(bundlesRoot, "a.ouro", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(path.join(habitsDir, "heartbeat.md"), "---\ntitle: heartbeat\n---\n\nRun the habit.\n", "utf8")
    const { daemon, processManager } = make(socketPath, { privatePolicyResult: "allow", bundlesRoot })
    processManager.listAgentSnapshots.mockReturnValue([{
      name: "a",
      channel: "private-runtime",
      status: "running",
      pid: 1234,
      restartCount: 0,
      startedAt: "2026-07-03T00:00:00.000Z",
      lastCrashAt: null,
      backoffMs: 0,
    }])
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing all agent command routing",
      meta: {},
    })

    const commands = [
      { kind: "agent.ask", agent: "a", friendId: "f", question: "q" },
      { kind: "agent.status", agent: "a", friendId: "f" },
      { kind: "agent.catchup", agent: "a", friendId: "f" },
      { kind: "agent.delegate", agent: "a", friendId: "f", task: "t" },
      { kind: "agent.getContext", agent: "a", friendId: "f" },
      { kind: "agent.searchFacts", agent: "a", friendId: "f", query: "q" },
      { kind: "agent.getTask", agent: "a", friendId: "f" },
      { kind: "agent.checkScope", agent: "a", friendId: "f", item: "i" },
      { kind: "agent.requestDecision", agent: "a", friendId: "f", topic: "t" },
      { kind: "agent.checkGuidance", agent: "a", friendId: "f", topic: "t" },
      { kind: "agent.reportProgress", agent: "a", friendId: "f", summary: "s" },
      { kind: "agent.reportBlocker", agent: "a", friendId: "f", blocker: "b" },
      { kind: "agent.reportComplete", agent: "a", friendId: "f", summary: "s" },
      { kind: "habit.poke", agent: "a", habitName: "heartbeat" },
      { kind: "await.poke", agent: "a", awaitName: "hey_export" },
    ]

    for (const command of commands) {
      const raw = await sendRaw(socketPath, JSON.stringify(command))
      const response = JSON.parse(raw)
      expect(response.ok).toBe(true)
    }

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "all agent command routing test complete",
      meta: {},
    })
  })

  it("preserves explicit habit trigger provenance on daemon habit pokes", async () => {
    const socketPath = tmpSocketPath("agent-habit-poke-trigger")
    const bundlesRoot = fs.mkdtempSync(path.join(testHomeRoot, "agent-habit-poke-bundles-"))
    fs.mkdirSync(path.join(bundlesRoot, "a.ouro", "habits"), { recursive: true })
    fs.writeFileSync(
      path.join(bundlesRoot, "a.ouro", "habits", "heartbeat.md"),
      [
        "---",
        "title: heartbeat",
        "cadence: 30m",
        "status: active",
        "lastRun: 2026-07-03T23:30:00.000Z",
        "---",
        "",
        "Run the habit.",
      ].join("\n"),
      "utf-8",
    )
    const { daemon, processManager } = make(socketPath, {
      privatePolicyResult: "allow",
      bundlesRoot,
    })
    processManager.listAgentSnapshots.mockReturnValue([{
      name: "a",
      channel: "private-runtime",
      status: "running",
      pid: 1234,
      restartCount: 0,
      startedAt: "2026-07-03T00:00:00.000Z",
      lastCrashAt: null,
      backoffMs: 0,
    }])
    await daemon.start()
    try {
      const raw = await sendRaw(socketPath, JSON.stringify({
        kind: "habit.poke",
        agent: "a",
        habitName: "heartbeat",
        trigger: "launchd",
      }))
      const response = JSON.parse(raw)
      expect(response.ok).toBe(true)
      expect(processManager.requestFromAgent).toHaveBeenCalledWith(
        "a",
        expect.objectContaining({
          type: "habit",
          habitName: "heartbeat",
          trigger: "launchd",
          privateTurnDecision: expect.objectContaining({
            result: "allow",
            triggerSource: "habit-launchd",
          }),
          executionRequest: expect.objectContaining({
            habitId: "heartbeat",
          }),
        }),
        expect.any(Object),
      )
      const [, sent, options] = processManager.requestFromAgent.mock.calls[0]
      const executionRequest = sent.executionRequest as {
        occurrenceId: string
        attemptId: string
        responseCapability: string
      }
      const candidate = {
        schemaVersion: 1,
        occurrenceId: executionRequest.occurrenceId,
        attemptId: executionRequest.attemptId,
        responseCapability: executionRequest.responseCapability,
        outcome: {
          version: 1,
          disposition: "settled",
          result: { version: 1, status: "completed", resultRef: "receipt:a" },
        },
      }
      const classified = options.classify(candidate)
      expect(classified).toMatchObject({ kind: "candidate", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
      expect(options.classify(null)).toEqual({ kind: "ignore" })
      expect(options.classify({ ...candidate, occurrenceId: "other" })).toEqual({ kind: "ignore" })
      expect(options.classify({ ...candidate, attemptId: "other" })).toEqual({ kind: "ignore" })
      expect(options.classify({ ...candidate, responseCapability: "other" })).toEqual({ kind: "ignore" })
      expect(options.classify({
        schemaVersion: 1,
        kind: "agent-turn-response-seal",
        occurrenceId: executionRequest.occurrenceId,
        attemptId: executionRequest.attemptId,
        responseCapability: executionRequest.responseCapability,
        responseSha256: classified.fingerprint,
      })).toEqual({ kind: "commit", fingerprint: classified.fingerprint })
      expect(options.classify({
        schemaVersion: 1,
        kind: "agent-turn-response-seal",
        occurrenceId: executionRequest.occurrenceId,
        attemptId: executionRequest.attemptId,
        responseCapability: executionRequest.responseCapability,
      })).toEqual({ kind: "commit", fingerprint: "" })
    } finally {
      await daemon.stop()
    }
  })

  it("rejects invalid daemon habit poke trigger provenance", async () => {
    const socketPath = tmpSocketPath("agent-habit-poke-invalid-trigger")
    const { daemon, processManager } = make(socketPath)
    await daemon.start()
    try {
      const raw = await sendRaw(socketPath, JSON.stringify({
        kind: "habit.poke",
        agent: "a",
        habitName: "heartbeat",
        trigger: "banana",
      }))
      const response = JSON.parse(raw)
      expect(response).toEqual({
        ok: false,
        error: "invalid habit trigger: banana",
      })
      expect(processManager.sendToAgent).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })

  it("routes daemon cron.trigger habit jobs as cron before falling back to task scheduler", async () => {
    const socketPath = tmpSocketPath("agent-habit-cron-trigger")
    const { daemon, processManager, scheduler } = make(socketPath)
    const triggerHabitJob = vi.fn(async (jobId: string) => {
      return { ok: true, message: `triggered habit ${jobId}` }
    })
    ;(scheduler as typeof scheduler & { triggerHabitJob: typeof triggerHabitJob }).triggerHabitJob = triggerHabitJob
    await daemon.start()
    try {
      const raw = await sendRaw(socketPath, JSON.stringify({
        kind: "cron.trigger",
        jobId: "a:heartbeat:cadence",
      }))
      const response = JSON.parse(raw)
      expect(response).toMatchObject({ ok: true, message: "triggered habit a:heartbeat:cadence" })
      expect(triggerHabitJob).toHaveBeenCalledWith("a:heartbeat:cadence")
      expect(scheduler.triggerJob).not.toHaveBeenCalled()
      expect(processManager.sendToAgent).not.toHaveBeenCalledWith("a", expect.objectContaining({ type: "habit" }))
    } finally {
      await daemon.stop()
    }
  })
})
