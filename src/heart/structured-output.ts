import { emitNervesEvent } from "../nerves/runtime"

export interface StructuredOutputItem {
  label: string
  text: string
}

export interface StructuredOutput {
  schemaVersion: 1
  id: string
  kind: "ordered_list"
  sourceEventId: string
  recordedAt: string
  heading?: string
  items: StructuredOutputItem[]
}

export interface StructuredOutputSourceEvent {
  id: string
  role: string
  content: unknown
  toolCalls?: Array<{
    function?: {
      name?: string
      arguments?: string
    }
  }>
  time?: {
    recordedAt?: string | null
  }
}

export interface ExtractStructuredOutputTextOptions {
  eventId: string
  recordedAt: string
  emitTelemetry?: boolean
}

export interface ExtractStructuredOutputEventsOptions {
  emitTelemetry?: boolean
}

const ORDERED_LIST_LINE_RE = /^\s*(\d+)[.)]\s+(.+?)\s*$/
const MAX_ITEMS_PER_OUTPUT = 25
const MAX_ITEM_TEXT_CHARS = 500
const MAX_HEADING_CHARS = 160

function clip(value: string, maxChars: number): string {
  const trimmed = value.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const text = (part as { text?: unknown }).text
      return typeof text === "string" ? text : ""
    })
    .filter((text) => text.length > 0)
    .join("\n")
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function extractVisibleTextFromAssistantToolCalls(toolCalls: StructuredOutputSourceEvent["toolCalls"]): string {
  if (!Array.isArray(toolCalls)) return ""
  const parts: string[] = []
  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name
    const args = parseToolArguments(toolCall.function?.arguments)
    if (!args) continue
    if (name === "settle" && typeof args.answer === "string") {
      parts.push(args.answer)
    } else if (name === "speak" && typeof args.message === "string") {
      parts.push(args.message)
    } else if (name === "surface" && typeof args.content === "string") {
      parts.push(args.content)
    }
  }
  return parts.filter((text) => text.trim().length > 0).join("\n")
}

function normalizeStructuredOutputItem(value: unknown): StructuredOutputItem | null {
  if (!value || typeof value !== "object") return null
  const record = value as { label?: unknown; text?: unknown }
  if (typeof record.label !== "string" || typeof record.text !== "string") return null
  const label = record.label.trim()
  const text = record.text.trim()
  if (!label || !text) return null
  return { label, text: clip(text, MAX_ITEM_TEXT_CHARS) }
}

export function normalizeStructuredOutputs(value: unknown): StructuredOutput[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): StructuredOutput | null => {
      if (!item || typeof item !== "object") return null
      const record = item as {
        schemaVersion?: unknown
        id?: unknown
        kind?: unknown
        sourceEventId?: unknown
        recordedAt?: unknown
        heading?: unknown
        items?: unknown
      }
      if (
        record.schemaVersion !== 1
        || record.kind !== "ordered_list"
        || typeof record.id !== "string"
        || typeof record.sourceEventId !== "string"
        || typeof record.recordedAt !== "string"
      ) {
        return null
      }
      const items = Array.isArray(record.items)
        ? record.items.map(normalizeStructuredOutputItem).filter((child): child is StructuredOutputItem => child !== null)
        : []
      if (items.length < 2) return null
      return {
        schemaVersion: 1,
        id: record.id,
        kind: "ordered_list",
        sourceEventId: record.sourceEventId,
        recordedAt: record.recordedAt,
        ...(typeof record.heading === "string" && record.heading.trim()
          ? { heading: clip(record.heading, MAX_HEADING_CHARS) }
          : {}),
        items: items.slice(0, MAX_ITEMS_PER_OUTPUT),
      }
    })
    .filter((item): item is StructuredOutput => item !== null)
}

export function extractStructuredOutputsFromText(
  text: string,
  options: ExtractStructuredOutputTextOptions,
): StructuredOutput[] {
  const outputs: StructuredOutput[] = []
  const lines = text.split(/\r?\n/)
  let currentItems: StructuredOutputItem[] = []
  let currentHeading: string | undefined
  let lastNonListLine: string | undefined
  let lastNumber = 0

  const finishCurrent = () => {
    if (currentItems.length >= 2) {
      outputs.push({
        schemaVersion: 1,
        id: `structured-${options.eventId}-${outputs.length + 1}`,
        kind: "ordered_list",
        sourceEventId: options.eventId,
        recordedAt: options.recordedAt,
        ...(currentHeading ? { heading: currentHeading } : {}),
        items: currentItems.slice(0, MAX_ITEMS_PER_OUTPUT),
      })
    }
    currentItems = []
    currentHeading = undefined
    lastNumber = 0
  }

  for (const line of lines) {
    const match = line.match(ORDERED_LIST_LINE_RE)
    if (!match) {
      if (currentItems.length > 0 && line.trim().length > 0) {
        finishCurrent()
      }
      if (line.trim().length > 0) {
        lastNonListLine = clip(line, MAX_HEADING_CHARS)
      }
      continue
    }

    const label = match[1]!
    const number = Number(label)
    const body = clip(match[2]!, MAX_ITEM_TEXT_CHARS)

    if (currentItems.length === 0) {
      if (number !== 1) {
        lastNonListLine = clip(line, MAX_HEADING_CHARS)
        continue
      }
      currentHeading = lastNonListLine
    } else if (number !== lastNumber + 1) {
      finishCurrent()
      if (number !== 1) {
        lastNonListLine = clip(line, MAX_HEADING_CHARS)
        continue
      }
      currentHeading = lastNonListLine
    }

    currentItems.push({ label, text: body })
    lastNumber = number
  }

  finishCurrent()

  if (outputs.length > 0 && options.emitTelemetry !== false) {
    emitNervesEvent({
      component: "heart",
      event: "heart.structured_output_extracted",
      message: "structured assistant output extracted",
      meta: {
        sourceEventId: options.eventId,
        outputCount: outputs.length,
        itemCount: outputs.reduce((sum, output) => sum + output.items.length, 0),
      },
    })
  }

  return outputs
}

export function extractStructuredOutputsFromEvents(
  events: StructuredOutputSourceEvent[],
  options: ExtractStructuredOutputEventsOptions = {},
): StructuredOutput[] {
  return events.flatMap((event) => {
    if (event.role !== "assistant") return []
    const text = [contentToText(event.content), extractVisibleTextFromAssistantToolCalls(event.toolCalls)]
      .filter((part) => part.trim().length > 0)
      .join("\n")
    if (!text.trim()) return []
    return extractStructuredOutputsFromText(text, {
      eventId: event.id,
      recordedAt: event.time?.recordedAt ?? new Date(0).toISOString(),
      emitTelemetry: options.emitTelemetry,
    })
  })
}
