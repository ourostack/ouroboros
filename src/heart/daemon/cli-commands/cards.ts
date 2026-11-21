// The error cards many ouro commands share in kind, each written for the one command it sits on, so an agent reads
// that command's own fix. Where each code is raised: `usage`, `no-agent` and `which-agent` in cli-exec, the flag
// refusals in cli-gate, `daemon-down` at cli-exec's daemonDown.
import type { CliErrorCard } from "../cli-manifest"

/** The flag gate's refusal of a flag this command doesn't take. */
export function unknownFlag(name: string): CliErrorCard {
  return {
    code: "unknown-flag",
    means: `ouro ${name} doesn't take that flag; the refusal names the nearest flag it does take.`,
    fix: `Retry with the suggested flag, or read ouro ${name} --help for the flags it takes.`,
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
