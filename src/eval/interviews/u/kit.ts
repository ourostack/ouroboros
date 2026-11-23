/**
 * Product U, Ouro UI against two other component kits (pre-registration section 2), as the runner's `ProductKit`.
 * Its one job, `remove-copy-card` (section 4), is no books case: the owner's message is the job, word for word, and
 * the run is graded in the container (`guest/u/arms.ts`) by the type-check, an axe scan with no violations and the
 * hidden test, which this kit reads back into a verdict. The household still runs beside the agent container, as in
 * every sandboxed run, but no U tool reaches it.
 */
import type { Case, Observation } from "../../domain/case"
import type { SandboxRun } from "../../sandbox/remote"
import type { ProductKit, Verdict } from "../runner"
import { labelLine } from "../protocol"

export const U_JOB = "remove-copy-card"

/** The job's user message, word for word from section 4. */
export const U_JOB_MESSAGE = "Build the screen where I confirm removing a bad copy of a book from my library. It shows the two copies of The Harbour Almanac: 187, which is unreadable, and 189, the good one. Removing 187 must ask me to confirm first, then tell me it's done. Write it as a React component in src/RemoveCopy.tsx with the default export RemoveCopy({ onRemove }), using the component kit in @kit/ui, and run the checks before you finish."

/** The job as the sandbox runs it: the persona's bundle paths, the owner's message and an empty household. */
export const U_CASE: Case = {
  schemaVersion: 1,
  id: U_JOB,
  actionIds: [],
  bundle: { include: ["agent.json", "psyche", "skills", "books"] },
  prefix: [{ role: "user", content: U_JOB_MESSAGE }],
  seed: { library: [], libgen: [], labels: [], deleteAllowed: false, disk: [] },
  assertions: [{ name: "u.grade" }],
  fixtures: { pass: emptyObservation(), fail: { "no-grade": emptyObservation() } },
}

function emptyObservation(): Observation {
  return { timeline: [], finalReply: "", library: [], mail: [], created: [], outcome: "settled", steps: 0, oracle: {} }
}

/** What the guest's grader reports (deploy/eval/u/tools/grade.mjs): every section, always, or `{ error }`. */
export type UGrade = {
  typecheck: { ok: boolean; output: string }
  axe: { ok: boolean; violations: number; output: string }
  hidden: { firstPressHeld: boolean; confirmedOnce187: boolean; statusSaysDone: boolean; detail: string }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The grade, or why it isn't one. */
export function readGrade(value: unknown): UGrade | { error: string } {
  if (!isRecord(value)) return { error: "the guest reported no grade" }
  if (typeof value.error === "string") return { error: value.error }
  const { typecheck, axe, hidden } = value
  if (!isRecord(typecheck) || typeof typecheck.ok !== "boolean" || typeof typecheck.output !== "string"
    || !isRecord(axe) || typeof axe.ok !== "boolean" || typeof axe.violations !== "number" || typeof axe.output !== "string"
    || !isRecord(hidden) || typeof hidden.firstPressHeld !== "boolean" || typeof hidden.confirmedOnce187 !== "boolean" || typeof hidden.statusSaysDone !== "boolean" || typeof hidden.detail !== "string") {
    return { error: "the guest's grade is malformed" }
  }
  return value as UGrade
}

/** Section 4's pass rule: the type-check passes, axe finds no violations, and the hidden test's three checks hold. */
export function gradeU(run: SandboxRun): Verdict {
  const grade = readGrade(run.grade)
  if ("error" in grade) return { passed: false, reason: `grade: ${grade.error}`, checks: [{ name: "u.grade", ok: false, detail: grade.error }] }
  const detail = grade.hidden.detail
  const checks = [
    { name: "u.typecheck", ok: grade.typecheck.ok, detail: grade.typecheck.ok ? "no type errors" : "type errors" },
    { name: "u.axe", ok: grade.axe.ok && grade.axe.violations === 0, detail: `${grade.axe.violations} violations` },
    { name: "u.hidden.firstPressHeld", ok: grade.hidden.firstPressHeld, detail },
    { name: "u.hidden.confirmedOnce187", ok: grade.hidden.confirmedOnce187, detail },
    { name: "u.hidden.statusSaysDone", ok: grade.hidden.statusSaysDone, detail },
  ]
  const failed = checks.filter((check) => !check.ok).map((check) => check.name)
  return { passed: failed.length === 0, reason: failed.length === 0 ? null : `failed ${failed.join(", ")}`, checks }
}

/** What is recorded about each U arm before any session (section 3): where it differs from the kit it stands for. */
export const U_FIDELITY: Readonly<Record<string, string[]>> = {
  "U:all": [
    "every arm is the same project template with the kit installed under @kit/ui, and the same five tools; a tool's path is relative to the project, reads may follow node_modules into the kit's packages, and writes never reach node_modules; read_file gives at most 60,000 characters a call, with an offset to read on",
    "the type-check and the axe scan use the checking tools' own compiler settings and rules, not files the model can change; axe runs the WCAG 2.x A and AA rules on the first render in jsdom, where no kit's stylesheet is loaded",
    "the job and its debrief run in one conversation with the arm's tools; finish ends a turn with its summary as the reply; the run is graded once the conversation has ended, so a debrief call can still change the project, as X scores its household after the debrief",
    "the grade is taken in the container and the host reads it back as the guest reported it; the model's component runs only in a separate process under Node's permission model that can't read the hidden test or write files, and its result counts only with a signature made under a key the page never sees; a component written to subvert the test inside its own page could still change what the test sees, and transcripts are kept",
    "the system prompt is the Butler's persona and the label line, as in every U and X arm",
  ],
}

export const U_KIT: ProductKit = {
  guest: ({ session, arm, debrief }) => ({
    entry: "interview-guest-entry.js",
    turn: { product: session.product, arm: arm.arm, labelLine: labelLine(session.product, arm.label), prefix: [], userText: U_JOB_MESSAGE, followUps: [debrief] },
  }),
  canonical: (_arm, obs) => obs,
  job: (id) => id === U_JOB ? U_CASE : undefined,
  grade: (run) => gradeU(run),
  fidelity: U_FIDELITY,
}
