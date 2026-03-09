import { randomUUID } from "node:crypto"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig } from "../heart/config"
import { loadAgentConfig } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { normalizeBlueBubblesEvent, type BlueBubblesChatRef, type BlueBubblesNormalizedEvent } from "./bluebubbles-model"
import { hydrateBlueBubblesAttachments } from "./bluebubbles-media"

export interface BlueBubblesSendTextParams {
  chat: BlueBubblesChatRef
  text: string
  replyToMessageGuid?: string
}

export interface BlueBubblesSendTextResult {
  messageGuid?: string
}

export interface BlueBubblesClient {
  sendText(params: BlueBubblesSendTextParams): Promise<BlueBubblesSendTextResult>
  repairEvent(event: BlueBubblesNormalizedEvent): Promise<BlueBubblesNormalizedEvent>
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
  return provider === "azure" || provider === "openai-codex"
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
      const resolvedChatGuid = params.chat.chatGuid
        ?? await resolveChatGuidForIdentifier(config, channelConfig, params.chat.chatIdentifier ?? "")
      if (!resolvedChatGuid) {
        throw new Error("BlueBubbles send currently requires chat.chatGuid from the inbound event.")
      }

      const url = buildBlueBubblesApiUrl(config.serverUrl, "/api/v1/message/text", config.password)
      const body: Record<string, unknown> = {
        chatGuid: resolvedChatGuid,
        tempGuid: randomUUID(),
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

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.bluebubbles_send_error",
          message: "bluebubbles send failed",
          meta: {
            status: response.status,
            reason: errorText || "unknown",
          },
        })
        throw new Error(`BlueBubbles send failed (${response.status}): ${errorText || "unknown"}`)
      }

      const payload = await parseJsonBody(response)
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
        let hydrated = hydrateTextForAgent(normalized, data)
        if (
          hydrated.kind === "message" &&
          hydrated.balloonBundleId !== "com.apple.messages.URLBalloonProvider" &&
          hydrated.attachments.length > 0
        ) {
          const media = await hydrateBlueBubblesAttachments(
            hydrated.attachments,
            config,
            channelConfig,
            {
              preferAudioInput: providerSupportsAudioInput(loadAgentConfig().provider),
            },
          )
          const transcriptSuffix = media.transcriptAdditions.map((entry) => `[${entry}]`).join("\n")
          const noticeSuffix = media.notices.map((entry) => `[${entry}]`).join("\n")
          const combinedSuffix = [transcriptSuffix, noticeSuffix].filter(Boolean).join("\n")
          hydrated = {
            ...hydrated,
            inputPartsForAgent: media.inputParts.length > 0 ? media.inputParts : undefined,
            textForAgent: combinedSuffix
              ? `${hydrated.textForAgent}${hydrated.textForAgent ? "\n" : ""}${combinedSuffix}`
              : hydrated.textForAgent,
          }
        }
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_repair_end",
          message: "bluebubbles event repaired",
          meta: {
            kind: hydrated.kind,
            messageGuid: hydrated.messageGuid,
            repairedFrom: event.kind,
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
  }
}
