export { at, checkCall, defineFlow, defineSuite, inProcess, listedCommands, main, matches, report, runFlows, runSuite, spawned, unlisted };
export type { Driver, Expect, Finding, Flow, FlowReport, FlowSuite, Harness, HarnessStep, Match, Mock, Ran, RequestStep, Rubric, RunStep, Step, StderrRule };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { quietPipes, runCli, type CliIo } from "./cli.ts";
import { defineCli, defineCommand, type Cli, type CommandDef, type FlagSpec, type Input } from "./command.ts";
import { outcome, type Outcome } from "./outcome.ts";
import { AxError, commandLine } from "./problem.ts";

/**
 * An adopter's agent flows as data, run in CI without a model: a flow is the calls a good agent makes for one task, and
 * the runner checks the calls' exit codes, JSON shapes and fields, error text, time, size and voice. The findings are in
 * the `flow-review/0` format (`findings.jsonl`, one check a line, and `report.json`), with an X-ray report attached when
 * given. The X-ray checks what every command must do; flows check what a task needs, and each finds what the other can't.
 *
 *   node lib/ouro/ax/flows.ts run <suite module> [--out report] [--flows a,b] [--slack n] [--xray report.json]
 *
 * @claim "each finds what the other can't" docs/decisions/2026-10-30-ouro-ax/evidence/agent-flow-review.md verify:fileLine(docs/decisions/2026-10-30-ouro-ax/evidence/agent-flow-review.md, /The same commit's X-ray called the CLI conformant/)
 */
type Rubric = "discoverable" | "predictable" | "honest" | "forgiving" | "fast" | "beautiful";

/** A value a JSON field must have: the value itself, a pattern (ignoring case), one of several values, or a type. */
type Match = string | number | boolean | null | { re: string } | { oneOf: readonly (string | number | boolean | null)[] } | { type: "string" | "number" | "boolean" | "array" | "object" | "null" };

/** Nothing on stderr ("empty"), or one line ("oneLine") that names what to do instead ("namesFix"), without a stack trace ("noStack"). */
type StderrRule = "empty" | "oneLine" | "namesFix" | "noStack";

interface Expect {
  /** The exit code (for a request, the HTTP status), or the codes any of which is right. */
  exit: number | readonly number[];
  /** Paths that must exist in stdout's JSON: `a.b`, `a[0]`, `a[-1]` (the last), `a[].b` (fans out over the list), `a[title~^Weekly]` (the elements whose field matches), `a.length`. */
  jsonShape?: readonly string[];
  /** Path to the value it must have; a path through `[]` passes when one element matches. */
  fields?: Readonly<Record<string, Match>>;
  stderrRules?: readonly StderrRule[];
  /** A time budget in milliseconds, multiplied by the run's slack. */
  maxMs?: number;
  /** An output budget: stdout and stderr together, in bytes. */
  maxBytes?: number;
  /** Patterns the output (stdout and stderr) must have, and must not. */
  text?: { has?: readonly string[]; not?: readonly string[] };
}

interface StepBase {
  id: string;
  expect: Expect;
  /** Values to keep from this step's JSON for later steps' `{name}`: name to path. */
  save?: Readonly<Record<string, string>>;
  /** The fix to report with this step's failing checks. */
  fix?: string;
  /** A defect still open, with its issue: its failures are reported, not fatal; once it passes, the run fails until `known` goes. */
  known?: string;
}
/** A call to the CLI: the words after the tool's name; `{name}` is a saved value. */
interface RunStep extends StepBase {
  run: readonly string[];
}
/** A request to the mock's HTTP API; `exit` is the status. */
interface RequestStep extends StepBase {
  request: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown };
}
/** A request to the mock's control port, such as a reply arriving; it is set-up, not checked. */
interface Harness {
  path: string;
  body?: unknown;
}
interface HarnessStep {
  id: string;
  harness: Harness;
}
type Step = RunStep | RequestStep | HarnessStep;

interface Flow {
  id: string;
  surface: "agent-cli" | "agent-http";
  title: string;
  steps: readonly Step[];
  rubric: readonly Rubric[];
  /** Where the flow comes from: a task, an issue, a person's week. */
  source?: string;
  /** The flow only reads: the suite's state read must not change across it (`reads-stay-reads`). */
  readOnly?: boolean;
  /** Environment for this flow's calls, such as the name the host gives the agent. */
  env?: Readonly<Record<string, string>>;
  /** Known defects of the flow's own checks (`discoverable.listed`, `reads-stay-reads`): check to issue. */
  known?: Readonly<Record<string, string>>;
}

/** One check's result: one line of findings.jsonl (`flow-review/0`). */
interface Finding {
  flow: string;
  step: string;
  surface: Flow["surface"];
  cell: null;
  check: string;
  pass: boolean;
  measured?: unknown;
  threshold?: unknown;
  selector?: string;
  evidence?: string;
  fix?: string;
  ms: number;
  rubric?: Rubric;
  known?: string;
}

/** What a call gave: its exit code (or HTTP status), stdout, stderr and how long it took. */
interface Ran {
  code: number;
  out: string;
  err: string;
  ms: number;
}

/** Calls the CLI with the words after its name and the environment for the call. */
type Driver = (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<Ran>;

/** A started mock: where its API and control port are, what the CLI's calls need in their environment, and how to stop it. */
interface Mock {
  /** The API's base URL, for `request` steps. */
  url?: string;
  /** The control port's base URL, for `harness` steps. */
  control?: string;
  /** Environment for the calls, such as the URL the CLI talks to. */
  env?: Readonly<Record<string, string>>;
  /** Values the flows start with for `{name}`, besides `{dir}` (the run's work folder). */
  vars?: Readonly<Record<string, string>>;
  stop(): void | Promise<void>;
}

/** An adopter's flows and how to run them. */
interface FlowSuite {
  /** The CLI's name, as its errors and fixes print it. */
  tool: string;
  flows: readonly Flow[];
  cli: Driver;
  /** Starts the mock the flows run against, in a work folder of its own. */
  start(dir: string): Promise<Mock>;
  /**
   * Throws unless the started mock is a mock, the way the X-ray proves one: nothing runs until it passes, so no flow can
   * act on anything real.
   *
   * @claim "nothing runs until it passes" registry/ouro/ax/flows.test.mts verify:testExists(registry/ouro/ax/flows.test.mts::nothing runs until the suite's guard passes)
   */
  guard(mock: Mock): void | Promise<void>;
  /** The words of a read whose answer is the state, for `reads-stay-reads` (`log --json`). */
  state?: readonly string[];
  /** Names that must not reach output, such as a brand's characters (`voice.no-brand-names`). */
  brandNames?: readonly string[];
}

function defineFlow<T extends Flow>(flow: T): T {
  return flow;
}

function defineSuite<T extends FlowSuite>(suite: T): T {
  return suite;
}

/**
 * A driver that runs the tool's own entry in this process (fast): `main(argv, { stdout, stderr, env })` returns the exit
 * code. stderr's `write` calls its callback, so a tool that waits for an announcement to flush before acting goes on.
 */
function inProcess(main: (argv: string[], io: { stdout: { write(s: string): boolean }; stderr: { write(s: string, done?: (error?: Error | null) => void): boolean }; env: Record<string, string> }) => Promise<number> | number): Driver {
  return async (argv, env) => {
    let out = "";
    let err = "";
    const started = performance.now();
    const code = await main([...argv], {
      stdout: { write: (s) => ((out += s), true) },
      stderr: {
        write: (s, done) => {
          err += s;
          done?.();
          return true;
        },
      },
      env: { ...env },
    });
    return { code, out, err, ms: Math.round(performance.now() - started) };
  };
}

/** A driver that runs a built or installed CLI as its own process: the command's words, then the step's. */
function spawned(command: readonly string[], timeoutMs: number = 30_000): Driver {
  return (argv, env) =>
    new Promise((done) => {
      const started = performance.now();
      const child = spawn(command[0]!, [...command.slice(1), ...argv], { env: { PATH: String(process.env["PATH"]), ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d: Buffer) => (out += String(d)));
      child.stderr.on("data", (d: Buffer) => (err += String(d)));
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? -1, out, err, ms: Math.round(performance.now() - started) });
      });
    });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The values at a path, and whether the path fanned out over an array (`[]` or a filter). */
function at(doc: unknown, path: string): { values: unknown[]; fan: boolean } {
  let values: unknown[] = [doc];
  let fan = false;
  const field = (v: unknown, k: string) => (Array.isArray(v) ? (k === "length" ? v.length : undefined) : isObject(v) ? v[k] : undefined);
  for (const part of path.split(/\.(?![^[]*\])/).filter(Boolean)) {
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!m) return { values: [], fan };
    if (m[1]) values = values.map((v) => field(v, m[1]!));
    for (const index of m[2]!.match(/\[[^\]]*\]/g) ?? []) {
      const n = index.slice(1, -1);
      const filter = /^(\w+)~(.*)$/.exec(n);
      if (n === "") {
        fan = true;
        values = values.flatMap((v) => (Array.isArray(v) ? v : [undefined]));
      } else if (filter) {
        fan = true;
        const re = new RegExp(filter[2]!, "i");
        values = values.flatMap((v) => (Array.isArray(v) ? v.filter((x) => re.test(String(field(x, filter[1]!) ?? ""))) : []));
      } else values = values.map((v) => (Array.isArray(v) ? v.at(Number(n)) : undefined));
    }
  }
  return { values, fan };
}

function matches(value: unknown, m: Match): boolean {
  if (m === null || typeof m !== "object") return value === m;
  if ("re" in m) return typeof value === "string" && new RegExp(m.re, "i").test(value);
  if ("oneOf" in m) return m.oneOf.some((x) => x === value);
  return (value === null ? "null" : Array.isArray(value) ? "array" : typeof value) === m.type;
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstLines = (s: string, n = 3) => s.split("\n").filter((l) => l.trim()).slice(0, n).join(" ⏎ ");
const parsed = (s: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};

/**
 * The findings for one call: one per check its `expect` declares, then the voice checks every CLI call gets: stderr
 * stays plain (no "I", exclamation or emoji outside quotes), JSON alone under `--json`, and no brand name the suite
 * forbids. A path through `why`, `by`, `agent`, `audience` or `who` is an honesty check.
 *
 * @claim "the voice checks every CLI call gets" registry/ouro/ax/flows.test.mts verify:testExists(registry/ouro/ax/flows.test.mts::a call's checks: exit, shape, fields, error text, time, size, text and voice, each its own finding)
 */
function checkCall(flow: Pick<Flow, "id" | "surface">, step: Pick<RunStep, "id" | "expect" | "fix" | "known">, ran: Ran, options: { tool: string; slack?: number; argv?: readonly string[]; brandNames?: readonly string[] }): Finding[] {
  const e = step.expect;
  const found: Finding[] = [];
  const add = (check: string, rubric: Rubric, pass: boolean, extra: Partial<Finding> = {}) => {
    const { fix: suggested, ...rest } = extra;
    const fix = pass ? undefined : (step.fix ?? suggested);
    found.push({ flow: flow.id, step: step.id, surface: flow.surface, cell: null, check, pass, ms: ran.ms, rubric, ...rest, ...(fix === undefined ? {} : { fix }), ...(step.known ? { known: step.known } : {}) });
  };
  const both = `${ran.out}${ran.err}`;
  const exits: readonly number[] = typeof e.exit === "number" ? [e.exit] : e.exit;
  const exitOk = exits.includes(ran.code);
  add("exit", "predictable", exitOk, { measured: ran.code, threshold: e.exit, ...(exitOk ? {} : { evidence: clip(firstLines(ran.err || ran.out)) }) });
  if (e.jsonShape || e.fields) {
    const j = parsed(ran.out);
    if (!j.ok) add("json", "predictable", false, { evidence: clip(firstLines(ran.out || ran.err)), fix: "print exactly one JSON document with --json" });
    else {
      for (const p of e.jsonShape ?? []) {
        const { values } = at(j.value, p);
        const pass = values.length > 0 && values.every((v) => v !== undefined);
        add("json-shape", "predictable", pass, { selector: p, ...(pass ? {} : { measured: values.length ? "missing" : "empty" }) });
      }
      for (const [p, m] of Object.entries(e.fields ?? {})) {
        const { values, fan } = at(j.value, p);
        const pass = fan ? values.some((v) => matches(v, m)) : values.length === 1 && matches(values[0], m);
        add("fields", /\b(why|agent|by|actor|audience|who)\b/i.test(p) ? "honest" : "predictable", pass, { selector: p, threshold: m, measured: fan ? `${values.length} values` : values[0] });
      }
    }
  }
  const errLines = ran.err.split("\n").filter((l) => l.trim());
  const namesFix = new RegExp(`\\bFix: |\\b${options.tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [a-z]`);
  for (const rule of e.stderrRules ?? []) {
    const pass = rule === "empty" ? errLines.length === 0 : rule === "oneLine" ? errLines.length === 1 : rule === "namesFix" ? namesFix.test(ran.err) : !/^\s+at .+[:(]\d+/m.test(both);
    add(`stderr.${rule}`, rule === "empty" ? "beautiful" : "forgiving", pass, { ...(rule === "oneLine" ? { measured: errLines.length } : {}), ...(pass ? {} : { evidence: clip(ran.err) }) });
  }
  if (e.maxMs !== undefined) add("max-ms", "fast", ran.ms <= e.maxMs * (options.slack ?? 1), { measured: ran.ms, threshold: e.maxMs * (options.slack ?? 1) });
  if (e.maxBytes !== undefined) {
    const bytes = new TextEncoder().encode(both).length;
    add("max-bytes", "fast", bytes <= e.maxBytes, { measured: bytes, threshold: e.maxBytes });
  }
  for (const has of e.text?.has ?? []) add("text.has", "beautiful", new RegExp(has, "m").test(both), { selector: has, evidence: clip(firstLines(both, 4)) });
  for (const not of e.text?.not ?? []) {
    const re = new RegExp(not, "m");
    const line = both.split("\n").find((l) => re.test(l));
    add("text.not", "beautiful", line === undefined, { selector: not, ...(line === undefined ? {} : { evidence: clip(line) }) });
  }
  if (options.argv) {
    // Quoted text is someone's words (an example, the agent's --why), not the tool's voice.
    const loud = errLines.find((l) => /\bI\b|!(\s|$)|\p{Extended_Pictographic}/u.test(l.replace(/"[^"]*"/g, "")));
    add("voice.plain-stderr", "beautiful", loud === undefined, loud === undefined ? {} : { evidence: clip(loud), fix: 'errors and notices on stderr are plain fact: no "I", no exclamation, no emoji' });
    if (options.argv.includes("--json") && !(e.jsonShape || e.fields)) {
      const ok = ran.out.trim() === "" || parsed(ran.out).ok;
      add("voice.json-only", "beautiful", ok, ok ? {} : { evidence: clip(firstLines(ran.out)), fix: "under --json, print the JSON document alone" });
    }
    if (options.brandNames?.length) {
      const re = new RegExp(`\\b(${options.brandNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
      const line = both.split("\n").find((l) => re.test(l));
      add("voice.no-brand-names", "beautiful", line === undefined, line === undefined ? {} : { evidence: clip(line), fix: 'say "you" (the agent) and "the person"' });
    }
  }
  return found.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as unknown as Finding);
}

/** The command words the overview lists: from `help --json` (the commands not hidden, with their aliases), else from `--help` text. */
function listedCommands(help: Ran, overview: Ran): Set<string> {
  const j = parsed(help.out);
  const commands = help.code === 0 && j.ok && isObject(j.value) && Array.isArray(j.value["commands"]) ? j.value["commands"].filter(isObject) : null;
  if (commands) return new Set(commands.filter((c) => c["hidden"] !== true).flatMap((c) => [String(c["name"]).split(" ")[0]!, ...(Array.isArray(c["aliases"]) ? c["aliases"].map(String) : [])]));
  return new Set(overview.out.split("\n").flatMap((l) => {
    const m = /^ {2,4}([a-z][\w-]*(?:, [a-z][\w-]*)*):? {2,}\S/.exec(l);
    return m ? m[1]!.split(", ") : [];
  }));
}

/** The command words a flow runs successfully that the overview does not list: an agent reading `--help` alone won't find them. */
function unlisted(flow: Flow, listed: ReadonlySet<string>): string[] {
  const words = new Set<string>();
  for (const s of flow.steps) {
    if (!("run" in s)) continue;
    const head = s.run[0];
    const exits: readonly number[] = typeof s.expect.exit === "number" ? [s.expect.exit] : s.expect.exit;
    if (head && /^[a-z]/.test(head) && head !== "help" && exits.includes(0)) words.add(head);
  }
  return [...words].filter((w) => !listed.has(w));
}

const fill = (s: string, vars: Readonly<Record<string, string>>) => s.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
}

/**
 * Runs the flows in order against one started mock and returns the findings. The suite's guard runs first, before any
 * call; a flow's `harness` steps set up what happens next, and its `save`d values fill later steps' `{name}`.
 */
async function runFlows(suite: FlowSuite, mock: Mock, options: { dir: string; slack?: number; flows?: readonly Flow[] }): Promise<Finding[]> {
  await suite.guard(mock);
  const flows = options.flows ?? suite.flows;
  const findings: Finding[] = [];
  const env = (flow: Flow) => ({ ...mock.env, ...flow.env });
  const listed = listedCommands(await suite.cli(["help", "--json"], { ...mock.env }), await suite.cli(["--help"], { ...mock.env }));
  const stateOf = async (flow: Flow) => {
    const r = await suite.cli(suite.state!, env(flow));
    const j = parsed(r.out);
    return r.code === 0 && j.ok ? JSON.stringify(j.value) : null;
  };
  for (const flow of flows) {
    const vars: Record<string, string> = { dir: options.dir, ...mock.vars };
    const knownOf = (check: string) => (flow.known?.[check] ? { known: flow.known[check] } : {});
    if (flow.surface === "agent-cli") {
      const missing = unlisted(flow, listed);
      findings.push({ flow: flow.id, step: "--help", surface: flow.surface, cell: null, check: "discoverable.listed", pass: missing.length === 0, ms: 0, rubric: "discoverable", ...(missing.length ? { measured: missing, evidence: `not in ${suite.tool} --help: ${missing.join(", ")}`, fix: `list ${missing.join(", ")} in the overview` } : {}), ...knownOf("discoverable.listed") });
    }
    const before = flow.readOnly && suite.state ? await stateOf(flow) : null;
    for (const step of flow.steps) {
      if ("harness" in step) {
        if (!mock.control) throw new Error(`${flow.id} ${step.id}: a harness step needs the mock's control port. Fix: return { control } from the suite's start().`);
        const r = await post(`${mock.control}${fill(step.harness.path, vars)}`, step.harness.body);
        if (!r.ok) throw new Error(`${flow.id} ${step.id}: the mock's control port answered ${r.status}: ${clip(await r.text(), 200)}`);
        continue;
      }
      let ran: Ran;
      if ("run" in step) ran = await suite.cli(step.run.map((a) => fill(a, vars)), env(flow));
      else {
        if (!mock.url) throw new Error(`${flow.id} ${step.id}: a request step needs the mock's API. Fix: return { url } from the suite's start().`);
        const started = performance.now();
        const { method, path, body } = step.request;
        const r = await fetch(`${mock.url}${fill(path, vars)}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
        ran = { code: r.status, out: await r.text(), err: "", ms: Math.round(performance.now() - started) };
      }
      findings.push(...checkCall(flow, step, ran, { tool: suite.tool, slack: options.slack ?? 1, ...("run" in step ? { argv: step.run } : {}), ...(suite.brandNames ? { brandNames: suite.brandNames } : {}) }));
      const j = parsed(ran.out);
      for (const [name, p] of Object.entries(step.save ?? {})) {
        const v = j.ok ? at(j.value, p).values[0] : undefined;
        if (v !== undefined && v !== null) vars[name] = String(v);
      }
    }
    if (flow.readOnly && suite.state) {
      const after = await stateOf(flow);
      findings.push({ flow: flow.id, step: "*", surface: flow.surface, cell: null, check: "reads-stay-reads", pass: before !== null && after === before, ms: 0, rubric: "honest", ...(before !== null && after === before ? {} : { evidence: before === null || after === null ? `${suite.state.join(" ")} gave no JSON` : `${suite.state.join(" ")} changed across a flow that only reads` }), ...knownOf("reads-stay-reads") });
    }
  }
  return findings;
}

interface FlowReport {
  schema: "flow-review-report/0";
  summary: {
    checks: number;
    pass: number;
    fail: number;
    /** Failures without a `known` issue: these fail the run. */
    unknownFail: number;
    /** Steps and flow checks marked `known` that pass now: their mark should go, and the run fails until it does. */
    knownPassing: { flow: string; step: string; known: string }[];
    flows: { flow: string; pass: boolean; checks: number; failed: number; known: number }[];
  };
  findings: Finding[];
  attachments: { kind: "ouro-ax-xray"; path: string; claimSetHash: string | null; checkerVersion: string | null; conformant: boolean | null }[];
}

/**
 * The `flow-review/0` report: a summary per flow, the findings, and the X-ray's report as an attachment. A step marked
 * `known` that passes is listed in `knownPassing`, so the mark is removed once the defect is fixed.
 *
 * @claim "A step marked `known` that passes" registry/ouro/ax/flows.test.mts verify:testExists(registry/ouro/ax/flows.test.mts::the report: per flow, unknown failures, a known defect that passes, and the X-ray attached)
 */
function report(findings: readonly Finding[], xray?: { path: string; doc: unknown }): FlowReport {
  const fail = findings.filter((f) => !f.pass);
  const groups = new Map<string, Finding[]>();
  for (const f of findings.filter((x) => x.known)) {
    const key = JSON.stringify([f.flow, f.step, f.known]);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const knownPassing = [...groups.values()].filter((fs) => fs.every((f) => f.pass)).map((fs) => ({ flow: fs[0]!.flow, step: fs[0]!.step, known: fs[0]!.known! }));
  const flows = [...new Set(findings.map((f) => f.flow))].map((id) => {
    const mine = findings.filter((f) => f.flow === id);
    const bad = mine.filter((f) => !f.pass);
    return { flow: id, pass: bad.length === 0, checks: mine.length, failed: bad.length, known: bad.filter((f) => f.known).length };
  });
  const doc = isObject(xray?.doc) ? xray.doc : {};
  const claimSet = isObject(doc["claimSet"]) ? doc["claimSet"] : {};
  const checker = isObject(doc["checker"]) ? doc["checker"] : {};
  return {
    schema: "flow-review-report/0",
    summary: { checks: findings.length, pass: findings.length - fail.length, fail: fail.length, unknownFail: fail.filter((f) => !f.known).length, knownPassing, flows },
    findings: [...findings],
    attachments: xray
      ? [{ kind: "ouro-ax-xray", path: xray.path, claimSetHash: typeof claimSet["hash"] === "string" ? claimSet["hash"] : null, checkerVersion: typeof checker["version"] === "string" ? checker["version"] : null, conformant: typeof doc["conformant"] === "boolean" ? doc["conformant"] : null }]
      : [],
  };
}

/** Starts the suite's mock in `<out>/work`, runs the flows, writes `findings.jsonl` and `report.json` to `out`, and stops the mock. */
async function runSuite(suite: FlowSuite, options: { out: string; only?: readonly string[]; slack?: number; xray?: string }): Promise<FlowReport> {
  const work = join(options.out, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const mock = await suite.start(work);
  try {
    const flows = options.only ? suite.flows.filter((f) => options.only!.includes(f.id)) : suite.flows;
    const findings = await runFlows(suite, mock, { dir: work, flows, ...(options.slack === undefined ? {} : { slack: options.slack }) });
    writeFileSync(join(options.out, "findings.jsonl"), findings.map((f) => `${JSON.stringify(f)}\n`).join(""));
    const r = report(findings, options.xray ? { path: options.xray, doc: JSON.parse(readFileSync(options.xray, "utf8")) as unknown } : undefined);
    writeFileSync(join(options.out, "report.json"), `${JSON.stringify(r, null, 2)}\n`);
    return r;
  } finally {
    await mock.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

const ABOUT = [
  "ax-flows runs an adopter's agent flows against its mock and writes the flow-review/0 findings and report.",
  "The suite module default-exports defineSuite({ tool, flows, cli, start, guard, state?, brandNames? }).",
];

const FLOW_FLAGS: Readonly<Record<string, FlagSpec>> = Object.freeze({
  out: { type: "string", placeholder: "<dir>", description: "Where findings.jsonl and report.json go (default: report)." },
  flows: { type: "list", placeholder: "<a,b>", description: "Run only these flows." },
  slack: { type: "string", placeholder: "<n>", description: "Multiply every time budget by this number above 0, for a loaded machine." },
  xray: { type: "string", placeholder: "<report.json>", description: "Attach an ax-xray report (--json) to report.json." },
});

type Io = Pick<CliIo, "stdout" | "stderr">;

/** Why a file cannot be an X-ray report, or null when it can. */
function xrayProblem(file: string): string | null {
  if (!existsSync(file)) return "does not exist";
  try {
    JSON.parse(readFileSync(file, "utf8"));
    return null;
  } catch {
    return "is not JSON";
  }
}

// The run: its arguments are checked first, then the suite is loaded and run. The lines for each flow go to stderr under
// --json, so stdout holds the outcome alone. A failure, or a known defect that now passes, is the failed outcome, exit 1.
async function runSuiteCommand(cli: Cli, input: Input, json: boolean, io: Io): Promise<Outcome> {
  const suiteArg = input["suite"] as string;
  const out = (input["out"] as string | undefined) ?? "report";
  const only = input["flows"] as readonly string[] | undefined;
  const slackText = input["slack"] as string | undefined;
  const xrayArg = input["xray"] as string | undefined;
  const fix = (...flags: string[]) => commandLine([cli.name, "run", suiteArg, ...flags]);
  const slack = slackText === undefined ? undefined : Number(slackText);
  if (slack !== undefined && !(slack > 0)) throw new AxError({ code: "bad-value", exit: cli.exits.code("usage"), thing: "run --slack", problem: `takes a number above 0, not "${slackText}"`, fix: fix("--slack", "2") });
  const xray = xrayArg === undefined ? undefined : resolve(xrayArg);
  const xrayWrong = xray === undefined ? null : xrayProblem(xray);
  if (xrayWrong !== null) throw new AxError({ code: "bad-value", exit: cli.exits.code("usage"), thing: "run --xray", problem: `takes an ax-xray report (--json), and ${xrayArg} ${xrayWrong}`, fix: fix("--xray", "report.json") });
  const modulePath = resolve(suiteArg);
  if (!existsSync(modulePath)) throw new AxError({ code: "no-suite", exit: cli.exits.code("usage"), thing: suiteArg, problem: "there is no suite module there", fix: "name the suite module's path, such as flows/suite.ts" });
  const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: FlowSuite };
  const suite = loaded.default;
  if (!suite || !Array.isArray(suite.flows) || typeof suite.cli !== "function" || typeof suite.guard !== "function")
    throw new AxError({ code: "bad-suite", exit: cli.exits.code("usage"), thing: suiteArg, problem: "does not default-export defineSuite({ tool, flows, cli, start, guard })", fix: "export default defineSuite({ tool, flows, cli, start, guard })" });
  mkdirSync(out, { recursive: true });
  let r: FlowReport;
  try {
    r = await runSuite(suite, { out, ...(only === undefined ? {} : { only: [...only] }), ...(slack === undefined ? {} : { slack }), ...(xray === undefined ? {} : { xray }) });
  } catch (problem) {
    throw new AxError({ code: "run-stopped", exit: cli.exits.code("error"), thing: "run", problem: `stopped before it finished: ${(problem as Error).message}`, fix: null });
  }
  const log = json ? io.stderr : io.stdout;
  for (const f of r.summary.flows) log.write(`${f.pass ? "pass" : "FAIL"}  ${f.flow.padEnd(4)} ${f.checks} checks, ${f.failed} failed${f.known ? ` (${f.known} known)` : ""}\n`);
  for (const f of r.findings.filter((x) => !x.pass)) log.write(`  ${f.known ? "known" : "FAIL "} ${f.flow} ${f.step} ${f.check}${f.selector ? ` ${f.selector}` : ""}: ${JSON.stringify(f.measured ?? f.evidence ?? "")}${f.fix ? ` -> ${f.fix}` : ""}\n`);
  for (const k of r.summary.knownPassing) log.write(`  FIXED ${k.flow} ${k.step} passes now: remove known ${k.known}\n`);
  const { pass, checks, unknownFail } = r.summary;
  const fixed = r.summary.knownPassing.length;
  const found = join(out, "findings.jsonl");
  const totals = `${pass}/${checks} checks pass; ${unknownFail} unknown failure${unknownFail === 1 ? "" : "s"}; ${fixed} known defect${fixed === 1 ? " passes" : "s pass"} now`;
  if (!unknownFail && !fixed) return outcome({ action: "run", state: "done", summary: `${totals}. ${found}` });
  const todo = [unknownFail ? "fix the FAIL lines above" : "", fixed ? "remove the known mark on each FIXED line above" : ""].filter(Boolean).join(", and ");
  return outcome({
    action: "run",
    state: "failed",
    summary: `${totals}. ${found}`,
    error: { code: "checks-failed", exit: cli.exits.code("error"), thing: "run", problem: totals, fix: `${todo}; findings are in ${found}` },
  });
}

// The tool: one command, `run`, named by its word, so `--help`, `--json` and every refusal come from the Ouro AX kit.
function flowsTool(io: Io): Cli {
  const runCommand: CommandDef<Outcome> = defineCommand<Outcome>({
    name: "run",
    summary: "Runs an adopter's agent flows against its mock, prints a line per flow and per failure, and writes the findings and report.",
    effect: "private",
    examples: ["ax-flows run flows/suite.ts --out report --xray xray.json"],
    args: [{ name: "suite", description: "The suite module, which default-exports defineSuite({ tool, flows, cli, start, guard }).", required: true, missing: "Name the suite module to run, such as flows/suite.ts." }],
    flags: FLOW_FLAGS,
    output: "an outcome: state done when every check passes or fails only as known; failed (exit 1) on an unknown failure or a known defect that now passes",
    run: (input, ctx) => runSuiteCommand(cli, input, ctx.json, io),
  });
  const cli: Cli = defineCli({ name: "ax-flows", about: ABOUT, commands: [runCommand] });
  return cli;
}

/**
 * The command: run a suite module, print one line per flow and per failure, write the files. Exits 1 on a failure no
 * `known` names, and on a `known` defect that now passes.
 *
 * @claim "Exits 1 on a failure no" registry/ouro/ax/flows.test.mts verify:testExists(registry/ouro/ax/flows.test.mts::the command runs a suite module: exit 0, 1 on an unknown failure or a known that passes, 2 on usage)
 */
async function main(argv: readonly string[], io: { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } } = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  return runCli(flowsTool(io), argv, io);
}

// Run as a program (`node flows.ts run ...`); the tests import it instead. No top-level await: the suite module imports
// this file, which must finish loading first.
/* node:coverage disable */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  quietPipes(process);
  void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
/* node:coverage enable */
