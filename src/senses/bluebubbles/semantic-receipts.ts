import { createHash, randomUUID as createRandomUuid } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"

import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type {
  BlueBubblesSemanticCaptureV1,
  IngressCanonicalAction,
  IngressCanonicalValue,
  IngressTargetAuthorship,
  ObservedIngressIdentity,
} from "../ingress-evidence"
import type { BlueBubblesNormalizedEvent } from "./model"

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CUTOVER_KEYS = ["schemaVersion", "providerNamespace", "effectiveAt"]
const CANONICAL_VALUES = new Set<Exclude<IngressCanonicalValue, null>>([
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
  "custom",
  "unknown",
])
const CANONICAL_ACTIONS = new Set<Exclude<IngressCanonicalAction, null>>(["add", "remove"])
const SEMANTIC_KEY_HASH_PATTERN = /^[0-9a-f]{64}$/
const SEMANTIC_CLAIM_POLL_MS = 50
const SEMANTIC_CLAIM_TIMEOUT_MS = 5_000
const SEMANTIC_OWNERSHIP_SCHEMA_VERSION = 1
const SEMANTIC_OWNERSHIP_SCHEMA_SQL = `CREATE TABLE owner_leases (
      resource_key TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      owner_json TEXT NOT NULL
    ) STRICT, WITHOUT ROWID`
const CAPTURE_KEYS = ["schemaVersion", "canonicalKey", "keyHash", "providerNamespace", "capturedAt", "event"]
const CAPTURE_EVENT_KEYS = [
  "provider",
  "kind",
  "eventGuid",
  "fromMe",
  "actor",
  "participants",
  "sourceEventType",
  "sessionKey",
  "chatGuid",
  "chatIdentifier",
  "text",
  "textSha256",
  "targetGuid",
  "targetAuthorship",
  "canonicalAction",
  "canonicalValue",
  "rawTransportValue",
  "effectiveAt",
  "revision",
  "contentSha256",
]
const OBSERVED_IDENTITY_KEYS = ["provider", "externalId", "displayName"]
const CLAIM_KEYS = ["schemaVersion", "canonicalKey", "keyHash", "owner"]
const CLAIM_OWNER_KEYS = ["operationId", "pid", "bootIdentity", "processStartedAt", "acquiredAt"]
const HANDLED_KEYS = ["schemaVersion", "canonicalKey", "keyHash", "handledAt", "outcome", "detailCode"]
const COORDINATE_KEYS = [
  "schemaVersion",
  "coordinateKey",
  "coordinateHash",
  "generation",
  "lastAction",
  "updatedAt",
]
const SEMANTIC_EVENT_KINDS = new Set(["message", "reaction", "edit", "unsend", "read", "delivery"])
const SEMANTIC_HANDLED_OUTCOMES = new Set<BlueBubblesSemanticHandledOutcome>([
  "ignored_self",
  "capture_only_removal",
  "capture_only_positive",
  "capture_only_custom",
  "capture_only_unknown",
  "capture_only_target_not_agent",
  "capture_only_untrusted_actor",
  "restricted_feedback_settled",
  "restricted_feedback_observed",
  "restricted_feedback_failed",
  "message_completed",
  "message_observed",
  "message_failed",
  "edit_capture_only",
  "unsend_capture_only",
  "read_audit_only",
  "delivery_audit_only",
])
const lastOwnerAcquisitionMs = new Map<string, number>()
const semanticClaimLeaseIds = new WeakMap<BlueBubblesSemanticClaimLease, string>()

export interface BlueBubblesSemanticCutover {
  schemaVersion: 1
  providerNamespace: string
  effectiveAt: string
}

export interface BlueBubblesSemanticPaths {
  root: string
  cutover: string
  captures: string
  handled: string
  claims: string
  coordinates: string
  quarantine: string
  ownership: string
}

export interface BlueBubblesSemanticCutoverDeps {
  now?: () => Date
  randomUUID?: () => string
}

export interface BlueBubblesSemanticIdentityInput {
  providerNamespace: unknown
  kind: "message" | "reaction" | "edit" | "unsend" | "read" | "delivery"
  eventGuid?: unknown
  targetGuid?: unknown
  actorExternalId?: unknown
  canonicalValue?: Exclude<IngressCanonicalValue, null>
  canonicalAction?: Exclude<IngressCanonicalAction, null>
  revision?: unknown
  effectiveTimestamp?: unknown
  text?: unknown
  coordinateGeneration?: unknown
  sessionKey?: unknown
  chatGuid?: unknown
  sourceEventType?: unknown
}

export interface BlueBubblesSemanticIdentity {
  canonicalKey: string
  keyHash: string
  handleable: boolean
  discriminator: string | null
  coordinateKey: string | null
  coordinateHash: string | null
}

export interface BlueBubblesSemanticCaptureInput {
  cutover: BlueBubblesSemanticCutover
  capturedAt: string
  event: BlueBubblesNormalizedEvent
  targetAuthorship: IngressTargetAuthorship
  coordinateGeneration?: number
}

export interface BlueBubblesReactionCoordinateRecord {
  schemaVersion: 1
  coordinateKey: string
  coordinateHash: string
  generation: number
  lastAction: "add" | "remove"
  updatedAt: string
}

export interface BlueBubblesSemanticClaimRecord {
  schemaVersion: 1
  canonicalKey: string
  keyHash: string
  owner: {
    operationId: string
    pid: number
    bootIdentity: string
    processStartedAt: string
    acquiredAt: string
  }
}

export type BlueBubblesSemanticHandledOutcome =
  | "ignored_self"
  | "capture_only_removal"
  | "capture_only_positive"
  | "capture_only_custom"
  | "capture_only_unknown"
  | "capture_only_target_not_agent"
  | "capture_only_untrusted_actor"
  | "restricted_feedback_settled"
  | "restricted_feedback_observed"
  | "restricted_feedback_failed"
  | "message_completed"
  | "message_observed"
  | "message_failed"
  | "edit_capture_only"
  | "unsend_capture_only"
  | "read_audit_only"
  | "delivery_audit_only"

export interface BlueBubblesSemanticHandledRecord {
  schemaVersion: 1
  canonicalKey: string
  keyHash: string
  handledAt: string
  outcome: BlueBubblesSemanticHandledOutcome
  detailCode: string | null
}

export interface BlueBubblesSemanticStoreDeps {
  fs?: typeof fs
  now?: () => Date
  randomUUID?: () => string
  pid?: () => number
  bootIdentity?: () => string
  processStartedAt?: (pid: number) => string | null
  isProcessAlive?: (pid: number) => boolean
  sleep?: (milliseconds: number) => Promise<void>
  sleepSync?: (milliseconds: number) => void
  platform?: NodeJS.Platform
  execFileSync?: typeof execFileSync
  kill?: typeof process.kill
  uptime?: () => number
}

export interface BlueBubblesSemanticClaimLease {
  status: "acquired"
  record: BlueBubblesSemanticClaimRecord
}

export type BlueBubblesSemanticClaimResult =
  | BlueBubblesSemanticClaimLease
  | { status: "already_handled"; record: BlueBubblesSemanticHandledRecord }
  | { status: "timeout"; code: "semantic_claim_timeout" }

export type BlueBubblesSemanticCaptureWriteResult =
  | "semantic_capture_published"
  | "semantic_capture_duplicate"
  | "semantic_identity_collision"

export type BlueBubblesSemanticHandledWriteResult =
  | "semantic_handled_published"
  | "semantic_handled_duplicate"
  | "semantic_handled_collision"

export type BlueBubblesRecoveryDisposition =
  | { disposition: "handleable"; keyHash: string }
  | { disposition: "audit_only"; reason: "legacy_or_actorless" | "before_cutover" | "audit_event" }

export function getBlueBubblesSemanticPaths(agentName: string): BlueBubblesSemanticPaths {
  const root = path.join(
    getAgentRoot(agentName),
    "state",
    "senses",
    "bluebubbles",
    "semantic-receipts",
  )
  return {
    root,
    cutover: path.join(root, "cutover.json"),
    captures: path.join(root, "captures"),
    handled: path.join(root, "handled"),
    claims: path.join(root, "claims"),
    coordinates: path.join(root, "coordinates"),
    quarantine: path.join(root, "quarantine"),
    ownership: path.join(root, "ownership.sqlite"),
  }
}

export function serializeBlueBubblesSemanticJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function normalizeIngressIdentifier(value: unknown): string {
  return String(value).trim().toLowerCase()
}

export function hashIngressActorIdentity(externalId: unknown): string {
  const normalized = normalizeIngressIdentifier(externalId)
  return sha256Utf8(JSON.stringify(["imessage-handle", normalized]))
}

export function normalizeIngressParticipants(
  participants: ObservedIngressIdentity[],
): ObservedIngressIdentity[] {
  return participants
    .map((participant) => ({
      provider: "imessage-handle" as const,
      externalId: normalizeIngressIdentifier(participant.externalId),
      displayName: normalizeDisplayName(participant.displayName),
    }))
    .filter((participant) => participant.externalId.length > 0)
    .sort((left, right) => left.externalId.localeCompare(right.externalId))
}

export function initializeBlueBubblesSemanticCutover(
  agentName: string,
  deps: BlueBubblesSemanticCutoverDeps = {},
): BlueBubblesSemanticCutover {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const existing = readBlueBubblesSemanticCutover(agentName)
  if (existing) return existing
  if (fs.existsSync(paths.cutover)) throw new Error("semantic_cutover_invalid")

  const marker = createCutover(deps)
  fs.mkdirSync(paths.root, { recursive: true })
  const tempPath = path.join(
    paths.root,
    `.cutover.json.${process.pid}.${marker.providerNamespace}.tmp`,
  )
  let tempFd: number | null = null
  let tempOwned = false
  let published = false
  let primaryError: unknown
  try {
    tempFd = fs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    fs.writeFileSync(tempFd, serializeBlueBubblesSemanticJson(marker), "utf8")
    fs.fsyncSync(tempFd)
    fs.closeSync(tempFd)
    tempFd = null
    try {
      fs.linkSync(tempPath, paths.cutover)
      published = true
      fsyncDirectory(paths.root)
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError: unknown
    if (tempFd !== null) {
      try {
        fs.closeSync(tempFd)
      } catch (error) {
        cleanupError = error
      }
    }
    if (tempOwned) {
      try {
        fs.unlinkSync(tempPath)
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && cleanupError === undefined) cleanupError = error
      }
    }
    if (primaryError === undefined && cleanupError !== undefined) throw cleanupError
  }

  if (!published) {
    const winner = readBlueBubblesSemanticCutover(agentName)
    if (!winner) throw new Error("semantic_cutover_invalid")
    return winner
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_semantic_cutover_initialized",
    message: "initialized bluebubbles semantic cutover",
    meta: { agentName, schemaVersion: 1 },
  })
  return marker
}

export function rotateBlueBubblesSemanticCutover(
  agentName: string,
  reason: "sense_reattachment" | "migration",
  deps: BlueBubblesSemanticCutoverDeps = {},
): BlueBubblesSemanticCutover {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const marker = createCutover(deps)
  fs.mkdirSync(paths.root, { recursive: true })
  const tempPath = path.join(
    paths.root,
    `.cutover.json.${process.pid}.${marker.providerNamespace}.tmp`,
  )
  let tempFd: number | null = null
  let tempOwned = false
  let primaryError: unknown
  try {
    tempFd = fs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    fs.writeFileSync(tempFd, serializeBlueBubblesSemanticJson(marker), "utf8")
    fs.fsyncSync(tempFd)
    fs.closeSync(tempFd)
    tempFd = null
    fs.renameSync(tempPath, paths.cutover)
    fsyncDirectory(paths.root)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError: unknown
    if (tempFd !== null) {
      try {
        fs.closeSync(tempFd)
      } catch (error) {
        cleanupError = error
      }
    }
    if (tempOwned) {
      try {
        fs.unlinkSync(tempPath)
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && cleanupError === undefined) cleanupError = error
      }
    }
    if (primaryError === undefined && cleanupError !== undefined) throw cleanupError
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_semantic_cutover_rotated",
    message: "rotated bluebubbles semantic provider namespace",
    meta: { agentName, reason, schemaVersion: 1 },
  })
  return marker
}

export function readBlueBubblesSemanticCutover(agentName: string): BlueBubblesSemanticCutover | null {
  const filePath = getBlueBubblesSemanticPaths(agentName).cutover
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
    return isBlueBubblesSemanticCutover(parsed) ? parsed : null
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.bluebubbles_semantic_cutover_error",
      message: "failed to read bluebubbles semantic cutover",
      meta: {
        agentName,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return null
  }
}

export function buildBlueBubblesSemanticIdentity(
  input: BlueBubblesSemanticIdentityInput,
): BlueBubblesSemanticIdentity | null {
  const providerNamespace = normalizeProviderNamespace(input.providerNamespace)
  if (!providerNamespace) return null

  if (input.kind === "message") {
    const eventGuid = requiredIdentifier(input.eventGuid)
    if (!eventGuid) return null
    return identityFromKey(["bb-sem-v1", providerNamespace, "message", eventGuid], true)
  }

  if (input.kind === "reaction") {
    const eventGuid = requiredIdentifier(input.eventGuid)
    const targetGuid = requiredIdentifier(input.targetGuid)
    const actorExternalId = requiredIdentifier(input.actorExternalId)
    const canonicalValue = normalizeCanonicalValue(input.canonicalValue)
    const canonicalAction = normalizeCanonicalAction(input.canonicalAction)
    if (!eventGuid || !targetGuid || !actorExternalId || !canonicalValue || !canonicalAction) return null

    const actorIdentityHash = hashIngressActorIdentity(actorExternalId)
    const coordinateTuple = [
      "bb-sem-v1",
      providerNamespace,
      "reaction-coordinate",
      eventGuid,
      targetGuid,
      actorIdentityHash,
      canonicalValue,
    ]
    const coordinateKey = JSON.stringify(coordinateTuple)
    const coordinateHash = sha256Utf8(coordinateKey)
    const discriminator = mutationDiscriminator(input)
      ?? generationDiscriminator(input.coordinateGeneration)
    if (!discriminator) return null

    return identityFromKey([
      "bb-sem-v1",
      providerNamespace,
      "reaction",
      eventGuid,
      targetGuid,
      actorIdentityHash,
      canonicalValue,
      canonicalAction,
      discriminator,
    ], true, discriminator, coordinateKey, coordinateHash)
  }

  if (input.kind === "edit") {
    const messageGuid = requiredIdentifier(input.eventGuid)
    if (!messageGuid) return null
    const discriminator = mutationDiscriminator(input)
      ?? (typeof input.text === "string" ? `content:${sha256Utf8(input.text)}` : null)
    if (!discriminator) return null
    return identityFromKey(
      ["bb-sem-v1", providerNamespace, "edit", messageGuid, discriminator],
      true,
      discriminator,
    )
  }

  if (input.kind === "unsend") {
    const targetGuid = requiredIdentifier(input.targetGuid)
    if (!targetGuid) return null
    const discriminator = mutationDiscriminator(input) ?? "terminal"
    return identityFromKey(
      ["bb-sem-v1", providerNamespace, "unsend", targetGuid, discriminator],
      true,
      discriminator,
    )
  }

  const eventGuid = requiredIdentifier(input.eventGuid)
  if (!eventGuid) return null
  const discriminator = effectiveTimestampDiscriminator(input.effectiveTimestamp) ?? "terminal"
  return identityFromKey(
    ["bb-sem-v1", providerNamespace, "audit", input.kind, eventGuid, discriminator],
    false,
    discriminator,
  )
}

export function buildBlueBubblesSemanticCapture(
  input: BlueBubblesSemanticCaptureInput,
): BlueBubblesSemanticCaptureV1 | null {
  const providerNamespace = normalizeProviderNamespace(input.cutover.providerNamespace)
  const capturedAt = exactIsoMilliseconds(input.capturedAt)
  const sender = input.event.sender
  const actorExternalId = sender.observed === true
    ? requiredIdentifier(sender.externalId)
    : null
  if (!providerNamespace || !capturedAt || !actorExternalId) return null

  const kind = input.event.kind === "message" ? "message" : input.event.mutationType
  const eventGuid = requiredIdentifier(input.event.messageGuid)
  const targetGuid = input.event.kind === "mutation"
    ? requiredIdentifier(input.event.targetMessageGuid)
      ?? (input.event.mutationType === "unsend" ? eventGuid : null)
    : null
  const reaction = input.event.kind === "mutation" ? input.event.reaction : undefined
  const editedText = input.event.kind === "mutation" ? input.event.editedText : undefined
  const identity = buildBlueBubblesSemanticIdentity({
    providerNamespace,
    kind,
    eventGuid,
    targetGuid,
    actorExternalId,
    canonicalValue: reaction?.canonicalValue,
    canonicalAction: reaction?.action,
    revision: input.event.kind === "mutation" ? input.event.revision : undefined,
    effectiveTimestamp: input.event.kind === "mutation" ? input.event.effectiveTimestamp : undefined,
    text: input.event.kind === "message" ? input.event.text : editedText,
    coordinateGeneration: input.coordinateGeneration,
  })
  if (!identity) return null

  const text = input.event.kind === "message"
    ? input.event.text
    : kind === "edit" ? editedText ?? null : null
  const textSha256 = text === null ? null : sha256Utf8(text)
  const effectiveAt = input.event.kind === "mutation"
    ? finiteTimestampIso(input.event.effectiveTimestamp)
    : null
  const revision = input.event.kind === "mutation"
    ? normalizedRevision(input.event.revision)
    : null
  const participants = normalizeIngressParticipants(
    input.event.chat.participantHandles.map((externalId) => ({
      provider: "imessage-handle",
      externalId,
      displayName: null,
    })),
  )

  return {
    schemaVersion: 1,
    canonicalKey: identity.canonicalKey,
    keyHash: identity.keyHash,
    providerNamespace,
    capturedAt,
    event: {
      provider: "bluebubbles",
      kind,
      eventGuid,
      fromMe: input.event.fromMe,
      actor: {
        provider: "imessage-handle",
        externalId: actorExternalId,
        displayName: normalizeDisplayName(sender.displayName),
      },
      participants,
      sourceEventType: input.event.eventType,
      sessionKey: nullableString(input.event.chat.sessionKey),
      chatGuid: nullableString(input.event.chat.chatGuid),
      chatIdentifier: nullableString(input.event.chat.chatIdentifier),
      text,
      textSha256,
      targetGuid,
      targetAuthorship: input.targetAuthorship,
      canonicalAction: reaction?.action ?? null,
      canonicalValue: reaction?.canonicalValue ?? null,
      rawTransportValue: reaction?.rawTransportValue ?? null,
      effectiveAt,
      revision,
      contentSha256: kind === "edit" ? textSha256 : null,
    },
  }
}

export function buildBlueBubblesReactionCoordinateRecord(input: {
  coordinateKey: string
  coordinateHash: string
  generation: number
  lastAction: "add" | "remove"
  updatedAt: string
}): BlueBubblesReactionCoordinateRecord {
  return {
    schemaVersion: 1,
    coordinateKey: input.coordinateKey,
    coordinateHash: input.coordinateHash,
    generation: input.generation,
    lastAction: input.lastAction,
    updatedAt: input.updatedAt,
  }
}

export function buildBlueBubblesSemanticClaimRecord(input: {
  canonicalKey: string
  keyHash: string
  operationId: string
  pid: number
  bootIdentity: string
  processStartedAt: string
  acquiredAt: string
}): BlueBubblesSemanticClaimRecord {
  return {
    schemaVersion: 1,
    canonicalKey: input.canonicalKey,
    keyHash: input.keyHash,
    owner: {
      operationId: input.operationId,
      pid: input.pid,
      bootIdentity: input.bootIdentity,
      processStartedAt: input.processStartedAt,
      acquiredAt: input.acquiredAt,
    },
  }
}

export function classifyBlueBubblesRecoveryRecord(
  value: unknown,
  cutover: BlueBubblesSemanticCutover,
): BlueBubblesRecoveryDisposition {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    emitLegacyRecoveryBlocked(value)
    return { disposition: "audit_only", reason: "legacy_or_actorless" }
  }
  if (!isRecord(value.event)) {
    emitInvalidSemanticRecoveryRecord(value, false, "event_missing")
    return { disposition: "audit_only", reason: "legacy_or_actorless" }
  }
  const actor = value.event.actor
  if (
    !isRecord(actor)
    || actor.provider !== "imessage-handle"
    || typeof actor.externalId !== "string"
    || actor.externalId.trim().length === 0
  ) {
    emitInvalidSemanticRecoveryRecord(value, false, "actor_missing")
    return { disposition: "audit_only", reason: "legacy_or_actorless" }
  }
  if (
    value.providerNamespace !== cutover.providerNamespace
    || typeof value.capturedAt !== "string"
    || !exactIsoMilliseconds(value.capturedAt)
    || value.capturedAt < cutover.effectiveAt
  ) {
    return { disposition: "audit_only", reason: "before_cutover" }
  }
  if (value.event.kind === "read" || value.event.kind === "delivery") {
    return { disposition: "audit_only", reason: "audit_event" }
  }
  if (typeof value.keyHash !== "string" || value.keyHash.length === 0) {
    emitInvalidSemanticRecoveryRecord(value, true, "key_hash_missing")
    return { disposition: "audit_only", reason: "legacy_or_actorless" }
  }
  return { disposition: "handleable", keyHash: value.keyHash }
}

export function writeBlueBubblesSemanticCapture(
  agentName: string,
  capture: BlueBubblesSemanticCaptureV1,
  deps: BlueBubblesSemanticStoreDeps = {},
): BlueBubblesSemanticCaptureWriteResult {
  emitNervesEvent({
    component: "senses",
    event: "bluebubbles_semantic_capture_start",
    message: "publishing bluebubbles semantic capture",
    meta: { agentName, keyHash: capture.keyHash },
  })
  try {
    const paths = getBlueBubblesSemanticPaths(agentName)
    const finalPath = semanticRecordPath(paths.captures, capture.keyHash)
    const existing = readExistingCaptureForWrite(agentName, capture.keyHash, deps)
    if (existing) return finishCaptureComparison(agentName, existing, capture, deps)
    if (!isBlueBubblesSemanticCapture(capture, capture.keyHash)) {
      throw semanticStoreError("semantic_capture_invalid")
    }

    const publication = publishImmutableSemanticRecord(
      paths.captures,
      finalPath,
      capture,
      deps,
    )
    if (publication === "exists") {
      const winner = readExistingCaptureForWrite(agentName, capture.keyHash, deps)
      if (!winner) {
        return writeBlueBubblesSemanticCaptureAfterQuarantine(agentName, capture, deps)
      }
      return finishCaptureComparison(agentName, winner, capture, deps)
    }
    emitNervesEvent({
      component: "senses",
      event: "bluebubbles_semantic_capture_end",
      message: "published bluebubbles semantic capture",
      meta: { agentName, keyHash: capture.keyHash, result: "semantic_capture_published" },
    })
    return "semantic_capture_published"
  } catch (error) {
    emitCaptureError(agentName, capture.keyHash, error)
    throw semanticStoreError("semantic_capture_failed", error)
  }
}

export function readBlueBubblesSemanticCapture(
  agentName: string,
  keyHash: string,
  deps: BlueBubblesSemanticStoreDeps = {},
): BlueBubblesSemanticCaptureV1 | null {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const finalPath = semanticRecordPath(paths.captures, keyHash)
  return readSemanticRecord(
    finalPath,
    "capture",
    keyHash,
    (value) => isBlueBubblesSemanticCapture(value, keyHash),
    deps,
  )
}

export function listPendingBlueBubblesSemanticCaptures(
  agentName: string,
  deps: BlueBubblesSemanticStoreDeps = {},
): BlueBubblesSemanticCaptureV1[] {
  const storeFs = semanticFs(deps)
  const paths = getBlueBubblesSemanticPaths(agentName)
  if (!storeFs.existsSync(paths.captures)) return []
  const captures: BlueBubblesSemanticCaptureV1[] = []
  const names = storeFs.readdirSync(paths.captures)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .sort()
  for (const name of names) {
    const keyHash = name.slice(0, -".json".length)
    const capture = readBlueBubblesSemanticCapture(agentName, keyHash, deps)
    if (!capture) continue
    if (readBlueBubblesSemanticHandled(agentName, keyHash, deps)) continue
    captures.push(capture)
  }
  return captures.sort((left, right) => (
    left.capturedAt.localeCompare(right.capturedAt) || left.keyHash.localeCompare(right.keyHash)
  ))
}

export function writeBlueBubblesSemanticHandled(
  agentName: string,
  record: BlueBubblesSemanticHandledRecord,
  deps: BlueBubblesSemanticStoreDeps = {},
): BlueBubblesSemanticHandledWriteResult {
  try {
    const paths = getBlueBubblesSemanticPaths(agentName)
    const finalPath = semanticRecordPath(paths.handled, record.keyHash)
    const existing = readExistingHandledForWrite(agentName, record.keyHash, deps)
    if (existing) return finishHandledComparison(agentName, existing, record, deps)
    if (!isBlueBubblesSemanticHandledRecord(record, record.keyHash)) {
      throw semanticStoreError("semantic_handled_invalid")
    }
    const publication = publishImmutableSemanticRecord(paths.handled, finalPath, record, deps)
    if (publication === "exists") {
      const winner = readExistingHandledForWrite(agentName, record.keyHash, deps)
      if (!winner) return writeBlueBubblesSemanticHandled(agentName, record, deps)
      return finishHandledComparison(agentName, winner, record, deps)
    }
    return "semantic_handled_published"
  } catch (error) {
    emitSemanticStoreError(agentName, record.keyHash, "semantic_handled_failed", error)
    if (error instanceof Error && error.message === "semantic_handled_failed") throw error
    throw semanticStoreError("semantic_handled_failed", error)
  }
}

export function readBlueBubblesSemanticHandled(
  agentName: string,
  keyHash: string,
  deps: BlueBubblesSemanticStoreDeps = {},
): BlueBubblesSemanticHandledRecord | null {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const finalPath = semanticRecordPath(paths.handled, keyHash)
  return readSemanticRecord(
    finalPath,
    "handled",
    keyHash,
    (value) => isBlueBubblesSemanticHandledRecord(value, keyHash),
    deps,
  )
}

export async function acquireBlueBubblesSemanticClaim(
  agentName: string,
  identity: { canonicalKey: string; keyHash: string },
  deps: BlueBubblesSemanticStoreDeps = {},
): Promise<BlueBubblesSemanticClaimResult> {
  const keyHash = validatedKeyHash(identity.keyHash)
  if (sha256Utf8(identity.canonicalKey) !== keyHash) {
    throw semanticStoreError("semantic_claim_invalid")
  }
  const handled = readBlueBubblesSemanticHandled(agentName, identity.keyHash, deps)
  if (handled) return { status: "already_handled", record: handled }
  const paths = getBlueBubblesSemanticPaths(agentName)
  const ownerPath = path.join(paths.claims, `${validatedKeyHash(identity.keyHash)}.owner.json`)
  let ownerResult: ExclusiveOwnerResult
  try {
    ownerResult = await acquireExclusiveSemanticOwner({
      directoryPath: paths.claims,
      ownerPath,
      canonicalKey: identity.canonicalKey,
      keyHash: identity.keyHash,
      operationId: `semantic-handle:${identity.keyHash}`,
      recordKind: "claim",
      ownershipPath: paths.ownership,
      resourceKey: `claim:${keyHash}`,
    }, deps)
  } catch (error) {
    if (error instanceof Error && error.message === "semantic_owner_liveness_failed") {
      throw semanticStoreError("semantic_claim_liveness_failed", error)
    }
    throw error
  }
  if (ownerResult.status === "timeout") {
    return { status: "timeout", code: "semantic_claim_timeout" }
  }
  const lease: BlueBubblesSemanticClaimLease = { status: "acquired", record: ownerResult.record }
  semanticClaimLeaseIds.set(lease, ownerResult.leaseId)
  const handledAfterClaim = readBlueBubblesSemanticHandled(agentName, identity.keyHash, deps)
  if (handledAfterClaim) {
    releaseBlueBubblesSemanticClaim(agentName, lease, deps)
    return { status: "already_handled", record: handledAfterClaim }
  }
  emitNervesEvent({
    component: "senses",
    event: "bluebubbles_semantic_recovery_claimed",
    message: "claimed captured bluebubbles semantic event",
    meta: { schemaVersion: 1, actorPresent: true, keyHash: identity.keyHash },
  })
  return lease
}

export function releaseBlueBubblesSemanticClaim(
  agentName: string,
  lease: BlueBubblesSemanticClaimLease,
  deps: BlueBubblesSemanticStoreDeps = {},
): boolean {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const ownerPath = path.join(
    paths.claims,
    `${validatedKeyHash(lease.record.keyHash)}.owner.json`,
  )
  const leaseId = semanticClaimLeaseIds.get(lease)
  if (!leaseId) return false
  return releaseExclusiveSemanticOwner({
    directoryPath: paths.claims,
    ownerPath,
    ownershipPath: paths.ownership,
    resourceKey: `claim:${lease.record.keyHash}`,
    record: lease.record,
    leaseId,
  }, deps)
}

export async function allocateBlueBubblesReactionCoordinate(
  agentName: string,
  input: {
    coordinateKey: string
    coordinateHash: string
    canonicalAction: "add" | "remove"
  },
  deps: BlueBubblesSemanticStoreDeps = {},
): Promise<BlueBubblesReactionCoordinateRecord> {
  const coordinateHash = validatedKeyHash(input.coordinateHash)
  if (sha256Utf8(input.coordinateKey) !== coordinateHash || !CANONICAL_ACTIONS.has(input.canonicalAction)) {
    throw semanticStoreError("semantic_coordinate_invalid")
  }
  const paths = getBlueBubblesSemanticPaths(agentName)
  const finalPath = path.join(paths.coordinates, `${coordinateHash}.json`)
  const ownerPath = path.join(paths.coordinates, `${coordinateHash}.owner.lock`)
  if (hasSemanticQuarantine(paths.quarantine, "coordinate", path.basename(finalPath), deps)) {
    throw semanticStoreError("semantic_coordinate_invalid")
  }

  let ownerResult: ExclusiveOwnerResult
  try {
    ownerResult = await acquireExclusiveSemanticOwner({
      directoryPath: paths.coordinates,
      ownerPath,
      canonicalKey: input.coordinateKey,
      keyHash: coordinateHash,
      operationId: `semantic-coordinate:${coordinateHash}`,
      recordKind: "coordinate-owner",
      ownershipPath: paths.ownership,
      resourceKey: `coordinate:${coordinateHash}`,
    }, deps)
  } catch (error) {
    if (error instanceof Error && error.message === "semantic_owner_liveness_failed") {
      throw semanticStoreError("semantic_coordinate_liveness_failed", error)
    }
    throw error
  }
  if (ownerResult.status === "timeout") {
    throw semanticStoreError("semantic_coordinate_lock_timeout")
  }

  try {
    if (hasSemanticQuarantine(paths.quarantine, "coordinate", path.basename(finalPath), deps)) {
      throw semanticStoreError("semantic_coordinate_invalid")
    }
    const existing = readSemanticRecord(
      finalPath,
      "coordinate",
      coordinateHash,
      (value) => isBlueBubblesReactionCoordinateRecord(value, input.coordinateKey, coordinateHash),
      deps,
    )
    if (!existing && hasSemanticQuarantine(
      paths.quarantine,
      "coordinate",
      path.basename(finalPath),
      deps,
    )) {
      throw semanticStoreError("semantic_coordinate_invalid")
    }
    if (existing && existing.lastAction === input.canonicalAction) {
      fsyncSemanticDirectory(paths.coordinates, semanticFs(deps))
      return existing
    }

    const record = buildBlueBubblesReactionCoordinateRecord({
      coordinateKey: input.coordinateKey,
      coordinateHash,
      generation: existing ? existing.generation + 1 : 0,
      lastAction: input.canonicalAction,
      updatedAt: semanticNow(deps).toISOString(),
    })
    writeMutableSemanticRecord(paths.coordinates, finalPath, record, deps)
    return record
  } finally {
    releaseExclusiveSemanticOwner({
      directoryPath: paths.coordinates,
      ownerPath,
      ownershipPath: paths.ownership,
      resourceKey: `coordinate:${coordinateHash}`,
      record: ownerResult.record,
      leaseId: ownerResult.leaseId,
    }, deps)
  }
}

type SemanticRecordKind = "capture" | "handled" | "claim" | "coordinate" | "coordinate-owner"

type ExclusiveOwnerResult =
  | { status: "acquired"; record: BlueBubblesSemanticClaimRecord; leaseId: string }
  | { status: "timeout" }

interface ExclusiveOwnerInput {
  directoryPath: string
  ownerPath: string
  canonicalKey: string
  keyHash: string
  operationId: string
  recordKind: SemanticRecordKind
  ownershipPath: string
  resourceKey: string
}

interface ExclusiveOwnerReleaseInput {
  directoryPath: string
  ownerPath: string
  ownershipPath: string
  resourceKey: string
  record: BlueBubblesSemanticClaimRecord
  leaseId: string
}

function writeBlueBubblesSemanticCaptureAfterQuarantine(
  agentName: string,
  capture: BlueBubblesSemanticCaptureV1,
  deps: BlueBubblesSemanticStoreDeps,
): BlueBubblesSemanticCaptureWriteResult {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const finalPath = semanticRecordPath(paths.captures, capture.keyHash)
  const publication = publishImmutableSemanticRecord(paths.captures, finalPath, capture, deps)
  if (publication === "exists") {
    const winner = readExistingCaptureForWrite(agentName, capture.keyHash, deps)
    if (!winner) throw semanticStoreError("semantic_capture_failed")
    return finishCaptureComparison(agentName, winner, capture, deps)
  }
  emitNervesEvent({
    component: "senses",
    event: "bluebubbles_semantic_capture_end",
    message: "published bluebubbles semantic capture after quarantining invalid state",
    meta: { agentName, keyHash: capture.keyHash, result: "semantic_capture_published" },
  })
  return "semantic_capture_published"
}

function readExistingCaptureForWrite(
  agentName: string,
  keyHash: string,
  deps: BlueBubblesSemanticStoreDeps,
): BlueBubblesSemanticCaptureV1 | null {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const finalPath = semanticRecordPath(paths.captures, keyHash)
  return semanticFs(deps).existsSync(finalPath)
    ? readBlueBubblesSemanticCapture(agentName, keyHash, deps)
    : null
}

function finishCaptureComparison(
  agentName: string,
  existing: BlueBubblesSemanticCaptureV1,
  candidate: BlueBubblesSemanticCaptureV1,
  deps: BlueBubblesSemanticStoreDeps,
): BlueBubblesSemanticCaptureWriteResult {
  fsyncSemanticDirectory(getBlueBubblesSemanticPaths(agentName).captures, semanticFs(deps))
  if (capturesAreEquivalent(existing, candidate)) {
    emitNervesEvent({
      component: "senses",
      event: "bluebubbles_semantic_capture_end",
      message: "recognized duplicate bluebubbles semantic capture",
      meta: { agentName, keyHash: candidate.keyHash, result: "semantic_capture_duplicate" },
    })
    return "semantic_capture_duplicate"
  }
  const error = semanticStoreError("semantic_identity_collision")
  emitCaptureError(agentName, candidate.keyHash, error)
  return "semantic_identity_collision"
}

function readExistingHandledForWrite(
  agentName: string,
  keyHash: string,
  deps: BlueBubblesSemanticStoreDeps,
): BlueBubblesSemanticHandledRecord | null {
  const paths = getBlueBubblesSemanticPaths(agentName)
  const finalPath = semanticRecordPath(paths.handled, keyHash)
  return semanticFs(deps).existsSync(finalPath)
    ? readBlueBubblesSemanticHandled(agentName, keyHash, deps)
    : null
}

function finishHandledComparison(
  agentName: string,
  existing: BlueBubblesSemanticHandledRecord,
  candidate: BlueBubblesSemanticHandledRecord,
  deps: BlueBubblesSemanticStoreDeps,
): BlueBubblesSemanticHandledWriteResult {
  fsyncSemanticDirectory(getBlueBubblesSemanticPaths(agentName).handled, semanticFs(deps))
  if (handledRecordsAreEquivalent(existing, candidate)) return "semantic_handled_duplicate"
  emitSemanticStoreError(
    agentName,
    candidate.keyHash,
    "semantic_handled_collision",
    semanticStoreError("semantic_handled_collision"),
  )
  return "semantic_handled_collision"
}

function capturesAreEquivalent(
  left: BlueBubblesSemanticCaptureV1,
  right: BlueBubblesSemanticCaptureV1,
): boolean {
  const project = (capture: BlueBubblesSemanticCaptureV1) => ({
    schemaVersion: capture.schemaVersion,
    canonicalKey: capture.canonicalKey,
    keyHash: capture.keyHash,
    providerNamespace: capture.providerNamespace,
    event: {
      provider: capture.event.provider,
      kind: capture.event.kind,
      eventGuid: capture.event.eventGuid,
      fromMe: capture.event.fromMe,
      actor: capture.event.actor,
      participants: capture.event.participants,
      text: capture.event.text,
      textSha256: capture.event.textSha256,
      targetGuid: capture.event.targetGuid,
      targetAuthorship: capture.event.targetAuthorship,
      canonicalAction: capture.event.canonicalAction,
      canonicalValue: capture.event.canonicalValue,
      effectiveAt: capture.event.effectiveAt,
      revision: capture.event.revision,
      contentSha256: capture.event.contentSha256,
    },
  })
  return JSON.stringify(project(left)) === JSON.stringify(project(right))
}

function handledRecordsAreEquivalent(
  left: BlueBubblesSemanticHandledRecord,
  right: BlueBubblesSemanticHandledRecord,
): boolean {
  const project = (record: BlueBubblesSemanticHandledRecord) => ({
    schemaVersion: record.schemaVersion,
    canonicalKey: record.canonicalKey,
    keyHash: record.keyHash,
    outcome: record.outcome,
    detailCode: record.detailCode,
  })
  return JSON.stringify(project(left)) === JSON.stringify(project(right))
}

function publishImmutableSemanticRecord(
  directoryPath: string,
  finalPath: string,
  value: unknown,
  deps: BlueBubblesSemanticStoreDeps,
): "published" | "exists" {
  const storeFs = semanticFs(deps)
  storeFs.mkdirSync(directoryPath, { recursive: true })
  const tempPath = semanticTempPath(finalPath, deps)
  let tempFd: number | null = null
  let tempOwned = false
  let outcome: "published" | "exists" | null = null
  let primaryError: unknown
  try {
    tempFd = storeFs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    storeFs.writeFileSync(tempFd, serializeBlueBubblesSemanticJson(value), "utf8")
    storeFs.fsyncSync(tempFd)
    storeFs.closeSync(tempFd)
    tempFd = null
    try {
      storeFs.linkSync(tempPath, finalPath)
      fsyncSemanticDirectory(directoryPath, storeFs)
      outcome = "published"
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error
      outcome = "exists"
    }
  } catch (error) {
    primaryError = error
  }

  let cleanupError: unknown
  if (tempFd !== null) {
    try {
      storeFs.closeSync(tempFd)
    } catch (error) {
      cleanupError = error
    }
  }
  if (tempOwned) {
    try {
      storeFs.unlinkSync(tempPath)
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && cleanupError === undefined) cleanupError = error
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
  return outcome!
}

function writeMutableSemanticRecord(
  directoryPath: string,
  finalPath: string,
  value: unknown,
  deps: BlueBubblesSemanticStoreDeps,
): void {
  const storeFs = semanticFs(deps)
  storeFs.mkdirSync(directoryPath, { recursive: true })
  const tempPath = semanticTempPath(finalPath, deps)
  let tempFd: number | null = null
  let tempOwned = false
  let primaryError: unknown
  try {
    tempFd = storeFs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    storeFs.writeFileSync(tempFd, serializeBlueBubblesSemanticJson(value), "utf8")
    storeFs.fsyncSync(tempFd)
    storeFs.closeSync(tempFd)
    tempFd = null
    storeFs.renameSync(tempPath, finalPath)
    fsyncSemanticDirectory(directoryPath, storeFs)
  } catch (error) {
    primaryError = error
  }

  let cleanupError: unknown
  if (tempFd !== null) {
    try {
      storeFs.closeSync(tempFd)
    } catch (error) {
      cleanupError = error
    }
  }
  if (tempOwned) {
    try {
      storeFs.unlinkSync(tempPath)
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && cleanupError === undefined) cleanupError = error
    }
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
}

async function acquireExclusiveSemanticOwner(
  input: ExclusiveOwnerInput,
  deps: BlueBubblesSemanticStoreDeps,
): Promise<ExclusiveOwnerResult> {
  const keyHash = validatedKeyHash(input.keyHash)
  const pid = semanticPid(deps)
  const ownerRecord = buildBlueBubblesSemanticClaimRecord({
    canonicalKey: input.canonicalKey,
    keyHash,
    operationId: input.operationId,
    pid,
    bootIdentity: semanticBootIdentity(deps),
    processStartedAt: requiredProbeIdentity(semanticProcessStartedAt(pid, deps)),
    acquiredAt: nextOwnerAcquiredAt(input.ownerPath, deps),
  })
  const leaseId = semanticRandomUuid(deps)
  const startedAt = semanticNow(deps).getTime()
  while (true) {
    const attempt = withImmediateSemanticOwnership(
      input.ownershipPath,
      deps,
      (database) => acquireSemanticOwnerInTransaction(
        database,
        input,
        ownerRecord,
        leaseId,
        deps,
      ),
    )
    if (attempt.status === "completed" && attempt.value === "acquired") {
      return { status: "acquired", record: ownerRecord, leaseId }
    }
    if (semanticNow(deps).getTime() - startedAt >= SEMANTIC_CLAIM_TIMEOUT_MS) {
      return { status: "timeout" }
    }
    await semanticSleep(SEMANTIC_CLAIM_POLL_MS, deps)
  }
}

function releaseExclusiveSemanticOwner(
  input: ExclusiveOwnerReleaseInput,
  deps: BlueBubblesSemanticStoreDeps,
): boolean {
  const startedAt = semanticNow(deps).getTime()
  while (true) {
    const result = withImmediateSemanticOwnership(input.ownershipPath, deps, (database) => {
      const row = readSemanticOwnershipRow(database, input.resourceKey)
      if (!row || row.lease_id !== input.leaseId) return false
      const rowOwner = parseSemanticOwnershipRow(row, {
        canonicalKey: input.record.canonicalKey,
        keyHash: input.record.keyHash,
        operationId: input.record.owner.operationId,
      })
      if (serializeBlueBubblesSemanticJson(rowOwner) !== serializeBlueBubblesSemanticJson(input.record)) {
        return false
      }
      const evidence = inspectSemanticOwnerEvidence(input.ownerPath, {
        canonicalKey: input.record.canonicalKey,
        keyHash: input.record.keyHash,
        operationId: input.record.owner.operationId,
      }, deps)
      if (evidence.status === "invalid") return false
      if (evidence.status === "valid" && evidence.bytes !== row.owner_json) return false
      if (evidence.status === "valid" && !removeSemanticOwnerEvidenceIfUnchanged(
        input.directoryPath,
        input.ownerPath,
        row.owner_json,
        semanticFs(deps),
      )) return false
      deleteSemanticOwnershipRow(database, input.resourceKey, input.leaseId)
      return true
    })
    if (result.status === "completed") return result.value
    if (semanticNow(deps).getTime() - startedAt >= SEMANTIC_CLAIM_TIMEOUT_MS) {
      throw semanticStoreError("semantic_ownership_busy")
    }
    semanticSleepSync(SEMANTIC_CLAIM_POLL_MS, deps)
  }
}

function removeSemanticOwnerEvidenceIfUnchanged(
  directoryPath: string,
  ownerPath: string,
  expectedBytes: string,
  storeFs: typeof fs,
): boolean {
  let before: fs.Stats
  try {
    before = storeFs.lstatSync(ownerPath)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false
    throw error
  }
  let current: string
  try {
    current = storeFs.readFileSync(ownerPath, "utf8")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false
    throw error
  }
  const after = storeFs.lstatSync(ownerPath)
  if (
    !before.isFile()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || current !== expectedBytes
  ) return false
  storeFs.unlinkSync(ownerPath)
  fsyncSemanticDirectory(directoryPath, storeFs)
  return true
}

interface SemanticOwnershipRow {
  resource_key: string
  lease_id: string
  owner_json: string
}

type SemanticOwnershipTransactionResult<T> =
  | { status: "completed"; value: T }
  | { status: "busy" }

type SemanticOwnerEvidence =
  | { status: "missing" }
  | { status: "valid"; record: BlueBubblesSemanticClaimRecord; bytes: string }
  | { status: "invalid"; reason: unknown }

function withImmediateSemanticOwnership<T>(
  ownershipPath: string,
  deps: BlueBubblesSemanticStoreDeps,
  operation: (database: Database.Database) => T,
): SemanticOwnershipTransactionResult<T> {
  const storeFs = semanticFs(deps)
  storeFs.mkdirSync(path.dirname(ownershipPath), { recursive: true })
  let database: Database.Database | null = null
  try {
    database = new Database(ownershipPath, { timeout: 0 })
    database.pragma("busy_timeout = 0")
    database.pragma("journal_mode = DELETE")
    database.pragma("synchronous = FULL")
    database.exec("BEGIN IMMEDIATE")
    initializeSemanticOwnershipSchema(database)
    const value = operation(database)
    database.exec("COMMIT")
    fsyncSemanticDirectory(path.dirname(ownershipPath), storeFs)
    return { status: "completed", value }
  } catch (error) {
    if (database?.inTransaction) {
      database.exec("ROLLBACK")
    }
    if (isSqliteBusy(error)) return { status: "busy" }
    if (isSqliteError(error)) throw semanticStoreError("semantic_ownership_invalid", error)
    throw error
  } finally {
    database?.close()
  }
}

function initializeSemanticOwnershipSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true })
  if (version === 0) {
    database.exec(SEMANTIC_OWNERSHIP_SCHEMA_SQL)
    database.pragma(`user_version = ${SEMANTIC_OWNERSHIP_SCHEMA_VERSION}`)
  } else if (version !== SEMANTIC_OWNERSHIP_SCHEMA_VERSION) {
    throw semanticStoreError("semantic_ownership_invalid")
  }
  const schema = database.prepare<[], { sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'owner_leases'",
  ).get()
  if (schema?.sql !== SEMANTIC_OWNERSHIP_SCHEMA_SQL) {
    throw semanticStoreError("semantic_ownership_invalid")
  }
}

function acquireSemanticOwnerInTransaction(
  database: Database.Database,
  input: ExclusiveOwnerInput,
  candidate: BlueBubblesSemanticClaimRecord,
  leaseId: string,
  deps: BlueBubblesSemanticStoreDeps,
): "acquired" | "occupied" {
  const row = readSemanticOwnershipRow(database, input.resourceKey)
  if (row) {
    const existing = parseSemanticOwnershipRow(row, input)
    if (!semanticOwnerIsStale(existing, deps)) {
      reconcileSemanticOwnerEvidence(input, existing, deps)
      return "occupied"
    }
    quarantineSemanticOwnerEvidenceIfPresent(input, deps)
    deleteSemanticOwnershipRow(database, input.resourceKey, row.lease_id)
  } else {
    const evidence = inspectSemanticOwnerEvidence(input.ownerPath, input, deps)
    if (evidence.status === "valid" && !semanticOwnerIsStale(evidence.record, deps)) {
      insertSemanticOwnershipRow(
        database,
        input.resourceKey,
        semanticRandomUuid(deps),
        evidence.bytes,
      )
      return "occupied"
    }
    if (evidence.status !== "missing") {
      quarantineSemanticRecord(
        input.ownerPath,
        input.recordKind,
        input.keyHash,
        deps,
        evidence.status === "invalid"
          ? evidence.reason
          : semanticStoreError("semantic_owner_stale"),
      )
    }
  }

  const ownerJson = serializeBlueBubblesSemanticJson(candidate)
  insertSemanticOwnershipRow(database, input.resourceKey, leaseId, ownerJson)
  ensureSemanticOwnerEvidence(input, candidate, ownerJson, deps)
  return "acquired"
}

function readSemanticOwnershipRow(
  database: Database.Database,
  resourceKey: string,
): SemanticOwnershipRow | null {
  return database.prepare<[string], SemanticOwnershipRow>(
    "SELECT resource_key, lease_id, owner_json FROM owner_leases WHERE resource_key = ?",
  ).get(resourceKey) ?? null
}

function insertSemanticOwnershipRow(
  database: Database.Database,
  resourceKey: string,
  leaseId: string,
  ownerJson: string,
): void {
  database.prepare<[string, string, string]>(
    "INSERT INTO owner_leases (resource_key, lease_id, owner_json) VALUES (?, ?, ?)",
  ).run(resourceKey, leaseId, ownerJson)
}

function deleteSemanticOwnershipRow(
  database: Database.Database,
  resourceKey: string,
  leaseId: string,
): void {
  database.prepare<[string, string]>(
    "DELETE FROM owner_leases WHERE resource_key = ? AND lease_id = ?",
  ).run(resourceKey, leaseId)
}

function parseSemanticOwnershipRow(
  row: SemanticOwnershipRow,
  expected: Pick<ExclusiveOwnerInput, "canonicalKey" | "keyHash" | "operationId">,
): BlueBubblesSemanticClaimRecord {
  if (!UUID_V4_PATTERN.test(row.lease_id)) {
    throw semanticStoreError("semantic_ownership_invalid")
  }
  let value: unknown
  try {
    value = JSON.parse(row.owner_json)
  } catch (error) {
    throw semanticStoreError("semantic_ownership_invalid", error)
  }
  if (
    !isBlueBubblesSemanticClaimRecord(value, expected)
    || row.owner_json !== serializeBlueBubblesSemanticJson(value)
  ) {
    throw semanticStoreError("semantic_ownership_invalid")
  }
  return value
}

function semanticOwnerIsStale(
  owner: BlueBubblesSemanticClaimRecord,
  deps: BlueBubblesSemanticStoreDeps,
): boolean {
  try {
    if (owner.owner.bootIdentity !== semanticBootIdentity(deps)) return true
    if (!semanticIsProcessAlive(owner.owner.pid, deps)) return true
    const observedStart = semanticProcessStartedAt(owner.owner.pid, deps)
    if (observedStart === null) throw semanticStoreError("semantic_owner_liveness_failed")
    return observedStart !== owner.owner.processStartedAt
  } catch (error) {
    if (error instanceof Error && error.message === "semantic_owner_liveness_failed") throw error
    throw semanticStoreError("semantic_owner_liveness_failed", error)
  }
}

function inspectSemanticOwnerEvidence(
  ownerPath: string,
  input: Pick<ExclusiveOwnerInput, "canonicalKey" | "keyHash" | "operationId">,
  deps: BlueBubblesSemanticStoreDeps,
): SemanticOwnerEvidence {
  const storeFs = semanticFs(deps)
  let stat: fs.Stats
  try {
    stat = storeFs.lstatSync(ownerPath)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { status: "invalid", reason: semanticStoreError("semantic_owner_evidence_invalid") }
  }
  let bytes: string
  try {
    bytes = storeFs.readFileSync(ownerPath, "utf8")
  } catch (error) {
    return { status: "invalid", reason: error }
  }
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch (error) {
    return { status: "invalid", reason: error }
  }
  if (
    !isBlueBubblesSemanticClaimRecord(value, input)
    || bytes !== serializeBlueBubblesSemanticJson(value)
  ) {
    return { status: "invalid", reason: semanticStoreError("semantic_owner_evidence_invalid") }
  }
  return { status: "valid", record: value, bytes }
}

function reconcileSemanticOwnerEvidence(
  input: ExclusiveOwnerInput,
  owner: BlueBubblesSemanticClaimRecord,
  deps: BlueBubblesSemanticStoreDeps,
): void {
  const ownerJson = serializeBlueBubblesSemanticJson(owner)
  const evidence = inspectSemanticOwnerEvidence(input.ownerPath, input, deps)
  if (evidence.status === "valid" && evidence.bytes === ownerJson) {
    fsyncSemanticDirectory(input.directoryPath, semanticFs(deps))
    return
  }
  if (evidence.status !== "missing") {
    quarantineSemanticRecord(
      input.ownerPath,
      input.recordKind,
      input.keyHash,
      deps,
      evidence.status === "invalid"
        ? evidence.reason
        : semanticStoreError("semantic_owner_evidence_mismatch"),
    )
  }
  ensureSemanticOwnerEvidence(input, owner, ownerJson, deps)
}

function quarantineSemanticOwnerEvidenceIfPresent(
  input: ExclusiveOwnerInput,
  deps: BlueBubblesSemanticStoreDeps,
): void {
  const evidence = inspectSemanticOwnerEvidence(input.ownerPath, input, deps)
  if (evidence.status === "missing") return
  quarantineSemanticRecord(
    input.ownerPath,
    input.recordKind,
    input.keyHash,
    deps,
    evidence.status === "invalid" ? evidence.reason : semanticStoreError("semantic_owner_stale"),
  )
}

function ensureSemanticOwnerEvidence(
  input: ExclusiveOwnerInput,
  owner: BlueBubblesSemanticClaimRecord,
  ownerJson: string,
  deps: BlueBubblesSemanticStoreDeps,
): void {
  const evidence = inspectSemanticOwnerEvidence(input.ownerPath, input, deps)
  if (evidence.status === "valid" && evidence.bytes === ownerJson) {
    fsyncSemanticDirectory(input.directoryPath, semanticFs(deps))
    return
  }
  if (evidence.status !== "missing") {
    quarantineSemanticRecord(
      input.ownerPath,
      input.recordKind,
      input.keyHash,
      deps,
      evidence.status === "invalid"
        ? evidence.reason
        : semanticStoreError("semantic_owner_evidence_mismatch"),
    )
  }
  const publication = publishImmutableSemanticRecord(
    input.directoryPath,
    input.ownerPath,
    owner,
    deps,
  )
  if (publication !== "published") throw semanticStoreError("semantic_owner_evidence_collision")
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return false
  }
  return error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED")
}

function isSqliteError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("SQLITE_")
}

function readSemanticRecord<T>(
  finalPath: string,
  recordKind: SemanticRecordKind,
  keyHash: string,
  validate: (value: unknown) => value is T,
  deps: BlueBubblesSemanticStoreDeps,
): T | null {
  const storeFs = semanticFs(deps)
  if (!storeFs.existsSync(finalPath)) return null
  let bytes: string
  try {
    bytes = storeFs.readFileSync(finalPath, "utf8")
  } catch (error) {
    emitSemanticStoreError("unknown", keyHash, "semantic_record_read_failed", error)
    throw semanticStoreError("semantic_record_read_failed", error)
  }
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch (error) {
    quarantineSemanticRecord(finalPath, recordKind, keyHash, deps, error)
    return null
  }
  if (!validate(value)) {
    quarantineSemanticRecord(
      finalPath,
      recordKind,
      keyHash,
      deps,
      semanticStoreError("semantic_record_invalid"),
    )
    return null
  }
  return value
}

function quarantineSemanticRecord(
  finalPath: string,
  recordKind: SemanticRecordKind,
  keyHash: string,
  deps: BlueBubblesSemanticStoreDeps,
  reason: unknown,
): void {
  const storeFs = semanticFs(deps)
  const paths = semanticQuarantinePaths(finalPath, recordKind, deps)
  try {
    storeFs.mkdirSync(paths.directoryPath, { recursive: true })
    const sourceStat = storeFs.lstatSync(finalPath)
    if (sourceStat.isSymbolicLink()) {
      storeFs.symlinkSync(storeFs.readlinkSync(finalPath), paths.quarantinePath)
    } else {
      storeFs.linkSync(finalPath, paths.quarantinePath)
    }
    fsyncSemanticDirectory(paths.directoryPath, storeFs)
    storeFs.unlinkSync(finalPath)
    fsyncSemanticDirectory(path.dirname(finalPath), storeFs)
  } catch (error) {
    emitSemanticStoreError("unknown", keyHash, "semantic_quarantine_failed", error)
    throw semanticStoreError("semantic_quarantine_failed", error)
  }
  emitSemanticStoreError("unknown", keyHash, "semantic_record_quarantined", reason)
}

function semanticQuarantinePaths(
  finalPath: string,
  recordKind: SemanticRecordKind,
  deps: BlueBubblesSemanticStoreDeps,
): { directoryPath: string; quarantinePath: string } {
  const semanticRoot = path.dirname(path.dirname(finalPath))
  const directoryPath = path.join(semanticRoot, "quarantine", recordKind)
  const observedAtUnixMs = semanticNow(deps).getTime()
  const uuid = semanticRandomUuid(deps)
  return {
    directoryPath,
    quarantinePath: path.join(
      directoryPath,
      `${path.basename(finalPath)}.${observedAtUnixMs}.${uuid}.json`,
    ),
  }
}

function hasSemanticQuarantine(
  quarantineRoot: string,
  recordKind: SemanticRecordKind,
  originalBase: string,
  deps: BlueBubblesSemanticStoreDeps,
): boolean {
  const storeFs = semanticFs(deps)
  const directoryPath = path.join(quarantineRoot, recordKind)
  if (!storeFs.existsSync(directoryPath)) return false
  return storeFs.readdirSync(directoryPath).some((name) => name.startsWith(`${originalBase}.`))
}

function isBlueBubblesSemanticCapture(
  value: unknown,
  expectedKeyHash: string,
): value is BlueBubblesSemanticCaptureV1 {
  if (!isRecord(value) || !hasExactKeys(value, CAPTURE_KEYS)) return false
  if (
    value.schemaVersion !== 1
    || typeof value.canonicalKey !== "string"
    || value.keyHash !== expectedKeyHash
    || sha256Utf8(value.canonicalKey) !== value.keyHash
    || normalizeProviderNamespace(value.providerNamespace) !== value.providerNamespace
    || exactIsoMilliseconds(value.capturedAt) === null
    || !isRecord(value.event)
    || !hasExactKeys(value.event, CAPTURE_EVENT_KEYS)
  ) return false
  const event = value.event
  if (
    event.provider !== "bluebubbles"
    || typeof event.kind !== "string"
    || !SEMANTIC_EVENT_KINDS.has(event.kind)
    || !isNullableString(event.eventGuid)
    || typeof event.fromMe !== "boolean"
    || !isObservedIngressIdentity(event.actor)
    || !Array.isArray(event.participants)
    || !event.participants.every(isObservedIngressIdentity)
    || !participantsAreSorted(event.participants)
    || typeof event.sourceEventType !== "string"
    || !isNullableString(event.sessionKey)
    || !isNullableString(event.chatGuid)
    || !isNullableString(event.chatIdentifier)
    || !isNullableString(event.text)
    || !isNullableString(event.textSha256)
    || !isNullableString(event.targetGuid)
    || !isIngressTargetAuthorship(event.targetAuthorship)
    || !isIngressCanonicalAction(event.canonicalAction)
    || !isIngressCanonicalValue(event.canonicalValue)
    || !isNullableString(event.rawTransportValue)
    || !(event.effectiveAt === null || exactIsoMilliseconds(event.effectiveAt) !== null)
    || !isNullableString(event.revision)
    || !isNullableString(event.contentSha256)
  ) return false
  if (event.text === null) {
    if (event.textSha256 !== null) return false
  } else if (event.textSha256 !== sha256Utf8(event.text)) {
    return false
  }
  return captureIdentityMatchesEvent(value as unknown as BlueBubblesSemanticCaptureV1)
}

function captureIdentityMatchesEvent(value: BlueBubblesSemanticCaptureV1): boolean {
  const event = value.event
  const coordinateGeneration = event.kind === "reaction"
    && event.revision === null
    && event.effectiveAt === null
    ? reactionGenerationFromCanonicalKey(value.canonicalKey)
    : undefined
  if (coordinateGeneration === null) return false
  const identity = buildBlueBubblesSemanticIdentity({
    providerNamespace: value.providerNamespace,
    kind: event.kind,
    eventGuid: event.eventGuid,
    targetGuid: event.targetGuid,
    actorExternalId: event.actor.externalId,
    canonicalValue: event.canonicalValue ?? undefined,
    canonicalAction: event.canonicalAction ?? undefined,
    revision: event.revision ?? undefined,
    effectiveTimestamp: event.effectiveAt === null ? undefined : Date.parse(event.effectiveAt),
    text: event.text ?? undefined,
    coordinateGeneration,
  })
  return identity !== null
    && identity.canonicalKey === value.canonicalKey
    && identity.keyHash === value.keyHash
}

function reactionGenerationFromCanonicalKey(canonicalKey: string): number | null {
  let tuple: unknown
  try {
    tuple = JSON.parse(canonicalKey)
  } catch {
    return null
  }
  if (!Array.isArray(tuple) || tuple.length !== 9 || typeof tuple[8] !== "string") return null
  const match = /^generation:(0|[1-9]\d*)$/.exec(tuple[8])
  if (!match) return null
  const generation = Number(match[1])
  return Number.isInteger(generation) && generation >= 0 ? generation : null
}

function isBlueBubblesSemanticHandledRecord(
  value: unknown,
  expectedKeyHash: string,
): value is BlueBubblesSemanticHandledRecord {
  return isRecord(value)
    && hasExactKeys(value, HANDLED_KEYS)
    && value.schemaVersion === 1
    && typeof value.canonicalKey === "string"
    && value.keyHash === expectedKeyHash
    && sha256Utf8(value.canonicalKey) === value.keyHash
    && exactIsoMilliseconds(value.handledAt) !== null
    && typeof value.outcome === "string"
    && SEMANTIC_HANDLED_OUTCOMES.has(value.outcome as BlueBubblesSemanticHandledOutcome)
    && (value.detailCode === null || typeof value.detailCode === "string")
}

function isBlueBubblesSemanticClaimRecord(
  value: unknown,
  expected: Pick<ExclusiveOwnerInput, "canonicalKey" | "keyHash" | "operationId">,
): value is BlueBubblesSemanticClaimRecord {
  if (!isRecord(value) || !hasExactKeys(value, CLAIM_KEYS) || !isRecord(value.owner)) return false
  return hasExactKeys(value.owner, CLAIM_OWNER_KEYS)
    && value.schemaVersion === 1
    && value.canonicalKey === expected.canonicalKey
    && value.keyHash === expected.keyHash
    && sha256Utf8(value.canonicalKey as string) === value.keyHash
    && value.owner.operationId === expected.operationId
    && typeof value.owner.pid === "number"
    && Number.isInteger(value.owner.pid)
    && value.owner.pid > 0
    && typeof value.owner.bootIdentity === "string"
    && value.owner.bootIdentity.length > 0
    && typeof value.owner.processStartedAt === "string"
    && value.owner.processStartedAt.length > 0
    && exactIsoMilliseconds(value.owner.acquiredAt) !== null
}

function isBlueBubblesReactionCoordinateRecord(
  value: unknown,
  coordinateKey: string,
  coordinateHash: string,
): value is BlueBubblesReactionCoordinateRecord {
  return isRecord(value)
    && hasExactKeys(value, COORDINATE_KEYS)
    && value.schemaVersion === 1
    && value.coordinateKey === coordinateKey
    && value.coordinateHash === coordinateHash
    && sha256Utf8(coordinateKey) === coordinateHash
    && typeof value.generation === "number"
    && Number.isInteger(value.generation)
    && value.generation >= 0
    && (value.lastAction === "add" || value.lastAction === "remove")
    && exactIsoMilliseconds(value.updatedAt) !== null
}

function isObservedIngressIdentity(value: unknown): value is ObservedIngressIdentity {
  return isRecord(value)
    && hasExactKeys(value, OBSERVED_IDENTITY_KEYS)
    && value.provider === "imessage-handle"
    && typeof value.externalId === "string"
    && value.externalId.length > 0
    && normalizeIngressIdentifier(value.externalId) === value.externalId
    && (value.displayName === null || typeof value.displayName === "string")
}

function participantsAreSorted(participants: ObservedIngressIdentity[]): boolean {
  return participants.every((participant, index) => (
    index === 0 || participants[index - 1]!.externalId.localeCompare(participant.externalId) <= 0
  ))
}

function isIngressTargetAuthorship(value: unknown): value is IngressTargetAuthorship {
  return value === null || value === "agent" || value === "non_agent_unknown"
}

function isIngressCanonicalAction(value: unknown): value is IngressCanonicalAction {
  return value === null || value === "add" || value === "remove"
}

function isIngressCanonicalValue(value: unknown): value is IngressCanonicalValue {
  return value === null || (
    typeof value === "string"
    && CANONICAL_VALUES.has(value as Exclude<IngressCanonicalValue, null>)
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function semanticRecordPath(directoryPath: string, keyHash: string): string {
  return path.join(directoryPath, `${validatedKeyHash(keyHash)}.json`)
}

function validatedKeyHash(value: string): string {
  if (!SEMANTIC_KEY_HASH_PATTERN.test(value)) throw semanticStoreError("semantic_key_hash_invalid")
  return value
}

function semanticTempPath(finalPath: string, deps: BlueBubblesSemanticStoreDeps): string {
  return path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${semanticPid(deps)}.${semanticRandomUuid(deps)}.tmp`,
  )
}

function semanticFs(deps: BlueBubblesSemanticStoreDeps): typeof fs {
  return deps.fs ?? fs
}

function semanticNow(deps: BlueBubblesSemanticStoreDeps): Date {
  return (deps.now ?? (() => new Date()))()
}

function semanticRandomUuid(deps: BlueBubblesSemanticStoreDeps): string {
  const uuid = (deps.randomUUID ?? createRandomUuid)()
  if (!UUID_V4_PATTERN.test(uuid)) throw semanticStoreError("semantic_uuid_invalid")
  return uuid
}

function semanticPid(deps: BlueBubblesSemanticStoreDeps): number {
  const pid = (deps.pid ?? (() => process.pid))()
  if (!Number.isInteger(pid) || pid <= 0) throw semanticStoreError("semantic_pid_invalid")
  return pid
}

function semanticBootIdentity(deps: BlueBubblesSemanticStoreDeps): string {
  const identity = deps.bootIdentity ? deps.bootIdentity() : defaultBootIdentity(deps)
  return requiredProbeIdentity(identity)
}

function semanticProcessStartedAt(pid: number, deps: BlueBubblesSemanticStoreDeps): string | null {
  return deps.processStartedAt
    ? deps.processStartedAt(pid)
    : defaultProcessStartedAt(pid, deps)
}

function semanticIsProcessAlive(pid: number, deps: BlueBubblesSemanticStoreDeps): boolean {
  return deps.isProcessAlive ? deps.isProcessAlive(pid) : defaultIsProcessAlive(pid, deps)
}

async function semanticSleep(milliseconds: number, deps: BlueBubblesSemanticStoreDeps): Promise<void> {
  if (deps.sleep) {
    await deps.sleep(milliseconds)
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function semanticSleepSync(milliseconds: number, deps: BlueBubblesSemanticStoreDeps): void {
  if (deps.sleepSync) {
    deps.sleepSync(milliseconds)
    return
  }
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(waitCell, 0, 0, milliseconds)
}

function requiredProbeIdentity(value: string | null): string {
  if (typeof value !== "string" || value.length === 0) {
    throw semanticStoreError("semantic_owner_liveness_failed")
  }
  return value
}

function defaultBootIdentity(deps: BlueBubblesSemanticStoreDeps): string {
  const platform = deps.platform ?? process.platform
  const storeFs = semanticFs(deps)
  const run = deps.execFileSync ?? execFileSync
  if (platform === "linux") {
    const bootId = storeFs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    return requiredProbeIdentity(`linux:${bootId}`)
  }
  if (platform === "darwin" || platform === "freebsd") {
    const output = run("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
    }).trim()
    return requiredProbeIdentity(`${platform}:${output}`)
  }
  if (platform === "win32") {
    const output = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
      ],
      { encoding: "utf8" },
    ).trim()
    return requiredProbeIdentity(`win32:${output}`)
  }
  const uptime = deps.uptime ?? os.uptime
  const bootEpochSeconds = Math.round((semanticNow(deps).getTime() - (uptime() * 1_000)) / 1_000)
  return requiredProbeIdentity(`${platform}:${bootEpochSeconds}`)
}

function defaultProcessStartedAt(pid: number, deps: BlueBubblesSemanticStoreDeps): string | null {
  const platform = deps.platform ?? process.platform
  const storeFs = semanticFs(deps)
  const run = deps.execFileSync ?? execFileSync
  if (platform === "linux") {
    try {
      const stat = storeFs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const closeParen = stat.lastIndexOf(")")
      if (closeParen < 0) return null
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
      return fields[19] ? `linux:${fields[19]}` : null
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) return null
      throw error
    }
  }
  if (platform === "win32") {
    try {
      const output = run(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: "utf8" },
      ).trim()
      return output ? `win32:${output}` : null
    } catch {
      return null
    }
  }
  try {
    const output = run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim()
    return output ? `${platform}:${output}` : null
  } catch {
    return null
  }
}

function defaultIsProcessAlive(pid: number, deps: BlueBubblesSemanticStoreDeps): boolean {
  const kill = deps.kill ?? process.kill
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false
    if (isNodeError(error, "EPERM")) return true
    throw error
  }
}

function nextOwnerAcquiredAt(ownerPath: string, deps: BlueBubblesSemanticStoreDeps): string {
  const observed = semanticNow(deps).getTime()
  const previous = lastOwnerAcquisitionMs.get(ownerPath)
  const next = previous === undefined ? observed : Math.max(observed, previous + 1)
  lastOwnerAcquisitionMs.set(ownerPath, next)
  return new Date(next).toISOString()
}

function fsyncSemanticDirectory(directoryPath: string, storeFs: typeof fs): void {
  const directoryFd = storeFs.openSync(directoryPath, "r")
  try {
    storeFs.fsyncSync(directoryFd)
  } finally {
    storeFs.closeSync(directoryFd)
  }
}

function semanticStoreError(code: string, cause?: unknown): Error {
  return cause === undefined ? new Error(code) : new Error(code, { cause })
}

function emitCaptureError(agentName: string, keyHash: string, error: unknown): void {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "bluebubbles_semantic_capture_error",
    message: "failed to publish bluebubbles semantic capture",
    meta: { agentName, keyHash, reason: errorReason(error) },
  })
}

function emitSemanticStoreError(
  agentName: string,
  keyHash: string,
  code: string,
  error: unknown,
): void {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "bluebubbles_semantic_store_error",
    message: "bluebubbles semantic store operation failed",
    meta: { agentName, keyHash, code, reason: errorReason(error) },
  })
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createCutover(deps: BlueBubblesSemanticCutoverDeps): BlueBubblesSemanticCutover {
  const providerNamespace = normalizeProviderNamespace(
    (deps.randomUUID ?? createRandomUuid)(),
  )
  if (!providerNamespace) throw new Error("semantic_provider_namespace_invalid")
  const effectiveAt = (deps.now ?? (() => new Date()))().toISOString()
  if (!exactIsoMilliseconds(effectiveAt)) throw new Error("semantic_cutover_timestamp_invalid")
  return { schemaVersion: 1, providerNamespace, effectiveAt }
}

function isBlueBubblesSemanticCutover(value: unknown): value is BlueBubblesSemanticCutover {
  if (!isRecord(value)) return false
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(CUTOVER_KEYS)) return false
  return value.schemaVersion === 1
    && normalizeProviderNamespace(value.providerNamespace) === value.providerNamespace
    && exactIsoMilliseconds(value.effectiveAt) !== null
}

function identityFromKey(
  tuple: unknown[],
  handleable: boolean,
  discriminator: string | null = null,
  coordinateKey: string | null = null,
  coordinateHash: string | null = null,
): BlueBubblesSemanticIdentity {
  const canonicalKey = JSON.stringify(tuple)
  return {
    canonicalKey,
    keyHash: sha256Utf8(canonicalKey),
    handleable,
    discriminator,
    coordinateKey,
    coordinateHash,
  }
}

function mutationDiscriminator(input: BlueBubblesSemanticIdentityInput): string | null {
  const revision = normalizedRevision(input.revision)
  if (revision) return `revision:${revision}`
  return effectiveTimestampDiscriminator(input.effectiveTimestamp)
}

function effectiveTimestampDiscriminator(value: unknown): string | null {
  const effectiveAt = finiteTimestampIso(value)
  return effectiveAt ? `effectiveAt:${effectiveAt}` : null
}

function generationDiscriminator(value: unknown): string | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? `generation:${value}`
    : null
}

function finiteTimestampIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function normalizedRevision(value: unknown): string | null {
  if (typeof value !== "string") return null
  return value.trim() || null
}

function requiredIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const normalized = normalizeIngressIdentifier(value)
  return normalized || null
}

function normalizeProviderNamespace(value: unknown): string | null {
  const normalized = requiredIdentifier(value)
  return normalized && UUID_V4_PATTERN.test(normalized) ? normalized : null
}

function normalizeCanonicalValue(value: unknown): Exclude<IngressCanonicalValue, null> | null {
  return typeof value === "string"
    && CANONICAL_VALUES.has(value as Exclude<IngressCanonicalValue, null>)
    ? value as Exclude<IngressCanonicalValue, null>
    : null
}

function normalizeCanonicalAction(value: unknown): Exclude<IngressCanonicalAction, null> | null {
  return typeof value === "string"
    && CANONICAL_ACTIONS.has(value as Exclude<IngressCanonicalAction, null>)
    ? value as Exclude<IngressCanonicalAction, null>
    : null
}

function normalizeDisplayName(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function exactIsoMilliseconds(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_MILLISECONDS_PATTERN.test(value)) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? value : null
}

function sha256Utf8(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

function fsyncDirectory(directoryPath: string): void {
  const directoryFd = fs.openSync(directoryPath, "r")
  try {
    fs.fsyncSync(directoryFd)
  } finally {
    fs.closeSync(directoryFd)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function emitLegacyRecoveryBlocked(value: unknown): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_legacy_recovery_blocked",
    message: "blocked legacy or actorless bluebubbles recovery record",
    meta: {
      schemaVersion: 0,
      actorPresent: false,
      recordKind: recoveryRecordKind(value),
      reason: "legacy_or_actorless",
    },
  })
}

function emitInvalidSemanticRecoveryRecord(
  value: unknown,
  actorPresent: boolean,
  reason: "event_missing" | "actor_missing" | "key_hash_missing",
): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_semantic_recovery_invalid",
    message: "blocked invalid v1 bluebubbles recovery record",
    meta: {
      schemaVersion: 1,
      actorPresent,
      recordKind: recoveryRecordKind(value),
      reason,
    },
  })
}

function recoveryRecordKind(value: unknown): string {
  const record = isRecord(value) ? value : null
  return typeof record?.mutationType === "string"
    ? record.mutationType
    : isRecord(record?.event) && typeof record.event.kind === "string"
      ? record.event.kind
      : "inbound"
}
