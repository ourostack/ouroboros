import { describe, expect, it } from "vitest"
import { gradeU, readGrade, U_CASE, U_FIDELITY, U_JOB, U_JOB_MESSAGE, U_KIT } from "../../../eval/interviews/u/kit"
import { KNOWN_ARMS, fidelityOf, X_KIT } from "../../../eval/interviews/runner"
import type { SandboxRun } from "../../../eval/sandbox/remote"

const passing = {
  typecheck: { ok: true, output: "" },
  axe: { ok: true, violations: 0, output: "" },
  hidden: { firstPressHeld: true, confirmedOnce187: true, statusSaysDone: true, detail: "status: Removed." },
}
const run = (grade: unknown): SandboxRun => ({ timeline: [], finalReply: "", library: [], mail: [], created: [], outcome: "settled", steps: 0, oracle: {}, gaps: [], grade })

describe("product U's kit", () => {
  it("runs the registered job, word for word, in the U arms", () => {
    expect(U_JOB).toBe("remove-copy-card")
    expect(U_JOB_MESSAGE).toBe("Build the screen where I confirm removing a bad copy of a book from my library. It shows the two copies of The Harbour Almanac: 187, which is unreadable, and 189, the good one. Removing 187 must ask me to confirm first, then tell me it's done. Write it as a React component in src/RemoveCopy.tsx with the default export RemoveCopy({ onRemove }), using the component kit in @kit/ui, and run the checks before you finish.")
    expect(KNOWN_ARMS.U).toEqual(["ouro", "shadcn", "mui"])
    expect(U_KIT.job!(U_JOB)).toBe(U_CASE)
    expect(U_KIT.job!("remove-bad-copy")).toBeUndefined()
    expect(U_CASE.prefix).toEqual([{ role: "user", content: U_JOB_MESSAGE }])
    expect(U_CASE.seed.library).toEqual([])
    const session = { id: "U-pilot", product: "U" as const, model: "m", order: ["ouro", "shadcn", "mui"], labels: ["Q", "F", "J"], job: U_JOB, pilot: true }
    expect(U_KIT.guest({ session, arm: { arm: "shadcn", label: "F" }, case: U_CASE, debrief: "How did it go?" })).toEqual({
      entry: "interview-guest-entry.js",
      turn: { product: "U", arm: "shadcn", labelLine: "The component kit for this job is component kit F.", prefix: [], userText: U_JOB_MESSAGE, followUps: ["How did it go?"] },
    })
    const obs = run(undefined)
    expect(U_KIT.canonical("ouro", obs)).toBe(obs)
  })

  it("passes a run only when the type-check, axe and all three hidden checks hold", () => {
    expect(gradeU(run(passing))).toEqual({
      passed: true, reason: null,
      checks: [
        { name: "u.typecheck", ok: true, detail: "no type errors" },
        { name: "u.axe", ok: true, detail: "0 violations" },
        { name: "u.hidden.firstPressHeld", ok: true, detail: "status: Removed." },
        { name: "u.hidden.confirmedOnce187", ok: true, detail: "status: Removed." },
        { name: "u.hidden.statusSaysDone", ok: true, detail: "status: Removed." },
      ],
    })
    expect(U_KIT.grade!(run(passing), U_CASE).passed).toBe(true)
    expect(gradeU(run({ ...passing, typecheck: { ok: false, output: "TS2307" } })).reason).toBe("failed u.typecheck")
    expect(gradeU(run({ ...passing, axe: { ok: true, violations: 2, output: "" } })).reason).toBe("failed u.axe")
    expect(gradeU(run({ ...passing, axe: { ok: false, violations: 0, output: "" } })).reason).toBe("failed u.axe")
    expect(gradeU(run({ ...passing, hidden: { ...passing.hidden, firstPressHeld: false, statusSaysDone: false } })).reason).toBe("failed u.hidden.firstPressHeld, u.hidden.statusSaysDone")
    expect(gradeU(run({ ...passing, hidden: { ...passing.hidden, confirmedOnce187: false } })).reason).toBe("failed u.hidden.confirmedOnce187")
  })

  it("fails a run with no grade, a grader's error or a malformed grade", () => {
    expect(gradeU(run(undefined))).toEqual({ passed: false, reason: "grade: the guest reported no grade", checks: [{ name: "u.grade", ok: false, detail: "the guest reported no grade" }] })
    expect(gradeU(run({ error: "the grader gave no result (exit 137): Killed" })).reason).toBe("grade: the grader gave no result (exit 137): Killed")
    expect(readGrade([])).toEqual({ error: "the guest reported no grade" })
    for (const bad of [{ ...passing, typecheck: null }, { ...passing, typecheck: { ok: "yes" } }, { ...passing, axe: { ok: true } }, { ...passing, axe: "x" }, { ...passing, axe: { violations: 0 } },
      { ...passing, hidden: null }, { ...passing, hidden: { ...passing.hidden, firstPressHeld: 1 } }, { ...passing, hidden: { ...passing.hidden, confirmedOnce187: undefined } }, { ...passing, hidden: { ...passing.hidden, statusSaysDone: "done" } }]) {
      expect(readGrade(bad)).toEqual({ error: "the guest's grade is malformed" })
    }
  })

  it("records its fidelity notes once, alongside X's, only when U runs", () => {
    const kits = { X: X_KIT, U: U_KIT }
    expect(fidelityOf(kits, [{ product: "U" }] as never)["U:all"]).toBe(U_FIDELITY["U:all"])
    expect(fidelityOf(kits, [{ product: "X" }] as never)["U:all"]).toBeUndefined()
  })
})
