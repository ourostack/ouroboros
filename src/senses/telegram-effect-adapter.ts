import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { loadSessionEnvelopeFile, type SessionEnvelope, type SessionEvent } from "../heart/session-events"
import { readSessionTransaction, withSessionTurnLease, writeSessionTransaction } from "../mind/session-transaction"
import { escapeTelegramHtml, sendTelegramText, splitTelegramText, type TelegramBotApi } from "./telegram-client"

export const FIXED_ADMISSION_ACKNOWLEDGEMENT = "Thanks — I’ve asked Ari."

export type TelegramEffectTarget =
  | { kind: "approved_relationship"; friendId: string; sessionKey: string; chatId: string; requestId?: string }
  | { kind: "admission_gate"; admissionId: string; botId: string; userId: string; chatId: string }

export type TelegramEffect =
  | { kind: "text"; text: string }
  | { kind: "admission_ack"; text: typeof FIXED_ADMISSION_ACKNOWLEDGEMENT }
  | { kind: "card"; text: string; buttons: Array<Array<{ text: string; callbackData: string }>> }
  | { kind: "edit"; messageId: number; text: string }
  | { kind: "callback_ack"; callbackQueryId: string; text?: string }

export type TelegramArtifactAuthorClass = "butler" | "control" | "system_failsafe"
export type TelegramEffectPartState = "prepared" | "attempting" | "accepted" | "session_recorded" | "indeterminate"

export interface TelegramEffectPart {
  index: number
  text: string | null
  state: TelegramEffectPartState
  messageId?: number
  sessionEventId?: string
  updatedAt: string
}

export interface TelegramEffectArtifact {
  schemaVersion: 1
  id: string
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
  authorizationReceiptId: string
  authorizationExpiresAt: string
  parts: TelegramEffectPart[]
  createdAt: string
  updatedAt: string
}

export type TelegramEffectAuthorization =
  | { allowed: true; receiptId: string; expiresAt: string }
  | { allowed: false; reason: string }

export interface TelegramEffectAuthorizationInput {
  phase: "prepare" | "send"
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
  artifact?: TelegramEffectArtifact
}

function artifactId(idempotencyKey: string): string {
  return crypto.createHash("sha256").update(idempotencyKey).digest("hex")
}

function requireText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be nonempty`)
  return value
}

function preparedTexts(effect: TelegramEffect): Array<string | null> {
  if (effect.kind === "text" || effect.kind === "admission_ack") return splitTelegramText(requireText(effect.text, "Telegram text"))
  if (effect.kind === "card" || effect.kind === "edit") return [requireText(effect.text, "Telegram text")]
  return [effect.text?.trim() || null]
}

function assertEffectTarget(target: TelegramEffectTarget, effect: TelegramEffect, idempotencyKey: string): void {
  if (target.kind === "admission_gate") {
    if (effect.kind !== "admission_ack" || effect.text !== FIXED_ADMISSION_ACKNOWLEDGEMENT || idempotencyKey !== `ack:${target.admissionId}`) {
      throw new Error("admission targets allow only the fixed admission acknowledgement")
    }
  } else if (effect.kind === "admission_ack") {
    throw new Error("fixed admission acknowledgement requires an admission target")
  }
}

export class FileTelegramEffectJournal {
  constructor(private readonly root: string) {
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root)
      if (stat.isSymbolicLink()) throw new Error("Telegram effect journal root must not be a symbolic link")
      if (!stat.isDirectory()) throw new Error("Telegram effect journal root must be a directory")
    } else {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    }
    fs.chmodSync(root, 0o700)
    const verified = fs.lstatSync(root)
    if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o777) !== 0o700) throw new Error("Telegram effect journal root is unsafe")
  }

  private artifactPath(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Telegram effect artifact id is invalid")
    return path.join(this.root, `${id}.json`)
  }

  read(id: string): TelegramEffectArtifact {
    const filePath = this.artifactPath(id)
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size < 2 || stat.size > 256 * 1024) throw new Error("Telegram effect artifact is not a bounded regular file")
      const artifact = JSON.parse(fs.readFileSync(fd, "utf8")) as TelegramEffectArtifact
      if (artifact.schemaVersion !== 1 || artifact.id !== id || typeof artifact.idempotencyKey !== "string" || !artifact.idempotencyKey
        || !["butler", "control", "system_failsafe"].includes(artifact.authorClass)
        || !artifact.target || !["approved_relationship", "admission_gate"].includes(artifact.target.kind)
        || !artifact.effect || !["text", "admission_ack", "card", "edit", "callback_ack"].includes(artifact.effect.kind)
        || typeof artifact.authorizationReceiptId !== "string" || !artifact.authorizationReceiptId
        || !Number.isFinite(Date.parse(artifact.authorizationExpiresAt))
        || !Array.isArray(artifact.parts) || artifact.parts.length < 1 || artifact.parts.length > 100
        || artifact.parts.some((part, index) => part.index !== index || (part.text !== null && typeof part.text !== "string")
          || !["prepared", "attempting", "accepted", "session_recorded", "indeterminate"].includes(part.state)
          || (part.messageId !== undefined && (!Number.isSafeInteger(part.messageId) || part.messageId < 1)))) {
        throw new Error("Telegram effect artifact is invalid")
      }
      return artifact
    } finally {
      fs.closeSync(fd)
    }
  }

  readIfExists(id: string): TelegramEffectArtifact | null {
    const filePath = this.artifactPath(id)
    return fs.existsSync(filePath) ? this.read(id) : null
  }

  write(artifact: TelegramEffectArtifact): void {
    const filePath = this.artifactPath(artifact.id)
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    const fd = fs.openSync(tempPath, "wx", 0o600)
    try {
      fs.writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tempPath, filePath)
    fs.chmodSync(filePath, 0o600)
    const directoryFd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
  }

  list(): TelegramEffectArtifact[] {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => this.read(entry.name.slice(0, -5)))
  }
}

export function prepareTelegramEffect(store: FileTelegramEffectJournal, input: {
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
  authorization: TelegramEffectAuthorization
  now?: string
}): TelegramEffectArtifact {
  if (!input.authorization.allowed) throw new Error(`Telegram effect authorization denied: ${input.authorization.reason}`)
  const idempotencyKey = requireText(input.idempotencyKey, "Telegram effect idempotency key")
  assertEffectTarget(input.target, input.effect, idempotencyKey)
  const id = artifactId(idempotencyKey)
  const existing = store.readIfExists(id)
  if (existing) {
    if (JSON.stringify(existing.target) !== JSON.stringify(input.target)
      || existing.authorClass !== input.authorClass
      || JSON.stringify(existing.effect) !== JSON.stringify(input.effect)) {
      throw new Error("Telegram effect idempotency key was reused for a different effect")
    }
    return existing
  }
  const now = input.now ?? new Date().toISOString()
  const artifact: TelegramEffectArtifact = {
    schemaVersion: 1,
    id,
    idempotencyKey,
    target: input.target,
    authorClass: input.authorClass,
    effect: input.effect,
    authorizationReceiptId: input.authorization.receiptId,
    authorizationExpiresAt: input.authorization.expiresAt,
    parts: preparedTexts(input.effect).map((text, index) => ({ index, text, state: "prepared", updatedAt: now })),
    createdAt: now,
    updatedAt: now,
  }
  store.write(artifact)
  emitNervesEvent({ component: "senses", event: "senses.telegram_effect_prepared", message: "prepared Telegram effect", meta: { artifactId: id, effectKind: input.effect.kind, targetKind: input.target.kind, partCount: artifact.parts.length } })
  return artifact
}

function canonicalMessageId(result: unknown): number {
  const messageId = result && typeof result === "object" && !Array.isArray(result) ? (result as { message_id?: unknown }).message_id : undefined
  if (!Number.isSafeInteger(messageId) || (messageId as number) < 1) throw new Error("Telegram effect response omitted message_id")
  return messageId as number
}

async function executePart(api: TelegramBotApi, artifact: TelegramEffectArtifact, part: TelegramEffectPart): Promise<number | undefined> {
  const chatId = artifact.target.chatId
  const effect = artifact.effect
  if (effect.kind === "text" || effect.kind === "admission_ack") {
    const ids = await sendTelegramText(api, chatId, part.text ?? "")
    if (ids.length !== 1) throw new Error("Telegram effect chunk renderer returned an unexpected message count")
    return ids[0]
  }
  if (effect.kind === "card") {
    const result = await api.request("sendMessage", {
      chat_id: chatId,
      text: escapeTelegramHtml(effect.text),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: effect.buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) },
    })
    return canonicalMessageId(result)
  }
  if (effect.kind === "edit") {
    await api.request("editMessageText", { chat_id: chatId, message_id: effect.messageId, text: escapeTelegramHtml(effect.text), parse_mode: "HTML" })
    return effect.messageId
  }
  await api.request("answerCallbackQuery", { callback_query_id: effect.callbackQueryId, ...(effect.text ? { text: effect.text } : {}) })
  return undefined
}

export async function executeTelegramEffect(
  store: FileTelegramEffectJournal,
  artifactIdValue: string,
  api: TelegramBotApi,
  reauthorize: (artifact: TelegramEffectArtifact) => TelegramEffectAuthorization,
): Promise<TelegramEffectArtifact> {
  const artifact = store.read(artifactIdValue)
  if (artifact.parts.some((part) => part.state === "indeterminate")) throw new Error("Telegram effect has an indeterminate part and cannot be retried blindly")
  const interrupted = artifact.parts.filter((part) => part.state === "attempting")
  if (interrupted.length > 0) {
    const now = new Date().toISOString()
    for (const part of interrupted) {
      part.state = "indeterminate"
      part.updatedAt = now
    }
    artifact.updatedAt = now
    store.write(artifact)
    throw new Error("Telegram effect has an indeterminate part after an interrupted send and cannot be retried blindly")
  }
  const authorization = reauthorize(artifact)
  if (!authorization.allowed) throw new Error(`Telegram effect authorization denied: ${authorization.reason}`)
  const nowMs = Date.now()
  if (Date.parse(authorization.expiresAt) <= nowMs) throw new Error("Telegram effect authorization expired")
  artifact.authorizationReceiptId = authorization.receiptId
  artifact.authorizationExpiresAt = authorization.expiresAt
  for (const part of artifact.parts) {
    if (part.state === "accepted" || part.state === "session_recorded") continue
    const attemptingAt = new Date().toISOString()
    part.state = "attempting"
    part.updatedAt = attemptingAt
    artifact.updatedAt = attemptingAt
    store.write(artifact)
    try {
      const messageId = await executePart(api, artifact, part)
      part.state = "accepted"
      if (messageId !== undefined) part.messageId = messageId
      part.updatedAt = new Date().toISOString()
      artifact.updatedAt = part.updatedAt
      store.write(artifact)
    } catch (error) {
      part.state = "indeterminate"
      part.updatedAt = new Date().toISOString()
      artifact.updatedAt = part.updatedAt
      store.write(artifact)
      emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_effect_indeterminate", message: "Telegram effect became indeterminate", meta: { artifactId: artifact.id, partIndex: part.index, effectKind: artifact.effect.kind, error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
  }
  emitNervesEvent({ component: "senses", event: "senses.telegram_effect_accepted", message: "Telegram effect accepted", meta: { artifactId: artifact.id, effectKind: artifact.effect.kind, partCount: artifact.parts.length } })
  return artifact
}

export function recordTelegramEffectInSession(store: FileTelegramEffectJournal, artifactIdValue: string, sessionEventIds: string[]): TelegramEffectArtifact {
  const artifact = store.read(artifactIdValue)
  const accepted = artifact.parts.filter((part) => part.state === "accepted")
  if (accepted.length !== sessionEventIds.length || sessionEventIds.some((value) => !value.trim())) throw new Error("Telegram session event ids do not match accepted effect parts")
  accepted.forEach((part, index) => {
    part.state = "session_recorded"
    part.sessionEventId = sessionEventIds[index]
    part.updatedAt = new Date().toISOString()
  })
  artifact.updatedAt = new Date().toISOString()
  store.write(artifact)
  emitNervesEvent({ component: "senses", event: "senses.telegram_effect_session_recorded", message: "recorded Telegram effect in session continuity", meta: { artifactId: artifact.id, authorClass: artifact.authorClass, partCount: accepted.length } })
  return artifact
}

function artifactEventContent(artifact: TelegramEffectArtifact, part: TelegramEffectPart): string {
  const text = part.text ?? ""
  if (artifact.authorClass === "butler") return text
  if (artifact.authorClass === "control") return `[Telegram control artifact]\n${text}`
  return `[System failsafe already sent]\n${text}`
}

export function appendTelegramArtifactEvents(envelope: SessionEnvelope, artifact: TelegramEffectArtifact, recordedAt: string): { envelope: SessionEnvelope; eventIds: string[] } {
  const accepted = artifact.parts.filter((part) => part.state === "accepted")
  if (accepted.length === 0) throw new Error("Telegram artifact has no accepted parts to record")
  let sequence = envelope.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0)
  const events: SessionEvent[] = accepted.map((part) => {
    sequence += 1
    const id = `evt-${String(sequence).padStart(6, "0")}`
    const role = artifact.authorClass === "butler" ? "assistant" as const : "system" as const
    const name = artifact.authorClass === "butler"
      ? "telegram-butler"
      : artifact.authorClass === "control" ? "telegram-control" : "telegram-system-failsafe"
    return {
      id,
      sequence,
      role,
      content: artifactEventContent(artifact, part),
      name,
      toolCallId: null,
      toolCalls: [],
      attachments: [],
      time: { authoredAt: recordedAt, authoredAtSource: "local", observedAt: recordedAt, observedAtSource: "local", recordedAt, recordedAtSource: "save" },
      relations: {
        replyToEventId: null,
        threadRootEventId: null,
        references: [
          `telegram-artifact:${artifact.id}`,
          ...(part.messageId ? [`telegram-message:${part.messageId}`] : []),
          ...(artifact.target.kind === "approved_relationship" && artifact.target.requestId ? [`request:${artifact.target.requestId}`] : []),
        ],
        toolCallId: null,
        supersedesEventId: null,
        redactsEventId: null,
      },
      provenance: { captureKind: "synthetic", legacyVersion: null, sourceMessageIndex: null },
    }
  })
  const eventIds = events.map((event) => event.id)
  return {
    envelope: {
      ...envelope,
      events: [...envelope.events, ...events],
      projection: { ...envelope.projection, eventIds: [...envelope.projection.eventIds, ...eventIds], projectedAt: recordedAt, trimmed: false },
    },
    eventIds,
  }
}

export function appendTelegramInboundEvent(envelope: SessionEnvelope, input: { text: string; reference: string; recordedAt: string }): SessionEnvelope {
  if (envelope.events.some((event) => event.relations.references.includes(input.reference))) return envelope
  const sequence = envelope.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1
  const id = `evt-${String(sequence).padStart(6, "0")}`
  const event: SessionEvent = {
    id,
    sequence,
    role: "user",
    content: input.text,
    name: "telegram-user",
    toolCallId: null,
    toolCalls: [],
    attachments: [],
    time: { authoredAt: null, authoredAtSource: "unknown", observedAt: input.recordedAt, observedAtSource: "ingest", recordedAt: input.recordedAt, recordedAtSource: "save" },
    relations: { replyToEventId: null, threadRootEventId: null, references: [input.reference], toolCallId: null, supersedesEventId: null, redactsEventId: null },
    provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
  }
  return {
    ...envelope,
    events: [...envelope.events, event],
    projection: { ...envelope.projection, eventIds: [...envelope.projection.eventIds, id], projectedAt: input.recordedAt, trimmed: false },
  }
}

export async function recordTelegramEffectsInSession(input: {
  store: FileTelegramEffectJournal
  sessionPath: string
  artifacts: TelegramEffectArtifact[]
  inbound?: { text: string; reference: string }
}): Promise<{ eventId: string; reference: string } | null> {
  if (input.artifacts.length === 0 && !input.inbound) return null
  return withSessionTurnLease(input.sessionPath, async (lease) => {
    const transaction = readSessionTransaction(input.sessionPath, lease)
    let envelope = loadSessionEnvelopeFile(input.sessionPath) ?? {
      version: 2 as const,
      events: [],
      projection: { eventIds: [], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }
    let inboundReceipt: { eventId: string; reference: string } | null = null
    let changed = false
    if (input.inbound) {
      const existing = envelope.events.filter((event) => event.relations.references.includes(input.inbound!.reference))
      if (existing.length > 1 || (existing.length === 1 && (existing[0]!.role !== "user" || existing[0]!.content !== input.inbound.text))) {
        throw new Error("Telegram session has conflicting inbound ingress")
      }
      if (existing.length === 1) {
        inboundReceipt = { eventId: existing[0]!.id, reference: input.inbound.reference }
      } else {
        envelope = appendTelegramInboundEvent(envelope, { ...input.inbound, recordedAt: new Date().toISOString() })
        inboundReceipt = { eventId: envelope.events.at(-1)!.id, reference: input.inbound.reference }
        changed = true
      }
    }
    const recordings: Array<{ artifact: TelegramEffectArtifact; eventIds: string[] }> = []
    for (const artifact of input.artifacts) {
      const unrecorded = artifact.parts.filter((part) => part.state === "accepted")
      if (unrecorded.length === 0) continue
      const reference = `telegram-artifact:${artifact.id}`
      const existingIds = envelope.events.filter((event) => event.relations.references.includes(reference)).map((event) => event.id)
      if (existingIds.length === unrecorded.length) {
        recordings.push({ artifact, eventIds: existingIds })
        continue
      }
      if (existingIds.length !== 0) throw new Error("Telegram effect session reconciliation is partial")
      const appended = appendTelegramArtifactEvents(envelope, artifact, new Date().toISOString())
      envelope = appended.envelope
      recordings.push({ artifact, eventIds: appended.eventIds })
      changed = true
    }
    if (changed) writeSessionTransaction(input.sessionPath, envelope, { lease, expectedRevision: transaction.revision })
    for (const recording of recordings) recordTelegramEffectInSession(input.store, recording.artifact.id, recording.eventIds)
    return inboundReceipt
  })
}

export function resolveTelegramReply(store: FileTelegramEffectJournal, input: { messageId: number; chatId: string; friendId: string; sessionKey: string }): { artifactId: string; authorClass: TelegramArtifactAuthorClass; sessionEventId: string; requestId: string | null } | null {
  for (const artifact of store.list()) {
    if (artifact.target.kind !== "approved_relationship" || artifact.target.chatId !== input.chatId || artifact.target.friendId !== input.friendId || artifact.target.sessionKey !== input.sessionKey) continue
    const part = artifact.parts.find((candidate) => candidate.messageId === input.messageId && candidate.state === "session_recorded" && candidate.sessionEventId)
    if (!part?.sessionEventId) continue
    return {
      artifactId: artifact.id,
      authorClass: artifact.authorClass,
      sessionEventId: part.sessionEventId,
      requestId: artifact.target.requestId ?? null,
    }
  }
  return null
}
