// The in-turn tools projection of the one action model: the function tools an agent harness hands its model inside a
// turn, each with its Ouro AX card, both from the one declaration. A harness loads tools.json instead of writing tool
// schemas and cards by hand, so its schemas and its Ouro AX card can't disagree.
//
// From an action set it writes:
//   tools.json  { generator, set, tools, errors, refusals }: `tools` is one entry per action an agent may call,
//               `{ type: "function", function: { name, description, parameters }, ax }`, which is the OpenAI chat
//               function tool plus its card, the shape Ouro AX's X-ray reads from a harness's `tools/list`
//               (`--tools`); `errors` are the error cards every tool shares; `refusals` are the person-only actions'
//               typed refusals, which a harness answers when a model calls one by name
//
// `ax` is the Ouro AX census's DoorCard (ourostack/ouro-ui scripts/ouro-census/types.mts): id `tool:<id>`, the group,
// the declaration's `when` and `errors`, its consent as `effect`, `destructive` and `idempotent` as MCP's hints say
// them, and a consequential action's `confirm`, the approval question word for word. A person-only action has no tool,
// as it has no App Intent or AppFunction. Every action an agent may call must declare `when`; generate fails without it.
//
// It imports only core's action model, so an app vendors it beside that file, and runs it with Node 22.18 or later:
//   node ouro-actions-tools.mts generate <actions.mts> <dir>   write tools.json into <dir>
//   node ouro-actions-tools.mts check <actions.mts> <dir>      fail when <dir> differs from what generate writes
// The declarations module may name the cards' group as `export const tools = { group }`; it is the set's name otherwise.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ACTIONS_VERSION, actionText, annotationsOf, inputSchema, refusal, type Action, type ActionError, type ActionSet, type Consent } from "./ouro-actions.mts";

const GENERATOR = `ouro-actions-tools ${ACTIONS_VERSION}`;

/** What the app tells the projection. */
export interface ToolsOptions {
  /** The cards' group, an Ouro AX group card's id such as `turn-shopping`. The set's name when left out. */
  group?: string;
}

/** The Ouro AX census's DoorCard for an in-turn tool. */
export interface ToolCard {
  id: `tool:${string}`;
  group: string;
  when: string;
  effect: Consent;
  errors: readonly ActionError[];
  destructive?: true;
  idempotent?: true;
  confirm?: string;
}

/** One in-turn tool: OpenAI's chat function tool, with its card. */
export interface Tool {
  type: "function";
  function: { name: string; description: string; parameters: ReturnType<typeof inputSchema> };
  ax: ToolCard;
}

const GROUP = /^[a-z][a-z0-9]*([-_][a-z0-9]+)*$/;

export function checkOptions(value: unknown): ToolsOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) throw new Error(`tools options are ${JSON.stringify(value)}. Fix: export const tools = { group: "turn-shopping" };`);
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) if (key !== "group") throw new Error(`tools options: "${key}" is not an option. Fix: only group.`);
  const group = r["group"];
  if (group === undefined) return {};
  if (typeof group !== "string" || !GROUP.test(group)) throw new Error(`tools options: group is ${JSON.stringify(group)}. Fix: lowercase words joined by - or _, such as "turn-shopping".`);
  return { group };
}

/** The in-turn tool for an action an agent may call. */
export function toTool(a: Action, group: string): Tool {
  if (a.consent === "person-only") throw new Error(`action "${a.id}" is person-only, so no agent calls it and it has no tool. Fix: answer a call to it with refusals["${a.id}"].`);
  if (a.when === undefined) throw new Error(`action "${a.id}": an in-turn tool needs when, its card's one line. Fix: when: "Pick this to <what it's for>; to <a neighbour's job>, use <neighbour>."`);
  const hints = annotationsOf(a);
  const confirm = actionText(a).confirm;
  const ax: ToolCard = { id: `tool:${a.id}`, group, when: a.when, effect: a.consent, errors: a.errors ?? [] };
  if (hints.destructiveHint) ax.destructive = true;
  if (a.consent === "read" || hints.idempotentHint) ax.idempotent = true;
  if (confirm !== undefined) ax.confirm = confirm;
  return { type: "function", function: { name: a.id, description: a.agent, parameters: inputSchema(a) }, ax };
}

/** The error card a harness answers when a model calls a person-only action by name. */
const PERSON_ONLY: ActionError = {
  code: "person-only",
  means: "Only the person can do this, so no agent may call it; the refusal says why and where the person does it.",
  fix: "Tell the person what the refusal says, and leave the step to them.",
};

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Every file generate writes, by name. Deterministic: the same set and options render the same bytes. */
export function renderTools(set: ActionSet, options: ToolsOptions): Map<string, string> {
  const group = checkOptions(options).group ?? set.name;
  const personOnly = set.actions.filter((a) => a.consent === "person-only");
  const tools = set.actions.filter((a) => a.consent !== "person-only").map((a) => toTool(a, group));
  const errors = personOnly.length ? [PERSON_ONLY] : [];
  const refusals = Object.fromEntries(personOnly.map((a) => [a.id, refusal(a)]));
  return new Map([["tools.json", json({ generator: GENERATOR, set: set.name, tools, errors, refusals })]]);
}

async function readDir(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return found;
  }
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const text = await readFile(join(dir, name), "utf8").catch((error: { code?: string }) => (error.code === "EISDIR" ? null : Promise.reject(error)));
    if (text !== null) found.set(name, text);
  }
  return found;
}

/** Every way `found` differs from what the set generates. */
export function checkTools(set: ActionSet, options: ToolsOptions, found: ReadonlyMap<string, string>): string[] {
  const expected = renderTools(set, options);
  const problems: string[] = [];
  for (const [path, text] of expected) {
    const have = found.get(path);
    if (have === undefined) problems.push(`${path}: missing. Fix: run generate.`);
    else if (have !== text) {
      const a = text.split("\n");
      const b = have.split("\n");
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      problems.push(`${path}:${i + 1}: drifted from its declaration: expected ${JSON.stringify(a[i] ?? "<end of file>")}, found ${JSON.stringify(b[i] ?? "<end of file>")}. Fix: change the declaration and run generate; never edit a generated file.`);
    }
  }
  for (const path of found.keys()) if (!expected.has(path)) problems.push(`${path}: not generated from any declaration. Fix: delete it.`);
  return problems;
}

const USAGE = "usage: node ouro-actions-tools.mts generate|check <actions.mts> <dir>";

/** Runs the CLI; returns the exit code: 0 clean, 1 drift, 2 usage. */
export async function main(argv: readonly string[], io: { out(s: string): void; err(s: string): void }): Promise<number> {
  const [cmd, declarations, dir, ...rest] = argv;
  if (!cmd || !declarations || !dir || rest.length || !["generate", "check"].includes(cmd)) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const mod = (await import(pathToFileURL(resolve(declarations)).href)) as { default?: ActionSet; tools?: unknown };
  if (!mod.default || !Array.isArray(mod.default.actions)) throw new Error(`${declarations}: has no default export from defineActions. Fix: export default defineActions("<name>", [ ... ]).`);
  const options = checkOptions(mod.tools);
  if (cmd === "generate") {
    const files = renderTools(mod.default, options);
    await mkdir(dir, { recursive: true });
    for (const [path, text] of files) await writeFile(join(dir, path), text);
    io.out(`ouro-actions-tools: wrote ${files.size} file for ${mod.default.actions.length} actions into ${dir}.\n`);
    return 0;
  }
  const problems = checkTools(mod.default, options, await readDir(dir));
  for (const p of problems) io.err(`ouro-actions-tools: ${p}\n`);
  if (problems.length) return 1;
  io.out(`ouro-actions-tools: ${mod.default.actions.length} actions, every in-turn tool matches its declaration.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`ouro-actions-tools: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
