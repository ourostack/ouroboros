import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { withImmediateSessionTurnLease } from "../mind/session-transaction"
import {
  FIXED_ADMISSION_ACKNOWLEDGEMENT,
  type TelegramArtifactAuthorClass,
  type TelegramEffect,
  type TelegramEffectTarget,
} from "./telegram-effect-adapter"
import { escapeTelegramHtml } from "./telegram-client"

export { FIXED_ADMISSION_ACKNOWLEDGEMENT }

export type TelegramAdmissionStatus =
  | "pending"
  | "approved"
  | "friend_bound"
  | "ingress_committed"
  | "turn_queued"
  | "handled"
  | "denied"
  | "blocked"
  | "expired"
  | "collision"
  | "indeterminate"

export interface TelegramUnknownContactMessage {
  updateId: number
  messageId: number
  botId: string
  userId: string
  chatId: string
  text: string
  displayLabel: string
  hasAttachments: boolean
}

export interface TelegramAdmissionRecord {
  schemaVersion: 1
  id: string
  revision: number
  status: TelegramAdmissionStatus
  botId: string
  userId: string
  chatId: string
  updateId: number
  messageId: number
  quarantinedText: string | null
  contentDigest: string
  displayLabel: string
  displayCode: string
  hasAttachments: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number
  friendId: string | null
  acknowledgementArtifactId: string | null
  ownerCardArtifactId: string | null
  ownerCardMessageId: number | null
  ingressSessionKey: string | null
  ingressEventId: string | null
  ingressReference: string | null
}

export interface TelegramAdmissionLimits {
  maxPendingContacts?: number
  maxTextBytes?: number
  maxMessagesPerIdentity?: number
  maxMessagesPerWindow?: number
  rateWindowMs?: number
  maxTotalBytes?: number
  retentionMs?: number
  retryCooldownMs?: number
  terminalRetentionMs?: number
  maxTerminalRecords?: number
}

interface ResolvedTelegramAdmissionLimits {
  maxPendingContacts: number
  maxTextBytes: number
  maxMessagesPerIdentity: number
  maxMessagesPerWindow: number
  rateWindowMs: number
  maxTotalBytes: number
  retentionMs: number
  retryCooldownMs: number
  terminalRetentionMs: number
  maxTerminalRecords: number
}

export interface TelegramAdmissionSelfHealth {
  schemaVersion: 1
  code: "telegram_admission_overflow"
  count: number
  lastObservedAt: number
}

export interface TelegramAdmissionEffectRequest {
  idempotencyKey: string
  target: TelegramEffectTarget
  authorClass: TelegramArtifactAuthorClass
  effect: TelegramEffect
}

export interface TelegramAdmissionFriendClaim {
  provider: "telegram-user"
  botId: string
  userId: string
  chatId: string
  admissionId: string
  displayLabel: string
  defaults: {
    trustLevel: "friend"
    admissionState: "active"
    initiativePolicy: "request_follow_up_only"
    capabilityProfileId: "sanctuary-household"
  }
}

export type TelegramAdmissionFriendClaimResult =
  | { kind: "created" | "existing"; friendId: string }
  | { kind: "collision"; reason: string }

export interface TelegramAdmissionFriendRevocation {
  provider: "telegram-user"
  botId: string
  userId: string
  chatId: string
  admissionId: string
  friendId: string
}

export type TelegramAdmissionFriendRevocationResult =
  | { kind: "revoked" }
  | { kind: "collision"; reason: string }

export interface TelegramApprovedTurn {
  admissionId: string
  idempotencyKey: string
  friendId: string
  botId: string
  userId: string
  chatId: string
  updateId: number
  messageId: number
  text: string
  hasAttachments: boolean
  synthetic: false
}

export interface TelegramCommittedAdmissionIngress {
  admissionId: string
  friendId: string
  sessionKey: string
  eventId: string
  reference: string
}

const ACTIVE_STATUSES = new Set<TelegramAdmissionStatus>([
  "pending", "approved", "friend_bound", "ingress_committed", "turn_queued",
])
const TERMINAL_STATUSES = new Set<TelegramAdmissionStatus>([
  "handled", "denied", "blocked", "expired", "collision", "indeterminate",
])
const ADMISSION_ID = /^[a-f0-9]{20}$/u
const CANONICAL_ID = /^[1-9][0-9]*$/u
const DEFAULT_LIMITS: ResolvedTelegramAdmissionLimits = {
  maxPendingContacts: 32,
  maxTextBytes: 16 * 1024,
  maxMessagesPerIdentity: 8,
  maxMessagesPerWindow: 128,
  rateWindowMs: 60_000,
  maxTotalBytes: 256 * 1024,
  retentionMs: 24 * 60 * 60 * 1_000,
  retryCooldownMs: 5 * 60 * 1_000,
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  maxTerminalRecords: 256,
}

interface TelegramAdmissionRateState {
  version: 1
  events: Array<{ identityDigest: string; updateDigest: string; observedAt: number }>
}

function admissionId(input: TelegramUnknownContactMessage): string {
  return crypto.createHash("sha256")
    .update(`telegram-admission-v1\0${input.botId}\0${input.userId}\0${input.chatId}\0${input.updateId}`)
    .digest("hex")
    .slice(0, 20)
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex")
}

function identity(record: Pick<TelegramAdmissionRecord, "botId" | "userId" | "chatId">): string {
  return `${record.botId}:${record.userId}:${record.chatId}`
}

function boundedLabel(value: string): string {
  return [...value.normalize("NFKC")].slice(0, 120).join("") || "(no Telegram label)"
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Telegram admission ${label} is invalid`)
}

function assertCanonicalId(value: string, label: string): void {
  if (!CANONICAL_ID.test(value)) throw new Error(`Telegram admission ${label} is invalid`)
}

function validateRecord(value: unknown, expectedId?: string): asserts value is TelegramAdmissionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram admission record is invalid")
  const record = value as TelegramAdmissionRecord
  if (record.schemaVersion !== 1 || !ADMISSION_ID.test(record.id) || (expectedId !== undefined && record.id !== expectedId)
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || ![...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(record.status)
    || typeof record.botId !== "string" || typeof record.userId !== "string" || typeof record.chatId !== "string"
    || !CANONICAL_ID.test(record.botId) || !CANONICAL_ID.test(record.userId) || !CANONICAL_ID.test(record.chatId)
    || !Number.isSafeInteger(record.updateId) || record.updateId < 0
    || !Number.isSafeInteger(record.messageId) || record.messageId < 1
    || (record.quarantinedText !== null && typeof record.quarantinedText !== "string")
    || typeof record.contentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.contentDigest)
    || typeof record.displayLabel !== "string" || [...record.displayLabel].length > 120
    || typeof record.displayCode !== "string" || record.displayCode.length < 4 || record.displayCode.length > 32
    || typeof record.hasAttachments !== "boolean"
    || ![record.createdAt, record.updatedAt, record.expiresAt].every(Number.isSafeInteger)
    || (record.friendId !== null && (typeof record.friendId !== "string" || !record.friendId))
    || (record.acknowledgementArtifactId !== null && typeof record.acknowledgementArtifactId !== "string")
    || (record.ownerCardArtifactId !== null && typeof record.ownerCardArtifactId !== "string")
    || (record.ownerCardMessageId !== null && (!Number.isSafeInteger(record.ownerCardMessageId) || record.ownerCardMessageId < 1))
    || (record.ingressSessionKey !== null && (typeof record.ingressSessionKey !== "string" || record.ingressSessionKey.length < 1 || record.ingressSessionKey.length > 1_024))
    || (record.ingressEventId !== null && (typeof record.ingressEventId !== "string" || !/^evt-[0-9]{6,}$/u.test(record.ingressEventId)))
    || (record.ingressReference !== null && record.ingressReference !== `telegram-admission:${record.id}`)
    || ([record.ingressSessionKey, record.ingressEventId, record.ingressReference].filter((entry) => entry !== null).length !== 0
      && [record.ingressSessionKey, record.ingressEventId, record.ingressReference].some((entry) => entry === null))
    || (TERMINAL_STATUSES.has(record.status) && record.quarantinedText !== null)) {
    throw new Error("Telegram admission record is invalid")
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporaryPath, filePath)
  fs.chmodSync(filePath, 0o600)
  const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

export class FileTelegramAdmissionStore {
  private readonly limits: ResolvedTelegramAdmissionLimits
  private readonly rootFd: number
  private readonly rootIdentity: { dev: number; ino: number }
  private closed = false

  constructor(
    private readonly root: string,
    limits: TelegramAdmissionLimits = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Telegram admission ${key} must be a positive safe integer`)
    }
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root)
      if (stat.isSymbolicLink()) throw new Error("Telegram admission root must not be a symbolic link")
      if (!stat.isDirectory()) throw new Error("Telegram admission root must be a directory")
    } else fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    fs.chmodSync(root, 0o700)
    const stat = fs.lstatSync(root)
    /* v8 ignore next -- race defense: constructor-created/chmodded roots satisfy this unless another process swaps the path between syscalls @preserve */
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error("Telegram admission root is unsafe")
    this.rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const pinned = fs.fstatSync(this.rootFd)
    this.rootIdentity = { dev: pinned.dev, ino: pinned.ino }
  }

  private assertRootIdentity(): void {
    if (this.closed) throw new Error("Telegram admission store is closed")
    const pinned = fs.fstatSync(this.rootFd)
    const current = fs.lstatSync(this.root)
    if (!pinned.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
      || pinned.dev !== this.rootIdentity.dev || pinned.ino !== this.rootIdentity.ino
      || current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino
      || (current.mode & 0o777) !== 0o700) throw new Error("Telegram admission root identity changed")
  }

  close(): void {
    if (this.closed) return
    fs.closeSync(this.rootFd)
    this.closed = true
  }

  private filePath(id: string): string {
    if (!ADMISSION_ID.test(id)) throw new Error("Telegram admission id is invalid")
    return path.join(this.root, `${id}.json`)
  }

  coordinationPath(id: string): string {
    return `${this.filePath(id)}.decision`
  }

  private selfHealthPath(): string {
    return path.join(this.root, "self-health.json")
  }

  private rateStatePath(): string {
    return path.join(this.root, "rate-window.json")
  }

  private globalCoordinationPath(): string {
    return path.join(path.dirname(this.root), `.${path.basename(this.root)}-coordination`, "admission")
  }

  private readRateState(now: number): TelegramAdmissionRateState {
    let state: TelegramAdmissionRateState = { version: 1, events: [] }
    try {
      const value = JSON.parse(fs.readFileSync(this.rateStatePath(), "utf8")) as TelegramAdmissionRateState
      if (value.version !== 1 || !Array.isArray(value.events) || value.events.some((event) => !event
        || !/^[a-f0-9]{64}$/u.test(event.identityDigest) || !/^[a-f0-9]{64}$/u.test(event.updateDigest)
        || !Number.isSafeInteger(event.observedAt) || event.observedAt < 0)) throw new Error("invalid")
      state = value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Telegram admission rate state is invalid", { cause: error })
    }
    state.events = state.events.filter((event) => event.observedAt > now - this.limits.rateWindowMs)
    return state
  }

  private recordRateAttempt(input: TelegramUnknownContactMessage, now: number): boolean {
    this.assertRootIdentity()
    const state = this.readRateState(now)
    const identityDigest = digest(`identity\0${identity(input)}`)
    const updateDigest = digest(`update\0${input.botId}\0${input.updateId}`)
    if (!state.events.some((event) => event.updateDigest === updateDigest)) state.events.push({ identityDigest, updateDigest, observedAt: now })
    const identityCount = state.events.filter((event) => event.identityDigest === identityDigest).length
    const overflow = identityCount > this.limits.maxMessagesPerIdentity || state.events.length > this.limits.maxMessagesPerWindow
    state.events = state.events
      .sort((left, right) => left.observedAt - right.observedAt || left.updateDigest.localeCompare(right.updateDigest))
      .slice(-(this.limits.maxMessagesPerWindow + 1))
    atomicWrite(this.rateStatePath(), state)
    this.assertRootIdentity()
    return overflow
  }

  private compactTerminalRecords(records: TelegramAdmissionRecord[], now: number): TelegramAdmissionRecord[] {
    const terminal = records.filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    const retained = new Set(terminal
      .filter((record) => record.updatedAt > now - this.limits.terminalRetentionMs)
      .slice(0, this.limits.maxTerminalRecords)
      .map((record) => record.id))
    for (const record of terminal) {
      if (!retained.has(record.id)) fs.unlinkSync(this.filePath(record.id))
    }
    this.assertRootIdentity()
    return records.filter((record) => !TERMINAL_STATUSES.has(record.status) || retained.has(record.id))
  }

  read(id: string): TelegramAdmissionRecord {
    this.assertRootIdentity()
    const filePath = this.filePath(id)
    const handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(handle)
      if (!stat.isFile() || stat.size < 2 || stat.size > this.limits.maxTextBytes + 8 * 1024) throw new Error("Telegram admission record is not bounded")
      const parsed = JSON.parse(fs.readFileSync(handle, "utf8")) as unknown
      validateRecord(parsed, id)
      this.assertRootIdentity()
      return parsed
    } finally {
      fs.closeSync(handle)
    }
  }

  list(): TelegramAdmissionRecord[] {
    this.assertRootIdentity()
    const records = fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{20}\.json$/u.test(entry.name))
      .map((entry) => this.read(entry.name.slice(0, -5)))
    this.assertRootIdentity()
    return records
  }

  private write(record: TelegramAdmissionRecord): void {
    this.assertRootIdentity()
    validateRecord(record, record.id)
    atomicWrite(this.filePath(record.id), record)
    this.assertRootIdentity()
  }

  readSelfHealth(): TelegramAdmissionSelfHealth | null {
    this.assertRootIdentity()
    try {
      const value = JSON.parse(fs.readFileSync(this.selfHealthPath(), "utf8")) as TelegramAdmissionSelfHealth
      if (value.schemaVersion !== 1 || value.code !== "telegram_admission_overflow" || !Number.isSafeInteger(value.count)
        || value.count < 1 || !Number.isSafeInteger(value.lastObservedAt)) throw new Error("invalid")
      this.assertRootIdentity()
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new Error("Telegram admission self-health is invalid", { cause: error })
    }
  }

  private recordOverflow(): void {
    const now = this.now()
    const current = this.readSelfHealth()
    atomicWrite(this.selfHealthPath(), {
      schemaVersion: 1,
      code: "telegram_admission_overflow",
      count: (current?.count ?? 0) + 1,
      lastObservedAt: now,
    } satisfies TelegramAdmissionSelfHealth)
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.telegram_admission_overflow",
      message: "Telegram admission capacity was exceeded",
      meta: { count: (current?.count ?? 0) + 1 },
    })
  }

  capture(input: TelegramUnknownContactMessage, displayCode: string):
    | { kind: "created" | "existing"; record: TelegramAdmissionRecord }
    | { kind: "blocked" | "overflow" } {
    return withImmediateSessionTurnLease(this.globalCoordinationPath(), () => this.captureExclusive(input, displayCode))
  }

  private captureExclusive(input: TelegramUnknownContactMessage, displayCode: string):
    | { kind: "created" | "existing"; record: TelegramAdmissionRecord }
    | { kind: "blocked" | "overflow" } {
    assertSafeInteger(input.updateId, "update id")
    assertSafeInteger(input.messageId, "message id")
    if (input.messageId < 1) throw new Error("Telegram admission message id is invalid")
    assertCanonicalId(input.botId, "bot id")
    assertCanonicalId(input.userId, "user id")
    assertCanonicalId(input.chatId, "chat id")
    const now = this.now()
    const records = this.compactTerminalRecords(this.list(), now)
    if (this.recordRateAttempt(input, now)) {
      this.recordOverflow()
      return { kind: "overflow" }
    }
    const sameIdentity = records.filter((record) => identity(record) === identity(input))
      .sort((left, right) => right.createdAt - left.createdAt)
    const blocked = sameIdentity.find((record) => record.status === "blocked")
    if (blocked) return { kind: "blocked" }
    const active = sameIdentity.find((record) => ACTIVE_STATUSES.has(record.status))
    if (active) return { kind: "existing", record: active }
    const recentTerminal = sameIdentity[0]
    if (recentTerminal && now - recentTerminal.updatedAt < this.limits.retryCooldownMs) return { kind: "blocked" }
    const textBytes = Buffer.byteLength(input.text, "utf8")
    const pending = records.filter((record) => ACTIVE_STATUSES.has(record.status))
    const pendingBytes = pending.reduce((total, record) => total + Buffer.byteLength(
      /* v8 ignore next -- active records are validated to retain quarantined text; fallback is corruption defense @preserve */
      record.quarantinedText ?? "",
      "utf8",
    ), 0)
    if (textBytes > this.limits.maxTextBytes || pending.length >= this.limits.maxPendingContacts
      || pendingBytes + textBytes > this.limits.maxTotalBytes || this.limits.maxMessagesPerIdentity < 1) {
      this.recordOverflow()
      return { kind: "overflow" }
    }
    const id = admissionId(input)
    const replay = records.find((record) => record.id === id)
    /* v8 ignore next -- active same-identity records return above; an ID replay reaching here is necessarily terminal @preserve */
    if (replay) return ACTIVE_STATUSES.has(replay.status) ? { kind: "existing", record: replay } : { kind: "blocked" }
    const record: TelegramAdmissionRecord = {
      schemaVersion: 1,
      id,
      revision: 0,
      status: "pending",
      botId: input.botId,
      userId: input.userId,
      chatId: input.chatId,
      updateId: input.updateId,
      messageId: input.messageId,
      quarantinedText: input.text,
      contentDigest: digest(input.text),
      displayLabel: boundedLabel(input.displayLabel),
      displayCode,
      hasAttachments: input.hasAttachments,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.limits.retentionMs,
      friendId: null,
      acknowledgementArtifactId: null,
      ownerCardArtifactId: null,
      ownerCardMessageId: null,
      ingressSessionKey: null,
      ingressEventId: null,
      ingressReference: null,
    }
    this.write(record)
    emitNervesEvent({
      component: "senses",
      event: "senses.telegram_admission_captured",
      message: "captured an unknown Telegram contact before friend resolution",
      meta: { admissionId: id, hasAttachments: input.hasAttachments, textBytes },
    })
    return { kind: "created", record }
  }

  compareAndSwap(input: {
    admissionId: string
    expectedStatus: TelegramAdmissionStatus
    nextStatus: TelegramAdmissionStatus
    friendId?: string
    acknowledgementArtifactId?: string
    ownerCardArtifactId?: string
    ingress?: Pick<TelegramCommittedAdmissionIngress, "sessionKey" | "eventId" | "reference">
  }): TelegramAdmissionRecord {
    const current = this.read(input.admissionId)
    if (current.status !== input.expectedStatus) throw new Error(`Telegram admission CAS failed: expected ${input.expectedStatus}, found ${current.status}`)
    const now = this.now()
    const terminal = TERMINAL_STATUSES.has(input.nextStatus)
    const updated: TelegramAdmissionRecord = {
      ...current,
      status: input.nextStatus,
      revision: current.revision + 1,
      updatedAt: now,
      ...(input.friendId ? { friendId: input.friendId } : {}),
      ...(input.acknowledgementArtifactId ? { acknowledgementArtifactId: input.acknowledgementArtifactId } : {}),
      ...(input.ownerCardArtifactId ? { ownerCardArtifactId: input.ownerCardArtifactId } : {}),
      ...(input.ingress ? { ingressSessionKey: input.ingress.sessionKey, ingressEventId: input.ingress.eventId, ingressReference: input.ingress.reference } : {}),
      ...(terminal || input.ingress ? { quarantinedText: null } : {}),
    }
    this.write(updated)
    return updated
  }

  recordEffect(admissionIdValue: string, kind: "acknowledgement" | "owner_card", artifactId: string, messageId?: number): TelegramAdmissionRecord {
    const current = this.read(admissionIdValue)
    if (current.status !== "pending") return current
    if (kind === "owner_card" && (!Number.isSafeInteger(messageId) || (messageId as number) < 1)) throw new Error("Telegram admission owner card message id is invalid")
    const ownerCardMessageId = messageId as number
    const updated: TelegramAdmissionRecord = {
      ...current,
      revision: current.revision + 1,
      updatedAt: this.now(),
      ...(kind === "acknowledgement" ? { acknowledgementArtifactId: artifactId } : { ownerCardArtifactId: artifactId, ownerCardMessageId }),
    }
    this.write(updated)
    return updated
  }
}

export interface TelegramAdmissionControllerOptions {
  store: FileTelegramAdmissionStore
  owner: { friendId: string; sessionKey: string; chatId: string }
  sendEffect(request: TelegramAdmissionEffectRequest): Promise<string>
  resolveEffectMessageId(artifactId: string): number | null
  claimFriend(input: TelegramAdmissionFriendClaim): Promise<TelegramAdmissionFriendClaimResult>
  revokeFriend(input: TelegramAdmissionFriendRevocation): Promise<TelegramAdmissionFriendRevocationResult>
  commitApprovedIngress(input: TelegramApprovedTurn): Promise<TelegramCommittedAdmissionIngress>
  enqueueApprovedWork(input: TelegramCommittedAdmissionIngress): Promise<void>
  dispatchApprovedWork(input: TelegramCommittedAdmissionIngress): Promise<"settled" | "indeterminate">
  withDecisionLease?<T>(admissionId: string, work: () => Promise<T>): Promise<T>
  now?: () => number
  createDisplayCode?: () => string
}

export interface TelegramAdmissionDecision {
  admissionId: string
  decision: "allow" | "deny" | "block"
  actorFriendId: string
}

function ownerCard(record: TelegramAdmissionRecord): string {
  return [
    "Unknown Telegram contact",
    `Unverified Telegram label: ${escapeTelegramHtml(record.displayLabel).replaceAll("'", "&#39;")}`,
    `Verification code: ${escapeTelegramHtml(record.displayCode)}`,
    "The message is quarantined and has not been processed.",
    record.hasAttachments ? "Attachments were not downloaded and must be resent after approval." : null,
  ].filter((line): line is string => line !== null).join("\n")
}

export function createTelegramAdmissionController(options: TelegramAdmissionControllerOptions) {
  const now = options.now ?? Date.now
  const createDisplayCode = options.createDisplayCode ?? (() => crypto.randomBytes(4).toString("hex").toUpperCase())
  const withDecisionLease = options.withDecisionLease ?? (async <T>(_admissionId: string, work: () => Promise<T>): Promise<T> => work())

  const ensureEffects = async (initial: TelegramAdmissionRecord): Promise<TelegramAdmissionRecord> => {
    let record = options.store.read(initial.id)
    if (!record.acknowledgementArtifactId) {
      const artifactIdValue = await options.sendEffect({
        idempotencyKey: `ack:${record.id}`,
        target: { kind: "admission_gate", admissionId: record.id, botId: record.botId, userId: record.userId, chatId: record.chatId },
        authorClass: "control",
        effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT },
      })
      record = options.store.recordEffect(record.id, "acknowledgement", artifactIdValue)
    }
    if (!record.ownerCardArtifactId) {
      const artifactIdValue = await options.sendEffect({
        idempotencyKey: `owner-card:${record.id}`,
        target: { kind: "approved_relationship", ...options.owner, requestId: record.id },
        authorClass: "control",
        effect: { kind: "card", text: ownerCard(record), buttons: [[
          { text: "Allow", callbackData: `admit:${record.id}:allow` },
          { text: "Deny", callbackData: `admit:${record.id}:deny` },
          { text: "Block", callbackData: `admit:${record.id}:block` },
        ]] },
      })
      const messageId = options.resolveEffectMessageId(artifactIdValue)
      if (!messageId) throw new Error("Telegram admission owner card message id is unavailable")
      record = options.store.recordEffect(record.id, "owner_card", artifactIdValue, messageId)
    }
    return record
  }

  const compensateFriend = async (record: TelegramAdmissionRecord): Promise<void> => {
    if (!record.friendId) return
    const revocation = await options.revokeFriend({
      provider: "telegram-user",
      botId: record.botId,
      userId: record.userId,
      chatId: record.chatId,
      admissionId: record.id,
      friendId: record.friendId,
    })
    if (revocation.kind === "collision") throw new Error(`Telegram admission compensation collision: ${revocation.reason}`)
  }

  const resume = async (admissionIdValue: string): Promise<TelegramAdmissionRecord> => {
    let record = options.store.read(admissionIdValue)
    if (record.status === "approved") {
      const claim = await options.claimFriend({
        provider: "telegram-user",
        botId: record.botId,
        userId: record.userId,
        chatId: record.chatId,
        admissionId: record.id,
        displayLabel: record.displayLabel,
        defaults: {
          trustLevel: "friend",
          admissionState: "active",
          initiativePolicy: "request_follow_up_only",
          capabilityProfileId: "sanctuary-household",
        },
      })
      if (claim.kind === "collision") {
        options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "approved", nextStatus: "collision" })
        emitNervesEvent({ level: "error", component: "senses", event: "senses.telegram_admission_collision", message: "Telegram admission Friend claim collided", meta: { admissionId: record.id } })
        throw new Error(`Telegram admission collision: ${claim.reason}`)
      }
      record = options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "approved", nextStatus: "friend_bound", friendId: claim.friendId })
    }
    try {
      if (record.status === "friend_bound") {
        if (record.quarantinedText === null || !record.friendId) throw new Error("Telegram admission lost input before durable ingress")
        const committed = await options.commitApprovedIngress({
          admissionId: record.id,
          idempotencyKey: `admission-turn:${record.id}`,
          friendId: record.friendId,
          botId: record.botId,
          userId: record.userId,
          chatId: record.chatId,
          updateId: record.updateId,
          messageId: record.messageId,
          text: record.quarantinedText,
          hasAttachments: record.hasAttachments,
          synthetic: false,
        })
        if (committed.admissionId !== record.id || committed.friendId !== record.friendId || committed.reference !== `telegram-admission:${record.id}`) {
          throw new Error("Telegram admission committed ingress changed identity")
        }
        await options.enqueueApprovedWork(committed)
        record = options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "friend_bound", nextStatus: "ingress_committed", ingress: committed })
      }
      if (record.status === "ingress_committed") {
        record = options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "ingress_committed", nextStatus: "turn_queued" })
      }
      if (record.status === "turn_queued") {
        if (!record.friendId || !record.ingressSessionKey || !record.ingressEventId || !record.ingressReference) throw new Error("Telegram admission queued work lost its durable reference")
        const settlement = await options.dispatchApprovedWork({ admissionId: record.id, friendId: record.friendId, sessionKey: record.ingressSessionKey, eventId: record.ingressEventId, reference: record.ingressReference })
        if (settlement === "indeterminate") {
          await compensateFriend(record)
          return options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "turn_queued", nextStatus: "indeterminate" })
        }
        record = options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "turn_queued", nextStatus: "handled" })
        emitNervesEvent({ component: "senses", event: "senses.telegram_admission_handled", message: "Telegram admission dispatched one approved user turn", meta: { admissionId: record.id, friendId: record.friendId } })
      }
    } catch (error) {
      const failed = options.store.read(record.id)
      if (failed.friendId && !TERMINAL_STATUSES.has(failed.status)) {
        await compensateFriend(failed)
        options.store.compareAndSwap({ admissionId: failed.id, expectedStatus: failed.status, nextStatus: "indeterminate" })
      }
      throw error
    }
    return record
  }

  const reconcileExpired = async (): Promise<void> => {
    for (const candidate of options.store.list()) {
      await withDecisionLease(candidate.id, async () => {
        const record = options.store.read(candidate.id)
        if (ACTIVE_STATUSES.has(record.status) && now() >= record.expiresAt) {
          await compensateFriend(record)
          options.store.compareAndSwap({ admissionId: record.id, expectedStatus: record.status, nextStatus: "expired" })
          emitNervesEvent({ component: "senses", event: "senses.telegram_admission_expired", message: "Telegram admission expired and raw content was purged", meta: { admissionId: record.id } })
        }
      })
    }
  }

  return {
    async handleUnknown(input: TelegramUnknownContactMessage): Promise<{ kind: "pending"; admissionId: string } | { kind: "blocked" | "overflow" }> {
      const captured = options.store.capture(input, createDisplayCode())
      if (!("record" in captured)) return { kind: captured.kind }
      const record = await ensureEffects(captured.record)
      return { kind: "pending", admissionId: record.id }
    },
    parseCallback(value: string, messageId: number): { admissionId: string; decision: "allow" | "deny" | "block" } {
      const match = /^admit:([a-f0-9]{20}):(allow|deny|block)$/u.exec(value)
      if (!match) throw new Error("Telegram admission callback is invalid")
      const record = options.store.read(match[1]!)
      if (record.ownerCardMessageId !== messageId) throw new Error("Telegram admission callback is not bound to its owner card")
      return { admissionId: match[1]!, decision: match[2] as "allow" | "deny" | "block" }
    },
    parseOwnerDecision(input: { text: string; replyToMessageId?: number }): { admissionId: string; decision: "allow" | "deny" | "block" } | null {
      if (!input.replyToMessageId || Buffer.byteLength(input.text, "utf8") > 80) return null
      const normalized = input.text.normalize("NFKC").trim().toLocaleLowerCase("en-US")
      const decision = /^(?:yes|allow|approve|let (?:them|him|her) in)$/u.test(normalized) ? "allow"
        : /^(?:no|deny|decline)$/u.test(normalized) ? "deny"
          : /^(?:block|block (?:them|him|her))$/u.test(normalized) ? "block"
            : null
      if (!decision) return null
      const matches = options.store.list().filter((record) => record.ownerCardMessageId === input.replyToMessageId
        && (record.status === "pending" || (record.status === "handled" && decision === "block")))
      if (matches.length === 0) return null
      if (matches.length !== 1) throw new Error("Telegram admission owner card message id is ambiguous")
      return { admissionId: matches[0]!.id, decision }
    },
    async decide(input: TelegramAdmissionDecision): Promise<TelegramAdmissionRecord> {
      return withDecisionLease(input.admissionId, async () => {
        if (input.actorFriendId !== options.owner.friendId) throw new Error("Only the Telegram admission owner may decide")
        let record = options.store.read(input.admissionId)
        if (record.status === "handled" && input.decision === "allow") return record
        if (record.status === "handled" && input.decision === "block") {
          if (!record.friendId) throw new Error("Telegram admission revocation unavailable")
          const revocation = await options.revokeFriend({
            provider: "telegram-user",
            botId: record.botId,
            userId: record.userId,
            chatId: record.chatId,
            admissionId: record.id,
            friendId: record.friendId,
          })
          if (revocation.kind === "collision") throw new Error(`Telegram admission revocation collision: ${revocation.reason}`)
          return options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "handled", nextStatus: "blocked" })
        }
        if (TERMINAL_STATUSES.has(record.status)) throw new Error("Telegram admission is terminal")
        if (record.status !== "pending") return resume(record.id)
        if (now() >= record.expiresAt) {
          options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "pending", nextStatus: "expired" })
          throw new Error("Telegram admission is terminal")
        }
        if (input.decision === "deny" || input.decision === "block") {
          return options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "pending", nextStatus: input.decision === "deny" ? "denied" : "blocked" })
        }
        record = options.store.compareAndSwap({ admissionId: record.id, expectedStatus: "pending", nextStatus: "approved" })
        return resume(record.id)
      })
    },
    async reconcileExpired(): Promise<void> { await reconcileExpired() },
    async recover(): Promise<void> {
      await reconcileExpired()
      for (const record of options.store.list()) {
        if (record.status === "pending") await ensureEffects(record)
        else if (["approved", "friend_bound", "ingress_committed", "turn_queued"].includes(record.status)) {
          await withDecisionLease(record.id, () => resume(record.id))
        }
      }
    },
  }
}
