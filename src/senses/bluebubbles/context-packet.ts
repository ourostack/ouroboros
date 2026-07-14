import { createHash } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  buildSenseContextPacket,
  renderSenseContextPacketForPrompt,
  type RenderedSenseContextPacket,
  type SenseContextPacket,
  type SenseContextPacketInputMessage,
} from "../context-packets"
import type { BlueBubblesClient } from "./client"
import type { BlueBubblesNormalizedMessage } from "./model"

export const BLUEBUBBLES_CONTEXT_PACKET_LIMIT = 40
export const BLUEBUBBLES_CONTEXT_PACKET_MAX_AGE_MS = 48 * 60 * 60 * 1000

export interface BlueBubblesContextPacketBuildResult {
  packet: SenseContextPacket
  rendered: RenderedSenseContextPacket
  historyCount: number
}

export interface BuildBlueBubblesContextPacketInput {
  agentName: string
  client: Pick<BlueBubblesClient, "listRecentMessages">
  event: BlueBubblesNormalizedMessage
  knownMessageTexts?: string[]
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export function blueBubblesContextChatKey(event: BlueBubblesNormalizedMessage): string {
  return event.chat.chatGuid ?? event.chat.chatIdentifier ?? event.chat.sessionKey
}

export function blueBubblesContextChatKeyHash(event: BlueBubblesNormalizedMessage): string {
  return sha256Hex(blueBubblesContextChatKey(event))
}

function isSameBlueBubblesChat(candidate: BlueBubblesNormalizedMessage, anchor: BlueBubblesNormalizedMessage): boolean {
  return candidate.chat.sessionKey === anchor.chat.sessionKey
    || (!!candidate.chat.chatGuid && candidate.chat.chatGuid === anchor.chat.chatGuid)
    || (!!candidate.chat.chatIdentifier && candidate.chat.chatIdentifier === anchor.chat.chatIdentifier)
}

function contextAuthorLabel(event: BlueBubblesNormalizedMessage): string {
  if (event.fromMe) return "Slugger"
  return event.sender.displayName || event.sender.externalId || "Unknown"
}

function messageToContextInput(
  event: BlueBubblesNormalizedMessage,
  chatGuidHash: string,
): SenseContextPacketInputMessage {
  return {
    timestamp: new Date(event.timestamp).toISOString(),
    authorLabel: contextAuthorLabel(event),
    body: event.textForAgent || event.text,
    sourceRef: {
      sense: "bluebubbles",
      adapter: "bluebubbles-api-v1",
      service: "imessage",
      chatGuid: event.chat.chatGuid,
      chatGuidHash,
      messageGuid: event.messageGuid,
      senderExternalIdHash: sha256Hex(event.sender.externalId || event.sender.rawId || "unknown"),
      observedAt: new Date(event.timestamp).toISOString(),
    },
  }
}

function normalizeKnownMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function hasKnownMessageText(candidate: BlueBubblesNormalizedMessage, knownTexts: Set<string>): boolean {
  if (knownTexts.size === 0) return false
  const body = normalizeKnownMessageText(candidate.textForAgent || candidate.text)
  if (!body) return true
  if (knownTexts.has(body)) return true
  for (const known of knownTexts) {
    if (body.length >= 12 && known.includes(body)) return true
  }
  return false
}

export async function buildBlueBubblesContextPacket(
  input: BuildBlueBubblesContextPacketInput,
): Promise<BlueBubblesContextPacketBuildResult | null> {
  if (!Number.isFinite(input.event.timestamp)) return null
  if (!input.client.listRecentMessages) return null
  const event = input.event
  const chatGuidHash = blueBubblesContextChatKeyHash(event)
  const anchorTimestamp = new Date(event.timestamp).toISOString()
  const knownTexts = new Set(
    (input.knownMessageTexts ?? [])
      .map(normalizeKnownMessageText)
      .filter((value) => value.length > 0),
  )
  const candidates = await input.client.listRecentMessages({
    beforeTimestamp: event.timestamp,
    limit: BLUEBUBBLES_CONTEXT_PACKET_LIMIT,
    offset: 0,
    ...(event.chat.chatGuid ? { chatGuid: event.chat.chatGuid } : {}),
    ...(!event.chat.chatGuid && event.chat.chatIdentifier ? { chatIdentifier: event.chat.chatIdentifier } : {}),
  })
  const history = candidates
    .filter((candidate): candidate is BlueBubblesNormalizedMessage => candidate.kind === "message")
    .filter((candidate) => isSameBlueBubblesChat(candidate, event))
    .filter((candidate) => candidate.messageGuid !== event.messageGuid)
    .filter((candidate) => candidate.timestamp <= event.timestamp)
    .filter((candidate) => event.timestamp - candidate.timestamp <= BLUEBUBBLES_CONTEXT_PACKET_MAX_AGE_MS)
    .filter((candidate) => !hasKnownMessageText(candidate, knownTexts))
  if (history.length === 0) return null
  const packet = buildSenseContextPacket({
    agent: input.agentName,
    sense: "bluebubbles",
    sessionKey: event.chat.sessionKey,
    chatKeyHash: chatGuidHash,
    anchorMessageGuid: event.messageGuid,
    anchorTimestamp,
    windowBeforeMessages: BLUEBUBBLES_CONTEXT_PACKET_LIMIT,
    windowBeforeMs: BLUEBUBBLES_CONTEXT_PACKET_MAX_AGE_MS,
    messages: history.map((candidate) => messageToContextInput(candidate, chatGuidHash)),
  })
  const rendered = renderSenseContextPacketForPrompt(packet, {
    redactionPatterns: [/password=[^\s]+/gi],
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_context_packet_built",
    message: "built bluebubbles same-chat context packet",
    meta: {
      packetId: packet.packetId,
      messageGuid: event.messageGuid,
      contextMessages: history.length,
      renderedMessages: rendered.stats.renderedMessages,
    },
  })
  return {
    packet,
    rendered,
    historyCount: history.length,
  }
}
