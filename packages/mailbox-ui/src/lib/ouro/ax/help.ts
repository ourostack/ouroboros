export { commandManifest, DEFAULT_WIDTH, definitionLines, flagLines, helpJson, renderCommand, renderOverview, wrap };
export type { CommandManifest, OverviewOptions };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { argUsage, BUILTIN_FLAGS, flagsOf, flagUsage, inputSchema, invocation, usageOf, type Cli, type CommandDef, type JsonSchema } from "./command.ts";
import { DRY_RUN_FLAG, WHY_FLAG } from "./effects.ts";
import { voiceLines } from "./voice.ts";

/**
 * Help from the definitions: a one-screen overview under the two effect headings, each command's details, and the same
 * as JSON (`help --json`), which an agent parses instead of scraping text. Every line is wrapped to `width` columns.
 *
 * @claim "a one-screen overview under the two effect headings" registry/ouro/ax/help.test.mts verify:testExists(registry/ouro/ax/help.test.mts::the overview is the two headings, one line per command, and the exit codes)
 * @claim "Every line is wrapped" registry/ouro/ax/help.test.mts verify:testExists(registry/ouro/ax/help.test.mts::a command's help is generated from its definition, and an others command says so first)
 */
const DEFAULT_WIDTH = 100;

/**
 * Wraps text to `width` columns, every line indented; a word longer than a line stays whole.
 *
 * @claim "every line indented" registry/ouro/ax/help.test.mts verify:testExists(registry/ouro/ax/help.test.mts::wrap keeps long words whole and indents every line)
 */
function wrap(text: string, indent: number, first: number = indent, width: number = DEFAULT_WIDTH): [...string[], string] {
  const lines: string[] = [];
  let line = " ".repeat(first);
  let empty = true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line);
      line = " ".repeat(indent);
      empty = true;
    }
    line += (empty ? "" : " ") + word;
    empty = false;
  }
  return [...lines, line];
}

interface OverviewOptions {
  width?: number;
  /** Added after the "others" heading, such as " (only when a human asked you to, with --why)". */
  othersNote?: string;
  /** Lines after the command lists; defaults to where details are, --json and the exit codes. */
  footer?: readonly string[];
}

const listed = (cli: Cli) => cli.commands.filter((c) => !c.hidden && c !== cli.defaultCommand);

/** Commands of one effect, one per row: a multi-word command ("draft set") shows under its first word once. */
function rows(cli: Cli, effect: "private" | "others"): { name: string; summary: string }[] {
  const out: { name: string; summary: string }[] = [];
  for (const c of listed(cli).filter((x) => x.effect === effect)) {
    const head = c.name.split(" ")[0]!;
    if (out.some((r) => r.name === head)) continue;
    out.push({ name: head, summary: cli.groups[head] ?? c.summary });
  }
  return out;
}

/**
 * The overview: what the tool is, the commands under "Only you see these" and "Other people see these", the words only
 * the person acts on, the footer. A tool defined with `command` shows its one command's usage and summary in place of
 * the command list; a tool with a default command lists the default's usage, arguments and flags under its heading.
 *
 * @claim "the words only the person acts on" registry/ouro/ax/help.test.mts verify:testExists(registry/ouro/ax/help.test.mts::person-only words are listed in the overview and in help --json, with the reason and how the person does it)
 * @claim "shows its one command's usage and summary" registry/ouro/ax/help.test.mts verify:testExists(registry/ouro/ax/help.test.mts::a one-command tool's overview and command help name the tool and its usage, never a command word)
 * @claim "lists the default's usage, arguments and flags" registry/ouro/ax/help.test.mts verify:testExists(registry/ouro/ax/help.test.mts::a default command is listed in the overview under its own heading, with its arguments and flags, and never as a command word)
 */
function renderOverview(cli: Cli, options: OverviewOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const footer = options.footer ?? [...wrap(`Output: --json on every command. ${cli.exits.line()} Errors: one line that says what to do instead.`, 0, 0, width), `Details: ${cli.single ? `${cli.name} --help` : `${cli.name} help <command>`}`];
  if (cli.single) {
    const cmd = cli.commands[0]!;
    const heading = cmd.effect === "others" ? `${cli.headings.others}${options.othersNote ?? ""}` : cli.headings.private;
    return [...cli.about, "", heading, ...columns(usageOf(cli, cmd), cmd.summary, width), "", ...footer, ""].join("\n");
  }
  const mine = rows(cli, "private");
  const theirs = rows(cli, "others");
  const pad = Math.max(...[...mine, ...theirs].map((r) => r.name.length)) + 2;
  const line = (r: { name: string; summary: string }) => `  ${r.name.padEnd(pad)} ${r.summary}`;
  const theirsOnly = Object.keys(cli.personOnly);
  const person = theirsOnly.length ? [...wrap(`Only the person does these, never you: ${theirsOnly.join(", ")}. Why and where: ${cli.name} help --json.`, 0, 0, width), ""] : [];
  const def = cli.defaultCommand;
  const defaultUnder = (effect: "private" | "others") => (def && !def.hidden && def.effect === effect ? defaultLines(cli, def, width) : []);
  return [...cli.about, "", cli.headings.private, ...defaultUnder("private"), ...mine.map(line), "", `${cli.headings.others}${options.othersNote ?? ""}`, ...defaultUnder("others"), ...theirs.map(line), "", ...person, ...footer, ""].join("\n");
}

/** The default command's part of the overview: its usage and summary, then its arguments and flags with what they do. */
function defaultLines(cli: Cli, cmd: CommandDef, width: number): string[] {
  return [...columns(usageOf(cli, cmd), cmd.summary, width), ...argLines(cli, cmd, width), ...flagLines(cli, cmd, width)];
}

const COL = 34;

/**
 * `left` from column 2, `text` from column 34, wrapped.
 *
 * @claim "from column 34" registry/ouro/ax/help.ts verify:fileLine(registry/ouro/ax/help.ts, /const COL = 34;/)
 */
function columns(left: string, text: string, width: number): string[] {
  if (left.length + 4 < COL) {
    const [head, ...more] = wrap(text, COL, COL, width);
    return [`  ${left}`.padEnd(COL) + head.slice(COL), ...more];
  }
  return [...wrap(left, 4, 2, width), ...wrap(text, COL, COL, width)];
}

/** One line per flag: usage on the left, what it does on the right; the built-ins and the tool's own are left out. */
function flagLines(cli: Cli, cmd: CommandDef, width: number = DEFAULT_WIDTH): string[] {
  return Object.entries(flagsOf(cli, cmd))
    .filter(([name]) => !(name in BUILTIN_FLAGS) && !(name in cli.globalFlags))
    .flatMap(([name, spec]) => columns(flagUsage(name, spec), `${spec.description}${spec.required ? (spec.unless === undefined ? " Required." : ` Required unless ${(typeof spec.unless === "string" ? [spec.unless] : spec.unless).map((u) => `--${u}`).join(" or ")}.`) : ""}${spec.repeat ? " Repeat it for each value." : ""}${spec.stdin ? ' "-" reads it from stdin.' : ""}`, width));
}

/** One line per argument: its usage on the left, what it is on the right. */
function argLines(cli: Cli, cmd: CommandDef, width: number = DEFAULT_WIDTH): string[] {
  return (cmd.args ?? []).flatMap((a) => columns(argUsage(a), `${a.description}${a.source ? ` "${cli.name} ${a.source}" lists them.` : ""}${a.stdin ? ' "-" reads it from stdin.' : ""}`, width));
}

/** The generated part of a command's help: its usage from the definition, its arguments and its flags. */
function definitionLines(cli: Cli, cmd: CommandDef, width: number = DEFAULT_WIDTH): string[] {
  return ["Definition", ...wrap(`${cli.name} ${usageOf(cli, cmd)}`, 4, 2, width), ...argLines(cli, cmd, width), ...flagLines(cli, cmd, width)];
}

/** One command's whole help, from its definition alone. */
function renderCommand(cli: Cli, cmd: CommandDef, width: number = DEFAULT_WIDTH): string {
  const lines = [
    ...(cmd.effect === "others" ? [...wrap(`${cli.headings.others}: run it only when a human asked you to, with --${WHY_FLAG}.`, 0, 0, width), ""] : []),
    ...wrap(`${invocation(cli, cmd)}: ${cmd.summary}`, 2, 0, width),
    "",
    ...definitionLines(cli, cmd, width),
  ];
  if (cmd.output) lines.push("", "--json", ...wrap(cmd.output, 4, 2, width));
  if (cmd.examples?.length) lines.push("", "Examples", ...cmd.examples.map((x) => `  ${x}`));
  lines.push("", ...wrap(cli.exits.line(), 0, 0, width), "");
  return lines.join("\n");
}

interface CommandManifest {
  name: string;
  aliases: readonly string[];
  effect: "private" | "others";
  whoSees: string;
  readOnly: boolean;
  needsWhy: boolean;
  /** Whether `--dry-run` previews it (an "others" command with a plan()). */
  dryRun: boolean;
  /** Whether a run() executes it; false for a declaration that only documents a command another path runs. */
  runs: boolean;
  summary: string;
  usage: string;
  inputSchema: JsonSchema;
  output: string | null;
  examples: readonly string[];
  hidden: boolean;
  /** `"self"` on a command an agent runs only on its own item (`--agent`); left out otherwise. */
  scope?: "self";
  /**
   * `true` on the word-less command: the one command of a tool defined with `command`, or the default command of one
   * defined with both.
   */
  single?: true;
}

/** One command as data. */
function commandManifest(cli: Cli, cmd: CommandDef): CommandManifest {
  const flags = flagsOf(cli, cmd);
  return {
    name: cmd.name,
    aliases: cmd.aliases ?? [],
    effect: cmd.effect,
    whoSees: cmd.effect === "others" ? cli.headings.others : cli.headings.private,
    readOnly: cmd.readOnly === true,
    needsWhy: flags[WHY_FLAG]?.required === true,
    dryRun: DRY_RUN_FLAG in flags && typeof cmd.plan === "function",
    runs: typeof cmd.run === "function" && cmd.loose !== true,
    summary: cmd.summary,
    usage: `${cli.name} ${usageOf(cli, cmd)}`,
    inputSchema: inputSchema(cli, cmd),
    output: cmd.output ?? null,
    examples: cmd.examples ?? [],
    hidden: cmd.hidden === true,
    ...(cmd.self ? { scope: "self" as const } : {}),
    ...(cmd === cli.defaultCommand ? { single: true as const } : {}),
  };
}

/**
 * The help as data: the tool, its headings, the commands, the words only the person acts on (`personOnly`: name, reason
 * and how), the exit codes, the tool's fixed voice lines (for a checker
 * that looks for them in an agent's output) and the one error shape.
 */
function helpJson(cli: Cli) {
  return {
    tool: cli.name,
    about: cli.about,
    effects: { private: cli.headings.private, others: cli.headings.others },
    commands: cli.commands.map((c) => commandManifest(cli, c)),
    personOnly: Object.entries(cli.personOnly).map(([name, p]) => ({ name, reason: p.reason, how: p.how })),
    exitCodes: cli.exits.codes,
    voice: voiceLines(cli.voice),
    errorShape: { error: { code: "<slug>", exit: "<exit code>", thing: "<command or flag>", problem: "<what's wrong>", fix: "<exact code to run instead, or null>", message: "<thing>: <problem>. Fix: <fix>." } },
  };
}
