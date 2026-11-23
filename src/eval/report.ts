/**
 * Grading runs into cells and writing what an eval run found. A cell is one (case, target, bundle ref): pass@1 is
 * passes over finished runs with a Wilson 95% interval. A run passes only when its turn settled and every check
 * passed; a turn that errored, was aborted or was refused a call fails with that reason, never skipped or retried.
 *
 * The full report, every observation included, is private: created once (`wx`) with mode 0600 in a 0700 folder. The
 * summary holds scores, counts, spend and fidelity gaps, never trace or reply text, so it can go into a task card.
 * `RunResult` (schemaVersion 1) is the format the census joins on by action id.
 */
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import type { Check } from "./assertions"
import type { Cost } from "./budget"
import type { Case, Observation } from "./domain/case"
import { wilsonInterval } from "./domain/stats"
import type { QuotaSnapshot } from "./targets"

export type RunRecord = {
  caseId: string
  run: number
  passed: boolean
  reason: string | null
  outcome: string
  steps: number
  spent: Cost
  /** The per-call worst case its reservation held. */
  reserved: Cost
  /** Its own credit reservation ran out before it finished: not scored, counted as not run. */
  budgetCut: boolean
  checks: Check[]
  gaps: string[]
  /** It passed without the books CLI's remove or replace subcommand, so by the shell. */
  viaShellFallback: boolean
  observation: Observation
}

export type Cell = {
  caseId: string
  actionIds: string[]
  target: string
  bundleRef: string
  harnessRef: string
  planned: number
  completed: number
  notRun: number
  passes: number
  passAt1: number | null
  interval: { low: number | null; high: number | null }
  reasons: Record<string, number>
  passesViaShellFallback: number
  fidelityGaps: string[]
}

export type RunResult = {
  schemaVersion: 1
  target: string
  bundleRef: string
  harnessRef: string
  account: string | null
  premiumMultiplier: number
  multiplierSource: string
  caps: { premium?: number; credits?: number }
  spent: Cost
  calls: number
  stopped: string | null
  quota: { before: QuotaSnapshot; after: QuotaSnapshot }
  cells: Cell[]
}

export function gradeRun(obs: Observation, graded: { passed: boolean; checks: Check[] }): { passed: boolean; reason: string | null } {
  if (obs.outcome !== "settled") return { passed: false, reason: `outcome ${obs.outcome}` }
  if (graded.passed) return { passed: true, reason: null }
  return { passed: false, reason: `failed ${graded.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}` }
}

const BOOKS_REMOVE = /\bbooks\b[^\n]*\blibrary\s+(remove|replace)\b/

/** Whether no tool call ran the books CLI's `library remove` or `library replace`. */
export function withoutBooksRemove(obs: Observation): boolean {
  return !obs.timeline.some((entry) => entry.kind === "call" && BOOKS_REMOVE.test(entry.args))
}

export function buildCells(cases: Case[], at: { target: string; bundleRef: string; harnessRef: string; planned: number }, runs: RunRecord[]): Cell[] {
  return cases.map((c) => {
    const mine = runs.filter((run) => run.caseId === c.id && !run.budgetCut)
    const passes = mine.filter((run) => run.passed).length
    const interval = wilsonInterval(passes, mine.length)
    const reasons: Record<string, number> = {}
    for (const run of mine) if (run.reason) reasons[run.reason] = (reasons[run.reason] ?? 0) + 1
    return {
      caseId: c.id, actionIds: [...c.actionIds], target: at.target, bundleRef: at.bundleRef, harnessRef: at.harnessRef,
      planned: at.planned, completed: mine.length, notRun: at.planned - mine.length, passes,
      passAt1: mine.length === 0 ? null : passes / mine.length,
      interval: { low: interval.low, high: interval.high },
      reasons,
      passesViaShellFallback: mine.filter((run) => run.passed && run.viaShellFallback).length,
      fidelityGaps: [...new Set(mine.flatMap((run) => run.gaps))].sort(),
    }
  })
}

/** Only called for a cell with finished runs, whose score and bounds are numbers. */
const fixed = (value: number | null): string => Number(value).toFixed(2)

export function summarize(input: { target: string; bundleRef: string; cells: Cell[]; spent: Cost; stopped: string | undefined; quota: RunResult["quota"] }): string {
  const lines = [`${input.target} on ${input.bundleRef}`]
  for (const cell of input.cells) {
    const score = cell.completed === 0 ? "0/0 (unscored)" : `${cell.passes}/${cell.completed} = ${fixed(cell.passAt1)} [${fixed(cell.interval.low)}, ${fixed(cell.interval.high)}]`
    const reasons = Object.entries(cell.reasons).map(([reason, count]) => `${reason} x${count}`).join("; ")
    lines.push(`  ${cell.caseId}: ${score}${cell.notRun ? `, ${cell.notRun} not run` : ""}${cell.passesViaShellFallback ? `, ${cell.passesViaShellFallback} passed by shell` : ""}${reasons ? `; ${reasons}` : ""}`)
  }
  lines.push(`  spent: premium requests ${input.spent.premium}, credits ${input.spent.credits}`)
  const remaining = (snapshot: QuotaSnapshot): string => snapshot.reading?.remaining == null ? "unknown" : String(snapshot.reading.remaining)
  lines.push(`  Copilot premium remaining: ${remaining(input.quota.before)} before, ${remaining(input.quota.after)} after; token-billed: ${input.quota.after.tokenBased ?? input.quota.before.tokenBased ?? "unknown"}`)
  lines.push(`  fidelity gaps: ${[...new Set(input.cells.flatMap((cell) => cell.fidelityGaps))].sort().join(", ") || "none"}`)
  if (input.stopped) lines.push(`  stopped: ${input.stopped}`)
  return lines.join("\n")
}

/** Writes `report` to a new file, mode 0600, making its folder 0700; refuses a file that already exists. */
export function writePrivateReport(file: string, report: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(file), 0o700)
  const fd = fs.openSync(file, "wx", 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    fs.closeSync(fd)
  }
  emitNervesEvent({ component: "eval", event: "eval.report_written", message: "wrote a private eval report", meta: { file } })
}
