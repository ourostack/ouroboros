// The commands of the ouro CLI, declared once: the names `ouro help --json` lists and the X-ray's inventory reads.
import { emitNervesEvent } from "../../nerves/runtime"
import { LIFECYCLE_COMMANDS } from "./cli-commands/lifecycle"
import { PROVIDERS_COMMANDS } from "./cli-commands/providers"
import { VAULT_COMMANDS } from "./cli-commands/vault"
import { FRIENDS_COMMANDS } from "./cli-commands/friends"
import { HABITS_COMMANDS } from "./cli-commands/habits"
import { MIND_COMMANDS } from "./cli-commands/mind"
import { MAIL_COMMANDS } from "./cli-commands/mail"
import { CODING_TOOLS_COMMANDS } from "./cli-commands/coding-tools"
import { A2A_COMMANDS } from "./cli-commands/a2a"
import { DESK_COMMANDS } from "./cli-commands/desk"
import { PRESENCE_COMMANDS } from "./cli-commands/presence"
import { SHEPHERD_COMMANDS } from "./cli-commands/shepherd"
import { RSVP_COMMANDS } from "./cli-commands/rsvp"
import { DNS_COMMANDS } from "./cli-commands/dns"

// Each command says who sees its effect: only the person ("private") or other people ("others"). A command moves onto
// the Ouro AX kit's definitions one at a time; until then it is declared in cli-commands/ and dispatched by cli-exec.
//
// A declaration's `ax` is its Ouro AX door card, the one the census (.github/scripts/ax-census) checks: when an agent
// should pick the command over its neighbours, its consent class, and what can go wrong as the agent reads it, each
// error code raised in the parser, the gate or the dispatcher. `help --json` serves the card, and the shell tool
// treats a command whose card says `effect: "read"` as safe to run (READ_ONLY_OURO_SHELL_COMMANDS in tools.ts).

export type CliEffect = "private" | "others";

/** What can go wrong at a command, as the agent reads it: the census's `ErrorCard`. */
export interface CliErrorCard {
  code: string;
  means: string;
  fix: string;
}

/** A command's Ouro AX declaration: the census's `DoorCard`, with the command's id `cli:<words>`. */
export interface CliDoorCard {
  id: string;
  group: string;
  when: string;
  effect: "read" | "write" | "consequential" | "person-only";
  errors: readonly CliErrorCard[];
  /** Other words the parser takes for this command, such as `down` for `stop`. */
  aliases?: readonly string[];
  destructive?: true;
  idempotent?: true;
  confirm?: string;
}

export interface CliCommandDeclaration {
  name: string;
  effect: CliEffect;
  readOnly?: true;
  summary: string;
  /** A legacy spelling kept for old scripts: help JSON marks it, and the usage text and overview leave it out. */
  hidden?: true;
  /** One command line, after `ouro`, that the parser accepts: shown in help, and how the census reaches its kind. */
  example?: string;
  ax?: CliDoorCard;
}

/** The CLI-level card: what words no command has answer. */
export const serverErrors: readonly CliErrorCard[] = [
  { code: "unknown-door", means: "No ouro command starts with those words; the error suggests the nearest one.", fix: "Run the suggested command if it is the one you meant; otherwise run ouro help --json and pick by summary." },
];

export const CLI_COMMANDS: readonly CliCommandDeclaration[] = [
  ...LIFECYCLE_COMMANDS,
  ...PROVIDERS_COMMANDS,
  ...VAULT_COMMANDS,
  ...FRIENDS_COMMANDS,
  ...HABITS_COMMANDS,
  ...MIND_COMMANDS,
  ...MAIL_COMMANDS,
  ...CODING_TOOLS_COMMANDS,
  ...A2A_COMMANDS,
  ...DESK_COMMANDS,
  ...PRESENCE_COMMANDS,
  ...SHEPHERD_COMMANDS,
  ...RSVP_COMMANDS,
  ...DNS_COMMANDS,
];

/**
 * Programs an agent's shell can start as `node <path>` beside the ouro command, such as the daemon and the senses.
 * The census finds them by their `process.argv` reads; each is declared here with its card. `help --json` lists them
 * as `entryPoints`, apart from the commands, because they don't start with `ouro`.
 */
export const CLI_ENTRY_POINTS: readonly CliCommandDeclaration[] = [];

export const CLI_EXIT_CODES = [
  { code: 0, name: "ok", meaning: "The command did what it was asked." },
  { code: 1, name: "error", meaning: "The command failed or refused; the output says why and how to fix it." },
] as const;

/**
 * What `help --json` says about one declaration: the card's fields beside the name, effect and summary. A command's
 * usage starts with `ouro`; an entry point's is its own command line.
 */
export function helpEntry(command: CliCommandDeclaration, usage: string = `ouro ${command.name}`): Record<string, unknown> {
  return {
    name: command.name,
    effect: command.effect,
    summary: command.summary,
    usage: [usage],
    ...(command.readOnly ? { readOnly: true } : {}),
    ...(command.hidden ? { hidden: true } : {}),
    ...(command.example ? { example: `ouro ${command.example}` } : {}),
    ...(command.ax
      ? {
          group: command.ax.group,
          when: command.ax.when,
          consent: command.ax.effect,
          errors: command.ax.errors,
          ...(command.ax.aliases ? { aliases: command.ax.aliases } : {}),
        }
      : {}),
  }
}

/** An entry point's help: its usage is its own command line, not an ouro command. */
export function entryPointHelp(entry: CliCommandDeclaration): Record<string, unknown> {
  return helpEntry(entry, entry.name)
}

/** The help as data: every declared command and entry point with its effect and card, and the exit codes. */
export function cliHelpJson(): string {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_help_json",
    message: "printing ouro help as data",
    meta: { commands: CLI_COMMANDS.length, entryPoints: CLI_ENTRY_POINTS.length },
  })
  return JSON.stringify(
    {
      tool: "ouro",
      commands: CLI_COMMANDS.map((command) => helpEntry(command)),
      entryPoints: CLI_ENTRY_POINTS.map(entryPointHelp),
      exitCodes: CLI_EXIT_CODES,
      errors: serverErrors,
    },
    null,
    2,
  )
}
