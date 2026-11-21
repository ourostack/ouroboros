// The Ouro AX census: find every agent door a product has, declared or not, and fail when a gap is new.
// Design: the AX census design (ouroboros-agent-harness desk). Slice 1 walks `ouro mcp-serve`'s tools only.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBaseline, checkSources } from "./baseline.mts";
import { checkCard } from "./cards.mts";
import { buildProductReport, renderText } from "./report.mts";
import type { CensusReport, Door, GroupCard, WalkResult } from "./types.mts";
import { WALKERS } from "./walkers/registry.mts";

export const CENSUS_VERSION = "0.1.0";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "child.mts");
const GUARD = join(HERE, "guard.mjs");
/** The files whose hash is the checker's identity; the ledger compares it with a released manifest. */
const CHECKER_FILES = ["baseline.mts", "cards.mts", "census.mts", "child.mts", "guard.mjs", "report.mts", "types.mts", "walkers/mcp-schemas.mts", "walkers/registry.mts"];
const TIMEOUT_MS = 10_000;

const USAGE = "usage: node census.mts --config <file> --baseline <file> --base-baseline <file|none> --base-config <file|absent> [--out <file>] [--inventory <file>] [--commit <sha>] [--ref <ref>] [--repo <owner/name>]";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

class CensusFailure extends Error {}

interface Config {
  product: string;
  sources: { walker: string; module: string; source: string }[];
  groups: GroupCard[];
}

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
  }
  return { product: config.product, sources: config.sources, groups: Array.isArray(config.groups) ? config.groups : [] };
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
    if (exit === "timeout") throw new CensusFailure(`ax-census: the walkers didn't finish within ${timeoutMs / 1000} seconds`);
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

async function checkerHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of CHECKER_FILES) {
    const content = await readFile(join(HERE, file));
    hash.update(`${file}\n${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

/** The weak reasons per door id: a card's failed checks, or a door with no literal name. */
function weakDoors(doors: readonly Door[], groups: readonly GroupCard[]): Map<string, string[]> {
  const weak = new Map<string, string[]>();
  for (const door of doors) {
    if (door.card) {
      let reasons: string[];
      try {
        reasons = checkCard(door, { groups, others: doors });
      } catch (error) {
        reasons = [`card: malformed (${(error as Error).message})`];
      }
      if (reasons.length > 0) weak.set(door.id, reasons);
    } else if (door.line === null) {
      weak.set(door.id, ["name: not a literal", "card: none declared"]);
    }
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
    const { doors, errors } = await runWalkers({ config: flags.config, root, timeoutMs: options.timeoutMs, childScript: options.childScript });
    if (doors.length === 0 && errors.length === 0) {
      throw new CensusFailure("ax-census: the walkers found no doors; a census that counts nothing is broken, not clean");
    }

    const weak = weakDoors(doors, config.groups);
    const gaps = doors.filter((d) => !d.card || weak.has(d.id)).map((d) => d.id);
    const kinds = [...new Set(config.sources.map((s) => WALKERS[s.walker]?.kind).filter((k): k is string => k !== undefined))];
    const problems = [
      ...errors,
      ...checkBaseline({ gaps, baseline, base: { baseline: baseBaseline, hasConfig: baseConfig !== null }, kinds }),
      ...checkSources(config.sources, baseConfig?.sources ?? null),
    ];

    const report: CensusReport = {
      ax: "census/1",
      tool: "ouro-census",
      checker: { version: CENSUS_VERSION, sha256: await checkerHash() },
      target: { repo: flags.repo ?? null, ref: flags.ref ?? null, commit: flags.commit ?? null },
      at: new Date().toISOString(),
      products: [buildProductReport(config.product, doors, weak, new Set(baseline).size, { kinds, finders: [] })],
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
