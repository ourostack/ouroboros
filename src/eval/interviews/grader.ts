/**
 * The grader (pre-registration section 7, item 9): section 3's blinding checks and section 6's analysis, from the
 * runner's private reports and request logs and Appendix B. It runs no model and sends nothing. Its result is counts
 * and labels only (no trace text, notes or reasons), so it can be committed as the study's result.
 *
 * Section 3: no leak (the brand pattern over every logged request body, zero matches outside void sessions); no
 * identification (a session is broken when Q4 names the `ouro` label with a product matching /ouro/i); a valid count
 * (at most 3 of 18 broken, or 1 of 9 in the reduced design). Section 6: k of n sessions with `ouro` first, where every
 * session of the design counts and one that is void, crashed, missing or not run counts as `ouro` not first; the three
 * pass conditions; and the figures reported beside them, never used to pass or fail.
 */
import { emitNervesEvent } from "../../nerves/runtime"
import { wilsonInterval } from "../domain/stats"
import type { Session } from "./allocation"
import { ARMS, BRAND_PATTERN, type Product } from "./protocol"
import type { SessionRecord } from "./runner"

export type LoggedRequest = { session: string; kind: string; sent: boolean; body: string }

/** What a correct guess for each alternative looks like (counted and reported; it never breaks a session). */
export const ALTERNATIVE_NAMES: Readonly<Record<string, RegExp>> = {
  "codex": /codex/i,
  "openhands": /open ?hands|all-hands/i,
  "shadcn": /shadcn|radix/i,
  "mui": /\bmui\b|material[ -]?ui/i,
  "mcp-plain": /\bmcp\b|model context protocol/i,
  "cli-shell": /\bcli\b|shell|command[- ]line|bash|terminal/i,
}

/** Section 6's bars: k of n for "more often than chance", and the most broken sessions a valid count allows. */
export function bars(reduced: boolean): { n: number; k: number; broken: number } {
  return reduced ? { n: 9, k: 7, broken: 1 } : { n: 18, k: 11, broken: 3 }
}

export type ArmFigures = { firsts: number; seconds: number; meanRating: number | null; ratings: number; missingRatings: number; jobsRun: number; jobsPassed: number; identified: number }

export type ProductResult = {
  product: Product
  n: number
  k: number
  share: { low: number; high: number; value: number }
  byModel: Record<string, { sessions: number; firsts: Record<string, number>; ouroAhead: boolean }>
  broken: string[]
  /** `blindingHeld` needs both no leak outside void sessions and at most the bar's broken sessions. */
  conditions: { moreThanChance: boolean; everyModelAgrees: boolean; blindingHeld: boolean }
  passed: boolean
  verdict: "passed" | "failed" | "blinding failed"
  withoutBroken: { n: number; k: number }
  arms: Record<string, ArmFigures>
  firstChoiceJobPassed: { sessions: number; of: number }
  statuses: Record<string, number>
}

export type StudyGrade = {
  leak: { requests: number; matches: number; outsideVoid: number; sessions: string[] }
  products: ProductResult[]
}

const brand = (): RegExp => new RegExp(BRAND_PATTERN, "gi")

/** Q4's guess for `label`, whether the model keyed it `K`, ` k ` or `tool interface K`. */
export function guessFor(guesses: Record<string, string> | null | undefined, label: string): string | undefined {
  const want = label.toLowerCase()
  const key = Object.keys(guesses ?? {}).find((k) => {
    const words = k.trim().toLowerCase().split(/\s+/)
    return words[words.length - 1] === want
  })
  return key === undefined ? undefined : guesses![key]
}

/**
 * The session records of the runner's reports, refusing any report from another pre-registration version than the
 * one being graded, since versions are never pooled. A report written before reports named their version is version 1's.
 */
export function sessionsOf(version: number, reports: Array<{ preregistrationVersion?: number; sessions: SessionRecord[] }>): SessionRecord[] {
  return reports.flatMap((report, i) => {
    const from = report.preregistrationVersion ?? 1
    if (from !== version) throw new Error(`report ${i + 1} is from pre-registration version ${from}, not version ${version}; versions are never pooled`)
    return report.sessions
  })
}

/** A session's blinding is broken when Q4 names the `ouro` arm's label with a product matching /ouro/i. */
export function isBroken(record: SessionRecord): boolean {
  const ouroLabel = Object.entries(record.labels).find(([, arm]) => arm === "ouro")?.[0]
  const guess = ouroLabel ? guessFor(record.final?.guesses, ouroLabel) : undefined
  return typeof guess === "string" && /ouro/i.test(guess)
}

export function gradeStudy(input: { design: Session[]; records: SessionRecord[]; requests: LoggedRequest[]; reduced: boolean }): StudyGrade {
  const byId = new Map<string, SessionRecord>()
  for (const record of input.records) {
    if (byId.has(record.id)) throw new Error(`session ${record.id} is in the reports twice; every session runs once`)
    byId.set(record.id, record)
  }
  for (const session of input.design) {
    const record = byId.get(session.id)
    const labels = JSON.stringify(Object.fromEntries(session.arms.map((arm) => [arm.label, arm.arm])))
    if (record && JSON.stringify(record.labels) !== labels) throw new Error(`session ${session.id}'s report gives labels other than Appendix B's`)
  }
  const voids = new Set(input.records.filter((record) => record.status === "void").map((record) => record.id))
  const leaking = input.requests.filter((request) => request.sent && (request.body.match(brand()) ?? []).length > 0)
  const leak = {
    requests: input.requests.length,
    matches: input.requests.reduce((sum, request) => sum + (request.body.match(brand()) ?? []).length, 0),
    outsideVoid: leaking.filter((request) => !voids.has(request.session)).length,
    sessions: [...new Set(leaking.map((request) => request.session))],
  }
  const bar = bars(input.reduced)
  const products = (["H", "U", "X"] as const).flatMap((product): ProductResult[] => {
    const sessions = input.design.filter((session) => session.product === product && !session.pilot)
    if (sessions.length === 0) return []
    const ran = sessions.map((session) => ({ session, record: byId.get(session.id) }))
    const first = (record: SessionRecord | undefined): string | null => record?.status === "complete" ? record.final?.choice?.first ?? null : null
    const armOf = (session: Session, label: string | null): string | null => session.arms.find((arm) => arm.label === label)?.arm ?? null
    // Recomputed from the choice and Appendix B's labels, not taken from the runner's own flag.
    const firstIsOuro = ({ session, record }: { session: Session; record: SessionRecord | undefined }): boolean => armOf(session, first(record)) === "ouro"
    const leaked = sessions.some((session) => leaking.some((request) => request.session === session.id && !voids.has(session.id)))
    const k = ran.filter(firstIsOuro).length
    const broken = ran.filter(({ record }) => record !== undefined && isBroken(record)).map(({ session }) => session.id)
    const byModel: ProductResult["byModel"] = {}
    for (const { session, record } of ran) {
      const entry = byModel[session.model] ??= { sessions: 0, firsts: Object.fromEntries(ARMS[product].map((arm) => [arm, 0])), ouroAhead: false }
      entry.sessions += 1
      const arm = armOf(session, first(record))
      if (arm) entry.firsts[arm]! += 1
    }
    for (const entry of Object.values(byModel)) entry.ouroAhead = ARMS[product].slice(1).every((alt) => entry.firsts.ouro! > entry.firsts[alt]!)
    const arms: Record<string, ArmFigures> = Object.fromEntries(ARMS[product].map((arm) => [arm, { firsts: 0, seconds: 0, meanRating: null, ratings: 0, missingRatings: 0, jobsRun: 0, jobsPassed: 0, identified: 0 }]))
    const ratingSums: Record<string, number> = {}
    let firstPassed = 0
    let firstOf = 0
    for (const { session, record } of ran) {
      if (!record) continue
      const firstArm = armOf(session, first(record))
      const secondArm = armOf(session, record.status === "complete" ? record.final?.choice?.second ?? null : null)
      if (firstArm) arms[firstArm]!.firsts += 1
      if (secondArm) arms[secondArm]!.seconds += 1
      for (const run of record.arms) {
        const figures = arms[run.arm]!
        figures.jobsRun += 1
        if (run.passed) figures.jobsPassed += 1
        if (run.rating === null) figures.missingRatings += 1
        else {
          figures.ratings += 1
          ratingSums[run.arm] = (ratingSums[run.arm] ?? 0) + run.rating
        }
      }
      for (const { label, arm } of session.arms) {
        const guess = guessFor(record.final?.guesses, label)
        if (arm !== "ouro" && typeof guess === "string" && ALTERNATIVE_NAMES[arm]!.test(guess)) arms[arm]!.identified += 1
      }
      if (firstArm) {
        firstOf += 1
        if (record.arms.find((run) => run.arm === firstArm)?.passed) firstPassed += 1
      }
    }
    for (const [arm, figures] of Object.entries(arms)) figures.meanRating = figures.ratings > 0 ? ratingSums[arm]! / figures.ratings : null
    const n = sessions.length
    const interval = wilsonInterval(k, n)
    const conditions = {
      moreThanChance: k >= bar.k,
      everyModelAgrees: Object.values(byModel).every((entry) => entry.ouroAhead),
      // A brand word sent outside a void session fails the blinding outright (section 3, no leak).
      blindingHeld: broken.length <= bar.broken && !leaked,
    }
    const passed = conditions.moreThanChance && conditions.everyModelAgrees && conditions.blindingHeld
    const kept = ran.filter(({ session }) => !broken.includes(session.id))
    const statuses: Record<string, number> = {}
    for (const { record } of ran) statuses[record?.status ?? "missing"] = (statuses[record?.status ?? "missing"] ?? 0) + 1
    return [{
      // n is at least 1 here, so the interval has both bounds.
      product, n, k, share: { value: k / n, low: interval.low as number, high: interval.high as number }, byModel, broken, conditions, passed,
      verdict: !conditions.blindingHeld ? "blinding failed" : passed ? "passed" : "failed",
      withoutBroken: { n: kept.length, k: kept.filter(firstIsOuro).length },
      arms, firstChoiceJobPassed: { sessions: firstPassed, of: firstOf }, statuses,
    }]
  })
  emitNervesEvent({ component: "eval", event: "eval.interview_graded", message: "graded the blind interviews", meta: { products: products.length, leaks: leak.outsideVoid } })
  return { leak, products }
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

/** The grade as text: counts, labels and arm names only. */
export function formatGrade(grade: StudyGrade, reduced: boolean): string {
  const bar = bars(reduced)
  const lines = [
    `Leak check: ${grade.leak.requests} logged requests, ${grade.leak.outsideVoid} sent with brand words outside void sessions (${grade.leak.matches} matches in all, sent or not).`,
  ]
  for (const p of grade.products) {
    lines.push(
      "",
      `${p.product}: ${p.verdict}. ouro first in ${p.k} of ${p.n} (bar ${bar.k} of ${bar.n}); share ${percent(p.share.value)}, Wilson 95% ${percent(p.share.low)} to ${percent(p.share.high)}.`,
      `  more often than chance: ${p.conditions.moreThanChance ? "yes" : "no"}; every model agrees: ${p.conditions.everyModelAgrees ? "yes" : "no"}; blinding held: ${p.conditions.blindingHeld ? "yes" : "no"} (${p.broken.length} broken, at most ${bar.broken}${p.broken.length ? `: ${p.broken.join(", ")}` : ""}).`,
      `  without broken sessions: ouro first in ${p.withoutBroken.k} of ${p.withoutBroken.n}.`,
      `  sessions: ${Object.entries(p.statuses).map(([status, count]) => `${count} ${status}`).join(", ")}.`,
      ...Object.entries(p.byModel).map(([model, entry]) => `  ${model}: ${entry.sessions} sessions; first choices ${Object.entries(entry.firsts).map(([arm, count]) => `${arm} ${count}`).join(", ")}.`),
      ...Object.entries(p.arms).map(([arm, f]) => `  ${arm}: first ${f.firsts}, second ${f.seconds}; mean rating ${f.meanRating === null ? "n/a" : f.meanRating.toFixed(2)} (${f.missingRatings} missing); jobs passed ${f.jobsPassed} of ${f.jobsRun}${arm === "ouro" ? "" : `; identified ${f.identified}`}.`),
      `  first choice was an arm whose job passed: ${p.firstChoiceJobPassed.sessions} of ${p.firstChoiceJobPassed.of}.`,
    )
  }
  return lines.join("\n")
}

/** The request log's lines, refusing a line that is not one logged request. */
export function readRequestLog(text: string): LoggedRequest[] {
  return text.split("\n").filter((line) => line.trim()).map((line, i) => {
    const value = JSON.parse(line) as Partial<LoggedRequest>
    if (typeof value.session !== "string" || typeof value.kind !== "string" || typeof value.sent !== "boolean" || typeof value.body !== "string") throw new Error(`request log line ${i + 1} is not a logged request`)
    return value as LoggedRequest
  })
}
