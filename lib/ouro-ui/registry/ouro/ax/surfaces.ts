export {
  checkSurfaces,
  countFindings,
  extractSurfaces,
  FIX_VERBS,
  leadsWithFix,
  main,
  ratchet,
  SURFACES_BASELINE_VERSION,
  SURFACES_DEFAULT_LIMITS,
  SURFACES_VERSION,
  surfacesText,
  SURFACE_CHECKS,
};
export type { BaselineResult, ErrorSurface, ReplySurface, SurfaceFinding, Surfaces, SurfacesLimits, SurfacesReport, TextSurface, ToolSurface };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { devCommandIn } from "./dev-commands.ts";
import { FINDINGS_EXIT_CODE } from "./exit-codes.ts";
import { errorMessage } from "./problem.ts";

/**
 * What a repository hands the checker: its agent-facing words as one JSON file a repository can produce cheaply. The
 * checker reads this, not the source, so a CLI, an MCP server, a hook or a script take the same path in.
 *
 * - `errors`: the error and refusal texts an agent can hit, with the stable `code` of a text that has one.
 * - `tools`: the tools or commands, with the description an agent loads.
 * - `replies`: the actions' replies, with the field names they carry.
 * - `texts`: other words that speak to an agent, such as a hook's text or a reply's message.
 *
 * An `id` is stable across edits to the wording (a code, a tool name, or `file#first-words`), because the ratchet
 * records findings by it.
 */
interface Surfaces {
  ax: typeof SURFACES_VERSION;
  /** The tool or product the manifest describes. */
  tool: string;
  errors?: ErrorSurface[];
  tools?: ToolSurface[];
  replies?: ReplySurface[];
  texts?: TextSurface[];
  /** The reply fields that report an outcome; replaces {@link SURFACES_DEFAULT_LIMITS}'s list. */
  outcomeFields?: string[];
  limits?: Partial<SurfacesLimits>;
}

interface ErrorSurface {
  id: string;
  text: string;
  /** The stable slug an agent can branch on, such as `desk_push_blocked`. */
  code?: string;
  /** Where the text is written, such as `src/sync.js:12`. */
  where?: string;
}

interface ToolSurface {
  name: string;
  description: string;
  where?: string;
}

interface ReplySurface {
  /** The tool or action whose reply this is. */
  id: string;
  /** Whether the call changes something: a read has nothing to report an outcome of. */
  action: boolean;
  /** The top-level field names of the reply. */
  fields: string[];
  where?: string;
}

interface TextSurface {
  id: string;
  text: string;
  where?: string;
}

interface SurfacesLimits {
  /** The longest description a tool may have, in characters: an agent session loads it whole. */
  toolDescription: number;
  /** The reply fields that report an outcome. */
  outcomeFields: string[];
}

/** The manifest's version, written as its `ax` field. */
const SURFACES_VERSION = "surfaces/1" as const;
/** The baseline file's version. */
const SURFACES_BASELINE_VERSION = "surfaces-baseline/2" as const;

const SURFACES_DEFAULT_LIMITS: SurfacesLimits = Object.freeze({
  toolDescription: 600,
  outcomeFields: Object.freeze(["outcome", "change", "state", "status", "result", "summary"]) as string[],
});

/** The checks, in report order, and the rule they hold a surface to. */
const SURFACE_CHECKS: readonly { id: string; rule: string }[] = Object.freeze([
  { id: "error.leads-with-fix", rule: "An error or refusal opens with what to do, then says what went wrong." },
  { id: "error.has-code", rule: "An error carries a stable code an agent can branch on." },
  { id: "tool.says-when", rule: "A tool's description says when to use it." },
  { id: "tool.description-budget", rule: "A tool's description stays within its size budget." },
  { id: "reply.reports-outcome", rule: "An action's reply reports its outcome." },
  { id: "text.no-script", rule: "Nothing tells an agent to run a script the tool could run itself." },
]);

interface SurfaceFinding {
  /** One of {@link SURFACE_CHECKS}. */
  check: string;
  /** The surface's `id` or `name`. */
  surface: string;
  where: string | null;
  /** What is wrong, in the agent's words. */
  problem: string;
  /** What to change. */
  fix: string;
  /** `<check>:<surface>`. */
  key: string;
  /** `<check>:<file>`, the ratchet's unit: rewording an error leaves it as it was. */
  group: string;
}

interface SurfacesReport {
  tool: string;
  surfaces: number;
  findings: SurfaceFinding[];
}

/**
 * The first words of a sentence that tell the reader what to do. A fix that opens an error starts with one of these
 * (after an optional "Please" or "Then"), or with a label such as "Fix:" or "To continue,".
 */
const FIX_VERBS: ReadonlySet<string> = new Set(
  (
    "run call use pass add set remove delete pick choose select ask wait retry try open sign log check create give provide specify name send pull update install enable disable start stop restart " +
    "reload reopen rerun re-run repeat resolve merge rebase commit push save move rename edit fix switch make ensure confirm approve grant authenticate reconnect supply include drop omit leave " +
    "keep read see look tell share upload download finish close unlock point refresh retype re-enter enter type paste copy list show request submit wait pin sync grant allow stage unstage " +
    "reauthenticate re-authenticate reinstall uninstall upgrade downgrade clear reset review inspect contact report file visit navigate go ensure verify rerun release lock unlock take"
  ).split(/\s+/),
);

const FIX_LABEL = /^(?:fix|next|do this|to (?:fix|continue|proceed|retry|recover|resolve|proceed|do this)[^:,]{0,40})\s*[:,]\s*/i;
/** A tool or place label such as `desk:` or `desk push:` in front of the words. */
const PREFIX = /^(?:\$\{[^}]*\}|[A-Za-z][\w.-]{0,24}(?: [a-z][\w.-]{0,24})?)\s*:\s+/;
const SOFTENERS = new Set(["please", "then", "and", "also", "now", "first", "next"]);
const SENTENCE_END = /(?<=[.!?;])\s+|\n+|\s[—–]\s/;

const firstWord = (clause: string) => (clause.trim().replace(/^[`"'(*_-]+/, "").match(/^[A-Za-z][\w-]*/)?.[0] ?? "").toLowerCase();

function startsWithFix(clause: string): boolean {
  let words = clause.trim();
  if (FIX_LABEL.test(words)) return true;
  let head = firstWord(words);
  while (SOFTENERS.has(head)) {
    words = words.replace(/^[`"'(*_-]*\w[\w-]*[,\s]+/, "");
    if (FIX_LABEL.test(words)) return true;
    head = firstWord(words);
  }
  return FIX_VERBS.has(head);
}

/**
 * Whether an error's words open with the fix: after a leading `tool:` or `thing:` label, the first sentence is a
 * command (starts with an imperative verb such as "Run", "Pass" or "Call") or a label such as "Fix:" or "To continue,".
 * `later` says the fix does come, in a sentence after the problem.
 *
 * @example
 * leadsWithFix("Pass --why. The send reaches other people."); // { leads: true, later: false }
 * leadsWithFix("send: the draft is empty. Fix: pass --text."); // { leads: false, later: true }
 */
function leadsWithFix(text: string): { leads: boolean; later: boolean } {
  let rest = text.trim().replace(/\s+/g, " ");
  for (let i = 0; i < 3 && !FIX_LABEL.test(rest) && PREFIX.test(rest); i++) rest = rest.replace(PREFIX, "");
  const sentences = rest.split(SENTENCE_END).filter((s) => s.trim());
  if (sentences.length === 0) return { leads: false, later: false };
  const leads = startsWithFix(sentences[0]!);
  const later = !leads && sentences.slice(1).some(startsWithFix);
  return { leads, later };
}

const WHEN = /\b(?:use|call|run|start|reach for|pick|prefer)\b[^.]{0,80}\b(?:when|to|for|if|before|after|instead|whenever)\b|\bwhen (?:you|the|a|an|someone|asked|asking|your)\b|\b(?:before|after|instead of)\b|\bonly (?:for|when|to)\b|\bfor (?:when|asking|checking)\b/i;
const SCRIPT_RUN = /\b(?:run|execute|invoke|launch|start|use)\s+[`"']?(?:[\w~.$/\\-]+[/\\])?[\w.-]+\.(?:[cm]?js|ts|mts|py|sh|ps1|rb)\b/i;
const CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function say(check: string, surface: string, where: string | undefined, problem: string, fix: string): SurfaceFinding {
  return { check, surface, where: where ?? null, problem, fix, key: `${check}:${surface}`, group: `${check}:${surface.split("#")[0]}` };
}

/**
 * Runs the checks over a manifest. Throws, with the fix, on a manifest that is not one. A finding names its check,
 * the surface, what is wrong and what to change; the order is the manifest's.
 *
 * @example
 * checkSurfaces({ ax: "surfaces/1", tool: "notes", errors: [{ id: "send-empty", text: "The draft is empty. Pass --text.", code: "send_empty" }] }).findings;
 * // [{ check: "error.leads-with-fix", surface: "send-empty", ... }]
 */
function checkSurfaces(manifest: Surfaces): SurfacesReport {
  validate(manifest);
  const limits = { ...SURFACES_DEFAULT_LIMITS, ...(manifest.outcomeFields ? { outcomeFields: manifest.outcomeFields } : {}), ...manifest.limits };
  const findings: SurfaceFinding[] = [];
  const noScript = (id: string, text: string, where: string | undefined) => {
    const dev = devCommandIn(text);
    const script = dev ? null : SCRIPT_RUN.exec(text)?.[0];
    const found = dev?.match ?? script;
    if (found) findings.push(say("text.no-script", id, where, `tells the agent to run \`${found.trim()}\`, a script the tool could run itself`, "do it in the tool and report the result, or name the tool call that does it"));
  };
  for (const e of manifest.errors ?? []) {
    const { leads, later } = leadsWithFix(e.text);
    if (!leads) {
      findings.push(
        later
          ? say("error.leads-with-fix", e.id, e.where, "puts its fix after the problem", 'move the fix to the first sentence ("Run <call> to …."), then say what went wrong')
          : say("error.leads-with-fix", e.id, e.where, "has no fix", "add the one call or flag that gets past it, as the first sentence"),
      );
    }
    if (e.code === undefined || e.code === "") findings.push(say("error.has-code", e.id, e.where, "has no stable code", 'give it a code an agent can branch on, such as "send_empty"'));
    else if (!CODE.test(e.code)) findings.push(say("error.has-code", e.id, e.where, `has the code "${e.code}", which is not a stable slug`, "use lower-case words joined by _ . or -, such as send_empty"));
    noScript(e.id, e.text, e.where);
  }
  for (const t of manifest.tools ?? []) {
    if (!WHEN.test(t.description)) findings.push(say("tool.says-when", t.name, t.where, "has a description that does not say when to use it", 'add "Use when …" with the situation that calls for it'));
    if (t.description.length > limits.toolDescription) findings.push(say("tool.description-budget", t.name, t.where, `has a description of ${t.description.length} characters, over the ${limits.toolDescription} budget`, "move the detail into the input schema or the reply, and keep the description to what and when"));
    noScript(t.name, t.description, t.where);
  }
  for (const r of manifest.replies ?? []) {
    if (r.action && !r.fields.some((f) => limits.outcomeFields.includes(f))) {
      findings.push(say("reply.reports-outcome", r.id, r.where, `replies with ${r.fields.length ? r.fields.map((f) => `\`${f}\``).join(", ") : "no fields"} and none of ${limits.outcomeFields.map((f) => `\`${f}\``).join(", ")}`, "add a field that says what happened, such as `outcome` or `change`"));
    }
  }
  for (const t of manifest.texts ?? []) noScript(t.id, t.text, t.where);
  const order = new Map(SURFACE_CHECKS.map((c, i) => [c.id, i]));
  findings.sort((a, b) => order.get(a.check)! - order.get(b.check)!);
  const surfaces = (manifest.errors?.length ?? 0) + (manifest.tools?.length ?? 0) + (manifest.replies?.length ?? 0) + (manifest.texts?.length ?? 0);
  return { tool: manifest.tool, surfaces, findings };
}

function validate(manifest: Surfaces): void {
  const fail = (problem: string, fix: string): never => {
    throw new Error(errorMessage({ thing: "surfaces manifest", problem, fix }));
  };
  if (typeof manifest !== "object" || manifest === null || manifest.ax !== SURFACES_VERSION) fail(`its "ax" is not "${SURFACES_VERSION}"`, `write { "ax": "${SURFACES_VERSION}", "tool": "<name>", "errors": [...] }`);
  if (typeof manifest.tool !== "string" || !manifest.tool) fail('it has no "tool"', 'add "tool": "<the tool or product name>"');
  const seen = new Set<string>();
  const unique = (kind: string, id: unknown) => {
    if (!id) return fail(`the ${kind}s list has an entry with no id`, "give each entry a stable id");
    const key = `${kind}:${id}`;
    if (seen.has(key)) fail(`two ${kind}s share the id "${id}"`, "make each id unique, such as file#first-words");
    seen.add(key);
  };
  const strings = (kind: string, id: string, field: string, value: unknown) => {
    if (typeof value !== "string") fail(`${kind} "${id}" has no ${field} string`, `give it a ${field}`);
  };
  for (const e of manifest.errors ?? []) {
    unique("error", e.id);
    strings("error", e.id, "text", e.text);
  }
  for (const t of manifest.tools ?? []) {
    unique("tool", t.name);
    strings("tool", t.name, "description", t.description);
  }
  for (const t of manifest.texts ?? []) {
    unique("text", t.id);
    strings("text", t.id, "text", t.text);
  }
  for (const r of manifest.replies ?? []) {
    unique("reply", r.id);
    if (!Array.isArray(r.fields) || typeof r.action !== "boolean") fail(`reply "${r.id}" needs "action" (true or false) and "fields" (a list)`, 'write { "id": "<tool>", "action": true, "fields": ["outcome"] }');
  }
}

interface BaselineResult {
  /** The findings of a group that grew past the baseline: a run with one fails. */
  added: SurfaceFinding[];
  /** Groups with fewer findings than the baseline records, as `<group>: was <n>, now <m>`: lower their counts, so the count only goes down. */
  fixed: string[];
  /** Findings the baseline records. */
  known: number;
  ok: boolean;
}

/** The findings per group, which is what the baseline file records. */
function countFindings(report: SurfacesReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of report.findings) counts[f.group] = (counts[f.group] ?? 0) + 1;
  return counts;
}

/**
 * Compares a run to the recorded baseline, which counts findings per check and file (the group `error.has-code:src/send.js`),
 * so rewording an error or moving it in its file leaves the baseline as it was. A group with more findings than recorded
 * fails, and so does one with fewer: the pull request that fixes a finding lowers its count, so the count only goes down.
 *
 * @example
 * ratchet(report, { "error.has-code:src/send.js": 2 }); // { added: [], fixed: ["error.has-code:src/send.js: was 2, now 1"], known: 1, ok: false }
 */
function ratchet(report: SurfacesReport, baseline: Readonly<Record<string, number>>): BaselineResult {
  const counts = countFindings(report);
  const grown = new Set(Object.keys(counts).filter((group) => counts[group]! > (baseline[group] ?? 0)));
  const added = report.findings.filter((f) => grown.has(f.group));
  const fixed = Object.keys(baseline)
    .filter((group) => (counts[group] ?? 0) < baseline[group]!)
    .sort()
    .map((group) => `${group}: was ${baseline[group]}, now ${counts[group] ?? 0}`);
  const known = Object.keys(counts).reduce((total, group) => total + Math.min(counts[group]!, baseline[group] ?? 0), 0);
  return { added, fixed, known, ok: added.length === 0 && fixed.length === 0 };
}

/**
 * The report for an agent or a person: the verdict on the first line, then the findings as
 * `<check> <surface> (<where>): <problem>. Fix: <fix>.`, then what the ratchet wants.
 */
function surfacesText(report: SurfacesReport, result: BaselineResult | null, options: { baselinePath?: string } = {}): string {
  const shown = result ? result.added : report.findings;
  const lines: string[] = [];
  if (result) {
    const verdict = result.ok ? "ok" : "FAIL";
    lines.push(`${verdict}: ${count(report.findings.length, "finding")} in ${count(report.surfaces, "surface")}: ${result.known} in the baseline, ${result.added.length} new, ${result.fixed.length} fixed and still listed.`);
  } else {
    lines.push(report.findings.length ? `FAIL: ${count(report.findings.length, "finding")} in ${count(report.surfaces, "surface")}.` : `ok: no findings in ${count(report.surfaces, "surface")}.`);
  }
  for (const f of shown) lines.push(`${f.check} ${f.surface}${f.where ? ` (${f.where})` : ""}: ${errorMessage({ thing: f.surface, problem: f.problem, fix: f.fix }).replace(`${f.surface}: `, "")}`);
  if (result && result.fixed.length) {
    lines.push(`Fix: lower these counts in ${options.baselinePath ?? "the baseline"} (run the check with --update), so the count only goes down:`);
    for (const entry of result.fixed) lines.push(`  ${entry}`);
  }
  return lines.join("\n");
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);
const SOURCE = /\.(?:[cm]?[jt]sx?|mts|cts)$/;
const TEST_FILE = /(?:\.test\.|\.spec\.|__tests__|\/tests?\/|\.d\.ts$)/;

function sourceFiles(path: string): string[] {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (SKIP_DIRS.has(name) ? [] : sourceFiles(join(path, name))));
}

/** Where an error's words begin: a throw, an Error constructor, a stderr write or an `error:`/`message:` property. */
const ERROR_START = /\b(?:throw\b|new\s+\w*Error\s*\(|\w*Error\s*\(|console\.error\s*\(|stderr\.write\s*\(|(?:die|fail|refuse|bail)\s*\(|(?:error|message)\s*:)/g;
const CODE_NEAR = /\b(?:error_)?code\s*[:=]\s*["'`]([A-Za-z][\w.-]*)["'`]/;

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

/** Reads one string literal at `i` (a quote or backtick), returning its text and the index after it. */
function literalAt(src: string, i: number): [string, number] | null {
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let text = "";
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === "\\") {
      text += ESCAPES[src.charAt(j + 1)] ?? src.charAt(j + 1);
      j++;
    } else if (c === quote) return [text, j + 1];
    else if (c === "\n" && quote !== "`") return null;
    else text += c;
  }
  return null;
}

/** A string, or several joined by `+`; an expression between them becomes `${…}`. Null when something other than a literal opens it. */
function joinedAt(src: string, from: number): [string, number] | null {
  let i = from;
  while (/[\s(]/.test(src.charAt(i))) i++;
  const first = literalAt(src, i);
  if (!first) return null;
  let text = first[0];
  i = first[1];
  for (let guard = 0; guard < 12; guard++) {
    let j = i;
    while (/\s/.test(src.charAt(j))) j++;
    if (src[j] !== "+") break;
    j++;
    while (/\s/.test(src.charAt(j))) j++;
    const next = literalAt(src, j);
    if (next) {
      text += next[0];
      i = next[1];
      continue;
    }
    let depth = 0;
    let k = j;
    for (; k < src.length; k++) {
      const c = src[k]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if ((c === "," || c === "+" || c === ";") && depth === 0) break;
    }
    text += "${…}";
    i = k;
  }
  return [text, i];
}

const slug = (text: string) =>
  text
    .replace(/\$\{[^}]*\}/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 5)
    .join("-") || "text";

/**
 * The error texts in JavaScript and TypeScript source: the first string (or strings joined with `+`) after a throw, an
 * `Error` constructor, `console.error`, a stderr write, `die`, `fail`, `refuse`, or an `error:` or `message:` property,
 * outside tests, when it has several words. An id is `<path>#<first words>`, with `~2` for a repeat, so rewording an
 * error's end keeps its id. A `code:` on the same line, or on the line before or after, gives the error its code. It reads the source as
 * text, so it can miss a text built elsewhere and read a string that is not an error: its manifest is a start to edit,
 * and the ratchet works from the manifest you keep.
 *
 * @example
 * extractSurfaces({ root: ".", paths: ["src"], tool: "notes" }).errors;
 */
function extractSurfaces(options: { root: string; paths: readonly string[]; tool: string }): Surfaces {
  const errors: ErrorSurface[] = [];
  const files = options.paths.flatMap((p) => sourceFiles(resolve(options.root, p))).filter((f) => SOURCE.test(f) && !TEST_FILE.test(f)).sort();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = relative(options.root, file).split("\\").join("/");
    const seen = new Map<string, number>();
    const taken = new Set<number>();
    for (const m of src.matchAll(ERROR_START)) {
      const read = joinedAt(src, m.index + m[0].length);
      if (!read || taken.has(read[1])) continue;
      taken.add(read[1]);
      const text = read[0].replace(/\s+/g, " ").trim();
      if (text.split(" ").length < 3 || !/[A-Za-z]{3}/.test(text)) continue;
      const base = `${rel}#${slug(text)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const lines = src.split("\n");
      const line = src.slice(0, m.index).split("\n").length;
      const last = src.slice(0, read[1]).split("\n").length;
      const beside = [lines[line - 2], lines[last]].filter((l) => l !== undefined && /^\s*(?:error_)?code\s*[:=]/.test(l));
      const code = CODE_NEAR.exec([...lines.slice(line - 1, last), ...beside].join("\n"))?.[1];
      errors.push({ id: n === 1 ? base : `${base}~${n}`, text, ...(code ? { code } : {}), where: `${rel}:${line}` });
    }
  }
  return { ax: SURFACES_VERSION, tool: options.tool, errors };
}

const USAGE = [
  "surfaces check <manifest.json> [--baseline <file>] [--update | --init] [--json]",
  "surfaces extract <path>... [--tool <name>] [--root <dir>] [--out <manifest.json>]",
].join("\n");

interface Io {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

function parseFlags(args: readonly string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["baseline", "tool", "root", "out"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (valued.has(a.slice(2))) flags.set(a.slice(2), args[++i] ?? "");
    else flags.set(a.slice(2), true);
  }
  return { positional, flags };
}

const usageError = (thing: string, problem: string, fix: string) => `surfaces: ${errorMessage({ thing, problem, fix })}\n`;

function readBaseline(path: string): Record<string, number> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { ax?: string; findings?: unknown };
  const counts = parsed.findings;
  if (parsed.ax !== SURFACES_BASELINE_VERSION || typeof counts !== "object" || counts === null || Object.values(counts).some((n) => !Number.isInteger(n))) {
    throw new Error(errorMessage({ thing: path, problem: `it is not a ${SURFACES_BASELINE_VERSION} file`, fix: `run the check with --baseline ${path} --init to write one` }));
  }
  return counts as Record<string, number>;
}

function writeBaseline(path: string, counts: Readonly<Record<string, number>>): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = Object.keys(counts).sort().map((group) => `    ${JSON.stringify(group)}: ${counts[group]}`).join(",\n");
  writeFileSync(path, `{\n  "ax": "${SURFACES_BASELINE_VERSION}",\n  "findings": {${body ? `\n${body}\n  ` : ""}}\n}\n`);
}

/**
 * The checker's command line. `check` reads a manifest and exits with the Ouro AX codes: ok, findings (with a baseline:
 * a finding it does not list, or a listed one that is fixed), usage and error. `check --init` writes the first baseline
 * and refuses to overwrite one; `--update` rewrites it with the findings that remain and refuses to add one. `extract`
 * writes a manifest from source.
 *
 * @claim "refuses to overwrite one" registry/ouro/ax/surfaces.test.mts verify:testExists(registry/ouro/ax/surfaces.test.mts::a baseline is written once, fails what is new, and only ever shrinks)
 * @claim "refuses to add one" registry/ouro/ax/surfaces.test.mts verify:testExists(registry/ouro/ax/surfaces.test.mts::a baseline is written once, fails what is new, and only ever shrinks)
 * @claim "exits with the Ouro AX codes" registry/ouro/ax/surfaces.test.mts verify:testExists(registry/ouro/ax/surfaces.test.mts::check exits 0 clean, 3 on findings, 2 on a usage mistake, 1 when it cannot read)
 */
async function main(args: readonly string[], io: Io = process): Promise<number> {
  const [command, ...rest] = args;
  const { positional, flags } = parseFlags(rest);
  try {
    const refuse = (message: string) => {
      io.stderr.write(message);
      return 2;
    };
    if (command === "extract") {
      if (positional.length === 0) return refuse(usageError("extract", "no path to read", "pass a file or folder, such as: surfaces extract src --tool notes"));
      const root = resolve(String(flags.get("root") ?? "."));
      const manifest = extractSurfaces({ root, paths: positional, tool: String(flags.get("tool") ?? "tool") });
      const json = `${JSON.stringify(manifest, null, 2)}\n`;
      const out = flags.get("out");
      if (typeof out === "string" && out) {
        mkdirSync(dirname(resolve(out)), { recursive: true });
        writeFileSync(out, json);
      } else io.stdout.write(json);
      return 0;
    }
    if (command !== "check") return refuse(usageError(command ?? "surfaces", command ? "is not a command" : "no command given", `use one of:\n${USAGE}`));
    if (positional.length !== 1) return refuse(usageError("check", "needs one manifest", "pass the manifest: surfaces check surfaces.json --baseline surfaces-baseline.json"));
    const baselinePath = flags.get("baseline");
    if ((flags.has("update") || flags.has("init")) && typeof baselinePath !== "string") return refuse(usageError("check", `--${flags.has("init") ? "init" : "update"} needs a baseline file`, "add --baseline <file>"));
    const report = checkSurfaces(JSON.parse(readFileSync(positional[0]!, "utf8")) as Surfaces);
    if (typeof baselinePath !== "string") {
      io.stdout.write(`${flags.has("json") ? JSON.stringify(report, null, 2) : surfacesText(report, null)}\n`);
      return report.findings.length ? FINDINGS_EXIT_CODE.code : 0;
    }
    if (flags.has("init")) {
      let exists = true;
      try {
        statSync(baselinePath);
      } catch {
        exists = false;
      }
      if (exists) return refuse(usageError(baselinePath, "already exists, and a baseline is only ever written once", "use --update to shrink it; never add a finding to it"));
      writeBaseline(baselinePath, countFindings(report));
      io.stdout.write(`ok: wrote ${count(report.findings.length, "finding")} to ${baselinePath}. From now on a new finding fails.\n`);
      return 0;
    }
    const result = ratchet(report, readBaseline(baselinePath));
    if (flags.has("update")) {
      if (result.added.length) {
        io.stdout.write(`${surfacesText(report, { ...result, fixed: [] }, { baselinePath })}\nFix: fix the new findings above; a baseline never takes one.\n`);
        return FINDINGS_EXIT_CODE.code;
      }
      writeBaseline(baselinePath, countFindings(report));
      io.stdout.write(`ok: ${baselinePath} now lists ${count(report.findings.length, "finding")}, ${result.fixed.length} fewer.\n`);
      return 0;
    }
    if (flags.has("json")) io.stdout.write(`${JSON.stringify({ report, baseline: { known: result.known, added: result.added.map((f) => f.key), fixed: result.fixed }, ok: result.ok }, null, 2)}\n`);
    else io.stdout.write(`${surfacesText(report, result, { baselinePath })}\n`);
    return result.ok ? 0 : FINDINGS_EXIT_CODE.code;
  } catch (error) {
    io.stderr.write(`surfaces: ${(error as Error).message}\n`);
    return 1;
  }
}

// Run as a program (`node surfaces.ts ...`); the tests import it instead.
/* node:coverage disable */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
/* node:coverage enable */
