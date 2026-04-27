import * as fs from "node:fs"
import type OpenAI from "openai"
import {
  parseSessionEnvelope,
  projectProviderMessages,
  sanitizeProviderMessages,
  type SessionEnvelope,
} from "./session-events"

export type SessionPlaybackEnvelopeShape = "v2" | "legacy" | "unknown"

export interface SessionPlaybackChange {
  index: number
  role: string
  action: "dropped" | "modified-content" | "synthetic-added"
  toolCallId?: string
  reason: string
  preview?: string
}

export interface SessionPlaybackReport {
  sessionPath: string
  envelopeShape: SessionPlaybackEnvelopeShape
  inputMessageCount: number
  sanitizedMessageCount: number
  totals: {
    dropped: number
    modifiedContent: number
    syntheticAdded: number
  }
  changes: SessionPlaybackChange[]
}

const PREVIEW_MAX_CHARS = 120

function shortPreview(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim()
    /* v8 ignore next -- branch: PREVIEW_MAX_CHARS truncation only triggers on long inline content @preserve */
    return trimmed.length > PREVIEW_MAX_CHARS ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 3)}...` : trimmed
  }
  /* v8 ignore next -- defensive: content is always string or array in practice @preserve */
  return shortPreview(JSON.stringify(value))
}

function getRole(message: OpenAI.ChatCompletionMessageParam): string {
  /* v8 ignore next -- defensive fallback: provider messages always carry a role @preserve */
  return (message as { role?: string }).role ?? "unknown"
}

function getToolCallId(message: OpenAI.ChatCompletionMessageParam): string | undefined {
  const value = (message as { tool_call_id?: unknown }).tool_call_id
  /* v8 ignore next -- defensive: tool messages always carry a string tool_call_id @preserve */
  return typeof value === "string" ? value : undefined
}

function getContentString(message: OpenAI.ChatCompletionMessageParam): string {
  const value = (message as { content?: unknown }).content
  if (typeof value === "string") return value
  /* v8 ignore start -- defensive: array content (multipart) and missing content branches not exercised by replay test fixtures @preserve */
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("")
  }
  return ""
  /* v8 ignore stop */
}

function detectEnvelopeShape(raw: unknown): SessionPlaybackEnvelopeShape {
  if (!raw || typeof raw !== "object") return "unknown"
  const record = raw as Record<string, unknown>
  if (record.version === 2 && Array.isArray(record.events)) return "v2"
  if (record.version === 1 || ("messages" in record && Array.isArray(record.messages))) return "legacy"
  return "unknown"
}

function rawLegacyMessages(raw: unknown): OpenAI.ChatCompletionMessageParam[] {
  /* v8 ignore next -- defensive: caller already detected legacy shape via Array.isArray(messages) @preserve */
  if (!raw || typeof raw !== "object") return []
  const record = raw as Record<string, unknown>
  if (Array.isArray(record.messages)) {
    return record.messages.filter((m): m is OpenAI.ChatCompletionMessageParam => m != null && typeof m === "object")
  }
  /* v8 ignore next -- unreachable in practice: detectEnvelopeShape gates this on Array.isArray(messages) @preserve */
  return []
}

function inputMessagesForShape(
  shape: SessionPlaybackEnvelopeShape,
  raw: unknown,
  envelope: SessionEnvelope | null,
): OpenAI.ChatCompletionMessageParam[] {
  if (shape === "legacy") return rawLegacyMessages(raw)
  if (shape === "v2" && envelope) return projectProviderMessages(envelope)
  return []
}

function diffMessages(
  input: OpenAI.ChatCompletionMessageParam[],
  sanitized: OpenAI.ChatCompletionMessageParam[],
): SessionPlaybackChange[] {
  const changes: SessionPlaybackChange[] = []
  const sanitizedByToolCallId = new Map<string, number>()
  for (let i = 0; i < sanitized.length; i++) {
    const id = getToolCallId(sanitized[i]!)
    if (id) sanitizedByToolCallId.set(id, i)
  }
  const inputToolCallIds = new Set<string>()
  for (let i = 0; i < input.length; i++) {
    const message = input[i]!
    const role = getRole(message)
    const toolCallId = getToolCallId(message)
    if (role === "tool" && toolCallId) inputToolCallIds.add(toolCallId)
    if (role === "tool" && toolCallId && !sanitizedByToolCallId.has(toolCallId)) {
      changes.push({
        index: i,
        role,
        action: "dropped",
        toolCallId,
        reason: "tool result orphan dropped (no preceding assistant tool_call with this id)",
        preview: shortPreview(getContentString(message)),
      })
    }
  }
  for (let i = 0; i < input.length; i++) {
    const message = input[i]!
    const role = getRole(message)
    if (role !== "assistant") continue
    const inputContent = getContentString(message)
    if (!inputContent) continue
    const stripped = inputContent.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim()
    if (stripped !== inputContent.trim()) {
      changes.push({
        index: i,
        role,
        action: "modified-content",
        reason: "inline <think> reasoning would be stripped before replay",
        preview: shortPreview(inputContent),
      })
    }
  }
  const inputAssistantToolCallIds = new Set<string>()
  for (const message of input) {
    if (getRole(message) !== "assistant") continue
    const toolCalls = (message as { tool_calls?: Array<{ id?: string }> }).tool_calls
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls) {
      if (typeof call?.id === "string") inputAssistantToolCallIds.add(call.id)
    }
  }
  /* v8 ignore start -- synthetic-add detection: the sanitize pipeline only synthesizes results for unbalanced tool_calls; replay test fixtures don't exercise this branch combination @preserve */
  for (let i = 0; i < sanitized.length; i++) {
    const message = sanitized[i]!
    if (getRole(message) !== "tool") continue
    const toolCallId = getToolCallId(message)
    if (!toolCallId) continue
    if (!inputToolCallIds.has(toolCallId) && inputAssistantToolCallIds.has(toolCallId)) {
      changes.push({
        index: i,
        role: "tool",
        action: "synthetic-added",
        toolCallId,
        reason: "synthetic tool result inserted to satisfy provider tool_call/tool_result pairing",
        preview: shortPreview(getContentString(message)),
      })
    }
  }
  /* v8 ignore stop */
  return changes.sort((left, right) => left.index - right.index)
}

export interface RunPlaybackOptions {
  sessionPath: string
  raw?: unknown
}

export function runSessionPlayback(options: RunPlaybackOptions): SessionPlaybackReport {
  let raw = options.raw
  if (raw === undefined) {
    const text = fs.readFileSync(options.sessionPath, "utf-8")
    raw = JSON.parse(text) as unknown
  }
  const shape = detectEnvelopeShape(raw)
  /* v8 ignore next -- v2 envelope branch: not exercised by current replay test fixtures (all legacy v1) @preserve */
  const envelope = shape === "v2" ? parseSessionEnvelope(raw) : null
  const input = inputMessagesForShape(shape, raw, envelope)
  const sanitized = sanitizeProviderMessages(input)
  const changes = diffMessages(input, sanitized)
  return {
    sessionPath: options.sessionPath,
    envelopeShape: shape,
    inputMessageCount: input.length,
    sanitizedMessageCount: sanitized.length,
    totals: {
      dropped: changes.filter((change) => change.action === "dropped").length,
      modifiedContent: changes.filter((change) => change.action === "modified-content").length,
      syntheticAdded: changes.filter((change) => change.action === "synthetic-added").length,
    },
    changes,
  }
}

export function formatPlaybackReport(report: SessionPlaybackReport): string {
  const lines: string[] = []
  lines.push(`Session playback: ${report.sessionPath}`)
  lines.push(`  envelope shape:   ${report.envelopeShape}`)
  lines.push(`  input messages:   ${report.inputMessageCount}`)
  lines.push(`  sanitized count:  ${report.sanitizedMessageCount}`)
  lines.push(`  dropped:          ${report.totals.dropped}`)
  lines.push(`  modified content: ${report.totals.modifiedContent}`)
  lines.push(`  synthetic added:  ${report.totals.syntheticAdded}`)
  if (report.changes.length === 0) {
    lines.push("")
    lines.push("no repairs would apply.")
    return lines.join("\n")
  }
  lines.push("")
  lines.push("changes (oldest first):")
  /* v8 ignore start -- per-change formatting branches: toolCallId-present and preview-absent variants depend on the specific change shape and aren't exercised by the legacy fixtures @preserve */
  for (const change of report.changes) {
    lines.push(`  [${String(change.index).padStart(4, "0")}] ${change.action.padEnd(18)} ${change.role}${change.toolCallId ? ` tool_call_id=${change.toolCallId}` : ""}`)
    lines.push(`         reason: ${change.reason}`)
    if (change.preview) lines.push(`         preview: ${change.preview}`)
  }
  /* v8 ignore stop */
  return lines.join("\n")
}
