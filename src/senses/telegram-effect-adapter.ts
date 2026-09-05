import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { bindPrivilegedFailsafeArtifact, listExternalEventStatus, readExternalEventRecord, type ExternalEventRecord } from "../heart/external-events/router"
import { loadSessionEnvelopeFile, type SessionEnvelope, type SessionEvent, type SessionIngressRelations } from "../heart/session-events"
import { currentSessionTurnLease, readSessionTransaction, withSessionTurnLease, writeSessionTransaction, type SessionTurnLease } from "../mind/session-transaction"
import { escapeTelegramHtml, sendTelegramText, splitTelegramText, TelegramApiError, type TelegramBotApi } from "./telegram-client"

export const FIXED_ADMISSION_ACKNOWLEDGEMENT = "Thanks — I’ve asked Ari. Your message is still unread and unprocessed; I’ll only read it if Ari welcomes you in."
export const FIXED_USENET_SYSTEM_FAILSAFE = "Quick heads-up: I paused downloads because the server was discarding most of what it fetched. Nothing needs doing this second — I’ll investigate and follow up when I’m back online."
const SYSTEM_FAILSAFE_UNAVAILABLE_MS = 2 * 60_000

export type TelegramEffectTarget =
  | { kind: "approved_relationship"; friendId: string; sessionKey: string; requestId?: string }
  | { kind: "admission_gate"; admissionId: string; botId: string; userId: string; chatId: string }

export type TelegramEffect =
  | { kind: "text"; text: string }
  | { kind: "admission_ack"; text: typeof FIXED_ADMISSION_ACKNOWLEDGEMENT }
  | { kind: "card"; text: string; buttons: Array<Array<{ text: string; callbackData: string }>> }
  | { kind: "edit"; messageId: number; text: string }
  | { kind: "callback_ack"; callbackQueryId: string; text?: string; showAlert?: boolean }

export type TelegramArtifactAuthorClass = "butler" | "control" | "system_failsafe"
export type TelegramEffectPartState = "prepared" | "attempting" | "accepted" | "session_recorded" | "indeterminate"

export interface TelegramEffectPart {
  index: number
  text: string | null
  state: TelegramEffectPartState
  messageId?: number
  sessionEventId?: string
  acceptedAt?: string
  sessionRecordedAt?: string
  attempts?: number
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
  obligationReturnId?: string
  parts: TelegramEffectPart[]
  createdAt: string
  updatedAt: string
}

function isTransportOnlyControl(artifact: Pick<TelegramEffectArtifact, "authorClass" | "effect" | "target">): boolean {
  return artifact.authorClass === "control" && artifact.effect.kind !== "text"
}

export type TelegramEffectAuthorization =
  | { allowed: true; receiptId: string; expiresAt: string; transport: { chatId: string } }
  | { allowed: false; reason: string }

export interface TelegramEffectAuthorizationInput {
  phase: "prepare" | "send"
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
  artifact?: TelegramEffectArtifact
}

export interface TelegramAuthorizedEffectInput {
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
  obligationReturnId?: string
  signal?: AbortSignal
  onMessageDelivered?: (messageId: number, chunk: string) => void
}

export interface TelegramApprovalEffectPort {
  sendText(input: { idempotencyKey: string; chatId: string; text: string; authorClass: TelegramArtifactAuthorClass; causalEventId?: string; signal?: AbortSignal }): Promise<number[]>
  sendCard(input: { idempotencyKey: string; chatId: string; text: string; buttons: Array<Array<{ text: string; callbackData: string }>>; signal?: AbortSignal }): Promise<number>
  edit(input: { idempotencyKey: string; chatId: string; messageId: number; text: string; signal?: AbortSignal }): Promise<void>
  acknowledge(input: { idempotencyKey: string; callbackQueryId: string; text?: string; showAlert?: boolean; signal?: AbortSignal }): Promise<void>
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

function renderTelegramButlerHtml(text: string): string {
  let html = ""
  let cursor = 0
  const styledText = /`([^`\n]+)`|\*\*([\p{L}\p{N}](?:[^*_`\n]*\S)?)\*\*|\*([\p{L}\p{N}](?:[^*_`\n]*\S)?)\*|_([\p{L}\p{N}](?:[^*_`\n]*\S)?)_/gu
  for (const match of text.matchAll(styledText)) {
    const gap = text.slice(cursor, match.index)
    if (/[*_`]/u.test(gap)) return escapeTelegramHtml(text)
    html += escapeTelegramHtml(gap)
    if (match[1] !== undefined) html += `<code>${escapeTelegramHtml(match[1])}</code>`
    else if (match[2] !== undefined || match[3] !== undefined) html += `<b>${escapeTelegramHtml((match[2] ?? match[3])!)}</b>`
    else html += `<i>${escapeTelegramHtml(match[4]!)}</i>`
    cursor = match.index + match[0].length
  }
  const tail = text.slice(cursor)
  return /[*_`]/u.test(tail) ? escapeTelegramHtml(text) : html + escapeTelegramHtml(tail)
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

function canonicalTarget(target: TelegramEffectTarget): TelegramEffectTarget {
  if (!target || typeof target !== "object") throw new Error("Telegram effect artifact is invalid")
  if (target.kind === "admission_gate") return target
  return {
    kind: "approved_relationship",
    friendId: target.friendId,
    sessionKey: target.sessionKey,
    ...(target.requestId ? { requestId: target.requestId } : {}),
  }
}

function boundedText(value: unknown, max = 50_000): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max
}

function canonicalTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function validateArtifact(artifact: TelegramEffectArtifact, expectedId: string): void {
  const target = artifact?.target
  const effect = artifact?.effect
  const targetValid = target?.kind === "approved_relationship"
    ? boundedText(target.friendId, 512) && boundedText(target.sessionKey, 512)
      && (target.requestId === undefined || boundedText(target.requestId, 512))
    : target?.kind === "admission_gate" && boundedText(target.admissionId, 512) && /^[1-9][0-9]*$/u.test(target.botId)
      && /^[1-9][0-9]*$/u.test(target.userId) && /^[1-9][0-9]*$/u.test(target.chatId)
  const effectValid = effect?.kind === "text" || effect?.kind === "admission_ack"
    ? boundedText(effect.text, 150_000)
    : effect?.kind === "card"
      ? boundedText(effect.text) && Array.isArray(effect.buttons) && effect.buttons.length > 0 && effect.buttons.length <= 20
        && effect.buttons.every((row) => Array.isArray(row) && row.length > 0 && row.length <= 8
          && row.every((button) => boundedText(button?.text, 256) && boundedText(button?.callbackData, 64) && Buffer.byteLength(button.callbackData, "utf8") <= 64))
      : effect?.kind === "edit"
        ? Number.isSafeInteger(effect.messageId) && effect.messageId > 0 && boundedText(effect.text)
        : effect?.kind === "callback_ack"
          ? boundedText(effect.callbackQueryId, 512) && (effect.text === undefined || boundedText(effect.text, 512)) && (effect.showAlert === undefined || typeof effect.showAlert === "boolean")
          : false
  let expectedTexts: Array<string | null> = []
  try {
    if (targetValid && effectValid) {
      assertEffectTarget(target, effect, artifact.idempotencyKey)
      expectedTexts = preparedTexts(effect)
    }
  } catch {
    expectedTexts = []
  }
  const partsValid = Array.isArray(artifact.parts) && artifact.parts.length === expectedTexts.length && artifact.parts.length > 0 && artifact.parts.length <= 100
    && artifact.parts.every((part, index) => part.index === index && part.text === expectedTexts[index]
      && ["prepared", "attempting", "accepted", "session_recorded", "indeterminate"].includes(part.state)
      && canonicalTime(part.updatedAt)
      && (part.acceptedAt === undefined || canonicalTime(part.acceptedAt))
      && (part.sessionRecordedAt === undefined || canonicalTime(part.sessionRecordedAt))
      && (part.messageId === undefined || (Number.isSafeInteger(part.messageId) && part.messageId > 0))
      && (part.sessionEventId === undefined || boundedText(part.sessionEventId, 512))
      && (part.attempts === undefined || (Number.isSafeInteger(part.attempts) && part.attempts >= 0 && part.attempts <= 100))
      && (part.state === "session_recorded"
        ? (boundedText(part.sessionEventId, 512) || (isTransportOnlyControl(artifact) && part.sessionEventId === undefined))
        : part.sessionEventId === undefined)
      && ((effect.kind === "callback_ack" || part.state === "prepared" || part.state === "attempting" || part.state === "indeterminate")
        || (Number.isSafeInteger(part.messageId) && part.messageId! > 0)))
  if (artifact.schemaVersion !== 1 || artifact.id !== expectedId || artifact.id !== artifactId(artifact.idempotencyKey)
    || !boundedText(artifact.idempotencyKey, 1024) || !targetValid || !effectValid || expectedTexts.length === 0
    || !["butler", "control", "system_failsafe"].includes(artifact.authorClass)
    || !boundedText(artifact.authorizationReceiptId, 1024) || !canonicalTime(artifact.authorizationExpiresAt)
    || (artifact.obligationReturnId !== undefined && !boundedText(artifact.obligationReturnId, 512))
    || !canonicalTime(artifact.createdAt) || !canonicalTime(artifact.updatedAt) || !partsValid) {
    throw new Error("Telegram effect artifact is invalid")
  }
}

export class FileTelegramEffectJournal {
  private readonly directoryFd: number
  private readonly descriptorRoot: string
  private readonly rootDevice: number
  private readonly rootInode: number
  private closed = false

  constructor(private readonly root: string) {
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root)
      if (stat.isSymbolicLink()) throw new Error("Telegram effect journal root must not be a symbolic link")
      if (!stat.isDirectory()) throw new Error("Telegram effect journal root must be a directory")
    } else {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    }
    this.directoryFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    this.descriptorRoot = root
    fs.fchmodSync(this.directoryFd, 0o700)
    const identity = fs.fstatSync(this.directoryFd)
    this.rootDevice = identity.dev
    this.rootInode = identity.ino
    const verified = fs.lstatSync(root)
    if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o777) !== 0o700) throw new Error("Telegram effect journal root is unsafe")
  }

  private artifactPath(id: string): string {
    if (this.closed) throw new Error("Telegram effect journal is closed")
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Telegram effect artifact id is invalid")
    return path.join(this.descriptorRoot, `${id}.json`)
  }

  private assertRootIdentity(): void {
    const current = fs.lstatSync(this.root)
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== this.rootDevice || current.ino !== this.rootInode) {
      throw new Error("Telegram effect journal root identity changed")
    }
  }

  coordinationPath(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Telegram effect artifact id is invalid")
    this.assertRootIdentity()
    return path.join(path.dirname(this.root), `${path.basename(this.root)}.coordination`, id)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    fs.closeSync(this.directoryFd)
  }

  read(id: string): TelegramEffectArtifact {
    this.assertRootIdentity()
    const filePath = this.artifactPath(id)
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      this.assertRootIdentity()
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size < 2 || stat.size > 512 * 1024) throw new Error("Telegram effect artifact is not a bounded regular file")
      const raw = fs.readFileSync(fd, "utf8")
      const artifact = JSON.parse(raw) as TelegramEffectArtifact
      artifact.target = canonicalTarget(artifact.target)
      validateArtifact(artifact, id)
      if (raw.includes('"chatId"') && artifact.target.kind === "approved_relationship") this.write(artifact)
      return artifact
    } finally {
      fs.closeSync(fd)
    }
  }

  readIfExists(id: string): TelegramEffectArtifact | null {
    const filePath = this.artifactPath(id)
    return fs.existsSync(filePath) ? this.read(id) : null
  }

  quarantineInvalid(id: string, reason: string): void {
    this.assertRootIdentity()
    const filePath = this.artifactPath(id)
    if (!fs.existsSync(filePath)) return
    const quarantineRoot = path.join(path.dirname(this.root), `${path.basename(this.root)}.quarantine`)
    fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 })
    fs.chmodSync(quarantineRoot, 0o700)
    const quarantinePath = path.join(quarantineRoot, `${id}.${Date.now()}.${process.pid}.invalid.json`)
    fs.renameSync(filePath, quarantinePath)
    fs.chmodSync(quarantinePath, 0o600)
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.telegram_effect_artifact_quarantined",
      message: "quarantined invalid Telegram effect artifact",
      meta: { artifactId: id, reason },
    })
  }

  write(artifact: TelegramEffectArtifact): void {
    this.assertRootIdentity()
    const filePath = this.artifactPath(artifact.id)
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    const fd = fs.openSync(tempPath, "wx", 0o600)
    try {
      this.assertRootIdentity()
      fs.writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.assertRootIdentity()
    fs.renameSync(tempPath, filePath)
    fs.chmodSync(filePath, 0o600)
    fs.fsyncSync(this.directoryFd)
    this.assertRootIdentity()
  }

  list(): TelegramEffectArtifact[] {
    this.assertRootIdentity()
    const entries = fs.readdirSync(this.descriptorRoot, { withFileTypes: true })
    this.assertRootIdentity()
    return entries
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => this.read(entry.name.slice(0, -5)))
  }

  listRecoverable(): TelegramEffectArtifact[] {
    this.assertRootIdentity()
    const entries = fs.readdirSync(this.descriptorRoot, { withFileTypes: true })
    this.assertRootIdentity()
    const artifacts: TelegramEffectArtifact[] = []
    for (const entry of entries.filter((candidate) => candidate.isFile() && /^[a-f0-9]{64}\.json$/u.test(candidate.name))) {
      const id = entry.name.slice(0, -5)
      try {
        artifacts.push(this.read(id))
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.telegram_effect_recovery_artifact_skipped",
          message: "skipped invalid Telegram effect artifact during recovery",
          meta: { artifactId: id, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
    return artifacts
  }
}

export function prepareTelegramEffect(store: FileTelegramEffectJournal, input: {
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
  obligationReturnId?: string
  authorization: TelegramEffectAuthorization
  now?: string
}): TelegramEffectArtifact {
  if (!input.authorization.allowed) throw new Error(`Telegram effect authorization denied: ${input.authorization.reason}`)
  if (!/^[1-9][0-9]*$/u.test(input.authorization.transport.chatId)) throw new Error("Telegram effect authorization returned an invalid transport route")
  const idempotencyKey = requireText(input.idempotencyKey, "Telegram effect idempotency key")
  const target = canonicalTarget(input.target)
  assertEffectTarget(target, input.effect, idempotencyKey)
  if (target.kind === "admission_gate" && input.authorization.transport.chatId !== target.chatId) throw new Error("Telegram admission transport route changed")
  const id = artifactId(idempotencyKey)
  let existing: TelegramEffectArtifact | null = null
  try {
    existing = store.readIfExists(id)
  } catch (error) {
    if (!isTransportOnlyControl({ authorClass: input.authorClass, effect: input.effect, target })) throw error
    store.quarantineInvalid(id, error instanceof Error ? error.message : String(error))
  }
  if (existing) {
    if (JSON.stringify(existing.target) !== JSON.stringify(target)
      || existing.authorClass !== input.authorClass
      || JSON.stringify(existing.effect) !== JSON.stringify(input.effect)
      || existing.obligationReturnId !== input.obligationReturnId) {
      throw new Error("Telegram effect idempotency key was reused for a different effect")
    }
    return existing
  }
  const now = input.now ?? new Date().toISOString()
  const artifact: TelegramEffectArtifact = {
    schemaVersion: 1,
    id,
    idempotencyKey,
    target,
    authorClass: input.authorClass,
    effect: input.effect,
    authorizationReceiptId: input.authorization.receiptId,
    authorizationExpiresAt: input.authorization.expiresAt,
    ...(input.obligationReturnId ? { obligationReturnId: input.obligationReturnId } : {}),
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

async function executePart(api: TelegramBotApi, artifact: TelegramEffectArtifact, part: TelegramEffectPart, chatId: string, signal?: AbortSignal): Promise<number | undefined> {
  const effect = artifact.effect
  if (effect.kind === "text" || effect.kind === "admission_ack") {
    const renderHtml = effect.kind === "text" && artifact.authorClass === "butler" ? renderTelegramButlerHtml : undefined
    const ids = await sendTelegramText(api, chatId, part.text!, { ...(signal ? { signal } : {}), ...(renderHtml ? { renderHtml } : {}) })
    if (ids.length !== 1) throw new Error("Telegram effect chunk renderer returned an unexpected message count")
    return ids[0]
  }
  if (effect.kind === "card") {
    const reply_markup = { inline_keyboard: effect.buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) }
    let result: unknown
    try {
      result = await api.request("sendMessage", { chat_id: chatId, text: escapeTelegramHtml(effect.text), parse_mode: "HTML", reply_markup }, signal)
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
      result = await api.request("sendMessage", { chat_id: chatId, text: effect.text, reply_markup }, signal)
    }
    return canonicalMessageId(result)
  }
  if (effect.kind === "edit") {
    const base = { chat_id: chatId, message_id: effect.messageId, reply_markup: { inline_keyboard: [] as never[] } }
    try {
      await api.request("editMessageText", { ...base, text: escapeTelegramHtml(effect.text), parse_mode: "HTML" }, signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000))
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 400 && /message is not modified/iu.test(error.message)) return effect.messageId
      if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
      try {
        await api.request("editMessageText", { ...base, text: effect.text }, signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000))
      } catch (fallbackError) {
        if (!(fallbackError instanceof TelegramApiError) || fallbackError.status !== 400 || !/message is not modified/iu.test(fallbackError.message)) throw fallbackError
      }
    }
    return effect.messageId
  }
  await api.request("answerCallbackQuery", { callback_query_id: effect.callbackQueryId, ...(effect.text ? { text: effect.text } : {}), ...(effect.showAlert ? { show_alert: true } : {}) }, signal)
  return undefined
}

export async function executeTelegramEffect(
  store: FileTelegramEffectJournal,
  artifactIdValue: string,
  api: TelegramBotApi,
  reauthorize: (artifact: TelegramEffectArtifact) => TelegramEffectAuthorization | Promise<TelegramEffectAuthorization>,
  signal?: AbortSignal,
): Promise<TelegramEffectArtifact> {
  return withSessionTurnLease(store.coordinationPath(artifactIdValue), async () => {
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
    const authorization = await reauthorize(artifact)
    if (!authorization.allowed) throw new Error(`Telegram effect authorization denied: ${authorization.reason}`)
    if (Date.parse(authorization.expiresAt) <= Date.now()) throw new Error("Telegram effect authorization expired")
    if (!/^[1-9][0-9]*$/u.test(authorization.transport.chatId)) throw new Error("Telegram effect authorization returned an invalid transport route")
    if (artifact.target.kind === "admission_gate" && authorization.transport.chatId !== artifact.target.chatId) throw new Error("Telegram admission transport route changed")
    artifact.authorizationReceiptId = authorization.receiptId
    artifact.authorizationExpiresAt = authorization.expiresAt
    for (const part of artifact.parts) {
      if (part.state === "accepted" || part.state === "session_recorded") continue
      if (signal?.aborted) throw signal.reason
      const attemptingAt = new Date().toISOString()
      part.state = "attempting"
      part.attempts = (part.attempts ?? 0) + 1
      part.updatedAt = attemptingAt
      artifact.updatedAt = attemptingAt
      store.write(artifact)
      try {
        const messageId = await executePart(api, artifact, part, authorization.transport.chatId, signal)
        part.state = "accepted"
        if (messageId !== undefined) part.messageId = messageId
        part.acceptedAt = new Date().toISOString()
        part.updatedAt = part.acceptedAt
        artifact.updatedAt = part.updatedAt
        store.write(artifact)
      } catch (error) {
        const safelyRetryable = artifact.effect.kind === "edit" || artifact.effect.kind === "callback_ack"
          || (error instanceof TelegramApiError && error.errorCode !== null)
        part.state = safelyRetryable ? "prepared" : "indeterminate"
        part.updatedAt = new Date().toISOString()
        artifact.updatedAt = part.updatedAt
        store.write(artifact)
        if (!safelyRetryable) emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_effect_indeterminate", message: "Telegram effect became indeterminate", meta: { artifactId: artifact.id, partIndex: part.index, effectKind: artifact.effect.kind, error: error instanceof Error ? error.message : String(error) } })
        throw error
      }
    }
    emitNervesEvent({ component: "senses", event: "senses.telegram_effect_accepted", message: "Telegram effect accepted", meta: { artifactId: artifact.id, effectKind: artifact.effect.kind, partCount: artifact.parts.length } })
    return artifact
  })
}

export function createTelegramAuthorizedEffectExecutor(options: {
  store: FileTelegramEffectJournal | (() => FileTelegramEffectJournal)
  api: TelegramBotApi
  authorize(input: TelegramEffectAuthorizationInput): TelegramEffectAuthorization | Promise<TelegramEffectAuthorization>
  barrier?: () => void
}): (input: TelegramAuthorizedEffectInput) => Promise<TelegramEffectArtifact> {
  const barrier = options.barrier ?? (() => undefined)
  const getStore = (): FileTelegramEffectJournal => typeof options.store === "function" ? options.store() : options.store
  return async (input) => {
    if (input.signal?.aborted) throw input.signal.reason
    barrier()
    const authorization = await options.authorize({ phase: "prepare", ...input })
    if (!authorization.allowed) throw new Error(`Telegram effect authorization denied: ${authorization.reason}`)
    const store = getStore()
    const prepared = prepareTelegramEffect(store, { ...input, authorization })
    try {
      const executed = await executeTelegramEffect(store, prepared.id, options.api, async (artifact) => {
        if (input.signal?.aborted) throw input.signal.reason
        barrier()
        return options.authorize({
          phase: "send",
          idempotencyKey: artifact.idempotencyKey,
          target: artifact.target,
          authorClass: artifact.authorClass,
          effect: artifact.effect,
          artifact,
        })
      }, input.signal)
      barrier()
      for (const part of executed.parts) {
        if (part.messageId !== undefined && part.text !== null) input.onMessageDelivered?.(part.messageId, part.text)
      }
      return executed
    } catch (error) {
      const attempted = store.read(prepared.id)
      for (const part of attempted.parts) {
        if ((part.state === "accepted" || part.state === "session_recorded") && part.messageId !== undefined && part.text !== null) {
          input.onMessageDelivered?.(part.messageId, part.text)
        }
      }
      throw error
    }
  }
}

export async function reconcileTelegramSystemFailsafe(input: {
  record: ExternalEventRecord
  now?: () => string
  target: TelegramEffectTarget
  verifyProtectiveState(action: NonNullable<ExternalEventRecord["privilegedProtectiveAction"]>): Promise<{ verified: boolean; reference: string }>
  execute(input: TelegramAuthorizedEffectInput): Promise<TelegramEffectArtifact>
  recordArtifact(artifact: TelegramEffectArtifact): Promise<void>
  bindArtifact(recordPath: string, input: { artifactId: string; verificationRef: string; recordedAt?: string }): ExternalEventRecord
}): Promise<{ sent: boolean; reason: string; artifactId?: string }> {
  const { record } = input
  const action = record.privilegedProtectiveAction
  if (record.privilegedFailsafe) return { sent: false, reason: "already_recorded", artifactId: record.privilegedFailsafe.artifactId }
  if (record.agent !== "sanctuary" || record.source !== "sanctuary-usenet" || record.eventType !== "usenet.protective_action"
    || record.priority !== "critical" || !action?.critical) return { sent: false, reason: "noncritical" }
  if (!action.verification.verified) return { sent: false, reason: "unverified" }
  if (action.action !== "sabnzbd.pause") return { sent: false, reason: "policy_blocked" }
  if (record.dispatchEnabled === false) return { sent: false, reason: "policy_blocked" }
  if ((record.executionState !== "retry_wait" && record.executionState !== "dead_letter") || !record.lastError || record.attemptCount < 1) {
    return { sent: false, reason: "butler_available" }
  }
  const now = input.now?.() ?? new Date().toISOString()
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs) || nowMs - Date.parse(record.updatedAt) < SYSTEM_FAILSAFE_UNAVAILABLE_MS) return { sent: false, reason: "unavailability_window" }
  if (nowMs > Date.parse(action.expiresAt)) return { sent: false, reason: "expired" }
  const verification = await input.verifyProtectiveState(action)
  if (!verification.verified || !verification.reference.trim() || Buffer.byteLength(verification.reference) > 512) return { sent: false, reason: "unverified" }
  const artifact = await input.execute({
    idempotencyKey: `system-failsafe:${action.transitionId}`,
    target: input.target,
    authorClass: "system_failsafe",
    effect: { kind: "text", text: FIXED_USENET_SYSTEM_FAILSAFE },
  })
  await input.recordArtifact(artifact)
  input.bindArtifact(record.recordPath, { artifactId: artifact.id, verificationRef: verification.reference, recordedAt: now })
  emitNervesEvent({ component: "senses", event: "senses.telegram_system_failsafe_sent", message: "sent verified Sanctuary system failsafe", meta: { artifactId: artifact.id, eventId: record.eventId, transitionId: action.transitionId } })
  return { sent: true, reason: "sent", artifactId: artifact.id }
}

export async function sweepTelegramSystemFailsafes(input: {
  eventRoot: string
  now?: () => string
  target: TelegramEffectTarget
  verifyProtectiveState(action: NonNullable<ExternalEventRecord["privilegedProtectiveAction"]>): Promise<{ verified: boolean; reference: string }>
  execute(input: TelegramAuthorizedEffectInput): Promise<TelegramEffectArtifact>
  recordArtifact(artifact: TelegramEffectArtifact): Promise<void>
}): Promise<{ inspected: number; sent: number }> {
  const records = listExternalEventStatus(input.eventRoot).filter((status) => !status.corrupt && status.agent === "sanctuary" && status.source === "sanctuary-usenet").slice(0, 32)
  let sent = 0
  for (const status of records) {
    const result = await reconcileTelegramSystemFailsafe({
      record: readExternalEventRecord(status.recordPath),
      ...(input.now ? { now: input.now } : {}),
      target: input.target,
      verifyProtectiveState: input.verifyProtectiveState,
      execute: input.execute,
      recordArtifact: input.recordArtifact,
      bindArtifact: bindPrivilegedFailsafeArtifact,
    })
    if (result.sent) sent += 1
  }
  return { inspected: records.length, sent }
}

export async function recoverTelegramEffectOutbox(input: {
  store: FileTelegramEffectJournal
  execute(input: TelegramAuthorizedEffectInput): Promise<TelegramEffectArtifact>
  maxArtifacts?: number
  matches?: (artifact: TelegramEffectArtifact) => boolean
}): Promise<{ attempted: number; accepted: number; failed: number }> {
  const limit = Math.min(Math.max(input.maxArtifacts ?? 20, 1), 100)
  const candidates = input.store.listRecoverable()
    .filter((artifact) => (!input.matches || input.matches(artifact))
      && !artifact.parts.some((part) => part.state === "attempting" || part.state === "indeterminate")
      && artifact.parts.some((part) => part.state === "prepared" && (part.attempts ?? 0) < 3))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(0, limit)
  let accepted = 0
  let failed = 0
  for (const artifact of candidates) {
    try {
      await input.execute({ idempotencyKey: artifact.idempotencyKey, target: artifact.target, authorClass: artifact.authorClass, effect: artifact.effect, ...(artifact.obligationReturnId ? { obligationReturnId: artifact.obligationReturnId } : {}) })
      accepted += 1
    } catch {
      failed += 1
    }
  }
  return { attempted: candidates.length, accepted, failed }
}

export function createTelegramApprovalEffectPort(options: {
  target: TelegramEffectTarget
  chatId: string
  execute(input: TelegramAuthorizedEffectInput): Promise<TelegramEffectArtifact>
  record(artifact: TelegramEffectArtifact, causalEventId?: string): Promise<void>
}): TelegramApprovalEffectPort {
  const executeAndRecord = async (input: Omit<TelegramAuthorizedEffectInput, "target">, causalEventId?: string): Promise<TelegramEffectArtifact> => {
    const artifact = await options.execute({ ...input, target: options.target })
    await options.record(artifact, causalEventId)
    return artifact
  }
  return {
    async sendText(input) {
      if (input.chatId !== options.chatId) throw new Error("Telegram approval text target changed")
      const artifact = await executeAndRecord({ idempotencyKey: input.idempotencyKey, authorClass: input.authorClass, effect: { kind: "text", text: input.text }, ...(input.signal ? { signal: input.signal } : {}) }, input.causalEventId)
      return artifact.parts.flatMap((part) => part.messageId === undefined ? [] : [part.messageId])
    },
    async sendCard(input) {
      if (input.chatId !== options.chatId) throw new Error("Telegram approval card target changed")
      const artifact = await executeAndRecord({ idempotencyKey: input.idempotencyKey, authorClass: "control", effect: { kind: "card", text: input.text, buttons: input.buttons }, ...(input.signal ? { signal: input.signal } : {}) })
      const messageId = artifact.parts[0]?.messageId
      if (!messageId) throw new Error("Telegram approval card omitted its message id")
      return messageId
    },
    async edit(input) {
      if (input.chatId !== options.chatId) throw new Error("Telegram approval edit target changed")
      await executeAndRecord({ idempotencyKey: input.idempotencyKey, authorClass: "control", effect: { kind: "edit", messageId: input.messageId, text: input.text }, ...(input.signal ? { signal: input.signal } : {}) })
    },
    async acknowledge(input) {
      await executeAndRecord({
        idempotencyKey: input.idempotencyKey,
        authorClass: "control",
        effect: { kind: "callback_ack", callbackQueryId: input.callbackQueryId, ...(input.text ? { text: input.text } : {}), ...(input.showAlert ? { showAlert: true } : {}) },
        ...(input.signal ? { signal: input.signal } : {}),
      })
    },
  }
}

export function recordTelegramEffectInSession(store: FileTelegramEffectJournal, artifactIdValue: string, sessionEventIds: string[]): TelegramEffectArtifact {
  const artifact = store.read(artifactIdValue)
  const accepted = artifact.parts.filter((part) => part.state === "accepted")
  const transportOnlyControl = isTransportOnlyControl(artifact)
  if ((!transportOnlyControl && accepted.length !== sessionEventIds.length) || (transportOnlyControl && sessionEventIds.length !== 0) || sessionEventIds.some((value) => !value.trim())) {
    throw new Error("Telegram session event ids do not match accepted effect parts")
  }
  accepted.forEach((part, index) => {
    part.state = "session_recorded"
    if (!transportOnlyControl) part.sessionEventId = sessionEventIds[index]
    part.sessionRecordedAt = new Date().toISOString()
    part.updatedAt = part.sessionRecordedAt
  })
  artifact.updatedAt = new Date().toISOString()
  store.write(artifact)
  emitNervesEvent({ component: "senses", event: "senses.telegram_effect_session_recorded", message: "recorded Telegram effect in session continuity", meta: { artifactId: artifact.id, authorClass: artifact.authorClass, partCount: accepted.length } })
  return artifact
}

function bindButlerArtifactToCanonicalEvent(envelope: SessionEnvelope, artifact: TelegramEffectArtifact, causalEventId?: string): { envelope: SessionEnvelope; eventIds: string[] } | null {
  if (artifact.authorClass !== "butler" || artifact.effect.kind !== "text" || !causalEventId) return null
  const reference = `telegram-artifact:${artifact.id}`
  const candidate = envelope.events.find((event) => event.id === causalEventId && event.role === "assistant")
  if (!candidate) throw new Error("Telegram effect canonical causal event is unavailable")
  const messageReferences = artifact.parts.flatMap((part) => part.messageId ? [`telegram-message:${part.messageId}`] : [])
  const requestReferences = artifact.target.kind === "approved_relationship" && artifact.target.requestId ? [`request:${artifact.target.requestId}`] : []
  const events = envelope.events.map((event) => event.id === candidate.id
    ? { ...event, relations: { ...event.relations, references: [...new Set([...event.relations.references, reference, ...messageReferences, ...requestReferences])] } }
    : event)
  return { envelope: { ...envelope, events }, eventIds: artifact.parts.filter((part) => part.state === "accepted").map(() => candidate.id) }
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

export function appendTelegramInboundEvent(envelope: SessionEnvelope, input: { text: string; reference: string; recordedAt: string; attachmentIds?: readonly string[]; relations?: SessionIngressRelations }): SessionEnvelope {
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
    attachments: [...new Set(input.attachmentIds ?? [])],
    time: { authoredAt: null, authoredAtSource: "unknown", observedAt: input.recordedAt, observedAtSource: "ingest", recordedAt: input.recordedAt, recordedAtSource: "save" },
    relations: {
      replyToEventId: input.relations?.replyToEventId ?? null,
      threadRootEventId: input.relations?.threadRootEventId ?? null,
      references: [...new Set([input.reference, ...(input.relations?.references ?? [])])],
      toolCallId: null,
      supersedesEventId: null,
      redactsEventId: null,
    },
    provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
  }
  return {
    ...envelope,
    events: [...envelope.events, event],
    projection: { ...envelope.projection, eventIds: [...envelope.projection.eventIds, id], projectedAt: input.recordedAt, trimmed: false },
  }
}

export function recordTelegramEffectsInSession(input: {
  store: FileTelegramEffectJournal
  sessionPath: string
  artifacts: TelegramEffectArtifact[]
  inbound: { text: string; reference: string; attachmentIds?: readonly string[]; relations?: SessionIngressRelations }
  causalEventIds?: Readonly<Record<string, string>>
}): Promise<{ eventId: string; reference: string }>
export function recordTelegramEffectsInSession(input: {
  store: FileTelegramEffectJournal
  sessionPath: string
  artifacts: TelegramEffectArtifact[]
  inbound?: { text: string; reference: string; attachmentIds?: readonly string[]; relations?: SessionIngressRelations }
  causalEventIds?: Readonly<Record<string, string>>
}): Promise<{ eventId: string; reference: string } | null>
export async function recordTelegramEffectsInSession(input: {
  store: FileTelegramEffectJournal
  sessionPath: string
  artifacts: TelegramEffectArtifact[]
  inbound?: { text: string; reference: string; attachmentIds?: readonly string[]; relations?: SessionIngressRelations }
  causalEventIds?: Readonly<Record<string, string>>
}): Promise<{ eventId: string; reference: string } | null> {
  if (input.artifacts.length === 0 && !input.inbound) return null
  const record = async (lease: SessionTurnLease): Promise<{ eventId: string; reference: string } | null> => {
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
      const expectedAttachmentIds = [...new Set(input.inbound.attachmentIds ?? [])]
      if (existing.length > 1 || (existing.length === 1 && (existing[0]!.role !== "user" || existing[0]!.content !== input.inbound.text
        || JSON.stringify(existing[0]!.attachments) !== JSON.stringify(expectedAttachmentIds)))) {
        throw new Error("Telegram session has conflicting inbound ingress")
      }
      if (existing.length === 1) {
        inboundReceipt = { eventId: existing[0]!.id, reference: input.inbound.reference }
      } else {
        envelope = appendTelegramInboundEvent(envelope, { ...input.inbound, attachmentIds: expectedAttachmentIds, recordedAt: new Date().toISOString() })
        inboundReceipt = { eventId: envelope.events.at(-1)!.id, reference: input.inbound.reference }
        changed = true
      }
    }
    const recordings: Array<{ artifact: TelegramEffectArtifact; eventIds: string[] }> = []
    for (const artifact of input.artifacts) {
      const unrecorded = artifact.parts.filter((part) => part.state === "accepted")
      if (unrecorded.length === 0) continue
      if (isTransportOnlyControl(artifact)) {
        recordings.push({ artifact, eventIds: [] })
        continue
      }
      const reference = `telegram-artifact:${artifact.id}`
      const existingEvents = envelope.events.filter((event) => event.relations.references.includes(reference))
      if (existingEvents.length > 0) {
        const eventIds = unrecorded.map((part) => existingEvents.find((event) => !part.messageId || event.relations.references.includes(`telegram-message:${part.messageId}`))?.id)
        if (eventIds.every((id): id is string => typeof id === "string")) {
          recordings.push({ artifact, eventIds })
          continue
        }
      }
      if (existingEvents.length !== 0) throw new Error("Telegram effect session reconciliation is partial")
      const appended = bindButlerArtifactToCanonicalEvent(envelope, artifact, input.causalEventIds?.[artifact.id])
        ?? appendTelegramArtifactEvents(envelope, artifact, new Date().toISOString())
      envelope = appended.envelope
      recordings.push({ artifact, eventIds: appended.eventIds })
      changed = true
    }
    if (changed) writeSessionTransaction(input.sessionPath, envelope, { lease, expectedRevision: transaction.revision })
    for (const recording of recordings) recordTelegramEffectInSession(input.store, recording.artifact.id, recording.eventIds)
    return inboundReceipt
  }
  const lease = currentSessionTurnLease(input.sessionPath)
  return lease ? record(lease) : withSessionTurnLease(input.sessionPath, record)
}

export function resolveTelegramReply(store: FileTelegramEffectJournal, input: { messageId: number; friendId: string; sessionKey: string }): { artifactId: string; authorClass: TelegramArtifactAuthorClass; sessionEventId: string; requestId: string | null } | null {
  for (const artifact of store.list()) {
    if (artifact.target.kind !== "approved_relationship" || artifact.target.friendId !== input.friendId || artifact.target.sessionKey !== input.sessionKey) continue
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

export function resolveTelegramControlArtifact(store: FileTelegramEffectJournal, input: { messageId: number; friendId: string; sessionKey: string }): { artifactId: string; requestId: string | null } | null {
  for (const artifact of store.list()) {
    if (artifact.authorClass !== "control" || artifact.target.kind !== "approved_relationship"
      || artifact.effect.kind !== "card"
      || artifact.target.friendId !== input.friendId || artifact.target.sessionKey !== input.sessionKey) continue
    if (!artifact.parts.some((part) => part.messageId === input.messageId && part.state === "session_recorded")) continue
    return { artifactId: artifact.id, requestId: artifact.target.requestId ?? null }
  }
  return null
}
