import * as fs from "fs"
import * as path from "path"
import type { HabitRunOutcome, HabitRunReceipt } from "../../arc/flight-recorder"
import { listHabitRunReceipts } from "../../arc/flight-recorder"
import { emitNervesEvent } from "../../nerves/runtime"
import { loadSessionEnvelopeFile, projectProviderMessages } from "../session-events"

export type HabitSummaryWhich = "latest" | "previous" | "latest-success" | "latest-failure"

export interface HabitSessionSummarySelector {
  runId?: string
  habitName?: string
  operationId?: string
  which?: HabitSummaryWhich | string
}

export type HabitSummaryReceipt = HabitRunReceipt & {
  operationId?: string | null
}

export interface HabitSessionSummarySnapshot {
  summary: string
  decisions: string[]
  nextLikelyStep: string | null
}

export interface HabitSessionSummaryPending {
  count: number
  files: string[]
}

export interface HabitSessionSummarySources {
  receipt: string
  session: string
  pending: string
  runtimeState: string
}

export interface HabitSessionSummary {
  runId: string
  habitName: string
  operationId: string | null
  status: HabitRunOutcome
  triggeredAt: string
  completedAt: string
  summary: string
  decisions: string[]
  pending: HabitSessionSummaryPending
  messagesSent: HabitSummaryReceipt["surfaceAttempts"]
  toolsUsed: string[]
  producedRefs: HabitSummaryReceipt["producedRefs"]
  errors: string[]
  nextLikelyStep: string | null
  sources: HabitSessionSummarySources
  warnings: string[]
}

export type HabitSessionSummarySelectorErrorCode =
  | "run_id_exclusive"
  | "selector_required"
  | "invalid_which"
  | "not_found"

export interface HabitSessionSummarySelectorError {
  code: HabitSessionSummarySelectorErrorCode
  message: string
}

export type HabitSummaryReceiptSelection =
  | { ok: true; receipt: HabitSummaryReceipt }
  | { ok: false; error: HabitSessionSummarySelectorError }

const VALID_WHICH = new Set<HabitSummaryWhich>(["latest", "previous", "latest-success", "latest-failure"])

const SUCCESS_OUTCOMES = new Set<HabitRunOutcome>([
  "no_change",
  "wrote_arc",
  "updated_desk",
  "wrote_record",
  "surfaced",
])

const FAILURE_OUTCOMES = new Set<HabitRunOutcome>(["blocked", "error"])
const MAX_SUMMARY_CHARS = 1600
const TRUNCATION_SUFFIX = "\n[truncated]"

function selectorError(code: HabitSessionSummarySelectorErrorCode, message: string): HabitSummaryReceiptSelection {
  return { ok: false, error: { code, message } }
}

function normalizeWhich(value: string | undefined): HabitSummaryWhich | null {
  if (value === undefined) return "latest"
  return VALID_WHICH.has(value as HabitSummaryWhich) ? value as HabitSummaryWhich : null
}

function sortNewestFirst(receipts: HabitSummaryReceipt[]): HabitSummaryReceipt[] {
  return [...receipts].sort((left, right) => right.endedAt.localeCompare(left.endedAt) || right.runId.localeCompare(left.runId))
}

function filterReceipts(receipts: HabitSummaryReceipt[], selector: HabitSessionSummarySelector): HabitSummaryReceipt[] {
  return receipts.filter((receipt) => {
    if (selector.habitName !== undefined && receipt.habitName !== selector.habitName) return false
    if (selector.operationId !== undefined && receipt.operationId !== selector.operationId) return false
    return true
  })
}

function filterByWhich(receipts: HabitSummaryReceipt[], which: HabitSummaryWhich): HabitSummaryReceipt[] {
  if (which === "latest" || which === "previous") return receipts
  const outcomes = which === "latest-success" ? SUCCESS_OUTCOMES : FAILURE_OUTCOMES
  return receipts.filter((receipt) => outcomes.has(receipt.outcome))
}

export function selectHabitRunReceipt(
  receipts: readonly HabitSummaryReceipt[],
  selector: HabitSessionSummarySelector,
): HabitSummaryReceiptSelection {
  if (selector.runId !== undefined) {
    if (selector.habitName !== undefined || selector.operationId !== undefined || selector.which !== undefined) {
      return selectorError("run_id_exclusive", "runId cannot be combined with habitName, operationId, or which")
    }
    const receipt = receipts.find((entry) => entry.runId === selector.runId)
    return receipt ? { ok: true, receipt } : selectorError("not_found", "no habit run matched selector")
  }

  if (selector.habitName === undefined && selector.operationId === undefined) {
    return selectorError("selector_required", "provide runId, habitName, or operationId")
  }

  const which = normalizeWhich(selector.which)
  if (which === null) {
    return selectorError("invalid_which", "which must be latest, previous, latest-success, or latest-failure")
  }

  const matches = filterByWhich(sortNewestFirst(filterReceipts([...receipts], selector)), which)
  const index = which === "previous" ? 1 : 0
  const receipt = matches[index]
  return receipt ? { ok: true, receipt } : selectorError("not_found", "no habit run matched selector")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function summarySnapshot(receipt: HabitSummaryReceipt): HabitSessionSummarySnapshot {
  const snapshot = receipt.summarySnapshot
  return {
    summary: snapshot.summary,
    decisions: snapshot.decisions,
    nextLikelyStep: snapshot.nextLikelyStep,
  }
}

function relativeSource(receipt: HabitSummaryReceipt, key: keyof HabitSessionSummarySources): string {
  if (key === "receipt") return receipt.receiptLocator
  if (key === "session") return receipt.sessionLocator
  if (key === "pending") return receipt.pendingLocator
  return receipt.runtimeStateLocator
}

function safeSourcePath(
  agentRoot: string,
  locator: string,
  key: keyof HabitSessionSummarySources,
  expectedPrefix: string,
): { ok: true; filePath: string } | { ok: false; warning: string } {
  const normalizedInput = locator.replace(/\\/g, "/")
  const normalized = path.posix.normalize(normalizedInput)
  const unsafe = path.isAbsolute(locator)
    || normalizedInput.startsWith("/")
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized !== normalizedInput
    || !normalized.startsWith(expectedPrefix)
  if (unsafe) {
    return { ok: false, warning: `${key} locator unsafe: ${locator}` }
  }
  const root = path.resolve(agentRoot)
  const filePath = path.resolve(agentRoot, normalized)
  /* v8 ignore next -- defensive containment check after normalized bundle-relative locator validation @preserve */
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return { ok: false, warning: `${key} locator escaped bundle: ${locator}` }
  }
  return { ok: true, filePath }
}

function safeExistingRealPath(
  agentRoot: string,
  filePath: string,
  key: keyof HabitSessionSummarySources,
  locator: string,
): { ok: true; filePath: string } | { ok: false; warning: string } {
  try {
    const root = fs.realpathSync.native(agentRoot)
    const realPath = fs.realpathSync.native(filePath)
    if (realPath !== root && !realPath.startsWith(`${root}${path.sep}`)) {
      return { ok: false, warning: `${key} locator escaped bundle via symlink: ${locator}` }
    }
    return { ok: true, filePath: realPath }
  } catch {
    /* v8 ignore next -- defensive realpath race/permission guard; existence is checked before callers invoke this @preserve */
    return { ok: false, warning: `${key} locator unreadable: ${locator}` }
  }
}

function sessionSummaryFromMessages(messages: unknown[]): {
  decisions: string[]
  nextLikelyStep: string | null
  toolsUsed: string[]
  warnings: string[]
} {
  const toolsUsed = new Set<string>()
  for (const message of messages) {
    /* v8 ignore next -- defensive: session projection returns message records; this protects malformed direct projection callers @preserve */
    if (!isRecord(message)) continue
    const name = stringValue(message.name) ?? stringValue(message.toolName)
    /* v8 ignore next -- defensive: canonical projections expose tool names from assistant tool_calls; legacy direct tool-name projections still count if present @preserve */
    if (name && message.role === "tool") toolsUsed.add(name)
    if (Array.isArray(message.tool_calls)) {
      /* v8 ignore start -- defensive: projected provider messages normally expose structured tool calls; malformed direct envelopes are kept inert @preserve */
      for (const toolCall of message.tool_calls) {
        if (!isRecord(toolCall)) continue
        const fn = isRecord(toolCall.function) ? toolCall.function : null
        const toolName = fn ? stringValue(fn.name) : null
        if (toolName) toolsUsed.add(toolName)
      }
      /* v8 ignore stop @preserve */
    }
  }
  const warnings = messages.length === 0 ? ["session file had no usable messages"] : []
  return {
    decisions: [],
    nextLikelyStep: null,
    toolsUsed: [...toolsUsed].sort(),
    warnings,
  }
}

function readSessionEnrichment(agentRoot: string, receipt: HabitSummaryReceipt): {
  decisions: string[]
  nextLikelyStep: string | null
  toolsUsed: string[]
  warnings: string[]
} {
  const source = safeSourcePath(agentRoot, receipt.sessionLocator, "session", "state/habit-sessions/")
  if (!source.ok) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: [source.warning] }
  }
  if (!fs.existsSync(source.filePath)) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: ["session file missing"] }
  }
  const realSource = safeExistingRealPath(agentRoot, source.filePath, "session", receipt.sessionLocator)
  if (!realSource.ok) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: [realSource.warning] }
  }
  const envelope = loadSessionEnvelopeFile(realSource.filePath)
  if (!envelope) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: ["session file malformed"] }
  }
  return sessionSummaryFromMessages(projectProviderMessages(envelope))
}

function readPending(agentRoot: string, receipt: HabitSummaryReceipt): { pending: HabitSessionSummaryPending; warnings: string[] } {
  const source = safeSourcePath(agentRoot, receipt.pendingLocator, "pending", "state/habit-sessions/")
  if (!source.ok) return { pending: { count: 0, files: [] }, warnings: [source.warning] }
  try {
    if (!fs.existsSync(source.filePath)) return { pending: { count: 0, files: [] }, warnings: [] }
    const realSource = safeExistingRealPath(agentRoot, source.filePath, "pending", receipt.pendingLocator)
    if (!realSource.ok) return { pending: { count: 0, files: [] }, warnings: [realSource.warning] }
    const entries = fs.readdirSync(realSource.filePath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
    return { pending: { count: entries.length, files: entries }, warnings: [] }
  } catch {
    return { pending: { count: 0, files: [] }, warnings: [] }
  }
}

function runtimeOperationId(agentRoot: string, receipt: HabitSummaryReceipt): { operationId: string | null; warnings: string[] } {
  const source = safeSourcePath(agentRoot, receipt.runtimeStateLocator, "runtimeState", "state/habits/")
  if (!source.ok) return { operationId: null, warnings: [source.warning] }
  try {
    if (!fs.existsSync(source.filePath)) return { operationId: null, warnings: [] }
    const realSource = safeExistingRealPath(agentRoot, source.filePath, "runtimeState", receipt.runtimeStateLocator)
    if (!realSource.ok) return { operationId: null, warnings: [realSource.warning] }
    const parsed = JSON.parse(fs.readFileSync(realSource.filePath, "utf-8")) as unknown
    if (!isRecord(parsed)) return { operationId: null, warnings: [] }
    if (parsed.schemaVersion !== 1) return { operationId: null, warnings: [] }
    if (stringValue(parsed.name) !== receipt.habitName) return { operationId: null, warnings: [] }
    if (stringValue(parsed.latestRunId) !== receipt.runId) return { operationId: null, warnings: [] }
    if (stringValue(parsed.latestReceiptLocator) !== receipt.receiptLocator) return { operationId: null, warnings: [] }
    return { operationId: stringValue(parsed.activeOperationId), warnings: [] }
  } catch {
    return { operationId: null, warnings: [] }
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function truncateSummary(value: string): string {
  if (value.length <= MAX_SUMMARY_CHARS) return value
  return `${value.slice(0, MAX_SUMMARY_CHARS - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
}

function legacySummaryWarnings(receipt: HabitSummaryReceipt): string[] {
  return receipt.permissionEnvelope.warnings.some((warning) => warning.includes("legacy receipt normalized"))
    ? ["legacy receipt normalized"]
    : []
}

export function readHabitSessionSummary(
  agentRoot: string,
  selector: HabitSessionSummarySelector,
): HabitSessionSummary | null {
  const selection = selectHabitRunReceipt(listHabitRunReceipts(agentRoot), selector)
  if (!selection.ok) return null

  const receipt = selection.receipt
  const snapshot = summarySnapshot(receipt)
  const session = readSessionEnrichment(agentRoot, receipt)
  const pending = readPending(agentRoot, receipt)
  const runtime = runtimeOperationId(agentRoot, receipt)
  const operationId = receipt.operationId ?? runtime.operationId
  const decisions = uniqueStrings([
    ...snapshot.decisions,
    ...session.decisions,
  ])
  const summary = truncateSummary(snapshot.summary)
  const nextLikelyStep = snapshot.nextLikelyStep ?? session.nextLikelyStep
  const result: HabitSessionSummary = {
    runId: receipt.runId,
    habitName: receipt.habitName,
    operationId: operationId ?? null,
    status: receipt.outcome,
    triggeredAt: receipt.startedAt,
    completedAt: receipt.endedAt,
    summary,
    decisions,
    pending: pending.pending,
    messagesSent: receipt.surfaceAttempts,
    toolsUsed: session.toolsUsed,
    producedRefs: receipt.producedRefs,
    errors: receipt.errors,
    nextLikelyStep: nextLikelyStep ?? null,
    sources: {
      receipt: relativeSource(receipt, "receipt"),
      session: relativeSource(receipt, "session"),
      pending: relativeSource(receipt, "pending"),
      runtimeState: relativeSource(receipt, "runtimeState"),
    },
    warnings: [
      ...legacySummaryWarnings(receipt),
      ...session.warnings,
      ...pending.warnings,
      ...runtime.warnings,
    ],
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_session_summary_read",
    message: "habit session summary read",
    meta: { agentRoot, runId: receipt.runId, habitName: receipt.habitName, warningCount: result.warnings.length },
  })
  return result
}
