import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildCells, gradeRun, summarize, writePrivateReport, type RunRecord } from "../../eval/report"
import type { Case, Observation } from "../../eval/domain/case"

const obs = (over: Partial<Observation> = {}): Observation & { gaps: string[] } => ({
  timeline: [], finalReply: "secret reply text", library: [], mail: [], created: [], outcome: "settled", steps: 3, oracle: {}, gaps: ["TACIT.md", "friends"], ...over,
})
const theCase = { id: "remove-bad-copy", actionIds: ["books.library.remove"] } as unknown as Case
const record = (over: Partial<RunRecord>): RunRecord => ({
  caseId: "remove-bad-copy", run: 1, passed: true, reason: null, outcome: "settled", steps: 3, spent: { premium: 3, credits: 10 }, reserved: { premium: 25, credits: 25 }, budgetCut: false, checks: [], gaps: ["TACIT.md"], viaShellFallback: false, observation: obs(), ...over,
})

describe("gradeRun", () => {
  it("passes a settled run whose checks all pass", () => {
    expect(gradeRun({ outcome: "settled" } as Observation, { passed: true, checks: [] })).toEqual({ passed: true, reason: null })
  })

  it("fails a run that ended on an error, a step-budget stop or a refused call, with its reason, whatever the checks say", () => {
    expect(gradeRun(obs({ outcome: "errored" }), { passed: true, checks: [] })).toEqual({ passed: false, reason: "outcome errored" })
    expect(gradeRun(obs({ outcome: "aborted" }), { passed: true, checks: [] })).toEqual({ passed: false, reason: "outcome aborted" })
  })

  it("names the failed checks", () => {
    expect(gradeRun(obs(), { passed: false, checks: [{ name: "mail.none", ok: false, detail: "" }, { name: "x", ok: true, detail: "" }] }))
      .toEqual({ passed: false, reason: "failed mail.none" })
  })
})

describe("buildCells", () => {
  it("gives each case its pass@1 with a Wilson interval, its failure reasons and its fidelity gaps", () => {
    const cells = buildCells([theCase], { target: "minimax:MiniMax-M3", bundleRef: "b24bff6", harnessRef: "abc", planned: 4 }, [
      record({ run: 1 }),
      record({ run: 2, passed: false, reason: "failed mail.none", gaps: ["state"] }),
      record({ run: 3, passed: true, viaShellFallback: true }),
    ])
    expect(cells).toEqual([{
      caseId: "remove-bad-copy", actionIds: ["books.library.remove"], target: "minimax:MiniMax-M3", bundleRef: "b24bff6", harnessRef: "abc",
      planned: 4, completed: 3, notRun: 1, passes: 2, passAt1: 2 / 3, interval: { low: expect.closeTo(0.2077, 3), high: expect.closeTo(0.9385, 3) },
      reasons: { "failed mail.none": 1 }, passesViaShellFallback: 1, fidelityGaps: ["TACIT.md", "state"],
    }])
  })

  it("reports a cell with no finished run as unscored", () => {
    const [cell] = buildCells([theCase], { target: "t", bundleRef: "b", harnessRef: "h", planned: 2 }, [])
    expect(cell).toMatchObject({ completed: 0, passAt1: null, interval: { low: null, high: null }, notRun: 2 })
  })
})

describe("private report and summary", () => {
  let dir: string | undefined
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it("creates the report once, mode 0600 in a 0700 folder, and refuses to overwrite it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-report-"))
    const file = path.join(dir, "reports", "run.json")
    writePrivateReport(file, { hello: "world" })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ hello: "world" })
    expect(() => writePrivateReport(file, {})).toThrow(/EEXIST/)
  })

  it("summarizes scores, spend and gaps without any trace or reply text", () => {
    const cells = buildCells([theCase], { target: "minimax:MiniMax-M3", bundleRef: "b24bff6", harnessRef: "abc", planned: 1 }, [record({})])
    const text = summarize({
      target: "minimax:MiniMax-M3", bundleRef: "b24bff6", cells, spent: { premium: 3, credits: 10.5 }, stopped: "the provider answered 429",
      quota: { before: { tokenBased: true, reading: null }, after: { tokenBased: true, reading: null } },
    })
    expect(text).toContain("remove-bad-copy")
    expect(text).toContain("1/1")
    expect(text).toContain("premium requests 3")
    expect(text).toContain("credits 10.5")
    expect(text).toContain("stopped: the provider answered 429")
    expect(text).toContain("TACIT.md")
    expect(text).not.toContain("secret reply text")
    const plain = summarize({ target: "t", bundleRef: "b", cells: buildCells([theCase], { target: "t", bundleRef: "b", harnessRef: "h", planned: 1 }, []), spent: { premium: 0, credits: 0 }, stopped: undefined, quota: { before: { tokenBased: null, reading: null }, after: { tokenBased: null, reading: null } } })
    expect(plain).toContain("0/0 (unscored)")
    expect(plain).not.toContain("stopped")
  })
})

describe("withoutBooksRemove", () => {
  it("is false when a call ran books library remove or replace, and true otherwise", async () => {
    const { withoutBooksRemove } = await import("../../eval/report")
    const call = (args: string) => ({ kind: "call" as const, name: "shell", args, result: "" })
    expect(withoutBooksRemove(obs({ timeline: [call(JSON.stringify({ command: "books library remove 187" }))] }))).toBe(false)
    expect(withoutBooksRemove(obs({ timeline: [call(JSON.stringify({ command: "/home/ouro/AgentBundles/sanctuary.ouro/books/books library replace 187 x.epub" }))] }))).toBe(false)
    expect(withoutBooksRemove(obs({ timeline: [{ kind: "reply", text: "books library remove" }, call(JSON.stringify({ command: "curl -X POST http://calibre-web:8083/delete/187" }))] }))).toBe(true)
  })
})

describe("summary details", () => {
  it("shows failure reasons, shell passes, quota readings and an empty gap list", () => {
    const cells = buildCells([theCase], { target: "t", bundleRef: "b", harnessRef: "h", planned: 2 }, [
      record({ viaShellFallback: true, gaps: [] }), record({ run: 2, passed: false, reason: "outcome errored", gaps: [] }),
    ])
    const reading = { key: "ari@github.com", leftPct: 50, burnPerH: null, dryAt: null, overageOk: false, at: "t", reset: null, remaining: 150, entitlement: 300, source: "direct" } as never
    const text = summarize({ target: "t", bundleRef: "b", cells, spent: { premium: 0, credits: 0 }, stopped: undefined, quota: { before: { tokenBased: false, reading }, after: { tokenBased: null, reading: null } } })
    expect(text).toContain("1 passed by shell; outcome errored x1")
    expect(text).toContain("150 before, unknown after; token-billed: false")
    expect(text).toContain("fidelity gaps: none")
  })
})
