/**
 * `npm run eval -- ...`: runs every case N times on one model target and one bundle, each run from scratch in the
 * sandbox, judged once, never retried. Before anything is spent it refuses a case that fails its self-test, an
 * output file that already exists, a Copilot target with no premium multiplier (see `targets`), and, without a credits
 * cap and prices, any target billed by the token: MiniMax, and a Copilot account that is token-billed or not known not
 * to be.
 *
 * Every run first reserves its worst case on the ledger: the turn's call ceiling (`MAX_PROVIDER_ITERATIONS_CEILING`
 * plus the step-budget report call) times the per-call premium multiplier and the per-call credit estimate, raised to
 * the most one call has cost so far. When a reservation would pass a cap, the command stops there. A run whose
 * calls outgrow its own credit reservation is cut short and not scored (it counts as not run), and the next run
 * reserves more. The first 402 or 429 also stops the command. Either way the report keeps every finished run, and the
 * run the provider cut short counts as failed. The command exits 2 when it stopped early.
 */
import { MAX_PROVIDER_ITERATIONS_CEILING, type ProviderRuntime } from "../heart/core"
import { emitNervesEvent } from "../nerves/runtime"
import { evaluate } from "./assertions"
import { createBudgetLedger, meteredRuntime, type Cost, type Pricing } from "./budget"
import type { Case } from "./domain/case"
import { buildCells, gradeRun, summarize, withoutBooksRemove, type RunRecord, type RunResult } from "./report"
import type { SandboxImages } from "./sandbox/docker"
import type { RunCase, SandboxRun } from "./sandbox/remote"
import { loadCases, selfTest } from "./self-test"
import type { ResolvedTarget, TargetCredentials } from "./targets"

/** The most model calls one turn can make: the step-budget ceiling, plus the report call it asks for when used up. */
export const CALLS_PER_RUN = MAX_PROVIDER_ITERATIONS_CEILING + 1

export type EvalArgs = {
  cases: string
  caseIds: string[]
  bundle: string
  bundleRef: string
  target: string
  runs: number
  budgetPremium: number
  budgetCredits?: number
  priceIn?: number
  priceOut?: number
  reserveCreditsPerCall?: number
  credentialsAgent: string
  copilotAccount?: string
  premiumMultiplier?: number
  output: string
  harnessRef: string
  seedBundle?: string
  oracleBooks?: string
  /** `<host>:<folder>`: run the sandbox on that Docker host over ssh, with the harness synced to `<folder>/harness`. */
  sandboxSsh?: string
  /** `<agent image>,<household image>`: the sandbox's own image tags, so a run on a shared Docker host uses its own names. */
  sandboxImages?: SandboxImages
}

export type EvalDeps = {
  resolveTarget(spec: string, creds: TargetCredentials): Promise<ResolvedTarget>
  loadCases?(dir: string): Case[]
  runCase(args: EvalArgs): RunCase
  outputExists(file: string): boolean
  writeReport(file: string, report: unknown): void
  print(text: string): void
}

const STRING_FLAGS = {
  "--cases": "cases", "--bundle": "bundle", "--bundle-ref": "bundleRef", "--target": "target", "--credentials-agent": "credentialsAgent",
  "--copilot-account": "copilotAccount", "--output": "output", "--harness-ref": "harnessRef", "--seed-bundle": "seedBundle",
  "--oracle-books": "oracleBooks", "--sandbox-ssh": "sandboxSsh", "--sandbox-images": "sandboxImages",
} as const
const NUMBER_FLAGS = {
  "--runs": "runs", "--budget-premium": "budgetPremium", "--budget-credits": "budgetCredits", "--price-in": "priceIn", "--price-out": "priceOut",
  "--reserve-credits-per-call": "reserveCreditsPerCall", "--premium-multiplier": "premiumMultiplier",
} as const
const REQUIRED = ["--cases", "--bundle", "--bundle-ref", "--target", "--runs", "--budget-premium", "--credentials-agent", "--output"] as const

export function parseEvalArgs(argv: string[]): EvalArgs {
  const out: Record<string, unknown> = { caseIds: [], harnessRef: "unknown" }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (flag !== "--case" && !Object.hasOwn(STRING_FLAGS, flag) && !Object.hasOwn(NUMBER_FLAGS, flag)) throw new Error(`unknown flag ${flag}`)
    if (value === undefined) throw new Error(`${flag} needs a value`)
    seen.add(flag)
    if (flag === "--case") {
      (out.caseIds as string[]).push(value)
    } else if (Object.hasOwn(STRING_FLAGS, flag)) {
      out[STRING_FLAGS[flag as keyof typeof STRING_FLAGS]] = value
    } else {
      const number = Number(value)
      if (flag === "--runs" ? !(Number.isInteger(number) && number >= 1) : !(Number.isFinite(number) && number >= 0)) {
        throw new Error(flag === "--runs" ? "--runs must be a whole number of at least 1" : `${flag} must be a number of at least 0`)
      }
      out[NUMBER_FLAGS[flag as keyof typeof NUMBER_FLAGS]] = number
    }
  }
  if (typeof out.sandboxImages === "string") {
    const [agent, household, ...rest] = out.sandboxImages.split(",").map((tag) => tag.trim())
    if (!agent || !household || rest.length > 0 || agent === household) throw new Error("--sandbox-images must be <agent image>,<household image>")
    out.sandboxImages = { agent, household }
  }
  const missing = REQUIRED.find((flag) => !seen.has(flag))
  if (missing) throw new Error(`${missing} is required`)
  return out as EvalArgs
}

function failedRun(outcome: string): SandboxRun {
  return { timeline: [], finalReply: "", library: [], mail: [], created: [], outcome, steps: 0, oracle: {}, gaps: [] }
}

export async function runEvalCommand(args: EvalArgs, deps: EvalDeps): Promise<{ exitCode: number; result: RunResult; runs: RunRecord[] }> {
  const all = (deps.loadCases ?? loadCases)(args.cases)
  const unknown = args.caseIds.find((id) => !all.some((c) => c.id === id))
  if (unknown) throw new Error(`no case ${unknown} in ${args.cases}`)
  const cases = args.caseIds.length > 0 ? all.filter((c) => args.caseIds.includes(c.id)) : all
  const broken = cases.map((c) => ({ id: c.id, ...selfTest(c) })).filter((tested) => !tested.ok)
  if (broken.length > 0) throw new Error(`refusing to spend on cases that fail their self-test: ${broken.map((b) => `${b.id} (${b.problems.join("; ")})`).join(", ")}`)
  if (deps.outputExists(args.output)) throw new Error(`${args.output} already exists; name a new report file`)

  const target = await deps.resolveTarget(args.target, {
    agent: args.credentialsAgent,
    ...(args.copilotAccount ? { copilotAccount: args.copilotAccount } : {}),
    ...(args.premiumMultiplier !== undefined ? { premiumMultiplier: args.premiumMultiplier } : {}),
  })
  const before = await target.quota()
  if (args.budgetCredits === undefined && (target.account === null || before.tokenBased !== false)) {
    const who = target.account === null ? `${args.target} is billed by the token` : `${target.account} is token-billed (or not known not to be)`
    throw new Error(`${who}; pass --budget-credits with --price-in, --price-out and --reserve-credits-per-call`)
  }
  if (args.budgetCredits !== undefined && (args.priceIn === undefined || args.priceOut === undefined || args.reserveCreditsPerCall === undefined)) {
    throw new Error("a credits cap needs --price-in, --price-out and --reserve-credits-per-call (credits per million tokens, and per call)")
  }
  emitNervesEvent({ component: "eval", event: "eval.run_command_start", message: "starting an eval model run", meta: { target: args.target, bundleRef: args.bundleRef, runs: args.runs, cases: cases.length } })

  const ledger = createBudgetLedger({ premium: args.budgetPremium, ...(args.budgetCredits !== undefined ? { credits: args.budgetCredits } : {}) })
  const pricing: Pricing = { premiumPerCall: target.unitCost, creditsPerMillionInput: args.priceIn ?? 0, creditsPerMillionOutput: args.priceOut ?? 0 }
  let perCallCredits = args.reserveCreditsPerCall ?? 0
  const runCase = deps.runCase(args)
  const runs: RunRecord[] = []
  let stopped: string | undefined
  outer: for (const c of cases) {
    for (let run = 1; run <= args.runs; run += 1) {
      const reserved: Cost = { premium: target.unitCost, credits: perCallCredits }
      const hold = ledger.reserve(`${c.id} run ${run}`, { calls: CALLS_PER_RUN, perCall: reserved, pricing })
      if ("refused" in hold) {
        stopped = hold.refused
        break outer
      }
      let obs: SandboxRun
      let sandboxError: string | undefined
      try {
        obs = await runCase({ case: c, host: meteredRuntime(target.runtime as ProviderRuntime, hold, ledger), budget: hold })
      } catch (error) {
        sandboxError = (error as Error).message
        obs = failedRun(`sandbox-error: ${sandboxError}`)
      }
      const spent = hold.release()
      const budgetCut = hold.cutShort()
      const graded = evaluate(c, obs)
      const verdict = budgetCut ? { passed: false, reason: "cut short by its credit reservation" } : gradeRun(obs, graded)
      const { gaps, ...observation } = obs
      runs.push({
        caseId: c.id, run, ...verdict, outcome: obs.outcome, steps: obs.steps, spent, reserved, budgetCut, checks: graded.checks, gaps,
        viaShellFallback: verdict.passed && withoutBooksRemove(obs), observation,
      })
      perCallCredits = Math.max(perCallCredits, hold.maxCall())
      if (ledger.stopped()) {
        stopped = ledger.stopped()
        break outer
      }
      if (sandboxError !== undefined) {
        stopped = `the sandbox failed: ${sandboxError}`
        break outer
      }
    }
  }
  const after = await target.quota()
  const totals = ledger.totals()
  const cells = buildCells(cases, { target: args.target, bundleRef: args.bundleRef, harnessRef: args.harnessRef, planned: args.runs }, runs)
  const result: RunResult = {
    schemaVersion: 1, target: args.target, bundleRef: args.bundleRef, harnessRef: args.harnessRef, account: target.account,
    premiumMultiplier: target.unitCost, multiplierSource: target.multiplierSource, caps: totals.caps, spent: totals.spent, calls: totals.calls,
    stopped: stopped ?? null, quota: { before, after }, cells,
  }
  deps.writeReport(args.output, { ...result, runs })
  deps.print(summarize({ target: args.target, bundleRef: args.bundleRef, cells, spent: totals.spent, stopped, quota: result.quota }))
  emitNervesEvent({ component: "eval", event: "eval.run_command_end", message: "finished an eval model run", meta: { target: args.target, runs: runs.length, stopped: stopped ?? null, ...totals.spent } })
  return { exitCode: stopped ? 2 : 0, result, runs }
}

