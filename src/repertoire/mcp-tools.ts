/**
 * First-class MCP tool integration — converts MCP server tools into ToolDefinitions
 * so the model can call them directly without shell indirection.
 */

import type { McpManager } from "./mcp-manager"
import type { ToolDefinition } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Convert all tools from an McpManager into ToolDefinition objects.
 * Each tool gets named `{server}_{tool}` (e.g., `browser_navigate`).
 * The handler calls `mcpManager.callTool()` and returns concatenated text content.
 */
export function mcpToolsAsDefinitions(mcpManager: McpManager): ToolDefinition[] {
  if (!mcpManager) return []

  return mcpManager.listAllTools().flatMap((entry) =>
    entry.tools.map((tool) => ({
      tool: {
        type: "function" as const,
        function: {
          name: `${entry.server}_${tool.name}`,
          description: tool.description || `MCP tool: ${tool.name} (server: ${entry.server})`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
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
            .filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
            .map((c: { text: string }) => c.text)
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
    })),
  )
}
