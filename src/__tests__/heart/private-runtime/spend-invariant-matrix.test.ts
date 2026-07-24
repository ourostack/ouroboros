import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const refreshProviderCredentialPoolMock = vi.hoisted(() => vi.fn())
const unexpectedProviderPingMock = vi.hoisted(() => vi.fn(async () => {
  throw new Error("unexpected provider readiness ping in spend-invariant matrix")
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: (...args: unknown[]) => refreshProviderCredentialPoolMock(...args),
  }
})

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: (...args: unknown[]) => unexpectedProviderPingMock(...args),
}))

import { OuroDaemon, type DaemonCommand } from "../../../heart/daemon/daemon"
import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"
import { readPrivateTurnLedger } from "../../../heart/private-runtime"
import type { PrivateTurnDecision, PrivateTurnPolicyDeps } from "../../../heart/private-runtime"

type WakeCommand = Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" | "habit.poke" | "await.poke" | "task.poke" }>

type Harness = ReturnType<typeof makeHarness>

interface MatrixRow {
  name: string
  setup?: (harness: Harness) => void
  command: (harness: Harness) => WakeCommand
  expectedWorkerType: "message" | "habit" | "await" | "poke"
}

const AGENT = "slugger"
const NOW = "2026-07-04T12:00:00.000Z"

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  refreshProviderCredentialPoolMock.mockReset()
  unexpectedProviderPingMock.mockClear()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeAgentBundle(bundlesRoot: string): void {
  const agentRoot = path.join(bundlesRoot, `${AGENT}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.5" },
    senses: {},
  }, null, 2), "utf-8")
}

function providerRecord(provider: "openai-codex" | "minimax") {
  return {
    provider,
    revision: `cred_${provider}`,
    updatedAt: NOW,
    credentials: provider === "openai-codex"
      ? { apiKey: "codex-test-key" }
      : { apiKey: "minimax-test-key" },
    config: provider === "openai-codex"
      ? { baseUrl: "https://codex.example.invalid" }
      : {},
    provenance: { source: "manual", updatedAt: NOW },
  }
}

function credentialPool() {
  return {
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: NOW,
      providers: {
        "openai-codex": providerRecord("openai-codex"),
        minimax: providerRecord("minimax"),
      },
    },
  }
}

function writeHabitFile(bundlesRoot: string, habitName: string): void {
  const habitDir = path.join(bundlesRoot, `${AGENT}.ouro`, "habits")
  fs.mkdirSync(habitDir, { recursive: true })
  fs.writeFileSync(path.join(habitDir, `${habitName}.md`), [
    "---",
    `title: ${habitName}`,
    "cadence: 30m",
    "status: active",
    "lastRun: 2026-07-04T11:30:00.000Z",
    "---",
    "",
    "Check what needs attention.",
  ].join("\n"), "utf-8")
}

function readLedgerRows(ledgerPath: string): PrivateTurnDecision[] {
  if (!fs.existsSync(ledgerPath)) return []
  return readPrivateTurnLedger(ledgerPath)
}

function registeredPrivateRuntimeSnapshot() {
  return {
    name: AGENT,
    channel: "private-runtime",
    status: "running",
    pid: 1234,
    restartCount: 0,
    startedAt: NOW,
    lastCrashAt: null,
    backoffMs: 0,
    lastExitCode: null,
    lastSignal: null,
    errorReason: null,
    fixHint: null,
  }
}

function makeHarness(policyResult: "allow" | "deny") {
  const root = tempRoot("ouro-spend-matrix-")
  const bundlesRoot = path.join(root, "AgentBundles")
  const ledgerPath = path.join(root, "decisions.jsonl")
  const socketPath = path.join(root, "daemon.sock")
  writeAgentBundle(bundlesRoot)

  const counters = {
    providerPings: 0,
    modelTurns: 0,
  }
  const workerMessages: Array<Record<string, unknown>> = []
  const processManager = {
    listAgentSnapshots: vi.fn(() => [registeredPrivateRuntimeSnapshot()]),
    startAutoStartAgents: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    resetAgentFailureState: vi.fn(),
    sendToAgent: vi.fn((_agent: string, message: Record<string, unknown>) => {
      workerMessages.push(message)
      const decision = message.privateTurnDecision as PrivateTurnDecision | undefined
      if (decision?.executable) counters.modelTurns += 1
    }),
    requestFromAgent: vi.fn(async (_agent: string, message: Record<string, unknown>) => {
      workerMessages.push(message)
      const decision = message.privateTurnDecision as PrivateTurnDecision | undefined
      if (decision?.executable) counters.modelTurns += 1
      const request = message.executionRequest as {
        occurrenceId: string
        attemptId: string
        responseCapability: string
      }
      return {
        schemaVersion: 1,
        occurrenceId: request.occurrenceId,
        attemptId: request.attemptId,
        responseCapability: request.responseCapability,
        outcome: {
          version: 1,
          disposition: "settled",
          result: { version: 1, status: "completed", resultRef: "habit-run:test" },
        },
      }
    }),
  }
  let receiptCounter = 0
  const router = {
    send: vi.fn(async () => {
      receiptCounter += 1
      return { id: `receipt-${receiptCounter}`, queuedAt: NOW }
    }),
    pollInbox: vi.fn(() => []),
  }
  const scheduler = {
    listJobs: vi.fn(() => []),
    triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
    reconcile: vi.fn(async () => undefined),
    recordTaskRun: vi.fn(async () => undefined),
  }
  const healthMonitor = {
    runChecks: vi.fn(async () => []),
    getLastResults: vi.fn(() => []),
    stopPeriodicChecks: vi.fn(),
  }
  const privateRuntimePolicyDeps: PrivateTurnPolicyDeps & {
  } = {
    ledgerPath,
    now: () => NOW,
    resolveProviderLane: vi.fn(() => ({
      lane: "inner",
      provider: "openai-codex",
      model: "gpt-5.5",
      source: "agent.json",
      credentialRevision: "test-rev",
    })),
    evaluatePolicy: vi.fn(() => policyResult === "allow"
      ? { result: "allow", reason: "matrix policy allow" }
      : { result: "deny", reason: "private runtime policy denies by default", deniedReason: "default policy deny" }),
  }
  const daemon = new OuroDaemon({
    socketPath,
    processManager,
    scheduler,
    healthMonitor,
    router,
    bundlesRoot,
    privateRuntimePolicyDeps,
    mailboxServerFactory: vi.fn(async () => ({
      url: "http://127.0.0.1:6876",
      stop: async () => undefined,
    })),
  } as any)

  return {
    root,
    bundlesRoot,
    ledgerPath,
    daemon,
    counters,
    processManager,
    router,
    scheduler,
    privateRuntimePolicyDeps,
    workerMessages,
  }
}

function privateWake(
  id: string,
  input: {
    reason: string
    triggerSource: string
    budgetClass?: string
    originRefs: Array<{ kind: string; id: string }>
  },
): Extract<DaemonCommand, { kind: "private.wake" }> {
  return {
    kind: "private.wake",
    agent: AGENT,
    reason: input.reason,
    triggerSource: input.triggerSource,
    budgetClass: input.budgetClass ?? "interactive",
    idempotencyKey: `matrix:${id}`,
    originRefs: input.originRefs,
  }
}

const WAKE_ROWS: MatrixRow[] = [
  {
    name: "manual private wake",
    command: () => privateWake("manual", {
      reason: "manual private-runtime wake",
      triggerSource: "manual",
      originRefs: [{ kind: "daemon-command", id: "private.wake" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "legacy private wake alias",
    command: () => ({ kind: "inner.wake", agent: AGENT }),
    expectedWorkerType: "message",
  },
  {
    name: "CLI lifecycle wake",
    command: () => privateWake("cli-lifecycle", {
      reason: "CLI lifecycle delivery should wake private runtime",
      triggerSource: "cli-lifecycle",
      originRefs: [{ kind: "cli-command", id: "ouro msg" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "dev-tool session-start wake",
    command: () => privateWake("dev-session-start", {
      reason: "dev-tool session-start hook",
      triggerSource: "dev-tool-session-start",
      budgetClass: "scheduled",
      originRefs: [{ kind: "dev-tool-hook", id: "session-start" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "dev-tool session-stop wake",
    command: () => privateWake("dev-session-stop", {
      reason: "dev-tool stop hook",
      triggerSource: "dev-tool-stop",
      budgetClass: "scheduled",
      originRefs: [{ kind: "dev-tool-hook", id: "stop" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "manual habit poke",
    setup: (harness) => writeHabitFile(harness.bundlesRoot, "heartbeat"),
    command: () => ({ kind: "habit.poke", agent: AGENT, habitName: "heartbeat", trigger: "manual" }),
    expectedWorkerType: "habit",
  },
  {
    name: "launchd habit poke",
    setup: (harness) => writeHabitFile(harness.bundlesRoot, "heartbeat"),
    command: () => ({ kind: "habit.poke", agent: AGENT, habitName: "heartbeat", trigger: "launchd" }),
    expectedWorkerType: "habit",
  },
  {
    name: "overdue habit catch-up",
    setup: (harness) => writeHabitFile(harness.bundlesRoot, "heartbeat"),
    command: () => ({ kind: "habit.poke", agent: AGENT, habitName: "heartbeat", trigger: "overdue" }),
    expectedWorkerType: "habit",
  },
  {
    name: "await condition poke",
    command: () => ({ kind: "await.poke", agent: AGENT, awaitName: "package-release" }),
    expectedWorkerType: "await",
  },
  {
    name: "await expiry alert",
    command: () => privateWake("await-expiry", {
      reason: "await package-release expired",
      triggerSource: "await-expiry",
      budgetClass: "scheduled",
      originRefs: [{ kind: "await", id: "package-release" }],
    }),
    expectedWorkerType: "await",
  },
  {
    name: "pulse alert",
    command: () => privateWake("pulse-alert", {
      reason: "pulse recovered after outage",
      triggerSource: "pulse-alert",
      budgetClass: "scheduled",
      originRefs: [{ kind: "pulse", id: "daemon-health" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "self-route fallback",
    command: () => privateWake("self-route", {
      reason: "self-route private attention requested",
      triggerSource: "self-route",
      originRefs: [{ kind: "friend", id: "self" }, { kind: "session", id: "self/inner/dialog" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "ponder return obligation",
    command: () => privateWake("ponder-return", {
      reason: "ponder return obligation ready",
      triggerSource: "ponder-return",
      originRefs: [{ kind: "ponder-packet", id: "pkt-1" }, { kind: "return-obligation", id: "ret-1" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "mail discovery",
    command: () => privateWake("mail-discovery", {
      reason: "mail import discovered messages",
      triggerSource: "mail-import-discovery",
      budgetClass: "scheduled",
      originRefs: [{ kind: "mail-import", id: "mbox-1" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "background mail operation completion",
    command: () => privateWake("mail-operation", {
      reason: "mail backfill completed",
      triggerSource: "mail-operation-complete",
      budgetClass: "scheduled",
      originRefs: [{ kind: "mail-operation", id: "backfill-indexes" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "coding feedback obligation",
    command: () => privateWake("coding-feedback", {
      reason: "coding feedback received",
      triggerSource: "coding-feedback",
      originRefs: [{ kind: "coding-obligation", id: "obl-1" }, { kind: "coding-session", id: "sess-1" }],
    }),
    expectedWorkerType: "message",
  },
  {
    name: "task poke",
    command: () => ({ kind: "task.poke", agent: AGENT, taskId: "tasks/private-runtime-v1.md" }),
    expectedWorkerType: "poke",
  },
]

describe("private-runtime spend-invariant matrix", () => {
  it.each(WAKE_ROWS)("denies $name without provider ping or model turn", async (row) => {
    const harness = makeHarness("deny")
    row.setup?.(harness)

    await harness.daemon.handleCommand(row.command(harness))

    const ledger = readLedgerRows(harness.ledgerPath)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      agent: AGENT,
      result: "deny",
      executable: false,
      deniedReason: "default policy deny",
    })
    expect(harness.counters.providerPings).toBe(0)
    expect(harness.counters.modelTurns).toBe(0)
    expect(harness.processManager.startAgent).not.toHaveBeenCalled()
    expect(harness.processManager.sendToAgent).not.toHaveBeenCalled()
    expect(harness.processManager.requestFromAgent).not.toHaveBeenCalled()
  })

  it.each(WAKE_ROWS)("allows $name with exactly one decision and one model turn", async (row) => {
    const harness = makeHarness("allow")
    row.setup?.(harness)

    await harness.daemon.handleCommand(row.command(harness))

    const ledger = readLedgerRows(harness.ledgerPath)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      agent: AGENT,
      result: "allow",
      executable: true,
      providerLane: expect.objectContaining({
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    })
    expect(harness.counters.providerPings).toBe(0)
    expect(harness.counters.modelTurns).toBe(1)
    expect(harness.processManager.startAgent).toHaveBeenCalledTimes(1)
    if (row.expectedWorkerType === "habit") {
      expect(harness.processManager.requestFromAgent).toHaveBeenCalledTimes(1)
      expect(harness.processManager.sendToAgent).not.toHaveBeenCalled()
    } else {
      expect(harness.processManager.sendToAgent).toHaveBeenCalledTimes(1)
      expect(harness.processManager.requestFromAgent).not.toHaveBeenCalled()
    }
    expect(harness.workerMessages[0]).toMatchObject({
      type: row.expectedWorkerType,
      privateTurnDecision: expect.objectContaining({
        receiptId: ledger[0].receiptId,
        requestFingerprint: ledger[0].requestFingerprint,
      }),
    })
  })

  it("keeps passive daemon commands and message storms queue-only", async () => {
    const harness = makeHarness("allow")

    await harness.daemon.handleCommand({ kind: "daemon.status" })
    await harness.daemon.handleCommand({ kind: "message.send", from: "claude-code", to: AGENT, content: "session-start note" })
    for (let index = 0; index < 5; index += 1) {
      await harness.daemon.handleCommand({ kind: "message.send", from: "claude-code:post-tool-use", to: AGENT, content: `tool event ${index}` })
    }
    await harness.daemon.handleCommand({ kind: "message.poll", agent: AGENT })

    expect(readLedgerRows(harness.ledgerPath)).toHaveLength(0)
    expect(harness.privateRuntimePolicyDeps.resolveProviderLane).not.toHaveBeenCalled()
    expect(harness.privateRuntimePolicyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(harness.counters.providerPings).toBe(0)
    expect(unexpectedProviderPingMock).not.toHaveBeenCalled()
    expect(harness.counters.modelTurns).toBe(0)
    expect(harness.processManager.startAgent).not.toHaveBeenCalled()
    expect(harness.processManager.sendToAgent).not.toHaveBeenCalled()
    expect(harness.router.send).toHaveBeenCalledTimes(6)
  })

  it("keeps daemon start and restart passive with zero private-turn decisions", async () => {
    const harness = makeHarness("allow")

    try {
      await harness.daemon.handleCommand({ kind: "daemon.start" })
      expect(fs.existsSync(path.join(harness.root, "daemon.sock"))).toBe(true)
      await harness.daemon.handleCommand({ kind: "daemon.restart", reason: "test restart", requestedBy: "matrix" })
      expect(fs.existsSync(path.join(harness.root, "daemon.sock"))).toBe(false)
    } finally {
      await harness.daemon.stop()
    }

    expect(readLedgerRows(harness.ledgerPath)).toHaveLength(0)
    expect(harness.privateRuntimePolicyDeps.resolveProviderLane).not.toHaveBeenCalled()
    expect(harness.privateRuntimePolicyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(harness.counters.providerPings).toBe(0)
    expect(unexpectedProviderPingMock).not.toHaveBeenCalled()
    expect(harness.counters.modelTurns).toBe(0)
    expect(harness.processManager.sendToAgent).not.toHaveBeenCalled()
  })

  it("collapses duplicate private wakes and rejects same-key different-fingerprint attempts", async () => {
    const harness = makeHarness("allow")
    const first = privateWake("duplicate", {
      reason: "same private wake",
      triggerSource: "manual",
      originRefs: [{ kind: "daemon-command", id: "private.wake" }],
    })

    await harness.daemon.handleCommand(first)
    await harness.daemon.handleCommand(first)
    await Promise.all([
      harness.daemon.handleCommand(first),
      harness.daemon.handleCommand(first),
    ])
    await harness.daemon.handleCommand({
      ...first,
      reason: "same key but different fingerprint",
      originRefs: [{ kind: "daemon-command", id: "private.wake" }, { kind: "task", id: "different" }],
    })

    const ledger = readLedgerRows(harness.ledgerPath)
    expect(ledger).toHaveLength(2)
    expect(ledger[0]).toMatchObject({ result: "allow", executable: true })
    expect(ledger[1]).toMatchObject({
      result: "deny",
      executable: false,
      deniedReason: "idempotency-key fingerprint mismatch",
      duplicateOf: ledger[0].receiptId,
    })
    expect(harness.counters.providerPings).toBe(0)
    expect(harness.counters.modelTurns).toBe(1)
    expect(harness.processManager.startAgent).toHaveBeenCalledTimes(1)
    expect(harness.processManager.sendToAgent).toHaveBeenCalledTimes(1)
  })

  it("keeps explicit provider-readiness pings separate from private-turn execution", async () => {
    const harness = makeHarness("allow")
    refreshProviderCredentialPoolMock.mockResolvedValueOnce(credentialPool())
    const pingProvider = vi.fn(async () => {
      harness.counters.providerPings += 1
      return { ok: true } as const
    })

    await expect(checkAgentConfigWithProviderHealth(AGENT, harness.bundlesRoot, {
      pingProvider,
      recordReadiness: false,
    })).resolves.toEqual({ ok: true })

    expect(readLedgerRows(harness.ledgerPath)).toHaveLength(0)
    expect(harness.privateRuntimePolicyDeps.resolveProviderLane).not.toHaveBeenCalled()
    expect(harness.privateRuntimePolicyDeps.evaluatePolicy).not.toHaveBeenCalled()
    expect(refreshProviderCredentialPoolMock).toHaveBeenCalledWith(AGENT, expect.objectContaining({
      providers: ["minimax", "openai-codex"],
      preserveCachedOnFailure: true,
    }))
    expect(pingProvider).toHaveBeenCalledTimes(2)
    expect(unexpectedProviderPingMock).not.toHaveBeenCalled()
    expect(harness.counters.providerPings).toBe(2)
    expect(harness.counters.modelTurns).toBe(0)
    expect(harness.processManager.startAgent).not.toHaveBeenCalled()
    expect(harness.processManager.sendToAgent).not.toHaveBeenCalled()
  })
})
