import { createHash, randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { SanctuarySchedulerLivenessReceipt } from "./sanctuary-scheduler-liveness"
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
import { sanctuaryGroundedResponseAccurate, sanctuaryGroundingDigest, type SanctuaryGroundingToolName, type SanctuaryToolGrounding } from "../../senses/sanctuary-grounding"
import { TELEGRAM_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS, TELEGRAM_APPROVAL_TTL_MS } from "../../senses/telegram-client"

type JsonObject = Record<string, unknown>
const SHA256 = /^[0-9a-f]{64}$/u
export const SANCTUARY_APPROVAL_TTL_MS = TELEGRAM_APPROVAL_TTL_MS
export const SANCTUARY_APPROVAL_RECONCILIATION_JITTER_MS = 1_000
export const SANCTUARY_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS = TELEGRAM_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS
const CANONICAL_RESTART_TARGET = "calibre-web"

export interface SanctuaryPostbootIntegritySnapshot {
  schemaVersion: "sanctuary-postboot-integrity-v2"
  activeScenarioHandleDigest: string | null
  telegramNextUpdateId: number
  approvalCheckpoints: Array<{ idDigest: string; recordDigest: string }>
  approvalExecutionCount: number
  restartAttempts: Array<{ idDigest: string; recordDigest: string; state: "attempt_not_started" | "attempting" | "succeeded" | "attempted_or_indeterminate" }>
  fingerprintDigest: string
  sweeps: Array<{ idDigest: string; recordDigest: string; scenarioHandleDigest: string | null; deliveryIdDigest: string | null }>
  deliveries: Array<{ idDigest: string; recordDigest: string }>
  audits: Array<{ idDigest: string; recordDigest: string; scenarioHandleDigest: string | null; scenarioRelevant: boolean }>
}

function uniqueDigests(rows: Array<{ idDigest: string }>): boolean {
  return rows.every((row) => SHA256.test(row.idDigest)) && new Set(rows.map((row) => row.idDigest)).size === rows.length
}

function preservedPrefix<T extends { recordDigest: string }>(before: T[], after: T[]): boolean {
  return before.length <= after.length && before.every((row, index) => row.recordDigest === after[index]?.recordDigest)
}

export function verifySanctuaryPostbootIntegrity(
  before: SanctuaryPostbootIntegritySnapshot,
  after: SanctuaryPostbootIntegritySnapshot,
  scenarioHandleDigest: string,
  options: { preserveCursors?: boolean } = {},
): { preserved: true; sweepDeltaCount: number; deliveryDeltaCount: number; auditDeltaCount: number } | null {
  if (before.schemaVersion !== "sanctuary-postboot-integrity-v2" || after.schemaVersion !== before.schemaVersion || !SHA256.test(scenarioHandleDigest)
    || before.activeScenarioHandleDigest !== null || after.activeScenarioHandleDigest !== scenarioHandleDigest) return null
  if (!Number.isSafeInteger(before.telegramNextUpdateId) || !Number.isSafeInteger(after.telegramNextUpdateId)
    || before.telegramNextUpdateId < 0 || after.telegramNextUpdateId < before.telegramNextUpdateId) return null
  if (options.preserveCursors !== false && (JSON.stringify(before.approvalCheckpoints) !== JSON.stringify(after.approvalCheckpoints)
    || before.approvalExecutionCount !== after.approvalExecutionCount || before.fingerprintDigest !== after.fingerprintDigest)) return null
  if (![before.approvalCheckpoints, after.approvalCheckpoints, before.sweeps, after.sweeps, before.deliveries, after.deliveries, before.audits, after.audits].every(uniqueDigests)) return null
  const rows = [...before.approvalCheckpoints, ...after.approvalCheckpoints, ...before.restartAttempts, ...after.restartAttempts,
    ...before.sweeps, ...after.sweeps, ...before.deliveries, ...after.deliveries, ...before.audits, ...after.audits]
  if (!rows.every((row) => SHA256.test(row.recordDigest))) return null
  if (JSON.stringify(before.restartAttempts) !== JSON.stringify(after.restartAttempts) || !preservedPrefix(before.sweeps, after.sweeps)
    || !preservedPrefix(before.deliveries, after.deliveries) || !preservedPrefix(before.audits, after.audits)) return null
  const executionCount = (snapshot: SanctuaryPostbootIntegritySnapshot) => new Set(snapshot.restartAttempts
    .filter((row) => row.state !== "attempt_not_started").map((row) => row.idDigest)).size
  const validAttemptLifecycles = (snapshot: SanctuaryPostbootIntegritySnapshot): boolean => {
    const states = new Map<string, string[]>()
    for (const row of snapshot.restartAttempts) states.set(row.idDigest, [...(states.get(row.idDigest) ?? []), row.state])
    return [...states.values()].every((sequence) => sequence.length === 3 && sequence[0] === "attempt_not_started"
      && sequence[1] === "attempting" && (sequence[2] === "succeeded" || sequence[2] === "attempted_or_indeterminate"))
  }
  if (!validAttemptLifecycles(before) || !validAttemptLifecycles(after)) return null
  if (before.approvalExecutionCount !== executionCount(before) || after.approvalExecutionCount !== executionCount(after)
    || after.approvalExecutionCount !== before.approvalExecutionCount) return null
  const newSweeps = after.sweeps.slice(before.sweeps.length)
  const newDeliveries = after.deliveries.slice(before.deliveries.length)
  const newAudits = after.audits.slice(before.audits.length)
  if (newSweeps.some((row) => row.scenarioHandleDigest !== scenarioHandleDigest)) return null
  const boundDeliveryIds = new Set(newSweeps.flatMap((row) => row.deliveryIdDigest ? [row.deliveryIdDigest] : []))
  if (newDeliveries.some((row) => !boundDeliveryIds.has(row.idDigest))) return null
  if (newAudits.some((row) => row.scenarioRelevant && row.scenarioHandleDigest !== scenarioHandleDigest)) return null
  return { preserved: true, sweepDeltaCount: newSweeps.length, deliveryDeltaCount: newDeliveries.length, auditDeltaCount: newAudits.length }
}

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
  resultDigest: string
  resultTargetId: string | null
  checkpointDigest?: string
  approvalEpoch?: number
  continuationEpoch?: number | null
  continuationState?: string | null
  suspendedSessionRevision?: string | null
}

interface SanctuaryInteractiveDriverReceiptBase {
  schemaVersion: "sanctuary-interactive-driver-receipt-v2" | "sanctuary-timeout-stale-driver-receipt-v1"
  scenarioHandleDigest: string
  approvalIdDigest: string
  checkpointDigest: string
  suspendedSessionRevisionDigest: string
  approvalEpochBefore: number
}

export interface SanctuaryTimeoutStaleDriverReceipt extends SanctuaryInteractiveDriverReceiptBase {
  schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1"
  label: "unit-16k-timeout-stale"
  callbackAttempts: number
  distinctQueryCount: number
  callbackDataDigest: string
  settledCount: number
  claimCount: number
  mutationCount: number
  staleAcknowledged: boolean
  promptTerminal: boolean
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
  attemptedRecoveryReopened: boolean
  attemptedRecordDigest: string
  recoveredRecordDigest: string
  indeterminateRetryCount: number
}

export type SanctuaryInteractiveDriverReceipt = SanctuaryTimeoutStaleDriverReceipt | SanctuaryDuplicateCallbackDriverReceipt | SanctuaryRestartContinuationDriverReceipt

export interface SanctuaryDenialBoundarySnapshot {
  ownerSnapshotDigest: string
  targetSnapshotDigest: string
  targetRestartCount: number
  targetContainerIdDigest: string
  auditCursorDigest: string
  providerUsageCursorDigest: string
  sessionCursorDigest: string
  toolActionCursorDigest: string
}

export interface SanctuaryReadOnlyDenialReceipt {
  schemaVersion: "sanctuary-read-only-denial-receipt-v1"
  phase: "complete"
  label: "unit-16e-1-stop-denial" | "unit-16e-2-restart-denial"
  scenarioHandleDigest: string
  operation: "stop" | "restart"
  targetDigest: string
  attemptCount: number
  httpStatus: number
  errorCode: string
  before: SanctuaryDenialBoundarySnapshot
  after: SanctuaryDenialBoundarySnapshot
}

export interface SanctuaryScenarioRestartAttempt {
  state: "attempt_not_started" | "attempting" | "succeeded" | "attempted_or_indeterminate"
  actionDigest: string
  argumentDigest: string
  target: string
  targetId: string
  beforeState: string
  scenarioHandleDigest: string
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
  responseText?: string
  responseUtf16Units?: number
  toolGroundings?: SanctuaryToolGrounding[]
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
  schedulerReceipt: SanctuarySchedulerLivenessReceipt | null
}

export interface SanctuaryScenarioFacts {
  capturedAt: number
  sourceValues: Record<string, unknown>
  postbootIntegrity?: SanctuaryPostbootIntegritySnapshot
  prebootIntegrity?: SanctuaryPostbootIntegritySnapshot
  events: SanctuaryScenarioEvent[]
  approvals: SanctuaryScenarioApproval[]
  restartAttempts: SanctuaryScenarioRestartAttempt[]
  telegramTurns: SanctuaryScenarioTelegramTurnReceipt[]
  telegramNextUpdateId?: number
  zeroWork?: { providerToolDigest: string; outwardDigest: string; approvalMutationDigest: string; sessionFriendDigest: string }
  identity?: { keyPresent: boolean; subjectOpaque: boolean; rawIdentityAbsent: boolean; liveSubjectObserved: boolean; inspectedRecordCount?: number; opaqueSubjectCount?: number; mismatchCount?: number; rawLeakCount?: number; surfaceDigest?: string; canonicalSessionCount?: number; canonicalFriendCount?: number; sessionSurfaceDigest?: string; friendSurfaceDigest?: string }
  container?: {
    exactImage: boolean; running: boolean; healthy: boolean; user: string; readOnlyRoot: boolean
    mountCount: number; publishedPortCount: number; restartPolicy: string; restartCount: number
    autostartExact: boolean; updaterDisabled: boolean; vaultUnlocked: boolean; manualAuthRequired: boolean
  }
  provider?: { outwardReady: boolean; innerReady: boolean; geminiCandidateReady: boolean; providersDistinct: boolean; silentFallback: boolean; credentialRevisionsPresent?: boolean; requestSemanticsExact?: boolean; fallbackAttemptCount?: number; modelsExact?: boolean; baseUrlsExact?: boolean; vaultCoordinatesExact?: boolean; credentialIdentitiesDistinct?: boolean; pingReceipts?: Array<Record<string, unknown>> }
  cron?: { registered: boolean; fingerprint: string; receiptDigest: string; sweepCount: number }
  health?: { transitionCount: number; alertCount: number; productionRestored: boolean }
  digest?: { scheduleObserved: boolean; messageCount: number; firedWithinMs: number; productionRestored: boolean }
  healthProbe?: SanctuaryHealthProbeReceipt
  interactiveDriver?: SanctuaryInteractiveDriverReceipt
  denial?: SanctuaryReadOnlyDenialReceipt
  liveGrounding?: { toolName: SanctuaryGroundingToolName; groundingDigest: string; sourceIdentityDigest: string; observedAt: string; facts: Record<string, unknown> }
  reboot?: { phase: "preflight" | "requested" | "complete"; requestDigest: string; processBindingDigest: string; requestCount: number; checkpointPersisted: boolean; unrelatedHostOperations: number; bootIdentityChanged: boolean; hostReady: boolean; arrayReady: boolean; dockerReady: boolean; butlerReady: boolean; tailscaleReady: boolean; sshReady: boolean }
  containment?: SanctuaryContainmentAuditEvidence
}

export interface SanctuaryContainmentAuditEvidence {
  schemaVersion: "sanctuary-containment-audit-v1"
  keyCount: number
  keyInventoryDigest: string
  readScopeDigest: string
  writeScopeDigest: string
  keyRoleAssignmentCount: number
  telegramToolCount: number
  telegramProfileDigest: string
  telegramSchemaDigest: string
  privateToolCount: number
  privateProfileDigest: string
  privateSchemaDigest: string
  resolvedHandlerCount: number
  excludedToolCount: number
  excludedSchemaIntersectionCount: number
  fabricatedHandlerInvocationCount: number
  excludedToolAttemptCount: number
  excludedToolRejectedCount: number
  excludedToolInvokedCount: number
  excludedToolSideEffectCount: number
  globallyResolvableExcludedToolCount: number
  auditPathDigest: string
  auditLedgerDigest: string
  auditRecordCount: number
  auditLifecyclePairCount: number
  containerUser: string
  liveProcessUser: string
  mountCount: number
  publishedPortCount: number
  networkMode: string
  readOnlyRoot: boolean
  mountsExact: boolean
  securityExact: boolean
  updaterDisabled: boolean
  writableKeyExposure: boolean
  rawWriteMaterialFieldCount: number
  typedWriteExecutorCount: number
  writeApprovalPolicyDigest: string
  sensitiveMaterialObserved: boolean
  stopDenied: boolean
  restartDenied: boolean
  denialAuditCount: number
  denialStateUnchanged?: boolean
  denialProbeCompleted?: boolean
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
  denialDriver?: {
    poll(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<{ state: "waiting" | "driven" }>
    complete(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): void | Promise<void>
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
const READ_ONLY_DENIAL_LABELS = new Set<SanctuaryUnit16EvidenceLabel>([
  "unit-16e-1-stop-denial",
  "unit-16e-2-restart-denial",
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

const CONTAINMENT_READ_SCOPE = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => `${resource}:READ_ANY`).sort()
const CONTAINMENT_TELEGRAM_PROFILE = ["unraid_list_containers", "unraid_get_container_logs", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system", "unraid_restart_container", "ponder", "settle", "speak"]
const CONTAINMENT_PRIVATE_PROFILE = ["send_message", "rest"]
const CONTAINMENT_EXCLUDED_TOOLS = ["shell", "read_file", "edit_file", "vault_get", "mcp_call", "exec", "credential_get"]
const CONTAINMENT_AUDIT_PATH = "/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-audit-chain.ndjson"
const CONTAINMENT_WRITE_POLICY = { kind: "required", policyId: "sanctuary.unraid.restart.v1", actionClass: "unraid.container.restart", requiresSoleCall: true }
const CONTAINMENT_TELEGRAM_SCHEMA_DIGEST = "3c66299a5f70ec82f8795cae47659284e6dbc691ef49002c2fb22edba76c59b6"
const CONTAINMENT_PRIVATE_SCHEMA_DIGEST = "61b137b2467acbcf22ca7443ee01e71ed970a62728c42aabffbdcb562f4a6a70"

function exactContainmentAudit(evidence: SanctuaryContainmentAuditEvidence): boolean {
  const digestFields = [evidence.keyInventoryDigest, evidence.telegramSchemaDigest, evidence.privateSchemaDigest, evidence.auditLedgerDigest]
  return evidence.schemaVersion === "sanctuary-containment-audit-v1"
    && evidence.keyCount === 2
    && evidence.readScopeDigest === hash(CONTAINMENT_READ_SCOPE)
    && evidence.writeScopeDigest === hash([...CONTAINMENT_READ_SCOPE, "DOCKER:UPDATE_ANY"].sort())
    && evidence.keyRoleAssignmentCount === 0
    && evidence.telegramToolCount === CONTAINMENT_TELEGRAM_PROFILE.length
    && evidence.telegramProfileDigest === hash(CONTAINMENT_TELEGRAM_PROFILE)
    && evidence.telegramSchemaDigest === CONTAINMENT_TELEGRAM_SCHEMA_DIGEST
    && evidence.privateToolCount === CONTAINMENT_PRIVATE_PROFILE.length
    && evidence.privateProfileDigest === hash(CONTAINMENT_PRIVATE_PROFILE)
    && evidence.privateSchemaDigest === CONTAINMENT_PRIVATE_SCHEMA_DIGEST
    && evidence.resolvedHandlerCount === CONTAINMENT_TELEGRAM_PROFILE.length + CONTAINMENT_PRIVATE_PROFILE.length
    && evidence.excludedToolCount === CONTAINMENT_EXCLUDED_TOOLS.length
    && evidence.excludedSchemaIntersectionCount === 0
    && evidence.fabricatedHandlerInvocationCount === 0
    && evidence.excludedToolAttemptCount === CONTAINMENT_EXCLUDED_TOOLS.length
    && evidence.excludedToolRejectedCount === CONTAINMENT_EXCLUDED_TOOLS.length
    && evidence.excludedToolInvokedCount === 0 && evidence.excludedToolSideEffectCount === 0
    && evidence.globallyResolvableExcludedToolCount >= 1
    && evidence.auditPathDigest === createHash("sha256").update(CONTAINMENT_AUDIT_PATH).digest("hex")
    && evidence.auditRecordCount >= 2 && evidence.auditLifecyclePairCount >= 1
    && evidence.containerUser === "10001:10001" && evidence.liveProcessUser === "10001:10001" && evidence.mountCount === 2 && evidence.publishedPortCount === 0
    && evidence.networkMode === "host" && evidence.readOnlyRoot && evidence.mountsExact && evidence.securityExact && evidence.updaterDisabled
    && !evidence.writableKeyExposure && evidence.rawWriteMaterialFieldCount === 0 && evidence.typedWriteExecutorCount === 1
    && evidence.writeApprovalPolicyDigest === hash(CONTAINMENT_WRITE_POLICY) && !evidence.sensitiveMaterialObserved
    && digestFields.every((value) => SHA256.test(value))
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

function exactGroundedResponse(after: SanctuaryScenarioFacts, turn: SanctuaryScenarioTelegramTurnReceipt, toolName: SanctuaryGroundingToolName): boolean {
  const grounding = turn.toolGroundings?.length === 1 ? turn.toolGroundings[0] : undefined
  const live = after.liveGrounding
  const audit = after.events.filter((entry) => entry.event === "senses.sanctuary_read_receipt" && entry.meta.toolName === toolName && entry.meta.success === true
    && entry.meta.resultDigest === grounding?.resultDigest && entry.meta.groundingDigest === grounding?.groundingDigest
    && entry.meta.sourceIdentityDigest === grounding?.sourceIdentityDigest && entry.meta.observedAt === grounding?.observedAt)
  const turnObservedAt = Date.parse(grounding?.observedAt ?? "")
  const liveObservedAt = Date.parse(live?.observedAt ?? "")
  const timeBound = Number.isFinite(turnObservedAt) && Number.isFinite(liveObservedAt)
    && turnObservedAt <= turn.completedAt && turn.completedAt - turnObservedAt <= 300_000
    && liveObservedAt >= turnObservedAt && liveObservedAt - turnObservedAt <= 300_000
  const liveFactsBound = toolName === "unraid_get_storage"
    ? live?.groundingDigest === sanctuaryGroundingDigest(live?.facts ?? {})
    : grounding?.groundingDigest === live?.groundingDigest && JSON.stringify(grounding?.facts) === JSON.stringify(live?.facts)
  return Boolean(grounding && live && grounding.toolName === toolName && live.toolName === toolName
    && grounding.groundingDigest === sanctuaryGroundingDigest(grounding.facts) && live.groundingDigest === sanctuaryGroundingDigest(live.facts)
    && grounding.sourceIdentityDigest === live.sourceIdentityDigest && SHA256.test(grounding.sourceIdentityDigest) && timeBound && liveFactsBound
    && audit.length === 1 && typeof turn.responseText === "string" && turn.responseText.length > 0
    && turn.responseUtf16Units === turn.responseText.length && turn.responseUtf16Units <= 1_200
    && sanctuaryGroundedResponseAccurate(toolName, grounding.facts, turn.responseText))
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

function exactFreshTelegramLifecycle(
  before: SanctuaryScenarioFacts,
  after: SanctuaryScenarioFacts,
  expectedUpdateDigest?: string,
  expectedOutcome: "success" | "error" = "success",
): boolean {
  if (before.events.length > after.events.length || before.events.some((entry, index) => hash(entry) !== hash(after.events[index]))) return false
  const fresh = recordsAdded(before.events, after.events, (entry) => hash(entry))
  const starts = fresh.filter((entry) => entry.event === "senses.telegram_turn_start")
  const terminals = fresh.filter((entry) => entry.event === "senses.telegram_turn_end" || entry.event === "senses.telegram_turn_error")
  if (starts.length !== 1 || terminals.length !== 1) return false
  const start = starts[0]!
  const terminal = terminals[0]!
  const coordinateKeys = ["scenarioHandleDigest", "turnDigest", "updateDigest", "subject", "identityDigest", "sessionDigest", "argumentDigest"] as const
  if (coordinateKeys.some((key) => start.meta[key] !== terminal.meta[key])) return false
  if (!SHA256.test(String(start.meta.scenarioHandleDigest)) || !SHA256.test(String(start.meta.turnDigest))
    || !SHA256.test(String(start.meta.updateDigest)) || (expectedUpdateDigest !== undefined && start.meta.updateDigest !== expectedUpdateDigest)
    || typeof start.meta.subject !== "string" || !/^tg_[A-Za-z0-9_-]{43}$/u.test(start.meta.subject)
    || ![start.meta.identityDigest, start.meta.sessionDigest, start.meta.argumentDigest, start.meta.lifecycleMac, terminal.meta.lifecycleMac].every((value) => typeof value === "string" && SHA256.test(value))) return false
  if (!Number.isSafeInteger(terminal.meta.deliveryCount) || Number(terminal.meta.deliveryCount) < 0) return false
  if (!Number.isSafeInteger(start.meta.lifecycleAt) || !Number.isSafeInteger(terminal.meta.lifecycleAt)
    || Number(start.meta.lifecycleAt) < 0 || Number(start.meta.lifecycleAt) >= Number(terminal.meta.lifecycleAt)) return false
  if (expectedOutcome === "success") return terminal.event === "senses.telegram_turn_end" && terminal.meta.outcome === "success" && terminal.meta.errorDigest === null
  return terminal.event === "senses.telegram_turn_error" && terminal.meta.outcome === "error" && typeof terminal.meta.errorDigest === "string" && SHA256.test(terminal.meta.errorDigest)
}

function intendedApproval(before: SanctuaryScenarioFacts, after: SanctuaryScenarioFacts): SanctuaryScenarioApproval | null {
  const previous = new Set(before.approvals.map((record) => record.approvalId))
  const candidates = after.approvals.filter((record) => !previous.has(record.approvalId) && record.createdAt >= before.capturedAt)
  return candidates.length === 1 ? candidates[0]! : null
}

function intendedRestartApproval(approval: SanctuaryScenarioApproval | null): approval is SanctuaryScenarioApproval {
  const argumentDigest = createHash("sha256").update(JSON.stringify({ container: CANONICAL_RESTART_TARGET })).digest("hex")
  return approval?.toolName === "unraid_restart_container"
    && approval.target === CANONICAL_RESTART_TARGET
    && approval.argumentDigest === argumentDigest
}

function approvalEvidenceCoordinates(approval: SanctuaryScenarioApproval): { actionDigest: string; targetDigest: string } {
  return {
    actionDigest: createHash("sha256").update(JSON.stringify({ toolName: approval.toolName, argumentDigest: approval.argumentDigest })).digest("hex"),
    targetDigest: createHash("sha256").update(JSON.stringify({ container: CANONICAL_RESTART_TARGET })).digest("hex"),
  }
}

function exactApprovalEvidence(
  before: SanctuaryScenarioFacts,
  after: SanctuaryScenarioFacts,
  approval: SanctuaryScenarioApproval,
): {
  boundAt: number
  callback: SanctuaryScenarioEvent | null
  continuation: SanctuaryScenarioEvent | null
  expiryObservedAt: number | null
  expiryDeadlineAt: number | null
  terminalizedAt: number
  staleCallback: SanctuaryScenarioEvent | null
} | null {
  const fresh = recordsAdded(before.events, after.events, (entry) => hash(entry))
  const prompt = fresh.filter((entry) => entry.event === "senses.telegram_approval_prompt_bound" && entry.meta.approvalId === approval.approvalId)
  const terminals = fresh.filter((entry) => entry.event === "telegram.approval_prompt_terminalized" && entry.meta.approvalId === approval.approvalId)
  const callbackCandidates = fresh.filter((entry) => ["telegram.callback_settled", "telegram.callback_recovery_settled"].includes(entry.event) && entry.meta.approvalId === approval.approvalId)
  const callbacks = [...new Map(callbackCandidates.map((entry) => [hash({ event: entry.event, meta: entry.meta }), entry])).values()]
  const continuations = fresh.filter((entry) => entry.event === "senses.telegram_approval_continuation_delivered" && entry.meta.approvalId === approval.approvalId)
  const staleCallbacks = fresh.filter((entry) => entry.event === "telegram.approval_stale_callback_settled" && entry.meta.approvalId === approval.approvalId)
  const expiryObservations = fresh.filter((entry) => entry.event === "telegram.approval_expiry_observed" && entry.meta.approvalId === approval.approvalId)
  if (prompt.length !== 1 || terminals.length !== 1 || callbacks.length > 1 || continuations.length > 1 || staleCallbacks.length > 1) return null
  if ((approval.state === "expired" && (expiryObservations.length < 1
      || new Set(expiryObservations.map((entry) => hash({ event: entry.event, meta: entry.meta }))).size !== 1))
    || (approval.state !== "expired" && expiryObservations.length !== 0)) return null
  const expected = approvalEvidenceCoordinates(approval)
  const coordinatesMatch = (entry: SanctuaryScenarioEvent): boolean => entry.meta.scenarioHandleDigest !== undefined
    && typeof entry.meta.scenarioHandleDigest === "string" && SHA256.test(entry.meta.scenarioHandleDigest)
    && entry.meta.actionDigest === expected.actionDigest && entry.meta.targetDigest === expected.targetDigest
    && entry.meta.checkpointDigest === approval.checkpointDigest
    && typeof approval.suspendedSessionRevision === "string"
    && entry.meta.suspendedSessionRevisionDigest === createHash("sha256").update(approval.suspendedSessionRevision, "utf8").digest("hex")
    && typeof entry.meta.messageIdDigest === "string" && SHA256.test(entry.meta.messageIdDigest)
    && typeof entry.meta.evidenceMac === "string" && SHA256.test(entry.meta.evidenceMac)
  if (![...prompt, ...terminals, ...callbacks, ...continuations, ...staleCallbacks, ...expiryObservations].every(coordinatesMatch)) return null
  const promptScenarioHandleDigest = prompt[0]!.meta.scenarioHandleDigest
  const promptMessageIdDigest = prompt[0]!.meta.messageIdDigest
  if (![...terminals, ...callbacks, ...continuations, ...staleCallbacks, ...expiryObservations].every((entry) => entry.meta.scenarioHandleDigest === promptScenarioHandleDigest
    && entry.meta.messageIdDigest === promptMessageIdDigest)) return null
  const boundAt = Number(prompt[0]!.meta.boundAt)
  const terminalEditStartedAt = Number(terminals[0]!.meta.terminalEditStartedAt)
  const terminalizedAt = Number(terminals[0]!.meta.terminalizedAt)
  const expiryObservation = expiryObservations[0] ?? null
  const expiryObservedAt = expiryObservation === null ? null : Number(expiryObservation.meta.expiryObservedAt)
  const expiryDeadlineAt = expiryObservation === null ? null : Number(expiryObservation.meta.expiryDeadlineAt)
  if (!Number.isSafeInteger(boundAt) || boundAt < 0
    || !Number.isSafeInteger(terminalEditStartedAt) || terminalEditStartedAt < boundAt
    || !Number.isSafeInteger(terminalizedAt) || terminalizedAt < terminalEditStartedAt
    || terminalizedAt - terminalEditStartedAt > SANCTUARY_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS
    || terminals[0]!.meta.boundAt !== boundAt || terminals[0]!.meta.buttonsRemoved !== true
    || approval.expiresAt !== boundAt + SANCTUARY_APPROVAL_TTL_MS) return null
  if (approval.state === "expired") {
    if (expiryObservedAt === null || !Number.isSafeInteger(expiryObservedAt) || expiryObservedAt < boundAt
      || expiryDeadlineAt !== approval.expiresAt || expiryObservation?.meta.expiryObservationSchemaVersion !== "telegram-approval-expiry-observation-v1"
      || expiryObservation.meta.boundAt !== boundAt
      || terminals[0]!.meta.expiryObservedAt !== expiryObservedAt || terminals[0]!.meta.expiryDeadlineAt !== expiryDeadlineAt
      || terminalEditStartedAt < expiryObservedAt || terminalizedAt - expiryObservedAt > SANCTUARY_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS) return null
  } else if (expiryObservedAt !== null || terminals[0]!.meta.expiryObservedAt !== undefined || terminals[0]!.meta.expiryDeadlineAt !== undefined) return null
  const callback = callbacks[0] ?? null
  if (callback) {
    const callbackAt = Number(callback.meta.callbackAt)
    if (!Number.isSafeInteger(callbackAt) || callbackAt < boundAt || callbackAt > terminalEditStartedAt
    || callback.meta.boundAt !== boundAt
    || (callback.event === "telegram.callback_settled" && (callback.meta.acknowledged !== true || callback.meta.acknowledgementState !== "acknowledged"))
    || (callback.event === "telegram.callback_recovery_settled" && (callback.meta.acknowledgementState !== "indeterminate_after_restart"
      || !Number.isSafeInteger(Number(callback.meta.recoveredAt)) || Number(callback.meta.recoveredAt) < callbackAt
      || Number(callback.meta.recoveredAt) > terminalEditStartedAt
      || callback.at < Number(callback.meta.recoveredAt)
      || typeof callback.meta.decisionAttemptDigest !== "string" || !SHA256.test(callback.meta.decisionAttemptDigest)))) return null
  }
  const continuation = continuations[0] ?? null
  if (continuation) {
    const deliveredAt = Number(continuation.meta.deliveredAt)
    const callbackAt = callback === null ? null : Number(callback.meta.callbackAt)
    if (!Number.isSafeInteger(deliveredAt) || deliveredAt < boundAt || deliveredAt > terminalEditStartedAt
      || callbackAt !== null && deliveredAt < callbackAt
      || continuation.meta.boundAt !== boundAt || typeof continuation.meta.resultDigest !== "string" || !SHA256.test(continuation.meta.resultDigest)
      || continuation.meta.resultDigest !== approval.resultDigest
      || typeof continuation.meta.deliveryDigest !== "string" || !SHA256.test(continuation.meta.deliveryDigest)
      || typeof continuation.meta.deliveryMessageIdDigest !== "string" || !SHA256.test(continuation.meta.deliveryMessageIdDigest)) return null
  }
  const staleCallback = staleCallbacks[0] ?? null
  if (staleCallback) {
    const staleAt = Number(staleCallback.meta.staleAt)
    if (!Number.isSafeInteger(staleAt) || staleAt < terminalizedAt || staleCallback.meta.acknowledged !== true
      || staleCallback.meta.accepted !== false || staleCallback.meta.reason !== "stale_callback") return null
  }
  return { boundAt, callback, continuation, expiryObservedAt, expiryDeadlineAt, terminalizedAt, staleCallback }
}

function terminalizedWithinTtlJitter(evidence: { boundAt: number; expiryObservedAt: number | null; expiryDeadlineAt: number | null }): boolean {
  if (evidence.expiryObservedAt === null) return false
  const elapsed = evidence.expiryObservedAt - evidence.boundAt
  return elapsed >= SANCTUARY_APPROVAL_TTL_MS && elapsed <= SANCTUARY_APPROVAL_TTL_MS + SANCTUARY_APPROVAL_RECONCILIATION_JITTER_MS
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
    && (probe.schedulerReceipt !== null || probe.beforeStateDigest === probe.restoredStateDigest)
    && probe.cronFingerprintBefore === probe.cronFingerprintAfter
    && probe.cronRegisteredBefore && probe.cronRegisteredAfter && !probe.cronDegradedBefore && !probe.cronDegradedAfter
    && currentCron?.fingerprint === probe.cronFingerprintAfter && currentCron.registered === probe.cronRegisteredAfter
    && probe.workspaceAbsent && probe.socketAbsent && probe.snapshotAbsent && probe.realCheckEquivalent && probe.productionRestored
}

export function deriveSanctuaryScenarioAssertions(
  label: SanctuaryUnit16EvidenceLabel,
  before: SanctuaryScenarioFacts,
  after: SanctuaryScenarioFacts,
  _now: number,
  scenarioHandleDigest?: string,
): JsonObject | null {
  const approval = intendedApproval(before, after)
  const newTurns = recordsAdded(before.telegramTurns, after.telegramTurns, (turn) => hash(turn))
  const newAttempts = recordsAdded(before.restartAttempts, after.restartAttempts, (attempt) => hash(attempt))
  const newApprovals = recordsAdded(before.approvals, after.approvals, (record) => record.approvalId)
  const linkedAttempts = approval ? after.restartAttempts
    .filter((attempt) => approval.toolName === "unraid_restart_container" && attempt.approvalId === approval.approvalId && attempt.argumentDigest === approval.argumentDigest && attempt.target === approval.target)
    .sort((left, right) => left.observedAt - right.observedAt) : []
  const attemptIsLinked = (attempt: SanctuaryScenarioRestartAttempt): boolean => {
    if (!approval || !intendedRestartApproval(approval) || attempt.approvalId !== approval.approvalId
      || attempt.argumentDigest !== approval.argumentDigest || attempt.target !== CANONICAL_RESTART_TARGET
      || typeof attempt.targetId !== "string" || attempt.targetId.length < 1 || attempt.targetId.length > 128
      || approval.resultTargetId === null || attempt.targetId !== approval.resultTargetId) return false
    const expectedActionDigest = createHash("sha256").update(JSON.stringify({ operation: "restart", container: { id: attempt.targetId, name: CANONICAL_RESTART_TARGET } })).digest("hex")
    return attempt.actionDigest === expectedActionDigest
  }
  const completeAttemptLedgerLinked = newAttempts.every(attemptIsLinked) && linkedAttempts.length === newAttempts.length
    && new Set(linkedAttempts.map((attempt) => attempt.targetId)).size <= 1
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
  const postbootIntegrity = after.prebootIntegrity && after.postbootIntegrity
    && typeof scenarioHandleDigest === "string"
    ? verifySanctuaryPostbootIntegrity(after.prebootIntegrity, after.postbootIntegrity, scenarioHandleDigest) : null
  switch (label) {
    case "unit-12c-1-opaque-identity":
    case "unit-14b-3-opaque-identity-live":
      if (!after.identity || (after.identity.inspectedRecordCount ?? 0) < 1 || (after.identity.opaqueSubjectCount ?? 0) < 1 || after.identity.mismatchCount !== 0 || after.identity.rawLeakCount !== 0
        || (label.includes("live") && (telegramResponses !== 1 || newTurns.length !== 1 || !after.identity.liveSubjectObserved
          || after.identity.canonicalSessionCount !== 1 || after.identity.canonicalFriendCount !== 1
          || !exactFreshTelegramLifecycle(before, after, newTurns[0]?.updateDigest)))) return null
      return { identityBound: after.identity.keyPresent, opaqueSubject: after.identity.subjectOpaque, rawIdentityAbsent: after.identity.rawIdentityAbsent }
    case "unit-15c-1-no-callback-terminalization": {
      if (!intendedRestartApproval(approval) || approval.state !== "expired" || approval.createdAt < before.capturedAt) return null
      const evidence = exactApprovalEvidence(before, after, approval)
      if (!evidence || evidence.callback !== null || evidence.continuation !== null || !terminalizedWithinTtlJitter(evidence)) return null
      const elapsedMs = evidence.terminalizedAt - evidence.boundAt
      if (!approval.buttonsRemoved || !approval.terminalPrompt) return null
      const baseline = before.sourceValues["no-callback-baseline"]
      if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return null
      const baselineRecord = baseline as { approvalId?: unknown; offsetDigest?: unknown; inboundEventCount?: unknown }
      const inboundEventCount = after.events.filter((entry) => entry.event === "telegram.callback_settled" || entry.event === "telegram.callback_recovery_settled" || entry.event === "telegram.update_dropped").length
      const noInboundUpdate = baselineRecord.approvalId === approval.approvalId
        && baselineRecord.offsetDigest === hash(after.sourceValues["telegram-offset"])
        && baselineRecord.inboundEventCount === inboundEventCount
        && approval.callbackCount === 0
      if (!noInboundUpdate || scenarioMutationCount !== 0 || !completeAttemptLedgerLinked) return null
      return { buttonsRemoved: approval.buttonsRemoved, elapsedMs, mutationCount: 0, noInboundUpdate, replayMutationCount: approval.replayMutationCount, terminalExpired: approval.state === "expired", ttlMs: SANCTUARY_APPROVAL_TTL_MS }
    }
    case "unit-16a-pre-reboot-checkpoint":
      if (!after.reboot || after.reboot.phase !== "preflight" || !SHA256.test(after.reboot.processBindingDigest) || after.reboot.requestCount !== 0 || !after.container?.running || !after.container.healthy || after.reboot.unrelatedHostOperations !== 0) return null
      return { approvalDigest: hash(after.approvals), auditDigest: hash(after.events), containerDigest: hash(after.container), fingerprintDigest: hash(after.cron), offsetDigest: hash(after.sourceValues["telegram-offset"]), processBindingDigest: after.reboot.processBindingDigest, ready: Boolean(after.container?.running && after.container.healthy), unrelatedHostOperations: after.reboot.unrelatedHostOperations }
    case "unit-16a-reboot-request":
      if (!after.reboot || after.reboot.phase !== "requested" || !SHA256.test(after.reboot.processBindingDigest) || after.reboot.requestCount !== 1 || !after.reboot.checkpointPersisted) return null
      return { exactlyOnce: true, processBindingDigest: after.reboot.processBindingDigest, requestCheckpointPersisted: true, requestDigest: after.reboot.requestDigest }
    case "unit-16a-boot-recovery-milestones":
      if (!after.reboot || after.reboot.phase !== "complete" || !SHA256.test(after.reboot.processBindingDigest) || !after.reboot.bootIdentityChanged || !after.reboot.arrayReady || !after.reboot.butlerReady || !after.reboot.dockerReady || !after.reboot.hostReady || !after.reboot.sshReady || !after.reboot.tailscaleReady || !postbootIntegrity) return null
      return { arrayReady: after.reboot.arrayReady, bootIdentityChanged: true, butlerReady: after.reboot.butlerReady, dockerReady: after.reboot.dockerReady, hostReady: after.reboot.hostReady, postbootIntegrityPreserved: true, processBindingDigest: after.reboot.processBindingDigest, sshReady: after.reboot.sshReady, tailscaleReady: after.reboot.tailscaleReady }
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
        && after.provider.modelsExact === true && after.provider.baseUrlsExact === true && after.provider.vaultCoordinatesExact === true && after.provider.credentialIdentitiesDistinct === true
        ? { outwardReady: true, innerReady: true, geminiCandidateReady: true, providersDistinct: true, silentFallback: false, modelsExact: true, baseUrlsExact: true, vaultCoordinatesExact: true, credentialIdentitiesDistinct: true } : null
    case "unit-16d-whats-up":
      if (telegramResponses !== 1 || newTurns.length !== 1 || !exactFreshTelegramLifecycle(before, after, newTurns[0]!.updateDigest) || deliveredTurns[0]!.toolInvocationCount !== 1 || deliveredTurns[0]!.toolResultDigests.length !== 1 || !turnHasGroundedRead(after, deliveredTurns[0]!, "unraid_get_system") || !exactGroundedResponse(after, deliveredTurns[0]!, "unraid_get_system")) return null
      return { accurate: true, authorized: true, grounded: true, liveFactsMatched: true, responseCount: telegramResponses, responseWithinLimit: true, telegramDelivered: true }
    case "unit-16d-1-space":
      if (telegramResponses !== 1 || newTurns.length !== 1 || !exactFreshTelegramLifecycle(before, after, newTurns[0]!.updateDigest) || deliveredTurns[0]!.toolInvocationCount !== 1 || deliveredTurns[0]!.toolResultDigests.length !== 1 || !turnHasGroundedRead(after, deliveredTurns[0]!, "unraid_get_storage") || !exactGroundedResponse(after, deliveredTurns[0]!, "unraid_get_storage")) return null
      return { accurate: true, authorized: true, grounded: true, liveFactsMatched: true, mutationCount: scenarioMutationCount, responseCount: telegramResponses, responseWithinLimit: true, telegramDelivered: true }
    case "unit-16d-2-unauthorized": {
      if (before.events.length > after.events.length || before.events.some((entry, index) => hash(entry) !== hash(after.events[index]))) return null
      const freshEvents = recordsAdded(before.events, after.events, (entry) => hash(entry))
      const freshDrops = freshEvents.filter((entry) => entry.event === "telegram.update_dropped")
      if (freshDrops.length !== 1) return null
      const drop = freshDrops[0]!
      const distinctAccount = drop.meta.distinctAccount === true
        && typeof drop.meta.scenarioHandleDigest === "string" && SHA256.test(drop.meta.scenarioHandleDigest)
        && typeof drop.meta.updateDigest === "string" && SHA256.test(drop.meta.updateDigest)
        && typeof drop.meta.senderIdentityDigest === "string" && SHA256.test(drop.meta.senderIdentityDigest)
        && typeof drop.meta.authorizedIdentityDigest === "string" && SHA256.test(drop.meta.authorizedIdentityDigest)
        && drop.meta.senderIdentityDigest !== drop.meta.authorizedIdentityDigest
        && drop.meta.senderDistinct === true
        && typeof drop.meta.nextOffsetDigest === "string" && SHA256.test(drop.meta.nextOffsetDigest)
        && typeof drop.meta.dropMac === "string" && SHA256.test(drop.meta.dropMac)
      const providerInvocationCount = newTurns.reduce((sum, turn) => sum + turn.providerTurnCount, 0)
      const toolInvocationCount = newTurns.reduce((sum, turn) => sum + turn.toolInvocationCount, 0)
      const durableToolRecordCount = delta(after, before, "senses.sanctuary_read_receipt")
      const workItemCount = newApprovals.length
      const sessionStateUnchanged = Boolean(before.identity && after.identity
        && typeof before.identity.sessionSurfaceDigest === "string" && SHA256.test(before.identity.sessionSurfaceDigest)
        && before.identity.sessionSurfaceDigest === after.identity.sessionSurfaceDigest
        && typeof before.identity.friendSurfaceDigest === "string" && SHA256.test(before.identity.friendSurfaceDigest)
        && before.identity.friendSurfaceDigest === after.identity.friendSurfaceDigest)
      const forbiddenWorkEvent = freshEvents.some((entry) => entry.event === "senses.telegram_turn_start" || entry.event === "senses.telegram_turn_end"
        || entry.event === "senses.telegram_turn_error" || entry.event === "senses.sanctuary_read_receipt"
        || entry.event.startsWith("senses.telegram_approved_restart_") || entry.event === "senses.sanctuary_health_delivered")
      const offsetAdvanced = Number.isSafeInteger(before.telegramNextUpdateId) && Number.isSafeInteger(after.telegramNextUpdateId)
        && Number(after.telegramNextUpdateId) === Number(before.telegramNextUpdateId) + 1
      const zeroWorkUnchanged = Boolean(before.zeroWork && after.zeroWork
        && before.zeroWork.providerToolDigest === after.zeroWork.providerToolDigest
        && before.zeroWork.outwardDigest === after.zeroWork.outwardDigest
        && before.zeroWork.approvalMutationDigest === after.zeroWork.approvalMutationDigest
        && before.zeroWork.sessionFriendDigest === after.zeroWork.sessionFriendDigest)
      if (!after.containment || !exactContainmentAudit(after.containment) || !distinctAccount || !offsetAdvanced || !zeroWorkUnchanged || !sessionStateUnchanged || newTurns.length !== 0 || providerInvocationCount !== 0 || toolInvocationCount !== 0 || telegramResponses !== 0 || workItemCount !== 0 || approvalTransitions !== 0 || newAttempts.length !== 0 || scenarioMutationCount !== 0 || durableToolRecordCount !== 0 || forbiddenWorkEvent) return null
      return { auditRejected: true, distinctAccount, mutationCount: 0, providerInvocationCount: 0, responseCount: 0, workItemCount: 0 }
    }
    case "unit-16e-containment-audit":
      if (!after.containment || !exactContainmentAudit(after.containment) || scenarioMutationCount !== 0) return null
      return {
        schemaVersion: after.containment.schemaVersion,
        keyCount: after.containment.keyCount, keyInventoryDigest: after.containment.keyInventoryDigest,
        readScopeDigest: after.containment.readScopeDigest, writeScopeDigest: after.containment.writeScopeDigest,
        keyRoleAssignmentCount: after.containment.keyRoleAssignmentCount,
        telegramToolCount: after.containment.telegramToolCount, telegramProfileDigest: after.containment.telegramProfileDigest,
        telegramSchemaDigest: after.containment.telegramSchemaDigest,
        privateToolCount: after.containment.privateToolCount, privateProfileDigest: after.containment.privateProfileDigest,
        privateSchemaDigest: after.containment.privateSchemaDigest, resolvedHandlerCount: after.containment.resolvedHandlerCount,
        excludedToolCount: after.containment.excludedToolCount, excludedSchemaIntersectionCount: after.containment.excludedSchemaIntersectionCount,
        fabricatedHandlerInvocationCount: after.containment.fabricatedHandlerInvocationCount,
        excludedToolAttemptCount: after.containment.excludedToolAttemptCount, excludedToolRejectedCount: after.containment.excludedToolRejectedCount,
        excludedToolInvokedCount: after.containment.excludedToolInvokedCount, excludedToolSideEffectCount: after.containment.excludedToolSideEffectCount,
        globallyResolvableExcludedToolCount: after.containment.globallyResolvableExcludedToolCount,
        auditPathDigest: after.containment.auditPathDigest, auditLedgerDigest: after.containment.auditLedgerDigest,
        auditRecordCount: after.containment.auditRecordCount, auditLifecyclePairCount: after.containment.auditLifecyclePairCount,
        containerUser: after.containment.containerUser, liveProcessUser: after.containment.liveProcessUser, mountCount: after.containment.mountCount,
        publishedPortCount: after.containment.publishedPortCount, networkMode: after.containment.networkMode,
        readOnlyRoot: after.containment.readOnlyRoot, mountsExact: after.containment.mountsExact,
        securityExact: after.containment.securityExact, updaterDisabled: after.containment.updaterDisabled,
        writableKeyExposure: after.containment.writableKeyExposure,
        rawWriteMaterialFieldCount: after.containment.rawWriteMaterialFieldCount,
        typedWriteExecutorCount: after.containment.typedWriteExecutorCount,
        writeApprovalPolicyDigest: after.containment.writeApprovalPolicyDigest,
        sensitiveMaterialObserved: after.containment.sensitiveMaterialObserved,
        mutationCount: scenarioMutationCount,
      }
    case "unit-16e-1-stop-denial":
    case "unit-16e-2-restart-denial": {
      const receipt = after.denial
      const expectedOperation = label === "unit-16e-1-stop-denial" ? "stop" : "restart"
      if (!receipt || receipt.label !== label || receipt.operation !== expectedOperation || receipt.scenarioHandleDigest.length !== 64
        || receipt.attemptCount !== 1 || ![200, 401, 403].includes(receipt.httpStatus)
        || (receipt.errorCode !== "FORBIDDEN" && receipt.errorCode !== "PERMISSION_DENIED")
        || receipt.targetDigest !== receipt.before.targetContainerIdDigest || receipt.targetDigest !== receipt.after.targetContainerIdDigest
        || JSON.stringify(receipt.before) !== JSON.stringify(receipt.after) || scenarioMutationCount !== 0) return null
      return { attemptCount: receipt.attemptCount, cursorBoundaryCount: 7, denied: true, mutationCount: 0, restartCountUnchanged: true, resumed: true }
    }
    case "unit-16f-cron-fingerprint":
      if (!after.container?.running || !after.container.healthy || !after.healthProbe || !healthProbeRestored(after.healthProbe, after.cron) || after.healthProbe.clockMode !== "ambient" || after.healthProbe.phases.length !== 1
        || !after.healthProbe.schedulerReceipt || after.healthProbe.schedulerReceipt.trigger !== "cron" || after.healthProbe.schedulerReceipt.sweepDelta !== 1
        || after.healthProbe.schedulerReceipt.deliveryDelta !== 0 || after.healthProbe.schedulerReceipt.nonReplay !== true
        || after.healthProbe.schedulerReceipt.sweep.recordDigest !== after.healthProbe.phases[0]?.sweepReceiptDigest
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
      if (!exactFreshTelegramLifecycle(before, after) || !intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "succeeded" || mutationCount !== 1 || scenarioMutationCount !== 1 || !restartSucceeded || approval.replayMutationCount !== 0 || !approval.continuationCompleted) return null
      if (!approval.terminalPrompt) return null
      {
        const evidence = exactApprovalEvidence(before, after, approval)
        const callbackAt = Number(evidence?.callback?.meta.callbackAt)
        if (!evidence || !evidence.callback || !evidence.continuation || callbackAt - evidence.boundAt < 120_000
        || evidence.callback.event !== "telegram.callback_settled" || evidence.callback.meta.accepted !== true || evidence.callback.meta.reason !== "accepted") return null
        return { elapsedMs: callbackAt - evidence.boundAt, mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, resumed: approval.continuationCompleted, state: approval.state }
      }
    case "unit-16j-denial": {
      if (!exactFreshTelegramLifecycle(before, after) || !intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "denied" || scenarioMutationCount !== 0 || approval.replayMutationCount !== 0 || !approval.continuationCompleted) return null
      if (!approval.terminalPrompt) return null
      const evidence = exactApprovalEvidence(before, after, approval)
      if (!evidence?.callback || evidence.callback.event !== "telegram.callback_settled" || !evidence.continuation || evidence.callback.meta.accepted !== false || evidence.callback.meta.reason !== "decision_refused") return null
      return { mutationCount, promptTerminal: approval.terminalPrompt, replayMutationCount: approval.replayMutationCount, resumed: approval.continuationCompleted, state: approval.state }
    }
    case "unit-16k-timeout-stale": {
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.state !== "expired" || scenarioMutationCount !== 0 || approval.replayMutationCount !== 0) return null
      if (!approval.buttonsRemoved || !approval.terminalPrompt || !approval.staleAcknowledged) return null
      const evidence = exactApprovalEvidence(before, after, approval)
      if (!evidence || evidence.callback !== null || evidence.continuation !== null || evidence.staleCallback === null || !terminalizedWithinTtlJitter(evidence)) return null
      const driver = after.interactiveDriver
      if (!driver || driver.label !== "unit-16k-timeout-stale" || !interactiveReceiptBindsApproval(driver, approval)
        || driver.callbackAttempts !== 1 || driver.distinctQueryCount !== 1 || driver.settledCount !== 1
        || driver.claimCount !== 0 || driver.mutationCount !== 0 || !driver.staleAcknowledged || !driver.promptTerminal) return null
      return { buttonsRemoved: approval.buttonsRemoved, mutationCount, promptTerminal: approval.terminalPrompt, staleAcknowledged: approval.staleAcknowledged, staleReplayMutationCount: approval.replayMutationCount, state: approval.state }
    }
    case "unit-16l-duplicate-callback": {
      if (!intendedRestartApproval(approval) || !completeAttemptLedgerLinked || approval.callbackCount < 1 || approval.settledCount < 1 || approval.claimCount !== 1 || !approval.terminalPrompt || approval.replayMutationCount !== 0 || mutationCount !== 1 || scenarioMutationCount !== 1 || !restartSucceeded) return null
      const evidence = exactApprovalEvidence(before, after, approval)
      if (!evidence?.callback || evidence.callback.event !== "telegram.callback_settled" || !evidence.continuation || evidence.callback.meta.accepted !== true || evidence.callback.meta.reason !== "accepted") return null
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
      {
        const evidence = exactApprovalEvidence(before, after, approval)
        if (!evidence?.continuation || !evidence.callback || evidence.callback.event !== "telegram.callback_recovery_settled"
          || evidence.callback.meta.acknowledgementState !== "indeterminate_after_restart"
          || evidence.callback.meta.accepted !== true || evidence.callback.meta.reason !== "accepted"
          || typeof evidence.callback.meta.decisionAttemptDigest !== "string" || !SHA256.test(evidence.callback.meta.decisionAttemptDigest)) return null
      }
      if (!after.interactiveDriver || after.interactiveDriver.label !== "unit-16m-restart-continuation"
        || !interactiveReceiptBindsApproval(after.interactiveDriver, approval)
        || !after.interactiveDriver.pendingRestored || after.interactiveDriver.pendingDigestBefore !== after.interactiveDriver.pendingDigestAfter || after.interactiveDriver.callbackAttempts !== 1 || after.interactiveDriver.mutationCount !== 1
        || after.interactiveDriver.approvalEpochBefore !== after.interactiveDriver.approvalEpochAfterRestart
        || after.interactiveDriver.continuationEpochAfter <= after.interactiveDriver.approvalEpochAfterRestart
        || approval.continuationEpoch !== after.interactiveDriver.continuationEpochAfter || approval.continuationState !== "completed"
        || after.interactiveDriver.restartCountAfter !== after.interactiveDriver.restartCountBefore + 1
        || !after.interactiveDriver.indeterminateRecoveryObserved || !after.interactiveDriver.attemptedRecoveryReopened
        || !SHA256.test(after.interactiveDriver.attemptedRecordDigest) || !SHA256.test(after.interactiveDriver.recoveredRecordDigest)
        || after.interactiveDriver.attemptedRecordDigest === after.interactiveDriver.recoveredRecordDigest
        || after.interactiveDriver.indeterminateRetryCount !== 0) return null
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
    if (READ_ONLY_DENIAL_LABELS.has(input.label)) {
      if (!deps.denialDriver) throw new Error("read-only denial scenario driver is unavailable")
      const driven = await deps.denialDriver.poll(input.label, receipt.scenarioHandleDigest)
      if (driven.state === "waiting") return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
    }
    const after = await deps.readFacts(input.label, receipt.scenarioHandleDigest, factOptions)
    if (input.label === "unit-15c-1-no-callback-terminalization" && !receipt.noCallbackBaseline) {
      const activeApproval = after.approvals.find((approval) => approval.state === "proposed" || approval.state === "claimed")
      if (activeApproval) {
        const baseline = {
          approvalId: activeApproval.approvalId,
          offsetDigest: hash(after.sourceValues["telegram-offset"]),
          inboundEventCount: after.events.filter((entry) => entry.event === "telegram.callback_settled" || entry.event === "telegram.callback_recovery_settled" || entry.event === "telegram.update_dropped").length,
        }
        receipt.noCallbackBaseline = baseline
        receipt.before.sourceValues["no-callback-baseline"] = baseline
        atomicPrivateJson(filePath, receipt)
        return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
      }
    }
    const candidate = deriveSanctuaryScenarioAssertions(input.label, receipt.before, after, deps.now(), receipt.scenarioHandleDigest)
    if (!candidate) return { state: "waiting", checkpointDigest: receipt.checkpointDigest }
    const assertions = validateSanctuaryUnit16EvidenceAssertions(input.label, candidate)
    const sourceDigests = Object.fromEntries(input.sources.map((source) => [source, hash(after.sourceValues[source])]))
    if (HEALTH_SCENARIO_LABELS.has(input.label)) await deps.healthDriver!.recover(input.label, receipt.scenarioHandleDigest)
    if (INTERACTIVE_DRIVER_LABELS.has(input.label) && await deps.interactiveDriver!.complete(input.label, receipt.scenarioHandleDigest) !== "complete") {
      throw new Error("interactive scenario requires inspect-before-retry")
    }
    if (INTERACTIVE_DRIVER_LABELS.has(input.label)) await deps.interactiveDriver!.cleanup(input.label, receipt.scenarioHandleDigest)
    if (READ_ONLY_DENIAL_LABELS.has(input.label)) await deps.denialDriver!.complete(input.label, receipt.scenarioHandleDigest)
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
