// The ouro CLI's commands for MCP servers, coding-tool hooks and plugins, each with its Ouro AX card (see cli-manifest.ts).
import type { CliCommandDeclaration } from "../cli-manifest"
import { daemonDown, unknownFlag } from "./cards"

export const CODING_TOOLS_COMMANDS: readonly CliCommandDeclaration[] = [
  { name: "mcp call", effect: "private", summary: "Call a tool on an MCP server." },
  { name: "mcp doctor", effect: "private", readOnly: true, summary: "Check an agent's MCP servers." },
  { name: "mcp list", effect: "private", readOnly: true, summary: "List the MCP servers.", ax: { id: "cli:mcp list", group: "coding-tools", effect: "read", when: "Before mcp call, see which servers the agent has connected and the tools each offers.", errors: [unknownFlag("mcp list"), daemonDown("mcp list")] } },
]
