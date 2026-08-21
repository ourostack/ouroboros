import { createHmac, randomBytes, randomUUID } from "node:crypto"
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as path from "node:path"
import { FileFriendStore } from "@ouro.bot/friends"

import { getAgentRoot } from "../heart/identity"
import { readSanctuaryAcceptanceMarker, sanctuaryAcceptanceEventMeta } from "../heart/daemon/sanctuary-acceptance-marker"
import { readRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { runSenseTurn, type RunSenseTurnOptions, type RunSenseTurnResult } from "./shared-turn"
import {
  createTelegramBotApi,
  createTelegramLongPoll,
  FileTelegramOffsetStore,
  FileTelegramUpdateInboxStore,
  sendTelegramText,
  type TelegramApprovalTransport,
  type TelegramBotApi,
  type TelegramInboundMessage,
  type TelegramLongPoll,
  type TelegramLongPollOptions,
  type TelegramOffsetStore,
  type TelegramUpdateInboxStore,
  type TelegramUpdate,
} from "./telegram-client"
import { createSanctuaryToolContext, runWithSanctuaryToolReceiptCollection } from "./sanctuary-runtime"
import { createTelegramApprovalRuntime, type TelegramApprovalRuntime } from "./telegram-approval-runtime"
import type { SanctuaryHealthSweepResult } from "./sanctuary-health"

export interface TelegramSenseCredentials {
  botToken: string
  authorizedUserId: string
  authorizedChatId: string
}

export interface TelegramSenseApp {
  run(signal?: AbortSignal): Promise<void>
  sendProactive(text: string, signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
}

type TelegramTurnRunner = (options: RunSenseTurnOptions) => Promise<RunSenseTurnResult>
type TelegramLongPollFactory = (options: TelegramLongPollOptions) => TelegramLongPoll
const APPROVAL_EXPIRY_RECONCILE_INTERVAL_MS = 1_000
const APPROVAL_EXPIRY_MAX_CONSECUTIVE_FAILURES = 5
const TELEGRAM_SUBJECT_DOMAIN = "ouroboros.telegram.subject.v1"
const TELEGRAM_IDENTITY_KEY = /^[A-Za-z0-9_-]{43}$/u
const TELEGRAM_SUBJECT = /^tg_[A-Za-z0-9_-]{43}$/u
const TELEGRAM_SUBJECT_INDEX = "identity-subjects.json"
const TELEGRAM_TURN_RECEIPT_DOMAIN = "ouroboros.telegram.turn-receipt.v2"
const telegramTurnLedgerTails = new Map<string, Promise<void>>()

async function appendSanctuaryTurnReceipt(agentRoot: string, receipt: Record<string, unknown>): Promise<void> {
  const filePath = path.join(agentRoot, "state", "acceptance", "telegram-turns.ndjson")
  const previous = telegramTurnLedgerTails.get(filePath) ?? Promise.resolve()
  const current = previous.then(() => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    let existing: string[] = []
    try {
      const raw = readFileSync(filePath, "utf8")
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Telegram turn receipt ledger exceeds its bound")
      existing = raw.split("\n").filter(Boolean)
      if (existing.length > 500 || existing.some((line) => Buffer.byteLength(line) > 16 * 1024)) throw new Error("Telegram turn receipt ledger is invalid")
      for (const line of existing) {
        const value = JSON.parse(line) as Record<string, unknown>
        if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["completedAt", "deliveryCount", "errorCategory", "providerInvocationCount", "responseDigest", "scenarioHandleDigest", "schemaVersion", "sequenceDigest", "status", "telegramMessageIdDigests", "toolInvocationCount", "toolResultDigests", "updateDigest"].sort())
          || value.schemaVersion !== "sanctuary-telegram-turn-receipt-v2" || !/^[0-9a-f]{64}$/u.test(String(value.scenarioHandleDigest))
          || !["success", "error"].includes(String(value.status)) || (value.errorCategory !== null && (typeof value.errorCategory !== "string" || value.errorCategory.length > 128))
          || ![value.updateDigest, value.sequenceDigest, value.responseDigest].every((digest) => /^[0-9a-f]{64}$/u.test(String(digest)))
          || !Array.isArray(value.toolResultDigests) || value.toolResultDigests.length > 100 || !value.toolResultDigests.every((digest) => /^[0-9a-f]{64}$/u.test(String(digest)))
          || !Array.isArray(value.telegramMessageIdDigests) || value.telegramMessageIdDigests.length > 100 || !value.telegramMessageIdDigests.every((digest) => /^[0-9a-f]{64}$/u.test(String(digest)))
          || ![value.providerInvocationCount, value.toolInvocationCount].every((count) => count === null || (Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000))
          || !Number.isSafeInteger(value.deliveryCount) || Number(value.deliveryCount) < 0 || Number(value.deliveryCount) > 100
          || typeof value.completedAt !== "string" || value.completedAt.length > 30 || !Number.isFinite(Date.parse(value.completedAt)) || new Date(Date.parse(value.completedAt)).toISOString() !== value.completedAt) throw new Error("Telegram turn receipt ledger row is invalid")
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const serialized = JSON.stringify(receipt)
    if (Buffer.byteLength(serialized) > 16 * 1024) throw new Error("Telegram turn receipt exceeds its bound")
    const lines = [...existing, serialized].slice(-500)
    const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" })
    const handle = openSync(temporary, "r")
    try { fsyncSync(handle) } finally { closeSync(handle) }
    renameSync(temporary, filePath)
    const directory = openSync(path.dirname(filePath), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  })
  telegramTurnLedgerTails.set(filePath, current)
  try { await current } finally { if (telegramTurnLedgerTails.get(filePath) === current) telegramTurnLedgerTails.delete(filePath) }
}

export interface CreateTelegramSenseAppOptions {
  agentName: string
  credentials: TelegramSenseCredentials
  api?: TelegramBotApi
  offsetStore?: TelegramOffsetStore
  inboxStore?: TelegramUpdateInboxStore
  createLongPoll?: TelegramLongPollFactory
  runTurn?: TelegramTurnRunner
  approvalTransport?: TelegramApprovalTransport
  approvalRuntime?: TelegramApprovalRuntime
  healthSweep?: (() => Promise<SanctuaryHealthSweepResult>) & {
    markDeliveryAttempting?: (deliveryId: string) => void
    markDelivered?: (deliveryId: string, messageIds: number[]) => void
  }
  identityKey?: string
  migrateIdentity?: () => Promise<void>
  subjectIndexHooks?: { afterCreateTemporary?: (temporaryPath: string) => void }
  acceptanceMarker?: () => { scenarioHandleDigest: string } | null
  acceptanceReceiptRoot?: string
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Telegram ${label} is missing`)
  return value.trim()
}

function canonicalTelegramId(value: unknown, label: string): string {
  const text = requiredText(value, label)
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(`Telegram ${label} must be a canonical positive decimal string`)
  return text
}

function canonicalTelegramIdentityKey(value: string): string {
  const key = value.trim()
  if (!TELEGRAM_IDENTITY_KEY.test(key) || Buffer.from(key, "base64url").length !== 32) {
    throw new Error("Telegram opaque identity key is invalid")
  }
  return key
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function openSecureTelegramDirectory(directory: string, afterOpen?: (handle: number) => void): number {
  try {
    const existing = lstatSync(directory)
    if (existing.isSymbolicLink()) throw new Error("Telegram state directory must not be a symbolic link")
    if (!existing.isDirectory()) throw new Error("Telegram state directory is not a directory")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const handle = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    fchmodSync(handle, 0o700)
    afterOpen?.(handle)
    const metadata = fstatSync(handle)
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error("Telegram state directory permissions are invalid")
    }
    return handle
  } catch (error) {
    closeSync(handle)
    throw error
  }
}

export function readOrCreateTelegramIdentityKey(agentRoot: string, hooks: {
  beforeCreate?: (keyPath: string) => void
  afterOpenDirectory?: (handle: number) => void
  afterCreateTemporary?: (temporaryPath: string, keyPath: string) => void
  beforePublish?: (temporaryPath: string, keyPath: string) => void
} = {}): string {
  const directory = path.join(agentRoot, "state", "senses", "telegram")
  const keyPath = path.join(directory, "identity.key")
  const directoryHandle = openSecureTelegramDirectory(directory, hooks.afterOpenDirectory)
  const readKey = (): string => {
    const handle = openSync(keyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const metadata = fstatSync(handle)
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error("Telegram opaque identity key permissions are invalid")
      return canonicalTelegramIdentityKey(readFileSync(handle, "utf8"))
    } finally {
      closeSync(handle)
    }
  }
  try {
    try {
      return readKey()
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const key = randomBytes(32).toString("base64url")
    hooks.beforeCreate?.(keyPath)
    const temporaryPath = path.join(directory, `.identity.key.${randomBytes(12).toString("base64url")}.tmp`)
    let temporaryHandle: number | undefined
    try {
      temporaryHandle = openSync(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
      hooks.afterCreateTemporary?.(temporaryPath, keyPath)
      writeFileSync(temporaryHandle, `${key}\n`)
      fsyncSync(temporaryHandle)
      closeSync(temporaryHandle)
      temporaryHandle = undefined
      hooks.beforePublish?.(temporaryPath, keyPath)
      try {
        linkSync(temporaryPath, keyPath)
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
        return readKey()
      }
      fsyncSync(directoryHandle)
      return key
    } finally {
      if (temporaryHandle !== undefined) closeSync(temporaryHandle)
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      fsyncSync(directoryHandle)
    }
  } finally {
    closeSync(directoryHandle)
  }
}

function opaqueTelegramSubject(identityKey: string, authorizedUserId: string, authorizedChatId: string): string {
  const payload = [
    TELEGRAM_SUBJECT_DOMAIN,
    `user:${authorizedUserId.length}:${authorizedUserId}`,
    `chat:${authorizedChatId.length}:${authorizedChatId}`,
  ].join("\0")
  return `tg_${createHmac("sha256", identityKey).update(payload, "utf8").digest("base64url")}`
}

function readTelegramSubjectIndex(agentRoot: string, subject: string): string[] {
  const indexPath = path.join(agentRoot, "state", "senses", "telegram", TELEGRAM_SUBJECT_INDEX)
  let text: string
  let handle: number | undefined
  try {
    handle = openSync(indexPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const metadata = fstatSync(handle)
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error("Telegram identity subject index permissions are invalid")
    text = readFileSync(handle, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Telegram identity subject index is invalid")
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || record.subject !== subject || !Array.isArray(record.legacySubjects)
    || Object.keys(record).sort().join(",") !== "legacySubjects,subject,version") {
    throw new Error("Telegram identity subject index is invalid")
  }
  const legacySubjects = record.legacySubjects
  if (!legacySubjects.every((candidate): candidate is string => typeof candidate === "string" && TELEGRAM_SUBJECT.test(candidate))) {
    throw new Error("Telegram identity subject index is invalid")
  }
  return [...new Set(legacySubjects)]
}

function discoverTelegramFilesystemSubjects(agentRoot: string): string[] {
  const subjects = new Set<string>()
  const addFriendDirectorySubjects = (root: string): void => {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("telegram-user:")) continue
      const candidate = entry.name.slice("telegram-user:".length)
      if (TELEGRAM_SUBJECT.test(candidate)) subjects.add(candidate)
    }
  }
  addFriendDirectorySubjects(path.join(agentRoot, "state", "sessions"))
  addFriendDirectorySubjects(path.join(agentRoot, "state", "pending"))
  addFriendDirectorySubjects(path.join(agentRoot, "state", "pending-returns"))

  const friendsRoot = path.join(agentRoot, "friends")
  let friendFiles
  try {
    friendFiles = readdirSync(friendsRoot, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [...subjects]
    throw error
  }
  for (const entry of friendFiles) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const friend: unknown = JSON.parse(readFileSync(path.join(friendsRoot, entry.name), "utf8"))
    if (!friend || typeof friend !== "object" || !Array.isArray((friend as { externalIds?: unknown }).externalIds)) {
      throw new Error("Telegram Friend identity record is invalid")
    }
    for (const external of (friend as { externalIds: unknown[] }).externalIds) {
      if (!external || typeof external !== "object") throw new Error("Telegram Friend external identity is invalid")
      const identity = external as { provider?: unknown; externalId?: unknown }
      if (identity.provider === "telegram-user" && typeof identity.externalId === "string" && TELEGRAM_SUBJECT.test(identity.externalId)) {
        subjects.add(identity.externalId)
      }
    }
  }
  return [...subjects]
}

function writeTelegramSubjectIndex(
  agentRoot: string,
  subject: string,
  legacySubjects: readonly string[],
  hooks: { afterCreateTemporary?: (temporaryPath: string) => void } = {},
): void {
  const directory = path.join(agentRoot, "state", "senses", "telegram")
  const indexPath = path.join(directory, TELEGRAM_SUBJECT_INDEX)
  const directoryHandle = openSecureTelegramDirectory(directory)
  const temporaryPath = path.join(directory, `.identity-subjects.${randomBytes(12).toString("base64url")}.tmp`)
  let temporaryHandle: number | undefined
  try {
    temporaryHandle = openSync(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    hooks.afterCreateTemporary?.(temporaryPath)
    const contents = `${JSON.stringify({ version: 1, subject, legacySubjects: [...legacySubjects] }, null, 2)}\n`
    writeFileSync(temporaryHandle, contents)
    fsyncSync(temporaryHandle)
    closeSync(temporaryHandle)
    temporaryHandle = undefined
    renameSync(temporaryPath, indexPath)
    fsyncSync(directoryHandle)
  } finally {
    if (temporaryHandle !== undefined) closeSync(temporaryHandle)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    closeSync(directoryHandle)
  }
}

export async function migrateTelegramFriendIdentity(agentRoot: string, legacyUserId: string, subject: string): Promise<void> {
  const store = new FileFriendStore(path.join(agentRoot, "friends"))
  const legacy = await store.findByExternalId("telegram-user", legacyUserId)
  if (!legacy) return
  const current = await store.findByExternalId("telegram-user", subject)
  if (current && current.id !== legacy.id) throw new Error("Telegram friend identity migration is ambiguous")
  legacy.externalIds = legacy.externalIds.map((external) => external.provider === "telegram-user" && external.externalId === legacyUserId
    ? { ...external, externalId: subject }
    : external)
  if (legacy.name === `Telegram user ${legacyUserId}`) legacy.name = `Telegram user ${subject}`
  legacy.updatedAt = new Date().toISOString()
  await store.put(legacy.id, legacy)
}

export function migrateTelegramSessionIdentity(agentRoot: string, legacyUserId: string, legacyChatId: string, subject: string): void {
  const legacyFriendId = `telegram-user:${legacyUserId}`
  const opaqueFriendId = `telegram-user:${subject}`
  const migrateDirectory = (root: string): string | null => {
    const legacy = path.join(root, legacyFriendId)
    const opaque = path.join(root, opaqueFriendId)
    if (!existsSync(legacy)) return existsSync(opaque) ? opaque : null
    if (existsSync(opaque)) throw new Error("Telegram session identity migration is ambiguous")
    mkdirSync(root, { recursive: true })
    renameSync(legacy, opaque)
    return opaque
  }
  const sessions = migrateDirectory(path.join(agentRoot, "state", "sessions"))
  if (sessions) {
    const legacySession = path.join(sessions, "telegram", `telegram_${legacyChatId}.json`)
    const opaqueSession = path.join(sessions, "telegram", `telegram_${subject}.json`)
    if (existsSync(legacySession)) {
      if (existsSync(opaqueSession)) throw new Error("Telegram session file migration is ambiguous")
      renameSync(legacySession, opaqueSession)
    }
  }
  const pending = migrateDirectory(path.join(agentRoot, "state", "pending"))
  if (pending) {
    const legacyPending = path.join(pending, "telegram", `telegram:${legacyChatId}`)
    const opaquePending = path.join(pending, "telegram", `telegram:${subject}`)
    if (existsSync(legacyPending)) {
      if (existsSync(opaquePending)) throw new Error("Telegram pending identity migration is ambiguous")
      renameSync(legacyPending, opaquePending)
    }
  }
  migrateDirectory(path.join(agentRoot, "state", "pending-returns"))
}

function redactTelegramPrivateValues(error: unknown, privateValues: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const privateValue of privateValues) message = message.split(privateValue).join("[redacted]")
  return message
}

export function parseTelegramSenseCredentials(value: Record<string, unknown>): TelegramSenseCredentials {
  return {
    botToken: requiredText(value.telegramBotToken, "bot token"),
    authorizedUserId: canonicalTelegramId(value.telegramAuthorizedUserId, "authorized user id"),
    authorizedChatId: canonicalTelegramId(value.telegramAuthorizedChatId, "authorized chat id"),
  }
}

export function createTelegramSenseApp(options: CreateTelegramSenseAppOptions): TelegramSenseApp {
  const botToken = requiredText(options.credentials.botToken, "bot token")
  const authorizedUserId = canonicalTelegramId(options.credentials.authorizedUserId, "authorized user id")
  const authorizedChatId = canonicalTelegramId(options.credentials.authorizedChatId, "authorized chat id")
  const agentRoot = getAgentRoot(options.agentName)
  const identityKey = options.identityKey === undefined
    ? readOrCreateTelegramIdentityKey(agentRoot)
    : canonicalTelegramIdentityKey(options.identityKey)
  const subject = opaqueTelegramSubject(identityKey, authorizedUserId, authorizedChatId)
  const transportError = (error: unknown): string => redactTelegramPrivateValues(
    error,
    [botToken, authorizedUserId, authorizedChatId],
  )
  const api = options.api ?? createTelegramBotApi({ token: botToken })
  const offsetStore = options.offsetStore ?? new FileTelegramOffsetStore(
    path.join(agentRoot, "state", "senses", "telegram", "offset.json"),
  )
  const inboxStore = options.inboxStore ?? new FileTelegramUpdateInboxStore(
    path.join(agentRoot, "state", "senses", "telegram", "inbox.json"),
  )
  const runTurn = options.runTurn ?? runSenseTurn
  const useSanctuaryRuntime = options.agentName === "sanctuary" && !options.runTurn
  const toolContext = useSanctuaryRuntime ? createSanctuaryToolContext(options.agentName) : undefined
  const approvalRuntime = options.approvalRuntime ?? (useSanctuaryRuntime ? createTelegramApprovalRuntime({
    agentName: options.agentName,
    api,
    authorizedUserId,
    authorizedChatId,
    subject,
    toolContext: toolContext ?? {},
  }) : undefined)
  const approvalTransport = options.approvalTransport ?? approvalRuntime?.transport
  const healthSweep = options.healthSweep
  const migrateIdentity = options.migrateIdentity ?? (async () => {
    const legacySubjects = new Set([
      ...readTelegramSubjectIndex(agentRoot, subject),
      ...discoverTelegramFilesystemSubjects(agentRoot),
      ...(approvalRuntime?.legacySubjects?.() ?? []),
    ])
    legacySubjects.delete(subject)
    if (legacySubjects.size > 1) throw new Error("Telegram legacy identity subject migration is ambiguous")
    const migrationSubjects = [...legacySubjects]
    for (const legacySubject of migrationSubjects) {
      migrateTelegramSessionIdentity(agentRoot, legacySubject, legacySubject, subject)
      await migrateTelegramFriendIdentity(agentRoot, legacySubject, subject)
    }
    migrateTelegramSessionIdentity(agentRoot, authorizedUserId, authorizedChatId, subject)
    await migrateTelegramFriendIdentity(agentRoot, authorizedUserId, subject)
    approvalRuntime?.migrateIdentity?.(migrationSubjects)
    writeTelegramSubjectIndex(agentRoot, subject, migrationSubjects, options.subjectIndexHooks)
  })
  let approvalReconcileTimer: ReturnType<typeof setTimeout> | undefined
  let approvalReconciliationActive = false
  let approvalReconcileInFlight: Promise<void> | undefined
  let approvalReconcileFailures = 0
  let stopPromise: Promise<void> | undefined
  let runPromise: Promise<void> | undefined

  const clearApprovalReconcileTimer = (): void => {
    if (approvalReconcileTimer) clearTimeout(approvalReconcileTimer)
    approvalReconcileTimer = undefined
  }

  const scheduleApprovalReconcile = (): void => {
    if (!approvalTransport || !approvalReconciliationActive) return
    if (approvalReconcileFailures >= APPROVAL_EXPIRY_MAX_CONSECUTIVE_FAILURES) return
    const delay = APPROVAL_EXPIRY_RECONCILE_INTERVAL_MS * (approvalReconcileFailures === 0 ? 1 : 2 ** approvalReconcileFailures)
    approvalReconcileTimer = setTimeout(() => {
      approvalReconcileTimer = undefined
      const reconciliation = approvalTransport.reconcileExpired().then(() => {
        approvalReconcileFailures = 0
      }).catch((error) => {
        approvalReconcileFailures += 1
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.telegram_approval_reconcile_error",
          message: "Telegram approval expiry reconciliation failed",
          meta: { agentName: options.agentName, subject, error: transportError(error) },
        })
      }).finally(() => {
        approvalReconcileInFlight = undefined
        scheduleApprovalReconcile()
      })
      approvalReconcileInFlight = reconciliation
    }, delay)
  }

  const runHealthSweep = async (): Promise<void> => {
    if (!healthSweep) return
    try {
      const result = await healthSweep()
      if (result.message) {
        if (result.deliveryId) await healthSweep.markDeliveryAttempting?.(result.deliveryId)
        const messageIds = await deliver(result.message)
        if (result.deliveryId) await healthSweep.markDelivered?.(result.deliveryId, messageIds)
        emitNervesEvent({
          component: "senses",
          event: "senses.sanctuary_health_delivered",
          message: "Sanctuary health notification was delivered",
          meta: { agentName: options.agentName, deliveryCount: messageIds.length, ...sanctuaryAcceptanceEventMeta(options.agentName) },
        })
      }
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.sanctuary_health_error",
        message: "Sanctuary deterministic health sweep failed",
        meta: { agentName: options.agentName, subject, error: transportError(error) },
      })
    }
  }

  const deliver = async (text: string, signal?: AbortSignal, onMessageDelivered?: (messageId: number, chunk: string) => void): Promise<number[]> => {
    return sendTelegramText(api, authorizedChatId, text, signal, onMessageDelivered)
  }

  const onMessage = async (message: TelegramInboundMessage): Promise<void> => {
    const acceptanceMarker = options.acceptanceMarker ? options.acceptanceMarker() : readSanctuaryAcceptanceMarker(options.agentName)
    const acceptanceMeta = sanctuaryAcceptanceEventMeta(options.agentName)
    emitNervesEvent({
      component: "senses",
      event: "senses.telegram_turn_start",
      message: "Telegram authorized turn started",
      meta: { agentName: options.agentName, subject, ...acceptanceMeta },
    })
    let deliveryCount = 0
    const deliveredMessageIds: number[] = []
    const deliveredChunks: string[] = []
    let receiptStatus: "success" | "error" = "success"
    let errorCategory: string | null = null
    let providerInvocationCount: number | null = null
    let toolInvocationCount: number | null = null
    let toolResultDigests: string[] = []
    try {
      const collected = await runWithSanctuaryToolReceiptCollection(() => runTurn({
        agentName: options.agentName,
        channel: "telegram",
        sessionKey: `telegram:${subject}`,
        friendId: `telegram-user:${subject}`,
        identity: {
          provider: "telegram-user",
          externalId: subject,
          displayName: `Telegram user ${subject}`,
        },
        userMessage: message.text,
        deliverySink: {
          onDelivery: async (delivery) => {
            await deliver(delivery.text, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) })
            deliveryCount += 1
          },
        },
        ...(toolContext ? { toolContext } : {}),
        ...(approvalRuntime ? { approvalCoordinatorFactory: approvalRuntime.coordinator } : {}),
      }))
      const result = collected.result
      providerInvocationCount = result.providerInvocationCount ?? null
      toolInvocationCount = result.toolInvocationCount ?? null
      toolResultDigests = collected.toolResultDigests
      if (deliveryCount === 0 && result.response.trim()) {
        await deliver(result.response, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) })
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_turn_end",
        message: "Telegram authorized turn completed",
        meta: { agentName: options.agentName, subject, deliveryCount: Math.max(deliveryCount, result.response.trim() ? 1 : 0), ...acceptanceMeta },
      })
    } catch (error) {
      receiptStatus = "error"
      errorCategory = error instanceof Error ? error.name : "unknown"
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.telegram_turn_error",
        message: "Telegram authorized turn failed",
        meta: {
          agentName: options.agentName,
          subject,
          ...acceptanceMeta,
          error: redactTelegramPrivateValues(
            error,
            [botToken, authorizedUserId, authorizedChatId, String(message.updateId), message.messageId],
          ),
        },
      })
      const fallback = "I couldn't complete that turn. The failure was recorded; please try again."
      if (deliveredMessageIds.length === 0) await deliver(fallback, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) })
    } finally {
      if (acceptanceMarker) {
        const hmac = (purpose: string, value: string): string => createHmac("sha256", identityKey).update(`${TELEGRAM_TURN_RECEIPT_DOMAIN}\0${purpose}\0${value}`, "utf8").digest("hex")
        try {
          await appendSanctuaryTurnReceipt(options.acceptanceReceiptRoot ?? agentRoot, {
            schemaVersion: "sanctuary-telegram-turn-receipt-v2",
            scenarioHandleDigest: acceptanceMarker.scenarioHandleDigest,
            status: receiptStatus,
            errorCategory,
            updateDigest: hmac("update", `${message.updateId}\0${message.messageId}`),
            sequenceDigest: hmac("sequence", String(message.updateId)),
            responseDigest: hmac("response", deliveredChunks.join("\n")),
            toolResultDigests,
            providerInvocationCount,
            toolInvocationCount,
            deliveryCount: deliveredMessageIds.length,
            telegramMessageIdDigests: deliveredMessageIds.map((id) => hmac("delivery", String(id))),
            completedAt: new Date().toISOString(),
          })
        } catch (error) {
          emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_acceptance_receipt_error", message: "Telegram acceptance receipt persistence failed", meta: { agentName: options.agentName, scenarioHandleDigest: acceptanceMarker.scenarioHandleDigest, category: error instanceof Error ? error.name : "unknown" } })
        }
      }
    }
  }

  const onUpdate = async (update: TelegramUpdate): Promise<boolean> => {
    if (!update.callback_query || !approvalTransport) return false
    const result = await approvalTransport.handleUpdate(update)
    return result.handled
  }

  const poll = (options.createLongPoll ?? createTelegramLongPoll)({
    api,
    expectedUserId: authorizedUserId,
    expectedChatId: authorizedChatId,
    offsetStore,
    inboxStore,
    onMessage,
    onUpdate,
    acceptanceEventMeta: () => sanctuaryAcceptanceEventMeta(options.agentName),
  })

  return {
    run(signal) {
      if (runPromise) return runPromise
      runPromise = (async () => {
        await migrateIdentity()
        await approvalRuntime?.recover()
        await approvalTransport?.reconcileExpired()
        await runHealthSweep()
        emitNervesEvent({
          component: "senses",
          event: "senses.telegram_poll_start",
          message: "Telegram long poll started",
          meta: { agentName: options.agentName, subject },
        })
        approvalReconciliationActive = true
        scheduleApprovalReconcile()
        try {
          await poll.run(signal)
        } finally {
          approvalReconciliationActive = false
          clearApprovalReconcileTimer()
          await approvalReconcileInFlight
        }
      })()
      return runPromise
    },
    async sendProactive(text, signal) {
      await deliver(requiredText(text, "proactive message"), signal)
    },
    stop() {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        approvalReconciliationActive = false
        clearApprovalReconcileTimer()
        poll.stop()
        await runPromise?.catch(() => undefined)
        await approvalReconcileInFlight
        api.stop()
        approvalRuntime?.close()
        emitNervesEvent({
          component: "senses",
          event: "senses.telegram_poll_end",
          message: "Telegram long poll stopped",
          meta: { agentName: options.agentName, subject },
        })
      })()
      return stopPromise
    },
  }
}

export function loadTelegramSenseCredentials(agentName: string): TelegramSenseCredentials {
  const runtime = readRuntimeCredentialConfig(agentName)
  if (!runtime.ok) {
    throw new Error(`Telegram runtime config is ${runtime.reason}; actor: agent-runnable; run ouro connect telegram --agent ${agentName}`)
  }
  return parseTelegramSenseCredentials(runtime.config)
}

export async function startTelegramSenseApp(agentName: string): Promise<TelegramSenseApp> {
  const app = createTelegramSenseApp({ agentName, credentials: loadTelegramSenseCredentials(agentName) })
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_app_ready",
    message: "Telegram sense app is ready",
    meta: { agentName },
  })
  return app
}
