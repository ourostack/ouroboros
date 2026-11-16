export { audienceWho, checkSafety, claimSetHash, compareInventory, harvest, main, misspell, parseArgs, refsOf, refusalVerdict, renderHtml, renderMarkdown, renderText, requiredWords, splitCommand, stateDelta, summarize, usageWords, xray, XRAY_VERSION };
export type { CheckResult, Inventory, InventoryCompare, Report, Safety, Verdict, XrayOptions };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLAIM_SET, claimSetText, type Claim, type ClaimSurface } from "./claims.ts";
import { isChecksReport, type ChecksReport } from "./checks.ts";
import { isReservedPersonOnly, type UiEntry } from "./component.ts";
import { devCommandIn, devCommandsIn, sourceCheckoutTexts } from "./dev-commands.ts";
import { checkFailureCopyAllow, vagueFailureIn, vagueFailuresIn, type FailureCopyAllow } from "./precise-copy.ts";
import { isGenericAudience, isOutcome, validateOutcome } from "./outcome.ts";
import { hasAnsi, stripAnsi } from "./terminal.ts";
import { isWait, validateWait } from "./wait.ts";
import { checkWorkEvent } from "./work-event.ts";
import { quietPipes, runCli } from "./cli.ts";
import { defineCli, defineCommand, parse, type FlagSpec, type Input } from "./command.ts";
import { defineExitCodes } from "./exit-codes.ts";
import { AxError, isAxError } from "./problem.ts";

/**
 * The Ouro AX conformance checker: it calls a CLI, an HTTP API or an MCP server the way an agent would, and reports
 * which claims hold on which surface, with the fix where a claim does not hold. It checks from outside, never by
 * importing the interface's code. Reads run freely; what other people see is called only on paths that must refuse (a made-up
 * target, no `--why`) or that act on nothing (`--dry-run`), and only against a target that proves it is a mock.
 *
 *   node xray.ts --cli "<command>" [--http <url> --routes <manifest.json>] [--mcp "<command>"] [options]
 *
 * @claim "never by importing the interface's code" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the kit's example tool conforms, and the X-ray acts on nothing)
 * @claim "only against a target that proves it is a mock" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::without proof of a mock, nothing other people see is called, and it does not conform)
 */
const XRAY_VERSION = "1.5.0";

type Verdict = "pass" | "fail" | "skip";

interface CheckResult {
  claim: string;
  surface: string;
  verdict: Verdict;
  note: string;
}

/**
 * The surfaces an adopter generates from its own registration: CLI command names, HTTP `METHOD /path` routes, MCP tool
 * names, and its components' bound reads and actions (`ui`, the entries `bindAx` returns), whose twins it checks.
 */
interface Inventory {
  cli?: string[];
  http?: string[];
  mcp?: string[];
  ui?: UiEntry[];
}

interface InventoryCompare {
  expected: number;
  covered: number;
  missing: string[];
  unknown: string[];
  duplicate: string[];
}

interface Safety {
  /** Whether the X-ray may call what other people see (refused probes and previews). */
  ok: boolean;
  checks: { name: string; ok: boolean; note: string }[];
}

interface XrayOptions {
  cli?: string | undefined;
  http?: string | undefined;
  routes?: string | undefined;
  mcp?: string | undefined;
  name?: string | undefined;
  env: Record<string, string>;
  guard?: string | undefined;
  mock?: string | undefined;
  home?: string | undefined;
  inventory?: string | undefined;
  events?: string | undefined;
  commit?: string | undefined;
  failureCopyAllow?: string | undefined;
  conformance: boolean;
  state: string[];
  volatile: string[];
  samples: Record<string, string>;
  width: number;
  timeoutMs: number;
  json: boolean;
  md?: string | undefined;
  html?: string | undefined;
  command: "claims" | "help" | null;
}

const CLAIMS: readonly Claim[] = CLAIM_SET.claims;
const CLAIM = new Map(CLAIMS.map((c) => [c.id, c]));
const BOGUS = "axxraynoref";
const NO_SUCH_COMMAND = "ax-xray-no-such-command";
const NO_SUCH_FLAG = "--ax-xray-no-such-flag";
/** The agent a self-scoped twin runs as: a made-up name that owns nothing, so the item the twin names is another's. */
const STRANGER = "stranger-agent";
const WHY = "ax-xray conformance probe: nobody asked, so this must not reach anyone";
const READ_WORDS = new Set(["show", "list", "status", "profile", "catalog", "get"]);
const AMBIGUOUS = ["edit", "delete", "remove"];
/** The byte budget of a command's help (`cli.help-size`). */
const HELP_BYTES = 6000;
/** An instruction to a person or agent at the start of a clause: "; open the window", "Tell them, do not retry". */
const IMPERATIVE = /(^|[;:.!?]\s+|, )(open|tell|ask|run|use|try|give|wait|restart|start|turn|name|pass|add|choose|pick|check)\b/i;
/** Environment variable names that carry credentials; the X-ray refuses to pass any to what it checks. */
const CREDENTIAL = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH|COOKIE|SESSION/i;
/** What the X-ray passes on from its own environment: enough to find and run programs, nothing that signs in. */
const PASSED_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR"];

/**
 * The SHA-256 of the claim set's canonical JSON: a report pins the exact standard it checked.
 *
 * @claim "a report pins the exact standard" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the claim set: its hash is stable and every claim the X-ray records exists)
 */
function claimSetHash(): string {
  return createHash("sha256").update(claimSetText(CLAIM_SET)).digest("hex");
}

/** Splits a command line into words, honouring single and double quotes. */
function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const shellWord = (w: string) => (/^[\w@%+=:,./#-]+$/.test(w) ? w : JSON.stringify(w));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs argv with exactly `env` (nothing inherited); resolves its exit code and output. */
function run(argv: readonly string[], env: Record<string, string>, timeoutMs: number, input: string | null = null, closed = false): Promise<RunResult> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
    // A reader that has already gone, as `tool --help | head -0` leaves the tool.
    if (closed) child.stdout.destroy();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    child.on("error", (e) => (stderr += e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
    // The program may exit before it reads its input; that is its answer, not the X-ray's error.
    /* node:coverage ignore next */
    child.stdin.on("error", () => undefined);
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

const lines = (s: string) => s.replace(/\n$/, "").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim();
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
type Parsed = { ok: true; value: unknown } | { ok: false };
const parseJson = (s: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};
/** A JSON answer's value, or undefined when it is not one JSON document. */
const jsonValue = (s: string): unknown => {
  const p = parseJson(s);
  return p.ok ? p.value : undefined;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasStack = (s: string) => /^\s+at (?:async )?(?:\S+ \()?(?:file:\/\/|node:|\/|[A-Za-z]:\\)\S*:\d+:\d+\)?$/m.test(s);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits a usage line into words, keeping a placeholder with spaces (`<message id>`) in one word. */
function usageWords(usage: string): string[] {
  return splitCommand(usage.replace(/<[^<>]*>/g, (p) => p.replace(/ /g, "\uE000"))).map((w) => w.replace(/\uE000/g, " "));
}

/** Removes `[...]` groups (nested) from a usage line and splits it into words. */
function requiredWords(usage: string): string[] {
  let u = usage;
  let prev;
  do {
    prev = u;
    u = u.replace(/\[[^[\]]*\]/g, " ");
  } while (u !== prev);
  return usageWords(u);
}

/**
 * What changed between two state snapshots, element by element: arrays compare by their members.
 *
 * @claim "What changed between two state snapshots" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::a refusal may leave only a record that says it was refused)
 */
function stateDelta(before: readonly string[], after: readonly string[]): { same: boolean; added: string[]; removed: string[] } {
  const leaves = (snap: readonly string[]) => {
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) for (const x of v) out.push(JSON.stringify(x));
      else if (isRecord(v)) for (const x of Object.values(v)) walk(x);
      else out.push(JSON.stringify(v));
    };
    for (const s of snap) {
      const j = parseJson(s);
      if (j.ok) walk(j.value);
      else out.push(s);
    }
    return out;
  };
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(leaves(before));
  const cb = count(leaves(after));
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, n] of cb) for (let i = ca.get(k) ?? 0; i < n; i++) added.push(k);
  for (const [k, n] of ca) for (let i = cb.get(k) ?? 0; i < n; i++) removed.push(k);
  return { same: added.length === 0 && removed.length === 0, added, removed };
}

/** A refusal's footprint: nothing, or only records that say they were refused. */
function refusalVerdict(delta: { same: boolean; added: string[]; removed: string[] }): { ok: boolean; note: string } {
  if (delta.same) return { ok: true, note: "nothing changed" };
  if (!delta.removed.length && delta.added.every((x) => /refus/i.test(x))) return { ok: true, note: `${delta.added.length} audit record${delta.added.length === 1 ? "" : "s"} of the refusal, nothing else` };
  return { ok: false, note: `${delta.added.length} added, ${delta.removed.length} removed; first: ${clip((delta.added[0] ?? delta.removed[0])!, 200)}` };
}

const placeholderKey = (p: string) => p.replace(/^<|>$/g, "").split(/[|\s.]/)[0]!.toLowerCase();
const singular = (k: string) => k.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");

/**
 * Collects sample refs from a JSON answer: the first `ref` (else `id`) of each array, keyed by its name, singular.
 *
 * @claim "of each array" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::harvest takes the first ref of each named list, singular)
 */
function harvest(value: unknown, samples: Record<string, string>, key: string | null = null): Record<string, string> {
  if (Array.isArray(value)) {
    if (key) {
      const k = singular(key);
      for (const item of value) {
        const ref = isRecord(item) ? (typeof item["ref"] === "string" ? item["ref"] : typeof item["id"] === "string" ? item["id"] : null) : null;
        if (ref) {
          if (!(k in samples)) samples[k] = ref;
          break;
        }
      }
    }
    for (const item of value) harvest(item, samples, key);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) harvest(v, samples, k);
  }
  return samples;
}

/** The refs that a JSON answer's list items carry, as a read's text should show them (`cli.text-refs`). */
function refsOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item) && typeof item["ref"] === "string" && item["ref"] && !out.includes(item["ref"])) out.push(item["ref"]);
      refsOf(item, out);
    }
  } else if (isRecord(value)) for (const v of Object.values(value)) refsOf(v, out);
  return out;
}

/** An outcome's `audience.who`, or an empty string. */
function audienceWho(value: unknown): string {
  const audience = isRecord(value) ? value["audience"] : null;
  return isRecord(audience) && typeof audience["who"] === "string" ? audience["who"] : "";
}

// The texts of the problems whose condition holds, in order.
const problemsOf = (pairs: readonly (readonly [boolean, string])[]) => pairs.filter(([bad]) => bad).map(([, text]) => text);
// The first problem whose condition holds, or the note when none does.
const firstOf = (pairs: readonly (readonly [boolean, string])[], note: string) => (pairs.find(([bad]) => bad) ?? [false, note])[1];
// The keys of an outcome envelope and of its objects, by path (`next[]` for each next step); every other key holds a
// scalar. A listening read's needs-human answer, or a refused stream, carries nothing else, so what people say cannot
// hide in it.
const OUTCOME_SHAPE: Readonly<Record<string, readonly string[]>> = {
  "": ["ax", "action", "effect", "audience", "target", "state", "summary", "postcondition", "receipt", "next", "error", "human"],
  audience: ["only", "who"],
  target: ["kind", "id", "name"],
  postcondition: ["checked", "holds", "how"],
  receipt: ["id", "at", "by", "why"],
  error: ["code", "exit", "thing", "problem", "fix", "message"],
  human: ["reason", "resume"],
  "human.resume": ["command", "why"],
  "next[]": ["command", "why"],
};

// What an outcome carries beyond its envelope, as paths (`lines`, `human.lines`, `target`): a key it does not have,
// an object or list where it has a scalar, or anything but an object (or null) where it has one.
function outcomeExtras(v: object): string[] {
  const out: string[] = [];
  const walk = (value: Record<string, unknown>, path: string) => {
    for (const [k, x] of Object.entries(value)) {
      const sub = path ? `${path}.${k}` : k;
      if (!OUTCOME_SHAPE[path]!.includes(k)) out.push(sub);
      else if (Object.hasOwn(OUTCOME_SHAPE, sub)) {
        if (isRecord(x)) walk(x, sub);
        else if (x !== null) out.push(sub);
      } else if (Object.hasOwn(OUTCOME_SHAPE, `${sub}[]`)) {
        if (!Array.isArray(x)) out.push(sub);
        else
          for (const item of x) {
            if (isRecord(item)) walk(item, `${sub}[]`);
            else out.push(`${sub}[]`);
          }
      } else if (typeof x === "object" && x !== null) out.push(sub);
    }
  };
  walk(v as Record<string, unknown>, "");
  return out;
}

// Every key of every object in a JSON value, at any depth.
function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

// Every member of every array in a JSON value, as JSON text: the lines a read answered.
function itemsOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) out.push(JSON.stringify(v));
  else if (isRecord(value)) for (const v of Object.values(value)) itemsOf(v, out);
  return out;
}

// A `ui` inventory entry the X-ray can read: a component, a kind and an id, each words.
function isUiEntry(v: unknown): v is UiEntry {
  return isRecord(v) && typeof v["component"] === "string" && (v["kind"] === "read" || v["kind"] === "action") && typeof v["id"] === "string";
}

/** Drops one inner letter: --limit becomes --limt. */
function misspell(flag: string): string {
  const body = flag.replace(/^--/, "");
  if (body.length < 4) return `--${body}x`;
  const i = Math.floor(body.length / 2) + 1;
  return `--${body.slice(0, i)}${body.slice(i + 1)}`;
}

class Recorder {
  readonly results: CheckResult[] = [];
  add(claim: string, surface: string, verdict: Verdict, note = "") {
    this.results.push({ claim, surface, verdict, note: clip(note, 400) });
  }
}

/** Compares what the X-ray covered with the inventory: missing, unknown and listed twice on either side. */
function compareInventory(expected: readonly string[], covered: readonly string[]): InventoryCompare {
  const twice = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  const want = new Set(expected);
  const got = new Set(covered);
  return { expected: want.size, covered: got.size, missing: [...want].filter((x) => !got.has(x)), unknown: [...got].filter((x) => !want.has(x)), duplicate: [...new Set([...twice(expected), ...twice(covered)])] };
}

function recordInventory(rec: Recorder, claim: string, compare: InventoryCompare | null, what: string) {
  if (!compare) return rec.add(claim, "inventory", "skip", "no --inventory given, so coverage is unproven");
  for (const m of compare.missing) rec.add(claim, m, "fail", `in the inventory but not in ${what}, so never checked`);
  for (const u of compare.unknown) rec.add(claim, u, "fail", `in ${what} but not in the inventory`);
  for (const d of compare.duplicate) rec.add(claim, d, "fail", "listed twice");
  if (!compare.missing.length && !compare.unknown.length && !compare.duplicate.length) rec.add(claim, "inventory", "pass", `${compare.covered} match the inventory`);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isLoopback = (url: string) => {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** The environment a checked program gets: the passed-on basics, the isolated home, and the --env values. */
function childEnv(opts: XrayOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSED_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const home = opts.home ? resolve(opts.home) : process.env["HOME"];
  if (home !== undefined) {
    env["HOME"] = home;
    env["USERPROFILE"] = home;
  }
  return { ...env, ...opts.env };
}

/** Reads `a.b.c` from a JSON value. */
const at = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), value);

/**
 * Whether the X-ray may call what other people see, failing closed: every address it can see is loopback, the home is
 * isolated, the target proves it is a mock (`--mock "<url> <key>=<value>"`, or the adopter's `--guard`, which already
 * passed), and no credential is passed to it. Any missing proof refuses those checks and says why.
 *
 * @claim "may call what other people see" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::checkSafety fails closed: a remote address, the real home, a credential, a wrong or missing mock)
 */
async function checkSafety(opts: XrayOptions, guardPassed: boolean): Promise<Safety> {
  const checks: Safety["checks"] = [];
  const [mockUrl, mockExpect] = opts.mock ? splitCommand(opts.mock) : [];
  const urls = [opts.http, mockUrl, ...Object.values(opts.env).filter((v) => /^https?:\/\//i.test(v))].filter((u): u is string => typeof u === "string" && u !== "");
  const far = urls.filter((u) => !isLoopback(u));
  checks.push(
    urls.length === 0
      ? { name: "loopback", ok: false, note: "no address to check: pass --mock \"<loopback url> <key>=<value>\" or --env <NAME>=<loopback url>" }
      : { name: "loopback", ok: far.length === 0, note: far.length ? `not loopback: ${far.join(", ")}` : `${urls.length} address${urls.length === 1 ? "" : "es"}, all loopback` },
  );
  const real = homedir();
  const home = opts.home ? resolve(opts.home) : null;
  const inside = home !== null && (home === real || !relative(home, real).startsWith(".."));
  checks.push(home === null ? { name: "isolated home", ok: false, note: "no --home <dir>: the checked program would run with the real home" } : { name: "isolated home", ok: !inside, note: inside ? `${home} is or holds the real home` : `HOME=${home}` });
  const leaked = Object.keys(opts.env).filter((k) => CREDENTIAL.test(k));
  checks.push({ name: "no credentials", ok: leaked.length === 0, note: leaked.length ? `--env passes ${leaked.join(", ")}` : `only ${PASSED_ENV.filter((k) => process.env[k] !== undefined).join(", ")} and the --env values are passed on` });
  let identity: { ok: boolean; note: string };
  if (mockUrl && mockExpect) {
    const eq = mockExpect.indexOf("=");
    const key = mockExpect.slice(0, eq);
    const want = mockExpect.slice(eq + 1);
    if (eq < 1) identity = { ok: false, note: `--mock needs <key>=<value> after the URL, not "${mockExpect}"` };
    else if (!isLoopback(mockUrl)) identity = { ok: false, note: `the mock check ${mockUrl} is not loopback` };
    else {
      try {
        const r = await fetch(mockUrl, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: "manual" });
        const j = parseJson(await r.text());
        const got = j.ok ? at(j.value, key) : undefined;
        identity = { ok: r.status === 200 && JSON.stringify(got) === JSON.stringify(parseJson(want).ok ? JSON.parse(want) : want), note: `${mockUrl} answers ${key}=${JSON.stringify(got)}; expected ${want}` };
      } catch (e) {
        identity = { ok: false, note: `${mockUrl}: ${(e as Error).message}` };
      }
    }
  } else identity = guardPassed ? { ok: true, note: "the --guard command passed" } : { ok: false, note: "no proof the target is a mock: pass --mock \"<url> <key>=<value>\" or --guard \"<command>\"" };
  checks.push({ name: "mock identity", ...identity });
  return { ok: checks.every((c) => c.ok), checks };
}

const refusedNote = (safety: Safety) => `not run: the target is not proven a mock (${safety.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`).join("; ")})`;

interface CliCommand {
  name: string;
  /**
   * The words a call starts with: none for the one command of a tool defined with `command` (`single` in help JSON).
   *
   * @claim "none for the one command of a tool defined with" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::a tool with one command conforms: its reads take the folder with no command word, and its help names none)
   */
  words: string[];
  effect: string | null;
  readOnly: boolean | null;
  usage: string[];
  /** `"self"` when the command runs only on the calling agent's own item. */
  scope: string | null;
}

interface Context {
  rec: Recorder;
  opts: XrayOptions;
  env: Record<string, string>;
  safety: Safety;
  inventory: Inventory | null;
  effects: { surface: string; note: string }[];
  allow: FailureCopyAllow[];
}

/** Reads help JSON's commands: `usage` as a list or one line, with or without the tool's name in front. */
function commandsOf(help: Record<string, unknown>, name: string): CliCommand[] {
  const list = (help["commands"] as unknown[]).filter(isRecord);
  return list.map((c) => {
    const cmd = String(c["name"]);
    const raw = Array.isArray(c["usage"]) ? c["usage"].map(String) : typeof c["usage"] === "string" ? [c["usage"]] : [cmd];
    const usage = raw.map((u) => (u.startsWith(`${name} `) ? u.slice(name.length + 1) : u));
    return { name: cmd, words: c["single"] === true ? [] : cmd.split(" "), effect: typeof c["effect"] === "string" ? c["effect"] : null, readOnly: typeof c["readOnly"] === "boolean" ? c["readOnly"] : null, usage, scope: typeof c["scope"] === "string" ? c["scope"] : null };
  });
}

async function checkCli(ctx: Context) {
  const { rec, opts, env } = ctx;
  const base = splitCommand(opts.cli!);
  const name = opts.name ?? basename(base[base.length - 1]!).replace(/\.[cm]?[jt]s$/, "");
  const calls: (RunResult & { args: string[]; shown: string })[] = [];
  const call = async (args: string[], input: string | null = null, timeoutMs = opts.timeoutMs, closed = false) => {
    const r = await run([...base, ...args], env, timeoutMs, input, closed);
    const c = { args, shown: `${[name, ...args].map(shellWord).join(" ")}${closed ? " | head -0" : ""}`, ...r };
    calls.push(c);
    return c;
  };
  const brief = (c: RunResult & { shown: string }) =>
    `\`${clip(c.shown, 120)}\` → ${c.timedOut ? "timed out" : `exit ${c.code}`}${c.stderr.trim() ? `; stderr: ${clip(firstLine(c.stderr), 200)}` : ""}${!c.stderr.trim() && c.stdout.trim() ? `; stdout: ${clip(firstLine(c.stdout), 120)}` : ""}`;
  const snapshot = async () => {
    const out: string[] = [];
    for (const s of opts.state) {
      const r = await run([...base, ...splitCommand(s)], env, opts.timeoutMs);
      const j = parseJson(r.stdout);
      out.push(j.ok ? JSON.stringify(stripKeys(j.value, opts.volatile)) : r.stdout);
    }
    return out;
  };

  // State first, twice: a state that moves on its own cannot show a read changed it.
  let stateBefore: string[] | null = null;
  let stateNote = "no --state command given";
  if (opts.state.length) {
    const a = await snapshot();
    const b = await snapshot();
    if (JSON.stringify(a) === JSON.stringify(b)) stateBefore = b;
    else stateNote = "the state commands answer differently with nothing run between them";
  }
  const runStart = stateBefore;

  // Help as data.
  let help: Record<string, unknown> | null = null;
  for (const args of [["help", "--json"], ["--help", "--json"]]) {
    const c = await call(args);
    const j = parseJson(c.stdout);
    if (c.code === 0 && j.ok && isRecord(j.value) && Array.isArray(j.value["commands"]) && j.value["commands"].every((x) => isRecord(x) && typeof x["name"] === "string")) {
      help = j.value;
      rec.add("cli.help-parses", "help", "pass", `\`${c.shown}\` lists ${j.value["commands"].length} commands`);
      break;
    }
    if (args[0] === "--help") rec.add("cli.help-parses", "help", "fail", brief(c));
  }
  const overview = await call(["--help"]);
  const overviewLines = lines(overview.stdout);
  // The overview into a pipe that is already closed: the tool should end quietly, not with a stack trace.
  await call(["--help"], null, opts.timeoutMs, true);
  /** The fixed voice lines the CLI declares (`help --json` `voice`), which a pipe or `--json` must not get. */
  const voiceLines = help && Array.isArray(help["voice"]) ? help["voice"].filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
  const commands: CliCommand[] = help ? commandsOf(help, name) : [];
  if (!help) {
    // Without help JSON, commands come from the text: an indented word, two spaces, then words.
    for (const l of overviewLines) {
      const m = /^ {2,4}([a-z][\w-]*):? {2,}\S/.exec(l);
      if (m?.[1]) commands.push({ name: m[1], words: [m[1]], effect: null, readOnly: null, usage: [m[1]], scope: null });
    }
  }
  const names = commands.map((c) => c.name);
  const unique = [...new Set(names)];
  /**
   * A tool with one command takes its tokens as the command's arguments.
   *
   * @claim "takes its tokens as the command's arguments" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::a tool with one command conforms: its reads take the folder with no command word, and its help names none)
   */
  const single = commands.some((c) => c.words.length === 0);
  recordInventory(rec, "cli.inventory", ctx.inventory?.cli ? compareInventory(ctx.inventory.cli, names) : null, "help --json");

  if (help) {
    for (const c of commands) {
      if (c.effect === "private" || c.effect === "others") rec.add("cli.help-effects", c.name, "pass", `effect: ${c.effect}`);
      else rec.add("cli.help-effects", c.name, "fail", `help --json gives ${c.name} no effect (private or others)`);
    }
  } else rec.add("cli.help-effects", "help", "fail", "no help JSON, so no command says who sees it");

  // Exit codes, documented.
  let documented: Set<number> | null = null;
  let usageCode: number | null = null;
  let findingsCode: number | null = null;
  const exitCodes = help && Array.isArray(help["exitCodes"]) ? help["exitCodes"].filter(isRecord) : null;
  if (exitCodes) {
    documented = new Set(exitCodes.map((e) => Number(e["code"])));
    const u = exitCodes.find((e) => /usage/i.test(JSON.stringify([e["name"], e["short"], e["meaning"]])));
    usageCode = u ? Number(u["code"]) : null;
    const f = exitCodes.find((e) => e["name"] === "findings");
    findingsCode = f ? Number(f["code"]) : null;
  } else {
    const m = /Exit codes?:([^\n]*(?:\n(?!\S*:)[^\n]*)*)/i.exec(overview.stdout);
    if (m?.[1]) {
      documented = new Set([...m[1].matchAll(/\b(\d{1,3}) [a-z]/gi)].map((x) => Number(x[1])));
      const u = /\b(\d{1,3}) usage/i.exec(m[1]);
      usageCode = u ? Number(u[1]) : null;
    }
  }

  // The overview and each command's help.
  const width = opts.width;
  const tooWide = (text: string) => lines(text).filter((l) => [...l].length > width);
  const wide = tooWide(overview.stdout);
  rec.add("cli.help-width", "--help", wide.length ? "fail" : "pass", wide.length ? `${wide.length} lines over ${width} columns, first: ${clip(wide[0]!, 140)}` : `every line ≤ ${width} columns`);
  rec.add("cli.overview-short", "--help", overviewLines.length <= 60 ? "pass" : "fail", `${overviewLines.length} lines`);
  const helpText: Record<string, string> = {};
  for (const n of unique) {
    const c = await call([...commands.find((x) => x.name === n)!.words, "--help"]);
    helpText[n] = c.stdout;
    const ok = c.code === 0 && c.stdout.trim() !== "" && !c.stderr.trim();
    rec.add("cli.command-help", n, ok ? "pass" : "fail", ok ? `${lines(c.stdout).length} lines` : brief(c));
    if (ok) {
      const bytes = new TextEncoder().encode(c.stdout).length;
      rec.add("cli.help-size", `${n} --help`, bytes <= HELP_BYTES ? "pass" : "fail", `${bytes} bytes${bytes > HELP_BYTES ? `, over ${HELP_BYTES}` : ""}`);
      const w = tooWide(c.stdout);
      rec.add("cli.help-width", `${n} --help`, w.length ? "fail" : "pass", w.length ? `${w.length} lines over ${width} columns, first (${[...w[0]!].length}): ${clip(w[0]!, 140)}` : `every line ≤ ${width} columns`);
    }
  }

  // Errors: one line, and they teach.
  const named = (msg: string, n: string) => new RegExp(`(^|[^\\w-])${escapeRe(n)}([^\\w-]|$)`).test(msg);
  const teaches = (msg: string) => IMPERATIVE.test(msg) || new RegExp(`\\b${escapeRe(name)} [a-z]`).test(msg) || /(^|\s|")--[a-z]/.test(msg) || unique.some((n) => msg.includes(`"${n}`) || msg.includes(`\`${n}`));
  const errorChecks = (surface: string, c: RunResult & { shown: string; args: string[] }) => {
    const errLines = lines(c.stderr).filter((l) => l.trim());
    // With --json, stdout may carry the same error as one JSON document.
    const out = parseJson(c.stdout);
    const quiet = !c.stdout.trim() || (c.args.includes("--json") && out.ok && isRecord(out.value) && isRecord(out.value["error"]));
    const one = errLines.length === 1 && quiet;
    rec.add("cli.one-line-error", surface, one ? "pass" : "fail", one ? clip(errLines[0]!) : `${brief(c)} (${errLines.length} stderr lines, ${lines(c.stdout).filter(Boolean).length} stdout lines)`);
    const t = errLines.length > 0 && teaches(c.stderr);
    rec.add("cli.error-teaches", surface, t ? "pass" : "fail", t ? clip(firstLine(c.stderr)) : `${brief(c)}: names no command or flag to try`);
  };

  // An unknown command. A tool with one command has none: its extra words are its arguments, so there is nothing to refuse.
  if (single) rec.add("cli.unknown-command", NO_SUCH_COMMAND, "skip", "a tool with one command takes its words as arguments, so none is refused as an unknown command");
  else {
    const c = await call([NO_SUCH_COMMAND]);
    const heads = [...new Set(unique.map((n) => n.split(" ")[0]!))];
    const listed = heads.filter((n) => named(c.stderr, n)).length;
    const codeOk = c.code !== 0 && !c.timedOut && (usageCode === null || c.code === usageCode);
    const pointsToHelp = c.stderr.includes(`${name} --help`) || c.stderr.includes(`${name} help`);
    const ok = codeOk && heads.length > 0 && (listed >= heads.length / 2 || pointsToHelp);
    rec.add("cli.unknown-command", NO_SUCH_COMMAND, ok ? "pass" : "fail", `${brief(c)}; lists ${listed} of ${heads.length} commands${usageCode !== null && c.code !== usageCode ? `; usage exit code is ${usageCode}` : ""}`);
    if (c.code !== 0) errorChecks(NO_SUCH_COMMAND, c);
  }

  // Ambiguous verbs, only when help JSON says what every command is: an unknown CLI's bare `delete` might act. A tool
  // with one command takes them as arguments, so there is nothing to check.
  for (const v of help && !single ? AMBIGUOUS.filter((x) => !names.includes(x)) : []) {
    const c = await call([v]);
    const hits = unique.filter((n) => n !== "help" && named(c.stderr, n));
    const ok = c.code !== 0 && !c.timedOut && hits.length >= 1;
    rec.add("cli.ambiguous-verbs", v, ok ? "pass" : "fail", `${brief(c)}${ok ? `; names ${hits.join(", ")}` : ""}`);
    if (c.code !== 0) errorChecks(v, c);
  }

  // Reads: each command's argument-free usage first, then those needing one harvested ref. A wait is checked apart.
  const waiter = commands.find((c) => c.name === "watch" || c.name === "wait") ?? null;
  const samples: Record<string, string> = { word: "the", words: "the", text: "ax-xray preview text", new: "ax-xray preview text", note: "ax-xray preview text", ...opts.samples };
  const knowsReads = commands.some((c) => c.readOnly !== null);
  const readPlan = (cmd: CliCommand) => {
    for (const u of cmd.usage) {
      const w = requiredWords(u);
      const head = cmd.words;
      const rest = w.slice(head.length);
      if (rest.some((t) => t.startsWith("-") || t.includes("|") || t.includes("#") || (t.includes("<") && !/^<[^<>]+>$/.test(t)))) continue;
      const ph = rest.filter((t) => t.startsWith("<"));
      if (ph.length > 1) continue;
      if (!knowsReads && rest.some((t) => !t.startsWith("<") && !READ_WORDS.has(t))) continue;
      return { words: rest, placeholder: ph[0] ? placeholderKey(ph[0]) : null };
    }
    return null;
  };
  const readable = commands.filter((c) => c.effect === "private" && c !== waiter && (knowsReads ? c.readOnly === true : true));
  const plans = readable.map((c) => ({ cmd: c, plan: readPlan(c) }));
  type Planned = { cmd: CliCommand; plan: { words: string[]; placeholder: string | null } };
  const withPlan = plans.filter((p): p is Planned => p.plan !== null);
  const planned = [...withPlan.filter((p) => !p.plan.placeholder), ...withPlan.filter((p) => p.plan.placeholder)];
  const reads: { cmd: CliCommand; args: string[] }[] = [];
  const reports: { cmd: CliCommand; report: ChecksReport; json: RunResult & { shown: string }; text: RunResult & { shown: string } }[] = [];
  for (const { cmd, plan } of planned) {
    let words = plan.words;
    if (plan.placeholder) {
      const v = samples[plan.placeholder];
      if (!v) {
        rec.add("cli.read-json", cmd.name, "skip", `no sample for <${plan.placeholder}>; pass --sample ${plan.placeholder}=<value>`);
        continue;
      }
      words = words.map((t) => (t.startsWith("<") ? v : t));
    }
    const args = [...cmd.words, ...words];
    reads.push({ cmd, args });
    const c = await call([...args, "--json"]);
    if (c.timedOut) {
      const ls = lines(c.stdout).filter((l) => l.trim());
      if (!ls.length) rec.add("cli.read-json", cmd.name, "skip", `\`${c.shown}\` streamed nothing in ${opts.timeoutMs} ms`);
      else rec.add("cli.read-json", cmd.name, ls.every((l) => parseJson(l).ok) ? "pass" : "fail", `a stream: ${ls.length} lines${ls.every((l) => parseJson(l).ok) ? ", each JSON" : ", not all JSON"}`);
      continue;
    }
    const j = parseJson(c.stdout);
    // A check command's findings may exit with the declared findings code, as its report says.
    const findings = j.ok && isChecksReport(j.value) && findingsCode !== null && c.code === findingsCode && j.value.exitCode === findingsCode;
    const ok = (c.code === 0 || findings) && j.ok && !c.stderr.trim();
    rec.add("cli.read-json", cmd.name, ok ? "pass" : "fail", ok ? `\`${c.shown}\` → one JSON document${findings ? `, exit ${c.code} (findings)` : ""}` : `${brief(c)}${c.code === 0 && !j.ok ? "; stdout is not one JSON document" : ""}`);
    if (j.ok) harvest(j.value, samples, cmd.name.split(" ").at(-1)!);
    if (j.ok && isChecksReport(j.value)) reports.push({ cmd, report: j.value, json: c, text: await call(args) });
    const refs = ok && j.ok ? refsOf(j.value) : [];
    if (refs.length) {
      const t = await call(args);
      const missing = refs.filter((r) => !t.stdout.includes(r));
      rec.add("cli.text-refs", cmd.name, t.code === 0 && !missing.length ? "pass" : "fail", t.code !== 0 ? brief(t) : missing.length ? `\`${clip(t.shown, 120)}\` leaves out ${missing.length} of ${refs.length} refs, first: ${missing[0]}` : `each of ${refs.length} refs is in the text`);
    }
  }
  for (const { cmd, plan } of plans) {
    if (plan || cmd.usage.some((u) => requiredWords(u).length === cmd.words.length)) continue;
    // Every usage needs something: the bare command must fail and say what.
    const c = await call(cmd.words);
    const ok = c.code !== 0 && !c.timedOut && (usageCode === null || c.code === usageCode);
    rec.add("cli.missing-arg", cmd.name, ok ? "pass" : "fail", `${brief(c)}${usageCode !== null && c.code !== usageCode && c.code !== 0 ? `; usage exit code is ${usageCode}` : ""}`);
    if (c.code !== 0) errorChecks(`${cmd.name} (no argument)`, c);
  }

  // Flags: an unknown one, and a misspelt real one, on every read.
  const flagsOf = (cmd: CliCommand) =>
    [...new Set(cmd.usage.flatMap((u) => [...u.matchAll(/(?<![\w-])(--[a-z][\w-]+)( <[^>]+>| N\b)?/g)].map((m) => JSON.stringify({ flag: m[1], value: Boolean(m[2]) }))))]
      .map((s) => JSON.parse(s) as { flag: string; value: boolean })
      .filter((f) => !["--json", "--help", "--why", "--agent"].includes(f.flag));
  for (const { cmd, args } of reads) {
    const c = await call([...args, NO_SUCH_FLAG, "--json"]);
    const ok = c.code !== 0 && !c.timedOut && c.stderr.includes(NO_SUCH_FLAG);
    rec.add("cli.unknown-flag", cmd.name, ok ? "pass" : "fail", ok ? clip(firstLine(c.stderr)) : `${brief(c)}${c.code === 0 ? ": the flag was ignored" : ""}`);
    if (c.code !== 0 && !c.timedOut) errorChecks(`${cmd.name} ${NO_SUCH_FLAG}`, c);
    const f = flagsOf(cmd)[0];
    if (f) {
      const bad = misspell(f.flag);
      const m = await call([...args, bad, ...(f.value ? ["2"] : []), "--json"]);
      const refused = m.code !== 0 && !m.timedOut && m.stderr.includes(bad);
      rec.add("cli.unknown-flag", `${cmd.name} ${bad}`, refused ? "pass" : "fail", refused ? clip(firstLine(m.stderr)) : `${brief(m)}${m.code === 0 ? `: ${bad} was ignored, so the answer is not what was asked` : ""}`);
      const suggests = refused && m.stderr.includes(f.flag);
      rec.add("cli.flag-suggest", `${cmd.name} ${bad}`, suggests ? "pass" : "fail", suggests ? clip(firstLine(m.stderr)) : `${brief(m)}; does not name ${f.flag}`);
    }
  }

  if (stateBefore) {
    const d = stateDelta(stateBefore, await snapshot());
    rec.add("cli.reads-stay-reads", `${reads.length} reads, their flag probes and the missing-argument probes`, d.same ? "pass" : "fail", d.same ? `state: ${opts.state.join("; ")}` : `${opts.state.join("; ")} changed: ${refusalVerdict(d).note}`);
    if (!d.same) ctx.effects.push({ surface: "reads", note: refusalVerdict(d).note });
  } else rec.add("cli.reads-stay-reads", "state", "skip", stateNote);

  // Free text: a command that reads text from stdin ("-") must also take it as an argument: a quoted placeholder, a
  // placeholder where the "-" goes, `<text>|-`, or a text flag (--text <text>, --file <path>).
  for (const cmd of commands.filter((c) => c.effect === "private" || c.effect === "others")) {
    const stdinRe = /(^|\s|\||\{|\[)-(?=\s|$|\}|\]|\|)/;
    const stdin = cmd.usage.filter((u) => stdinRe.test(u));
    if (!stdin.length) continue;
    const forms = cmd.usage.map((u) => usageWords(u.replace(/\[[^[\]]*\]/g, " ")));
    const textFlag = cmd.usage.some((u) => /--(text|file|body|message)\s+<[^>]+>/.test(u));
    const quoted = cmd.usage.some((u) => /"<[^>]+>"/.test(u.replace(/--\w[\w-]* "<[^>]+>"/g, "")));
    const inPlace = forms.some((w) => {
      const i = w.indexOf("-");
      return i > 0 && forms.some((v) => v !== w && v[0] === w[0] && /^"?<[^>]+>"?$/.test(v[i] ?? "") && !v.includes("-"));
    });
    const altInline = stdin.some((u) => /\|\s*<[^>]+>\s*\|/.test(u) || /<[^>]+>\s*\|\s*-/.test(u));
    const ok = textFlag || quoted || inPlace || altInline;
    rec.add("cli.text-as-argument", cmd.name, ok ? "pass" : "fail", ok ? "an argument form is listed beside stdin" : `only stdin: ${clip(stdin.join("; "), 200)}`);
  }

  // Waiting: the wait command takes a conversation ref a read gave, and answers a typed wait.
  const convRef = ["conversation", "chat", "room", "channel"].map((k) => samples[k]).find(Boolean);
  if (waiter && convRef) {
    const waitedCode = exitCodes?.find((e) => /wait|didn.t happen|timed? ?out/i.test(JSON.stringify([e["name"], e["short"], e["meaning"]])))?.["code"];
    const c = await call([...waiter.words, convRef, "--timeout", "1s"], null, Math.max(opts.timeoutMs, 15_000));
    const ok = !c.timedOut && c.code !== usageCode && (c.code === 0 || (waitedCode !== undefined && c.code === Number(waitedCode)) || /resume|--cursor|nothing (yet|happened)/i.test(c.stdout + c.stderr));
    rec.add("cli.wait-on-refs", `${waiter.name} <conversation>`, ok ? "pass" : "fail", brief(c));
    const t = await call([...waiter.words, convRef, "--timeout", "1s", "--json"], null, Math.max(opts.timeoutMs, 15_000));
    const j = parseJson(t.stdout);
    const v = j.ok && isWait(j.value) ? validateWait(j.value) : null;
    rec.add("cli.wait-typed", `${waiter.name} <conversation> --json`, v?.ok ? "pass" : "fail", v ? (v.ok ? `wait/1, state ${String((j as { value: { state: string } }).value.state)}` : v.errors.join("; ")) : `${brief(t)}; not a wait/1`);
  } else if (waiter) {
    rec.add("cli.wait-on-refs", waiter.name, "skip", "no conversation ref harvested from the reads");
    rec.add("cli.wait-typed", waiter.name, "skip", "no conversation ref harvested from the reads");
  }

  // What other people see: refused paths, and a preview where the CLI offers one, only against a proven mock.
  const others = commands.filter((c) => c.effect === "others");
  const fill = (word: string, value: (key: string) => string | undefined) => word.replace(/<([^>]+)>/g, (_, p: string) => (/^name$/i.test(p) ? "ax-xray" : (value(placeholderKey(`<${p}>`)) ?? BOGUS)));
  if (others.length && !ctx.safety.ok) {
    for (const cmd of others) for (const id of ["cli.others-need-why", "cli.wrong-ref-first", "cli.others-preview", "cli.outcome", "cli.fact-before-voice", "cli.audience-named"]) rec.add(id, cmd.name, "skip", refusedNote(ctx.safety));
  }
  for (const cmd of ctx.safety.ok ? others : []) {
    const head = cmd.words;
    const words = usageWords(cmd.usage[0]!.replace(/\[[^[\]]*\]/g, " "));
    let input: string | null = null;
    const target: string[] = [];
    for (let i = head.length; i < words.length; i++) {
      const w = words[i]!;
      if (w === "--why") {
        i++;
        continue;
      }
      if (w === "-") input = "ax-xray probe text";
      target.push(w.includes("|") && !w.includes("<") ? w.split("|")[0]! : w.replace(/\|-$/, ""));
    }
    // Every reference is made up, even where a sample exists, so the call must be refused.
    const bogus = target.map((w) => fill(w, () => undefined));
    const pre = stateBefore ? await snapshot() : null;
    const noWhy = await call([...head, ...bogus], input);
    const whyOk = noWhy.code !== 0 && !noWhy.timedOut && /--why\b|\bwhy\b/i.test(noWhy.stderr);
    rec.add("cli.others-need-why", cmd.name, whyOk ? "pass" : "fail", brief(noWhy));
    if (noWhy.code !== 0 && !noWhy.timedOut) errorChecks(`${cmd.name} (no --why)`, noWhy);
    const wrong = await call([...head, ...bogus, "--why", WHY], input);
    const wrongOk = wrong.code !== 0 && !wrong.timedOut && teaches(wrong.stderr);
    rec.add("cli.wrong-ref-first", cmd.name, wrongOk ? "pass" : "fail", brief(wrong));
    if (wrong.code !== 0 && !wrong.timedOut) errorChecks(`${cmd.name} (wrong ref)`, wrong);
    if (pre) {
      const d = stateDelta(pre, await snapshot());
      const v = refusalVerdict(d);
      rec.add("cli.refusals-change-nothing", cmd.name, v.ok ? "pass" : "fail", v.note);
      if (!d.same) ctx.effects.push({ surface: `${cmd.name} (refused)`, note: v.note });
    }
    if (!/--dry-run\b/.test(helpText[cmd.name]!)) {
      rec.add("cli.others-preview", cmd.name, "fail", `\`${name} ${cmd.name} --help\` offers no --dry-run, so who will see it can only be learnt by doing it`);
      for (const id of ["cli.outcome", "cli.fact-before-voice", "cli.audience-named"]) rec.add(id, cmd.name, "skip", "no --dry-run to read an outcome from");
      continue;
    }
    // A sample may name a whole word (`--sample "<conversation>#<message id>=abc#123"`), or a word in one command (`react:<...>=...`).
    const wholeSample = (w: string) => opts.samples[`${cmd.name}:${w}`] ?? opts.samples[w];
    const realWord = (w: string) => {
      const whole = wholeSample(w);
      if (whole !== undefined) return whole;
      const keys = [...w.matchAll(/<([^>]+)>/g)].map((m) => placeholderKey(`<${m[1]}>`));
      // A harvested message ref already carries its conversation: "<conversation>#<message id>" is that ref alone.
      const last = samples[keys[keys.length - 1] ?? ""];
      if (keys.length > 1 && w.includes("#") && last?.includes("#")) return last;
      return fill(w, (k) => samples[k]);
    };
    const missing = target.filter((w) => wholeSample(w) === undefined).flatMap((w) => [...w.matchAll(/<([^>]+)>/g)].map((m) => placeholderKey(`<${m[1]}>`))).filter((k) => k !== "name" && !samples[k]);
    if (missing.length) {
      rec.add("cli.others-preview", cmd.name, "skip", `no sample for <${missing[0]}>; pass --sample ${missing[0]}=<value>`);
      for (const id of ["cli.outcome", "cli.fact-before-voice", "cli.audience-named"]) rec.add(id, cmd.name, "skip", `no sample for <${missing[0]}>`);
      continue;
    }
    const real = target.map(realWord);
    const before = stateBefore ? await snapshot() : null;
    const dry = await call([...head, ...real, "--why", WHY, "--dry-run"], input);
    const dryJson = await call([...head, ...real, "--why", WHY, "--dry-run", "--json"], input);
    const after = stateBefore ? await snapshot() : null;
    const unchanged = !before || JSON.stringify(before) === JSON.stringify(after);
    if (!unchanged && before && after) ctx.effects.push({ surface: `${cmd.name} --dry-run`, note: refusalVerdict(stateDelta(before, after)).note });
    const ok = dry.code === 0 && /\b(see|sees|seen|visible|will get|will know|notified)\b/i.test(dry.stdout) && unchanged;
    rec.add("cli.others-preview", cmd.name, ok ? "pass" : "fail", `${brief(dry)}${!unchanged ? "; the state changed" : ""}`);
    const j = parseJson(dryJson.stdout);
    if (!j.ok || !isOutcome(j.value)) {
      rec.add("cli.outcome", cmd.name, "fail", `${brief(dryJson)}; not an outcome/1`);
      for (const id of ["cli.fact-before-voice", "cli.audience-named"]) rec.add(id, cmd.name, "skip", "no outcome/1 to compare with");
      continue;
    }
    if (j.value.state !== "planned") rec.add("cli.outcome", cmd.name, "fail", `outcome/1 in state ${j.value.state}, not planned`);
    else {
      const v = validateOutcome(j.value);
      rec.add("cli.outcome", cmd.name, v.ok ? "pass" : "fail", v.ok ? `outcome/1, planned, audience: ${j.value.audience.who}` : v.errors.join("; "));
    }
    const summary = firstLine(j.value.summary);
    const first = firstLine(dry.stdout);
    rec.add("cli.fact-before-voice", cmd.name, first === summary ? "pass" : "fail", first === summary ? `starts: ${clip(first, 120)}` : `the text starts ${JSON.stringify(clip(first, 100))}, not the summary ${JSON.stringify(clip(summary, 100))}`);
    const who = audienceWho(j.value);
    rec.add("cli.audience-named", cmd.name, isGenericAudience(who) || !who.trim() ? "fail" : "pass", `audience.who: ${JSON.stringify(who)}`);
  }

  // Components: the twins the inventory's `ui` list binds. Reads and refused words run here; the follow that unlocks
  // what people say runs after the whole run's state check, since it is the one write the X-ray makes on purpose.
  const ui = (ctx.inventory?.ui ?? []).filter(isUiEntry);
  const wordsOf = (line: string) => {
    const w = splitCommand(line);
    return w[0] === name ? w.slice(1) : w;
  };
  const listed = help ? commands : [];
  /**
   * The command the leading words name, the longest first, as help --json lists it (none for a one-command tool's words).
   *
   * @claim "none for a one-command tool's words" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::a tool with one command conforms: its reads take the folder with no command word, and its help names none)
   */
  const commandOf = (ws: readonly string[]): CliCommand | null => {
    for (let n = ws.length; n >= 0; n--) {
      const found = listed.find((c) => c.words.join(" ") === ws.slice(0, n).join(" "));
      if (found) return found;
    }
    return null;
  };
  // The words with each `<placeholder>` filled from the samples, or the first placeholder that has none.
  const filled = (ws: readonly string[]): { args: string[] } | { missing: string } => {
    const args: string[] = [];
    for (const w of ws) {
      if (!/^<[^<>]+>$/.test(w)) {
        args.push(w);
        continue;
      }
      const v = samples[placeholderKey(w)];
      if (v === undefined) return { missing: placeholderKey(w) };
      args.push(v);
    }
    return { args };
  };
  const label = (e: UiEntry) => `${e.component} ${e.kind} ${e.id}`;
  const noSample = (key: string) => `no sample for <${key}>; pass --sample ${key}=<value>`;
  const refuses = (c: RunResult) => !c.timedOut && c.code !== 0;
  const privateRead = (c: CliCommand) => c.effect === "private" && c.readOnly !== false;
  // Why a read's twin may not run (it is no private read, and the target is not proven a mock), or null when it may.
  const blocked = (line: string) => {
    const cmd = commandOf(wordsOf(line));
    return (cmd !== null && privateRead(cmd)) || ctx.safety.ok ? null : `not run: \`${line}\` is no private read in help --json, and the target is not proven a mock`;
  };
  const isRefusal = (v: unknown) => (isOutcome(v) ? v.state === "refused" : isRecord(v) && isRecord(v["error"]));
  const personOnlyList = [at(help, "personOnly")].flat().filter(isRecord);
  const recordFields = (e: UiEntry, fields: readonly string[], c: RunResult & { shown: string }) => {
    const keys = keysOf(jsonValue(c.stdout));
    const lacks = fields.filter((f) => !keys.has(f));
    const bad = problemsOf([[c.code !== 0, brief(c)], [lacks.length > 0, `\`${c.shown}\` has no ${lacks.join(", ")}`]]);
    rec.add("ui.read-fields", label(e), bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : `has ${fields.join(", ")}`);
  };
  // The follow each listening read answered with, the read's words and fields, for the consented reads.
  const resumes = new Map<UiEntry, { resume: string; twin: string[]; fields: readonly string[] }>();
  for (const e of ui) {
    if (e.kind === "action" && isReservedPersonOnly(e.id)) {
      const theirs = typeof e.personOnly === "string";
      rec.add("ui.reserved-person-only", label(e), theirs ? "pass" : "fail", theirs ? "person-only" : `"${e.id}" is the person's own, and this entry is not person-only`);
    }
    if (e.kind === "action" && typeof e.personOnly === "string" && typeof e.refuseAs !== "string") rec.add("ui.person-only-refuses", label(e), "fail", "it has no refuseAs words, so nothing shows that the words an agent might try refuse");
    if (e.kind === "action" && typeof e.personOnly === "string" && typeof e.twin === "string") rec.add("ui.person-only-refuses", label(e), "fail", `it is person-only but has a twin, \`${e.twin}\`, so an agent could do it`);
    for (const twin of [e.twin, e.push].filter((t): t is string => typeof t === "string")) {
      const cmd = commandOf(wordsOf(twin));
      const surface = `${label(e)}${twin === e.push ? " stream" : ""}`;
      rec.add("ui.twin-exists", surface, cmd ? "pass" : "fail", cmd ? `\`${twin}\` is \`${name} ${cmd.name}\`` : help ? `\`${twin}\` names no command in help --json` : "no help JSON to find the twin in");
      const matches = cmd !== null && (e.kind === "action" ? cmd.effect === e.effect : privateRead(cmd));
      const wanted = e.kind === "action" ? `the action is ${String(e.effect)}` : "the read wants a private read";
      rec.add("ui.twin-effect-matches", surface, cmd ? (matches ? "pass" : "fail") : "skip", cmd ? `${wanted}; \`${name} ${cmd.name}\` is ${String(cmd.effect)}${e.kind === "read" && cmd.readOnly === false ? ", not a read" : ""}` : "the twin is no command (ui.twin-exists)");
    }
    if (typeof e.refuseAs === "string") {
      if (!ctx.safety.ok) rec.add("ui.person-only-refuses", label(e), "skip", refusedNote(ctx.safety));
      else {
        const ws = wordsOf(e.refuseAs);
        const pre = stateBefore ? await snapshot() : null;
        const text = await call(ws);
        const json = await call([...ws, "--json"]);
        const d = pre ? stateDelta(pre, await snapshot()) : null;
        const verdict = d ? refusalVerdict(d) : { ok: true, note: "" };
        const entry = personOnlyList.find((p) => p["name"] === ws.join(" "));
        const reason = String(at(entry, "reason")).trim().replace(/[.\s]+$/, "");
        const bad = problemsOf([
          [!refuses(text), `${brief(text)}: it did not refuse`],
          [usageCode !== null && refuses(text) && text.code !== usageCode, `exit ${text.code}, not the usage code ${usageCode}`],
          [!refuses(json) || !isRefusal(jsonValue(json.stdout)), `${brief(json)}: no refused outcome or error`],
          [usageCode !== null && refuses(json) && json.code !== usageCode, `--json exit ${json.code}, not the usage code ${usageCode}`],
          [!entry, `help --json lists no personOnly "${ws.join(" ")}"`],
          [entry !== undefined && !text.stderr.includes(reason), `the refusal does not name the reason help gives ("${clip(reason, 80)}")`],
          [!verdict.ok, `the state changed: ${verdict.note}`],
        ]);
        rec.add("ui.person-only-refuses", label(e), bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : clip(firstLine(text.stderr)));
        if (d && !d.same) ctx.effects.push({ surface: `${e.refuseAs} (refused)`, note: verdict.note });
        if (refuses(text)) errorChecks(e.refuseAs, text);
      }
    }
    if (e.kind === "action" && e.scope === "self" && typeof e.twin === "string") {
      // Who is calling, and a call on an item that is not theirs: run as an agent that owns nothing, on a mock.
      const ws = wordsOf(e.twin);
      const flagAt = ws.indexOf("--agent");
      const cmd = commandOf(ws);
      const bad: string[] = problemsOf([
        [flagAt < 0 || !/^<[^<>]+>$/.test(String(ws[flagAt + 1])), "its twin does not say who is calling (--agent <me>), so it cannot tell the caller's own item from another's"],
        [cmd !== null && cmd.scope !== "self", `\`${name} ${cmd?.name}\` does not check the owner: help --json gives it no scope: "self"`],
      ]);
      const probe = filled(ws.map((w, i) => (i === flagAt + 1 && flagAt >= 0 ? STRANGER : w)));
      if (cmd === null || !ctx.safety.ok || "missing" in probe) {
        const why = cmd === null ? "the twin is no command (ui.twin-exists)" : !ctx.safety.ok ? refusedNote(ctx.safety) : noSample((probe as { missing: string }).missing);
        rec.add("ui.self-scope-refuses", label(e), bad.length ? "fail" : "skip", bad.length ? bad.join("; ") : why);
      } else {
        const pre = stateBefore ? await snapshot() : null;
        const text = await call(probe.args);
        const json = await call([...probe.args, "--json"]);
        const d = pre ? stateDelta(pre, await snapshot()) : null;
        const verdict = d ? refusalVerdict(d) : { ok: true, note: "" };
        bad.push(
          ...problemsOf([
            [!refuses(text), `\`${clip(text.shown, 100)}\`, as ${STRANGER}, who owns nothing → exit ${text.code}: it did not refuse`],
            [usageCode !== null && refuses(text) && text.code !== usageCode, `exit ${text.code}, not the usage code ${usageCode}`],
            [!refuses(json) || !isRefusal(jsonValue(json.stdout)), `${brief(json)}: no refused outcome or error`],
            [!verdict.ok, `the state changed: ${verdict.note}`],
          ]),
        );
        rec.add("ui.self-scope-refuses", label(e), bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : clip(firstLine(text.stderr)));
        if (d && !d.same) ctx.effects.push({ surface: `${text.shown} (as ${STRANGER})`, note: verdict.note });
        if (refuses(text)) errorChecks(`${e.twin} (as ${STRANGER})`, text);
      }
    }
    if (e.kind !== "read" || typeof e.twin !== "string") continue;
    const fields = e.fields ?? [];
    const stopped = blocked(e.twin);
    if (stopped) {
      for (const id of e.consent === "listening" ? ["ui.listening-needs-yes", "cli.listening-push-filtered"] : ["ui.read-fields"]) rec.add(id, label(e), "skip", stopped);
      continue;
    }
    const twin = filled(wordsOf(e.twin));
    if ("missing" in twin) {
      rec.add(e.consent === "listening" ? "ui.listening-needs-yes" : "ui.read-fields", label(e), "skip", noSample(twin.missing));
      continue;
    }
    if (e.consent !== "listening") {
      recordFields(e, fields, await call([...twin.args, "--json"]));
      continue;
    }
    // What people say: before a follow the read and its triggered stream answer needs-human; every line refuses.
    const stream = typeof e.push === "string" && typeof e.trigger === "string" && blocked(e.push) === null ? { push: e.push, trigger: e.trigger } : null;
    if (typeof e.push === "string" && stream === null) rec.add("cli.listening-push-filtered", label(e), "skip", blocked(e.push) ?? "no trigger is bound for the stream");
    const probes = [twin.args, ...(stream ? [[...wordsOf(stream.push), ...splitCommand(stream.trigger)]] : [])];
    for (const probe of probes) {
      const words = filled(probe);
      if ("missing" in words) {
        rec.add("ui.listening-needs-yes", label(e), "skip", noSample(words.missing));
        continue;
      }
      const c = await call([...words.args, "--json"]);
      const v = jsonValue(c.stdout);
      const resume = String(at(v, "human.resume.command"));
      const state = String(at(v, "state"));
      const extra = isOutcome(v) ? outcomeExtras(v) : [];
      const ok = !c.timedOut && isOutcome(v) && state === "needs-human" && validateOutcome(v).ok && commandOf(wordsOf(resume)) !== null && !extra.length;
      const why = firstOf(
        [
          [!isOutcome(v), `${brief(c)}; not an outcome, so it may be what people say`],
          [state !== "needs-human", `outcome in state ${state}, not needs-human`],
          [extra.length > 0, `the outcome also carries ${extra.join(", ")}`],
          [!ok, `needs-human without a resume command help lists (${clip(resume, 100)})`],
        ],
        `needs-human; resume: ${clip(resume, 120)}`,
      );
      rec.add("ui.listening-needs-yes", `${label(e)} (\`${clip(c.shown, 80)}\`)`, ok ? "pass" : "fail", why);
      if (ok && !resumes.has(e)) resumes.set(e, { resume, twin: twin.args, fields });
    }
    if (stream) {
      const words = filled(wordsOf(stream.push));
      if ("missing" in words) {
        rec.add("cli.listening-push-filtered", label(e), "skip", noSample(words.missing));
        continue;
      }
      const c = await call([...words.args, "--json"]);
      const values = [jsonValue(c.stdout), ...lines(c.stdout).map(jsonValue)];
      const leaked = fields.filter((f) => values.some((x) => !isOutcome(x) && keysOf(x).has(f)));
      const carried = values.filter(isOutcome).flatMap(outcomeExtras);
      const flag = String(splitCommand(stream.trigger)[0]);
      const bad = problemsOf([
        [!refuses(c), `${brief(c)}: it did not refuse`],
        [leaked.length > 0, `it delivered ${leaked.join(", ")}`],
        [carried.length > 0, `the refusal also carries ${[...new Set(carried)].join(", ")}`],
        [!isRefusal(jsonValue(c.stdout)), "no refused outcome or error"],
        [!`${c.stdout}\n${c.stderr}`.includes(flag), `it names no ${flag}`],
      ]);
      rec.add("cli.listening-push-filtered", `${label(e)} (\`${clip(c.shown, 80)}\`)`, bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : `refused, naming ${flag}`);
    }
  }
  /** The person's yes on the mock: follow, then read what people say, its fields, and again from its cursor. */
  const consented = async () => {
    for (const e of ui.filter((x) => x.kind === "read" && x.consent === "listening")) {
      const skip = (note: string) => {
        for (const id of ["ui.read-fields", "cli.listening-cursor"]) rec.add(id, label(e), "skip", note);
      };
      const found = resumes.get(e);
      if (!ctx.safety.ok) {
        skip(refusedNote(ctx.safety));
        continue;
      }
      if (!found) {
        skip("the read gave no follow command to resume with (ui.listening-needs-yes)");
        continue;
      }
      const rw = wordsOf(found.resume);
      const follow = filled(rw.map((w, i) => (rw[i - 1] === "--why" ? WHY : w)));
      if ("missing" in follow) {
        skip(`no sample for <${follow.missing}> in the follow command`);
        continue;
      }
      const f = await call(follow.args);
      if (f.code !== 0) {
        skip(`the follow failed: ${brief(f)}`);
        continue;
      }
      ctx.effects.push({ surface: f.shown, note: "the person's yes, on the mock: followed, to read what people say" });
      const first = await call([...found.twin, "--json"]);
      recordFields(e, found.fields, first);
      const v1 = jsonValue(first.stdout);
      const cursor = at(v1, "cursor");
      if (typeof cursor !== "string") {
        rec.add("cli.listening-cursor", label(e), "fail", `\`${first.shown}\` gives no cursor`);
        continue;
      }
      const seen = itemsOf(v1);
      if (!seen.length) {
        rec.add("cli.listening-cursor", label(e), "skip", `\`${first.shown}\` answered no lines to read past`);
        continue;
      }
      const again = await call([...found.twin, "--cursor", cursor, "--json"]);
      const v2 = jsonValue(again.stdout);
      const repeated = itemsOf(v2).filter((x) => seen.includes(x));
      const bad = problemsOf([
        [again.code !== 0, brief(again)],
        [typeof at(v2, "cursor") !== "string", `\`${again.shown}\` gives no next cursor`],
        [repeated.length > 0, `\`${again.shown}\` repeats a line it already gave: ${clip(String(repeated[0]), 120)}`],
      ]);
      rec.add("cli.listening-cursor", label(e), bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : `from ${cursor}: no line again, and a next cursor`);
    }
  };

  // Work events, read through the interface.
  if (opts.events) {
    const c = await call(splitCommand(opts.events));
    const j = parseJson(c.stdout);
    const list = j.ok ? (Array.isArray(j.value) ? j.value : isRecord(j.value) && Array.isArray(j.value["events"]) ? j.value["events"] : null) : lines(c.stdout).every((l) => parseJson(l).ok) && c.stdout.trim() ? lines(c.stdout).map((l) => JSON.parse(l) as unknown) : null;
    if (!list) rec.add("cli.work-events", opts.events, "fail", `${brief(c)}; not a list of events`);
    else {
      const bad = list.map((e) => checkWorkEvent(e)).filter((r): r is { ok: false; problem: string; fix: string } => !r.ok);
      rec.add("cli.work-events", opts.events, bad.length ? "fail" : "pass", bad[0] ? `${bad.length} of ${list.length} events are not work-event/1; first: ${bad[0].problem}. Fix: ${bad[0].fix}` : `${list.length} events, each work-event/1`);
    }
  } else rec.add("cli.work-events", "events", "skip", "no --events command given");

  // The whole run: what the X-ray changed, which must be nothing but refusal records.
  if (runStart) {
    const d = stateDelta(runStart, await snapshot());
    const v = refusalVerdict(d);
    rec.add("cli.refusals-change-nothing", "the whole run", v.ok ? "pass" : "fail", v.ok ? `planned effects: none; ${v.note}` : `an unplanned write: ${v.note}`);
    if (!d.same) ctx.effects.push({ surface: "the whole run", note: v.note });
  }

  await consented();

  // Across every call: voice only on a terminal, JSON alone under --json, commands named are listed.
  const isVoice = (l: string) => voiceLines.includes(l.trim());
  const voiced = (c: RunResult) => lines(`${c.stdout}\n${c.stderr}`).find(isVoice);
  const jsonCalls = calls.filter((c) => c.args.includes("--json") && !c.timedOut);
  const jsonAlone = (out: string) => out === "" || parseJson(out).ok || lines(out).filter((l) => l.trim()).every((l) => parseJson(l).ok);
  const notJsonAlone = jsonCalls.filter((c) => voiced(c) !== undefined || !jsonAlone(c.stdout.trim()));
  for (const c of notJsonAlone) rec.add("cli.voice-off-in-json", c.shown, "fail", voiced(c) !== undefined ? `prints the voice line ${JSON.stringify(voiced(c))}` : `stdout is not JSON alone: ${clip(firstLine(c.stdout), 160)}`);
  if (!notJsonAlone.length) rec.add("cli.voice-off-in-json", `all ${jsonCalls.length} --json calls`, "pass", "JSON alone");
  if (!voiceLines.length) rec.add("cli.voice-off-when-piped", "help --json", "skip", "the CLI lists no voice lines in help --json (voice)");
  else {
    const loud = calls.filter((c) => voiced(c) !== undefined);
    for (const c of loud) rec.add("cli.voice-off-when-piped", c.shown, "fail", `prints the voice line ${JSON.stringify(voiced(c))} into a pipe`);
    if (!loud.length) rec.add("cli.voice-off-when-piped", `all ${calls.length} calls`, "pass", `none of ${voiceLines.length} voice lines appears`);
  }
  {
    const listedHeads = new Set(overviewLines.flatMap((l) => {
      const m = /^ {2,4}([a-z][\w-]*(?:, [a-z][\w-]*)*):? {2,}\S/.exec(l);
      return m ? m[1]!.split(", ") : [];
    }));
    const heads = new Set(unique.map((n) => n.split(" ")[0]!));
    const namedBy = new Map<string, string>();
    const pattern = new RegExp(`(?:^|[\\s"'\`(])${escapeRe(name)} ([a-z][\\w-]*)`, "g");
    for (const c of calls) {
      // A command's own help names it; that is not a pointer to it.
      const own = c.args.at(-1) === "--help" && c.args.length > 1 ? c.args[0] : null;
      for (const m of `${c.stdout}\n${c.stderr}`.matchAll(pattern)) {
        const word = m[1]!;
        if (word !== own && heads.has(word) && !namedBy.has(word)) namedBy.set(word, c.shown);
      }
    }
    const unlisted = [...namedBy].filter(([word]) => !listedHeads.has(word));
    for (const [word, where] of unlisted) rec.add("cli.named-is-listed", word, "fail", `\`${clip(where, 120)}\` names \`${name} ${word}\`, which ${name} --help does not list`);
    if (!unlisted.length) rec.add("cli.named-is-listed", `${namedBy.size} commands named`, "pass", namedBy.size ? `each is in --help: ${[...namedBy.keys()].join(", ")}` : "no output names a command");
  }

  // A check command's verdict: the text's first line holds the JSON's summary, timings aside, and both exit alike.
  const untimed = (s: string) => s.replace(/(?:under )?(?:\d+m \d{2}s|\d+(?:\.\d+)?s\b)/g, "<time>");
  if (!reports.length) rec.add("cli.check-verdict", "reads", "skip", "no read's --json is a checks report (ax-checks)");
  for (const { cmd, report, json, text } of reports) {
    const first = stripAnsi(firstLine(text.stdout));
    const leads = untimed(first).includes(untimed(report.summary));
    const same = text.code === json.code && json.code === report.exitCode;
    const note = !leads ? `\`${clip(text.shown, 120)}\` starts "${clip(first, 120)}", not the verdict "${clip(report.summary, 120)}"` : `exit ${text.code} as text, ${json.code} with --json, ${report.exitCode} in the report`;
    rec.add("cli.check-verdict", cmd.name, leads && same ? "pass" : "fail", leads && same ? `first line: ${clip(first, 160)}` : note);
  }

  // No message asks for a developer command or a repository path: help in full, and of the rest only what speaks to
  // the agent or the person (stderr, a failed call's text, and the next, human, error and fix fields of its JSON).
  {
    // A step marked sourceCheckout in a call's --json lets the same command pass in that call's text, and nowhere else.
    const twin = (c: { args: string[] }) => c.args.filter((a) => a !== "--json").join(" ");
    const marked = calls.flatMap((c) => {
      const j = parseJson(c.stdout);
      return j.ok ? sourceCheckoutTexts(j.value).map((text) => [twin(c), text] as const) : [];
    });
    const found = new Map<string, string>();
    for (const c of calls) {
      const isHelp = c.args[0] === "help" || c.args.includes("--help");
      const j = parseJson(c.stdout);
      const exempt = marked.filter(([key]) => key === twin(c)).map(([, text]) => text);
      const say = (where: string, match: string, text: string) => {
        if (!exempt.includes(match) && !found.has(match)) found.set(match, `\`${clip(c.shown, 80)}\` ${where}: ${JSON.stringify(clip(text, 120))} asks for \`${match}\``);
      };
      if (j.ok) for (const f of devCommandsIn(j.value, { messagesOnly: !isHelp })) say(f.where, f.match, f.text);
      const text = [c.stderr, ...(!j.ok && (isHelp || c.code !== 0) ? [c.stdout] : [])];
      for (const line of lines(text.join("\n"))) {
        const f = devCommandIn(line);
        if (f) say("prints", f.match, line.trim());
      }
    }
    for (const [match, note] of found) rec.add("cli.no-dev-commands", match, "fail", note);
    if (!found.size) rec.add("cli.no-dev-commands", `all ${calls.length} calls`, "pass", "no developer command or repository path in help, errors, refusals or next steps");
  }

  // No failure is vague: help in full, and of the rest what speaks to the agent or the person, as above, plus an Ouro
  // AX answer's summary and its findings. A text the allow-list lets through passes with the entry's reason.
  {
    const found = new Map<string, string>();
    const allowed = new Map<string, string>();
    for (const c of calls) {
      const isHelp = c.args[0] === "help" || c.args.includes("--help");
      const j = parseJson(c.stdout);
      const say = (where: string, phrase: string, text: string, entry: FailureCopyAllow | null) => {
        if (entry) allowed.set(entry.match, entry.reason);
        else if (!found.has(text)) found.set(text, `\`${clip(c.shown, 80)}\` ${where}: ${JSON.stringify(clip(text, 120))} says "${phrase}" and not what happened or why`);
      };
      if (j.ok) for (const f of vagueFailuresIn(j.value, { messagesOnly: !isHelp, allow: ctx.allow })) say(f.where, f.phrase, f.text, f.allowed);
      const text = [c.stderr, ...(!j.ok && (isHelp || c.code !== 0) ? [c.stdout] : [])];
      for (const line of lines(text.join("\n"))) {
        const phrase = vagueFailureIn(line);
        if (phrase) say("prints", phrase, line.trim(), ctx.allow.find((e) => line.includes(e.match)) ?? null);
      }
    }
    for (const [text, note] of found) rec.add("copy.precise-failure", clip(text, 60), "fail", note);
    for (const [match, reason] of allowed) rec.add("copy.precise-failure", clip(match, 60), "pass", `allowed: ${reason}`);
    if (!found.size && !allowed.size) rec.add("copy.precise-failure", `all ${calls.length} calls`, "pass", "every failure in help, errors, refusals, outcomes and findings says what happened");
  }

  // Across every call.
  const traced = calls.filter((c) => hasStack(c.stdout) || hasStack(c.stderr));
  if (traced.length) for (const c of traced) rec.add("cli.no-stack-trace", c.shown, "fail", clip(c.stderr.split("\n").slice(0, 3).join(" | ")));
  else rec.add("cli.no-stack-trace", `all ${calls.length} calls`, "pass");
  if (documented) {
    const known = documented;
    const bad = calls.filter((c) => !c.timedOut && !known.has(c.code!));
    if (bad.length) for (const c of bad) rec.add("cli.exit-codes", c.shown, "fail", `exit ${c.code} is not documented (${[...known].join(", ")})`);
    else rec.add("cli.exit-codes", `all ${calls.length} calls`, "pass", `documented: ${[...known].join(", ")}`);
  } else rec.add("cli.exit-codes", "help", "fail", "no exit codes in help --json or an `Exit codes:` line");
  // Piped output is plain, and NO_COLOR wins even where colour is forced.
  const forced = { ...(await run([...base, "--help"], { ...env, NO_COLOR: "1", FORCE_COLOR: "1" }, opts.timeoutMs)), shown: `NO_COLOR=1 FORCE_COLOR=1 ${name} --help` };
  const redraws = (t: string) => /\r(?!\n)/.test(t);
  const decorated = [...calls, forced].filter((c) => hasAnsi(c.stdout + c.stderr) || redraws(c.stdout + c.stderr));
  if (decorated.length) for (const c of decorated) rec.add("cli.plain-pipe", c.shown, "fail", hasAnsi(c.stdout + c.stderr) ? `escape codes in piped output: ${clip(JSON.stringify(firstLine(c.stdout + c.stderr)), 140)}` : "a carriage return redraws piped output");
  else rec.add("cli.plain-pipe", `all ${calls.length + 1} calls`, "pass", "plain text, NO_COLOR beside FORCE_COLOR included");

  return { name, calls: calls.length, commands: unique.length };
}

function stripKeys(value: unknown, keys: readonly string[]): unknown {
  if (!keys.length) return value;
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)).map(([k, v]) => [k, stripKeys(v, keys)]));
  return value;
}

interface RoutesManifest {
  base?: string;
  routes?: string[];
  state?: string[];
  skip?: string[];
  others?: { route: string; why?: string; body?: Record<string, unknown> }[];
}

interface HttpAnswer {
  status: number;
  type: string;
  text: string;
  json: Parsed;
}

async function checkHttp(ctx: Context) {
  const { rec, opts } = ctx;
  const manifest = JSON.parse(readFileSync(opts.routes!, "utf8")) as RoutesManifest;
  const origin = opts.http!.replace(/\/$/, "");
  const basePath = manifest.base ?? "/api";
  const routes = manifest.routes ?? [];
  const stateRoutes = manifest.state ?? [];
  let count = 0;
  const req = async (method: string, p: string, body?: unknown): Promise<HttpAnswer> => {
    count++;
    try {
      const r = await fetch(origin + p, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(opts.timeoutMs), redirect: "manual" });
      const text = await r.text();
      return { status: r.status, type: r.headers.get("content-type") ?? "", text, json: parseJson(text) };
    } catch (e) {
      return { status: 0, type: "", text: (e as Error).message, json: { ok: false } };
    }
  };
  const errorOf = (r: HttpAnswer) => (r.json.ok && isRecord(r.json.value) && typeof r.json.value["error"] === "string" ? r.json.value["error"] : null);
  const brief = (method: string, p: string, r: HttpAnswer) => `\`${method} ${p}\` → ${r.status}${r.text ? ` ${clip(r.text.replace(/\s+/g, " "), 160)}` : ""}`;
  const teaches = (msg: string) => IMPERATIVE.test(msg) || /\b(GET|POST|PUT|DELETE|PATCH) \//.test(msg) || msg.includes(`${basePath}/`) || /(^|\s)--[a-z]/.test(msg) || (opts.name ? msg.includes(`${opts.name} `) : false);
  const errorChecks = (surface: string, method: string, p: string, r: HttpAnswer) => {
    const error = errorOf(r);
    rec.add("http.error-shape", surface, error !== null ? "pass" : "fail", brief(method, p, r));
    const t = error !== null && teaches(error);
    rec.add("http.error-teaches", surface, t ? "pass" : "fail", error !== null ? (t ? clip(error) : `"${clip(error)}" names no route, flag or command`) : brief(method, p, r));
  };
  const snapshot = async () => {
    const out: string[] = [];
    for (const s of stateRoutes) {
      const r = await req("GET", s.split(" ")[1] ?? s);
      out.push(r.json.ok ? JSON.stringify(stripKeys(r.json.value, opts.volatile)) : r.text);
    }
    return out;
  };
  let stateBefore: string[] | null = null;
  if (stateRoutes.length) {
    const a = await snapshot();
    const b = await snapshot();
    if (JSON.stringify(a) === JSON.stringify(b)) stateBefore = b;
  }
  recordInventory(rec, "http.inventory", ctx.inventory?.http ? compareInventory(ctx.inventory.http, routes) : null, "the routes manifest");

  // The index.
  {
    const r = await req("GET", basePath);
    const text = r.json.ok ? JSON.stringify(r.json.value) : "";
    const named = routes.filter((rt) => text.includes(rt) || text.includes(rt.split(" ")[1]!));
    const ok = r.status === 200 && r.json.ok && named.length >= routes.length * 0.8;
    rec.add("http.index", `GET ${basePath}`, ok ? "pass" : "fail", `${brief("GET", basePath, r)}; names ${named.length} of ${routes.length} routes`);
  }
  // An unknown route.
  {
    const p = `${basePath}/ax-xray-no-such-route`;
    const r = await req("GET", p);
    const error = errorOf(r);
    const ok = r.status === 404 && error !== null && teaches(error);
    rec.add("http.unknown-route", `GET ${p}`, ok ? "pass" : "fail", brief("GET", p, r));
    if (r.status >= 400) errorChecks(`GET ${p}`, "GET", p, r);
  }
  // Every read route.
  for (const rt of routes) {
    const [method, p = ""] = rt.split(" ");
    if (method !== "GET" || p.includes("?") || (manifest.skip ?? []).includes(rt)) continue;
    const real = p.replace(/\{[^}]+\}/g, BOGUS);
    const r = await req("GET", real);
    const json = /json/i.test(r.type) && r.json.ok;
    rec.add("http.json", rt, json ? "pass" : "fail", json ? `${r.status}` : brief("GET", real, r));
    if (p.includes("{")) {
      const error = errorOf(r);
      const ok = r.status >= 400 && r.status < 500 && error !== null && teaches(error);
      rec.add("http.wrong-ref-first", rt, ok ? "pass" : "fail", brief("GET", real, r));
    }
    if (r.status >= 400) errorChecks(rt, "GET", real, r);
  }
  if (stateBefore) {
    const d = stateDelta(stateBefore, await snapshot());
    rec.add("http.reads-stay-reads", `${count} GET requests`, d.same ? "pass" : "fail", `${stateRoutes.join("; ")}${d.same ? " unchanged" : ` changed: ${refusalVerdict(d).note}`}`);
    if (!d.same) ctx.effects.push({ surface: "GET requests", note: refusalVerdict(d).note });
  } else rec.add("http.reads-stay-reads", "state", "skip", stateRoutes.length ? "the state routes answer differently with nothing run between them" : "the manifest names no state routes");
  // What other people see: refused probes only, and only against a proven mock.
  for (const probe of manifest.others ?? []) {
    const label = `${probe.route}${typeof probe.body?.["action"] === "string" ? ` (${probe.body["action"]})` : ""}`;
    if (!ctx.safety.ok) {
      for (const id of ["http.others-need-why", "http.wrong-ref-first"]) rec.add(id, label, "skip", refusedNote(ctx.safety));
      continue;
    }
    const pre = stateBefore ? await snapshot() : null;
    const [method = "POST", p = ""] = probe.route.split(" ");
    const real = p.replace(/\{[^}]+\}/g, BOGUS);
    const body = JSON.parse(JSON.stringify(probe.body ?? {}).replaceAll("{ref}", BOGUS)) as Record<string, unknown>;
    const whyField = probe.why ?? "why";
    const noWhy = await req(method, real, body);
    const whyOk = noWhy.status >= 400 && noWhy.status < 500 && noWhy.text.includes(whyField);
    rec.add("http.others-need-why", label, whyOk ? "pass" : "fail", brief(method, real, noWhy));
    if (noWhy.status >= 400) errorChecks(`${label} (no ${whyField})`, method, real, noWhy);
    const wrong = await req(method, real, { ...body, [whyField]: WHY });
    const error = errorOf(wrong);
    const wrongOk = wrong.status >= 400 && wrong.status < 500 && error !== null && teaches(error);
    rec.add("http.wrong-ref-first", label, wrongOk ? "pass" : "fail", brief(method, real, wrong));
    if (wrong.status >= 400) errorChecks(`${label} (wrong ref)`, method, real, wrong);
    if (pre) {
      const d = stateDelta(pre, await snapshot());
      const v = refusalVerdict(d);
      rec.add("http.refusals-change-nothing", label, v.ok ? "pass" : "fail", v.note);
      if (!d.same) ctx.effects.push({ surface: `${label} (refused)`, note: v.note });
    }
  }
  return { origin, routes: routes.length, requests: count };
}

interface RpcReply {
  id?: unknown;
  result?: { tools?: unknown; content?: { text?: string }[]; isError?: boolean };
  error?: { message?: string; data?: unknown };
}

async function checkMcp(ctx: Context) {
  const { rec, opts } = ctx;
  const argv = splitCommand(opts.mcp!);
  const child = spawn(argv[0]!, argv.slice(1), { env: ctx.env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiting = new Map<number, (v: RpcReply) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const j = parseJson(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const reply = j.ok && isRecord(j.value) ? (j.value as RpcReply) : null;
      const answer = typeof reply?.id === "number" ? waiting.get(reply.id) : undefined;
      if (reply && answer) {
        waiting.delete(reply.id as number);
        answer(reply);
      }
    }
  });
  // A server that cannot start answers nothing, which the requests report; its stdin may already be closed.
  /* node:coverage disable */
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  /* node:coverage enable */
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<RpcReply>((done) => {
      const my = ++id;
      const t = setTimeout(() => {
        waiting.delete(my);
        done({ error: { message: `no answer to ${method} in ${opts.timeoutMs} ms` } });
      }, opts.timeoutMs);
      waiting.set(my, (v) => {
        clearTimeout(t);
        done(v);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    });
  const textOf = (r: RpcReply) => (r.error ? JSON.stringify(r.error) : (r.result?.content ?? []).map((c) => c.text ?? "").join(" "));
  const refused = (r: RpcReply) => Boolean(r.error) || r.result?.isError === true;
  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ax-xray", version: XRAY_VERSION } });
    if (init.error) {
      rec.add("mcp.tools-list", "initialize", "fail", textOf(init));
      return { tools: 0 };
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await request("tools/list", {});
    const tools = Array.isArray(list.result?.tools) ? list.result.tools.filter(isRecord) : null;
    if (!tools) {
      rec.add("mcp.tools-list", "tools/list", "fail", textOf(list) || "no tools array");
      return { tools: 0 };
    }
    recordInventory(rec, "mcp.inventory", ctx.inventory?.mcp ? compareInventory(ctx.inventory.mcp, tools.map((t) => String(t["name"]))) : null, "tools/list");
    for (const t of tools) {
      const tname = String(t["name"]);
      const schema = t["inputSchema"];
      const ok = typeof t["description"] === "string" && t["description"].trim() !== "" && isRecord(schema);
      rec.add("mcp.tools-list", tname, ok ? "pass" : "fail", ok ? clip(String(t["description"]), 120) : `missing ${typeof t["description"] === "string" && t["description"].trim() ? "inputSchema" : "description"}`);
      const a = isRecord(t["annotations"]) ? t["annotations"] : {};
      const ann = typeof a["readOnlyHint"] === "boolean" || typeof a["destructiveHint"] === "boolean";
      rec.add("mcp.effect-annotated", tname, ann ? "pass" : "fail", ann ? JSON.stringify(a) : "no readOnlyHint or destructiveHint");
      const required = isRecord(schema) && Array.isArray(schema["required"]) ? schema["required"].map(String) : [];
      if (required.length && a["readOnlyHint"] !== true && !ctx.safety.ok) rec.add("mcp.bad-call-teaches", tname, "skip", refusedNote(ctx.safety));
      else if (required.length) {
        const r = await request("tools/call", { name: tname, arguments: {} });
        const text = textOf(r);
        const ok2 = refused(r) && required.some((f) => text.includes(f));
        rec.add("mcp.bad-call-teaches", tname, ok2 ? "pass" : "fail", `${refused(r) ? "refused" : "ran"}: ${clip(text || "(no text)")}`);
      }
    }
    const u = await request("tools/call", { name: "ax_xray_no_such_tool", arguments: {} });
    const ut = textOf(u);
    const ok = refused(u) && (ut.includes("tools/list") || tools.some((t) => ut.includes(String(t["name"]))));
    rec.add("mcp.unknown-tool", "ax_xray_no_such_tool", ok ? "pass" : "fail", `${refused(u) ? "refused" : "ran"}: ${clip(ut || "(no text)")}`);
    return { tools: tools.length };
  } finally {
    child.kill();
  }
}

interface ClaimSummary extends Claim {
  pass: number;
  fail: number;
  skip: number;
  holds: boolean;
  failing: CheckResult[];
  skipped: CheckResult[];
}

interface Report {
  tool: "ax-xray";
  checker: { version: string };
  claimSet: { version: string; hash: string };
  at: string;
  target: { commit: string | null; cli?: { name: string; calls: number; commands: number }; http?: { origin: string; routes: number; requests: number }; mcp?: { tools: number } };
  safety: Safety;
  inventory: { given: boolean; surfaces: ClaimSurface[] };
  effects: { surface: string; note: string }[];
  /**
   * Every applicable must claim holds, none was skipped, and the inventory covered every checked surface.
   *
   * @claim "Every applicable must claim holds" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the kit's example tool conforms, and the X-ray acts on nothing)
   */
  conformant: boolean;
  summary: { claims: number; holding: number; must: number; mustHolding: number; mustSkipped: number; checks: { pass: number; fail: number; skip: number }; score: number | null };
  claims: ClaimSummary[];
  results: CheckResult[];
}

/** The report from the results: per claim, how many surfaces hold it; overall, whether the interface conforms. */
function summarize(results: readonly CheckResult[], parts: Pick<Report, "target" | "safety" | "inventory" | "effects">, at: string = new Date().toISOString()): Report {
  const claims: ClaimSummary[] = CLAIMS.filter((c) => results.some((r) => r.claim === c.id)).map((c) => {
    const rs = results.filter((r) => r.claim === c.id);
    const count = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
    return { ...c, pass: count("pass"), fail: count("fail"), skip: count("skip"), holds: count("fail") === 0 && count("pass") > 0, failing: rs.filter((r) => r.verdict === "fail"), skipped: rs.filter((r) => r.verdict === "skip") };
  });
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const must = claims.filter((c) => c.tier === "must");
  const mustSkipped = must.filter((c) => c.skip > 0).length;
  const checked = new Set(results.map((r) => CLAIM.get(r.claim)!.surface));
  const pass = count("pass");
  const fail = count("fail");
  return {
    tool: "ax-xray",
    checker: { version: XRAY_VERSION },
    claimSet: { version: CLAIM_SET.version, hash: claimSetHash() },
    at,
    ...parts,
    conformant: must.every((c) => c.fail === 0 && c.skip === 0) && parts.inventory.given && [...checked].every((s) => parts.inventory.surfaces.includes(s)),
    summary: { claims: claims.length, holding: claims.filter((c) => c.holds).length, must: must.length, mustHolding: must.filter((c) => c.holds).length, mustSkipped, checks: { pass, fail, skip: count("skip") }, score: pass + fail ? Math.round((1000 * pass) / (pass + fail)) / 10 : null },
    claims,
    results: [...results],
  };
}

const targetLine = (t: Report["target"]) =>
  [t.commit && `at ${t.commit}`, t.cli && `CLI \`${t.cli.name}\` (${t.cli.commands} commands, ${t.cli.calls} calls)`, t.http && `HTTP ${t.http.origin} (${t.http.routes} routes in the manifest, ${t.http.requests} requests)`, t.mcp && `MCP (${t.mcp.tools} tools)`].filter(Boolean).join("; ");
const order = (claims: readonly ClaimSummary[]) => [...claims].sort((a, b) => Number(a.holds) - Number(b.holds) || (a.tier === b.tier ? 0 : a.tier === "must" ? -1 : 1) || b.fail - a.fail);
const mark = (c: ClaimSummary) => (c.holds ? "✓" : c.fail ? "✗" : "–");
const pinLine = (r: Report) => `Ouro AX claim set ${r.claimSet.version} (sha256 ${r.claimSet.hash}), checked by ax-xray ${r.checker.version} at ${r.at}.`;
const verdictLine = (r: Report) => {
  if (r.conformant) return "Conforms: every applicable must claim holds, and the inventory covers every surface checked.";
  const failing = r.claims.filter((c) => c.tier === "must" && c.fail > 0).length;
  const count = (n: number, what: string) => `${n} must claim${n === 1 ? "" : "s"} ${what}`;
  const uncovered = r.inventory.given ? [...new Set(r.results.map((x) => CLAIM.get(x.claim)!.surface))].filter((s) => !r.inventory.surfaces.includes(s)) : [];
  return `Does not conform yet: ${[failing ? count(failing, "not holding") : "", !r.inventory.given ? "no inventory given" : "", uncovered.length ? `the inventory names no ${uncovered.join(" or ")} surfaces` : "", r.summary.mustSkipped ? count(r.summary.mustSkipped, "skipped") : ""].filter(Boolean).join("; ")}.`;
};
const safetyLine = (r: Report) => `Calls to what other people see: ${r.safety.ok ? "allowed, the target is a proven mock" : "not made"} (${r.safety.checks.map((c) => `${c.name}: ${c.ok ? "yes" : "no"}`).join(", ")}).`;
const effectsLine = (r: Report) => (r.effects.length ? `Effects the X-ray caused: ${r.effects.map((e) => `${e.surface}: ${e.note}`).join("; ")}.` : "Effects the X-ray caused: none recorded.");

function renderText(report: Report, max = 6): string {
  const s = report.summary;
  const out = [`ax-xray: ${targetLine(report.target)}`, pinLine(report), verdictLine(report), `Claims holding: ${s.holding} of ${s.claims} (must: ${s.mustHolding} of ${s.must}). Checks: ${s.checks.pass} pass, ${s.checks.fail} fail, ${s.checks.skip} skipped.`, safetyLine(report), effectsLine(report), ""];
  for (const c of order(report.claims)) {
    out.push(`${mark(c)} ${c.id} [${c.tier}] ${c.rule} (${c.pass} of ${c.pass + c.fail}${c.skip ? `, ${c.skip} skipped` : ""})`);
    for (const f of c.failing.slice(0, max)) out.push(`    ${f.surface}: ${f.note}`);
    if (c.failing.length > max) out.push(`    … ${c.failing.length - max} more`);
    if (c.fail) out.push(`    Fix: ${c.fix}`);
  }
  return `${out.join("\n")}\n`;
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const titleOf = (r: Report) => r.target.cli?.name ?? r.target.http?.origin ?? "MCP server";
const bySurface = (r: Report) => {
  const by: Record<string, CheckResult[]> = {};
  for (const x of r.results) (by[`${CLAIM.get(x.claim)!.surface} · ${x.surface}`] ??= []).push(x);
  return by;
};

function renderMarkdown(report: Report): string {
  const s = report.summary;
  const out = [
    `# AX X-ray: ${titleOf(report)}`,
    "",
    `${pinLine(report)} Target: ${targetLine(report.target)}.`,
    "",
    `**${verdictLine(report)}** Claims holding: ${s.holding} of ${s.claims} (must: ${s.mustHolding} of ${s.must}). Checks: ${s.checks.pass} pass, ${s.checks.fail} fail, ${s.checks.skip} skipped.`,
    "",
    safetyLine(report),
    "",
    effectsLine(report),
    "",
    "| | Claim | Tier | Rule | Pass | Fail | Skip |",
    "|---|---|---|---|---|---|---|",
    ...order(report.claims).map((c) => `| ${mark(c)} | \`${c.id}\` | ${c.tier} | ${md(c.rule)} | ${c.pass} | ${c.fail} | ${c.skip} |`),
    "",
    "## What fails, and the fix",
    "",
  ];
  for (const c of order(report.claims).filter((x) => x.fail)) {
    out.push(`### \`${c.id}\`: ${c.rule}`, "", `Why: ${c.why}`, "", `Fix: ${c.fix}`, "");
    for (const f of c.failing) out.push(`- **${md(f.surface)}**: ${md(f.note)}`);
    out.push("");
  }
  out.push("## Every surface", "", "| Surface | Holds | Fails | Skipped |", "|---|---|---|---|");
  for (const [k, rs] of Object.entries(bySurface(report))) {
    const ids = (v: Verdict) => rs.filter((r) => r.verdict === v).map((r) => `\`${r.claim}\``).join(" ");
    out.push(`| ${md(k)} | ${ids("pass")} | ${ids("fail")} | ${ids("skip")} |`);
  }
  return `${out.join("\n")}\n`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderHtml(report: Report): string {
  const s = report.summary;
  const claims = order(report.claims);
  const cell = (rs: CheckResult[], id: string) => {
    const r = rs.filter((x) => x.claim === id);
    if (!r.length) return "<td></td>";
    const v = r.some((x) => x.verdict === "fail") ? "fail" : r.some((x) => x.verdict === "pass") ? "pass" : "skip";
    return `<td class="${v}" title="${esc(r.map((x) => `${x.verdict}: ${x.note}`).join("\n"))}">${v === "pass" ? "✓" : v === "fail" ? "✗" : "–"}</td>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AX X-ray: ${esc(titleOf(report))}</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1b1b1f;background:#fff}h1{font-size:1.5rem}code{font:12px ui-monospace,monospace}
table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d0d7;padding:.25rem .5rem;text-align:left;vertical-align:top}
th.v{writing-mode:vertical-rl;transform:rotate(180deg);font-weight:500;white-space:nowrap}td.pass{background:#e6f4ea;color:#14532d;text-align:center}td.fail{background:#fde8e8;color:#7f1d1d;text-align:center}td.skip{background:#f3f3f5;text-align:center}
.holds{color:#14532d}.fails{color:#7f1d1d}details{margin:.5rem 0}summary{cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#151518;color:#e8e8ee}th,td{border-color:#3a3a44}td.pass{background:#12351f;color:#bbf7d0}td.fail{background:#3b1414;color:#fecaca}td.skip{background:#26262c}.holds{color:#86efac}.fails{color:#fca5a5}}
</style></head><body><main>
<h1>AX X-ray: ${esc(titleOf(report))}</h1>
<p>${esc(pinLine(report))} ${esc(targetLine(report.target))}.</p>
<p><strong>${esc(verdictLine(report))}</strong> Claims holding: ${s.holding} of ${s.claims} (must: ${s.mustHolding} of ${s.must}). Checks: ${s.checks.pass} pass, ${s.checks.fail} fail, ${s.checks.skip} skipped.</p>
<p>${esc(safetyLine(report))}</p>
<p>${esc(effectsLine(report))}</p>
<h2>Claims</h2>
${claims.map((c) => `<details${c.fail ? " open" : ""}><summary class="${c.holds ? "holds" : "fails"}">${mark(c)} <code>${esc(c.id)}</code> [${c.tier}] ${esc(c.rule)} (${c.pass} of ${c.pass + c.fail})</summary><p>${esc(c.why)}</p>${c.fail ? `<p><strong>Fix:</strong> ${esc(c.fix)}</p><ul>${c.failing.map((f) => `<li><code>${esc(f.surface)}</code>: ${esc(f.note)}</li>`).join("")}</ul>` : ""}</details>`).join("\n")}
<h2>Every surface</h2>
<table><thead><tr><th>Surface</th>${claims.map((c) => `<th class="v" scope="col"><code>${esc(c.id)}</code></th>`).join("")}</tr></thead><tbody>
${Object.entries(bySurface(report)).map(([k, rs]) => `<tr><th scope="row"><code>${esc(k)}</code></th>${claims.map((c) => cell(rs, c.id)).join("")}</tr>`).join("\n")}
</tbody></table></main></body></html>
`;
}

/**
 * The exit codes of the command line: 0 ok, 1 error (a must claim fails, or it does not conform), 2 usage.
 *
 * @claim "0 ok, 1 error (a must claim fails, or it does not conform), 2 usage" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the command: claims, help, usage errors with the fix, exit codes, written reports)
 */
const exits = defineExitCodes();

/** The check's flags, as the kit parses them and `--help` lists them. */
const CHECK_FLAGS: Readonly<Record<string, FlagSpec>> = Object.freeze({
  cli: { type: "string", placeholder: '"<command>"', description: 'The CLI to check, run as a command line, such as "notes".' },
  http: { type: "string", placeholder: "<url>", description: "The HTTP API to check, at its address. Needs --routes." },
  routes: { type: "string", placeholder: "<manifest.json>", description: "The routes to check, with --http." },
  mcp: { type: "string", placeholder: '"<command>"', description: "The MCP server to check, run over stdio as a command line." },
  inventory: { type: "string", placeholder: "<file>", description: 'The surfaces your interface registers, generated from its own registration: { "cli": [names], "http": ["GET /api/x"], "mcp": [names], "ui": [bindAx entries] }.' },
  conformance: { type: "boolean", description: "Exit 1 unless it conforms: every applicable must claim holds, none skipped, inventory given." },
  mock: { type: "string", placeholder: '"<url> k=v"', description: "Prove the target is a mock: a loopback URL whose JSON has k=v, such as mock=true." },
  guard: { type: "string", placeholder: '"<command>"', description: "Run this first; refuse to check unless it exits 0 (it also proves a mock)." },
  home: { type: "string", placeholder: "<dir>", description: "The isolated home every checked program runs with." },
  env: { type: "string", repeat: true, placeholder: "K=V", description: "An environment variable for every call; nothing else is passed on but PATH." },
  state: { type: "string", repeat: true, placeholder: '"<args>"', description: "CLI args whose output is the state that must not change." },
  events: { type: "string", placeholder: '"<args>"', description: "CLI args that list the interface's work events, to validate." },
  commit: { type: "string", placeholder: "<sha>", description: "The commit checked, recorded in the report." },
  "failure-copy-allow": { type: "string", placeholder: "<file>", description: 'Failure copy that is precise but holds a vague phrase, each with its reason: [{ "match": "<part of the text>", "reason": "<why it is precise>" }].' },
  name: { type: "string", placeholder: "<name>", description: "The CLI's name in its messages (default: the command's file name)." },
  volatile: { type: "list", placeholder: "<k,k>", description: "JSON keys to ignore when comparing state." },
  sample: { type: "string", repeat: true, placeholder: "K=V", description: "A ref for <k> placeholders; others are harvested from reads." },
  width: { type: "string", placeholder: "<N>", description: "Help width limit, a positive number (default 100)." },
  timeout: { type: "string", placeholder: "<ms>", description: "Per call, a positive number of milliseconds (default 20000)." },
  md: { type: "string", placeholder: "<file>", description: "Also write the report as Markdown." },
  html: { type: "string", placeholder: "<file>", description: "Also write the report as a static HTML page." },
});

/** Whether a report fails the run: a must claim fails, or with --conformance, the interface does not conform. */
function failsRun(report: Report, input: Input): boolean {
  return input["conformance"] === true ? !report.conformant : report.claims.some((c) => c.tier === "must" && c.fail > 0);
}

/** The check: its options, then the report, with its --md and --html files written first. The kit prints the report. */
async function checkRun(input: Input, json: boolean): Promise<Report> {
  const o = optionsOf(input, json);
  try {
    const report = await xray(o);
    if (o.md) writeFileSync(o.md, renderMarkdown(report));
    if (o.html) writeFileSync(o.html, renderHtml(report));
    return report;
  } catch (e) {
    if (isAxError(e)) throw e;
    throw new AxError({ code: "check-stopped", exit: exits.code("error"), thing: "check", problem: `stopped before it finished: ${(e as Error).message}`, fix: null });
  }
}

const checkCommand = defineCommand<Report>({
  name: "check",
  summary: "Checks an interface against the Ouro AX claims, from outside, and reports which hold.",
  effect: "private",
  examples: ['ax-xray --cli "notes" --home .xray-home --mock "http://127.0.0.1:5999/api/state mock=true"'],
  flags: CHECK_FLAGS,
  output: "the report: the claims that hold, each surface's checks, and the fix for each claim that fails",
  run: (input, ctx) => checkRun(input, ctx.json),
  exit: (report, input) => (failsRun(report, input) ? "error" : "ok"),
  text: (report) => renderText(report),
});

const claimsCommand = defineCommand<unknown>({
  name: "claims",
  summary: "Every claim, its tier, rule and check; --json gives the claim set as data, with its hash.",
  effect: "private",
  readOnly: true,
  examples: ["ax-xray claims"],
  output: "the claim set as data, with its hash",
  run: () => ({ ...CLAIM_SET, hash: claimSetHash() }),
  text: () => `${CLAIMS.map((c) => `${c.id} [${c.tier}] ${c.rule}\n    check: ${c.check}`).join("\n")}\n`,
});

const tool = defineCli({
  name: "ax-xray",
  about: [`ax-xray ${XRAY_VERSION}: checks an agent-facing interface against the Ouro AX claims, from outside.`],
  exits,
  command: checkCommand,
  commands: [claimsCommand],
});

/** A refusal of the command line, or of a file it reads: one line with its fix, and the usage exit. */
function refusal(code: string, thing: string, problem: string, fix: string | null): AxError {
  return new AxError({ code, exit: exits.code("usage"), thing, problem, fix });
}

/**
 * The K=V pairs in the order given; the last of a name wins, and a pair with no name or no equals sign is refused.
 *
 * @claim "a pair with no name or no equals sign is refused" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the command: claims, help, usage errors with the fix, exit codes, written reports)
 */
function pairsOf(name: string, values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq < 1) throw refusal("bad-value", `--${name}`, `takes K=V, not "${v}"`, `ax-xray --${name} NAME=value`);
    out[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return out;
}

/** A positive number, or the default when the flag is not given. */
function positiveOf(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw refusal("bad-value", `--${name}`, `takes a positive number, not "${raw}"`, `ax-xray --${name} ${fallback}`);
  return n;
}

/** The options the check takes from its parsed input, with the defaults; a missing or contradictory flag is refused. */
function optionsOf(input: Input, json: boolean): XrayOptions {
  const text = (name: string) => input[name] as string | undefined;
  const repeated = (name: string) => (input[name] as readonly string[] | undefined) ?? [];
  const o: XrayOptions = {
    cli: text("cli"),
    http: text("http"),
    routes: text("routes"),
    mcp: text("mcp"),
    name: text("name"),
    guard: text("guard"),
    mock: text("mock"),
    home: text("home"),
    inventory: text("inventory"),
    events: text("events"),
    commit: text("commit"),
    failureCopyAllow: text("failure-copy-allow"),
    md: text("md"),
    html: text("html"),
    env: pairsOf("env", repeated("env")),
    state: [...repeated("state")],
    volatile: [...((input["volatile"] as readonly string[] | undefined) ?? [])],
    samples: pairsOf("sample", repeated("sample")),
    width: positiveOf("width", text("width"), 100),
    timeoutMs: positiveOf("timeout", text("timeout"), 20_000),
    json,
    conformance: input["conformance"] === true,
    command: null,
  };
  if (o.http && !o.routes) throw refusal("needs-routes", "--http", "needs --routes <manifest.json>, the routes to check", "ax-xray --http <url> --routes routes.json");
  if (!o.cli && !o.http && !o.mcp) throw refusal("nothing-to-check", "check", "nothing to check", "give --cli, --http or --mcp; ax-xray --help");
  if (o.conformance && !o.inventory) throw refusal("needs-inventory", "--conformance", "needs --inventory <file>, the surfaces your interface registers", "ax-xray --inventory inventory.json --conformance");
  return o;
}

/** The options a command line gives: `help`, `claims`, or the check's options. A refused flag or value throws an AxError. */
function parseArgs(argv: readonly string[]): XrayOptions {
  const parsed = parse(tool, argv);
  const base = (json: boolean, command: XrayOptions["command"]): XrayOptions => ({ env: {}, state: [], volatile: [], samples: {}, width: 100, timeoutMs: 20_000, json, conformance: false, command });
  if (parsed.kind === "help") return base(parsed.json, "help");
  if (parsed.command.name === "claims") return base(parsed.json, "claims");
  return optionsOf(parsed.input, parsed.json);
}

/** The allow-list of precise failure copy, checked; a usage error names the file and its bad entries. */
function readAllow(file: string): FailureCopyAllow[] {
  try {
    return checkFailureCopyAllow(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw refusal("bad-allow-file", "--failure-copy-allow", `${file}: ${(e as Error).message}`, null);
  }
}

/** Runs the X-ray: the guard, the safety proof, then the surfaces given; returns the report. */
async function xray(opts: XrayOptions): Promise<Report> {
  const env = childEnv(opts);
  let guardPassed = false;
  if (opts.guard) {
    const g = await run(splitCommand(opts.guard), env, opts.timeoutMs);
    if (g.code !== 0) throw refusal("guard-failed", "--guard", `refusing: the guard failed: ${firstLine(g.stderr) || firstLine(g.stdout) || `exit ${String(g.code)}`}`, "point it at the mock");
    guardPassed = true;
  }
  const inventory = opts.inventory ? (JSON.parse(readFileSync(opts.inventory, "utf8")) as Inventory) : null;
  const allow = opts.failureCopyAllow ? readAllow(opts.failureCopyAllow) : [];
  const ctx: Context = { rec: new Recorder(), opts, env, safety: await checkSafety(opts, guardPassed), inventory, effects: [], allow };
  const target: Report["target"] = { commit: opts.commit ?? null };
  if (opts.cli) target.cli = await checkCli(ctx);
  if (opts.http) target.http = await checkHttp(ctx);
  if (opts.mcp) target.mcp = await checkMcp(ctx);
  const surfaces = (["cli", "http", "mcp", "ui"] as const).filter((s) => Array.isArray(inventory?.[s]));
  return summarize(ctx.rec.results, { target, safety: ctx.safety, inventory: { given: inventory !== null, surfaces }, effects: ctx.effects });
}

interface Io {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

/** The command: the kit parses argv, runs the check or `claims`, prints the report or the one error line, and resolves the exit code. */
async function main(argv: readonly string[], io: Io = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  return runCli(tool, argv, io);
}

// Run as a program (`node xray.ts ...`); the tests import it instead.
/* node:coverage disable */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && fileURLToPath(import.meta.url)) {
  quietPipes(process);
  process.exitCode = await main(process.argv.slice(2));
}
/* node:coverage enable */
