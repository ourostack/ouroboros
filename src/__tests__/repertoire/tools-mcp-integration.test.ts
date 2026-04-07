import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events. vi.mock factories cannot reference top-level variables
// because they hoist above imports — use vi.hoisted so the mock and the
// assertions share the same array.
const { nervesEvents } = vi.hoisted(() => ({
  nervesEvents: [] as Array<Record<string, unknown>>,
}))
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent"),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
  })),
}))

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../repertoire/graph-client", () => ({
  getProfile: vi.fn(),
  graphRequest: vi.fn(),
}))

vi.mock("../../repertoire/ado-client", () => ({
  queryWorkItems: vi.fn(),
  adoRequest: vi.fn(),
  discoverOrganizations: vi.fn(),
}))

vi.mock("../../repertoire/github-client", () => ({
  githubRequest: vi.fn(),
}))

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn().mockReturnValue({ compact: "", full: "", byStatus: {}, actionRequired: [], unresolvedDependencies: [], activeSessions: [] }),
    createTask: vi.fn(),
    updateStatus: vi.fn(),
    boardStatus: vi.fn().mockReturnValue([]),
    boardAction: vi.fn().mockReturnValue([]),
    boardDeps: vi.fn().mockReturnValue([]),
    boardSessions: vi.fn().mockReturnValue([]),
  }),
}))

import type { McpManager } from "../../repertoire/mcp-manager"
import { getToolsForChannel, execTool, summarizeArgs, resetMcpDefinitions } from "../../repertoire/tools"

function makeMockMcpManager(
  allTools: Array<{ server: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>,
): McpManager {
  return {
    listAllTools: () => allTools,
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as McpManager
}

describe("getToolsForChannel with mcpManager", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    resetMcpDefinitions()
  })

  it("without mcpManager: returns same tools as before (no MCP tools)", () => {
    const withoutMcp = getToolsForChannel()
    const names = withoutMcp.map((t) => t.function.name)
    expect(names).not.toContain("browser_navigate")
    // Baseline: should have native tools
    expect(names).toContain("read_file")
  })

  it("with mcpManager: MCP tools appended to the tool list", () => {
    const mgr = makeMockMcpManager([{
      server: "browser",
      tools: [
        { name: "navigate", description: "Navigate", inputSchema: { type: "object" } },
        { name: "screenshot", description: "Screenshot", inputSchema: { type: "object" } },
      ],
    }])

    const withMcp = getToolsForChannel(undefined, undefined, undefined, undefined, mgr)
    const names = withMcp.map((t) => t.function.name)
    expect(names).toContain("browser_navigate")
    expect(names).toContain("browser_screenshot")
    // Still has native tools
    expect(names).toContain("read_file")
  })

  it("tool list includes correct count: native + MCP tools", () => {
    const withoutMcp = getToolsForChannel()
    const mgr = makeMockMcpManager([{
      server: "test",
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    }])
    const withMcp = getToolsForChannel(undefined, undefined, undefined, undefined, mgr)
    expect(withMcp.length).toBe(withoutMcp.length + 1)
  })

  it("MCP tools with empty server list: no extra tools", () => {
    const mgr = makeMockMcpManager([])
    const withMcp = getToolsForChannel(undefined, undefined, undefined, undefined, mgr)
    const withoutMcp = getToolsForChannel()
    expect(withMcp.length).toBe(withoutMcp.length)
  })

  it("MCP tools from multiple servers all appear", () => {
    const mgr = makeMockMcpManager([
      { server: "browser", tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }] },
      { server: "duffel", tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] },
    ])

    const result = getToolsForChannel(undefined, undefined, undefined, undefined, mgr)
    const names = result.map((t) => t.function.name)
    expect(names).toContain("browser_navigate")
    expect(names).toContain("duffel_search")
  })
})

describe("execTool with MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    resetMcpDefinitions()
  })

  it("MCP tool name found in mcpDefinitions: handler is called, result returned", async () => {
    const mgr = makeMockMcpManager([{
      server: "browser",
      tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }],
    }])
    // Populate mcpDefinitions by calling getToolsForChannel
    getToolsForChannel(undefined, undefined, undefined, undefined, mgr)

    const result = await execTool("browser_navigate", { url: "https://example.com" })
    expect(result).toBe("ok")
    expect(mgr.callTool).toHaveBeenCalledWith("browser", "navigate", { url: "https://example.com" })
  })

  it("MCP tool name NOT found anywhere: returns unknown", async () => {
    const result = await execTool("nonexistent_tool_xyz", {})
    expect(result).toBe("unknown: nonexistent_tool_xyz")
  })

  it("MCP tool handler error: error propagated through handler (returns error string)", async () => {
    const mgr = {
      listAllTools: () => [{
        server: "broken",
        tools: [{ name: "fail", description: "Fails", inputSchema: { type: "object" } }],
      }],
      callTool: vi.fn().mockRejectedValue(new Error("connection lost")),
    } as unknown as McpManager

    getToolsForChannel(undefined, undefined, undefined, undefined, mgr)

    // The MCP handler catches errors and returns error string (no throw)
    const result = await execTool("broken_fail", {})
    expect(result).toContain("[mcp error]")
    expect(result).toContain("connection lost")
  })

  it("summarizeArgs works for MCP tools (falls back to generic summary)", () => {
    const mgr = makeMockMcpManager([{
      server: "browser",
      tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }],
    }])
    getToolsForChannel(undefined, undefined, undefined, undefined, mgr)

    const summary = summarizeArgs("browser_navigate", { url: "https://example.com" })
    expect(summary).toContain("url=https://example.com")
  })
})
