import { emitNervesEvent } from "../nerves/runtime"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

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
  load(): TelegramUpdate[]
  loadPending(): TelegramUpdate[]
  loadIndeterminate(): TelegramUpdate[]
  capture(update: TelegramUpdate): boolean
  claim(updateId: number): boolean
  complete(updateId: number): void
  discardCompletedBefore(nextUpdateId: number): void
}

interface TelegramUpdateInboxState {
  pending: TelegramUpdate[]
  dispatching: TelegramUpdate[]
  completedUpdateIds: number[]
}

export class FileTelegramUpdateInboxStore implements TelegramUpdateInboxStore {
  constructor(private readonly path: string) {}

  private read(): TelegramUpdateInboxState {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<TelegramUpdateInboxState>
      if (!Array.isArray(value.pending) || !Array.isArray(value.completedUpdateIds)) throw new Error("invalid inbox shape")
      if (value.dispatching !== undefined && !Array.isArray(value.dispatching)) throw new Error("invalid dispatching updates")
      if (!value.pending.every((update) => update && Number.isSafeInteger(update.update_id) && update.update_id >= 0)) throw new Error("invalid pending update")
      if (!(value.dispatching ?? []).every((update) => update && Number.isSafeInteger(update.update_id) && update.update_id >= 0)) throw new Error("invalid dispatching update")
      if (!value.completedUpdateIds.every((id) => Number.isSafeInteger(id) && id >= 0)) throw new Error("invalid completed update")
      return { pending: structuredClone(value.pending), dispatching: structuredClone(value.dispatching ?? []), completedUpdateIds: [...value.completedUpdateIds] }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { pending: [], dispatching: [], completedUpdateIds: [] }
      throw new Error("Telegram update inbox state is corrupt", { cause: error })
    }
  }

  private write(state: TelegramUpdateInboxState): void {
    durableAtomicWrite(this.path, `${JSON.stringify(state)}\n`)
  }

  load(): TelegramUpdate[] {
    const state = this.read()
    return [...state.pending, ...state.dispatching]
  }

  loadPending(): TelegramUpdate[] {
    return this.read().pending
  }

  loadIndeterminate(): TelegramUpdate[] {
    return this.read().dispatching
  }

  capture(update: TelegramUpdate): boolean {
    const state = this.read()
    const existing = [...state.pending, ...state.dispatching].find((candidate) => candidate.update_id === update.update_id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(update)) throw new Error(`Telegram update inbox has conflicting update ${update.update_id}`)
      return false
    }
    if (state.completedUpdateIds.includes(update.update_id)) return false
    state.pending.push(structuredClone(update))
    state.pending.sort((left, right) => left.update_id - right.update_id)
    this.write(state)
    return true
  }

  claim(updateId: number): boolean {
    const state = this.read()
    if (state.dispatching.some((update) => update.update_id === updateId)) return false
    const index = state.pending.findIndex((update) => update.update_id === updateId)
    if (index < 0) return false
    const [update] = state.pending.splice(index, 1)
    state.dispatching.push(update!)
    this.write(state)
    return true
  }

  complete(updateId: number): void {
    const state = this.read()
    state.pending = state.pending.filter((update) => update.update_id !== updateId)
    state.dispatching = state.dispatching.filter((update) => update.update_id !== updateId)
    if (!state.completedUpdateIds.includes(updateId)) state.completedUpdateIds.push(updateId)
    this.write(state)
  }

  discardCompletedBefore(nextUpdateId: number): void {
    const state = this.read()
    const remaining = state.completedUpdateIds.filter((updateId) => updateId >= nextUpdateId)
    if (remaining.length === state.completedUpdateIds.length) return
    state.completedUpdateIds = remaining
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
      meta: { updateClass: update.message ? "message" : "other", reason: "unauthorized_or_unsupported" },
    })
  }

  const pollOnce = async (signal?: AbortSignal): Promise<number> => {
    const requestSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
    if (requestSignal.aborted) throw new Error("Telegram long poll stopped")
    for (const indeterminate of options.inboxStore?.loadIndeterminate() ?? []) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "telegram.update_dropped",
        message: "Telegram update dispatch outcome is indeterminate after restart",
        meta: { updateClass: indeterminate.callback_query ? "callback" : "message", reason: "dispatch_indeterminate" },
      })
    }
    for (const pending of options.inboxStore?.loadPending() ?? []) {
      if (!options.inboxStore?.claim(pending.update_id)) continue
      await dispatch(pending)
      options.inboxStore.complete(pending.update_id)
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
      const requiresDurableDispatch = Boolean(update.callback_query || authorizedMessage(update))
      const newlyCaptured = requiresDurableDispatch ? (options.inboxStore?.capture(update) ?? true) : true
      options.offsetStore.save(next)
      nextUpdateId = next
      if (newlyCaptured) {
        if (requiresDurableDispatch && options.inboxStore && !options.inboxStore.claim(update.update_id)) continue
        await dispatch(update)
        if (requiresDurableDispatch) options.inboxStore?.complete(update.update_id)
      }
      options.inboxStore?.discardCompletedBefore(nextUpdateId)
    }
    return nextUpdateId
  }

  return {
    pollOnce,
    async run(signal?: AbortSignal) {
      const runSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
      while (!runSignal.aborted) await pollOnce(runSignal)
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
}

export interface TelegramPersistedPendingApproval {
  approvalId: string
  messageId: string
  approveCallbackData: string
  denyCallbackData: string
  expiresAt: number
  terminal?: { accepted: boolean; terminalText: string }
}

interface TelegramPendingApproval extends TelegramPersistedPendingApproval {
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
  sendApproval(input: { approvalId: string; decisionToken: string; prompt: string }): Promise<{
    messageId: string
    approveCallbackData: string
    denyCallbackData: string
    expiresAt: number
  }>
  handleUpdate(update: TelegramUpdate): Promise<{ handled: boolean; accepted: boolean; reason: string }>
  reconcileExpired(): Promise<void>
  terminalizeRecovered(approvalId: string, terminalText: string): Promise<void>
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
}

function assertTelegramCallbackData(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes < 1 || bytes > 64) throw new Error("Telegram callback_data must be 1 to 64 bytes")
}

export function createTelegramApprovalTransport(options: TelegramApprovalTransportOptions): TelegramApprovalTransport {
  const now = options.now ?? Date.now
  const pendingByCallback = new Map<string, TelegramPendingApproval>()

  const uniquePending = (): TelegramPendingApproval[] => [...new Set(pendingByCallback.values())]
  const persist = (): void => options.pendingStore.save(uniquePending().map(({ decisionToken: _secret, ...record }) => record))
  const add = (pending: TelegramPendingApproval): void => {
    pendingByCallback.set(pending.approveCallbackData, pending)
    pendingByCallback.set(pending.denyCallbackData, pending)
  }
  const remove = (pending: TelegramPendingApproval): void => {
    pendingByCallback.delete(pending.approveCallbackData)
    pendingByCallback.delete(pending.denyCallbackData)
  }

  for (const pending of options.pendingStore.load()) {
    assertTelegramCallbackData(pending.approveCallbackData)
    assertTelegramCallbackData(pending.denyCallbackData)
    if (pendingByCallback.has(pending.approveCallbackData) || pendingByCallback.has(pending.denyCallbackData)) {
      throw new Error("Telegram persisted approval callback handle collision")
    }
    add(pending)
  }

  const editTerminal = async (pending: TelegramPendingApproval, terminalText: string): Promise<void> => {
    const base = {
      chat_id: options.expectedChatId,
      message_id: Number(pending.messageId),
      reply_markup: { inline_keyboard: [] as never[] },
    }
    try {
      await options.api.request("editMessageText", { ...base, text: escapeTelegramHtml(terminalText), parse_mode: "HTML" })
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 400 && /message is not modified/i.test(error.message)) return
      if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
      try {
        await options.api.request("editMessageText", { ...base, text: terminalText })
      } catch (fallbackError) {
        if (!(fallbackError instanceof TelegramApiError) || fallbackError.status !== 400 || !/message is not modified/i.test(fallbackError.message)) {
          throw fallbackError
        }
      }
    }
  }

  const acknowledge = async (callbackQueryId: string, invalid: boolean): Promise<void> => {
    try {
      await options.api.request("answerCallbackQuery", invalid ? {
        callback_query_id: callbackQueryId,
        text: "This approval is no longer valid.",
        show_alert: true,
      } : { callback_query_id: callbackQueryId })
    } catch (error) {
      const stale = error instanceof TelegramApiError
        && error.status === 400
        && /query is too old|query ID is invalid/i.test(error.message)
      if (!stale) throw error
    }
  }

  const reconcileExpired = async (): Promise<void> => {
    for (const pending of uniquePending()) {
      if (now() < pending.expiresAt) continue
      await options.onExpire?.(pending.approvalId)
      await editTerminal(pending, "⚠️ Approval expired")
      remove(pending)
      persist()
    }
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
      if (!result || typeof result !== "object" || Array.isArray(result) || !("message_id" in result)) {
        throw new Error("Telegram sendMessage response did not include message_id")
      }
      const pending: TelegramPendingApproval = {
        approvalId: input.approvalId,
        decisionToken: input.decisionToken,
        messageId: String(result.message_id),
        approveCallbackData,
        denyCallbackData,
        expiresAt: now() + 300_000,
      }
      add(pending)
      try {
        persist()
      } catch (error) {
        remove(pending)
        throw error
      }
      return { messageId: pending.messageId, approveCallbackData, denyCallbackData, expiresAt: pending.expiresAt }
    },

    async handleUpdate(update) {
      const callback = update.callback_query
      if (!callback) return { handled: false, accepted: false, reason: "not_callback" }
      const pending = pendingByCallback.get(callback.data ?? "")
      const userId = String(callback.from.id)
      const chatId = callback.message ? String(callback.message.chat.id) : ""
      const messageId = callback.message ? String(callback.message.message_id) : ""
      let invalidReason: string | null = null
      if (!pending) invalidReason = "stale_callback"
      else if (userId !== options.expectedUserId) invalidReason = "foreign_user"
      else if (chatId !== options.expectedChatId) invalidReason = "foreign_chat"
      else if (messageId !== pending.messageId) invalidReason = "foreign_message"
      else if (now() >= pending.expiresAt) invalidReason = "expired"
      if (invalidReason) {
        await acknowledge(callback.id, true)
        if (pending && invalidReason === "expired") {
          await options.onExpire?.(pending.approvalId)
          await editTerminal(pending, "⚠️ Approval expired")
          remove(pending)
          persist()
        }
        return { handled: true, accepted: false, reason: invalidReason }
      }

      remove(pending!)
      try {
        await acknowledge(callback.id, false)
        let outcome = pending!.terminal
        if (!outcome) {
          const decisionToken = pending!.decisionToken ?? await options.resolveDecisionToken?.(pending!.approvalId)
          if (!decisionToken) throw new Error("Telegram approval restart requires a decision token resolver")
          outcome = await options.onDecision({
            approvalId: pending!.approvalId,
            decisionToken,
            decision: callback.data === pending!.approveCallbackData ? "approve" : "deny",
            requesterId: options.expectedUserId,
            transport: "telegram",
            transportChatId: options.expectedChatId,
            transportMessageId: pending!.messageId,
          })
          pending!.terminal = outcome
        }
        add(pending!)
        persist()
        await editTerminal(pending!, outcome.terminalText)
        remove(pending!)
        persist()
        return { handled: true, accepted: outcome.accepted, reason: outcome.accepted ? "accepted" : "decision_refused" }
      } catch (error) {
        add(pending!)
        throw error
      }
    },
    reconcileExpired,
    async terminalizeRecovered(approvalId, terminalText) {
      const pending = uniquePending().find((record) => record.approvalId === approvalId)
      if (!pending) return
      await editTerminal(pending, terminalText)
      remove(pending)
      persist()
    },
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
): Promise<number[]> {
  const results: number[] = []
  const recordMessageId = (value: unknown): void => {
    const messageId = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { message_id?: unknown }).message_id
      : undefined
    if (!Number.isSafeInteger(messageId) || (messageId as number) < 1) throw new TelegramApiError("Telegram sendMessage result omitted a canonical message_id")
    results.push(messageId as number)
  }
  for (const chunk of splitTelegramText(text)) {
    try {
      recordMessageId(await api.request("sendMessage", {
        chat_id: chatId,
        text: escapeTelegramHtml(chunk),
        parse_mode: "HTML",
      }, signal))
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
      recordMessageId(await api.request("sendMessage", { chat_id: chatId, text: chunk }, signal))
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
          ? caught
          : new TelegramApiError(safeErrorMessage(caught instanceof Error ? caught.message : String(caught), options.token), { cause: caught })
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
