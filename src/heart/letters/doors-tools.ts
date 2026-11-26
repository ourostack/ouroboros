// The mailbox's in-turn tools, from the generated actions/generated/mailbox-tools/tools.json. They live apart from
// doors.ts because they need the MCP tool code, and the CLI loads doors.ts on every start: `ouro --version` must not
// load that code (the edge benchmark counts its modules). Only the tool registry (src/repertoire/tools.ts) loads this.
import { emitNervesEvent } from "../../nerves/runtime"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"
import { declaredRiskProfile } from "../../repertoire/mcp-declared-tools"
import { mcpToolSchema } from "../../repertoire/mcp-tools"
import type { JsonObject } from "../approval-store"
import { getAgentName } from "../identity"
import { withCode } from "../../repertoire/tool-error-code"
import { MailboxDoorError, readMailboxDoors, runMailboxAction } from "./doors"

/** The server name the census's declared-tools source gives these tools (ax/census.config.json). */
const MAILBOX_SERVER = "mailbox"

/**
 * A declared tool's schema, built the way the harness builds a bundle's declared MCP tools (mcp-tools.ts's
 * mcpToolSchema, a census passthrough) from only what tools.json declares. The census counts it from tools.json.
 */
export function declaredToolSchema(server: string, name: string, declared: { description: string; parameters: JsonObject }) {
  return mcpToolSchema({ server }, { name, description: declared.description, inputSchema: declared.parameters })
}

/**
 * The longest an in-turn mailbox_wait blocks, in seconds. Turns run one at a time across the process, so a long wait
 * would hold up every agent's turns; a longer wait belongs to the CLI or a coding tool.
 */
export const IN_TURN_WAIT_MAX_S = 5

/** One in-turn call, for the turn's own agent over its daemon socket: the result as JSON, or the refusal's text with its card's code. */
async function runMailboxTool(name: string, args: Record<string, unknown>, ctx: ToolContext | undefined): Promise<string> {
  const input = name === "mailbox_wait" && !(typeof args.timeout === "number" && args.timeout <= IN_TURN_WAIT_MAX_S)
    ? { ...args, timeout: IN_TURN_WAIT_MAX_S }
    : args
  try {
    return JSON.stringify(await runMailboxAction(name, input, {
      agent: ctx?.agentName ?? getAgentName(),
      ...(ctx?.currentSession ? { session: { friendId: ctx.currentSession.friendId, channel: ctx.currentSession.channel, key: ctx.currentSession.key } } : {}),
      ...(ctx?.daemonSocketPath ? { socketPath: ctx.daemonSocketPath } : {}),
    }))
  } catch (error) {
    if (error instanceof MailboxDoorError) return withCode(error.message, error.code)
    throw error
  }
}

/** A person-only action's refusal, which the dispatcher answers when a model calls it by name; null for any other name. */
export function mailboxToolRefusal(name: string): string | null {
  const { refusals } = readMailboxDoors()
  const refusal = Object.hasOwn(refusals, name) ? refusals[name] : undefined
  return refusal ? withCode(refusal.summary, "person-only") : null
}

/** The in-turn registry's definitions: the declared tools, each running its action and answering its result as JSON. */
export function mailboxToolDefinitions(): ToolDefinition[] {
  const definitions = [...readMailboxDoors().tools].map(([name, declared]): ToolDefinition => ({
    tool: declaredToolSchema(MAILBOX_SERVER, name, { description: declared.description, parameters: declared.parameters as JsonObject }),
    ax: declared.ax,
    riskProfile: declaredRiskProfile(declared.ax.effect),
    handler: (args: Record<string, string>, ctx?: ToolContext) => runMailboxTool(name, args, ctx),
  }))
  emitNervesEvent({ component: "repertoire", event: "mailbox.tools_registered", message: "mailbox in-turn tools registered", meta: { tools: definitions.length } })
  return definitions
}
