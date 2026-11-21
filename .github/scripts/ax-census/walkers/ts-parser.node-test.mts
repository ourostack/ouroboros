import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkTsParser } from "./ts-parser.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "cli");
const repo = resolve(here, "../../../..");

function walk(overrides: Partial<{ module: string; source: string; parser: string; kinds: string; cards: string; handlers: string[] }> = {}) {
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
    "cli:key",
    "cli:key acme",
    "cli:key acme add",
    "cli:key acme show",
    "cli:lock",
    "cli:mode",
    "cli:mode live",
    "cli:mode shadow",
    "cli:pause",
    "cli:resume",
    "cli:seal",
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
  // A word compared with a named constant is that constant's value, at the comparison.
  equal(at("cli:pause").line, lineOf("cli-parse.ts", "head === PAUSE"));
  equal(at("cli:friend show").line, lineOf("cli-parse.ts", 'sub === "show"'));
  equal(at("cli:work card").line, lineOf("cli-parse.ts", 'case "card"'));
  equal(at("cli:mode live").line, lineOf("cli-parse.ts", "const MODES"));
  equal(at("cli:unlock").line, lineOf("cli-parse.ts", '["lock", "unlock"]'));
  // A sub-parser in another file reports its own file and line.
  equal(at("cli:tool run").file, "cli-tool.ts");
  equal(at("cli:tool run").line, lineOf("cli-tool.ts", 'sub === "run"'));
  // A word a throwing guard checks with !== leads to the words read after the guard.
  equal(at("cli:key acme add").line, lineOf("cli-tool.ts", 'action !== "add"'));
  deepEqual(at("cli:key acme show").evidence, { confirmed: true, kinds: ["key.show"] });
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
  deepEqual((unwalked ?? []).filter((g) => g.id.startsWith("cli:kind ")), [
    { id: "cli:kind seal", kind: "cli", file: "cli-tool.ts", line: lineOf("cli-tool.ts", '{ kind: "seal"; code'), walker: "ts-parser", reasons: ["no walked path returns this kind"] },
    { id: "cli:kind hidden", kind: "cli", file: "cli-types.ts", line: lineOf("cli-types.ts", '"hidden"'), walker: "ts-parser", reasons: ["no walked path returns this kind"] },
    { id: "cli:kind extra", kind: "cli", file: "cli-extra.ts", line: lineOf("cli-extra.ts", '"extra"'), walker: "ts-parser", reasons: ["no walked path returns this kind"] },
    { id: "cli:kind resume.all", kind: "cli", file: "cli-types.ts", line: lineOf("cli-types.ts", '"resume.all"'), walker: "ts-parser", reasons: ["no walked path returns this kind"] },
  ]);
});

test("a union member whose kind isn't string literals is an unwalked gap, so the cross-check fails closed", async () => {
  const { unwalked } = await walk();
  const unread = (unwalked ?? []).filter((g) => g.id.startsWith("cli:type "));
  const reason = ["the kind cross-check can't read this member's kind as string literals"];
  deepEqual(unread, [
    { id: "cli:type { kind: `plug.${string}` }", kind: "cli", file: "cli-types.ts", line: lineOf("cli-types.ts", "plug."), walker: "ts-parser", reasons: reason },
    { id: 'cli:type Partial<{ kind: "partial" }>', kind: "cli", file: "cli-types.ts", line: lineOf("cli-types.ts", "Partial<"), walker: "ts-parser", reasons: reason },
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

function cards(spec = "cli-manifest.cjs#COMMANDS") {
  return walk({ cards: spec, handlers: ["cli-handler.ts"] });
}

test("a door's card, summary and effect evidence come from its declaration", async () => {
  const { doors, errors } = await cards();
  deepEqual(errors, []);
  const at = (id: string) => doors.find((d) => d.id === id)!;
  equal(at("cli:up").card!.when, "Pick this first on a fresh machine, before anything that needs the background runtime.");
  // The summary is the door's description, so a `when` line that only repeats it is weak.
  equal(at("cli:up").description, "Start the fixture daemon.");
  deepEqual(at("cli:friend list").evidence, { confirmed: true, kinds: ["friend.list"], readOnly: true, raises: ["no-friend"] });
  // A command other people see is evidence of mutation, so its card can't say read.
  equal(at("cli:secret rotate").evidence.mutates, "others");
  // A door with no declaration, or a declaration without a card, stays undeclared.
  equal(at("cli:work card").card, null);
  equal(at("cli:seal").card, null);
});

test("an error code counts as raised only where it is a literal outside a card, in the door's file or a handler", async () => {
  const { doors } = await cards();
  deepEqual(doors.find((d) => d.id === "cli:up")!.evidence.raises, ["daemon-down"]);
  // bad-hex is only in its card.
  deepEqual(doors.find((d) => d.id === "cli:secret rotate")!.evidence.raises, []);
  const unhandled = await walk({ cards: "cli-manifest.cjs#COMMANDS" });
  deepEqual(unhandled.doors.find((d) => d.id === "cli:up")!.evidence.raises, []);
});

test("an alias's declaration needs no card, and an example reaches the kind it parses to", async () => {
  const { doors, unwalked, errors } = await cards();
  deepEqual(errors, []);
  ok(!doors.some((d) => d.id === "cli:down"));
  deepEqual(doors.find((d) => d.id === "cli:seal")!.evidence, { confirmed: true, kinds: ["seal"] });
  deepEqual(doors.find((d) => d.id === "cli:secret rotate")!.evidence.confirmed, true);
  ok(!(unwalked ?? []).some((g) => g.id === "cli:kind seal"));
  ok((unwalked ?? []).some((g) => g.id === "cli:kind hidden"));
});

test("a stale declaration, an alias's own card, a bad example and a name declared twice are census errors", async () => {
  deepEqual((await cards("cli-manifest.cjs#STALE")).errors, ["cli:nope: declared in cli-manifest.cjs#STALE, but no walked path reaches it. Fix: remove the declaration, or make the parser accept its words."]);
  deepEqual((await cards("cli-manifest.cjs#BAD")).errors, [
    "cli:up: declared twice in cli-manifest.cjs#BAD.",
    "cli:down: an alias of cli:stop has a card of its own. Fix: list down in cli:stop's card aliases and drop this card.",
    "cli:seal: its example `seal now` doesn't parse (throws Usage: seal <6 digits>). Fix: give an example the parser accepts.",
    "cli:tool run: its example `up --name x` doesn't start with its words.",
  ]);
  deepEqual((await cards("cli-manifest.cjs#NOT_A_LIST")).errors, ["cli-manifest.cjs#NOT_A_LIST: not a list of declarations with names."]);
  deepEqual((await cards("cli-manifest.cjs")).errors, ["cards cli-manifest.cjs: give it as <module>#<export>."]);
});

test("a CLI that declares cards must export serverErrors with an unknown-door card, and raise it", async () => {
  const none = await walk({ cards: "cli-manifest.cjs#COMMANDS", module: "cli-parse.cjs", handlers: [] });
  deepEqual(none.errors, ["cli-manifest.cjs: the CLI declares cards but unknown-door is never raised in its handler files."]);
  const bare = await cards("cli-manifest-bare.cjs#COMMANDS");
  deepEqual(bare.errors, ["cli-manifest-bare.cjs: the CLI declares cards but exports no serverErrors with an unknown-door card, the answer to an unknown command."]);
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
