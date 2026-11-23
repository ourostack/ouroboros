/**
 * Turns `engine.turn_summary` log lines into Watch's private rows, and rows into counts a day by channel.
 *
 * A line is kept only if its summary has every field of the event's shape: every string from its fixed list or shaped
 * like an id, every count a whole number. Anything else is rejected by reason alone. A row is built field by field from
 * that shape, so a field the event gains later is left out rather than copied, and a summary from before
 * `runtimeVersion` existed is kept with `runtimeVersion: "unknown"`. Tool names come from tool definitions, never from
 * message text; one that isn't shaped like a tool name is kept as `other`. The turn is named only by a salted hash of
 * its trace id; the message and the trace id themselves are never kept. Watch prints only counts, never these names.
 */
import crypto from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  TURN_SUMMARY_CHANNELS,
  TURN_SUMMARY_ERROR_CLASSES,
  TURN_SUMMARY_OUTCOMES,
  TurnTally,
  type TurnSummaryMeta,
} from "../../heart/turn-summary"
import type { AgentProvider } from "../../heart/identity"

export interface WatchRow extends TurnSummaryMeta {
  /** UTC day of the turn's end, YYYY-MM-DD. */
  day: string
  /** First 16 hex digits of sha256(salt + trace id). */
  turn: string
  /** The bundle's commit when Watch read the line, which may be later than the turn. */
  bundleCommitAtWatch: string
}

export type RowResult = { kind: "row"; row: WatchRow } | { kind: "rejected"; reason: "parse" | "schema" } | { kind: "skip" }

export interface DayChannelCounts {
  turns: number
  steps: number
  stepBudgetStops: number
  toolCalls: number
  toolErrors: number
  unknownToolCalls: number
  findToolsCalls: number
  findToolsLoaded: number
  loadedThenCalled: number
  providerSwitches: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  outcomes: Record<string, number>
  errorClasses: Record<string, number>
}

export type DailyCounts = Record<string, Record<string, DayChannelCounts>>

const EVENT = "engine.turn_summary"
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/
/** The providers an agent can be configured with, plus the tally's labels for none and for a malformed id. */
export const WATCH_PROVIDERS = [
  "azure", "minimax", "anthropic", "openai-codex", "github-copilot", "openai-compatible", "openai-compatible-gemini",
] as const satisfies readonly AgentProvider[]
const PROVIDER_LABELS: readonly string[] = [...WATCH_PROVIDERS, "unknown", "other"]
/** Model ids as providers name them: lowercase, digits, dots and dashes (no spaces, slashes or capitals). */
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const STRING_FIELDS: Record<string, (value: string) => boolean> = {
  channel: (value) => (TURN_SUMMARY_CHANNELS as readonly string[]).includes(value),
  outcome: (value) => (TURN_SUMMARY_OUTCOMES as readonly string[]).includes(value),
  errorClass: (value) => (TURN_SUMMARY_ERROR_CLASSES as readonly string[]).includes(value),
  provider: (value) => PROVIDER_LABELS.includes(value),
  model: (value) => MODEL.test(value),
  runtimeVersion: (value) => ID.test(value),
}

let summaryKeys: string[] | undefined
/** The summary's field names, taken from the tally itself so the two can't drift. */
function expectedKeys(): string[] {
  summaryKeys ??= Object.keys(new TurnTally().summarize({ channel: "cli", outcome: "settled", errorClass: "none" })).sort()
  return summaryKeys
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
/** A tool's own name, a whole MCP server's label, or the tally's label for a name the turn didn't offer. */
const TOOL_LABEL = /^(?:[a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9][A-Za-z0-9_.-]{0,47})$/
const OTHER_TOOL = "other"

function toolCounts(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const counts: Record<string, number> = {}
  for (const [name, count] of Object.entries(value)) {
    if (!isCount(count)) return null
    const label = TOOL_LABEL.test(name) ? name : OTHER_TOOL
    counts[label] = (counts[label] ?? 0) + count
  }
  return counts
}

/** The summary rebuilt from its known fields only, or null if any is missing or malformed. */
function cleanMeta(meta: unknown): TurnSummaryMeta | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null
  const record = { runtimeVersion: "unknown", ...(meta as Record<string, unknown>) }
  const clean: Record<string, unknown> = {}
  for (const key of expectedKeys()) {
    const value = record[key as keyof typeof record]
    const checkString = STRING_FIELDS[key]
    if (checkString) {
      if (typeof value !== "string" || !checkString(value)) return null
      clean[key] = value
    } else if (key === "toolCalls") {
      const counts = toolCounts(value)
      if (!counts) return null
      clean[key] = counts
    } else if (isCount(value)) {
      clean[key] = value
    } else {
      return null
    }
  }
  return clean as unknown as TurnSummaryMeta
}

export function rowFromLine(line: string, context: { salt: string; bundleCommitAtWatch: string }): RowResult {
  // Cheap filter first: most lines are other events and are never parsed.
  if (!line.includes(`"${EVENT}"`)) return { kind: "skip" }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: "rejected", reason: "parse" }
  }
  const entry = parsed as Record<string, unknown>
  if (typeof parsed !== "object" || parsed === null || entry.event !== EVENT) return { kind: "skip" }
  const day = typeof entry.ts === "string" ? TIMESTAMP.exec(entry.ts)?.[1] : undefined
  const meta = cleanMeta(entry.meta)
  if (!day || typeof entry.trace_id !== "string" || !meta) return { kind: "rejected", reason: "schema" }
  const turn = crypto.createHash("sha256").update(context.salt).update(entry.trace_id).digest("hex").slice(0, 16)
  return { kind: "row", row: { day, turn, bundleCommitAtWatch: context.bundleCommitAtWatch, ...meta } }
}

function emptyCounts(): DayChannelCounts {
  return {
    turns: 0, steps: 0, stepBudgetStops: 0, toolCalls: 0, toolErrors: 0, unknownToolCalls: 0, findToolsCalls: 0,
    findToolsLoaded: 0, loadedThenCalled: 0, providerSwitches: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    outcomes: {}, errorClasses: {},
  }
}

export function dailyCounts(rows: readonly WatchRow[]): DailyCounts {
  const days: DailyCounts = {}
  for (const row of rows) {
    days[row.day] ??= {}
    const counts = (days[row.day][row.channel] ??= emptyCounts())
    counts.turns += 1
    counts.steps += row.steps
    counts.stepBudgetStops += row.stepBudgetExhausted
    counts.toolCalls += Object.values(row.toolCalls).reduce((sum, count) => sum + count, 0)
    counts.toolErrors += row.toolErrors
    counts.unknownToolCalls += row.unknownToolCalls
    counts.findToolsCalls += row.findToolsCalls
    counts.findToolsLoaded += row.findToolsLoaded
    counts.loadedThenCalled += row.loadedThenCalled
    counts.providerSwitches += row.providerSwitches
    counts.inputTokens += row.inputTokens
    counts.outputTokens += row.outputTokens
    counts.reasoningTokens += row.reasoningTokens
    counts.outcomes[row.outcome] = (counts.outcomes[row.outcome] ?? 0) + 1
    if (row.errorClass !== "none") counts.errorClasses[row.errorClass] = (counts.errorClasses[row.errorClass] ?? 0) + 1
  }
  emitNervesEvent({ component: "eval", event: "eval.watch_counted", message: "Watch counted turn summaries", meta: { rows: rows.length } })
  return days
}
