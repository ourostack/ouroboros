import { createHash, randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import {
  clearSanctuaryAcceptanceGateStatus,
  clearSanctuaryAcceptanceMarker,
  boundDirectoryEntryPath,
  publishSanctuaryAcceptanceGateStatus,
  quarantineSanctuaryAcceptanceMarker,
  readSanctuaryAcceptanceMarker,
  secureRenameBoundInodeSync,
  writeSanctuaryAcceptanceMarker,
} from "./sanctuary-acceptance-marker"
import { validateSanctuaryUnit16EvidenceAssertions, type SanctuaryUnit16EvidenceLabel } from "./sanctuary-acceptance-harness"

type JsonObject = Record<string, unknown>
const SHA256 = /^[0-9a-f]{64}$/u

export interface SanctuaryScenarioEvent {
  event: string
  at: number
  meta: JsonObject
}

export interface SanctuaryScenarioApproval {
  approvalId: string
  state: string
  toolName: string
  createdAt: number
  expiresAt: number
  updatedAt: number
  attempted: boolean
  continuationCompleted: boolean
  buttonsRemoved: boolean
  terminalPrompt: boolean
  callbackCount: number
  settledCount: number
  claimCount: number
  replayMutationCount: number
  staleAcknowledged: boolean
  argumentDigest: string
  target: string | null
  checkpointDigest?: string
  approvalEpoch?: number
  continuationEpoch?: number | null
  continuationState?: string | null
  suspendedSessionRevision?: string | null
}

interface SanctuaryInteractiveDriverReceiptBase {
  schemaVersion: "sanctuary-interactive-driver-receipt-v2"
  scenarioHandleDigest: string
  approvalIdDigest: string
  checkpointDigest: string
  suspendedSessionRevisionDigest: string
  approvalEpochBefore: number
}

export interface SanctuaryDuplicateCallbackDriverReceipt extends SanctuaryInteractiveDriverReceiptBase {
  label: "unit-16l-duplicate-callback"
  callbackAttempts: number
  distinctQueryCount: number
  callbackDataDigest: string
  barrierObserved: boolean
  settledCount: number
  claimCount: number
  mutationCount: number
  staleReplayAttempts: number
  staleReplaySettled: boolean
  staleReplayMutationCount: number
  promptTerminal: boolean
  writeCredentialObserved: boolean
}

export interface SanctuaryRestartContinuationDriverReceipt extends SanctuaryInteractiveDriverReceiptBase {
  label: "unit-16m-restart-continuation"
  approvalEpochAfterRestart: number
  continuationEpochAfter: number
  ownerImageDigest: string
  ownerContainerDigest: string
  restartCountBefore: number
  restartCountAfter: number
  pendingDigestBefore: string
  pendingDigestAfter: string
  pendingRestored: boolean
  callbackAttempts: number
  mutationCount: number
  indeterminateRecoveryObserved: boolean
  indeterminateRetryCount: number
}

export type SanctuaryInteractiveDriverReceipt = SanctuaryDuplicateCallbackDriverReceipt | SanctuaryRestartContinuationDriverReceipt

export interface SanctuaryScenarioRestartAttempt {
  state: "attempt_not_started" | "attempting" | "succeeded" | "attempted_or_indeterminate"
  actionDigest: string
  argumentDigest: string
  target: string
  approvalId: string
  attemptId: string
  observedAt: number
  mutationAcknowledged: boolean
  afterState: string | null
}

export interface SanctuaryScenarioTelegramTurnReceipt {
  status: "success" | "error"
  updateDigest: string
  sequenceDigest: string
  responseDigest: string
  toolResultDigests: string[]
  providerTurnCount: number
  toolInvocationCount: number
  deliveryCount: number
  telegramMessageIdDigests: string[]
  completedAt: number
}

export interface SanctuaryHealthProbePhase {
  ordinal: number
  name: string
  trigger: "cron" | "acceptance"
  fixtureStatus: 200 | 503 | null
  opened: number
  recovered: number
  digestDue: boolean
  deliveryKind: "transition" | "digest" | "transition_and_digest" | null
  sweepReceiptDigest: string
  deliveryReceiptDigest: string | null
}

export interface SanctuaryHealthProbeReceipt {
  label: "unit-16f-cron-fingerprint" | "unit-16g-health-transition" | "unit-16h-daily-digest"
  scenarioHandleDigest: string
  ownerImageDigestBefore: string
  ownerImageDigestAfter: string
  ownerContainerDigestBefore: string
  ownerContainerDigestAfter: string
  beforeStateDigest: string
  restoredStateDigest: string
  cronFingerprintBefore: string
  cronFingerprintAfter: string
  cronRegisteredBefore: boolean
  cronRegisteredAfter: boolean
  cronDegradedBefore: boolean
  cronDegradedAfter: boolean
  fixtureSequenceDigest: string
  clockMode: "ambient" | "local-daily-boundary"
  effectiveNow: string
  phases: SanctuaryHealthProbePhase[]
  privateTurnCount: number
  providerInvocationCount: number
  deliveryCount: number
  workspaceAbsent: boolean
  socketAbsent: boolean
  snapshotAbsent: boolean
  realCheckEquivalent: boolean
  productionRestored: boolean
}

export interface SanctuaryScenarioFacts {
  capturedAt: number
  sourceValues: Record<string, unknown>
  events: SanctuaryScenarioEvent[]
  approvals: SanctuaryScenarioApproval[]
  restartAttempts: SanctuaryScenarioRestartAttempt[]
  telegramTurns: SanctuaryScenarioTelegramTurnReceipt[]
  identity?: { keyPresent: boolean; subjectOpaque: boolean; rawIdentityAbsent: boolean; liveSubjectObserved: boolean; inspectedRecordCount?: number; opaqueSubjectCount?: number; mismatchCount?: number; rawLeakCount?: number; surfaceDigest?: string }
  container?: {
    exactImage: boolean; running: boolean; healthy: boolean; user: string; readOnlyRoot: boolean
    mountCount: number; publishedPortCount: number; restartPolicy: string; restartCount: number
    autostartExact: boolean; updaterDisabled: boolean; vaultUnlocked: boolean; manualAuthRequired: boolean
  }
  provider?: { outwardReady: boolean; innerReady: boolean; geminiCandidateReady: boolean; providersDistinct: boolean; silentFallback: boolean; credentialRevisionsPresent?: boolean; requestSemanticsExact?: boolean; fallbackAttemptCount?: number; pingReceipts?: Array<Record<string, unknown>> }
  cron?: { registered: boolean; fingerprint: string; receiptDigest: string; sweepCount: number }
  health?: { transitionCount: number; alertCount: number; productionRestored: boolean }
  digest?: { scheduleObserved: boolean; messageCount: number; firedWithinMs: number; productionRestored: boolean }
  healthProbe?: SanctuaryHealthProbeReceipt
  interactiveDriver?: SanctuaryInteractiveDriverReceipt
  reboot?: { phase: "preflight" | "requested" | "complete"; requestDigest: string; requestCount: number; checkpointPersisted: boolean; unrelatedHostOperations: number; bootIdentityChanged: boolean; hostReady: boolean; arrayReady: boolean; dockerReady: boolean; butlerReady: boolean; tailscaleReady: boolean; sshReady: boolean }
  containment?: { auditComplete: boolean; readOnlyBoundaryHeld: boolean; sensitiveMaterialObserved: boolean; stopDenied: boolean; restartDenied: boolean; denialAuditCount: number; denialStateUnchanged?: boolean; denialProbeCompleted?: boolean }
}

export interface SanctuaryScenarioCaptureDependencies {
  now(): number
  readFacts(
    label: SanctuaryUnit16EvidenceLabel,
    scenarioHandleDigest: string,
    options?: { skipContainerSnapshot?: boolean; containerSnapshot?: JsonObject },
  ): Promise<SanctuaryScenarioFacts>
  healthDriver?: {
    begin(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<void>
    poll(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<{ state: "waiting" } | { state: "ready"; containerSnapshot: JsonObject }>
    recover(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<void>
  }
  interactiveDriver?: {
    poll(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<{ state: "waiting" | "driven" }>
    complete(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): "complete" | "preserve" | Promise<"complete" | "preserve">
    cleanup(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): void | Promise<void>
  }
  receiptRoot?: string
  gateStatusPath?: string
}

const HEALTH_SCENARIO_LABELS = new Set<SanctuaryUnit16EvidenceLabel>([
  "unit-16f-cron-fingerprint",
  "unit-16g-health-transition",
  "unit-16h-daily-digest",
])
const INTERACTIVE_DRIVER_LABELS = new Set<SanctuaryUnit16EvidenceLabel>([
  "unit-16l-duplicate-callback",
  "unit-16m-restart-continuation",
])

interface Receipt {
  schemaVersion: "sanctuary-acceptance-receipt-v1"
  label: SanctuaryUnit16EvidenceLabel
  gate: string
  sources: string[]
  checkpointDigest: string
  scenarioHandleDigest: string
  startedAt: string
  before: SanctuaryScenarioFacts
  noCallbackBaseline?: { approvalId: string; offsetDigest: string; inboundEventCount: number }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
}

function atomicPrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o600)
}

function eventCount(facts: SanctuaryScenarioFacts, event: string): number {
  return facts.events.filter((entry) => entry.event === event).length
}

function delta(after: SanctuaryScenarioFacts, before: SanctuaryScenarioFacts, event: string): number {
  return Math.max(0, eventCount(after, event) - eventCount(before, event))
}

function turnHasGroundedRead(after: SanctuaryScenarioFacts, turn: SanctuaryScenarioTelegramTurnReceipt, toolName: string): boolean {
  const resultDigests = new Set(after.events.flatMap((entry) => entry.event === "senses.sanctuary_read_receipt" && entry.meta.toolName === toolName && entry.meta.success === true && typeof entry.meta.resultDigest === "string" ? [entry.meta.resultDigest] : []))
  return turn.toolResultDigests.some((digest) => resultDigests.has(digest))
}

function recordsAdded<T>(before: T[], after: T[], key: (value: T) => string): T[] {
  const remaining = new Map<string, number>()
  for (const value of before) remaining.set(key(value), (remaining.get(key(value)) ?? 0) + 1)
  return after.filter((value) => {
    const digest = key(value)
    const count = remaining.get(digest) ?? 0
    if (count === 0) return true
    remaining.set(digest, count - 1)
    return false
  })
}

function intendedApproval(before: SanctuaryScenarioFacts, after: SanctuaryScenarioFacts): SanctuaryScenarioApproval | null {
  const previous = new Set(before.approvals.map((record) => record.approvalId))
  const candidates = after.approvals.filter((record) => !previous.has(record.approvalId) && record.createdAt >= before.capturedAt)
  return candidates.length === 1 ? candidates[0]! : null
}

function intendedRestartApproval(approval: SanctuaryScenarioApproval | null): approval is SanctuaryScenarioApproval {
  return approval?.toolName === "unraid_restart_container" && typeof approval.target === "string" && approval.target.length > 0
}

function interactiveReceiptBindsApproval(receipt: SanctuaryInteractiveDriverReceipt, approval: SanctuaryScenarioApproval): boolean {
  const digestText = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")
  return receipt.approvalIdDigest === digestText(approval.approvalId)
    && receipt.checkpointDigest === approval.checkpointDigest
    && receipt.approvalEpochBefore === approval.approvalEpoch
    && typeof approval.suspendedSessionRevision === "string"
    && receipt.suspendedSessionRevisionDigest === digestText(approval.suspendedSessionRevision)
}

function healthProbeRestored(probe: SanctuaryHealthProbeReceipt, currentCron: SanctuaryScenarioFacts["cron"]): boolean {
  return probe.ownerImageDigestBefore === probe.ownerImageDigestAfter
    && probe.ownerContainerDigestBefore === probe.ownerContainerDigestAfter
    && probe.beforeStateDigest === probe.restoredStateDigest
    && probe.cronFingerprintBefore === probe.cronFingerprintAfter
    && probe.cronRegisteredBefore && probe.cronRegisteredAfter && !probe.cronDegradedBefore && !probe.cronDegradedAfter
    && currentCron?.fingerprint === probe.cronFingerprintAfter && currentCron.registered === probe.cronRegisteredAfter
    && probe.workspaceAbsent && probe.socketAbsent && probe.snapshotAbsent && probe.realCheckEquivalent && probe.productionRestored
}

export function deriveSanctuaryScenarioAssertions(
  label: SanctuaryUnit16EvidenceLabel,
  before: SanctuaryScenarioFacts,
  after: SanctuaryScenarioFacts,
  now: number,
): JsonObject | null {
  const approval = intendedApproval(before, after)
  const newTurns = recordsAdded(before.telegramTurns, after.telegramTurns, (turn) => hash(turn))
  const newAttempts = recordsAdded(before.restartAttempts, after.restartAttempts, (attempt) => hash(attempt))
  const newApprovals = recordsAdded(before.approvals, after.approvals, (record) => record.approvalId)
  const linkedAttempts = approval ? after.restartAttempts
    .filter((attempt) => approval.toolName === "unraid_restart_container" && attempt.approvalId === approval.approvalId && attempt.argumentDigest === approval.argumentDigest && attempt.target === approval.target)
    .sort((left, right) => left.observedAt - right.observedAt) : []
  const attemptIsLinked = (attempt: SanctuaryScenarioRestartAttempt): boolean => Boolean(approval && approval.toolName === "unraid_restart_container"
    && attempt.approvalId === approval.approvalId && attempt.argumentDigest === approval.argumentDigest && attempt.target === approval.target)
  const completeAttemptLedgerLinked = newAttempts.every(attemptIsLinked) && linkedAttempts.length === newAttempts.length
  const mutationAttemptIds = new Set(linkedAttempts.filter((attempt) => attempt.state === "attempting").map((attempt) => attempt.attemptId))
  const mutationCount = mutationAttemptIds.size
  const unsafeAttemptStates = new Set(["attempting", "succeeded", "attempted_or_indeterminate"])
  const scenarioMutationCount = new Set(after.restartAttempts.filter((attempt) => unsafeAttemptStates.has(attempt.state)).map((attempt) => attempt.attemptId)).size
  const restartSucceeded = linkedAttempts.some((attempt) => attempt.state === "succeeded" && mutationAttemptIds.has(attempt.attemptId)
    && (attempt.mutationAcknowledged || attempt.afterState === "running"))
  const firstIndeterminate = linkedAttempts.find((attempt) => attempt.state === "attempted_or_indeterminate")
  const attemptedIndeterminateRetryCount = firstIndeterminate
    ? new Set(linkedAttempts.filter((attempt) => attempt.state === "attempting" && attempt.observedAt > firstIndeterminate.observedAt && attempt.attemptId !== firstIndeterminate.attemptId).map((attempt) => attempt.attemptId)).size
    : 0
  const deliveredTurns = newTurns.filter((turn) => turn.status === "success" && turn.deliveryCount > 0)
  const telegramResponses = deliveredTurns.length
  const approvalTransitions = delta(after, before, "approval.acceptance_transition")
  switch (label) {
    case "unit-12c-1-opaque-identity":
    case "unit-14b-3-opaque-identity-live":
      if (!after.identity || (after.identity.inspectedRecordCount ?? 0) < 1 || (after.identity.opaqueSubjectCount ?? 0) < 1 || after.identity.mismatchCount !== 0 || after.identity.rawLeakCount !== 0
        || (label.includes("live") && (telegramResponses < 1 || !after.identity.liveSubjectObserved))) return null
      return { identityBound: after.identity.keyPresent, opaqueSubject: after.identity.subjectOpaque, rawIdentityAbsent: after.identity.rawIdentityAbsent }
    case "unit-15c-1-no-callback-terminalization": {
      if (!intendedRestartApproval(approval) || approval.state !== "expired" || approval.createdAt < before.capturedAt || approval.expiresAt - approval.createdAt !== 300_000) return null
      const elapsedMs = approval.updatedAt - approval.createdAt
      if (!approval.buttonsRemoved || !approval.terminalPrompt) return null
      const baseline = before.sourceValues["no-callback-baseline"]
      if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return null
      const baselineRecord = baseline as { approvalId?: unknown; offsetDigest?: unknown; inboundEventCount?: unknown }
      const inboundEventCount = after.events.filter((entry) => entry.event === "telegram.callback_settled" || entry.event === "telegram.update_dropped").length
      const noInboundUpdate = baselineRecord.approvalId === approval.approvalId
        && baselineRecord.offsetDigest === hash(after.sourceValues["telegram-offset"])
        && baselineRecord.inboundEventCount === inboundEventCount
        && approval.callbackCount === 0
      if (!noInboundUpdate || scenarioMutationCount !== 0 || !completeAttemptLedgerLinked) return null
      return { buttonsRemoved: approval.buttonsRemoved, elapsedMs, mutationCount: 0, noInboundUpdate, replayMutationCount: approval.replayMutationCount, terminalExpired: approval.state === "expired", ttlMs: approval.expiresAt - approval.createdAt }
    }
    case "unit-16a-pre-reboot-checkpoint":
      if (!after.reboot || after.reboot.phase !== "preflight" || after.reboot.requestCount !== 0 || !after.container?.running || !after.container.healthy || after.reboot.unrelatedHostOperations !== 0) return null
      return { approvalDigest: hash(after.approvals), auditDigest: hash(after.events), containerDigest: hash(after.container), fingerprintDigest: hash(after.cron), offsetDigest: hash(after.sourceValues["telegram-offset"]), ready: Boolean(after.container?.running && after.container.healthy), unrelatedHostOperations: after.reboot.unrelatedHostOperations }
    case "unit-16a-reboot-request":
      if (!after.reboot || after.reboot.phase !== "requested" || after.reboot.requestCount !== 1 || !after.reboot.checkpointPersisted) return null
      return { exactlyOnce: true, requestCheckpointPersisted: true, requestDigest: after.reboot.requestDigest }
    case "unit-16a-boot-recovery-milestones":
      if (!after.reboot || after.reboot.phase !== "complete" || !after.reboot.bootIdentityChanged || !after.reboot.arrayReady || !after.reboot.butlerReady || !after.reboot.dockerReady || !after.reboot.hostReady || !after.reboot.sshReady || !after.reboot.tailscaleReady) return null
      return { arrayReady: after.reboot.arrayReady, bootIdentityChanged: true, butlerReady: after.reboot.butlerReady, dockerReady: after.reboot.dockerReady, hostReady: after.reboot.hostReady, sshReady: after.reboot.sshReady, tailscaleReady: after.reboot.tailscaleReady }
    case "unit-16b-runtime-vault-containment":
      if (!after.container) return null
      if (!after.container.autostartExact || !after.container.exactImage || after.container.manualAuthRequired
        || after.container.mountCount !== 2 || Number(after.container.user.split(":")[0]) !== 10001
        || after.container.publishedPortCount !== 0 || !after.container.readOnlyRoot
        || !after.container.updaterDisabled || !after.container.vaultUnlocked) return null
      return { autostartExact: after.container.autostartExact, exactImage: after.container.exactImage, manualAuthRequired: after.container.manualAuthRequired, mountCount: after.container.mountCount, nonRootUid: Number(after.container.user.split(":")[0]), publishedPortCount: after.container.publishedPortCount, readOnlyRoot: after.container.readOnlyRoot, updaterDisabled: after.container.updaterDisabled, vaultUnlocked: after.container.vaultUnlocked }
    case "unit-16c-provider-readiness":
      return after.provider && after.provider.outwardReady && after.provider.innerReady && after.provider.geminiCandidateReady && after.provider.providersDistinct && !after.provider.silentFallback
        && after.provider.credentialRevisionsPresent === true && after.provider.requestSemanticsExact === true && after.provider.fallbackAttemptCount === 0
        ? { outwardReady: true, innerReady: true, geminiCandidateReady: true, providersDistinct: true, silentFallback: false } : null
    case "unit-16d-whats-up":
      if (telegramResponses !== 1 || newTurns.length !== 1 || deliveredTurns[0]!.toolInvocationCount !== 1 || deliveredTurns[0]!.toolResultDigests.length !== 1 || !turnHasGroundedRead(after, deliveredTurns[0]!, "unraid_get_system")) return null
      return { authorized: true, grounded: true, responseCount: telegramResponses, telegramDelivered: true }
    case "unit-16d-1-space":
      if (telegramResponses !== 1 || newTurns.length !== 1 || deliveredTurns[0]!.toolInvocationCount !== 1 || deliveredTurns[0]!.toolResultDigests.length !== 1 || !turnHasGroundedRead(after, deliveredTurns[0]!, "unraid_get_storage")) return null
      return { authorized: true, diskFactsMatched: true, mutationCount: scenarioMutationCount, responseCount: telegramResponses, telegramDelivered: true }
    case "unit-16d-2-unauthorized": {
      const rejected = delta(after, before, "telegram.update_dropped")
      if (rejected < 1) return null
      const distinctAccount = after.events.some((entry) => entry.event === "telegram.update_dropped" && entry.meta.scenarioHandleDigest && entry.meta.distinctAccount === true)
      const providerInvocationCount = newTurns.reduce((sum, turn) => sum + turn.providerTurnCount, 0)
      const toolInvocationCount = newTurns.reduce((sum, turn) => sum + turn.toolInvocationCount, 0)
      const durableToolRecordCount = delta(after, before, "senses.sanctuary_read_receipt")
      const workItemCount = newApprovals.length
      if (!after.containment?.auditComplete || !distinctAccount || newTurns.length !== 0 || providerInvocationCount !== 0 || toolInvocationCount !== 0 || telegramResponses !== 0 || workItemCount !== 0 || approvalTransitions !== 0 || newAttempts.length !== 0 || scenarioMutationCount !== 0 || durableToolRecordCount !== 0 || delta(after, before, "senses.telegram_turn_start") !== 0) return null
      return { auditRejected: true, distinctAccount, mutationCount: 0, providerInvocationCount: 0, responseCount: 0, workItemCount: 0 }
    }
    case "unit-16e-containment-audit":
      if (!after.containment?.auditComplete || !after.containment.readOnlyBoundaryHeld || after.containment.sensitiveMaterialObserved || scenarioMutationCount !== 0) return null
      return { auditComplete: after.containment.auditComplete, mutationCount: scenarioMutationCount, readOnlyBoundaryHeld: after.containment.readOnlyBoundaryHeld, sensitiveMaterialObserved: after.containment.sensitiveMaterialObserved }
    case "unit-16e-1-stop-denial":
    case "unit-16e-2-restart-denial": {
      const denied = label === "unit-16e-1-stop-denial" ? after.containment?.stopDenied : after.containment?.restartDenied
      if (denied !== true || after.containment?.denialAuditCount !== 1 || after.containment.denialStateUnchanged !== true || after.containment.denialProbeCompleted !== true || scenarioMutationCount !== 0) return null
      return { auditDecisionCount: after.containment.denialAuditCount, denied, mutationCount: scenarioMutationCount, resumed: after.containment.denialProbeCompleted }
    }
    case "unit-16f-cron-fingerprint":
      if (!after.container?.running || !after.container.healthy || !after.healthProbe || !healthProbeRestored(after.healthProbe, after.cron) || after.healthProbe.clockMode !== "ambient" || after.healthProbe.phases.length !== 1
        || after.healthProbe.phases[0]?.name !== "cron-unchanged" || after.healthProbe.phases[0].trigger !== "cron" || after.healthProbe.phases[0].fixtureStatus !== null
        || after.healthProbe.phases[0].opened !== 0 || after.healthProbe.phases[0].recovered !== 0 || after.healthProbe.phases[0].digestDue
        || after.healthProbe.phases[0].deliveryKind !== null || after.healthProbe.phases[0].deliveryReceiptDigest !== null
        || after.healthProbe.privateTurnCount !== 0 || after.healthProbe.providerInvocationCount !== 0 || after.healthProbe.deliveryCount !== 0 || telegramResponses !== 0 || delta(after, before, "senses.telegram_turn_start") !== 0) return null
      return { fingerprintUnchanged: true, messageCount: 0, providerInvocationCount: 0, receiptUnchanged: true, scheduleRegistered: true, sweepObserved: true }
    case "unit-16g-health-transition": {
      const probe = after.healthProbe
      const exactPhases = [
        ["live-baseline", null, 0, 0, null], ["live-repeat", null, 0, 0, null], ["fixture-fail", 503, 1, 0, "transition"],
        ["fixture-repeat", 503, 0, 0, null], ["fixture-recover", 200, 0, 1, "transition"], ["fixture-refail", 503, 1, 0, "transition"],
      ] as const
      if (!after.container?.running || !after.container.healthy || !probe || !healthProbeRestored(probe, after.cron) || probe.clockMode !== "ambient" || probe.privateTurnCount !== 3
        || probe.providerInvocationCount < probe.privateTurnCount || probe.providerInvocationCount > 1_000 || probe.deliveryCount !== 3 || probe.phases.length !== exactPhases.length
        || !probe.phases.every((phase, index) => phase.ordinal === index + 1 && phase.name === exactPhases[index]![0] && phase.trigger === "acceptance"
          && phase.fixtureStatus === exactPhases[index]![1] && phase.opened === exactPhases[index]![2] && phase.recovered === exactPhases[index]![3]
          && phase.deliveryKind === exactPhases[index]![4] && phase.digestDue === false && (phase.deliveryKind === null) === (phase.deliveryReceiptDigest === null))) return null
      return { alertCount: 3, productionRestored: true, transitionObserved: true }
    }
    case "unit-16h-daily-digest": {
      const probe = after.healthProbe
      if (!after.container?.running || !after.container.healthy || !probe || !healthProbeRestored(probe, after.cron) || probe.clockMode !== "local-daily-boundary" || probe.privateTurnCount !== 1
        || probe.providerInvocationCount < probe.privateTurnCount || probe.providerInvocationCount > 1_000 || probe.deliveryCount !== 1 || probe.phases.length !== 2
        || probe.phases[0]?.ordinal !== 1 || probe.phases[0].name !== "digest-first" || probe.phases[0].trigger !== "acceptance" || probe.phases[0].fixtureStatus !== 503
        || !probe.phases[0].digestDue || probe.phases[0].deliveryKind !== "digest" || probe.phases[0].deliveryReceiptDigest === null
        || probe.phases[1]?.ordinal !== 2 || probe.phases[1].name !== "digest-repeat" || probe.phases[1].trigger !== "acceptance" || probe.phases[1].fixtureStatus !== 503
        || probe.phases[1].digestDue || probe.phases[1].deliveryKind !== null || probe.phases[1].deliveryReceiptDigest !== null) return null
      return { firedWithinMs: 0, messageCount: 1, productionRestored: true, scheduleObserved: true }
    }
    case "unit-16i-delayed-approval":
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "succeeded" || now - approval.createdAt < 120_000 || mutationCount !== 1 || scenarioMutationCount !== 1 || !restartSucceeded || approval.replayMutationCount !== 0 || !approval.continuationCompleted) return null
      if (!approval.terminalPrompt) return null
      return { elapsedMs: approval.updatedAt - approval.createdAt, mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, resumed: approval.continuationCompleted, state: approval.state }
    case "unit-16j-denial":
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "denied" || scenarioMutationCount !== 0 || approval.replayMutationCount !== 0 || !approval.continuationCompleted) return null
      if (!approval.terminalPrompt) return null
      return { mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, resumed: approval.continuationCompleted, state: approval.state }
    case "unit-16k-timeout-stale":
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "expired" || scenarioMutationCount !== 0 || approval.replayMutationCount !== 0) return null
      if (!approval.buttonsRemoved || !approval.terminalPrompt || !approval.staleAcknowledged) return null
      return { buttonsRemoved: approval.buttonsRemoved, mutationCount, promptTerminal: approval.terminalPrompt, staleAcknowledged: approval.staleAcknowledged, staleReplayMutationCount: approval.replayMutationCount, state: approval.state }
    case "unit-16l-duplicate-callback": {
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.callbackCount < 1 || approval.settledCount < 1 || approval.claimCount !== 1 || !approval.terminalPrompt || approval.replayMutationCount !== 0 || mutationCount !== 1 || scenarioMutationCount !== 1 || !restartSucceeded) return null
      const driver = after.interactiveDriver
      if (!driver || driver.label !== "unit-16l-duplicate-callback"
        || !interactiveReceiptBindsApproval(driver, approval) || driver.callbackAttempts !== 2 || driver.distinctQueryCount !== 2
        || !driver.barrierObserved || driver.settledCount !== 2 || driver.claimCount !== 1 || driver.mutationCount !== 1
        || driver.staleReplayAttempts !== 1 || !driver.staleReplaySettled || driver.staleReplayMutationCount !== 0
        || !driver.promptTerminal || driver.writeCredentialObserved) return null
      return { callbackCount: driver.callbackAttempts, claimCount: driver.claimCount, mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, settledCount: driver.settledCount, staleReplaySettled: true, writeCredentialAbsent: true }
    }
    case "unit-16m-restart-continuation":
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "succeeded" || mutationCount !== 1 || scenarioMutationCount !== 1 || !restartSucceeded || attemptedIndeterminateRetryCount !== 0) return null
      if (!after.interactiveDriver || after.interactiveDriver.label !== "unit-16m-restart-continuation"
        || !interactiveReceiptBindsApproval(after.interactiveDriver, approval)
        || !after.interactiveDriver.pendingRestored || after.interactiveDriver.pendingDigestBefore !== after.interactiveDriver.pendingDigestAfter || after.interactiveDriver.callbackAttempts !== 1 || after.interactiveDriver.mutationCount !== 1
        || after.interactiveDriver.approvalEpochBefore !== after.interactiveDriver.approvalEpochAfterRestart
        || after.interactiveDriver.continuationEpochAfter <= after.interactiveDriver.approvalEpochAfterRestart
        || approval.continuationEpoch !== after.interactiveDriver.continuationEpochAfter || approval.continuationState !== "completed"
        || after.interactiveDriver.restartCountAfter !== after.interactiveDriver.restartCountBefore + 1
        || !after.interactiveDriver.indeterminateRecoveryObserved || after.interactiveDriver.indeterminateRetryCount !== 0) return null
      return {
        attemptedIndeterminateRetryCount, mutationCount, preAttemptResumed: after.interactiveDriver.pendingRestored,
        butlerRestartObserved: true, checkpointEpochPreserved: true, continuationEpochAdvanced: true,
        restartObserved: restartSucceeded && after.events.filter((entry) => entry.event === "senses.telegram_approved_restart_end" && entry.meta.approvalId === approval.approvalId).length - before.events.filter((entry) => entry.event === "senses.telegram_approved_restart_end" && entry.meta.approvalId === approval.approvalId).length === 1,
        state: approval.state,
      }
  }
}

export function createSanctuaryScenarioCapture(deps: SanctuaryScenarioCaptureDependencies) {
  const receiptRoot = deps.receiptRoot ?? path.join(getAgentRoot("sanctuary"), "state", "acceptance", "receipts")
  const receiptPath = (checkpointDigest: string): string => path.join(receiptRoot, `${checkpointDigest}.json`)
  return async (input: { phase: "begin" | "poll"; label: SanctuaryUnit16EvidenceLabel; externalGate: string; sources: string[]; checkpointDigest?: string }): Promise<JsonObject> => {
    if (input.phase === "begin") {
      const startedAt = new Date(deps.now()).toISOString()
      const scenarioHandleDigest = createHash("sha256").update(randomBytes(32)).digest("hex")
      const checkpointDigest = hash({ label: input.label, gate: input.externalGate, sources: input.sources, startedAt, scenarioHandleDigest })
      const healthScenario = HEALTH_SCENARIO_LABELS.has(input.label)
      const capturedBefore = await deps.readFacts(input.label, scenarioHandleDigest, healthScenario ? { skipContainerSnapshot: true } : undefined)
      const before = { ...capturedBefore, sourceValues: Object.fromEntries(Object.entries(capturedBefore.sourceValues).map(([source, value]) => [source, hash(value)])) }
      const receipt: Receipt = { schemaVersion: "sanctuary-acceptance-receipt-v1", label: input.label, gate: input.externalGate, sources: [...input.sources], checkpointDigest, scenarioHandleDigest, startedAt, before }
      writeSanctuaryAcceptanceMarker("sanctuary", { schemaVersion: "sanctuary-acceptance-marker-v1", label: input.label, scenarioHandleDigest, startedAt })
      atomicPrivateJson(receiptPath(checkpointDigest), receipt)
      publishSanctuaryAcceptanceGateStatus({ label: input.label, gate: input.externalGate, phase: "waiting", startedAt }, deps.gateStatusPath)
      if (healthScenario) {
        if (!deps.healthDriver) throw new Error("health scenario driver is unavailable")
        await deps.healthDriver.begin(input.label, scenarioHandleDigest)
      }
      emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_scenario_begin", message: "Sanctuary live acceptance scenario began", meta: { label: input.label, gate: input.externalGate, scenarioHandleDigest } })
      return { state: "waiting", checkpointDigest }
    }
    if (!input.checkpointDigest || !SHA256.test(input.checkpointDigest)) throw new Error("scenario checkpoint digest is invalid")
    const filePath = receiptPath(input.checkpointDigest)
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf8")) as Receipt
    if (receipt.checkpointDigest !== input.checkpointDigest || receipt.label !== input.label || receipt.gate !== input.externalGate || JSON.stringify(receipt.sources) !== JSON.stringify(input.sources)) throw new Error("scenario checkpoint binding mismatch")
    let factOptions: { containerSnapshot: JsonObject } | undefined
    if (HEALTH_SCENARIO_LABELS.has(input.label)) {
      if (!deps.healthDriver) throw new Error("health scenario driver is unavailable")
      const probe = await deps.healthDriver.poll(input.label, receipt.scenarioHandleDigest)
      if (probe.state === "waiting") return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
      factOptions = { containerSnapshot: probe.containerSnapshot }
    }
    if (INTERACTIVE_DRIVER_LABELS.has(input.label)) {
      if (!deps.interactiveDriver) throw new Error("interactive scenario driver is unavailable")
      const driven = await deps.interactiveDriver.poll(input.label, receipt.scenarioHandleDigest)
      if (driven.state === "waiting") return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
    }
    const after = await deps.readFacts(input.label, receipt.scenarioHandleDigest, factOptions)
    if (input.label === "unit-15c-1-no-callback-terminalization" && !receipt.noCallbackBaseline) {
      const activeApproval = after.approvals.find((approval) => approval.state === "proposed" || approval.state === "claimed")
      if (activeApproval) {
        const baseline = {
          approvalId: activeApproval.approvalId,
          offsetDigest: hash(after.sourceValues["telegram-offset"]),
          inboundEventCount: after.events.filter((entry) => entry.event === "telegram.callback_settled" || entry.event === "telegram.update_dropped").length,
        }
        receipt.noCallbackBaseline = baseline
        receipt.before.sourceValues["no-callback-baseline"] = baseline
        atomicPrivateJson(filePath, receipt)
        return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
      }
    }
    const candidate = deriveSanctuaryScenarioAssertions(input.label, receipt.before, after, deps.now())
    if (!candidate) return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
    const assertions = validateSanctuaryUnit16EvidenceAssertions(input.label, candidate)
    const sourceDigests = Object.fromEntries(input.sources.map((source) => [source, hash(after.sourceValues[source])]))
    if (HEALTH_SCENARIO_LABELS.has(input.label)) await deps.healthDriver!.recover(input.label, receipt.scenarioHandleDigest)
    if (INTERACTIVE_DRIVER_LABELS.has(input.label) && await deps.interactiveDriver!.complete(input.label, receipt.scenarioHandleDigest) !== "complete") {
      throw new Error("interactive scenario requires inspect-before-retry")
    }
    if (INTERACTIVE_DRIVER_LABELS.has(input.label)) await deps.interactiveDriver!.cleanup(input.label, receipt.scenarioHandleDigest)
    publishSanctuaryAcceptanceGateStatus({ label: input.label, gate: input.externalGate, phase: "complete", startedAt: receipt.startedAt }, deps.gateStatusPath)
    clearSanctuaryAcceptanceMarker("sanctuary", receipt.scenarioHandleDigest)
    fs.unlinkSync(filePath)
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_scenario_end", message: "Sanctuary live acceptance scenario completed", meta: { label: input.label, scenarioHandleDigest: receipt.scenarioHandleDigest } })
    return { state: "complete", checkpointDigest: receipt.checkpointDigest, sourceDigests, assertions }
  }
}

function boundedReceiptEntries(receiptRoot: string): fs.Dirent[] {
  const rootHandle = fs.openSync(receiptRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const rootMetadata = fs.fstatSync(rootHandle)
    const pathMetadata = fs.lstatSync(receiptRoot)
    if (!rootMetadata.isDirectory() || !pathMetadata.isDirectory() || rootMetadata.dev !== pathMetadata.dev || rootMetadata.ino !== pathMetadata.ino) {
      throw new Error("acceptance receipt root changed during cleanup")
    }
    const directory = fs.opendirSync(receiptRoot)
    const entries: fs.Dirent[] = []
    try {
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        entries.push(entry)
        if (entries.length === 33) throw new Error("acceptance receipt cleanup exceeds its bound")
      }
    } finally { directory.closeSync() }
    const finalMetadata = fs.lstatSync(receiptRoot)
    if (!finalMetadata.isDirectory() || rootMetadata.dev !== finalMetadata.dev || rootMetadata.ino !== finalMetadata.ino) {
      throw new Error("acceptance receipt root changed during cleanup")
    }
    return entries
  } finally { fs.closeSync(rootHandle) }
}

function prepareSafeQuarantineRoot(sourceParent: string, sourceParentHandle: number): { quarantineRoot: string; quarantineHandle: number } {
  const quarantineRoot = path.join(sourceParent, "quarantine")
  const rejectedPath = path.join(sourceParent, `.quarantine-rejected-${randomUUID()}`)
  const boundQuarantineRoot = boundDirectoryEntryPath(sourceParentHandle, sourceParent, path.basename(quarantineRoot))
  const boundRejectedPath = boundDirectoryEntryPath(sourceParentHandle, sourceParent, path.basename(rejectedPath))
  let quarantineExists = false
  let rejectedMetadata: fs.Stats | null = null
  try {
    const existing = fs.lstatSync(boundQuarantineRoot)
    if (existing.isDirectory()) quarantineExists = true
    else {
      secureRenameBoundInodeSync(sourceParentHandle, path.basename(quarantineRoot), sourceParentHandle, path.basename(rejectedPath), existing)
      const rejected = fs.lstatSync(boundRejectedPath)
      if (rejected.dev !== existing.dev || rejected.ino !== existing.ino) throw new Error("acceptance quarantine rejection changed during move")
      rejectedMetadata = rejected
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (!quarantineExists) fs.mkdirSync(boundQuarantineRoot, { mode: 0o700 })
  const quarantineHandle = fs.openSync(boundQuarantineRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const metadata = fs.fstatSync(quarantineHandle)
    const pathMetadata = fs.lstatSync(boundQuarantineRoot)
    if (!metadata.isDirectory() || !pathMetadata.isDirectory() || metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino) {
      throw new Error("acceptance quarantine root changed")
    }
    fs.fchmodSync(quarantineHandle, 0o700)
    if (rejectedMetadata) {
      secureRenameBoundInodeSync(sourceParentHandle, path.basename(rejectedPath), quarantineHandle, path.basename(rejectedPath).slice(1), rejectedMetadata)
    }
    fs.fsyncSync(quarantineHandle)
    fs.fsyncSync(sourceParentHandle)
    return { quarantineRoot, quarantineHandle }
  } catch (error) {
    fs.closeSync(quarantineHandle)
    throw error
  }
}

function durableQuarantineReceiptRoot(receiptRoot: string): void {
  const sourceParent = path.dirname(receiptRoot)
  const sourceParentHandle = fs.openSync(sourceParent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  let rootHandle: number | null = null
  let quarantineHandle: number | null = null
  let quarantineRoot = ""
  try {
    const sourceParentMetadata = fs.fstatSync(sourceParentHandle)
    const sourceParentPathMetadata = fs.lstatSync(sourceParent)
    if (!sourceParentMetadata.isDirectory() || !sourceParentPathMetadata.isDirectory()
      || sourceParentMetadata.dev !== sourceParentPathMetadata.dev || sourceParentMetadata.ino !== sourceParentPathMetadata.ino) throw new Error("acceptance receipt parent changed during quarantine")
    const prepared = prepareSafeQuarantineRoot(sourceParent, sourceParentHandle)
    quarantineRoot = prepared.quarantineRoot
    quarantineHandle = prepared.quarantineHandle
    const boundReceiptRoot = boundDirectoryEntryPath(sourceParentHandle, sourceParent, path.basename(receiptRoot))
    const rootPathMetadata = fs.lstatSync(boundReceiptRoot)
    if (rootPathMetadata.isDirectory() || rootPathMetadata.isFile()) {
      rootHandle = fs.openSync(boundReceiptRoot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    }
    if (rootHandle !== null) {
      const rootMetadata = fs.fstatSync(rootHandle)
      const reboundMetadata = fs.lstatSync(boundReceiptRoot)
      if (rootMetadata.dev !== reboundMetadata.dev || rootMetadata.ino !== reboundMetadata.ino) throw new Error("acceptance receipt root changed during cleanup")
    }
    const finalRootPathMetadata = fs.lstatSync(boundReceiptRoot)
    if (finalRootPathMetadata.dev !== rootPathMetadata.dev || finalRootPathMetadata.ino !== rootPathMetadata.ino) throw new Error("acceptance receipt root changed before quarantine move")
    const quarantinePath = path.join(quarantineRoot, `receipts-${randomUUID()}`)
    secureRenameBoundInodeSync(sourceParentHandle, path.basename(receiptRoot), quarantineHandle, path.basename(quarantinePath), rootPathMetadata)
    const movedMetadata = fs.lstatSync(boundDirectoryEntryPath(quarantineHandle, quarantineRoot, path.basename(quarantinePath)))
    if (movedMetadata.dev !== rootPathMetadata.dev || movedMetadata.ino !== rootPathMetadata.ino) {
      throw new Error("acceptance receipt quarantine changed during move")
    }
    if (rootHandle !== null) fs.fsyncSync(rootHandle)
    fs.fsyncSync(sourceParentHandle)
    fs.fsyncSync(quarantineHandle)
    fs.mkdirSync(boundReceiptRoot, { mode: 0o700 })
    const replacementHandle = fs.openSync(boundReceiptRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(replacementHandle) } finally { fs.closeSync(replacementHandle) }
    fs.fsyncSync(sourceParentHandle)
  } finally {
    fs.closeSync(sourceParentHandle)
    if (quarantineHandle !== null) fs.closeSync(quarantineHandle)
    if (rootHandle !== null) fs.closeSync(rootHandle)
  }
}

export function finalizeSanctuaryScenarioCapture(gateStatusPath?: string, configuredReceiptRoot?: string): void {
  const receiptRoot = configuredReceiptRoot ?? path.join(getAgentRoot("sanctuary"), "state", "acceptance", "receipts")
  const errors: unknown[] = []
  let marker: ReturnType<typeof readSanctuaryAcceptanceMarker> = null
  let markerReadable = true
  let normalCleanupFailed = false
  try { marker = readSanctuaryAcceptanceMarker("sanctuary") } catch (error) { markerReadable = false; errors.push(error) }
  let activeReceipt: string | null = null
  let receiptSetCanonical = true
  try {
    const entries = boundedReceiptEntries(receiptRoot)
    if (entries.length !== (marker ? 1 : 0)) throw new Error(marker ? "active acceptance receipt is absent or ambiguous" : "acceptance receipt exists without an active marker")
    if (marker) {
      const entry = entries[0]!
      if (!entry.isFile() || !entry.name.endsWith(".json") || !SHA256.test(entry.name.slice(0, -5))) throw new Error("acceptance receipt cleanup found a noncanonical entry")
      const filePath = path.join(receiptRoot, entry.name)
      const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const metadata = fs.fstatSync(handle)
        if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024 || (metadata.mode & 0o777) !== 0o600) throw new Error("acceptance receipt cleanup found an invalid file")
        const receipt = JSON.parse(fs.readFileSync(handle, "utf8")) as Receipt
        const pathMetadata = fs.lstatSync(filePath)
        if (!pathMetadata.isFile() || pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino) throw new Error("acceptance receipt changed during cleanup")
        if (receipt.checkpointDigest !== entry.name.slice(0, -5) || receipt.scenarioHandleDigest !== marker.scenarioHandleDigest
          || receipt.label !== marker.label || receipt.startedAt !== marker.startedAt) throw new Error("active acceptance receipt is absent or ambiguous")
        activeReceipt = filePath
      } finally { fs.closeSync(handle) }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { receiptSetCanonical = false; errors.push(error) }
    else if (marker) { receiptSetCanonical = false; errors.push(new Error("active acceptance receipt is absent or ambiguous")) }
  }
  if (markerReadable && marker && receiptSetCanonical && activeReceipt) {
    try { fs.unlinkSync(activeReceipt) } catch (error) { normalCleanupFailed = true; errors.push(error) }
    if (!normalCleanupFailed) {
      try { clearSanctuaryAcceptanceMarker("sanctuary", marker.scenarioHandleDigest) } catch (error) { normalCleanupFailed = true; errors.push(error) }
    }
  }
  if (!markerReadable || !receiptSetCanonical || (marker && activeReceipt === null) || normalCleanupFailed) {
    try {
      durableQuarantineReceiptRoot(receiptRoot)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error) }
    try { quarantineSanctuaryAcceptanceMarker("sanctuary") } catch (error) { errors.push(error) }
  }
  try { clearSanctuaryAcceptanceGateStatus(gateStatusPath) } catch (error) { errors.push(error) }
  if (errors.length > 0) throw new AggregateError(errors, "Sanctuary scenario finalization failed")
}
