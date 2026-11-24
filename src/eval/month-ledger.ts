/**
 * The month ledger: what every eval run on this machine spent in each calendar month (UTC), in
 * `~/.ouro-eval/ledger-month.json`, read and written only under a file lock. Before a run, `refusal` answers why its
 * worst case would pass the month cap, and after it, `add` records what it spent. Past the cap, runs refuse until the
 * next month; spending more is a money decision for Ari.
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

type MonthFile = { schemaVersion: 1; months: Record<string, Cost & { runs: number }> }

export type MonthLedger = {
  /** Why a run with this worst case must not start, or undefined when it fits the month. */
  refusal(label: string, worst: Cost): Promise<string | undefined>
  /** Adds a finished run's spend to its month. */
  add(spent: Cost): Promise<void>
  /** This month's key and what it has spent so far. */
  current(): Promise<{ month: string; spent: Cost & { runs: number } }>
}

const METERS = ["premium", "credits"] as const
const round = (value: number): number => Math.round(value * 1e6) / 1e6
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

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
  const valid = (parsed as Partial<MonthFile> | undefined)?.schemaVersion === 1 && typeof months === "object" && months !== null && !Array.isArray(months)
    && Object.values(months).every((m) => typeof m === "object" && m !== null && isCount(m.premium) && isCount(m.credits) && isCount(m.runs))
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
  const spentIn = (data: MonthFile, month: string): Cost & { runs: number } => data.months[month] ?? { premium: 0, credits: 0, runs: 0 }

  return {
    refusal: (label, worst) => locked(() => {
      const month = monthOf()
      const spent = spentIn(read(file), month)
      const meter = METERS.find((m) => round(spent[m] + worst[m]) > caps[m])
      if (meter === undefined) return undefined
      emitNervesEvent({ component: "eval", event: "eval.month_cap_refused", message: "refused a run that could pass the month cap", meta: { label, meter, month } })
      return `${label} could pass the ${month} ${meter} cap ${caps[meter]}: ${spent[meter]} spent this month, ${worst[meter]} more at worst`
    }),
    add: (spent) => locked(() => {
      const data = read(file)
      const month = monthOf()
      const before = spentIn(data, month)
      data.months[month] = { premium: round(before.premium + spent.premium), credits: round(before.credits + spent.credits), runs: before.runs + 1 }
      writeFileAtomicSync(file, `${JSON.stringify(data, null, 2)}\n`)
      emitNervesEvent({ component: "eval", event: "eval.month_ledger_added", message: "added a run's spend to the month ledger", meta: { month, ...data.months[month] } })
    }),
    current: () => locked(() => {
      const month = monthOf()
      return { month, spent: spentIn(read(file), month) }
    }),
  }
}
