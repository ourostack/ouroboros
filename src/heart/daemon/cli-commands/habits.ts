// The ouro CLI's commands for an agent's habits and tasks, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"

export const HABITS_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "habit cancel", effect: "private", summary: "Cancel a habit's pending run." },
  { name: "habit create", effect: "private", summary: "Create a habit that runs on a cadence." },
  { name: "habit inspect", effect: "private", readOnly: true, summary: "Show one habit run." },
  { name: "habit list", effect: "private", readOnly: true, summary: "List the agent's habits." },
  { name: "habit probe", effect: "private", readOnly: true, summary: "Check a habit without sending anything." },
  { name: "habit runs", effect: "private", readOnly: true, summary: "List recent habit runs." },
  { name: "habit summary", effect: "private", readOnly: true, summary: "Summarise a habit run." },
  { name: "poke", effect: "private", summary: "Wake an agent for a task or habit." },
]
