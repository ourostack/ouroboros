import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"

export type OrientationSignal = "correction_marker" | "terse_referent"

export interface OrientationReferent {
  kind: "ordered_list_item"
  label: string
  text: string
}

export interface OrientationSource {
  kind: string
  lane?: string
  defaultReplyTarget?: string
  threadId?: string
  recentLanes?: Array<{ key: string; label: string; snippet: string }>
}

export type OrientationActionPolicy =
  | { mode: "normal" }
  | {
      mode: "correction_hold"
      reason: string
      blockedMutationKinds: string[]
    }

export interface OrientationFrame {
  schemaVersion: 1
  channel: string
  currentUserSpeech: string[]
  priorAssistantReferents: OrientationReferent[]
  signals: OrientationSignal[]
  actionPolicy: OrientationActionPolicy
  source?: OrientationSource
}

export interface BuildOrientationFrameInput {
  channel: string
  messages: OpenAI.ChatCompletionMessageParam[]
  currentUserMessages?: OpenAI.ChatCompletionMessageParam[]
  source?: OrientationSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function extractMessageText(message: OpenAI.ChatCompletionMessageParam | undefined): string {
  if (!message) return ""
  const content = message.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const text = part.text
    if (typeof text === "string") {
      parts.push(text.trim())
    }
  }
  return parts.filter(Boolean).join("\n").trim()
}

function currentUserMessagesFrom(messages: OpenAI.ChatCompletionMessageParam[]): {
  messages: OpenAI.ChatCompletionMessageParam[]
  firstIndex: number
} {
  const collected: OpenAI.ChatCompletionMessageParam[] = []
  let firstIndex = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== "user") {
      if (collected.length > 0) break
      continue
    }
    collected.unshift(message)
    firstIndex = index
  }
  return { messages: collected, firstIndex }
}

function latestAssistantBefore(
  messages: OpenAI.ChatCompletionMessageParam[],
  beforeIndex: number,
): OpenAI.ChatCompletionMessageParam | undefined {
  for (let index = Math.min(beforeIndex - 1, messages.length - 1); index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "assistant") return message
  }
  return undefined
}

export function extractOrderedListReferents(text: string): OrientationReferent[] {
  const referents: OrientationReferent[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/)
    if (!match) continue
    referents.push({
      kind: "ordered_list_item",
      label: match[1],
      text: match[2].trim(),
    })
    if (referents.length >= 12) break
  }
  return referents
}

function hasCorrectionMarker(text: string): boolean {
  return /\b(hang on|wait|actually|not that|not this|wrong|misunderstood|you(?:'re| are) right|correct|exactly)\b/i.test(text)
}

function isTerseReferent(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "")
  return /^(same|correct|exactly|yes|no|that one|this one|the first one|the second one|the third one|first|second|third|option \d+|\d+)$/.test(normalized)
}

function deriveSignals(currentUserSpeech: string[], priorAssistantReferents: OrientationReferent[]): OrientationSignal[] {
  const combined = currentUserSpeech.join("\n").trim()
  if (!combined) return []

  const signals: OrientationSignal[] = []
  if (hasCorrectionMarker(combined)) signals.push("correction_marker")
  if (priorAssistantReferents.length > 0 && isTerseReferent(combined)) signals.push("terse_referent")
  return [...new Set(signals)]
}

function deriveActionPolicy(signals: OrientationSignal[]): OrientationActionPolicy {
  if (signals.length === 0) return { mode: "normal" }
  return {
    mode: "correction_hold",
    reason: signals.includes("terse_referent")
      ? "Current user speech appears referent-dependent; inspect orientation before mutating durable state."
      : "Current user speech appears to correct or revise prior understanding; inspect orientation before mutating durable state.",
    blockedMutationKinds: ["durable_state_write", "external_side_effect"],
  }
}

export function buildOrientationFrame(input: BuildOrientationFrameInput): OrientationFrame {
  const derivedCurrent = input.currentUserMessages
    ? { messages: input.currentUserMessages, firstIndex: input.messages.length }
    : currentUserMessagesFrom(input.messages)
  const currentUserSpeech = derivedCurrent.messages
    .map((message) => extractMessageText(message))
    .filter((text) => text.length > 0)
  const previousAssistant = latestAssistantBefore(input.messages, derivedCurrent.firstIndex)
  const priorAssistantReferents = extractOrderedListReferents(extractMessageText(previousAssistant))
  const signals = deriveSignals(currentUserSpeech, priorAssistantReferents)
  const actionPolicy = deriveActionPolicy(signals)

  const frame: OrientationFrame = {
    schemaVersion: 1,
    channel: input.channel,
    currentUserSpeech,
    priorAssistantReferents,
    signals,
    actionPolicy,
    ...(input.source ? { source: input.source } : {}),
  }

  emitNervesEvent({
    component: "engine",
    event: "orientation.frame_built",
    message: "orientation frame built",
    meta: {
      channel: input.channel,
      signalCount: signals.length,
      referentCount: priorAssistantReferents.length,
      policy: actionPolicy.mode,
    },
  })

  return frame
}

export function renderOrientationFrame(frame: OrientationFrame): string {
  const lines = [
    "## orientation frame",
    `channel: ${frame.channel}`,
    `action policy: ${frame.actionPolicy.mode}`,
  ]

  if (frame.actionPolicy.mode === "correction_hold") {
    lines.push(`policy reason: ${frame.actionPolicy.reason}`)
  }

  if (frame.source) {
    lines.push("source:")
    lines.push(`- kind: ${frame.source.kind}`)
    if (frame.source.lane) lines.push(`- lane: ${frame.source.lane}`)
    if (frame.source.defaultReplyTarget) lines.push(`- default reply target: ${frame.source.defaultReplyTarget}`)
    if (frame.source.threadId) lines.push(`- thread id: ${frame.source.threadId}`)
    if (frame.source.recentLanes && frame.source.recentLanes.length > 0) {
      lines.push("- recent lanes:")
      for (const lane of frame.source.recentLanes) {
        lines.push(`  - ${lane.label || lane.key}: ${lane.snippet}`)
      }
    }
  }

  lines.push("current user speech:")
  if (frame.currentUserSpeech.length === 0) {
    lines.push("- (none)")
  } else {
    for (const speech of frame.currentUserSpeech) lines.push(`- ${speech}`)
  }

  if (frame.signals.length > 0) {
    lines.push(`signals: ${frame.signals.join(", ")}`)
  }

  if (frame.priorAssistantReferents.length > 0) {
    lines.push("prior assistant referents:")
    for (const item of frame.priorAssistantReferents) {
      lines.push(`${item.label}. ${item.text}`)
    }
  }

  return lines.join("\n")
}
