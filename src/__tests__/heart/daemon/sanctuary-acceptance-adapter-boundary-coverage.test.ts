import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createServer } from "node:net"

import { beforeEach, describe, expect, it, vi } from "vitest"

const boundary = vi.hoisted(() => ({
  controlOutput: "",
  mode: "success" as "success" | "bad-outcome" | "duplicate-control" | "invalid-control",
  sourceIdentityDigest: "9".repeat(64),
  agentRoot: "/tmp/sanctuary-adapter-boundary-unset",
  machineRuntime: { ok: false, reason: "missing", itemPath: "vault:missing", error: "missing" } as Record<string, unknown>,
}))

vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => boundary.agentRoot }))

vi.mock("../../../heart/runtime-credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/runtime-credentials")>(),
  readMachineRuntimeCredentialConfig: () => boundary.machineRuntime,
}))

vi.mock("../../../senses/sanctuary-runtime", () => ({
  createSanctuaryToolContext: () => ({ sanctuary: {
    getSystem: async () => ({ ok: true, data: { sourceIdentityDigest: boundary.sourceIdentityDigest, serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", uptimeSeconds: 10, degraded: false } }),
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
    runtime.appendToolOutput("sanctuary-valid-system", boundary.controlOutput)
    options.toolBoundaryObserver({ name: "unraid_get_system", reason: "dispatched", invoked: true, sideEffect: false })
    if (boundary.mode === "duplicate-control") options.toolBoundaryObserver({ name: "unraid_get_system", reason: "dispatched", invoked: true, sideEffect: false })
    options.toolBoundaryObserver({ name: "settle", reason: "dispatched", invoked: true, sideEffect: false })
    await runtime.streamTurn()
    await runtime.streamTurn()
    await runtime.streamTurn()
    runtime.resetTurnState()
    await runtime.ping()
    runtime.classifyError(new Error("synthetic"))
    return { outcome: boundary.mode === "bad-outcome" ? "failed" : "settled" }
  },
}))

import {
  createSanctuaryAcceptanceAdapterDependencies,
  createSanctuaryInteractiveAcceptanceScenarioDriver,
  createSanctuaryReadOnlyDenialScenarioDriver,
  executeSanctuaryAcceptanceAdapter,
  readDefaultSanctuaryScenarioFacts,
  runSanctuaryProductionBoundaryProbe,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"
import { SANCTUARY_SCENARIO_GATES, SANCTUARY_SCENARIO_SOURCES } from "../../../heart/daemon/sanctuary-acceptance-harness"

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
    expect(() => deps.telegramCredentials!()).toThrow()
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

  it("derives daily digest evidence from valid health receipts", async () => {
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
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16h-daily-digest", scenario, {
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
})
