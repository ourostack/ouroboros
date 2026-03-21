import * as fs from "fs"
import type { TrustLevel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import { normalizeSessionOrientation, type SessionOrientation } from "../mind/session-orientation"

export interface SessionRecallOptions {
  sessionPath: string
  friendId: string
  channel: string
  key: string
  messageCount: number
  summarize?: (transcript: string, instruction: string) => Promise<string>
  trustLevel?: TrustLevel
}

export type SessionRecallResult =
  | { kind: "missing" }
  | { kind: "empty" }
  | {
    kind: "ok"
    transcript: string
    summary: string
    snapshot: string
    tailMessages: Array<{ role: string; content: string }>
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

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((part) => (
      part && typeof part === "object" && "type" in part && (part as { type?: unknown }).type === "text" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    ))
    .filter((text) => text.length > 0)
    .join("")
}

function normalizeSessionMessages(messages: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(messages)) return []

  return messages
    .map((message) => {
      const record = message && typeof message === "object" ? message as { role?: unknown; content?: unknown } : {}
      return {
        role: typeof record.role === "string" ? record.role : "",
        content: normalizeContent(record.content),
      }
    })
    .filter((message) => message.role !== "system" && message.content.length > 0)
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

function buildOrientationSnapshot(orientation?: SessionOrientation): string[] {
  if (!orientation) return []

  const lines: string[] = []
  if (orientation.goal) {
    lines.push(`goal: ${clip(orientation.goal, 200)}`)
  }
  if (orientation.constraints.length > 0) {
    lines.push(`constraints: ${clip(orientation.constraints.join("; "), 200)}`)
  }
  if (orientation.progress.length > 0) {
    lines.push(`progress: ${clip(orientation.progress.join("; "), 200)}`)
  }
  if (orientation.modifiedFiles.length > 0) {
    lines.push(`files: ${clip(orientation.modifiedFiles.join(", "), 200)}`)
  }

  return lines
}

function buildSnapshot(
  summary: string,
  tailMessages: Array<{ role: string; content: string }>,
  orientation?: SessionOrientation,
): string {
  const lines = [`recent focus: ${clip(summary, 240)}`]
  lines.push(...buildOrientationSnapshot(orientation))
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

function buildSearchSnapshot(
  query: string,
  messages: Array<{ role: string; content: string }>,
  orientation?: SessionOrientation,
  includeLatestTurn = true,
): string {
  const lines = [`history query: "${clip(query, 120)}"`]
  lines.push(...buildOrientationSnapshot(orientation))
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

function mergeOrientationIntoSummary(summary: string, orientation?: SessionOrientation): string {
  const orientationLines = buildOrientationSnapshot(orientation)
  if (orientationLines.length === 0) return summary

  return [`session orientation:`, ...orientationLines, "", summary].join("\n")
}

function buildSearchExcerpts(
  messages: Array<{ role: string; content: string }>,
  query: string,
  maxMatches: number,
): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  const candidates: Array<{ excerpt: string; score: number; index: number }> = []
  let lastMatchIndex = -2

  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].content.toLowerCase().includes(normalizedQuery)) continue
    if (i <= lastMatchIndex + 1) continue
    lastMatchIndex = i

    const start = Math.max(0, i - 1)
    const end = Math.min(messages.length, i + 2)
    const excerpt = messages
      .slice(start, end)
      .map((message) => `[${message.role}] ${clip(message.content, 200)}`)
      .join("\n")
    const score = messages
      .slice(start, end)
      .filter((message) => message.content.toLowerCase().includes(normalizedQuery))
      .length

    candidates.push({ excerpt, score, index: i })
  }

  const seen = new Set<string>()
  return candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter((candidate) => {
      if (seen.has(candidate.excerpt)) return false
      seen.add(candidate.excerpt)
      return true
    })
    .slice(0, maxMatches)
    .map((candidate) => candidate.excerpt)
}

export async function recallSession(options: SessionRecallOptions): Promise<SessionRecallResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.session_recall",
    message: "recalling session transcript tail",
    meta: {
      friendId: options.friendId,
      channel: options.channel,
      key: options.key,
      messageCount: options.messageCount,
    },
  })

  let raw: string
  try {
    raw = fs.readFileSync(options.sessionPath, "utf-8")
  } catch {
    return { kind: "missing" }
  }

  const parsed = JSON.parse(raw) as {
    messages?: Array<{ role?: unknown; content?: unknown }>
    sessionOrientation?: unknown
  }
  const sessionOrientation = normalizeSessionOrientation(parsed.sessionOrientation)
  const tailMessages = normalizeSessionMessages(parsed.messages).slice(-options.messageCount)

  if (tailMessages.length === 0) {
    return { kind: "empty" }
  }

  const transcript = tailMessages
    .map((message) => `[${message.role}] ${message.content}`)
    .join("\n")

  const rawSummary = options.summarize
    ? await options.summarize(
      transcript,
      buildSummaryInstruction(options.friendId, options.channel, options.trustLevel ?? "family"),
    )
    : transcript
  const summary = mergeOrientationIntoSummary(rawSummary, sessionOrientation)

  return {
    kind: "ok",
    transcript,
    summary,
    snapshot: buildSnapshot(summary, tailMessages, sessionOrientation),
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

  let raw: string
  try {
    raw = fs.readFileSync(options.sessionPath, "utf-8")
  } catch {
    return { kind: "missing" }
  }

  const parsed = JSON.parse(raw) as {
    messages?: Array<{ role?: unknown; content?: unknown }>
    sessionOrientation?: unknown
  }
  const sessionOrientation = normalizeSessionOrientation(parsed.sessionOrientation)
  const messages = normalizeSessionMessages(parsed.messages)

  if (messages.length === 0) {
    return { kind: "empty" }
  }

  const query = options.query.trim()
  const matches = buildSearchExcerpts(messages, query, options.maxMatches ?? 5)

  if (matches.length === 0) {
    return {
      kind: "no_match",
      query,
      snapshot: buildSearchSnapshot(query, messages, sessionOrientation),
    }
  }

  return {
    kind: "ok",
    query,
    snapshot: buildSearchSnapshot(query, messages, sessionOrientation, false),
    matches,
  }
}
