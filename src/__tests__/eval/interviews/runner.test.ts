import crypto from "node:crypto"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import type { Case } from "../../../eval/domain/case"
import { canonicalX, NO_BOOKS, parseInterviewArgs, runInterviews, summarizeSessions, X_KIT, type InterviewArgs, type InterviewDeps, type SessionRecord } from "../../../eval/interviews/runner"
import { loadCases } from "../../../eval/self-test"
import type { RunCase, SandboxRun } from "../../../eval/sandbox/remote"
import type { ResolvedTarget } from "../../../eval/targets"

const CASES = path.resolve(__dirname, "../../../eval/cases/sanctuary-books")
const cases = new Map(loadCases(CASES).map((c) => [c.id, c]))

const ROWS = [
  "| X-pilot | MiniMax-M3 | remove-bad-copy | T=ouro, J=cli-shell, Q=mcp-plain |",
  "| X-1 | MiniMax-M3 | remove-bad-copy | F=ouro, J=mcp-plain, K=cli-shell |",
  "| X-2 | MiniMax-M3 | unreadable-edition | F=mcp-plain, J=cli-shell, K=ouro |",
  "| H-1 | MiniMax-M3 | remove-bad-copy | F=codex, J=ouro, K=openhands |",
]
const PREREG = ["## Appendix B", ...ROWS, "## Appendix C"].join("\n")
const SHA = crypto.createHash("sha256").update(`${ROWS.join("\n")}\n`).digest("hex")
const usage = { input_tokens: 10_000, output_tokens: 500, reasoning_tokens: 0, total_tokens: 10_500 }

type Reply = { content?: string; calls?: Array<{ name: string; arguments: string }> }
/** The target's model: the final conversation's answers come from `final`; everything else answers "ok". */
function target(final: (request: ProviderTurnRequest) => Reply | Error = () => ({ content: "" }), over: Partial<ResolvedTarget> = {}, job: () => Reply | Error = () => ({ content: "ok" })): ResolvedTarget & { sent: ProviderTurnRequest[] } {
  const sent: ProviderTurnRequest[] = []
  const runtime: ProviderRuntime = {
    id: "minimax", model: "MiniMax-M3", client: null, capabilities: new Set(),
    streamTurn: async (request) => {
      sent.push(request)
      const isFinal = request.activeTools.some((tool) => tool.type === "function" && tool.function.name === "choose")
      const step = isFinal ? final(request) : job()
      if (step instanceof Error) throw step
      return { content: step.content ?? "", toolCalls: (step.calls ?? []).map((call, i) => ({ id: `id${sent.length}-${i}`, ...call })), outputItems: [], usage }
    },
    appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined,
    classifyError: (error) => ((error as { status?: number }).status === 429 ? "rate-limit" : "unknown"),
  }
  return { spec: "minimax:MiniMax-M3", runtime, unitCost: 1, multiplierSource: "not a Copilot target", account: null, quota: async () => ({ tokenBased: null, reading: null }), sent, ...over }
}

const chooseOuro = (request: ProviderTurnRequest): Reply => {
  const q3 = String(request.messages[1]!.content)
  const label = /tool interface (\w), /.exec(q3)![1]!
  if (request.messages.some((m) => m.role === "user" && String(m.content).startsWith("One more question"))) return { calls: [{ name: "identify", arguments: JSON.stringify({ guesses: { [label]: "no idea" } }) }] }
  return { calls: [{ name: "choose", arguments: JSON.stringify({ first: label, second: label, reason: "r" }) }] }
}

type Plan = { jobCalls?: number; debriefCalls?: number; obs?: "pass" | string; throws?: string; brand?: boolean; outcome?: string; error?: Error }
/** Each arm's sandbox: `jobCalls` job calls and `debriefCalls` debrief calls through the host, then the case's fixture. */
function sandbox(plan: (arm: string, run: number) => Plan): RunCase & { guests: unknown[] } {
  const guests: unknown[] = []
  let run = 0
  const fn = (async ({ case: c, host, guest, budget }) => {
    run += 1
    // The proxy's own budget lets every call through: the latch on the host is what limits them.
    expect(budget.take()).toBe(true)
    guests.push(guest)
    const turn = guest!.turn as { arm: string; labelLine: string; followUps: string[] }
    const step = plan(turn.arm, run)
    if (step.throws) throw new Error(step.throws)
    const messages = (extra: string) => [{ role: "system" as const, content: `persona\n\n${turn.labelLine}` }, { role: "user" as const, content: extra }]
    let outcome = "settled"
    let debriefOutcome = "settled"
    let jobMade = 0
    let debriefMade = 0
    for (let i = 0; i < (step.jobCalls ?? 2); i += 1) {
      jobMade += 1
      try {
        if (step.error && i === 0) throw step.error
        await host.streamTurn({ messages: messages(step.brand ? "the ouro job" : "the job"), activeTools: [], callbacks: {} as never })
      } catch (error) {
        outcome = `provider-error: ${(error as Error).message}`
        break
      }
    }
    if (outcome === "settled") {
      for (let i = 0; i < (step.debriefCalls ?? 1); i += 1) {
        debriefMade += 1
        try {
          await host.streamTurn({ messages: [...messages("the job"), { role: "user", content: turn.followUps[0]! }], activeTools: [], callbacks: {} as never })
        } catch (error) {
          debriefOutcome = `provider-error: ${(error as Error).message}`
          break
        }
      }
    }
    const fixture = (step.obs ?? "pass") === "pass" ? c.fixtures.pass : c.fixtures.fail[step.obs!]!
    return {
      ...fixture, outcome: step.outcome ?? outcome, gaps: [],
      ...(outcome === "settled" ? { followUps: [{ finalReply: `5\nnotes for ${turn.labelLine.slice(-2, -1)}`, outcome: debriefOutcome, calls: debriefMade, toolCalls: 0 }] } : {}),
    } satisfies SandboxRun
  }) as RunCase & { guests: unknown[] }
  fn.guests = guests
  void 0
  return fn
}

const args = (over: Partial<InterviewArgs> = {}): InterviewArgs => ({
  preregistration: "/prereg.md", sessions: ["X-pilot"], reduced: false, cases: CASES, target: "minimax:MiniMax-M3", credentialsAgent: "slugger",
  budgetPremium: 1000, budgetCredits: 300, priceIn: 30, priceOut: 120, reserveCreditsPerCall: 1, output: "/r/run.json", requestLog: "/r/run.requests.ndjson", harnessRef: "h", ...over,
})

function startedSet(): InterviewDeps["started"] {
  const ids = new Set<string>()
  return { has: (id) => ids.has(id), add: (id) => { ids.add(id) } }
}

function deps(runCase: RunCase, model = target(chooseOuro), over: Partial<InterviewDeps> = {}) {
  const reports: unknown[] = []
  const log: string[] = []
  const printed: string[] = []
  const d: InterviewDeps = {
    readText: () => PREREG, loadCases: () => [...cases.values()], resolveTarget: async () => model, runCase, kits: { X: X_KIT },
    outputExists: () => false, writeReport: (_file, report) => reports.push(report), openLog: () => (line) => log.push(line),
    print: (text) => printed.push(text), allocationSha256: SHA, started: startedSet(), ...over,
  }
  return { d, reports, log, printed, model }
}

describe("the interview runner", () => {
  it("runs a session: three arms with the label line and Q1, then Q3 and Q4, and records ouro chosen first", async () => {
    const runCase = sandbox(() => ({}))
    const { d, reports, log, printed } = deps(runCase)
    const { exitCode, records } = await runInterviews(args(), d)
    expect(exitCode).toBe(0)
    const [record] = records as [SessionRecord]
    expect(record).toMatchObject({ id: "X-pilot", status: "complete", ended: null, ouroFirst: true, labels: { T: "ouro", J: "cli-shell", Q: "mcp-plain" }, voidedBy: null })
    expect(record.arms.map((arm) => [arm.label, arm.arm, arm.passed, arm.rating, arm.jobCalls, arm.debriefCalls])).toEqual([["T", "ouro", true, 5, 2, 1], ["J", "cli-shell", true, 5, 2, 1], ["Q", "mcp-plain", true, 5, 2, 1]])
    expect(record.final).toMatchObject({ choice: { first: "T" }, guesses: { T: "no idea" }, nudged: false })
    expect(record.calls).toHaveLength(11)
    expect(record.spent.premium).toBe(11)
    expect(runCase.guests[0]).toEqual({
      entry: "interview-guest-entry.js",
      turn: { product: "X", arm: "ouro", labelLine: "Your tools for this job are tool interface T.", prefix: cases.get("remove-bad-copy")!.prefix.slice(0, -1), userText: "yes please, get rid of the old one", followUps: [expect.stringContaining("In tool interface T:")] },
    })
    expect(log).toHaveLength(11)
    expect(JSON.parse(log[0]!)).toMatchObject({ session: "X-pilot", kind: "job", sent: true })
    expect(JSON.parse(log[2]!)).toMatchObject({ kind: "debrief" })
    expect(JSON.parse(log.at(-1)!)).toMatchObject({ kind: "identify" })
    expect(printed[0]).toMatch(/^X-pilot complete ouro-first=yes jobs-passed=3\/3 calls=11 tokens-in=110000 tokens-out=5500 credits=3\.960 premium=11\nspent: 3\.960 credits, 11 premium requests$/)
    expect(reports[0]).toMatchObject({ kind: "blind-interviews", stopped: null, fidelity: expect.objectContaining({ "X:all": expect.any(Array) }), sessions: [expect.objectContaining({ id: "X-pilot" })] })
  })

  it("voids a session whose request names a brand, sends nothing for it, and goes on to the next session", async () => {
    const runCase = sandbox((_arm, run) => ({ brand: run === 2 }))
    const { d, model } = deps(runCase)
    const { records } = await runInterviews(args({ sessions: ["X-pilot", "X-1"] }), d)
    expect(records[0]).toMatchObject({ status: "void", ended: "J: a request named ouro", ouroFirst: false, voidedBy: ["ouro"], final: null })
    expect(records[0]!.arms).toHaveLength(2)
    expect(model.sent.some((request) => JSON.stringify(request.messages).includes("ouro job"))).toBe(false)
    expect(records[1]).toMatchObject({ id: "X-1", status: "complete", ouroFirst: true })
  })

  it("ends a job conversation at its 13th call: the job does not pass, its note is empty, and the session goes on", async () => {
    const runCase = sandbox((arm) => (arm === "cli-shell" ? { jobCalls: 13 } : { debriefCalls: arm === "ouro" ? 3 : 1 }))
    const { d } = deps(runCase)
    const { records } = await runInterviews(args(), d)
    const [record] = records as [SessionRecord]
    expect(record.status).toBe("complete")
    const shell = record.arms.find((arm) => arm.arm === "cli-shell")!
    expect(shell).toMatchObject({ passed: false, reason: "refused: the job conversation's call limit of 12 is used up", note: "", rating: null, jobCalls: 12, debriefOutcome: null })
    const ouro = record.arms.find((arm) => arm.arm === "ouro")!
    expect(ouro).toMatchObject({ passed: true, debriefCalls: 2, note: "", debriefOutcome: "provider-error: not sent: the debrief conversation's call limit of 2 is used up" })
  })

  it("counts a crash, a provider error and a failed final conversation as crashed sessions, never rerun", async () => {
    const crash = await runInterviews(args(), deps(sandbox(() => ({ throws: "docker died" }))).d)
    expect(crash.records[0]).toMatchObject({ status: "crashed", ended: "T: docker died", ouroFirst: false })
    const provider = await runInterviews(args(), deps(sandbox(() => ({ error: new Error("upstream 500") }))).d)
    expect(provider.records[0]).toMatchObject({ status: "crashed", ended: "T: provider-error: upstream 500" })
    const failedFinal = await runInterviews(args(), deps(sandbox(() => ({})), target(() => new Error("final 500"))).d)
    expect(failedFinal.records[0]).toMatchObject({ status: "crashed", ended: "final: final 500" })
    const mismatch = await runInterviews(args(), deps(sandbox(() => ({ outcome: "trace-mismatch" }))).d)
    expect(mismatch.records[0]).toMatchObject({ status: "crashed", ended: "T: trace-mismatch" })
    const failedJob = await runInterviews(args(), deps(sandbox(() => ({ obs: Object.keys(cases.get("remove-bad-copy")!.fixtures.fail)[0]! }))).d)
    expect(failedJob.records[0]).toMatchObject({ status: "complete" })
    expect(failedJob.records[0]!.arms.every((arm) => !arm.passed)).toBe(true)
  })

  it("records no choice after the nudge, and a brand word in the final conversation voids it", async () => {
    const silent = await runInterviews(args(), deps(sandbox(() => ({})), target(() => ({ content: "T" }))).d)
    expect(silent.records[0]).toMatchObject({ status: "complete", ouroFirst: false, final: { choice: null, nudged: true } })
    expect(silent.records[0]!.calls.filter((call) => call.kind === "choose")).toHaveLength(2)
    const leaky = await runInterviews(args(), deps(sandbox((arm) => ({})), target(chooseOuro)).d)
    expect(leaky.records[0]!.status).toBe("complete")
    const brandNote = sandbox(() => ({}))
    const wrapped: RunCase = async (input) => {
      const run = await brandNote(input)
      return { ...run, followUps: run.followUps!.map((f) => ({ ...f, finalReply: "4\nlike Claude Code" })) }
    }
    const voided = await runInterviews(args(), deps(wrapped).d)
    expect(voided.records[0]).toMatchObject({ status: "void", ended: "final: a request named claude" })
    const refusedQ4 = target((request) => request.messages.some((m) => m.role === "user" && String(m.content).startsWith("One more")) ? { calls: [] } : chooseOuro(request))
    expect((await runInterviews(args(), deps(sandbox(() => ({})), refusedQ4).d)).records[0]).toMatchObject({ status: "complete", ouroFirst: true })
  })

  it("stops the study at a 429, and at a reservation a cap refuses, recording later sessions as not run", async () => {
    const limited = target(() => Object.assign(new Error("slow down"), { status: 429 }))
    const stopped = await runInterviews(args({ sessions: ["X-pilot", "X-1"] }), deps(sandbox(() => ({})), limited).d)
    expect(stopped.exitCode).toBe(2)
    expect(stopped.records[0]).toMatchObject({ status: "crashed", ended: expect.stringMatching(/^final: the provider answered 429/) })
    expect(stopped.records[1]).toMatchObject({ status: "not-run", ended: expect.stringMatching(/^the study stopped/) })
    const midJob = await runInterviews(args(), deps(sandbox(() => ({})), target(chooseOuro, {}, () => Object.assign(new Error("busy"), { status: 429 }))).d)
    expect(midJob.records[0]).toMatchObject({ status: "crashed", ended: expect.stringMatching(/^T: the provider answered 429/) })

    const capped = await runInterviews(args({ sessions: ["X-pilot", "X-1"], budgetPremium: 50 }), deps(sandbox(() => ({}))).d)
    expect(capped.records.map((r) => r.status)).toEqual(["complete", "not-run"])
    expect(capped.records[1]!.ended).toMatch(/premium/)
    const none = await runInterviews(args({ budgetPremium: 10 }), deps(sandbox(() => ({}))).d)
    expect(none.records[0]).toMatchObject({ status: "not-run" })
  })

  it("runs the reduced design's sessions, every one by default", async () => {
    const { d } = deps(sandbox(() => ({})))
    const { records } = await runInterviews(args({ sessions: [], reduced: true, budgetPremium: 10_000, budgetCredits: 10_000 }), { ...d, readText: () => ["## Appendix B", ...ROWS.slice(0, 3), "## Appendix C"].join("\n"), allocationSha256: crypto.createHash("sha256").update(`${ROWS.slice(0, 3).join("\n")}\n`).digest("hex") })
    expect(records.map((r) => r.id)).toEqual(["X-pilot", "X-1", "X-2"])
    expect(records[2]!.arms[2]).toMatchObject({ arm: "ouro" })
  })

  it("refuses before spending: an unknown session, a product with no kit, a missing case, an existing file, an unpriced or uncapped token target", async () => {
    const { d } = deps(sandbox(() => ({})))
    await expect(runInterviews(args({ sessions: ["X-9"] }), d)).rejects.toThrow("no session X-9 in Appendix B")
    await expect(runInterviews(args({ sessions: ["H-1"] }), d)).rejects.toThrow("session H-1 is product H, which has no runner kit yet")
    await expect(runInterviews(args(), { ...d, loadCases: () => [cases.get("unreadable-edition")!] })).rejects.toThrow(/needs case remove-bad-copy/)
    await expect(runInterviews(args(), { ...d, outputExists: (file) => file.endsWith(".ndjson") })).rejects.toThrow("/r/run.requests.ndjson already exists")
    await expect(runInterviews(args({ priceIn: undefined }), d)).rejects.toThrow(/needs --price-in/)
    await expect(runInterviews(args({ budgetCredits: undefined }), d)).rejects.toThrow(/billed by the token/)
    const copilot = deps(sandbox(() => ({})), target(chooseOuro, { account: "a@github.com", quota: async () => ({ tokenBased: false, reading: null }) }))
    const ok = await runInterviews(args({ budgetCredits: undefined, priceIn: undefined, priceOut: undefined, reserveCreditsPerCall: undefined }), copilot.d)
    expect(ok.records[0]!.status).toBe("complete")
    await expect(runInterviews(args({ reserveCreditsPerCall: 0 }), d)).rejects.toThrow("--reserve-credits-per-call must be more than 0")
    await expect(runInterviews(args({ reduced: true, sessions: ["H-1"] }), d)).rejects.toThrow("session H-1 is not in the reduced design")
  })

  it("starts a session once, ever: a second run of it is refused before anything is spent", async () => {
    const started = startedSet()
    const first = deps(sandbox(() => ({})), target(chooseOuro), { started })
    await runInterviews(args(), first.d)
    expect(started.has("X-pilot")).toBe(true)
    const again = deps(sandbox(() => ({})), target(chooseOuro), { started })
    await expect(runInterviews(args({ output: "/r/again.json" }), again.d)).rejects.toThrow("session X-pilot has already started once")
    expect(again.model.sent).toHaveLength(0)
  })

  it("records a session that throws as crashed, releases its hold and still writes the report", async () => {
    const { d, reports } = deps(sandbox(() => ({})), target(chooseOuro), { kits: { X: { ...X_KIT, canonical: () => { throw new Error("bad assertion") } } } })
    const { records } = await runInterviews(args(), d)
    expect(records[0]).toMatchObject({ id: "X-pilot", status: "crashed", ended: "bad assertion", ouroFirst: false })
    expect(reports).toHaveLength(1)
    expect((reports[0] as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  it("writes the report even when the run itself fails partway", async () => {
    const quotaFails = target(chooseOuro)
    let reads = 0
    quotaFails.quota = async () => { reads += 1; if (reads > 1) throw new Error("quota read failed"); return { tokenBased: null, reading: null } }
    const { d, reports } = deps(sandbox(() => ({})), quotaFails)
    await expect(runInterviews(args(), d)).rejects.toThrow("quota read failed")
    expect(reports).toHaveLength(1)
  })
})

describe("scoring every arm the same way", () => {
  const c = cases.get("unreadable-edition") as Case
  it("writes each tool arm's operation calls as the books command line they ran", () => {
    const obs = { ...c.fixtures.pass, timeline: [
      { kind: "call" as const, name: "deliver_books", args: JSON.stringify({ files: ["work/1/a.epub"], accept_check_failure: true }), result: "" },
      { kind: "call" as const, name: "nope", args: "{}", result: "" },
      { kind: "reply" as const, text: "sent" },
    ] }
    expect(canonicalX("mcp-plain", obs).timeline).toEqual([
      { kind: "call", name: "shell", args: JSON.stringify({ command: "books deliver work/1/a.epub --accept-check-failure" }), result: "" },
      { kind: "call", name: "no-operation", args: "{}", result: "" },
      { kind: "reply", text: "sent" },
    ])
    const ouro = { ...obs, timeline: [{ kind: "call" as const, name: "check", args: JSON.stringify({ files: ["work/1/a.epub"] }), result: "" }] }
    expect(canonicalX("ouro", ouro).timeline[0]).toMatchObject({ name: "shell", args: JSON.stringify({ command: "books check work/1/a.epub" }) })
    // A call the kit refuses (an id given as a number) ran nothing, so it is scored as no operation.
    const refused = { ...obs, timeline: [{ kind: "call" as const, name: "library_remove", args: JSON.stringify({ id: 187 }), result: "" }] }
    expect(canonicalX("ouro", refused).timeline[0]).toMatchObject({ name: "no-operation" })
    const shell = { ...obs, timeline: [
      { kind: "call" as const, name: "shell", args: JSON.stringify({ command: "books check  'work/1/a.epub'" }), result: "" },
      { kind: "call" as const, name: "shell", args: JSON.stringify({ command: "books send --help" }), result: "" },
      { kind: "call" as const, name: "shell", args: JSON.stringify({ command: "books send x.epub --accept-check-failur" }), result: "" },
    ] }
    expect(canonicalX("cli-shell", shell).timeline.map((entry) => entry.kind === "call" ? [entry.name, entry.args] : null)).toEqual([
      ["shell", JSON.stringify({ command: "books check work/1/a.epub" })], ["no-operation", shell.timeline[1]!.args], ["no-operation", shell.timeline[2]!.args],
    ])
  })

  it("runs no books operation on the host", async () => {
    await expect(NO_BOOKS(["ledger"])).rejects.toThrow("runs no books operation")
  })

  it("summarizes counts only", () => {
    expect(summarizeSessions([], { premium: 0, credits: 0 }, "the provider answered 429")).toBe("spent: 0.000 credits, 0 premium requests; stopped: the provider answered 429")
  })
})

describe("the interviews command's flags", () => {
  it("parses flags, repeated sessions and the reduced switch, and names the request log after the report", () => {
    expect(parseInterviewArgs(["--preregistration", "p.md", "--cases", "c", "--target", "minimax:MiniMax-M3", "--credentials-agent", "slugger", "--budget-premium", "100", "--budget-credits", "300", "--output", "/r/x.json", "--session", "X-pilot", "--session", "X-1", "--reduced"])).toEqual({
      preregistration: "p.md", cases: "c", target: "minimax:MiniMax-M3", credentialsAgent: "slugger", budgetPremium: 100, budgetCredits: 300, output: "/r/x.json",
      sessions: ["X-pilot", "X-1"], reduced: true, harnessRef: "unknown", requestLog: "/r/x.requests.ndjson",
    })
    expect(parseInterviewArgs(["--preregistration", "p", "--cases", "c", "--target", "t", "--credentials-agent", "a", "--budget-premium", "1", "--output", "o", "--request-log", "l", "--harness-ref", "abc"])).toMatchObject({ requestLog: "l", harnessRef: "abc" })
    expect(() => parseInterviewArgs(["--nope", "1"])).toThrow("unknown flag --nope")
    expect(() => parseInterviewArgs(["--cases"])).toThrow("--cases needs a value")
    expect(() => parseInterviewArgs(["--budget-premium", "-1"])).toThrow("--budget-premium must be a number of at least 0")
    expect(() => parseInterviewArgs(["--cases", "c"])).toThrow("--preregistration is required")
  })
})
