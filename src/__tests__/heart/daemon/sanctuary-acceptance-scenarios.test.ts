import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scenarios-"))
vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => path.join(root, "sanctuary.ouro") }))

import {
  createSanctuaryScenarioCapture,
  deriveSanctuaryScenarioAssertions,
  finalizeSanctuaryScenarioCapture,
  type SanctuaryScenarioFacts,
} from "../../../heart/daemon/sanctuary-acceptance-scenarios"
import { SANCTUARY_SCENARIO_SOURCES, SANCTUARY_UNIT_16_EVIDENCE_LABELS, validateSanctuaryUnit16EvidenceAssertions } from "../../../heart/daemon/sanctuary-acceptance-harness"
import { readSanctuaryAcceptanceMarker, secureRenameBoundInodeSync } from "../../../heart/daemon/sanctuary-acceptance-marker"
import { createSanctuaryAcceptanceScenarioFinalizer } from "../../../heart/daemon/sanctuary-acceptance-adapter"

const event = (name: string) => ({ event: name, at: 1, meta: {} })
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
const approvalAuditEvent = (eventName: string, at: number, patch: Record<string, unknown> = {}) => ({
  event: eventName,
  at,
  meta: {
    scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1", actionDigest: promptActionDigest,
    targetDigest, messageIdDigest: "4".repeat(64), evidenceMac: "5".repeat(64), ...patch,
  },
})
const approvalEvidence = (decision: "approve" | "deny", boundAt = 1_000, callbackAt = 121_000) => [
  approvalAuditEvent("senses.telegram_approval_prompt_bound", boundAt, { boundAt }),
  approvalAuditEvent("telegram.callback_settled", callbackAt, { boundAt, callbackAt, acknowledged: true, accepted: decision === "approve", reason: decision === "approve" ? "accepted" : "decision_refused" }),
  approvalAuditEvent("senses.telegram_approval_continuation_delivered", callbackAt + 1, { boundAt, deliveredAt: callbackAt + 1, resultDigest: approvalResultDigest(decision === "approve" ? "succeeded" : "denied"), deliveryDigest: "8".repeat(64), deliveryMessageIdDigest: "7".repeat(64) }),
  approvalAuditEvent("telegram.approval_prompt_terminalized", callbackAt + 2, { boundAt, terminalizedAt: callbackAt + 2, buttonsRemoved: true }),
]
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
  indeterminateRecoveryObserved: true, indeterminateRetryCount: 0,
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
  }
}
const validDenialReceiptForFacts = () => {
  const boundary = { ownerSnapshotDigest: "1".repeat(64), targetSnapshotDigest: "2".repeat(64), targetRestartCount: 7, targetContainerIdDigest: "7".repeat(64), auditCursorDigest: "3".repeat(64), providerUsageCursorDigest: "4".repeat(64), sessionCursorDigest: "5".repeat(64), toolActionCursorDigest: "6".repeat(64) }
  return { schemaVersion: "sanctuary-read-only-denial-receipt-v1" as const, phase: "complete" as const, label: "unit-16e-1-stop-denial" as const, scenarioHandleDigest: "a".repeat(64), operation: "stop" as const, targetDigest: "7".repeat(64), attemptCount: 1, httpStatus: 403, errorCode: "FORBIDDEN", before: boundary, after: { ...boundary } }
}
const base = (): SanctuaryScenarioFacts => ({
  capturedAt: 0,
  sourceValues: Object.fromEntries(["identity-key", "telegram-audit", "telegram-offset", "telegram-turn-receipts", "live-grounding-read", "approval-journal", "approval-checkpoints", "container-inspect", "provider-live-check", "cron-runtime", "health-runtime", "digest-runtime", "health-probe-receipt", "reboot-checkpoint", "read-only-denial-receipt"].map((key) => [key, { key }])),
  events: [], approvals: [],
  restartAttempts: [],
  telegramTurns: [],
  identity: { keyPresent: true, subjectOpaque: true, rawIdentityAbsent: true, liveSubjectObserved: true, inspectedRecordCount: 1, opaqueSubjectCount: 1, mismatchCount: 0, rawLeakCount: 0, surfaceDigest: "a".repeat(64) },
  container: { exactImage: true, running: true, healthy: true, user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false },
  provider: { outwardReady: true, innerReady: true, geminiCandidateReady: true, providersDistinct: true, silentFallback: false, credentialRevisionsPresent: true, requestSemanticsExact: true, fallbackAttemptCount: 0 },
  cron: { registered: true, fingerprint: "a".repeat(64), receiptDigest: "b".repeat(64), sweepCount: 0 },
  health: { transitionCount: 0, alertCount: 0, productionRestored: true },
  digest: { scheduleObserved: true, messageCount: 0, firedWithinMs: 1_000, productionRestored: true },
  reboot: { phase: "complete", requestDigest: "c".repeat(64), requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: 0, bootIdentityChanged: true, hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
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
    auditPathDigest: createHash("sha256").update("/home/ouro/AgentBundles/sanctuary.ouro/state/daemon/logs/telegram.ndjson").digest("hex"),
    auditLedgerDigest: "4".repeat(64), auditRecordCount: 2, auditLifecyclePairCount: 1,
    containerUser: "10001:10001", liveProcessUser: "10001:10001", mountCount: 2, publishedPortCount: 0, networkMode: "host", readOnlyRoot: true, mountsExact: true, securityExact: true, updaterDisabled: true,
    writableKeyExposure: false, rawWriteMaterialFieldCount: 0, typedWriteExecutorCount: 1,
    writeApprovalPolicyDigest: createHash("sha256").update(JSON.stringify({ kind: "required", policyId: "sanctuary.unraid.restart.v1", actionClass: "unraid.container.restart", requiresSoleCall: true })).digest("hex"),
    sensitiveMaterialObserved: false, stopDenied: true, restartDenied: true, denialAuditCount: 1, denialStateUnchanged: true, denialProbeCompleted: true,
  },
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

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
      if (label.includes("opaque-identity-live")) after.telegramTurns.push(turnReceipt())
      if (label === "unit-15c-1-no-callback-terminalization") {
        after.approvals = [approval("expired")]
        after.events.push(
          approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }),
          approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, terminalizedAt: 301_000, buttonsRemoved: true }),
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
        after.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName, success: true, resultDigest: "5".repeat(64), groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } })
        ;(after as any).liveGrounding = { toolName, groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts }
      }
      if (label === "unit-16d-2-unauthorized") after.events.push({ ...event("telegram.update_dropped"), meta: { scenarioHandleDigest: "a".repeat(64), distinctAccount: true } })
      if (label === "unit-16e-2-restart-denial") after.denial = { ...after.denial!, label, operation: "restart" }
      if (label === "unit-16j-denial") { after.approvals = [approval("denied")]; after.events.push(...approvalEvidence("deny", 1_000, 2_000)) }
      if (label === "unit-16f-cron-fingerprint" || label === "unit-16g-health-transition" || label === "unit-16h-daily-digest") after.healthProbe = healthProbe(label)
      if (label === "unit-16i-delayed-approval") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart(); after.events.push(...approvalEvidence("approve")) }
      if (label === "unit-16k-timeout-stale") { after.approvals = [approval("expired")]; after.interactiveDriver = timeoutStaleDriver(); after.events.push(approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }), approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, terminalizedAt: 301_000, buttonsRemoved: true }), event("telegram.update_dropped")) }
      if (label === "unit-16l-duplicate-callback") { after.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2, claimCount: 1 }]; after.restartAttempts = successfulRestart(); after.interactiveDriver = duplicateCallbackDriver(); after.events.push(...approvalEvidence("approve"), event("telegram.callback_settled"), event("telegram.callback_settled"), event("approval.acceptance_transition")) }
      if (label === "unit-16m-restart-continuation") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart(); after.interactiveDriver = restartContinuationDriver(); after.events.push(...approvalEvidence("approve"), { ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } }) }
      const assertions = deriveSanctuaryScenarioAssertions(label, before, after, 400_000)
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
    after.events = [{ ...event("senses.sanctuary_read_receipt"), meta: { toolName, success: true, resultDigest: "5".repeat(64), groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } }]
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
    after.events = [{ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_storage", success: true, resultDigest: "5".repeat(64), groundingDigest: factDigest, sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:09.000Z" } }]
    const drifted = { array: { ...storageGrounding.array, usedBytes: 8_100_000_000_000, freeBytes: 1_900_000_000_000, usedPercent: 81 }, shares: [], truncated: false }
    after.liveGrounding = { toolName: "unraid_get_storage", groundingDigest: groundingDigest(drifted), sourceIdentityDigest: groundingSource, observedAt: "1970-01-01T00:00:11.000Z", facts: drifted } as never
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toMatchObject({ accurate: true, liveFactsMatched: true })
    after.events = [{ ...after.events[0]!, meta: { ...after.events[0]!.meta, sourceIdentityDigest: "8".repeat(64) } }]
    expect(deriveSanctuaryScenarioAssertions("unit-16d-1-space", before, after, 400_000)).toBeNull()
    after.events = [{ ...after.events[0]!, meta: { ...after.events[0]!.meta, sourceIdentityDigest: groundingSource } }]
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
    expect(deriveSanctuaryScenarioAssertions("unit-16m-restart-continuation", before, after, 400_000)).toMatchObject({
      preAttemptResumed: true,
      checkpointEpochPreserved: true,
      continuationEpochAdvanced: true,
      butlerRestartObserved: true,
    })
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
    after.events.push(approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }), approvalAuditEvent("telegram.approval_prompt_terminalized", 301_000, { boundAt: 1_000, terminalizedAt: 301_000, buttonsRemoved: true }), event("telegram.update_dropped"))
    expect(deriveSanctuaryScenarioAssertions("unit-16k-timeout-stale", before, after, 400_000)).toMatchObject({ staleAcknowledged: true, mutationCount: 0 })
    after.interactiveDriver = { ...timeoutStaleDriver(), claimCount: 1 }
    expect(deriveSanctuaryScenarioAssertions("unit-16k-timeout-stale", before, after, 400_000)).toBeNull()
  })

  it("rejects every non-canonical restart action, target name, target id, and action digest", () => {
    const valid = base()
    valid.approvals = [approval("succeeded")]
    valid.restartAttempts = successfulRestart()
    valid.events = approvalEvidence("approve")
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
    after.events = approvalEvidence("approve", 1_000, 121_000)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), after, 400_000)).toMatchObject({ elapsedMs: 120_000, resumed: true })

    for (const eventName of ["senses.telegram_approval_prompt_bound", "telegram.callback_settled", "telegram.approval_prompt_terminalized", "senses.telegram_approval_continuation_delivered"]) {
      const missing = structuredClone(after)
      missing.events = missing.events.filter((entry) => entry.event !== eventName)
      expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), missing, 400_000), eventName).toBeNull()
    }
    const early = structuredClone(after)
    early.events = approvalEvidence("approve", 1_000, 120_999)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), early, 400_000)).toBeNull()
    const unacknowledged = structuredClone(after)
    unacknowledged.events = unacknowledged.events.map((entry) => entry.event === "telegram.callback_settled" ? { ...entry, meta: { ...entry.meta, acknowledged: false } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), unacknowledged, 400_000)).toBeNull()
    const reboundMessage = structuredClone(after)
    reboundMessage.events = reboundMessage.events.map((entry) => entry.event === "telegram.approval_prompt_terminalized"
      ? { ...entry, meta: { ...entry.meta, messageIdDigest: "9".repeat(64) } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), reboundMessage, 400_000)).toBeNull()
    const wrongResult = structuredClone(after)
    wrongResult.events = wrongResult.events.map((entry) => entry.event === "senses.telegram_approval_continuation_delivered"
      ? { ...entry, meta: { ...entry.meta, resultDigest: "9".repeat(64) } }
      : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16i-delayed-approval", base(), wrongResult, 400_000)).toBeNull()
  })

  it("requires identity-key provenance for every approval scenario", () => {
    for (const label of ["unit-15c-1-no-callback-terminalization", "unit-16i-delayed-approval", "unit-16j-denial", "unit-16k-timeout-stale", "unit-16l-duplicate-callback", "unit-16m-restart-continuation"] as const) {
      expect(SANCTUARY_SCENARIO_SOURCES[label]).toContain("identity-key")
    }
  })

  it("requires denial acknowledgement plus resumed delivery while proving no mutation", () => {
    const after = base()
    after.approvals = [approval("denied")]
    after.events = approvalEvidence("deny", 1_000, 2_000)
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", base(), after, 400_000)).toMatchObject({ mutationCount: 0, resumed: true })
    after.events = after.events.map((entry) => entry.event === "telegram.callback_settled" ? { ...entry, meta: { ...entry.meta, accepted: true, reason: "accepted" } } : entry)
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", base(), after, 400_000)).toBeNull()
  })

  it.each(["unit-15c-1-no-callback-terminalization", "unit-16k-timeout-stale"] as const)("bounds %s terminalization to the exact TTL plus one reconciliation interval", (label) => {
    const make = (terminalizedAt: number) => {
      const before = base()
      const after = base()
      after.approvals = [approval("expired")]
      after.approvals[0]!.updatedAt = terminalizedAt
      after.events = [
        approvalAuditEvent("senses.telegram_approval_prompt_bound", 1_000, { boundAt: 1_000 }),
        approvalAuditEvent("telegram.approval_prompt_terminalized", terminalizedAt, { boundAt: 1_000, terminalizedAt, buttonsRemoved: true }),
      ]
      if (label === "unit-15c-1-no-callback-terminalization") {
        before.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: probeDigest(after.sourceValues["telegram-offset"]), inboundEventCount: 0 }
      } else {
        after.interactiveDriver = timeoutStaleDriver()
        after.events.push(event("telegram.update_dropped"))
      }
      return { before, after }
    }
    for (const elapsed of [300_000, 301_000]) {
      const { before, after } = make(1_000 + elapsed)
      expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000), String(elapsed)).not.toBeNull()
    }
    const { before, after } = make(302_001)
    expect(deriveSanctuaryScenarioAssertions(label, before, after, 400_000)).toBeNull()
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
