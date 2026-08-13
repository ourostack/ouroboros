import { randomUUID } from "node:crypto"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig } from "../../heart/config"
import { getAgentName, loadAgentConfig } from "../../heart/identity"
import {
  probeBlueBubblesHealth,
  redactBlueBubblesHealthDetailForNerves,
} from "../../heart/daemon/bluebubbles-health-diagnostics"
import { emitNervesEvent } from "../../nerves/runtime"
import { MINIMAX_PROVIDER_BASE_URL } from "../../heart/providers/minimax"
import { minimaxVlmDescribe } from "../../heart/providers/minimax-vlm"
import { normalizeBlueBubblesEvent, type BlueBubblesChatRef, type BlueBubblesNormalizedEvent } from "./model"
import { hydrateBlueBubblesAttachments, type VlmDescribeFn } from "./media"

export interface BlueBubblesSendTextParams {
  chat: BlueBubblesChatRef
  text: string
  replyToMessageGuid?: string
  tempGuid?: string
  signal?: AbortSignal
  onTransportInvocation?: () => void
}

export interface BlueBubblesSendTextResult {
  messageGuid?: string
}

export class BlueBubblesSendError extends Error {
  readonly httpStatus: number | null
  readonly status: number | null
  readonly errorCode: string
  readonly transportInvoked: boolean

  constructor(input: {
    message: string
    httpStatus: number | null
    errorCode: string
    transportInvoked: boolean
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "BlueBubblesSendError"
    this.httpStatus = input.httpStatus
    this.status = input.httpStatus
    this.errorCode = input.errorCode
    this.transportInvoked = input.transportInvoked
  }
}

export interface BlueBubblesEditMessageParams {
  messageGuid: string
  text: string
  backwardsCompatibilityMessage?: string
  partIndex?: number
}

export interface BlueBubblesClient {
  sendText(params: BlueBubblesSendTextParams): Promise<BlueBubblesSendTextResult>
  editMessage(params: BlueBubblesEditMessageParams): Promise<void>
  setTyping(chat: BlueBubblesChatRef, typing: boolean, signal?: AbortSignal): Promise<void>
  markChatRead(chat: BlueBubblesChatRef, signal?: AbortSignal): Promise<void>
  checkHealth(): Promise<void>
  listRecentMessages?(params?: BlueBubblesListRecentMessagesParams): Promise<BlueBubblesNormalizedEvent[]>
  queryRecentMessagesWithMetadata?(params?: BlueBubblesListRecentMessagesParams): Promise<BlueBubblesMessageQueryResult>
  repairEvent(event: BlueBubblesNormalizedEvent): Promise<BlueBubblesNormalizedEvent>
  /** Fetch the text content of a message by its GUID. Returns null if not found or on error. */
  getMessageText(messageGuid: string): Promise<string | null>
}

export interface BlueBubblesListRecentMessagesParams {
  limit?: number
  offset?: number
  chatGuid?: string
  chatIdentifier?: string
  beforeTimestamp?: number
}

export interface BlueBubblesMessageQueryResult {
  messages: BlueBubblesNormalizedEvent[]
  rawRowCount: number
  normalizedRowCount: number
  skippedRowCount: number
  invalidCausalTimestampRowCount: number
  request: {
    limit: number
    offset: number
    sort: "DESC"
    chatGuid?: string
    chatIdentifier?: string
    beforeTimestamp?: number
  }
}

type ClientConfig = ReturnType<typeof getBlueBubblesConfig>
type ChannelConfig = ReturnType<typeof getBlueBubblesChannelConfig>
type JsonRecord = Record<string, unknown>
type BlueBubblesChatQueryRecord = Record<string, unknown>

function buildBlueBubblesApiUrl(baseUrl: string, endpoint: string, password: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const url = new URL(endpoint.replace(/^\//, ""), root)
  url.searchParams.set("password", password)
  return url.toString()
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function extractMessageGuid(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null
  const candidates = [
    record.messageGuid,
    record.messageId,
    record.guid,
    data?.messageGuid,
    data?.messageId,
    data?.guid,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }
  return undefined
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function describeCaughtValue(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sendTransportErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout"
  if (error instanceof Error && error.name === "AbortError") return "abort"
  if (error instanceof TypeError) return "socket"
  return "transport_error"
}

function emitBlueBubblesSendError(input: {
  status: number | null
  errorCode: string
  reason: string
}): void {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.bluebubbles_send_error",
    message: "bluebubbles send failed",
    meta: {
      status: input.status,
      errorCode: input.errorCode,
      reason: input.reason,
    },
  })
}

function buildRepairUrl(baseUrl: string, messageGuid: string, password: string): string {
  const url = buildBlueBubblesApiUrl(baseUrl, `/api/v1/message/${encodeURIComponent(messageGuid)}`, password)
  const parsed = new URL(url)
  parsed.searchParams.set("with", "attachments,payloadData,chats,messageSummaryInfo")
  return parsed.toString()
}

function extractChatIdentifierFromGuid(chatGuid: string): string | undefined {
  const parts = chatGuid.split(";")
  return parts.length >= 3 ? parts[2]?.trim() || undefined : undefined
}

function extractChatGuid(value: unknown): string | undefined {
  const record = asRecord(value)
  const candidates = [
    record?.chatGuid,
    record?.guid,
    record?.chat_guid,
    record?.identifier,
    record?.chatIdentifier,
    record?.chat_identifier,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }
  return undefined
}

function extractQueriedChatIdentifier(chat: BlueBubblesChatQueryRecord, chatGuid: string): string | undefined {
  const explicitIdentifier = readString(chat, "chatIdentifier")
    ?? readString(chat, "identifier")
    ?? readString(chat, "chat_identifier")
  if (explicitIdentifier) {
    return explicitIdentifier
  }

  return extractChatIdentifierFromGuid(chatGuid)
}

function extractChatQueryRows(payload: unknown): BlueBubblesChatQueryRecord[] {
  const record = asRecord(payload)
  const data = Array.isArray(record?.data) ? record.data : payload
  if (!Array.isArray(data)) {
    return []
  }
  return data.map((entry) => asRecord(entry)).filter((entry): entry is BlueBubblesChatQueryRecord => entry !== null)
}

function extractMessageQueryRows(payload: unknown): unknown[] {
  const record = asRecord(payload)
  const data = asRecord(record?.data)
  const rows =
    Array.isArray(record?.data) ? record.data
      : Array.isArray(data?.messages) ? data.messages
        : Array.isArray(data?.results) ? data.results
          : Array.isArray(record?.messages) ? record.messages
            : Array.isArray(payload) ? payload
              : []

  return rows
}

function hasValidRawMessageCausalTimestamp(row: unknown): boolean {
  const record = asRecord(row)
  return typeof record?.dateCreated === "number"
    && Number.isFinite(record.dateCreated)
    && record.dateCreated > 0
}

async function resolveChatGuidForIdentifier(
  config: ClientConfig,
  channelConfig: ChannelConfig,
  chatIdentifier: string,
): Promise<string | undefined> {
  const trimmedIdentifier = chatIdentifier.trim()
  if (!trimmedIdentifier) return undefined

  const url = buildBlueBubblesApiUrl(config.serverUrl, "/api/v1/chat/query", config.password)
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      limit: 500,
      offset: 0,
      with: ["participants"],
    }),
    signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
  })

  if (!response.ok) {
    return undefined
  }

  const payload = await parseJsonBody(response)
  const rows = extractChatQueryRows(payload)
  for (const row of rows) {
    const guid = extractChatGuid(row)
    if (!guid) continue
    const identifier = extractQueriedChatIdentifier(row, guid)
    if (identifier === trimmedIdentifier || guid === trimmedIdentifier) {
      return guid
    }
  }

  return undefined
}

function collectPreviewStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || out.length >= 4) return
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed) out.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPreviewStrings(entry, out, depth + 1)
    return
  }
  const record = asRecord(value)
  if (!record) return
  const preferredKeys = ["title", "summary", "subtitle", "previewText", "siteName", "host", "url"]
  for (const key of preferredKeys) {
    if (out.length >= 4) break
    collectPreviewStrings(record[key], out, depth + 1)
  }
}

function extractLinkPreviewText(data: JsonRecord): string | undefined {
  const values: string[] = []
  collectPreviewStrings(data.payloadData, values)
  collectPreviewStrings(data.messageSummaryInfo, values)
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  if (unique.length === 0) return undefined
  return unique.slice(0, 2).join(" — ")
}

function applyRepairNotice(event: BlueBubblesNormalizedEvent, notice: string): BlueBubblesNormalizedEvent {
  return {
    ...event,
    requiresRepair: false,
    repairNotice: notice,
  }
}

function hasRecoverableMessageContent(event: BlueBubblesNormalizedEvent): event is Extract<BlueBubblesNormalizedEvent, { kind: "message" }> {
  return event.kind === "message"
    && (
      event.textForAgent.trim().length > 0
      || event.attachments.length > 0
      || event.hasPayloadData
    )
}

function hydrateTextForAgent(event: BlueBubblesNormalizedEvent, rawData: JsonRecord): BlueBubblesNormalizedEvent {
  if (event.kind !== "message") {
    return { ...event, requiresRepair: false }
  }
  if (event.balloonBundleId !== "com.apple.messages.URLBalloonProvider") {
    return { ...event, requiresRepair: false }
  }

  const previewText = extractLinkPreviewText(rawData)
  if (!previewText) {
    return { ...event, requiresRepair: false }
  }

  const base = event.text.trim()
  const textForAgent = base
    ? `${base}\n[link preview: ${previewText}]`
    : `[link preview: ${previewText}]`

  return {
    ...event,
    textForAgent,
    requiresRepair: false,
  }
}

function extractRepairData(payload: unknown): JsonRecord | null {
  const record = asRecord(payload)
  return asRecord(record?.data) ?? record
}

function providerSupportsAudioInput(provider: string): boolean {
  void provider
  return false
}

async function resolveChatGuid(
  chat: BlueBubblesChatRef,
  config: ClientConfig,
  channelConfig: ChannelConfig,
): Promise<string | undefined> {
  return chat.chatGuid
    ?? await resolveChatGuidForIdentifier(config, channelConfig, chat.chatIdentifier ?? "")
}

export function createBlueBubblesClient(
  config: ClientConfig = getBlueBubblesConfig(),
  channelConfig: ChannelConfig = getBlueBubblesChannelConfig(),
): BlueBubblesClient {
  return {
    async sendText(params: BlueBubblesSendTextParams): Promise<BlueBubblesSendTextResult> {
      const trimmedText = params.text.trim()
      if (!trimmedText) {
        throw new Error("BlueBubbles send requires non-empty text.")
      }
      const resolvedChatGuid = await resolveChatGuid(params.chat, config, channelConfig)
      if (!resolvedChatGuid) {
        throw new Error("BlueBubbles send currently requires chat.chatGuid from the inbound event.")
      }

      const url = buildBlueBubblesApiUrl(config.serverUrl, "/api/v1/message/text", config.password)
      const body: Record<string, unknown> = {
        chatGuid: resolvedChatGuid,
        tempGuid: params.tempGuid?.trim() || randomUUID(),
        message: trimmedText,
      }
      if (params.replyToMessageGuid?.trim()) {
        body.method = "private-api"
        body.selectedMessageGuid = params.replyToMessageGuid.trim()
        body.partIndex = 0
      }

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_send_start",
        message: "sending bluebubbles message",
        meta: {
          chatGuid: resolvedChatGuid,
          hasReplyTarget: Boolean(params.replyToMessageGuid?.trim()),
        },
      })

      const requestTimeoutSignal = AbortSignal.timeout(channelConfig.requestTimeoutMs)
      params.onTransportInvocation?.()
      let response: Response
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: params.signal
            ? AbortSignal.any([params.signal, requestTimeoutSignal])
            : requestTimeoutSignal,
        })
      } catch (error) {
        const errorCode = sendTransportErrorCode(error)
        const reason = describeCaughtValue(error)
        emitBlueBubblesSendError({ status: null, errorCode, reason })
        throw new BlueBubblesSendError({
          message: `BlueBubbles send failed (${errorCode}): ${reason}`,
          httpStatus: null,
          errorCode,
          transportInvoked: true,
          cause: error,
        })
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        const reason = errorText || "unknown"
        const errorCode = `http_${response.status}`
        emitBlueBubblesSendError({ status: response.status, errorCode, reason })
        throw new BlueBubblesSendError({
          message: `BlueBubbles send failed (${response.status}): ${reason}`,
          httpStatus: response.status,
          errorCode,
          transportInvoked: true,
        })
      }

      const rawPayload = await response.text()
      let payload: unknown = null
      if (rawPayload.trim()) {
        try {
          payload = JSON.parse(rawPayload) as unknown
        } catch (error) {
          const errorCode = "malformed_response"
          emitBlueBubblesSendError({ status: response.status, errorCode, reason: errorCode })
          throw new BlueBubblesSendError({
            message: `BlueBubbles send failed (${response.status}): malformed response`,
            httpStatus: response.status,
            errorCode,
            transportInvoked: true,
            cause: error,
          })
        }
      }
      const messageGuid = extractMessageGuid(payload)

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_send_end",
        message: "bluebubbles message sent",
        meta: {
          chatGuid: resolvedChatGuid,
          messageGuid: messageGuid ?? null,
        },
      })

      return { messageGuid }
    },

    async editMessage(params: BlueBubblesEditMessageParams): Promise<void> {
      const messageGuid = params.messageGuid.trim()
      const text = params.text.trim()
      if (!messageGuid) {
        throw new Error("BlueBubbles edit requires messageGuid.")
      }
      if (!text) {
        throw new Error("BlueBubbles edit requires non-empty text.")
      }

      const editTimeoutMs = Math.max(channelConfig.requestTimeoutMs, 120000)
      const url = buildBlueBubblesApiUrl(
        config.serverUrl,
        `/api/v1/message/${encodeURIComponent(messageGuid)}/edit`,
        config.password,
      )
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          editedMessage: text,
          backwardsCompatibilityMessage: params.backwardsCompatibilityMessage ?? `Edited to: ${text}`,
          partIndex: typeof params.partIndex === "number" ? params.partIndex : 0,
        }),
        signal: AbortSignal.timeout(editTimeoutMs),
      })
      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        throw new Error(`BlueBubbles edit failed (${response.status}): ${errorText || "unknown"}`)
      }
    },

    async setTyping(chat: BlueBubblesChatRef, typing: boolean, signal?: AbortSignal): Promise<void> {
      const resolvedChatGuid = await resolveChatGuid(chat, config, channelConfig)
      if (!resolvedChatGuid) {
        return
      }
      const url = buildBlueBubblesApiUrl(
        config.serverUrl,
        `/api/v1/chat/${encodeURIComponent(resolvedChatGuid)}/typing`,
        config.password,
      )
      const requestTimeoutSignal = AbortSignal.timeout(channelConfig.requestTimeoutMs)
      const response = await fetch(url, {
        method: typing ? "POST" : "DELETE",
        signal: signal ? AbortSignal.any([signal, requestTimeoutSignal]) : requestTimeoutSignal,
      })
      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        throw new Error(`BlueBubbles typing failed (${response.status}): ${errorText || "unknown"}`)
      }
    },

    async markChatRead(chat: BlueBubblesChatRef, signal?: AbortSignal): Promise<void> {
      const resolvedChatGuid = await resolveChatGuid(chat, config, channelConfig)
      if (!resolvedChatGuid) {
        return
      }
      const url = buildBlueBubblesApiUrl(
        config.serverUrl,
        `/api/v1/chat/${encodeURIComponent(resolvedChatGuid)}/read`,
        config.password,
      )
      const requestTimeoutSignal = AbortSignal.timeout(channelConfig.requestTimeoutMs)
      const response = await fetch(url, {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, requestTimeoutSignal]) : requestTimeoutSignal,
      })
      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        throw new Error(`BlueBubbles read failed (${response.status}): ${errorText || "unknown"}`)
      }
    },

    async checkHealth(): Promise<void> {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_healthcheck_start",
        message: "probing bluebubbles upstream health",
        meta: { serverUrl: config.serverUrl },
      })
      const result = await probeBlueBubblesHealth({
        serverUrl: config.serverUrl,
        password: config.password,
        requestTimeoutMs: channelConfig.requestTimeoutMs,
        fetchImpl: fetch,
      })
      if (!result.ok) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_healthcheck_error",
          message: "bluebubbles upstream health probe failed",
          meta: {
            serverUrl: config.serverUrl,
            status: result.status,
            reason: result.reason,
            classification: result.classification,
            detail: redactBlueBubblesHealthDetailForNerves(result.detail),
          },
        })
        throw new Error(result.detail)
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_healthcheck_end",
        message: "bluebubbles upstream health probe succeeded",
        meta: { serverUrl: config.serverUrl },
      })
    },

    async queryRecentMessagesWithMetadata(
      params: BlueBubblesListRecentMessagesParams = {},
    ): Promise<BlueBubblesMessageQueryResult> {
      const limit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 50)))
      const offset = Math.max(0, Math.floor(params.offset ?? 0))
      const url = buildBlueBubblesApiUrl(config.serverUrl, "/api/v1/message/query", config.password)

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_query_recent_start",
        message: "querying recent bluebubbles messages",
        meta: { limit, offset },
      })

      const request: BlueBubblesMessageQueryResult["request"] = {
        limit,
        offset,
        sort: "DESC",
        ...(params.chatGuid?.trim() ? { chatGuid: params.chatGuid.trim() } : {}),
        ...(params.chatIdentifier?.trim() ? { chatIdentifier: params.chatIdentifier.trim() } : {}),
        ...(typeof params.beforeTimestamp === "number" && Number.isFinite(params.beforeTimestamp)
          ? { beforeTimestamp: params.beforeTimestamp }
          : {}),
      }
      const { beforeTimestamp, ...wireRequest } = request
      const body = {
        ...wireRequest,
        // BlueBubbles names its inclusive message-date upper bound `before`.
        ...(beforeTimestamp !== undefined ? { before: beforeTimestamp } : {}),
        with: ["chats", "attachments", "payloadData", "messageSummaryInfo"],
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_query_recent_error",
          message: "bluebubbles recent message query failed",
          meta: {
            status: response.status,
            reason: errorText || "unknown",
          },
        })
        throw new Error(`BlueBubbles recent message query failed (${response.status}): ${errorText || "unknown"}`)
      }

      const payload = await parseJsonBody(response)
      const rows = extractMessageQueryRows(payload)
      const invalidCausalTimestampRowCount = rows.filter((row) => !hasValidRawMessageCausalTimestamp(row)).length
      const messages: BlueBubblesNormalizedEvent[] = []
      for (const row of rows) {
        try {
          messages.push(normalizeBlueBubblesEvent({ type: "new-message", data: row }))
        } catch (error) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_query_recent_skip",
            message: "skipped unusable bluebubbles recent message row",
            meta: {
              reason: describeCaughtValue(error),
            },
          })
        }
      }

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_query_recent_end",
        message: "queried recent bluebubbles messages",
        meta: {
          rows: rows.length,
          normalized: messages.length,
          skipped: rows.length - messages.length,
        },
      })

      return {
        messages,
        rawRowCount: rows.length,
        normalizedRowCount: messages.length,
        skippedRowCount: rows.length - messages.length,
        invalidCausalTimestampRowCount,
        request,
      }
    },

    async listRecentMessages(params: BlueBubblesListRecentMessagesParams = {}): Promise<BlueBubblesNormalizedEvent[]> {
      const result = await this.queryRecentMessagesWithMetadata!(params)
      return result.messages
    },

    async repairEvent(event: BlueBubblesNormalizedEvent): Promise<BlueBubblesNormalizedEvent> {
      if (!event.requiresRepair) {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_repair_skipped",
          message: "bluebubbles event repair skipped",
          meta: {
            kind: event.kind,
            messageGuid: event.messageGuid,
          },
        })
        return event
      }

      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_repair_start",
        message: "repairing bluebubbles event by guid",
        meta: {
          kind: event.kind,
          messageGuid: event.messageGuid,
          eventType: event.eventType,
        },
      })

      const url = buildRepairUrl(config.serverUrl, event.messageGuid, config.password)

      try {
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => "")
          const repaired = applyRepairNotice(
            event,
            `BlueBubbles repair failed: ${errorText || `HTTP ${response.status}`}`,
          )
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_repair_error",
            message: "bluebubbles repair request failed",
            meta: {
              messageGuid: event.messageGuid,
              status: response.status,
              reason: errorText || "unknown",
            },
          })
          return repaired
        }

        const payload = await parseJsonBody(response)
        const data = extractRepairData(payload)
        if (!data || typeof data.guid !== "string") {
          const repaired = applyRepairNotice(event, "BlueBubbles repair failed: invalid message payload")
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_repair_error",
            message: "bluebubbles repair returned unusable payload",
            meta: {
              messageGuid: event.messageGuid,
            },
          })
          return repaired
        }

        const normalized = normalizeBlueBubblesEvent({
          type: event.eventType,
          data,
        })
        const recoveredMessage = event.kind === "mutation"
          && !event.shouldNotifyAgent
          ? normalizeBlueBubblesEvent({
              type: "new-message",
              data,
            })
          : null
        let hydrated = recoveredMessage && hasRecoverableMessageContent(recoveredMessage)
          ? hydrateTextForAgent(recoveredMessage, data)
          : hydrateTextForAgent(normalized, data)
        if (
          hydrated.kind === "message" &&
          hydrated.balloonBundleId !== "com.apple.messages.URLBalloonProvider" &&
          hydrated.attachments.length > 0
        ) {
          const agentConfig = loadAgentConfig()
          const chatModel: string = agentConfig.humanFacing.model
          const chatProvider: string = agentConfig.humanFacing.provider
          const vlmDescribe: VlmDescribeFn = async (params) => {
            if (chatProvider !== "minimax") {
              throw new Error(
                "VLM fallback requires a minimax credential for this agent — " +
                "configure one or switch to a vision-capable chat model",
              )
            }
            const { readProviderCredentialRecord } = await import("../../heart/provider-credentials")
            const credential = await readProviderCredentialRecord(getAgentName(), "minimax")
            const apiKey = credential.ok ? credential.record.credentials.apiKey : undefined
            if (!apiKey) {
              throw new Error(
                "VLM fallback: minimax API key not found in the agent vault — " +
                "run `ouro auth --agent <agent> --provider minimax`",
              )
            }
            return minimaxVlmDescribe({
              apiKey: String(apiKey),
              prompt: params.prompt,
              imageDataUrl: params.imageDataUrl,
              baseURL: MINIMAX_PROVIDER_BASE_URL,
              attachmentGuid: params.attachmentGuid,
              mimeType: params.mimeType,
              chatModel: params.chatModel,
            })
          }
          // VLM prompt context wants the user's raw inbound text — NOT
          // the agent-facing rendering, which now carries the attachment
          // marker after the B2 fix. Pull it from the source payload.
          const rawUserText =
            typeof (data as { text?: unknown }).text === "string"
              ? ((data as { text: string }).text).trim()
              : ""
          const media = await hydrateBlueBubblesAttachments(
            hydrated.attachments,
            config,
            channelConfig,
            {
              preferAudioInput: providerSupportsAudioInput(chatProvider),
              chatModel,
              vlmDescribe,
              userText: rawUserText,
            },
          )
          const transcriptSuffix = media.transcriptAdditions.map((entry) => `[${entry}]`).join("\n")
          const noticeSuffix = media.notices.map((entry) => `[${entry}]`).join("\n")
          const combinedSuffix = [transcriptSuffix, noticeSuffix].filter(Boolean).join("\n")
          hydrated = {
            ...hydrated,
            inputPartsForAgent: media.inputParts.length > 0 ? media.inputParts : undefined,
            textForAgent: [hydrated.textForAgent, combinedSuffix].filter(Boolean).join("\n"),
          }
        }
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_repair_end",
          message: "bluebubbles event repaired",
          meta: {
            kind: hydrated.kind,
            messageGuid: hydrated.messageGuid,
            repairedFrom: event.kind,
            promotedFromMutation: event.kind === "mutation" && hydrated.kind === "message",
          },
        })
        return hydrated
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_repair_error",
          message: "bluebubbles repair threw",
          meta: {
            messageGuid: event.messageGuid,
            reason,
          },
        })
        return applyRepairNotice(event, `BlueBubbles repair failed: ${reason}`)
      }

    },

    async getMessageText(messageGuid: string): Promise<string | null> {
      const url = buildRepairUrl(config.serverUrl, messageGuid, config.password)
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
        })
        if (!response.ok) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_get_message_text_error",
            message: "failed to fetch message text",
            meta: { messageGuid, status: response.status },
          })
          return null
        }
        const payload = await parseJsonBody(response)
        const data = extractRepairData(payload)
        if (!data || typeof data.text !== "string") {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_get_message_text_error",
            message: "message payload missing text field",
            meta: { messageGuid, hasData: !!data, textType: data ? typeof data.text : "n/a" },
          })
          return null
        }
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_get_message_text",
          message: "fetched message text by guid",
          meta: { messageGuid },
        })
        return data.text.trim() || null
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_get_message_text_error",
          message: "exception fetching message text",
          meta: { messageGuid, reason: error instanceof Error ? error.message : String(error) },
        })
        return null
      }
    },

  }
}
