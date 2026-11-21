// The ouro CLI's commands for installing, starting, updating and checking Ouro on this machine, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { unknownFlag } from "./cards"

export const LIFECYCLE_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "clone", effect: "private", summary: "Clone an agent bundle from a remote." },
  { name: "dev", effect: "private", summary: "Run the daemon from this checkout, rebuilding as it goes." },
  { name: "doctor", effect: "private", readOnly: true, summary: "Check the health of this machine's Ouro install." },
  { name: "down", effect: "private", summary: "Stop the daemon." },
  { name: "hatch", effect: "private", summary: "Create a new agent." },
  { name: "logs", effect: "private", readOnly: true, summary: "Show the daemon's recent logs." },
  { name: "repair", effect: "private", summary: "Repair an agent's setup." },
  { name: "rollback", effect: "private", summary: "Roll the install back to an earlier version." },
  { name: "status", effect: "private", readOnly: true, summary: "Show the daemon and an agent's status.", ax: { id: "cli:status", group: "lifecycle", effect: "read", when: "Start here: learn whether the daemon runs, which agents it hosts and whether their senses are healthy.", errors: [unknownFlag("status")] } },
  { name: "stop", effect: "private", summary: "Stop the daemon." },
  { name: "sync", effect: "private", summary: "Sync an agent bundle with its remote." },
  { name: "versions", effect: "private", readOnly: true, summary: "List the installed and available versions.", ax: { id: "cli:versions", group: "lifecycle", effect: "read", when: "Before an update or rollback, see the releases installed here, the one running now and the pinned intent.", errors: [unknownFlag("versions")] } },
  { name: "whoami", effect: "private", readOnly: true, summary: "Show which agent this is.", ax: { id: "cli:whoami", group: "lifecycle", effect: "read", when: "Confirm which agent bundle and home folder this terminal speaks as before writing into either.", errors: [unknownFlag("whoami")] } },
  { name: "changelog", effect: "private", readOnly: true, summary: "Show the release notes.", ax: { id: "cli:changelog", group: "lifecycle", effect: "read", when: "Explain new behaviour after an update by reading release notes, limited to releases after --from.", errors: [unknownFlag("changelog")] } },
  { name: "help", effect: "private", readOnly: true, summary: "Show ouro's commands and how to use them.", ax: { id: "cli:help", group: "lifecycle", effect: "read", when: "Discover commands: help --json gives each one's consent class, errors and example, to choose from.", errors: [unknownFlag("help")] } },
]
