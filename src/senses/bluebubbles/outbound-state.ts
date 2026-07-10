import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesChatRef } from "./model"

export const BLUEBUBBLES_OUTBOUND_STATE_POLICY_VERSION = "bluebubbles-outbound-state/v1" as const

export type BlueBubblesOutboundStatus =
  | "reserved"
  | "accepted"
  | "enqueued"
  | "local-visible"
  | "delivered"
  | "failed"
  | "pending-manual-verification"

export interface BlueBubblesAttachmentIdentityInput {
  serverUrl: string
  accountId?: string
}

export interface BlueBubblesAttachmentProof {
  endpointOrigin: string
  accountId: string | null
  identityHash: string
  secretStored: false
}

export interface BlueBubblesRouteProof {
  chatGuid: string | null
  chatIdentifier: string | null
  sendTarget: BlueBubblesChatRef["sendTarget"]
  sessionKey: string
  isGroup: boolean
  participantHandlesHash: string
  routeHash: string
  rawParticipantHandlesStored: false
}

export interface BlueBubblesOutboundRecord {
  schemaVersion: 1
  policyVersion: typeof BLUEBUBBLES_OUTBOUND_STATE_POLICY_VERSION
  recordId: string
  idempotencyKey: string
  idempotencyHash: string
  status: BlueBubblesOutboundStatus
  createdAt: string
  updatedAt: string
  tempGuid: string
  messageGuid?: string
  routeProof: BlueBubblesRouteProof
  attachmentProof: BlueBubblesAttachmentProof
  textHash: string
  textLength: number
  replyToMessageGuidHash?: string
  acceptedAt?: string
  enqueuedAt?: string
  localVisibleAt?: string
  deliveredAt?: string
  failedAt?: string
  failureReason?: string
  manualVerificationReason?: string
  contentStored: false
}

export type BlueBubblesOutboundReservationResult =
  | { status: "reserved"; record: BlueBubblesOutboundRecord }
  | { status: "duplicate"; record: BlueBubblesOutboundRecord }
  | {
    status: "pending-manual-verification"
    reason: "identity-proof-mismatch"
    record: BlueBubblesOutboundRecord
  }

export interface ReserveBlueBubblesOutboundInput {
  agentRoot: string
  idempotencyKey: string
  chat: BlueBubblesChatRef
  attachment: BlueBubblesAttachmentIdentityInput
  text: string
  tempGuid: string
  now?: string
  replyToMessageGuid?: string
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function hash(input: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(input))}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function nowIso(input?: string): string {
  return input ?? new Date().toISOString()
}

function recordIdFor(idempotencyKey: string): string {
  return `bbout_${sha256Hex(`bluebubbles-outbound:${idempotencyKey}`).slice(0, 32)}`
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function endpointOrigin(serverUrl: string): string {
  const parsed = new URL(serverUrl)
  return parsed.origin
}

function blueBubblesOutboundDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "bluebubbles", "outbound")
}

export function blueBubblesOutboundRecordPath(agentRoot: string, recordId: string): string {
  return path.join(blueBubblesOutboundDir(agentRoot), `${recordId}.json`)
}

export function buildBlueBubblesRouteProof(chat: BlueBubblesChatRef): BlueBubblesRouteProof {
  const participantHandles = [...chat.participantHandles].sort()
  const base = {
    chatGuid: chat.chatGuid?.trim() || null,
    chatIdentifier: chat.chatIdentifier?.trim() || null,
    sendTarget: chat.sendTarget,
    sessionKey: chat.sessionKey,
    isGroup: chat.isGroup,
    participantHandles,
  }
  return {
    chatGuid: base.chatGuid,
    chatIdentifier: base.chatIdentifier,
    sendTarget: base.sendTarget,
    sessionKey: base.sessionKey,
    isGroup: base.isGroup,
    participantHandlesHash: hash(participantHandles),
    routeHash: hash(base),
    rawParticipantHandlesStored: false,
  }
}

export function buildBlueBubblesAttachmentProof(input: BlueBubblesAttachmentIdentityInput): BlueBubblesAttachmentProof {
  const proof = {
    endpointOrigin: endpointOrigin(input.serverUrl),
    accountId: input.accountId?.trim() || null,
  }
  return {
    ...proof,
    identityHash: hash(proof),
    secretStored: false,
  }
}

function buildRecord(input: ReserveBlueBubblesOutboundInput): BlueBubblesOutboundRecord {
  const createdAt = nowIso(input.now)
  const idempotencyKey = input.idempotencyKey.trim()
  const text = normalizeText(input.text)
  return {
    schemaVersion: 1,
    policyVersion: BLUEBUBBLES_OUTBOUND_STATE_POLICY_VERSION,
    recordId: recordIdFor(idempotencyKey),
    idempotencyKey,
    idempotencyHash: hash(idempotencyKey),
    status: "reserved",
    createdAt,
    updatedAt: createdAt,
    tempGuid: input.tempGuid.trim(),
    routeProof: buildBlueBubblesRouteProof(input.chat),
    attachmentProof: buildBlueBubblesAttachmentProof(input.attachment),
    textHash: hash(text),
    textLength: text.length,
    ...(input.replyToMessageGuid?.trim() ? { replyToMessageGuidHash: hash(input.replyToMessageGuid.trim()) } : {}),
    contentStored: false,
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  fs.renameSync(tmp, filePath)
}

function readJson(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
}

function isOutboundRecord(value: unknown): value is BlueBubblesOutboundRecord {
  const row = value as Partial<BlueBubblesOutboundRecord> | null
  return !!row
    && row.schemaVersion === 1
    && row.policyVersion === BLUEBUBBLES_OUTBOUND_STATE_POLICY_VERSION
    && typeof row.recordId === "string"
    && typeof row.idempotencyKey === "string"
    && typeof row.idempotencyHash === "string"
    && typeof row.status === "string"
    && typeof row.createdAt === "string"
    && typeof row.updatedAt === "string"
    && typeof row.tempGuid === "string"
    && typeof row.textHash === "string"
    && typeof row.textLength === "number"
    && row.contentStored === false
}

export function readBlueBubblesOutboundRecord(agentRoot: string, recordId: string): BlueBubblesOutboundRecord | null {
  try {
    const parsed = readJson(blueBubblesOutboundRecordPath(agentRoot, recordId))
    return isOutboundRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeBlueBubblesOutboundRecord(agentRoot: string, record: BlueBubblesOutboundRecord): BlueBubblesOutboundRecord {
  writeJsonAtomic(blueBubblesOutboundRecordPath(agentRoot, record.recordId), record)
  return record
}

function identityMatches(left: BlueBubblesOutboundRecord, right: BlueBubblesOutboundRecord): boolean {
  return left.routeProof.routeHash === right.routeProof.routeHash
    && left.attachmentProof.identityHash === right.attachmentProof.identityHash
    && left.textHash === right.textHash
    && left.replyToMessageGuidHash === right.replyToMessageGuidHash
}

function emitDuplicate(record: BlueBubblesOutboundRecord): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_outbound_duplicate",
    message: "duplicate bluebubbles outbound reservation suppressed",
    meta: { recordId: record.recordId, status: record.status },
  })
}

function markPendingManualVerification(
  agentRoot: string,
  record: BlueBubblesOutboundRecord,
  decidedAt: string,
  reason: string,
): BlueBubblesOutboundRecord {
  const updated = writeBlueBubblesOutboundRecord(agentRoot, {
    ...record,
    status: "pending-manual-verification",
    updatedAt: decidedAt,
    manualVerificationReason: reason,
  })
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_outbound_pending_manual_verification",
    message: "bluebubbles outbound requires manual verification",
    meta: { recordId: updated.recordId, reason },
  })
  return updated
}

export function reserveBlueBubblesOutbound(input: ReserveBlueBubblesOutboundInput): BlueBubblesOutboundReservationResult {
  const record = buildRecord(input)
  const filePath = blueBubblesOutboundRecordPath(input.agentRoot, record.recordId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    const fd = fs.openSync(filePath, "wx")
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf-8")
    } finally {
      fs.closeSync(fd)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_outbound_reserved",
      message: "reserved bluebubbles outbound idempotency key",
      meta: { recordId: record.recordId, textLength: record.textLength },
    })
    return { status: "reserved", record }
  } catch (error) {
    /* v8 ignore next -- non-EEXIST filesystem failures are rethrown fail-closed; hard to trigger portably after mkdir succeeds @preserve */
    if (!isNodeFileExistsError(error)) throw error
    const existing = readBlueBubblesOutboundRecord(input.agentRoot, record.recordId)
    if (!existing) throw new Error(`bluebubbles outbound reservation is unreadable: ${record.recordId}`)
    if (identityMatches(existing, record)) {
      emitDuplicate(existing)
      return { status: "duplicate", record: existing }
    }
    const updated = markPendingManualVerification(
      input.agentRoot,
      existing,
      nowIso(input.now),
      "identity-proof-mismatch",
    )
    return { status: "pending-manual-verification", reason: "identity-proof-mismatch", record: updated }
  }
}

function isNodeFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
}

function updateStatus(
  agentRoot: string,
  recordId: string,
  status: BlueBubblesOutboundStatus,
  updatedAt: string,
  patch: Partial<BlueBubblesOutboundRecord>,
): BlueBubblesOutboundRecord {
  const existing = readBlueBubblesOutboundRecord(agentRoot, recordId)
  if (!existing) throw new Error(`bluebubbles outbound record not found: ${recordId}`)
  const updated = writeBlueBubblesOutboundRecord(agentRoot, {
    ...existing,
    ...patch,
    status,
    updatedAt,
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_outbound_state_changed",
    message: "bluebubbles outbound state changed",
    meta: { recordId, status },
  })
  return updated
}

export function markBlueBubblesOutboundAccepted(input: {
  agentRoot: string
  recordId: string
  acceptedAt: string
  messageGuid?: string
}): BlueBubblesOutboundRecord {
  return updateStatus(input.agentRoot, input.recordId, "accepted", input.acceptedAt, {
    acceptedAt: input.acceptedAt,
    ...(input.messageGuid?.trim() ? { messageGuid: input.messageGuid.trim() } : {}),
  })
}

export function markBlueBubblesOutboundEnqueued(input: {
  agentRoot: string
  recordId: string
  enqueuedAt: string
  messageGuid: string
}): BlueBubblesOutboundRecord {
  return updateStatus(input.agentRoot, input.recordId, "enqueued", input.enqueuedAt, {
    enqueuedAt: input.enqueuedAt,
    messageGuid: input.messageGuid.trim(),
  })
}

export function markBlueBubblesOutboundLocalVisible(input: {
  agentRoot: string
  recordId: string
  visibleAt: string
  messageGuid: string
  tempGuid?: string
}): BlueBubblesOutboundRecord {
  return updateStatus(input.agentRoot, input.recordId, "local-visible", input.visibleAt, {
    localVisibleAt: input.visibleAt,
    messageGuid: input.messageGuid.trim(),
    ...(input.tempGuid?.trim() ? { tempGuid: input.tempGuid.trim() } : {}),
  })
}

export function markBlueBubblesOutboundDelivered(input: {
  agentRoot: string
  recordId: string
  deliveredAt: string
  messageGuid?: string
}): BlueBubblesOutboundRecord {
  return updateStatus(input.agentRoot, input.recordId, "delivered", input.deliveredAt, {
    deliveredAt: input.deliveredAt,
    ...(input.messageGuid?.trim() ? { messageGuid: input.messageGuid.trim() } : {}),
  })
}

export function markBlueBubblesOutboundFailed(input: {
  agentRoot: string
  recordId: string
  failedAt: string
  reason: string
}): BlueBubblesOutboundRecord {
  return updateStatus(input.agentRoot, input.recordId, "failed", input.failedAt, {
    failedAt: input.failedAt,
    failureReason: input.reason.slice(0, 500),
  })
}

export function markBlueBubblesOutboundPendingManualVerification(input: {
  agentRoot: string
  recordId: string
  decidedAt: string
  reason: string
}): BlueBubblesOutboundRecord {
  const existing = readBlueBubblesOutboundRecord(input.agentRoot, input.recordId)
  if (!existing) throw new Error(`bluebubbles outbound record not found: ${input.recordId}`)
  return markPendingManualVerification(input.agentRoot, existing, input.decidedAt, input.reason)
}
