import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkTsParser } from "./ts-parser.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "cli");
const repo = resolve(here, "../../../..");

function walk(overrides: Partial<{ module: string; source: string; parser: string; kinds: string }> = {}) {
  return walkTsParser({ product: "harness", module: "cli-parse.cjs", source: "cli-parse.ts", parser: "parseCommand", kinds: "cli-types.ts#Command", root: fixtures, ...overrides });
}

/** The 1-based line of the first line in `file` that holds `text`. */
function lineOf(file: string, text: string, root = fixtures): number {
  return readFileSync(join(root, file), "utf8").split("\n").findIndex((l) => l.includes(text)) + 1;
}

test("finds every word path the parser dispatches on, each at the line of its comparison", async () => {
  const { doors, errors } = await walk();
  deepEqual(errors, []);
  deepEqual(doors.map((d) => d.id).sort(), [
    "cli:connect",
    "cli:friend",
    "cli:friend list",
    "cli:friend show",
    "cli:lock",
    "cli:mode",
    "cli:mode live",
    "cli:mode shadow",
    "cli:secret",
    "cli:secret rotate",
    "cli:stop",
    "cli:tool",
    "cli:tool run",
    "cli:unlock",
    "cli:up",
    "cli:work",
    "cli:work card",
    "cli:work gauntlet",
  ]);
  const at = (id: string) => doors.find((d) => d.id === id)!;
  equal(at("cli:up").line, lineOf("cli-parse.ts", 'head === "up"'));
  equal(at("cli:friend show").line, lineOf("cli-parse.ts", 'sub === "show"'));
  equal(at("cli:work card").line, lineOf("cli-parse.ts", 'case "card"'));
  equal(at("cli:mode live").line, lineOf("cli-parse.ts", "const MODES"));
  equal(at("cli:unlock").line, lineOf("cli-parse.ts", '["lock", "unlock"]'));
  // A sub-parser in another file reports its own file and line.
  equal(at("cli:tool run").file, "cli-tool.ts");
  equal(at("cli:tool run").line, lineOf("cli-tool.ts", 'sub === "run"'));
  for (const door of doors) {
    equal(door.kind, "cli");
    equal(door.product, "harness");
    equal(door.name, door.id.slice(4));
    equal(door.card, null);
  }
});

test("flags are never words, and an argument the parent already returns is not a door", async () => {
  const { doors } = await walk();
  ok(!doors.some((d) => d.name.includes("-")), "no --agent door");
  // `connect providers` returns the same kind as `connect`: providers is an argument.
  ok(!doors.some((d) => d.name.startsWith("connect ")));
});

test("a path is confirmed by a kind its parent doesn't return, using the flags its parsers mention", async () => {
  const { doors } = await walk();
  const at = (id: string) => doors.find((d) => d.id === id)!;
  deepEqual(at("cli:friend show").evidence, { confirmed: true, kinds: ["friend.show"] });
  deepEqual(at("cli:unlock").evidence, { confirmed: true, kinds: ["vault.unlock"] });
  deepEqual(at("cli:tool run").evidence, { confirmed: true, kinds: ["tool.run"] });
  // A group that only prefixes doors returns nothing itself.
  deepEqual(at("cli:friend").evidence, { confirmed: false, kinds: [] });
});

test("a path no filler can make return is kept, unconfirmed, with the kinds its own branch returns", async () => {
  const { doors } = await walk();
  deepEqual(doors.find((d) => d.id === "cli:secret rotate")!.evidence, { confirmed: false, kinds: ["secret.rotate"] });
});

test("two words in one `||` that always parse the same are one door with an alias", async () => {
  const { doors } = await walk();
  deepEqual(doors.find((d) => d.id === "cli:stop")!.aliases, ["down"]);
  ok(!doors.some((d) => d.id === "cli:down"));
  // lock and unlock share a comparison but parse differently.
  equal(doors.find((d) => d.id === "cli:lock")!.aliases, undefined);
});

test("every kind of the command type that no walked path reaches is an unwalked gap at its line in the type", async () => {
  const { unwalked } = await walk();
  deepEqual(unwalked, [
    { id: "cli:kind hidden", kind: "cli", file: "cli-types.ts", line: lineOf("cli-types.ts", '"hidden"'), walker: "ts-parser", reasons: ["no walked path returns this kind"] },
    { id: "cli:kind extra", kind: "cli", file: "cli-extra.ts", line: lineOf("cli-extra.ts", '"extra"'), walker: "ts-parser", reasons: ["no walked path returns this kind"] },
  ]);
});

test("a module without the parser, a source without it, or a type without kinds is a census error", async () => {
  deepEqual(await walk({ module: "../mcp-none.cjs" }), { doors: [], errors: ["../mcp-none.cjs: exports no parseCommand function"], unwalked: [] });
  deepEqual(await walk({ parser: "parseNothing", module: "cli-parse.cjs" }), { doors: [], errors: ["cli-parse.cjs: exports no parseNothing function"], unwalked: [] });
  const noSource = await walk({ source: "cli-extra.ts" });
  deepEqual(noSource.errors, ["cli-extra.ts: declares no function parseCommand"]);
  const noKinds = await walk({ kinds: "cli-types.ts#Missing" });
  deepEqual(noKinds.errors, ["cli-types.ts#Missing: no type alias with kind literals"]);
  const noSpec = await walk({ kinds: "" });
  deepEqual(noSpec.errors, ["ts-parser needs parser and kinds (<file>#<type>) in its source"]);
});

const built = join(repo, "dist/heart/daemon/cli-parse.js");
// The 21 first words parseOuroCommand accepted that no CLI_COMMANDS entry started with (harness 43c87eead; the AX
// census design's evidence, harness-cli-parser-gap.txt).
const GAP_WORDS = "acp-serve attention changelog config desk git help hook inner mcp-serve migrate-to-desk move plugin presence sanctuary self-update service setup shepherd task up".split(" ");

test("the real harness parser: the 21 missing first words with lines, and every kind reached or reported", { skip: existsSync(built) ? false : "run npm run build first" }, async () => {
  const started = Date.now();
  const { doors, errors, unwalked } = await walkTsParser({
    product: "harness",
    module: "dist/heart/daemon/cli-parse.js",
    source: "src/heart/daemon/cli-parse.ts",
    parser: "parseOuroCommand",
    kinds: "src/heart/daemon/cli-types.ts#OuroCliCommand",
    root: repo,
  });
  ok(Date.now() - started < 10_000, "well inside the census budget");
  deepEqual(errors, []);
  for (const word of GAP_WORDS) {
    const door = doors.find((d) => d.id === `cli:${word}`);
    ok(door, word);
    ok(typeof door.line === "number" && door.line > 0, word);
    ok(door.file.startsWith("src/"), word);
  }
  const reached = new Set(doors.flatMap((d) => d.evidence.kinds ?? []));
  const source = readFileSync(join(repo, "src/heart/daemon/cli-types.ts"), "utf8");
  ok(source.includes("export type OuroCliCommand"));
  for (const gap of unwalked ?? []) ok(!reached.has(gap.id.slice("cli:kind ".length)), gap.id);
  ok(reached.size + (unwalked ?? []).length >= 133, `${reached.size} reached, ${(unwalked ?? []).length} reported`);
});
