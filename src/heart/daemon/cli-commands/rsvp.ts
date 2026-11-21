// The ouro CLI's commands for RSVP events and their habit, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"

export const RSVP_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "rsvp", effect: "private", summary: "Work with RSVP events." },
]
