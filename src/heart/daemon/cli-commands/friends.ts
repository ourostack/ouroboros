// The ouro CLI's commands for the people an agent knows and their sessions, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { unknownFlag } from "./cards"

export const FRIENDS_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "friend create", effect: "private", summary: "Add a friend the agent knows." },
  { name: "friend link", effect: "private", summary: "Link a friend to an external account." },
  { name: "friend list", effect: "private", readOnly: true, summary: "List the friends this agent knows." },
  { name: "friend show", effect: "private", readOnly: true, summary: "Show one friend." },
  { name: "friend unlink", effect: "private", summary: "Remove a link between a friend and an external account." },
  { name: "friend update", effect: "private", summary: "Change a friend's trust, admission or initiative." },
  { name: "link", effect: "private", summary: "Link an agent to a friend's external account." },
  { name: "session list", effect: "private", readOnly: true, summary: "List the agent's sessions.", ax: { id: "cli:session list", group: "friends", effect: "read", when: "Find who the agent talks with now, on which channel and how recently, before reaching someone.", errors: [unknownFlag("session list")] } },
]
