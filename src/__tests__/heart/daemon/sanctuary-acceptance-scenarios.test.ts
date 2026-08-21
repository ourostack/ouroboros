import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

const fsFaults = vi.hoisted(() => ({
  lstatSync: null as null | ((actual: typeof import("node:fs").lstatSync, target: import("node:fs").PathLike, options?: unknown) => import("node:fs").Stats),
  unlinkSync: null as null | ((actual: typeof import("node:fs").unlinkSync, target: import("node:fs").PathLike) => void),
}))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    lstatSync: (target: fs.PathLike, options?: unknown) => fsFaults.lstatSync?.(actual.lstatSync, target, options) ?? actual.lstatSync(target, options as never),
    unlinkSync: (target: fs.PathLike) => fsFaults.unlinkSync?.(actual.unlinkSync, target) ?? actual.unlinkSync(target),
  }
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scenarios-"))
vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => path.join(root, "sanctuary.ouro") }))

import {
  createSanctuaryScenarioCapture,
  deriveSanctuaryScenarioAssertions,
  verifySanctuaryPostbootIntegrity,
  finalizeSanctuaryScenarioCapture,
  terminalizedWithinTtlJitter,
  type SanctuaryScenarioFacts,
} from "../../../heart/daemon/sanctuary-acceptance-scenarios"
import { SANCTUARY_SCENARIO_SOURCES, SANCTUARY_UNIT_16_EVIDENCE_LABELS, validateSanctuaryUnit16EvidenceAssertions } from "../../../heart/daemon/sanctuary-acceptance-harness"
import { readSanctuaryAcceptanceMarker, secureRenameBoundInodeSync } from "../../../heart/daemon/sanctuary-acceptance-marker"
import { createSanctuaryAcceptanceScenarioFinalizer } from "../../../heart/daemon/sanctuary-acceptance-adapter"

const event = (name: string) => ({ event: name, at: 1, meta: {} })
const scenarioHandleDigest = "a".repeat(64)
const auditTurn = (outcome: "success" | "error" = "success") => {
  const coordinates = {
    scenarioHandleDigest,
    turnDigest: "7".repeat(64),
    updateDigest: "1".repeat(64),
    subject: `tg_${"s".repeat(43)}`,
    identityDigest: "8".repeat(64),
    sessionDigest: "9".repeat(64),
    argumentDigest: "a".repeat(64),
    lifecycleAt: 9_000,
    lifecycleMac: "c".repeat(64),
  }
  return [
    { event: "senses.telegram_turn_start", at: 9_000, meta: coordinates },
    { event: outcome === "success" ? "senses.telegram_turn_end" : "senses.telegram_turn_error", at: 10_000, meta: {
      ...coordinates,
      outcome,
      errorDigest: outcome === "success" ? null : "b".repeat(64),
      deliveryCount: outcome === "success" ? 1 : 0,
      lifecycleAt: 10_000,
      lifecycleMac: "d".repeat(64),
    } },
  ]
}
const groundingDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const systemGrounding = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
const storageGrounding = { array: { state: "STARTED", usedBytes: 8_000_000_000_000, freeBytes: 2_000_000_000_000, usedPercent: 80, degraded: false }, shares: [], truncated: false }
const groundingSource = "9".repeat(64)
const approvalArgumentDigest = createHash("sha256").update(JSON.stringify({ container: "calibre-web" })).digest("hex")
const canonicalTargetId = `Docker:${"7".repeat(64)}`
const restartResult = JSON.stringify({ ok: true, data: { container: { id: canonicalTargetId, name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } })
const approvalResultDigest = (state: string) => createHash("sha256").update(JSON.stringify({ state, result: state === "succeeded" ? restartResult : null })).digest("hex")
const restartActionDigest = createHash("sha256").update(JSON.stringify({ operation: "restart", container: { id: canonicalTargetId, name: "calibre-web" } })).digest("hex")
const promptActionDigest = createHash("sha256").update(JSON.stringify({ toolName: "unraid_restart_container", argumentDigest: approvalArgumentDigest })).digest("hex")
const targetDigest = createHash("sha256").update(JSON.stringify({ container: "calibre-web" })).digest("hex")
const checkpointDigest = "2".repeat(64)
const suspendedSessionRevisionDigest = createHash("sha256").update("c".repeat(64)).digest("hex")
const approvalAuditEvent = (eventName: string, at: number, patch: Record<string, unknown> = {}) => ({
  event: eventName,
  at,
  meta: {
    scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1", actionDigest: promptActionDigest,
    targetDigest, checkpointDigest, suspendedSessionRevisionDigest, messageIdDigest: "4".repeat(64), evidenceMac: "5".repeat(64), ...patch,
  },
})
const approvalEvidence = (decision: "approve" | "deny", boundAt = 1_000, callbackAt = 121_000) => [
  approvalAuditEvent("senses.telegram_approval_prompt_bound", boundAt, { boundAt }),
  approvalAuditEvent("telegram.callback_settled", callbackAt, { boundAt, callbackAt, acknowledged: true, acknowledgementState: "acknowledged", decisionAttemptDigest: "6".repeat(64), accepted: decision === "approve", reason: decision === "approve" ? "accepted" : "decision_refused" }),
  approvalAuditEvent("senses.telegram_approval_continuation_delivered", callbackAt + 1, { boundAt, deliveredAt: callbackAt + 1, resultDigest: approvalResultDigest(decision === "approve" ? "succeeded" : "denied"), deliveryDigest: "8".repeat(64), deliveryMessageIdDigest: "7".repeat(64) }),
  approvalAuditEvent("telegram.approval_prompt_terminalized", callbackAt + 2, { boundAt, terminalEditStartedAt: callbackAt + 1, terminalizedAt: callbackAt + 2, buttonsRemoved: true }),
]
const staleCallbackEvidence = (staleAt = 301_001) => approvalAuditEvent("telegram.approval_stale_callback_settled", staleAt, {
  boundAt: 1_000, staleAt, acknowledged: true, accepted: false, reason: "stale_callback",
})
const expiryObservationEvidence = (expiryObservedAt = 301_000) => approvalAuditEvent("telegram.approval_expiry_observed", expiryObservedAt, {
  boundAt: 1_000, expiryObservationSchemaVersion: "telegram-approval-expiry-observation-v1",
  expiryDeadlineAt: 301_000, expiryObservedAt,
})
const groundedTurn = (toolName: "unraid_get_system" | "unraid_get_storage", facts: unknown, responseText: string) => {
  const resultDigest = "5".repeat(64)
  const factDigest = groundingDigest(facts)
  return {
    status: "success" as const, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64),
    toolResultDigests: [resultDigest], providerTurnCount: 1, toolInvocationCount: 1, deliveryCount: 1,
    telegramMessageIdDigests: ["4".repeat(64)], completedAt: 10_000, responseText, responseUtf16Units: responseText.length,
    toolGroundings: [{ toolName, resultDigest, groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z", facts }],
  }
}
const turnReceipt = (toolResultDigests: string[] = []) => ({ status: "success" as const, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64), toolResultDigests, providerTurnCount: 1, toolInvocationCount: toolResultDigests.length, deliveryCount: 1, telegramMessageIdDigests: ["4".repeat(64)], completedAt: 10_000 })
const approval = (state: string) => ({ approvalId: "approval-1", state, toolName: "unraid_restart_container", createdAt: 1_000, expiresAt: 301_000, updatedAt: 302_000, attempted: state === "succeeded", continuationCompleted: true, buttonsRemoved: true, terminalPrompt: true, callbackCount: 0, settledCount: 0, claimCount: state === "succeeded" ? 1 : 0, replayMutationCount: 0, staleAcknowledged: true, argumentDigest: approvalArgumentDigest, target: "calibre-web", resultDigest: approvalResultDigest(state), resultTargetId: state === "succeeded" ? canonicalTargetId : null, checkpointDigest: "2".repeat(64), approvalEpoch: 0, continuationEpoch: 1, continuationState: "completed", suspendedSessionRevision: "c".repeat(64) })
const restartContinuationDriver = () => ({
  schemaVersion: "sanctuary-interactive-driver-receipt-v2" as const,
  label: "unit-16m-restart-continuation" as const,
  scenarioHandleDigest: "a".repeat(64), approvalIdDigest: createHash("sha256").update("approval-1").digest("hex"), checkpointDigest: "2".repeat(64),
  suspendedSessionRevisionDigest: createHash("sha256").update("c".repeat(64)).digest("hex"),
  approvalEpochBefore: 0, approvalEpochAfterRestart: 0, continuationEpochAfter: 1,
  ownerImageDigest: "3".repeat(64), ownerContainerDigest: "4".repeat(64), restartCountBefore: 7, restartCountAfter: 8,
  pendingDigestBefore: "6".repeat(64), pendingDigestAfter: "6".repeat(64), pendingRestored: true, callbackAttempts: 1, mutationCount: 1,
  indeterminateRecoveryObserved: true, attemptedRecoveryReopened: true,
  attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "8".repeat(64), indeterminateRetryCount: 0,
})
const duplicateCallbackDriver = () => ({
  schemaVersion: "sanctuary-interactive-driver-receipt-v2" as const,
  label: "unit-16l-duplicate-callback" as const, scenarioHandleDigest: "a".repeat(64),
  approvalIdDigest: createHash("sha256").update("approval-1").digest("hex"), checkpointDigest: "2".repeat(64), suspendedSessionRevisionDigest: createHash("sha256").update("c".repeat(64)).digest("hex"), approvalEpochBefore: 0,
  callbackAttempts: 2, distinctQueryCount: 2, callbackDataDigest: "6".repeat(64), barrierObserved: true,
  settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1,
  staleReplaySettled: true, staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false,
})
const timeoutStaleDriver = () => ({
  schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1" as const, label: "unit-16k-timeout-stale" as const,
  scenarioHandleDigest: "a".repeat(64), approvalIdDigest: createHash("sha256").update("approval-1").digest("hex"), checkpointDigest: "2".repeat(64),
  suspendedSessionRevisionDigest: createHash("sha256").update("c".repeat(64)).digest("hex"), approvalEpochBefore: 0,
  callbackAttempts: 1, distinctQueryCount: 1, callbackDataDigest: "6".repeat(64), settledCount: 1,
  claimCount: 0, mutationCount: 0, staleAcknowledged: true, promptTerminal: true,
})
const successfulRestart = () => ([
  { state: "attempt_not_started" as const, actionDigest: restartActionDigest, argumentDigest: approvalArgumentDigest, target: "calibre-web", targetId: canonicalTargetId, approvalId: "approval-1", attemptId: "attempt-1", observedAt: 1_000, mutationAcknowledged: false, afterState: null },
  { state: "attempting" as const, actionDigest: restartActionDigest, argumentDigest: approvalArgumentDigest, target: "calibre-web", targetId: canonicalTargetId, approvalId: "approval-1", attemptId: "attempt-1", observedAt: 2_000, mutationAcknowledged: false, afterState: null },
  { state: "succeeded" as const, actionDigest: restartActionDigest, argumentDigest: approvalArgumentDigest, target: "calibre-web", targetId: canonicalTargetId, approvalId: "approval-1", attemptId: "attempt-1", observedAt: 3_000, mutationAcknowledged: true, afterState: "running" },
])
const probeDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const probePhase = (ordinal: number, name: string, trigger: "cron" | "acceptance", fixtureStatus: 200 | 503 | null, opened: number, recovered: number, digestDue: boolean, deliveryKind: "transition" | "digest" | null) => ({
  ordinal, name, trigger, fixtureStatus, opened, recovered, digestDue, deliveryKind,
  sweepReceiptDigest: probeDigest({ ordinal, name }), deliveryReceiptDigest: deliveryKind === null ? null : probeDigest({ ordinal, deliveryKind }),
})
const healthProbe = (label: "unit-16f-cron-fingerprint" | "unit-16g-health-transition" | "unit-16h-daily-digest") => {
  const phases = label === "unit-16f-cron-fingerprint"
    ? [probePhase(1, "cron-unchanged", "cron", null, 0, 0, false, null)]
    : label === "unit-16g-health-transition"
      ? [
          probePhase(1, "live-baseline", "acceptance", null, 0, 0, false, null), probePhase(2, "live-repeat", "acceptance", null, 0, 0, false, null),
          probePhase(3, "fixture-fail", "acceptance", 503, 1, 0, false, "transition"), probePhase(4, "fixture-repeat", "acceptance", 503, 0, 0, false, null),
          probePhase(5, "fixture-recover", "acceptance", 200, 0, 1, false, "transition"), probePhase(6, "fixture-refail", "acceptance", 503, 1, 0, false, "transition"),
        ]
      : [probePhase(1, "digest-first", "acceptance", 503, 0, 0, true, "digest"), probePhase(2, "digest-repeat", "acceptance", 503, 0, 0, false, null)]
  const fixtureSequence = phases.flatMap((phase) => phase.fixtureStatus === null ? [] : [phase.fixtureStatus])
  return {
    label, scenarioHandleDigest: "a".repeat(64), ownerImageDigestBefore: "1".repeat(64), ownerImageDigestAfter: "1".repeat(64), ownerContainerDigestBefore: "2".repeat(64), ownerContainerDigestAfter: "2".repeat(64),
    beforeStateDigest: "3".repeat(64), restoredStateDigest: "3".repeat(64), cronFingerprintBefore: "a".repeat(64), cronFingerprintAfter: "a".repeat(64), cronRegisteredBefore: true, cronRegisteredAfter: true,
    cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: probeDigest(fixtureSequence), clockMode: label === "unit-16h-daily-digest" ? "local-daily-boundary" as const : "ambient" as const,
    effectiveNow: label === "unit-16h-daily-digest" ? "2026-08-20T16:00:00.000Z" : "2026-08-20T15:00:00.000Z", phases,
    privateTurnCount: label === "unit-16f-cron-fingerprint" ? 0 : label === "unit-16g-health-transition" ? 3 : 1,
    providerInvocationCount: label === "unit-16f-cron-fingerprint" ? 0 : label === "unit-16g-health-transition" ? 5 : 2, deliveryCount: phases.filter((phase) => phase.deliveryReceiptDigest !== null).length,
    workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true,
    schedulerReceipt: label === "unit-16f-cron-fingerprint" ? {
      schemaVersion: "sanctuary-scheduler-liveness-receipt-v1" as const, label, scenarioHandleDigest: "a".repeat(64), trigger: "cron" as const,
      occurrenceId: "cron:slot-1", runnerId: "11111111-1111-4111-8111-111111111111", recordedAt: "2026-08-20T15:00:00.000Z",
      before: { sweepCount: 0, deliveryCount: 0 }, after: { sweepCount: 1, deliveryCount: 0 }, sweepDelta: 1 as const, deliveryDelta: 0 as const,
      providerInvocationCount: 0 as const, privateTurnCount: 0 as const, sweep: { recordDigest: phases[0]!.sweepReceiptDigest, opened: 0 as const, recovered: 0 as const, digestDue: false as const, deliveryId: null },
      supervisor: { schemaVersion: "supercronic-supervisor-snapshot-v1" as const, daemonPid: 1, childCount: 1 as const, childPid: 42, healthy: true as const, binaryPath: "/usr/local/bin/supercronic", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"] as ["-split-logs", "-inotify", string], crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab", namespace: "habit:sanctuary", manifest: [], renderedCrontab: "canonical" },
      nonReplay: true as const,
    } : null,
  }
}
const validDenialReceiptForFacts = () => {
  const boundary = { ownerSnapshotDigest: "1".repeat(64), targetSnapshotDigest: "2".repeat(64), targetRestartCount: 7, targetContainerIdDigest: "7".repeat(64), auditCursorDigest: "3".repeat(64), providerUsageCursorDigest: "4".repeat(64), sessionCursorDigest: "5".repeat(64), toolActionCursorDigest: "6".repeat(64) }
  return { schemaVersion: "sanctuary-read-only-denial-receipt-v1" as const, phase: "complete" as const, label: "unit-16e-1-stop-denial" as const, scenarioHandleDigest: "a".repeat(64), operation: "stop" as const, targetDigest: "7".repeat(64), attemptCount: 1, httpStatus: 403, errorCode: "FORBIDDEN", before: boundary, after: { ...boundary } }
}
const base = (): SanctuaryScenarioFacts => ({
  capturedAt: 0,
  sourceValues: Object.fromEntries(["identity-key", "telegram-audit", "telegram-offset", "telegram-turn-receipts", "live-grounding-read", "approval-journal", "approval-checkpoints", "container-inspect", "provider-live-check", "cron-runtime", "health-runtime", "digest-runtime", "health-probe-receipt", "scheduler-liveness-receipt", "reboot-checkpoint", "read-only-denial-receipt"].map((key) => [key, { key }])),
  events: [], approvals: [],
  restartAttempts: [],
  telegramTurns: [],
  telegramNextUpdateId: 10,
  zeroWork: { providerToolDigest: "1".repeat(64), outwardDigest: "2".repeat(64), approvalMutationDigest: "3".repeat(64), sessionFriendDigest: "4".repeat(64) },
  identity: { keyPresent: true, subjectOpaque: true, rawIdentityAbsent: true, liveSubjectObserved: true, inspectedRecordCount: 1, opaqueSubjectCount: 1, mismatchCount: 0, rawLeakCount: 0, surfaceDigest: "a".repeat(64), canonicalSessionCount: 1, canonicalFriendCount: 1, sessionSurfaceDigest: "b".repeat(64), friendSurfaceDigest: "c".repeat(64) },
  container: { exactImage: true, running: true, healthy: true, user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false },
  provider: { outwardReady: true, innerReady: true, geminiCandidateReady: true, providersDistinct: true, silentFallback: false, credentialRevisionsPresent: true, requestSemanticsExact: true, fallbackAttemptCount: 0, modelsExact: true, baseUrlsExact: true, vaultCoordinatesExact: true, credentialIdentitiesDistinct: true },
  cron: { registered: true, fingerprint: "a".repeat(64), receiptDigest: "b".repeat(64), sweepCount: 0 },
  health: { transitionCount: 0, alertCount: 0, productionRestored: true },
  digest: { scheduleObserved: true, messageCount: 0, firedWithinMs: 1_000, productionRestored: true },
  reboot: { phase: "complete", requestDigest: "c".repeat(64), processBindingDigest: "d".repeat(64), requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: 0, bootIdentityChanged: true, hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
  denial: validDenialReceiptForFacts(),
  containment: {
    schemaVersion: "sanctuary-containment-audit-v1", keyCount: 2, keyInventoryDigest: "1".repeat(64),
    readScopeDigest: createHash("sha256").update(JSON.stringify(["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"].map((resource) => `${resource}:READ_ANY`).sort())).digest("hex"),
    writeScopeDigest: createHash("sha256").update(JSON.stringify([...(["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"].map((resource) => `${resource}:READ_ANY`)), "DOCKER:UPDATE_ANY"].sort())).digest("hex"),
    keyRoleAssignmentCount: 0, telegramToolCount: 10,
    telegramProfileDigest: createHash("sha256").update(JSON.stringify(["unraid_list_containers", "unraid_get_container_logs", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system", "unraid_restart_container", "ponder", "settle", "speak"])).digest("hex"),
    telegramSchemaDigest: "3c66299a5f70ec82f8795cae47659284e6dbc691ef49002c2fb22edba76c59b6", privateToolCount: 2,
    privateProfileDigest: createHash("sha256").update(JSON.stringify(["send_message", "rest"])).digest("hex"), privateSchemaDigest: "61b137b2467acbcf22ca7443ee01e71ed970a62728c42aabffbdcb562f4a6a70", resolvedHandlerCount: 12,
    excludedToolCount: 7, excludedSchemaIntersectionCount: 0, fabricatedHandlerInvocationCount: 0, excludedToolAttemptCount: 7, excludedToolRejectedCount: 7, excludedToolInvokedCount: 0, excludedToolSideEffectCount: 0, globallyResolvableExcludedToolCount: 4,
    auditPathDigest: createHash("sha256").update("/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-audit-chain.ndjson").digest("hex"),
    auditLedgerDigest: "4".repeat(64), auditRecordCount: 2, auditLifecyclePairCount: 1,
    containerUser: "10001:10001", liveProcessUser: "10001:10001", mountCount: 2, publishedPortCount: 0, networkMode: "host", readOnlyRoot: true, mountsExact: true, securityExact: true, updaterDisabled: true,
    writableKeyExposure: false, rawWriteMaterialFieldCount: 0, typedWriteExecutorCount: 1,
    writeApprovalPolicyDigest: createHash("sha256").update(JSON.stringify({ kind: "required", policyId: "sanctuary.unraid.restart.v1", actionClass: "unraid.container.restart", requiresSoleCall: true })).digest("hex"),
    sensitiveMaterialObserved: false, stopDenied: true, restartDenied: true, denialAuditCount: 1, denialStateUnchanged: true, denialProbeCompleted: true,
  },
  postbootIntegrity: integritySnapshot(),
  prebootIntegrity: integritySnapshot(),
})

const integritySnapshot = () => ({
  schemaVersion: "sanctuary-postboot-integrity-v2" as const,
  activeScenarioHandleDigest: null,
  telegramNextUpdateId: 10,
  approvalCheckpoints: [{ idDigest: "1".repeat(64), recordDigest: "2".repeat(64) }],
  approvalExecutionCount: 1,
  restartAttempts: [
    { idDigest: "3".repeat(64), recordDigest: "4".repeat(64), state: "attempt_not_started" as const },
    { idDigest: "3".repeat(64), recordDigest: "b".repeat(64), state: "attempting" as const },
    { idDigest: "3".repeat(64), recordDigest: "c".repeat(64), state: "succeeded" as const },
  ],
  fingerprintDigest: "3".repeat(64),
  sweeps: [{ idDigest: "5".repeat(64), recordDigest: "6".repeat(64), scenarioHandleDigest: null, deliveryIdDigest: null }],
  deliveries: [{ idDigest: "7".repeat(64), recordDigest: "8".repeat(64) }],
  audits: [{ idDigest: "9".repeat(64), recordDigest: "a".repeat(64), scenarioHandleDigest: null, scenarioRelevant: false }],
})

describe("Sanctuary postboot relational integrity", () => {
  it("accepts unchanged cursors and scenario-bound, ordinally appended deltas", () => {
    const scenarioHandleDigest = "a".repeat(64)
    const before = integritySnapshot()
    const after = {
      ...before,
      activeScenarioHandleDigest: scenarioHandleDigest,
      telegramNextUpdateId: 11,
      sweeps: [...before.sweeps, { idDigest: "b".repeat(64), recordDigest: "c".repeat(64), scenarioHandleDigest, deliveryIdDigest: "d".repeat(64) }],
      deliveries: [...before.deliveries, { idDigest: "d".repeat(64), recordDigest: "e".repeat(64) }],
      audits: [...before.audits, { idDigest: "f".repeat(64), recordDigest: "0".repeat(64), scenarioHandleDigest, scenarioRelevant: true }],
    }
    expect(verifySanctuaryPostbootIntegrity(before, after, scenarioHandleDigest)).toEqual({
      auditDeltaCount: 1, deliveryDeltaCount: 1, preserved: true, sweepDeltaCount: 1,
    })
  })

  it.each([
    ["offset replay", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, activeScenarioHandleDigest: "a".repeat(64), telegramNextUpdateId: 9 })],
    ["approval state replay", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, activeScenarioHandleDigest: "a".repeat(64), approvalCheckpoints: [{ ...value.approvalCheckpoints[0]!, recordDigest: "f".repeat(64) }] })],
    ["approval execution replay", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, approvalExecutionCount: 2 })],
    ["fingerprint mutation", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, fingerprintDigest: "f".repeat(64) })],
    ["sweep replay", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, activeScenarioHandleDigest: "a".repeat(64), sweeps: [value.sweeps[0]!, value.sweeps[0]!] })],
    ["delivery replay", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, activeScenarioHandleDigest: "a".repeat(64), deliveries: [value.deliveries[0]!, value.deliveries[0]!] })],
    ["audit replay", (value: ReturnType<typeof integritySnapshot>) => ({ ...value, activeScenarioHandleDigest: "a".repeat(64), audits: [value.audits[0]!, value.audits[0]!] })],
  ])("rejects %s", (_name, mutate) => {
    const before = integritySnapshot()
    expect(verifySanctuaryPostbootIntegrity(before, mutate(before), "a".repeat(64))).toBeNull()
  })

  it("rejects same-id record mutation and repeated execution of the same attempt", () => {
    const before = integritySnapshot()
    const handle = "a".repeat(64)
    const bound = { ...before, activeScenarioHandleDigest: handle }
    expect(verifySanctuaryPostbootIntegrity(before, { ...bound, sweeps: [{ ...bound.sweeps[0]!, recordDigest: "f".repeat(64) }] }, handle)).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, {
      ...bound,
      restartAttempts: [...bound.restartAttempts, { ...bound.restartAttempts[2]!, recordDigest: "f".repeat(64) }],
    }, handle)).toBeNull()
  })

  it.each(["succeeded", "attempted_or_indeterminate"] as const)("rejects appended %s terminal replay without relying on a counter", (state) => {
    const before = integritySnapshot()
    const after = { ...before, activeScenarioHandleDigest: "a".repeat(64), restartAttempts: [
      ...before.restartAttempts, { idDigest: "d".repeat(64), recordDigest: "e".repeat(64), state },
    ] }
    expect(verifySanctuaryPostbootIntegrity(before, after, "a".repeat(64))).toBeNull()
  })

  it("rejects restart-attempt reorder and any full-record digest change", () => {
    const before = integritySnapshot()
    const bound = { ...before, activeScenarioHandleDigest: "a".repeat(64) }
    expect(verifySanctuaryPostbootIntegrity(before, { ...bound, restartAttempts: [...bound.restartAttempts].reverse() }, "a".repeat(64))).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, { ...bound, restartAttempts: bound.restartAttempts.map((row, index) => index === 1 ? { ...row, recordDigest: "f".repeat(64) } : row) }, "a".repeat(64))).toBeNull()
  })

  it("requires the live active scenario marker relation", () => {
    const before = integritySnapshot()
    expect(verifySanctuaryPostbootIntegrity(before, before, "a".repeat(64))).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, { ...before, activeScenarioHandleDigest: "b".repeat(64) }, "a".repeat(64))).toBeNull()
  })

  it("rejects new sweeps, deliveries, and relevant audit rows not bound to the active scenario", () => {
    const before = integritySnapshot()
    const after = {
      ...before,
      activeScenarioHandleDigest: "a".repeat(64),
      sweeps: [...before.sweeps, { idDigest: "b".repeat(64), recordDigest: "c".repeat(64), scenarioHandleDigest: "b".repeat(64), deliveryIdDigest: "d".repeat(64) }],
      deliveries: [...before.deliveries, { idDigest: "d".repeat(64), recordDigest: "e".repeat(64) }],
      audits: [...before.audits, { idDigest: "f".repeat(64), recordDigest: "0".repeat(64), scenarioHandleDigest: "b".repeat(64), scenarioRelevant: true }],
    }
    expect(verifySanctuaryPostbootIntegrity(before, after, "a".repeat(64))).toBeNull()
  })

  it("rejects each independent postboot relation at the exact failing boundary", () => {
    const handle = "a".repeat(64)
    const before = integritySnapshot()
    const bound = { ...before, activeScenarioHandleDigest: handle }
    const newSweep = { idDigest: "b".repeat(64), recordDigest: "c".repeat(64), scenarioHandleDigest: handle, deliveryIdDigest: "d".repeat(64) }

    expect(verifySanctuaryPostbootIntegrity(before, {
      ...bound,
      sweeps: [...before.sweeps, { ...newSweep, recordDigest: "invalid" }],
    }, handle)).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, {
      ...bound,
      restartAttempts: bound.restartAttempts.map((row, index) => index === 1 ? { ...row, state: "succeeded" as const } : row),
    }, handle)).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, {
      ...bound,
      approvalExecutionCount: 0,
    }, handle, { preserveCursors: false })).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, {
      ...bound,
      sweeps: [...before.sweeps, newSweep],
      deliveries: [...before.deliveries, { idDigest: "e".repeat(64), recordDigest: "f".repeat(64) }],
    }, handle)).toBeNull()
    expect(verifySanctuaryPostbootIntegrity(before, {
      ...bound,
      audits: [...before.audits, { idDigest: "e".repeat(64), recordDigest: "f".repeat(64), scenarioHandleDigest: "b".repeat(64), scenarioRelevant: true }],
    }, handle)).toBeNull()
  })

  it("covers alternate valid and invalid postboot lifecycle and delivery bindings", () => {
    const indeterminate = integritySnapshot()
    indeterminate.restartAttempts[2] = { ...indeterminate.restartAttempts[2]!, state: "attempted_or_indeterminate" }
    const afterIndeterminate = structuredClone(indeterminate)
    afterIndeterminate.activeScenarioHandleDigest = scenarioHandleDigest
    expect(verifySanctuaryPostbootIntegrity(indeterminate, afterIndeterminate, scenarioHandleDigest)).not.toBeNull()

    const invalidAfter = integritySnapshot()
    invalidAfter.activeScenarioHandleDigest = scenarioHandleDigest
    invalidAfter.restartAttempts = invalidAfter.restartAttempts.slice(0, 2)
    expect(verifySanctuaryPostbootIntegrity(integritySnapshot(), invalidAfter, scenarioHandleDigest)).toBeNull()

    const invalidBoth = integritySnapshot()
    invalidBoth.restartAttempts = invalidBoth.restartAttempts.slice(0, 2)
    const invalidBothAfter = structuredClone(invalidBoth)
    invalidBothAfter.activeScenarioHandleDigest = scenarioHandleDigest
    expect(verifySanctuaryPostbootIntegrity(invalidBoth, invalidBothAfter, scenarioHandleDigest)).toBeNull()

    const changingAfter = integritySnapshot() as ReturnType<typeof integritySnapshot>
    const validAttempts = structuredClone(changingAfter.restartAttempts)
    const invalidAttempts = validAttempts.slice(0, 2)
    let reads = 0
    Object.defineProperty(changingAfter, "restartAttempts", { configurable: true, get: () => ++reads <= 2 ? validAttempts : invalidAttempts })
    changingAfter.activeScenarioHandleDigest = scenarioHandleDigest
    expect(verifySanctuaryPostbootIntegrity(integritySnapshot(), changingAfter, scenarioHandleDigest)).toBeNull()

    const nullDelivery = integritySnapshot()
    const afterNullDelivery = structuredClone(nullDelivery)
    afterNullDelivery.activeScenarioHandleDigest = scenarioHandleDigest
    afterNullDelivery.sweeps.push({ idDigest: "d".repeat(64), recordDigest: "e".repeat(64), scenarioHandleDigest, deliveryIdDigest: null })
    expect(verifySanctuaryPostbootIntegrity(nullDelivery, afterNullDelivery, scenarioHandleDigest)).toMatchObject({ sweepDeltaCount: 1, deliveryDeltaCount: 0 })
  })
})

afterEach(() => {
  fsFaults.lstatSync = null
  fsFaults.unlinkSync = null
  fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary live scenario capture", () => {
  it("captures a denial baseline without mutation and drives exactly one persisted denial attempt on poll", async () => {
    const receipts = path.join(root, "denial-driver-receipts")
    const gate = path.join(root, "denial-driver-gate.json")
    const denialDriver = { poll: vi.fn(async () => ({ state: "driven" as const })), complete: vi.fn(async () => undefined) }
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base(), denialDriver } as any)
    const sources = SANCTUARY_SCENARIO_SOURCES["unit-16e-1-stop-denial"]
    const begin = await capture({ phase: "begin", label: "unit-16e-1-stop-denial", externalGate: "none", sources })
    expect(denialDriver.poll).not.toHaveBeenCalled()
    await expect(capture({ phase: "poll", label: "unit-16e-1-stop-denial", externalGate: "none", sources, checkpointDigest: String(begin.checkpointDigest) })).resolves.toMatchObject({ state: "complete" })
    expect(denialDriver.poll).toHaveBeenCalledOnce()
    expect(denialDriver.complete).toHaveBeenCalledOnce()
  })

  it("derives every Unit 16 assertion contract from event, journal, and runtime facts", () => {
    for (const label of SANCTUARY_UNIT_16_EVIDENCE_LABELS) {
      const before = base()
      const after = base()
      if (label === "unit-16a-pre-reboot-checkpoint") after.reboot = { ...after.reboot!, phase: "preflight", requestCount: 0, bootIdentityChanged: false }
      if (label === "unit-16a-reboot-request") after.reboot = { ...after.reboot!, phase: "requested", bootIdentityChanged: false }
      if (label === "unit-16a-boot-recovery-milestones") after.postbootIntegrity = { ...after.postbootIntegrity!, activeScenarioHandleDigest: "a".repeat(64) }
      if (label.includes("opaque-identity-live")) { after.telegramTurns.push(turnReceipt()); after.events.push(...auditTurn()) }
      if (label === "unit-15c-1-no-callback-terminalization") {
        after.approvals = [approval("expired")]
        after.events.push(
          approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }),
          expiryObservationEvidence(),
          approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, expiryDeadlineAt: 301_000, expiryObservedAt: 301_000, terminalEditStartedAt: 301_000, terminalizedAt: 301_000, buttonsRemoved: true }),
        )
        before.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: createHash("sha256").update(JSON.stringify(after.sourceValues["telegram-offset"])).digest("hex"), inboundEventCount: 0 }
      }
      if (label === "unit-16d-whats-up" || label === "unit-16d-1-space") {
        const system = label === "unit-16d-whats-up"
        const toolName = system ? "unraid_get_system" : "unraid_get_storage"
        const facts = system ? systemGrounding : storageGrounding
        const responseText = system ? "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded." : "There is 2 TB free and the array is 80% used."
        const factDigest = groundingDigest(facts)
        after.telegramTurns.push(groundedTurn(toolName, facts, responseText))
        after.events.push(...auditTurn())
        after.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName, success: true, resultDigest: "5".repeat(64), groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } })
        ;(after as any).liveGrounding = { toolName, groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts }
      }
      if (label === "unit-16d-2-unauthorized") after.events.push({ ...event("telegram.update_dropped"), meta: {
        scenarioHandleDigest, updateDigest: "1".repeat(64), distinctAccount: true,
        senderIdentityDigest: "d".repeat(64), authorizedIdentityDigest: "e".repeat(64), senderDistinct: true,
        nextOffsetDigest: "9".repeat(64), dropMac: "f".repeat(64),
      } }); after.telegramNextUpdateId = 11
      if (label === "unit-16e-2-restart-denial") after.denial = { ...after.denial!, label, operation: "restart" }
      if (label === "unit-16j-denial") { after.approvals = [approval("denied")]; after.events.push(...auditTurn(), ...approvalEvidence("deny", 1_000, 2_000)) }
      if (label === "unit-16f-cron-fingerprint" || label === "unit-16g-health-transition" || label === "unit-16h-daily-digest") after.healthProbe = healthProbe(label)
      if (label === "unit-16i-delayed-approval") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart(); after.events.push(...auditTurn(), ...approvalEvidence("approve")) }
      if (label === "unit-16k-timeout-stale") { after.approvals = [approval("expired")]; after.interactiveDriver = timeoutStaleDriver(); after.events.push(approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }), expiryObservationEvidence(), approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, expiryDeadlineAt: 301_000, expiryObservedAt: 301_000, terminalEditStartedAt: 301_000, terminalizedAt: 301_000, buttonsRemoved: true }), staleCallbackEvidence(), event("telegram.update_dropped")) }
      if (label === "unit-16l-duplicate-callback") { after.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2, claimCount: 1 }]; after.restartAttempts = successfulRestart(); after.interactiveDriver = duplicateCallbackDriver(); after.events.push(...approvalEvidence("approve"), event("telegram.callback_settled"), event("telegram.callback_settled"), event("approval.acceptance_transition")) }
      if (label === "unit-16m-restart-continuation") {
        after.approvals = [approval("succeeded")]
        after.restartAttempts = successfulRestart()
        after.interactiveDriver = restartContinuationDriver()
        after.events.push(...approvalEvidence("approve").map((entry) => entry.event === "telegram.callback_settled" ? {
          ...entry,
          event: "telegram.callback_recovery_settled",
          at: 121_003,
          meta: { ...entry.meta, acknowledged: undefined, acknowledgementState: "indeterminate_after_restart", recoveredAt: 121_002, decisionAttemptDigest: "6".repeat(64) },
        } : entry), { ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } })
      }
      const assertions = deriveSanctuaryScenarioAssertions(label, before, after, 400_000, "a".repeat(64))
      expect(assertions, label).not.toBeNull()
      expect(validateSanctuaryUnit16EvidenceAssertions(label, assertions)).toEqual(assertions)
    }
  })

  it.each([
    ["unit-16d-whats-up", "unraid_get_system", systemGrounding, "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded."],
    ["unit-16d-1-space", "unraid_get_storage", storageGrounding, "There is 2 TB free and the array is 80% used."],
  ] as const)("requires bounded accurate response content bound to an independent live read for %s", (label, toolName, facts, responseText) => {
    const before = base()
    const after = base()
    const factDigest = groundingDigest(facts)
    const validTurn = groundedTurn(toolName, facts, responseText)
    after.telegramTurns = [validTurn]
    after.events = [...auditTurn(), { ...event("senses.sanctuary_read_receipt"), meta: { toolName, success: true, resultDigest: "5".repeat(64), groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } }]
    ;(after as any).liveGrounding = { toolName, groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts }
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toMatchObject({ accurate: true, grounded: true, liveFactsMatched: true, responseWithinLimit: true })

    after.telegramTurns = [{ ...validTurn, responseText: "Everything looks fine.", responseUtf16Units: 22 }]
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    after.telegramTurns = [{ ...validTurn, responseText: "x".repeat(1_201), responseUtf16Units: 1_201 }]
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    after.telegramTurns = [validTurn]
    ;(after as any).liveGrounding = { toolName, groundingDigest: "f".repeat(64), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts }
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
  })

  it("accepts bounded same-source storage drift but rejects forged source and causal time", () => {
    const before = base()
    const after = base()
    const turn = groundedTurn("unraid_get_storage", storageGrounding, "There is 2 TB free and the array is 80% used.")
    const factDigest = groundingDigest(storageGrounding)
    after.telegramTurns = [turn]
    after.events = [...auditTurn(), { ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_storage", success: true, resultDigest: "5".repeat(64), groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } }]
    const drifted = { array: { ...storageGrounding.array, usedBytes: 8_100_000_000_000, freeBytes: 1_900_000_000_000, usedPercent: 81 }, shares: [], truncated: false }
    after.liveGrounding = { toolName: "unraid_get_storage", groundingDigest: groundingDigest(drifted), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts: drifted } as never
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toMatchObject({ accurate: true, liveFactsMatched: true })
    after.events = after.events.map((entry) => entry.event === "senses.sanctuary_read_receipt" ? { ...entry, meta: { ...entry.meta, sourceIdentityDigest: "8".repeat(64) } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toBeNull()
    after.events = after.events.map((entry) => entry.event === "senses.sanctuary_read_receipt" ? { ...entry, meta: { ...entry.meta, sourceIdentityDigest: groundingSource } } : entry)
    after.liveGrounding = { ...after.liveGrounding!, sourceIdentityDigest: "8".repeat(64) } as never
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toBeNull()
    after.liveGrounding = { ...after.liveGrounding!, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:08.000Z" } as never
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toBeNull()
    after.liveGrounding = { ...after.liveGrounding!, observedAt: "1970-01-01T00:20:00.000Z" } as never
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toBeNull()
  })

  it("requires independently attested butler restart and restored pending checkpoint for unit-16m", () => {
    const before = base()
    const after = base()
    after.approvals = [approval("succeeded")]
    after.restartAttempts = successfulRestart()
    after.events.push(...approvalEvidence("approve"), { ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } })
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toBeNull()
    after.interactiveDriver = restartContinuationDriver()
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toBeNull()
    after.events = after.events.map((entry) => entry.event === "telegram.callback_settled" ? {
      ...entry,
      event: "telegram.callback_recovery_settled",
      at: 121_003,
      meta: { ...entry.meta, acknowledged: undefined, acknowledgementState: "indeterminate_after_restart", recoveredAt: 121_002, decisionAttemptDigest: "6".repeat(64) },
    } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toMatchObject({
      preAttemptResumed: true,
      checkpointEpochPreserved: true,
      continuationEpochAdvanced: true,
      butlerRestartObserved: true,
    })
    after.events = after.events.map((entry) => entry.event === "telegram.callback_recovery_settled" ? { ...entry, meta: { ...entry.meta, recoveredAt: 121_001 } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toBeNull()
    after.events = after.events.map((entry) => entry.event === "telegram.callback_recovery_settled" ? { ...entry, meta: { ...entry.meta, recoveredAt: 121_002 } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", before, after, 400_000)).toBeNull()
    after.interactiveDriver = { ...restartContinuationDriver(), pendingRestored: false }
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toBeNull()
    after.interactiveDriver = { ...restartContinuationDriver(), indeterminateRecoveryObserved: false }
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toBeNull()
  })

  it("requires broker-attested current duplicate callbacks, stale replay, and absent write credential for unit-16l", () => {
    const before = base()
    const after = base()
    after.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2, claimCount: 1 }]
    after.restartAttempts = successfulRestart()
    after.events.push(...approvalEvidence("approve"), event("telegram.callback_settled"), event("telegram.callback_settled"), event("approval.acceptance_transition"))
    expect(deriveSanctuaryScenarioAssertions("unit-16l-duplicate-callback", before, after, 400_000)).toBeNull()
    after.interactiveDriver = duplicateCallbackDriver()
    expect(deriveSanctuaryScenarioAssertions("unit-16l-duplicate-callback", before, after, 400_000)).toMatchObject({ staleReplaySettled: true, writeCredentialAbsent: true })
    after.interactiveDriver = { ...duplicateCallbackDriver(), writeCredentialObserved: true }
    expect(deriveSanctuaryScenarioAssertions("unit-16l-duplicate-callback", before, after, 400_000)).toBeNull()
  })

  it("requires a daemon-retained stale callback settlement with zero claim and mutation for unit-16k", () => {
    const before = base()
    const after = base()
    after.approvals = [approval("expired")]
    after.interactiveDriver = timeoutStaleDriver()
    after.events.push(approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }), expiryObservationEvidence(), approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, expiryDeadlineAt: 301_000, expiryObservedAt: 301_000, terminalEditStartedAt: 301_000, terminalizedAt: 301_000, buttonsRemoved: true }), staleCallbackEvidence(), event("telegram.update_dropped"))
    expect(deriveSanctuaryScenarioAssertions("unit-16k-timeout-stale", before, after, 400_000)).toMatchObject({ staleAcknowledged: true, mutationCount: 0 })
    after.events = after.events.filter((entry) => entry.event !== "telegram.approval_stale_callback_settled")
    expect(deriveSanctuaryScenarioAssertions("unit-16k-timeout-stale", before, after, 400_000)).toBeNull()
    after.events.push(staleCallbackEvidence())
    after.interactiveDriver = { ...timeoutStaleDriver(), claimCount: 1 }
    expect(deriveSanctuaryScenarioAssertions("unit-16k-timeout-stale", before, after, 400_000)).toBeNull()
  })

  it("rejects every non-canonical restart action, target name, target id, and action digest", () => {
    const valid = base()
    valid.approvals = [approval("succeeded")]
    valid.restartAttempts = successfulRestart()
    valid.events = [...auditTurn(), ...approvalEvidence("approve")]
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), valid, 400_000)).not.toBeNull()

    const wrongName = structuredClone(valid)
    wrongName.approvals[0]!.target = "plex"
    wrongName.approvals[0]!.argumentDigest = createHash("sha256").update(JSON.stringify({ container: "plex" })).digest("hex")
    wrongName.restartAttempts = wrongName.restartAttempts.map((attempt) => ({ ...attempt, target: "plex", argumentDigest: wrongName.approvals[0]!.argumentDigest }))
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), wrongName, 400_000)).toBeNull()

    const alias = structuredClone(valid)
    alias.approvals[0]!.target = "/calibre-web"
    alias.approvals[0]!.argumentDigest = createHash("sha256").update(JSON.stringify({ container: "/calibre-web" })).digest("hex")
    alias.restartAttempts = alias.restartAttempts.map((attempt) => ({ ...attempt, target: "/calibre-web", argumentDigest: alias.approvals[0]!.argumentDigest }))
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), alias, 400_000)).toBeNull()

    const wrongId = structuredClone(valid)
    wrongId.restartAttempts = wrongId.restartAttempts.map((attempt) => ({ ...attempt, targetId: `Docker:${"8".repeat(64)}` }))
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), wrongId, 400_000)).toBeNull()

    const pairedSubstitution = structuredClone(valid)
    const substitutedId = `Docker:${"8".repeat(64)}`
    const substitutedDigest = createHash("sha256").update(JSON.stringify({ operation: "restart", container: { id: substitutedId, name: "calibre-web" } })).digest("hex")
    pairedSubstitution.restartAttempts = pairedSubstitution.restartAttempts.map((attempt) => ({ ...attempt, targetId: substitutedId, actionDigest: substitutedDigest }))
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), pairedSubstitution, 400_000)).toBeNull()

    const wrongAction = structuredClone(valid)
    wrongAction.restartAttempts = wrongAction.restartAttempts.map((attempt) => ({ ...attempt, actionDigest: "f".repeat(64) }))
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), wrongAction, 400_000)).toBeNull()
  })

  it("measures delayed approval from the authenticated prompt binding and requires exact callback, terminal, and resumed-delivery evidence", () => {
    const after = base()
    after.approvals = [approval("succeeded")]
    after.restartAttempts = successfulRestart()
    after.events = [...auditTurn(), ...approvalEvidence("approve", 1_000, 121_000)]
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), after, 400_000)).toMatchObject({ elapsedMs: 120_000, resumed: true })

    for (const eventName of ["senses.telegram_approval_prompt_bound", "telegram.callback_settled", "telegram.approval_prompt_terminalized", "senses.telegram_approval_continuation_delivered"]) {
      const missing = structuredClone(after)
      missing.events = missing.events.filter((entry) => entry.event !== eventName)
      expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), missing, 400_000), eventName).toBeNull()
    }
    const early = structuredClone(after)
    early.events = [...auditTurn(), ...approvalEvidence("approve", 1_000, 120_999)]
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), early, 400_000)).toBeNull()
    const unacknowledged = structuredClone(after)
    unacknowledged.events = unacknowledged.events.map((entry) => entry.event === "telegram.callback_settled" ? { ...entry, meta: { ...entry.meta, acknowledged: false } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), unacknowledged, 400_000)).toBeNull()
    const reboundMessage = structuredClone(after)
    reboundMessage.events = reboundMessage.events.map((entry) => entry.event === "telegram.approval_prompt_terminalized"
      ? { ...entry, meta: { ...entry.meta, messageIdDigest: "9".repeat(64) } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), reboundMessage, 400_000)).toBeNull()
    for (const field of ["checkpointDigest", "suspendedSessionRevisionDigest"] as const) {
      const reboundSession = structuredClone(after)
      reboundSession.events = reboundSession.events.map((entry) => entry.event === "telegram.callback_settled"
        ? { ...entry, meta: { ...entry.meta, [field]: "9".repeat(64) } }
        : entry)
      expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), reboundSession, 400_000), field).toBeNull()
    }
    const wrongResult = structuredClone(after)
    wrongResult.events = wrongResult.events.map((entry) => entry.event === "senses.telegram_approval_continuation_delivered"
      ? { ...entry, meta: { ...entry.meta, resultDigest: "9".repeat(64) } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), wrongResult, 400_000)).toBeNull()

    const continuationBeforeCallback = structuredClone(after)
    continuationBeforeCallback.events = continuationBeforeCallback.events.map((entry) => entry.event === "senses.telegram_approval_continuation_delivered"
      ? { ...entry, meta: { ...entry.meta, deliveredAt: 120_999 } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), continuationBeforeCallback, 400_000)).toBeNull()

    const editBeforeContinuation = structuredClone(after)
    editBeforeContinuation.events = editBeforeContinuation.events.map((entry) => entry.event === "telegram.approval_prompt_terminalized"
      ? { ...entry, meta: { ...entry.meta, terminalEditStartedAt: 121_000 } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), editBeforeContinuation, 400_000)).toBeNull()

    const unboundedTerminalEdit = structuredClone(after)
    unboundedTerminalEdit.events = unboundedTerminalEdit.events.map((entry) => entry.event === "telegram.approval_prompt_terminalized"
      ? { ...entry, at: 151_002, meta: { ...entry.meta, terminalizedAt: 151_002 } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), unboundedTerminalEdit, 400_000)).toBeNull()

    const unexpectedExpiryMetadata = structuredClone(after)
    unexpectedExpiryMetadata.events = unexpectedExpiryMetadata.events.map((entry) => entry.event === "telegram.approval_prompt_terminalized"
      ? { ...entry, meta: { ...entry.meta, expiryObservedAt: 121_000 } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), unexpectedExpiryMetadata, 400_000)).toBeNull()
  })

  it("requires identity-key provenance for every approval scenario", () => {
    for (const label of ["unit-15c-1-no-callback-terminalization", "unit-16i-delayed-approval", "unit-16j-denial", "unit-16k-timeout-stale", "unit-16l-duplicate-callback", "unit-16m-restart-continuation"] as const) {
      expect(SANCTUARY_SCENARIO_SOURCES[label]).toContain("identity-key")
    }
  })

  it("requires denial acknowledgement plus resumed delivery while proving no mutation", () => {
    const after = base()
    after.approvals = [approval("denied")]
    after.events = [...auditTurn(), ...approvalEvidence("deny", 1_000, 2_000)]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", base(), after, 400_000)).toMatchObject({ mutationCount: 0, resumed: true })
    after.events = after.events.map((entry) => entry.event === "telegram.callback_settled" ? { ...entry, meta: { ...entry.meta, accepted: true, reason: "accepted" } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", base(), after, 400_000)).toBeNull()
  })

  it.each(["unit-15c-1-no-callback-terminalization", "unit-16k-timeout-stale"] as const)("bounds %s expiry observation while permitting bounded terminal edit completion", (label) => {
    const make = (expiryObservedAt: number, terminalizedAt = expiryObservedAt) => {
      const before = base()
      const after = base()
      after.approvals = [approval("expired")]
      after.approvals[0]!.updatedAt = terminalizedAt
      after.events = [
        approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }),
        expiryObservationEvidence(expiryObservedAt),
        approvalAuditEvent("telegram.approval_prompt_terminalized", terminalizedAt, { boundAt: 1_000, expiryDeadlineAt: 301_000, expiryObservedAt, terminalEditStartedAt: expiryObservedAt, terminalizedAt, buttonsRemoved: true }),
      ]
      if (label === "unit-15c-1-no-callback-terminalization") {
        before.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: probeDigest(after.sourceValues["telegram-offset"]), inboundEventCount: 0 }
      } else {
        after.interactiveDriver = timeoutStaleDriver()
        after.events.push(staleCallbackEvidence(terminalizedAt + 1), event("telegram.update_dropped"))
      }
      return { before, after }
    }
    for (const elapsed of [300_000, 301_000]) {
      const { before, after } = make(1_000 + elapsed)
      expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000), String(elapsed)).not.toBeNull()
    }
    const lateObservation = make(302_001)
    expect(deriveSanctuaryScenarioAssertions(label, lateObservation.before, lateObservation.after, 400_000)).toBeNull()
    const delayed = make(302_000, 327_000)
    expect(deriveSanctuaryScenarioAssertions(label, delayed.before, delayed.after, 400_000)).not.toBeNull()
    const reversed = make(302_000, 301_999)
    expect(deriveSanctuaryScenarioAssertions(label, reversed.before, reversed.after, 400_000)).toBeNull()
    const unbounded = make(302_000, 332_001)
    expect(deriveSanctuaryScenarioAssertions(label, unbounded.before, unbounded.after, 400_000)).toBeNull()
    const missingObservation = make(301_000)
    missingObservation.after.events = missingObservation.after.events.filter((entry) => entry.event !== "telegram.approval_expiry_observed")
    expect(deriveSanctuaryScenarioAssertions(label, missingObservation.before, missingObservation.after, 400_000)).toBeNull()
    const retryObservation = make(301_000)
    retryObservation.after.events.splice(2, 0, { ...expiryObservationEvidence(), at: 301_001 })
    expect(deriveSanctuaryScenarioAssertions(label, retryObservation.before, retryObservation.after, 400_000)).not.toBeNull()
    const conflictingRetry = make(301_000)
    conflictingRetry.after.events.splice(2, 0, expiryObservationEvidence(301_001))
    expect(deriveSanctuaryScenarioAssertions(label, conflictingRetry.before, conflictingRetry.after, 400_000)).toBeNull()

    if (label === "unit-15c-1-no-callback-terminalization") {
      const changingState = make(301_000)
      let stateReads = 0
      Object.defineProperty(changingState.after.approvals[0]!, "state", { configurable: true, get: () => ++stateReads <= 2 ? "expired" : "succeeded" })
      expect(deriveSanctuaryScenarioAssertions(label, changingState.before, changingState.after, 400_000)).toBeNull()
    }

    const editStartedBeforeObservation = make(301_000)
    editStartedBeforeObservation.after.events = editStartedBeforeObservation.after.events.map((entry) => entry.event === "telegram.approval_prompt_terminalized"
      ? { ...entry, meta: { ...entry.meta, terminalEditStartedAt: 300_999 } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions(label, editStartedBeforeObservation.before, editStartedBeforeObservation.after, 400_000)).toBeNull()

    if (label === "unit-16k-timeout-stale") {
      const wronglyAcceptedStale = make(301_000)
      wronglyAcceptedStale.after.events = wronglyAcceptedStale.after.events.map((entry) => entry.event === "telegram.approval_stale_callback_settled"
        ? { ...entry, meta: { ...entry.meta, accepted: true } }
        : entry)
      expect(deriveSanctuaryScenarioAssertions(label, wronglyAcceptedStale.before, wronglyAcceptedStale.after, 400_000)).toBeNull()
    }
  })

  it("rejects denial boundary drift after evaluating both immutable snapshots", () => {
    const after = base()
    after.denial = structuredClone(after.denial!)
    after.denial.after = { ...after.denial.after, auditCursorDigest: "f".repeat(64) }
    expect(deriveSanctuaryScenarioAssertions("unit-16e-1-stop-denial", base(), after, 400_000)).toBeNull()
  })

  it("evaluates prior approval identity, indeterminate retry, and unrelated restart audit filters", () => {
    const prior = base()
    prior.approvals = [approval("succeeded")]
    const sameApproval = base()
    sameApproval.approvals = [approval("succeeded")]
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", prior, sameApproval, 400_000)).toBeNull()

    const retried = base()
    retried.approvals = [approval("succeeded")]
    retried.restartAttempts = [
      ...successfulRestart().slice(0, 2),
      { ...successfulRestart()[1]!, state: "attempted_or_indeterminate", observedAt: 2_500 },
      { ...successfulRestart()[1]!, attemptId: "attempt-2", observedAt: 2_600 },
    ]
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", base(), retried, 400_000, scenarioHandleDigest)).toBeNull()

    const continuedBefore = base()
    continuedBefore.events = [{ ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "unrelated-before" } }]
    const continued = base()
    continued.approvals = [approval("succeeded")]
    continued.restartAttempts = successfulRestart()
    continued.interactiveDriver = restartContinuationDriver()
    continued.events = [
      ...continuedBefore.events,
      ...approvalEvidence("approve", 1_000, 2_000).map((entry) => entry.event === "telegram.callback_settled"
        ? { ...entry, event: "telegram.callback_recovery_settled", at: 3_001, meta: { ...entry.meta, acknowledgementState: "indeterminate_after_restart", recoveredAt: 3_000 } }
        : entry),
      { ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "unrelated" } },
      { ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } },
    ]
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", continuedBefore, continued, 400_000, scenarioHandleDigest)).toMatchObject({ restartObserved: true })
  })

  it("exercises independent negative gates after their preceding invariants pass", () => {
    const whatsUp = () => {
      const facts = base()
      facts.telegramTurns = [groundedTurn("unraid_get_system", systemGrounding, "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded.")]
      facts.events = [
        ...auditTurn(),
        { ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64), groundingDigest: groundingDigest(systemGrounding), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } },
      ]
      facts.liveGrounding = { toolName: "unraid_get_system", groundingDigest: groundingDigest(systemGrounding), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts: systemGrounding }
      return facts
    }
    const missingGrounding = whatsUp()
    delete missingGrounding.telegramTurns[0]!.toolGroundings
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", base(), missingGrounding, 400_000)).toBeNull()
    const missingLive = whatsUp(); missingLive.liveGrounding = undefined
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", base(), missingLive, 400_000)).toBeNull()
    const invalidScenarioCoordinate = whatsUp()
    invalidScenarioCoordinate.events = invalidScenarioCoordinate.events.map((entry) => entry.event === "senses.telegram_turn_start" || entry.event === "senses.telegram_turn_end" ? { ...entry, meta: { ...entry.meta, scenarioHandleDigest: "invalid" } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", base(), invalidScenarioCoordinate, 400_000)).toBeNull()
    const negativeDelivery = whatsUp()
    negativeDelivery.events = negativeDelivery.events.map((entry) => entry.event === "senses.telegram_turn_end" ? { ...entry, meta: { ...entry.meta, deliveryCount: -1 } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", base(), negativeDelivery, 400_000)).toBeNull()
    const unacknowledgedRestart = base()
    unacknowledgedRestart.approvals = [approval("succeeded")]
    unacknowledgedRestart.restartAttempts = successfulRestart().map((entry) => entry.state === "succeeded" ? { ...entry, mutationAcknowledged: false } : entry)
    unacknowledgedRestart.events = [...auditTurn(), ...approvalEvidence("approve", 1_000, 121_000)]
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), unacknowledgedRestart, 400_000)).not.toBeNull()

    const oldApproval = base(); oldApproval.capturedAt = 2_000
    const expired = base(); expired.approvals = [approval("expired")]
    expect(deriveSanctuaryScenarioAssertions("unit-15c-1-no-callback-terminalization", oldApproval, expired, 400_000)).toBeNull()
    const missingButtons = base(); missingButtons.approvals = [{ ...approval("expired"), buttonsRemoved: false }]
    missingButtons.events = [approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }), expiryObservationEvidence(), approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, expiryDeadlineAt: 301_000, expiryObservedAt: 301_000, terminalEditStartedAt: 301_000, terminalizedAt: 301_000, buttonsRemoved: true })]
    const missingButtonsBefore = base(); missingButtonsBefore.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: probeDigest(missingButtons.sourceValues["telegram-offset"]), inboundEventCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-15c-1-no-callback-terminalization", missingButtonsBefore, missingButtons, 400_000)).toBeNull()
    const arrayBaseline = structuredClone(missingButtonsBefore); arrayBaseline.sourceValues["no-callback-baseline"] = []
    missingButtons.approvals[0]!.buttonsRemoved = true
    expect(deriveSanctuaryScenarioAssertions("unit-15c-1-no-callback-terminalization", arrayBaseline, missingButtons, 400_000)).toBeNull()
    const callbackBaseline = structuredClone(missingButtonsBefore)
    const callbackAfter = structuredClone(missingButtons); callbackAfter.approvals[0]!.callbackCount = 1
    expect(deriveSanctuaryScenarioAssertions("unit-15c-1-no-callback-terminalization", callbackBaseline, callbackAfter, 400_000)).toBeNull()

    for (const label of ["unit-16a-pre-reboot-checkpoint", "unit-16a-reboot-request", "unit-16a-boot-recovery-milestones"] as const) {
      const noReboot = base(); noReboot.reboot = undefined
      expect(deriveSanctuaryScenarioAssertions(label, base(), noReboot, 400_000, scenarioHandleDigest)).toBeNull()
    }
    const noContainer = base(); noContainer.container = undefined
    expect(deriveSanctuaryScenarioAssertions("unit-16b-runtime-vault-containment", base(), noContainer, 400_000)).toBeNull()

    const expiredApproval = base(); expiredApproval.approvals = [{ ...approval("succeeded"), terminalPrompt: false }]
    expiredApproval.restartAttempts = successfulRestart(); expiredApproval.events = [...auditTurn(), ...approvalEvidence("approve", 1_000, 121_000)]
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), expiredApproval, 400_000)).toBeNull()
    const deniedNoPrompt = base(); deniedNoPrompt.approvals = [{ ...approval("denied"), terminalPrompt: false }]; deniedNoPrompt.events = [...auditTurn(), ...approvalEvidence("deny", 1_000, 2_000)]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", base(), deniedNoPrompt, 400_000)).toBeNull()
    const staleNoAck = base(); staleNoAck.approvals = [{ ...approval("expired"), staleAcknowledged: false }]
    expect(deriveSanctuaryScenarioAssertions("unit-16k-timeout-stale", base(), staleNoAck, 400_000)).toBeNull()
    const duplicateWithoutEvidence = base(); duplicateWithoutEvidence.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2 }]; duplicateWithoutEvidence.restartAttempts = successfulRestart()
    expect(deriveSanctuaryScenarioAssertions("unit-16l-duplicate-callback", base(), duplicateWithoutEvidence, 400_000)).toBeNull()

    const prefixedBefore = base(); prefixedBefore.events = [event("existing")]
    const truncatedAfter = base()
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", prefixedBefore, truncatedAfter, 400_000)).toBeNull()
    const http401 = base(); http401.denial = { ...http401.denial!, httpStatus: 401 }
    expect(deriveSanctuaryScenarioAssertions("unit-16e-1-stop-denial", base(), http401, 400_000)).not.toBeNull()
    const http200 = base(); http200.denial = { ...http200.denial!, httpStatus: 200 }
    expect(deriveSanctuaryScenarioAssertions("unit-16e-1-stop-denial", base(), http200, 400_000)).not.toBeNull()
    const permissionDenied = base(); permissionDenied.denial = { ...permissionDenied.denial!, errorCode: "PERMISSION_DENIED" }
    expect(deriveSanctuaryScenarioAssertions("unit-16e-1-stop-denial", base(), permissionDenied, 400_000)).not.toBeNull()
    const shortScenarioHandle = base(); shortScenarioHandle.denial = { ...shortScenarioHandle.denial!, scenarioHandleDigest: "short" }
    expect(deriveSanctuaryScenarioAssertions("unit-16e-1-stop-denial", base(), shortScenarioHandle, 400_000)).toBeNull()
    const missingDenial = base(); missingDenial.denial = undefined
    expect(deriveSanctuaryScenarioAssertions("unit-16e-1-stop-denial", base(), missingDenial, 400_000)).toBeNull()

    const storageWithoutLiveFacts = base()
    storageWithoutLiveFacts.telegramTurns = [groundedTurn("unraid_get_storage", storageGrounding, "Sanctuary storage is 80% used with 2 TB free; the array is STARTED and not degraded.")]
    storageWithoutLiveFacts.events = [...auditTurn(), { ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_storage", success: true, resultDigest: "5".repeat(64), groundingDigest: groundingDigest(storageGrounding), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } }]
    storageWithoutLiveFacts.liveGrounding = { toolName: "unraid_get_storage", groundingDigest: groundingDigest({}), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts: null as never }
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", base(), storageWithoutLiveFacts, 400_000)).toBeNull()

    expect(terminalizedWithinTtlJitter({ boundAt: 1_000, expiryObservedAt: null, expiryDeadlineAt: 301_000 })).toBe(false)
  })

  it.each([
    "unit-16f-cron-fingerprint",
    "unit-16g-health-transition",
    "unit-16h-daily-digest",
  ] as const)("rejects stopped and unhealthy independently injected owner snapshots for %s", (label) => {
    const before = base()
    const stopped = base(); stopped.healthProbe = healthProbe(label); stopped.container = { ...stopped.container!, running: false }
    const unhealthy = base(); unhealthy.healthProbe = healthProbe(label); unhealthy.container = { ...unhealthy.container!, healthy: false }
    expect(deriveSanctuaryScenarioAssertions(label, before, stopped, 400_000)).toBeNull()
    expect(deriveSanctuaryScenarioAssertions(label, before, unhealthy, 400_000)).toBeNull()
  })

  it("keeps the opaque handle private while persisting and completing the bound receipt", async () => {
    const receipts = path.join(root, "receipts")
    const gate = path.join(root, "evidence", "current-scenario-gate.json")
    let facts = base()
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => facts })
    const sources = ["telegram-audit", "telegram-offset", "telegram-turn-receipts", "live-grounding-read"]
    const begin = await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources })
    expect(begin).toEqual({ state: "waiting", checkpointDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(fs.readFileSync(gate, "utf8")).not.toContain("scenarioHandleDigest")
    expect(await capture({ phase: "poll", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources, checkpointDigest: begin.checkpointDigest as string })).toEqual(begin)
    const digest = groundingDigest(systemGrounding)
    facts = base()
    facts.telegramTurns.push(groundedTurn("unraid_get_system", systemGrounding, "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded."))
    facts.events.push(...auditTurn())
    facts.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64), groundingDigest: digest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } })
    facts.liveGrounding = { toolName: "unraid_get_system", groundingDigest: digest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts: systemGrounding }
    const complete = await capture({ phase: "poll", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources, checkpointDigest: begin.checkpointDigest as string })
    expect(complete).toMatchObject({ state: "complete", checkpointDigest: begin.checkpointDigest, assertions: { responseCount: 1 }, sourceDigests: { "telegram-audit": expect.stringMatching(/^[0-9a-f]{64}$/u), "telegram-offset": expect.stringMatching(/^[0-9a-f]{64}$/u), "telegram-turn-receipts": expect.stringMatching(/^[0-9a-f]{64}$/u), "live-grounding-read": expect.stringMatching(/^[0-9a-f]{64}$/u) } })
    finalizeSanctuaryScenarioCapture(gate)
    expect(fs.existsSync(gate)).toBe(false)
  })

  it("drives a health capture start through running and ready before recovery and local completion", async () => {
    const receipts = path.join(root, "health-receipts")
    const gate = path.join(root, "health-evidence", "current-scenario-gate.json")
    const marker = path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")
    const ownerSnapshot = { independentlyAttested: true }
    const calls: string[] = []
    let readCount = 0
    let pollCount = 0
    const before = base()
    const after = base(); after.healthProbe = healthProbe("unit-16g-health-transition")
    const healthDriver = {
      begin: vi.fn(async () => {
        calls.push("begin")
        expect(fs.existsSync(marker)).toBe(true)
        expect(fs.readdirSync(receipts)).toHaveLength(1)
        expect(JSON.parse(fs.readFileSync(gate, "utf8"))).toMatchObject({ phase: "waiting" })
      }),
      poll: vi.fn(async () => {
        calls.push("poll")
        pollCount += 1
        return pollCount === 1 ? { state: "waiting" as const } : { state: "ready" as const, containerSnapshot: ownerSnapshot }
      }),
      recover: vi.fn(async () => {
        calls.push("recover")
        expect(fs.existsSync(marker)).toBe(true)
        expect(fs.readdirSync(receipts)).toHaveLength(1)
        expect(JSON.parse(fs.readFileSync(gate, "utf8"))).toMatchObject({ phase: "waiting" })
      }),
    }
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, healthDriver,
      readFacts: async (_label, _handle, options) => {
        calls.push(`facts:${JSON.stringify(options ?? {})}`)
        readCount += 1
        return readCount === 1 ? before : after
      },
    })

    const begin = await capture({ phase: "begin", label: "unit-16g-health-transition", externalGate: "health-transition", sources: ["health-runtime", "health-probe-receipt"] })
    expect(calls).toEqual(["facts:{\"skipContainerSnapshot\":true}", "begin"])
    await expect(capture({ phase: "poll", label: "unit-16g-health-transition", externalGate: "health-transition", sources: ["health-runtime", "health-probe-receipt"], checkpointDigest: begin.checkpointDigest as string })).resolves.toEqual(begin)
    expect(readCount).toBe(1)
    const complete = await capture({ phase: "poll", label: "unit-16g-health-transition", externalGate: "health-transition", sources: ["health-runtime", "health-probe-receipt"], checkpointDigest: begin.checkpointDigest as string })
    expect(complete).toMatchObject({ state: "complete", checkpointDigest: begin.checkpointDigest })
    expect(calls).toEqual([
      "facts:{\"skipContainerSnapshot\":true}", "begin", "poll", "poll",
      `facts:${JSON.stringify({ containerSnapshot: ownerSnapshot })}`, "recover",
    ])
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readdirSync(receipts)).toEqual([])
    expect(JSON.parse(fs.readFileSync(gate, "utf8"))).toMatchObject({ phase: "complete" })
  })

  it.each([
    ["unit-16l-duplicate-callback", "interactiveDriver", "interactive scenario driver is unavailable"],
    ["unit-16e-1-stop-denial", "denialDriver", "read-only denial scenario driver is unavailable"],
  ] as const)("fails closed when %s has no required driver", async (label, _driver, message) => {
    const receipts = path.join(root, `missing-${label}`)
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000,
      receiptRoot: receipts,
      gateStatusPath: path.join(root, `missing-${label}-gate.json`),
      readFacts: async () => base(),
    })
    const begin = await capture({ phase: "begin", label, externalGate: "test", sources: ["telegram-audit"] })
    await expect(capture({ phase: "poll", label, externalGate: "test", sources: ["telegram-audit"], checkpointDigest: begin.checkpointDigest as string })).rejects.toThrow(message)
  })

  it.each([
    ["unit-16l-duplicate-callback", "interactive"],
    ["unit-16e-1-stop-denial", "denial"],
  ] as const)("keeps %s waiting while its %s driver is waiting", async (label, kind) => {
    const poll = vi.fn(async () => ({ state: "waiting" as const }))
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000,
      receiptRoot: path.join(root, `waiting-${label}`),
      gateStatusPath: path.join(root, `waiting-${label}-gate.json`),
      readFacts: async () => base(),
      ...(kind === "interactive"
        ? { interactiveDriver: { poll, complete: vi.fn(), cleanup: vi.fn() } }
        : { denialDriver: { poll, complete: vi.fn() } }),
    })
    const begin = await capture({ phase: "begin", label, externalGate: "test", sources: ["telegram-audit"] })
    await expect(capture({ phase: "poll", label, externalGate: "test", sources: ["telegram-audit"], checkpointDigest: begin.checkpointDigest as string })).resolves.toEqual(begin)
    expect(poll).toHaveBeenCalledOnce()
  })

  it("persists the no-callback baseline once an active approval becomes observable", async () => {
    let facts = base()
    const receiptRoot = path.join(root, "no-callback-baseline")
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000,
      receiptRoot,
      gateStatusPath: path.join(root, "no-callback-baseline-gate.json"),
      readFacts: async () => facts,
    })
    const input = { phase: "begin" as const, label: "unit-15c-1-no-callback-terminalization" as const, externalGate: "expiry", sources: ["telegram-offset", "telegram-audit"] }
    const begin = await capture(input)
    facts = base()
    facts.approvals.push(approval("proposed"))
    facts.events.push(event("telegram.callback_settled"), event("telegram.update_dropped"))
    const pollInput = { ...input, phase: "poll" as const, checkpointDigest: begin.checkpointDigest as string }
    await expect(capture(pollInput)).resolves.toEqual(begin)
    const stored = JSON.parse(fs.readFileSync(path.join(receiptRoot, `${begin.checkpointDigest as string}.json`), "utf8"))
    expect(stored.noCallbackBaseline).toMatchObject({ approvalId: "approval-1", inboundEventCount: 2, offsetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(stored.before.sourceValues["no-callback-baseline"]).toEqual(stored.noCallbackBaseline)
  })

  it("refuses to publish completion when an interactive driver requests inspect-before-retry", async () => {
    let facts = base()
    const complete = vi.fn(async () => "preserve" as const)
    const cleanup = vi.fn()
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000,
      receiptRoot: path.join(root, "interactive-preserve"),
      gateStatusPath: path.join(root, "interactive-preserve-gate.json"),
      readFacts: async () => facts,
      interactiveDriver: { poll: async () => ({ state: "driven" }), complete, cleanup },
    })
    const input = { phase: "begin" as const, label: "unit-16l-duplicate-callback" as const, externalGate: "callback", sources: ["approval-journal", "telegram-audit"] }
    const begin = await capture(input)
    facts = base()
    facts.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2 }]
    facts.restartAttempts = successfulRestart()
    facts.events = approvalEvidence("approve", 1_000, 2_000)
    facts.interactiveDriver = duplicateCallbackDriver()
    await expect(capture({ ...input, phase: "poll", checkpointDigest: begin.checkpointDigest as string })).rejects.toThrow(/inspect-before-retry/u)
    expect(complete).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it("covers default paths, invalid checkpoints, checkpoint rebinding, claimed baselines, and absent baselines", async () => {
    const defaultCapture = createSanctuaryScenarioCapture({ now: () => 400_000, readFacts: async () => base() })
    await expect(defaultCapture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "telegram", sources: ["telegram-audit"] })).rejects.toMatchObject({ code: "ENOENT" })

    const receipts = path.join(root, "capture-branches")
    let facts = base()
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: path.join(root, "capture-branches-gate.json"), readFacts: async () => facts })
    await expect(capture({ phase: "poll", label: "unit-16d-whats-up", externalGate: "telegram", sources: [], checkpointDigest: undefined })).rejects.toThrow(/checkpoint digest/u)
    const begin = await capture({ phase: "begin", label: "unit-15c-1-no-callback-terminalization", externalGate: "expiry", sources: ["telegram-offset"] })
    await expect(capture({ phase: "poll", label: "unit-15c-1-no-callback-terminalization", externalGate: "changed", sources: ["telegram-offset"], checkpointDigest: begin.checkpointDigest as string })).rejects.toThrow(/binding mismatch/u)
    await expect(capture({ phase: "poll", label: "unit-15c-1-no-callback-terminalization", externalGate: "expiry", sources: ["telegram-offset"], checkpointDigest: begin.checkpointDigest as string })).resolves.toEqual(begin)
    facts = base(); facts.approvals = [approval("claimed")]
    await expect(capture({ phase: "poll", label: "unit-15c-1-no-callback-terminalization", externalGate: "expiry", sources: ["telegram-offset"], checkpointDigest: begin.checkpointDigest as string })).resolves.toEqual(begin)
  })

  it("cleans up a successfully completed interactive capture", async () => {
    let facts = base()
    const cleanup = vi.fn()
    const complete = vi.fn(async () => "complete" as const)
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000,
      receiptRoot: path.join(root, "interactive-complete"),
      gateStatusPath: path.join(root, "interactive-complete-gate.json"),
      readFacts: async () => facts,
      interactiveDriver: { poll: async () => ({ state: "driven" }), complete, cleanup },
    })
    const input = { phase: "begin" as const, label: "unit-16l-duplicate-callback" as const, externalGate: "callback", sources: ["approval-journal"] }
    const begin = await capture(input)
    facts = base(); facts.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2 }]; facts.restartAttempts = successfulRestart(); facts.events = approvalEvidence("approve", 1_000, 2_000); facts.interactiveDriver = duplicateCallbackDriver()
    await expect(capture({ ...input, phase: "poll", checkpointDigest: begin.checkpointDigest as string })).resolves.toMatchObject({ state: "complete" })
    expect(complete).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("retains durable health cleanup coordinates when broker start fails", async () => {
    const receipts = path.join(root, "failed-start-receipts")
    const gate = path.join(root, "failed-start-gate.json")
    const marker = path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")
    const failure = new Error("start failed")
    const recover = vi.fn(async () => {})
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate,
      readFacts: async () => base(),
      healthDriver: { begin: async () => { throw failure }, poll: async () => ({ state: "waiting" }), recover },
    })
    await expect(capture({ phase: "begin", label: "unit-16f-cron-fingerprint", externalGate: "cron", sources: ["cron-runtime"] })).rejects.toBe(failure)
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.readdirSync(receipts)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(gate, "utf8"))).toMatchObject({ phase: "waiting" })
    const active = readSanctuaryAcceptanceMarker("sanctuary")!
    const finalize = createSanctuaryAcceptanceScenarioFinalizer({
      readActiveScenario: () => readSanctuaryAcceptanceMarker("sanctuary"),
      recoverHealthScenario: recover,
      finalizeLocal: () => finalizeSanctuaryScenarioCapture(gate, receipts),
    })
    await finalize()
    expect(recover).toHaveBeenCalledWith(active.label, active.scenarioHandleDigest)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readdirSync(receipts)).toEqual([])
    expect(fs.existsSync(gate)).toBe(false)
  })

  it("requires a health driver independently at begin and poll", async () => {
    const beginMissing = createSanctuaryScenarioCapture({
      now: () => 400_000,
      receiptRoot: path.join(root, "health-driver-missing-begin"),
      gateStatusPath: path.join(root, "health-driver-missing-begin-gate.json"),
      readFacts: async () => base(),
    })
    await expect(beginMissing({ phase: "begin", label: "unit-16g-health-transition", externalGate: "health", sources: ["health-probe-receipt"] })).rejects.toThrow(/health scenario driver is unavailable/u)

    const receipts = path.join(root, "health-driver-missing-poll")
    const gate = path.join(root, "health-driver-missing-poll-gate.json")
    const withDriver = createSanctuaryScenarioCapture({
      now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base(),
      healthDriver: { begin: async () => {}, poll: async () => ({ state: "waiting" }), recover: async () => {} },
    })
    const input = { phase: "begin" as const, label: "unit-16g-health-transition" as const, externalGate: "health", sources: ["health-probe-receipt"] }
    const begin = await withDriver(input)
    const withoutDriver = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await expect(withoutDriver({ ...input, phase: "poll", checkpointDigest: begin.checkpointDigest as string })).rejects.toThrow(/health scenario driver is unavailable/u)
  })

  it("preserves an incomplete interactive receipt and active marker for inspect-before-retry", async () => {
    const localFinalize = vi.fn()
    const finalize = createSanctuaryAcceptanceScenarioFinalizer({
      readActiveScenario: () => ({ label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }),
      recoverHealthScenario: vi.fn(),
      finalizeInteractiveScenario: async () => "preserve" as const,
      finalizeLocal: localFinalize,
    })
    await expect(finalize()).rejects.toThrow(/inspect-before-retry/u)
    expect(localFinalize).not.toHaveBeenCalled()
  })

  it("preserves a complete interactive receipt after a lost capture response", async () => {
    const localFinalize = vi.fn()
    const finalize = createSanctuaryAcceptanceScenarioFinalizer({
      readActiveScenario: () => ({ label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }),
      recoverHealthScenario: vi.fn(),
      finalizeInteractiveScenario: async () => "complete" as const,
      finalizeLocal: localFinalize,
    })
    await expect(finalize()).rejects.toThrow(/inspect-before-retry/u)
    expect(localFinalize).not.toHaveBeenCalled()
  })

  it("retains health state when recovery fails before completion publication", async () => {
    const receipts = path.join(root, "failed-recovery-receipts")
    const gate = path.join(root, "failed-recovery-gate.json")
    const marker = path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")
    const failure = new Error("recover failed")
    const after = base(); after.healthProbe = healthProbe("unit-16h-daily-digest")
    const capture = createSanctuaryScenarioCapture({
      now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate,
      readFacts: async (_label, _handle, options) => options?.skipContainerSnapshot ? base() : after,
      healthDriver: { begin: async () => {}, poll: async () => ({ state: "ready", containerSnapshot: {} }), recover: async () => { throw failure } },
    })
    const begin = await capture({ phase: "begin", label: "unit-16h-daily-digest", externalGate: "digest", sources: ["digest-runtime", "health-probe-receipt"] })
    await expect(capture({ phase: "poll", label: "unit-16h-daily-digest", externalGate: "digest", sources: ["digest-runtime", "health-probe-receipt"], checkpointDigest: begin.checkpointDigest as string })).rejects.toBe(failure)
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.readdirSync(receipts)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(gate, "utf8"))).toMatchObject({ phase: "waiting" })
  })

  it("never invokes the health driver for a non-health scenario", async () => {
    const healthDriver = { begin: vi.fn(), poll: vi.fn(), recover: vi.fn() }
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: path.join(root, "ordinary"), gateStatusPath: path.join(root, "ordinary-gate.json"), healthDriver, readFacts: async () => base() })
    const begin = await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "telegram", sources: ["telegram-audit"] })
    await capture({ phase: "poll", label: "unit-16d-whats-up", externalGate: "telegram", sources: ["telegram-audit"], checkpointDigest: begin.checkpointDigest as string })
    expect(healthDriver.begin).not.toHaveBeenCalled()
    expect(healthDriver.poll).not.toHaveBeenCalled()
    expect(healthDriver.recover).not.toHaveBeenCalled()
  })

  it("finalizes the exact active private marker, receipt, and public gate", async () => {
    const receipts = path.join(root, "cleanup-receipts")
    const gate = path.join(root, "cleanup-evidence", "current-scenario-gate.json")
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"] })
    const marker = path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")
    expect(fs.readdirSync(receipts)).toHaveLength(1)
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.existsSync(gate)).toBe(true)

    finalizeSanctuaryScenarioCapture(gate, receipts)

    expect(fs.readdirSync(receipts)).toHaveLength(0)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(gate)).toBe(false)
  })

  it("quarantines corrupt marker and receipt state before surfacing cleanup failure", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const gate = path.join(root, "corrupt-evidence", "current-scenario-gate.json")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(acceptanceRoot, "active-scenario.json"), "{}\n", { mode: 0o600 })
    fs.writeFileSync(path.join(receipts, "not-a-receipt"), "untrusted\n", { mode: 0o600 })
    fs.mkdirSync(path.dirname(gate), { recursive: true })
    fs.writeFileSync(gate, "{}\n")

    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(fs.readdirSync(receipts)).toEqual([])
    expect(fs.existsSync(gate)).toBe(false)
    const quarantine = fs.readdirSync(path.join(acceptanceRoot, "quarantine"))
    expect(quarantine.some((entry) => entry.startsWith("active-scenario-"))).toBe(true)
    expect(quarantine.some((entry) => entry.startsWith("receipts-"))).toBe(true)
  })

  it("atomically quarantines an ambiguous active receipt set without losing evidence", async () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const gate = path.join(root, "ambiguous-evidence", "current-scenario-gate.json")
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"] })
    const original = fs.readdirSync(receipts)[0]!
    fs.copyFileSync(path.join(receipts, original), path.join(receipts, `${"f".repeat(64)}.json`))
    fs.chmodSync(path.join(receipts, `${"f".repeat(64)}.json`), 0o600)

    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(fs.readdirSync(receipts)).toEqual([])
    const quarantinedReceiptRoot = fs.readdirSync(path.join(acceptanceRoot, "quarantine"))
      .find((entry) => entry.startsWith("receipts-"))
    expect(quarantinedReceiptRoot).toBeDefined()
    expect(fs.readdirSync(path.join(acceptanceRoot, "quarantine", quarantinedReceiptRoot!))).toHaveLength(2)
  })

  it("stops receipt inspection at the thirty-third entry and quarantines the complete set", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(receipts, `entry-${index}`), "evidence\n", { mode: 0o600 })

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(fs.readdirSync(receipts)).toEqual([])
    const quarantinedReceiptRoot = fs.readdirSync(path.join(acceptanceRoot, "quarantine"))
      .find((entry) => entry.startsWith("receipts-"))
    expect(fs.readdirSync(path.join(acceptanceRoot, "quarantine", quarantinedReceiptRoot!))).toHaveLength(40)
  })

  it("quarantines a symlink receipt root by inode without traversing its target", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const outside = path.join(root, "outside-receipts")
    fs.mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(outside, { mode: 0o700 })
    fs.writeFileSync(path.join(outside, "preserved"), "evidence\n", { mode: 0o600 })
    fs.symlinkSync(outside, receipts)

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(fs.lstatSync(receipts).isDirectory()).toBe(true)
    expect(fs.statSync(receipts).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(outside, "preserved"), "utf8")).toBe("evidence\n")
    const quarantined = fs.readdirSync(path.join(acceptanceRoot, "quarantine")).find((entry) => entry.startsWith("receipts-"))
    expect(quarantined).toBeDefined()
    expect(fs.lstatSync(path.join(acceptanceRoot, "quarantine", quarantined!)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(acceptanceRoot, "quarantine", quarantined!))).toBe(outside)
  })

  it("moves a quarantine-root symlink aside without touching its external target", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const quarantine = path.join(acceptanceRoot, "quarantine")
    const outside = path.join(root, "outside-quarantine")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    fs.mkdirSync(outside, { mode: 0o700 })
    fs.writeFileSync(path.join(outside, "preserved"), "external\n", { mode: 0o600 })
    fs.symlinkSync(outside, quarantine)
    fs.writeFileSync(path.join(acceptanceRoot, "active-scenario.json"), "{}\n", { mode: 0o600 })

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(fs.lstatSync(quarantine).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(outside, "preserved"), "utf8")).toBe("external\n")
    expect(fs.readdirSync(outside)).toEqual(["preserved"])
    const entries = fs.readdirSync(quarantine)
    expect(entries.some((entry) => entry.startsWith("quarantine-rejected-"))).toBe(true)
    expect(entries.some((entry) => entry.startsWith("active-scenario-"))).toBe(true)
  })

  it("moves a dangling quarantine-root symlink by inode without following it", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const quarantine = path.join(acceptanceRoot, "quarantine")
    const missing = path.join(root, "missing-quarantine-target")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    fs.symlinkSync(missing, quarantine)
    fs.writeFileSync(path.join(acceptanceRoot, "active-scenario.json"), "{}\n", { mode: 0o600 })

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(fs.existsSync(missing)).toBe(false)
    expect(fs.readdirSync(acceptanceRoot).some((entry) => entry.startsWith(".quarantine-rejected-"))).toBe(false)
    const rejected = fs.readdirSync(quarantine).find((entry) => entry.startsWith("quarantine-rejected-"))
    expect(rejected).toBeDefined()
    expect(fs.lstatSync(path.join(quarantine, rejected!)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(quarantine, rejected!))).toBe(missing)
  })

  it("anchors quarantine mutation to opened directory descriptors across pathname exchange", () => {
    const source = path.join(root, "bound-source")
    const quarantine = path.join(root, "bound-quarantine")
    const rebound = path.join(root, "rebound-quarantine")
    const outside = path.join(root, "outside-bound-quarantine")
    fs.mkdirSync(source, { recursive: true, mode: 0o700 })
    fs.mkdirSync(quarantine, { mode: 0o700 })
    fs.mkdirSync(outside, { mode: 0o700 })
    fs.writeFileSync(path.join(source, "evidence"), "evidence\n", { mode: 0o600 })
    const expected = fs.lstatSync(path.join(source, "evidence"))
    const sourceHandle = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const quarantineHandle = fs.openSync(quarantine, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
      fs.renameSync(quarantine, rebound)
      fs.symlinkSync(outside, quarantine)
      secureRenameBoundInodeSync(sourceHandle, "evidence", quarantineHandle, "captured", expected)
    } finally {
      fs.closeSync(quarantineHandle)
      fs.closeSync(sourceHandle)
    }
    expect(fs.readFileSync(path.join(rebound, "captured"), "utf8")).toBe("evidence\n")
    expect(fs.readdirSync(outside)).toEqual([])
    expect(() => secureRenameBoundInodeSync(-1, "../escape", -1, "captured", expected)).toThrow(/basename/u)
  })

  it("does not perform a blocking open when a receipt root is a FIFO", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/heart/daemon/sanctuary-acceptance-scenarios.ts"), "utf8")
    const helper = source.slice(source.indexOf("function durableQuarantineReceiptRoot"), source.indexOf("export function finalizeSanctuaryScenarioCapture"))
    expect(helper).toContain("fs.constants.O_NONBLOCK")
  })

  it("keeps quarantine rename durability and inode checks structurally explicit", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/heart/daemon/sanctuary-acceptance-scenarios.ts"), "utf8")
    const helper = source.slice(source.indexOf("function durableQuarantineReceiptRoot"), source.indexOf("export function finalizeSanctuaryScenarioCapture"))
    expect(helper).toContain("fs.constants.O_NOFOLLOW")
    expect(helper).toContain("rootMetadata.ino !== reboundMetadata.ino")
    expect(helper.indexOf("secureRenameBoundInodeSync(")).toBeLessThan(helper.indexOf("fs.fsyncSync(rootHandle)"))
    expect(helper.match(/fs\.fsyncSync\(/gu)).toHaveLength(5)
  })

  it("keeps marker quarantine inode binding and durability structurally explicit", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/heart/daemon/sanctuary-acceptance-marker.ts"), "utf8")
    const helper = source.slice(source.indexOf("export function quarantineSanctuaryAcceptanceMarker"), source.indexOf("export function sanctuaryAcceptanceEventMeta"))
    expect(helper).toContain("fs.constants.O_NOFOLLOW")
    expect(helper).toContain("markerMetadata.ino !== markerPathMetadata.ino")
    expect(helper.indexOf("secureRenameBoundInodeSync(")).toBeLessThan(helper.indexOf("fs.fsyncSync(markerHandle)"))
    expect(helper.match(/fs\.fsyncSync\(/gu)?.length).toBeGreaterThanOrEqual(3)
  })

  it("fails closed when the receipt root inode changes during initial or final enumeration", () => {
    for (const changedCall of [1, 2]) {
      const receipts = path.join(root, `enumeration-race-${changedCall}`)
      fs.mkdirSync(receipts, { recursive: true })
      let receiptStats = 0
      fsFaults.lstatSync = (actualLstat, target, options) => {
        const stats = actualLstat(target, options as never)
        if (String(target) === receipts && ++receiptStats === changedCall) return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: stats.ino + 1 })
        return stats
      }
      try {
        expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow(AggregateError)
      } finally { fsFaults.lstatSync = null }
    }
  })

  it("rejects a receipt whose contents drift from the active marker", async () => {
    const receipts = path.join(root, "binding-race-receipts")
    const gate = path.join(root, "binding-race-gate.json")
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "telegram", sources: ["telegram-audit"] })
    const receiptPath = path.join(receipts, fs.readdirSync(receipts)[0]!)
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, label: "unit-16d-1-space" })}\n`, { mode: 0o600 })
    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow(AggregateError)
  })

  it("records a missing quarantine parent as inspectable cleanup failure when a marker remains", async () => {
    const receipts = path.join(root, "vanished-parent", "receipts")
    const gate = path.join(root, "vanished-parent-gate.json")
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "telegram", sources: ["telegram-audit"] })
    fs.renameSync(path.dirname(receipts), `${path.dirname(receipts)}-moved`)
    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow(AggregateError)
  })

  it.each([
    "quarantine-validation",
    "parent-validation",
    "opened-receipt-rebind",
    "final-receipt-rebind",
    "moved-receipt-rebind",
    "rejected-quarantine-rebind",
    "quarantine-lstat-error",
  ] as const)("fails closed for the %s inode race", (mode) => {
    const parent = path.join(root, `quarantine-race-${mode}`)
    const receipts = path.join(parent, "receipts")
    fs.mkdirSync(receipts, { recursive: true })
    fs.writeFileSync(path.join(receipts, "noncanonical"), "evidence", { mode: 0o600 })
    if (mode === "rejected-quarantine-rebind") fs.writeFileSync(path.join(parent, "quarantine"), "not-a-directory", { mode: 0o600 })
    let receiptLstats = 0
    let quarantineLstats = 0
    fsFaults.lstatSync = (actualLstat, target, options) => {
      const targetText = String(target)
      if (targetText === path.join(parent, "quarantine")) {
        quarantineLstats += 1
        if (mode === "quarantine-lstat-error" && quarantineLstats === 1) throw Object.assign(new Error("injected lstat failure"), { code: "EIO" })
      }
      const stats = actualLstat(target, options as never)
      const changed = () => Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: stats.ino + 1 })
      if (targetText === receipts) {
        receiptLstats += 1
        if (mode === "opened-receipt-rebind" && receiptLstats === 4) return changed()
        if (mode === "final-receipt-rebind" && receiptLstats === 5) return changed()
      }
      if (mode === "parent-validation" && targetText === parent) return changed()
      if (mode === "quarantine-validation" && targetText === path.join(parent, "quarantine") && quarantineLstats === 2) return changed()
      if (mode === "moved-receipt-rebind" && targetText.startsWith(`${path.join(parent, "quarantine", "receipts-")}`)) return changed()
      if (mode === "rejected-quarantine-rebind" && targetText.includes(".quarantine-rejected-")) return changed()
      return stats
    }
    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow(AggregateError)
  })

  it.each(["directory-entry", "oversized-file", "path-rebind", "unlink-failure"] as const)("fails closed for invalid active receipt state: %s", async (mode) => {
    const receipts = path.join(root, `active-receipt-${mode}`)
    const gate = path.join(root, `active-receipt-${mode}-gate.json`)
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "telegram", sources: ["telegram-audit"] })
    const receiptPath = path.join(receipts, fs.readdirSync(receipts)[0]!)
    if (mode === "directory-entry") {
      fs.unlinkSync(receiptPath)
      fs.mkdirSync(receiptPath)
    } else if (mode === "oversized-file") {
      fs.writeFileSync(receiptPath, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 })
    } else if (mode === "path-rebind") {
      fsFaults.lstatSync = (actualLstat, target, options) => {
        const stats = actualLstat(target, options as never)
        return String(target) === receiptPath ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: stats.ino + 1 }) : stats
      }
    } else {
      fsFaults.unlinkSync = (_actual, target) => {
        if (String(target) === receiptPath) throw Object.assign(new Error("injected unlink failure"), { code: "EIO" })
      }
    }
    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow(AggregateError)
  })

  it("waits instead of self-attesting absent negative and containment facts", () => {
    const before = base()
    const containment = base(); containment.container!.updaterDisabled = false
    expect(deriveSanctuaryScenarioAssertions("unit-16b-runtime-vault-containment", before, containment, 400_000)).toBeNull()
    const unauthorized = base(); unauthorized.events.push(event("telegram.update_dropped"))
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, unauthorized, 400_000)).toBeNull()
    const denial = base(); denial.approvals = [{ ...approval("denied"), replayMutationCount: 1 }]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", before, denial, 400_000)).toBeNull()
    const audit = base(); audit.containment!.sensitiveMaterialObserved = true
    expect(deriveSanctuaryScenarioAssertions("unit-16e-containment-audit", before, audit, 400_000)).toBeNull()
    const unlinkedMutation = base(); unlinkedMutation.restartAttempts = successfulRestart().map((attempt) => ({ ...attempt, approvalId: "unlinked" }))
    expect(deriveSanctuaryScenarioAssertions("unit-16e-containment-audit", before, unlinkedMutation, 400_000)).toBeNull()
    const wrongApproval = base(); wrongApproval.approvals = [{ ...approval("denied"), toolName: "ponder", target: null }]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", before, wrongApproval, 400_000)).toBeNull()
    const unobservedProvider = base(); unobservedProvider.provider!.requestSemanticsExact = false
    expect(deriveSanctuaryScenarioAssertions("unit-16c-provider-readiness", before, unobservedProvider, 400_000)).toBeNull()
  })

  it("binds positive turns and approvals to one new scenario record", () => {
    const before = base()
    const decoy = turnReceipt(["6".repeat(64)])
    const after = base()
    after.telegramTurns.push(decoy, turnReceipt(["5".repeat(64)]))
    after.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64) } })
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", before, after, 400_000)).toBeNull()

    const overbroad = base()
    overbroad.telegramTurns.push({ ...turnReceipt(["5".repeat(64), "6".repeat(64)]), toolInvocationCount: 2 })
    overbroad.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64) } })
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", before, overbroad, 400_000)).toBeNull()

    const ambiguous = base()
    ambiguous.approvals = [approval("denied"), { ...approval("denied"), approvalId: "approval-2" }]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", before, ambiguous, 400_000)).toBeNull()
  })

  it("requires unauthorized traffic to leave every scenario work ledger empty", () => {
    const before = base()
    const after = base()
    after.events.push({ ...event("telegram.update_dropped"), meta: { scenarioHandleDigest: "a".repeat(64), distinctAccount: true } })
    after.telegramTurns.push({ ...turnReceipt(), status: "error", deliveryCount: 0, telegramMessageIdDigests: [], providerTurnCount: 1 })
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
  })

  it("requires exactly one fresh scenario-bound distinct-account drop", () => {
    const binding = { senderIdentityDigest: "d".repeat(64), authorizedIdentityDigest: "e".repeat(64), senderDistinct: true, nextOffsetDigest: "9".repeat(64), dropMac: "f".repeat(64) }
    const historical = { ...event("telegram.update_dropped"), meta: { scenarioHandleDigest, updateDigest: "0".repeat(64), distinctAccount: true, ...binding } }
    const freshDistinct = { ...event("telegram.update_dropped"), at: 2, meta: { scenarioHandleDigest, updateDigest: "1".repeat(64), distinctAccount: true, ...binding } }
    const before = base(); before.events = [historical]
    const after = base(); after.events = [historical, freshDistinct]; after.telegramNextUpdateId = 11
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toMatchObject({ auditRejected: true, distinctAccount: true })

    after.events = [historical, { ...freshDistinct, meta: { ...freshDistinct.meta, distinctAccount: false } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, freshDistinct, { ...freshDistinct, at: 3, meta: { ...freshDistinct.meta, updateDigest: "2".repeat(64) } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, { ...freshDistinct, meta: { ...freshDistinct.meta, updateDigest: "not-a-digest" } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, { ...freshDistinct, meta: { ...freshDistinct.meta, senderIdentityDigest: freshDistinct.meta.authorizedIdentityDigest } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, { ...freshDistinct, meta: { ...freshDistinct.meta, senderDistinct: false } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, { ...freshDistinct, meta: { ...freshDistinct.meta, dropMac: "not-a-mac" } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, freshDistinct, { ...event("senses.sanctuary_health_delivered"), at: 3, meta: { scenarioHandleDigest, deliveryCount: 1 } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.events = [historical, freshDistinct]
    after.identity = { ...after.identity!, sessionSurfaceDigest: "d".repeat(64) }
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.identity = { ...before.identity }
    after.telegramNextUpdateId = before.telegramNextUpdateId
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.telegramNextUpdateId = Number(before.telegramNextUpdateId) + 2
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.telegramNextUpdateId = 11
    after.zeroWork = { ...after.zeroWork!, outwardDigest: "f".repeat(64) }
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
    after.zeroWork = { ...before.zeroWork!, sessionFriendDigest: "f".repeat(64) }
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
  })

  it.each(["unit-16d-whats-up", "unit-16i-delayed-approval", "unit-16j-denial"] as const)("requires one fresh exact audit lifecycle for %s", (label) => {
    const before = base()
    const after = base()
    if (label === "unit-16d-whats-up") {
      after.telegramTurns = [groundedTurn("unraid_get_system", systemGrounding, "Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded.")]
      after.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64), groundingDigest: groundingDigest(systemGrounding), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } })
      after.liveGrounding = { toolName: "unraid_get_system", groundingDigest: groundingDigest(systemGrounding), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts: systemGrounding }
    } else {
      after.approvals = [approval(label === "unit-16i-delayed-approval" ? "succeeded" : "denied")]
      if (label === "unit-16i-delayed-approval") after.restartAttempts = successfulRestart()
      after.events.push(...approvalEvidence(label === "unit-16i-delayed-approval" ? "approve" : "deny", 1_000, label === "unit-16i-delayed-approval" ? 121_000 : 2_000))
    }
    after.events.push(...auditTurn())
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).not.toBeNull()

    const valid = [...after.events]
    after.events = valid.filter((entry) => entry.event !== "senses.telegram_turn_end")
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    after.events = valid.map((entry) => entry.event === "senses.telegram_turn_end" ? { ...entry, meta: { ...entry.meta, outcome: undefined } } : entry)
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    after.events = valid.map((entry) => entry.event === "senses.telegram_turn_end" ? { ...entry, meta: { ...entry.meta, errorDigest: undefined } } : entry)
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    after.events = valid.map((entry) => entry.event === "senses.telegram_turn_end" ? { ...entry, meta: { ...entry.meta, sessionDigest: "c".repeat(64) } } : entry)
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    after.events = valid.map((entry) => entry.event === "senses.telegram_turn_end" ? { ...entry, meta: { ...entry.meta, lifecycleAt: 8_000 } } : entry)
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    before.events = [valid[0]!]
    after.events = [valid[1]!]
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    before.events = valid
    after.events = [valid[1]!, valid[0]!]
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
    before.events = auditTurn()
    after.events = auditTurn()
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
  })

  it("requires one new turn with exactly one canonical session and Friends identity", () => {
    const before = base()
    const after = base()
    after.telegramTurns = [turnReceipt()]
    after.events = auditTurn()
    expect(deriveSanctuaryScenarioAssertions("unit-14b-3-opaque-identity-live", before, after, 400_000)).not.toBeNull()
    after.telegramTurns.push({ ...turnReceipt(), updateDigest: "2".repeat(64) })
    expect(deriveSanctuaryScenarioAssertions("unit-14b-3-opaque-identity-live", before, after, 400_000)).toBeNull()
    after.telegramTurns = [turnReceipt()]
    after.identity = { ...after.identity!, canonicalSessionCount: 2 }
    expect(deriveSanctuaryScenarioAssertions("unit-14b-3-opaque-identity-live", before, after, 400_000)).toBeNull()
    after.identity = { ...after.identity!, canonicalSessionCount: 1, canonicalFriendCount: 2 }
    expect(deriveSanctuaryScenarioAssertions("unit-14b-3-opaque-identity-live", before, after, 400_000)).toBeNull()
  })

  it("treats lone indeterminate attempts as unsafe across negative approval and containment gates", () => {
    const unsafe = { ...successfulRestart()[0]!, state: "attempted_or_indeterminate" as const, approvalId: "unlinked", attemptId: "unlinked-attempt" }
    const noCallbackBefore = base()
    const noCallback = base(); noCallback.approvals = [approval("expired")]; noCallback.restartAttempts = [unsafe]
    noCallbackBefore.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: probeDigest(noCallback.sourceValues["telegram-offset"]), inboundEventCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-15c-1-no-callback-terminalization", noCallbackBefore, noCallback, 400_000)).toBeNull()

    for (const [label, state] of [["unit-16j-denial", "denied"], ["unit-16k-timeout-stale", "expired"]] as const) {
      const after = base(); after.approvals = [approval(state)]; after.restartAttempts = [unsafe]
      expect(deriveSanctuaryScenarioAssertions(label, base(), after, 400_000)).toBeNull()
    }
    const containment = base(); containment.restartAttempts = [unsafe]
    expect(deriveSanctuaryScenarioAssertions("unit-16e-containment-audit", base(), containment, 400_000)).toBeNull()
  })

  it("rejects extra unlinked attempts from every positive approval proof", () => {
    const unsafe = { ...successfulRestart()[0]!, state: "attempted_or_indeterminate" as const, approvalId: "unlinked", attemptId: "unlinked-attempt" }
    for (const label of ["unit-16i-delayed-approval", "unit-16l-duplicate-callback", "unit-16m-restart-continuation"] as const) {
      const after = base()
      after.approvals = [{ ...approval("succeeded"), ...(label === "unit-16l-duplicate-callback" ? { callbackCount: 2, settledCount: 2, claimCount: 1 } : {}) }]
      after.restartAttempts = [...successfulRestart(), unsafe]
      if (label === "unit-16m-restart-continuation") after.events.push({ ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } })
      expect(deriveSanctuaryScenarioAssertions(label, base(), after, 400_000)).toBeNull()
    }
  })

  it("rejects a second linked indeterminate attempt from every positive exactly-once proof", () => {
    const extra = { ...successfulRestart()[0]!, state: "attempted_or_indeterminate" as const, attemptId: "attempt-2", observedAt: 4_000 }
    for (const label of ["unit-16i-delayed-approval", "unit-16l-duplicate-callback", "unit-16m-restart-continuation"] as const) {
      const after = base()
      after.approvals = [{ ...approval("succeeded"), ...(label === "unit-16l-duplicate-callback" ? { callbackCount: 2, settledCount: 2, claimCount: 1 } : {}) }]
      after.restartAttempts = [...successfulRestart(), extra]
      if (label === "unit-16m-restart-continuation") after.events.push({ ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } })
      expect(deriveSanctuaryScenarioAssertions(label, base(), after, 400_000)).toBeNull()
    }
  })

  it("accepts a daily digest fired exactly at the local boundary", () => {
    const before = base()
    const after = base()
    after.healthProbe = healthProbe("unit-16h-daily-digest")
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, after, 400_000)).toMatchObject({ firedWithinMs: 0 })
  })

  it("derives exact private-turn and delivery counts from observed health-probe metrics", () => {
    const before = base()
    const cron = base(); cron.healthProbe = healthProbe("unit-16f-cron-fingerprint")
    const transitions = base(); transitions.healthProbe = healthProbe("unit-16g-health-transition")
    const digest = base(); digest.healthProbe = healthProbe("unit-16h-daily-digest")
    expect(deriveSanctuaryScenarioAssertions("unit-16f-cron-fingerprint", before, cron, 400_000)).toMatchObject({ providerInvocationCount: 0, messageCount: 0 })
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toEqual({ alertCount: 3, productionRestored: true, transitionObserved: true })
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toMatchObject({ firedWithinMs: 0, messageCount: 1 })
  })

  it("rejects health-probe phase, private-turn, provider-bound, and restoration drift", () => {
    const before = base()
    const cron = base(); cron.healthProbe = { ...healthProbe("unit-16f-cron-fingerprint"), providerInvocationCount: 1 }
    expect(deriveSanctuaryScenarioAssertions("unit-16f-cron-fingerprint", before, cron, 400_000)).toBeNull()

    const transitions = base(); transitions.healthProbe = healthProbe("unit-16g-health-transition")
    transitions.healthProbe.phases[4] = { ...transitions.healthProbe.phases[4]!, recovered: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()
    transitions.healthProbe = { ...healthProbe("unit-16g-health-transition"), privateTurnCount: 2 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()
    transitions.healthProbe = { ...healthProbe("unit-16g-health-transition"), providerInvocationCount: 2 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()
    transitions.healthProbe = { ...healthProbe("unit-16g-health-transition"), providerInvocationCount: 1_001 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()

    const digest = base(); digest.healthProbe = { ...healthProbe("unit-16h-daily-digest"), privateTurnCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toBeNull()
    digest.healthProbe = { ...healthProbe("unit-16h-daily-digest"), providerInvocationCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toBeNull()
    digest.healthProbe = { ...healthProbe("unit-16h-daily-digest"), restoredStateDigest: "9".repeat(64) }
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toBeNull()
  })

  it.each(["unit-16f-cron-fingerprint", "unit-16g-health-transition", "unit-16h-daily-digest"] as const)("binds %s restoration to the independently observed current cron", (label) => {
    const fingerprintDrift = base(); fingerprintDrift.healthProbe = healthProbe(label); fingerprintDrift.cron!.fingerprint = "9".repeat(64)
    expect(deriveSanctuaryScenarioAssertions(label, base(), fingerprintDrift, 400_000)).toBeNull()
    const registrationDrift = base(); registrationDrift.healthProbe = healthProbe(label); registrationDrift.cron!.registered = false
    expect(deriveSanctuaryScenarioAssertions(label, base(), registrationDrift, 400_000)).toBeNull()
  })
})
