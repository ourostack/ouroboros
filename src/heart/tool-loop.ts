import * as crypto from "crypto"

import { emitNervesEvent } from "../nerves/runtime"

export type ToolLoopDetectorKind =
  | "generic_repeat"
  | "known_poll_no_progress"
  | "ping_pong"
  | "global_circuit_breaker"

export type ToolLoopDetection =
  | { stuck: false }
  | {
      stuck: true
      detector: ToolLoopDetectorKind
      count: number
      message: string
      pairedToolName?: string
    }

interface ToolLoopRecord {
  toolName: string
  callHash: string
  outcomeHash: string
  isKnownPoll: boolean
}

export interface ToolLoopState {
  history: ToolLoopRecord[]
}

export const TOOL_LOOP_HISTORY_LIMIT = 30
export const POLL_NO_PROGRESS_LIMIT = 3
export const GENERIC_REPEAT_LIMIT = 4
export const PING_PONG_WINDOW = 6
export const GLOBAL_CIRCUIT_BREAKER_LIMIT = 24

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  /* v8 ignore next -- stableStringify currently receives only objects/strings from normalized loop inputs @preserve */
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex")
}

function normalizeArgs(toolName: string, args: Record<string, string>): Record<string, unknown> {
  if (toolName === "query_active_work") {
    return { toolName }
  }

  if (toolName === "coding_status" || toolName === "coding_tail") {
    return {
      toolName,
      sessionId: args.sessionId ?? "",
    }
  }

  if (toolName === "query_session") {
    return {
      toolName,
      mode: args.mode ?? "",
      friendId: args.friendId ?? "",
      channel: args.channel ?? "",
      key: args.key ?? "",
      query: args.query ?? "",
    }
  }

  return {
    toolName,
    args,
  }
}

function normalizeOutcome(result: string, success: boolean): Record<string, unknown> {
  return {
    success,
    result: result.replace(/\s+/g, " ").trim(),
  }
}

function isKnownPollTool(toolName: string, args: Record<string, string>): boolean {
  return toolName === "query_active_work"
    || toolName === "coding_status"
    || toolName === "coding_tail"
    || (toolName === "query_session" && (args.mode ?? "").trim() === "status")
}

function emitDetection(
  detector: ToolLoopDetectorKind,
  toolName: string,
  count: number,
  message: string,
  pairedToolName?: string,
): ToolLoopDetection {
  emitNervesEvent({
    level: "warn",
    component: "engine",
    event: "engine.tool_loop_detected",
    message: "tool loop guard detected repeated non-progress work",
    meta: {
      detector,
      toolName,
      count,
      pairedToolName: pairedToolName ?? null,
    },
  })

  return {
    stuck: true,
    detector,
    count,
    message,
    pairedToolName,
  }
}

function countTrailingRepeats(history: ToolLoopRecord[], toolName: string, callHash: string): { count: number; outcomeHash?: string } {
  let count = 0
  let outcomeHash: string | undefined

  for (let index = history.length - 1; index >= 0; index--) {
    const record = history[index]
    if (record.toolName !== toolName || record.callHash !== callHash) {
      break
    }
    if (!outcomeHash) {
      outcomeHash = record.outcomeHash
    }
    if (record.outcomeHash !== outcomeHash) {
      break
    }
    count += 1
  }

  return { count, outcomeHash }
}

function detectPingPong(history: ToolLoopRecord[], toolName: string, callHash: string): ToolLoopDetection {
  if (history.length < PING_PONG_WINDOW) {
    return { stuck: false }
  }

  const recent = history.slice(-PING_PONG_WINDOW)
  const first = recent[0]
  const second = recent[1]

  if (!first.isKnownPoll || !second.isKnownPoll) {
    return { stuck: false }
  }
  if (first.toolName === second.toolName && first.callHash === second.callHash) {
    return { stuck: false }
  }

  for (let index = 0; index < recent.length; index++) {
    const expected = index % 2 === 0 ? first : second
    const actual = recent[index]
    if (
      actual.toolName !== expected.toolName
      || actual.callHash !== expected.callHash
      || actual.outcomeHash !== expected.outcomeHash
    ) {
      return { stuck: false }
    }
  }

  const matchesPair =
    (toolName === first.toolName && callHash === first.callHash)
    || (toolName === second.toolName && callHash === second.callHash)
  if (!matchesPair) {
    return { stuck: false }
  }

  const pairedToolName = toolName === first.toolName ? second.toolName : first.toolName
  return emitDetection(
    "ping_pong",
    toolName,
    PING_PONG_WINDOW,
    `repeated ${first.toolName}/${second.toolName} polling is not changing. stop cycling between status checks and either act on the current state, change approach, or answer truthfully with what is known.`,
    pairedToolName,
  )
}

export function createToolLoopState(): ToolLoopState {
  return { history: [] }
}

export function recordToolOutcome(
  state: ToolLoopState,
  toolName: string,
  args: Record<string, string>,
  result: string,
  success: boolean,
): void {
  state.history.push({
    toolName,
    callHash: digest(normalizeArgs(toolName, args)),
    outcomeHash: digest(normalizeOutcome(result, success)),
    isKnownPoll: isKnownPollTool(toolName, args),
  })

  if (state.history.length > TOOL_LOOP_HISTORY_LIMIT) {
    state.history.splice(0, state.history.length - TOOL_LOOP_HISTORY_LIMIT)
  }
}

// Tools that must never be blocked by the circuit breaker.
// settle = end the turn, surface = deliver results outward.
// ponder = continue thinking (inner dialog) or hand off to inner dialog (outer).
// rest = end inner dialog turn (added in Unit 8b).
// Blocking these traps the agent: it can think all it wants but can never speak or stop.
const CIRCUIT_BREAKER_EXEMPT = new Set(["settle", "surface", "ponder", "rest"])

export function detectToolLoop(
  state: ToolLoopState,
  toolName: string,
  args: Record<string, string>,
): ToolLoopDetection {
  if (state.history.length >= GLOBAL_CIRCUIT_BREAKER_LIMIT && !CIRCUIT_BREAKER_EXEMPT.has(toolName)) {
    return emitDetection(
      "global_circuit_breaker",
      toolName,
      state.history.length,
      `this turn has already made ${state.history.length} tool calls. stop thrashing, use the current evidence, and either change approach or answer truthfully with the best grounded status.`,
    )
  }

  const callHash = digest(normalizeArgs(toolName, args))
  const trailing = countTrailingRepeats(state.history, toolName, callHash)

  if (isKnownPollTool(toolName, args) && trailing.count >= POLL_NO_PROGRESS_LIMIT) {
    return emitDetection(
      "known_poll_no_progress",
      toolName,
      trailing.count,
      `repeated ${toolName} calls have returned the same state ${trailing.count} times. stop polling and either act on the current state, wait for a meaningful change, or answer truthfully with what is known.`,
    )
  }

  if (trailing.count >= GENERIC_REPEAT_LIMIT) {
    return emitDetection(
      "generic_repeat",
      toolName,
      trailing.count,
      `repeating ${toolName} with the same inputs is not producing new information. change approach, use the evidence already gathered, or answer truthfully with what is known.`,
    )
  }

  return detectPingPong(state.history, toolName, callHash)
}
