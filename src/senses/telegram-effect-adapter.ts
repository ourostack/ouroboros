import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import type { SessionEnvelope, SessionEvent } from "../heart/session-events"
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
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    fs.chmodSync(root, 0o700)
  }

  private artifactPath(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Telegram effect artifact id is invalid")
    return path.join(this.root, `${id}.json`)
  }

  read(id: string): TelegramEffectArtifact {
    const filePath = this.artifactPath(id)
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Telegram effect artifact is not a regular file")
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as TelegramEffectArtifact
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

export function resolveTelegramReply(store: FileTelegramEffectJournal, messageId: number): { artifactId: string; authorClass: TelegramArtifactAuthorClass; sessionEventId: string; requestId: string | null } | null {
  for (const artifact of store.list()) {
    const part = artifact.parts.find((candidate) => candidate.messageId === messageId && candidate.state === "session_recorded" && candidate.sessionEventId)
    if (!part?.sessionEventId) continue
    return {
      artifactId: artifact.id,
      authorClass: artifact.authorClass,
      sessionEventId: part.sessionEventId,
      requestId: artifact.target.kind === "approved_relationship" ? artifact.target.requestId ?? null : null,
    }
  }
  return null
}
