import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { getAgentRoot } from "./identity"

const JOURNAL_VERSION = 1
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024
const DEFAULT_REPLAY_LIMIT = 1_000

export type FrontendJournalEventType =
  | "user_message"
  | "turn_started"
  | "assistant_delivery"
  | "tool_started"
  | "tool_completed"
  | "structured_output"
  | "error"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"

const EVENT_TYPES = new Set<FrontendJournalEventType>([
  "user_message",
  "turn_started",
  "assistant_delivery",
  "tool_started",
  "tool_completed",
  "structured_output",
  "error",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
])

export interface FrontendJournalRef {
  agent: string
  friendId: string
  sessionId: string
}

export interface FrontendJournalEvent {
  version: 1
  sequence: number
  agent: string
  friendId: string
  sessionId: string
  turnId: string
  type: FrontendJournalEventType
  occurredAt: string
  data: Record<string, unknown>
}

export interface FrontendJournalReplay {
  events: FrontendJournalEvent[]
  lastSequence: number
  hasMore: boolean
  degraded: boolean
}

export class FrontendJournalCorruptError extends Error {
  constructor(journalPath: string) {
    super(`frontend journal has an invalid tail: ${journalPath}`)
    this.name = "FrontendJournalCorruptError"
  }
}

export class FrontendJournalPayloadTooLargeError extends Error {
  constructor(size: number, limit: number) {
    super(`frontend journal event is ${size} bytes; limit is ${limit}`)
    this.name = "FrontendJournalPayloadTooLargeError"
  }
}

function required(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must be a non-empty string`)
  return trimmed
}

function opaqueSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("journal data must be an object")
  return value as Record<string, unknown>
}

function parseEvent(raw: unknown, ref: FrontendJournalRef, expectedSequence: number): FrontendJournalEvent {
  const value = record(raw)
  if (value.version !== JOURNAL_VERSION) throw new Error("unsupported journal version")
  if (value.sequence !== expectedSequence) throw new Error("invalid journal sequence")
  if (value.agent !== ref.agent || value.friendId !== ref.friendId || value.sessionId !== ref.sessionId) {
    throw new Error("journal identity mismatch")
  }
  if (typeof value.turnId !== "string" || !value.turnId) throw new Error("invalid journal turnId")
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type as FrontendJournalEventType)) {
    throw new Error("invalid journal event type")
  }
  if (typeof value.occurredAt !== "string" || !value.occurredAt) throw new Error("invalid journal timestamp")
  return {
    version: JOURNAL_VERSION,
    sequence: expectedSequence,
    agent: ref.agent,
    friendId: ref.friendId,
    sessionId: ref.sessionId,
    turnId: value.turnId,
    type: value.type as FrontendJournalEventType,
    occurredAt: value.occurredAt,
    data: record(value.data),
  }
}

export class FrontendJournalStore {
  private readonly agentRoot: (agent: string) => string
  private readonly now: () => string
  private readonly maxEventBytes: number

  constructor(options: {
    agentRoot?: (agent: string) => string
    now?: () => string
    maxEventBytes?: number
  } = {}) {
    this.agentRoot = options.agentRoot ?? getAgentRoot
    this.now = options.now ?? (() => new Date().toISOString())
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
    if (!Number.isSafeInteger(this.maxEventBytes) || this.maxEventBytes < 1) {
      throw new Error("maxEventBytes must be a positive integer")
    }
  }

  pathFor(ref: FrontendJournalRef): string {
    const agent = required(ref.agent, "agent")
    const friendId = required(ref.friendId, "friendId")
    const sessionId = required(ref.sessionId, "sessionId")
    return path.join(
      this.agentRoot(agent),
      "state",
      "frontend-sessions",
      opaqueSegment(friendId),
      `${opaqueSegment(sessionId)}.jsonl`,
    )
  }

  replay(
    ref: FrontendJournalRef,
    options: { afterSequence?: number; limit?: number } = {},
  ): FrontendJournalReplay {
    const afterSequence = options.afterSequence ?? 0
    const limit = options.limit ?? DEFAULT_REPLAY_LIMIT
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a non-negative integer")
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer")
    }

    const journalPath = this.pathFor(ref)
    if (!fs.existsSync(journalPath)) {
      return { events: [], lastSequence: 0, hasMore: false, degraded: false }
    }

    const valid: FrontendJournalEvent[] = []
    let degraded = false
    const lines = fs.readFileSync(journalPath, "utf8").split("\n").filter((line) => line.length > 0)
    for (const line of lines) {
      try {
        valid.push(parseEvent(JSON.parse(line), ref, valid.length + 1))
      } catch {
        degraded = true
        break
      }
    }
    const matching = valid.filter((event) => event.sequence > afterSequence)
    return {
      events: matching.slice(0, limit),
      lastSequence: valid.at(-1)?.sequence ?? 0,
      hasMore: matching.length > limit,
      degraded,
    }
  }

  append(
    ref: FrontendJournalRef,
    input: { turnId: string; type: FrontendJournalEventType; data: Record<string, unknown> },
  ): FrontendJournalEvent {
    const journalPath = this.pathFor(ref)
    const replay = this.replay(ref)
    if (replay.degraded) throw new FrontendJournalCorruptError(journalPath)
    if (!EVENT_TYPES.has(input.type)) throw new Error("invalid journal event type")

    const event: FrontendJournalEvent = {
      version: JOURNAL_VERSION,
      sequence: replay.lastSequence + 1,
      agent: required(ref.agent, "agent"),
      friendId: required(ref.friendId, "friendId"),
      sessionId: required(ref.sessionId, "sessionId"),
      turnId: required(input.turnId, "turnId"),
      type: input.type,
      occurredAt: this.now(),
      data: record(input.data),
    }
    const encoded = `${JSON.stringify(event)}\n`
    const size = Buffer.byteLength(encoded)
    if (size > this.maxEventBytes) throw new FrontendJournalPayloadTooLargeError(size, this.maxEventBytes)

    // ponytail: semantic event volume is low; add a side index only if replay-on-append becomes measurable.
    const directory = path.dirname(journalPath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    fs.appendFileSync(journalPath, encoded, { encoding: "utf8", mode: 0o600 })
    fs.chmodSync(journalPath, 0o600)
    return event
  }
}
