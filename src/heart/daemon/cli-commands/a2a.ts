// The ouro CLI's commands for agent-to-agent messaging and the gateway, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"

export const A2A_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "gateway serve", effect: "others", summary: "Serve the gateway that other agents connect to." },
  { name: "a2a card", effect: "private", readOnly: true, summary: "Show the agent's A2A card." },
  { name: "a2a delegated-commands grant", effect: "others", summary: "Let a friend's agent run delegated commands." },
  { name: "a2a delegated-commands list", effect: "private", readOnly: true, summary: "List the delegated command grants." },
  { name: "a2a delegated-commands revoke", effect: "private", summary: "Revoke a delegated command grant." },
  { name: "a2a escalation grant", effect: "others", summary: "Let a friend escalate to the person." },
  { name: "a2a escalation list", effect: "private", readOnly: true, summary: "List escalation grants." },
  { name: "a2a escalation revoke", effect: "private", summary: "Revoke an escalation grant." },
  { name: "a2a identity", effect: "private", readOnly: true, summary: "Show the agent's A2A identity." },
  { name: "a2a message", effect: "others", summary: "Send an A2A message to another agent." },
  { name: "a2a onboard", effect: "private", summary: "Onboard another agent from its card." },
  { name: "a2a outbox ack", effect: "others", summary: "Acknowledge messages another agent sent." },
  { name: "a2a outbox list", effect: "private", readOnly: true, summary: "List the A2A outbox." },
  { name: "a2a outbox resolve", effect: "others", summary: "Resolve a report another agent filed." },
  { name: "a2a serve", effect: "others", summary: "Serve the agent's A2A endpoint to other agents." },
]
