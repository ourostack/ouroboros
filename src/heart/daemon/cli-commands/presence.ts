// The ouro CLI's commands for where an agent is present: machines, voice and BlueBubbles, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"

export const PRESENCE_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "voice join", effect: "others", summary: "Join a voice call as the agent." },
  { name: "voice leave", effect: "others", summary: "Leave a voice call." },
  { name: "voice status", effect: "private", readOnly: true, summary: "Show the agent's voice status." },
  { name: "bluebubbles context-smoke", effect: "private", summary: "Check the context a BlueBubbles message would get." },
  { name: "bluebubbles host", effect: "private", summary: "Install, check or repair the BlueBubbles host." },
  { name: "bluebubbles replay", effect: "private", summary: "Replay a BlueBubbles message." },
]
