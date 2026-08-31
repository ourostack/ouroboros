import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
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
import { createSanctuarySabClient } from "./sanctuary-sab"
import { getSenseSessionPath, runSenseTurn, type RunSenseTurnOptions, type RunSenseTurnResult } from "./shared-turn"
import {
  createTelegramBotApi,
  createTelegramLongPoll,
  FileTelegramOffsetStore,
  FileTelegramUpdateInboxStore,
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
import { loadSessionEnvelopeFile } from "../heart/session-events"
import { getExternalEventRoot, type PrivilegedProtectiveAction } from "../heart/external-events/router"
import { withSessionTurnLease } from "../mind/session-transaction"
import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "../heart/approval-files"
import { openApprovalStore } from "../heart/approval-store"
import { cancelRelationshipFollowUps, hasActiveRelationshipFollowUp, resetAwaitToolDeps, setAwaitToolDeps } from "../repertoire/tools-awaiting"
import { findPendingObligationForRequest, fulfillObligation, markObligationReturnReady, readObligation } from "../arc/obligations"
import { buildOrientationFrame } from "../heart/orientation-frame"
import { renderAttachmentBlock } from "../heart/attachments/render"
import { ingestTelegramAttachments } from "./telegram-attachments"
import { getPrivateRuntimePendingDir, queuePendingMessage } from "../mind/pending"
import type { CrossChatDeliveryRequest, CrossChatDirectDeliveryResult } from "../heart/cross-chat-delivery"
import {
  authorizeRelationshipAccess,
  createRelationshipAuthorizationEvaluator,
  loadRelationshipCapabilityRegistry,
  type RelationshipAuthorizationEvaluator,
} from "../repertoire/relationship-authorization"
import {
  createTelegramAdmissionController,
  FileTelegramAdmissionStore,
  type TelegramAdmissionFriendClaim,
  type TelegramAdmissionFriendClaimResult,
  type TelegramAdmissionFriendRevocation,
  type TelegramAdmissionFriendRevocationResult,
  type TelegramNewlyAdmittedOrientation,
} from "./telegram-admission"
import {
  createTelegramAuthorizedEffectExecutor,
  createTelegramApprovalEffectPort,
  FIXED_USENET_SYSTEM_FAILSAFE,
  FileTelegramEffectJournal,
  recordTelegramEffectsInSession,
  recoverTelegramEffectOutbox,
  resolveTelegramControlArtifact,
  resolveTelegramReply,
  sweepTelegramSystemFailsafes,
  type TelegramEffectArtifact,
  type TelegramEffectAuthorization,
  type TelegramEffectAuthorizationInput,
  type TelegramEffectTarget,
} from "./telegram-effect-adapter"

const SANCTUARY_SAB_CONFIG_PATH = "/run/sanctuary/sabnzbd.ini"

export function createSabQueueProtectiveStateVerifier(options: {
  iniPath?: string
  fetch?: typeof fetch
  now?: () => string
} = {}): (action: PrivilegedProtectiveAction) => Promise<{ verified: boolean; reference: string }> {
  let client: ReturnType<typeof createSanctuarySabClient> | null = null
  return async (action) => {
    client ??= createSanctuarySabClient({ iniPath: options.iniPath ?? SANCTUARY_SAB_CONFIG_PATH, fetch: options.fetch, now: options.now })
    const snapshot = await client.readQueue()
    const paused = snapshot.paused
    const digest = createHash("sha256").update(`sabnzbd.queue.paused=${String(paused)}`).digest("hex")
    const verified = action.action === "sabnzbd.pause" && paused && action.verification.verified && action.verification.digest === digest
    return { verified, reference: `sabnzbd.queue.paused:${digest}:${snapshot.observedAt}` }
  }
}

export interface TelegramSenseCredentials {
  botToken: string
  botId?: string
  authorizedUserId: string
  authorizedChatId: string
}

export interface TelegramAdmissionDependencies {
  ownerFriendId: string
  resolveOwner(input: { botId: string; userId: string; chatId: string; sessionKey: string }): Promise<{ friendId: string } | null>
  resolveApprovedFriend(input: { botId: string; userId: string; chatId: string }): Promise<{ friendId: string } | null>
  claimFriend(input: TelegramAdmissionFriendClaim): Promise<TelegramAdmissionFriendClaimResult>
  revokeFriend(input: TelegramAdmissionFriendRevocation): Promise<TelegramAdmissionFriendRevocationResult>
  createDisplayCode?: () => string
}

export interface TelegramContactManager {
  list(input: { actorFriendId: string }): Promise<{ contacts: Array<{ friendId: string; name: string; userId: string; admissionState: string; initiativePolicy: string }>; blocked: Array<{ admissionId: string; userId: string; displayCode: string; status: "blocked"; createdAt: string }> }>
  revoke(input: { actorFriendId: string; friendId: string }): Promise<{ revoked: true; friendId: string }>
  unblock(input: { actorFriendId: string; admissionId: string }): Promise<{ unblocked: true; admissionId: string }>
}

export interface TelegramSenseApp {
  run(signal?: AbortSignal): Promise<void>
  sendProactive(text: string, signal?: AbortSignal): Promise<void>
  sendExternalEventDecision(input: { source: string; eventId: string; generation: number; text: string; signal?: AbortSignal }): Promise<void>
  sendAwaitFollowUp(request: CrossChatDeliveryRequest): Promise<CrossChatDirectDeliveryResult>
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
  authorizeEffect?: (input: TelegramEffectAuthorizationInput) => TelegramEffectAuthorization | Promise<TelegramEffectAuthorization>
  /** Installs the stranger quarantine/admission path. Production supplies this from Friends. */
  admission?: TelegramAdmissionDependencies
  /** Resolves current relationship authority before both effect preparation and send. */
  authorizeRelationshipEffect?: (input: TelegramEffectAuthorizationInput) => Promise<TelegramEffectAuthorization>
  privilegedFailsafe?: {
    eventRoot: string
    verifyProtectiveState(action: PrivilegedProtectiveAction): Promise<{ verified: boolean; reference: string }>
  }
  /** Resolves a current per-turn relationship envelope after durable ingress exists. */
  resolveRelationshipAuthorization?: (input: { friendId: string; requestId: string; sessionEventId: string; botId: string; userId: string; chatId: string; sessionKey: string }) => Promise<RelationshipAuthorizationEvaluator>
  telegramContactManager?: TelegramContactManager
  /** Optional transport seam; production defaults to global fetch. */
  attachmentFetch?: typeof globalThis.fetch
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

export function telegramBotIdFromToken(token: string): string {
  const match = /^([1-9][0-9]*):/u.exec(token.trim())
  if (!match) throw new Error("Telegram bot token does not expose a canonical numeric bot id")
  return match[1]!
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
  const botId = options.credentials.botId !== undefined
    ? canonicalTelegramId(options.credentials.botId, "bot id")
    : options.admission ? telegramBotIdFromToken(botToken) : null
  const authorizedUserId = canonicalTelegramId(options.credentials.authorizedUserId, "authorized user id")
  const authorizedChatId = canonicalTelegramId(options.credentials.authorizedChatId, "authorized chat id")
  const agentRoot = options._agentRoot ?? getAgentRoot(options.agentName)
  const identityKey = options.identityKey === undefined
    ? readOrCreateTelegramIdentityKey(agentRoot)
    : canonicalTelegramIdentityKey(options.identityKey)
  const subject = opaqueTelegramSubject(identityKey, botId ?? botToken, authorizedUserId, authorizedChatId)
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
  const admissionStore = options.admission
    ? new FileTelegramAdmissionStore(path.join(agentRoot, "state", "senses", "telegram", "admissions"))
    : undefined
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
  let effectJournal: FileTelegramEffectJournal | undefined
  const getEffectJournal = (): FileTelegramEffectJournal => {
    effectJournal ??= new FileTelegramEffectJournal(path.join(agentRoot, "state", "telegram", "effects"))
    return effectJournal
  }
  const configuredOwnerFriendId = options.admission?.ownerFriendId ?? `telegram-user:${subject}`
  const configuredOwnerSessionKey = `telegram:${subject}`
  const defaultEffectAuthorization = async (input: TelegramEffectAuthorizationInput): Promise<TelegramEffectAuthorization> => {
    const target = input.target
    if (target.kind === "admission_gate") {
      const pending = admissionStore!.read(target.admissionId)
      const authorization = authorizeRelationshipAccess({
        profiles: [],
        pendingAdmission: { admissionId: pending.id, botId: pending.botId, userId: pending.userId, chatId: pending.chatId, expiresAt: new Date(pending.expiresAt).toISOString() },
        request: { kind: "admission_gate", admissionId: target.admissionId, botId: target.botId, userId: target.userId, chatId: target.chatId, effect: "fixed_ack", idempotencyKey: input.idempotencyKey, expiresAt: new Date(pending.expiresAt).toISOString() },
      })
      const admissionAuthorization = authorization as Extract<typeof authorization, { authorizationKind: "admission_gate" }>
      return { allowed: true, receiptId: admissionAuthorization.receiptId, expiresAt: admissionAuthorization.expiresAt, transport: { chatId: target.chatId } }
    }
    if (input.authorClass === "system_failsafe" && (input.effect.kind !== "text" || input.effect.text !== FIXED_USENET_SYSTEM_FAILSAFE || !input.idempotencyKey.startsWith("system-failsafe:"))) {
      return { allowed: false, reason: "system failsafe shape is not fixed" }
    }
    if (options.authorizeRelationshipEffect) {
      if (target.friendId === configuredOwnerFriendId && target.sessionKey !== configuredOwnerSessionKey) return { allowed: false, reason: "owner relationship session binding changed" }
      return options.authorizeRelationshipEffect(input)
    }
    if (target.friendId !== `telegram-user:${subject}` || target.sessionKey !== `telegram:${subject}`) {
      return { allowed: false, reason: "effect target is not the configured owner relationship" }
    }
    return { allowed: true, receiptId: `configured-owner:${subject}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), transport: { chatId: authorizedChatId } }
  }
  const authorizeEffect = options.authorizeEffect ?? defaultEffectAuthorization
  let recordAcceptedEffects!: (sessionPath: string, artifacts: TelegramEffectArtifact[], bootstrapInbound?: { text: string; reference: string; attachmentIds?: readonly string[] }, causalEventIds?: Readonly<Record<string, string>>) => Promise<void>
  const configuredOwnerTarget = (): Extract<TelegramEffectTarget, { kind: "approved_relationship" }> => ({ kind: "approved_relationship", friendId: configuredOwnerFriendId, sessionKey: configuredOwnerSessionKey })
  const executeAuthorizedEffect = createTelegramAuthorizedEffectExecutor({
    store: getEffectJournal,
    api,
    authorize: authorizeEffect,
    barrier: acceptanceAuditBarrier,
  })
  const recordConfiguredOwnerEffect = async (artifact: TelegramEffectArtifact, causalEventId?: string): Promise<void> => {
    await recordAcceptedEffects(
      getSenseSessionPath(options.agentName, configuredOwnerFriendId, "telegram", configuredOwnerSessionKey, agentRoot),
      [artifact],
      undefined,
      causalEventId ? { [artifact.id]: causalEventId } : undefined,
    )
  }
  const approvalEffects = createTelegramApprovalEffectPort({ target: configuredOwnerTarget(), chatId: authorizedChatId, execute: executeAuthorizedEffect, record: recordConfiguredOwnerEffect })
  let toolContext: ReturnType<typeof createSanctuaryToolContext> | undefined
  let approvalRuntime: TelegramApprovalRuntime | undefined
  let approvalTransport: TelegramApprovalTransport | undefined
  let interactiveControl: ReturnType<typeof createSanctuaryInteractiveControl> | undefined
  try {
    toolContext = useSanctuaryRuntime ? (options._toolContext ?? createSanctuaryToolContext(options.agentName)) : undefined
    if (toolContext && options.telegramContactManager) (toolContext as import("../repertoire/tools-base").ToolContext).telegramContactManager = options.telegramContactManager
    approvalRuntime = options.approvalRuntime ?? (useSanctuaryRuntime ? (options._createApprovalRuntime ?? createTelegramApprovalRuntime)({
      agentName: options.agentName,
      api,
      authorizedUserId,
      authorizedChatId,
      subject,
      identityKey,
      toolContext: toolContext ?? {},
      effects: approvalEffects,
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
  let reconcileSystemFailsafes!: () => Promise<void>
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
      const failsafe = runWithAcceptanceAuditOwner(reconcileSystemFailsafes)
        .finally(() => { approvalReconciliationsInFlight.delete(failsafe) })
      approvalReconciliationsInFlight.add(failsafe)
    }, delay)
  }

  const deliverButlerEffect = async (
    text: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    onMessageDelivered?: (messageId: number, chunk: string) => void,
  ): Promise<TelegramEffectArtifact> => {
    return executeAuthorizedEffect({
      idempotencyKey,
      target: configuredOwnerTarget(),
      authorClass: "butler",
      effect: { kind: "text", text },
      ...(signal ? { signal } : {}),
      ...(onMessageDelivered ? { onMessageDelivered } : {}),
    })
  }

  recordAcceptedEffects = async (sessionPath: string, artifacts: TelegramEffectArtifact[], bootstrapInbound?: { text: string; reference: string; attachmentIds?: readonly string[] }, causalEventIds?: Readonly<Record<string, string>>): Promise<void> => {
    await recordTelegramEffectsInSession({ store: getEffectJournal(), sessionPath, artifacts, ...(bootstrapInbound ? { inbound: bootstrapInbound } : {}), ...(causalEventIds ? { causalEventIds } : {}) })
    for (const artifact of artifacts) {
      if (artifact.target.kind !== "approved_relationship" || !artifact.target.requestId || artifact.effect.kind !== "text") continue
      const recorded = getEffectJournal().read(artifact.id)
      if (!recorded.parts.every((part) => part.state === "session_recorded")) continue
      if (!artifact.obligationReturnId) continue
      const obligation = readObligation(agentRoot, artifact.obligationReturnId)
      if (obligation?.returnReadyAt && obligation.requestId === artifact.target.requestId
        && obligation.owedTo?.friendId === artifact.target.friendId && obligation.owedTo.channel === "telegram"
        && obligation.owedTo.key === artifact.target.sessionKey) fulfillObligation(agentRoot, obligation.id)
    }
  }
  const deliverAwaitFollowUp = async (request: CrossChatDeliveryRequest): Promise<CrossChatDirectDeliveryResult> => {
    if (!request.requestId) return { status: "blocked", detail: "Telegram follow-up is missing its request binding" }
    try {
      const obligation = findPendingObligationForRequest(agentRoot, { requestId: request.requestId, owedTo: { friendId: request.friendId, channel: "telegram", key: request.key } })
      if (obligation && !obligation.returnReadyAt) markObligationReturnReady(agentRoot, obligation.id, request.deliveryId ?? `telegram-return:${request.requestId}`)
      const expiry = request.deliveryId?.endsWith(":expired") === true
      const artifact = await executeAuthorizedEffect({
        idempotencyKey: `await-${expiry ? "expiry-" : ""}follow-up:${request.requestId}:${createHash("sha256").update(request.deliveryId ?? request.content).digest("hex")}`,
        target: { kind: "approved_relationship", friendId: request.friendId, sessionKey: request.key, requestId: request.requestId },
        authorClass: "butler",
        effect: { kind: "text", text: request.content },
        ...(obligation ? { obligationReturnId: obligation.id } : {}),
      })
      await recordAcceptedEffects(getSenseSessionPath(options.agentName, request.friendId, "telegram", request.key, agentRoot), [artifact])
      return { status: "delivered_now", detail: "sent to the exact request-bound Telegram chat" }
    } catch (error) {
      return { status: "blocked", detail: error instanceof Error ? error.message : String(error) }
    }
  }
  setAwaitToolDeps({
    buildDeliveryDeps: () => ({
      agentName: options.agentName,
      queuePending: (message) => queuePendingMessage(getPrivateRuntimePendingDir(options.agentName), message),
      deliverers: {
        telegram: deliverAwaitFollowUp,
      },
    }),
  })
  reconcileSystemFailsafes = async (): Promise<void> => {
    if (!options.privilegedFailsafe) return
    const target = configuredOwnerTarget()
    try {
      await sweepTelegramSystemFailsafes({
        eventRoot: options.privilegedFailsafe.eventRoot,
        target,
        verifyProtectiveState: options.privilegedFailsafe.verifyProtectiveState,
        execute: executeAuthorizedEffect,
        recordArtifact: async (artifact) => {
          await recordAcceptedEffects(getSenseSessionPath(options.agentName, target.friendId, "telegram", target.sessionKey, agentRoot), [artifact])
        },
      })
    } catch (error) {
      emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_system_failsafe_error", message: "Telegram system failsafe reconciliation failed", meta: { agentName: options.agentName, subject, error: transportError(error) } })
    }
  }
  const prepareRelationshipRunAgentOptions = (input: {
    friendId: string
    requestId: string
    sessionEventId: string
    userId: string
    chatId: string
    sessionKey: string
  }): NonNullable<RunSenseTurnOptions["prepareRunAgentOptions"]> => {
    if (!options.resolveRelationshipAuthorization) throw new Error("Telegram relationship authorization resolver is unavailable")
    const relationshipCoordinates = { ...input, botId: botId! }
    const resolveLiveRelationshipAuthorization = async () => {
      const authorization = await options.resolveRelationshipAuthorization!(relationshipCoordinates)
      if (authorization.subject.friendId !== input.friendId || authorization.subject.admissionState !== "active") throw new Error("Telegram relationship admission is not active")
      return {
        requestId: input.requestId,
        profileId: authorization.profileId,
        authorizedContextScopes: authorization.authorizedContextScopes,
        advertisedToolNames: authorization.advertisedToolNames,
        actor: authorization.actor,
        authorizeTool: async (name: string, args: Record<string, string>) =>
          (await options.resolveRelationshipAuthorization!(relationshipCoordinates)).authorizeTool(name, args),
      }
    }
    return async ({ runAgentOptions }) => ({
      ...runAgentOptions,
      toolContext: { ...runAgentOptions.toolContext!, relationshipAuthorization: await resolveLiveRelationshipAuthorization() },
    })
  }
  const dispatchResolvedRelationshipTurn = async (input: {
    friendId: string
    sessionKey: string
    requestId: string
    eventId: string
    reference: string
    text: string
    attachmentIds?: readonly string[]
    userId: string
    chatId: string
    orientation?: TelegramNewlyAdmittedOrientation
  }): Promise<void> => {
    const sessionPath = getSenseSessionPath(options.agentName, input.friendId, "telegram", input.sessionKey, agentRoot)
    const effects: TelegramEffectArtifact[] = []
    let ordinal = 0
    const deliver = async (text: string, terminalReturn = false): Promise<void> => {
      const obligation = terminalReturn ? findPendingObligationForRequest(agentRoot, {
        requestId: input.requestId,
        owedTo: { friendId: input.friendId, channel: "telegram", key: input.sessionKey },
      }) : undefined
      effects.push(await executeAuthorizedEffect({
        idempotencyKey: `relationship-turn:${input.requestId}:delivery:${ordinal++}`,
        target: { kind: "approved_relationship", friendId: input.friendId, sessionKey: input.sessionKey, requestId: input.requestId },
        authorClass: "butler",
        effect: { kind: "text", text },
        ...(obligation?.returnReadyAt ? { obligationReturnId: obligation.id } : {}),
      }))
    }
    const orientationFrame = input.orientation?.kind === "newly_admitted"
      ? {
          ...buildOrientationFrame({ channel: "telegram", messages: [{ role: "user", content: input.text }] }),
          source: {
            kind: "telegram_newly_admitted",
            authority: "presentation_only" as const,
            routingHint: [
              "This is this person’s first admitted turn. Welcome them warmly and briefly explain what the household Butler can help with before answering their request.",
              input.orientation.relationship ? `The owner identified this person as their ${input.orientation.relationship}.` : null,
              input.orientation.attachmentsNeedResend ? "Their original message included attachments that were not downloaded; ask them to resend those attachments now." : null,
            ].filter(Boolean).join(" "),
          },
        }
      : undefined
    const result = await runTurn({
      agentName: options.agentName,
      channel: "telegram",
      sessionKey: input.sessionKey,
      friendId: input.friendId,
      identity: { provider: "telegram-user", externalId: input.userId, displayName: "Household member", tenantId: botId! },
      userMessage: input.text,
      ingressRelations: { replyToEventId: null, threadRootEventId: null, references: [input.reference] },
      precommittedIngress: { eventId: input.eventId, reference: input.reference },
      ...(orientationFrame ? { orientationFrame } : {}),
      toolContext: { ...(toolContext ?? {}), attachmentIds: input.attachmentIds ?? [] },
      prepareRunAgentOptions: prepareRelationshipRunAgentOptions({ friendId: input.friendId, requestId: input.requestId,
        sessionEventId: input.eventId, userId: input.userId, chatId: input.chatId, sessionKey: input.sessionKey }),
      deliverySink: { onDelivery: (delivery) => deliver(delivery.text, delivery.kind === "settle") },
    })
    if (effects.length === 0 && result.response.trim()) await deliver(result.response, true)
    const causalEventIds = Object.fromEntries(effects.flatMap((artifact, index) => {
      const eventId = result.causalSessionEventIds?.[index] ?? (effects.length === 1 ? result.responseCausalSessionEventId : undefined)
      return eventId ? [[artifact.id, eventId]] : []
    }))
    await recordAcceptedEffects(sessionPath, effects, undefined, causalEventIds)
  }
  const admissionController = options.admission && admissionStore ? createTelegramAdmissionController({
    store: admissionStore,
    owner: { friendId: configuredOwnerFriendId, sessionKey: configuredOwnerSessionKey },
    sendEffect: async (request) => {
      const artifact = await executeAuthorizedEffect(request)
      if (artifact.target.kind === "approved_relationship") {
        await recordAcceptedEffects(getSenseSessionPath(options.agentName, artifact.target.friendId, "telegram", artifact.target.sessionKey, agentRoot), [artifact])
      }
      return artifact.id
    },
    resolveOwnerCard: (messageId) => {
      const resolved = resolveTelegramControlArtifact(getEffectJournal(), { messageId, friendId: configuredOwnerFriendId, sessionKey: configuredOwnerSessionKey })
      return resolved?.requestId
        ? { artifactId: resolved.artifactId, admissionId: resolved.requestId }
        : null
    },
    resolveOwnerCardMessageId: (artifactId) => {
      const artifact = getEffectJournal().read(artifactId)
      if (artifact.authorClass !== "control" || artifact.target.kind !== "approved_relationship"
        || artifact.target.friendId !== configuredOwnerFriendId || artifact.target.sessionKey !== configuredOwnerSessionKey) return null
      return artifact.parts.find((part) => part.state === "session_recorded" && part.messageId)?.messageId ?? null
    },
    claimFriend: options.admission.claimFriend,
    revokeFriend: options.admission.revokeFriend,
    commitApprovedIngress: async (input) => {
      const sessionKey = `telegram:${input.botId}:${input.userId}`
      const reference = `telegram-admission:${input.admissionId}`
      const sessionPath = getSenseSessionPath(options.agentName, input.friendId, "telegram", sessionKey, agentRoot)
      const receipt = await recordTelegramEffectsInSession({ store: getEffectJournal(), sessionPath, artifacts: [], inbound: { text: input.text, reference } })
      return { admissionId: input.admissionId, friendId: input.friendId, sessionKey, eventId: receipt.eventId, reference }
    },
    enqueueApprovedWork: async (input) => {
      if (!inboxStore.captureAdmittedWork) throw new Error("Telegram admitted work inbox is unavailable")
      inboxStore.captureAdmittedWork(input)
    },
    dispatchApprovedWork: async (input) => {
      if (!inboxStore.admittedWorkState || !inboxStore.claimAdmittedWork || !inboxStore.completeAdmittedWork) return "indeterminate"
      const state = inboxStore.admittedWorkState(input.admissionId)
      if (state === "settled") return "settled"
      if (state !== "pending" || !inboxStore.claimAdmittedWork(input.admissionId)) return "indeterminate"
      try {
        const sessionPath = getSenseSessionPath(options.agentName, input.friendId, "telegram", input.sessionKey, agentRoot)
        const envelope = loadSessionEnvelopeFile(sessionPath)
        const event = envelope?.events.find((candidate) => candidate.id === input.eventId
          && candidate.role === "user" && candidate.relations.references.includes(input.reference))
        if (!event || typeof event.content !== "string") throw new Error("Telegram admitted work ingress is unavailable")
        const record = admissionStore.read(input.admissionId)
        await dispatchResolvedRelationshipTurn({ friendId: input.friendId, sessionKey: input.sessionKey, requestId: input.admissionId,
          eventId: input.eventId, reference: input.reference, text: event.content, userId: record.userId, chatId: record.chatId, orientation: input.orientation })
        inboxStore.completeAdmittedWork(input.admissionId)
        return "settled"
      } catch {
        return "indeterminate"
      }
    },
    withDecisionLease: (admissionId, work) => withSessionTurnLease(
      path.join(agentRoot, "state", "senses", "telegram", "admission-decisions", admissionId),
      async () => work(),
    ),
    ...(options.admission.createDisplayCode ? { createDisplayCode: options.admission.createDisplayCode } : {}),
  }) : undefined
  const recoverEffectOutbox = async (): Promise<void> => {
    if (!effectJournal && !existsSync(path.join(agentRoot, "state", "telegram", "effects"))) return
    await recoverTelegramEffectOutbox({
      store: getEffectJournal(),
      execute: executeAuthorizedEffect,
      matches: (artifact) => artifact.target.kind === "approved_relationship",
    })
    const accepted = getEffectJournal().list().filter((artifact) => artifact.target.kind === "approved_relationship" && artifact.parts.some((part) => part.state === "accepted"))
    for (const artifact of accepted) {
      const target = artifact.target as Extract<TelegramEffectTarget, { kind: "approved_relationship" }>
      await recordAcceptedEffects(getSenseSessionPath(options.agentName, target.friendId, "telegram", target.sessionKey, agentRoot), [artifact])
    }
  }

  const hydrateAuthorizedMessage = async (message: TelegramInboundMessage): Promise<{ text: string; attachmentIds: string[] }> => {
    if (!message.attachments?.length) return { text: [message.text, ...(message.attachmentNotices ?? [])].filter(Boolean).join("\n"), attachmentIds: [] }
    const ingested = await ingestTelegramAttachments({
      agentName: options.agentName,
      agentRoot,
      botToken,
      api,
      ...(options.attachmentFetch ? { fetch: options.attachmentFetch } : {}),
      attachments: message.attachments ?? [],
    })
    const attachmentIds = ingested.attachments.map((attachment) => attachment.id)
    return {
      text: [message.text, renderAttachmentBlock(ingested.attachments), ...(message.attachmentNotices ?? []), ...ingested.notices].filter(Boolean).join("\n"),
      attachmentIds,
    }
  }

  const onMessageBody = async (rawMessage: TelegramInboundMessage): Promise<void> => {
    const hydrated = await hydrateAuthorizedMessage(rawMessage)
    const message = { ...rawMessage, text: hydrated.text }
    const currentFriendId = configuredOwnerFriendId
    const currentSessionKey = configuredOwnerSessionKey
    const currentSessionPath = getSenseSessionPath(options.agentName, currentFriendId, "telegram", currentSessionKey, agentRoot)
    const inboundReference = `telegram-inbound:${createHmac("sha256", identityKey).update(`${message.updateId}\0${message.messageId}`).digest("hex")}`
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
    const groundingIntentTool = groundedAcceptance
      ? /^(?:what['’]?s up|status)\??$/u.test(normalizedRequest) ? "unraid_get_system"
        : /^how much (?:space|storage) is left\??$/u.test(normalizedRequest) ? "unraid_get_storage"
          : null
      : null
    const bufferedGroundedDeliveries: string[] = []
    const turnEffects: TelegramEffectArtifact[] = []
    let deliveryOrdinal = 0
    await recoverEffectOutbox()
    let ingressRelations: NonNullable<RunSenseTurnOptions["ingressRelations"]> = { replyToEventId: null, threadRootEventId: null, references: [inboundReference] }
    if (message.replyToMessageId && /^[1-9][0-9]*$/u.test(message.replyToMessageId)) {
      const replyMessageId = Number(message.replyToMessageId)
      const reply = resolveTelegramReply(getEffectJournal(), { messageId: replyMessageId, friendId: currentFriendId, sessionKey: currentSessionKey })
      const session = reply ? loadSessionEnvelopeFile(currentSessionPath) : null
      if (reply && session?.events.some((event) => event.id === reply.sessionEventId)) ingressRelations = {
        replyToEventId: reply.sessionEventId,
        threadRootEventId: null,
        references: [inboundReference, `telegram-artifact:${reply.artifactId}`, ...(reply.requestId ? [`request:${reply.requestId}`] : [])],
      }
    }
    try {
      acceptanceAuditBarrier()
      const ingressReceipt = options.resolveRelationshipAuthorization
        ? await recordTelegramEffectsInSession({
            store: getEffectJournal(),
            sessionPath: currentSessionPath,
            artifacts: [],
            inbound: { text: message.text, reference: inboundReference, attachmentIds: hydrated.attachmentIds, relations: ingressRelations },
          })
        : null
      const collected = await collectToolReceipts(() => runTurn({
        agentName: options.agentName,
        channel: "telegram",
        sessionKey: currentSessionKey,
        friendId: currentFriendId,
        identity: {
          provider: "telegram-user",
          externalId: options.admission ? message.userId : subject,
          displayName: options.admission ? "Ari" : `Telegram user ${subject}`,
          ...(options.admission ? { tenantId: botId! } : {}),
        },
        userMessage: message.text,
        ingressRelations,
        ...(ingressReceipt ? { precommittedIngress: ingressReceipt } : {}),
        turnMetricsObserver,
        deliverySink: {
          onDelivery: async (delivery) => {
            if (groundingIntentTool) {
              bufferedGroundedDeliveries.push(delivery.kind)
            } else {
              turnEffects.push(await deliverButlerEffect(delivery.text, `turn:${subject}:${message.updateId}:delivery:${deliveryOrdinal++}`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
              deliveryCount += 1
            }
          },
        },
        ...(toolContext || options.resolveRelationshipAuthorization ? {
          toolContext: { ...(toolContext ?? {}), ...(options.resolveRelationshipAuthorization ? { attachmentIds: hydrated.attachmentIds } : {}) },
        } : {}),
        ...(options.resolveRelationshipAuthorization ? {
          prepareRunAgentOptions: prepareRelationshipRunAgentOptions({
            friendId: currentFriendId,
            requestId: inboundReference,
            sessionEventId: ingressReceipt!.eventId,
            userId: message.userId,
            chatId: message.chatId,
            sessionKey: currentSessionKey,
          }),
        } : {}),
        ...(approvalRuntime ? { approvalCoordinatorFactory: approvalRuntime.coordinator } : {}),
      }), toolReceiptObserver)
      const result = collected.result
      let responseFallbackArtifactId: string | undefined
      turnMetricsObserver.providerInvocationCount = Math.max(turnMetricsObserver.providerInvocationCount, result.providerInvocationCount ?? 0)
      turnMetricsObserver.toolInvocationCount = Math.max(turnMetricsObserver.toolInvocationCount, result.toolInvocationCount ?? 0)
      if (groundingIntentTool) {
        const grounding = toolReceiptObserver.toolGroundings?.length === 1 ? toolReceiptObserver.toolGroundings[0] : undefined
        if (!grounding || grounding.toolName !== groundingIntentTool || bufferedGroundedDeliveries.length > 1
          || (bufferedGroundedDeliveries.length === 1 && bufferedGroundedDeliveries[0] !== "settle")) throw new Error("Canonical Sanctuary query did not produce exactly one matching grounded settle")
        const canonical = renderSanctuaryGroundedResponse(grounding.toolName, grounding.facts)
        turnEffects.push(await deliverButlerEffect(canonical, `turn:${subject}:${message.updateId}:delivery:${deliveryOrdinal++}`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
        deliveryCount = 1
      } else if (deliveryCount === 0 && result.response.trim()) {
        const artifact = await deliverButlerEffect(result.response, `turn:${subject}:${message.updateId}:delivery:${deliveryOrdinal++}`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) })
        turnEffects.push(artifact)
        responseFallbackArtifactId = artifact.id
      }
      if (result.sessionPath) {
        const causalEventIds = Object.fromEntries((groundingIntentTool ? [] : turnEffects).flatMap((artifact, index) => {
          const eventId = result.causalSessionEventIds?.[index]
          if (eventId) return [[artifact.id, eventId]]
          return artifact.id === responseFallbackArtifactId && result.responseCausalSessionEventId
            ? [[artifact.id, result.responseCausalSessionEventId]]
            : []
        }))
        await recordAcceptedEffects(result.sessionPath, turnEffects, undefined, causalEventIds)
      }
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
      if (deliveredMessageIds.length === 0) turnEffects.push(await deliverButlerEffect(fallback, `turn:${subject}:${message.updateId}:fallback`, undefined, (messageId, chunk) => { deliveredMessageIds.push(messageId); deliveredChunks.push(chunk) }))
      await recordAcceptedEffects(currentSessionPath, turnEffects, { text: message.text, reference: inboundReference, attachmentIds: hydrated.attachmentIds })
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

  const onMessage = (message: TelegramInboundMessage): Promise<void> => runWithAcceptanceAuditOwner(async () => {
    const ownerDecision = !message.attachments?.length && !message.attachmentNotices?.length ? admissionController?.parseOwnerDecision({
      text: message.text,
      ...(message.replyToMessageId ? { replyToMessageId: Number(message.replyToMessageId) } : {}),
    }) : null
    if (ownerDecision) {
      const actor = await options.admission?.resolveOwner({ botId: botId!, userId: message.userId, chatId: message.chatId, sessionKey: configuredOwnerSessionKey })
      if (!actor) throw new Error("Telegram admission owner decision identity is invalid")
      await admissionController!.decide({ ...ownerDecision, actorFriendId: actor.friendId })
      return
    }
    if ((message.attachments?.length || message.attachmentNotices?.length) && options.admission) {
      const actor = await options.admission.resolveOwner({ botId: botId!, userId: message.userId, chatId: message.chatId, sessionKey: configuredOwnerSessionKey })
      if (!actor || actor.friendId !== configuredOwnerFriendId) throw new Error("Telegram attachment owner relationship is not active")
    }
    await onMessageBody(message)
  })

  const onUnknownMessage = admissionController && options.admission ? async (message: Parameters<NonNullable<TelegramLongPollOptions["onUnknownMessage"]>>[0]): Promise<void> => {
    const approved = await options.admission!.resolveApprovedFriend(message)
    if (!approved) {
      await admissionController.handleUnknown(message)
      return
    }
    const hydrated = await hydrateAuthorizedMessage({
      updateId: message.updateId,
      messageId: String(message.messageId),
      userId: message.userId,
      chatId: message.chatId,
      text: message.text,
      attachments: message.attachments,
      attachmentNotices: message.attachmentNotices,
    })
    const sessionKey = `telegram:${message.botId}:${message.userId}`
    const reference = `telegram-inbound:${createHmac("sha256", identityKey).update(`${message.botId}\0${message.userId}\0${message.updateId}\0${message.messageId}`).digest("hex")}`
    const sessionPath = getSenseSessionPath(options.agentName, approved.friendId, "telegram", sessionKey, agentRoot)
    const receipt = await recordTelegramEffectsInSession({ store: getEffectJournal(), sessionPath, artifacts: [], inbound: { text: hydrated.text, reference, attachmentIds: hydrated.attachmentIds } })
    await dispatchResolvedRelationshipTurn({ friendId: approved.friendId, sessionKey, requestId: reference, eventId: receipt.eventId,
      reference, text: hydrated.text, attachmentIds: hydrated.attachmentIds, userId: message.userId, chatId: message.chatId })
  } : undefined

  const onUpdate = async (update: TelegramUpdate): Promise<boolean> => {
    const callback = update.callback_query
    if (callback?.data?.startsWith("admit:") && admissionController && callback.message) {
      return runWithAcceptanceAuditOwner(async () => {
        const actor = await options.admission?.resolveOwner({ botId: botId!, userId: String(callback.from.id), chatId: String(callback.message!.chat.id), sessionKey: configuredOwnerSessionKey })
        if (!actor) throw new Error("Telegram admission owner callback identity is invalid")
        const decision = admissionController.parseCallback(callback.data!, callback.message!.message_id)
        await admissionController.decide({ ...decision, actorFriendId: actor.friendId })
        const ownerTarget = configuredOwnerTarget()
        const artifact = await executeAuthorizedEffect({
          idempotencyKey: `admission-callback:${callback.id}`,
          target: { ...ownerTarget, requestId: decision.admissionId },
          authorClass: "control",
          effect: { kind: "callback_ack", callbackQueryId: callback.id },
        })
        await recordAcceptedEffects(getSenseSessionPath(options.agentName, ownerTarget.friendId, "telegram", ownerTarget.sessionKey, agentRoot), [artifact])
        return true
      })
    }
    if (!callback || !approvalTransport) return false
    return runWithAcceptanceAuditOwner(async () => (await approvalTransport.handleUpdate(update)).handled)
  }

  let poll: TelegramLongPoll
  try {
    poll = (options.createLongPoll ?? createTelegramLongPoll)({
      api,
      expectedUserId: authorizedUserId,
      expectedChatId: authorizedChatId,
      ...(onUnknownMessage ? { botId: botId!, onUnknownMessage } : {}),
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
        inboxStore.quarantineStrandedAdmittedWork?.()
        await runWithAcceptanceAuditOwner(async () => { await admissionController?.recover() })
        await runWithAcceptanceAuditOwner(recoverEffectOutbox)
        await runWithAcceptanceAuditOwner(reconcileSystemFailsafes)
        try {
          await runWithAcceptanceAuditOwner(async () => { await toolContext?.sanctuary?.recoverRoutineActions?.() })
        } catch (error) {
          emitNervesEvent({ level: "error", component: "senses", event: "senses.sanctuary_routine_recovery_error", message: "Sanctuary routine action recovery requires inspection", meta: { agentName: options.agentName, subject, category: error instanceof Error ? error.name : "unknown" } })
        }
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
        const sessionPath = getSenseSessionPath(options.agentName, configuredOwnerFriendId, "telegram", configuredOwnerSessionKey, agentRoot)
        await recordAcceptedEffects(sessionPath, [effect])
      })
    },
    async sendExternalEventDecision(input) {
      const source = requiredText(input.source, "external event source")
      const eventId = requiredText(input.eventId, "external event id")
      if (Buffer.byteLength(source) > 512 || Buffer.byteLength(eventId) > 512 || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("Telegram external event identity is invalid")
      await runWithAcceptanceAuditOwner(async () => {
        const receiptIdentity = JSON.stringify([source, eventId, input.generation])
        const effect = await deliverButlerEffect(requiredText(input.text, "external event decision"), `external-event:${receiptIdentity}`, input.signal)
        const sessionPath = getSenseSessionPath(options.agentName, configuredOwnerFriendId, "telegram", configuredOwnerSessionKey, agentRoot)
        await recordAcceptedEffects(sessionPath, [effect])
      })
    },
    async sendAwaitFollowUp(request) {
      return runWithAcceptanceAuditOwner(() => deliverAwaitFollowUp(request))
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
        await attempt(() => effectJournal?.close())
        await attempt(() => admissionStore?.close())
        await attempt(() => resetAwaitToolDeps())
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

export async function createProductionTelegramRelationshipComposition(agentName: string, credentials: TelegramSenseCredentials, agentRootOverride?: string): Promise<Pick<CreateTelegramSenseAppOptions,
  "admission" | "authorizeRelationshipEffect" | "resolveRelationshipAuthorization"> & { telegramContactManager: TelegramContactManager }> {
  const agentRoot = agentRootOverride ?? getAgentRoot(agentName)
  const botId = canonicalTelegramId(credentials.botId ?? telegramBotIdFromToken(credentials.botToken), "bot id")
  const ownerUserId = canonicalTelegramId(credentials.authorizedUserId, "authorized user id")
  const ownerChatId = canonicalTelegramId(credentials.authorizedChatId, "authorized chat id")
  if (ownerUserId !== ownerChatId) throw new Error("Telegram owner relationship requires a private user-bound chat")
  const ownerSessionKey = `telegram:${opaqueTelegramSubject(readOrCreateTelegramIdentityKey(agentRoot), botId, ownerUserId, ownerChatId)}`
  const store = new FileFriendStore(path.join(agentRoot, "friends"))
  const sameBotTelegramBindings = (friend: NonNullable<Awaited<ReturnType<FileFriendStore["get"]>>>) => friend.externalIds.filter((external) =>
    external.provider === "telegram-user" && external.tenantId === botId)
  const exactTelegramIdentity = (friend: NonNullable<Awaited<ReturnType<FileFriendStore["get"]>>>, userId: string): boolean => {
    const bindings = sameBotTelegramBindings(friend)
    return bindings.length === 1 && /^[1-9][0-9]*$/u.test(bindings[0]!.externalId) && bindings[0]!.externalId === userId
  }
  const canonicalOwner = (friend: Awaited<ReturnType<FileFriendStore["get"]>>): boolean => Boolean(friend
    && exactTelegramIdentity(friend, ownerUserId) && friend.admissionState === "active" && friend.trustLevel === "family"
    && friend.initiativePolicy === "proactive" && friend.capabilityProfileId === "sanctuary-owner")
  const canonicalHousehold = (friend: Awaited<ReturnType<FileFriendStore["get"]>>, userId: string): boolean => Boolean(friend
    && exactTelegramIdentity(friend, userId) && friend.admissionState === "active" && friend.trustLevel === "friend"
    && friend.initiativePolicy === "request_follow_up_only" && friend.capabilityProfileId === "sanctuary-household")
  const owner = await store.findByExternalId("telegram-user", ownerUserId, botId)
  if (!owner || !canonicalOwner(owner)) {
    throw new Error("Telegram owner Friend must be active with the sanctuary-owner profile and exact bot identity")
  }
  const registry = loadRelationshipCapabilityRegistry(agentRoot)
  if (!registry.profiles["sanctuary-owner"] || !registry.profiles["sanctuary-household"]) {
    throw new Error("Telegram relationship capability registry is missing canonical profiles")
  }
  const assertLiveOwner = async (actorFriendId: string): Promise<void> => {
    const current = await store.get(owner.id)
    if (actorFriendId !== owner.id || !canonicalOwner(current)) throw new Error("Only the live Telegram owner may manage contacts")
  }
  const admissionsRoot = path.join(agentRoot, "state", "senses", "telegram", "admissions")
  const invalidatePendingApprovals = (sessionPath: string): void => {
    const stateRoot = path.join(agentRoot, "state", "approvals")
    const checkpoints = new FileApprovalCheckpointStore(path.join(stateRoot, "checkpoints.json"))
    const tokens = new FileApprovalTokenStore(path.join(stateRoot, "tokens.json"))
    const approvals = openApprovalStore({ databasePath: path.join(stateRoot, "approvals.sqlite") })
    try {
      for (const checkpoint of checkpoints.list()) {
        const approval = approvals.read(checkpoint.approvalId)
        if (!approval || path.resolve(approval.sessionPath) !== path.resolve(sessionPath)) continue
        const decisionToken = tokens.get(checkpoint.approvalId)
        if (approval.state === "preparing") approvals.recoverPreparing({ approvalId: approval.approvalId, state: "abandoned_before_attempt", reason: "requesting relationship was revoked" })
        else if (approval.state === "awaiting_prompt_binding") approvals.abandonPromptBinding({ approvalId: approval.approvalId, reason: "requesting relationship was revoked" })
        else if (approval.state === "proposed" && decisionToken) approvals.decide({
          approvalId: approval.approvalId, decisionToken, decision: "deny", requesterId: approval.requesterId,
          transport: approval.transport, transportUserId: approval.transportUserId, transportChatId: approval.transportChatId,
          transportMessageId: approval.transportMessageId!, sessionKey: approval.sessionKey, ownerId: `relationship-revocation-${randomUUID()}`,
        })
        else if (approval.state === "proposed") throw new Error(`Cannot revoke relationship while approval ${approval.approvalId} is missing its decision token`)
        else if (approval.state === "claimed" && approval.ownerId) approvals.abandonBeforeAttempt({ approvalId: approval.approvalId, ownerId: approval.ownerId, epoch: approval.epoch, reason: "requesting relationship was revoked" })
        else if (approval.state === "claimed") throw new Error(`Cannot revoke relationship while approval ${approval.approvalId} is missing its claim owner`)
        const terminal = approvals.read(checkpoint.approvalId)
        if (terminal && terminal.state !== "attempted") checkpoints.remove(checkpoint.approvalId)
        tokens.remove(checkpoint.approvalId)
      }
    } finally { approvals.close() }
  }
  const telegramContactManager: TelegramContactManager = {
    list: async ({ actorFriendId }) => {
      await assertLiveOwner(actorFriendId)
      const contacts = (await store.listAll()).flatMap((friend) => {
        if (friend.id === owner.id) return []
        const bindings = sameBotTelegramBindings(friend)
        if (bindings.length !== 1 || !/^[1-9][0-9]*$/u.test(bindings[0]!.externalId)) return []
        return [{ friendId: friend.id, name: friend.name, userId: bindings[0]!.externalId, admissionState: friend.admissionState ?? "unverified", initiativePolicy: friend.initiativePolicy ?? "none" }]
      }).slice(0, 256)
      const admissions = new FileTelegramAdmissionStore(admissionsRoot)
      try {
        const blocked = admissions.list().filter((record) => record.status === "blocked" && record.botId === botId)
          .slice(0, 256).map((record) => ({ admissionId: record.id, userId: record.userId, displayCode: record.displayCode, status: "blocked" as const, createdAt: new Date(record.createdAt).toISOString() }))
        return { contacts, blocked }
      } finally { admissions.close() }
    },
    revoke: async ({ actorFriendId, friendId }) => {
      await assertLiveOwner(actorFriendId)
      if (friendId === owner.id) throw new Error("The Telegram owner relationship cannot revoke itself")
      const current = await store.get(friendId)
      if (!current) throw new Error("Telegram contact was not found")
      const bindings = sameBotTelegramBindings(current)
      if (bindings.length !== 1 || !/^[1-9][0-9]*$/u.test(bindings[0]!.externalId) || bindings[0]!.externalId === ownerUserId) throw new Error("Telegram contact identity is not exact")
      const sessionKey = `telegram:${botId}:${bindings[0]!.externalId}`
      const sessionPath = getSenseSessionPath(agentName, current.id, "telegram", sessionKey, agentRoot)
      await withSessionTurnLease(sessionPath, async () => {
        invalidatePendingApprovals(sessionPath)
        const live = await store.get(current.id)
        if (!live || !exactTelegramIdentity(live, bindings[0]!.externalId)) throw new Error("Telegram contact identity changed")
        const { capabilityProfileId: _removedProfile, ...withoutProfile } = live
        await store.put(live.id, { ...withoutProfile, admissionState: "revoked", initiativePolicy: "none", updatedAt: new Date().toISOString() })
        cancelRelationshipFollowUps(agentRoot, agentName, { friendId: live.id, channel: "telegram", key: sessionKey })
      })
      return { revoked: true, friendId }
    },
    unblock: async ({ actorFriendId, admissionId }) => {
      await assertLiveOwner(actorFriendId)
      const admissions = new FileTelegramAdmissionStore(admissionsRoot)
      try {
        const record = admissions.read(admissionId)
        if (record.botId !== botId || record.userId !== record.chatId) throw new Error("Blocked Telegram contact identity changed")
        admissions.releaseBlock(admissionId)
      } finally { admissions.close() }
      return { unblocked: true, admissionId }
    },
  }
  const resolveEvaluator = async (input: { friendId: string; requestId: string; sessionEventId: string; botId: string; userId: string; chatId: string; sessionKey: string }): Promise<RelationshipAuthorizationEvaluator> => {
    const friend = await store.get(input.friendId)
    const ownerBound = friend?.id === owner.id
    const coordinatesValid = ownerBound
      ? input.botId === botId && input.userId === ownerUserId && input.chatId === ownerChatId && input.sessionKey === ownerSessionKey
      : input.botId === botId && input.userId === input.chatId && input.sessionKey === `telegram:${botId}:${input.userId}`
    if (!friend || !coordinatesValid || (ownerBound ? !canonicalOwner(friend) : !canonicalHousehold(friend, input.userId))) {
      throw new Error("Telegram relationship identity binding is not active")
    }
    return createRelationshipAuthorizationEvaluator({
      friend,
      registry: loadRelationshipCapabilityRegistry(agentRoot),
      requestId: input.requestId,
      requestPhase: "inbound",
      sessionEventId: input.sessionEventId,
    })
  }
  const admission: TelegramAdmissionDependencies = {
    ownerFriendId: owner.id,
    resolveOwner: async ({ botId: candidateBotId, userId, chatId, sessionKey }) => {
      if (candidateBotId !== botId || userId !== ownerUserId || chatId !== ownerChatId || sessionKey !== ownerSessionKey) return null
      const exact = await store.findByExternalId("telegram-user", userId, botId)
      const current = await store.get(owner.id)
      return exact?.id === owner.id && canonicalOwner(current)
        ? { friendId: owner.id }
        : null
    },
    resolveApprovedFriend: async ({ botId: candidateBotId, userId, chatId }) => {
      if (candidateBotId !== botId || userId !== chatId) return null
      const friend = await store.findByExternalId("telegram-user", userId, botId)
      return friend && canonicalHousehold(friend, userId) ? { friendId: friend.id } : null
    },
    claimFriend: async (input) => {
      if (input.botId !== botId || input.userId !== input.chatId) return { kind: "collision", reason: "Telegram identity is not bound to this bot and private chat" }
      const claimed = await store.claimExternalId({
        externalId: { provider: "telegram-user", externalId: input.userId, tenantId: botId, linkedAt: new Date().toISOString() },
        target: { kind: "create", record: { id: randomUUID(), name: "Household member" } },
      }) as Extract<Awaited<ReturnType<FileFriendStore["claimExternalId"]>>, { ok: true }>
      const current = claimed.record
      const now = new Date().toISOString()
      const connections = input.relationship
        ? [...(current.connections ?? []).filter((connection) => !(connection.name === owner.name && connection.relationship === input.relationship)), { name: owner.name, relationship: input.relationship }]
        : current.connections
      const updated = { ...current,
        ...(connections ? { connections } : {}),
        trustLevel: input.defaults.trustLevel, admissionState: input.defaults.admissionState,
        initiativePolicy: input.defaults.initiativePolicy, capabilityProfileId: input.defaults.capabilityProfileId, updatedAt: now }
      await store.put(current.id, updated)
      return { kind: claimed.status === "created" ? "created" : "existing", friendId: current.id }
    },
    revokeFriend: async (input) => {
      if (input.botId !== botId || input.userId !== input.chatId) return { kind: "collision", reason: "Telegram revocation identity is invalid" }
      const current = await store.findByExternalId("telegram-user", input.userId, botId)
      if (!current || current.id !== input.friendId || !exactTelegramIdentity(current, input.userId)) return { kind: "collision", reason: "Telegram revocation identity changed" }
      const { capabilityProfileId: _removedProfile, ...withoutProfile } = current
      await store.put(current.id, { ...withoutProfile, admissionState: "revoked", initiativePolicy: "none", updatedAt: new Date().toISOString() })
      cancelRelationshipFollowUps(agentRoot, agentName, { friendId: current.id, channel: "telegram", key: `telegram:${botId}:${input.userId}` })
      return { kind: "revoked" }
    },
  }
  return {
    telegramContactManager,
    admission,
    resolveRelationshipAuthorization: resolveEvaluator,
    authorizeRelationshipEffect: async (input) => {
      if (input.target.kind !== "approved_relationship") return { allowed: false, reason: "relationship effect target is required" }
      const friend = await store.get(input.target.friendId)
      if (!friend) return { allowed: false, reason: "relationship admission is not active" }
      const bindings = sameBotTelegramBindings(friend)
      if (bindings.length !== 1 || !/^[1-9][0-9]*$/u.test(bindings[0]!.externalId)) return { allowed: false, reason: "relationship Telegram identity binding is unavailable" }
      const chatId = bindings[0]!.externalId
      if (friend.id === owner.id ? !canonicalOwner(friend) : !canonicalHousehold(friend, chatId)) return { allowed: false, reason: "relationship admission is not active or canonical" }
      if (friend.id === owner.id) {
        if (chatId !== ownerUserId || chatId !== ownerChatId || input.target.sessionKey !== ownerSessionKey) return { allowed: false, reason: "owner Telegram identity or session binding changed" }
      } else if (input.target.sessionKey !== `telegram:${botId}:${chatId}`) return { allowed: false, reason: "relationship Telegram session binding changed" }
      const inboundIdempotency = input.target.requestId
        ? new RegExp(`^relationship-turn:${input.target.requestId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:delivery:[0-9]+$`, "u").test(input.idempotencyKey)
        : false
      const durableFollowUp = friend.id !== owner.id && input.target.requestId
        ? hasActiveRelationshipFollowUp(agentRoot, { friendId: friend.id, channel: "telegram", key: input.target.sessionKey, requestId: input.target.requestId, allowElapsed: input.idempotencyKey.startsWith("await-expiry-follow-up:") })
        : false
      if (friend.id !== owner.id && input.target.requestId && !inboundIdempotency && !durableFollowUp) return { allowed: false, reason: "relationship follow-up is not bound to an active request await" }
      const evaluator = createRelationshipAuthorizationEvaluator({
        friend,
        registry: loadRelationshipCapabilityRegistry(agentRoot),
        ...(input.target.requestId ? { requestId: input.target.requestId, requestPhase: inboundIdempotency ? "inbound" as const : "follow_up" as const } : {}),
      })
      const scope = input.target.friendId === owner.id
        ? (input.target.requestId ? "telegram.owner_event" : "telegram.proactive")
        : "telegram.request_return"
      const authorization = evaluator.authorizeEffect(scope)
      return authorization.allowed
        ? { allowed: true, receiptId: authorization.receiptId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), transport: { chatId } }
        : authorization
    },
  }
}

export async function startTelegramSenseApp(agentName: string): Promise<TelegramSenseApp> {
  const loaded = loadTelegramSenseCredentials(agentName)
  const credentials = { ...loaded, botId: telegramBotIdFromToken(loaded.botToken) }
  const app = createTelegramSenseApp({
    agentName,
    credentials,
    ...(await createProductionTelegramRelationshipComposition(agentName, credentials)),
    ...(agentName === "sanctuary" ? { privilegedFailsafe: {
      eventRoot: getExternalEventRoot(),
      verifyProtectiveState: createSabQueueProtectiveStateVerifier(),
    } } : {}),
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_app_ready",
    message: "Telegram sense app is ready",
    meta: { agentName },
  })
  return app
}

export async function sendTelegramExternalEventDecision(
  agentName: string,
  input: { source: string; eventId: string; generation: number; text: string; signal?: AbortSignal },
): Promise<void> {
  const app = await startTelegramSenseApp(agentName)
  try {
    await app.sendExternalEventDecision(input)
  } finally {
    await app.stop()
  }
}

export async function sendTelegramAwaitFollowUp(agentName: string, request: CrossChatDeliveryRequest): Promise<CrossChatDirectDeliveryResult> {
  const app = await startTelegramSenseApp(agentName)
  try {
    return await app.sendAwaitFollowUp(request)
  } finally {
    await app.stop()
  }
}
