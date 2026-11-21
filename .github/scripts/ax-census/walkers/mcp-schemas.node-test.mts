import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkMcpSchemas } from "./mcp-schemas.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const repo = resolve(here, "../../../..");

function walk(name: string) {
  return walkMcpSchemas({ product: "harness", module: `${name}.cjs`, source: `${name}.ts`, root: fixtures });
}

function lineOf(file: string, literal: string): number {
  return readFileSync(join(fixtures, file), "utf8").split("\n").findIndex((l) => l.includes(`name: "${literal}"`)) + 1;
}

test("lists every tool getToolSchemas returns, with its source line", async () => {
  const { doors, errors } = await walk("mcp-ok");
  deepEqual(errors, []);
  deepEqual(doors.map((d) => d.id), ["mcp:ask", "mcp:status", "mcp:catchup"]);
  for (const door of doors) {
    equal(door.line, lineOf("mcp-ok.ts", door.name), door.id);
    equal(door.file, "mcp-ok.ts");
    equal(door.kind, "mcp");
    equal(door.product, "harness");
    equal(door.card, null);
  }
});

test("a duplicate name is a census error naming both lines", async () => {
  const { errors } = await walk("mcp-dup");
  deepEqual(errors, ["mcp:ask: listed twice, at mcp-dup.ts:4 and mcp-dup.ts:12"]);
});

test("a name that is not a literal is counted with line null", async () => {
  const { doors, errors } = await walk("mcp-computed");
  deepEqual(errors, []);
  deepEqual(doors.map((d) => [d.id, d.line]), [["mcp:ask", null], ["mcp:check_response", null]]);
});

test("reads the ax card when a schema has one", async () => {
  const { doors } = await walk("mcp-card");
  equal(doors[0]!.card!.id, "mcp:ask");
  equal(doors[0]!.evidence.readOnly, true);
});

const built = join(repo, "dist/heart/mcp/mcp-server.js");
test("the real harness server lists 17 tools", { skip: existsSync(built) ? false : "run npm run build first" }, async () => {
  const { doors, errors } = await walkMcpSchemas({ product: "harness", module: "dist/heart/mcp/mcp-server.js", source: "src/heart/mcp/mcp-server.ts", root: repo });
  deepEqual(errors, []);
  equal(doors.length, 17);
  const ask = doors.find((d) => d.id === "mcp:ask");
  ok(ask);
  // 654 at the time of writing; read from the source so an edit above it doesn't break the test.
  const source = readFileSync(join(repo, "src/heart/mcp/mcp-server.ts"), "utf8").split("\n");
  equal(ask.line, source.findIndex((l) => l.includes('name: "ask"')) + 1);
  equal(ask.file, "src/heart/mcp/mcp-server.ts");
  ok(doors.every((d) => typeof d.line === "number"));
});

test("a module without getToolSchemas is a census error", async () => {
  const { doors, errors } = await walkMcpSchemas({ product: "harness", module: "mcp-none.cjs", source: "mcp-ok.ts", root: fixtures });
  deepEqual(doors, []);
  deepEqual(errors, ["mcp-none.cjs: exports no getToolSchemas function"]);
});

test("a tool without a name is a census error", async () => {
  const { doors, errors } = await walk("mcp-noname");
  deepEqual(doors, []);
  deepEqual(errors, ["mcp-noname.cjs: getToolSchemas returned a tool without a name"]);
});

test("records which of a card's error codes the source raises outside the card", async () => {
  const { doors, errors } = await walk("mcp-raises");
  deepEqual(errors, []);
  deepEqual(doors[0]!.evidence.raises, ["daemon-down"]);
});

test("a server with tool cards and no unknown-door card is a census error", async () => {
  const { errors } = await walk("mcp-no-server-card");
  deepEqual(errors, ["mcp-no-server-card.cjs: declares tool cards but exports no serverErrors with an unknown-door card, the answer to an unknown tool name"]);
});

test("an unknown-door card the source never raises is a census error", async () => {
  const { errors } = await walk("mcp-unknown-unraised");
  deepEqual(errors, ["mcp-unknown-unraised.cjs: the unknown-door code is never raised in mcp-unknown-unraised.ts"]);
});

test("a server with no cards needs no server card", async () => {
  const { doors } = await walk("mcp-ok");
  ok(doors.every((d) => d.evidence.raises === undefined));
});

test("reads read-only evidence from the served listTools() annotations when the server exports it", async () => {
  const { doors } = await walkMcpSchemas({ product: "harness", module: "mcp-served.cjs", source: "mcp-ok.ts", root: fixtures });
  deepEqual(doors.map((d) => [d.id, d.evidence.readOnly ?? false]), [["mcp:ask", false], ["mcp:status", true], ["mcp:catchup", false]]);
});

test("an error card built by a helper is a declaration, not a raise", async () => {
  const { doors, errors } = await walk("mcp-helper-card");
  deepEqual(errors, []);
  deepEqual(doors[0]!.evidence.raises, []);
});
