import { createHash, randomUUID as createRandomUuid } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

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
  let published = false
  try {
    tempFd = fs.openSync(tempPath, "wx", 0o600)
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
  } finally {
    if (tempFd !== null) fs.closeSync(tempFd)
    try {
      fs.unlinkSync(tempPath)
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error
    }
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
  try {
    tempFd = fs.openSync(tempPath, "wx", 0o600)
    fs.writeFileSync(tempFd, serializeBlueBubblesSemanticJson(marker), "utf8")
    fs.fsyncSync(tempFd)
    fs.closeSync(tempFd)
    tempFd = null
    fs.renameSync(tempPath, paths.cutover)
    fsyncDirectory(paths.root)
  } finally {
    if (tempFd !== null) fs.closeSync(tempFd)
    try {
      fs.unlinkSync(tempPath)
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error
    }
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
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.event)) {
    emitLegacyRecoveryBlocked(value)
    return { disposition: "audit_only", reason: "legacy_or_actorless" }
  }
  const actor = value.event.actor
  if (
    !isRecord(actor)
    || actor.provider !== "imessage-handle"
    || typeof actor.externalId !== "string"
    || actor.externalId.trim().length === 0
  ) {
    emitLegacyRecoveryBlocked(value)
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
    emitLegacyRecoveryBlocked(value)
    return { disposition: "audit_only", reason: "legacy_or_actorless" }
  }
  return { disposition: "handleable", keyHash: value.keyHash }
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
  const record = isRecord(value) ? value : null
  const recordKind = typeof record?.mutationType === "string"
    ? record.mutationType
    : isRecord(record?.event) && typeof record.event.kind === "string"
      ? record.event.kind
      : "inbound"
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_legacy_recovery_blocked",
    message: "blocked legacy or actorless bluebubbles recovery record",
    meta: {
      schemaVersion: 0,
      actorPresent: false,
      recordKind,
      reason: "legacy_or_actorless",
    },
  })
}
