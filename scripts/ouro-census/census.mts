// The Ouro AX census: find every agent door a product has, declared or not, and fail when a gap is new.
// Built-in walkers find MCP tools, CLI commands, in-turn tools and approval prompts; a product adds its own (README.md).
//
//   node census.mts --config ax/census.config.json --baseline ax/census.baseline.json \
//     --base-baseline <file|none> --base-config <file|absent> [--out census.json] [--inventory inventory.json] [--commit <sha>] [--ref <ref>] [--repo <owner/name>]
//
// --inventory writes the declared doors in the X-ray's inventory shape ({ "mcp": [names] }), so the X-ray checks how
// they behave; the census owns the undeclared ones.
//
// The walkers run in one child process with an empty HOME and TMPDIR, no credentials and a loopback-only socket
// guard. The census never calls a door; it reads code and lists. Exit 0 when nothing is wrong, 1 when the census or
// its baseline fails, 2 for a usage error. There is no override.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBaseline, checkBooklet, checkSources, checkWalkers, type WalkerSource } from "./baseline.mts";
import { BOOKLET_FIELDS, BOOKLET_WORDS, bookletTexts, bookletWordsIn, checkCard, checkDeclaredBy } from "./cards.mts";
import { buildProductReport, renderText } from "./report.mts";
import type { BookletAllow, CensusReport, Door, GroupCard, ProductWalker, ProductWalkerReport, WalkResult } from "./types.mts";
import { CENSUS_VERSION, checkerHash } from "./checker.mts";
import { WALKERS } from "./walkers/registry.mts";

export { CENSUS_VERSION, CHECKER_FILES, checkerHash } from "./checker.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "child.mts");
const GUARD = join(HERE, "guard.mjs");
const TIMEOUT_MS = 10_000;

const USAGE = "usage: node census.mts --config <file> --baseline <file> --base-baseline <file|none> --base-config <file|absent> [--out <file>] [--inventory <file>] [--commit <sha>] [--ref <ref>] [--repo <owner/name>]";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

class CensusFailure extends Error {}

interface Config {
  product: string;
  sources: WalkerSource[];
  groups: GroupCard[];
  /** The product's own walkers, by the name its sources use. */
  walkers: Record<string, ProductWalker>;
  /** The booklet-words check's reviewed allowlist, once the product adopts the check; null before. */
  booklet: BookletAllow[] | null;
}

const isClaims = (c: unknown): boolean =>
  Array.isArray(c) && c.every((x: { entry?: unknown; parser?: unknown }) => typeof x?.entry === "string" && typeof x.parser === "string");

async function readConfig(path: string): Promise<Config> {
  let config: Partial<Config>;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CensusFailure(`ax-census: can't read the config ${path}: ${(error as Error).message}`);
  }
  if (typeof config.product !== "string" || config.product.length === 0) throw new CensusFailure(`ax-census: ${path} names no product`);
  if (!Array.isArray(config.sources) || config.sources.length === 0) throw new CensusFailure(`ax-census: ${path} has no walker sources`);
  for (const s of config.sources) {
    if (typeof s?.walker !== "string" || typeof s.module !== "string" || typeof s.source !== "string") {
      throw new CensusFailure(`ax-census: ${path}: each source needs walker, module and source strings`);
    }
    if ((s.parser !== undefined && typeof s.parser !== "string") || (s.kinds !== undefined && typeof s.kinds !== "string") || (s.claims !== undefined && !isClaims(s.claims))) {
      throw new CensusFailure(`ax-census: ${path}: a source's parser, kinds and claims must be strings and a list of { entry, parser } paths`);
    }
    if ((s.cards !== undefined && typeof s.cards !== "string") || (s.handlers !== undefined && !(Array.isArray(s.handlers) && s.handlers.every((h) => typeof h === "string")))) {
      throw new CensusFailure(`ax-census: ${path}: a source's cards must be a string and its handlers a list of paths`);
    }
    if (s.server !== undefined && (typeof s.server !== "string" || s.server === "")) {
      throw new CensusFailure(`ax-census: ${path}: a source's server must be the server's name under mcpServers`);
    }
    const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (!strings(s.passthrough) || !strings(s.approvals) || !strings(s.reshape)) {
      throw new CensusFailure(`ax-census: ${path}: a source's passthrough, approvals and reshape must be lists of <file>#<function>`);
    }
    if (s.skip !== undefined && (!strings(s.skip) || !["argv-entries", "tool-schemas"].includes(s.walker))) {
      throw new CensusFailure(`ax-census: ${path}: ${s.walker}: skip is a list of folders, on an argv-entries or tool-schemas source only`);
    }
  }
  const walkers = (config as { walkers?: unknown }).walkers ?? {};
  if (typeof walkers !== "object" || walkers === null || Array.isArray(walkers)) {
    throw new CensusFailure(`ax-census: ${path}: walkers must map each product walker's name to { module, kinds }`);
  }
  const modules = new Map<string, string>();
  for (const [name, w] of Object.entries(walkers as Record<string, Partial<ProductWalker>>)) {
    if (Object.hasOwn(WALKERS, name)) throw new CensusFailure(`ax-census: ${path}: ${name}: a built-in walker's name. Fix: give the product's own walker another name in ax/census.config.json.`);
    if (typeof w?.module !== "string" || w.module.length === 0 || !Array.isArray(w.kinds) || w.kinds.length === 0 || !w.kinds.every((k) => typeof k === "string" && /^[a-z][a-z0-9-]*$/.test(k))) {
      throw new CensusFailure(`ax-census: ${path}: ${name}: each of walkers needs a module path and a non-empty list of door kinds (lowercase words)`);
    }
    if (w.kinds.includes("unwalked")) throw new CensusFailure(`ax-census: ${path}: ${name}: unwalked is the census's own kind. Fix: report code the walker can't walk as unwalked gaps instead.`);
    const module = normalize(w.module);
    const other = modules.get(module);
    if (other) throw new CensusFailure(`ax-census: ${path}: ${name}: ${module} is already the ${other} walker's module. Fix: give each product walker its own module.`);
    modules.set(module, name);
  }
  const booklet = (config as { bookletWords?: { allow?: unknown } }).bookletWords;
  let allow: BookletAllow[] | null = null;
  if (booklet !== undefined) {
    if (typeof booklet !== "object" || booklet === null || Array.isArray(booklet)) {
      throw new CensusFailure(`ax-census: ${path}: bookletWords: adopt the rule with an object that has an allow list`);
    }
    const entries = booklet.allow ?? [];
    const valid = (e: Partial<BookletAllow>) =>
      typeof e?.door === "string" && BOOKLET_FIELDS.includes(e.field as BookletAllow["field"]) && BOOKLET_WORDS.includes(e.word as string) && typeof e.reason === "string" && e.reason.trim().length > 0;
    if (!Array.isArray(entries) || !entries.every(valid)) {
      throw new CensusFailure(`ax-census: ${path}: bookletWords.allow: each entry needs a door, a field (${BOOKLET_FIELDS.join(", ").replace(/, (?=[^,]*$)/, " or ")}), a booklet word and a reason`);
    }
    allow = entries as BookletAllow[];
  }
  return { product: config.product, sources: config.sources, groups: Array.isArray(config.groups) ? config.groups : [], walkers: walkers as Record<string, ProductWalker>, booklet: allow };
}

async function readBaseline(path: string): Promise<string[]> {
  let parsed: { census?: unknown; gaps?: unknown };
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CensusFailure(`ax-census: can't read the baseline ${path}: ${(error as Error).message}`);
  }
  if (parsed?.census !== "census/1" || !Array.isArray(parsed.gaps) || !parsed.gaps.every((g) => typeof g === "string")) {
    throw new CensusFailure(`ax-census: ${path} is not a census/1 baseline ({ "census": "census/1", "gaps": [ids] })`);
  }
  return parsed.gaps as string[];
}

function tail(text: string, lines = 20): string {
  return text.trimEnd().split("\n").slice(-lines).map((l) => `  ${l}`).join("\n");
}

/** The walker whose `ax-census: start <name>` line in the child's stderr has no matching `finish` after it, if any. */
function inProgressWalker(stderr: string): string | null {
  let open: string | null = null;
  for (const line of stderr.split("\n")) {
    const start = /^ax-census: start (\S+)$/.exec(line);
    if (start) {
      open = start[1]!;
      continue;
    }
    const finish = /^ax-census: finish (\S+) in \d+ms$/.exec(line);
    if (finish && finish[1] === open) open = null;
  }
  return open;
}

/** Start the isolated child, wait for its one JSON line, and return it. Throws CensusFailure for anything else. */
export async function runWalkers(options: { config: string; root: string; timeoutMs?: number; childScript?: string }): Promise<WalkResult> {
  await readConfig(options.config);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const home = await mkdtemp(join(tmpdir(), "ax-census-home-"));
  try {
    const child = spawn(process.execPath, ["--import", pathToFileURL(GUARD).href, options.childScript ?? CHILD, resolve(options.config)], {
      cwd: options.root,
      env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout kills anything it started too, and a grandchild holding the pipes can't
      // keep the census waiting.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await new Promise<{ code: number | null; signal: string | null } | "timeout">((done) => {
      child.on("close", (code, signal) => done({ code, signal }));
      timer = setTimeout(() => {
        killGroup();
        child.stdout.destroy();
        child.stderr.destroy();
        done("timeout");
      }, timeoutMs);
    });
    clearTimeout(timer);
    // Nothing the walkers started outlives them.
    killGroup();
    if (exit === "timeout") {
      const walker = inProgressWalker(stderr);
      throw new CensusFailure(
        `ax-census: the walkers didn't finish within ${timeoutMs / 1000} seconds${walker ? ` (${walker} was running)` : ""}; their stderr ends:\n${tail(stderr)}`,
      );
    }
    if (exit.code !== 0) {
      throw new CensusFailure(`ax-census: the walkers failed (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`}); their stderr ends:\n${tail(stderr)}`);
    }
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length !== 1) {
      throw new CensusFailure(`ax-census: the walkers printed ${lines.length} lines, not one JSON line; their stderr ends:\n${tail(stderr)}`);
    }
    let result: WalkResult;
    try {
      result = JSON.parse(lines[0]!);
    } catch {
      throw new CensusFailure(`ax-census: the walkers printed something that isn't JSON: ${lines[0]!.slice(0, 200)}`);
    }
    if (!Array.isArray(result?.doors) || !Array.isArray(result.errors)) {
      throw new CensusFailure("ax-census: the walkers' output has no doors and errors lists");
    }
    return result;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Each product walker the config names, with its module file's hash, so a reader can see which counts it can't vouch for. */
async function productWalkerReports(walkers: Readonly<Record<string, ProductWalker>>, root: string): Promise<ProductWalkerReport[]> {
  const reports: ProductWalkerReport[] = [];
  for (const [name, { module, kinds }] of Object.entries(walkers)) {
    let sha256: string | null = null;
    try {
      sha256 = createHash("sha256").update(await readFile(resolve(root, module))).digest("hex");
    } catch {
      // The child already reported the module it couldn't load.
    }
    reports.push({ name, module, kinds, sha256 });
  }
  return reports;
}


/**
 * The weak reasons per door id: a card's failed checks, or a door with no literal name. A door another door's card
 * declares (an approval prompt) is checked after its owner, and isn't compared with the others: it shares their card.
 */
function weakDoors(doors: readonly Door[], groups: readonly GroupCard[], booklet: readonly BookletAllow[] | null = null): Map<string, string[]> {
  const weak = new Map<string, string[]>();
  const own = doors.filter((d) => !d.declaredBy);
  for (const door of own) {
    if (door.card) {
      let reasons: string[];
      try {
        reasons = checkCard(door, { groups, others: own, booklet });
      } catch (error) {
        reasons = [`card: malformed (${(error as Error).message})`];
      }
      if (reasons.length > 0) weak.set(door.id, reasons);
    } else if (door.line === null) {
      weak.set(door.id, ["name: not a literal", "card: none declared"]);
    }
  }
  for (const door of doors) {
    if (!door.declaredBy || !door.card) continue;
    const reasons = checkDeclaredBy(door, weak.has(door.declaredBy));
    if (reasons.length > 0) weak.set(door.id, reasons);
  }
  return weak;
}

interface Flags {
  config: string;
  baseline: string;
  baseBaseline: string;
  /** The base branch's config file, or `absent` when the base doesn't run the census. */
  baseConfig: string;
  out?: string;
  inventory?: string;
  commit?: string;
  ref?: string;
  repo?: string;
}

const FLAG_NAMES: Readonly<Record<string, keyof Flags>> = {
  "--config": "config",
  "--baseline": "baseline",
  "--base-baseline": "baseBaseline",
  "--base-config": "baseConfig",
  "--out": "out",
  "--inventory": "inventory",
  "--commit": "commit",
  "--ref": "ref",
  "--repo": "repo",
};

function parseFlags(argv: readonly string[]): Flags | string {
  const flags: Partial<Record<keyof Flags, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FLAG_NAMES[argv[i]!];
    if (!key) return `unknown argument ${argv[i]}`;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return `${argv[i]} needs a value`;
    flags[key] = value;
  }
  for (const required of ["config", "baseline", "baseBaseline", "baseConfig"] as const) {
    if (flags[required] === undefined) return `missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  }
  return flags as Flags;
}

export async function run(options: { argv: readonly string[]; io: Io; root?: string; timeoutMs?: number; childScript?: string }): Promise<number> {
  const { io } = options;
  const flags = parseFlags(options.argv);
  if (typeof flags === "string") {
    io.err(`ax-census: ${flags}`);
    io.err(USAGE);
    return 2;
  }
  const root = options.root ?? process.cwd();
  try {
    const config = await readConfig(flags.config);
    const baseline = await readBaseline(flags.baseline);
    const baseBaseline = flags.baseBaseline === "none" ? null : await readBaseline(flags.baseBaseline);
    const baseConfig = flags.baseConfig === "absent" ? null : await readConfig(flags.baseConfig);
    const { doors, errors, unwalked = [], excluded = [] } = await runWalkers({ config: flags.config, root, timeoutMs: options.timeoutMs, childScript: options.childScript });
    if (doors.length === 0 && errors.length === 0) {
      throw new CensusFailure("ax-census: the walkers found no doors; a census that counts nothing is broken, not clean");
    }

    const weak = weakDoors(doors, config.groups, config.booklet);
    // The pull request that adopts the booklet check may list the doors it alone makes weak.
    const adopting = config.booklet !== null && baseConfig !== null && baseConfig.booklet === null;
    const plain = adopting ? weakDoors(doors, config.groups) : null;
    const seed = plain ? new Set(doors.filter((d) => weak.has(d.id) && !plain.has(d.id)).map((d) => d.id)) : undefined;
    const used = new Set(doors.filter((d) => d.card && !d.declaredBy).flatMap((d) => bookletTexts(d).flatMap(({ field, text }) => bookletWordsIn(text).map((word) => `${d.id} ${field} ${word}`))));
    const gaps = [...doors.filter((d) => !d.card || weak.has(d.id)).map((d) => d.id), ...unwalked.map((g) => g.id)];
    const kindsOf = (c: Config) => [...new Set(c.sources.flatMap((s) => (Object.hasOwn(WALKERS, s.walker) ? WALKERS[s.walker]!.kinds : Object.hasOwn(c.walkers, s.walker) ? c.walkers[s.walker]!.kinds : [])))];
    const kinds = kindsOf(config);
    // A kind new on the base may seed the baseline only when the product walker that walks it is new too: a walker the
    // base has can't take on a kind and list that kind's doors as gaps.
    const seedless = (base: Config) => Object.entries(config.walkers).filter(([name]) => Object.hasOwn(base.walkers, name)).flatMap(([, w]) => w.kinds);
    const problems = [
      ...errors,
      ...checkBaseline({ gaps, baseline, base: { baseline: baseBaseline, hasConfig: baseConfig !== null, ...(baseConfig ? { kinds: [...kindsOf(baseConfig), ...seedless(baseConfig)] } : {}) }, kinds, ...(seed ? { seed } : {}) }),
      ...checkSources(config.sources, baseConfig?.sources ?? null),
      ...checkWalkers(config.walkers, baseConfig?.walkers ?? null),
      ...checkBooklet(config.booklet, baseConfig?.booklet, used),
    ];

    const report: CensusReport = {
      ax: "census/1",
      tool: "ouro-census",
      checker: { version: CENSUS_VERSION, sha256: await checkerHash(), walkers: await productWalkerReports(config.walkers, root) },
      target: { repo: flags.repo ?? null, ref: flags.ref ?? null, commit: flags.commit ?? null },
      at: new Date().toISOString(),
      products: [buildProductReport(config.product, doors, weak, new Set(baseline).size, { kinds, finders: [] }, unwalked, excluded)],
    };
    if (flags.out) {
      await mkdir(dirname(resolve(flags.out)), { recursive: true });
      await writeFile(flags.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (flags.inventory) {
      const inventory: Record<string, string[]> = {};
      for (const door of doors) if (door.card && !weak.has(door.id)) (inventory[door.kind] ??= []).push(door.name);
      await mkdir(dirname(resolve(flags.inventory)), { recursive: true });
      await writeFile(flags.inventory, `${JSON.stringify(inventory, null, 2)}\n`);
    }
    for (const line of renderText(report).split("\n")) io.out(line);
    for (const problem of problems) io.err(problem);
    if (problems.length > 0) io.err(`ax-census: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof CensusFailure)) throw error;
    io.err(error.message);
    return 1;
  }
}

export function main(argv: readonly string[], io: Io): Promise<number> {
  return run({ argv, io });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
