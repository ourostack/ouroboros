import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import {
  extractVisibleTextFromAssistantToolCalls,
  type StructuredOutput,
  type StructuredOutputSourceEvent,
} from "./structured-output"

export type OrientationSignal = "correction_marker" | "terse_referent" | "structured_referent"

/**
 * How the current user "speech" reached us. `reaction` covers tapback-style
 * acknowledgements (iMessage Loved/Liked/Questioned, Teams reactions): the text is
 * synthesised by the sense from the *target* message, so it is not the human
 * composing a correction and must never arm a hold.
 */
export type OrientationSpeechKind = "utterance" | "reaction"

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
  replyingToText?: string
  repairNotice?: string
  routingHint?: string
  recentLanes?: Array<{ key: string; label: string; snippet: string }>
}

export type OrientationActionPolicy =
  | { mode: "normal" }
  | {
      mode: "correction_hold"
      reason: string
      blockedMutationKinds: string[]
      /** The correction marker that armed the hold, so the trigger is never a guess. */
      triggeredBy?: string
      /** Plain-language statement of what releases the hold, so it is never a silent wall. */
      clearedBy?: string
    }

export interface OrientationFrame {
  schemaVersion: 1
  channel: string
  currentUserSpeech: string[]
  priorAssistantReferents: OrientationReferent[]
  latestStructuredOutput?: StructuredOutput
  signals: OrientationSignal[]
  actionPolicy: OrientationActionPolicy
  source?: OrientationSource
  /** Only set when the turn was triggered by something other than a plain utterance. */
  speechKind?: OrientationSpeechKind
}

export interface BuildOrientationFrameInput {
  channel: string
  messages: OpenAI.ChatCompletionMessageParam[]
  currentUserMessages?: OpenAI.ChatCompletionMessageParam[]
  structuredOutputs?: StructuredOutput[]
  source?: OrientationSource
  speechKind?: OrientationSpeechKind
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function extractMessageText(message: OpenAI.ChatCompletionMessageParam | undefined): string {
  if (!message) return ""
  const content = message.content
  const toolText = message.role === "assistant"
    ? extractVisibleTextFromAssistantToolCalls((message as { tool_calls?: StructuredOutputSourceEvent["toolCalls"] }).tool_calls)
    : ""
  if (typeof content === "string") return [content, toolText].filter((part) => part.trim().length > 0).join("\n").trim()
  if (!Array.isArray(content)) return toolText.trim()

  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const text = part.text
    if (typeof text === "string") {
      parts.push(text.trim())
    }
  }
  if (toolText) parts.push(toolText)
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

/**
 * Returns the marker that fired, not just a boolean: when the hold blocks an action
 * the agent has to be able to see *which* word triggered it. In the 2026-07-27
 * incident it guessed wrong twice ("it's because of the word 'useful'") because the
 * block message named no trigger.
 */
function correctionMarkerIn(text: string): string | undefined {
  const phrase = /\b(hang on|wait|actually|not that|not this|wrong|misunderstood|you(?:'re| are) right|correct)\b/i.exec(text)
  if (phrase) return phrase[0].toLowerCase()
  return /^\s*no[\s,]/i.test(text) ? "no" : undefined
}

function isTerseReferent(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "")
  return /^(same|correct|exactly|yes|no|that one|this one|the first one|the second one|the third one|first|second|third|option \d+|number \d+|item \d+|\d+)$/.test(normalized)
}

function hasNumericStructuredReferent(text: string): boolean {
  return /\b(?:number|item|option|#)\s*\d+\b/i.test(text) || /^\s*\d+\b/.test(text.trim())
}

function latestStructuredOutputFrom(outputs: StructuredOutput[] | undefined): StructuredOutput | undefined {
  if (!outputs || outputs.length === 0) return undefined
  return outputs.at(-1)
}

function shouldAttachStructuredOutput(combinedSpeech: string, signals: OrientationSignal[]): boolean {
  if (hasNumericStructuredReferent(combinedSpeech)) return true
  return signals.some((signal) => signal === "terse_referent" || signal === "correction_marker")
}

function deriveSignals(
  currentUserSpeech: string[],
  priorAssistantReferents: OrientationReferent[],
  latestStructuredOutput: StructuredOutput | undefined,
  speechKind: OrientationSpeechKind,
): OrientationSignal[] {
  const combined = currentUserSpeech.join("\n").trim()
  // A reaction is an acknowledgement of an existing message, not new speech. Its
  // text is synthesised by the sense from the message being reacted to, so scanning
  // it would read the *quoted* message's words as the human's correction — and a
  // positive tapback is approval, which must never gate outbound work.
  if (!combined || speechKind === "reaction") return []

  const signals: OrientationSignal[] = []
  if (correctionMarkerIn(combined)) signals.push("correction_marker")
  if (priorAssistantReferents.length > 0 && isTerseReferent(combined)) signals.push("terse_referent")
  if (latestStructuredOutput && hasNumericStructuredReferent(combined)) signals.push("structured_referent")
  return [...new Set(signals)]
}

/**
 * The hold exists for corrections that are terse or ambiguous ("no, not that one").
 * A correction word buried in a long, self-contained instruction is neither: on
 * 2026-07-27 the word "actually" — in "Do NOT claim a hotel has AC unless you
 * actually saw evidence" — armed the hold inside a 195-word directive that had zero
 * prior referents and no structured output, and blocked five consecutive
 * `send_message` calls. The same directive was what authorised the send, and with
 * nothing to disambiguate the remedy the block named could not be performed.
 */
const TERSE_CORRECTION_MAX_WORDS = 12

const CORRECTION_HOLD_CLEARED_BY =
  "Resolve the referent (orientation_get lists the candidates) or restate the request as a standalone, correction-free instruction. The policy is recomputed from each user turn, so it never carries past this turn."

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function correctionMarkerArmsHold(
  combinedSpeech: string,
  priorAssistantReferents: OrientationReferent[],
  latestStructuredOutput: StructuredOutput | undefined,
): boolean {
  if (countWords(combinedSpeech) <= TERSE_CORRECTION_MAX_WORDS) return true
  // Long speech still holds when there is something concrete to disambiguate.
  return priorAssistantReferents.length > 0 || Boolean(latestStructuredOutput)
}

function deriveActionPolicy(
  signals: OrientationSignal[],
  combinedSpeech: string,
  priorAssistantReferents: OrientationReferent[],
  latestStructuredOutput: StructuredOutput | undefined,
): OrientationActionPolicy {
  const holdSignals = signals.filter((signal) => signal !== "correction_marker"
    || correctionMarkerArmsHold(combinedSpeech, priorAssistantReferents, latestStructuredOutput))
  if (holdSignals.length === 0) return { mode: "normal" }
  const triggeredBy = holdSignals.includes("correction_marker")
    ? correctionMarkerIn(combinedSpeech)
    : undefined
  return {
    mode: "correction_hold",
    reason: holdSignals.includes("terse_referent")
      ? "Current user speech appears referent-dependent; inspect orientation before mutating durable state."
      : "Current user speech appears to correct or revise prior understanding; inspect orientation before mutating durable state.",
    blockedMutationKinds: ["durable_state_write", "external_side_effect"],
    ...(triggeredBy ? { triggeredBy } : {}),
    clearedBy: CORRECTION_HOLD_CLEARED_BY,
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
  const candidateStructuredOutput = latestStructuredOutputFrom(input.structuredOutputs)
  const speechKind = input.speechKind ?? "utterance"
  const signals = deriveSignals(currentUserSpeech, priorAssistantReferents, candidateStructuredOutput, speechKind)
  const combinedSpeech = currentUserSpeech.join("\n").trim()
  const latestStructuredOutput = candidateStructuredOutput && shouldAttachStructuredOutput(combinedSpeech, signals)
    ? candidateStructuredOutput
    : undefined
  const actionPolicy = deriveActionPolicy(
    signals,
    combinedSpeech,
    priorAssistantReferents,
    candidateStructuredOutput,
  )

  const frame: OrientationFrame = {
    schemaVersion: 1,
    channel: input.channel,
    currentUserSpeech,
    priorAssistantReferents,
    ...(latestStructuredOutput ? { latestStructuredOutput } : {}),
    signals,
    actionPolicy,
    ...(input.source ? { source: input.source } : {}),
    ...(speechKind === "utterance" ? {} : { speechKind }),
  }

  emitNervesEvent({
    component: "engine",
    event: "orientation.frame_built",
    message: "orientation frame built",
    meta: {
      channel: input.channel,
      signalCount: signals.length,
      referentCount: priorAssistantReferents.length,
      structuredOutput: latestStructuredOutput?.id ?? null,
      policy: actionPolicy.mode,
    },
  })

  if (actionPolicy.mode === "correction_hold") {
    // Distinct + greppable: a hold that blocks an explicitly requested action must
    // leave a trace naming what it blocks and what releases it.
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "orientation.correction_hold_armed",
      message: "orientation correction hold armed",
      meta: {
        channel: input.channel,
        speechKind,
        signals,
        blockedMutationKinds: actionPolicy.blockedMutationKinds,
        triggeredBy: actionPolicy.triggeredBy ?? null,
        referentCount: priorAssistantReferents.length,
        structuredOutput: candidateStructuredOutput?.id ?? null,
        speechWordCount: countWords(combinedSpeech),
        clearedBy: actionPolicy.clearedBy,
      },
    })
  }

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
    lines.push(`policy blocks: ${frame.actionPolicy.blockedMutationKinds.join(", ")}`)
    if (frame.actionPolicy.triggeredBy) {
      lines.push(`policy trigger: correction marker "${frame.actionPolicy.triggeredBy}" in current user speech`)
    }
    if (frame.actionPolicy.clearedBy) lines.push(`policy clears when: ${frame.actionPolicy.clearedBy}`)
  }

  if (frame.speechKind) {
    lines.push(`speech kind: ${frame.speechKind}`)
  }

  if (frame.source) {
    lines.push("source:")
    lines.push(`- kind: ${frame.source.kind}`)
    if (frame.source.lane) lines.push(`- lane: ${frame.source.lane}`)
    if (frame.source.defaultReplyTarget) lines.push(`- default reply target: ${frame.source.defaultReplyTarget}`)
    if (frame.source.threadId) lines.push(`- thread id: ${frame.source.threadId}`)
    if (frame.source.replyingToText) lines.push(`- replying to: ${frame.source.replyingToText}`)
    if (frame.source.repairNotice) lines.push(`- repair notice: ${frame.source.repairNotice}`)
    if (frame.source.routingHint) lines.push(`- routing hint: ${frame.source.routingHint}`)
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

  if (frame.latestStructuredOutput) {
    lines.push(`latest structured output: ${frame.latestStructuredOutput.id}`)
    if (frame.latestStructuredOutput.heading) lines.push(`heading: ${frame.latestStructuredOutput.heading}`)
    for (const item of frame.latestStructuredOutput.items) {
      lines.push(`${item.label}. ${item.text}`)
    }
  }

  return lines.join("\n")
}
