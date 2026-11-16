export { lintCli };
export type { LintOptions, LintReport };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { flagsOf, invocation, type Cli } from "./command.ts";
import { WHY_FLAG } from "./effects.ts";
import { DEFAULT_WIDTH, renderCommand, renderOverview } from "./help.ts";

/**
 * The kit's check of a tool's declarations: what an agent needs from every declared command (a summary, an example,
 * described arguments and flags, `--why` and a preview where other people see it, help that fits the width), and,
 * against the tool's own command inventory, that every command it registers runs through its declaration.
 *
 * @claim "what an agent needs from every declared command" registry/ouro/ax/lint.test.mts verify:testExists(registry/ouro/ax/lint.test.mts::each missing piece is one line with its fix, and loose commands are counted)
 */
interface LintOptions {
  width?: number;
  /**
   * The command names the tool actually registers, generated from its own registration (its dispatcher's table), not
   * written by hand. Every one must be declared with a run(); a declaration with no registered command is stale. The
   * inventory compares names: a run() that hands the call to a second dispatch path still passes, so keep a check of
   * your own source that the command table is the only one.
   *
   * @claim "Every one must be declared" registry/ouro/ax/lint.test.mts verify:testExists(registry/ouro/ax/lint.test.mts::against the tool's own inventory: a registered command with no declaration, and a declaration with no command)
   */
  inventory?: readonly string[];
}

interface LintReport {
  /** Declared commands whose calls the kit parses and runs. */
  typed: string[];
  /** Declared commands that still pass flags through unchecked. */
  loose: string[];
  /** Declared commands without a run(): the kit documents them, but another path executes them. */
  bypassed: string[];
  /** Inventory commands that nothing declares. */
  undeclared: string[];
  /** Declarations the inventory does not have. */
  stale: string[];
  /** A line per problem, in the dev message format: `<tool> <command>: <what's wrong>. Fix: <what to add>.` */
  problems: string[];
  /** True when `problems` and `loose` are empty. */
  ok: boolean;
}

function lintCli(cli: Cli, options: LintOptions = {}): LintReport {
  const width = options.width ?? DEFAULT_WIDTH;
  const problems: string[] = [];
  const say = (thing: string, problem: string, fix: string) => problems.push(`${[cli.name, thing].filter(Boolean).join(" ")}: ${problem}. Fix: ${fix}.`);
  const long = (text: string) => text.split("\n").find((line) => line.length > width);
  const typed = cli.commands.filter((c) => !c.loose);
  // The inventory checks the command words. A default command takes no word, so it is left out, unless it is the tool's only command.
  const worded = cli.single ? cli.commands : cli.commands.filter((c) => c !== cli.defaultCommand);
  for (const cmd of typed) {
    // The default command has no command word to name, so its problems are the tool's.
    const thing = cmd === cli.defaultCommand ? "" : cmd.name;
    if (!cmd.summary.trim()) say(thing, "has no summary", 'summary: "<what it does, in one line>"');
    if (!cmd.examples?.length) say(thing, "has no example", `examples: ["${invocation(cli, cmd)} ..."]`);
    if (cmd.effect === "others" && flagsOf(cli, cmd)[WHY_FLAG]?.required !== true) say(thing, "reaches other people without a required --why", 'drop why: "optional"');
    if (cmd.effect === "others" && !cmd.plan) say(thing, "reaches other people with no preview for --dry-run", 'plan: (input) => outcome({ state: "planned", ... })');
    if (cmd.effect === "others" && cmd.readOnly) say(thing, "is a read that other people see", 'effect: "private", or drop readOnly');
    for (const a of cmd.args ?? []) if (!a.description.trim()) say(thing, `<${a.name}> has no description`, `{ name: "${a.name}", description: "<what it is>" }`);
    for (const [name, spec] of Object.entries(cmd.flags ?? {})) if (!spec.description.trim()) say(thing, `--${name} has no description`, `${name}: { description: "<what it does>" }`);
    const line = long(renderCommand(cli, cmd, width));
    if (line) say(thing, `its help has a line of ${line.length} columns`, `shorten "${line.trim().slice(0, 40)}..."`);
  }
  const over = long(renderOverview(cli, { width }));
  if (over) say("--help", `the overview has a line of ${over.length} columns`, "shorten that command's summary");
  const declared = new Set(worded.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const inventory = options.inventory ? new Set(options.inventory) : null;
  const undeclared = inventory ? [...inventory].filter((name) => !declared.has(name)) : [];
  const stale = inventory ? worded.filter((c) => ![c.name, ...(c.aliases ?? [])].some((n) => inventory.has(n))).map((c) => c.name) : [];
  for (const name of undeclared) say(name, "is registered but not declared, so it runs outside the kit", `defineCommand({ name: "${name}", ... run })`);
  for (const name of stale) say(name, "is declared but the tool does not register it", "remove the declaration, or register the command");
  const bypassed = cli.commands.filter((c) => typeof c.run !== "function").map((c) => c.name);
  for (const name of bypassed) say(name, "is declared with no run(), so another path executes it", "move its code into run(input, ctx)");
  const loose = cli.commands.filter((c) => c.loose).map((c) => c.name);
  return { typed: typed.map((c) => c.name), loose, bypassed, undeclared, stale, problems, ok: problems.length === 0 && loose.length === 0 };
}
