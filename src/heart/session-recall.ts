import * as fs from "fs"
import type { TrustLevel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"

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

function buildSnapshot(summary: string, tailMessages: Array<{ role: string; content: string }>): string {
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

  const parsed = JSON.parse(raw) as { messages?: Array<{ role?: unknown; content?: unknown }> }
  const tailMessages = (parsed.messages ?? [])
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "",
      content: normalizeContent(message.content),
    }))
    .filter((message) => message.role !== "system" && message.content.length > 0)
    .slice(-options.messageCount)

  if (tailMessages.length === 0) {
    return { kind: "empty" }
  }

  const transcript = tailMessages
    .map((message) => `[${message.role}] ${message.content}`)
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
