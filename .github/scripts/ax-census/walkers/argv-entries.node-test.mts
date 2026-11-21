import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkArgvEntries } from "./argv-entries.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "entries");
const repo = resolve(here, "../../../..");
const CLAIM = { entry: "src/ouro-entry.mts", parser: "src/parse.ts" };

function walk(claims = [CLAIM]) {
  return walkArgvEntries({ product: "harness", module: "dist", source: "src", root: fixtures, claims });
}

function lineOf(file: string, text: string): number {
  return readFileSync(join(fixtures, file), "utf8").split("\n").findIndex((l) => l.includes(text)) + 1;
}

test("every module that reads process.argv and runs on load is a door, named as an agent runs it", async () => {
  const { doors, errors } = await walk();
  deepEqual(errors, []);
  deepEqual(
    doors.map((d) => [d.id, d.file, d.line]),
    [
      ["cli:node dist/alias-entry.js", "src/alias-entry.ts", lineOf("src/alias-entry.ts", "= process")],
      ["cli:node dist/bracket-entry.js", "src/bracket-entry.ts", lineOf("src/bracket-entry.ts", 'process["argv"]')],
      ["cli:node dist/daemon-entry.js", "src/daemon-entry.ts", lineOf("src/daemon-entry.ts", "= process.argv")],
      ["cli:node dist/global-entry.js", "src/global-entry.ts", lineOf("src/global-entry.ts", "(globalThis")],
      ["cli:node dist/lone-entry.js", "src/lone-entry.ts", lineOf("src/lone-entry.ts", "(process.argv")],
      ["cli:node dist/ouro-entry.mjs rescue", "src/ouro-entry.mts", lineOf("src/ouro-entry.mts", '=== "rescue"')],
      ["cli:node dist/stats-main.js", "src/stats-main.ts", lineOf("src/stats-main.ts", "(process.argv")],
      ["cli:node dist/stats-main.js summary", "src/stats.ts", lineOf("src/stats.ts", '"summary"')],
      ["cli:node dist/stats-main.js export", "src/stats.ts", lineOf("src/stats.ts", '"export"')],
    ],
  );
  for (const door of doors) {
    equal(door.kind, "cli");
    equal(door.card, null);
    deepEqual(door.evidence, { confirmed: false, kinds: [] });
  }
});

test("a claimed entry that reaches its parser is left to that parser's walker, except words the parser never mentions", async () => {
  const { doors } = await walk();
  deepEqual(
    doors.filter((d) => d.id.includes("ouro-entry")).map((d) => [d.id, d.file, d.line]),
    [["cli:node dist/ouro-entry.mjs rescue", "src/ouro-entry.mts", lineOf("src/ouro-entry.mts", '=== "rescue"')]],
  );
  const unclaimed = await walk([]);
  ok(unclaimed.doors.some((d) => d.id === "cli:node dist/ouro-entry.mjs"));
});

test("a claim on a module that isn't an entry, or one that doesn't import its parser, is a census error", async () => {
  const { errors } = await walk([CLAIM, { entry: "src/helper.ts", parser: "src/parse.ts" }, { entry: "src/lone-entry.ts", parser: "src/parse.ts" }]);
  deepEqual(errors, [
    "argv-entries: src/helper.ts is claimed, but it isn't an argv entry point under src",
    "argv-entries: src/lone-entry.ts is claimed by src/parse.ts, but never imports it",
  ]);
});

test("the real harness: the four hand-written CLIs are doors and the ouro entry points are claimed", { skip: existsSync(join(repo, "src")) ? false : "no harness source" }, async () => {
  const { doors, errors } = await walkArgvEntries({
    product: "harness",
    module: "dist",
    source: "src",
    root: repo,
    claims: [
      { entry: "src/heart/daemon/ouro-entry.ts", parser: "src/heart/daemon/cli-parse.ts" },
      { entry: "src/heart/daemon/ouro-bot-entry.ts", parser: "src/heart/daemon/cli-parse.ts" },
    ],
  });
  deepEqual(errors, []);
  for (const main of ["heart/session-stats-cli-main", "heart/session-playback-cli-main", "heart/session-redaction-repair-cli-main", "nerves/review/cli-main"]) {
    ok(doors.some((d) => d.id === `cli:node dist/${main}.js`), main);
  }
  ok(!doors.some((d) => d.id.includes("ouro-entry") || d.id.includes("ouro-bot-entry")));
  ok(!doors.some((d) => d.file.includes("__tests__")));
});
