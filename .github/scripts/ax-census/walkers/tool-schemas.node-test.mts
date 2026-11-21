import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkToolSchemas } from "./tool-schemas.mts";
import type { WalkerOptions } from "../types.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const root = join(fixtures, "tools");
const repo = resolve(here, "../../../..");

function walk(extra: Partial<WalkerOptions> = {}, at = root) {
  return walkToolSchemas({ product: "harness", module: "built", source: "src", root: at, handlers: ["src/dispatch.ts"], ...extra });
}

function lineOf(file: string, text: string, at = root): number {
  return readFileSync(join(at, file), "utf8").split("\n").findIndex((l) => l.includes(text)) + 1;
}

test("every tool schema outside tests is a door at its name, through as const, a const name and a factory's literal calls", async () => {
  const { doors, errors } = await walk();
  deepEqual(errors, []);
  const tools = doors.filter((d) => d.kind === "tool").map((d) => [d.id, d.file, d.line]);
  deepEqual(tools, [
    ["tool:restart_box", "src/approval.ts", lineOf("src/approval.ts", '"restart_box", description')],
    ["tool:list_contacts", "src/approval.ts", lineOf("src/approval.ts", '"list_contacts"')],
    ["tool:resume_queue", "src/approval.ts", lineOf("src/approval.ts", '"resume_queue"')],
    ["tool:send_mail", "src/approval.ts", lineOf("src/approval.ts", '"send_mail"')],
    ["tool:hidden_policy", "src/approval.ts", lineOf("src/approval.ts", '"hidden_policy"')],
    ["tool:rest", "src/engine.ts", lineOf("src/engine.ts", '"rest"')],
    ["tool:list_rows", "src/factory.ts", lineOf("src/factory.ts", '"list_rows"')],
    ["tool:drop_rows", "src/factory.ts", lineOf("src/factory.ts", '"drop_rows"')],
    // A template over a literal list makes one door per item.
    ["tool:queue_pause", "src/factory.ts", lineOf("src/factory.ts", "queue_${action}")],
    ["tool:queue_resume", "src/factory.ts", lineOf("src/factory.ts", "queue_${action}")],
    ["tool:local_tool", "src/nested/passthrough.ts", lineOf("src/nested/passthrough.ts", '"local_tool"')],
    ["tool:read_note", "src/notes.ts", lineOf("src/notes.ts", '"read_note", description')],
    ["tool:save_note", "src/notes.ts", lineOf("src/notes.ts", '"save_note"')],
    ["tool:ping", "src/notes.ts", lineOf("src/notes.ts", "name: PING")],
  ]);
  // Tests and the tool call records are not doors.
  ok(!doors.some((d) => d.name.startsWith("test_only")));
  equal(doors.filter((d) => d.name === "read_note").length, 1);
});

test("a name the census can't read to a literal is unwalked at its place, with the reason", async () => {
  const { unwalked = [] } = await walk();
  deepEqual(unwalked.map((g) => [g.id, g.line, g.reasons]), [
    ["tool:src/factory.ts#define(dynamicName)", lineOf("src/factory.ts", "define(dynamicName"), ["name: define is called with a name that isn't a literal"]],
    ...["deep_${action}", "two_${a}_${b}", "key_${obj.k}", "free_${free}", "each_${action}"].map((t) => [`tool:src/factory.ts#define(\`${t}\`)`, lineOf("src/factory.ts", t), ["name: define is called with a name that isn't a literal"]]),
    ["tool:src/factory.ts#label", lineOf("src/factory.ts", "orphan ="), ["name: the parameter label of orphan, which is never called in this file with a literal"]],
    ["tool:src/factory.ts#function: makeFunction()", lineOf("src/factory.ts", "opaque ="), ["function: not an object literal the census can read"]],
    ["tool:src/nested/passthrough.ts#`mcp__${entry.server}__${tool.name}`", lineOf("src/nested/passthrough.ts", "mcp__"), ["name: not a literal, a const holding one, or a factory parameter called with one"]],
    ["tool:src/nested/passthrough.ts#`${PREFIX}${tool.name}`", lineOf("src/nested/passthrough.ts", "${PREFIX}"), ["name: not a literal, a const holding one, or a factory parameter called with one"]],
  ]);
  for (const gap of unwalked) equal(gap.kind, "tool");
});

test("a passthrough schema built only from its function's parameters is excluded, with its place", async () => {
  const { unwalked = [], excluded, errors } = await walk({ passthrough: ["src/nested/passthrough.ts#serverSchema", "src/nested/passthrough.ts#leakySchema"] });
  deepEqual(excluded, [{ hit: `src/nested/passthrough.ts:${lineOf("src/nested/passthrough.ts", "mcp__")}`, category: "third-party-passthrough" }]);
  deepEqual(unwalked.find((g) => g.id.includes("PREFIX"))!.reasons, ["name: in passthrough src/nested/passthrough.ts#leakySchema, but it reads PREFIX, so it isn't only what a connected server lists"]);
  deepEqual(errors, ["tool-schemas: passthrough src/nested/passthrough.ts#leakySchema holds no schema built only from its parameters. Fix: remove it from the config."]);
});

test("a stale or malformed passthrough or approvals entry is a census error", async () => {
  const { errors } = await walk({
    passthrough: ["src/nested/passthrough.ts#gone", "src/missing.ts#serverSchema", "no-hash", "src/nested/passthrough.ts#noSchema"],
    approvals: ["src/approval.ts#gone", "src/approval.ts#decidesNothing", "trailing#"],
  });
  deepEqual(errors, [
    "tool-schemas: passthrough no-hash: give it as <file>#<function>.",
    "tool-schemas: approvals trailing#: give it as <file>#<function>.",
    "tool-schemas: passthrough src/nested/passthrough.ts#gone names no function. Fix: remove it from the config.",
    "tool-schemas: passthrough src/missing.ts#serverSchema names no function. Fix: remove it from the config.",
    "tool-schemas: passthrough src/nested/passthrough.ts#noSchema holds no schema built only from its parameters. Fix: remove it from the config.",
    "tool-schemas: approvals src/approval.ts#gone names no function. Fix: remove it from the config.",
    "tool-schemas: approvals src/approval.ts#decidesNothing compares no tool name. Fix: remove it from the config.",
  ]);
});

test("cards come from the built definitions or a toolCards sidecar, with evidence from the risk profile and raised codes", async () => {
  const { doors } = await walk();
  const byId = new Map(doors.map((d) => [d.id, d]));
  const read = byId.get("tool:read_note")!;
  equal(read.card!.effect, "read");
  equal(read.description, "Read one note.");
  deepEqual(read.evidence, { approval: false, mutates: "none", raises: ["note-missing"] });
  equal(byId.get("tool:save_note")!.card, null);
  deepEqual(byId.get("tool:save_note")!.evidence, { approval: false });
  deepEqual(byId.get("tool:ping")!.evidence, { approval: false, mutates: "depends on arguments", raises: ["invalid-arguments"] });
  deepEqual(byId.get("tool:list_rows")!.evidence, { approval: false, mutates: "durable_state_write", raises: ["invalid-arguments"] });
  equal(byId.get("tool:rest")!.card!.id, "tool:rest");
  equal(byId.get("tool:rest")!.description, "End the turn.");
  deepEqual(byId.get("tool:restart_box")!.evidence, { approval: true, mutates: "external_side_effect", raises: ["box-unreachable"] });
});

test("approval prompts are found from code: a policy that asks, a built policy the literal hides, and a resolver's comparisons", async () => {
  const { doors } = await walk({ approvals: ["src/approval.ts#classify"] });
  const approvals = doors.filter((d) => d.kind === "approval");
  deepEqual(approvals.map((d) => [d.id, d.line, d.declaredBy]), [
    ["approval:restart_box", lineOf("src/approval.ts", 'kind: "required", policyId'), "tool:restart_box"],
    ["approval:resume_queue", lineOf("src/approval.ts", "approvalPolicy: sharedPolicy"), "tool:resume_queue"],
    ["approval:hidden_policy", lineOf("src/approval.ts", '"hidden_policy"'), "tool:hidden_policy"],
    ["approval:restart_box via classify", lineOf("src/approval.ts", 'name !== "restart_box"'), "tool:restart_box"],
  ]);
  // A prompt is declared by its tool's card.
  equal(approvals[0]!.card, doors.find((d) => d.id === "tool:restart_box")!.card);
  equal(approvals[2]!.card, null);
  ok(!doors.some((d) => d.id === "approval:list_contacts"));
});

test("a name defined twice is a census error naming both places", async () => {
  const { doors, errors, unwalked = [] } = await walk({ handlers: [] }, join(fixtures, "tools-dup"));
  deepEqual(errors, ["tool:twice: defined twice, at src/a.ts:1 and src/b.ts:1"]);
  equal(doors.length, 1);
  // A schema with no name at all is unwalked.
  deepEqual(unwalked.map((g) => [g.id, g.reasons]), [["tool:src/b.ts#no name", ["name: missing"]]]);
});

test("a module that isn't built, or throws on load, is a census error, and its doors have no cards", async () => {
  const { doors, errors } = await walk({ handlers: [] }, join(fixtures, "tools-broken"));
  deepEqual(errors, ["tool-schemas: built/throws.js can't be loaded: boom on load", "tool-schemas: built/unbuilt.js is missing; build the product before the census runs."]);
  deepEqual(doors.map((d) => [d.id, d.card]), [["tool:throws_on_load", null], ["tool:not_built", null]]);
});

test("the real harness: every in-turn tool is found, the MCP passthrough is excluded, and the approval prompts are doors", { skip: existsSync(join(repo, "dist", "repertoire", "tools.js")) ? false : "build the harness first" }, async () => {
  const config = JSON.parse(readFileSync(join(repo, "ax", "census.config.json"), "utf8"));
  const source = config.sources.find((s: { walker: string }) => s.walker === "tool-schemas");
  const { doors, errors, unwalked, excluded = [] } = await walkToolSchemas({ ...source, product: "harness", root: repo });
  deepEqual(errors, []);
  deepEqual(unwalked, []);
  deepEqual(excluded.map((e) => e.category), ["third-party-passthrough"]);
  const tools = doors.filter((d) => d.kind === "tool");
  ok(tools.length > 200, `${tools.length} tools`);
  for (const name of ["complete_adoption", "list_directory", "find_tools", "sanctuary_host_execute", "voice_join_local_audio", "list_sessions_and_chats", "shepherd_correct", "unraid_list_containers", "ponder"]) {
    ok(tools.some((d) => d.name === name), name);
  }
  deepEqual(doors.filter((d) => d.kind === "approval").map((d) => d.id).sort(), [
    "approval:sanctuary_host_execute", "approval:sanctuary_resume_download_queue", "approval:shell", "approval:unraid_restart_container", "approval:unraid_restart_container via classifyApprovalForInvocation",
  ]);
});
