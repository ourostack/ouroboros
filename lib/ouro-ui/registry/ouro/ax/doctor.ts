export { agoText, DOCTOR_VERSION, doctorReport, doctorText, isDoctorReport };
export type { DoctorReport, PartState, StateLine, StateSection };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { checksText, isChecksReport, type ChecksReport } from "./checks.ts";
import { paint, type TerminalStyle } from "./terminal.ts";

/**
 * A doctor: a tool's checks (ax-checks) with the state they judged, so a person and an agent read the same facts. It
 * says what runs and since when, the versions and the last attempts, then what is wrong and the command that fixes it.
 * `DoctorReport` is a checks report with `doctor`, `at` and `state` added, so whatever reads a checks report reads it.
 *
 * @claim "so whatever reads a checks report reads it" registry/ouro/ax/doctor.test.mts verify:testExists(registry/ouro/ax/doctor.test.mts::a doctor report is the checks report with the state it judged, and still a checks report)
 * @example
 * const report = doctorReport(await checks.run(facts), [{ id: "processes", label: "Processes", lines: [{ label: "Service", value: "up", state: "up", since: startedAt }] }], Date.now());
 * stdout.write(json ? JSON.stringify(report) : doctorText(report, terminalStyle(stdout, env), { command: "notes doctor" }));
 * process.exitCode = report.exitCode;
 */
type PartState = "up" | "starting" | "stuck" | "down" | "absent";

/** The version of the doctor's shape; `--json` carries it as `doctor`, beside the checks' `ax`. */
const DOCTOR_VERSION = "doctor/1";

/** One fact: what it is, its value in words, and since when it has held (ms since the epoch) when that is known. */
interface StateLine {
  label: string;
  value: string;
  since?: number | null;
  /** A part's state, when the line is about one: up, starting, stuck (there and not answering), down or absent. */
  state?: PartState;
}

/** A group of facts under one heading: "Versions", "Processes", "Sign-in". */
interface StateSection {
  id: string;
  label: string;
  lines: StateLine[];
}

/** The checks' report, with the doctor's version, when it looked and what it saw. */
interface DoctorReport extends ChecksReport {
  doctor: typeof DOCTOR_VERSION;
  at: number;
  state: StateSection[];
}

/**
 * The checks' report with what the doctor saw and when it looked. Its exit code is the checks' own.
 *
 * @claim "Its exit code is the checks' own" registry/ouro/ax/doctor.test.mts verify:testExists(registry/ouro/ax/doctor.test.mts::a doctor report is the checks report with the state it judged, and still a checks report)
 * @example
 * const report = doctorReport(await checks.run(facts), state(facts), Date.now());
 */
function doctorReport(checks: ChecksReport, state: StateSection[], at: number): DoctorReport {
  return { ...checks, doctor: DOCTOR_VERSION, at, state };
}

/**
 * Whether a value is a doctor report, such as the answer of an app's own doctor endpoint, with sections and lines
 * `doctorText` can print.
 *
 * @claim "with sections and lines `doctorText` can print" registry/ouro/ax/doctor.test.mts verify:testExists(registry/ouro/ax/doctor.test.mts::a doctor report is the checks report with the state it judged, and still a checks report)
 * @example
 * const asked = await probeHttp(`${serviceUrl}/api/doctor`);
 * if (asked.state === "up" && isDoctorReport(asked.body)) return asked.body;
 */
function isDoctorReport(value: unknown): value is DoctorReport {
  if (!isChecksReport(value)) return false;
  const v = value as Partial<DoctorReport>;
  return v.doctor === DOCTOR_VERSION && typeof v.at === "number" && Array.isArray(v.state) && v.state.every(isSection);
}

/** A field of a value that may not be an object: undefined when it isn't one. */
const field = (v: unknown, key: string): unknown => (v as Record<string, unknown> | null | undefined)?.[key];

/** A section `doctorText` can print: a label, and lines with a label and a value in words. */
function isSection(s: unknown): boolean {
  const lines = field(s, "lines");
  return typeof field(s, "label") === "string" && Array.isArray(lines) && lines.every((l) => typeof field(l, "label") === "string" && typeof field(l, "value") === "string");
}

/**
 * How long ago, in a person's words: "just now", "40 s ago", "12 min ago", "3 h ago", "2 days ago". A time after `now`
 * reads as "just now".
 *
 * @claim "A time after `now` reads as" registry/ouro/ax/doctor.test.mts verify:testExists(registry/ouro/ax/doctor.test.mts::agoText says how long ago in a person's words, at each step's edges)
 * @example
 * agoText(Date.now() - 12 * 60_000, Date.now()); // "12 min ago"
 */
function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 120) return `${s} s ago`;
  if (s < 120 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** A state line as a person reads it: "Engine  up, since 12 min ago", stuck and down in red, starting in yellow. */
function lineText(line: StateLine, now: number, width: number, style: TerminalStyle): string {
  const p = paint(style);
  const tint = line.state === "stuck" || line.state === "down" ? p.red : line.state === "starting" ? p.yellow : (s: string) => s;
  const since = line.since != null ? p.dim(`, since ${agoText(line.since, now)}`) : "";
  return `  ${line.label.padEnd(width)}  ${tint(line.value)}${since}`;
}

/**
 * The report for a person: the checks' verdict on the first line (with the line under it that says what was not run),
 * then what the doctor saw, section by section, then the problems, their fixes and the next steps, as `checksText`
 * prints them. A section with no lines is left out.
 *
 * @claim "the checks' verdict on the first line" registry/ouro/ax/doctor.test.mts verify:testExists(registry/ouro/ax/doctor.test.mts::the text leads with the verdict, then the state by section, then the problems and their fixes)
 * @claim "A section with no lines is left out" registry/ouro/ax/doctor.test.mts verify:testExists(registry/ouro/ax/doctor.test.mts::the text leads with the verdict, then the state by section, then the problems and their fixes)
 * @example
 * stdout.write(`${doctorText(report, terminalStyle(stdout, env), { command: "notes doctor", verbose })}\n`);
 */
function doctorText(report: DoctorReport, style: TerminalStyle, options: { verbose?: boolean; command?: string } = {}): string {
  const p = paint(style);
  const lines = checksText(report, style, options).split("\n");
  const head = lines.indexOf("") === -1 ? lines.length : lines.indexOf("");
  const width = Math.max(0, ...report.state.flatMap((s) => s.lines.map((l) => l.label.length)));
  const state = report.state.filter((s) => s.lines.length).flatMap((s) => ["", p.bold(s.label), ...s.lines.map((l) => lineText(l, report.at, width, style))]);
  return [...lines.slice(0, head), ...state, ...lines.slice(head)].join("\n");
}
