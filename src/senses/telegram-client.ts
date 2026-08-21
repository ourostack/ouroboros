import { emitNervesEvent } from "../nerves/runtime"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"

type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface TelegramEnvelope<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export class TelegramApiError extends Error {
  readonly status: number | null
  readonly errorCode: number | null
  readonly retryAfterSeconds: number | null

  constructor(message: string, options: {
    status?: number | null
    errorCode?: number | null
    retryAfterSeconds?: number | null
    cause?: unknown
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "TelegramApiError"
    this.status = options.status ?? null
    this.errorCode = options.errorCode ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

export interface TelegramBotApi {
  request<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T>
  stop(): void
}

export interface TelegramBotApiOptions {
  token: string
  fetch?: TelegramFetch
  apiRoot?: string
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export interface TelegramOffsetStore {
  load(): number
  save(nextUpdateId: number): void
}

function durableAtomicWrite(path: string, contents: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporaryPath, contents, { mode: 0o600 })
  const temporary = openSync(temporaryPath, "r")
  try { fsyncSync(temporary) } finally { closeSync(temporary) }
  renameSync(temporaryPath, path)
  const directoryHandle = openSync(directory, "r")
  try { fsyncSync(directoryHandle) } finally { closeSync(directoryHandle) }
}

export class FileTelegramOffsetStore implements TelegramOffsetStore {
  constructor(private readonly path: string) {}

  load(): number {
    let raw: string
    try {
      raw = readFileSync(this.path, "utf8")
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0
      throw error
    }
    try {
      const value = JSON.parse(raw) as { nextUpdateId?: unknown }
      if (!Number.isSafeInteger(value.nextUpdateId) || (value.nextUpdateId as number) < 0) throw new Error("invalid offset")
      return value.nextUpdateId as number
    } catch (cause) {
      throw new Error("Telegram offset state is corrupt", { cause })
    }
  }

  save(nextUpdateId: number): void {
    if (!Number.isSafeInteger(nextUpdateId) || nextUpdateId < 0) throw new Error("Telegram offset must be a non-negative safe integer")
    durableAtomicWrite(this.path, `${JSON.stringify({ nextUpdateId })}\n`)
  }
}

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number }
    chat: { id: number; type: string }
    text?: string
  }
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

export interface TelegramInboundMessage {
  updateId: number
  messageId: string
  userId: string
  chatId: string
  text: string
}

export interface TelegramUpdateInboxStore {
  load(): TelegramUpdateReceipt[]
  loadPending(): TelegramUpdateReceipt[]
  loadIndeterminate(): TelegramUpdateReceipt[]
  quarantineStranded(): TelegramUpdateReceipt[]
  acknowledgeIndeterminateWarning(receipt: TelegramUpdateReceipt): boolean
  capture(update: TelegramUpdate): boolean
  claim(update: TelegramUpdate): boolean
  complete(update: TelegramUpdate): void
}

export interface TelegramUpdateReceipt {
  digest: string
  sequenceDigest: string
  updateClass: "callback" | "message" | "other"
}

interface TelegramIndeterminateUpdateReceipt extends TelegramUpdateReceipt {
  quarantinedAt: number
  warningAcknowledged: boolean
}

interface TelegramUpdateInboxState {
  version: 3
  pending: TelegramUpdateReceipt[]
  dispatching: TelegramUpdateReceipt[]
  indeterminate: TelegramIndeterminateUpdateReceipt[]
}

export interface FileTelegramUpdateInboxStoreOptions {
  now?: () => number
  indeterminateRetentionMs?: number
  maxIndeterminateReceipts?: number
}

const DEFAULT_TELEGRAM_INDETERMINATE_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_TELEGRAM_MAX_INDETERMINATE_RECEIPTS = 1_000

const TELEGRAM_UPDATE_DIGEST_DOMAIN = "ouroboros.telegram.update.v1"
const TELEGRAM_UPDATE_SEQUENCE_DOMAIN = "ouroboros.telegram.update-sequence.v1"
const TELEGRAM_UPDATE_DIGEST = /^tgu_[A-Za-z0-9_-]{43}$/u
const TELEGRAM_UPDATE_SEQUENCE_DIGEST = /^tgs_[A-Za-z0-9_-]{43}$/u

function updateReceipt(update: TelegramUpdate): TelegramUpdateReceipt {
  return {
    digest: `tgu_${createHash("sha256").update(`${TELEGRAM_UPDATE_DIGEST_DOMAIN}\0${JSON.stringify(update)}`, "utf8").digest("base64url")}`,
    sequenceDigest: `tgs_${createHash("sha256").update(`${TELEGRAM_UPDATE_SEQUENCE_DOMAIN}\0${update.update_id}`, "utf8").digest("base64url")}`,
    updateClass: update.callback_query ? "callback" : update.message ? "message" : "other",
  }
}

function sameReceipt(left: TelegramUpdateReceipt, right: TelegramUpdateReceipt): boolean {
  return left.digest === right.digest
}

function uniqueReceipts(records: readonly TelegramUpdateReceipt[]): TelegramUpdateReceipt[] {
  return records.filter((record, index) => records.findIndex((candidate) => sameReceipt(candidate, record)) === index)
}

export class FileTelegramUpdateInboxStore implements TelegramUpdateInboxStore {
  private readonly now: () => number
  private readonly indeterminateRetentionMs: number
  private readonly maxIndeterminateReceipts: number

  constructor(private readonly path: string, options: FileTelegramUpdateInboxStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.indeterminateRetentionMs = options.indeterminateRetentionMs ?? DEFAULT_TELEGRAM_INDETERMINATE_RETENTION_MS
    this.maxIndeterminateReceipts = options.maxIndeterminateReceipts ?? DEFAULT_TELEGRAM_MAX_INDETERMINATE_RECEIPTS
    if (!Number.isSafeInteger(this.indeterminateRetentionMs) || this.indeterminateRetentionMs < 1) {
      throw new Error("Telegram indeterminate receipt retention must be a positive safe integer")
    }
    if (!Number.isSafeInteger(this.maxIndeterminateReceipts) || this.maxIndeterminateReceipts < 1) {
      throw new Error("Telegram indeterminate receipt limit must be a positive safe integer")
    }
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Telegram inbox clock must return a non-negative safe integer")
    return value
  }

  private prune(records: readonly TelegramIndeterminateUpdateReceipt[], timestamp: number): TelegramIndeterminateUpdateReceipt[] {
    const cutoff = timestamp - this.indeterminateRetentionMs
    return [...records]
      .filter((record) => record.quarantinedAt >= cutoff)
      .sort((left, right) => left.quarantinedAt - right.quarantinedAt || left.digest.localeCompare(right.digest))
      .slice(-this.maxIndeterminateReceipts)
  }

  private read(): TelegramUpdateInboxState {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>
      const validReceipt = (record: unknown): record is TelegramUpdateReceipt => Boolean(record)
        && typeof record === "object"
        && !Array.isArray(record)
        && Object.keys(record as object).sort().join(",") === "digest,sequenceDigest,updateClass"
        && TELEGRAM_UPDATE_DIGEST.test((record as TelegramUpdateReceipt).digest)
        && TELEGRAM_UPDATE_SEQUENCE_DIGEST.test((record as TelegramUpdateReceipt).sequenceDigest)
        && ["callback", "message", "other"].includes((record as TelegramUpdateReceipt).updateClass)
      const validIndeterminate = (record: unknown): record is TelegramIndeterminateUpdateReceipt => Boolean(record)
        && typeof record === "object"
        && !Array.isArray(record)
        && Object.keys(record as object).sort().join(",") === "digest,quarantinedAt,sequenceDigest,updateClass,warningAcknowledged"
        && TELEGRAM_UPDATE_DIGEST.test((record as TelegramIndeterminateUpdateReceipt).digest)
        && TELEGRAM_UPDATE_SEQUENCE_DIGEST.test((record as TelegramIndeterminateUpdateReceipt).sequenceDigest)
        && ["callback", "message", "other"].includes((record as TelegramIndeterminateUpdateReceipt).updateClass)
        && Number.isSafeInteger((record as TelegramIndeterminateUpdateReceipt).quarantinedAt)
        && (record as TelegramIndeterminateUpdateReceipt).quarantinedAt >= 0
        && typeof (record as TelegramIndeterminateUpdateReceipt).warningAcknowledged === "boolean"
      if (value.version === 3) {
        if (Object.keys(value).sort().join(",") !== "dispatching,indeterminate,pending,version"
          || !Array.isArray(value.pending) || !Array.isArray(value.dispatching) || !Array.isArray(value.indeterminate)
          || !value.pending.every(validReceipt) || !value.dispatching.every(validReceipt)
          || !value.indeterminate.every(validIndeterminate)) throw new Error("invalid bounded inbox shape")
        const state = structuredClone(value) as unknown as TelegramUpdateInboxState
        const pruned = this.prune(state.indeterminate, this.timestamp())
        if (pruned.length !== state.indeterminate.length) {
          state.indeterminate = pruned
          this.write(state)
        }
        return state
      }
      if (value.version === 2) {
        if (Object.keys(value).sort().join(",") !== "dispatching,indeterminate,pending,version") throw new Error("invalid opaque inbox shape")
        const arrays = [value.pending, value.dispatching, value.indeterminate]
        if (!arrays.every(Array.isArray)) throw new Error("invalid opaque inbox shape")
        if (!arrays.flat().every(validReceipt)) throw new Error("invalid opaque inbox receipt")
        const timestamp = this.timestamp()
        const migrated: TelegramUpdateInboxState = {
          version: 3,
          pending: structuredClone(value.pending) as TelegramUpdateReceipt[],
          dispatching: structuredClone(value.dispatching) as TelegramUpdateReceipt[],
          indeterminate: this.prune((value.indeterminate as TelegramUpdateReceipt[]).map((record) => ({
            ...record,
            quarantinedAt: timestamp,
            warningAcknowledged: false,
          })), timestamp),
        }
        this.write(migrated)
        return migrated
      }
      const pending = value.pending
      const dispatching = value.dispatching ?? []
      const completed = value.completedUpdateIds
      if (!Array.isArray(pending) || !Array.isArray(dispatching) || !Array.isArray(completed)) throw new Error("invalid legacy inbox shape")
      const validLegacy = (update: unknown): update is TelegramUpdate => Boolean(update)
        && typeof update === "object"
        && Number.isSafeInteger((update as TelegramUpdate).update_id)
        && (update as TelegramUpdate).update_id >= 0
      if (![...pending, ...dispatching].every(validLegacy)
        || !completed.every((id) => Number.isSafeInteger(id) && (id as number) >= 0)) throw new Error("invalid legacy inbox record")
      const timestamp = this.timestamp()
      const migrated: TelegramUpdateInboxState = {
        version: 3,
        pending: [],
        dispatching: [],
        indeterminate: this.prune(uniqueReceipts([...pending, ...dispatching].map(updateReceipt)).map((record) => ({
          ...record,
          quarantinedAt: timestamp,
          warningAcknowledged: false,
        })), timestamp),
      }
      this.write(migrated)
      return migrated
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { version: 3, pending: [], dispatching: [], indeterminate: [] }
      throw new Error("Telegram update inbox state is corrupt", { cause: error })
    }
  }

  private write(state: TelegramUpdateInboxState): void {
    durableAtomicWrite(this.path, `${JSON.stringify(state)}\n`)
  }

  load(): TelegramUpdateReceipt[] {
    const state = this.read()
    return [...state.pending, ...state.dispatching, ...state.indeterminate]
  }

  loadPending(): TelegramUpdateReceipt[] {
    return this.read().pending
  }

  loadIndeterminate(): TelegramUpdateReceipt[] {
    return this.read().indeterminate
  }

  quarantineStranded(): TelegramUpdateReceipt[] {
    const state = this.read()
    const stranded = uniqueReceipts([...state.pending, ...state.dispatching])
    const timestamp = this.timestamp()
    state.pending = []
    state.dispatching = []
    const combined = [...state.indeterminate, ...stranded.map((record) => ({
      ...record,
      quarantinedAt: timestamp,
      warningAcknowledged: false,
    }))]
    state.indeterminate = this.prune(combined.filter((record, index) => (
      combined.findIndex((candidate) => sameReceipt(candidate, record)) === index
    )), timestamp)
    const warnings = state.indeterminate.filter((record) => !record.warningAcknowledged)
    if (stranded.length > 0) this.write(state)
    return warnings.map(({ quarantinedAt: _quarantinedAt, warningAcknowledged: _warningAcknowledged, ...receipt }) => receipt)
  }

  acknowledgeIndeterminateWarning(receipt: TelegramUpdateReceipt): boolean {
    const state = this.read()
    const warning = state.indeterminate.find((candidate) => sameReceipt(candidate, receipt))
    if (!warning || warning.warningAcknowledged) return false
    warning.warningAcknowledged = true
    this.write(state)
    return true
  }

  capture(update: TelegramUpdate): boolean {
    const state = this.read()
    const receipt = updateReceipt(update)
    const existing = [...state.pending, ...state.dispatching, ...state.indeterminate]
      .find((candidate) => candidate.sequenceDigest === receipt.sequenceDigest)
    if (existing) {
      if (!sameReceipt(existing, receipt)) throw new Error("Telegram update inbox has a conflicting opaque receipt")
      return false
    }
    state.pending.push(receipt)
    this.write(state)
    return true
  }

  claim(update: TelegramUpdate): boolean {
    const state = this.read()
    const receipt = updateReceipt(update)
    if (state.dispatching.some((candidate) => sameReceipt(candidate, receipt))) return false
    const index = state.pending.findIndex((candidate) => sameReceipt(candidate, receipt))
    if (index < 0) return false
    state.pending.splice(index, 1)
    state.dispatching.push(receipt)
    this.write(state)
    return true
  }

  complete(update: TelegramUpdate): void {
    const state = this.read()
    const receipt = updateReceipt(update)
    state.pending = state.pending.filter((candidate) => !sameReceipt(candidate, receipt))
    state.dispatching = state.dispatching.filter((candidate) => !sameReceipt(candidate, receipt))
    this.write(state)
  }
}

export interface TelegramLongPoll {
  pollOnce(signal?: AbortSignal): Promise<number>
  run(signal?: AbortSignal): Promise<void>
  stop(): void
}

export interface TelegramLongPollOptions {
  api: TelegramBotApi
  expectedUserId: string
  expectedChatId: string
  offsetStore: TelegramOffsetStore
  inboxStore?: TelegramUpdateInboxStore
  onMessage: (message: TelegramInboundMessage) => Promise<void>
  onUpdate?: (update: TelegramUpdate) => Promise<boolean>
  acceptanceEventMeta?: () => Record<string, string>
}

export function createTelegramLongPoll(options: TelegramLongPollOptions): TelegramLongPoll {
  let nextUpdateId = options.offsetStore.load()
  const shutdown = new AbortController()

  const authorizedMessage = (update: TelegramUpdate): TelegramInboundMessage | null => {
    const message = update.message
    const userId = message?.from ? String(message.from.id) : ""
    const chatId = message ? String(message.chat.id) : ""
    if (!message || message.chat.type !== "private" || userId !== options.expectedUserId || chatId !== options.expectedChatId || typeof message.text !== "string") return null
    return { updateId: update.update_id, messageId: String(message.message_id), userId, chatId, text: message.text }
  }

  const authorizedCallback = (update: TelegramUpdate): boolean => {
    const callback = update.callback_query
    return Boolean(callback?.message
      && String(callback.from.id) === options.expectedUserId
      && String(callback.message.chat.id) === options.expectedChatId)
  }

  const dispatch = async (update: TelegramUpdate): Promise<void> => {
    const handled = await options.onUpdate?.(update) ?? false
    if (handled) return
    const message = authorizedMessage(update)
    if (message) {
      await options.onMessage(message)
      return
    }
    emitNervesEvent({
      component: "senses",
      event: "telegram.update_dropped",
      message: "Telegram update dropped before dispatch",
      meta: {
        updateClass: update.message ? "message" : "other",
        reason: "unauthorized_or_unsupported",
        distinctAccount: Boolean(update.message?.from && (String(update.message.from.id) !== options.expectedUserId || String(update.message.chat.id) !== options.expectedChatId)),
        ...options.acceptanceEventMeta?.(),
      },
    })
  }

  const pollOnce = async (signal?: AbortSignal): Promise<number> => {
    const requestSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
    if (requestSignal.aborted) throw new Error("Telegram long poll stopped")
    const stranded = options.inboxStore?.quarantineStranded?.() ?? options.inboxStore?.loadIndeterminate() ?? []
    for (const indeterminate of stranded) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "telegram.update_dropped",
        message: "Telegram update dispatch outcome is indeterminate after restart",
        meta: { updateClass: indeterminate.updateClass, reason: "dispatch_indeterminate", ...options.acceptanceEventMeta?.() },
      })
      options.inboxStore?.acknowledgeIndeterminateWarning(indeterminate)
    }
    const updates = await options.api.request<TelegramUpdate[]>("getUpdates", {
      offset: nextUpdateId,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    }, requestSignal)
    if (!Array.isArray(updates)) throw new Error("Telegram getUpdates result must be an array")
    for (const update of updates) {
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < nextUpdateId) continue
      const next = update.update_id + 1
      const requiresDurableDispatch = Boolean(authorizedCallback(update) || authorizedMessage(update))
      const newlyCaptured = requiresDurableDispatch ? (options.inboxStore?.capture(update) ?? true) : true
      options.offsetStore.save(next)
      nextUpdateId = next
      if (newlyCaptured) {
        if (requiresDurableDispatch && options.inboxStore && !options.inboxStore.claim(update)) continue
        try {
          await dispatch(update)
          if (requiresDurableDispatch) options.inboxStore?.complete(update)
        } catch (error) {
          options.inboxStore?.quarantineStranded?.()
          throw error
        }
      }
    }
    return nextUpdateId
  }

  return {
    pollOnce,
    async run(signal?: AbortSignal) {
      const runSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
      try {
        while (!runSignal.aborted) await pollOnce(runSignal)
      } catch (error) {
        if (!shutdown.signal.aborted && !signal?.aborted) throw error
      }
    },
    stop() {
      shutdown.abort(new Error("Telegram long poll stopped"))
    },
  }
}

export interface TelegramApprovalDecision {
  approvalId: string
  decisionToken: string
  decision: "approve" | "deny"
  requesterId: string
  transport: "telegram"
  transportChatId: string
  transportMessageId: string
  decisionAt: number
  acceptanceBinding?: TelegramPersistedPendingApproval["acceptanceBinding"]
}

export interface TelegramPersistedPendingApproval {
  approvalId: string
  messageId: string | null
  deliveryState?: "pending" | "send_attempting" | "bound" | "delivery_indeterminate" | "terminal_tombstone"
  approveCallbackData: string
  denyCallbackData: string
  expiresAt: number
  prompt?: string
  acceptanceBinding?: {
    scenarioHandleDigest: string
    actionDigest: string
    targetDigest: string
    checkpointDigest: string
    suspendedSessionRevisionDigest: string
    messageIdDigest: string
    boundAt: number
  }
  terminal?: { accepted: boolean; terminalText: string }
  terminalMac?: string | null
  terminalizedAt?: number
  tombstoneExpiresAt?: number
  tombstoneMac?: string
  expiryObservation?: {
    schemaVersion: "telegram-approval-expiry-observation-v1"
    deadlineAt: number
    observedAt: number
    evidenceMac: string | null
  }
  staleTap?: {
    schemaVersion: "telegram-approval-stale-tap-v1"
    state: "attempted" | "consumed"
    queryIdDigest: string
    attemptedAt: number
    consumedAt: number | null
    evidenceMac: string | null
  }
  decisionAttempt?: {
    schemaVersion: "telegram-approval-decision-attempt-v1"
    decision: "approve" | "deny"
    queryIdDigest: string
    attemptedAt: number
    evidenceMac: string
    recoveryMac?: string | null
  }
  settlementReceipt?: {
    schemaVersion: "telegram-approval-settlement-receipt-v1"
    kind: "live" | "recovery"
    callbackAt: number
    accepted: boolean
    reason: "accepted" | "decision_refused"
    acknowledgementState: "acknowledged" | "rejected_as_stale" | "indeterminate_after_restart"
    recoveredAt: number | null
    decisionAttemptDigest: string
    evidenceMac: string | null
  }
}

interface TelegramPendingApproval extends TelegramPersistedPendingApproval {
  deliveryState: "pending" | "send_attempting" | "bound" | "delivery_indeterminate" | "terminal_tombstone"
  decisionToken?: string
}

export interface TelegramPendingApprovalStore {
  load(): TelegramPersistedPendingApproval[]
  save(records: TelegramPersistedPendingApproval[]): void
}

export class FileTelegramPendingApprovalStore implements TelegramPendingApprovalStore {
  constructor(private readonly path: string) {}

  load(): TelegramPersistedPendingApproval[] {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as unknown
      if (!Array.isArray(value)) throw new Error("pending approvals must be an array")
      return structuredClone(value as TelegramPersistedPendingApproval[])
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
      throw new Error("Telegram pending approval state is corrupt", { cause: error })
    }
  }

  save(records: TelegramPersistedPendingApproval[]): void {
    durableAtomicWrite(this.path, `${JSON.stringify(records)}\n`)
  }
}

export interface TelegramApprovalTransport {
  sendApproval(input: { approvalId: string; decisionToken: string; prompt: string; acceptanceBinding?: { scenarioHandleDigest: string; actionDigest: string; targetDigest: string; checkpointDigest: string; suspendedSessionRevisionDigest: string } }): Promise<{
    messageId: string
    approveCallbackData: string
    denyCallbackData: string
    expiresAt: number
  }>
  handleUpdate(update: TelegramUpdate): Promise<{ handled: boolean; accepted: boolean; reason: string }>
  recoverDecisionAttempt(approvalId: string): Promise<boolean>
  reconcileExpired(): Promise<void>
  terminalizeOrphaned(approvalId: string, terminalText: string): Promise<{ terminalEditSucceeded: boolean }>
  terminalizeRecovered(approvalId: string, terminalText: string): Promise<void>
  listPendingDeliveries(): TelegramPersistedPendingApproval[]
}

export interface TelegramApprovalTransportOptions {
  api: TelegramBotApi
  expectedUserId: string
  expectedChatId: string
  pendingStore: TelegramPendingApprovalStore
  createOpaqueHandle: () => string
  onDecision: (decision: TelegramApprovalDecision) => Promise<{ accepted: boolean; terminalText: string }>
  onExpire?: (approvalId: string) => void | Promise<void>
  resolveDecisionToken?: (approvalId: string) => Promise<string>
  now?: () => number
  acceptanceEventMeta?: () => Record<string, string>
  signAcceptanceEvidence?: (event: string, meta: Record<string, unknown>) => string
  onAcceptanceEvidence?: (event: string, meta: Record<string, unknown>) => void
  commitAcceptanceEvidence?: (event: string, meta: Record<string, unknown>) => void | Promise<void>
  onSettlementComplete?: (approvalId: string) => void | Promise<void>
  acceptanceMessageIdDigest?: (messageId: string) => string
}

export const TELEGRAM_APPROVAL_TTL_MS = 300_000
export const TELEGRAM_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS = 30_000
export const TELEGRAM_APPROVAL_TOMBSTONE_TTL_MS = 600_000

function assertTelegramCallbackData(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes < 1 || bytes > 64) throw new Error("Telegram callback_data must be 1 to 64 bytes")
}

export function createTelegramApprovalTransport(options: TelegramApprovalTransportOptions): TelegramApprovalTransport {
  const now = options.now ?? Date.now
  const pendingByCallback = new Map<string, TelegramPendingApproval>()
  const approvalOperations = new Map<string, { done: Promise<void>; release(): void }>()

  const uniquePending = (): TelegramPendingApproval[] => [...new Set(pendingByCallback.values())]
  const persist = (): void => options.pendingStore.save(uniquePending().map(({ decisionToken: _secret, ...record }) => record))
  const persistMutation = (pending: TelegramPendingApproval, mutate: () => void): void => {
    const before = structuredClone(pending)
    try {
      mutate()
      persist()
    } catch (error) {
      for (const key of Object.keys(pending)) delete (pending as unknown as Record<string, unknown>)[key]
      Object.assign(pending, before)
      throw error
    }
  }
  const add = (pending: TelegramPendingApproval): void => {
    pendingByCallback.set(pending.approveCallbackData, pending)
    pendingByCallback.set(pending.denyCallbackData, pending)
  }
  const remove = (pending: TelegramPendingApproval): void => {
    pendingByCallback.delete(pending.approveCallbackData)
    pendingByCallback.delete(pending.denyCallbackData)
  }
  const persistRemoval = (pending: TelegramPendingApproval): void => {
    options.pendingStore.save(uniquePending().filter((record) => record !== pending).map(({ decisionToken: _secret, ...record }) => record))
    remove(pending)
  }
  const acceptanceEvidenceUnsigned = (pending: TelegramPendingApproval, fields: Record<string, unknown>): Record<string, unknown> => (
    { ...options.acceptanceEventMeta?.(), approvalId: pending.approvalId, ...pending.acceptanceBinding, ...fields }
  )
  const emitAcceptanceEvidence = (event: string, pending: TelegramPendingApproval, fields: Record<string, unknown>): void => {
    if (!pending.acceptanceBinding) return
    if (!options.signAcceptanceEvidence) throw new Error("Telegram acceptance evidence signer is unavailable")
    const unsigned = acceptanceEvidenceUnsigned(pending, fields)
    const meta = { ...unsigned, evidenceMac: options.signAcceptanceEvidence(event, unsigned) }
    emitNervesEvent({ component: "senses", event, message: "Telegram approval acceptance evidence recorded", meta })
    options.onAcceptanceEvidence?.(event, meta)
  }

  const withApprovalExclusive = async <T>(approvalId: string, wait: boolean, operation: () => Promise<T>): Promise<T | undefined> => {
    while (approvalOperations.has(approvalId)) {
      if (!wait) return undefined
      await approvalOperations.get(approvalId)!.done
    }
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    const claim = { done, release }
    approvalOperations.set(approvalId, claim)
    try { return await operation() } finally {
      if (approvalOperations.get(approvalId) === claim) approvalOperations.delete(approvalId)
      release()
    }
  }

  const expiryObservationFields = (pending: TelegramPendingApproval, observedAt: number): Record<string, unknown> => ({
    expiryObservationSchemaVersion: "telegram-approval-expiry-observation-v1",
    expiryDeadlineAt: pending.expiresAt,
    expiryObservedAt: observedAt,
  })

  const terminalTombstoneFields = (pending: TelegramPendingApproval): Record<string, unknown> => ({
    ...expiryObservationFields(pending, pending.expiryObservation!.observedAt),
    terminalizedAt: pending.terminalizedAt,
    tombstoneExpiresAt: pending.tombstoneExpiresAt,
  })

  const staleTapFields = (pending: TelegramPendingApproval, staleTap: NonNullable<TelegramPersistedPendingApproval["staleTap"]>): Record<string, unknown> => ({
    ...terminalTombstoneFields(pending),
    staleTapSchemaVersion: staleTap.schemaVersion,
    staleTapState: staleTap.state,
    queryIdDigest: staleTap.queryIdDigest,
    attemptedAt: staleTap.attemptedAt,
    consumedAt: staleTap.consumedAt,
  })

  const signState = (event: string, pending: TelegramPendingApproval, fields: Record<string, unknown>): string | null => {
    const evidenceMac = options.signAcceptanceEvidence?.(event, acceptanceEvidenceUnsigned(pending, fields)) ?? null
    return evidenceMac
  }

  const decisionAttemptPayload = (
    pending: TelegramPendingApproval,
    attempt: Omit<NonNullable<TelegramPersistedPendingApproval["decisionAttempt"]>, "evidenceMac" | "recoveryMac">,
  ): Record<string, unknown> => ({
    approvalId: pending.approvalId,
    messageId: pending.messageId,
    expiresAt: pending.expiresAt,
    approveCallbackData: pending.approveCallbackData,
    denyCallbackData: pending.denyCallbackData,
    acceptanceBinding: pending.acceptanceBinding,
    schemaVersion: attempt.schemaVersion,
    decision: attempt.decision,
    queryIdDigest: attempt.queryIdDigest,
    attemptedAt: attempt.attemptedAt,
  })

  const decisionAttemptMac = (
    decisionToken: string,
    pending: TelegramPendingApproval,
    attempt: Omit<NonNullable<TelegramPersistedPendingApproval["decisionAttempt"]>, "evidenceMac" | "recoveryMac">,
  ): string => createHmac("sha256", decisionToken).update(JSON.stringify(decisionAttemptPayload(pending, attempt))).digest("hex")

  const resolveDecisionToken = async (pending: TelegramPendingApproval): Promise<string> => {
    const decisionToken = pending.decisionToken ?? await options.resolveDecisionToken?.(pending.approvalId)
    if (!decisionToken) throw new Error("Telegram approval restart requires a decision token resolver")
    return decisionToken
  }

  const validateDecisionAttempt = async (
    pending: TelegramPendingApproval,
    expected?: { decision: "approve" | "deny"; queryIdDigest: string },
  ): Promise<NonNullable<TelegramPersistedPendingApproval["decisionAttempt"]>> => {
    const attempt = pending.decisionAttempt
    if (!attempt) throw new Error("Telegram persisted decision attempt is invalid")
    const lowerBound = pending.acceptanceBinding?.boundAt ?? pending.expiresAt - TELEGRAM_APPROVAL_TTL_MS
    const unsigned = { schemaVersion: attempt.schemaVersion, decision: attempt.decision, queryIdDigest: attempt.queryIdDigest, attemptedAt: attempt.attemptedAt }
    const token = pending.decisionToken ?? await options.resolveDecisionToken?.(pending.approvalId)
    const expectedMac = token ? decisionAttemptMac(token, pending, unsigned) : null
    const suppliedMac = typeof attempt.evidenceMac === "string" ? Buffer.from(attempt.evidenceMac, "hex") : Buffer.alloc(0)
    const calculatedMac = expectedMac ? Buffer.from(expectedMac, "hex") : Buffer.alloc(0)
    const tokenMacValid = calculatedMac.length > 0 && suppliedMac.length === calculatedMac.length && timingSafeEqual(suppliedMac, calculatedMac)
    const recoveryMacValid = typeof attempt.recoveryMac === "string"
      && options.signAcceptanceEvidence !== undefined
      && attempt.recoveryMac === options.signAcceptanceEvidence(
        "telegram.approval_decision_attempt_recovery_state",
        acceptanceEvidenceUnsigned(pending, decisionAttemptPayload(pending, unsigned)),
      )
    if (attempt.schemaVersion !== "telegram-approval-decision-attempt-v1"
      || !["approve", "deny"].includes(attempt.decision)
      || !/^[0-9a-f]{64}$/u.test(attempt.queryIdDigest)
      || !Number.isSafeInteger(attempt.attemptedAt) || attempt.attemptedAt < lowerBound || attempt.attemptedAt >= pending.expiresAt
      || (!tokenMacValid && !recoveryMacValid)
      || (expected !== undefined && (attempt.decision !== expected.decision || attempt.queryIdDigest !== expected.queryIdDigest))) {
      throw new Error("Telegram persisted decision attempt is invalid")
    }
    return attempt
  }

  const settlementReceiptFields = (
    receipt: NonNullable<TelegramPersistedPendingApproval["settlementReceipt"]>,
  ): Record<string, unknown> => ({
    settlementReceiptSchemaVersion: receipt.schemaVersion,
    settlementKind: receipt.kind,
    callbackAt: receipt.callbackAt,
    accepted: receipt.accepted,
    reason: receipt.reason,
    acknowledgementState: receipt.acknowledgementState,
    recoveredAt: receipt.recoveredAt,
    decisionAttemptDigest: receipt.decisionAttemptDigest,
  })

  const terminalOutcomeFields = (pending: TelegramPendingApproval): Record<string, unknown> => ({
    accepted: pending.terminal?.accepted,
    terminalText: pending.terminal?.terminalText,
    decisionAttemptDigest: pending.decisionAttempt ? createHash("sha256").update(JSON.stringify(pending.decisionAttempt)).digest("hex") : null,
  })

  const validateTerminalOutcome = (pending: TelegramPendingApproval): void => {
    if (!pending.terminal || typeof pending.terminal.accepted !== "boolean" || typeof pending.terminal.terminalText !== "string"
      || pending.terminal.terminalText.length === 0 || pending.terminal.terminalText.length > 4_096
      || pending.terminalMac !== signState("telegram.approval_terminal_outcome_state", pending, terminalOutcomeFields(pending))) {
      throw new Error("Telegram persisted terminal outcome is invalid")
    }
  }

  const validateSettlementReceipt = (pending: TelegramPendingApproval): NonNullable<TelegramPersistedPendingApproval["settlementReceipt"]> => {
    const receipt = pending.settlementReceipt
    validateTerminalOutcome(pending)
    const decisionAttemptDigest = pending.decisionAttempt
      ? createHash("sha256").update(JSON.stringify(pending.decisionAttempt)).digest("hex")
      : null
    if (!receipt || !pending.terminal || !pending.decisionAttempt || receipt.schemaVersion !== "telegram-approval-settlement-receipt-v1"
      || !["live", "recovery"].includes(receipt.kind)
      || !Number.isSafeInteger(receipt.callbackAt)
      || typeof receipt.accepted !== "boolean"
      || receipt.reason !== (receipt.accepted ? "accepted" : "decision_refused")
      || (receipt.kind === "live" ? !["acknowledged", "rejected_as_stale"].includes(receipt.acknowledgementState) : receipt.acknowledgementState !== "indeterminate_after_restart")
      || (receipt.kind === "live" ? receipt.recoveredAt !== null : !Number.isSafeInteger(receipt.recoveredAt))
      || receipt.callbackAt !== pending.decisionAttempt.attemptedAt
      || !/^[0-9a-f]{64}$/u.test(receipt.decisionAttemptDigest) || receipt.decisionAttemptDigest !== decisionAttemptDigest
      || receipt.evidenceMac !== signState("telegram.approval_settlement_receipt_state", pending, settlementReceiptFields(receipt))) {
      throw new Error("Telegram persisted settlement receipt is invalid")
    }
    return receipt
  }

  const emitSettlementReceipt = async (pending: TelegramPendingApproval): Promise<void> => {
    const receipt = validateSettlementReceipt(pending)
    const fields = receipt.kind === "live"
      ? { callbackAt: receipt.callbackAt, acknowledged: receipt.acknowledgementState === "acknowledged", acknowledgementState: receipt.acknowledgementState, accepted: receipt.accepted, reason: receipt.reason, decisionAttemptDigest: receipt.decisionAttemptDigest }
      : { callbackAt: receipt.callbackAt, acknowledgementState: receipt.acknowledgementState, accepted: receipt.accepted, reason: receipt.reason, recoveredAt: receipt.recoveredAt!, decisionAttemptDigest: receipt.decisionAttemptDigest }
    const event = receipt.kind === "live" ? "telegram.callback_settled" : "telegram.callback_recovery_settled"
    if (options.signAcceptanceEvidence) {
      const unsigned = acceptanceEvidenceUnsigned(pending, fields)
      const meta = { ...unsigned, evidenceMac: options.signAcceptanceEvidence(event, unsigned) }
      if (options.commitAcceptanceEvidence) await options.commitAcceptanceEvidence(event, meta)
      else emitNervesEvent({ component: "senses", event, message: "Telegram approval acceptance evidence recorded", meta })
      options.onAcceptanceEvidence?.(event, meta)
    } else emitNervesEvent({ component: "senses", event, message: "Telegram approval callback settled", meta: { approvalId: pending.approvalId, ...fields, ...options.acceptanceEventMeta?.() } })
  }

  const validateExpiryObservation = (pending: TelegramPendingApproval): NonNullable<TelegramPersistedPendingApproval["expiryObservation"]> => {
    const observation = pending.expiryObservation
    if (!observation) throw new Error("Telegram persisted expiry observation is invalid")
    const fields = expiryObservationFields(pending, observation.observedAt)
    const expectedMac = pending.acceptanceBinding
      ? options.signAcceptanceEvidence?.("telegram.approval_expiry_observed", acceptanceEvidenceUnsigned(pending, fields)) ?? null
      : null
    if (observation.schemaVersion !== "telegram-approval-expiry-observation-v1" || observation.deadlineAt !== pending.expiresAt
      || !Number.isSafeInteger(observation.observedAt) || observation.observedAt < observation.deadlineAt
      || observation.evidenceMac !== expectedMac) throw new Error("Telegram persisted expiry observation is invalid")
    return observation
  }

  const ensureExpiryObservation = (pending: TelegramPendingApproval, observedAt = now()): NonNullable<TelegramPersistedPendingApproval["expiryObservation"]> => {
    let observation = pending.expiryObservation
    if (!observation) {
      const fields = expiryObservationFields(pending, observedAt)
      const evidenceMac = pending.acceptanceBinding
        ? options.signAcceptanceEvidence?.("telegram.approval_expiry_observed", acceptanceEvidenceUnsigned(pending, fields)) ?? null
        : null
      if (pending.acceptanceBinding && evidenceMac === null) throw new Error("Telegram acceptance evidence signer is unavailable")
      observation = { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: pending.expiresAt, observedAt, evidenceMac }
      persistMutation(pending, () => { pending.expiryObservation = observation })
    }
    observation = validateExpiryObservation(pending)
    const fields = expiryObservationFields(pending, observation.observedAt)
    emitAcceptanceEvidence("telegram.approval_expiry_observed", pending, fields)
    return observation
  }

  const validateStaleTap = (pending: TelegramPendingApproval): void => {
    if (!pending.staleTap) return
    if (pending.staleTap.schemaVersion !== "telegram-approval-stale-tap-v1"
      || !["attempted", "consumed"].includes(pending.staleTap.state)
      || !/^[0-9a-f]{64}$/u.test(pending.staleTap.queryIdDigest)
      || !Number.isSafeInteger(pending.staleTap.attemptedAt)
      || (pending.staleTap.state === "attempted" && pending.staleTap.consumedAt !== null)
      || (pending.staleTap.state === "consumed" && (!Number.isSafeInteger(pending.staleTap.consumedAt)
        || Number(pending.staleTap.consumedAt) < pending.staleTap.attemptedAt))
      || pending.staleTap.evidenceMac !== signState("telegram.approval_stale_tap_state", pending, staleTapFields(pending, pending.staleTap))) {
      throw new Error("Telegram persisted stale-tap record is invalid")
    }
  }

  const validateTerminalTombstone = (pending: TelegramPendingApproval): void => {
    try {
      if (pending.deliveryState !== "terminal_tombstone" || !pending.acceptanceBinding || pending.messageId === null
        || pending.decisionToken !== undefined || !Number.isSafeInteger(pending.terminalizedAt)
        || !Number.isSafeInteger(pending.tombstoneExpiresAt)
        || pending.tombstoneExpiresAt !== Number(pending.terminalizedAt) + TELEGRAM_APPROVAL_TOMBSTONE_TTL_MS) {
        throw new Error("shape")
      }
      const observation = validateExpiryObservation(pending)
      if (Number(pending.terminalizedAt) < observation.observedAt
        || pending.tombstoneMac !== signState("telegram.approval_terminal_tombstone_state", pending, terminalTombstoneFields(pending))) throw new Error("order")
      validateStaleTap(pending)
    } catch {
      throw new Error("Telegram persisted terminal tombstone is invalid")
    }
  }

  for (const loaded of options.pendingStore.load()) {
    const pending: TelegramPendingApproval = {
      ...loaded,
      deliveryState: loaded.deliveryState ?? "bound",
    }
    assertTelegramCallbackData(pending.approveCallbackData)
    assertTelegramCallbackData(pending.denyCallbackData)
    if (pendingByCallback.has(pending.approveCallbackData) || pendingByCallback.has(pending.denyCallbackData)) {
      throw new Error("Telegram persisted approval callback handle collision")
    }
    add(pending)
  }

  const editTerminal = async (pending: TelegramPendingApproval, terminalText: string, expiryObservedAt?: number): Promise<number> => {
    if (pending.messageId === null) return now()
    const terminalEditStartedAt = now()
    const base = {
      chat_id: options.expectedChatId,
      message_id: Number(pending.messageId),
      reply_markup: { inline_keyboard: [] as never[] },
    }
    const editSignal = AbortSignal.timeout(TELEGRAM_APPROVAL_TERMINAL_EDIT_TIMEOUT_MS)
    try {
      await options.api.request("editMessageText", { ...base, text: escapeTelegramHtml(terminalText), parse_mode: "HTML" }, editSignal)
    } catch (error) {
      const alreadyTerminal = error instanceof TelegramApiError && error.status === 400 && /message is not modified/i.test(error.message)
      if (!alreadyTerminal) {
        if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
        try {
          await options.api.request("editMessageText", { ...base, text: terminalText }, editSignal)
        } catch (fallbackError) {
          if (!(fallbackError instanceof TelegramApiError) || fallbackError.status !== 400 || !/message is not modified/i.test(fallbackError.message)) {
            throw fallbackError
          }
        }
      }
    }
    const terminalizedAt = now()
    if (pending.acceptanceBinding) emitAcceptanceEvidence("telegram.approval_prompt_terminalized", pending, { ...(expiryObservedAt === undefined ? {} : { expiryDeadlineAt: pending.expiresAt, expiryObservedAt }), terminalEditStartedAt, terminalizedAt, buttonsRemoved: true })
    else emitNervesEvent({ component: "senses", event: "telegram.approval_prompt_terminalized", message: "Telegram approval prompt was terminalized", meta: { approvalId: pending.approvalId, buttonsRemoved: true, ...options.acceptanceEventMeta?.() } })
    return terminalizedAt
  }

  const retainTerminalTombstone = (pending: TelegramPendingApproval, terminalizedAt: number): void => {
    pending.deliveryState = "terminal_tombstone"
    pending.decisionToken = undefined
    pending.terminalizedAt = terminalizedAt
    pending.tombstoneExpiresAt = terminalizedAt + TELEGRAM_APPROVAL_TOMBSTONE_TTL_MS
    pending.tombstoneMac = signState("telegram.approval_terminal_tombstone_state", pending, terminalTombstoneFields(pending)) ?? undefined
  }

  const acknowledge = async (callbackQueryId: string, invalid: boolean): Promise<"acknowledged" | "rejected_as_stale"> => {
    try {
      await options.api.request("answerCallbackQuery", invalid ? {
        callback_query_id: callbackQueryId,
        text: "This approval is no longer valid.",
        show_alert: true,
      } : { callback_query_id: callbackQueryId })
      return "acknowledged"
    } catch (error) {
      const stale = error instanceof TelegramApiError
        && error.status === 400
        && /query is too old|query ID is invalid/i.test(error.message)
      if (!stale) throw error
      return "rejected_as_stale"
    }
  }

  const settleDecisionAttempt = async (
    pending: TelegramPendingApproval,
    expected?: { decision: "approve" | "deny"; queryIdDigest: string; callbackQueryId: string; observedAt: number },
  ): Promise<{ accepted: boolean; terminalText: string; callbackAt: number }> => {
    if (pending.settlementReceipt) {
      const receipt = validateSettlementReceipt(pending)
      await emitSettlementReceipt(pending)
      await options.onSettlementComplete?.(pending.approvalId)
      persistRemoval(pending)
      return { accepted: receipt.accepted, terminalText: pending.terminal!.terminalText, callbackAt: receipt.callbackAt }
    }
    if (pending.terminal && !pending.decisionAttempt) {
      if (!expected) throw new Error("Telegram persisted decision attempt is unavailable")
      await acknowledge(expected.callbackQueryId, false)
      await editTerminal(pending, pending.terminal.terminalText)
      persistRemoval(pending)
      return { ...pending.terminal, callbackAt: expected.observedAt }
    }
    let decisionToken: string | undefined
    if (!pending.decisionAttempt) {
      if (!expected) throw new Error("Telegram persisted decision attempt is unavailable")
      decisionToken = await resolveDecisionToken(pending)
      const fencingToken = decisionToken
      const unsigned = {
        schemaVersion: "telegram-approval-decision-attempt-v1" as const,
        decision: expected.decision,
        queryIdDigest: expected.queryIdDigest,
        attemptedAt: expected.observedAt,
      }
      if (unsigned.attemptedAt < (pending.acceptanceBinding?.boundAt ?? pending.expiresAt - TELEGRAM_APPROVAL_TTL_MS)
        || unsigned.attemptedAt >= pending.expiresAt) throw new Error("Telegram decision attempt was observed outside its deadline")
      persistMutation(pending, () => {
        pending.decisionAttempt = {
          ...unsigned,
          evidenceMac: decisionAttemptMac(fencingToken, pending, unsigned),
          recoveryMac: signState("telegram.approval_decision_attempt_recovery_state", pending, decisionAttemptPayload(pending, unsigned)),
        }
      })
    }
    const attempt = await validateDecisionAttempt(pending, expected)
    let outcome = pending.terminal
    if (outcome) validateTerminalOutcome(pending)
    else {
      decisionToken ??= await resolveDecisionToken(pending)
      outcome = await options.onDecision({
        approvalId: pending.approvalId,
        decisionToken,
        decision: attempt.decision,
        decisionAt: attempt.attemptedAt,
        requesterId: options.expectedUserId,
        transport: "telegram",
        transportChatId: options.expectedChatId,
        transportMessageId: pending.messageId!,
        ...(pending.acceptanceBinding ? { acceptanceBinding: pending.acceptanceBinding } : {}),
      })
      persistMutation(pending, () => {
        pending.terminal = outcome
        pending.terminalMac = signState("telegram.approval_terminal_outcome_state", pending, terminalOutcomeFields(pending))
      })
    }
    const acknowledgementState = expected ? await acknowledge(expected.callbackQueryId, false) : "indeterminate_after_restart"
    await editTerminal(pending, outcome.terminalText)
    const reason = outcome.accepted ? "accepted" : "decision_refused"
    persistMutation(pending, () => {
      const receipt: NonNullable<TelegramPersistedPendingApproval["settlementReceipt"]> = {
        schemaVersion: "telegram-approval-settlement-receipt-v1",
        kind: expected ? "live" : "recovery",
        callbackAt: attempt.attemptedAt,
        accepted: outcome.accepted,
        reason,
        acknowledgementState,
        recoveredAt: expected ? null : now(),
        decisionAttemptDigest: createHash("sha256").update(JSON.stringify(attempt)).digest("hex"),
        evidenceMac: null,
      }
      receipt.evidenceMac = signState("telegram.approval_settlement_receipt_state", pending, settlementReceiptFields(receipt))
      pending.settlementReceipt = receipt
    })
    await emitSettlementReceipt(pending)
    await options.onSettlementComplete?.(pending.approvalId)
    persistRemoval(pending)
    return { ...outcome, callbackAt: attempt.attemptedAt }
  }

  const reconcileExpired = async (): Promise<void> => {
    let firstFailure: unknown
    for (const pending of uniquePending()) {
      if (pending.deliveryState !== "terminal_tombstone" && !pending.terminal && now() < pending.expiresAt) continue
      try {
        await withApprovalExclusive(pending.approvalId, false, async () => {
          const current = uniquePending().find((candidate) => candidate.approvalId === pending.approvalId)
          if (!current) return
          if (current.deliveryState === "terminal_tombstone") {
            validateTerminalTombstone(current)
            if (now() >= current.tombstoneExpiresAt!) {
              remove(current)
              persist()
            }
            return
          }
          if (current.decisionAttempt) {
            await settleDecisionAttempt(current)
            return
          }
          if (!current.terminal && now() < current.expiresAt) return
          if (current.terminal) {
            await editTerminal(current, current.terminal.terminalText)
            remove(current)
            persist()
            return
          }
          const observation = ensureExpiryObservation(current)!
          await options.onExpire?.(current.approvalId)
          const terminalizedAt = await editTerminal(current, "⚠️ Approval expired", observation.observedAt)
          if (current.acceptanceBinding) persistMutation(current, () => retainTerminalTombstone(current, terminalizedAt))
          else {
            remove(current)
            persist()
          }
        })
      } catch (error) {
        firstFailure ??= error
      }
    }
    if (firstFailure !== undefined) throw firstFailure
  }

  return {
    async sendApproval(input) {
      const approveCallbackData = `a:${options.createOpaqueHandle()}`
      const denyCallbackData = `d:${options.createOpaqueHandle()}`
      assertTelegramCallbackData(approveCallbackData)
      assertTelegramCallbackData(denyCallbackData)
      if (pendingByCallback.has(approveCallbackData) || pendingByCallback.has(denyCallbackData)) {
        throw new Error("Telegram approval callback handle collision")
      }
      const replyMarkup = { inline_keyboard: [[
        { text: "Approve", callback_data: approveCallbackData },
        { text: "Deny", callback_data: denyCallbackData },
      ]] }
      const htmlBody = {
        chat_id: options.expectedChatId,
        text: escapeTelegramHtml(input.prompt),
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }
      const pending: TelegramPendingApproval = {
        approvalId: input.approvalId,
        decisionToken: input.decisionToken,
        messageId: null,
        deliveryState: "pending",
        approveCallbackData,
        denyCallbackData,
        expiresAt: now() + TELEGRAM_APPROVAL_TTL_MS,
        prompt: input.prompt,
      }
      add(pending)
      try {
        persist()
      } catch (error) {
        remove(pending)
        throw error
      }
      pending.deliveryState = "send_attempting"
      try {
        persist()
      } catch (error) {
        pending.deliveryState = "pending"
        remove(pending)
        throw error
      }
      try {
        let result: unknown
        try {
          result = await options.api.request("sendMessage", htmlBody)
        } catch (error) {
          if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
          result = await options.api.request("sendMessage", {
            chat_id: options.expectedChatId,
            text: input.prompt,
            reply_markup: replyMarkup,
          })
        }
        if (!result || typeof result !== "object" || Array.isArray(result) || !("message_id" in result)
          || typeof result.message_id !== "number" || !Number.isSafeInteger(result.message_id) || result.message_id <= 0) {
          throw new Error("Telegram sendMessage response did not include a canonical message_id")
        }
        pending.messageId = String(result.message_id)
        pending.deliveryState = "bound"
        if (input.acceptanceBinding) {
          const boundAt = now()
          pending.acceptanceBinding = {
            ...input.acceptanceBinding,
            messageIdDigest: options.acceptanceMessageIdDigest?.(pending.messageId)
              ?? createHash("sha256").update(pending.messageId, "utf8").digest("hex"),
            boundAt,
          }
          pending.expiresAt = boundAt + TELEGRAM_APPROVAL_TTL_MS
        }
        persist()
        emitAcceptanceEvidence("senses.telegram_approval_prompt_bound", pending, { boundAt: pending.acceptanceBinding?.boundAt })
      } catch (error) {
        pending.messageId = null
        pending.deliveryState = "delivery_indeterminate"
        persist()
        throw error
      }
      return { messageId: pending.messageId!, approveCallbackData, denyCallbackData, expiresAt: pending.expiresAt }
    },

    async handleUpdate(update) {
      const callback = update.callback_query
      if (!callback) return { handled: false, accepted: false, reason: "not_callback" }
      const observedAt = now()
      const initiallyPending = pendingByCallback.get(callback.data ?? "")
      if (initiallyPending) {
        const result = await withApprovalExclusive(initiallyPending.approvalId, true, async () => handleUpdateUnlocked(update, observedAt))
        return result!
      }
      return handleUpdateUnlocked(update, observedAt)
    },
    reconcileExpired,
    async recoverDecisionAttempt(approvalId) {
      const result = await withApprovalExclusive(approvalId, true, async () => {
        const pending = uniquePending().find((record) => record.approvalId === approvalId)
        if (!pending?.decisionAttempt) return false
        await settleDecisionAttempt(pending)
        return true
      })
      return result ?? false
    },
    async terminalizeOrphaned(approvalId, terminalText) {
      const result = await withApprovalExclusive(approvalId, true, async () => {
        const pending = uniquePending().find((record) => record.approvalId === approvalId)
        if (!pending) return { terminalEditSucceeded: true }
        let terminalEditSucceeded = true
        try { await editTerminal(pending, terminalText) } catch { terminalEditSucceeded = false }
        remove(pending)
        persist()
        return { terminalEditSucceeded }
      })
      return result!
    },
    async terminalizeRecovered(approvalId, terminalText) {
      await withApprovalExclusive(approvalId, true, async () => {
        const pending = uniquePending().find((record) => record.approvalId === approvalId)
        if (!pending) return
        if (pending.messageId === null && (pending.deliveryState === "send_attempting" || pending.deliveryState === "delivery_indeterminate")) {
          pending.deliveryState = "delivery_indeterminate"
          pending.terminal = { accepted: false, terminalText }
          persist()
          return
        }
        await editTerminal(pending, terminalText)
        remove(pending)
        persist()
      })
    },
    listPendingDeliveries() {
      return uniquePending().filter((record) => record.deliveryState !== "terminal_tombstone")
        .map(({ decisionToken: _secret, ...record }) => structuredClone(record))
    },
  }

  async function handleUpdateUnlocked(update: TelegramUpdate, observedAt: number): Promise<{ handled: boolean; accepted: boolean; reason: string }> {
      const callback = update.callback_query!
      const pending = pendingByCallback.get(callback.data ?? "")
      const userId = String(callback.from.id)
      const chatId = callback.message ? String(callback.message.chat.id) : ""
      const messageId = callback.message ? String(callback.message.message_id) : ""
      let invalidReason: string | null = null
      let expiryObservedAt: number | undefined
      let expiryObservation: NonNullable<TelegramPersistedPendingApproval["expiryObservation"]> | undefined
      if (!pending) invalidReason = "stale_callback"
      else if (userId !== options.expectedUserId) invalidReason = "foreign_user"
      else if (chatId !== options.expectedChatId) invalidReason = "foreign_chat"
      else if (pending.deliveryState === "terminal_tombstone") {
        if (pending.messageId === null || messageId !== pending.messageId) invalidReason = "foreign_message"
        else invalidReason = "stale_callback"
      }
      else if (pending.deliveryState === "send_attempting" || pending.deliveryState === "delivery_indeterminate") invalidReason = "delivery_indeterminate"
      else if (pending.deliveryState !== "bound" || pending.messageId === null) invalidReason = "prompt_not_bound"
      else if (messageId !== pending.messageId) invalidReason = "foreign_message"
      else {
        if (!pending.decisionAttempt && observedAt >= pending.expiresAt) {
          invalidReason = "expired"
          expiryObservedAt = observedAt
        }
      }
      if (invalidReason) {
        if (pending?.deliveryState === "terminal_tombstone" && invalidReason === "stale_callback") {
          validateTerminalTombstone(pending)
          const queryIdDigest = createHash("sha256").update(callback.id).digest("hex")
          if (pending.staleTap) {
            validateStaleTap(pending)
            if (pending.staleTap.state === "attempted") {
              if (pending.staleTap.queryIdDigest !== queryIdDigest) throw new Error("Telegram stale-tap recovery query mismatch")
              const staleAt = pending.staleTap.attemptedAt
              persistMutation(pending, () => {
                const consumed: NonNullable<TelegramPersistedPendingApproval["staleTap"]> = { ...pending.staleTap!, state: "consumed", consumedAt: now(), evidenceMac: null }
                consumed.evidenceMac = signState("telegram.approval_stale_tap_state", pending, staleTapFields(pending, consumed))
                pending.staleTap = consumed
              })
              await acknowledge(callback.id, true)
              emitAcceptanceEvidence("telegram.approval_stale_callback_settled", pending, { staleAt, acknowledged: true, accepted: false, reason: "stale_callback" })
            } else {
              await acknowledge(callback.id, true)
            }
            return { handled: true, accepted: false, reason: invalidReason }
          }
          const staleAt = now()
          persistMutation(pending, () => {
            const attempted = { schemaVersion: "telegram-approval-stale-tap-v1" as const, state: "attempted" as const, queryIdDigest, attemptedAt: staleAt, consumedAt: null, evidenceMac: null as string | null }
            attempted.evidenceMac = signState("telegram.approval_stale_tap_state", pending, staleTapFields(pending, attempted))
            pending.staleTap = attempted
          })
          persistMutation(pending, () => {
            const consumed: NonNullable<TelegramPersistedPendingApproval["staleTap"]> = { ...pending.staleTap!, state: "consumed", consumedAt: now(), evidenceMac: null }
            consumed.evidenceMac = signState("telegram.approval_stale_tap_state", pending, staleTapFields(pending, consumed))
            pending.staleTap = consumed
          })
          await acknowledge(callback.id, true)
          emitAcceptanceEvidence("telegram.approval_stale_callback_settled", pending, { staleAt, acknowledged: true, accepted: false, reason: "stale_callback" })
          return { handled: true, accepted: false, reason: invalidReason }
        }
        if (pending && invalidReason === "expired") {
          expiryObservation = ensureExpiryObservation(pending, expiryObservedAt!)
          expiryObservedAt = expiryObservation.observedAt
        }
        await acknowledge(callback.id, true)
        if (pending && invalidReason === "delivery_indeterminate" && callback.message) {
          pending.messageId = messageId
          await editTerminal(pending, pending.terminal?.terminalText ?? "⚠️ Approval prompt delivery was interrupted — no action was taken")
          remove(pending)
          persist()
        }
        if (pending && invalidReason === "expired") {
          await options.onExpire?.(pending.approvalId)
          const terminalizedAt = await editTerminal(pending, "⚠️ Approval expired", expiryObservation!.observedAt)
          if (pending.acceptanceBinding) persistMutation(pending, () => retainTerminalTombstone(pending, terminalizedAt))
          else {
            remove(pending)
            persist()
          }
        }
        if (pending?.acceptanceBinding && invalidReason === "expired") emitAcceptanceEvidence("telegram.callback_settled", pending, { callbackAt: expiryObservedAt!, acknowledged: true, accepted: false, reason: invalidReason })
        else emitNervesEvent({ component: "senses", event: "telegram.callback_settled", message: "Telegram approval callback settled", meta: { approvalId: pending?.approvalId ?? null, reason: invalidReason, accepted: false, ...options.acceptanceEventMeta?.() } })
        return { handled: true, accepted: false, reason: invalidReason }
      }

      const decision = callback.data === pending!.approveCallbackData ? "approve" : "deny"
      const queryIdDigest = createHash("sha256").update(callback.id).digest("hex")
      const outcome = await settleDecisionAttempt(pending!, { decision, queryIdDigest, callbackQueryId: callback.id, observedAt })
      const reason = outcome.accepted ? "accepted" : "decision_refused"
      return { handled: true, accepted: outcome.accepted, reason }
  }
}

export interface TelegramChunkOptions {
  targetUnits?: number
  maxUnits?: number
}

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function sourceIndexForRenderedLimit(value: string, limit: number): number {
  let renderedUnits = 0
  let sourceIndex = 0
  for (const character of value) {
    const escaped = escapeTelegramHtml(character)
    if (renderedUnits + escaped.length > limit) break
    renderedUnits += escaped.length
    sourceIndex += character.length
  }
  return sourceIndex
}

function preferredBoundary(value: string, limit: number, minimum: number): number {
  const paragraph = value.lastIndexOf("\n\n", limit - 1)
  if (paragraph >= minimum) return paragraph + 2
  const newline = value.lastIndexOf("\n", limit - 1)
  if (newline >= minimum) return newline + 1
  for (let index = limit - 1; index >= minimum; index -= 1) {
    if (/\s/u.test(value[index])) return index + 1
  }
  return limit
}

export function splitTelegramText(value: string, options: TelegramChunkOptions = {}): string[] {
  const targetUnits = options.targetUnits ?? 1_200
  const maxUnits = options.maxUnits ?? 4_000
  if (!Number.isInteger(targetUnits) || !Number.isInteger(maxUnits) || targetUnits < 1 || maxUnits < targetUnits) {
    throw new Error("Telegram chunk limits must be positive integers with targetUnits <= maxUnits")
  }
  if (!value) return [""]

  const chunks: string[] = []
  let remaining = value
  while (escapeTelegramHtml(remaining).length > maxUnits || escapeTelegramHtml(remaining).length > targetUnits) {
    const targetIndex = sourceIndexForRenderedLimit(remaining, targetUnits)
    const maxIndex = sourceIndexForRenderedLimit(remaining, maxUnits)
    const candidate = targetIndex > 0 ? targetIndex : maxIndex
    if (candidate <= 0) throw new Error("Telegram chunk limit cannot fit one character")
    const splitAt = preferredBoundary(remaining, candidate, Math.floor(candidate / 2))
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  chunks.push(remaining)
  return chunks
}

export async function sendTelegramText(
  api: TelegramBotApi,
  chatId: string,
  text: string,
  signal?: AbortSignal,
  onMessageDelivered?: (messageId: number, chunk: string) => void,
): Promise<number[]> {
  const results: number[] = []
  const recordMessageId = (value: unknown, chunk: string): void => {
    const messageId = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { message_id?: unknown }).message_id
      : undefined
    if (!Number.isSafeInteger(messageId) || (messageId as number) < 1) throw new TelegramApiError("Telegram sendMessage result omitted a canonical message_id")
    results.push(messageId as number)
    onMessageDelivered?.(messageId as number, chunk)
  }
  for (const chunk of splitTelegramText(text)) {
    try {
      recordMessageId(await api.request("sendMessage", {
        chat_id: chatId,
        text: escapeTelegramHtml(chunk),
        parse_mode: "HTML",
      }, signal), chunk)
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
      recordMessageId(await api.request("sendMessage", { chat_id: chatId, text: chunk }, signal), chunk)
    }
  }
  return results
}

function safeErrorMessage(message: string, token: string): string {
  return message.split(token).join("[redacted]")
}

function parseEnvelope<T>(raw: string, status: number, token: string): TelegramEnvelope<T> {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (cause) {
    throw new TelegramApiError(`Telegram returned invalid JSON (HTTP ${status})`, { status, cause })
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { ok?: unknown }).ok !== "boolean") {
    throw new TelegramApiError("Telegram returned an invalid response envelope", { status })
  }
  const envelope = value as TelegramEnvelope<T>
  if (!envelope.ok) {
    throw new TelegramApiError(safeErrorMessage(envelope.description ?? "Telegram request failed", token), {
      status,
      errorCode: typeof envelope.error_code === "number" ? envelope.error_code : null,
      retryAfterSeconds: typeof envelope.parameters?.retry_after === "number" ? envelope.parameters.retry_after : null,
    })
  }
  if (!("result" in envelope)) {
    throw new TelegramApiError("Telegram success response omitted result", { status })
  }
  return envelope
}

export function createTelegramBotApi(options: TelegramBotApiOptions): TelegramBotApi {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const apiRoot = options.apiRoot ?? "https://api.telegram.org"
  const baseUrl = `${apiRoot.replace(/\/$/, "")}/bot${options.token}`
  const shutdown = new AbortController()
  const sleep = options.sleep ?? ((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  }))

  return {
    async request<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal) {
      emitNervesEvent({
        component: "senses",
        event: "telegram.request_start",
        message: "Telegram Bot API request started",
        meta: { method },
      })
      try {
        const requestSignal = signal
          ? AbortSignal.any([shutdown.signal, signal])
          : shutdown.signal
        let retries = 0
        for (;;) {
          requestSignal.throwIfAborted()
          try {
            const response = await fetchImpl(`${baseUrl}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: requestSignal,
            })
            const envelope = parseEnvelope<T>(await response.text(), response.status, options.token)
            if (!response.ok) {
              throw new TelegramApiError(`Telegram request failed (HTTP ${response.status})`, { status: response.status })
            }
            emitNervesEvent({
              component: "senses",
              event: "telegram.request_end",
              message: "Telegram Bot API request completed",
              meta: { method, status: response.status },
            })
            return envelope.result as T
          } catch (caught) {
            const retryAfter = caught instanceof TelegramApiError ? caught.retryAfterSeconds : null
            const canRetry = caught instanceof TelegramApiError
              && caught.status === 429
              && Number.isInteger(retryAfter)
              && retries < 3
            if (!canRetry) throw caught
            retries += 1
            const boundedSeconds = Math.min(Math.max(retryAfter as number, 1), 30)
            await sleep(boundedSeconds * 1_000, requestSignal)
          }
        }
      } catch (caught) {
        const error = caught instanceof TelegramApiError
          ? new TelegramApiError(safeErrorMessage(caught.message, options.token), {
              status: caught.status,
              errorCode: caught.errorCode,
              retryAfterSeconds: caught.retryAfterSeconds,
            })
          : new TelegramApiError(safeErrorMessage(caught instanceof Error ? caught.message : String(caught), options.token))
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "telegram.request_error",
          message: "Telegram Bot API request failed",
          meta: { method, status: error.status, errorCode: error.errorCode },
        })
        throw error
      }
    },
    stop() {
      shutdown.abort(new Error("Telegram Bot API client stopped"))
    },
  }
}
