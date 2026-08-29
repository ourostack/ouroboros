import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
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
  readSync,
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
import { emitNervesEvent, emitNervesEventDurable } from "../nerves/runtime"
import { registerGlobalLogSink } from "../nerves"
import { createSanctuaryInteractiveControl } from "./sanctuary-interactive-control"
import { getSenseSessionPath, runSenseTurn, type RunSenseTurnOptions, type RunSenseTurnResult } from "./shared-turn"
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
import { createSanctuaryToolContext, runWithSanctuaryToolReceiptCollection, type SanctuaryToolReceiptObserver } from "./sanctuary-runtime"
import { renderSanctuaryGroundedResponse, sanctuaryGroundingDigest } from "./sanctuary-grounding"
import { createTelegramApprovalRuntime, type TelegramApprovalRuntime } from "./telegram-approval-runtime"
import type { SanctuaryHealthSweepResult } from "./sanctuary-health"
import { createTelegramAuditLedger, type TelegramAuditLedger } from "./telegram-audit-ledger"
import { buildCanonicalSessionEnvelope, loadSessionEnvelopeFile, stampIngressTime } from "../heart/session-events"
import { readSessionTransaction, withSessionTurnLease, writeSessionTransaction } from "../mind/session-transaction"
import {
  appendTelegramArtifactEvents,
  executeTelegramEffect,
  FileTelegramEffectJournal,
  prepareTelegramEffect,
  recordTelegramEffectInSession,
  resolveTelegramReply,
  type TelegramEffectArtifact,
  type TelegramEffectAuthorization,
  type TelegramEffectAuthorizationInput,
} from "./telegram-effect-adapter"

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
const TELEGRAM_SUBJECT_DOMAIN = "ouroboros.telegram.subject.v1"
const TELEGRAM_IDENTITY_KEY = /^[A-Za-z0-9_-]{43}$/u
const TELEGRAM_SUBJECT = /^tg_[A-Za-z0-9_-]{43}$/u
const TELEGRAM_SUBJECT_INDEX = "identity-subjects.json"
const TELEGRAM_ACCEPTANCE_AUDIT_EVENTS = new Set([
  "approval.acceptance_continuation_transition",
  "approval.acceptance_transition",
  "senses.sanctuary_health_delivered",
  "senses.sanctuary_read_receipt",
  "senses.telegram_approved_restart_end",
  "senses.telegram_approved_restart_error",
  "senses.telegram_approved_restart_start",
  "senses.telegram_approval_continuation_delivered",
  "senses.telegram_approval_prompt_bound",
  "senses.telegram_turn_end",
  "senses.telegram_turn_error",
  "senses.telegram_turn_start",
  "telegram.approval_prompt_terminalized",
  "telegram.approval_expiry_observed",
  "telegram.approval_stale_callback_settled",
  "telegram.callback_recovery_settled",
  "telegram.callback_settled",
  "telegram.update_dropped",
])
const telegramAcceptanceAuditOwner = new AsyncLocalStorage<string>()
const telegramAcceptanceAuditScenario = new AsyncLocalStorage<string | null>()
const telegramAcceptanceAuditExplicitCommit = new AsyncLocalStorage<boolean>()
type TelegramAcceptanceAuditRecord = {
  agentName: string
  identityKey: string
  ledger: TelegramAuditLedger
  ownerDigest: string
  references: number
  scenarioHandleDigest: string
  unregister: () => void
}
const telegramAcceptanceAudits = new Map<string, TelegramAcceptanceAuditRecord>()
const TELEGRAM_TURN_RECEIPT_DOMAINS = {
  "sanctuary-telegram-turn-receipt-v3": "ouroboros.telegram.turn-receipt.v3",
  "sanctuary-telegram-turn-receipt-v4": "ouroboros.telegram.turn-receipt.v4",
} as const
const TELEGRAM_TURN_LEDGER_MAX_BYTES = 4 * 1024 * 1024
const TELEGRAM_TURN_LEDGER_MAX_ROWS = 500
const TELEGRAM_TURN_LEDGER_MAX_ROW_BYTES = 16 * 1024
const telegramTurnLedgerTails = new Map<string, Promise<void>>()

export function telegramAcceptanceAuditOwnerDigest(identityKey: string, agentName: string, root: string): string {
  return createHmac("sha256", identityKey)
    .update(`ouroboros.telegram.acceptance-audit-owner.v1\0${agentName}\0${root}`, "utf8")
    .digest("hex")
}

function acquireTelegramAcceptanceAudit(
  root: string,
  agentName: string,
  identityKey: string,
  privateValues: readonly string[],
  scenarioHandleDigest: string,
  releaseHook?: () => void,
  maxBytes?: number,
): { ledger: TelegramAuditLedger; ownerDigest: string; scenarioHandleDigest: string; release(): void } {
  const existing = telegramAcceptanceAudits.get(root)
  if (existing) {
    if (existing.identityKey !== identityKey) throw new Error("Telegram acceptance audit identity changed while active")
    if (existing.scenarioHandleDigest !== scenarioHandleDigest) throw new Error("Telegram acceptance audit scenario changed while active")
    existing.ledger.assertHealthy()
    existing.references += 1
    return { ledger: existing.ledger, ownerDigest: existing.ownerDigest, scenarioHandleDigest: existing.scenarioHandleDigest, release: () => {
      existing.references -= 1
      if (existing.references === 0) {
        try { existing.unregister() } finally { telegramAcceptanceAudits.delete(root) }
        releaseHook?.()
      }
    } }
  }
  const ledger = createTelegramAuditLedger({ root, identityKey, privateValues, _maxBytes: maxBytes })
  const ownerDigest = telegramAcceptanceAuditOwnerDigest(identityKey, agentName, root)
  let record!: TelegramAcceptanceAuditRecord
  const unregister = registerGlobalLogSink((event) => {
    if (!TELEGRAM_ACCEPTANCE_AUDIT_EVENTS.has(event.event)) return
    if (telegramAcceptanceAuditExplicitCommit.getStore()) return
    const explicitOwner = event.meta.acceptanceAuditOwnerDigest
    const contextualOwner = telegramAcceptanceAuditOwner.getStore()
    if (explicitOwner !== ownerDigest && contextualOwner !== ownerDigest) return
    const scenario = event.meta.scenarioHandleDigest
    if (typeof scenario !== "string" || !/^[0-9a-f]{64}$/u.test(scenario) || record.scenarioHandleDigest !== scenario) {
      ledger.poison(new Error("Telegram acceptance audit scenario ownership drift"))
    }
    ledger.append(event)
  })
  record = { agentName, identityKey, ledger, ownerDigest, references: 1, scenarioHandleDigest, unregister }
  telegramAcceptanceAudits.set(root, record)
  return { ledger, ownerDigest, scenarioHandleDigest, release: () => {
    record.references -= 1
    if (record.references === 0) {
      try { record.unregister() } finally { telegramAcceptanceAudits.delete(root) }
      releaseHook?.()
    }
  } }
}

export function sanctuaryTelegramTurnReceiptDigest(identityKey: string, schemaVersion: keyof typeof TELEGRAM_TURN_RECEIPT_DOMAINS, purpose: string, value: string): string {
  return createHmac("sha256", identityKey).update(`${TELEGRAM_TURN_RECEIPT_DOMAINS[schemaVersion]}\0${purpose}\0${value}`, "utf8").digest("hex")
}

function canonicalReceiptJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReceiptJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalReceiptJson(record[key])}`).join(",")}}`
  }
  const rendered = JSON.stringify(value)
  if (rendered === undefined) throw new Error("Telegram receipt contains an unsupported value")
  return rendered
}

export function sanctuaryTelegramTurnReceiptMac(identityKey: string, value: Record<string, unknown>): string {
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receiptMac"))
  return sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v4", "receipt", canonicalReceiptJson(unsigned))
}

export function sanctuaryTelegramAuditLifecycleMac(
  identityKey: string,
  schemaVersion: keyof typeof TELEGRAM_TURN_RECEIPT_DOMAINS,
  event: string,
  meta: Record<string, unknown>,
): string {
  const unsigned = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== "lifecycleMac"))
  return sanctuaryTelegramTurnReceiptDigest(identityKey, schemaVersion, "audit-lifecycle", canonicalReceiptJson({ event, meta: unsigned }))
}

export function sanctuaryTelegramUnauthorizedDropMac(
  identityKey: string,
  schemaVersion: keyof typeof TELEGRAM_TURN_RECEIPT_DOMAINS,
  value: {
    scenarioHandleDigest: string
    updateDigest: string
    senderIdentityDigest: string
    authorizedIdentityDigest: string
    senderDistinct: boolean
    nextOffsetDigest: string
  },
): string {
  return sanctuaryTelegramTurnReceiptDigest(identityKey, schemaVersion, "unauthorized-drop", canonicalReceiptJson(value))
}

export function sanctuaryTelegramApprovalEvidenceMac(
  identityKey: string,
  event: string,
  meta: Record<string, unknown>,
): string {
  const unsigned = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== "evidenceMac"))
  return sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v3", "approval-evidence", canonicalReceiptJson({ event, meta: unsigned }))
}

function sameTelegramLedgerMetadata(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function readStableBoundedTelegramLedger(filePath: string, afterPreReadStat?: (filePath: string) => void): string | null {
  let handle: number
  try {
    handle = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    const before = fstatSync(handle, { bigint: true })
    if (!before.isFile()) throw new Error("Telegram turn receipt ledger must be a regular file")
    if (before.size > BigInt(TELEGRAM_TURN_LEDGER_MAX_BYTES)) throw new Error("Telegram turn receipt ledger exceeds its bound")
    afterPreReadStat?.(filePath)
    const expectedBytes = Number(before.size)
    const content = Buffer.allocUnsafe(expectedBytes)
    let offset = 0
    while (offset < expectedBytes) {
      const bytesRead = readSync(handle, content, offset, expectedBytes - offset, offset)
      if (bytesRead === 0) throw new Error("Telegram turn receipt ledger changed during read")
      offset += bytesRead
    }
    const overflow = Buffer.allocUnsafe(1)
    const overflowBytes = readSync(handle, overflow, 0, 1, expectedBytes)
    const after = fstatSync(handle, { bigint: true })
    const pathAfter = lstatSync(filePath, { bigint: true })
    if (overflowBytes !== 0 || !sameTelegramLedgerMetadata(before, after)
      || !pathAfter.isFile() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error("Telegram turn receipt ledger changed during read")
    }
    return content.toString("utf8")
  } finally {
    closeSync(handle)
  }
}

function validateSanctuaryTurnReceipt(value: Record<string, unknown>): void {
  const grounded = value.schemaVersion === "sanctuary-telegram-turn-receipt-v4"
  const exactKeys = ["completedAt", "deliveries", "deliveryCount", "errorCategory", "providerInvocationCount", "responseDigest", "scenarioHandleDigest", "schemaVersion", "sequenceDigest", "status", "toolInvocationCount", "toolResultDigests", "updateDigest", ...(grounded ? ["receiptMac", "toolGroundings"] : [])].sort()
  const deliveries = value.deliveries
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys)
    || (!grounded && value.schemaVersion !== "sanctuary-telegram-turn-receipt-v3")
    || typeof value.scenarioHandleDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.scenarioHandleDigest)
    || (value.status !== "success" && value.status !== "error")
    || (value.status === "success"
      ? value.errorCategory !== null
      : typeof value.errorCategory !== "string" || value.errorCategory.length < 1 || value.errorCategory.length > 128)
    || ![value.updateDigest, value.sequenceDigest, value.responseDigest].every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest))
    || !Array.isArray(value.toolResultDigests) || value.toolResultDigests.length > 100 || !value.toolResultDigests.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest))
    || !Array.isArray(deliveries) || deliveries.length > 100 || !deliveries.every((delivery) => {
      if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return false
      const record = delivery as Record<string, unknown>
      return JSON.stringify(Object.keys(record).sort()) === JSON.stringify(grounded ? ["chunkDigest", "messageIdDigest", "redactedText", "utf16Units"] : ["chunkDigest", "messageIdDigest"])
        && typeof record.chunkDigest === "string" && /^[0-9a-f]{64}$/u.test(record.chunkDigest)
        && typeof record.messageIdDigest === "string" && /^[0-9a-f]{64}$/u.test(record.messageIdDigest)
        && (!grounded || (typeof record.redactedText === "string" && record.redactedText.length === record.utf16Units && record.utf16Units <= 1_200))
    })
    || (grounded && (!Array.isArray(value.toolGroundings) || value.toolGroundings.length !== 1 || !value.toolGroundings.every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
      const record = raw as Record<string, unknown>
      if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["facts", "groundingDigest", "observedAt", "resultDigest", "sourceIdentityDigest", "toolName"]) || (record.toolName !== "unraid_get_system" && record.toolName !== "unraid_get_storage")
        || typeof record.resultDigest !== "string" || !/^[0-9a-f]{64}$/u.test(record.resultDigest) || typeof record.groundingDigest !== "string" || !/^[0-9a-f]{64}$/u.test(record.groundingDigest)
        || typeof record.sourceIdentityDigest !== "string" || !/^[0-9a-f]{64}$/u.test(record.sourceIdentityDigest) || typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt)) || new Date(Date.parse(record.observedAt)).toISOString() !== record.observedAt
        || !record.facts || typeof record.facts !== "object" || Array.isArray(record.facts)) return false
      return sanctuaryGroundingDigest(record.facts as Record<string, unknown>) === record.groundingDigest && (value.toolResultDigests as string[]).includes(record.resultDigest)
    })))
    || (grounded && (typeof value.receiptMac !== "string" || !/^[0-9a-f]{64}$/u.test(value.receiptMac)))
    || ![value.providerInvocationCount, value.toolInvocationCount].every((count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 1_000)
    || !Number.isSafeInteger(value.deliveryCount) || value.deliveryCount !== deliveries.length
    || typeof value.completedAt !== "string" || value.completedAt.length > 30 || !Number.isFinite(Date.parse(value.completedAt)) || new Date(Date.parse(value.completedAt)).toISOString() !== value.completedAt) throw new Error("Telegram turn receipt ledger row is invalid")
}

async function appendSanctuaryTurnReceipt(
  agentRoot: string,
  receipt: Record<string, unknown>,
  afterPreReadStat?: (filePath: string) => void,
): Promise<void> {
  const filePath = path.join(agentRoot, "state", "acceptance", "telegram-turns.ndjson")
  const previous = telegramTurnLedgerTails.get(filePath) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    let existing: string[] = []
    const raw = readStableBoundedTelegramLedger(filePath, afterPreReadStat)
    if (raw !== null) {
      existing = raw.split("\n").filter(Boolean)
      if (existing.length > TELEGRAM_TURN_LEDGER_MAX_ROWS || existing.some((line) => Buffer.byteLength(line) > TELEGRAM_TURN_LEDGER_MAX_ROW_BYTES)) throw new Error("Telegram turn receipt ledger is invalid")
      for (const line of existing) {
        validateSanctuaryTurnReceipt(JSON.parse(line) as Record<string, unknown>)
      }
    }
    validateSanctuaryTurnReceipt(receipt)
    const serialized = JSON.stringify(receipt)
    if (Buffer.byteLength(serialized) > TELEGRAM_TURN_LEDGER_MAX_ROW_BYTES) throw new Error("Telegram turn receipt exceeds its bound")
    const lines = [...existing, serialized].slice(-TELEGRAM_TURN_LEDGER_MAX_ROWS)
    let aggregateBytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0)
    while (aggregateBytes > TELEGRAM_TURN_LEDGER_MAX_BYTES && lines.length > 1) {
      aggregateBytes -= Buffer.byteLength(lines.shift()!) + 1
    }
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
  acceptanceMarker?: () => { scenarioHandleDigest: string; label?: string } | null
  acceptanceReceiptRoot?: string
  /** Test seam for observing receipt evidence across a rejected turn. */
  _runWithToolReceiptCollection?: typeof runWithSanctuaryToolReceiptCollection
  /** Test seam for simulating a ledger mutation after its pre-read metadata check. */
  _afterAcceptanceLedgerPreReadStat?: (filePath: string) => void
  /** Test seam for proving constructor/stop release error aggregation. */
  _acceptanceAuditReleaseHook?: () => void
  /** Test seam for proving exhaustion is fenced before effects. */
  _acceptanceAuditMaxBytes?: number
  /** Test seam for isolating Sanctuary state without changing production root selection. */
  _agentRoot?: string
  /** Test seam for inspecting production approval-runtime wiring. */
  _createApprovalRuntime?: typeof createTelegramApprovalRuntime
  /** Test seam for exercising default Sanctuary orchestration without machine credentials. */
  _toolContext?: ReturnType<typeof createSanctuaryToolContext>
  /** Test seam for exercising default Sanctuary selection with a deterministic turn body. */
  _runTurn?: TelegramTurnRunner
  /** Test seam for avoiding a real Unix control socket in lifecycle tests. */
  _createInteractiveControl?: typeof createSanctuaryInteractiveControl
  /** Revalidates relationship authority immediately before each Telegram effect. */
  authorizeEffect?: (input: TelegramEffectAuthorizationInput) => TelegramEffectAuthorization
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

export function opaqueTelegramSubject(identityKey: string, botToken: string, authorizedUserId: string, authorizedChatId: string): string {
  const payload = [
    TELEGRAM_SUBJECT_DOMAIN,
    `bot:${botToken.length}:${botToken}`,
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
  if (record.version !== 1 || typeof record.subject !== "string" || !TELEGRAM_SUBJECT.test(record.subject) || !Array.isArray(record.legacySubjects)
    || Object.keys(record).sort().join(",") !== "legacySubjects,subject,version") {
    throw new Error("Telegram identity subject index is invalid")
  }
  const legacySubjects = record.legacySubjects
  if (!legacySubjects.every((candidate): candidate is string => typeof candidate === "string" && TELEGRAM_SUBJECT.test(candidate))) {
    throw new Error("Telegram identity subject index is invalid")
  }
  return record.subject === subject ? [] : [record.subject]
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
  const agentRoot = options._agentRoot ?? getAgentRoot(options.agentName)
  const identityKey = options.identityKey === undefined
    ? readOrCreateTelegramIdentityKey(agentRoot)
    : canonicalTelegramIdentityKey(options.identityKey)
  const subject = opaqueTelegramSubject(identityKey, botToken, authorizedUserId, authorizedChatId)
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
  const runTurn = options.runTurn ?? options._runTurn ?? runSenseTurn
  const collectToolReceipts = options._runWithToolReceiptCollection ?? runWithSanctuaryToolReceiptCollection
  const useSanctuaryRuntime = options.agentName === "sanctuary" && !options.runTurn
  const readScenarioHandleDigest = (): string | undefined => (options.acceptanceMarker
    ? options.acceptanceMarker()
    : readSanctuaryAcceptanceMarker(options.agentName))?.scenarioHandleDigest
  let acceptanceAuditLease: ReturnType<typeof acquireTelegramAcceptanceAudit> | undefined
  const retireAcceptanceAudit = (): void => {
    const lease = acceptanceAuditLease
    if (!lease) return
    const errors: unknown[] = []
    try { lease.ledger.assertHealthy() } catch (error) { errors.push(error) }
    try { lease.release() } catch (error) { errors.push(error) }
    finally { acceptanceAuditLease = undefined }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Telegram acceptance audit retirement failed")
  }
  const ensureAcceptanceAudit = (): ReturnType<typeof acquireTelegramAcceptanceAudit> | undefined => {
    if (!useSanctuaryRuntime) return undefined
    const scenarioHandleDigest = readScenarioHandleDigest()
    const effectScenarioHandleDigest = telegramAcceptanceAuditScenario.getStore()
    if (effectScenarioHandleDigest !== undefined && (scenarioHandleDigest ?? null) !== effectScenarioHandleDigest) {
      const error = new Error("Telegram acceptance audit scenario ownership drift")
      acceptanceAuditLease?.ledger.poison(error)
      throw error
    }
    if (scenarioHandleDigest === undefined) {
      if (acceptanceAuditLease) {
        retireAcceptanceAudit()
      }
      return undefined
    }
    if (!/^[0-9a-f]{64}$/u.test(scenarioHandleDigest)) throw new Error("Telegram acceptance audit scenario handle is invalid")
    if (!acceptanceAuditLease) {
      acceptanceAuditLease = acquireTelegramAcceptanceAudit(
        options.acceptanceReceiptRoot ?? agentRoot,
        options.agentName,
        identityKey,
        [botToken, authorizedUserId, authorizedChatId],
        scenarioHandleDigest,
        options._acceptanceAuditReleaseHook,
        options._acceptanceAuditMaxBytes,
      )
    } else if (scenarioHandleDigest !== acceptanceAuditLease.scenarioHandleDigest) {
      retireAcceptanceAudit()
      acceptanceAuditLease = acquireTelegramAcceptanceAudit(
        options.acceptanceReceiptRoot ?? agentRoot,
        options.agentName,
        identityKey,
        [botToken, authorizedUserId, authorizedChatId],
        scenarioHandleDigest,
        options._acceptanceAuditReleaseHook,
        options._acceptanceAuditMaxBytes,
      )
    }
    return acceptanceAuditLease
  }
  ensureAcceptanceAudit()
  const acceptanceAuditBarrier = (): void => {
    const lease = ensureAcceptanceAudit()
    if (!lease) return
    lease.ledger.assertHealthy()
    lease.ledger.assertCapacity(8)
  }
  const runWithAcceptanceAuditOwner = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const scenarioHandleDigest = readScenarioHandleDigest() ?? null
    return telegramAcceptanceAuditScenario.run(scenarioHandleDigest, async () => {
      acceptanceAuditBarrier()
      const ownerDigest = acceptanceAuditLease?.ownerDigest ?? ""
      return telegramAcceptanceAuditOwner.run(ownerDigest, async () => {
        try {
          const result = await operation()
          acceptanceAuditBarrier()
          return result
        } catch (error) {
          try { acceptanceAuditBarrier() } catch (auditError) {
            if (error === auditError) throw auditError
            throw new AggregateError([error, auditError], "Telegram effect and acceptance audit verification failed")
          }
          throw error
        }
      })
    })
  }
  const emitDurableSettlementEvidence = async (event: string, meta: Record<string, unknown>): Promise<void> => {
      if (event === "telegram.callback_settled") {
        await emitNervesEventDurable({
          component: "senses",
          event: "telegram.callback_settled",
          message: "Telegram approval acceptance evidence durably recorded",
          meta,
        })
      } else if (event === "telegram.callback_recovery_settled") {
        await emitNervesEventDurable({
          component: "senses",
          event: "telegram.callback_recovery_settled",
          message: "Telegram approval acceptance evidence durably recorded",
          meta,
        })
      } else {
        throw new Error("Telegram durable acceptance settlement event is unsupported")
      }
  }
  const commitAcceptanceEvidence = useSanctuaryRuntime ? async (event: string, meta: Record<string, unknown>): Promise<void> => {
    acceptanceAuditBarrier()
    const lease = acceptanceAuditLease
    if (!lease) {
      await emitDurableSettlementEvidence(event, meta)
      return
    }
    await telegramAcceptanceAuditExplicitCommit.run(true, async () => {
      await emitDurableSettlementEvidence(event, meta)
    })
    acceptanceAuditBarrier()
    lease.ledger.append({
      ts: new Date().toISOString(),
      level: "info",
      event,
      trace_id: randomUUID(),
      component: "senses",
      message: "Telegram approval acceptance evidence durably recorded",
      meta,
    })
    lease.ledger.assertHealthy()
  } : undefined
  const releaseAcceptanceAudit = (primaryError: unknown): never => {
    try {
      acceptanceAuditLease?.release()
    } catch (releaseError) {
      throw new AggregateError([primaryError, releaseError], "Telegram sense construction and audit release failed")
    }
    throw primaryError
  }
  let toolContext: ReturnType<typeof createSanctuaryToolContext> | undefined
  let approvalRuntime: TelegramApprovalRuntime | undefined
  let approvalTransport: TelegramApprovalTransport | undefined
  let interactiveControl: ReturnType<typeof createSanctuaryInteractiveControl> | undefined
  try {
    toolContext = useSanctuaryRuntime ? (options._toolContext ?? createSanctuaryToolContext(options.agentName)) : undefined
    approvalRuntime = options.approvalRuntime ?? (useSanctuaryRuntime ? (options._createApprovalRuntime ?? createTelegramApprovalRuntime)({
      agentName: options.agentName,
      api,
      authorizedUserId,
      authorizedChatId,
      subject,
      identityKey,
      toolContext: toolContext ?? {},
      effectBarrier: acceptanceAuditBarrier,
      dependencies: {
        acceptanceMarker: () => {
          const scenarioHandleDigest = readScenarioHandleDigest()
          return scenarioHandleDigest ? { scenarioHandleDigest } : null
        },
        commitAcceptanceEvidence,
      },
    }) : undefined)
    approvalTransport = options.approvalTransport ?? approvalRuntime?.transport
    interactiveControl = useSanctuaryRuntime && approvalTransport
      ? (options._createInteractiveControl ?? createSanctuaryInteractiveControl)({
        agentRoot,
        transport: approvalTransport,
        authorizedUserId,
        authorizedChatId,
        runRequest: runWithAcceptanceAuditOwner,
      })
      : undefined
  } catch (error) {
    releaseAcceptanceAudit(error)
  }
  const healthSweep = options.healthSweep
  let effectJournal: FileTelegramEffectJournal | undefined
  const getEffectJournal = (): FileTelegramEffectJournal => {
    effectJournal ??= new FileTelegramEffectJournal(path.join(agentRoot, "state", "telegram", "effects"))
    return effectJournal
  }
  const defaultEffectAuthorization = (): TelegramEffectAuthorization => ({
    allowed: true,
    receiptId: `telegram-owner:${subject}`,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  })
  const authorizeEffect = options.authorizeEffect ?? defaultEffectAuthorization
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
      acceptanceAuditBarrier()
      migrateTelegramSessionIdentity(agentRoot, legacySubject, legacySubject, subject)
      acceptanceAuditBarrier()
      await migrateTelegramFriendIdentity(agentRoot, legacySubject, subject)
    }
    acceptanceAuditBarrier()
    migrateTelegramSessionIdentity(agentRoot, authorizedUserId, authorizedChatId, subject)
    acceptanceAuditBarrier()
    await migrateTelegramFriendIdentity(agentRoot, authorizedUserId, subject)
    acceptanceAuditBarrier()
    approvalRuntime?.migrateIdentity?.(migrationSubjects)
    acceptanceAuditBarrier()
    writeTelegramSubjectIndex(agentRoot, subject, migrationSubjects, options.subjectIndexHooks)
  })
  let approvalReconcileTimer: ReturnType<typeof setTimeout> | undefined
  let approvalReconciliationActive = false
  const approvalReconciliationsInFlight = new Set<Promise<void>>()
  let nextApprovalReconcileDeadline: number | undefined
  let stopPromise: Promise<void> | undefined
  let runPromise: Promise<void> | undefined

  const clearApprovalReconcileTimer = (): void => {
    if (approvalReconcileTimer) clearTimeout(approvalReconcileTimer)
    approvalReconcileTimer = undefined
  }

  const scheduleApprovalReconcile = (): void => {
    if (!approvalTransport || !approvalReconciliationActive) return
    const scheduledAt = nextApprovalReconcileDeadline ?? (Date.now() + APPROVAL_EXPIRY_RECONCILE_INTERVAL_MS)
    nextApprovalReconcileDeadline = scheduledAt + APPROVAL_EXPIRY_RECONCILE_INTERVAL_MS
    const delay = Math.max(0, scheduledAt - Date.now())
    approvalReconcileTimer = setTimeout(() => {
      approvalReconcileTimer = undefined
      scheduleApprovalReconcile()
      const reconciliation = runWithAcceptanceAuditOwner(() => approvalTransport.reconcileExpired()).catch((error) => {
        acceptanceAuditBarrier()
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.telegram_approval_reconcile_error",
          message: "Telegram approval expiry reconciliation failed",
          meta: { agentName: options.agentName, subject, error: transportError(error) },
        })
      }).finally(() => {
        approvalReconciliationsInFlight.delete(reconciliation)
      })
      approvalReconciliationsInFlight.add(reconciliation)
    }, delay)
  }

  const runHealthSweep = async (): Promise<void> => {
    if (!healthSweep) return
    try {
      acceptanceAuditBarrier()
      const result = await healthSweep()
      if (result.message) {
        acceptanceAuditBarrier()
        if (result.deliveryId) await healthSweep.markDeliveryAttempting?.(result.deliveryId)
        const messageIds = await deliver(result.message)
        acceptanceAuditBarrier()
        if (result.deliveryId) await healthSweep.markDelivered?.(result.deliveryId, messageIds)
        emitNervesEvent({
          component: "senses",
          event: "senses.sanctuary_health_delivered",
          message: "Sanctuary health notification was delivered",
          meta: { agentName: options.agentName, deliveryCount: messageIds.length, ...sanctuaryAcceptanceEventMeta(options.agentName) },
        })
      }
    } catch (error) {
      acceptanceAuditBarrier()
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
    acceptanceAuditBarrier()
    return sendTelegramText(api, authorizedChatId, text, signal, onMessageDelivered)
  }

  const deliverButlerEffect = async (
    text: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    onMessageDelivered?: (messageId: number, chunk: string) => void,
  ): Promise<TelegramEffectArtifact> => {
    if (signal?.aborted) throw signal.reason
    acceptanceAuditBarrier()
    const target = { kind: "approved_relationship" as const, friendId: `telegram-user:${subject}`, sessionKey: `telegram:${subject}`, chatId: authorizedChatId }
    const effect = { kind: "text" as const, text }
    const preparationAuthorization = authorizeEffect({ phase: "prepare", idempotencyKey, target, authorClass: "butler", effect })
    if (!preparationAuthorization.allowed) throw new Error(`Telegram effect authorization denied: ${preparationAuthorization.reason}`)
    const journal = getEffectJournal()
    const prepared = prepareTelegramEffect(journal, {
      idempotencyKey,
      target,
      authorClass: "butler",
      effect,
      authorization: preparationAuthorization,
    })
    let executed: TelegramEffectArtifact
    try {
      executed = await executeTelegramEffect(journal, prepared.id, api, (artifact) => {
        acceptanceAuditBarrier()
        return authorizeEffect({ phase: "send", idempotencyKey, target, authorClass: "butler", effect, artifact })
      })
      acceptanceAuditBarrier()
    } catch (error) {
      executed = journal.read(prepared.id)
      for (const part of executed.parts) {
        if ((part.state === "accepted" || part.state === "session_recorded") && part.messageId !== undefined && part.text !== null) onMessageDelivered?.(part.messageId, part.text)
      }
      throw error
    }
    for (const part of executed.parts) {
      if (part.messageId !== undefined && part.text !== null) onMessageDelivered?.(part.messageId, part.text)
    }
    return executed
  }

  const recordAcceptedEffects = async (sessionPath: string, artifacts: TelegramEffectArtifact[], bootstrapUserMessage?: string): Promise<void> => {
    if (artifacts.length === 0) return
    await withSessionTurnLease(sessionPath, async (lease) => {
      const transaction = readSessionTransaction(sessionPath, lease)
      let envelope = loadSessionEnvelopeFile(sessionPath)
      if (!envelope) {
        const messages = bootstrapUserMessage ? [{ role: "user" as const, content: bootstrapUserMessage }] : []
        if (messages[0]) stampIngressTime(messages[0])
        envelope = buildCanonicalSessionEnvelope({
          existing: null,
          previousMessages: [],
          currentMessages: messages,
          trimmedMessages: messages,
          recordedAt: new Date().toISOString(),
          lastUsage: null,
          state: null,
          projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
        }).envelope
      }
      const recordings: Array<{ artifact: TelegramEffectArtifact; eventIds: string[] }> = []
      let changed = false
      for (const artifact of artifacts) {
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
      if (changed) writeSessionTransaction(sessionPath, envelope, { lease, expectedRevision: transaction.revision })
      for (const recording of recordings) recordTelegramEffectInSession(getEffectJournal(), recording.artifact.id, recording.eventIds)
    })
  }

  const onMessageBody = async (message: TelegramInboundMessage): Promise<void> => {
    const currentFriendId = `telegram-user:${subject}`
    const currentSessionKey = `telegram:${subject}`
    const currentSessionPath = getSenseSessionPath(options.agentName, currentFriendId, "telegram", currentSessionKey, agentRoot)
    const acceptanceMarker = options.acceptanceMarker ? options.acceptanceMarker() : readSanctuaryAcceptanceMarker(options.agentName)
    const acceptanceMeta = sanctuaryAcceptanceEventMeta(options.agentName)
    const groundedAcceptance = acceptanceMarker?.label === "unit-16d-whats-up" || acceptanceMarker?.label === "unit-16d-1-space"
    const acceptanceSchema = groundedAcceptance ? "sanctuary-telegram-turn-receipt-v4" : "sanctuary-telegram-turn-receipt-v3"
    const auditDigest = (purpose: string, value: string): string => sanctuaryTelegramTurnReceiptDigest(identityKey, acceptanceSchema, purpose, value)
    const lifecycleCoordinates = acceptanceMarker ? {
      scenarioHandleDigest: acceptanceMarker.scenarioHandleDigest,
      turnDigest: auditDigest("turn", `${message.updateId}\0${message.messageId}`),
      updateDigest: auditDigest("update", `${message.updateId}\0${message.messageId}`),
      subject,
      identityDigest: auditDigest("identity", subject),
      sessionDigest: auditDigest("session", `telegram:${subject}`),
      argumentDigest: auditDigest("argument", message.text),
    } : {}
    const lifecycleStartedAt = Date.now()
    const lifecycleMeta = (event: string, meta: Record<string, unknown>, lifecycleAt: number): Record<string, unknown> => acceptanceMarker
      ? { ...meta, lifecycleAt, lifecycleMac: sanctuaryTelegramAuditLifecycleMac(identityKey, acceptanceSchema, event, { ...meta, lifecycleAt }) }
      : meta
    emitNervesEvent({
      component: "senses",
      event: "senses.telegram_turn_start",
      message: "Telegram authorized turn started",
      meta: lifecycleMeta("senses.telegram_turn_start", { agentName: options.agentName, subject, ...acceptanceMeta, ...lifecycleCoordinates }, lifecycleStartedAt),
    })
    acceptanceAuditBarrier()
    let deliveryCount = 0
    const deliveredMessageIds: number[] = []
    const deliveredChunks: string[] = []
    let receiptStatus: "success" | "error" = "success"
    let errorCategory: string | null = null
    const turnMetricsObserver = { providerInvocationCount: 0, toolInvocationCount: 0 }
    const toolReceiptObserver: SanctuaryToolReceiptObserver = { toolResultDigests: [], toolGroundings: [] }
    const normalizedRequest = message.text.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    const groundingIntentTool = /^(?:what['’]?s up|status)\??$/u.test(normalizedRequest) ? "unraid_get_system"
      : /^how much (?:space|storage) is left\??$/u.test(normalizedRequest) ? "unraid_get_storage"
        : null
    const bufferedGroundedDeliveries: string[] = []
    const turnEffects: TelegramEffectArtifact[] = []
    let deliveryOrdinal = 0
    if (effectJournal) {
      const recoverable = effectJournal.list().filter((artifact) => artifact.target.kind === "approved_relationship"
        && artifact.target.friendId === currentFriendId && artifact.target.sessionKey === currentSessionKey && artifact.target.chatId === authorizedChatId
        && artifact.parts.some((part) => part.state === "accepted"))
      if (recoverable.length > 0) await recordAcceptedEffects(currentSessionPath, recoverable)
    } else if (existsSync(path.join(agentRoot, "state", "telegram", "effects"))) {
      const recoverable = getEffectJournal().list().filter((artifact) => artifact.target.kind === "approved_relationship"
        && artifact.target.friendId === currentFriendId && artifact.target.sessionKey === currentSessionKey && artifact.target.chatId === authorizedChatId
        && artifact.parts.some((part) => part.state === "accepted"))
      if (recoverable.length > 0) await recordAcceptedEffects(currentSessionPath, recoverable)
    }
    let ingressRelations: RunSenseTurnOptions["ingressRelations"]
    if (message.replyToMessageId && /^[1-9][0-9]*$/u.test(message.replyToMessageId)) {
      const replyMessageId = Number(message.replyToMessageId)
      const candidate = getEffectJournal().list().find((artifact) => artifact.target.kind === "approved_relationship"
        && artifact.target.chatId === authorizedChatId && artifact.target.friendId === currentFriendId && artifact.target.sessionKey === currentSessionKey
        && artifact.parts.some((part) => part.messageId === replyMessageId))
      if (candidate?.target.kind === "approved_relationship" && candidate.parts.some((part) => part.state === "accepted")) {
        await recordAcceptedEffects(currentSessionPath, [candidate])
      }
      const reply = resolveTelegramReply(getEffectJournal(), { messageId: replyMessageId, chatId: authorizedChatId, friendId: currentFriendId, sessionKey: currentSessionKey })
      const session = reply ? loadSessionEnvelopeFile(currentSessionPath) : null
      if (reply && session?.events.some((event) => event.id === reply.sessionEventId)) ingressRelations = {
        replyToEventId: reply.sessionEventId,
        threadRootEventId: null,
        references: [`telegram-artifact:${reply.artifactId}`, ...(reply.requestId ? [`request:${reply.requestId}`] : [])],
      }
    }
    try {
      acceptanceAuditBarrier()
      const collected = await collectToolReceipts(() => runTurn({
        agentName: options.agentName,
        channel: "telegram",
        sessionKey: currentSessionKey,
        friendId: currentFriendId,
        identity: {
          provider: "telegram-user",
          externalId: subject,
          displayName: `Telegram user ${subject}`,
        },
        userMessage: message.text,
        ...(ingressRelations ? { ingressRelations } : {}),
        turnMetricsObserver,
        deliverySink: {
          onDelivery: async (delivery) => {
            if (groundingIntentTool) {
              bufferedGroundedDeliveries.push(delivery.kind)
            } else {
              turnEffects.push(await deliverButlerEffect(delivery.text, `turn:${message.updateId}:delivery:${deliveryOrdinal++}`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
              deliveryCount += 1
            }
          },
        },
        ...(toolContext ? { toolContext } : {}),
        ...(approvalRuntime ? { approvalCoordinatorFactory: approvalRuntime.coordinator } : {}),
      }), toolReceiptObserver)
      const result = collected.result
      turnMetricsObserver.providerInvocationCount = Math.max(turnMetricsObserver.providerInvocationCount, result.providerInvocationCount ?? 0)
      turnMetricsObserver.toolInvocationCount = Math.max(turnMetricsObserver.toolInvocationCount, result.toolInvocationCount ?? 0)
      if (groundingIntentTool) {
        const grounding = toolReceiptObserver.toolGroundings?.length === 1 ? toolReceiptObserver.toolGroundings[0] : undefined
        if (!grounding || grounding.toolName !== groundingIntentTool || bufferedGroundedDeliveries.length > 1
          || (bufferedGroundedDeliveries.length === 1 && bufferedGroundedDeliveries[0] !== "settle")) throw new Error("Canonical Sanctuary query did not produce exactly one matching grounded settle")
        const canonical = renderSanctuaryGroundedResponse(grounding.toolName, grounding.facts)
        turnEffects.push(await deliverButlerEffect(canonical, `turn:${message.updateId}:delivery:${deliveryOrdinal++}`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
        deliveryCount = 1
      } else if (deliveryCount === 0 && result.response.trim()) {
        turnEffects.push(await deliverButlerEffect(result.response, `turn:${message.updateId}:delivery:${deliveryOrdinal++}`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
      }
      if (result.sessionPath) await recordAcceptedEffects(result.sessionPath, turnEffects)
      emitNervesEvent({
        component: "senses",
        event: "senses.telegram_turn_end",
        message: "Telegram authorized turn completed",
        meta: lifecycleMeta("senses.telegram_turn_end", { agentName: options.agentName, subject, deliveryCount: Math.max(deliveryCount, result.response.trim() ? 1 : 0), ...acceptanceMeta, ...lifecycleCoordinates, ...(acceptanceMarker ? { outcome: "success", errorDigest: null } : {}) }, Math.max(Date.now(), lifecycleStartedAt + 1)),
      })
    } catch (error) {
      receiptStatus = "error"
      errorCategory = (error instanceof Error && error.name.trim() ? error.name : "unknown").slice(0, 128)
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.telegram_turn_error",
        message: "Telegram authorized turn failed",
        meta: lifecycleMeta("senses.telegram_turn_error", {
          agentName: options.agentName,
          subject,
          ...acceptanceMeta,
          ...lifecycleCoordinates,
          ...(acceptanceMarker ? {
            outcome: "error",
            errorDigest: auditDigest("error", redactTelegramPrivateValues(error, [botToken, authorizedUserId, authorizedChatId, String(message.updateId), message.messageId])),
            deliveryCount: deliveredMessageIds.length,
          } : { error: redactTelegramPrivateValues(error, [botToken, authorizedUserId, authorizedChatId, String(message.updateId), message.messageId]) }),
        }, Math.max(Date.now(), lifecycleStartedAt + 1)),
      })
      const fallback = "I couldn't complete that turn. The failure was recorded; please try again."
      if (deliveredMessageIds.length === 0) turnEffects.push(await deliverButlerEffect(fallback, `turn:${message.updateId}:fallback`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
      await recordAcceptedEffects(currentSessionPath, turnEffects, message.text)
    } finally {
      if (acceptanceMarker) {
        acceptanceAuditBarrier()
        const grounded = groundedAcceptance
        const schemaVersion = grounded ? "sanctuary-telegram-turn-receipt-v4" : "sanctuary-telegram-turn-receipt-v3"
        const hmac = (purpose: string, value: string): string => sanctuaryTelegramTurnReceiptDigest(identityKey, schemaVersion, purpose, value)
        const redact = (value: string): string => [botToken, authorizedUserId, authorizedChatId, String(message.updateId), message.messageId]
          .reduce((text, privateValue) => privateValue.length >= 5 ? text.replaceAll(privateValue, "[REDACTED]") : text, value)
        const deliveries = deliveredMessageIds.map((messageId, index) => {
          const chunk = deliveredChunks[index]!
          const redactedText = redact(chunk)
          return { messageIdDigest: hmac("delivery", String(messageId)), chunkDigest: hmac("chunk", grounded ? redactedText : chunk), ...(grounded ? { redactedText, utf16Units: redactedText.length } : {}) }
        })
        try {
          const receipt: Record<string, unknown> = {
            schemaVersion,
            scenarioHandleDigest: acceptanceMarker.scenarioHandleDigest,
            status: receiptStatus,
            errorCategory,
            updateDigest: hmac("update", `${message.updateId}\0${message.messageId}`),
            sequenceDigest: hmac("sequence", String(message.updateId)),
            responseDigest: hmac("response", JSON.stringify(deliveries)),
            toolResultDigests: toolReceiptObserver.toolResultDigests,
            ...(grounded ? { toolGroundings: toolReceiptObserver.toolGroundings } : {}),
            providerInvocationCount: turnMetricsObserver.providerInvocationCount,
            toolInvocationCount: turnMetricsObserver.toolInvocationCount,
            deliveryCount: deliveries.length,
            deliveries,
            completedAt: new Date().toISOString(),
          }
          if (grounded) receipt.receiptMac = sanctuaryTelegramTurnReceiptMac(identityKey, receipt)
          await appendSanctuaryTurnReceipt(options.acceptanceReceiptRoot ?? agentRoot, receipt, options._afterAcceptanceLedgerPreReadStat)
        } catch (error) {
          emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_acceptance_receipt_error", message: "Telegram acceptance receipt persistence failed", meta: { agentName: options.agentName, scenarioHandleDigest: acceptanceMarker.scenarioHandleDigest, category: error instanceof Error ? error.name : "unknown" } })
        }
      }
    }
  }

  const onMessage = (message: TelegramInboundMessage): Promise<void> => runWithAcceptanceAuditOwner(() => onMessageBody(message))

  const onUpdate = async (update: TelegramUpdate): Promise<boolean> => {
    if (!update.callback_query || !approvalTransport) return false
    return runWithAcceptanceAuditOwner(async () => (await approvalTransport.handleUpdate(update)).handled)
  }

  let poll: TelegramLongPoll
  try {
    poll = (options.createLongPoll ?? createTelegramLongPoll)({
      api,
      expectedUserId: authorizedUserId,
      expectedChatId: authorizedChatId,
      offsetStore,
      inboxStore,
      onMessage,
      onUpdate,
      acceptanceEventMeta: (update, distinctAccount) => {
        const marker = options.acceptanceMarker ? options.acceptanceMarker() : readSanctuaryAcceptanceMarker(options.agentName)
        if (!marker) return {}
        const auditOwnerMeta = acceptanceAuditLease ? { acceptanceAuditOwnerDigest: acceptanceAuditLease.ownerDigest } : {}
        const messageId = update?.message?.message_id ?? update?.callback_query?.message?.message_id
        const senderId = update?.message?.from?.id
        if (!update || messageId === undefined || senderId === undefined) return { scenarioHandleDigest: marker.scenarioHandleDigest, ...auditOwnerMeta }
        const schemaVersion = marker.label === "unit-16d-whats-up" || marker.label === "unit-16d-1-space"
          ? "sanctuary-telegram-turn-receipt-v4" : "sanctuary-telegram-turn-receipt-v3"
        const digest = (purpose: string, value: string): string => sanctuaryTelegramTurnReceiptDigest(identityKey, schemaVersion, purpose, value)
        const senderDistinct = String(senderId) !== authorizedUserId
        if (distinctAccount !== senderDistinct) throw new Error("Telegram dropped-update identity classification mismatch")
        const binding = {
          scenarioHandleDigest: marker.scenarioHandleDigest,
          updateDigest: digest("update", `${update.update_id}\0${messageId}`),
          senderIdentityDigest: digest("sender-identity", String(senderId)),
          authorizedIdentityDigest: digest("sender-identity", authorizedUserId),
          senderDistinct,
          nextOffsetDigest: digest("next-update-id", String(update.update_id + 1)),
        }
        return { ...binding, ...auditOwnerMeta, dropMac: sanctuaryTelegramUnauthorizedDropMac(identityKey, schemaVersion, binding) }
      },
      onBeforeDispatch: acceptanceAuditBarrier,
      onDispatchSettled: acceptanceAuditBarrier,
    })
  } catch (error) {
    releaseAcceptanceAudit(error)
  }

  return {
    run(signal) {
      if (runPromise) return runPromise
      runPromise = (async () => {
        await runWithAcceptanceAuditOwner(migrateIdentity)
        await runWithAcceptanceAuditOwner(async () => { await approvalRuntime?.recover() })
        await runWithAcceptanceAuditOwner(async () => { await interactiveControl?.start() })
        try {
          await runWithAcceptanceAuditOwner(async () => { await approvalTransport?.reconcileExpired() })
        } catch (error) {
          acceptanceAuditBarrier()
          emitNervesEvent({
            level: "error",
            component: "senses",
            event: "senses.telegram_approval_reconcile_error",
            message: "Telegram approval expiry reconciliation failed",
            meta: { agentName: options.agentName, subject, error: transportError(error) },
          })
        }
        await runWithAcceptanceAuditOwner(runHealthSweep)
        emitNervesEvent({
          component: "senses",
          event: "senses.telegram_poll_start",
          message: "Telegram long poll started",
          meta: { agentName: options.agentName, subject },
        })
        approvalReconciliationActive = true
        nextApprovalReconcileDeadline = undefined
        scheduleApprovalReconcile()
        try {
          await poll.run(signal)
        } finally {
          approvalReconciliationActive = false
          nextApprovalReconcileDeadline = undefined
          clearApprovalReconcileTimer()
          await Promise.all([...approvalReconciliationsInFlight])
          try {
            await runWithAcceptanceAuditOwner(async () => { await approvalTransport?.reconcileExpired() })
          } catch (error) {
            acceptanceAuditBarrier()
            emitNervesEvent({
              level: "error",
              component: "senses",
              event: "senses.telegram_approval_reconcile_error",
              message: "Telegram approval expiry reconciliation failed",
              meta: { agentName: options.agentName, subject, error: transportError(error) },
            })
          }
          await interactiveControl?.stop()
        }
      })()
      return runPromise
    },
    async sendProactive(text, signal) {
      await runWithAcceptanceAuditOwner(async () => {
        const effect = await deliverButlerEffect(requiredText(text, "proactive message"), `proactive:${randomUUID()}`, signal)
        const sessionPath = getSenseSessionPath(options.agentName, `telegram-user:${subject}`, "telegram", `telegram:${subject}`, agentRoot)
        await recordAcceptedEffects(sessionPath, [effect])
      })
    },
    stop() {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        const errors: unknown[] = []
        const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
          try { await operation() } catch (error) { errors.push(error) }
        }
        await attempt(() => poll.stop())
        await attempt(async () => { await runPromise?.catch(() => undefined) })
        await attempt(async () => { await Promise.all([...approvalReconciliationsInFlight]) })
        await attempt(async () => { await interactiveControl?.stop() })
        await attempt(() => api.stop())
        await attempt(() => approvalRuntime?.close())
        await attempt(() => runWithAcceptanceAuditOwner(() => {
          emitNervesEvent({
            component: "senses",
            event: "senses.telegram_poll_end",
            message: "Telegram long poll stopped",
            meta: { agentName: options.agentName, subject },
          })
        }))
        await attempt(retireAcceptanceAudit)
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, "Telegram sense cleanup failed")
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
