import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import {
  clearSanctuaryAcceptanceGateStatus,
  clearSanctuaryAcceptanceMarker,
  publishSanctuaryAcceptanceGateStatus,
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
}

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
  reboot?: { requestDigest: string; requestCount: number; checkpointPersisted: boolean; unrelatedHostOperations: number; bootIdentityChanged: boolean; hostReady: boolean; arrayReady: boolean; dockerReady: boolean; butlerReady: boolean; tailscaleReady: boolean; sshReady: boolean }
  containment?: { auditComplete: boolean; readOnlyBoundaryHeld: boolean; sensitiveMaterialObserved: boolean; stopDenied: boolean; restartDenied: boolean; denialAuditCount: number; denialStateUnchanged?: boolean; denialProbeCompleted?: boolean }
}

export interface SanctuaryScenarioCaptureDependencies {
  now(): number
  readFacts(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<SanctuaryScenarioFacts>
  receiptRoot?: string
  gateStatusPath?: string
}

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

function groundedReadCount(after: SanctuaryScenarioFacts, toolName: string): number {
  const resultDigests = new Set(after.events.flatMap((entry) => entry.event === "senses.sanctuary_read_receipt" && entry.meta.toolName === toolName && entry.meta.success === true && typeof entry.meta.resultDigest === "string" ? [entry.meta.resultDigest] : []))
  return after.telegramTurns.filter((turn) => turn.toolResultDigests.some((digest) => resultDigests.has(digest))).length
}

function firstApproval(after: SanctuaryScenarioFacts): SanctuaryScenarioApproval | null {
  return after.approvals.at(-1) ?? null
}

export function deriveSanctuaryScenarioAssertions(
  label: SanctuaryUnit16EvidenceLabel,
  before: SanctuaryScenarioFacts,
  after: SanctuaryScenarioFacts,
  now: number,
): JsonObject | null {
  const approval = firstApproval(after)
  const linkedAttempts = approval ? after.restartAttempts
    .filter((attempt) => approval.toolName === "unraid_restart_container" && attempt.approvalId === approval.approvalId && attempt.argumentDigest === approval.argumentDigest && attempt.target === approval.target)
    .sort((left, right) => left.observedAt - right.observedAt) : []
  const mutationAttemptIds = new Set(linkedAttempts.filter((attempt) => attempt.state === "attempting").map((attempt) => attempt.attemptId))
  const mutationCount = mutationAttemptIds.size
  const scenarioMutationCount = new Set(after.restartAttempts.filter((attempt) => attempt.state === "attempting").map((attempt) => attempt.attemptId)).size
  const restartSucceeded = linkedAttempts.some((attempt) => attempt.state === "succeeded" && mutationAttemptIds.has(attempt.attemptId)
    && (attempt.mutationAcknowledged || attempt.afterState === "running"))
  const firstIndeterminate = linkedAttempts.find((attempt) => attempt.state === "attempted_or_indeterminate")
  const attemptedIndeterminateRetryCount = firstIndeterminate
    ? new Set(linkedAttempts.filter((attempt) => attempt.state === "attempting" && attempt.observedAt > firstIndeterminate.observedAt && attempt.attemptId !== firstIndeterminate.attemptId).map((attempt) => attempt.attemptId)).size
    : 0
  const telegramResponses = Math.max(0, after.telegramTurns.filter((turn) => turn.status === "success" && turn.deliveryCount > 0).length - before.telegramTurns.filter((turn) => turn.status === "success" && turn.deliveryCount > 0).length)
  const approvalTransitions = delta(after, before, "approval.acceptance_transition")
  switch (label) {
    case "unit-12c-1-opaque-identity":
    case "unit-14b-3-opaque-identity-live":
      if (!after.identity || (after.identity.inspectedRecordCount ?? 0) < 1 || (after.identity.opaqueSubjectCount ?? 0) < 1 || after.identity.mismatchCount !== 0 || after.identity.rawLeakCount !== 0
        || (label.includes("live") && (telegramResponses < 1 || !after.identity.liveSubjectObserved))) return null
      return { identityBound: after.identity.keyPresent, opaqueSubject: after.identity.subjectOpaque, rawIdentityAbsent: after.identity.rawIdentityAbsent }
    case "unit-15c-1-no-callback-terminalization": {
      if (!approval || approval.state !== "expired" || approval.createdAt < before.capturedAt || approval.expiresAt - approval.createdAt !== 300_000) return null
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
      if (!noInboundUpdate) return null
      return { buttonsRemoved: approval.buttonsRemoved, elapsedMs, mutationCount, noInboundUpdate, replayMutationCount: approval.replayMutationCount, terminalExpired: approval.state === "expired", ttlMs: approval.expiresAt - approval.createdAt }
    }
    case "unit-16a-pre-reboot-checkpoint":
      if (!after.reboot || !after.container?.running || !after.container.healthy || after.reboot.unrelatedHostOperations !== 0) return null
      return { approvalDigest: hash(after.approvals), auditDigest: hash(after.events), containerDigest: hash(after.container), fingerprintDigest: hash(after.cron), offsetDigest: hash(after.sourceValues["telegram-offset"]), ready: Boolean(after.container?.running && after.container.healthy), unrelatedHostOperations: after.reboot.unrelatedHostOperations }
    case "unit-16a-reboot-request":
      if (!after.reboot || after.reboot.requestCount !== 1 || !after.reboot.checkpointPersisted) return null
      return { exactlyOnce: true, requestCheckpointPersisted: true, requestDigest: after.reboot.requestDigest }
    case "unit-16a-boot-recovery-milestones":
      if (!after.reboot?.bootIdentityChanged || !after.reboot.arrayReady || !after.reboot.butlerReady || !after.reboot.dockerReady || !after.reboot.hostReady || !after.reboot.sshReady || !after.reboot.tailscaleReady) return null
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
      if (telegramResponses !== 1) return null
      return { authorized: true, grounded: groundedReadCount(after, "unraid_get_system") === 1 && after.telegramTurns.at(-1)?.deliveryCount! > 0, responseCount: telegramResponses, telegramDelivered: true }
    case "unit-16d-1-space":
      if (telegramResponses !== 1) return null
      return { authorized: true, diskFactsMatched: groundedReadCount(after, "unraid_get_storage") === 1 && after.telegramTurns.at(-1)?.deliveryCount! > 0, mutationCount: scenarioMutationCount, responseCount: telegramResponses, telegramDelivered: true }
    case "unit-16d-2-unauthorized": {
      const rejected = delta(after, before, "telegram.update_dropped")
      if (rejected < 1) return null
      const distinctAccount = after.events.some((entry) => entry.event === "telegram.update_dropped" && entry.meta.scenarioHandleDigest && entry.meta.distinctAccount === true)
      if (!distinctAccount) return null
      return { auditRejected: true, distinctAccount, mutationCount: scenarioMutationCount, providerInvocationCount: after.telegramTurns.reduce((sum, turn) => sum + turn.providerTurnCount, 0), responseCount: telegramResponses, workItemCount: approvalTransitions }
    }
    case "unit-16e-containment-audit":
      if (!after.containment?.auditComplete || !after.containment.readOnlyBoundaryHeld || after.containment.sensitiveMaterialObserved || mutationCount !== 0) return null
      return { auditComplete: after.containment.auditComplete, mutationCount, readOnlyBoundaryHeld: after.containment.readOnlyBoundaryHeld, sensitiveMaterialObserved: after.containment.sensitiveMaterialObserved }
    case "unit-16e-1-stop-denial":
    case "unit-16e-2-restart-denial": {
      const denied = label === "unit-16e-1-stop-denial" ? after.containment?.stopDenied : after.containment?.restartDenied
      if (denied !== true || after.containment?.denialAuditCount !== 1 || after.containment.denialStateUnchanged !== true || after.containment.denialProbeCompleted !== true || scenarioMutationCount !== 0) return null
      return { auditDecisionCount: after.containment.denialAuditCount, denied, mutationCount, resumed: after.containment.denialProbeCompleted }
    }
    case "unit-16f-cron-fingerprint":
      if (!before.cron || !after.cron || after.cron.sweepCount <= before.cron.sweepCount || before.cron.fingerprint !== after.cron.fingerprint || before.cron.receiptDigest !== after.cron.receiptDigest || telegramResponses !== 0 || delta(after, before, "senses.telegram_turn_start") !== 0 || !after.cron.registered) return null
      return { fingerprintUnchanged: before.cron.fingerprint === after.cron.fingerprint, messageCount: telegramResponses, providerInvocationCount: delta(after, before, "senses.telegram_turn_start"), receiptUnchanged: before.cron.receiptDigest === after.cron.receiptDigest, scheduleRegistered: after.cron.registered, sweepObserved: true }
    case "unit-16g-health-transition":
      if (!after.health || after.health.transitionCount <= (before.health?.transitionCount ?? 0) || after.health.alertCount - (before.health?.alertCount ?? 0) !== 1 || !after.health.productionRestored) return null
      return { alertCount: after.health.alertCount - (before.health?.alertCount ?? 0), productionRestored: after.health.productionRestored, transitionObserved: true }
    case "unit-16h-daily-digest":
      if (!after.digest || after.digest.messageCount - (before.digest?.messageCount ?? 0) !== 1 || after.digest.firedWithinMs < 1 || after.digest.firedWithinMs > 960_000 || !after.digest.productionRestored || !after.digest.scheduleObserved) return null
      return { firedWithinMs: after.digest.firedWithinMs, messageCount: after.digest.messageCount - (before.digest?.messageCount ?? 0), productionRestored: after.digest.productionRestored, scheduleObserved: after.digest.scheduleObserved }
    case "unit-16i-delayed-approval":
      if (!approval || approval.state !== "succeeded" || now - approval.createdAt < 120_000 || mutationCount !== 1 || !restartSucceeded || approval.replayMutationCount !== 0 || !approval.continuationCompleted) return null
      if (!approval.terminalPrompt) return null
      return { elapsedMs: approval.updatedAt - approval.createdAt, mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, resumed: approval.continuationCompleted, state: approval.state }
    case "unit-16j-denial":
      if (!approval || approval.state !== "denied" || mutationCount !== 0 || approval.replayMutationCount !== 0 || !approval.continuationCompleted) return null
      if (!approval.terminalPrompt) return null
      return { mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, resumed: approval.continuationCompleted, state: approval.state }
    case "unit-16k-timeout-stale":
      if (!approval || approval.state !== "expired" || mutationCount !== 0 || approval.replayMutationCount !== 0) return null
      if (!approval.buttonsRemoved || !approval.terminalPrompt || !approval.staleAcknowledged) return null
      return { buttonsRemoved: approval.buttonsRemoved, mutationCount, promptTerminal: approval.terminalPrompt, staleAcknowledged: approval.staleAcknowledged, staleReplayMutationCount: approval.replayMutationCount, state: approval.state }
    case "unit-16l-duplicate-callback": {
      if (!approval || approval.callbackCount !== 2 || approval.settledCount !== 2 || approval.claimCount !== 1 || !approval.terminalPrompt || approval.replayMutationCount !== 0 || mutationCount !== 1 || !restartSucceeded) return null
      return { callbackCount: approval.callbackCount, claimCount: approval.claimCount, mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, settledCount: approval.settledCount }
    }
    case "unit-16m-restart-continuation":
      if (!approval || approval.state !== "succeeded" || mutationCount !== 1 || !restartSucceeded || attemptedIndeterminateRetryCount !== 0) return null
      return { attemptedIndeterminateRetryCount, mutationCount, preAttemptResumed: approval.continuationCompleted, restartObserved: restartSucceeded && delta(after, before, "senses.telegram_approved_restart_end") === 1, state: approval.state }
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
      const capturedBefore = await deps.readFacts(input.label, scenarioHandleDigest)
      const before = { ...capturedBefore, sourceValues: Object.fromEntries(Object.entries(capturedBefore.sourceValues).map(([source, value]) => [source, hash(value)])) }
      const receipt: Receipt = { schemaVersion: "sanctuary-acceptance-receipt-v1", label: input.label, gate: input.externalGate, sources: [...input.sources], checkpointDigest, scenarioHandleDigest, startedAt, before }
      atomicPrivateJson(receiptPath(checkpointDigest), receipt)
      writeSanctuaryAcceptanceMarker("sanctuary", { schemaVersion: "sanctuary-acceptance-marker-v1", label: input.label, scenarioHandleDigest, startedAt })
      publishSanctuaryAcceptanceGateStatus({ label: input.label, gate: input.externalGate, phase: "waiting", startedAt }, deps.gateStatusPath)
      emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_scenario_begin", message: "Sanctuary live acceptance scenario began", meta: { label: input.label, gate: input.externalGate, scenarioHandleDigest } })
      return { state: "waiting", checkpointDigest }
    }
    if (!input.checkpointDigest || !SHA256.test(input.checkpointDigest)) throw new Error("scenario checkpoint digest is invalid")
    const filePath = receiptPath(input.checkpointDigest)
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf8")) as Receipt
    if (receipt.checkpointDigest !== input.checkpointDigest || receipt.label !== input.label || receipt.gate !== input.externalGate || JSON.stringify(receipt.sources) !== JSON.stringify(input.sources)) throw new Error("scenario checkpoint binding mismatch")
    const after = await deps.readFacts(input.label, receipt.scenarioHandleDigest)
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
    publishSanctuaryAcceptanceGateStatus({ label: input.label, gate: input.externalGate, phase: "complete", startedAt: receipt.startedAt }, deps.gateStatusPath)
    clearSanctuaryAcceptanceMarker("sanctuary", receipt.scenarioHandleDigest)
    fs.unlinkSync(filePath)
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_scenario_end", message: "Sanctuary live acceptance scenario completed", meta: { label: input.label, scenarioHandleDigest: receipt.scenarioHandleDigest } })
    return { state: "complete", checkpointDigest: receipt.checkpointDigest, sourceDigests, assertions }
  }
}

export function finalizeSanctuaryScenarioCapture(gateStatusPath?: string): void {
  clearSanctuaryAcceptanceGateStatus(gateStatusPath)
}
