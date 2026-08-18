import { emitNervesEvent } from "../nerves/runtime"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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
    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporaryPath, `${JSON.stringify({ nextUpdateId })}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.path)
  }
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number }
    chat: { id: number; type: string }
    text?: string
  }
  callback_query?: unknown
}

export interface TelegramInboundMessage {
  updateId: number
  messageId: string
  userId: string
  chatId: string
  text: string
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
  onMessage: (message: TelegramInboundMessage) => Promise<void>
  onUpdate?: (update: TelegramUpdate) => Promise<boolean>
}

export function createTelegramLongPoll(options: TelegramLongPollOptions): TelegramLongPoll {
  let nextUpdateId = options.offsetStore.load()
  const shutdown = new AbortController()

  const pollOnce = async (signal?: AbortSignal): Promise<number> => {
    const requestSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
    if (requestSignal.aborted) throw new Error("Telegram long poll stopped")
    const updates = await options.api.request<TelegramUpdate[]>("getUpdates", {
      offset: nextUpdateId,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    }, requestSignal)
    if (!Array.isArray(updates)) throw new Error("Telegram getUpdates result must be an array")
    for (const update of updates) {
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < nextUpdateId) continue
      const next = update.update_id + 1
      const handled = await options.onUpdate?.(update) ?? false
      if (!handled) {
        const message = update.message
        const userId = message?.from ? String(message.from.id) : ""
        const chatId = message ? String(message.chat.id) : ""
        const authorized = message
          && message.chat.type === "private"
          && userId === options.expectedUserId
          && chatId === options.expectedChatId
          && typeof message.text === "string"
        if (authorized) {
          await options.onMessage({
            updateId: update.update_id,
            messageId: String(message.message_id),
            userId,
            chatId,
            text: message.text as string,
          })
        } else {
          emitNervesEvent({
            component: "senses",
            event: "telegram.update_dropped",
            message: "Telegram update dropped before dispatch",
            meta: { updateClass: message ? "message" : "other", reason: "unauthorized_or_unsupported" },
          })
        }
      }
      nextUpdateId = next
      options.offsetStore.save(nextUpdateId)
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
): Promise<unknown[]> {
  const results: unknown[] = []
  for (const chunk of splitTelegramText(text)) {
    try {
      results.push(await api.request("sendMessage", {
        chat_id: chatId,
        text: escapeTelegramHtml(chunk),
        parse_mode: "HTML",
      }, signal))
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.status !== 400) throw error
      results.push(await api.request("sendMessage", { chat_id: chatId, text: chunk }, signal))
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
