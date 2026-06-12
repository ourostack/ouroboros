import * as fs from "fs"
import * as path from "path"
import type { HabitRunOutcome, HabitRunReceipt } from "../../arc/flight-recorder"
import { listHabitRunReceipts } from "../../arc/flight-recorder"
import { emitNervesEvent } from "../../nerves/runtime"

export type HabitSummaryWhich = "latest" | "previous" | "latest-success" | "latest-failure"

export interface HabitSessionSummarySelector {
  runId?: string
  habitName?: string
  operationId?: string
  which?: HabitSummaryWhich | string
}

export type HabitSummaryReceipt = HabitRunReceipt & {
  operationId?: string | null
  summarySnapshot?: HabitSessionSummarySnapshot
}

export interface HabitSessionSummarySnapshot {
  summary?: string
  decisions?: string[]
  nextLikelyStep?: string | null
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : []
}

function summarySnapshot(receipt: HabitSummaryReceipt): HabitSessionSummarySnapshot | null {
  const snapshot = (receipt as unknown as Record<string, unknown>).summarySnapshot
  if (!isRecord(snapshot)) return null
  return {
    ...(stringValue(snapshot.summary) ? { summary: stringValue(snapshot.summary)! } : {}),
    decisions: stringArray(snapshot.decisions),
    ...(snapshot.nextLikelyStep === null ? { nextLikelyStep: null } : {}),
    ...(stringValue(snapshot.nextLikelyStep) ? { nextLikelyStep: stringValue(snapshot.nextLikelyStep) } : {}),
  }
}

function relativeSource(receipt: HabitSummaryReceipt, key: keyof HabitSessionSummarySources): string {
  if (key === "receipt") return receipt.receiptLocator
  if (key === "session") return receipt.sessionLocator
  if (key === "pending") return receipt.pendingLocator
  return receipt.runtimeStateLocator
}

function absoluteSource(agentRoot: string, locator: string): string {
  return path.join(agentRoot, locator)
}

function readJsonFile(filePath: string): { ok: true; value: unknown } | { ok: false; warning: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown }
  } catch (error) {
    return {
      ok: false,
      warning: `session file malformed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function sessionSummary(value: unknown): {
  decisions: string[]
  nextLikelyStep: string | null
  toolsUsed: string[]
  warnings: string[]
} {
  if (!isRecord(value)) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: ["session file malformed: expected object"] }
  }
  const messages = Array.isArray(value.messages) ? value.messages : []
  const toolsUsed = new Set<string>()
  for (const message of messages) {
    if (!isRecord(message)) continue
    const name = stringValue(message.name) ?? stringValue(message.toolName)
    if (name) toolsUsed.add(name)
  }
  const summary = isRecord(value.summary) ? value.summary : {}
  const warnings = messages.length === 0 ? ["session file had no usable messages"] : []
  return {
    decisions: stringArray(summary.decisions),
    nextLikelyStep: stringValue(summary.nextLikelyStep),
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
  const sessionPath = absoluteSource(agentRoot, receipt.sessionLocator)
  if (!fs.existsSync(sessionPath)) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: ["session file missing"] }
  }
  const parsed = readJsonFile(sessionPath)
  if (!parsed.ok) {
    return { decisions: [], nextLikelyStep: null, toolsUsed: [], warnings: [parsed.warning] }
  }
  return sessionSummary(parsed.value)
}

function readPending(agentRoot: string, receipt: HabitSummaryReceipt): HabitSessionSummaryPending {
  const pendingPath = absoluteSource(agentRoot, receipt.pendingLocator)
  try {
    const entries = fs.existsSync(pendingPath)
      ? fs.readdirSync(pendingPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
      : []
    return { count: entries.length, files: entries }
  } catch {
    return { count: 0, files: [] }
  }
}

function runtimeOperationId(agentRoot: string, receipt: HabitSummaryReceipt): string | null {
  const runtimePath = absoluteSource(agentRoot, receipt.runtimeStateLocator)
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimePath, "utf-8")) as unknown
    if (!isRecord(parsed)) return null
    return stringValue(parsed.activeOperationId)
  } catch {
    return null
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function fallbackSummary(receipt: HabitSummaryReceipt): string {
  return `Habit ${receipt.habitName} finished with ${receipt.outcome}.`
}

function legacySummaryWarnings(receipt: HabitSummaryReceipt, snapshot: HabitSessionSummarySnapshot | null): string[] {
  if (snapshot) return []
  return receipt.permissionEnvelope.warnings.some((warning) => warning.includes("legacy receipt normalized"))
    ? ["legacy receipt normalized without summary snapshot"]
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
  const operationId = receipt.operationId ?? runtimeOperationId(agentRoot, receipt)
  const decisions = uniqueStrings([
    ...(snapshot?.decisions ?? []),
    ...session.decisions,
  ])
  const summary = snapshot?.summary ?? fallbackSummary(receipt)
  const nextLikelyStep = snapshot?.nextLikelyStep ?? session.nextLikelyStep
  const result: HabitSessionSummary = {
    runId: receipt.runId,
    habitName: receipt.habitName,
    operationId: operationId ?? null,
    status: receipt.outcome,
    triggeredAt: receipt.startedAt,
    completedAt: receipt.endedAt,
    summary,
    decisions,
    pending,
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
    warnings: [...legacySummaryWarnings(receipt, snapshot), ...session.warnings],
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_session_summary_read",
    message: "habit session summary read",
    meta: { agentRoot, runId: receipt.runId, habitName: receipt.habitName, warningCount: result.warnings.length },
  })
  return result
}
