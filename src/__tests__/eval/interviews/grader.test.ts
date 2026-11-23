import { describe, expect, it } from "vitest"
import type { Session } from "../../../eval/interviews/allocation"
import { bars, formatGrade, gradeStudy, guessFor, isBroken, readRequestLog, sessionsOf } from "../../../eval/interviews/grader"
import type { ArmRecord, SessionRecord } from "../../../eval/interviews/runner"

const ARMS = ["ouro", "mcp-plain", "cli-shell"]
const LABELS = ["F", "J", "K"]

/** A design of `n` X sessions over `models`, each in a rotation of the arm list. */
function design(n: number, models = ["m1", "m2", "m3"]): Session[] {
  return [
    { id: "X-pilot", product: "X", model: "m1", job: "j", pilot: true, arms: [{ label: "T", arm: "ouro" }, { label: "J", arm: "cli-shell" }, { label: "Q", arm: "mcp-plain" }] },
    ...Array.from({ length: n }, (_, i): Session => ({
      id: `X-${i + 1}`, product: "X", model: models[i % models.length]!, job: "j", pilot: false,
      arms: LABELS.map((label, j) => ({ label, arm: ARMS[(i + j) % 3]! })) as Session["arms"],
    })),
  ]
}

function record(session: Session, first: string | null, over: Partial<SessionRecord> = {}, guesses: Record<string, string> | null = null): SessionRecord {
  const labelOf = (arm: string) => session.arms.find((a) => a.arm === arm)!.label
  const arms = session.arms.map((a): ArmRecord => ({
    label: a.label, arm: a.arm, passed: a.arm !== "cli-shell", reason: null, outcome: "settled", checks: [], note: "", rating: a.arm === "mcp-plain" ? null : a.arm === "ouro" ? 6 : 3,
    debriefOutcome: "settled", debriefToolCalls: 0, jobCalls: 3, debriefCalls: 1, observation: {} as never,
  }))
  return {
    id: session.id, product: "X", model: session.model, job: "j", pilot: session.pilot, labels: Object.fromEntries(session.arms.map((a) => [a.label, a.arm])),
    status: "complete", ended: null, arms, ouroFirst: first === "ouro",
    final: first === null ? { choice: null, nudged: true, guesses, ended: null, replies: [] } : { choice: { first: labelOf(first), second: labelOf(first === "ouro" ? "cli-shell" : "ouro"), reason: "" }, nudged: false, guesses, ended: null, replies: [] },
    voidedBy: null, calls: [], spent: { premium: 0, credits: 0 }, ...over,
  }
}

describe("the grader", () => {
  it("passes a product only when ouro is first often enough, every model agrees and the blinding held", () => {
    const sessions = design(18)
    const data = sessions.slice(1)
    const records = data.map((s, i) => record(s, i < 12 ? "ouro" : "mcp-plain"))
    const grade = gradeStudy({ design: sessions, records, requests: [], reduced: false })
    const x = grade.products[0]!
    expect(x).toMatchObject({ product: "X", n: 18, k: 12, passed: true, verdict: "passed", broken: [], conditions: { moreThanChance: true, everyModelAgrees: true, blindingHeld: true } })
    expect(x.byModel.m1).toEqual({ sessions: 6, firsts: { "ouro": 4, "mcp-plain": 2, "cli-shell": 0 }, ouroAhead: true })
    expect(x.arms.ouro).toMatchObject({ firsts: 12, seconds: 6, meanRating: 6, missingRatings: 0, jobsRun: 18, jobsPassed: 18 })
    expect(x.arms["mcp-plain"]).toMatchObject({ firsts: 6, seconds: 0, meanRating: null, missingRatings: 18 })
    expect(x.arms["cli-shell"]).toMatchObject({ seconds: 12, meanRating: 3, jobsPassed: 0 })
    expect(x.firstChoiceJobPassed).toEqual({ sessions: 18, of: 18 })
    expect(x.share.value).toBeCloseTo(12 / 18)
    expect(x.statuses).toEqual({ complete: 18 })
    expect(formatGrade(grade, false)).toContain("X: passed. ouro first in 12 of 18 (bar 11 of 18)")
  })

  it("counts void, crashed, missing and unchosen sessions as ouro not first, and fails on a model that disagrees", () => {
    const sessions = design(18)
    const data = sessions.slice(1)
    const records = data.slice(0, 15).map((s, i) => i === 0 ? record(s, "ouro", { status: "void", ouroFirst: false }) : i === 1 ? record(s, null) : i === 2 ? record(s, "ouro", { status: "crashed", ouroFirst: false, final: null }) : record(s, i % 3 === 0 ? "cli-shell" : "ouro"))
    const x = gradeStudy({ design: sessions, records, requests: [], reduced: false }).products[0]!
    expect(x.statuses).toEqual({ void: 1, complete: 13, crashed: 1, missing: 3 })
    expect(x.k).toBe(8)
    expect(x).toMatchObject({ passed: false, verdict: "failed", conditions: { moreThanChance: false } })
    expect(x.byModel.m1!.ouroAhead).toBe(false)
  })

  it("marks a session broken when Q4 names the ouro label as an ouro product, and fails the blinding past the bar", () => {
    const sessions = design(9)
    const data = sessions.slice(1)
    const ouroLabel = (s: Session) => s.arms.find((a) => a.arm === "ouro")!.label
    const altLabel = (s: Session) => s.arms.find((a) => a.arm === "cli-shell")!.label
    const records = data.map((s, i) => record(s, "ouro", {}, i < 2 ? { [ouroLabel(s)]: "Ouro AX" } : { [ouroLabel(s)]: "no idea", [altLabel(s)]: "a bash shell" }))
    const grade = gradeStudy({ design: sessions, records, requests: [], reduced: true })
    const x = grade.products[0]!
    expect(x.broken).toEqual(["X-1", "X-2"])
    expect(x).toMatchObject({ verdict: "blinding failed", passed: false, conditions: { blindingHeld: false }, withoutBroken: { n: 7, k: 7 } })
    expect(x.arms["cli-shell"]!.identified).toBe(7)
    expect(formatGrade(grade, true)).toContain("2 broken, at most 1: X-1, X-2")
    expect(bars(true)).toEqual({ n: 9, k: 7, broken: 1 })
    expect(isBroken({ ...records[0]!, labels: {} })).toBe(false)
  })

  it("finds brand words sent outside void sessions, and refuses a session reported twice", () => {
    const sessions = design(3)
    const records = [record(sessions[1]!, "ouro", { status: "void", ouroFirst: false }), record(sessions[2]!, "ouro")]
    const requests = [
      { session: "X-1", kind: "job", sent: true, body: "sanctuary.ouro" },
      { session: "X-2", kind: "job", sent: true, body: "uses Claude and GPT" },
      { session: "X-2", kind: "job", sent: false, body: "shadcn" },
      { session: "X-3", kind: "job", sent: true, body: "clean" },
    ]
    expect(gradeStudy({ design: sessions, records, requests, reduced: false }).leak).toEqual({ requests: 4, matches: 4, outsideVoid: 1, sessions: ["X-1", "X-2"] })
    expect(() => gradeStudy({ design: sessions, records: [records[1]!, records[1]!], requests, reduced: false })).toThrow("session X-2 is in the reports twice")
    expect(gradeStudy({ design: [], records: [], requests: [], reduced: false }).products).toEqual([])
    expect(formatGrade(gradeStudy({ design: [sessions[0]!, sessions[1]!], records: [], requests: [], reduced: false }), false)).toContain("share 0.0%")
  })

  it("reads Q4's guesses whatever the model keyed them, fails the blinding on a leak, and checks labels against Appendix B", () => {
    expect(guessFor({ " tool interface k ": "Ouro AX" }, "K")).toBe("Ouro AX")
    expect(guessFor({ k: "x" }, "K")).toBe("x")
    expect(guessFor({ KK: "x" }, "K")).toBeUndefined()
    expect(guessFor(null, "K")).toBeUndefined()
    const sessions = design(9)
    const data = sessions.slice(1)
    const ouroLabel = (s: Session) => s.arms.find((a) => a.arm === "ouro")!.label
    const records = data.map((s, i) => record(s, "ouro", {}, i === 0 ? { [`tool interface ${ouroLabel(s).toLowerCase()}`]: "Ouro" } : null))
    expect(gradeStudy({ design: sessions, records, requests: [], reduced: true }).products[0]!.broken).toEqual(["X-1"])
    const clean = data.map((s) => record(s, "ouro"))
    const leak = [{ session: "X-3", kind: "job", sent: true, body: "uses claude" }]
    expect(gradeStudy({ design: sessions, records: clean, requests: leak, reduced: true }).products[0]).toMatchObject({ verdict: "blinding failed", conditions: { blindingHeld: false }, broken: [] })
    const relabelled = [{ ...clean[0]!, labels: { F: "ouro", J: "mcp-plain", K: "cli-shell", Z: "x" } }, ...clean.slice(1)]
    expect(() => gradeStudy({ design: sessions, records: relabelled, requests: [], reduced: true })).toThrow("session X-1's report gives labels other than Appendix B's")
    // k comes from the choice and Appendix B, never from the runner's own flag.
    const flagged = clean.map((r) => ({ ...r, ouroFirst: false }))
    expect(gradeStudy({ design: sessions, records: flagged, requests: [], reduced: true }).products[0]!.k).toBe(9)
  })

  it("reads the request log strictly", () => {
    expect(readRequestLog(`${JSON.stringify({ session: "X-1", kind: "job", sent: true, body: "{}" })}\n\n`)).toHaveLength(1)
    expect(() => readRequestLog(`{"session":"X-1"}`)).toThrow("request log line 1 is not a logged request")
  })

  it("reads only the request log lines of the version it grades; a line from before lines named their version is version 1's", () => {
    const line = (over: object) => JSON.stringify({ session: "X-1", kind: "job", sent: true, body: "{}", ...over })
    expect(readRequestLog(`${line({ preregistrationVersion: 2 })}\n`, 2)).toHaveLength(1)
    expect(readRequestLog(`${line({})}\n`, 1)).toHaveLength(1)
    expect(() => readRequestLog(`${line({ preregistrationVersion: 2 })}\n${line({})}\n`, 2)).toThrow("request log line 2 is from pre-registration version 1, not version 2; versions are never pooled")
  })

  it("grades only the reports of the pre-registration's own version, so versions are never pooled", () => {
    const [pilot] = design(2)
    const one = record(pilot!, "ouro")
    expect(sessionsOf(2, [{ preregistrationVersion: 2, sessions: [one] }])).toEqual([one])
    // A report from before reports named their version is version 1's.
    expect(sessionsOf(1, [{ sessions: [one] }])).toEqual([one])
    expect(() => sessionsOf(2, [{ preregistrationVersion: 2, sessions: [] }, { sessions: [one] }])).toThrow("report 2 is from pre-registration version 1, not version 2; versions are never pooled")
  })
})
