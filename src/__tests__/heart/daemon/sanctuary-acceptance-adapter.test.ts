import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createServer } from "node:net"
import { createHash, createHmac } from "node:crypto"

import { describe, expect, it, vi } from "vitest"
import { openApprovalStore } from "../../../heart/approval-store"
import { sanctuaryTelegramAuditLifecycleMac, sanctuaryTelegramTurnReceiptDigest, sanctuaryTelegramTurnReceiptMac, sanctuaryTelegramUnauthorizedDropMac } from "../../../senses/telegram"
import { createTelegramAuditLedger } from "../../../senses/telegram-audit-ledger"
import * as sanctuaryAcceptanceAdapter from "../../../heart/daemon/sanctuary-acceptance-adapter"
import { SANCTUARY_SCENARIO_GATES, SANCTUARY_SCENARIO_SOURCES } from "../../../heart/daemon/sanctuary-acceptance-harness"

import {
  createSanctuaryAcceptanceAdapterDependencies,
  createSanctuaryInteractiveAcceptanceScenarioDriver,
  createSanctuaryReadOnlyDenialScenarioDriver,
  createSanctuaryAcceptanceVaultProbeDependencies,
  auditContainsSensitiveMaterial,
  canonicalDockerIdFromUnraidPrefixedId,
  executeSanctuaryAcceptanceCallbackProbe,
  executeSanctuaryInteractiveRuntimeOperation,
  executeSanctuaryAcceptanceAdapter,
  executeSanctuaryAcceptanceRevokedProbe,
  executeSanctuaryAcceptanceVaultProbe,
  evaluateSanctuaryProviderReadinessContract,
  proveAttemptedRecoveryWithoutRetry,
  readDefaultSanctuaryScenarioFacts,
  runSanctuaryProductionBoundaryProbe,
  type SanctuaryAcceptanceAdapterDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"
import { sanctuarySchedulerLivenessReceiptMac } from "../../../heart/daemon/sanctuary-scheduler-liveness"

const READ_QUERY = "query AcceptanceAuthProbe { info { os { hostname } } }"
const WRITE_QUERY = "mutation AcceptanceWriteProbe($id: PrefixedID!) { docker { restart(id: $id) { id } } }"
const MISSING_CONTAINER_ID = "Docker:ouro-acceptance-guaranteed-missing"
const READ_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => ({ resource, actions: ["READ_ANY"] }))
const AUDIT_PATH = "/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-audit-chain.ndjson"
const AUDIT_HEAD_PATH = "/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-audit-chain.head.json"

function chainedAuditFiles(agentRoot: string, raw: string, identityKey = "k".repeat(43)): Record<string, string> {
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-audit-fixture-"))
  const ledger = createTelegramAuditLedger({ root: ledgerRoot, identityKey })
  for (const [index, line] of raw.split("\n").filter(Boolean).entries()) {
    const entry = JSON.parse(line) as { ts: string; event: string; meta: Record<string, unknown> }
    ledger.append({ ts: entry.ts, level: "info", component: "senses", event: entry.event, trace_id: `fixture-${index}`, message: "fixture", meta: entry.meta })
  }
  const files = {
    [AUDIT_PATH]: fs.readFileSync(ledger.ledgerPath, "utf8"),
    [AUDIT_HEAD_PATH]: fs.readFileSync(ledger.headPath, "utf8"),
    [`${agentRoot}/state/senses/telegram/identity.key`]: `${identityKey}\n`,
  }
  fs.rmSync(ledgerRoot, { recursive: true, force: true })
  return files
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function refreshed(config: Record<string, unknown>) {
  return {
    ok: true as const,
    itemPath: "vault:opaque",
    revision: "opaque",
    updatedAt: "2026-08-20T00:00:00.000Z",
    config,
  }
}

function validHealthProbeReceipt(scenarioHandleDigest: string, patch: Record<string, unknown> = {}) {
  const phases = [
    { ordinal: 1, name: "digest-first", trigger: "acceptance", fixtureStatus: 503, opened: 0, recovered: 0, digestDue: true, deliveryKind: "digest", sweepReceiptDigest: "5".repeat(64), deliveryReceiptDigest: "6".repeat(64) },
    { ordinal: 2, name: "digest-repeat", trigger: "acceptance", fixtureStatus: 503, opened: 0, recovered: 0, digestDue: false, deliveryKind: null, sweepReceiptDigest: "7".repeat(64), deliveryReceiptDigest: null },
  ]
  return {
    schemaVersion: "sanctuary-health-probe-receipt-v1", label: "unit-16h-daily-digest", scenarioHandleDigest,
    ownerImageDigestBefore: "1".repeat(64), ownerImageDigestAfter: "1".repeat(64), ownerContainerDigestBefore: "2".repeat(64), ownerContainerDigestAfter: "2".repeat(64),
    beforeStateDigest: "3".repeat(64), restoredStateDigest: "3".repeat(64), cronFingerprintBefore: "4".repeat(64), cronFingerprintAfter: "4".repeat(64),
    cronRegisteredBefore: true, cronRegisteredAfter: true, cronDegradedBefore: false, cronDegradedAfter: false,
    fixtureSequenceDigest: createHash("sha256").update(JSON.stringify([503, 503])).digest("hex"), clockMode: "local-daily-boundary", effectiveNow: "2026-08-20T16:00:00.000Z",
    phases, privateTurnCount: 1, providerInvocationCount: 2, deliveryCount: 1, workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true, schedulerReceipt: null,
    ...patch,
  }
}

function validCronHealthProbeReceipt(scenarioHandleDigest: string) {
  const phase = { ordinal: 1, name: "cron-unchanged", trigger: "cron", fixtureStatus: null, opened: 0, recovered: 0, digestDue: false, deliveryKind: null, sweepReceiptDigest: "5".repeat(64), deliveryReceiptDigest: null }
  return validHealthProbeReceipt(scenarioHandleDigest, {
    label: "unit-16f-cron-fingerprint", clockMode: "ambient", effectiveNow: "2026-08-20T15:00:00.000Z", phases: [phase],
    fixtureSequenceDigest: createHash("sha256").update(JSON.stringify([])).digest("hex"), privateTurnCount: 0, providerInvocationCount: 0, deliveryCount: 0,
    schedulerReceipt: (() => {
      const unsigned = {
      schemaVersion: "sanctuary-scheduler-liveness-receipt-v1", label: "unit-16f-cron-fingerprint", scenarioHandleDigest, trigger: "cron",
      occurrenceId: "cron:2026-08-20T15:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", recordedAt: "2026-08-20T15:00:01.000Z",
      before: { sweepCount: 0, deliveryCount: 0 }, after: { sweepCount: 1, deliveryCount: 0 }, sweepDelta: 1, deliveryDelta: 0,
      providerInvocationCount: 0, privateTurnCount: 0, sweep: { recordDigest: phase.sweepReceiptDigest, opened: 0, recovered: 0, digestDue: false, deliveryId: null },
      supervisor: {
        schemaVersion: "supercronic-supervisor-snapshot-v1", daemonPid: 1, childCount: 1, childPid: 42, healthy: true,
        binaryPath: "/usr/local/bin/supercronic", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"],
        crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab", namespace: "habit:sanctuary",
        manifest: [{ id: "sanctuary:sanctuary-health", agent: "sanctuary", taskId: "sanctuary-health", schedule: "*/15 * * * *", lastRun: null, command: "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron", taskPath: "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md" }],
        renderedCrontab: "# ouro:habit:sanctuary:sanctuary:sanctuary-health\n",
      },
      schedulerOrigin: { slot: "2026-08-20T15:00:00.000Z", occurrenceId: "cron:2026-08-20T15:00:00.000Z", schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "c".repeat(64), scenarioHandleDigest },
      nonReplay: true,
      }
      return { ...unsigned, receiptMac: sanctuarySchedulerLivenessReceiptMac("k".repeat(43), unsigned) }
    })(),
  })
}

function validOwnerSnapshot(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    containerId: "2".repeat(64),
    imageId: `sha256:${"1".repeat(64)}`,
    running: true,
    health: "healthy",
    user: "10001:10001",
    liveProcessUser: "10001:10001",
    processBindingDigest: "4".repeat(64),
    readOnlyRoot: true,
    mountCount: 2,
    mountsDigest: "3".repeat(64),
    mountsExact: true,
    publishedPortCount: 0,
    networkMode: "host",
    securityExact: true,
    writableKeyExposure: false,
    restartPolicy: "unless-stopped",
    restartCount: 0,
    autostartExact: true,
    updaterDisabled: true,
    vaultUnlocked: true,
    manualAuthRequired: false,
    recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
    ...patch,
  }
}

function validDenialReceipt(label: "unit-16e-1-stop-denial" | "unit-16e-2-restart-denial", scenarioHandleDigest: string) {
  const targetContainerIdDigest = "7".repeat(64)
  const boundary = {
    ownerSnapshotDigest: "1".repeat(64), targetSnapshotDigest: "2".repeat(64), targetRestartCount: 7,
    targetContainerIdDigest,
    auditCursorDigest: "3".repeat(64), providerUsageCursorDigest: "4".repeat(64),
    sessionCursorDigest: "5".repeat(64), toolActionCursorDigest: "6".repeat(64),
  }
  return {
    schemaVersion: "sanctuary-read-only-denial-receipt-v1", phase: "complete", label, scenarioHandleDigest,
    operation: label === "unit-16e-1-stop-denial" ? "stop" : "restart", targetDigest: targetContainerIdDigest,
    attemptCount: 1, httpStatus: 403, errorCode: "FORBIDDEN", before: boundary, after: { ...boundary },
  }
}

function validInteractiveReceipt(label: "unit-16k-timeout-stale" | "unit-16l-duplicate-callback" | "unit-16m-restart-continuation", scenarioHandleDigest: string) {
  const common = {
    schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label, scenarioHandleDigest,
    approvalIdDigest: "1".repeat(64), checkpointDigest: "2".repeat(64), suspendedSessionRevisionDigest: "3".repeat(64), approvalEpochBefore: 0,
  }
  if (label === "unit-16k-timeout-stale") return {
    ...common, schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1", callbackAttempts: 1, distinctQueryCount: 1,
    callbackDataDigest: "4".repeat(64), settledCount: 1, claimCount: 0, mutationCount: 0, staleAcknowledged: true, promptTerminal: true,
  }
  return label === "unit-16l-duplicate-callback" ? {
    ...common, callbackAttempts: 2, distinctQueryCount: 2, callbackDataDigest: "4".repeat(64), barrierObserved: true,
    settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true,
    staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false,
  } : {
    ...common, approvalEpochAfterRestart: 0, continuationEpochAfter: 1, ownerImageDigest: "4".repeat(64), ownerContainerDigest: "5".repeat(64),
    restartCountBefore: 7, restartCountAfter: 8, pendingDigestBefore: "6".repeat(64), pendingDigestAfter: "6".repeat(64), pendingRestored: true,
    callbackAttempts: 1, mutationCount: 1, indeterminateRecoveryObserved: true, indeterminateRetryCount: 0,
  }
}

describe("Sanctuary acceptance adapter semantic proofs", () => {
  it("uses the production repertoire dispatcher for its valid boundary control", () => {
    const source = runSanctuaryProductionBoundaryProbe.toString()
    expect(source).not.toContain("execTool:")
    expect(source).not.toContain("definition.handler")
    expect(source).toContain("runWithSanctuaryToolReceiptCollection")
  })

  it("maps only the exact official Unraid PrefixedID to its underlying Docker ID", () => {
    const serverId = "a".repeat(64)
    const dockerId = "b".repeat(64)
    expect(canonicalDockerIdFromUnraidPrefixedId(`${serverId}:${dockerId}`)).toBe(dockerId)
    for (const invalid of [dockerId, `${dockerId}:${serverId}:extra`, `${serverId}:calibre-web`, `${serverId.toUpperCase()}:${dockerId}`, `:${dockerId}`]) {
      expect(() => canonicalDockerIdFromUnraidPrefixedId(invalid)).toThrow(/PrefixedID/u)
    }
  })
  it("persists one denial attempt and never reissues it after success or an indeterminate interruption", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-denial-driver-"))
    const scenarioHandleDigest = "a".repeat(64)
    const runProbe = vi.fn(async () => validDenialReceipt("unit-16e-1-stop-denial", scenarioHandleDigest))
    const driver = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: root, runProbe })
    try {
      await expect(driver.poll("unit-16e-1-stop-denial", scenarioHandleDigest)).resolves.toEqual({ state: "driven" })
      await expect(driver.poll("unit-16e-1-stop-denial", scenarioHandleDigest)).resolves.toEqual({ state: "driven" })
      expect(runProbe).toHaveBeenCalledOnce()
      expect(fs.readFileSync(path.join(root, "state/acceptance/denial-receipts", `${scenarioHandleDigest}.json`), "utf8")).not.toContain("private")

      const interruptedDigest = "b".repeat(64)
      const interruptedProbe = vi.fn(async () => { throw new Error("transport interrupted after attempt") })
      const interrupted = createSanctuaryReadOnlyDenialScenarioDriver({ agentRoot: root, runProbe: interruptedProbe })
      await expect(interrupted.poll("unit-16e-2-restart-denial", interruptedDigest)).rejects.toThrow("transport interrupted")
      await expect(interrupted.poll("unit-16e-2-restart-denial", interruptedDigest)).rejects.toThrow(/inspect-before-retry/u)
      await expect(interrupted.poll("unit-16e-2-restart-denial", "c".repeat(64))).rejects.toThrow(/inspect-before-retry/u)
      expect(interruptedProbe).toHaveBeenCalledOnce()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("exact-parses a scenario-bound denial receipt and rejects any restart or cursor drift", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-denial-receipt-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = path.join(root, "state/acceptance/denial-receipts", `${scenarioHandleDigest}.json`)
    const receipt = validDenialReceipt("unit-16e-2-restart-denial", scenarioHandleDigest)
    const deps = unit16Deps({
      readFixedFile: (file) => { if (file === receiptPath) return JSON.stringify(receipt); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      hostRequest: async () => validOwnerSnapshot(),
    })
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16e-2-restart-denial", scenarioHandleDigest, deps, root)
      expect((facts as any).denial).toEqual(receipt)
      const drifted = { ...receipt, after: { ...receipt.after, targetRestartCount: 8 } }
      deps.readFixedFile = (file) => { if (file === receiptPath) return JSON.stringify(drifted); throw Object.assign(new Error("missing"), { code: "ENOENT" }) }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16e-2-restart-denial", scenarioHandleDigest, deps, root)).rejects.toThrow(/boundary drift/u)
      const mismatchedTarget = { ...receipt, targetDigest: "8".repeat(64) }
      deps.readFixedFile = (file) => { if (file === receiptPath) return JSON.stringify(mismatchedTarget); throw Object.assign(new Error("missing"), { code: "ENOENT" }) }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16e-2-restart-denial", scenarioHandleDigest, deps, root)).rejects.toThrow(/target/u)
      const changedTarget = { ...receipt, after: { ...receipt.after, targetContainerIdDigest: "8".repeat(64) } }
      deps.readFixedFile = (file) => { if (file === receiptPath) return JSON.stringify(changedTarget); throw Object.assign(new Error("missing"), { code: "ENOENT" }) }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16e-2-restart-denial", scenarioHandleDigest, deps, root)).rejects.toThrow(/target|drift/u)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it.each([
    ['{"meta":{"update_id":8541786263}}', undefined],
    ['{"meta":{"messageId":"8541786263"}}', undefined],
    ['{"meta":{"error":"provider rejected bearer sk-live-secret-material"}}', undefined],
    ['{"meta":{"note":"authorized subject 123456789"}}', { botToken: "12345:private-token-value", authorizedUserId: "123456789", authorizedChatId: "987654321" }],
  ] as const)("detects forbidden Telegram/provider material in audit text %#", (raw, credentials) => {
    expect(auditContainsSensitiveMaterial(raw, credentials)).toBe(true)
  })

  it("captures exact redacted Unit-16e containment evidence from packaged profiles, host inventory, audit, and container policy", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-containment-audit-"))
    const scenarioHandleDigest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const telegramTools = ["unraid_list_containers", "unraid_get_container_logs", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system", "unraid_restart_container", "ponder", "settle", "speak"]
    const privateTools = ["send_message", "rest"]
    const lifecycle = (event: string, ts: string, meta: Record<string, unknown>) => ({ ts, event, meta: { ...meta, lifecycleMac: sanctuaryTelegramAuditLifecycleMac(identityKey, "sanctuary-telegram-turn-receipt-v3", event, meta) } })
    const audit = [
      lifecycle("senses.telegram_turn_start", "2026-08-20T16:00:00.000Z", { scenarioHandleDigest }),
      lifecycle("senses.telegram_turn_end", "2026-08-20T16:00:01.000Z", { scenarioHandleDigest, deliveryCount: 1 }),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    const files: Record<string, string> = {
      ...chainedAuditFiles(agentRoot, audit, identityKey),
      "/opt/ouro/deploy/unraid/sanctuary.ouro/tool-profiles.json": JSON.stringify({ version: 1, profiles: { "sanctuary-telegram": telegramTools, "sanctuary-health-private": privateTools } }),
    }
    const hostRequest = vi.fn(async (payload: Record<string, unknown>) => payload.operation === "inventory_keys" ? { keys: [
      { id: "ro-private-id", name: "Butler RO", permissions: READ_PERMISSIONS, roles: [] },
      { id: "rw-private-id", name: "Butler RW", permissions: [...READ_PERMISSIONS, { resource: "DOCKER", actions: ["UPDATE_ANY"] }], roles: [] },
    ] } : validOwnerSnapshot())
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16e-containment-audit", scenarioHandleDigest, unit16Deps({
        readFixedFile: (file) => { if (file in files) return files[file]!; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
        telegramCredentials: () => ({ botToken: "123:token", authorizedUserId: "123456789", authorizedChatId: "987654321" }),
        hostRequest,
      }), agentRoot)
      expect(hostRequest).toHaveBeenCalledWith({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" })
      expect(facts.containment).toMatchObject({
        schemaVersion: "sanctuary-containment-audit-v1",
        keyCount: 2, keyRoleAssignmentCount: 0,
        telegramToolCount: 10, privateToolCount: 2, resolvedHandlerCount: 12,
        excludedToolCount: 7, excludedSchemaIntersectionCount: 0, fabricatedHandlerInvocationCount: 0, excludedToolAttemptCount: 7, excludedToolRejectedCount: 7, excludedToolInvokedCount: 0, excludedToolSideEffectCount: 0, globallyResolvableExcludedToolCount: expect.any(Number),
        auditRecordCount: 2, auditLifecyclePairCount: 1,
        containerUser: "10001:10001", liveProcessUser: "10001:10001", mountCount: 2, publishedPortCount: 0, networkMode: "host",
        readOnlyRoot: true, mountsExact: true, securityExact: true, updaterDisabled: true, writableKeyExposure: false,
        rawWriteMaterialFieldCount: 0, typedWriteExecutorCount: 1, sensitiveMaterialObserved: false,
      })
      for (const field of ["keyInventoryDigest", "readScopeDigest", "writeScopeDigest", "telegramSchemaDigest", "privateSchemaDigest", "auditPathDigest", "auditLedgerDigest", "writeApprovalPolicyDigest"] as const) {
        expect(facts.containment?.[field]).toMatch(/^[0-9a-f]{64}$/u)
      }
      expect(facts.sourceValues["containment-audit"]).toEqual(facts.containment)
      expect(facts.containment!.globallyResolvableExcludedToolCount).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(facts.sourceValues["containment-audit"])).not.toMatch(/ro-private-id|rw-private-id|read-only-key/u)
    } finally { fs.rmSync(agentRoot, { recursive: true, force: true }) }
  })

  it("delegates exact current duplicate and restart-continuation proposals to the production-owner broker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-interactive-driver-"))
    const scenarioHandleDigest = "a".repeat(64)
    const approvalRecord = {
      approvalId: "approval-1", state: "proposed", toolName: "unraid_restart_container", arguments: { container: "calibre-web" },
      checkpointDigest: "b".repeat(64), epoch: 0, suspendedSessionRevision: "c".repeat(64), transport: "telegram",
    }
    const pending = [{ approvalId: "approval-1", messageId: "42", deliveryState: "bound", approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: Date.now() + 300_000 }]
    const hostRequests: Array<Record<string, unknown>> = []
    let restartPolls = 0
    let currentLabel = "unit-16k-timeout-stale"
    const driver = createSanctuaryInteractiveAcceptanceScenarioDriver({
      agentRoot: root,
      readApprovals: () => [{ approval: approvalRecord as never, continuation: null }],
      readPending: () => pending,
      hostRequest: async (payload) => {
        hostRequests.push(payload)
        if (payload.label === "unit-16m-restart-continuation") {
          restartPolls += 1
          return restartPolls === 1 ? { state: "waiting" } : { state: "complete", receipt: validInteractiveReceipt(payload.label, scenarioHandleDigest) }
        }
        return validInteractiveReceipt(payload.label as never, scenarioHandleDigest)
      },
    })
    try {
      await expect(driver.poll(currentLabel as never, scenarioHandleDigest)).resolves.toEqual({ state: "driven" })
      currentLabel = "unit-16l-duplicate-callback"
      await expect(driver.poll(currentLabel as never, scenarioHandleDigest)).resolves.toEqual({ state: "driven" })
      currentLabel = "unit-16m-restart-continuation"
      await expect(driver.poll(currentLabel as never, scenarioHandleDigest)).resolves.toEqual({ state: "waiting" })
      await expect(driver.poll(currentLabel as never, scenarioHandleDigest)).resolves.toEqual({ state: "driven" })
      expect(hostRequests).toEqual([
        { operation: "drive_timeout_stale", targetId: "sanctuary", label: "unit-16k-timeout-stale", scenarioHandleDigest },
        { operation: "drive_duplicate_callbacks", targetId: "sanctuary", label: "unit-16l-duplicate-callback", scenarioHandleDigest },
        { operation: "drive_restart_continuation", targetId: "sanctuary", label: "unit-16m-restart-continuation", scenarioHandleDigest },
        { operation: "drive_restart_continuation", targetId: "sanctuary", label: "unit-16m-restart-continuation", scenarioHandleDigest },
      ])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("uses one production callback session for two barrier-released queries and a terminal stale replay", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    const approval = {
      approvalId: "approval-1", state: "proposed", toolName: "unraid_restart_container", arguments: { container: "calibre-web" },
      checkpointDigest: "b".repeat(64), epoch: 0, suspendedSessionRevision: "c".repeat(64), transport: "telegram",
    }
    let terminal = false
    const queries: string[] = []
    const close = vi.fn()
    const createSession = vi.fn(async () => ({
      handle: async ({ queryId }: { queryId: string }) => {
        queries.push(queryId)
        if (!terminal) { terminal = true; return { handled: true, accepted: true, reason: "accepted" } }
        return { handled: true, accepted: false, reason: "stale_callback" }
      },
      pendingApprovalIds: () => terminal ? [] : ["approval-1"],
      close,
    }))
    const receipt = await executeSanctuaryInteractiveRuntimeOperation({
      operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest,
    }, {
      agentRoot: "/unused",
      readApprovals: () => [{ approval: { ...approval, ...(terminal ? { state: "succeeded", epoch: 1 } : {}) } as never, continuation: null }],
      readPending: () => [{ approvalId: "approval-1", messageId: "42", deliveryState: "bound", approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: Date.now() + 300_000 }],
      createSession,
    }) as Record<string, unknown>

    expect(receipt).toMatchObject({ callbackAttempts: 2, distinctQueryCount: 2, barrierObserved: true, settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true, staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false })
    expect(createSession).toHaveBeenCalledOnce()
    expect(new Set(queries.slice(0, 2)).size).toBe(2)
    expect(queries).toHaveLength(3)
    expect(close).toHaveBeenCalledOnce()
  })

  it("prepares an isolated attempted recovery proof and reconciles the restored pending approval once", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    let terminal = false
    const approval = {
      approvalId: "approval-1", state: "proposed", toolName: "unraid_restart_container", arguments: { container: "calibre-web" },
      checkpointDigest: "b".repeat(64), epoch: 0, suspendedSessionRevision: "c".repeat(64), transport: "telegram",
    }
    const common = {
      agentRoot: "/unused",
      readApprovals: () => [{ approval: { ...approval, ...(terminal ? { state: "succeeded", epoch: 1 } : {}) } as never, continuation: terminal ? { continuationEpoch: 1, continuationState: "completed" } as never : null }],
      readPending: () => [{ approvalId: "approval-1", messageId: "42", deliveryState: "bound" as const, approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: Date.now() + 300_000 }],
    }
    const proveIndeterminateRecovery = vi.fn(() => ({ observed: true, retryCount: 0 }))
    await expect(executeSanctuaryInteractiveRuntimeOperation({
      operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest,
    }, { ...common, proveIndeterminateRecovery })).resolves.toMatchObject({ phase: "prepared", pendingDigestBefore: expect.stringMatching(/^[0-9a-f]{64}$/u), indeterminateRecoveryObserved: true })
    expect(proveIndeterminateRecovery).toHaveBeenCalledOnce()

    const handle = vi.fn(async () => { terminal = true; return { handled: true, accepted: true, reason: "accepted" } })
    await expect(executeSanctuaryInteractiveRuntimeOperation({
      operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest,
    }, { ...common, createSession: async () => ({ handle, pendingApprovalIds: () => [], close: vi.fn() }) })).resolves.toMatchObject({
      approvalEpochAfterRestart: 0, continuationEpochAfter: 1, pendingRestored: true, callbackAttempts: 1, mutationCount: 1, indeterminateRetryCount: 0,
    })
    expect(handle).toHaveBeenCalledOnce()
  })

  it("proves attempted recovery with the production transition and makes the second recovery ineligible", () => {
    const result = proveAttemptedRecoveryWithoutRetry({
      approvalId: "approval-isolated", state: "proposed", ownerId: null, epoch: 0, attemptedAt: null,
      updatedAt: "2026-08-20T00:00:00.000Z",
    } as never)
    expect(result).toEqual({ observed: true, retryCount: 0 })
  })

  it("executes the fixed in-container interactive operations without accepting extra coordinates", async () => {
    const interactiveRuntime = vi.fn(async (payload: Record<string, unknown>) => ({ phase: payload.operation }))
    const deps = unit16Deps({ interactiveRuntime } as never)
    const scenarioHandleDigest = "a".repeat(64)

    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest,
    }, deps)).resolves.toEqual({ phase: "drive_timeout_stale" })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest,
    }, deps)).resolves.toEqual({ phase: "drive_duplicate_callbacks" })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest,
    }, deps)).resolves.toEqual({ phase: "prepare_restart_continuation" })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest,
    }, deps)).resolves.toEqual({ phase: "reconcile_restart_continuation" })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "interactive_runtime_ready", label: "unit-16m-restart-continuation", scenarioHandleDigest,
    }, deps)).resolves.toEqual({ ready: false })
    expect(interactiveRuntime.mock.calls.map(([payload]) => payload)).toEqual([
      { operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest },
      { operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest },
      { operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest },
      { operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest },
    ])
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest, approvalId: "leak",
    }, deps)).rejects.toThrow(/interactive runtime payload shape/iu)
  })
  it("composes the default health capture through exact start, running, complete, and recovery calls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-default-health-capture-"))
    const agentRoot = path.join(root, "sanctuary.ouro")
    const receiptRoot = path.join(agentRoot, "state", "acceptance", "receipts")
    const gateStatusPath = path.join(root, "current-scenario-gate.json")
    const ownerSnapshot = validOwnerSnapshot()
    const requests: Record<string, unknown>[] = []
    let statusCount = 0
    let complete = false
    const hostRequest = vi.fn(async (payload: Record<string, unknown>) => {
      requests.push(payload)
      if (payload.operation === "start_health_probe") return { state: "started", operationDigest: "a".repeat(64) }
      if (payload.operation === "health_probe_status") {
        statusCount += 1
        if (statusCount === 1) return { state: "running" }
        complete = true
        return { state: "complete", containerSnapshot: ownerSnapshot }
      }
      if (payload.operation === "recover_health_probe") return { recovered: true }
      throw new Error(`unexpected host operation: ${String(payload.operation)}`)
    })
    const deps = createSanctuaryAcceptanceAdapterDependencies(3, {
      hostRequest,
      scenarioCapture: { agentRoot, receiptRoot, gateStatusPath },
    })
    const healthState = '{"incidents":{},"lastDigestDay":null,"updatedAt":"1970-01-01T00:00:00.000Z","outbox":null,"indeterminateDeliveries":[],"deliveredReceipts":[],"sweepReceipts":[]}\n'
    const cron = "# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron\n"
    deps.readFixedFile = (file) => {
      if (file.endsWith("/state/health/sanctuary-health.json")) return healthState
      if (file.endsWith("/.ouro-cli/scheduler/sanctuary.crontab")) return cron
      if (file === "/run/ouro-acceptance/image-digest") return "1".repeat(64)
      if (file.includes("/health-probe-receipts/") && complete) {
        const handle = path.basename(file, ".json")
        const cronFingerprint = createHash("sha256").update(cron).digest("hex")
        return `${JSON.stringify(validHealthProbeReceipt(handle, { cronFingerprintBefore: cronFingerprint, cronFingerprintAfter: cronFingerprint }))}\n`
      }
      throw Object.assign(new Error("missing fixture"), { code: "ENOENT" })
    }
    try {
      const payload = {
        operation: "capture_acceptance_scenario", phase: "begin", label: "unit-16h-daily-digest",
        externalGate: SANCTUARY_SCENARIO_GATES["unit-16h-daily-digest"], sources: SANCTUARY_SCENARIO_SOURCES["unit-16h-daily-digest"],
      }
      const begin = await executeSanctuaryAcceptanceAdapter(payload, deps) as Record<string, unknown>
      const checkpointDigest = begin.checkpointDigest as string
      await expect(executeSanctuaryAcceptanceAdapter({ ...payload, phase: "poll", checkpointDigest }, deps)).resolves.toEqual(begin)
      const result = await executeSanctuaryAcceptanceAdapter({ ...payload, phase: "poll", checkpointDigest }, deps)
      expect(result).toMatchObject({ state: "complete", sourceDigests: { "container-inspect": expect.stringMatching(/^[0-9a-f]{64}$/u) } })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    const scenarioHandleDigest = (requests[0] as { scenarioHandleDigest: string }).scenarioHandleDigest
    expect(requests).toEqual([
      { operation: "start_health_probe", targetId: "sanctuary", label: "unit-16h-daily-digest", scenarioHandleDigest },
      { operation: "health_probe_status", targetId: "sanctuary", label: "unit-16h-daily-digest", scenarioHandleDigest },
      { operation: "health_probe_status", targetId: "sanctuary", label: "unit-16h-daily-digest", scenarioHandleDigest },
      { operation: "recover_health_probe", targetId: "sanctuary", label: "unit-16h-daily-digest", scenarioHandleDigest },
    ])
  })

  it("declares the exact after-owner source set for every health scenario", () => {
    expect(SANCTUARY_SCENARIO_SOURCES["unit-16f-cron-fingerprint"]).toEqual(["health-probe-receipt", "scheduler-liveness-receipt", "cron-runtime", "telegram-audit", "container-inspect"])
    expect(SANCTUARY_SCENARIO_SOURCES["unit-16g-health-transition"]).toEqual(["health-probe-receipt", "telegram-audit", "container-inspect"])
    expect(SANCTUARY_SCENARIO_SOURCES["unit-16h-daily-digest"]).toEqual(["health-probe-receipt", "cron-runtime", "telegram-audit", "container-inspect"])
  })
  it("uses one bounded redacted request over the private host broker socket", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-unit16-broker-client-"))
    const invoke = async (reply: string | null, timeoutMs = 200): Promise<unknown> => {
      const socketPath = path.join(root, `broker-${Math.random().toString(16).slice(2)}.sock`)
      const server = createServer((connection) => {
        let request = ""
        connection.setEncoding("utf8")
        connection.on("error", () => {})
        connection.on("data", (chunk) => { request += chunk })
        connection.on("end", () => {
          expect(JSON.parse(request)).toEqual({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" })
          if (reply !== null) connection.end(reply)
        })
      })
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))
      try {
        const deps = createSanctuaryAcceptanceAdapterDependencies(3, { hostBrokerSocket: socketPath, adapterTimeoutMs: timeoutMs })
        return await deps.hostRequest!({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
    try {
      await expect(invoke('{"ok":true,"result":{"keys":[]}}\n')).resolves.toEqual({ keys: [] })
      await expect(invoke('{"ok":false,"error":"host operation failed"}\n')).rejects.toThrow(/host acceptance operation failed/u)
      await expect(invoke('{"ok":true,"result":{},"extra":true}\n')).rejects.toThrow(/host acceptance operation failed/u)
      await expect(invoke("not-json\n")).rejects.toThrow(/host acceptance operation failed/u)
      await expect(invoke(JSON.stringify({ ok: true, result: "x".repeat(300_000) }), 500)).rejects.toThrow(/host acceptance operation failed/u)
      await expect(invoke(null, 20)).rejects.toThrow(/host acceptance operation failed/u)
      const missing = createSanctuaryAcceptanceAdapterDependencies(3, { hostBrokerSocket: path.join(root, "missing.sock"), adapterTimeoutMs: 20 })
      await expect(missing.hostRequest!({ operation: "inventory_keys" })).rejects.toThrow(/host acceptance operation failed/u)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("packages every Unit 16 harness operation with a fixed operator-only authority", () => {
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as any
    expect(Object.keys(contract.adapters).sort()).toEqual([
      "callback-inject", "callback-live", "capture-evidence-provenance", "closed-inventory", "config-materializer", "cursor-snapshot",
      "evidence-snapshot", "exact-id-revoke", "health-probe-recovery", "health-probe-start", "health-probe-status",
      "interactive-duplicate-driver", "interactive-restart-driver", "interactive-timeout-stale-driver",
      "key-create", "key-inventory", "key-probe", "key-read-old", "key-revoke", "key-store",
      "reboot-final-commit", "reboot-live-request", "reboot-owner-stop", "reboot-poll", "reboot-request", "revoked-key-auth-rejection", "scenario-capture", "scenario-finalize",
      "telegram-poller-quiescence", "telegram-vault-store", "unraid-key-rotate", "vault-backed-capability-verify",
    ])
    expect(Object.values(contract.adapters)).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelReachable: false, timeoutMs: 15_000 }),
    ]))
    expect(Object.keys(contract.configTemplates).sort()).toEqual(Object.keys(contract.commands).sort())
    expect(contract.configTemplates["unraid-key-rotate"].fixed).toMatchObject({
      targetServerId: "sanctuary-unraid",
      inventoryAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      createAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      storeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      revokeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      probeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      keys: [{ name: "Butler RO", vaultField: "unraidReadApiKey" }, { name: "Butler RW", vaultField: "unraidWriteApiKey" }],
    })
    expect(contract.configTemplates["unraid-key-rotate"].oldKeyTemplate.secretAdapter).toBe("/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh")
    expect(JSON.stringify(contract)).not.toMatch(/(?:botToken|authorizedUserId|authorizedChatId|descriptor|rawKey)/u)
  })

  it("proves Telegram poller quiescence and stores bootstrap coordinates without returning them", async () => {
    const calls: unknown[] = []
    const deps = unit16Deps({
      readFixedFile: (file) => file.endsWith("telegram-poller-count.json")
        ? '{"activePollers":0,"productionContainerStopped":true}'
        : "",
      mergeRuntime: async (_agent, patch) => { calls.push(patch); return refreshed(patch) },
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, deps)).resolves.toEqual({ quiesced: true, activePollers: 0 })
    const stored = await executeSanctuaryAcceptanceAdapter({
      operation: "store_telegram_bootstrap", botToken: "456:rotated", authorizedUserId: "333", authorizedChatId: "444",
    }, deps)
    expect(stored).toEqual({ stored: true })
    expect(calls).toContainEqual({ telegramBotToken: "456:rotated", telegramAuthorizedUserId: "333", telegramAuthorizedChatId: "444" })
    expect(JSON.stringify(stored)).not.toMatch(/333|444|456:rotated/u)
  })

  it("snapshots fixed cursor state and runs bounded concurrent callback plus replay probes", async () => {
    const active: number[] = []
    let inFlight = 0
    let peak = 0
    const deps = unit16Deps({
      readFixedFile: (file) => file.endsWith("offset.json") ? '{"nextUpdateId":42}\n' : '{"event":"tool"}\n',
      callbackProbe: async (_update, replay) => {
        inFlight += 1; peak = Math.max(peak, inFlight); active.push(replay ? 2 : 1)
        await Promise.resolve(); inFlight -= 1
        return replay ? { settled: true, claimed: false, mutated: false } : { settled: true, claimed: active.length === 1, mutated: active.length === 1 }
      },
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "snapshot", schema: "telegram-cursor-v1" }, deps)).resolves.toEqual({
      offsetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), auditCursorDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    const update = { update_id: 9, callback_query: { id: "q", from: { id: 111 }, data: "opaque", message: { message_id: 7, chat: { id: 222 } } } }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inject_callbacks_concurrently", update, concurrency: 3 }, deps)).resolves.toMatchObject({ results: { length: 3 } })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inject_callback_replay", update }, deps)).resolves.toEqual({ settled: true, claimed: false, mutated: false })
    expect(peak).toBeGreaterThan(1)
  })

  it("binds scenario capture to the exact label gate and source contract", async () => {
    const captureScenario = vi.fn(async (payload) => ({ state: "waiting", checkpointDigest: "a".repeat(64), payload }))
    const deps = unit16Deps({ captureScenario })
    const payload = {
      operation: "capture_acceptance_scenario",
      phase: "begin",
      label: "unit-16d-whats-up",
      externalGate: "authorized-telegram-message",
      sources: ["telegram-audit", "telegram-offset", "telegram-turn-receipts", "live-grounding-read"],
    }
    await expect(executeSanctuaryAcceptanceAdapter(payload, deps)).resolves.toMatchObject({ state: "waiting", checkpointDigest: "a".repeat(64) })
    expect(captureScenario).toHaveBeenCalledWith({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset", "telegram-turn-receipts", "live-grounding-read"] })
    await expect(executeSanctuaryAcceptanceAdapter({ ...payload, externalGate: "none" }, deps)).rejects.toThrow("external gate")
    await expect(executeSanctuaryAcceptanceAdapter({ ...payload, sources: ["telegram-audit"] }, deps)).rejects.toThrow("sources")
    await expect(executeSanctuaryAcceptanceAdapter({ ...payload, label: "unknown" }, deps)).rejects.toThrow("label")
  })

  it("drives health scenarios through exact private broker start, status, and recovery payloads", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    const operationDigest = "b".repeat(64)
    const snapshot = validOwnerSnapshot()
    const hostRequest = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.operation === "start_health_probe") return { state: "started", operationDigest }
      if (payload.operation === "health_probe_status") return hostRequest.mock.calls.filter(([call]) => call.operation === "health_probe_status").length === 1
        ? { state: "running" }
        : { state: "complete", containerSnapshot: snapshot }
      if (payload.operation === "recover_health_probe") return { recovered: true }
      throw new Error("unexpected host operation")
    })
    const factory = (sanctuaryAcceptanceAdapter as unknown as {
      createSanctuaryHealthAcceptanceScenarioDriver?: (request: typeof hostRequest) => {
        begin(label: string, handle: string): Promise<void>
        poll(label: string, handle: string): Promise<{ state: "waiting" } | { state: "ready"; containerSnapshot: Record<string, unknown> }>
        recover(label: string, handle: string): Promise<void>
      }
    }).createSanctuaryHealthAcceptanceScenarioDriver
    expect(factory, "the adapter must expose one fixed health scenario driver").toBeTypeOf("function")
    const driver = factory!(hostRequest)

    await expect(driver.begin("unit-16g-health-transition", scenarioHandleDigest)).resolves.toBeUndefined()
    await expect(driver.poll("unit-16g-health-transition", scenarioHandleDigest)).resolves.toEqual({ state: "waiting" })
    await expect(driver.poll("unit-16g-health-transition", scenarioHandleDigest)).resolves.toEqual({ state: "ready", containerSnapshot: snapshot })
    await expect(driver.recover("unit-16g-health-transition", scenarioHandleDigest)).resolves.toBeUndefined()

    expect(hostRequest.mock.calls.map(([payload]) => payload)).toEqual([
      { operation: "start_health_probe", targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest },
      { operation: "health_probe_status", targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest },
      { operation: "health_probe_status", targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest },
      { operation: "recover_health_probe", targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest },
    ])
  })

  it.each([
    ["unknown status", { state: "mystery" }],
    ["running status with extra fields", { state: "running", extra: true }],
    ["complete status without owner snapshot", { state: "complete" }],
    ["complete status with malformed owner snapshot", { state: "complete", containerSnapshot: { imageId: "wrong" } }],
    ["complete status with an unknown owner health state", { state: "complete", containerSnapshot: validOwnerSnapshot({ health: "mysterious" }) }],
  ])("rejects %s from the health probe broker", async (_case, response) => {
    const hostRequest = vi.fn(async () => response)
    const factory = (sanctuaryAcceptanceAdapter as unknown as {
      createSanctuaryHealthAcceptanceScenarioDriver?: (request: typeof hostRequest) => {
        poll(label: string, handle: string): Promise<unknown>
      }
    }).createSanctuaryHealthAcceptanceScenarioDriver
    expect(factory).toBeTypeOf("function")
    const driver = factory!(hostRequest)
    await expect(driver.poll("unit-16h-daily-digest", "a".repeat(64))).rejects.toThrow(/health probe.*(?:state|snapshot|response)/iu)
  })

  it.each([
    ["start response with an invalid operation digest", "begin", { state: "started", operationDigest: "wrong" }],
    ["start response with extra fields", "begin", { state: "started", operationDigest: "b".repeat(64), extra: true }],
    ["recovery response with extra fields", "recover", { recovered: true, extra: true }],
    ["recovery response without a boolean attestation", "recover", { recovered: "yes" }],
  ] as const)("rejects %s", async (_case, method, response) => {
    const hostRequest = vi.fn(async () => response)
    const factory = (sanctuaryAcceptanceAdapter as unknown as {
      createSanctuaryHealthAcceptanceScenarioDriver?: (request: typeof hostRequest) => {
        begin(label: string, handle: string): Promise<void>
        recover(label: string, handle: string): Promise<void>
      }
    }).createSanctuaryHealthAcceptanceScenarioDriver
    expect(factory).toBeTypeOf("function")
    const driver = factory!(hostRequest)
    await expect(driver[method]("unit-16f-cron-fingerprint", "a".repeat(64))).rejects.toThrow(/health probe.*response/iu)
  })

  it("skips the duplicate before-owner snapshot and reuses the independently attested after-owner snapshot", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-driven-health-owner-"))
    const hostRequest = vi.fn(async () => { throw new Error("duplicate container snapshot") })
    const readFacts = readDefaultSanctuaryScenarioFacts as unknown as (
      label: "unit-16g-health-transition",
      handle: string,
      deps: SanctuaryAcceptanceAdapterDependencies,
      root: string,
      options: { skipContainerSnapshot?: boolean; containerSnapshot?: Record<string, unknown> },
    ) => ReturnType<typeof readDefaultSanctuaryScenarioFacts>
    const dependencies = unit16Deps({
      readFixedFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      hostRequest,
    })
    try {
      const before = await readFacts("unit-16g-health-transition", "a".repeat(64), dependencies, agentRoot, { skipContainerSnapshot: true })
      expect(before.container).toBeUndefined()
      expect(hostRequest).not.toHaveBeenCalled()

      const snapshot = validOwnerSnapshot()
      const after = await readFacts("unit-16g-health-transition", "a".repeat(64), dependencies, agentRoot, { containerSnapshot: snapshot })
      expect(after.container).toMatchObject({ exactImage: false, running: true, healthy: true, user: "10001:10001" })
      expect(after.sourceValues["container-inspect"]).toEqual(snapshot)
      expect(hostRequest).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("awaits asynchronous scenario finalization and preserves recovery plus cleanup failures", async () => {
    const recoveryError = new Error("health recovery failed")
    const cleanupError = new Error("private cleanup failed")
    const aggregate = new AggregateError([recoveryError, cleanupError], "health recovery failed; private cleanup failed")
    let awaited = false
    const finalization = {
      then(_resolve: (value?: void) => void, reject: (reason: unknown) => void) {
        awaited = true
        reject(aggregate)
      },
    }
    const deps = unit16Deps({ finalizeScenarios: vi.fn(() => finalization as unknown as void) })

    const execution = executeSanctuaryAcceptanceAdapter({ operation: "finalize_acceptance_scenarios" }, deps)
    await expect(execution).rejects.toBe(aggregate)
    expect(awaited).toBe(true)
    expect((aggregate as AggregateError).errors).toEqual([recoveryError, cleanupError])
  })

  it("recovers the active health probe before local cleanup and aggregates both failures", async () => {
    const order: string[] = []
    const recoveryError = new Error("health recovery failed")
    const cleanupError = new Error("private cleanup failed")
    const factory = (sanctuaryAcceptanceAdapter as unknown as {
      createSanctuaryAcceptanceScenarioFinalizer?: (dependencies: {
        readActiveScenario(): { label: string; scenarioHandleDigest: string } | null
        recoverHealthScenario(label: string, handle: string): Promise<void>
        finalizeLocal(): void
      }) => () => Promise<void>
    }).createSanctuaryAcceptanceScenarioFinalizer
    expect(factory).toBeTypeOf("function")
    const finalize = factory!({
      readActiveScenario: () => { order.push("read"); return { label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) } },
      recoverHealthScenario: async () => { order.push("recover"); throw recoveryError },
      finalizeLocal: () => { order.push("local"); throw cleanupError },
    })

    const thrown = await finalize().catch((error) => error as unknown)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([recoveryError, cleanupError])
    expect(order).toEqual(["read", "recover", "local"])
  })

  it("recursively flattens ordered AggregateError leaves from recovery and local cleanup", async () => {
    const recoveryLeaf = new Error("recovery leaf")
    const cleanupLeafOne = new Error("cleanup leaf one")
    const cleanupLeafTwo = new Error("cleanup leaf two")
    const factory = (sanctuaryAcceptanceAdapter as unknown as {
      createSanctuaryAcceptanceScenarioFinalizer(dependencies: {
        readActiveScenario(): { label: string; scenarioHandleDigest: string }
        recoverHealthScenario(): Promise<void>
        finalizeLocal(): void
      }): () => Promise<void>
    }).createSanctuaryAcceptanceScenarioFinalizer
    const finalize = factory({
      readActiveScenario: () => ({ label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }),
      recoverHealthScenario: async () => { throw new AggregateError([new AggregateError([recoveryLeaf], "nested recovery")], "recovery") },
      finalizeLocal: () => { throw new AggregateError([cleanupLeafOne, new AggregateError([cleanupLeafTwo], "nested cleanup")], "cleanup") },
    })

    const thrown = await finalize().catch((error) => error as unknown)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([recoveryLeaf, cleanupLeafOne, cleanupLeafTwo])
  })

  it("reads actual persisted source schemas and exact host facts without exposing raw Telegram identity", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scenario-facts-"))
    const scenarioHandleDigest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const credentials = { botToken: "12345:private-token-value", authorizedUserId: "123456789", authorizedChatId: "123456789" }
    const subjectPayload = ["ouroboros.telegram.subject.v1", `user:${credentials.authorizedUserId.length}:${credentials.authorizedUserId}`, `chat:${credentials.authorizedChatId.length}:${credentials.authorizedChatId}`].join("\0")
    const subject = `tg_${createHmac("sha256", identityKey).update(subjectPayload).digest("base64url")}`
    const canonicalSession = path.join(agentRoot, "state", "sessions", `telegram-user:${subject}`, "telegram", `telegram_${subject}.json`)
    fs.mkdirSync(path.dirname(canonicalSession), { recursive: true })
    fs.writeFileSync(canonicalSession, "{}\n")
    const canonicalFriend = { id: "friend-1", name: `Telegram user ${subject}`, role: "friend", trustLevel: "family", externalIds: [{ provider: "telegram-user", externalId: subject, linkedAt: "2026-08-20T00:00:00.000Z" }] }
    fs.mkdirSync(path.join(agentRoot, "friends"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "friends", "friend-1.json"), JSON.stringify(canonicalFriend))
    const lifecycleCoordinates = { scenarioHandleDigest, turnDigest: "7".repeat(64), updateDigest: "1".repeat(64), subject, identityDigest: "8".repeat(64), sessionDigest: "9".repeat(64), argumentDigest: "a".repeat(64) }
    const lifecycle = (event: string, ts: string, lifecycleAt: number, meta: Record<string, unknown>) => {
      const combined = { ...lifecycleCoordinates, ...meta, lifecycleAt }
      return { ts, event, meta: { ...combined, lifecycleMac: sanctuaryTelegramAuditLifecycleMac(identityKey, "sanctuary-telegram-turn-receipt-v3", event, combined) } }
    }
    const audit = `${JSON.stringify(lifecycle("senses.telegram_turn_start", "2026-08-20T16:00:00.000Z", 1_000, {}))}\n${JSON.stringify(lifecycle("senses.telegram_turn_end", "2026-08-20T16:00:01.000Z", 2_000, { deliveryCount: 1, outcome: "success", errorDigest: null }))}\n`
    const cron = "# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron\n"
    const files: Record<string, string> = {
      [`${agentRoot}/state/senses/telegram/identity.key`]: `${identityKey}\n`,
      ...chainedAuditFiles(agentRoot, audit, identityKey),
      "/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json": '{"nextUpdateId":10}\n',
      [`${agentRoot}/state/approvals/checkpoints.json`]: "{}\n",
      [`${agentRoot}/state/acceptance/telegram-turns.ndjson`]: `${JSON.stringify({ schemaVersion: "sanctuary-telegram-turn-receipt-v3", scenarioHandleDigest, status: "success", errorCategory: null, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64), toolResultDigests: [], providerInvocationCount: 1, toolInvocationCount: 0, deliveryCount: 1, deliveries: [{ messageIdDigest: "4".repeat(64), chunkDigest: "5".repeat(64) }], completedAt: "2026-08-20T16:00:01.000Z" })}\n`,
      "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab": cron,
      [`${agentRoot}/state/health/sanctuary-health.json`]: '{"incidents":{},"lastDigestDay":null,"updatedAt":"1970-01-01T00:00:00.000Z","outbox":null,"indeterminateDeliveries":[],"deliveredReceipts":[],"sweepReceipts":[]}\n',
      "/run/ouro-acceptance/image-digest": "b".repeat(64),
    }
    const approvalDatabase = path.join(agentRoot, "state", "approvals", "approvals.sqlite")
    openApprovalStore({ databasePath: approvalDatabase }).close()
    const facts = await readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! },
      telegramCredentials: () => credentials,
      hostRequest: async () => ({ imageId: `sha256:${"b".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(facts.identity).toMatchObject({ keyPresent: true, subjectOpaque: true, rawIdentityAbsent: true, liveSubjectObserved: true, mismatchCount: 0, rawLeakCount: 0, canonicalSessionCount: 1, canonicalFriendCount: 1 })
    expect(facts.identity?.inspectedRecordCount).toBeGreaterThan(0)
    expect(facts.identity?.opaqueSubjectCount).toBeGreaterThan(0)
    expect(facts.container).toMatchObject({ exactImage: true, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false })
    expect(facts.cron?.registered).toBe(true)
    expect(facts.containment?.sensitiveMaterialObserved).toBe(false)
    expect(JSON.stringify(facts.sourceValues)).not.toContain(credentials.botToken)
    const baselineSessionDigest = facts.identity?.sessionSurfaceDigest
    const sessionDerivedMutations = [
      [path.join(agentRoot, "state", "pending", "telegram", "pending.json"), "{}\n"],
      [path.join(agentRoot, "state", "pending-returns", "telegram-user", "return.json"), "{}\n"],
      [path.join(agentRoot, "state", "senses", "telegram", "identity-subjects.json"), JSON.stringify({ version: 1, subject, legacySubjects: [] })],
    ] as const
    for (const [mutationPath, contents] of sessionDerivedMutations) {
      fs.mkdirSync(path.dirname(mutationPath), { recursive: true })
      fs.writeFileSync(mutationPath, contents)
      const mutated = await readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
        readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! }, telegramCredentials: () => credentials,
      }), agentRoot, { skipContainerSnapshot: true })
      expect(mutated.identity?.sessionSurfaceDigest, mutationPath).not.toBe(baselineSessionDigest)
      fs.unlinkSync(mutationPath)
    }
    const tamperedLifecycle = audit.trim().split("\n").map((line, index) => {
      const record = JSON.parse(line) as { meta: Record<string, unknown> }
      return JSON.stringify(index === 1 ? { ...record, meta: { ...record.meta, lifecycleAt: 500 } } : record)
    }).join("\n")
    Object.assign(files, chainedAuditFiles(agentRoot, `${tamperedLifecycle}\n`, identityKey))
    await expect(readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! },
      telegramCredentials: () => credentials,
    }), agentRoot, { skipContainerSnapshot: true })).rejects.toThrow("lifecycle MAC")
    Object.assign(files, chainedAuditFiles(agentRoot, audit, identityKey))
    const replaySession = path.join(path.dirname(canonicalSession), "replay.json")
    fs.writeFileSync(replaySession, "{}\n")
    const duplicateSession = await readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! },
      telegramCredentials: () => credentials,
      hostRequest: async () => ({ imageId: `sha256:${"b".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(duplicateSession.identity?.canonicalSessionCount).toBe(1)
    fs.unlinkSync(replaySession)
    fs.renameSync(canonicalSession, replaySession)
    const wrongSession = await readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! }, telegramCredentials: () => credentials,
    }), agentRoot, { skipContainerSnapshot: true })
    expect(wrongSession.identity?.canonicalSessionCount).toBe(0)
    fs.renameSync(replaySession, canonicalSession)
    fs.writeFileSync(path.join(agentRoot, "friends", "friend-2.json"), JSON.stringify({ ...canonicalFriend, id: "friend-2" }))
    const duplicate = await readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! },
      telegramCredentials: () => credentials,
      hostRequest: async () => ({ imageId: `sha256:${"b".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(duplicate.identity?.canonicalFriendCount).toBe(2)
    fs.unlinkSync(path.join(agentRoot, "friends", "friend-2.json"))
    fs.writeFileSync(path.join(agentRoot, "friends", "friend-1.json"), JSON.stringify({ ...canonicalFriend, externalIds: [...canonicalFriend.externalIds, ...canonicalFriend.externalIds] }))
    const duplicatedIdentity = await readDefaultSanctuaryScenarioFacts("unit-14b-3-opaque-identity-live", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! }, telegramCredentials: () => credentials,
    }), agentRoot, { skipContainerSnapshot: true })
    expect(duplicatedIdentity.identity?.canonicalFriendCount).toBe(2)
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("rejects a tampered unauthorized Telegram sender binding", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-unauthorized-binding-"))
    const scenarioHandleDigest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const credentials = { botToken: "12345:private-token-value", authorizedUserId: "123456789", authorizedChatId: "123456789" }
    const binding = {
      scenarioHandleDigest,
      updateDigest: "1".repeat(64),
      senderIdentityDigest: "d".repeat(64),
      authorizedIdentityDigest: sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v3", "sender-identity", credentials.authorizedUserId),
      senderDistinct: true,
      nextOffsetDigest: sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v3", "next-update-id", "124"),
    }
    const drop = { ts: "2026-08-20T16:00:00.000Z", event: "telegram.update_dropped", meta: { ...binding, distinctAccount: true, dropMac: sanctuaryTelegramUnauthorizedDropMac(identityKey, "sanctuary-telegram-turn-receipt-v3", binding) } }
    const files: Record<string, string> = {
      ...chainedAuditFiles(agentRoot, `${JSON.stringify(drop)}\n`, identityKey),
      "/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json": '{"nextUpdateId":124}\n',
    }
    const deps = unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); return files[file]! },
      telegramCredentials: () => credentials,
    })
    Object.assign(files, chainedAuditFiles(agentRoot, `${JSON.stringify({ ...drop, meta: { ...drop.meta, senderIdentityDigest: "c".repeat(64) } })}\n`, identityKey))
    await expect(readDefaultSanctuaryScenarioFacts("unit-16d-2-unauthorized", scenarioHandleDigest, deps, agentRoot, { skipContainerSnapshot: true })).rejects.toThrow("sender binding MAC")
    Object.assign(files, chainedAuditFiles(agentRoot, `${JSON.stringify(drop)}\n`, identityKey))
    files["/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json"] = '{"nextUpdateId":125}\n'
    await expect(readDefaultSanctuaryScenarioFacts("unit-16d-2-unauthorized", scenarioHandleDigest, deps, agentRoot, { skipContainerSnapshot: true })).rejects.toThrow("sender binding MAC")
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("detects raw Telegram credentials in persisted session paths as well as contents", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-identity-path-leak-"))
    const scenarioHandleDigest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const credentials = { botToken: "12345:private-token-value", authorizedUserId: "123456789", authorizedChatId: "987654321" }
    const leakedDirectory = path.join(agentRoot, "state", "sessions", credentials.authorizedUserId)
    fs.mkdirSync(leakedDirectory, { recursive: true })
    fs.writeFileSync(path.join(leakedDirectory, "session.json"), "{}\n")
    const identityPath = `${agentRoot}/state/senses/telegram/identity.key`
    const facts = await readDefaultSanctuaryScenarioFacts("unit-12c-1-opaque-identity", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === identityPath) return `${identityKey}\n`; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      telegramCredentials: () => credentials,
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(facts.identity).toMatchObject({ rawIdentityAbsent: false })
    expect(facts.identity?.rawLeakCount).toBeGreaterThan(0)
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("fails identity attestation instead of silently skipping an unaudited filesystem surface", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-identity-surface-symlink-"))
    const friendsRoot = path.join(agentRoot, "friends")
    fs.mkdirSync(friendsRoot, { recursive: true })
    fs.symlinkSync(path.join(agentRoot, "outside"), path.join(friendsRoot, "uninspected"))
    const identityPath = `${agentRoot}/state/senses/telegram/identity.key`
    await expect(readDefaultSanctuaryScenarioFacts("unit-12c-1-opaque-identity", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (file === identityPath) return `${"k".repeat(43)}\n`; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      telegramCredentials: () => ({ botToken: "123:token", authorizedUserId: "123456789", authorizedChatId: "987654321" }),
    }), agentRoot)).rejects.toThrow("refuses symbolic links")
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("propagates non-absence source read failures", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" })
    await expect(readDefaultSanctuaryScenarioFacts("unit-16d-whats-up", "a".repeat(64), unit16Deps({ readFixedFile: () => { throw failure } }))).rejects.toBe(failure)
  })

  it("preserves approval correlation on restart lifecycle audit evidence", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-restart-correlation-"))
    const scenarioHandleDigest = "a".repeat(64)
    const audit = `${JSON.stringify({ ts: "2026-08-20T16:00:00.000Z", event: "senses.telegram_approved_restart_end", meta: { scenarioHandleDigest, approvalId: "approval-1", observedRestart: true } })}\n`
    const files = chainedAuditFiles(agentRoot, audit)
    const facts = await readDefaultSanctuaryScenarioFacts("unit-16m-restart-continuation", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file in files) return files[file]!; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      telegramCredentials: () => ({ botToken: "123:token", authorizedUserId: "123456789", authorizedChatId: "987654321" }),
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(facts.events).toEqual([{ event: "senses.telegram_approved_restart_end", at: Date.parse("2026-08-20T16:00:00.000Z"), meta: { scenarioHandleDigest, approvalId: "approval-1", observedRestart: true } }])
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("exact-parses broker-owned interactive receipts without accepting synthetic aliases", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-interactive-receipt-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = `${agentRoot}/state/acceptance/interactive-driver-receipts/${scenarioHandleDigest}.json`
    const receipt = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label: "unit-16m-restart-continuation", scenarioHandleDigest,
      approvalIdDigest: "1".repeat(64), checkpointDigest: "2".repeat(64), suspendedSessionRevisionDigest: "3".repeat(64), approvalEpochBefore: 0,
      approvalEpochAfterRestart: 0, continuationEpochAfter: 1, ownerImageDigest: "4".repeat(64), ownerContainerDigest: "5".repeat(64),
      restartCountBefore: 7, restartCountAfter: 8, pendingDigestBefore: "6".repeat(64), pendingDigestAfter: "6".repeat(64), pendingRestored: true,
      callbackAttempts: 1, mutationCount: 1, indeterminateRecoveryObserved: true, indeterminateRetryCount: 0,
    }
    const deps = unit16Deps({
      readFixedFile: (file) => { if (file === receiptPath) return JSON.stringify(receipt); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      hostRequest: async () => validOwnerSnapshot(),
    })
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16m-restart-continuation", scenarioHandleDigest, deps, agentRoot)
      const { phase: _phase, ...expected } = receipt
      expect(facts.interactiveDriver).toEqual(expected)
      const withAlias = { ...receipt, restartObserved: true }
      deps.readFixedFile = (file) => { if (file === receiptPath) return JSON.stringify(withAlias); throw Object.assign(new Error("missing"), { code: "ENOENT" }) }
      await expect(readDefaultSanctuaryScenarioFacts("unit-16m-restart-continuation", scenarioHandleDigest, deps, agentRoot)).rejects.toThrow(/shape is invalid/u)
    } finally { fs.rmSync(agentRoot, { recursive: true, force: true }) }
  })

  it("parses the real reboot checkpoint schema and binds live host recovery milestones", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-reboot-facts-"))
    const prebootDigest = "1".repeat(64)
    const postbootDigest = "2".repeat(64)
    const requestId = "3".repeat(64)
    const files: Record<string, string> = {
      "/evidence/reboot.json": JSON.stringify({ schemaVersion: 1, operation: "reboot", phase: "complete", targetId: "sanctuary", requestId, prebootDigest, postbootDigest, processBindingDigest: "6".repeat(64), unrelatedHostOperations: 0, completedAt: 1 }),
      "/run/ouro-acceptance/image-digest": "b".repeat(64),
      "/opt/ouro/deploy/unraid/sanctuary.ouro/tool-profiles.json": JSON.stringify({ version: 1, profiles: { "sanctuary-telegram": ["unraid_list_containers", "unraid_get_container_logs", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system", "unraid_restart_container", "ponder", "settle", "speak"] } }),
    }
    const facts = await readDefaultSanctuaryScenarioFacts("unit-16a-boot-recovery-milestones", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]! },
      hostRequest: async () => ({ imageId: `sha256:${"b".repeat(64)}`, running: true, health: "healthy", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false, mountsExact: true, securityExact: true, networkMode: "host", writableKeyExposure: false, recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true } }),
      now: () => 123_456,
    }), agentRoot)
    expect(facts.capturedAt).toBe(123_456)
    expect(facts.reboot).toEqual({ phase: "complete", requestDigest: createHash("sha256").update(requestId).digest("hex"), processBindingDigest: "6".repeat(64), requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: 0, bootIdentityChanged: true, hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true })
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("parses a preflight reboot checkpoint without fabricating a reboot request", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-reboot-preflight-"))
    const idempotencyDigest = "4".repeat(64)
    const files: Record<string, string> = {
      "/evidence/reboot.json": JSON.stringify({ schemaVersion: 1, operation: "reboot", phase: "preflight", targetId: "sanctuary", idempotencyDigest, processBindingDigest: "5".repeat(64), unrelatedHostOperations: 0, requestedAt: 123 }),
    }
    const facts = await readDefaultSanctuaryScenarioFacts("unit-16a-pre-reboot-checkpoint", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]! },
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(facts.reboot).toMatchObject({ phase: "preflight", requestDigest: idempotencyDigest, processBindingDigest: "5".repeat(64), requestCount: 0, checkpointPersisted: true, bootIdentityChanged: false })
    files["/evidence/reboot.json"] = JSON.stringify({ schemaVersion: 1, operation: "reboot", phase: "preflight", targetId: "sanctuary", idempotencyDigest, unrelatedHostOperations: 0, requestedAt: 123 })
    const unbound = await readDefaultSanctuaryScenarioFacts("unit-16a-pre-reboot-checkpoint", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]! },
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(unbound.reboot).toBeUndefined()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it.each([
    ["delivery count mismatch", { deliveryCount: 1, deliveries: [] }],
    ["extra field", { extra: true }],
  ])("fails closed on a Telegram turn receipt with %s", async (_label, patch) => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-turn-receipt-invalid-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receipt = { schemaVersion: "sanctuary-telegram-turn-receipt-v3", scenarioHandleDigest, status: "success", errorCategory: null, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64), toolResultDigests: [], providerInvocationCount: 1, toolInvocationCount: 0, deliveryCount: 0, deliveries: [], completedAt: "2026-08-20T16:00:01.000Z", ...patch }
    const ledgerPath = `${agentRoot}/state/acceptance/telegram-turns.ndjson`
    await expect(readDefaultSanctuaryScenarioFacts("unit-16d-whats-up", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === ledgerPath) return `${JSON.stringify(receipt)}\n`; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
    }), agentRoot)).rejects.toThrow("Telegram turn receipt ledger row is invalid")
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("parses bounded redacted grounding receipts and binds them to an independent live read", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-turn-grounding-"))
    const scenarioHandleDigest = "a".repeat(64)
    const identityKey = "k".repeat(43)
    const identityPath = `${agentRoot}/state/senses/telegram/identity.key`
    const facts = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
    const groundingDigest = createHash("sha256").update(JSON.stringify(facts)).digest("hex")
    const sourceIdentityDigest = "9".repeat(64)
    const observedAt = "2026-08-20T16:00:00.000Z"
    const text = "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded."
    const deliveries = [{ messageIdDigest: "5".repeat(64), chunkDigest: sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v4", "chunk", text), redactedText: text, utf16Units: text.length }]
    const unsignedReceipt = {
      schemaVersion: "sanctuary-telegram-turn-receipt-v4", scenarioHandleDigest, status: "success", errorCategory: null,
      updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v4", "response", JSON.stringify(deliveries)), toolResultDigests: ["4".repeat(64)],
      toolGroundings: [{ toolName: "unraid_get_system", resultDigest: "4".repeat(64), groundingDigest, sourceIdentityDigest, observedAt, facts }],
      providerInvocationCount: 1, toolInvocationCount: 1, deliveryCount: 1,
      deliveries,
      completedAt: "2026-08-20T16:00:01.000Z",
    }
    const receipt = { ...unsignedReceipt, receiptMac: sanctuaryTelegramTurnReceiptMac(identityKey, unsignedReceipt) }
    const ledgerPath = `${agentRoot}/state/acceptance/telegram-turns.ndjson`
    const deps = unit16Deps({
      readFixedFile: (file) => { if (file === ledgerPath) return `${JSON.stringify(receipt)}\n`; if (file === identityPath) return identityKey; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      readLiveGrounding: vi.fn(async () => ({ toolName: "unraid_get_system", groundingDigest, sourceIdentityDigest, observedAt: "2026-08-20T16:00:02.000Z", facts })),
      telegramCredentials: () => ({ botToken: "12345:synthetic-token", authorizedUserId: "123456789", authorizedChatId: "123456789" }),
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    } as any)
    const observed = await readDefaultSanctuaryScenarioFacts("unit-16d-whats-up", scenarioHandleDigest, deps, agentRoot)
    expect(observed.telegramTurns[0]).toMatchObject({ responseText: text, responseUtf16Units: text.length, toolGroundings: receipt.toolGroundings })
    expect((observed as any).liveGrounding).toEqual({ toolName: "unraid_get_system", groundingDigest, sourceIdentityDigest, observedAt: "2026-08-20T16:00:02.000Z", facts })

    await expect(readDefaultSanctuaryScenarioFacts("unit-16d-whats-up", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === ledgerPath) return `${JSON.stringify(receipt)}\n`; if (file === identityPath) return "z".repeat(43); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
    }), agentRoot)).rejects.toThrow("Telegram turn receipt ledger row is invalid")

    for (const patch of [
      { deliveries: [{ ...receipt.deliveries[0], utf16Units: text.length + 1 }] },
      { deliveries: [{ ...receipt.deliveries[0], redactedText: "x".repeat(1_201), utf16Units: 1_201 }] },
      { deliveries: [{ ...receipt.deliveries[0], redactedText: "Sanctuary runs Unraid 7.2.3; the array is STARTED and healthy.", utf16Units: 62 }] },
      { deliveries: [{ ...receipt.deliveries[0], chunkDigest: "f".repeat(64) }] },
      { responseDigest: "f".repeat(64) },
      { providerInvocationCount: 2 },
      { completedAt: "2026-08-20T16:00:02.000Z" },
      { toolResultDigests: ["8".repeat(64)], toolGroundings: [{ ...receipt.toolGroundings[0], resultDigest: "8".repeat(64) }] },
      { toolGroundings: [{ ...receipt.toolGroundings[0], groundingDigest: "f".repeat(64) }] },
      { toolGroundings: [{ ...receipt.toolGroundings[0], sourceIdentityDigest: "8".repeat(64) }] },
      { toolGroundings: [{ ...receipt.toolGroundings[0], observedAt: "2026-08-20T16:00:00.001Z" }] },
      { toolGroundings: [{ ...receipt.toolGroundings[0], facts: { ...facts, unraidVersion: "7.2.4" } }] },
      { toolGroundings: [{ ...receipt.toolGroundings[0], toolName: "unraid_restart_container" }] },
    ]) {
      await expect(readDefaultSanctuaryScenarioFacts("unit-16d-whats-up", scenarioHandleDigest, unit16Deps({
        readFixedFile: (file) => { if (file === ledgerPath) return `${JSON.stringify({ ...receipt, ...patch })}\n`; if (file === identityPath) return identityKey; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      }), agentRoot)).rejects.toThrow("Telegram turn receipt ledger row is invalid")
    }
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it.each([
    ["audit", "state/acceptance/telegram-audit-chain.ndjson", `${JSON.stringify({ ts: "2026-08-20T16:00:00.000Z", event: "telegram.update_dropped", meta: {} })}\n{\n`],
    ["restart", "state/acceptance/restart-attempts.ndjson", `${JSON.stringify({ container: { id: "Docker:test", name: "test" }, beforeState: "running", observedAt: "2026-08-20T16:00:00.000Z", actionDigest: "1".repeat(64), argumentDigest: "2".repeat(64), scenarioHandleDigest: "b".repeat(64), approvalId: "approval", attemptId: "attempt", mutationAcknowledged: false, afterState: null, state: "attempt_not_started" })}\n{}\n`],
    ["health", "state/health/sanctuary-health.json", JSON.stringify({ incidents: {}, lastDigestDay: null, updatedAt: "1970-01-01T00:00:00.000Z", outbox: null, indeterminateDeliveries: [], deliveredReceipts: [], sweepReceipts: [{ sweepId: "not-a-uuid" }] })],
  ])("fails closed when a decisive %s source contains mixed corruption", async (_label, suffix, contents) => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-decisive-source-invalid-"))
    const sourcePath = suffix.includes("telegram-audit-chain") ? AUDIT_PATH : `${agentRoot}/${suffix}`
    await expect(readDefaultSanctuaryScenarioFacts("unit-16g-health-transition", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (file === sourcePath) return contents; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
    }), agentRoot)).rejects.toThrow()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("runs provider checks concurrently and derives fallback count from observed attempts", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-observation-"))
    const files: Record<string, string> = {
      [`${agentRoot}/agent.json`]: JSON.stringify({ humanFacing: { provider: "openai-compatible", model: "glm-out" }, agentFacing: { provider: "openai-compatible", model: "glm-in" } }),
      [`${agentRoot}/provider-readiness.json`]: JSON.stringify({ selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "openai-compatible-gemini", model: "gemini-candidate" }] }),
    }
    let active = 0
    let peak = 0
    const facts = await readDefaultSanctuaryScenarioFacts("unit-16c-provider-readiness", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]! },
      readProviderCredential: async (_agent, provider) => ({
        ok: true,
        poolPath: "vault:opaque",
        record: { provider, revision: `rev-${provider}`, updatedAt: "2026-08-20T00:00:00.000Z", credentials: { apiKey: "secret" }, config: { baseUrl: "https://example.invalid" }, provenance: { source: "manual", updatedAt: "2026-08-20T00:00:00.000Z" } },
      }),
      providerPing: async (provider, _config, options) => {
        active += 1; peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        const observedProvider = options.model === "gemini-candidate" ? "openai-compatible" : provider
        return { ok: true, attempts: [{ attempt: 1, provider: observedProvider, model: options.model!, operation: "ping", ok: true, willRetry: false }] }
      },
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(peak).toBe(3)
    expect(facts.provider?.fallbackAttemptCount).toBe(1)
    expect(facts.provider?.requestSemanticsExact).toBe(false)
    expect(facts.provider?.pingReceipts).toEqual(expect.arrayContaining([expect.objectContaining({ lane: "candidate", attempts: [expect.objectContaining({ provider: "openai-compatible" })] })]))
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("requires the exact Sanctuary provider coordinates and distinct secret-derived identities without exposing secrets", () => {
    const canonical = {
      outward: { provider: "openai-compatible", model: "glm-5.2" },
      inner: { provider: "openai-compatible", model: "glm-5.2" },
      gemini: { provider: "openai-compatible-gemini", model: "gemini-3.6-flash", vaultItem: "providers/openai-compatible-gemini" },
      glm: { baseUrl: "https://api.z.ai/api/paas/v4/", vaultItem: "providers/openai-compatible", apiKey: "glm-secret" },
      geminiCredential: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "gemini-secret" },
      selectionPolicy: "explicit-same-lane-only",
      identityKey: "identity-key",
    }
    const result = evaluateSanctuaryProviderReadinessContract(canonical)
    expect(result).toEqual({ baseUrlsExact: true, credentialIdentitiesDistinct: true, modelsExact: true, vaultCoordinatesExact: true })
    expect(JSON.stringify(result)).not.toContain("glm-secret")
    expect(JSON.stringify(result)).not.toContain("gemini-secret")
    expect(evaluateSanctuaryProviderReadinessContract({ ...canonical, outward: { ...canonical.outward, model: "glm-5.1" } }).modelsExact).toBe(false)
    expect(evaluateSanctuaryProviderReadinessContract({ ...canonical, gemini: { ...canonical.gemini, model: "gemini-3.5-flash" } }).modelsExact).toBe(false)
    expect(evaluateSanctuaryProviderReadinessContract({ ...canonical, glm: { ...canonical.glm, baseUrl: "https://example.invalid" } }).baseUrlsExact).toBe(false)
    expect(evaluateSanctuaryProviderReadinessContract({ ...canonical, gemini: { ...canonical.gemini, vaultItem: "providers/wrong" } }).vaultCoordinatesExact).toBe(false)
    expect(evaluateSanctuaryProviderReadinessContract({ ...canonical, geminiCredential: { ...canonical.geminiCredential, apiKey: "glm-secret" } }).credentialIdentitiesDistinct).toBe(false)
  })

  it.each([
    ["empty attempts", () => []],
    ["wrong operation", (provider: string, model: string) => [{ attempt: 1, provider, model, operation: "completion", ok: true, willRetry: false }]],
    ["wrong model", (provider: string) => [{ attempt: 1, provider, model: "wrong-model", operation: "ping", ok: true, willRetry: false }]],
    ["non-successful final attempt", (provider: string, model: string) => [{ attempt: 1, provider, model, operation: "ping", ok: false, willRetry: false }]],
    ["overbound attempts", (provider: string, model: string) => Array.from({ length: 4 }, (_, index) => ({ attempt: index + 1, provider, model, operation: "ping", ok: true, willRetry: false }))],
  ] as const)("rejects ok provider pings with %s", async (_case, attempts) => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-attempt-binding-"))
    const files: Record<string, string> = {
      [`${agentRoot}/agent.json`]: JSON.stringify({ humanFacing: { provider: "openai-compatible", model: "glm-out" }, agentFacing: { provider: "openai-compatible", model: "glm-in" } }),
      [`${agentRoot}/provider-readiness.json`]: JSON.stringify({ selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "openai-compatible-gemini", model: "gemini-candidate" }] }),
    }
    const facts = await readDefaultSanctuaryScenarioFacts("unit-16c-provider-readiness", "a".repeat(64), unit16Deps({
      readFixedFile: (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]! },
      readProviderCredential: async (_agent, provider) => ({
        ok: true,
        poolPath: "vault:opaque",
        record: {
          provider,
          revision: `rev-${provider}`,
          updatedAt: "2026-08-20T00:00:00.000Z",
          credentials: { apiKey: "secret" },
          config: {},
          provenance: { source: "manual", updatedAt: "2026-08-20T00:00:00.000Z" },
        },
      }),
      providerPing: async (provider, _config, options) => ({ ok: true, attempts: attempts(provider, options.model!) as never }),
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(facts.provider?.requestSemanticsExact).toBe(false)
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("parses a strict restored health probe receipt at the exact local digest boundary", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-health-probe-receipt-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = `${agentRoot}/state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`
    const facts = await readDefaultSanctuaryScenarioFacts("unit-16h-daily-digest", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === receiptPath) return JSON.stringify(validHealthProbeReceipt(scenarioHandleDigest)); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
    }), agentRoot)
    expect(facts.healthProbe).toMatchObject({ label: "unit-16h-daily-digest", scenarioHandleDigest, clockMode: "local-daily-boundary", privateTurnCount: 1, providerInvocationCount: 2, deliveryCount: 1 })
    expect(facts.sourceValues["health-probe-receipt"]).toEqual(facts.healthProbe)
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("parses a strict scheduler-origin Unit16f receipt with PID1 and canonical habit provenance", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scheduler-health-receipt-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = `${agentRoot}/state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`
    try {
      const facts = await readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", scenarioHandleDigest, unit16Deps({
        readFixedFile: (file) => { if (file === receiptPath) return JSON.stringify(validCronHealthProbeReceipt(scenarioHandleDigest)); if (file === `${agentRoot}/state/senses/telegram/identity.key`) return "k".repeat(43); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
        telegramCredentials: () => ({ botToken: "123:test", authorizedUserId: "1", authorizedChatId: "1" }),
        hostRequest: async () => ({ running: true, health: "healthy", imageId: "sha256:missing", user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false }),
      }), agentRoot)
      expect(facts.healthProbe?.schedulerReceipt).toMatchObject({ trigger: "cron", sweepDelta: 1, deliveryDelta: 0, nonReplay: true, supervisor: { daemonPid: 1, childCount: 1, healthy: true, namespace: "habit:sanctuary" } })
      expect(facts.sourceValues["scheduler-liveness-receipt"]).toEqual(facts.healthProbe?.schedulerReceipt)
    } finally { fs.rmSync(agentRoot, { recursive: true, force: true }) }
  })

  it("rejects a structurally valid scheduler receipt after MAC-bound evidence is tampered", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scheduler-health-tamper-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = `${agentRoot}/state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`
    const receipt = validCronHealthProbeReceipt(scenarioHandleDigest)
    ;(receipt.schedulerReceipt as Record<string, unknown>).runnerId = "33333333-3333-4333-8333-333333333333"
    await expect(readDefaultSanctuaryScenarioFacts("unit-16f-cron-fingerprint", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === receiptPath) return JSON.stringify(receipt); if (file === `${agentRoot}/state/senses/telegram/identity.key`) return "k".repeat(43); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
      telegramCredentials: () => ({ botToken: "123:test", authorizedUserId: "1", authorizedChatId: "1" }),
    }), agentRoot)).rejects.toThrow(/scheduler liveness receipt/u)
  })

  it.each([
    ["stale scenario binding", { scenarioHandleDigest: "b".repeat(64) }],
    ["wrong label", { label: "unit-16g-health-transition" }],
    ["unrestored state", { restoredStateDigest: "8".repeat(64) }],
    ["non-boundary clock", { effectiveNow: "2026-08-20T16:00:00.001Z" }],
    ["mismatched delivery count", { deliveryCount: 2 }],
    ["missing private turn count", { privateTurnCount: undefined }],
    ["provider count below private turns", { privateTurnCount: 2, providerInvocationCount: 1 }],
    ["provider count above bound", { providerInvocationCount: 1_001 }],
    ["mismatched fixture sequence", { fixtureSequenceDigest: "9".repeat(64) }],
    ["malformed phase", { phases: [{ ordinal: 1, name: "digest-first", trigger: "acceptance", fixtureStatus: 503, opened: 0, recovered: 0, digestDue: true, deliveryKind: "digest", sweepReceiptDigest: "5".repeat(64), deliveryReceiptDigest: "6".repeat(64), extra: true }] }],
  ])("rejects a health probe receipt with %s", async (_label, patch) => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-health-probe-invalid-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = `${agentRoot}/state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`
    await expect(readDefaultSanctuaryScenarioFacts("unit-16h-daily-digest", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === receiptPath) return JSON.stringify(validHealthProbeReceipt(scenarioHandleDigest, patch)); throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
    }), agentRoot)).rejects.toThrow()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it.each([
    ["malformed JSON", "{"],
    ["oversized bytes", "x".repeat(128 * 1024 + 1)],
  ])("rejects a %s health probe receipt", async (_label, raw) => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-health-probe-invalid-raw-"))
    const scenarioHandleDigest = "a".repeat(64)
    const receiptPath = `${agentRoot}/state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`
    await expect(readDefaultSanctuaryScenarioFacts("unit-16h-daily-digest", scenarioHandleDigest, unit16Deps({
      readFixedFile: (file) => { if (file === receiptPath) return raw; throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
    }), agentRoot)).rejects.toThrow()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("executes exact Unraid create/store/probe/read/revoke lifecycle operations", async () => {
    const calls: Array<Record<string, unknown>> = []
    const read = READ_PERMISSIONS.map((permission) => `${permission.resource}:READ_ANY`)
    const oldRecord = { id: "old-id", name: "Old", permissions: READ_PERMISSIONS, roles: [], key: "old-secret" }
    let machine = { unraidGraphqlUrl: "http://127.0.0.1:2378/graphql" } as Record<string, unknown>
    const deps = unit16Deps({
      refreshMachine: async () => refreshed(machine),
      mergeMachine: async (_agent, _machine, patch) => { machine = { ...machine, ...patch }; return refreshed(machine) },
      hostRequest: async (payload) => {
        calls.push(payload)
        if (payload.operation === "inventory_keys") return { keys: [oldRecord, { ...oldRecord, id: "z-id", name: "Zed" }] }
        if (payload.operation === "create_key") return { id: "new-id", name: payload.name, key: "new-secret", permissions: READ_PERMISSIONS, roles: [] }
        if (payload.operation === "read_key_record") return oldRecord
        if (payload.operation === "revoke_key") return { revoked: true, id: "old-id" }
        if (payload.operation === "probe_revoked_key") return { valid: false, status: 401, id: "old-id" }
        throw new Error("unexpected host request")
      },
      fetch: vi.fn(async () => jsonResponse({ data: { info: { os: { hostname: "sanctuary" } } } })) as typeof fetch,
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "inventory_keys", targetServerId: "sanctuary-unraid" }, deps)).resolves.toMatchObject({ keys: [{ id: "old-id", name: "Old" }, { id: "z-id", name: "Zed" }] })
    const created = await executeSanctuaryAcceptanceAdapter({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO Rotation a1a1a1a1a1a1a1a1", permissions: read }, deps) as any
    expect(created).toMatchObject({ id: "new-id", key: "unraid-key:new-id:unraidReadApiKey" })
    expect(JSON.stringify(created)).not.toContain("new-secret")
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "new-id", key: created.key }, deps)).resolves.toEqual({ stored: true, keyId: "new-id" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "new-id", key: created.key }, deps)).resolves.toEqual({ valid: true })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "old-id" }, deps)).resolves.toEqual({ key: "unraid-key:old-id:legacy" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoke_key", targetServerId: "sanctuary-unraid", id: "old-id" }, deps)).resolves.toEqual({ revoked: true, id: "old-id" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "old-id", key: "unraid-key:old-id:legacy" }, deps)).resolves.toEqual({ valid: false, status: 401, id: "old-id" })
    expect(calls.map((call) => call.operation)).toEqual(["inventory_keys", "create_key", "read_key_record", "revoke_key", "probe_revoked_key"])
    expect(JSON.stringify(calls)).not.toContain("old-secret")
  })

  it("captures fixed evidence provenance and bounded reboot request/poll state", async () => {
    const files: Record<string, string> = {
      "/run/ouro-acceptance/image-digest": "a".repeat(64),
      "/run/ouro-acceptance/container-digest": "b".repeat(64),
      "/run/ouro-acceptance/process-binding-digest": "f".repeat(64),
      "/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json": '{"nextUpdateId":4}\n',
      [AUDIT_PATH]: "event\n",
      [AUDIT_HEAD_PATH]: "head\n",
      "/run/ouro-acceptance/postboot-health.json": JSON.stringify({ healthy: true }),
      "/run/ouro-acceptance/boot-id": "boot-after\n",
    }
    const calls: unknown[] = []
    const deps = unit16Deps({
      readFixedFile: (file) => files[file]!,
      hostRequest: async (payload) => {
        calls.push(payload)
        if (payload.operation === "reboot_preflight_snapshot") return { arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, safe: true, digest: "e".repeat(64), processBindingDigest: payload.processBindingDigest }
        const requestId = payload.idempotencyKey === "c".repeat(32)
          ? "0601926a228a699dfc43ce0bde272b874aea53e6b894c0bd85118bddd7bb7884"
          : "697764ef46c1e7073061a38e3c37eb7c7f7f2f37c9391dd7c603058fbce91d8e"
        return {
          accepted: true, staged: true, targetId: "sanctuary",
          requestId,
          prebootId: "boot-after", preflightDigest: payload.preflightDigest, processBindingDigest: payload.processBindingDigest,
          reservationId: createHash("sha256").update(`sanctuary-reboot-reservation\0${requestId}`).digest("hex"),
        }
      },
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "capture_evidence_provenance", schema: "sanctuary-unit-16-provenance-v1" }, deps)).resolves.toEqual({
      imageDigest: "a".repeat(64), containerDigest: "b".repeat(64), cursorDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, deps)).resolves.toMatchObject({ healthy: true, containerImageDigest: "a".repeat(64) })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "reboot_preflight_snapshot", targetId: "sanctuary" }, deps)).resolves.toMatchObject({ safe: true, processBindingDigest: "f".repeat(64) })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "c".repeat(32), preflightDigest: "e".repeat(64), processBindingDigest: "f".repeat(64) }, deps)).resolves.toMatchObject({ accepted: true, targetId: "sanctuary", prebootId: "boot-after" })
    const requested = await executeSanctuaryAcceptanceAdapter({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "d".repeat(32), preflightDigest: "e".repeat(64), processBindingDigest: "f".repeat(64) }, deps) as any
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "poll_reboot", targetId: "sanctuary", requestId: requested.requestId }, deps)).resolves.toEqual({ targetId: "sanctuary", requestId: requested.requestId, state: "ready", bootId: "boot-after" })
    expect(calls).toContainEqual({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "c".repeat(32), preflightDigest: "e".repeat(64), processBindingDigest: "f".repeat(64) })
    expect(calls).toContainEqual({ operation: "reboot_preflight_snapshot", targetId: "sanctuary", processBindingDigest: "f".repeat(64) })
  })

  it("binds postboot continuity to every validated restart-attempt field and lifecycle row", async () => {
    const attempt = (state: "attempt_not_started" | "attempting" | "succeeded", beforeState = "running") => ({
      actionDigest: "1".repeat(64), afterState: state === "succeeded" ? "running" : null, approvalId: "approval-1",
      argumentDigest: "2".repeat(64), attemptId: "attempt-1", beforeState,
      container: { id: "Docker:calibre-web", name: "calibre-web" }, mutationAcknowledged: state === "succeeded",
      observedAt: state === "attempt_not_started" ? "2026-08-20T01:00:00.000Z" : state === "attempting" ? "2026-08-20T01:00:01.000Z" : "2026-08-20T01:00:02.000Z",
      scenarioHandleDigest: "a".repeat(64), state,
    })
    const snapshot = async (beforeState = "running") => executeSanctuaryAcceptanceAdapter({ operation: "postboot_integrity_snapshot" }, unit16Deps({
      readFixedFile: (file) => {
        if (file.endsWith("offset.json")) return '{"nextUpdateId":42}\n'
        if (file.endsWith("restart-attempts.ndjson")) return [attempt("attempt_not_started", beforeState), attempt("attempting", beforeState), attempt("succeeded", beforeState)].map((row) => JSON.stringify(row)).join("\n") + "\n"
        throw Object.assign(new Error("absent"), { code: "ENOENT" })
      },
    })) as Promise<{ restartAttempts: Array<{ recordDigest: string; state: string }> }>
    const baseline = await snapshot()
    const changed = await snapshot("exited")
    expect(baseline.restartAttempts.map((row) => row.state)).toEqual(["attempt_not_started", "attempting", "succeeded"])
    expect(changed.restartAttempts.map((row) => row.recordDigest)).not.toEqual(baseline.restartAttempts.map((row) => row.recordDigest))
  })

  it("materializes executable configs from only fixed live state", async () => {
    const contract = fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")
    const deps = unit16Deps({ readFixedFile: (file) => {
      if (file.endsWith("sanctuary-acceptance-contract.json")) return contract
      if (file.endsWith("offset.json")) return '{"nextUpdateId":91}'
      if (file.endsWith("closed-inventory.json")) return '{"keys":[{"id":"old-rw"},{"id":"old-ro"}]}'
      throw new Error("unexpected fixed file")
    } })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "telegram-bootstrap" }, deps)).resolves.toMatchObject({
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 91,
      pollerAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "cursor-snapshot", phase: "before" }, deps)).resolves.toMatchObject({ evidencePath: "/evidence/cursor-before.json" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "unraid-key-rotate" }, deps)).resolves.toMatchObject({
      oldKeys: [{ id: "old-ro", secretAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh" }, { id: "old-rw", secretAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh" }],
    })
    const bundle = await executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "evidence-bundle-index" }, deps) as any
    expect(bundle.entries).toHaveLength(22)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "evidence-bundle-verify" }, deps)).resolves.toMatchObject({ evidencePath: "/evidence/unit-16-evidence-bundle.json" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "missing" }, deps)).rejects.toThrow(/template/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "cursor-snapshot", phase: "invalid" }, deps)).rejects.toThrow(/phase/u)
    const malformed = (offset: string, inventory: string) => unit16Deps({ readFixedFile: (file) => file.endsWith("contract.json") ? contract : file.endsWith("offset.json") ? offset : inventory })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "telegram-bootstrap" }, malformed('{"nextUpdateId":-1}', "{}"))).rejects.toThrow(/offset/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "unraid-key-rotate" }, malformed("{}", '{"keys":[]}'))).rejects.toThrow(/empty/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "materialize_config", command: "unraid-key-rotate" }, malformed("{}", '{"keys":[{"id":"same"},{"id":"same"}]}'))).rejects.toThrow(/ambiguous/u)
  })

  it("refuses invalid Unit 16 adapter inputs and failed bounded dependencies", async () => {
    const reject = (payload: Record<string, unknown>, deps = unit16Deps()) => expect(executeSanctuaryAcceptanceAdapter(payload, deps)).rejects.toThrow()
    await reject({ operation: "quiesce_telegram_poller", expectedState: "running" })
    await reject({ operation: "quiesce_telegram_poller", expectedState: "stopped", extra: true })
    await reject({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, unit16Deps({ readFixedFile: () => "{}" }))
    await reject({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, unit16Deps({ readFixedFile: () => '{"activePollers":1,"productionContainerStopped":true}' }))
    await reject({ operation: "quiesce_telegram_poller", expectedState: "stopped" }, unit16Deps({ readFixedFile: () => '{"activePollers":0,"productionContainerStopped":false}' }))
    await reject({ operation: "store_telegram_bootstrap", botToken: "x", authorizedUserId: "1", authorizedChatId: "2" }, unit16Deps({ mergeRuntime: async () => ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" }) }))
    await reject({ operation: "store_telegram_bootstrap", botToken: "x", authorizedUserId: "1", authorizedChatId: "2" }, unit16Deps({ mergeRuntime: async () => refreshed({ telegramBotToken: "other" }) }))
    await reject({ operation: "snapshot", schema: "telegram-cursor-v1" }, unit16Deps({ readFixedFile: () => '{"nextUpdateId":-1}' }))
    await reject({ operation: "snapshot", schema: "telegram-cursor-v1" }, { ...unit16Deps(), readFixedFile: undefined })
    for (const concurrency of [1, 17, 2.5]) await reject({ operation: "inject_callbacks_concurrently", update: { callback_query: {} }, concurrency })
    await reject({ operation: "inject_callbacks_concurrently", update: {}, concurrency: 2 })
    await reject({ operation: "inject_callback_replay", update: { callback_query: {} } }, { ...unit16Deps(), callbackProbe: undefined })
    await reject({ operation: "inventory_keys", targetServerId: "other" })
    for (const permissions of [[], ["bad"], ["ARRAY:READ_ANY", "ARRAY:READ_ANY"]]) await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions })
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Admin", permissions: ["ARRAY:READ_ANY"] })
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions: ["ARRAY:READ_ANY"] })
    const read = READ_PERMISSIONS.map((permission) => `${permission.resource}:READ_ANY`)
    const write = [...read, "DOCKER:UPDATE_ANY"]
    const createDeps = (created: unknown, mergeMachine = async (_agent: string, _machine: string, patch: Record<string, unknown>) => refreshed(patch)) => unit16Deps({
      hostRequest: async () => created, mergeMachine,
    })
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions: read }, createDeps({ id: "id", name: "wrong", key: "k", permissions: READ_PERMISSIONS, roles: [] }))
    await reject({ operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RW Rotation a1a1a1a1a1a1a1a1", permissions: write }, createDeps({ id: "id", name: "Butler RW Rotation a1a1a1a1a1a1a1a1", key: "k", permissions: [...READ_PERMISSIONS, { resource: "DOCKER", actions: ["UPDATE_ANY"] }], roles: [] }, async () => ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" })))
    await reject({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "other", keyId: "id", key: "x" })
    await reject({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "id", key: "wrong" })
    await reject({ operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "id", key: "unraid-key:id:unraidReadApiKey" }, unit16Deps({ refreshMachine: async () => refreshed({ unraidReadApiKey: "x", sanctuaryAcceptanceKeyHandles: { id: "y" } }) }))
    await reject({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "id", key: "bad" })
    const probeConfig = { unraidGraphqlUrl: "http://127.0.0.1/graphql", sanctuaryAcceptanceKeyHandles: { id: "k" } }
    await reject({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:unraidReadApiKey" }, unit16Deps({ refreshMachine: async () => refreshed(probeConfig), fetch: async () => { throw new Error("x") } }))
    await reject({ operation: "probe_new_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:unraidReadApiKey" }, unit16Deps({ refreshMachine: async () => refreshed(probeConfig), fetch: async () => jsonResponse({ errors: [{}] }, 403) }))
    await reject({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "id" })
    await reject({ operation: "read_old_key", targetServerId: "sanctuary-unraid", id: "id" }, unit16Deps({ hostRequest: async () => ({ id: "id", name: "Old", permissions: READ_PERMISSIONS, roles: [], key: "k" }), mergeMachine: async () => ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" }) }))
    await reject({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "bad" })
    const revokedDeps = (status: number, ok = true) => unit16Deps({ hostRequest: async () => ({ valid: false, status, id: "id" }), mergeMachine: async () => ok ? refreshed({}) : ({ ok: false, reason: "unavailable", itemPath: "x", error: "x" }) })
    await reject({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:legacy" }, revokedDeps(200))
    await reject({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:legacy" }, revokedDeps(401, false))
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "id", key: "unraid-key:id:legacy" }, revokedDeps(403))).resolves.toMatchObject({ valid: false, status: 403 })
    await reject({ operation: "capture_evidence_provenance", schema: "bad" })
    await reject({ operation: "capture_evidence_provenance", schema: "sanctuary-unit-16-provenance-v1" }, unit16Deps({ readFixedFile: () => "bad" }))
    await reject({ operation: "evidence_snapshot", schema: "bad" })
    await reject({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, unit16Deps({ readFixedFile: (file) => file.endsWith("health.json") ? '{"healthy":true,"extra":1}' : "a".repeat(64) }))
    await reject({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, unit16Deps({ readFixedFile: (file) => file.endsWith("health.json") ? '{"healthy":"yes"}' : "a".repeat(64) }))
    await reject({ operation: "evidence_snapshot", schema: "postboot-health-v1" }, unit16Deps({ readFixedFile: (file) => file.endsWith("health.json") ? '{"healthy":true}' : "bad" }))
    await reject({ operation: "request_reboot", targetId: "other", idempotencyKey: "a".repeat(32) })
    await reject({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "bad" })
    await reject({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "a".repeat(32) }, unit16Deps({ hostRequest: async () => ({ accepted: true, staged: false }) }))
    await reject({ operation: "poll_reboot", targetId: "other", requestId: "a".repeat(64) })
    await reject({ operation: "poll_reboot", targetId: "sanctuary", requestId: "bad" })
  })

  it("maps live callback transport outcomes without exposing the approval runtime", async () => {
    const update = { callback_query: {} }
    const base = (result: Record<string, unknown>, refresh = async () => refreshed({})) => ({
      refresh,
      credentials: () => ({ botToken: "secret", authorizedUserId: "1", authorizedChatId: "2" }),
      identityKey: () => "a".repeat(43),
      createApi: () => ({ stop: vi.fn() }) as any,
      createRuntime: () => ({ transport: { handleUpdate: async () => result }, close: vi.fn() }) as any,
      toolContext: () => ({} as any),
    })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false, base({ handled: true, accepted: true, reason: "accepted" }))).resolves.toEqual({ settled: true, claimed: true, mutated: true })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false, base({ handled: true, accepted: false, reason: "decision_refused" }))).resolves.toEqual({ settled: true, claimed: true, mutated: false })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, true, base({ handled: true, accepted: false, reason: "stale_callback" }))).resolves.toEqual({ settled: true, claimed: false, mutated: false })
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false, base({}, async () => ({ ok: false, reason: "missing", itemPath: "x", error: "x" })))).rejects.toThrow(/unavailable/u)
  })

  it("loads fixed default adapter records and files", () => {
    const root = fs.mkdtempSync("/tmp/ouro-default-acceptance-")
    const keyFile = `${root}/key.json`
    fs.writeFileSync(keyFile, JSON.stringify({ id: "id", name: "Butler RO", permissions: READ_PERMISSIONS, roles: [], key: "secret" }))
    try {
      const deps = createSanctuaryAcceptanceAdapterDependencies(3, { keyDirectory: root })
      expect(deps.readKeyRecords?.()).toEqual([expect.objectContaining({ id: "id", key: "secret" })])
      expect(deps.readFixedFile?.(keyFile)).toContain('"id":"id"')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses every ambiguous vault capability proof envelope", async () => {
    const run = (capability: "read-only" | "bounded-write", writeBody: unknown, status = 200) => {
      const permissions = capability === "read-only" ? READ_PERMISSIONS : READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER" ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] } : permission)
      const record = { id: `${capability}-id`, name: capability === "read-only" ? "Butler RO" : "Butler RW", permissions, roles: [], key: `${capability}-secret` }
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ data: { info: {} } })).mockResolvedValueOnce(jsonResponse(writeBody, status)) as typeof fetch
      return executeSanctuaryAcceptanceVaultProbe(record.id, capability, {
        refresh: async () => refreshed({ unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: record.key, unraidWriteApiKey: record.key }),
        readKeyRecords: () => [record], fetch: fetchImpl,
      })
    }
    await expect(run("read-only", { data: {} }, 403)).rejects.toThrow(/denial/u)
    await expect(run("read-only", { errors: [] })).rejects.toThrow(/denial/u)
    await expect(run("bounded-write", { data: {} })).rejects.toThrow(/not-found/u)
    await expect(run("bounded-write", { errors: [{ extensions: { code: "NOT_FOUND" } }] }, 500)).rejects.toThrow(/not-found/u)
    await expect(run("bounded-write", { errors: [{ extensions: null }, { extensions: { code: 1 } }] })).rejects.toThrow(/not-found/u)
    await expect(run("bounded-write", {})).rejects.toThrow(/not-found/u)
  })

  it("loads only the selected mounted key record for vault proof", () => {
    const root = fs.mkdtempSync("/tmp/ouro-selected-unraid-key-")
    const selected = `${root}/selected.json`
    fs.writeFileSync(selected, JSON.stringify({
      id: "read-id",
      name: "Butler RO",
      permissions: READ_PERMISSIONS,
      roles: [],
      key: "read-descriptor",
    }))
    try {
      const deps = createSanctuaryAcceptanceVaultProbeDependencies({ keyRecordPath: selected })
      expect(deps.readKeyRecords()).toEqual([expect.objectContaining({ id: "read-id", key: "read-descriptor" })])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("binds the read-only vault descriptor to the exact key ID and proves write denial", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { info: { os: { hostname: "opaque" } } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] })) as typeof fetch
    const deps = {
      refresh: async () => refreshed({
        unraidGraphqlUrl: "http://127.0.0.1:2378/graphql",
        unraidReadApiKey: "read-descriptor",
        unraidWriteApiKey: "write-descriptor",
      }),
      readKeyRecords: () => [
        { id: "read-id", name: "Butler RO", permissions: READ_PERMISSIONS, roles: [], key: "read-descriptor" },
        { id: "write-id", name: "Butler RW", permissions: READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER"
          ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
          : permission), roles: [], key: "write-descriptor" },
      ],
      fetch: fetchImpl,
    }

    await expect(executeSanctuaryAcceptanceVaultProbe("read-id", "read-only", deps)).resolves.toEqual({
      valid: true,
      keyId: "read-id",
      capability: "read-only",
      proof: "read-authorized-write-denied",
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:2378/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: READ_QUERY, variables: {} }),
      headers: { "content-type": "application/json", "x-api-key": "read-descriptor" },
      signal: expect.any(AbortSignal),
    }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:2378/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: WRITE_QUERY, variables: { id: MISSING_CONTAINER_ID } }),
      headers: { "content-type": "application/json", "x-api-key": "read-descriptor" },
      signal: expect.any(AbortSignal),
    }))
  })

  it("binds the bounded-write descriptor to exact metadata and proves harmless mutation authorization", async () => {
    const writeKey = {
      id: "write-id",
      name: "Butler RW",
      permissions: READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER"
        ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
        : permission),
      roles: [],
      key: "write-descriptor",
    }
    const base = {
      refresh: async () => refreshed({
        unraidGraphqlUrl: "http://127.0.0.1:2378/graphql",
        unraidReadApiKey: "read-descriptor",
        unraidWriteApiKey: "write-descriptor",
      }),
      readKeyRecords: () => [writeKey],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { info: { os: { hostname: "opaque" } } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Container not found", extensions: { code: "NOT_FOUND" } }] })) as typeof fetch

    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", { ...base, fetch: fetchImpl })).resolves.toEqual({
      valid: true,
      keyId: "write-id",
      capability: "bounded-write",
      proof: "read-authorized-write-reached-not-found",
    })
    expect(JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      query: WRITE_QUERY,
      variables: { id: MISSING_CONTAINER_ID },
    })

    await expect(executeSanctuaryAcceptanceVaultProbe("other-id", "bounded-write", {
      ...base,
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/descriptor.*exact key ID/iu)
    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", {
      ...base,
      readKeyRecords: () => [{ ...writeKey, permissions: READ_PERMISSIONS }],
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/scope/iu)
  })

  it("packages explicit vault and revoked probe modes without putting descriptors in argv", () => {
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-adapter.sh", "utf8")

    expect(wrapper).toContain("vault-probe")
    expect(wrapper).toContain("revoked-probe")
    expect(wrapper).toContain("callback-probe")
    expect(wrapper).toContain("3<&0")
    expect(wrapper).not.toMatch(/descriptor.*\$[234]/u)
  })

  it("binds a revoked raw key file from fd3 to argv ID without returning its descriptor", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }, 401)) as typeof fetch
    const rawKeyFile = JSON.stringify({ id: "revoked-id", name: "Legacy", key: "revoked-descriptor" })

    await expect(executeSanctuaryAcceptanceRevokedProbe(
      "revoked-id",
      "http://127.0.0.1:2378/graphql",
      rawKeyFile,
      { fetch: fetchImpl },
    )).resolves.toEqual({ rejected: true, id: "revoked-id", status: 401 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:2378/graphql")
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "revoked-descriptor",
    })
    await expect(executeSanctuaryAcceptanceRevokedProbe(
      "other-id",
      "http://127.0.0.1:2378/graphql",
      rawKeyFile,
      { fetch: fetchImpl },
    )).rejects.toThrow(/ID mismatch/u)
  })
})

function unit16Deps(overrides: Partial<SanctuaryAcceptanceAdapterDependencies> = {}): SanctuaryAcceptanceAdapterDependencies {
  return {
    readKeyFiles: () => [],
    readKeyRecords: () => [],
    readDescriptor: () => "",
    readFixedFile: () => "",
    execFile: async () => ({ status: 0, stdout: "{}" }),
    fetch: async () => jsonResponse({}),
    refreshRuntime: async () => refreshed({}),
    mergeRuntime: async (_agent, patch) => refreshed(patch),
    refreshMachine: async () => refreshed({}),
    mergeMachine: async (_agent, _machine, patch) => refreshed(patch),
    callbackProbe: async () => ({ settled: true, claimed: false, mutated: false }),
    hostRequest: async () => ({}),
    runProductionBoundaryProbe: async () => [
      ...["shell", "read_file", "edit_file", "vault_get", "mcp_call", "exec", "credential_get"].map((name, index) => ({ name, reason: "profile_excluded" as const, globallyResolvable: index < 4, invoked: false, sideEffect: false })),
      { name: "unraid_get_system", reason: "dispatched", globallyResolvable: true, invoked: true, sideEffect: false },
    ],
    ...overrides,
  }
}
