export { CHECKS_VERSION, checksText, defineChecks, isChecksReport, printChecks };
export type { CheckDef, CheckFix, CheckResult, CheckRow, CheckState, Checks, ChecksDef, ChecksReport, ChecksRunOptions, Verdict };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import type { NextStep } from "./outcome.ts";
import { devCommandsIn } from "./dev-commands.ts";
import { BASE_EXIT_CODES, FINDINGS_EXIT_CODE } from "./exit-codes.ts";
import { createProgress, markOf, nextStepsText, paint, terminalStyle, timeText, type ProgressStream, type TerminalStyle, type Timers } from "./terminal.ts";

/**
 * A tool's checks, such as a doctor or a self-check, declared once: progress while they run, the verdict first and the
 * results grouped for a person, the same facts as `--json` for an agent, the time taken and the exit code. A problem
 * comes with its fix: the exact command, or the thing to do by hand, and never a developer command or a repository
 * path (ax-dev-commands) unless the fix is marked `sourceCheckout: true`.
 *
 * @claim "never a developer command or a repository path" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::a fix or next step that asks for a developer command throws, unless it is marked sourceCheckout)
 */
type CheckFix = NextStep | { byHand: string; sourceCheckout?: true };

/** The version of the report's shape; `--json` carries it as `ax`, as an outcome or a wait does. */
const CHECKS_VERSION = "checks/1";

/** `errored` is a check that threw before finishing, so the tool broke rather than found something. */
type CheckState = "passed" | "warned" | "failed" | "errored" | "skipped";

/**
 * What a check found. A warning or a failure carries its fix; a check that was not run says why, and `kind` names what
 * it waits on, read after a count ("waiting on something you name", "by hand"), so the not-run line groups them.
 */
type CheckResult =
  | { state: "passed"; detail?: string }
  | { state: "warned" | "failed"; detail: string; fix: CheckFix }
  | { state: "skipped"; detail: string; kind?: string; fix?: CheckFix };

interface CheckDef<C> {
  /** Stable, for `--json` and `needs`. */
  id: string;
  /**
   * What it checks, in words a person reads, named so it reads after "failed:": "Send a picture" or "Cache freshness",
   * not `send_picture` or "The cache is fresh".
   */
  label: string;
  /** Checks that must pass (or warn) first; when one didn't, this one is not run and says which to fix first. */
  needs?: readonly string[];
  run(context: C): CheckResult | Promise<CheckResult>;
}

interface ChecksDef<C> {
  /** The command a person runs, as in `app doctor`: the `--verbose` hint uses it, and a fix may not be it. */
  command: string;
  /** What one check is called in the verdict, singular and plural. Default `["check", "checks"]`. */
  noun?: readonly [string, string];
  checks: readonly CheckDef<C>[];
}

type Verdict = "passed" | "warned" | "failed" | "errored";

interface CheckRow {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  fix: CheckFix | null;
  kind: string | null;
  durationMs: number;
}

/** One run's facts, the same for the person's text and the agent's `--json`. */
interface ChecksReport {
  ax: typeof CHECKS_VERSION;
  verdict: Verdict;
  summary: string;
  durationMs: number;
  counts: Record<CheckState, number>;
  rows: CheckRow[];
  next: NextStep[];
  exitCode: number;
}

interface ChecksRunOptions {
  /** Where progress goes, normally `process.stderr`; leave it out, or pass `off`, to show nothing. */
  progress?: ProgressStream;
  env?: Readonly<Record<string, string | undefined>>;
  /** Turn progress off, as under `--json` or `--quiet`. */
  off?: boolean;
  timers?: Timers;
  /** Steps to offer after the fixes, such as running the checks that need something the person names. */
  next?: readonly NextStep[];
}

interface Checks<C> {
  readonly def: ChecksDef<C>;
  /** Runs the checks in order, with progress for a slow one, and reports. */
  run(context: C, options?: ChecksRunOptions): Promise<ChecksReport>;
}

const isCommandFix = (fix: CheckFix): fix is NextStep => "command" in fix;

/**
 * Declares a tool's checks once: from this one definition come the progress while they run, the verdict and the
 * grouped results for a person, the `--json` for an agent, the timing and the exit code. Throws at definition time on
 * an empty list, a repeated id, an empty label or a `needs` that names no earlier check, and at run time when a warning or failure
 * has no fix, or its fix is the command just run, so a tool's own tests catch both. A fix or a next step that asks for
 * a developer command or a repository path throws too, so a doctor never tells a person to run a repository script.
 *
 * @claim "an empty list, a repeated id, an empty label or a `needs` that names no earlier check" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::defineChecks refuses an empty list, a repeated id, an empty label and a needs that names no earlier check)
 * @claim "at run time when a warning or failure has no fix, or its fix is the command just run" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::a warning or failure without a fix, or with the command just run as its fix, fails the run)
 * @claim "A fix or a next step that asks for a developer command or a repository path throws too" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::a fix or next step that asks for a developer command throws, unless it is marked sourceCheckout)
 * @example
 * const doctor = defineChecks({
 *   command: "notes doctor",
 *   checks: [
 *     { id: "store", label: "Notes file", run: () => ({ state: "passed" }) },
 *     { id: "sync", label: "Last sync", needs: ["store"], run: () => ({ state: "warned", detail: "last synced 3 days ago", fix: { command: "notes sync", why: "Sync now" } }) },
 *   ],
 * });
 * const report = await doctor.run(context, { progress: process.stderr, env: process.env });
 */
function defineChecks<C>(def: ChecksDef<C>): Checks<C> {
  if (!def.checks.length) throw new Error(`defineChecks: ${def.command} declares no checks. Fix: declare the checks it runs.`);
  const seen = new Set<string>();
  for (const check of def.checks) {
    if (seen.has(check.id)) throw new Error(`defineChecks: the id ${check.id} is used twice. Fix: give each check its own id.`);
    if (!check.label.trim()) throw new Error(`defineChecks: ${check.id} has no label. Fix: name what it checks, in words a person reads.`);
    for (const need of check.needs ?? []) if (!seen.has(need)) throw new Error(`defineChecks: ${check.id} needs ${need}, which is not an earlier check. Fix: list ${need} before ${check.id}.`);
    seen.add(check.id);
  }
  return Object.freeze({ def, run: (context: C, options: ChecksRunOptions = {}) => runChecks(def, context, options) });
}

const wallClock = (): Pick<Timers, "now"> => ({ now: () => Date.now() });

/**
 * The exit code for a verdict: 0 when nothing failed, warnings included; the declared `findings` code when a check
 * found a problem; and the base `error` code when a check threw before finishing, since then the tool broke.
 *
 * @claim "the declared `findings` code when a check found a problem" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::findings exit with the declared findings code and a check that couldn't run exits 1, never the same code)
 */
const EXITS: Readonly<Record<Verdict, number>> = Object.freeze({ passed: 0, warned: 0, failed: FINDINGS_EXIT_CODE.code, errored: BASE_EXIT_CODES[1]!.code });

/** What a row records: a check's result, or what it threw. */
type RowResult = CheckResult | { state: "errored"; detail: string; fix: CheckFix };

async function runChecks<C>(def: ChecksDef<C>, context: C, options: ChecksRunOptions): Promise<ChecksReport> {
  const clock = options.timers ?? wallClock();
  const progress = options.progress
    ? createProgress(options.progress, { env: options.env ?? {}, off: options.off ?? false, ...(options.timers ? { timers: options.timers } : {}) })
    : null;
  const began = clock.now();
  const rows: CheckRow[] = [];
  const byId = new Map<string, CheckRow>();
  try {
    for (const [i, check] of def.checks.entries()) {
      const unmet = (check.needs ?? []).map((id) => byId.get(id)!).find((r) => r.state !== "passed" && r.state !== "warned");
      const why = { skipped: "was not run", errored: "threw before finishing", failed: "failed" } as const;
      let result: RowResult;
      const start = clock.now();
      if (unmet) {
        result = { state: "skipped", detail: `not checked: ${unmet.label} ${why[unmet.state as keyof typeof why]}`, kind: "after an earlier problem" };
      } else {
        progress?.start(check.label, { index: i + 1, total: def.checks.length });
        try {
          result = await check.run(context);
        } catch (error) {
          result = {
            state: "errored",
            detail: error instanceof Error ? error.message : String(error),
            fix: { byHand: "Report this error to the tool's maintainers; the check itself broke." },
          };
        } finally {
          progress?.stop();
        }
      }
      const row = rowOf(def, check, result, clock.now() - start);
      rows.push(row);
      byId.set(check.id, row);
    }
  } finally {
    progress?.stop();
  }
  const durationMs = clock.now() - began;
  const counts: Record<CheckState, number> = { passed: 0, warned: 0, failed: 0, errored: 0, skipped: 0 };
  for (const r of rows) counts[r.state]++;
  const verdict: Verdict = counts.errored ? "errored" : counts.failed ? "failed" : counts.warned ? "warned" : "passed";
  const problems = rows.filter((r) => r.state === "failed" || r.state === "warned" || r.state === "errored");
  const fixes = problems.flatMap((r) => (isCommandFix(r.fix!) ? [r.fix as NextStep] : []));
  const again = problems.length ? [{ command: def.command, why: "Check again once it's fixed" }] : [];
  const dev = devCommandsIn(options.next ?? [])[0];
  if (dev) throw new Error(`${def.command}: the next step \`${dev.text}\` asks for ${dev.match}, which only works in a source checkout. Fix: name the command the installed tool runs, or mark the step sourceCheckout: true.`);
  const next = [...fixes, ...(options.next ?? []), ...again].filter((s, i, all) => all.findIndex((t) => t.command === s.command) === i);
  return { ax: CHECKS_VERSION, verdict, summary: summaryOf(def, rows, counts, verdict, durationMs), durationMs, counts, rows, next, exitCode: EXITS[verdict] };
}

function rowOf<C>(def: ChecksDef<C>, check: CheckDef<C>, result: RowResult, durationMs: number): CheckRow {
  const fix = "fix" in result && result.fix ? result.fix : null;
  if ((result.state === "failed" || result.state === "warned") && !fix) {
    throw new Error(`${def.command}: ${check.id} ${result.state} without a fix. Fix: give it the command that fixes it, or { byHand } when no command can.`);
  }
  if (fix && isCommandFix(fix) && fix.command.trim() === def.command.trim()) {
    throw new Error(`${def.command}: ${check.id}'s fix is \`${def.command}\`, the command just run. Fix: name the command that changes something.`);
  }
  const dev = devCommandsIn(fix)[0];
  if (dev) throw new Error(`${def.command}: ${check.id}'s fix \`${dev.text}\` asks for ${dev.match}, which only works in a source checkout. Fix: name the command the installed tool runs, or mark the fix sourceCheckout: true.`);
  return { id: check.id, label: check.label, state: result.state, detail: result.detail ?? "", fix, kind: result.state === "skipped" ? (result.kind ?? null) : null, durationMs };
}

/** A check that ran this long shows its time beside it without `verbose`. */
const SLOW_MS = 1000;

const plural = (n: number, [one, many]: readonly [string, string]) => `${n} ${n === 1 ? one : many}`;

/** The first labels, then how many more. */
const someOf = (labels: readonly string[]) => (labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : labels.join(", "));

/** How long the run took, for the verdict: "under 0.1s" rather than "0.0s". */
const tookText = (ms: number) => (ms < 100 ? "under 0.1s" : timeText(ms));

function summaryOf<C>(def: ChecksDef<C>, rows: readonly CheckRow[], counts: Record<CheckState, number>, verdict: Verdict, ms: number): string {
  const noun = def.noun ?? ["check", "checks"];
  const all = plural(rows.length, noun);
  const took = tookText(ms);
  const labels = (state: CheckState) => someOf(rows.filter((r) => r.state === state).map((r) => r.label));
  const notRun = counts.skipped ? `, ${counts.skipped} not run` : "";
  const warned = counts.warned ? `, ${counts.warned} warned` : "";
  const failed = counts.failed ? `, ${counts.failed} failed` : "";
  const says = { failed: "failed", warned: "needs a look", errored: "threw before finishing" } as const;
  if (rows.length === 1 && verdict !== "passed") return `The ${noun[0]} ${says[verdict]}: ${labels(verdict)}, in ${took}.`;
  if (verdict === "errored") return `${counts.errored} of ${all} threw before finishing: ${labels("errored")}. ${counts.passed} passed${failed}${warned}${notRun}, in ${took}.`;
  if (verdict === "failed") return `${counts.failed} of ${all} failed: ${labels("failed")}. ${counts.passed} passed${warned}${notRun}, in ${took}.`;
  if (verdict === "warned") return `${counts.warned} of ${all} ${counts.warned === 1 ? "needs" : "need"} a look: ${labels("warned")}. ${counts.passed} passed${notRun}, in ${took}.`;
  if (!counts.passed) return `${rows.length === 1 ? `The ${noun[0]} was not run` : `None of the ${plural(rows.length, noun)} were run`}, in ${took}.`;
  if (counts.skipped) return `${counts.passed} of ${all} passed${notRun}, in ${took}.`;
  return `${rows.length === 1 ? `The ${noun[0]}` : rows.length === 2 ? `Both ${noun[1]}` : `All ${all}`} passed in ${took}.`;
}

/** What the checks not run wait on, the bigger groups first, or "" when they don't say. */
function notRunLine(rows: readonly CheckRow[]): string {
  const kinds = new Map<string, number>();
  for (const r of rows) if (r.state === "skipped" && r.kind) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const groups = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${kind}`);
  return groups.length ? `Not run: ${groups.join(", ")}` : "";
}

/**
 * A fix under its row: the reason, then the command alone on its line so it can be copied whole; or the step by hand.
 * A check not run says how to run it, without the word "Fix", since nothing broke.
 */
function fixLines(fix: CheckFix, style: TerminalStyle, broke: boolean): string[] {
  const lead = broke ? "Fix: " : "";
  return isCommandFix(fix) ? [`${lead}${fix.why}`, `  ${paint(style).cyan(fix.command)}`] : [`${lead}${fix.byHand}`];
}

/**
 * The report for a person: the verdict on the first line, then the results grouped (what failed, what warned, what
 * was not run, and what passed with `verbose`), each problem with its fix, then the next steps. On success it prints
 * the verdict and what is left to act on, and with `verbose` every check and its time. Off a terminal the marks are
 * words and there is no colour, so the first line reads `FAIL 1 of 12 checks failed: …`.
 *
 * @claim "the verdict on the first line" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::the text puts the verdict first, then failures with their fixes, warnings, what was not run, and the next steps)
 * @claim "On success it prints the verdict and what is left to act on" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::quiet on success: the verdict alone, and every check with its time under --verbose)
 * @claim "Off a terminal the marks are words and there is no colour" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::off a terminal the report is in words, and under NO_COLOR it has no escape codes)
 */
function checksText(report: ChecksReport, style: TerminalStyle, options: { verbose?: boolean; command?: string } = {}): string {
  const p = paint(style);
  const time = (r: CheckRow) => (r.durationMs >= SLOW_MS || (options.verbose && r.durationMs >= 100) ? `  ${p.dim(timeText(r.durationMs))}` : "");
  const lead = report.verdict === "passed" && !report.counts.passed ? "skipped" : report.verdict;
  const out: string[] = [`${markOf(lead, style)} ${p.bold(report.summary)}`];
  const waits = options.verbose || report.rows.every((r) => r.state !== "skipped" || r.fix) ? "" : notRunLine(report.rows);
  if (waits) out.push(`  ${waits}`);
  const section = (title: string, rows: readonly CheckRow[], body: (r: CheckRow) => string[]) => {
    if (!rows.length) return;
    out.push("", p.bold(title), ...rows.flatMap((r) => [`  ${markOf(r.state, style)} ${r.label}${time(r)}`, ...body(r).map((l) => `    ${l}`)]));
  };
  const problem = (r: CheckRow) => [...(r.detail ? [r.detail] : []), ...(r.fix ? fixLines(r.fix, style, r.state !== "skipped") : [])];
  section("Threw before finishing", report.rows.filter((r) => r.state === "errored"), problem);
  section("Found a problem", report.rows.filter((r) => r.state === "failed"), problem);
  section("Warnings", report.rows.filter((r) => r.state === "warned"), problem);
  const skipped = report.rows.filter((r) => r.state === "skipped");
  section("Still to check", options.verbose ? skipped : skipped.filter((r) => r.fix), problem);
  if (options.verbose) section("Passed", report.rows.filter((r) => r.state === "passed"), (r) => (r.detail ? [p.dim(r.detail)] : []));
  const hidden = skipped.some((r) => !r.fix) || (report.verdict !== "passed" && report.counts.passed > 0);
  const hint = !options.verbose && options.command && hidden ? [{ command: `${options.command} --verbose`, why: "See every check" }] : [];
  const shown = new Set(report.rows.flatMap((r) => (r.fix && isCommandFix(r.fix) ? [r.fix.command] : [])));
  const next = [...report.next.filter((s) => !shown.has(s.command)), ...hint];
  const steps = nextStepsText(next, style);
  if (steps) out.push("", steps);
  return out.join("\n");
}

/** Whether a value is a checks report: what the X-ray looks for in a read's `--json`. */
function isChecksReport(value: unknown): value is ChecksReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["ax"] === CHECKS_VERSION && typeof v["verdict"] === "string" && typeof v["summary"] === "string" && typeof v["counts"] === "object" && Array.isArray(v["rows"]);
}

/**
 * Prints a report the way the kit's commands print a result: `--json` as one JSON document, otherwise the text for the
 * stream it goes to, each with one trailing newline. Returns the exit code.
 *
 * @claim "each with one trailing newline" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::printChecks writes the JSON or the text with one trailing newline, and returns the exit code)
 * @claim "Returns the exit code" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::printChecks writes the JSON or the text with one trailing newline, and returns the exit code)
 */
function printChecks(
  report: ChecksReport,
  io: { stdout: { write(s: string): unknown; isTTY?: boolean }; env: Readonly<Record<string, string | undefined>> },
  options: { json?: boolean; verbose?: boolean; command?: string } = {},
): number {
  io.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${checksText(report, terminalStyle(io.stdout, io.env), options)}\n`);
  return report.exitCode;
}
