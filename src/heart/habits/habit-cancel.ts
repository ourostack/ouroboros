import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import {
  classifyBlueBubblesRecoveryRecord,
  readBlueBubblesSemanticCaptureAtRoot,
  readBlueBubblesSemanticCutoverAtRoot,
} from "../../senses/bluebubbles/semantic-receipts"
import { parseHabitFile } from "./habit-parser"
import {
  HabitLifecycleError,
  HABIT_LIFECYCLE_POLL_MS,
  HABIT_LIFECYCLE_TIMEOUT_MS,
  acquireHabitLifecycleLock,
  buildHabitCancellationOperation,
  buildHabitEvidenceIdentity,
  confirmHabitLifecyclePathDurability,
  createHabitLifecycleJournal,
  getHabitLifecyclePaths,
  habitLifecycleLeaseIsCurrent,
  listHabitLifecycleJournals,
  publishHabitLifecycleReceipt,
  readHabitLifecycleJournal,
  readHabitLifecycleReceipt,
  releaseHabitLifecycleLock,
  renderHabitCancellationAcknowledgement as renderLifecycleAcknowledgement,
  serializeHabitLifecycleJson,
  transitionHabitLifecycleJournal,
  writeHabitLifecycleDefinition,
  writeHabitLifecycleJournal,
  type HabitBoundaryState,
  type HabitCancellationPreparation,
  type HabitCancellationReceipt,
  type HabitLifecycleDeps,
  type HabitLifecycleLease,
} from "./habit-lifecycle"

const CAPTURE_LOCATOR_PATTERN = /^capture:([a-f0-9]{64})$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const BRIDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ISO_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const retainedCancellationLeases = new Map<string, HabitLifecycleLease>()

export const HISTORICAL_HABIT_EVIDENCE_BRIDGE_SHA256 =
  "34a90f6ce3f7b092edb8114cf7ab640486fd7e6d7667acfd0249408fff394201"

export function resolveHistoricalHabitEvidenceBridgeTrust(
  bridgeSha256: string,
  actorDisplayName: string,
): { cancellationReason: string } | null {
  if (bridgeSha256 !== HISTORICAL_HABIT_EVIDENCE_BRIDGE_SHA256) return null
  return {
    cancellationReason:
      `Confirmed requester ${actorDisplayName} asked to end the RSVP report after the wedding.`,
  }
}

export type HabitCancellationAuthority =
  | {
    kind: "current_ingress"
    currentIngressEvidence: Readonly<{
      schemaVersion: 1
      provider: "bluebubbles"
      captureKeyHash: string
    }>
  }
  | { kind: "offline_bridge" }

export interface HabitCancelInput {
  agentRoot: string
  habitId: string
  evidenceLocator: string
  authority: HabitCancellationAuthority
}

export interface HabitCancelDeps extends HabitLifecycleDeps {
  trustedBridge?: (
    bridgeId: string,
    sha256: string,
  ) => { cancellationReason: string } | null
}

interface GroundedCancellationEvidence {
  locator: { kind: "bridge" | "capture"; id: string }
  actor: {
    displayName: string
    provider: string | null
    externalId: string | null
  }
  request: {
    text: string
    sha256: string
    observedAt: string
  }
  cancellationReason: string
}

interface DefinitionSnapshot {
  path: string
  bytes: string
  status: "active" | "paused" | "cancelled"
}

export class HabitCancellationError extends Error {
  readonly code: string

  constructor(code: string, options: { cause?: unknown } = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "HabitCancellationError"
    this.code = code
  }
}

export function renderHabitCancellationAcknowledgement(
  habitId: string,
  actorDisplayName: string,
  boundaryState: HabitBoundaryState,
): string {
  return renderLifecycleAcknowledgement(habitId, actorDisplayName, boundaryState)
}

export function validateHabitEvidenceBridge(
  input: { agentRoot: string; bridgeId: string },
  deps: HabitCancelDeps = {},
): GroundedCancellationEvidence {
  const storeFs = deps.fs ?? fs
  const agentRoot = requiredString(input.agentRoot, "bridge_agent_root_required")
  const bridgeId = validatedBridgeId(input.bridgeId)
  const bridgeRoot = path.join(
    agentRoot,
    "state",
    "senses",
    "bluebubbles",
    "evidence-bridges",
  )
  const bridgePath = path.join(bridgeRoot, `${bridgeId}.json`)
  const bridgeBytes = readUtf8(storeFs, bridgePath, "bridge_evidence_missing")
  const bridgeSha256 = sha256(bridgeBytes)
  const value = parseJsonRecord(bridgeBytes, "bridge_evidence_invalid")
  if (serializeHabitLifecycleJson(value) !== bridgeBytes) {
    throw new HabitCancellationError("bridge_evidence_not_canonical")
  }
  requireExactKeys(value, [
    "schemaVersion",
    "bridgeId",
    "sourceKind",
    "createdAt",
    "confirmedAt",
    "actor",
    "participants",
    "request",
    "evidence",
  ], "bridge_evidence_invalid")
  if (
    value.schemaVersion !== 1
    || value.bridgeId !== bridgeId
    || value.sourceKind !== "operator_confirmation"
    || !isCanonicalTimestamp(value.createdAt)
    || value.confirmedAt !== value.createdAt
  ) throw new HabitCancellationError("bridge_evidence_invalid")

  const actor = requiredRecord(value.actor, "bridge_actor_invalid")
  requireExactKeys(actor, ["displayName", "provider", "externalId"], "bridge_actor_invalid")
  const actorDisplayName = requiredSingleLine(actor.displayName, "bridge_actor_invalid")
  if (actor.provider !== null || actor.externalId !== null) {
    throw new HabitCancellationError("bridge_actor_invalid")
  }

  const trusted = deps.trustedBridge
    ? deps.trustedBridge(bridgeId, bridgeSha256)
    : resolveHistoricalHabitEvidenceBridgeTrust(bridgeSha256, actorDisplayName)
  if (!trusted) throw new HabitCancellationError("bridge_trust_rejected")
  const cancellationReason = requiredSingleLine(
    trusted.cancellationReason,
    "bridge_cancellation_reason_invalid",
  )

  if (!Array.isArray(value.participants) || value.participants.length === 0) {
    throw new HabitCancellationError("bridge_participants_invalid")
  }
  for (const participantValue of value.participants) {
    const participant = requiredRecord(participantValue, "bridge_participants_invalid")
    requireExactKeys(
      participant,
      ["displayName", "provider", "externalId", "role"],
      "bridge_participants_invalid",
    )
    requiredSingleLine(participant.displayName, "bridge_participants_invalid")
    if (
      participant.provider !== null
      || participant.externalId !== null
      || participant.role !== "group_participant_only"
    ) throw new HabitCancellationError("bridge_participants_invalid")
  }

  const request = requiredRecord(value.request, "bridge_request_invalid")
  requireExactKeys(request, ["eventGuid", "text", "sha256"], "bridge_request_invalid")
  const eventGuid = requiredString(request.eventGuid, "bridge_request_invalid")
  const requestText = requiredString(request.text, "bridge_request_invalid")
  const requestSha256 = validatedHash(request.sha256, "bridge_request_invalid")
  if (sha256(requestText) !== requestSha256) {
    throw new HabitCancellationError("bridge_request_invalid")
  }

  const evidence = requiredRecord(value.evidence, "bridge_evidence_invalid")
  requireExactKeys(
    evidence,
    ["operatorConfirmation", "screenshots", "sources"],
    "bridge_evidence_invalid",
  )
  validateOperatorConfirmation(bridgeRoot, evidence.operatorConfirmation, storeFs)
  validateBridgeScreenshots(bridgeRoot, evidence.screenshots, storeFs)
  validateBridgeSources({
    value: evidence.sources,
    eventGuid,
    requestText,
    requestSha256,
    storeFs,
  })

  return {
    locator: { kind: "bridge", id: bridgeId },
    actor: { displayName: actorDisplayName, provider: null, externalId: null },
    request: {
      text: requestText,
      sha256: requestSha256,
      observedAt: value.confirmedAt as string,
    },
    cancellationReason,
  }
}

export async function cancelHabit(
  input: HabitCancelInput,
  deps: HabitCancelDeps = {},
): Promise<HabitCancellationReceipt> {
  let operationId: string | null = null
  let evidenceKeyHash: string | null = null
  let started = false
  try {
    const locator = validatedCancellationLocator(input)
    const identity = buildHabitEvidenceIdentity({
      habitId: input.habitId,
      kind: locator.kind,
      id: locator.id,
    })
    evidenceKeyHash = identity.evidenceKeyHash
    operationId = buildHabitCancellationOperation(evidenceKeyHash).operationId
    emitHabitCancellationStart(input.habitId, operationId, evidenceKeyHash)
    started = true

    readDefinitionSnapshot(input.agentRoot, input.habitId, deps)
    const preflightJournal = readHabitLifecycleJournal({
      agentRoot: input.agentRoot,
      habitId: input.habitId,
      operationId,
    }, deps)
    const initialEvidence = preflightJournal?.state === "cancellation_receipt_committed"
      ? null
      : resolveCancellationEvidence(input, deps)
    const leaseKey = cancellationLeaseKey(input.agentRoot, input.habitId, operationId)
    let lease = retainedCancellationLeases.get(leaseKey)
    if (lease && !habitLifecycleLeaseIsCurrent(lease, deps)) {
      retainedCancellationLeases.delete(leaseKey)
      lease = undefined
    }
    if (!lease) {
      const lock = await acquireHabitLifecycleLock({
        agentRoot: input.agentRoot,
        habitId: input.habitId,
        operationId,
      }, deps)
      if (lock.status !== "acquired") {
        throw new HabitCancellationError(lock.error)
      }
      lease = lock.lease
    }

    let receipt: HabitCancellationReceipt | null = null
    let primaryError: unknown
    try {
      let evidence: GroundedCancellationEvidence | null = null
      if (initialEvidence !== null) {
        evidence = resolveCancellationEvidence(input, deps)
        if (serializeHabitLifecycleJson(evidence) !== serializeHabitLifecycleJson(initialEvidence)) {
          throw new HabitCancellationError("cancellation_evidence_changed")
        }
      }
      const definition = readDefinitionSnapshot(input.agentRoot, input.habitId, deps)
      receipt = executeCancellationUnderLock({
        lease,
        definition,
        evidence,
        evidenceKeyHash,
        operationId,
      }, deps)
    } catch (error) {
      primaryError = error
    }

    let releaseError: unknown
    try {
      await releaseCancellationLease(leaseKey, lease, deps)
    } catch (error) {
      releaseError = error
    }
    if (primaryError !== undefined) throw primaryError
    if (releaseError !== undefined) throw releaseError
    // executeCancellationUnderLock either returns a receipt or supplies primaryError.
    const completedReceipt = receipt as HabitCancellationReceipt

    emitNervesEvent({
      component: "daemon",
      event: "habit_cancel_end",
      message: "grounded habit cancellation completed",
      meta: {
        habitId: input.habitId,
        operationId,
        evidenceKeyHash,
        boundaryState: completedReceipt.transition.boundaryState,
      },
    })
    return completedReceipt
  } catch (error) {
    const wrapped = asCancellationError(error)
    if (!started) emitHabitCancellationStart(input.habitId, operationId, evidenceKeyHash)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "habit_cancel_error",
      message: "grounded habit cancellation failed",
      meta: {
        habitId: input.habitId,
        operationId,
        evidenceKeyHash,
        errorCode: wrapped.code,
      },
    })
    throw wrapped
  }
}

function emitHabitCancellationStart(
  habitId: string,
  operationId: string | null,
  evidenceKeyHash: string | null,
): void {
  emitNervesEvent({
    component: "daemon",
    event: "habit_cancel_start",
    message: "grounded habit cancellation started",
    meta: { habitId, operationId, evidenceKeyHash },
  })
}

function executeCancellationUnderLock(input: {
  lease: HabitLifecycleLease
  definition: DefinitionSnapshot
  evidence: GroundedCancellationEvidence | null
  evidenceKeyHash: string
  operationId: string
}, deps: HabitCancelDeps): HabitCancellationReceipt {
  const { lease, evidence, evidenceKeyHash, operationId } = input
  let definition = input.definition
  let journal = readHabitLifecycleJournal({
    agentRoot: lease.agentRoot,
    habitId: lease.habitId,
    operationId,
  }, deps)
  const existingReceipt = readHabitLifecycleReceipt({
    agentRoot: lease.agentRoot,
    habitId: lease.habitId,
    evidenceKeyHash,
  }, deps)

  if (journal?.state === "cancellation_receipt_committed") {
    if (!existingReceipt) {
      throw new HabitCancellationError("cancellation_committed_state_invalid")
    }
    const committedPreparation = journal.cancellationPreparation as HabitCancellationPreparation
    assertPreparedReceipt(existingReceipt, committedPreparation.receipt, null)
    if (definition.status !== "cancelled") {
      throw new HabitCancellationError("cancellation_definition_state_invalid")
    }
    assertDefinitionMatches(definition.bytes, committedPreparation.definitionCancelledSha256)
    confirmCancellationDurability(
      lease,
      definition.path,
      evidenceKeyHash,
      operationId,
      deps,
    )
    return existingReceipt
  }

  if (evidence === null) throw new HabitCancellationError("cancellation_evidence_required")

  if (journal === null || journal.state === "lock_acquired") {
    if (existingReceipt) throw new HabitCancellationError("cancellation_receipt_without_intent")
    if (definition.status !== "active" && definition.status !== "paused") {
      throw new HabitCancellationError("habit_definition_already_cancelled")
    }
    const cancelledAt = cancellationNow(deps)
    const boundaryState = classifyConcurrentSendBoundary(
      lease.agentRoot,
      lease.habitId,
      evidence.request.observedAt,
      cancelledAt,
      deps,
    )
    const cancelledBytes = renderCancelledDefinition(
      definition,
      evidence.locator,
      evidence.cancellationReason,
      cancelledAt,
    )
    const receipt = buildCancellationReceipt({
      habitId: lease.habitId,
      operationId,
      evidenceKeyHash,
      evidence,
      fromStatus: definition.status,
      cancelledAt,
      boundaryState,
    })
    const preparation: HabitCancellationPreparation = {
      receipt,
      definitionBeforeSha256: sha256(definition.bytes),
      definitionCancelledSha256: sha256(cancelledBytes),
    }
    if (journal === null) {
      journal = createHabitLifecycleJournal({
        habitId: lease.habitId,
        operationId,
        operationKind: "cancel",
        updatedAt: cancelledAt,
      })
      writeHabitLifecycleJournal(lease, journal, deps)
    }
    journal = transitionHabitLifecycleJournal(journal, {
      state: "cancellation_intent",
      at: cancelledAt,
      evidenceKeyHash,
      cancellationPreparation: preparation,
    })
    writeHabitLifecycleJournal(lease, journal, deps)
  }

  const preparation = journal.cancellationPreparation as HabitCancellationPreparation
  assertPreparedReceipt(preparation.receipt, preparation.receipt, evidence)
  const journalPath = getHabitLifecyclePaths({
    agentRoot: lease.agentRoot,
    habitId: lease.habitId,
    operationId,
  }).journal!
  confirmHabitLifecyclePathDurability(lease, journalPath, deps)
  const definitionHash = sha256(definition.bytes)
  if (definitionHash === preparation.definitionBeforeSha256) {
    if (
      (definition.status !== "active" && definition.status !== "paused")
      || definition.status !== preparation.receipt.transition.fromStatus
    ) {
      throw new HabitCancellationError("cancellation_definition_state_invalid")
    }
    if (journal.state !== "cancellation_intent") {
      throw new HabitCancellationError("cancellation_definition_state_invalid")
    }
    const cancelledBytes = renderCancelledDefinition(
      definition,
      evidence.locator,
      evidence.cancellationReason,
      preparation.receipt.transition.cancelledAt,
    )
    if (sha256(cancelledBytes) !== preparation.definitionCancelledSha256) {
      throw new HabitCancellationError("cancellation_definition_digest_mismatch")
    }
    writeHabitLifecycleDefinition(lease, definition.path, cancelledBytes, deps)
    definition = { path: definition.path, bytes: cancelledBytes, status: "cancelled" }
  } else {
    if (definitionHash !== preparation.definitionCancelledSha256) {
      throw new HabitCancellationError("cancellation_definition_digest_mismatch")
    }
    if (definition.status !== "cancelled") {
      throw new HabitCancellationError("cancellation_definition_state_invalid")
    }
    confirmHabitLifecyclePathDurability(lease, definition.path, deps)
  }

  if (journal.state === "cancellation_intent") {
    journal = transitionHabitLifecycleJournal(journal, {
      state: "definition_cancelled",
      at: preparation.receipt.transition.cancelledAt,
      boundaryState: preparation.receipt.transition.boundaryState,
    })
    writeHabitLifecycleJournal(lease, journal, deps)
  }
  confirmHabitLifecyclePathDurability(lease, journalPath, deps)

  if (existingReceipt) {
    assertPreparedReceipt(existingReceipt, preparation.receipt, evidence)
    const receiptPath = getHabitLifecyclePaths({
      agentRoot: lease.agentRoot,
      habitId: lease.habitId,
      evidenceKeyHash,
    }).receipt!
    confirmHabitLifecyclePathDurability(lease, receiptPath, deps)
  } else {
    publishHabitLifecycleReceipt(lease, evidenceKeyHash, preparation.receipt, deps)
  }
  journal = transitionHabitLifecycleJournal(journal, {
    state: "cancellation_receipt_committed",
    at: preparation.receipt.createdAt,
  })
  writeHabitLifecycleJournal(lease, journal, deps)
  return preparation.receipt
}

function cancellationLeaseKey(
  agentRoot: string,
  habitId: string,
  operationId: string,
): string {
  return JSON.stringify([path.resolve(agentRoot), habitId, operationId])
}

async function releaseCancellationLease(
  leaseKey: string,
  lease: HabitLifecycleLease,
  deps: HabitCancelDeps,
): Promise<void> {
  const attempts = Math.floor(HABIT_LIFECYCLE_TIMEOUT_MS / HABIT_LIFECYCLE_POLL_MS) + 1
  const wait = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let released: boolean
    try {
      released = releaseHabitLifecycleLock(lease, deps)
    } catch (error) {
      retainedCancellationLeases.set(leaseKey, lease)
      throw new HabitCancellationError("lifecycle_lock_release_failed", { cause: error })
    }
    if (released) {
      retainedCancellationLeases.delete(leaseKey)
      return
    }
    if (attempt + 1 < attempts) await wait(HABIT_LIFECYCLE_POLL_MS)
  }
  retainedCancellationLeases.set(leaseKey, lease)
  throw new HabitCancellationError("lifecycle_lock_release_failed")
}

function confirmCancellationDurability(
  lease: HabitLifecycleLease,
  definitionPath: string,
  evidenceKeyHash: string,
  operationId: string,
  deps: HabitCancelDeps,
): void {
  const paths = getHabitLifecyclePaths({
    agentRoot: lease.agentRoot,
    habitId: lease.habitId,
    evidenceKeyHash,
    operationId,
  })
  confirmHabitLifecyclePathDurability(lease, paths.journal!, deps)
  confirmHabitLifecyclePathDurability(lease, definitionPath, deps)
  confirmHabitLifecyclePathDurability(lease, paths.receipt!, deps)
}

function resolveCancellationEvidence(
  input: HabitCancelInput,
  deps: HabitCancelDeps,
): GroundedCancellationEvidence {
  const locator = validatedCancellationLocator(input)
  if (locator.kind === "capture") return validateCaptureEvidence(input.agentRoot, locator.id, deps)
  return validateHabitEvidenceBridge({
    agentRoot: input.agentRoot,
    bridgeId: locator.id,
  }, deps)
}

function validatedCancellationLocator(
  input: HabitCancelInput,
): GroundedCancellationEvidence["locator"] {
  if (!isRecord(input.authority)) throw new HabitCancellationError("cancellation_authority_invalid")
  if (input.authority.kind === "current_ingress") {
    const match = CAPTURE_LOCATOR_PATTERN.exec(input.evidenceLocator)
    if (!match) throw new HabitCancellationError("capture_evidence_locator_invalid")
    const current = input.authority.currentIngressEvidence
    if (
      !isRecord(current)
      || Object.keys(current).length !== 3
      || current.schemaVersion !== 1
      || current.provider !== "bluebubbles"
      || typeof current.captureKeyHash !== "string"
      || !HASH_PATTERN.test(current.captureKeyHash)
    ) throw new HabitCancellationError("current_ingress_evidence_invalid")
    if (match[1] !== current.captureKeyHash) {
      throw new HabitCancellationError("evidence_capture_mismatch")
    }
    return { kind: "capture", id: match[1] }
  }
  if (input.authority.kind !== "offline_bridge") {
    throw new HabitCancellationError("cancellation_authority_invalid")
  }
  if (CAPTURE_LOCATOR_PATTERN.test(input.evidenceLocator)) {
    throw new HabitCancellationError("offline_capture_evidence_forbidden")
  }
  return { kind: "bridge", id: validatedBridgeId(input.evidenceLocator) }
}

function validateCaptureEvidence(
  agentRoot: string,
  captureKeyHash: string,
  deps: HabitCancelDeps,
): GroundedCancellationEvidence {
  const cutover = readBlueBubblesSemanticCutoverAtRoot(agentRoot, deps)
  if (!cutover) throw new HabitCancellationError("capture_cutover_invalid")
  const capture = readBlueBubblesSemanticCaptureAtRoot(agentRoot, captureKeyHash, deps)
  if (!capture) throw new HabitCancellationError("capture_evidence_missing_or_invalid")
  const disposition = classifyBlueBubblesRecoveryRecord(capture, cutover)
  if (disposition.disposition !== "handleable" || disposition.keyHash !== captureKeyHash) {
    throw new HabitCancellationError("capture_evidence_not_handleable")
  }
  const event = capture.event
  if (
    capture.keyHash !== captureKeyHash
    || capture.providerNamespace !== cutover.providerNamespace
    || capture.capturedAt < cutover.effectiveAt
    || event.provider !== "bluebubbles"
    || event.kind !== "message"
    || event.fromMe
    || typeof event.text !== "string"
    || event.text.length === 0
    || typeof event.textSha256 !== "string"
    || event.textSha256 !== sha256(event.text)
    || event.actor.provider !== "imessage-handle"
    || typeof event.actor.externalId !== "string"
    || event.actor.externalId.trim().length === 0
    || typeof event.actor.displayName !== "string"
  ) throw new HabitCancellationError("capture_message_evidence_invalid")
  const displayName = requiredSingleLine(event.actor.displayName, "capture_actor_invalid")
  return {
    locator: { kind: "capture", id: captureKeyHash },
    actor: {
      displayName,
      provider: event.actor.provider,
      externalId: event.actor.externalId,
    },
    request: {
      text: event.text,
      sha256: event.textSha256,
      observedAt: capture.capturedAt,
    },
    cancellationReason: `Confirmed requester ${displayName} asked to end this habit.`,
  }
}

function readDefinitionSnapshot(
  agentRoot: string,
  habitId: string,
  deps: HabitCancelDeps,
): DefinitionSnapshot {
  const definitionPath = path.join(agentRoot, "habits", `${habitId}.md`)
  let bytes: string
  try {
    bytes = (deps.fs ?? fs).readFileSync(definitionPath, "utf8")
  } catch (error) {
    throw new HabitCancellationError("habit_definition_missing_or_unreadable", { cause: error })
  }
  const parsed = parseHabitFile(bytes, definitionPath)
  if (parsed.status === "degraded") {
    throw new HabitCancellationError(`habit_definition_degraded:${parsed.degradedReason}`)
  }
  return { path: definitionPath, bytes, status: parsed.status }
}

function renderCancelledDefinition(
  definition: DefinitionSnapshot,
  locator: GroundedCancellationEvidence["locator"],
  cancellationReason: string,
  cancelledAt: string,
): string {
  const evidenceValue = locator.kind === "capture" ? `capture:${locator.id}` : locator.id
  const lineEnding = definition.bytes.includes("\r\n") ? "\r\n" : "\n"
  const lifecycleLines = [
    "status: cancelled",
    `cancelledAt: ${cancelledAt}`,
    `cancelledEvidence: ${evidenceValue}`,
    `cancelledReason: ${requiredSingleLine(cancellationReason, "cancellation_reason_invalid")}`,
  ].join(lineEnding)
  const bomLength = definition.bytes.startsWith("\uFEFF") ? 1 : 0
  const lines = physicalLines(definition.bytes)
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.content.trim() === "---")
  const hasFrontmatter = lines[0]?.content.trim() === "---" && closingIndex > 0
  const frontmatterLines = hasFrontmatter ? lines.slice(1, closingIndex) : []
  if (frontmatterLines.some((line) => /^(?:cancelledAt|cancelledEvidence|cancelledReason):/.test(line.content))) {
    throw new HabitCancellationError("habit_definition_lifecycle_lines_invalid")
  }
  const statusLines = frontmatterLines.filter((line) => /^status:/.test(line.content))
  if (statusLines.length > 1) throw new HabitCancellationError("habit_definition_status_line_invalid")
  if (statusLines.length === 1) {
    const statusLine = statusLines[0]
    return `${definition.bytes.slice(0, statusLine.start)}${lifecycleLines}${definition.bytes.slice(statusLine.contentEnd)}`
  }
  if (hasFrontmatter) {
    const closing = lines[closingIndex]
    return `${definition.bytes.slice(0, closing.start)}${lifecycleLines}${lineEnding}${definition.bytes.slice(closing.start)}`
  }
  return `${definition.bytes.slice(0, bomLength)}---${lineEnding}${lifecycleLines}${lineEnding}---${lineEnding}${definition.bytes.slice(bomLength)}`
}

function physicalLines(value: string): Array<{
  content: string
  start: number
  contentEnd: number
}> {
  const lines: Array<{ content: string; start: number; contentEnd: number }> = []
  let start = 0
  while (start < value.length) {
    const newline = value.indexOf("\n", start)
    const end = newline === -1 ? value.length : newline + 1
    const raw = value.slice(start, end)
    const content = raw.endsWith("\r\n")
      ? raw.slice(0, -2)
      : raw.endsWith("\n")
        ? raw.slice(0, -1)
        : raw
    lines.push({ content, start, contentEnd: start + content.length })
    start = end
  }
  return lines
}

function buildCancellationReceipt(input: {
  habitId: string
  operationId: string
  evidenceKeyHash: string
  evidence: GroundedCancellationEvidence
  fromStatus: "active" | "paused"
  cancelledAt: string
  boundaryState: HabitBoundaryState
}): HabitCancellationReceipt {
  const acknowledgement = renderHabitCancellationAcknowledgement(
    input.habitId,
    input.evidence.actor.displayName,
    input.boundaryState,
  )
  return {
    schemaVersion: 1,
    habitId: input.habitId,
    operationId: input.operationId,
    evidenceKeyHash: input.evidenceKeyHash,
    evidenceLocator: input.evidence.locator,
    actor: input.evidence.actor,
    request: input.evidence.request,
    transition: {
      fromStatus: input.fromStatus,
      toStatus: "cancelled",
      cancelledAt: input.cancelledAt,
      boundaryState: input.boundaryState,
    },
    acknowledgement,
    createdAt: input.cancelledAt,
  }
}

function classifyConcurrentSendBoundary(
  agentRoot: string,
  habitId: string,
  requestObservedAt: string,
  cancelledAt: string,
  deps: HabitCancelDeps,
): HabitBoundaryState {
  const candidates = listHabitLifecycleJournals({ agentRoot, habitId }, deps)
    .filter((journal) => journal.operationKind === "send"
      && journal.intentAt !== null
      && journal.intentAt <= cancelledAt
      && (journal.classifiedAt === null || journal.classifiedAt >= requestObservedAt))
  if (candidates.some((journal) => journal.state === "crossed")) return "crossed"
  if (candidates.some((journal) => (
    journal.state === "crossing_unknown" || journal.state === "send_intent"
  ))) return "crossing_unknown"
  return "not_crossed"
}

function assertPreparedReceipt(
  actual: HabitCancellationReceipt,
  prepared: HabitCancellationReceipt,
  evidence: GroundedCancellationEvidence | null,
): void {
  if (
    serializeHabitLifecycleJson(actual) !== serializeHabitLifecycleJson(prepared)
    || (evidence !== null && (
      serializeHabitLifecycleJson(prepared.evidenceLocator) !== serializeHabitLifecycleJson(evidence.locator)
      || serializeHabitLifecycleJson(prepared.actor) !== serializeHabitLifecycleJson(evidence.actor)
      || serializeHabitLifecycleJson(prepared.request) !== serializeHabitLifecycleJson(evidence.request)
    ))
  ) throw new HabitCancellationError("cancellation_prepared_receipt_mismatch")
}

function assertDefinitionMatches(bytes: string, expectedSha256: string): void {
  if (sha256(bytes) !== expectedSha256) {
    throw new HabitCancellationError("cancellation_definition_digest_mismatch")
  }
}

function validateOperatorConfirmation(
  bridgeRoot: string,
  raw: unknown,
  storeFs: typeof fs,
): void {
  const value = requiredRecord(raw, "bridge_confirmation_invalid")
  requireExactKeys(value, ["path", "sha256"], "bridge_confirmation_invalid")
  const relativePath = validatedArtifactPath(value.path, "bridge_confirmation_invalid")
  const expectedSha256 = validatedHash(value.sha256, "bridge_confirmation_invalid")
  const bytes = readUtf8(storeFs, path.join(bridgeRoot, relativePath), "bridge_confirmation_invalid")
  if (sha256(bytes) !== expectedSha256 || !bytes.endsWith("\n") || bytes.endsWith("\n\n") || bytes.includes("\r")) {
    throw new HabitCancellationError("bridge_confirmation_invalid")
  }
}

function validateBridgeScreenshots(
  bridgeRoot: string,
  raw: unknown,
  storeFs: typeof fs,
): void {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new HabitCancellationError("bridge_screenshots_invalid")
  }
  raw.forEach((entry, index) => {
    const value = requiredRecord(entry, "bridge_screenshots_invalid")
    requireExactKeys(
      value,
      ["index", "sourcePath", "artifactPath", "sha256"],
      "bridge_screenshots_invalid",
    )
    if (value.index !== index + 1) throw new HabitCancellationError("bridge_screenshots_invalid")
    const sourcePath = requiredString(value.sourcePath, "bridge_screenshots_invalid")
    if (!path.isAbsolute(sourcePath)) throw new HabitCancellationError("bridge_screenshots_invalid")
    const artifactPath = validatedArtifactPath(value.artifactPath, "bridge_screenshots_invalid")
    const expectedSha256 = validatedHash(value.sha256, "bridge_screenshots_invalid")
    const artifactBytes = readBuffer(
      storeFs,
      path.join(bridgeRoot, artifactPath),
      "bridge_screenshots_invalid",
    )
    if (sha256(artifactBytes) !== expectedSha256) {
      throw new HabitCancellationError("bridge_screenshots_invalid")
    }
  })
}

function validateBridgeSources(input: {
  value: unknown
  eventGuid: string
  requestText: string
  requestSha256: string
  storeFs: typeof fs
}): void {
  if (!Array.isArray(input.value) || input.value.length !== 3) {
    throw new HabitCancellationError("bridge_sources_invalid")
  }
  const [inboundRaw, sessionRaw, contextRaw] = input.value
  const inbound = requiredRecord(inboundRaw, "bridge_inbound_evidence_invalid")
  requireExactKeys(
    inbound,
    ["role", "path", "fileSha256", "eventGuid", "requestSha256"],
    "bridge_inbound_evidence_invalid",
  )
  if (
    inbound.role !== "inbound_request"
    || inbound.eventGuid !== input.eventGuid
    || inbound.requestSha256 !== input.requestSha256
  ) throw new HabitCancellationError("bridge_inbound_evidence_invalid")
  const inboundBytes = validatedSourceBytes(inbound, input.storeFs, "bridge_inbound_evidence_invalid")
  const inboundRows = inboundBytes.split("\n").filter((line) => line.length > 0).map((line) => {
    const row = parseJsonRecord(line, "bridge_inbound_evidence_invalid")
    return row
  }).filter((row) => row.messageGuid === input.eventGuid)
  if (
    inboundRows.length !== 1
    || inboundRows[0].textForAgent !== input.requestText
    || sha256(String(inboundRows[0].textForAgent)) !== input.requestSha256
  ) throw new HabitCancellationError("bridge_inbound_request_invalid")

  const session = requiredRecord(sessionRaw, "bridge_session_evidence_invalid")
  requireExactKeys(
    session,
    ["role", "path", "fileSha256", "eventId", "normalizedRequestSha256"],
    "bridge_session_evidence_invalid",
  )
  if (
    session.role !== "session_rendering"
    || session.normalizedRequestSha256 !== input.requestSha256
  ) throw new HabitCancellationError("bridge_session_evidence_invalid")
  const sessionBytes = validatedSourceBytes(session, input.storeFs, "bridge_session_evidence_invalid")
  const sessionValue = parseJsonRecord(sessionBytes, "bridge_session_evidence_invalid")
  if (!Array.isArray(sessionValue.events)) throw new HabitCancellationError("bridge_session_evidence_invalid")
  const sessionEvents = sessionValue.events.filter((entry) => (
    isRecord(entry) && entry.id === session.eventId
  )) as Array<Record<string, unknown>>
  if (sessionEvents.length !== 1 || typeof sessionEvents[0].content !== "string") {
    throw new HabitCancellationError("bridge_session_evidence_invalid")
  }
  const prefixEnd = sessionEvents[0].content.indexOf(": ")
  if (prefixEnd < 0) throw new HabitCancellationError("bridge_session_normalization_invalid")
  const normalized = sessionEvents[0].content.slice(prefixEnd + 2)
  if (normalized !== input.requestText || sha256(normalized) !== input.requestSha256) {
    throw new HabitCancellationError("bridge_session_normalization_invalid")
  }

  const context = requiredRecord(contextRaw, "bridge_context_evidence_invalid")
  requireExactKeys(
    context,
    ["role", "path", "fileSha256", "eventGuid"],
    "bridge_context_evidence_invalid",
  )
  if (context.role !== "context_chronology" || context.eventGuid !== input.eventGuid) {
    throw new HabitCancellationError("bridge_context_evidence_invalid")
  }
  const contextBytes = validatedSourceBytes(context, input.storeFs, "bridge_context_evidence_invalid")
  const contextValue = parseJsonRecord(contextBytes, "bridge_context_evidence_invalid")
  if (
    contextValue.anchorMessageGuid !== input.eventGuid
    || !Array.isArray(contextValue.messages)
    || contextValue.messages.length !== 2
    || contextValue.messages.some((entry) => (
      !isRecord(entry)
      || typeof entry.authorLabel !== "string"
      || typeof entry.bodyPreview !== "string"
      || typeof entry.timestamp !== "string"
    ))
  ) throw new HabitCancellationError("bridge_context_evidence_invalid")
}

function validatedSourceBytes(
  value: Record<string, unknown>,
  storeFs: typeof fs,
  code: string,
): string {
  const sourcePath = requiredString(value.path, code)
  const expectedSha256 = validatedHash(value.fileSha256, code)
  const bytes = readUtf8(storeFs, sourcePath, code)
  if (sha256(bytes) !== expectedSha256) throw new HabitCancellationError(code)
  return bytes
}

function validatedArtifactPath(value: unknown, code: string): string {
  const relativePath = requiredString(value, code)
  if (path.basename(relativePath) !== relativePath || relativePath === "." || relativePath === "..") {
    throw new HabitCancellationError(code)
  }
  return relativePath
}

function cancellationNow(deps: HabitCancelDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HabitCancellationError(code)
  return value
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new HabitCancellationError(code)
  }
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HabitCancellationError(code)
  }
  return value
}

function requiredSingleLine(value: unknown, code: string): string {
  const text = requiredString(value, code)
  if (/[\r\n]/.test(text)) throw new HabitCancellationError(code)
  return text
}

function validatedHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new HabitCancellationError(code)
  }
  return value
}

function validatedBridgeId(value: unknown): string {
  const bridgeId = requiredString(value, "bridge_id_invalid")
  if (!BRIDGE_ID_PATTERN.test(bridgeId) || bridgeId === "." || bridgeId === "..") {
    throw new HabitCancellationError("bridge_id_invalid")
  }
  return bridgeId
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_MILLISECONDS_PATTERN.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function readUtf8(storeFs: typeof fs, filePath: string, code: string): string {
  try {
    return storeFs.readFileSync(filePath, "utf8")
  } catch (error) {
    throw new HabitCancellationError(code, { cause: error })
  }
}

function readBuffer(storeFs: typeof fs, filePath: string, code: string): Buffer {
  try {
    return storeFs.readFileSync(filePath)
  } catch (error) {
    throw new HabitCancellationError(code, { cause: error })
  }
}

function parseJsonRecord(bytes: string, code: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch (error) {
    throw new HabitCancellationError(code, { cause: error })
  }
  return requiredRecord(value, code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function asCancellationError(error: unknown): HabitCancellationError {
  if (error instanceof HabitCancellationError) return error
  if (error instanceof HabitLifecycleError) {
    return new HabitCancellationError(error.code, { cause: error })
  }
  return new HabitCancellationError("habit_cancellation_failed", { cause: error })
}
