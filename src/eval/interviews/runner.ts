/**
 * The blind-interview runner (pre-registration section 7, item 8). It reads Appendix B from the pre-registration
 * (checking its hash), and runs the chosen sessions in Appendix B's order. Per session it reserves the worst case on
 * the latch; then, per arm in the session's order, one sandboxed conversation with the arm's label line in the system
 * prompt, the job and then Q1; then, on the host, the final conversation with Q3 and Q4. Every request goes through
 * the guarded runtime, which scans it for brand words before it is sent.
 *
 * A void (brand words in a request), a provider error or a crash ends the session there: it counts as `ouro` not
 * chosen first and is never rerun. A refused call (a conversation's limit) ends only that conversation, and its job
 * does not pass. A 402 or 429 stops the study.
 *
 * Products plug in through `ProductKit`: X is built here, with its arms run by the neutral loop in the sandbox; H's
 * alternatives (item 4) and the U sandbox (item 6) add their own kits later, with the same session flow.
 */
import type { ProviderRuntime, ProviderTurnRequest } from "../../heart/core"
import { emitNervesEvent } from "../../nerves/runtime"
import { evaluate } from "../assertions"
import { createBudgetLedger, type Cost, type Pricing } from "../budget"
import type { Case, Observation, TraceCall } from "../domain/case"
import { gradeRun } from "../report"
import type { GuestChoice, RunCase, SandboxRun } from "../sandbox/remote"
import type { ResolvedTarget, TargetCredentials } from "../targets"
import { readAllocation, reducedDesign, startedKey, type LabelledArm, type Session } from "./allocation"
import { runFinalConversation, type FinalResult } from "./final"
import { buildArm, X_ARMS } from "./guest/arms"
import type { BooksCore } from "./guest/books-core"
import { messageOf } from "./guest/loop"
import { argvOf, commandLine } from "./guest/operations"
import { createInterviewLatch, guardedRuntime, SESSION_CALLS, type CallRecord, type ConversationKind, type Gate, type SessionLatch } from "./latch"
import { debriefQuestion, IDENTIFY_QUESTION, labelLine, ratingOf, type Note, type Product } from "./protocol"

/** What is recorded about each arm before any session: where it differs from the product it stands for. */
export const FIDELITY: Readonly<Record<string, string[]>> = {
  "X:ouro": [
    "ax-command and its MCP handler are Ouro AX v1.3.445's files unchanged; only their `.ts` import suffixes are dropped so the harness compiles them",
    "the tools are called in-process through the handler's tools/call, not over an MCP transport",
    "ax-command types positional arguments as strings, so this arm asks for a book's id as a string (\"187\") where mcp-plain asks for an integer; its tool descriptions carry the kit's own effect sentence",
    "only the kit's MCP-tool side reaches the model: its parser, `help --json`, `--json` output and exit codes are the same code behind each tool, but the model never sees the command line itself",
    "the kit cuts a tool answer at its own 20,000-character limit; no answer in the books cases comes near it",
  ],
  "X:mcp-plain": ["hand-written for this study: the same operations, inputs and JSON results as the other arms, no kit"],
  "X:cli-shell": [
    "the shell runs one `books` command per call, with quoting but no other programs, pipes, redirection or chaining",
    "its human-readable output is generated from the same JSON answer the other arms return",
  ],
  "X:all": [
    "every arm runs the eval's books stub in the bundle, against the fake household; paths in answers are shown relative to the books folder",
    "the persona is the Butler's psyche files from the seed bundle with the household's names filled in; the bundle's skills are left out, since they describe the shell command line",
    "the debrief keeps the arm's tools; the job is scored on the household after the debrief, and debrief tool calls are counted",
    "for scoring, each arm's calls are written as the books command line they ran, so the case's trace assertions read every arm the same way; a call the interface refused before any books operation ran (a bad argument, an unknown tool, a help request) is written as `no-operation` in every arm",
    "the loop starts a failed call's answer with `Error: ` in every arm, in place of MCP's isError flag",
    "on the Copilot Responses path the provider's body is rebuilt from the scanned messages before every call, so reasoning items from an earlier call are not sent back",
  ],
}

export type ProductKit = {
  /** The guest the sandbox runs for one arm's job and debrief. */
  guest(input: { session: Session; arm: LabelledArm; case: Case; debrief: string }): GuestChoice
  /** The observation as the case's assertions read it. */
  canonical(arm: string, obs: Observation): Observation
}

/** What a call the interface refused, before any books operation ran, is written as for scoring, in every arm. */
export const NO_OPERATION = "no-operation"

/** The books core for reading calls back on the host, where no operation ever runs. */
export const NO_BOOKS: BooksCore = async () => { throw new Error("the host only reads calls back; it runs no books operation") }

/** X's calls as the books command lines they ran, so `trace.*` assertions read every arm the same way. */
export function canonicalX(arm: string, obs: Observation): Observation {
  const tools = buildArm(arm, NO_BOOKS)
  return {
    ...obs,
    timeline: obs.timeline.map((entry): TraceCall | typeof entry => {
      if (entry.kind !== "call") return entry
      const ran = tools.operationOf(entry.name, entry.args)
      return ran ? { ...entry, name: "shell", args: JSON.stringify({ command: commandLine(argvOf(ran.op, ran.input)) }) } : { ...entry, name: NO_OPERATION }
    }),
  }
}

export const X_KIT: ProductKit = {
  guest: ({ session, arm, case: c, debrief }) => {
    const last = c.prefix[c.prefix.length - 1]!
    return {
      entry: "interview-guest-entry.js",
      turn: { product: session.product, arm: arm.arm, labelLine: labelLine(session.product, arm.label), prefix: c.prefix.slice(0, -1), userText: last.content, followUps: [debrief] },
    }
  },
  canonical: canonicalX,
}

export type InterviewArgs = {
  preregistration: string
  sessions: string[]
  reduced: boolean
  cases: string
  target: string
  credentialsAgent: string
  budgetPremium: number
  budgetCredits?: number
  priceIn?: number
  priceOut?: number
  reserveCreditsPerCall?: number
  output: string
  requestLog: string
  harnessRef: string
}

export type InterviewDeps = {
  readText(file: string): string
  loadCases(dir: string): Case[]
  resolveTarget(spec: string, creds: TargetCredentials): Promise<ResolvedTarget>
  runCase: RunCase
  kits: Partial<Record<Product, ProductKit>>
  outputExists(file: string): boolean
  writeReport(file: string, report: unknown): void
  /** Opens the private request log; each call appends one line. */
  openLog(file: string): (line: string) => void
  print(text: string): void
  /** The sessions ever started, in an append-only record kept beside the reports: a session starts once, ever. */
  started: { has(id: string): boolean; add(id: string): void }
  /** The registered versions' Appendix B SHA-256s; the real ones unless a test gives its own table. */
  allocations?: Readonly<Record<string, number>>
}

export type ArmRecord = {
  label: string
  arm: string
  passed: boolean
  reason: string | null
  outcome: string
  checks: Array<{ name: string; ok: boolean; detail: string }>
  note: string
  rating: number | null
  debriefOutcome: string | null
  debriefToolCalls: number
  jobCalls: number
  debriefCalls: number
  observation: Observation
}

export type SessionStatus = "complete" | "void" | "crashed" | "not-run"
export type SessionRecord = {
  id: string
  product: Product
  model: string
  job: string
  pilot: boolean
  labels: Record<string, string>
  status: SessionStatus
  /** Why the session ended before its end, or did not run. */
  ended: string | null
  arms: ArmRecord[]
  final: FinalResult | null
  ouroFirst: boolean
  voidedBy: string[] | null
  calls: CallRecord[]
  spent: Cost
}

const ZERO: Cost = { premium: 0, credits: 0 }

/** The brand words found, each once, in lower case. */
const named = (hits: string[]): string => [...new Set(hits.map((hit) => hit.toLowerCase()))].join(", ")

const providerFailure = (outcome: string): boolean => /^(provider-error|sandbox-error|trace-mismatch)/.test(outcome)

function armRecord(input: { arm: LabelledArm; c: Case; obs: SandboxRun; kit: ProductKit; job: Gate; debrief: Gate }): ArmRecord {
  const { gaps: _gaps, followUps, ...raw } = input.obs
  const observation = input.kit.canonical(input.arm.arm, raw)
  const graded = evaluate(input.c, observation)
  const refused = input.job.refused()
  const verdict = refused ? { passed: false, reason: `refused: ${refused}` } : gradeRun(observation, graded)
  const debrief = followUps?.[0]
  const note = debrief && debrief.outcome === "settled" ? debrief.finalReply : ""
  return {
    label: input.arm.label, arm: input.arm.arm, ...verdict, outcome: raw.outcome, checks: graded.checks, note, rating: ratingOf(note),
    debriefOutcome: debrief?.outcome ?? null, debriefToolCalls: debrief?.toolCalls ?? 0,
    jobCalls: input.job.calls(), debriefCalls: input.debrief.calls(), observation,
  }
}

/** Runs one session. Returns its record; `stop` when the study must stop (402, 429 or a cap). */
async function runSession(input: {
  session: Session
  kit: ProductKit
  cases: Map<string, Case>
  latch: SessionLatch
  target: ResolvedTarget
  ledger: ReturnType<typeof createBudgetLedger>
  pricing: Pricing
  runCase: RunCase
  log(line: string): void
}): Promise<SessionRecord> {
  const { session, latch } = input
  const record: SessionRecord = {
    id: session.id, product: session.product, model: session.model, job: session.job, pilot: session.pilot,
    labels: Object.fromEntries(session.arms.map((arm) => [arm.label, arm.arm])), status: "complete", ended: null, arms: [], final: null,
    ouroFirst: false, voidedBy: null, calls: [], spent: ZERO,
  }
  const c = input.cases.get(session.job)!
  const guard = (gateFor: (request: ProviderTurnRequest) => Gate): ProviderRuntime => guardedRuntime({
    inner: input.target.runtime, latch, ledger: input.ledger, pricing: input.pricing, gateFor,
    log: (entry) => input.log(JSON.stringify({ session: session.id, ...entry })),
  })
  const end = (status: SessionStatus, why: string): void => {
    record.status = status
    record.ended = why
  }
  for (const arm of session.arms) {
    const debrief = debriefQuestion(session.product, arm.label)
    const job = latch.gate("job")
    const debriefGate = latch.gate("debrief")
    const host = guard((request) => request.messages.some((m) => m.role === "user" && m.content === debrief) ? debriefGate : job)
    let obs: SandboxRun
    try {
      obs = await input.runCase({ case: c, host, budget: { take: () => true }, guest: input.kit.guest({ session, arm, case: c, debrief }) })
    } catch (error) {
      end("crashed", `${arm.label}: ${messageOf(error)}`)
      break
    }
    const armResult = armRecord({ arm, c, obs, kit: input.kit, job, debrief: debriefGate })
    record.arms.push(armResult)
    if (latch.voided()) {
      end("void", `${arm.label}: a request named ${named(latch.voided()!)}`)
      break
    }
    if (input.ledger.stopped()) {
      end("crashed", `${arm.label}: ${input.ledger.stopped()}`)
      break
    }
    const refusedOnly = job.refused() !== null || debriefGate.refused() !== null
    const failed = [obs.outcome, armResult.debriefOutcome ?? ""].find((outcome) => providerFailure(outcome))
    if (failed && !refusedOnly) {
      end("crashed", `${arm.label}: ${failed}`)
      break
    }
  }
  if (record.status === "complete") {
    const notes = record.arms.map((arm): Note => ({ label: arm.label, answer: arm.note })) as [Note, Note, Note]
    const choose = latch.gate("choose")
    const identify = latch.gate("identify")
    const host = guard((request) => request.messages.some((m) => m.role === "user" && m.content === IDENTIFY_QUESTION) ? identify : choose)
    record.final = await runFinalConversation({ runtime: host, product: session.product, notes, allowNudge: () => choose.allowOneMore() })
    if (latch.voided()) end("void", `final: a request named ${named(latch.voided()!)}`)
    else if (input.ledger.stopped()) end("crashed", `final: ${input.ledger.stopped()}`)
    else if (record.final.ended && choose.refused() === null && identify.refused() === null && !record.final.choice) end("crashed", `final: ${record.final.ended}`)
  }
  const ouroLabel = session.arms.find((arm) => arm.arm === "ouro")!.label
  record.ouroFirst = record.status === "complete" && record.final?.choice?.first === ouroLabel
  record.voidedBy = latch.voided()
  record.calls = latch.calls()
  record.spent = latch.release()
  emitNervesEvent({ component: "eval", event: "eval.interview_session_end", message: "finished an interview session", meta: { session: session.id, status: record.status, calls: record.calls.length } })
  return record
}

/** The counts-only summary: no trace text, no notes, no reasons. */
export function summarizeSessions(records: SessionRecord[], spent: Cost, stopped: string | null): string {
  const lines = records.map((r) => {
    const passed = r.arms.filter((arm) => arm.passed).length
    const usage = r.calls.reduce((sum, call) => ({ input: sum.input + (call.usage?.input_tokens ?? 0), output: sum.output + (call.usage?.output_tokens ?? 0) }), { input: 0, output: 0 })
    return `${r.id} ${r.status} ouro-first=${r.ouroFirst ? "yes" : "no"} jobs-passed=${passed}/${r.arms.length} calls=${r.calls.length} tokens-in=${usage.input} tokens-out=${usage.output} credits=${r.spent.credits.toFixed(3)} premium=${r.spent.premium}`
  })
  return [...lines, `spent: ${spent.credits.toFixed(3)} credits, ${spent.premium} premium requests${stopped ? `; stopped: ${stopped}` : ""}`].join("\n")
}

export async function runInterviews(args: InterviewArgs, deps: InterviewDeps): Promise<{ exitCode: number; records: SessionRecord[] }> {
  const { version, sessions: all } = readAllocation(deps.readText(args.preregistration), deps.allocations)
  const design = args.reduced ? reducedDesign(all) : all
  const unknown = args.sessions.find((id) => !all.some((session) => session.id === id))
  if (unknown) throw new Error(`no session ${unknown} in Appendix B`)
  const outside = args.sessions.find((id) => !design.some((session) => session.id === id))
  if (outside) throw new Error(`session ${outside} is not in the reduced design`)
  const chosen = args.sessions.length > 0 ? design.filter((session) => args.sessions.includes(session.id)) : design
  const rerun = chosen.find((session) => deps.started.has(startedKey(version, session.id)))
  if (rerun) throw new Error(`session ${rerun.id}${version === 1 ? "" : ` of version ${version}`} has already started once; a session is never rerun`)
  const missingKit = chosen.find((session) => !deps.kits[session.product])
  if (missingKit) throw new Error(`session ${missingKit.id} is product ${missingKit.product}, which has no runner kit yet`)
  const cases = new Map(deps.loadCases(args.cases).map((c) => [c.id, c]))
  const missingCase = chosen.find((session) => !cases.has(session.job))
  if (missingCase) throw new Error(`session ${missingCase.id} needs case ${missingCase.job}, which is not in ${args.cases}`)
  for (const file of [args.output, args.requestLog]) if (deps.outputExists(file)) throw new Error(`${file} already exists; name a new file`)
  if (args.budgetCredits !== undefined && (args.priceIn === undefined || args.priceOut === undefined || args.reserveCreditsPerCall === undefined)) {
    throw new Error("a credits cap needs --price-in, --price-out and --reserve-credits-per-call (credits per million tokens, and per call)")
  }
  if (args.budgetCredits !== undefined && !(args.reserveCreditsPerCall! > 0)) throw new Error("--reserve-credits-per-call must be more than 0 with a credits cap, or the cap reserves nothing")

  const target = await deps.resolveTarget(args.target, { agent: args.credentialsAgent })
  const before = await target.quota()
  if (args.budgetCredits === undefined && (target.account === null || before.tokenBased !== false)) {
    throw new Error(`${args.target} is billed by the token (or not known not to be); pass --budget-credits with --price-in, --price-out and --reserve-credits-per-call`)
  }
  const ledger = createBudgetLedger({ premium: args.budgetPremium, ...(args.budgetCredits !== undefined ? { credits: args.budgetCredits } : {}) })
  const pricing: Pricing = { premiumPerCall: target.unitCost, creditsPerMillionInput: args.priceIn ?? 0, creditsPerMillionOutput: args.priceOut ?? 0 }
  let perCallCredits = args.reserveCreditsPerCall ?? 0
  const interviewLatch = createInterviewLatch({ ledger, pricing, perCall: () => ({ premium: target.unitCost, credits: perCallCredits }) })
  const log = deps.openLog(args.requestLog)
  emitNervesEvent({ component: "eval", event: "eval.interview_run_start", message: "starting blind-interview sessions", meta: { sessions: chosen.length, target: args.target } })

  const records: SessionRecord[] = []
  let stopped: string | null = null
  const writeReport = (): void => {
    const totals = ledger.totals()
    deps.writeReport(args.output, {
      schemaVersion: 1, kind: "blind-interviews", preregistrationVersion: version, target: args.target, harnessRef: args.harnessRef, reduced: args.reduced, account: target.account,
      premiumMultiplier: target.unitCost, caps: totals.caps, spent: totals.spent, calls: totals.calls, stopped, quota: { before, after: after ?? before },
      fidelity: FIDELITY, pricing, sessions: records,
    })
  }
  let after: Awaited<ReturnType<ResolvedTarget["quota"]>> | null = null
  try {
  for (const session of chosen) {
    const notRun = (why: string): SessionRecord => ({
      id: session.id, product: session.product, model: session.model, job: session.job, pilot: session.pilot,
      labels: Object.fromEntries(session.arms.map((arm) => [arm.label, arm.arm])), status: "not-run", ended: why, arms: [], final: null,
      ouroFirst: false, voidedBy: null, calls: [], spent: ZERO,
    })
    if (stopped) {
      records.push(notRun(`the study stopped: ${stopped}`))
      continue
    }
    const latch = interviewLatch.reserve(session.id, SESSION_CALLS)
    if ("refused" in latch) {
      stopped = latch.refused
      records.push(notRun(latch.refused))
      continue
    }
    deps.started.add(startedKey(version, session.id))
    let record: SessionRecord
    try {
      record = await runSession({ session, kit: deps.kits[session.product]!, cases, latch, target, ledger, pricing, runCase: deps.runCase, log })
    } catch (error) {
      // Nothing that goes wrong in one session loses the sessions already run, or holds its reservation.
      record = { ...notRun(messageOf(error)), status: "crashed", voidedBy: latch.voided(), calls: latch.calls(), spent: latch.release() }
    }
    records.push(record)
    perCallCredits = Math.max(perCallCredits, latch.hold.maxCall())
    if (ledger.stopped()) stopped = ledger.stopped()!
  }
  after = await target.quota()
  } finally {
    writeReport()
  }
  deps.print(summarizeSessions(records, ledger.totals().spent, stopped))
  emitNervesEvent({ component: "eval", event: "eval.interview_run_end", message: "finished blind-interview sessions", meta: { sessions: records.length, stopped } })
  return { exitCode: stopped ? 2 : 0, records }
}

/** Every X arm, for the parser's check. */
export const KNOWN_ARMS: Readonly<Record<Product, readonly string[]>> = { H: [], U: [], X: X_ARMS }

const STRING_FLAGS = { "--preregistration": "preregistration", "--cases": "cases", "--target": "target", "--credentials-agent": "credentialsAgent", "--output": "output", "--request-log": "requestLog", "--harness-ref": "harnessRef" } as const
const NUMBER_FLAGS = { "--budget-premium": "budgetPremium", "--budget-credits": "budgetCredits", "--price-in": "priceIn", "--price-out": "priceOut", "--reserve-credits-per-call": "reserveCreditsPerCall" } as const
const REQUIRED = ["--preregistration", "--cases", "--target", "--credentials-agent", "--budget-premium", "--output"] as const

export function parseInterviewArgs(argv: string[]): InterviewArgs {
  const out: Record<string, unknown> = { sessions: [], reduced: false, harnessRef: "unknown" }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!
    if (flag === "--reduced") {
      out.reduced = true
      continue
    }
    const value = argv[i + 1]
    if (flag !== "--session" && !Object.hasOwn(STRING_FLAGS, flag) && !Object.hasOwn(NUMBER_FLAGS, flag)) throw new Error(`unknown flag ${flag}`)
    if (value === undefined) throw new Error(`${flag} needs a value`)
    i += 1
    seen.add(flag)
    if (flag === "--session") (out.sessions as string[]).push(value)
    else if (Object.hasOwn(STRING_FLAGS, flag)) out[STRING_FLAGS[flag as keyof typeof STRING_FLAGS]] = value
    else {
      const number = Number(value)
      if (!(Number.isFinite(number) && number >= 0)) throw new Error(`${flag} must be a number of at least 0`)
      out[NUMBER_FLAGS[flag as keyof typeof NUMBER_FLAGS]] = number
    }
  }
  const missing = REQUIRED.find((flag) => !seen.has(flag))
  if (missing) throw new Error(`${missing} is required`)
  out.requestLog ??= String(out.output).replace(/(\.json)?$/, ".requests.ndjson")
  return out as InterviewArgs
}

export type { ConversationKind }
