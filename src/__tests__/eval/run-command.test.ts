import path from "node:path"
import { describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../heart/core"
import { CALLS_PER_RUN, parseEvalArgs, runEvalCommand, type EvalArgs, type EvalDeps } from "../../eval/run-command"
import { loadCases } from "../../eval/self-test"
import type { Case } from "../../eval/domain/case"
import type { ResolvedTarget } from "../../eval/targets"
import type { RunCase, SandboxRun } from "../../eval/sandbox/remote"

const CASES = path.resolve(__dirname, "../../eval/cases/sanctuary-books")
const cases = loadCases(CASES)
const byId = new Map(cases.map((c) => [c.id, c]))

const base: EvalArgs = {
  cases: CASES, caseIds: [], bundle: "/bundles/fixed", bundleRef: "b24bff6", target: "minimax:MiniMax-M3", runs: 2,
  budgetPremium: 300, budgetCredits: 500, priceIn: 30, priceOut: 120, reserveCreditsPerCall: 1, credentialsAgent: "slugger",
  output: "/reports/run.json", harnessRef: "h1",
}
const { budgetCredits: _c, priceIn: _i, priceOut: _o, reserveCreditsPerCall: _r, ...noCredits } = base

function runtime(): ProviderRuntime {
  return {
    id: "minimax", model: "MiniMax-M3", client: null, capabilities: new Set(),
    streamTurn: async () => ({ content: "", toolCalls: [], outputItems: [], usage: { input_tokens: 10_000, output_tokens: 500, reasoning_tokens: 0, total_tokens: 10_500 } }),
    appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined,
    classifyError: (error) => ((error as { status?: number }).status === 429 ? "rate-limit" : "unknown"),
  }
}

const target = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  spec: "minimax:MiniMax-M3", runtime: runtime(), unitCost: 1, multiplierSource: "--premium-multiplier", account: null,
  quota: async () => ({ tokenBased: null, reading: null }), ...over,
})

/** Each run makes `calls` model calls through the budget, then returns the case's own pass or a fail fixture. */
function scripted(plan: (c: Case, run: number) => { calls: number; obs: "pass" | string; throwOn?: number }): RunCase & { runs: string[] } {
  const counts = new Map<string, number>()
  const runs: string[] = []
  const fn = (async ({ case: c, host, budget }) => {
    const run = (counts.get(c.id) ?? 0) + 1
    counts.set(c.id, run)
    runs.push(`${c.id}#${run}`)
    const step = plan(c, run)
    let made = 0
    for (let i = 0; i < step.calls; i += 1) {
      if (!budget.take()) return { ...byId.get(c.id)!.fixtures.pass, outcome: "errored", steps: made, gaps: [] } satisfies SandboxRun
      made += 1
      if (step.throwOn === i) {
        await host.streamTurn({} as never).catch(() => undefined)
        return { ...byId.get(c.id)!.fixtures.pass, outcome: "errored", steps: made, gaps: [] } satisfies SandboxRun
      }
      await host.streamTurn({} as never)
    }
    const fixture = step.obs === "pass" ? c.fixtures.pass : c.fixtures.fail[step.obs]!
    return { ...fixture, steps: made, gaps: ["TACIT.md"] }
  }) as RunCase & { runs: string[] }
  fn.runs = runs
  return fn
}

function deps(runCase: RunCase, over: Partial<EvalDeps> = {}): EvalDeps & { printed: string[]; reports: Array<{ file: string; report: any }> } {
  const printed: string[] = []
  const reports: Array<{ file: string; report: any }> = []
  return {
    printed, reports,
    resolveTarget: async () => target(),
    runCase: () => runCase,
    outputExists: () => false,
    writeReport: (file, report) => { reports.push({ file, report }) },
    print: (text) => { printed.push(text) },
    ...over,
  }
}

describe("parseEvalArgs", () => {
  it("reads every flag", () => {
    expect(parseEvalArgs([
      "--cases", "c", "--bundle", "b", "--bundle-ref", "r", "--target", "github-copilot:claude-opus-5.5", "--runs", "5", "--budget-premium", "300",
      "--credentials-agent", "slugger", "--copilot-account", "ari", "--premium-multiplier", "1", "--output", "o.json", "--budget-credits", "2500",
      "--price-in", "400", "--price-out", "2000", "--reserve-credits-per-call", "15", "--case", "remove-bad-copy", "--case", "unreadable-edition",
      "--harness-ref", "h", "--seed-bundle", "s", "--oracle-books", "ob", "--sandbox-ssh", "sanctuary:/tmp/ouro-eval-2026-11-22",
    ])).toEqual({
      cases: "c", bundle: "b", bundleRef: "r", target: "github-copilot:claude-opus-5.5", runs: 5, budgetPremium: 300, credentialsAgent: "slugger",
      copilotAccount: "ari", premiumMultiplier: 1, output: "o.json", budgetCredits: 2500, priceIn: 400, priceOut: 2000, reserveCreditsPerCall: 15,
      caseIds: ["remove-bad-copy", "unreadable-edition"], harnessRef: "h", seedBundle: "s", oracleBooks: "ob", sandboxSsh: "sanctuary:/tmp/ouro-eval-2026-11-22",
    })
  })

  it("refuses a missing required flag, an unknown flag, a flag with no value and a bad number", () => {
    expect(() => parseEvalArgs(["--cases", "c"])).toThrow(/--bundle is required/)
    expect(() => parseEvalArgs(["--cases", "c", "--nope", "x"])).toThrow(/unknown flag --nope/)
    expect(() => parseEvalArgs(["--cases"])).toThrow(/--cases needs a value/)
    const required = ["--cases", "c", "--bundle", "b", "--bundle-ref", "r", "--target", "t", "--budget-premium", "1", "--credentials-agent", "a", "--output", "o"]
    expect(() => parseEvalArgs([...required, "--runs", "zero"])).toThrow(/--runs must be a whole number of at least 1/)
    expect(() => parseEvalArgs([...required, "--runs", "2", "--budget-credits", "-1"])).toThrow(/--budget-credits must be a number of at least 0/)
    expect(parseEvalArgs([...required, "--runs", "1"])).toMatchObject({ runs: 1, caseIds: [], harnessRef: "unknown" })
  })
})

describe("runEvalCommand", () => {
  it("runs every case the asked number of times, and writes the report with the cells and spend", async () => {
    const runCase = scripted(() => ({ calls: 3, obs: "pass" }))
    const d = deps(runCase)
    const { exitCode, result } = await runEvalCommand(base, d)
    expect(exitCode).toBe(0)
    expect(runCase.runs).toEqual(["remove-bad-copy#1", "remove-bad-copy#2", "unreadable-edition#1", "unreadable-edition#2"])
    expect(result).toMatchObject({ schemaVersion: 1, target: "minimax:MiniMax-M3", bundleRef: "b24bff6", harnessRef: "h1", calls: 12, spent: { premium: 12, credits: 4.32 }, stopped: null })
    expect(result.cells.map((cell) => [cell.caseId, cell.passes, cell.completed])).toEqual([["remove-bad-copy", 2, 2], ["unreadable-edition", 2, 2]])
    expect(d.reports).toHaveLength(1)
    expect(d.reports[0]!.file).toBe("/reports/run.json")
    expect(d.reports[0]!.report.runs).toHaveLength(4)
    expect(d.printed.join("\n")).toContain("remove-bad-copy: 2/2")
  })

  it("passes the credentials agent, the pinned account and the given multiplier to the target", async () => {
    const seen: unknown[] = []
    const d = deps(scripted(() => ({ calls: 1, obs: "pass" })), { resolveTarget: async (spec, creds) => { seen.push([spec, creds]); return target() } })
    await runEvalCommand({ ...base, runs: 1, caseIds: ["remove-bad-copy"], copilotAccount: "ari", premiumMultiplier: 1 }, d)
    expect(seen).toEqual([["minimax:MiniMax-M3", { agent: "slugger", copilotAccount: "ari", premiumMultiplier: 1 }]])
  })

  it("runs only the named cases", async () => {
    const runCase = scripted(() => ({ calls: 1, obs: "pass" }))
    await runEvalCommand({ ...base, runs: 1, caseIds: ["unreadable-edition"] }, deps(runCase))
    expect(runCase.runs).toEqual(["unreadable-edition#1"])
    await expect(runEvalCommand({ ...base, caseIds: ["nope"] }, deps(runCase))).rejects.toThrow(/no case nope/)
  })

  it("refuses to run when a case fails its self-test, before any target or call", async () => {
    let resolved = false
    const broken = { ...byId.get("remove-bad-copy")!, fixtures: { ...byId.get("remove-bad-copy")!.fixtures, fail: { "said-cant": byId.get("remove-bad-copy")!.fixtures.pass } } }
    const d = deps(scripted(() => ({ calls: 1, obs: "pass" })), { resolveTarget: async () => { resolved = true; return target() }, loadCases: () => [broken] })
    await expect(runEvalCommand(base, d)).rejects.toThrow(/self-test.*said-cant/)
    expect(resolved).toBe(false)
  })

  it("refuses an output file that exists, before any call", async () => {
    let resolved = false
    const d = deps(scripted(() => ({ calls: 1, obs: "pass" })), { outputExists: () => true, resolveTarget: async () => { resolved = true; return target() } })
    await expect(runEvalCommand(base, d)).rejects.toThrow(/already exists/)
    expect(resolved).toBe(false)
  })

  it("refuses a token-billed Copilot account without a credits cap, and a credits cap without prices", async () => {
    const tokenBilled = target({ spec: "github-copilot:claude-opus-5.5", account: "ari@github.com", quota: async () => ({ tokenBased: true, reading: null }) })
    const d = deps(scripted(() => ({ calls: 1, obs: "pass" })), { resolveTarget: async () => tokenBilled })
    await expect(runEvalCommand(noCredits, d)).rejects.toThrow(/token-billed.*--budget-credits/)
    await expect(runEvalCommand({ ...noCredits, budgetCredits: 2500 }, d)).rejects.toThrow(/--price-in, --price-out and --reserve-credits-per-call/)
  })

  it("refuses a pay-per-token target such as MiniMax without a credits cap, and runs a known premium-only Copilot account without one", async () => {
    await expect(runEvalCommand(noCredits, deps(scripted(() => ({ calls: 1, obs: "pass" }))))).rejects.toThrow(/minimax:MiniMax-M3 is billed by the token.*--budget-credits/)
    const premiumOnly = target({ spec: "github-copilot:claude-opus-5.5", account: "ari@github.com", quota: async () => ({ tokenBased: false, reading: null }) })
    const { exitCode } = await runEvalCommand({ ...noCredits, runs: 1 }, deps(scripted(() => ({ calls: 1, obs: "pass" })), { resolveTarget: async () => premiumOnly }))
    expect(exitCode).toBe(0)
  })

  it("does not score a run its own credit reservation cut short, and reserves more for the next", async () => {
    // 0.36 credits a call against a 0.01 estimate: 25 × 0.01 = 0.25 reserved, so the run's first call already passes it.
    const plan = scripted(() => ({ calls: 2, obs: "pass" }))
    const { exitCode, result, runs } = await runEvalCommand({ ...base, runs: 2, caseIds: ["remove-bad-copy"], reserveCreditsPerCall: 0.01 }, deps(plan))
    expect(exitCode).toBe(0)
    expect(runs.map((run) => [run.passed, run.budgetCut, run.reason])).toEqual([[false, true, "cut short by its credit reservation"], [true, false, null]])
    expect(runs[1]!.reserved.credits).toBe(0.36)
    expect(result.cells[0]).toMatchObject({ completed: 1, notRun: 1, passes: 1, passAt1: 1 })
  })

  it("counts credits from usage, reserves each run's worst case, and stops when the next run could pass a cap", async () => {
    // Each run: 3 calls of 10,000 in and 500 out at 30 and 120 credits per million = 0.36 credits a call.
    const runCase = scripted(() => ({ calls: 3, obs: "pass" }))
    const d = deps(runCase)
    // Each run reserves 25 calls × 1 premium request. With a cap of 30, run 1 (3 spent after) and run 2 (6 spent
    // after) fit, and run 3 would need 6 + 25 = 31.
    const { exitCode, result } = await runEvalCommand({ ...base, runs: 3, budgetPremium: 30, budgetCredits: 500, priceIn: 30, priceOut: 120, reserveCreditsPerCall: 1 }, d)
    expect(CALLS_PER_RUN).toBe(25)
    expect(runCase.runs).toEqual(["remove-bad-copy#1", "remove-bad-copy#2"])
    expect(result.spent).toEqual({ premium: 6, credits: 2.16 })
    expect(exitCode).toBe(2)
    expect(result.stopped).toMatch(/would pass the premium cap 30/)
    expect(result.cells.some((cell) => cell.notRun > 0)).toBe(true)
  })

  it("ends the whole run on the first 429, keeping the finished runs and failing the one it cut short", async () => {
    let calls = 0
    const limited = target({
      runtime: {
        ...runtime(),
        streamTurn: async () => {
          calls += 1
          if (calls === 5) throw Object.assign(new Error("HTTP 429"), { status: 429 })
          return { content: "", toolCalls: [], outputItems: [] }
        },
      },
    })
    const plan = scripted((c, run) => (c.id === "remove-bad-copy" && run <= 2 ? { calls: 2, obs: "pass" } : { calls: 2, obs: "pass", throwOn: 0 }))
    const d = deps(plan, { resolveTarget: async () => limited })
    const { exitCode, result, runs } = await runEvalCommand(noCredits as EvalArgs, { ...d, resolveTarget: async () => ({ ...limited, quota: async () => ({ tokenBased: false, reading: null }), account: "ari" }) })
    expect(exitCode).toBe(2)
    expect(result.stopped).toMatch(/429/)
    expect(plan.runs).toEqual(["remove-bad-copy#1", "remove-bad-copy#2", "unreadable-edition#1"])
    expect(runs.map((run) => [run.caseId, run.passed, run.reason])).toEqual([
      ["remove-bad-copy", true, null], ["remove-bad-copy", true, null], ["unreadable-edition", false, "outcome errored"],
    ])
    expect(result.cells[1]).toMatchObject({ completed: 1, notRun: 1, passes: 0 })
  })

  it("fails a run that hit the step budget or errored, and one whose checks fail, with its reason", async () => {
    const plan = scripted((c, run) => (run === 1 ? { calls: 1, obs: Object.keys(c.fixtures.fail)[0]! } : { calls: 1, obs: "pass", throwOn: 0 }))
    const { runs } = await runEvalCommand(base, deps(plan))
    expect(runs.map((run) => run.passed)).toEqual([false, false, false, false])
    expect(runs[0]!.reason).toMatch(/^failed /)
    expect(runs[1]!.reason).toBe("outcome errored")
  })

  it("stops when the sandbox itself fails, and records the run as failed", async () => {
    const d = deps((async () => { throw new Error("docker is down") }) as RunCase)
    const { exitCode, result, runs } = await runEvalCommand({ ...base, runs: 1 }, d)
    expect(exitCode).toBe(2)
    expect(result.stopped).toBe("the sandbox failed: docker is down")
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ passed: false, reason: "outcome sandbox-error: docker is down" })
  })

  it("marks runs that passed without the books remove subcommand", async () => {
    const plan = scripted(() => ({ calls: 1, obs: "pass" }))
    const { runs } = await runEvalCommand({ ...base, runs: 1 }, deps(plan))
    expect(runs.find((run) => run.caseId === "remove-bad-copy")!.viaShellFallback).toEqual(expect.any(Boolean))
  })

  it("raises each later run's credit reservation to the most a call has cost so far", async () => {
    const plan = scripted(() => ({ calls: 2, obs: "pass" }))
    // 0.36 credits a call measured, against a 0.1 estimate.
    const { runs } = await runEvalCommand({ ...base, runs: 2, caseIds: ["remove-bad-copy"], budgetCredits: 500, priceIn: 30, priceOut: 120, reserveCreditsPerCall: 0.1 }, deps(plan))
    expect(runs.map((run) => run.reserved.credits)).toEqual([0.1, 0.36])
  })
})
