/**
 * First-class MCP tool integration — converts MCP server tools into ToolDefinitions
 * so the model can call them directly without shell indirection.
 */

import type { McpManager } from "./mcp-manager"
import type { ToolDefinition } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Convert all tools from an McpManager into ToolDefinition objects.
 *
 * Naming rules:
 *  - Builtin servers (agent.json `mcpServers`) — legacy `{server}_{tool}`
 *    shape (e.g., `browser_navigate`), with double-prefix avoidance when
 *    the tool already starts with the server name.
 *  - Plugin servers (from `<plugin>/.mcp.json`, W6 Unit 9) — Anthropic public
 *    convention `mcp__{server}__{tool}` (e.g., `mcp__desk__task_create`).
 *    This matches Claude Code's external naming and the on-prompt promise
 *    in `desk-section.ts` (`mcp__desk__*`).
 *
 * The handler always calls `mcpManager.callTool()` with the un-prefixed
 * `(server, tool)` pair regardless of how the surfaced name was shaped.
 */
export function mcpToolsAsDefinitions(mcpManager: McpManager): ToolDefinition[] {
  if (!mcpManager) return []

  return mcpManager.listAllTools().flatMap((entry) => {
    const isPluginSourced = Boolean(entry.pluginId)
    return entry.tools.map((tool) => ({
      tool: {
        type: "function" as const,
        function: {
          name: isPluginSourced
            ? `mcp__${entry.server}__${tool.name}`
            : tool.name.startsWith(`${entry.server}_`) || tool.name === entry.server
              ? tool.name
              : `${entry.server}_${tool.name}`,
          description: tool.description || `MCP tool: ${tool.name} (server: ${entry.server})`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      },
      riskProfile: {
        mutates: "external_side_effect" as const,
        risk: "high" as const,
        reason: "MCP tools may mutate external systems",
      },
      handler: async (args: Record<string, string>): Promise<string> => {
        emitNervesEvent({
          event: "mcp.tool_start",
          component: "repertoire",
          message: `calling MCP tool ${entry.server}/${tool.name}`,
          meta: { server: entry.server, tool: tool.name },
        })

        try {
          const result = await mcpManager.callTool(entry.server, tool.name, args)
          const text = result.content
            .filter((content): content is typeof content & { text: string } =>
              content.type === "text" && typeof content.text === "string")
            .map((content) => content.text)
            .join("")

          emitNervesEvent({
            event: "mcp.tool_end",
            component: "repertoire",
            message: `MCP tool ${entry.server}/${tool.name} completed`,
            meta: { server: entry.server, tool: tool.name },
          })

          return text
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          emitNervesEvent({
            level: "error",
            event: "mcp.tool_error",
            component: "repertoire",
            message: `MCP tool ${entry.server}/${tool.name} failed: ${reason}`,
            meta: { server: entry.server, tool: tool.name, reason },
          })
          return `[mcp error] ${entry.server}/${tool.name}: ${reason}`
        }
      },
      mcpServer: entry.server,
    }))
  })
}
