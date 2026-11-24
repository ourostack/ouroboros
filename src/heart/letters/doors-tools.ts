// The mailbox's in-turn tools, from the generated actions/generated/mailbox-tools/tools.json. They live apart from
// doors.ts because they need the MCP tool code, and the CLI loads doors.ts on every start: `ouro --version` must not
// load that code (the edge benchmark counts its modules). Only the tool registry (src/repertoire/tools.ts) loads this.
import { emitNervesEvent } from "../../nerves/runtime"
import type { ToolDefinition } from "../../repertoire/tools-base"
import { declaredRiskProfile } from "../../repertoire/mcp-declared-tools"
import { mcpToolSchema } from "../../repertoire/mcp-tools"
import type { JsonObject } from "../approval-store"
import { readMailboxDoors, runMailboxAction } from "./doors"

/** The server name the census's declared-tools source gives these tools (ax/census.config.json). */
const MAILBOX_SERVER = "mailbox"

/**
 * A declared tool's schema, built the way the harness builds a bundle's declared MCP tools (mcp-tools.ts's
 * mcpToolSchema, a census passthrough) from only what tools.json declares. The census counts it from tools.json.
 */
export function declaredToolSchema(server: string, name: string, declared: { description: string; parameters: JsonObject }) {
  return mcpToolSchema({ server }, { name, description: declared.description, inputSchema: declared.parameters })
}

/** The in-turn registry's definitions: the declared tools, each running its action and answering its result as JSON. */
export function mailboxToolDefinitions(): ToolDefinition[] {
  const definitions = [...readMailboxDoors().tools].map(([name, declared]): ToolDefinition => ({
    tool: declaredToolSchema(MAILBOX_SERVER, name, { description: declared.description, parameters: declared.parameters as JsonObject }),
    ax: declared.ax,
    riskProfile: declaredRiskProfile(declared.ax.effect),
    handler: (args: Record<string, string>) => JSON.stringify(runMailboxAction(name, args)),
  }))
  emitNervesEvent({ component: "repertoire", event: "mailbox.tools_registered", message: "mailbox in-turn tools registered", meta: { tools: definitions.length } })
  return definitions
}
