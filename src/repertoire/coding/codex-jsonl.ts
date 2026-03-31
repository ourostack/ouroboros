/**
 * Codex JSONL event parser.
 * Parses typed events from Codex --json output:
 * thread.started, turn.started, turn.completed, item.completed.
 * Maps events to coding session status transitions.
 */

import { emitNervesEvent } from "../../nerves/runtime"
import type { CodingSessionStatus } from "./types"

export interface CodexJsonlEvent {
  type: "thread.started" | "turn.started" | "turn.completed" | "item.completed"
  threadId?: string
  turnId?: string
  item?: Record<string, unknown>
  raw: Record<string, unknown>
  /** Suggested session status transition, null if no change */
  statusHint: CodingSessionStatus | null
}

const KNOWN_TYPES = new Set(["thread.started", "turn.started", "turn.completed", "item.completed"])

/**
 * Parse a single JSONL line from Codex --json output.
 * Returns null for invalid JSON, empty strings, or unknown event types.
 */
export function parseCodexJsonlEvent(line: string): CodexJsonlEvent | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.codex_jsonl_parse_error",
      message: "failed to parse codex JSONL line",
      meta: { line: trimmed.slice(0, 100) },
    })
    return null
  }

  const type = parsed.type as string
  if (!type || !KNOWN_TYPES.has(type)) return null

  const event: CodexJsonlEvent = {
    type: type as CodexJsonlEvent["type"],
    threadId: typeof parsed.thread_id === "string" ? parsed.thread_id : undefined,
    turnId: typeof parsed.turn_id === "string" ? parsed.turn_id : undefined,
    item: typeof parsed.item === "object" && parsed.item !== null ? parsed.item as Record<string, unknown> : undefined,
    raw: parsed,
    statusHint: mapStatusHint(type),
  }

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.codex_jsonl_event",
    message: "parsed codex JSONL event",
    meta: { type, threadId: event.threadId ?? null },
  })

  return event
}

function mapStatusHint(type: string): CodingSessionStatus | null {
  switch (type) {
    case "thread.started":
    case "turn.started":
      return "running"
    case "turn.completed":
    case "item.completed":
      return null // No automatic status change for completion events
    /* v8 ignore next -- defensive default for unknown event types */
    default:
      return null
  }
}
