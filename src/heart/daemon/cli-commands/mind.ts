// The ouro CLI's commands for an agent's inner life: its thoughts, private state, attention and work, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { agentErrors, unknownFlag } from "./cards"

export const MIND_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "chat", effect: "private", summary: "Open an interactive chat with an agent." },
  { name: "event submit", effect: "others", summary: "Submit an event that can wake the agent and reach other people." },
  { name: "msg", effect: "others", summary: "Send a message to another agent." },
  { name: "nerves-review", effect: "private", readOnly: true, summary: "Review the runtime's nerves events." },
  { name: "private decisions", effect: "private", readOnly: true, summary: "List an agent's recent private decisions." },
  { name: "private status", effect: "private", readOnly: true, summary: "Show an agent's private status.", ax: { id: "cli:private status", group: "mind", effect: "read", when: "See the inner runtime's cadence, its last wake, open return obligations and how much the diary holds.", errors: [unknownFlag("private status"), ...agentErrors("private status")] } },
  { name: "thoughts", effect: "private", readOnly: true, summary: "Show an agent's recent thoughts.", ax: { id: "cli:thoughts", group: "mind", effect: "read", when: "Read the private runtime's recent turns to understand what the agent is mulling; --follow streams new ones live.", errors: [unknownFlag("thoughts"), ...agentErrors("thoughts")] } },
  { name: "work card", effect: "private", readOnly: true, summary: "Show the agent's work card." },
  { name: "work gauntlet", effect: "private", readOnly: true, summary: "Show the agent's work gauntlet." },
  { name: "work sentinel", effect: "private", readOnly: true, summary: "Show the agent's work sentinel." },
  { name: "inner", effect: "private", readOnly: true, hidden: true, summary: "The older name of private status.", ax: { id: "cli:inner", group: "mind", effect: "read", when: "Kept so existing scripts still run; new calls should prefer private status, which answers identically.", errors: [unknownFlag("inner"), ...agentErrors("inner")] } },
]
