/**
 * The month ledger: what every eval run and interview session on this machine spent in each calendar month (UTC), in
 * `~/.ouro-eval/ledger-month.json`, read and written only under a file lock. Both draw on one Copilot subscription,
 * so the month's totals hold both, and each month also keeps them apart by source. Before an eval run, `refusal`
 * answers why its worst case would pass the month cap, counting the interviews' spend, so evals yield to the study.
 * After a run or session, `add` records what it spent. Interviews only add: their pre-registered caps govern them,
 * and the month cap never blocks or stops one (changing a registered cap mid-study would break the registration).
 * Past the cap, eval runs refuse until the next month; spending more is a money decision for Ari.
 *
 * A file it can't read or understand refuses every run rather than starting the month again from nothing. Two eval
 * commands running at once can each pass the check before the other adds, so the cap holds to within one run per
 * command; batches run one at a time under the host lock.
 */
import fs from "node:fs"
import path from "node:path"
import { writeFileAtomicSync } from "../heart/atomic-file"
import { withFileLock } from "../heart/file-lock"
import { emitNervesEvent } from "../nerves/runtime"
import type { Cost } from "./budget"
import { evalHome } from "./kill-switch"

/** $40 a month in credits (1 credit is $0.01), and 600 premium requests (design section 7). */
export const MONTH_CAPS: Readonly<Cost> = { premium: 600, credits: 4000 }

export type SpendSource = "eval" | "interviews"
type Spend = Cost & { runs: number }
type Month = Spend & { sources?: Partial<Record<SpendSource, Spend>> }
type MonthFile = { schemaVersion: 1; months: Record<string, Month> }

export type MonthLedger = {
  /** Why a run with this worst case must not start, or undefined when it fits the month. */
  refusal(label: string, worst: Cost): Promise<string | undefined>
  /** Adds a finished run's or session's spend to its month, under its source (an eval run by default). */
  add(spent: Cost, source?: SpendSource): Promise<void>
  /** This month's key and what it has spent so far, in total and by source. */
  current(): Promise<{ month: string; spent: Month }>
}

const METERS = ["premium", "credits"] as const
const round = (value: number): number => Math.round(value * 1e6) / 1e6
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isSpend = (value: unknown): value is Month => isRecord(value) && isCount(value.premium) && isCount(value.credits) && isCount(value.runs)
const SOURCES: readonly SpendSource[] = ["eval", "interviews"]
const ZERO: Spend = { premium: 0, credits: 0, runs: 0 }
const plus = (before: Spend, spent: Cost): Spend => ({ premium: round(before.premium + spent.premium), credits: round(before.credits + spent.credits), runs: before.runs + 1 })

function read(file: string): MonthFile {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, months: {} }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  const months = (parsed as Partial<MonthFile> | undefined)?.months
  const valid = (parsed as Partial<MonthFile> | undefined)?.schemaVersion === 1 && isRecord(months)
    && Object.values(months).every((m) => isSpend(m) && (m.sources === undefined || (isRecord(m.sources) && Object.entries(m.sources).every(([source, s]) => SOURCES.includes(source as SpendSource) && isSpend(s)))))
  if (!valid) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.month_ledger_unreadable", message: "the month ledger can't be understood", meta: { file: path.basename(file) } })
    throw new Error(`the month ledger ${path.basename(file)} can't be understood; fix or move it before running more evals`)
  }
  return parsed as MonthFile
}

export function monthLedger(options: { file?: string; caps?: Cost; now?: () => Date } = {}): MonthLedger {
  const file = options.file ?? path.join(evalHome(), "ledger-month.json")
  const caps = options.caps ?? MONTH_CAPS
  const now = options.now ?? (() => new Date())
  const locked = <T>(fn: () => T): Promise<T> => withFileLock(path.dirname(file), path.basename(file), fn)
  const monthOf = (): string => now().toISOString().slice(0, 7)
  const spentIn = (data: MonthFile, month: string): Month => data.months[month] ?? ZERO

  return {
    refusal: (label, worst) => locked(() => {
      const month = monthOf()
      const spent = spentIn(read(file), month)
      const meter = METERS.find((m) => round(spent[m] + worst[m]) > caps[m])
      if (meter === undefined) return undefined
      emitNervesEvent({ component: "eval", event: "eval.month_cap_refused", message: "refused a run that could pass the month cap", meta: { label, meter, month } })
      const interviews = spent.sources?.interviews?.[meter] ?? 0
      return `${label} could pass the ${month} ${meter} cap ${caps[meter]}: ${spent[meter]} spent this month (${interviews} by interviews), ${worst[meter]} more at worst`
    }),
    add: (spent, source = "eval") => locked(() => {
      const data = read(file)
      const month = monthOf()
      const before = spentIn(data, month)
      const { sources = {}, ...total } = before
      data.months[month] = { ...plus(total, spent), sources: { ...sources, [source]: plus(sources[source] ?? ZERO, spent) } }
      writeFileAtomicSync(file, `${JSON.stringify(data, null, 2)}\n`)
      emitNervesEvent({ component: "eval", event: "eval.month_ledger_added", message: "added a run's spend to the month ledger", meta: { month, source, ...plus(total, spent) } })
    }),
    current: () => locked(() => {
      const month = monthOf()
      return { month, spent: spentIn(read(file), month) }
    }),
  }
}
