import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createServer } from "node:net"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { openApprovalStore } from "../../../heart/approval-store"
import { writeSanctuaryAcceptanceMarker } from "../../../heart/daemon/sanctuary-acceptance-marker"
import { createTelegramAuditLedger } from "../../../senses/telegram-audit-ledger"
import { sanctuaryTelegramApprovalEvidenceMac, sanctuaryTelegramTurnReceiptDigest, sanctuaryTelegramUnauthorizedDropMac } from "../../../senses/telegram"
import { sanctuarySchedulerLivenessReceiptMac } from "../../../heart/daemon/sanctuary-scheduler-liveness"

const boundary = vi.hoisted(() => ({
  controlOutput: "",
  mode: "success" as "success" | "bad-outcome" | "duplicate-control" | "invalid-control" | "ungrounded",
  sourceIdentityDigest: "9".repeat(64),
  agentRoot: "/tmp/sanctuary-adapter-boundary-unset",
  machineRuntime: { ok: false, reason: "missing", itemPath: "vault:missing", error: "missing" } as Record<string, unknown>,
}))

vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => boundary.agentRoot }))

vi.mock("../../../heart/runtime-credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/runtime-credentials")>(),
  readMachineRuntimeCredentialConfig: () => boundary.machineRuntime,
}))

vi.mock("../../../senses/telegram", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../senses/telegram")>(),
  loadTelegramSenseCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
}))

vi.mock("../../../heart/provider-credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/provider-credentials")>(),
  readProviderCredentialRecord: async () => ({ ok: false }),
}))

vi.mock("../../../heart/provider-ping", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/provider-ping")>(),
  pingProvider: async () => ({ ok: false, attempts: [] }),
}))

vi.mock("../../../senses/sanctuary-runtime", () => ({
  createSanctuaryToolContext: () => ({ sanctuary: {
    getSystem: async () => boundary.mode === "ungrounded" ? ({ ok: false, error: { code: "DOWN", message: "down" } }) : ({ ok: true, data: { sourceIdentityDigest: boundary.sourceIdentityDigest, serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", uptimeSeconds: 10, degraded: false } }),
    getStorage: async () => ({ ok: true, data: { sourceIdentityDigest: boundary.sourceIdentityDigest, array: { state: "STARTED", usedBytes: 8, freeBytes: 2, usedPercent: 80, degraded: false }, shares: [], truncated: false } }),
  } }),
  runWithSanctuaryToolReceiptCollection: async (operation: () => Promise<unknown>) => ({
    result: await operation(),
    toolResultDigests: boundary.controlOutput ? [createHash("sha256").update(boundary.controlOutput).digest("hex")] : [],
  }),
}))

vi.mock("../../../heart/core", () => ({
  runAgent: async (_messages: unknown, _callbacks: unknown, _channel: unknown, _signal: unknown, options: any) => {
    for (const callback of Object.values(_callbacks as Record<string, (...args: unknown[]) => unknown>)) callback("synthetic", "synthetic")
    const runtime = options.providerRuntimeOverride
    const excluded = ["shell", "read_file", "edit_file", "vault_get", "mcp_call", "exec", "credential_get"]
    for (const name of excluded) options.toolBoundaryObserver({ name, reason: "not_in_profile", invoked: false, sideEffect: false })
    const system = await options.toolContext.sanctuary.getSystem()
    boundary.controlOutput = JSON.stringify(boundary.mode === "invalid-control" ? { ok: true, data: { sourceIdentityDigest: "bad" } } : system)
    runtime.appendToolOutput("synthetic-non-control", "ignored")
    runtime.appendToolOutput("sanctuary-valid-system", boundary.controlOutput)
    options.toolBoundaryObserver({ name: "unraid_get_system", reason: "dispatched", invoked: true, sideEffect: false })
    if (boundary.mode === "duplicate-control") options.toolBoundaryObserver({ name: "unraid_get_system", reason: "dispatched", invoked: true, sideEffect: false })
    options.toolBoundaryObserver({ name: "settle", reason: "dispatched", invoked: true, sideEffect: false })
    await runtime.streamTurn()
    await runtime.streamTurn()
    await runtime.streamTurn()
    await runtime.streamTurn().catch(() => undefined)
    runtime.resetTurnState()
    await runtime.ping()
    runtime.classifyError(new Error("synthetic"))
    await options.toolContext.signin()
    return { outcome: boundary.mode === "bad-outcome" ? "failed" : "settled" }
  },
}))

import {
  createSanctuaryAcceptanceAdapterDependencies,
  createSanctuaryAcceptanceScenarioFinalizer,
  createSanctuaryHealthAcceptanceScenarioDriver,
  createSanctuaryInteractiveAcceptanceScenarioDriver,
  createSanctuaryReadOnlyDenialScenarioDriver,
  executeSanctuaryAcceptanceAdapter,
  executeSanctuaryInteractiveRuntimeOperation,
  readDefaultSanctuaryScenarioFacts,
  runSanctuaryProductionBoundaryProbe,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"
import { SANCTUARY_SCENARIO_GATES, SANCTUARY_SCENARIO_SOURCES } from "../../../heart/daemon/sanctuary-acceptance-harness"

function healthProbeReceipt(scenarioHandleDigest: string, patch: Record<string, unknown> = {}) {
  const phases = [{ ordinal: 1, name: "digest", trigger: "acceptance", fixtureStatus: 503, opened: 0, recovered: 0, digestDue: true, deliveryKind: "digest", sweepReceiptDigest: "5".repeat(64), deliveryReceiptDigest: "6".repeat(64) }]
  return { schemaVersion: "sanctuary-health-probe-receipt-v1", label: "unit-16h-acceptance-delivery-probe", scenarioHandleDigest, ownerImageDigestBefore: "1".repeat(64), ownerImageDigestAfter: "1".repeat(64), ownerContainerDigestBefore: "2".repeat(64), ownerContainerDigestAfter: "2".repeat(64), beforeStateDigest: "3".repeat(64), restoredStateDigest: "3".repeat(64), cronFingerprintBefore: "4".repeat(64), cronFingerprintAfter: "4".repeat(64), cronRegisteredBefore: true, cronRegisteredAfter: true, cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: createHash("sha256").update(JSON.stringify([503])).digest("hex"), clockMode: "local-daily-boundary", effectiveNow: "2026-08-20T16:00:00.000Z", phases, privateTurnCount: 1, providerInvocationCount: 1, deliveryCount: 1, workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true, schedulerReceipt: null, acceptanceOnly: true, productionScheduleChanged: false, ...patch }
}

function cronHealthProbeReceipt(scenarioHandleDigest: string) {
  const phase = { ordinal: 1, name: "cron", trigger: "cron", fixtureStatus: null, opened: 0, recovered: 0, digestDue: false, deliveryKind: null, sweepReceiptDigest: "5".repeat(64), deliveryReceiptDigest: null }
  const unsigned = { schemaVersion: "sanctuary-scheduler-liveness-receipt-v1", label: "unit-16f-cron-fingerprint", scenarioHandleDigest, trigger: "cron", occurrenceId: "cron:2026-08-20T15:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", recordedAt: "2026-08-20T15:00:01.000Z", before: { sweepCount: 0, deliveryCount: 0 }, after: { sweepCount: 1, deliveryCount: 0 }, sweepDelta: 1, deliveryDelta: 0, providerInvocationCount: 0, privateTurnCount: 0, sweep: { recordDigest: phase.sweepReceiptDigest, opened: 0, recovered: 0, digestDue: false, deliveryId: null }, supervisor: { schemaVersion: "supercronic-supervisor-snapshot-v1", daemonPid: 1, childCount: 1, childPid: 42, healthy: true, binaryPath: "/usr/local/bin/supercronic", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"], crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab", namespace: "habit:sanctuary", manifest: [{ id: "sanctuary:sanctuary-health", agent: "sanctuary", taskId: "sanctuary-health", schedule: "*/15 * * * *", lastRun: null, command: "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron", taskPath: "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md" }], renderedCrontab: "# cron" }, schedulerOrigin: { slot: "2026-08-20T15:00:00.000Z", occurrenceId: "cron:2026-08-20T15:00:00.000Z", schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "c".repeat(64), scenarioHandleDigest }, nonReplay: true }
  return healthProbeReceipt(scenarioHandleDigest, { label: "unit-16f-cron-fingerprint", clockMode: "ambient", effectiveNow: "2026-08-20T15:00:00.000Z", phases: [phase], fixtureSequenceDigest: createHash("sha256").update("[]").digest("hex"), privateTurnCount: 0, providerInvocationCount: 0, deliveryCount: 0, schedulerReceipt: { ...unsigned, receiptMac: sanctuarySchedulerLivenessReceiptMac("k".repeat(43), unsigned) } })
}

describe("Sanctuary production boundary adapter coverage", () => {
  beforeEach(() => {
    boundary.controlOutput = ""
    boundary.mode = "success"
    boundary.sourceIdentityDigest = "9".repeat(64)
    boundary.machineRuntime = { ok: false, reason: "missing", itemPath: "vault:missing", error: "missing" }
  })

  it("exercises interactive readiness validation and its live daemon socket response", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-ready-socket-"))
    boundary.agentRoot = root
    const socketPath = path.join(root, "state", "acceptance", "telegram-control.sock")
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", () => socket.end(`${JSON.stringify({ ok: true, result: { ready: true } })}\n`))
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "interactive_runtime_ready", label: "wrong", scenarioHandleDigest: "a".repeat(64) }, {} as never)).rejects.toThrow("coordinates are invalid")
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "interactive_runtime_ready", label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }, {} as never)).resolves.toEqual({ ready: true })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects ambiguous key inventories and forged reboot attestations, then finalizes", async () => {
    const base = {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      readFixedFile: () => "a".repeat(64),
    }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" }, {
      ...base,
      hostRequest: async () => ({ keys: [
        { id: "duplicate", name: "one", permissions: [{ resource: "ARRAY", actions: ["READ_ANY"] }], roles: [] },
        { id: "duplicate", name: "two", permissions: [{ resource: "ARRAY", actions: ["READ_ANY"] }], roles: [] },
      ] }),
    } as never)).rejects.toThrow("inventory is ambiguous")

    await expect(executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "a".repeat(32), preflightDigest: "b".repeat(64), processBindingDigest: "c".repeat(64) }, {
      ...base, hostRequest: async () => ({ accepted: true, staged: true, targetId: "sanctuary", requestId: "d".repeat(64), reservationId: "e".repeat(64), prebootId: "boot", preflightDigest: "b".repeat(64), processBindingDigest: "c".repeat(64) }),
    } as never)).rejects.toThrow("staging attestation is invalid")

    await expect(executeSanctuaryAcceptanceAdapter({ operation: "reboot_preflight_snapshot", targetId: "sanctuary" }, {
      ...base, hostRequest: async () => ({ digest: "d".repeat(64), processBindingDigest: "a".repeat(64), safe: false, arrayReady: true, parityActive: false, moverActive: false, mutationActive: false }),
    } as never)).rejects.toThrow("preflight attestation is invalid")

    const finalizeScenarios = vi.fn(async () => undefined)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "finalize_acceptance_scenarios" }, { ...base, finalizeScenarios } as never)).resolves.toEqual({ finalized: true })
    expect(finalizeScenarios).toHaveBeenCalledOnce()
  })

  it("proves excluded tools stay blocked while one live read dispatches", async () => {
    const receipts = await runSanctuaryProductionBoundaryProbe([])
    expect(receipts).toHaveLength(8)
    expect(receipts.filter(({ invoked }) => invoked)).toEqual([expect.objectContaining({ name: "unraid_get_system", reason: "dispatched" })])
  })

  it.each(["bad-outcome", "duplicate-control"] as const)("rejects an invalid control execution: %s", async (mode) => {
    boundary.mode = mode
    await expect(runSanctuaryProductionBoundaryProbe([])).rejects.toThrow("valid control did not dispatch")
  })

  it("rejects an invalid live control result", async () => {
    boundary.mode = "invalid-control"
    await expect(runSanctuaryProductionBoundaryProbe([])).rejects.toThrow("control result is invalid")
  })

  it("executes both independent live-grounding readers and rejects invalid source identity", async () => {
    const deps = createSanctuaryAcceptanceAdapterDependencies(3, { hostRequest: async () => ({}) })
    await expect(deps.readLiveGrounding!("unraid_get_system")).resolves.toMatchObject({ toolName: "unraid_get_system", sourceIdentityDigest: "9".repeat(64), facts: { serverName: "Sanctuary" } })
    await expect(deps.readLiveGrounding!("unraid_get_storage")).resolves.toMatchObject({ toolName: "unraid_get_storage", sourceIdentityDigest: "9".repeat(64), facts: { truncated: false } })
    boundary.sourceIdentityDigest = "invalid"
    await expect(deps.readLiveGrounding!("unraid_get_system")).rejects.toThrow("source identity is unavailable")
    expect(deps.telegramCredentials!()).toMatchObject({ authorizedUserId: "42" })
    await expect(deps.finalizeScenarios!()).resolves.toBeUndefined()
  })

  it("drives, reuses, and cleans a durable read-only denial receipt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-driver-"))
    const scenario = "a".repeat(64)
    const digest = (value: string) => createHash("sha256").update(value).digest("hex")
    const boundaryReceipt = {
      ownerSnapshotDigest: digest("owner"), targetSnapshotDigest: digest("target"), targetRestartCount: 7,
      targetContainerIdDigest: digest("container"), auditCursorDigest: digest("audit"), providerUsageCursorDigest: digest("provider"),
      sessionCursorDigest: digest("session"), toolActionCursorDigest: digest("tool"),
    }
    const runProbe = vi.fn(async (label: "unit-16e-1-stop-denial" | "unit-16e-2-restart-denial") => ({
      schemaVersion: "sanctuary-read-only-denial-receipt-v1" as const, phase: "complete" as const, label, scenarioHandleDigest: scenario,
      operation: label === "unit-16e-1-stop-denial" ? "stop" as const : "restart" as const,
      targetDigest: boundaryReceipt.targetContainerIdDigest, attemptCount: 1 as const, httpStatus: 403, errorCode: "FORBIDDEN" as const,
      before: boundaryReceipt, after: boundaryReceipt,
    }))
    const driver = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: root, runProbe })
    try {
      await expect(driver.poll("unit-16e-1-stop-denial", scenario)).resolves.toEqual({ state: "driven" })
      await expect(driver.poll("unit-16e-1-stop-denial", scenario)).resolves.toEqual({ state: "driven" })
      expect(runProbe).toHaveBeenCalledOnce()
      driver.complete("unit-16e-1-stop-denial", scenario)
      expect(fs.existsSync(path.join(root, "state/acceptance/denial-receipts", `${scenario}.json`))).toBe(false)
      await expect(driver.poll("unit-16d-whats-up", scenario)).rejects.toThrow("label is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("rejects an indeterminate denial attempt before retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-indeterminate-"))
    const scenario = "a".repeat(64)
    const attempts = path.join(root, "state/acceptance/denial-attempts")
    fs.mkdirSync(attempts, { recursive: true })
    fs.writeFileSync(path.join(attempts, "prior.json"), JSON.stringify({ schemaVersion: "sanctuary-read-only-denial-attempt-v1", phase: "attempting", label: "unit-16e-2-restart-denial", scenarioHandleDigest: scenario }))
    const driver = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: root, runProbe: vi.fn() })
    try {
      await expect(driver.poll("unit-16e-2-restart-denial", scenario)).rejects.toThrow("inspect-before-retry")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers interactive waiting and invalid receipt envelopes through the public driver", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-interactive-boundary-"))
    const scenario = "a".repeat(64)
    const approval = { approvalId: "approval-1", state: "proposed", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64), transport: "telegram" }
    try {
      const waiting = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [{ approval } as never], hostRequest: async () => ({ state: "waiting" }) })
      await expect(waiting.poll("unit-16k-timeout-stale", scenario)).resolves.toEqual({ state: "waiting" })
      const invalid = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [{ approval } as never], hostRequest: async () => ({ state: "complete", receipt: {} }) })
      await expect(invalid.poll("unit-16m-restart-continuation", scenario)).rejects.toThrow(/receipt .*invalid/u)
      await expect(invalid.poll("unit-16l-duplicate-callback", scenario)).rejects.toThrow(/receipt .*invalid/u)
      const wrongState = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [{ approval } as never], hostRequest: async () => ({ state: "unexpected", receipt: {} }) })
      await expect(wrongState.poll("unit-16m-restart-continuation", scenario)).rejects.toThrow("receipt is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("rejects malformed restart, health, offset, and approval identity evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-facts-invalid-"))
    boundary.agentRoot = root
    const scenario = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const read = async (files: Record<string, string>, label: "unit-16f-cron-fingerprint" | "unit-16i-delayed-approval" = "unit-16f-cron-fingerprint") => readDefaultSanctuaryScenarioFacts(label, scenario, {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      readFixedFile: (file) => {
        const entry = Object.entries(files).find(([suffix]) => file.endsWith(suffix))
        if (entry) return entry[1]
        throw missing
      },
    } as never, root, { skipContainerSnapshot: true })
    const restartAttempt = {
      actionDigest: "b".repeat(64), afterState: 1, approvalId: "approval-1", argumentDigest: "c".repeat(64), attemptId: "attempt-1",
      beforeState: "running", container: { id: "container-1", name: "calibre-web" }, mutationAcknowledged: false,
      observedAt: "2026-08-20T16:00:00.000Z", scenarioHandleDigest: scenario, state: "attempt_not_started",
    }
    const health = {
      deliveredReceipts: [], incidents: {}, indeterminateDeliveries: {}, lastDigestDay: null, outbox: null, sweepReceipts: [], updatedAt: "2026-08-20T16:00:00.000Z",
    }
    try {
      await expect(read({ "/state/acceptance/restart-attempts.ndjson": JSON.stringify(restartAttempt) })).rejects.toThrow("restart attempt ledger row is invalid")
      await expect(read({ "/state/health/sanctuary-health.json": JSON.stringify(health) })).rejects.toThrow("health state schema is invalid")
      await expect(read({ "/state/health/sanctuary-health.json": JSON.stringify({ ...health, indeterminateDeliveries: [], deliveredReceipts: [{}] }) })).rejects.toThrow("health delivery receipts are invalid")
      await expect(read({ "/state/senses/telegram/offset.json": JSON.stringify({ nextUpdateId: -1 }) })).rejects.toThrow("Telegram offset state is invalid")
      await expect(read({}, "unit-16i-delayed-approval")).rejects.toThrow("approval identity key is missing or malformed")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("derives acceptance-only delivery-path evidence from valid health receipts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-facts-health-"))
    boundary.agentRoot = root
    const scenario = "a".repeat(64)
    const completedAt = "2026-08-20T16:00:00.000Z"
    const health = {
      deliveredReceipts: [{ deliveredAt: completedAt, deliveryId: "delivery-1", kind: "digest", messageIds: [1] }],
      incidents: {}, indeterminateDeliveries: [], lastDigestDay: "2026-08-20", outbox: null,
      sweepReceipts: [{ completedAt, deliveryId: "delivery-1", digestDue: true, incidentDigest: "b".repeat(64), opened: 0, recovered: 0, scenarioHandleDigest: scenario, startedAt: completedAt, sweepId: "12345678-1234-4123-8123-123456789abc" }],
      updatedAt: completedAt,
    }
    const cron = "# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron\n"
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16h-acceptance-delivery-probe", scenario, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        readFixedFile: (file) => {
          if (file.endsWith("/state/health/sanctuary-health.json")) return JSON.stringify(health)
          if (file.endsWith("/scheduler/sanctuary.crontab")) return cron
          throw missing
        },
        now: () => Date.parse(completedAt),
      } as never, root, { skipContainerSnapshot: true })
      expect(facts.health).toEqual({ transitionCount: 0, alertCount: 0, productionRestored: false })
      expect(facts.digest).toEqual({ scheduleObserved: true, messageCount: 1, firedWithinMs: 0, productionRestored: false })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("executes the real default read-only denial probe through scenario capture", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-default-denial-"))
    const agentRoot = path.join(root, "sanctuary.ouro")
    const canonicalId = "c".repeat(64)
    const prefixedId = `${"d".repeat(64)}:${canonicalId}`
    const targetDigest = createHash("sha256").update(canonicalId).digest("hex")
    const ownerSnapshot = {
      schemaVersion: 1, containerId: "1".repeat(64), imageId: `sha256:${"2".repeat(64)}`, running: true, health: "healthy",
      user: "10001:10001", liveProcessUser: "10001:10001", processBindingDigest: "3".repeat(64), readOnlyRoot: true,
      mountCount: 2, mountsDigest: "4".repeat(64), mountsExact: true, publishedPortCount: 0, networkMode: "host",
      securityExact: true, writableKeyExposure: false, restartPolicy: "unless-stopped", restartCount: 7, autostartExact: true,
      updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false,
      recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
    }
    const targetSnapshot = { containerIdDigest: targetDigest, imageDigest: "5".repeat(64), running: true, status: "running", restartCount: 7, startedAtDigest: "6".repeat(64) }
    boundary.agentRoot = agentRoot
    boundary.machineRuntime = {
      ok: true, itemPath: "vault:sanctuary:runtime", revision: "revision-1", updatedAt: "2026-08-20T16:00:00.000Z",
      config: { unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: "read-only-key" },
    }
    const hostRequest = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.operation === "container_snapshot") return ownerSnapshot
      if (payload.operation === "denial_target_snapshot") return targetSnapshot
      throw new Error(`unexpected host operation ${String(payload.operation)}`)
    })
    const deps = createSanctuaryAcceptanceAdapterDependencies(3, {
      hostRequest,
      scenarioCapture: { agentRoot, receiptRoot: path.join(agentRoot, "state/acceptance/receipts"), gateStatusPath: path.join(root, "gate.json") },
    })
    deps.readFixedFile = (file) => {
      if (file.startsWith(agentRoot)) return fs.readFileSync(file, "utf8")
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    }
    deps.fetch = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: { docker: { containers: [{ id: prefixedId, names: ["/calibre-web"], state: "running", status: "Up" }] } } }) })
      .mockResolvedValueOnce({ status: 403, json: async () => ({ errors: [{ extensions: { code: "FORBIDDEN" } }] }) }) as never
    const label = "unit-16e-1-stop-denial"
    const payload = { operation: "capture_acceptance_scenario", phase: "begin", label, externalGate: SANCTUARY_SCENARIO_GATES[label], sources: SANCTUARY_SCENARIO_SOURCES[label] }
    try {
      const begin = await executeSanctuaryAcceptanceAdapter(payload, deps) as Record<string, unknown>
      const polled = await executeSanctuaryAcceptanceAdapter({ ...payload, phase: "poll", checkpointDigest: begin.checkpointDigest }, deps)
      expect(polled).toMatchObject({
        state: "complete",
        assertions: { attemptCount: 1, cursorBoundaryCount: 7, denied: true, mutationCount: 0, restartCountUnchanged: true, resumed: true },
      })
      expect(deps.fetch).toHaveBeenCalledTimes(2)
      expect(hostRequest.mock.calls.filter(([request]) => request.operation === "denial_target_snapshot")).toHaveLength(2)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("fails closed across every interactive and denial receipt validator", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-receipt-matrix-"))
    const scenario = "a".repeat(64)
    const approval = { approvalId: "approval-1", state: "proposed", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64), transport: "telegram" }
    const common = { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", scenarioHandleDigest: scenario, approvalIdDigest: "1".repeat(64), checkpointDigest: "2".repeat(64), suspendedSessionRevisionDigest: "3".repeat(64), approvalEpochBefore: 0 }
    const timeout = { ...common, schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1", label: "unit-16k-timeout-stale", callbackAttempts: 0, distinctQueryCount: 1, callbackDataDigest: "4".repeat(64), settledCount: 1, claimCount: 0, mutationCount: 0, staleAcknowledged: true, promptTerminal: true }
    const duplicate = { ...common, label: "unit-16l-duplicate-callback", callbackAttempts: 2, distinctQueryCount: 2, callbackDataDigest: "4".repeat(64), barrierObserved: true, settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true, staleReplayMutationCount: 0, promptTerminal: false, writeCredentialObserved: false }
    const restart = { ...common, label: "unit-16m-restart-continuation", approvalEpochAfterRestart: 0, continuationEpochAfter: 1, ownerImageDigest: "4".repeat(64), ownerContainerDigest: "5".repeat(64), restartCountBefore: 0, restartCountAfter: 1, pendingDigestBefore: "6".repeat(64), pendingDigestAfter: "6".repeat(64), pendingRestored: true, callbackAttempts: 1, mutationCount: 1, indeterminateRecoveryObserved: true, attemptedRecoveryReopened: true, attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "7".repeat(64), indeterminateRetryCount: 0 }
    try {
      for (const [label, receipt, error] of [
        ["unit-16k-timeout-stale", timeout, "timeout stale driver receipt is invalid"],
        ["unit-16l-duplicate-callback", duplicate, "duplicate callback driver receipt is invalid"],
        ["unit-16m-restart-continuation", restart, "restart continuation driver receipt is invalid"],
      ] as const) {
        const driver = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [{ approval } as never], hostRequest: async () => label === "unit-16m-restart-continuation" ? { state: "complete", receipt } : receipt })
        await expect(driver.poll(label, scenario)).rejects.toThrow(error)
      }
      const badCommon = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [{ approval } as never], hostRequest: async () => ({ ...duplicate, approvalIdDigest: "bad", promptTerminal: true }) })
      await expect(badCommon.poll("unit-16l-duplicate-callback", scenario)).rejects.toThrow("common coordinates are invalid")

      const denialRoot = path.join(root, "state/acceptance/denial-receipts")
      fs.mkdirSync(denialRoot, { recursive: true })
      fs.writeFileSync(path.join(denialRoot, `${scenario}.json`), JSON.stringify({ schemaVersion: "bad", phase: "complete", label: "unit-16e-1-stop-denial", scenarioHandleDigest: scenario, operation: "stop", targetDigest: "1".repeat(64), attemptCount: 1, httpStatus: 403, errorCode: "FORBIDDEN", before: {}, after: {} }))
      const denial = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: root, runProbe: vi.fn() })
      await expect(denial.poll("unit-16e-1-stop-denial", scenario)).rejects.toThrow("receipt binding is invalid")
      fs.writeFileSync(path.join(denialRoot, `${scenario}.json`), JSON.stringify({ schemaVersion: "sanctuary-read-only-denial-receipt-v1", phase: "complete", label: "unit-16e-1-stop-denial", scenarioHandleDigest: scenario, operation: "stop", targetDigest: "1".repeat(64), attemptCount: 1, httpStatus: 403, errorCode: "FORBIDDEN", before: { ownerSnapshotDigest: "bad", targetSnapshotDigest: "2".repeat(64), targetRestartCount: 0, targetContainerIdDigest: "1".repeat(64), auditCursorDigest: "3".repeat(64), providerUsageCursorDigest: "4".repeat(64), sessionCursorDigest: "5".repeat(64), toolActionCursorDigest: "6".repeat(64) }, after: {} }))
      await expect(denial.poll("unit-16e-1-stop-denial", scenario)).rejects.toThrow("before boundary is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("rejects corrupt denial attempts and invalid denial target snapshots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-corrupt-"))
    const scenario = "a".repeat(64)
    const attempts = path.join(root, "state/acceptance/denial-attempts")
    fs.mkdirSync(attempts, { recursive: true })
    fs.writeFileSync(path.join(attempts, "corrupt.json"), JSON.stringify({ schemaVersion: "bad", phase: "attempting", label: "unit-16e-2-restart-denial", scenarioHandleDigest: scenario }))
    try {
      const driver = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: root, runProbe: vi.fn() })
      await expect(driver.poll("unit-16e-1-stop-denial", scenario)).rejects.toThrow("attempt is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }

    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-target-invalid-"))
    boundary.agentRoot = captureRoot
    boundary.machineRuntime = { ok: true, itemPath: "vault:x", revision: "r", updatedAt: "2026-08-20T16:00:00.000Z", config: { unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: "read" } }
    const canonicalId = "c".repeat(64)
    const owner = { schemaVersion: 1, containerId: "1".repeat(64), imageId: `sha256:${"2".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", liveProcessUser: "10001:10001", processBindingDigest: "3".repeat(64), readOnlyRoot: true, mountCount: 2, mountsDigest: "4".repeat(64), mountsExact: true, publishedPortCount: 0, networkMode: "host", securityExact: true, writableKeyExposure: false, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false, recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true } }
    const deps = createSanctuaryAcceptanceAdapterDependencies(3, { hostRequest: async (payload) => payload.operation === "container_snapshot" ? owner : { containerIdDigest: createHash("sha256").update(canonicalId).digest("hex"), imageDigest: "2".repeat(64), running: true, status: "running", restartCount: -1, startedAtDigest: "3".repeat(64) }, scenarioCapture: { agentRoot: captureRoot, receiptRoot: path.join(captureRoot, "receipts"), gateStatusPath: path.join(captureRoot, "gate.json") } })
    deps.readFixedFile = (file) => { if (file.startsWith(captureRoot)) return fs.readFileSync(file, "utf8"); throw Object.assign(new Error("missing"), { code: "ENOENT" }) }
    deps.fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ data: { docker: { containers: [{ id: `${"d".repeat(64)}:${canonicalId}`, names: ["calibre-web"] }] } } }) }) as never
    const payload = { operation: "capture_acceptance_scenario", phase: "begin", label: "unit-16e-1-stop-denial", externalGate: "none", sources: ["read-only-denial-receipt", "container-inspect"] }
    try {
      const begin = await executeSanctuaryAcceptanceAdapter(payload, deps) as Record<string, unknown>
      await expect(executeSanctuaryAcceptanceAdapter({ ...payload, phase: "poll", checkpointDigest: begin.checkpointDigest }, deps)).rejects.toThrow("target snapshot is invalid")
    } finally { fs.rmSync(captureRoot, { recursive: true, force: true }) }
  })

  it("projects a real succeeded approval and its signed audit evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-approval-projection-"))
    const scenario = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const approvalId = "11111111-1111-4111-8111-111111111111"
    boundary.agentRoot = root
    const databasePath = path.join(root, "state/approvals/approvals.sqlite")
    const store = openApprovalStore({ databasePath, now: () => new Date("2026-08-20T16:00:00.000Z"), randomUUID: () => approvalId, randomBytes: (size) => Buffer.alloc(size, 7) })
    const prepared = store.prepare({
      toolCallId: "call-1", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, schemaDigest: "1".repeat(64), toolDigest: "2".repeat(64), policyDigest: "3".repeat(64), policyId: "restart",
      sessionKey: "telegram:test", sessionPath: "/tmp/session", baseSessionRevision: "4".repeat(64), checkpointDigest: "5".repeat(64), requesterId: `tg_${"q".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", expiresAt: "2026-08-20T16:05:00.000Z", scenarioHandleDigest: scenario,
      frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "unraid_restart_container", arguments: "{\"container\":\"calibre-web\"}" } }] },
    })
    store.activate({ approvalId, checkpointDigest: prepared.record.checkpointDigest, suspendedSessionRevision: "6".repeat(64) })
    store.bindPrompt({ approvalId, transport: "telegram", transportChatId: "42", transportMessageId: "99" })
    const claimed = store.decide({ approvalId, decisionToken: prepared.decisionToken, decision: "approve", requesterId: `tg_${"q".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", transportMessageId: "99", sessionKey: "telegram:test", ownerId: "worker" })
    store.markAttempted({ approvalId, ownerId: claimed.ownerId!, epoch: claimed.epoch })
    const result = JSON.stringify({ ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } })
    store.complete({ approvalId, ownerId: claimed.ownerId!, epoch: claimed.epoch, state: "succeeded", result })
    const continuation = store.claimContinuation({ approvalId, ownerId: "continuation", ownerPid: process.pid })
    store.markContinuationMaterialized({ approvalId, ownerId: "continuation", epoch: continuation.record.continuationEpoch })
    store.completeContinuation({ approvalId, ownerId: "continuation", epoch: continuation.record.continuationEpoch })
    store.close()
    const audit = createTelegramAuditLedger({ root, identityKey })
    audit.append({ ts: "2026-08-20T16:00:01.000Z", level: "info", event: "approval.acceptance_transition", component: "heart", trace_id: "trace", message: "claimed", meta: { scenarioHandleDigest: scenario, approvalId, state: "claimed", acknowledged: true, reason: "expired" } })
    const staleUnsigned = { accepted: false, acknowledged: true, actionDigest: "7".repeat(64), approvalId, boundAt: 1, checkpointDigest: "5".repeat(64), messageIdDigest: "8".repeat(64), reason: "stale_callback", scenarioHandleDigest: scenario, staleAt: 2, suspendedSessionRevisionDigest: createHash("sha256").update("6".repeat(64)).digest("hex"), targetDigest: "9".repeat(64) }
    audit.append({ ts: "2026-08-20T16:00:02.000Z", level: "info", event: "telegram.approval_stale_callback_settled", component: "senses", trace_id: "trace-2", message: "stale", meta: { ...staleUnsigned, evidenceMac: sanctuaryTelegramApprovalEvidenceMac(identityKey, "telegram.approval_stale_callback_settled", staleUnsigned) } })
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", scenario, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        telegramCredentials: () => ({ botToken: "bot-token", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => {
          if (file.endsWith("/state/senses/telegram/identity.key")) return `${identityKey}\n`
          if (file.endsWith("/state/acceptance/telegram-audit-chain.ndjson")) return fs.readFileSync(audit.ledgerPath, "utf8")
          if (file.endsWith("/state/acceptance/telegram-audit-chain.head.json")) return fs.readFileSync(audit.headPath, "utf8")
          if (file.endsWith("/state/approvals/checkpoints.json")) return JSON.stringify({ z: { state: 2 }, a: { state: 1 } })
          throw missing
        },
      } as never, root, { skipContainerSnapshot: true })
      expect(facts.approvals).toEqual([expect.objectContaining({ approvalId, state: "succeeded", resultTargetId: "container-1", continuationCompleted: true, claimCount: 1, staleAcknowledged: true })])
      expect(facts.postbootIntegrity.approvalCheckpoints).toHaveLength(2)

      const secondId = "22222222-2222-4222-8222-222222222222"
      const secondStore = openApprovalStore({ databasePath, now: () => new Date("2026-08-20T16:00:03.000Z"), randomUUID: () => secondId, randomBytes: (size) => Buffer.alloc(size, 8) })
      const second = secondStore.prepare({
        toolCallId: "call-2", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, schemaDigest: "1".repeat(64), toolDigest: "2".repeat(64), policyDigest: "3".repeat(64), policyId: "restart",
        sessionKey: "telegram:test-2", sessionPath: "/tmp/session-2", baseSessionRevision: "4".repeat(64), checkpointDigest: "5".repeat(64), requesterId: `tg_${"r".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", expiresAt: "2026-08-20T16:05:03.000Z", scenarioHandleDigest: scenario,
        frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "unraid_restart_container", arguments: "{\"container\":\"calibre-web\"}" } }] },
      })
      secondStore.activate({ approvalId: secondId, checkpointDigest: second.record.checkpointDigest, suspendedSessionRevision: "6".repeat(64) })
      secondStore.bindPrompt({ approvalId: secondId, transport: "telegram", transportChatId: "42", transportMessageId: "100" })
      const secondClaim = secondStore.decide({ approvalId: secondId, decisionToken: second.decisionToken, decision: "approve", requesterId: `tg_${"r".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", transportMessageId: "100", sessionKey: "telegram:test-2", ownerId: "worker-2" })
      secondStore.markAttempted({ approvalId: secondId, ownerId: secondClaim.ownerId!, epoch: secondClaim.epoch })
      secondStore.complete({ approvalId: secondId, ownerId: secondClaim.ownerId!, epoch: secondClaim.epoch, state: "succeeded", result: JSON.stringify({ ok: true, data: { container: { id: "x".repeat(129), name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } }) })
      secondStore.close()
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", scenario, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        telegramCredentials: () => ({ botToken: "bot-token", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => {
          if (file.endsWith("/state/senses/telegram/identity.key")) return `${identityKey}\n`
          if (file.endsWith("/state/acceptance/telegram-audit-chain.ndjson")) return fs.readFileSync(audit.ledgerPath, "utf8")
          if (file.endsWith("/state/acceptance/telegram-audit-chain.head.json")) return fs.readFileSync(audit.headPath, "utf8")
          throw missing
        },
      } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("approved restart result binding is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("runs default interactive finalization and default engine dependency closures", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-default-interactive-"))
    boundary.agentRoot = root
    const scenario = "a".repeat(64)
    writeSanctuaryAcceptanceMarker("sanctuary", { schemaVersion: "sanctuary-acceptance-marker-v1", label: "unit-16m-restart-continuation", scenarioHandleDigest: scenario, startedAt: "2026-08-20T16:00:00.000Z" })
    const deps = createSanctuaryAcceptanceAdapterDependencies(3, { hostRequest: async () => ({}) })
    try {
      await expect(deps.finalizeScenarios!()).rejects.toThrow("inspect-before-retry")
      fs.mkdirSync(path.join(root, "state/approvals"), { recursive: true })
      openApprovalStore({ databasePath: path.join(root, "state/approvals/approvals.sqlite") }).close()
      await expect(executeSanctuaryInteractiveRuntimeOperation({ operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest: scenario }, { agentRoot: root, readPending: () => [] })).rejects.toThrow("approval is absent or ambiguous")

      const projection = { approval: { approvalId: "approval-1", state: "proposed", epoch: 0, toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, checkpointDigest: "1".repeat(64), suspendedSessionRevision: "2".repeat(64) }, continuation: null }
      const pending = { approvalId: "approval-1", deliveryState: "bound", messageId: "99", approveCallbackData: "a:x", denyCallbackData: "d:x", expiresAt: 1_000 }
      await expect(executeSanctuaryInteractiveRuntimeOperation({ operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest: scenario }, { agentRoot: root, readApprovals: () => [projection] as never, readPending: () => [pending] })).rejects.toThrow("callback session is unavailable")
      await expect(executeSanctuaryInteractiveRuntimeOperation({ operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest: scenario }, { agentRoot: root, readApprovals: () => [projection] as never, readPending: () => [pending] })).rejects.toThrow()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers host socket oversize and late-end failure paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-host-socket-fail-"))
    boundary.agentRoot = root
    const socketPath = path.join(root, "host.sock")
    let peer: import("node:net").Socket | undefined
    const server = createServer((socket) => { peer = socket; socket.end("x".repeat(256 * 1024 + 1)) })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const deps = createSanctuaryAcceptanceAdapterDependencies(3, { hostBrokerSocket: socketPath, adapterTimeoutMs: 100 })
      await expect(deps.hostRequest!({ operation: "test" })).rejects.toThrow("host acceptance operation failed")
    } finally {
      peer?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("flattens finalizer errors and preserves local cleanup ordering", async () => {
    const finalizeLocal = vi.fn(() => { throw new AggregateError([new Error("local-a"), new AggregateError([new Error("local-b")])]) })
    const finalize = createSanctuaryAcceptanceScenarioFinalizer({ readActiveScenario: () => null, recoverHealthScenario: async () => undefined, finalizeLocal })
    await expect(finalize()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "local-a" }), expect.objectContaining({ message: "local-b" })] })
    expect(finalizeLocal).toHaveBeenCalledOnce()
    const readFailure = createSanctuaryAcceptanceScenarioFinalizer({ readActiveScenario: () => { throw new Error("read") }, recoverHealthScenario: async () => undefined, finalizeLocal: () => undefined })
    await expect(readFailure()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "read" })] })
    const interactiveFailure = createSanctuaryAcceptanceScenarioFinalizer({ readActiveScenario: () => ({ label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }), recoverHealthScenario: async () => undefined, finalizeInteractiveScenario: async () => { throw new Error("interactive") }, finalizeLocal: () => undefined })
    await expect(interactiveFailure()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "interactive" }), expect.objectContaining({ message: "interactive scenario requires inspect-before-retry" })] })
  })

  it("covers invalid health coordinates and the independent postboot offset guard", async () => {
    const health = createSanctuaryHealthAcceptanceScenarioDriver(async () => ({}))
    await expect(health.begin("unit-16d-whats-up", "a".repeat(64))).rejects.toThrow("health probe label is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "postboot_integrity_snapshot" }, {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      readFixedFile: (file) => file.endsWith("offset.json") ? JSON.stringify({ nextUpdateId: -1 }) : (() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) })(),
    })).rejects.toThrow("Telegram offset state is invalid")
  })

  it("rejects unsupported identity surface filesystem entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-socket-"))
    const friends = path.join(root, "friends")
    fs.mkdirSync(friends, { recursive: true })
    const socketPath = path.join(friends, "unsupported.sock")
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    try {
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", "a".repeat(64), {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        telegramCredentials: () => ({ botToken: "bot-token", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => file.endsWith("/state/senses/telegram/identity.key") ? `${"k".repeat(43)}\n` : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("unsupported filesystem entry")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("ignores a structurally common interactive receipt for a non-interactive scenario", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-noninteractive-receipt-"))
    const scenario = "a".repeat(64)
    const raw = JSON.stringify({ schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label: "unit-16f-cron-fingerprint", scenarioHandleDigest: scenario, approvalIdDigest: "1".repeat(64), checkpointDigest: "2".repeat(64), suspendedSessionRevisionDigest: "3".repeat(64), approvalEpochBefore: 0 })
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", scenario, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        readFixedFile: (file) => {
          if (file.includes("/interactive-driver-receipts/")) return raw
          throw Object.assign(new Error("missing"), { code: "ENOENT" })
        },
      } as never, root, { skipContainerSnapshot: true })
      expect(facts.interactiveDriver).toBeUndefined()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers public adapter validation boundaries without private test hooks", async () => {
    const digest = "a".repeat(64)
    const health = createSanctuaryHealthAcceptanceScenarioDriver(async () => ({}))
    await expect(health.begin("unit-16g-health-transition", "bad")).rejects.toThrow("scenario handle is invalid")

    const proposal = (suspendedSessionRevision: unknown, checkpointDigest: unknown) => [{ approval: {
      state: "proposed", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, transport: "telegram",
      suspendedSessionRevision, checkpointDigest,
    } }]
    const interactive = createSanctuaryInteractiveAcceptanceScenarioDriver({
      agentRoot: os.tmpdir(), hostRequest: async () => ({}), readApprovals: () => proposal(undefined, digest) as never,
    })
    await expect(interactive.poll("unit-16l-duplicate-callback", digest)).rejects.toThrow("checkpoint is invalid")
    const interactiveBadDigest = createSanctuaryInteractiveAcceptanceScenarioDriver({
      agentRoot: os.tmpdir(), hostRequest: async () => ({}), readApprovals: () => proposal(digest, "bad") as never,
    })
    await expect(interactiveBadDigest.poll("unit-16l-duplicate-callback", digest)).rejects.toThrow("checkpoint is invalid")
    expect(() => interactive.cleanup("unit-16f-cron-fingerprint", digest)).not.toThrow()
    expect(() => interactive.cleanup("unit-16l-duplicate-callback", digest)).not.toThrow()

    const base = { readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "store_telegram_bootstrap", botToken: "x", authorizedUserId: "0", authorizedChatId: "1" }, base as never)).rejects.toThrow("authorized user is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "store_telegram_bootstrap", botToken: "x", authorizedUserId: "1", authorizedChatId: "2" }, {
      ...base, mergeRuntime: async () => ({ ok: false, reason: "locked" }),
    } as never)).rejects.toThrow("readback failed")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" }, {
      ...base, hostRequest: async () => ({ keys: null }),
    } as never)).rejects.toThrow("inventory is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "old" }, {
      ...base, hostRequest: async () => ({ id: "other", name: "Butler RO", permissions: [], roles: [], key: "secret" }),
    } as never)).rejects.toThrow("does not match")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoke_key", targetServerId: "sanctuary-unraid", id: "old" }, {
      ...base, hostRequest: async () => ({ revoked: false, id: "old" }),
    } as never)).rejects.toThrow("did not attest")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "poll_reboot", targetId: "sanctuary", requestId: digest }, {
      ...base, readFixedFile: () => "bad",
    } as never)).rejects.toThrow("boot identity is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "wrong", idempotencyKey: "1".repeat(32), preflightDigest: digest, processBindingDigest: digest }, base as never)).rejects.toThrow("targetId is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "bad", preflightDigest: digest, processBindingDigest: digest }, base as never)).rejects.toThrow("idempotencyKey is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "1".repeat(32), preflightDigest: "bad", processBindingDigest: digest }, base as never)).rejects.toThrow("binding digest is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "reboot_preflight_snapshot", targetId: "wrong" }, base as never)).rejects.toThrow("targetId is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "reboot_preflight_snapshot", targetId: "sanctuary" }, { ...base, readFixedFile: () => "bad" } as never)).rejects.toThrow("process binding digest is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "finalize_acceptance_scenarios" }, base as never)).rejects.toThrow("finalization is unavailable")

    await expect(executeSanctuaryAcceptanceAdapter({ operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest: "bad" }, base as never)).rejects.toThrow("scenario digest is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "drive_timeout_stale", label: "unit-16l-duplicate-callback", scenarioHandleDigest: digest }, base as never)).rejects.toThrow("label is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "capture_acceptance_scenario", phase: "bad" }, base as never)).rejects.toThrow("scenario phase is invalid")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "capture_acceptance_scenario", phase: "begin", label: "unit-16a-pre-reboot-checkpoint", externalGate: SANCTUARY_SCENARIO_GATES["unit-16a-pre-reboot-checkpoint"], sources: SANCTUARY_SCENARIO_SOURCES["unit-16a-pre-reboot-checkpoint"] }, base as never)).rejects.toThrow("scenario capture is unavailable")
  })

  it("enforces every bounded durable-fact input through the public facts reader", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-fact-bounds-"))
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const call = (suffix: string, raw: string) => readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      readFixedFile: (file) => file.endsWith(suffix) ? raw : (() => { throw missing })(),
    } as never, root, { skipContainerSnapshot: true })
    try {
      await expect(call("restart-attempts.ndjson", "x".repeat(4 * 1024 * 1024 + 1))).rejects.toThrow("restart attempt ledger exceeds")
      await expect(call("restart-attempts.ndjson", `${Array.from({ length: 501 }, () => " ").join("\n")}\n`)).rejects.toThrow("restart attempt ledger exceeds")
      await expect(call("restart-attempts.ndjson", `${"x".repeat(8 * 1024 + 1)}\n`)).rejects.toThrow("restart attempt ledger exceeds")
      await expect(call("sanctuary-health.json", "x".repeat(4 * 1024 * 1024 + 1))).rejects.toThrow("health state exceeds")
      await expect(call("telegram-turns.ndjson", "x".repeat(4 * 1024 * 1024 + 1))).rejects.toThrow("turn receipt ledger exceeds")
      await expect(call("telegram-turns.ndjson", `${Array.from({ length: 501 }, () => " ").join("\n")}\n`)).rejects.toThrow("turn receipt ledger exceeds")
      await expect(call("telegram-turns.ndjson", `${"x".repeat(16 * 1024 + 1)}\n`)).rejects.toThrow("turn receipt ledger exceeds")
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      } as never, root, { skipContainerSnapshot: true })).resolves.toBeTruthy()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("enforces identity-surface depth, count, and byte bounds", async () => {
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const facts = (root: string) => readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
      readFixedFile: (file) => file.endsWith("identity.key") ? `${"k".repeat(43)}\n` : (() => { throw missing })(),
    } as never, root, { skipContainerSnapshot: true })
    const depthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-depth-"))
    const countRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-count-"))
    const bytesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-bytes-"))
    const directBytesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-direct-bytes-"))
    const directJsonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-direct-json-"))
    const friendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-identity-friend-"))
    try {
      let nested = path.join(depthRoot, "friends")
      for (let index = 0; index < 8; index += 1) nested = path.join(nested, String(index))
      fs.mkdirSync(nested, { recursive: true })
      await expect(facts(depthRoot)).rejects.toThrow("depth bound")
      const friends = path.join(countRoot, "friends")
      fs.mkdirSync(friends, { recursive: true })
      for (let index = 0; index < 2_001; index += 1) fs.writeFileSync(path.join(friends, String(index)), "")
      await expect(facts(countRoot)).rejects.toThrow("file-count bound")
      fs.mkdirSync(path.join(bytesRoot, "friends"), { recursive: true })
      fs.writeFileSync(path.join(bytesRoot, "friends", "large"), "x".repeat(1024 * 1024 + 1))
      await expect(facts(bytesRoot)).rejects.toThrow("identity surface audit exceeds its bound")
      fs.mkdirSync(path.join(directBytesRoot, "state/senses/telegram"), { recursive: true })
      fs.writeFileSync(path.join(directBytesRoot, "state/senses/telegram/identity-subjects.json"), "x".repeat(1024 * 1024 + 1))
      await expect(facts(directBytesRoot)).rejects.toThrow("identity surface audit exceeds its bound")
      fs.mkdirSync(path.join(directJsonRoot, "state/senses/telegram"), { recursive: true })
      fs.writeFileSync(path.join(directJsonRoot, "state/senses/telegram/identity-subjects.json"), "{")
      await expect(facts(directJsonRoot)).rejects.toThrow()
      fs.mkdirSync(path.join(friendRoot, "friends"), { recursive: true })
      fs.writeFileSync(path.join(friendRoot, "friends", "friend.json"), JSON.stringify({ externalIds: null }))
      await expect(facts(friendRoot)).resolves.toBeTruthy()
    } finally {
      for (const root of [depthRoot, countRoot, bytesRoot, directBytesRoot, directJsonRoot, friendRoot]) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed across denial runtime, topology, identity, and error-code variants", async () => {
    const digest = "a".repeat(64)
    const canonicalId = "c".repeat(64)
    const prefixedId = `${"d".repeat(64)}:${canonicalId}`
    const owner = { schemaVersion: 1, containerId: "1".repeat(64), imageId: `sha256:${"2".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", liveProcessUser: "10001:10001", processBindingDigest: "3".repeat(64), readOnlyRoot: true, mountCount: 2, mountsDigest: "4".repeat(64), mountsExact: true, publishedPortCount: 0, networkMode: "host", securityExact: true, writableKeyExposure: false, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false, recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true } }
    const run = async (label: "unit-16e-1-stop-denial" | "unit-16e-2-restart-denial", responses: unknown[], expected: string | null, targetId: string | [string, string] = canonicalId, runtimeOk = true, unreadableCursor = false) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-variant-"))
      boundary.agentRoot = root
      boundary.machineRuntime = runtimeOk ? { ok: true, config: { unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: "read" } } : { ok: false, reason: "locked" }
      let targetReads = 0
      const target = () => { const id = Array.isArray(targetId) ? targetId[Math.min(targetReads++, 1)]! : targetId; return { containerIdDigest: createHash("sha256").update(id).digest("hex"), imageDigest: "5".repeat(64), running: true, status: "running", restartCount: 0, startedAtDigest: "6".repeat(64) } }
      const deps = createSanctuaryAcceptanceAdapterDependencies(3, {
        hostRequest: async (payload) => payload.operation === "container_snapshot" ? owner : target(),
        scenarioCapture: { agentRoot: root, receiptRoot: path.join(root, "receipts"), gateStatusPath: path.join(root, "gate.json") },
      })
      deps.readFixedFile = (file) => {
        if (unreadableCursor && file.endsWith("telegram-turns.ndjson")) throw Object.assign(new Error("missing"), { code: "ENOENT" })
        if (file.startsWith(root)) return fs.readFileSync(file, "utf8")
        throw Object.assign(new Error("missing"), { code: "ENOENT" })
      }
      deps.fetch = vi.fn()
      for (const response of responses) (deps.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response)
      const payload = { operation: "capture_acceptance_scenario", phase: "begin", label, externalGate: SANCTUARY_SCENARIO_GATES[label], sources: SANCTUARY_SCENARIO_SOURCES[label] }
      try {
        const begin = await executeSanctuaryAcceptanceAdapter(payload, deps) as Record<string, unknown>
        if (unreadableCursor) fs.mkdirSync(path.join(root, "state/acceptance/telegram-turns.ndjson"), { recursive: true })
        const poll = executeSanctuaryAcceptanceAdapter({ ...payload, phase: "poll", checkpointDigest: begin.checkpointDigest }, deps)
        if (expected === null) await expect(poll).resolves.toMatchObject({ state: "complete" })
        else await expect(poll).rejects.toThrow(expected)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    }
    const topology = (containers: unknown) => ({ status: 200, json: async () => ({ data: { docker: { containers } } }) })
    await run("unit-16e-1-stop-denial", [], "unlocked machine runtime", canonicalId, false)
    await run("unit-16e-1-stop-denial", [topology(null)], "target list is invalid")
    await run("unit-16e-1-stop-denial", [topology([])], "target is absent")
    await run("unit-16e-1-stop-denial", [topology([{ id: prefixedId, names: ["calibre-web"] }])], "target identity is invalid", "e".repeat(64))
    await run("unit-16e-2-restart-denial", [topology([{ id: prefixedId, names: ["calibre-web"] }]), { status: 403, json: async () => ({ errors: [{ extensions: { code: "OTHER" } }, { extensions: null }] }) }], "receipt binding is invalid")
    await run("unit-16e-1-stop-denial", [topology([{ id: prefixedId, names: ["calibre-web"] }]), { status: 403, json: async () => ({ errors: null }) }], "receipt binding is invalid")
    await run("unit-16e-2-restart-denial", [topology([{ id: prefixedId, names: ["calibre-web"] }]), { status: 403, json: async () => ({ errors: [{ extensions: { code: "PERMISSION_DENIED" } }] }) }], null)
    await run("unit-16e-1-stop-denial", [topology([{ id: prefixedId, names: ["calibre-web"] }]), { status: 403, json: async () => ({ errors: [{ extensions: { code: "FORBIDDEN" } }] }) }], "identity drifted", [canonicalId, "e".repeat(64)])
    await run("unit-16e-1-stop-denial", [topology([{ id: prefixedId, names: ["calibre-web"] }])], "EISDIR", canonicalId, true, true)
  })

  it("covers remaining public facts and runtime dependency selection branches", async () => {
    const digest = "a".repeat(64)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-public-selection-"))
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const base = { readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch, readFixedFile: () => { throw missing } }
    try {
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, base as never, root, { skipContainerSnapshot: true, containerSnapshot: {} })).rejects.toThrow("mutually exclusive")
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, base as never, root)
      expect(facts.container).toBeUndefined()

      const healthBase = { deliveredReceipts: [], incidents: {}, indeterminateDeliveries: [], lastDigestDay: null, outbox: null, sweepReceipts: [], updatedAt: "2026-08-20T16:00:00.000Z" }
      for (const outbox of ["bad", []]) {
        await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
          ...base, readFixedFile: (file) => file.endsWith("sanctuary-health.json") ? JSON.stringify({ ...healthBase, outbox }) : (() => { throw missing })(),
        } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("health state schema is invalid")
      }

      fs.mkdirSync(path.join(root, "state/senses/telegram"), { recursive: true })
      fs.writeFileSync(path.join(root, "state/senses/telegram/identity-subjects.json"), "{}")
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
        ...base,
        telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => file.endsWith("identity.key") ? `${"k".repeat(43)}\n` : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).resolves.toBeTruthy()

      await expect(executeSanctuaryAcceptanceAdapter({ operation: "store_key", targetServerId: "sanctuary-unraid", keyId: "old", vaultField: "unraidReadApiKey", key: "unraid-key:old:unraidReadApiKey" }, {
        ...base, refreshMachine: async () => ({ ok: false, reason: "locked" }),
      } as never)).rejects.toThrow("runtime config is unavailable")
      boundary.agentRoot = root
      await expect(executeSanctuaryInteractiveRuntimeOperation({ operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest: digest }, {
        readApprovals: () => [], readPending: () => [],
      })).rejects.toThrow("approval is absent or ambiguous")
      await expect(executeSanctuaryInteractiveRuntimeOperation({ operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest: digest })).rejects.toThrow()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers provider readiness short-circuit and credential availability matrix", async () => {
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const variants = [
      { outward: "wrong", inner: "openai-compatible", providers: [{ provider: "openai-compatible-gemini", model: "gemini" }], glm: true, gemini: true, identity: true },
      { outward: "openai-compatible", inner: "wrong", providers: [{ provider: "openai-compatible-gemini", model: "gemini" }], glm: true, gemini: true, identity: true },
      { outward: "openai-compatible", inner: "openai-compatible", providers: [], glm: true, gemini: true, identity: true },
      { outward: "openai-compatible", inner: "openai-compatible", providers: [{ provider: "openai-compatible-gemini", model: "gemini" }], glm: false, gemini: false, identity: false },
      { outward: "openai-compatible", inner: "openai-compatible", providers: [{ provider: "openai-compatible-gemini", model: "gemini" }], glm: true, gemini: false, identity: true },
      { outward: "openai-compatible", inner: "openai-compatible", providers: [{ provider: "openai-compatible-gemini", model: "gemini", vaultItem: "providers/openai-compatible-gemini" }], glm: true, gemini: true, identity: true },
      { outward: "openai-compatible", inner: "openai-compatible", providers: [{ provider: "openai-compatible-gemini", model: "gemini", vaultItem: "providers/openai-compatible-gemini" }, { provider: "openai-compatible", vaultItem: "providers/openai-compatible" }], glm: false, gemini: true, identity: true },
      { outward: "openai-compatible", inner: "openai-compatible", providers: [{ provider: "openai-compatible-gemini", model: "gemini-3.6-flash", vaultItem: "providers/openai-compatible-gemini" }, { provider: "openai-compatible", vaultItem: "providers/openai-compatible" }], glm: true, gemini: true, identity: true },
    ]
    for (const variant of variants) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-provider-matrix-"))
      const files: Record<string, string> = {
        [`${root}/agent.json`]: JSON.stringify({ humanFacing: { provider: variant.outward, model: "glm-5.2" }, agentFacing: { provider: variant.inner, model: "glm-5.2" } }),
        [`${root}/provider-readiness.json`]: JSON.stringify({ selectionPolicy: "explicit-same-lane-only", providers: variant.providers }),
        ...(variant.identity ? { [`${root}/state/senses/telegram/identity.key`]: `${"k".repeat(43)}\n` } : {}),
      }
      try {
        await expect(readDefaultSanctuaryScenarioFacts("unit-16c-provider-readiness", digest, {
          readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
          readFixedFile: (file) => file in files ? files[file]! : (() => { throw missing })(),
          telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
          readProviderCredential: async (_agent, provider) => {
            const ok = provider === "openai-compatible" ? variant.glm : variant.gemini
            return ok ? { ok: true, record: { revision: "r", credentials: { apiKey: `${provider}-secret` }, config: { baseUrl: provider === "openai-compatible" ? "https://api.z.ai/api/paas/v4/" : "https://generativelanguage.googleapis.com/v1beta/openai/" } } } : { ok: false }
          },
          providerPing: async (provider, _config, options) => ({ ok: false, attempts: variant.glm && variant.gemini ? undefined : [{ provider, model: options.model!, operation: "ping", ok: false }] }),
        } as never, root, { skipContainerSnapshot: true })).resolves.toBeTruthy()
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-provider-defaults-"))
    try {
      const files: Record<string, string> = {
        [`${root}/agent.json`]: JSON.stringify({ humanFacing: { provider: "openai-compatible", model: "glm-5.2" }, agentFacing: { provider: "openai-compatible", model: "glm-5.2" } }),
        [`${root}/provider-readiness.json`]: JSON.stringify({ selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "openai-compatible-gemini", model: "gemini-3.6-flash", vaultItem: "providers/openai-compatible-gemini" }] }),
      }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16c-provider-readiness", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        readFixedFile: (file) => file in files ? files[file]! : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).resolves.toBeTruthy()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers MiniMax provider readiness credential branches", async () => {
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    for (const variant of [
      { credentials: { apiKey: "minimax-secret" }, credentialOk: true, attempts: "present", readinessVaultItem: "providers/minimax" },
      { credentials: {}, credentialOk: true, attempts: "present", readinessVaultItem: "providers/minimax" },
      { credentials: { apiKey: "minimax-secret" }, credentialOk: false, attempts: "present", readinessVaultItem: "providers/minimax" },
      { credentials: { apiKey: "minimax-secret" }, credentialOk: true, attempts: "missing", readinessVaultItem: "providers/minimax" },
      { credentials: { apiKey: "minimax-secret" }, credentialOk: true, attempts: "present", readinessVaultItem: undefined },
    ]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-minimax-provider-matrix-"))
      const files: Record<string, string> = {
        [`${root}/agent.json`]: JSON.stringify({ humanFacing: { provider: "minimax", model: "MiniMax-M3" }, agentFacing: { provider: "minimax", model: "MiniMax-M3" } }),
        [`${root}/provider-readiness.json`]: JSON.stringify({ selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "minimax", model: "MiniMax-M3", ...(variant.readinessVaultItem ? { vaultItem: variant.readinessVaultItem } : {}) }] }),
        [`${root}/state/senses/telegram/identity.key`]: `${"k".repeat(43)}\n`,
      }
      try {
        const facts = await readDefaultSanctuaryScenarioFacts("unit-16c-provider-readiness", digest, {
          readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
          readFixedFile: (file) => file in files ? files[file]! : (() => { throw missing })(),
          telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
          readProviderCredential: async (_agent, provider) => variant.credentialOk
            ? { ok: true, record: { provider, revision: "minimax-rev", credentials: variant.credentials, config: { baseUrl: "https://api.minimax.io/v1" } } }
            : { ok: false },
          providerPing: async (provider, _config, options) => ({ ok: true, ...(variant.attempts === "present" ? { attempts: [{ provider, model: options.model!, operation: "ping", ok: true }] } : {}) }),
        } as never, root, { skipContainerSnapshot: true })
        expect(facts.provider?.pingReceipts).toHaveLength(2)
        const contractEvaluated = Boolean(("apiKey" in variant.credentials) && variant.credentials.apiKey && variant.credentialOk)
        expect(facts.provider).toMatchObject({
          laneSelectionExact: contractEvaluated,
          baseUrlExact: contractEvaluated,
          vaultCoordinatesExact: contractEvaluated && variant.readinessVaultItem === "providers/minimax",
          singleCredentialExact: contractEvaluated,
        })
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    }
  })

  it("covers MiniMax provider readiness default dependency wiring", async () => {
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-minimax-provider-default-deps-"))
    const files: Record<string, string> = {
      [`${root}/agent.json`]: JSON.stringify({ humanFacing: { provider: "minimax", model: "MiniMax-M3" }, agentFacing: { provider: "minimax", model: "MiniMax-M3" } }),
      [`${root}/provider-readiness.json`]: JSON.stringify({ selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "minimax", model: "MiniMax-M3", vaultItem: "providers/minimax" }] }),
      [`${root}/state/senses/telegram/identity.key`]: `${"k".repeat(43)}\n`,
    }
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16c-provider-readiness", digest, {
        readKeyFiles: () => [],
        readDescriptor: () => "",
        execFile: async () => ({ status: 0, stdout: "" }),
        fetch,
        readFixedFile: (file) => file in files ? files[file]! : (() => { throw missing })(),
        telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
      } as never, root, { skipContainerSnapshot: true })
      expect(facts.provider).toMatchObject({
        outwardReady: false,
        innerReady: false,
        laneSelectionExact: false,
        baseUrlExact: false,
        vaultCoordinatesExact: false,
        singleCredentialExact: false,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("covers sparse and adversarial containment projections", async () => {
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const run = async (profiles: unknown, keys: unknown[], receipts: unknown[]) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-containment-sparse-"))
      try {
        fs.writeFileSync(path.join(root, "tool-profiles.json"), JSON.stringify({ version: 2, profiles }))
        return await readDefaultSanctuaryScenarioFacts("unit-16e-containment-audit", digest, {
          readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
          readFixedFile: () => { throw missing },
          hostRequest: async () => ({ keys }), runProductionBoundaryProbe: async () => receipts,
        } as never, root, { skipContainerSnapshot: true })
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    }
    const sparse = await run({}, [], [])
    expect(sparse.containment).toMatchObject({ keyCount: 0, telegramToolCount: 0, privateToolCount: 0, containerUser: "", liveProcessUser: "", mountCount: -1, publishedPortCount: -1, networkMode: "" })
    const shaped = await run({
      "sanctuary-owner": { version: 1, contextScopes: [], toolNames: ["ponder"], effectScopes: [] },
      "sanctuary-event": { version: 1, contextScopes: [], toolNames: [], effectScopes: [] },
    }, [], [])
    expect(shaped.containment).toMatchObject({ telegramToolCount: 1, privateToolCount: 0 })
    const unresolved = await run({
      "sanctuary-owner": { version: 1, contextScopes: [], toolNames: ["not_a_registered_tool"], effectScopes: [] },
      "sanctuary-event": { version: 1, contextScopes: [], toolNames: ["rest"], effectScopes: [] },
    }, [], [])
    expect(unresolved.containment).toMatchObject({ relationshipProfilesExact: true, handlersExact: false, telegramToolCount: 1, privateToolCount: 1, resolvedHandlerCount: 1 })
    await expect(run({ "sanctuary-owner": "bad", "sanctuary-event": "bad" }, [], [])).rejects.toThrow("relationship capability profile")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-containment-invalid-"))
    try {
      await expect(readDefaultSanctuaryScenarioFacts("unit-16e-containment-audit", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        readFixedFile: () => { throw missing }, hostRequest: async () => ({ keys: null }), runProductionBoundaryProbe: async () => [],
      } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("containment key inventory is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers postboot audit presence combinations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-postboot-audit-"))
    boundary.agentRoot = root
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const base = { readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch }
    try {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "postboot_integrity_snapshot" }, {
        ...base, readFixedFile: (file) => file.endsWith("telegram-audit-chain.ndjson") ? "" : (() => { throw missing })(),
      } as never)).rejects.toThrow("ledger/head presence mismatch")
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "postboot_integrity_snapshot" }, {
        ...base, readFixedFile: (file) => file.endsWith("telegram-audit-chain.ndjson") || file.endsWith("telegram-audit-chain.head.json") ? "{}" : (() => { throw missing })(),
      } as never)).rejects.toThrow("identity key is unavailable")
      const identityKey = "k".repeat(43)
      const ledger = createTelegramAuditLedger({ root, identityKey })
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "postboot_integrity_snapshot" }, {
        ...base, readFixedFile: (file) => {
          if (file.endsWith("identity.key")) return identityKey
          if (file.endsWith("telegram-audit-chain.ndjson")) return fs.readFileSync(ledger.ledgerPath, "utf8")
          if (file.endsWith("telegram-audit-chain.head.json")) return fs.readFileSync(ledger.headPath, "utf8")
          throw missing
        },
      } as never)).resolves.toBeTruthy()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers denial attempt inventory and durable-write fault boundaries", async () => {
    const digest = "a".repeat(64)
    const roots = Array.from({ length: 4 }, () => fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-fs-")))
    try {
      const attempts = path.join(roots[0]!, "state/acceptance/denial-attempts")
      fs.mkdirSync(attempts, { recursive: true })
      for (let index = 0; index < 101; index += 1) fs.writeFileSync(path.join(attempts, `${index}.json`), "{}")
      await expect(createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: roots[0]!, runProbe: vi.fn() }).poll("unit-16e-1-stop-denial", digest)).rejects.toThrow("inventory exceeds")

      const invalid = path.join(roots[1]!, "state/acceptance/denial-attempts/not-a-file.json")
      fs.mkdirSync(invalid, { recursive: true })
      await expect(createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: roots[1]!, runProbe: vi.fn() }).poll("unit-16e-1-stop-denial", digest)).rejects.toThrow("inventory is invalid")

      const completion = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: roots[2]!, runProbe: vi.fn() })
      completion.complete("unit-16e-1-stop-denial", digest)
      completion.complete("unit-16e-1-stop-denial", digest)

    } finally {
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("covers expired proposal selection and optional durable evidence fields", async () => {
    const digest = "a".repeat(64)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-optional-evidence-"))
    const expired = { approval: { state: "expired", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, transport: "telegram", suspendedSessionRevision: digest, checkpointDigest: digest } }
    try {
      const duplicate = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [expired] as never, hostRequest: vi.fn() })
      await expect(duplicate.poll("unit-16l-duplicate-callback", digest)).resolves.toEqual({ state: "waiting" })
      const timeout = createSanctuaryInteractiveAcceptanceScenarioDriver({ agentRoot: root, readApprovals: () => [expired] as never, hostRequest: async () => ({ state: "waiting" }) })
      await expect(timeout.poll("unit-16k-timeout-stale", digest)).resolves.toEqual({ state: "waiting" })

      const identityKey = "k".repeat(43)
      const audit = createTelegramAuditLedger({ root, identityKey })
      audit.append({ ts: "2026-08-20T16:00:00.000Z", level: "info", event: "custom.audit", component: "senses", trace_id: "trace", message: "custom", meta: {} })
      const health = {
        deliveredReceipts: [], incidents: {}, indeterminateDeliveries: [], lastDigestDay: null, outbox: null,
        sweepReceipts: [{ completedAt: "2026-08-20T14:00:00.000Z", digestDue: true, incidentDigest: "b".repeat(64), opened: 0, recovered: 0, scenarioHandleDigest: digest, startedAt: "2026-08-20T13:59:00.000Z", sweepId: "12345678-1234-4123-8123-123456789abc" }, { completedAt: "2026-08-20T14:00:01.000Z", digestDue: false, incidentDigest: "c".repeat(64), opened: 0, recovered: 0, startedAt: "2026-08-20T14:00:00.000Z", sweepId: "22345678-1234-4123-8123-123456789abc" }],
        updatedAt: "2026-08-20T16:00:00.000Z",
      }
      const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16h-acceptance-delivery-probe", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => {
          if (file.endsWith("identity.key")) return identityKey
          if (file.endsWith("telegram-audit-chain.ndjson")) return fs.readFileSync(audit.ledgerPath, "utf8")
          if (file.endsWith("telegram-audit-chain.head.json")) return fs.readFileSync(audit.headPath, "utf8")
          if (file.endsWith("sanctuary-health.json")) return JSON.stringify(health)
          if (file.endsWith("sanctuary.crontab")) return "not canonical"
          throw missing
        },
      } as never, root, { skipContainerSnapshot: true })
      expect(facts.digest).toBeUndefined()
      expect(facts.cron?.registered).toBe(false)
      expect(facts.postbootIntegrity.audits[0]).toMatchObject({ scenarioHandleDigest: null, scenarioRelevant: false })
      expect(facts.postbootIntegrity.sweeps[0]).toMatchObject({ scenarioHandleDigest: digest, deliveryIdDigest: null })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers denial receipt restart projection and non-denial binding", async () => {
    const digest = "a".repeat(64)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-denial-receipt-projection-"))
    const boundaryFact = { ownerSnapshotDigest: "1".repeat(64), targetSnapshotDigest: "2".repeat(64), targetRestartCount: 0, targetContainerIdDigest: "3".repeat(64), auditCursorDigest: "4".repeat(64), providerUsageCursorDigest: "5".repeat(64), sessionCursorDigest: "6".repeat(64), toolActionCursorDigest: "7".repeat(64) }
    const receipt = { schemaVersion: "sanctuary-read-only-denial-receipt-v1", phase: "complete", label: "unit-16e-2-restart-denial", scenarioHandleDigest: digest, operation: "restart", targetDigest: "3".repeat(64), attemptCount: 1, httpStatus: 403, errorCode: "PERMISSION_DENIED", before: boundaryFact, after: boundaryFact }
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const deps = { readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch, readFixedFile: (file: string) => file.includes("denial-receipts") ? JSON.stringify(receipt) : (() => { throw missing })() }
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16e-2-restart-denial", digest, deps as never, root, { skipContainerSnapshot: true })
      expect(facts.containment.restartDenied).toBe(true)
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, deps as never, root, { skipContainerSnapshot: true })).rejects.toThrow("receipt binding is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("projects a proposed approval with no continuation, callbacks, or string target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-proposed-approval-"))
    const digest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const databasePath = path.join(root, "state/approvals/approvals.sqlite")
    const store = openApprovalStore({ databasePath, now: () => new Date("2026-08-20T16:00:00.000Z"), randomUUID: () => "11111111-1111-4111-8111-111111111111", randomBytes: (size) => Buffer.alloc(size, 8) })
    const prepared = store.prepare({
      toolCallId: "call", toolName: "unraid_restart_container", arguments: { container: 42 }, schemaDigest: "1".repeat(64), toolDigest: "2".repeat(64), policyDigest: "3".repeat(64), policyId: "policy",
      sessionKey: "telegram:test", sessionPath: "/tmp/session", baseSessionRevision: "4".repeat(64), checkpointDigest: "5".repeat(64), requesterId: `tg_${"q".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", expiresAt: "2026-08-20T16:05:00.000Z", scenarioHandleDigest: digest,
      frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "unraid_restart_container", arguments: "{\"container\":42}" } }] },
    })
    store.close()
    const audit = createTelegramAuditLedger({ root, identityKey })
    const terminal = { actionDigest: "6".repeat(64), approvalId: prepared.record.approvalId, boundAt: "2026-08-20T16:00:00.000Z", buttonsRemoved: true, checkpointDigest: prepared.record.checkpointDigest, messageIdDigest: "7".repeat(64), scenarioHandleDigest: digest, suspendedSessionRevisionDigest: "8".repeat(64), targetDigest: "9".repeat(64), terminalEditStartedAt: "2026-08-20T16:00:01.000Z", terminalizedAt: "2026-08-20T16:00:02.000Z" }
    audit.append({ ts: "2026-08-20T16:00:02.000Z", level: "info", event: "telegram.approval_prompt_terminalized", component: "senses", trace_id: "t1", message: "terminal", meta: { ...terminal, evidenceMac: sanctuaryTelegramApprovalEvidenceMac(identityKey, "telegram.approval_prompt_terminalized", terminal) } })
    const callback = { accepted: false, acknowledged: true, acknowledgementState: "expired", actionDigest: "6".repeat(64), approvalId: prepared.record.approvalId, boundAt: "2026-08-20T16:00:00.000Z", callbackAt: "2026-08-20T16:00:03.000Z", checkpointDigest: prepared.record.checkpointDigest, decisionAttemptDigest: "a".repeat(64), messageIdDigest: "7".repeat(64), reason: "expired", scenarioHandleDigest: digest, suspendedSessionRevisionDigest: "8".repeat(64), targetDigest: "9".repeat(64) }
    audit.append({ ts: "2026-08-20T16:00:03.000Z", level: "info", event: "telegram.callback_settled", component: "senses", trace_id: "t2", message: "expired", meta: { ...callback, evidenceMac: sanctuaryTelegramApprovalEvidenceMac(identityKey, "telegram.callback_settled", callback) } })
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16i-delayed-approval", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        telegramCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => {
          if (file.endsWith("identity.key")) return identityKey
          if (file.endsWith("telegram-audit-chain.ndjson")) return fs.readFileSync(audit.ledgerPath, "utf8")
          if (file.endsWith("telegram-audit-chain.head.json")) return fs.readFileSync(audit.headPath, "utf8")
          throw missing
        },
      } as never, root, { skipContainerSnapshot: true })
      expect(facts.approvals[0]).toMatchObject({ target: null, continuationEpoch: null, continuationState: null, staleAcknowledged: true, buttonsRemoved: true, replayMutationCount: 0 })
      const later = openApprovalStore({ databasePath, now: () => new Date("2026-08-20T16:01:00.000Z") })
      later.activate({ approvalId: prepared.record.approvalId, checkpointDigest: prepared.record.checkpointDigest, suspendedSessionRevision: "8".repeat(64) })
      later.bindPrompt({ approvalId: prepared.record.approvalId, transport: "telegram", transportChatId: "42", transportMessageId: "101" })
      const claim = later.decide({ approvalId: prepared.record.approvalId, decisionToken: prepared.decisionToken, decision: "approve", requesterId: `tg_${"q".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", transportMessageId: "101", sessionKey: "telegram:test", ownerId: "worker" })
      later.markAttempted({ approvalId: prepared.record.approvalId, ownerId: claim.ownerId!, epoch: claim.epoch })
      later.complete({ approvalId: prepared.record.approvalId, ownerId: claim.ownerId!, epoch: claim.epoch, state: "succeeded", result: JSON.stringify({ ok: true, data: { container: { id: "id", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: false, degraded: false } }) })
      later.close()
      await expect(readDefaultSanctuaryScenarioFacts("unit-16i-delayed-approval", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        telegramCredentials: () => ({ botToken: "x", authorizedUserId: "42", authorizedChatId: "42" }),
        readFixedFile: (file) => file.endsWith("identity.key") ? identityKey : file.endsWith("telegram-audit-chain.ndjson") ? fs.readFileSync(audit.ledgerPath, "utf8") : file.endsWith("telegram-audit-chain.head.json") ? fs.readFileSync(audit.headPath, "utf8") : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("approved restart result binding is invalid")
      const other = "b".repeat(64)
      const invalidJsonStore = openApprovalStore({ databasePath, now: () => new Date("2026-08-20T16:02:00.000Z"), randomUUID: () => "22222222-2222-4222-8222-222222222222", randomBytes: (size) => Buffer.alloc(size, 9) })
      const invalid = invalidJsonStore.prepare({ toolCallId: "invalid", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, schemaDigest: "1".repeat(64), toolDigest: "2".repeat(64), policyDigest: "3".repeat(64), policyId: "policy", sessionKey: "telegram:invalid", sessionPath: "/tmp/invalid", baseSessionRevision: "4".repeat(64), checkpointDigest: "5".repeat(64), requesterId: `tg_${"q".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", expiresAt: "2026-08-20T16:05:00.000Z", scenarioHandleDigest: other, frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "invalid", type: "function", function: { name: "unraid_restart_container", arguments: "{\"container\":\"calibre-web\"}" } }] } })
      invalidJsonStore.activate({ approvalId: invalid.record.approvalId, checkpointDigest: invalid.record.checkpointDigest, suspendedSessionRevision: "8".repeat(64) })
      invalidJsonStore.bindPrompt({ approvalId: invalid.record.approvalId, transport: "telegram", transportChatId: "42", transportMessageId: "102" })
      const invalidClaim = invalidJsonStore.decide({ approvalId: invalid.record.approvalId, decisionToken: invalid.decisionToken, decision: "approve", requesterId: `tg_${"q".repeat(43)}`, transport: "telegram", transportUserId: "42", transportChatId: "42", transportMessageId: "102", sessionKey: "telegram:invalid", ownerId: "worker-invalid" })
      invalidJsonStore.markAttempted({ approvalId: invalid.record.approvalId, ownerId: invalidClaim.ownerId!, epoch: invalidClaim.epoch })
      invalidJsonStore.complete({ approvalId: invalid.record.approvalId, ownerId: invalidClaim.ownerId!, epoch: invalidClaim.epoch, state: "succeeded", result: "{" })
      invalidJsonStore.close()
      await expect(readDefaultSanctuaryScenarioFacts("unit-16i-delayed-approval", other, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch, telegramCredentials: () => ({ botToken: "x", authorizedUserId: "42", authorizedChatId: "42" }), readFixedFile: (file) => file.endsWith("identity.key") ? identityKey : file.endsWith("telegram-audit-chain.ndjson") ? fs.readFileSync(audit.ledgerPath, "utf8") : file.endsWith("telegram-audit-chain.head.json") ? fs.readFileSync(audit.headPath, "utf8") : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("approved restart result binding is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers reboot checkpoint and restored digest projection polarities", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-reboot-projection-"))
    const digest = "a".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const checkpoint = { operation: "reboot", phase: "requested", requestId: "b".repeat(64), prebootDigest: "c".repeat(64), processBindingDigest: "d".repeat(64), unrelatedHostOperations: 0, prebootIntegrity: [] }
    const health = {
      deliveredReceipts: [{ deliveredAt: "2026-08-20T16:00:01.000Z", deliveryId: "delivery", kind: "transition_and_digest", messageIds: [1] }], incidents: {}, indeterminateDeliveries: [], lastDigestDay: "2026-08-20", outbox: null,
      sweepReceipts: [{ completedAt: "2026-08-20T16:00:00.000Z", deliveryId: "delivery", digestDue: true, incidentDigest: "e".repeat(64), opened: 0, recovered: 0, scenarioHandleDigest: digest, startedAt: "2026-08-20T15:59:00.000Z", sweepId: "12345678-1234-4123-8123-123456789abc" }], updatedAt: "2026-08-20T16:00:01.000Z",
    }
    const owner = { schemaVersion: 1, containerId: "1".repeat(64), imageId: `sha256:${"2".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", liveProcessUser: "10001:10001", processBindingDigest: "3".repeat(64), readOnlyRoot: true, mountCount: 2, mountsDigest: "4".repeat(64), mountsExact: true, publishedPortCount: 0, networkMode: "host", securityExact: true, writableKeyExposure: false, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false, recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true } }
    const deps = (prebootIntegrity: unknown) => ({
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      readFixedFile: (file: string) => {
        if (file === "/evidence/reboot.json") return JSON.stringify({ ...checkpoint, prebootIntegrity })
        if (file.endsWith("sanctuary-health.json")) return JSON.stringify(health)
        if (file.endsWith("sanctuary.crontab")) return "present but noncanonical"
        throw missing
      },
    })
    try {
      const sparse = await readDefaultSanctuaryScenarioFacts("unit-16h-acceptance-delivery-probe", digest, deps([]) as never, root, { skipContainerSnapshot: true })
      expect(sparse.reboot).toMatchObject({ phase: "requested", hostReady: false })
      const restored = await readDefaultSanctuaryScenarioFacts("unit-16h-acceptance-delivery-probe", digest, deps({ schemaVersion: "sanctuary-postboot-integrity-v2" }) as never, root, { containerSnapshot: owner })
      expect(restored.digest).toMatchObject({ scheduleObserved: false, productionRestored: true, messageCount: 1 })
      expect(restored.reboot).toMatchObject({ hostReady: true, butlerReady: true })
      const unhealthy = await readDefaultSanctuaryScenarioFacts("unit-16h-acceptance-delivery-probe", digest, deps({}) as never, root, { containerSnapshot: { ...owner, running: false, health: "unhealthy" } })
      expect(unhealthy.digest?.productionRestored).toBe(false)
      const cronOnly = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
        readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
        readFixedFile: (file) => file.endsWith("sanctuary.crontab") ? "noncanonical" : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })
      expect(cronOnly.cron?.registered).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("covers grounding selection, default Telegram credentials, and foreign turn filtering", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-grounding-selection-"))
    const digest = "a".repeat(64)
    const other = "b".repeat(64)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const turn = { schemaVersion: "sanctuary-telegram-turn-receipt-v3", scenarioHandleDigest: other, status: "success", errorCategory: null, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64), toolResultDigests: [], deliveries: [], providerInvocationCount: 0, toolInvocationCount: 0, deliveryCount: 0, completedAt: "2026-08-20T16:00:00.000Z" }
    const observed: string[] = []
    const base = {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      readFixedFile: (file: string) => file.endsWith("telegram-turns.ndjson") ? `${JSON.stringify(turn)}\n` : (() => { throw missing })(),
      readLiveGrounding: async (name: string) => { observed.push(name); return { toolName: name, groundingDigest: digest, sourceIdentityDigest: digest, observedAt: "2026-08-20T16:00:00.000Z", facts: {} } },
    }
    try {
      await readDefaultSanctuaryScenarioFacts("unit-16d-whats-up", digest, base as never, root, { skipContainerSnapshot: true })
      await readDefaultSanctuaryScenarioFacts("unit-16d-1-space", digest, base as never, root, { skipContainerSnapshot: true })
      const ordinary = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, base as never, root, { skipContainerSnapshot: true })
      expect(observed).toEqual(["unraid_get_system", "unraid_get_storage"])
      expect(ordinary.telegramTurns).toEqual([])
      const errorTurn = { ...turn, scenarioHandleDigest: digest, status: "error", errorCategory: "provider_failure" }
      const errorFacts = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
        ...base, readFixedFile: (file: string) => file.endsWith("telegram-turns.ndjson") ? `${JSON.stringify(errorTurn)}\n` : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })
      expect(errorFacts.telegramTurns).toHaveLength(1)
      const unauthenticatedGrounded = { ...turn, schemaVersion: "sanctuary-telegram-turn-receipt-v4", scenarioHandleDigest: digest, receiptMac: "4".repeat(64), toolGroundings: [] }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
        ...base, readFixedFile: (file: string) => file.endsWith("telegram-turns.ndjson") ? `${JSON.stringify(unauthenticatedGrounded)}\n` : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).rejects.toThrow("turn receipt ledger row is invalid")

      boundary.machineRuntime = { ok: true, config: { telegramBotToken: "12345:abcdefghijklmnopqrst", telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42" } }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", digest, {
        ...base, readFixedFile: (file: string) => file.endsWith("identity.key") ? `${"k".repeat(43)}\n` : (() => { throw missing })(),
      } as never, root, { skipContainerSnapshot: true })).resolves.toBeTruthy()

      boundary.mode = "ungrounded"
      const defaults = createSanctuaryAcceptanceAdapterDependencies(3, { hostRequest: async () => ({}) })
      await expect(defaults.readLiveGrounding!("unraid_get_system")).rejects.toThrow("must succeed")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("rejects health-probe manifest, scheduler, and clock polarity violations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-polarity-"))
    const digest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    const read = (label: "unit-16f-cron-fingerprint" | "unit-16g-health-transition" | "unit-16h-acceptance-delivery-probe", receipt: unknown) => readDefaultSanctuaryScenarioFacts(label, digest, {
      readKeyFiles: () => [], readDescriptor: () => "", execFile: async () => ({ status: 0, stdout: "" }), fetch,
      telegramCredentials: () => ({ botToken: "x", authorizedUserId: "42", authorizedChatId: "42" }),
      readFixedFile: (file) => file.endsWith("identity.key") ? identityKey : file.includes("health-probe-receipts") ? JSON.stringify(receipt) : (() => { throw missing })(),
    } as never, root, { skipContainerSnapshot: true })
    try {
      const cron = cronHealthProbeReceipt(digest)
      const scheduler = (cron.schedulerReceipt as Record<string, any>)
      await expect(read("unit-16f-cron-fingerprint", { ...cron, schedulerReceipt: { ...scheduler, supervisor: { ...scheduler.supervisor, manifest: null } } })).rejects.toThrow("scheduler liveness receipt is invalid")
      await expect(read("unit-16h-acceptance-delivery-probe", healthProbeReceipt(digest, { schedulerReceipt: {} }))).rejects.toThrow("unexpected scheduler receipt")
      await expect(read("unit-16g-health-transition", healthProbeReceipt(digest, { label: "unit-16g-health-transition", clockMode: "local-daily-boundary" }))).rejects.toThrow("clock mode is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

})
