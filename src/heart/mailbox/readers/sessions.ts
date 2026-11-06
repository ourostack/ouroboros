import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import { getAgentBundlesRoot } from "../../identity"
import {
  deriveSessionChronology,
  extractEventText,
  loadFullEventHistory,
  type SessionEvent,
} from "../../session-events"
import {
  type MailboxSessionContinuity,
  type MailboxSessionInventory,
  type MailboxSessionInventoryItem,
  type MailboxSessionTranscript,
  type MailboxSessionUsage,
  type MailboxTranscriptMessage,
} from "../mailbox-types"
import {
  STALE_THRESHOLD_MS,
  type MailboxReadOptions,
  readSessionEnvelope,
  resolveFriendName,
  safeFileMtime,
  safeIsDirectory,
  safeReaddir,
  truncateExcerpt,
} from "./shared"

/* v8 ignore start — session envelope parsing utilities */
function parseSessionUsage(raw: unknown): MailboxSessionUsage | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens : 0
  const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens : 0
  const reasoningTokens = typeof record.reasoning_tokens === "number" ? record.reasoning_tokens : 0
  const totalTokens = typeof record.total_tokens === "number" ? record.total_tokens : 0
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null
  return { input_tokens: inputTokens, output_tokens: outputTokens, reasoning_tokens: reasoningTokens, total_tokens: totalTokens }
}

function parseSessionContinuity(raw: unknown): MailboxSessionContinuity | null {
  if (!raw) return null
  if (typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const continuity = {
    mustResolveBeforeHandoff: record.mustResolveBeforeHandoff === true,
    lastFriendActivityAt: typeof record.lastFriendActivityAt === "string" ? record.lastFriendActivityAt : null,
  }
  if (!continuity.mustResolveBeforeHandoff && continuity.lastFriendActivityAt === null) return null
  return continuity
}

function extractContent(event: SessionEvent | null | undefined): string | null {
  if (!event) return null
  const text = extractEventText(event)
  return text.length > 0 ? text : null
}

function extractToolCallNames(event: SessionEvent | null | undefined): string[] {
  if (!event) return []
  return event.toolCalls
    .map((call) => call.function.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
}

/* v8 ignore stop */

function estimateTokenCount(messages: SessionEvent[]): number {
  let charCount = 0
  for (const msg of messages) {
    const content = extractContent(msg)
    if (content) charCount += content.length
    if (msg.toolCalls.length > 0) charCount += JSON.stringify(msg.toolCalls).length
  }
  return Math.ceil(charCount / 4)
}

/* v8 ignore start — filesystem traversal with defensive isDirectory checks */
function resolveAllSessionPaths(sessionsDir: string): Array<{ friendId: string; channel: string; key: string; sessionPath: string }> {
  const results: Array<{ friendId: string; channel: string; key: string; sessionPath: string }> = []
  if (!safeIsDirectory(sessionsDir)) return results

  for (const friendId of safeReaddir(sessionsDir)) {
    const friendDir = path.join(sessionsDir, friendId)
    if (!safeIsDirectory(friendDir)) continue
    for (const channel of safeReaddir(friendDir)) {
      const channelDir = path.join(friendDir, channel)
      if (!safeIsDirectory(channelDir)) continue
      for (const file of safeReaddir(channelDir)) {
        if (!file.endsWith(".json")) continue
        const key = file.slice(0, -5)
        results.push({
          friendId,
          channel,
          key,
          sessionPath: path.join(channelDir, file),
        })
      }
    }
  }
  return results
}

/* v8 ignore stop */

/* v8 ignore start — defensive parsing */
export function readSessionInventory(agentName: string, options: MailboxReadOptions = {}): MailboxSessionInventory {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const sessionsDir = path.join(agentRoot, "state", "sessions")
  const friendsDir = path.join(agentRoot, "friends")

  const allSessions = resolveAllSessionPaths(sessionsDir)
  const items: MailboxSessionInventoryItem[] = []

  for (const { friendId, channel, key, sessionPath } of allSessions) {
    if (friendId === "self" && channel === "inner") continue

    const envelope = readSessionEnvelope(sessionPath)
    const events = envelope?.events ?? []
    const chronology = deriveSessionChronology(events)
    const lastUsage = parseSessionUsage(envelope?.lastUsage)
    const continuity = parseSessionContinuity(envelope?.state)

    const hasObservedEventTiming = events.some((event) => event.time.authoredAt !== null || event.time.observedAt !== null)
    const lastActivityAt = hasObservedEventTiming
      ? (chronology.lastActivityAt ?? continuity?.lastFriendActivityAt ?? safeFileMtime(sessionPath) ?? now.toISOString())
      : (continuity?.lastFriendActivityAt ?? safeFileMtime(sessionPath) ?? now.toISOString())
    const activitySource: "event-timeline" | "friend-facing" | "mtime-fallback" = hasObservedEventTiming && chronology.lastActivityAt
      ? "event-timeline"
      : continuity?.lastFriendActivityAt
        ? "friend-facing"
        : "mtime-fallback"

    const userMessages = events.filter((m) => m.role === "user")
    const assistantMessages = events.filter((m) => m.role === "assistant")
    const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1]! : null
    const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1]! : null

    const latestToolCallNames: string[] = []
    for (let i = events.length - 1; i >= 0; i--) {
      const names = extractToolCallNames(events[i]!)
      if (names.length > 0) {
        latestToolCallNames.push(...names)
        break
      }
    }

    const friendName = resolveFriendName(friendsDir, friendId)

    const lastMsg = events.length > 0 ? events[events.length - 1]! : null
    const mustResolve = continuity?.mustResolveBeforeHandoff === true
    let replyState: "needs-reply" | "on-hold" | "monitoring" | "idle" = "idle"
    if (mustResolve) {
      replyState = "on-hold"
    } else if (lastMsg?.role === "user") {
      replyState = "needs-reply"
    } else if (events.length > 0) {
      replyState = "monitoring"
    }

    items.push({
      friendId,
      friendName,
      channel,
      key,
      sessionPath,
      lastActivityAt,
      activitySource,
      replyState,
      messageCount: events.length,
      lastUsage,
      continuity,
      latestUserExcerpt: truncateExcerpt(extractContent(lastUser)),
      latestAssistantExcerpt: truncateExcerpt(extractContent(lastAssistant)),
      latestToolCallNames,
      estimatedTokens: events.length > 0 ? estimateTokenCount(events) : null,
    })
  }

  items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))

  const ageThreshold = now.getTime() - STALE_THRESHOLD_MS
  const activeCount = items.filter((item) => Date.parse(item.lastActivityAt) >= ageThreshold).length

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_sessions_read",
    message: "reading mailbox session inventory",
    meta: { agentName, totalCount: items.length, activeCount },
  })

  return {
    totalCount: items.length,
    activeCount,
    staleCount: items.length - activeCount,
    items,
  }
}

export function readSessionTranscript(
  agentName: string,
  friendId: string,
  channel: string,
  key: string,
  options: MailboxReadOptions = {},
): MailboxSessionTranscript | null {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const sessionPath = path.join(agentRoot, "state", "sessions", friendId, channel, `${key}.json`)

  const envelope = readSessionEnvelope(sessionPath)
  if (!envelope) return null

  // Use full event history (envelope + archive) for complete transcript
  const rawMessages = loadFullEventHistory(sessionPath)
  const friendsDir = path.join(agentRoot, "friends")
  const friendName = resolveFriendName(friendsDir, friendId)

  const messages: MailboxTranscriptMessage[] = rawMessages

  return {
    friendId,
    friendName,
    channel,
    key,
    sessionPath,
    messageCount: messages.length,
    lastUsage: parseSessionUsage(envelope.lastUsage),
    continuity: parseSessionContinuity(envelope.state),
    messages,
  }
}
