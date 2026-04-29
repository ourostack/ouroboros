import type { TrustLevel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import {
  bestEventTimestamp,
  extractEventText,
  formatSessionEventTimestamp,
  loadFullEventHistory,
  loadSessionEnvelopeFile,
  type SessionEvent,
  type SessionEventToolCall,
} from "./session-events"

export interface SessionTailOptions {
  sessionPath: string
  friendId: string
  channel: string
  key: string
  messageCount: number
  summarize?: (transcript: string, instruction: string) => Promise<string>
  trustLevel?: TrustLevel
  archiveFallback?: boolean
}

export type SessionTailResult =
  | { kind: "missing" }
  | { kind: "empty" }
  | {
    kind: "ok"
    transcript: string
    summary: string
    snapshot: string
    tailMessages: Array<{ id: string; role: string; content: string; timestamp: string }>
  }

export interface SessionSearchOptions {
  sessionPath: string
  friendId: string
  channel: string
  key: string
  query: string
  maxMatches?: number
}

export type SessionSearchResult =
  | { kind: "missing" }
  | { kind: "empty" }
  | {
    kind: "no_match"
    query: string
    snapshot: string
  }
  | {
    kind: "ok"
    query: string
    snapshot: string
    matches: string[]
  }

interface TranscriptContext {
  friendId: string
  channel: string
  key: string
  includeToolMessages?: boolean
}

function shouldIncludeToolMessages(friendId: string, channel: string): boolean {
  return friendId === "self" && channel === "inner"
}

function sortEventsForTranscript(events: SessionEvent[]): SessionEvent[] {
  return [...events].sort((a, b) => {
    const byTime = Date.parse(bestEventTimestamp(a)) - Date.parse(bestEventTimestamp(b))
    return byTime === 0 ? a.sequence - b.sequence : byTime
  })
}

function parseToolArguments(toolCall: SessionEventToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function extractHumanVisibleToolText(event: SessionEvent, context: TranscriptContext): string {
  if (event.role !== "assistant" || event.toolCalls.length === 0) return ""

  for (const toolCall of event.toolCalls) {
    const args = parseToolArguments(toolCall)
    if (!args) continue

    if (toolCall.function.name === "settle" && typeof args.answer === "string") {
      return args.answer.trim()
    }

    if (toolCall.function.name === "send_message" && typeof args.content === "string") {
      const targetChannel = typeof args.channel === "string" ? args.channel : ""
      const targetFriendId = typeof args.friendId === "string" ? args.friendId : ""
      const targetKey = typeof args.key === "string" ? args.key : "session"
      if (targetChannel === context.channel && targetFriendId === context.friendId && targetKey === context.key) {
        return args.content.trim()
      }
    }
  }

  return ""
}

function normalizeSessionMessages(
  events: SessionEvent[],
  context: TranscriptContext,
): Array<{ id: string; role: string; content: string; timestamp: string }> {
  return sortEventsForTranscript(events)
    .map((event) => ({
      id: event.id,
      role: event.role,
      content: extractEventText(event) || extractHumanVisibleToolText(event, context),
      timestamp: formatSessionEventTimestamp(event),
    }))
    .filter((message) => {
      if (message.role === "system") return false
      if (message.role === "tool" && !context.includeToolMessages) return false
      return message.content.length > 0
    })
}

function buildSummaryInstruction(friendId: string, channel: string, trustLevel: TrustLevel): string {
  if (friendId === "self" && channel === "inner") {
    return "summarize this session transcript fully and transparently. this is my own inner dialog — include all details, decisions, and reasoning."
  }

  return `summarize this session transcript. the person asking has trust level: ${trustLevel}. family=full transparency, friend=share work and general topics but protect other people's identities, acquaintance=very guarded minimal disclosure.`
}

function clip(text: string, limit = 160): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > limit ? compact.slice(0, limit - 1) + "…" : compact
}

function buildSnapshot(summary: string, tailMessages: Array<{ id: string; role: string; content: string; timestamp: string }>): string {
  const lines = [`recent focus: ${clip(summary, 240)}`]
  const latestUser = [...tailMessages].reverse().find((message) => message.role === "user")?.content
  const latestAssistant = [...tailMessages].reverse().find((message) => message.role === "assistant")?.content

  if (latestUser) {
    lines.push(`latest user: ${clip(latestUser)}`)
  }
  if (latestAssistant) {
    lines.push(`latest assistant: ${clip(latestAssistant)}`)
  }

  return lines.join("\n")
}

function selectSessionTailMessages(
  messages: Array<{ id: string; role: string; content: string; timestamp: string }>,
  messageCount: number,
): Array<{ id: string; role: string; content: string; timestamp: string }> {
  const requestedCount = Number.isFinite(messageCount) && messageCount > 0 ? Math.floor(messageCount) : 20
  const tail = messages.slice(-requestedCount)
  const selectedIds = new Set(tail.map((message) => message.id))

  const latestUser = [...messages].reverse().find((message) => message.role === "user")
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  if (latestUser) selectedIds.add(latestUser.id)
  if (latestAssistant) selectedIds.add(latestAssistant.id)

  return messages.filter((message) => selectedIds.has(message.id))
}

function buildSearchSnapshot(
  query: string,
  messages: Array<{ id: string; role: string; content: string; timestamp: string }>,
  includeLatestTurn = true,
): string {
  const lines = [`history query: "${clip(query, 120)}"`]
  if (!includeLatestTurn) {
    return lines.join("\n")
  }
  const latestUser = [...messages].reverse().find((message) => message.role === "user")?.content
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.content

  if (latestUser) {
    lines.push(`latest user: ${clip(latestUser)}`)
  }
  if (latestAssistant) {
    lines.push(`latest assistant: ${clip(latestAssistant)}`)
  }

  return lines.join("\n")
}
function buildSearchExcerpts(
  messages: Array<{ id: string; role: string; content: string; timestamp: string }>,
  query: string,
  maxMatches: number,
): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  const candidates: Array<{ excerpt: string; signature: string; score: number; index: number }> = []
  let lastMatchIndex = -2

  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].content.toLowerCase().includes(normalizedQuery)) continue
    if (i <= lastMatchIndex + 1) continue
    lastMatchIndex = i

    const start = Math.max(0, i - 1)
    const end = Math.min(messages.length, i + 2)
    const excerpt = messages
      .slice(start, end)
      .map((message) => `[${message.timestamp} | ${message.role} | ${message.id}] ${clip(message.content, 200)}`)
      .join("\n")
    const signature = messages
      .slice(start, end)
      .map((message) => `[${message.role}] ${clip(message.content, 200)}`)
      .join("\n")
    const score = messages
      .slice(start, end)
      .filter((message) => message.content.toLowerCase().includes(normalizedQuery))
      .length

    candidates.push({ excerpt, signature, score, index: i })
  }

  const seen = new Set<string>()
  return candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter((candidate) => {
      if (seen.has(candidate.signature)) return false
      seen.add(candidate.signature)
      return true
    })
    .slice(0, maxMatches)
    .map((candidate) => candidate.excerpt)
}

export async function summarizeSessionTail(options: SessionTailOptions): Promise<SessionTailResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.session_tail_summary",
    message: "summarizing session transcript tail",
    meta: {
      friendId: options.friendId,
      channel: options.channel,
      key: options.key,
      messageCount: options.messageCount,
    },
  })

  const envelope = loadSessionEnvelopeFile(options.sessionPath)
  if (!envelope) return { kind: "missing" }

  const transcriptContext = {
    friendId: options.friendId,
    channel: options.channel,
    key: options.key,
    includeToolMessages: shouldIncludeToolMessages(options.friendId, options.channel),
  }
  let visibleMessages = normalizeSessionMessages(envelope.events, transcriptContext)
  if (options.archiveFallback && !visibleMessages.some((message) => message.role === "user")) {
    const fullHistoryMessages = normalizeSessionMessages(loadFullEventHistory(options.sessionPath), transcriptContext)
    if (fullHistoryMessages.length > 0) visibleMessages = fullHistoryMessages
  }

  const tailMessages = selectSessionTailMessages(visibleMessages, options.messageCount)

  if (tailMessages.length === 0) {
    return { kind: "empty" }
  }

  const transcript = tailMessages
    .map((message) => `[${message.timestamp} | ${message.role} | ${message.id}] ${message.content}`)
    .join("\n")

  const summary = options.summarize
    ? await options.summarize(
      transcript,
      buildSummaryInstruction(options.friendId, options.channel, options.trustLevel ?? "family"),
    )
    : transcript

  return {
    kind: "ok",
    transcript,
    summary,
    snapshot: buildSnapshot(summary, tailMessages),
    tailMessages,
  }
}

export async function searchSessionTranscript(options: SessionSearchOptions): Promise<SessionSearchResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.session_search",
    message: "searching session transcript",
    meta: {
      friendId: options.friendId,
      channel: options.channel,
      key: options.key,
      query: options.query,
      maxMatches: options.maxMatches ?? 5,
    },
  })

  // Use full event history (envelope + archive) for search to find older messages
  const allEvents = loadFullEventHistory(options.sessionPath)
  if (allEvents.length === 0) {
    const envelope = loadSessionEnvelopeFile(options.sessionPath)
    if (!envelope) return { kind: "missing" }
    return { kind: "empty" }
  }
  const messages = normalizeSessionMessages(allEvents, {
    friendId: options.friendId,
    channel: options.channel,
    key: options.key,
    includeToolMessages: shouldIncludeToolMessages(options.friendId, options.channel),
  })

  if (messages.length === 0) {
    return { kind: "empty" }
  }

  const query = options.query.trim()
  const matches = buildSearchExcerpts(messages, query, options.maxMatches ?? 5)

  if (matches.length === 0) {
    return {
      kind: "no_match",
      query,
      snapshot: buildSearchSnapshot(query, messages),
    }
  }

  return {
    kind: "ok",
    query,
    snapshot: buildSearchSnapshot(query, messages, false),
    matches,
  }
}
