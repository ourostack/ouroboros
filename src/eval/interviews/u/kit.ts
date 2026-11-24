/**
 * Product U, Ouro UI against two other component kits (pre-registration section 2), as the runner's `ProductKit`.
 * Its one job, `remove-copy-card` (section 4), is no books case: the owner's message is the job, word for word, and
 * the run is graded in the container (`guest/u/arms.ts`) by the type-check, an axe scan with no violations and the
 * hidden test, which this kit reads back into a verdict. The household still runs beside the agent container, as in
 * every sandboxed run, but no U tool reaches it.
 */
import { emitNervesEvent } from "../../../nerves/runtime"
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
  hidden: UHidden
  /** The static scan of the model's files for ways out of the page (lib.mjs escapeScan): one line per hit. */
  escape: { hits: string[] }
  /** When the scan flagged anything: the hidden test again in a fresh process, or null when it couldn't run. */
  recheck?: UHidden | null
}

type UHidden = { firstPressHeld: boolean; confirmedOnce187: boolean; statusSaysDone: boolean; detail: string }

const isHidden = (value: unknown): value is UHidden => isRecord(value) && typeof value.firstPressHeld === "boolean" && typeof value.confirmedOnce187 === "boolean" && typeof value.statusSaysDone === "boolean" && typeof value.detail === "string"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The grade, or why it isn't one. */
export function readGrade(value: unknown): UGrade | { error: string } {
  if (!isRecord(value)) return { error: "the guest reported no grade" }
  if (typeof value.error === "string") return { error: value.error }
  const { typecheck, axe, hidden, escape, recheck } = value
  if (!isRecord(typecheck) || typeof typecheck.ok !== "boolean" || typeof typecheck.output !== "string"
    || !isRecord(axe) || typeof axe.ok !== "boolean" || typeof axe.violations !== "number" || typeof axe.output !== "string"
    || !isHidden(hidden)
    || !isRecord(escape) || !Array.isArray(escape.hits) || !escape.hits.every((hit) => typeof hit === "string")
    || (recheck !== undefined && recheck !== null && !isHidden(recheck))) {
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
  // A grading safeguard, not a pass rule: a run whose source names a way out of the page counts only when the hidden
  // test passes again in a fresh process.
  const hits = grade.escape.hits
  if (hits.length > 0) {
    const again = grade.recheck
    const ok = !!again && again.firstPressHeld && again.confirmedOnce187 && again.statusSaysDone
    checks.push({ name: "u.escape.recheck", ok, detail: `flagged ${hits.join(", ")}; ${!again ? "no second grade" : ok ? "the second grade passed" : `the second grade failed: ${again.detail}`}` })
  }
  const failed = checks.filter((check) => !check.ok).map((check) => check.name)
  emitNervesEvent({ component: "eval", event: "eval.u_graded", message: "graded a U run", meta: { failed: failed.length, escapeHits: hits.length } })
  return { passed: failed.length === 0, reason: failed.length === 0 ? null : `failed ${failed.join(", ")}`, checks }
}

/** What is recorded about each U arm before any session (section 3): where it differs from the kit it stands for. */
export const U_FIDELITY: Readonly<Record<string, string[]>> = {
  "U:all": [
    "every arm is the same project template with the kit installed under @kit/ui, and the same five tools; a tool's path is relative to the project, reads may follow node_modules into the kit's packages, and writes never reach node_modules; read_file gives at most 60,000 characters a call, with an offset to read on",
    "the type-check and the axe scan use the checking tools' own compiler settings and rules, not files the model can change; axe runs the WCAG 2.x A and AA rules on the first render in jsdom, where no kit's stylesheet is loaded, so its colour-contrast rule is off: jsdom computes no colours",
    "the job and its debrief run in one conversation with the arm's tools; finish ends a turn with its summary as the reply; the run is graded once the conversation has ended, so a debrief call can still change the project, as X scores its household after the debrief",
    "the grade is taken in the container and the host reads it back as the guest reported it; the model's component runs only in a separate process under Node's permission model that can't read the hidden test or write files, and that process judges nothing: it sends plain-data snapshots of the DOM, and the grader's own process, where no page code runs, rebuilds each as a script-free copy and gives every verdict; the runner closes the known ways out of the page (Function constructors, code from strings, stack-trace call sites, frames' windows), freezes the built-ins and jsdom classes it uses, ends a run as tampered when the page plants a getter or proxy on jsdom's own objects, and the test takes its hooks and freezes the page's own built-ins before the component loads, but that is hardening, not proof: a component written to subvert the test could still change what the runner sees, so transcripts are kept; a run whose source names a way out of the page (a static scan) counts only when the hidden test passes again in a fresh process",
    "the copy the verdicts are judged on keeps every element, attribute and text node where the page had them, each element's inline style and its computed display and visibility, but not the page's stylesheets (so axe's css-orientation-lock sees none in any arm); known limits: a status that is only transparent (opacity 0) or clipped still counts, as a screen reader still reads it; shadow DOM isn't copied; a component can tell it runs in jsdom; axe can't measure inline text spacing in jsdom and reports it as needing review, not as a violation",
    "the hidden test's wording: the confirm is pressed a random 0.5 to 1.5 s after it appears, and the first press holds only if onRemove hasn't run by then and, in a fresh render whose remove control is pressed and never confirmed, doesn't run within 5 s; a status, read as heard (block elements apart, hidden text left out), says removed or done when a sentence claims it (removed, deleted, gone, done, or removal or deletion complete: section 4 asks for the meaning, not one word) and nothing before the claim in its own clause negates it or puts it in the future (an aside in brackets or dashes is its own clause), no claiming sentence is a question, and the status doesn't say the removal failed; the wording is a heuristic, and a known false fail is a negation inside an unpunctuated relative clause before the claim (\"The copy you couldn't read was removed.\"), so every failed status check reports the exact text read; a name starting with remove or delete always confirms unless it names 189 alone, and other confirm words count unless the name declines (cancel, keep, without, don't, do not, not now, not sure, never mind anywhere, or no, back or close first); the holding check runs once the confirm has been pressed, so a component that keeps a removal across mounts finds no remove control in the fresh render and fails it, and a component written to tell its second mount apart could skip it (a known limit)",
    "the system prompt is the Butler's persona and the label line, as in every U and X arm",
    "the page runs in jsdom with no-op stand-ins for browser features jsdom lacks (CSS.supports answering false, ResizeObserver, IntersectionObserver, matchMedia never matching, scrollIntoView, pointer capture, getAnimations, dialog show, showModal and close), the same for every arm; the kits' own tests run in real browsers",
    "every word of the brand pattern is rewritten wherever it appears, inside words too (hourOffset becomes hkitffset), in the kit and in node_modules; a scan then finds none left in the template",
  ],
  "U:ouro": [
    "Ouro UI at 45b39c4a632b ships as copy-in source; here its 135 components (each folder's component.json list) and the 280 files they import are one package, @kit/ui, with a barrel of 668 exports, an ES module build and type declarations, without its stylesheet or design tokens",
    "its own tests after the rewrite, 35,936 in 8 shards: 12 failed only under load and pass one file at a time; 37, and 9 files that fail to import, are the docs site's and fail the same way without the rewrite (its build runs git fetch, and the archived tree is no repository); 6 fail because of the rewrite, 3 tests in 2 browsers whose expected values come from the brand text (avatar initials of a rewritten name, the vendored a2ui-core.ts byte for byte, a hero-art description fixture); none tests the kit's behaviour differently",
    "the template rewrite made 35,925 replacements and renamed 10 paths",
  ],
  "U:shadcn": [
    "shadcn/ui at bfa64ff4d1cb: the new-york-v4 registry's 61 components, packaged the same way (62 files, 347 exports); radix-ui becomes prim-ui and @shadcn/react becomes @kit/react",
    "one declaration can't name its type: @kit/react's message-scroller entry, a workspace package that isn't built at the pin",
    "shadcn/ui's registry components have no tests of their own, so none could be run after the rewrite",
    "the template rewrite made 7,302 replacements and renamed 27 paths",
  ],
  "U:mui": [
    "MUI at bae15c107484 (@mui/material 10.0.0-alpha.0, not on npm), built with its own build and installed from its packs, with @emotion/react 11.14.0 and @emotion/styled 11.14.1, the versions its own tests install; @mui/material is @kit/ui and every other @mui package is @kit/<name>; the Mui, mui and MUI prefixes of classes, theme keys and props become Kit, kit and KIT",
    "its own tests after the rewrite, with the same replacements in its test utilities: 10,845 of 11,834 passed and none failed (989 skipped); without the rewrite 2 Select pointer-timing tests failed",
  ],
}

/** The name U's guest gives its agent image; a run's `--images` maps it to a tag (`u=<tag>`). */
export const U_IMAGE = "u"

export const U_KIT: ProductKit = {
  guest: ({ session, arm, debrief }) => ({
    entry: "interview-guest-entry.js",
    turn: { product: session.product, arm: arm.arm, labelLine: labelLine(session.product, arm.label), prefix: [], userText: U_JOB_MESSAGE, followUps: [debrief] },
    // The U image (deploy/eval/u): the agent image with the three kits' templates and the checking tools.
    image: U_IMAGE,
  }),
  canonical: (_arm, obs) => obs,
  job: (id) => id === U_JOB ? U_CASE : undefined,
  grade: (run) => gradeU(run),
  fidelity: U_FIDELITY,
}
