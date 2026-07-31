import OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { renderAttachmentBlock } from "../../heart/attachments/render"
import { buildBlueBubblesAttachmentRecord } from "../../heart/attachments/sources/bluebubbles"

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
  /** True only when the transport supplied the sender identity directly. */
  observed?: boolean
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

export type BlueBubblesReactionAction = "add" | "remove"

/**
 * A decoded iMessage tapback. `raw` is the `associatedMessageType` exactly as it
 * arrived (lowercased when it was a string); `verb`/`noun` are only present for
 * the six tapbacks iMessage actually defines, so unrecognized associated types
 * (stickers, future codes) degrade to naming the raw value instead of guessing.
 */
export type BlueBubblesReactionDescriptor = {
  raw: string
  rawTransportValue: string
  canonicalValue: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "custom" | "unknown"
  action: BlueBubblesReactionAction
  verb?: string
  noun?: string
}

/** What is known about the message a reaction points at, once resolution is attempted. */
export type BlueBubblesReactionTarget = {
  guid?: string
  text?: string | null
  /** true = the agent's own message, false = the other party's, null/undefined = unknown. */
  fromMe?: boolean | null
}

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
  /** Present for `mutationType: "reaction"` so senses can re-render once the target resolves. */
  reaction?: BlueBubblesReactionDescriptor
  /** Exact provider edit text; presentation text may be trimmed separately. */
  editedText?: string
  /** Exact trimmed provider revision, when supplied. */
  revision?: string
  /** Mutation-specific effective timestamp in epoch milliseconds. */
  effectiveTimestamp?: number
  /** Provider retraction timestamp retained separately for boundary evidence. */
  retractionTimestamp?: number
}

export type BlueBubblesNormalizedEvent =
  | BlueBubblesNormalizedMessage
  | BlueBubblesNormalizedMutation

const IGNORABLE_GUIDLESS_EVENT_TYPES = new Set([
  "chat-read-status-changed",
])

export class BlueBubblesIgnoredEventError extends Error {
  readonly eventType: string

  constructor(eventType: string, message: string) {
    super(message)
    this.name = "BlueBubblesIgnoredEventError"
    this.eventType = eventType
  }
}

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
  const observedRawId =
    readString(handle, "address") ??
    readString(handle, "id") ??
    readString(data, "senderId")
  const observed = typeof observedRawId === "string" && observedRawId.trim().length > 0
  const rawId =
    observedRawId ??
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
    observed,
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

  const renderable = attachments
    .filter((attachment) => typeof attachment.guid === "string" && attachment.guid.trim().length > 0)
    .map((attachment) => buildBlueBubblesAttachmentRecord(attachment))

  if (renderable.length > 0) {
    return renderAttachmentBlock(renderable)
  }

  const [first] = attachments
  return `[attachment: ${first.transferName?.trim() || "unknown"}]`
}

function formatMessageText(data: JsonRecord, attachments: BlueBubblesAttachmentSummary[]): string {
  const text = readString(data, "text")?.trim() ?? ""
  const balloonBundleId = readString(data, "balloonBundleId")?.trim()
  if (text) {
    if (balloonBundleId === "com.apple.messages.URLBalloonProvider") {
      return `${text}\n[link preview attached]`
    }
    // B2 fix: when text and attachments both exist, append the attachment
    // marker so downstream senses can see the guid/filename. Previously the
    // marker was dropped whenever text was non-empty, which hid images from
    // the agent when the user captioned a screenshot.
    if (attachments.length > 0) {
      return `${text}\n${formatAttachmentText(attachments)}`
    }
    return text
  }
  return formatAttachmentText(attachments)
}

function normalizeReactionName(value: unknown): string | undefined {
  // chat.db stores associated_message_type as an integer; BlueBubbles forwards it
  // as either the integer, its decimal string, or a name ("love", "-love").
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0 ? String(value) : undefined
  }
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.toLowerCase() : undefined
}

/**
 * iMessage tapbacks: associated_message_type 2000-2006 add a tapback, 3000-3006
 * remove the same tapback. BlueBubbles may send either the code or the name.
 */
const REACTION_VOCABULARY: ReadonlyArray<{
  code: number
  name: Exclude<BlueBubblesReactionDescriptor["canonicalValue"], "unknown">
  verb: string
  noun: string
}> = [
  { code: 2000, name: "love", verb: "loved", noun: "love" },
  { code: 2001, name: "like", verb: "liked", noun: "like" },
  { code: 2002, name: "dislike", verb: "disliked", noun: "dislike" },
  { code: 2003, name: "laugh", verb: "laughed at", noun: "laugh" },
  { code: 2004, name: "emphasize", verb: "emphasized", noun: "emphasis" },
  { code: 2005, name: "question", verb: "questioned", noun: "question" },
  { code: 2006, name: "custom", verb: "reacted with custom emoji to", noun: "custom emoji" },
]

const REACTION_EXCERPT_MAX_LENGTH = 80

export function describeBlueBubblesReaction(
  raw: string,
  rawTransportValue: string = raw,
): BlueBubblesReactionDescriptor {
  const stripped = raw.startsWith("-") ? raw.slice(1) : raw
  const code = /^\d+$/.test(stripped) ? Number(stripped) : undefined
  const removal = raw.startsWith("-") || (code !== undefined && code >= 3000 && code < 4000)
  const action: BlueBubblesReactionAction = removal ? "remove" : "add"
  const entry = REACTION_VOCABULARY.find((candidate) =>
    candidate.name === stripped || candidate.code === code || candidate.code + 1000 === code)
  const canonicalValue = entry?.name ?? "unknown"
  if (!entry) return { raw, rawTransportValue, canonicalValue, action }
  return {
    raw,
    rawTransportValue,
    canonicalValue,
    action,
    verb: entry.verb,
    noun: entry.noun,
  }
}

function reactionExcerpt(text: string): string {
  return text.length > REACTION_EXCERPT_MAX_LENGTH
    ? `${text.slice(0, REACTION_EXCERPT_MAX_LENGTH - 3)}...`
    : text
}

function reactionTargetPhrase(target: BlueBubblesReactionTarget): string {
  const text = target.text?.trim()
  if (text) {
    const owner = target.fromMe === true ? "your" : target.fromMe === false ? "their" : "a"
    return `${owner} message: "${reactionExcerpt(text)}"`
  }
  // Never hand the agent a bare "reacted with love" stub — say plainly that the
  // referent is missing so it can ask instead of guessing what was approved.
  return target.guid
    ? `an unidentified message (target guid ${target.guid}; its text could not be resolved)`
    : "an unidentified message (the reaction carried no target message reference)"
}

/**
 * Render a reaction as speech the agent can act on: what the tapback was, whether
 * it was added or removed, and which message it points at.
 */
export function renderBlueBubblesReactionText(
  reaction: BlueBubblesReactionDescriptor,
  target: BlueBubblesReactionTarget,
): string {
  const phrase = reactionTargetPhrase(target)
  if (reaction.action === "remove") {
    const noun = reaction.noun ?? reaction.raw.replace(/^-/, "")
    return `removed their ${noun} reaction from ${phrase}`
  }
  return reaction.verb
    ? `${reaction.verb} ${phrase}`
    : `reacted with ${reaction.raw} to ${phrase}`
}

function stripPartPrefix(guid?: string): string | undefined {
  if (!guid) return undefined
  const trimmed = guid.trim()
  const marker = trimmed.lastIndexOf("/")
  return marker >= 0 ? trimmed.slice(marker + 1) : trimmed
}

// Reactions never reach here: `detectMutationType` returns "reaction" only when a
// reaction name was decoded, and that same name produces the descriptor the caller
// renders with `renderBlueBubblesReactionText` instead.
function buildMutationText(
  mutationType: BlueBubblesMutationType,
  data: JsonRecord,
): string {
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
    if (readNumber(data, "dateRetracted") !== undefined) return "unsend"
    if (readNumber(data, "dateEdited") !== undefined) return "edit"
    if (readNumber(data, "dateRead") !== undefined) return "read"
    if (readBoolean(data, "isDelivered") || readNumber(data, "dateDelivered") !== undefined) return "delivery"
  }
  return null
}

function readProviderRevision(data: JsonRecord): string | undefined {
  const value = data.revision
  if (typeof value !== "string" && typeof value !== "number") return undefined
  const normalized = String(value).trim()
  return normalized || undefined
}

function mutationEffectiveTimestamp(
  mutationType: BlueBubblesMutationType,
  data: JsonRecord,
): number | undefined {
  if (mutationType === "reaction") return readNumber(data, "dateCreated")
  if (mutationType === "edit") return readNumber(data, "dateEdited")
  if (mutationType === "unsend") return readNumber(data, "dateRetracted")
  if (mutationType === "read") return readNumber(data, "dateRead")
  return readNumber(data, "dateDelivered")
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
    if (IGNORABLE_GUIDLESS_EVENT_TYPES.has(eventType)) {
      throw new BlueBubblesIgnoredEventError(
        eventType,
        `Ignored BlueBubbles event '${eventType}' without data.guid`,
      )
    }
    throw new Error("BlueBubbles payload is missing data.guid")
  }

  const threadOriginatorGuid = readString(data, "threadOriginatorGuid")?.trim() || undefined
  const chat = buildChatRef(data, threadOriginatorGuid)
  const sender = extractSender(data, chat)
  const timestamp = readNumber(data, "dateCreated") ?? Date.now()
  const fromMe = readBoolean(data, "isFromMe") ?? false
  const attachments = extractAttachments(data)
  const reactionName = normalizeReactionName(data.associatedMessageType)
  const reaction = reactionName
    ? describeBlueBubblesReaction(reactionName, String(data.associatedMessageType))
    : undefined
  const targetMessageGuid = reaction
    ? stripPartPrefix(readString(data, "associatedMessageGuid"))
    : undefined
  const mutationType = detectMutationType(eventType, data, reactionName)
  const revision = mutationType ? readProviderRevision(data) : undefined
  const effectiveTimestamp = mutationType
    ? mutationEffectiveTimestamp(mutationType, data)
    : undefined
  const editedText = mutationType === "edit" ? readString(data, "text") : undefined
  const retractionTimestamp = mutationType === "unsend"
    ? readNumber(data, "dateRetracted")
    : undefined
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
        targetMessageGuid,
        timestamp,
        fromMe,
        sender,
        chat,
        shouldNotifyAgent: mutationType === "reaction" || mutationType === "edit" || mutationType === "unsend",
        textForAgent: reaction
          ? renderBlueBubblesReactionText(reaction, { guid: targetMessageGuid })
          : buildMutationText(mutationType, data),
        requiresRepair,
        ...(reaction ? { reaction } : {}),
        ...(editedText !== undefined ? { editedText } : {}),
        ...(revision ? { revision } : {}),
        ...(effectiveTimestamp !== undefined ? { effectiveTimestamp } : {}),
        ...(retractionTimestamp !== undefined ? { retractionTimestamp } : {}),
      }
    : {
        kind: "message",
        eventType,
        messageGuid,
        timestamp,
        fromMe,
        sender,
        chat,
        text: readString(data, "text") ?? "",
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
