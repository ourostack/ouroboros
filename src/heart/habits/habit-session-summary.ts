import type { HabitRunOutcome, HabitRunReceipt } from "../../arc/flight-recorder"

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
