// The error cards many ouro commands share in kind, each written for the one command it sits on, so an agent reads
// that command's own fix. Where each code is raised: `usage`, `no-agent` and `which-agent` in cli-exec, the flag
// refusals in cli-gate, `daemon-down` at cli-exec's daemonDown. A failure prints its code as its last stderr line.
import type { CliErrorCard } from "../cli-manifest"

/** The flag gate's refusal of a flag this command doesn't take. */
export function unknownFlag(name: string): CliErrorCard {
  return {
    code: "unknown-flag",
    means: `ouro ${name} got a flag no ouro command takes; the refusal suggests the nearest known flag, which may belong to another command.`,
    fix: `Read ouro ${name} --help for the flags this command takes, then retry with one of those.`,
  }
}

/** No agent was named and the shell couldn't pick one: none on this machine, or several and no prompt. */
export function agentErrors(name: string): CliErrorCard[] {
  return [
    {
      code: "no-agent",
      means: `No agent bundle is on this machine, so ouro ${name} has no agent to read.`,
      fix: "Hatch or clone an agent first, then run the command again.",
    },
    {
      code: "which-agent",
      means: `Several agents are on this machine and ouro ${name} can't ask which one from a script.`,
      fix: `Name it: ouro ${name} --agent <name>.`,
    },
  ]
}

/** The parser refused the words: a required flag or value is missing or malformed. */
export function usageError(name: string, needs: string, fix: string): CliErrorCard {
  return { code: "usage", means: `ouro ${name} ${needs}`, fix }
}

/** The command needs the running daemon and it isn't up. */
export function daemonDown(name: string): CliErrorCard {
  return {
    code: "daemon-down",
    means: `ouro ${name} asks the daemon, and the daemon isn't running on this machine.`,
    fix: `Start it with ouro up, then run ouro ${name} again.`,
  }
}

/** A group's own words, which only print its usage: the subcommand is missing or unknown. */
export function needsSubcommand(name: string, subcommands: string): CliErrorCard {
  return {
    code: "usage",
    means: `ouro ${name} on its own runs nothing; it needs one of its subcommands: ${subcommands}.`,
    fix: `Pick the subcommand for the job and run ouro ${name} <subcommand> --help for its flags.`,
  }
}

/** The command prompts the person (often for a hidden secret), and this shell has no terminal. */
export function needsTerminal(name: string, fix: string): CliErrorCard {
  return {
    code: "needs-terminal",
    means: `ouro ${name} has to ask the person at a prompt, and this shell has no interactive terminal.`,
    fix,
  }
}

/** The gate's refusal of a command other people see when no `--why` is given. */
export function needsWhy(name: string, reaches: string): CliErrorCard {
  return {
    code: "needs-why",
    means: `ouro ${name} ${reaches}, so the gate wants a one-line reason it can record.`,
    fix: `Add --why "<reason>" saying why, then run it again.`,
  }
}
