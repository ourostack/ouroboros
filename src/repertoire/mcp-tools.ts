/**
 * First-class MCP tool integration — converts MCP server tools into ToolDefinitions
 * so the model can call them directly without shell indirection.
 */

import type { McpServerView, McpToolBinding, McpTurnView } from "./mcp-manager"
import type { McpContentPart, McpToolInfo } from "./mcp-client"
import type { ToolDefinition, ToolDoorCard, ToolResultImage } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"
import { digestJson } from "./tool-arguments"
import { guardMcpArgs } from "./mcp-write-guard"
import { declaredRiskProfile, type DeclaredTool } from "./mcp-declared-tools"

export class McpCallRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpCallRejectedError"
  }
}

export class McpToolExecutionError extends Error {
  constructor(readonly kind: "handler_failed" | "handler_indeterminate", message: string) {
    super(message)
    this.name = "McpToolExecutionError"
  }
}

/** Text parts become the tool's text result; image parts (base64 `data` + `mimeType`) go to the model as images. */
export function splitMcpContent(content: McpContentPart[]): { text: string; images: ToolResultImage[] } {
  const text = content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("")
  const images = content
    .filter((part) => part.type === "image" && part.data && part.mimeType?.startsWith("image/"))
    .map((part) => ({ data: part.data!, mimeType: part.mimeType! }))
  return { text, images }
}

export function mcpToolSchema(entry: Pick<McpServerView, "server" | "pluginId">, tool: McpToolInfo) {
  return {
    type: "function" as const,
    function: {
      name: entry.pluginId
        ? `mcp__${entry.server}__${tool.name}`
        : tool.name.startsWith(`${entry.server}_`) || tool.name === entry.server
          ? tool.name
          : `${entry.server}_${tool.name}`,
      description: tool.description || `MCP tool: ${tool.name} (server: ${entry.server})`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }
}

/** The served schema with the bundle's declared description and parameters; its name stays the served one. */
function withDeclaration(served: ReturnType<typeof mcpToolSchema>, declared: DeclaredTool): ReturnType<typeof mcpToolSchema> {
  return { ...served, function: { ...served.function, description: declared.description, parameters: declared.parameters as typeof served.function.parameters } }
}

/**
 * An MCP tool's Ouro AX card, made from what its server says: the tool's first description sentence as its `when`
 * line, and a read effect only when the read-only hint is trusted (the agent's own servers), else a write.
 */
function mcpToolCard(server: string, tool: McpToolInfo, surfacedName: string, readOnly: boolean): ToolDoorCard {
  const first = tool.description?.trim().split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]$/, "")
  return {
    id: `tool:${surfacedName}`,
    group: `mcp:${server}`,
    when: `Pick this to use ${server}'s ${tool.name} tool${first ? `: ${first}` : ""}.`,
    effect: readOnly ? "read" : "write",
    errors: [],
  }
}

/**
 * Convert an owned frozen MCP view into ToolDefinition objects.
 *
 * Naming rules:
 *  - Builtin servers (agent.json `mcpServers`) — legacy `{server}_{tool}`
 *    shape (e.g., `browser_navigate`), with double-prefix avoidance when
 *    the tool already starts with the server name.
 *  - Desk servers (built in, `desk-mcp.ts`) and plugin servers (from
 *    `<plugin>/.mcp.json`) — Anthropic public convention
 *    `mcp__{server}__{tool}` (e.g., `mcp__desk__task_create`), matching
 *    Claude Code's external naming and the desk section's promise.
 *
 * The handler carries the exact frozen binding to the manager's client fence.
 */
export function mcpToolsAsDefinitions(view: McpTurnView): ToolDefinition[] {
  if (!view) return []

  return view.entries.flatMap((entry) => {
    if (entry.declared) warnUnservedDeclarations(entry)
    return entry.tools.flatMap((tool): ToolDefinition[] => {
      const served = mcpToolSchema(entry, tool)
      // The bundle's own declaration, when it has one: the model sees the declared description, parameters and card.
      const declared = entry.declared?.get(tool.name)
      // A person-only action is never an agent's to call, so a declared one is not surfaced.
      if (declared?.ax.effect === "person-only") return []
      const schema = declared ? withDeclaration(served, declared) : served
      const binding: McpToolBinding = Object.freeze({
        manager: view.manager, ...view.owner, server: entry.server,
        rawName: tool.name, surfacedName: served.function.name,
        source: entry.source, pluginId: entry.pluginId,
        configDigest: entry.configDigest, generation: entry.generation,
        // The served schema, which the manager checks the binding against; the declaration changes only what the model reads.
        schemaDigest: digestJson(served),
      })
      // A read-only hint is trusted only from the agent's own bundle (agent.json mcpServers) and the built-in Desk,
      // so an orientation hold still lets the agent inspect through those tools.
      const trustedReadOnly = (entry.source === "builtin" || entry.source === "desk") && tool.annotations?.readOnlyHint === true
      return [{
        tool: schema,
        ax: declared ? { ...declared.ax, id: `tool:${served.function.name}` as const } : mcpToolCard(entry.server, tool, served.function.name, trustedReadOnly),
        riskProfile: declared ? declaredRiskProfile(declared.ax.effect) : trustedReadOnly
          ? { mutates: "none" as const, risk: "low" as const, reason: "read-only tool from the agent's own MCP server" }
          : entry.source === "desk" ? {
            mutates: "durable_state_write" as const,
            risk: "high" as const,
            reason: "changes a desk through Desk, which commits and pushes the change",
          } : {
            mutates: "external_side_effect" as const,
            risk: "high" as const,
            reason: "MCP tools may mutate external systems",
          },
        // A declared consequential tool waits for the person's approval, like the harness's own consequential tools.
        ...(declared?.ax.effect === "consequential"
          ? { approvalPolicy: () => ({ kind: "required" as const, policyId: "mcp.declared.consequential.v1", actionClass: `mcp.${entry.server}.${tool.name}`, requiresSoleCall: true as const }) }
          : {}),
        handler: async (args, ctx): Promise<string> => {
          if (ctx?.agentName !== binding.agentName || ctx.agentRoot !== binding.agentRoot) {
            emitNervesEvent({
              level: "warn", event: "mcp.tool_rejected", component: "repertoire",
              message: "MCP tool owner does not match its caller", meta: { reason: "owner mismatch" },
            })
            throw new McpCallRejectedError("MCP tool owner does not match its caller")
          }
          emitNervesEvent({
            event: "mcp.tool_start",
            component: "repertoire",
            message: `calling MCP tool ${entry.server}/${tool.name}`,
            meta: { server: entry.server, tool: tool.name },
          })

          const guarded = guardMcpArgs({ toolName: tool.name, declaresDryRun: Object.hasOwn((tool.inputSchema?.properties ?? {}) as object, "dry_run"), args, ctx })
          if (guarded.rejected !== undefined) throw new McpCallRejectedError(guarded.rejected)

          try {
            const result = await view.manager.callTool(binding, guarded.args as Record<string, string>, { agentName: ctx.agentName, agentRoot: ctx.agentRoot }, ctx.beforeHandler)
            const { text, images } = splitMcpContent(result.content)

            if (result.isError === true) {
              throw new McpToolExecutionError("handler_failed", `[mcp error] ${entry.server}/${tool.name}: ${text}`)
            }
            let output = text
            if (images.length > 0) {
              if (ctx.attachToolImages) ctx.attachToolImages(images)
              else output = `${text}${text ? "\n\n" : ""}[${images.length} image(s) returned, but this caller can't receive images]`
            }
            emitNervesEvent({
              event: "mcp.tool_end",
              component: "repertoire",
              message: `MCP tool ${entry.server}/${tool.name} completed`,
              meta: { server: entry.server, tool: tool.name },
            })

            return output
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            emitNervesEvent({
              level: "error",
              event: "mcp.tool_error",
              component: "repertoire",
              message: `MCP tool ${entry.server}/${tool.name} failed: ${reason}`,
              meta: { server: entry.server, tool: tool.name, reason },
            })
            if (error instanceof McpCallRejectedError || error instanceof McpToolExecutionError) throw error
            throw new McpToolExecutionError("handler_indeterminate", `[mcp error] ${entry.server}/${tool.name}: ${reason}`)
          }
        },
        mcpServer: entry.server,
        mcpBinding: binding,
      }]
    })
  })
}

/** A declared tool the server doesn't serve is not surfaced; say so, since the bundle promised it. */
function warnUnservedDeclarations(entry: McpServerView): void {
  const served = new Set(entry.tools.map((tool) => tool.name))
  const missing = [...entry.declared!.keys()].filter((name) => !served.has(name))
  if (missing.length === 0) return
  emitNervesEvent({
    level: "warn", event: "mcp.declared_tool_unserved", component: "repertoire",
    message: `MCP server ${entry.server} doesn't serve tools its bundle declares`, meta: { server: entry.server, missing },
  })
}
