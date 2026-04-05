import OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"

type JsonRecord = Record<string, unknown>

export type BlueBubblesAttachmentSummary = {
  guid?: string
  mimeType?: string
  transferName?: string
  totalBytes?: number
  height?: number
  width?: number
}

export type BlueBubblesSenderRef = {
  provider: "imessage-handle"
  externalId: string
  rawId: string
  displayName: string
}

export type BlueBubblesSendTarget =
  | { kind: "chat_guid"; value: string }
  | { kind: "chat_identifier"; value: string }

export type BlueBubblesChatRef = {
  chatGuid?: string
  chatIdentifier?: string
  displayName?: string
  isGroup: boolean
  sessionKey: string
  sendTarget: BlueBubblesSendTarget
  /** Normalized participant handles (addresses) from the chat, if available. */
  participantHandles: string[]
}

export type BlueBubblesNormalizedMessage = {
  kind: "message"
  eventType: string
  messageGuid: string
  timestamp: number
  fromMe: boolean
  sender: BlueBubblesSenderRef
  chat: BlueBubblesChatRef
  text: string
  textForAgent: string
  attachments: BlueBubblesAttachmentSummary[]
  balloonBundleId?: string
  hasPayloadData: boolean
  requiresRepair: boolean
  repairNotice?: string
  inputPartsForAgent?: OpenAI.Chat.ChatCompletionContentPart[]
  threadOriginatorGuid?: string
  replyToGuid?: string
}

export type BlueBubblesMutationType = "reaction" | "edit" | "unsend" | "read" | "delivery"

export type BlueBubblesNormalizedMutation = {
  kind: "mutation"
  eventType: string
  mutationType: BlueBubblesMutationType
  messageGuid: string
  targetMessageGuid?: string
  timestamp: number
  fromMe: boolean
  sender: BlueBubblesSenderRef
  chat: BlueBubblesChatRef
  shouldNotifyAgent: boolean
  textForAgent: string
  requiresRepair: boolean
  repairNotice?: string
}

export type BlueBubblesNormalizedEvent =
  | BlueBubblesNormalizedMessage
  | BlueBubblesNormalizedMutation

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function readString(record: JsonRecord | null, key: string): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function readNumber(record: JsonRecord | null, key: string): number | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

function normalizeHandle(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  if (trimmed.includes("@")) return trimmed.toLowerCase()
  const compact = trimmed.replace(/[^\d+]/g, "")
  return compact || trimmed
}

function extractChatIdentifierFromGuid(chatGuid?: string): string | undefined {
  if (!chatGuid) return undefined
  const parts = chatGuid.split(";")
  return parts.length >= 3 ? parts[2]?.trim() || undefined : undefined
}

function buildChatRef(data: JsonRecord, threadOriginatorGuid?: string): BlueBubblesChatRef {
  void threadOriginatorGuid
  const chats = Array.isArray(data.chats) ? data.chats : []
  const chat = asRecord(chats[0]) ?? null
  const chatGuid = readString(chat, "guid")
  const chatIdentifier =
    readString(chat, "chatIdentifier") ??
    readString(chat, "identifier") ??
    extractChatIdentifierFromGuid(chatGuid)
  const displayName = readString(chat, "displayName")?.trim() || undefined
  const style = readNumber(chat, "style")
  const isGroup = style === 43 || (chatGuid?.includes(";+;") ?? false) || Boolean(displayName)
  const sessionKey = chatGuid?.trim()
    ? `chat:${chatGuid.trim()}`
    : `chat_identifier:${(chatIdentifier ?? "unknown").trim()}`

  // Extract participant handles from chat.participants (when available from BB API)
  const rawParticipants = Array.isArray(chat?.participants) ? chat.participants : []
  const participantHandles = rawParticipants
    .map((p) => {
      const rec = asRecord(p)
      const addr = readString(rec, "address") ?? readString(rec, "id")
      return addr ? normalizeHandle(addr) : ""
    })
    .filter(Boolean)

  return {
    chatGuid: chatGuid?.trim() || undefined,
    chatIdentifier: chatIdentifier?.trim() || undefined,
    displayName,
    isGroup,
    sessionKey,
    sendTarget: chatGuid?.trim()
      ? { kind: "chat_guid", value: chatGuid.trim() }
      : { kind: "chat_identifier", value: (chatIdentifier ?? "unknown").trim() },
    participantHandles,
  }
}

function extractSender(data: JsonRecord, chat: BlueBubblesChatRef): BlueBubblesSenderRef {
  const handle = asRecord(data.handle) ?? asRecord(data.sender) ?? null
  const rawId =
    readString(handle, "address") ??
    readString(handle, "id") ??
    readString(data, "senderId") ??
    chat.chatIdentifier ??
    chat.chatGuid ??
    "unknown"
  const externalId = normalizeHandle(rawId)
  const displayName = externalId || rawId || "Unknown"
  return {
    provider: "imessage-handle",
    externalId,
    rawId,
    displayName,
  }
}

function extractAttachments(data: JsonRecord): BlueBubblesAttachmentSummary[] {
  const raw = Array.isArray(data.attachments) ? data.attachments : []
  return raw
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null)
    .map((entry) => ({
      guid: readString(entry, "guid"),
      mimeType: readString(entry, "mimeType"),
      transferName: readString(entry, "transferName"),
      totalBytes: readNumber(entry, "totalBytes"),
      height: readNumber(entry, "height"),
      width: readNumber(entry, "width"),
    }))
}

function formatAttachmentText(attachments: BlueBubblesAttachmentSummary[]): string {
  if (attachments.length === 0) return ""
  const [first] = attachments
  const mime = first.mimeType ?? ""
  const label = mime.startsWith("image/")
    ? "image attachment"
    : mime.startsWith("audio/")
      ? "audio attachment"
      : "attachment"
  const name = first.transferName ? `: ${first.transferName}` : ""
  const dimensions =
    typeof first.width === "number" && typeof first.height === "number" && first.width > 0 && first.height > 0
      ? ` (${first.width}x${first.height})`
      : ""
  return `[${label}${name}${dimensions}]`
}

function formatMessageText(data: JsonRecord, attachments: BlueBubblesAttachmentSummary[]): string {
  const text = readString(data, "text")?.trim() ?? ""
  const balloonBundleId = readString(data, "balloonBundleId")?.trim()
  if (text) {
    if (balloonBundleId === "com.apple.messages.URLBalloonProvider") {
      return `${text}\n[link preview attached]`
    }
    return text
  }
  return formatAttachmentText(attachments)
}

function normalizeReactionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.toLowerCase() : undefined
}

function stripPartPrefix(guid?: string): string | undefined {
  if (!guid) return undefined
  const trimmed = guid.trim()
  const marker = trimmed.lastIndexOf("/")
  return marker >= 0 ? trimmed.slice(marker + 1) : trimmed
}

function buildMutationText(
  mutationType: BlueBubblesMutationType,
  data: JsonRecord,
  reactionName?: string,
): string {
  if (mutationType === "reaction") {
    return `reacted with ${reactionName}`
  }
  if (mutationType === "edit") {
    const editedText = readString(data, "text")?.trim() ?? ""
    return editedText ? `edited message: ${editedText}` : "edited a message"
  }
  if (mutationType === "unsend") {
    return "unsent a message"
  }
  if (mutationType === "read") {
    return "message marked as read"
  }
  return "message marked as delivered"
}

function detectMutationType(
  eventType: string,
  data: JsonRecord,
  reactionName?: string,
): BlueBubblesMutationType | null {
  if (reactionName) return "reaction"
  if (eventType === "updated-message") {
    if (readNumber(data, "dateRetracted")) return "unsend"
    if (readNumber(data, "dateEdited")) return "edit"
    if (readNumber(data, "dateRead")) return "read"
    if (readBoolean(data, "isDelivered") || readNumber(data, "dateDelivered")) return "delivery"
  }
  return null
}

export function normalizeBlueBubblesEvent(payload: unknown): BlueBubblesNormalizedEvent {
  const envelope = asRecord(payload)
  const eventType = readString(envelope, "type")?.trim() ?? ""
  const data = asRecord(envelope?.data)
  if (!eventType || !data) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_event_ignored",
      message: "ignored invalid bluebubbles payload",
      meta: { hasEnvelope: Boolean(envelope), eventType },
    })
    throw new Error("Invalid BlueBubbles payload")
  }

  const messageGuid = readString(data, "guid")?.trim()
  if (!messageGuid) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_event_ignored",
      message: "ignored bluebubbles payload without guid",
      meta: { eventType },
    })
    throw new Error("BlueBubbles payload is missing data.guid")
  }

  const threadOriginatorGuid = readString(data, "threadOriginatorGuid")?.trim() || undefined
  const chat = buildChatRef(data, threadOriginatorGuid)
  const sender = extractSender(data, chat)
  const timestamp = readNumber(data, "dateCreated") ?? Date.now()
  const fromMe = readBoolean(data, "isFromMe") ?? false
  const attachments = extractAttachments(data)
  const reactionName = normalizeReactionName(data.associatedMessageType)
  const mutationType = detectMutationType(eventType, data, reactionName)
  const requiresRepair =
    (readBoolean(data, "hasPayloadData") ?? false) ||
    attachments.length > 0 ||
    eventType === "updated-message"

  const result: BlueBubblesNormalizedEvent = mutationType
    ? {
        kind: "mutation",
        eventType,
        mutationType,
        messageGuid,
        targetMessageGuid:
          mutationType === "reaction"
            ? stripPartPrefix(readString(data, "associatedMessageGuid"))
            : undefined,
        timestamp,
        fromMe,
        sender,
        chat,
        shouldNotifyAgent: mutationType === "reaction" || mutationType === "edit" || mutationType === "unsend",
        textForAgent: buildMutationText(mutationType, data, reactionName),
        requiresRepair,
      }
    : {
        kind: "message",
        eventType,
        messageGuid,
        timestamp,
        fromMe,
        sender,
        chat,
        text: readString(data, "text")?.trim() ?? "",
        textForAgent: formatMessageText(data, attachments),
        attachments,
        balloonBundleId: readString(data, "balloonBundleId")?.trim() || undefined,
        hasPayloadData: readBoolean(data, "hasPayloadData") ?? false,
        requiresRepair,
        threadOriginatorGuid,
        replyToGuid: threadOriginatorGuid,
      }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_event_normalized",
    message: "normalized bluebubbles event",
    meta: {
      eventType,
      kind: result.kind,
      mutationType: result.kind === "mutation" ? result.mutationType : null,
      sessionKey: result.chat.sessionKey,
      fromMe,
    },
  })

  return result
}
