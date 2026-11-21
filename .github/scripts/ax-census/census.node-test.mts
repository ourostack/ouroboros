import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run, runWalkers } from "./census.mts";
import { buildProductReport, renderText } from "./report.mts";
import type { CensusReport } from "./types.mts";
import type { Door, DoorCard } from "./types.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const guard = join(here, "guard.mjs");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ax-census-test-"));
}

function baselineFile(dir: string, gaps: string[], name = "baseline.json"): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ census: "census/1", gaps }));
  return path;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
}

function args(config: string, baseline: string, extra: string[] = []): string[] {
  return ["--config", join(fixtures, config), "--baseline", baseline, "--base-baseline", "none", "--base-config", "absent", ...extra];
}

function probe(...argv: string[]) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, join(fixtures, "guard-probe.mjs"), ...argv], { encoding: "utf8", timeout: 10_000 });
}

test("the guard refuses a non-loopback connection", async () => {
  const refused = probe("net", "93.184.216.34", "443");
  ok(refused.status !== 0, "the probe should fail");
  ok(refused.stderr.includes("ax-census: refused a connection to 93.184.216.34"), refused.stderr);

  const fetched = probe("fetch", "https://example.com/");
  ok(fetched.status !== 0);
  ok(fetched.stderr.includes("ax-census: refused a connection to example.com"), fetched.stderr);

  const lookalike = probe("net", "127.attacker.example", "443");
  ok(lookalike.stderr.includes("ax-census: refused a connection to 127.attacker.example"), lookalike.stderr);
  const lookup = probe("lookup", "localhost", "443");
  ok(lookup.stderr.includes("ax-census: refused a connection to localhost (custom lookup)"), lookup.stderr);

  for (const mode of ["dgram", "dgram-connect"]) {
    const sent = probe(mode, "93.184.216.34", "53");
    ok(sent.status !== 0, mode);
    ok(sent.stderr.includes("ax-census: refused a connection to 93.184.216.34"), sent.stderr);
    const local = probe(mode, "127.0.0.1", "9");
    equal(local.status, 0, local.stderr);
    ok(local.stdout.includes("sent"), local.stdout);
  }

  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const allowed = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      // Spawn asynchronously so this process can accept the connection.
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, ["--import", pathToFileURL(guard).href, join(fixtures, "guard-probe.mjs"), "net", "127.0.0.1", String(port)], (error, stdout) => {
          resolve({ status: error ? 1 : 0, stdout });
        });
      });
    });
    equal(allowed.status, 0);
    ok(allowed.stdout.includes("connected"), allowed.stdout);
    const http = await new Promise<string>((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile(process.execPath, ["--import", pathToFileURL(guard).href, join(fixtures, "guard-probe.mjs"), "fetch", `http://127.0.0.1:${port}/`], (_error, stdout, stderr) => resolve(stdout + stderr));
      });
    });
    ok(!http.includes("ax-census: refused"), http);
  } finally {
    server.close();
  }
});

test("the child runs with an empty HOME and no credentials", async () => {
  process.env.AX_CENSUS_TEST_TOKEN = "not-a-real-token";
  try {
    const { errors } = await runWalkers({ config: join(fixtures, "config-fixture.json"), root: here, childScript: join(fixtures, "child-env.mts") });
    const home = errors.find((e) => e.startsWith("HOME="))!.slice(5);
    ok(home.startsWith(join(tmpdir(), "ax-census-")) || home.includes("ax-census-"), home);
    ok(home !== homedir());
    ok(!existsSync(home), "the parent removes the child's HOME afterwards");
    equal(errors.find((e) => e.startsWith("TMPDIR=")), `TMPDIR=${home}`);
    equal(errors.find((e) => e.startsWith("CREDENTIALS=")), "CREDENTIALS=");
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts, and node --experimental-test-coverage adds NODE_V8_COVERAGE.
    const names = errors.find((e) => e.startsWith("NAMES="))!.slice(6).split(",").filter((n) => !n.startsWith("__CF_") && n !== "NODE_V8_COVERAGE");
    deepEqual(names, ["HOME", "PATH", "TMPDIR"]);
  } finally {
    delete process.env.AX_CENSUS_TEST_TOKEN;
  }
});

test("a child that crashes fails the census and writes no report", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const out = join(dir, "census.json");
    const code = await run({ argv: args("config-fixture.json", baselineFile(dir, [])).concat(["--out", out]), io, root: here, childScript: join(fixtures, "child-crash.mts") });
    equal(code, 1);
    ok(err.join("\n").includes("the fixture walker exploded"), err.join("\n"));
    ok(!existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that prints nothing fails the census", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const out = join(dir, "census.json");
    const code = await run({ argv: args("config-fixture.json", baselineFile(dir, [])).concat(["--out", out]), io, root: here, childScript: join(fixtures, "child-silent.mts") });
    equal(code, 1);
    ok(err.join("\n").includes("ax-census: the walkers printed 0 lines, not one JSON line"), err.join("\n"));
    ok(!existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that hangs fails after 10 seconds", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const code = await run({ argv: args("config-fixture.json", baselineFile(dir, [])), io, root: here, childScript: join(fixtures, "child-hang.mts"), timeoutMs: 200 });
    equal(code, 1);
    ok(err.includes("ax-census: the walkers didn't finish within 0.2 seconds"), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child whose grandchild holds its pipes still fails at the timeout", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const started = Date.now();
    const code = await run({ argv: args("config-fixture.json", baselineFile(dir, [])), io, root: here, childScript: join(fixtures, "child-grandchild.mts"), timeoutMs: 500 });
    equal(code, 1);
    ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    ok(err.includes("ax-census: the walkers didn't finish within 0.5 seconds"), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a census over the mcp-ok fixture writes the report and the text", async () => {
  const dir = scratch();
  try {
    const { out, err, io } = capture();
    const file = join(dir, "out", "census.json");
    const baseline = baselineFile(dir, ["mcp:ask", "mcp:status", "mcp:catchup"]);
    const code = await run({ argv: args("config-ok.json", baseline, ["--out", file, "--commit", "abc123", "--ref", "refs/pull/1/merge"]), io, root: here });
    equal(code, 0, err.join("\n"));
    const report = JSON.parse(readFileSync(file, "utf8"));
    equal(report.ax, "census/1");
    equal(report.tool, "ouro-census");
    equal(report.target.commit, "abc123");
    equal(report.target.ref, "refs/pull/1/merge");
    ok(/^[0-9a-f]{64}$/.test(report.checker.sha256));
    deepEqual(report.products[0].walked.kinds, ["mcp"]);
    equal(report.products[0].summary.found, 3);
    equal(report.products[0].summary.baseline, 3);
    equal(report.products[0].undeclared[0].walker, "mcp-schemas");
    ok(out.includes("harness: 3 found, 0 declared, 0 weak, 3 undeclared (mcp 3)"), out.join("\n"));
    ok(out.includes("walkers/fixtures/mcp-ok.ts:5 mcp:ask"), out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new tool with no card fails the census", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const code = await run({ argv: args("config-four.json", baselineFile(dir, ["mcp:ask", "mcp:status", "mcp:catchup"])), io, root: here });
    equal(code, 1);
    ok(err.includes("mcp:delegate: a door with no valid card, not on the baseline. Fix: give it an ax card in this pull request."), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a census error fails even when the baseline matches", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const code = await run({ argv: args("config-dup.json", baselineFile(dir, ["mcp:ask", "mcp:status"])), io, root: here });
    equal(code, 1);
    ok(err.join("\n").includes("listed twice"), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pull request's base decides whether the baseline may grow", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const gaps = ["mcp:ask", "mcp:status", "mcp:catchup"];
    const argv = ["--config", join(fixtures, "config-ok.json"), "--baseline", baselineFile(dir, gaps), "--base-baseline", baselineFile(dir, ["mcp:ask"], "base.json"), "--base-config", join(fixtures, "config-ok.json")];
    equal(await run({ argv, io, root: here }), 1);
    ok(err.includes("mcp:status: added to the baseline. Fix: declare the door instead; the baseline only shrinks."), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a usage error exits 2", async () => {
  const { err, io } = capture();
  equal(await run({ argv: ["--config"], io, root: here }), 2);
  equal(await run({ argv: ["--config", "a", "--baseline", "b", "--base-baseline", "none", "--base-config"], io, root: here }), 2);
  equal(await run({ argv: ["--nope", "x"], io, root: here }), 2);
  equal(await run({ argv: ["--config", "a", "--baseline", "b"], io, root: here }), 2);
  ok(err.includes("ax-census: missing --base-baseline"), err.join("\n"));
  ok(err.some((e) => e.startsWith("usage: node census.mts")), err.join("\n"));
});

test("a baseline that isn't a census baseline fails", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ gaps: "mcp:ask" }));
    equal(await run({ argv: args("config-ok.json", bad), io, root: here }), 1);
    ok(err.some((e) => e.includes("not a census/1 baseline")), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWalkers rejects a config with no sources", async () => {
  const dir = scratch();
  try {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ product: "harness", sources: [] }));
    await rejects(runWalkers({ config, root: here }), /no walker sources/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a door whose name isn't a literal is weak, and the text names the reasons", () => {
  const door: Door = { id: "mcp:ask", kind: "mcp", product: "harness", name: "ask", description: "", file: "a.ts", line: null, card: null, evidence: {} };
  const report = buildProductReport("harness", [door], new Map([["mcp:ask", ["name: not a literal", "card: none declared"]]]), 1, { kinds: ["mcp"], finders: [] });
  equal(report.summary.weak, 1);
  equal(report.summary.undeclared, 0);
  const text = renderText({ ax: "census/1", tool: "ouro-census", checker: { version: "0", sha256: "" }, target: { repo: null, ref: null, commit: null }, at: "", products: [report] });
  ok(text.includes("a.ts:? mcp:ask (weak: name: not a literal; card: none declared)"), text);
});

async function failsWith(argv: string[], message: string, options: { childScript?: string } = {}) {
  const { err, io } = capture();
  equal(await run({ argv, io, root: here, ...options }), 1);
  ok(err.some((e) => e.includes(message)), err.join("\n"));
}

test("a config or baseline the census can't read fails with its path", async () => {
  const dir = scratch();
  try {
    const empty = baselineFile(dir, []);
    await failsWith(["--config", join(dir, "missing.json"), "--baseline", empty, "--base-baseline", "none", "--base-config", "absent"], "can't read the config");
    await failsWith(args("config-bad-source.json", empty), "each source needs walker, module and source strings");
    await failsWith(args("config-ok.json", join(dir, "missing.json")), "can't read the baseline");
    const noProduct = join(dir, "no-product.json");
    writeFileSync(noProduct, JSON.stringify({ sources: [] }));
    await failsWith(["--config", noProduct, "--baseline", empty, "--base-baseline", "none", "--base-config", "absent"], "names no product");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that prints something other than its result fails the census", async () => {
  const dir = scratch();
  try {
    const argv = args("config-fixture.json", baselineFile(dir, []));
    await failsWith(argv, "printed something that isn't JSON", { childScript: join(fixtures, "child-garbage.mts") });
    await failsWith(argv, "has no doors and errors lists", { childScript: join(fixtures, "child-shapeless.mts") });
    await failsWith(argv, "a census that counts nothing is broken", { childScript: join(fixtures, "child-empty.mts") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config naming a walker the child doesn't have fails", async () => {
  const dir = scratch();
  try {
    await failsWith(args("config-unknown-walker.json", baselineFile(dir, [])), "nope: no such walker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a door with a weak card is a gap with its reasons", async () => {
  const dir = scratch();
  try {
    const { out, io } = capture();
    const code = await run({ argv: args("config-card.json", baselineFile(dir, ["mcp:ask"])), io, root: here });
    equal(code, 0);
    ok(out.includes("harness: 1 found, 0 declared, 1 weak, 0 undeclared (mcp 1)"), out.join("\n"));
    ok(out.some((l) => l.startsWith("walkers/fixtures/mcp-card.ts:7 mcp:ask (weak: ") && l.includes("errors: none declared")), out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a door with a valid card counts as declared", () => {
  const card: DoorCard = {
    id: "mcp:ask",
    group: "agent",
    when: "Ask the agent a question and wait for its answer in this turn.",
    effect: "read",
    errors: [{ code: "agent-unreachable", means: "The agent's daemon isn't running.", fix: "Run ouro up, then ask again." }],
  };
  const door: Door = { id: "mcp:ask", kind: "mcp", product: "harness", name: "ask", description: "", file: "a.ts", line: 3, card, evidence: { readOnly: true } };
  const report = buildProductReport("harness", [door], new Map(), 0, { kinds: ["mcp"], finders: [] });
  deepEqual(report.summary, { found: 1, declared: 1, weak: 0, undeclared: 0, unwalked: 0, stale: 0, excluded: 0, baseline: 0 });
  deepEqual(report.byKind, { mcp: { found: 1, declared: 1, weak: 0, undeclared: 0, unwalked: 0 } });
});

test("the text sorts gaps by file, then line, then id", () => {
  const gap = (id: string, file: string, line: number | null) => ({ id, kind: "mcp", file, line, walker: "mcp-schemas" });
  const report: CensusReport = {
    ax: "census/1", tool: "ouro-census", checker: { version: "0", sha256: "" }, target: { repo: null, ref: null, commit: null }, at: "",
    products: [{
      product: "harness", walked: { kinds: ["mcp"], finders: [] },
      summary: { found: 4, declared: 0, weak: 0, undeclared: 4, unwalked: 0, stale: 0, excluded: 0, baseline: 4 },
      byKind: { mcp: { found: 4, declared: 0, weak: 0, undeclared: 4, unwalked: 0 } },
      undeclared: [gap("mcp:b", "b.ts", 1), gap("mcp:z", "a.ts", null), gap("mcp:y", "a.ts", 2), gap("mcp:x", "a.ts", 2)],
      weak: [], unwalked: [], excluded: [],
    }],
  };
  deepEqual(renderText(report).split("\n").slice(1), ["a.ts:2 mcp:x", "a.ts:2 mcp:y", "a.ts:? mcp:z", "b.ts:1 mcp:b"]);
});

test("run from the command line, it prints the table and sets the exit code", () => {
  const dir = scratch();
  try {
    const baseline = baselineFile(dir, ["mcp:ask", "mcp:status"]);
    const result = spawnSync(process.execPath, [join(here, "census.mts"), ...args("config-ok.json", baseline)], { cwd: here, encoding: "utf8", timeout: 15_000 });
    equal(result.status, 1);
    ok(result.stdout.includes("harness: 3 found, 0 declared, 0 weak, 3 undeclared (mcp 3)"), result.stdout);
    ok(result.stderr.includes("mcp:catchup: a door with no valid card, not on the baseline."), result.stderr);
    ok(result.stderr.includes("ax-census: 1 problem"), result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a door whose name isn't a literal is counted as weak with its reason", async () => {
  const dir = scratch();
  try {
    const { out, io } = capture();
    equal(await run({ argv: args("config-computed.json", baselineFile(dir, ["mcp:ask", "mcp:check_response"])), io, root: here }), 0);
    ok(out.includes("harness: 2 found, 0 declared, 2 weak, 0 undeclared (mcp 2)"), out.join("\n"));
    ok(out.includes("walkers/fixtures/mcp-computed.ts:? mcp:ask (weak: name: not a literal; card: none declared)"), out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a walker source the base has and this branch lacks fails", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const gaps = ["mcp:ask", "mcp:status", "mcp:catchup", "mcp:delegate"];
    const argv = ["--config", join(fixtures, "config-ok.json"), "--baseline", baselineFile(dir, gaps.slice(0, 3)), "--base-baseline", baselineFile(dir, gaps, "base.json"), "--base-config", join(fixtures, "config-four.json")];
    equal(await run({ argv, io, root: here }), 1);
    ok(err.some((e) => e.startsWith("mcp-schemas walkers/fixtures/mcp-four.cjs walkers/fixtures/mcp-four.ts: a walker source on the base branch is missing here.")), err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed card is weak, not a crash, and the report names the repository", async () => {
  const dir = scratch();
  try {
    const { out, err, io } = capture();
    const file = join(dir, "census.json");
    const code = await run({ argv: args("config-malformed.json", baselineFile(dir, ["mcp:ask"]), ["--out", file, "--repo", "ourostack/ouroboros"]), io, root: here });
    equal(code, 0, err.join("\n"));
    ok(out.some((l) => l.includes("mcp:ask (weak: card: malformed")), out.join("\n"));
    equal(JSON.parse(readFileSync(file, "utf8")).target.repo, "ourostack/ouroboros");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--inventory writes the declared doors only, in the X-ray's inventory shape", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const file = join(dir, "inventory.json");
    const code = await run({ argv: args("config-declared.json", baselineFile(dir, ["mcp:status"]), ["--inventory", file]), io, root: here });
    equal(code, 0, err.join("\n"));
    deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcp: ["ask"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CLI_GAPS = [
  "mcp:ask", "mcp:status", "mcp:catchup",
  "cli:connect", "cli:friend", "cli:friend list", "cli:friend show", "cli:lock", "cli:mode", "cli:mode live", "cli:mode shadow",
  "cli:secret", "cli:secret rotate", "cli:stop", "cli:tool", "cli:tool run", "cli:unlock", "cli:up", "cli:work", "cli:work card", "cli:work gauntlet",
  "cli:pause", "cli:resume", "cli:seal", "cli:key", "cli:key acme", "cli:key acme add", "cli:key acme show",
  "cli:kind seal", "cli:kind hidden", "cli:kind extra", "cli:kind resume.all", "cli:type { kind: `plug.${string}` }", 'cli:type Partial<{ kind: "partial" }>',
  "cli:node dist/alias-entry.js", "cli:node dist/bracket-entry.js", "cli:node dist/global-entry.js",
  "cli:node dist/daemon-entry.js", "cli:node dist/ouro-entry.mjs rescue", "cli:node dist/lone-entry.js", "cli:node dist/stats-main.js", "cli:node dist/stats-main.js summary", "cli:node dist/stats-main.js export",
];

test("a census with the CLI walkers walks both kinds, and counts unwalked kinds against zero", async () => {
  const dir = scratch();
  try {
    const { out, err, io } = capture();
    const file = join(dir, "census.json");
    const code = await run({ argv: args("config-cli.json", baselineFile(dir, CLI_GAPS), ["--out", file]), io, root: here });
    equal(code, 0, err.join("\n"));
    const product = JSON.parse(readFileSync(file, "utf8")).products[0];
    deepEqual(product.walked.kinds, ["mcp", "cli"]);
    equal(product.summary.unwalked, 6);
    deepEqual(product.unwalked.map((g: { id: string }) => g.id), ["cli:kind seal", "cli:kind hidden", "cli:kind extra", "cli:kind resume.all", "cli:type { kind: `plug.${string}` }", 'cli:type Partial<{ kind: "partial" }>']);
    deepEqual(product.byKind.cli, { found: 34, declared: 0, weak: 0, undeclared: 34, unwalked: 6 });
    // Each gap names the walker that found it, even where two walkers find one kind.
    equal(product.undeclared.find((g: { id: string }) => g.id === "cli:up").walker, "ts-parser");
    equal(product.undeclared.find((g: { id: string }) => g.id === "cli:node dist/lone-entry.js").walker, "argv-entries");
    ok(out.includes("harness: 37 found, 0 declared, 0 weak, 37 undeclared, 6 unwalked (mcp 3, cli 34)"), out.join("\n"));
    ok(out.includes("walkers/fixtures/cli/cli-types.ts:" + lineIn("walkers/fixtures/cli/cli-types.ts", '"hidden"') + " cli:kind hidden (unwalked: no walked path returns this kind)"), out.join("\n"));

    // An unwalked kind off the baseline fails like any other gap.
    const short = capture();
    equal(await run({ argv: args("config-cli.json", baselineFile(dir, CLI_GAPS.filter((g) => g !== "cli:kind extra"))), io: short.io, root: here }), 1);
    ok(short.err.some((e) => e.startsWith("cli:kind extra: ")), short.err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source's claims must be a list of entry and parser paths", async () => {
  const dir = scratch();
  try {
    await failsWith(args("config-bad-claims.json", baselineFile(dir, [])), "parser, kinds and claims");
    await failsWith(args("config-bad-handlers.json", baselineFile(dir, [])), "cards must be a string and its handlers a list of paths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function lineIn(file: string, text: string): number {
  return readFileSync(join(here, file), "utf8").split("\n").findIndex((l) => l.includes(text)) + 1;
}

test("the pull request that starts walking CLI doors seeds their baseline against an MCP-only base", async () => {
  const dir = scratch();
  try {
    const { err, io } = capture();
    const argv = ["--config", join(fixtures, "config-cli.json"), "--baseline", baselineFile(dir, CLI_GAPS), "--base-baseline", baselineFile(dir, CLI_GAPS.slice(0, 3), "base.json"), "--base-config", join(fixtures, "config-ok.json")];
    equal(await run({ argv, io, root: here }), 0, err.join("\n"));
    const grown = capture();
    const more = ["--config", join(fixtures, "config-cli.json"), "--baseline", baselineFile(dir, CLI_GAPS, "b2.json"), "--base-baseline", baselineFile(dir, CLI_GAPS.slice(0, 2), "base2.json"), "--base-config", join(fixtures, "config-ok.json")];
    equal(await run({ argv: more, io: grown.io, root: here }), 1);
    ok(grown.err.includes("mcp:catchup: added to the baseline. Fix: declare the door instead; the baseline only shrinks."), grown.err.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI doors carry their declarations' cards: declared, weak with reasons, and in the inventory", async () => {
  const dir = scratch();
  try {
    const gaps = [
      "cli:friend show", "cli:work card", "cli:work gauntlet", "cli:mode live", "cli:mode shadow", "cli:pause", "cli:resume", "cli:friend", "cli:connect",
      "cli:work", "cli:mode", "cli:lock", "cli:unlock", "cli:tool", "cli:seal", "cli:secret", "cli:secret rotate", "cli:tool run",
      "cli:key", "cli:key acme", "cli:key acme add", "cli:key acme show",
      "cli:kind extra", "cli:kind resume.all", "cli:kind hidden", "cli:type { kind: `plug.${string}` }", 'cli:type Partial<{ kind: "partial" }>',
    ];
    const { out, err, io } = capture();
    const file = join(dir, "census.json");
    const inventory = join(dir, "inventory.json");
    const code = await run({ argv: args("config-cli-cards.json", baselineFile(dir, gaps), ["--out", file, "--inventory", inventory]), io, root: here });
    equal(code, 0, err.join("\n"));
    const product = JSON.parse(readFileSync(file, "utf8")).products[0];
    deepEqual(product.byKind.cli, { found: 25, declared: 3, weak: 1, undeclared: 21, unwalked: 5 });
    deepEqual(product.weak.find((g: { id: string }) => g.id === "cli:secret rotate").reasons, [
      "errors[0]: code bad-hex is never raised in walkers/fixtures/cli/cli-parse.ts",
      "effect: read, but the code mutates (others)",
    ]);
    deepEqual(JSON.parse(readFileSync(inventory, "utf8")), { cli: ["up", "stop", "friend list"] });
    ok(out[0]!.startsWith("harness: 25 found, 3 declared, 1 weak, 21 undeclared, 5 unwalked"), out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-turn tools and their approval prompts: both kinds walked, unwalked and excluded counted, prompts declared by their tools", async () => {
  const dir = scratch();
  try {
    const first = capture();
    const probeFile = join(dir, "probe.json");
    await run({ argv: args("config-tools.json", baselineFile(dir, []), ["--out", probeFile]), io: first.io, root: here });
    const probed = JSON.parse(readFileSync(probeFile, "utf8")).products[0];
    const gaps = [...probed.undeclared, ...probed.weak, ...probed.unwalked].map((g: { id: string }) => g.id);
    const { out, err, io } = capture();
    const file = join(dir, "census.json");
    const inventory = join(dir, "inventory.json");
    equal(await run({ argv: args("config-tools.json", baselineFile(dir, gaps, "all.json"), ["--out", file, "--inventory", inventory]), io, root: here }), 0, err.join("\n"));
    const product = JSON.parse(readFileSync(file, "utf8")).products[0];
    deepEqual(product.walked.kinds, ["tool", "approval"]);
    deepEqual(product.byKind, {
      tool: { found: 14, declared: 5, weak: 3, undeclared: 6, unwalked: 9 },
      approval: { found: 4, declared: 2, weak: 1, undeclared: 1, unwalked: 0 },
    });
    deepEqual(product.summary.excluded, 1);
    deepEqual(product.excluded, [{ hit: `walkers/fixtures/tools/src/nested/passthrough.ts:${lineIn("walkers/fixtures/tools/src/nested/passthrough.ts", "mcp__")}`, category: "third-party-passthrough" }]);
    // The approval prompt shares its tool's card, so it isn't a near-duplicate of it, and its tool's weakness carries over.
    deepEqual(product.weak.find((g: { id: string }) => g.id === "approval:resume_queue").reasons, [
      "card: tool:resume_queue is weak",
      "effect: the code asks for approval here, but tool:resume_queue says write",
      "confirm: required for consequential",
    ]);
    ok(!product.weak.some((g: { id: string }) => g.id === "tool:restart_box"), JSON.stringify(product.weak));
    deepEqual(JSON.parse(readFileSync(inventory, "utf8")), {
      tool: ["restart_box", "list_contacts", "rest", "list_rows", "read_note"],
      approval: ["restart_box", "restart_box"],
    });
    ok(out[0]!.startsWith("harness: 18 found, 7 declared, 4 weak, 7 undeclared, 9 unwalked (tool 14, approval 4)"), out.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source's passthrough and approvals must be lists", async () => {
  const dir = scratch();
  try {
    await failsWith(args("config-bad-passthrough.json", baselineFile(dir, [])), "passthrough, approvals and reshape must be lists of <file>#<function>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
