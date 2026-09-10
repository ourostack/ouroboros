import { vi } from "vitest"
import { McpManager, type McpOwner, type McpTurnView } from "../../repertoire/mcp-manager"
import type { McpToolInfo } from "../../repertoire/mcp-client"

export const MCP_OWNER = Object.freeze({ agentName: "test-agent", agentRoot: "/mock/test-agent.ouro" })
export const MCP_CONTEXT = { ...MCP_OWNER, signin: async () => undefined }
const managers: McpManager[] = []

export function makeMcpView(
  groups: Array<{ server: string; tools: McpToolInfo[]; pluginId?: string }>,
  result?: { content: Array<{ type: string; text: string }> },
  error?: unknown,
  owner: McpOwner = MCP_OWNER,
): McpTurnView {
  const manager = new McpManager()
  managers.push(manager)
  vi.spyOn(manager, "validateToolBinding").mockResolvedValue(undefined)
  vi.spyOn(manager, "callTool").mockImplementation(async () => {
    if (error !== undefined) throw error
    return result ?? { content: [{ type: "text", text: "ok" }] }
  })
  return {
    manager,
    owner,
    entries: groups.map((group, index) => ({
      ...group, source: group.pluginId ? "plugin" : "builtin",
      configDigest: "a".repeat(64), generation: index + 1,
    })),
  }
}

export async function shutdownMcpFixtures(): Promise<void> {
  for (const manager of managers.splice(0)) await manager.shutdown()
}
