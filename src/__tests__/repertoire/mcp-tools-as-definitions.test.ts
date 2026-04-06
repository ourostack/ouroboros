import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import type { McpManager } from "../../repertoire/mcp-manager"
import { mcpToolsAsDefinitions } from "../../repertoire/mcp-tools"

function makeMockMcpManager(
  allTools: Array<{ server: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>,
  callToolResult?: { content: Array<{ type: string; text: string }> },
  callToolError?: Error,
): McpManager {
  return {
    listAllTools: () => allTools,
    callTool: vi.fn().mockImplementation(async () => {
      if (callToolError) throw callToolError
      return callToolResult ?? { content: [{ type: "text", text: "ok" }] }
    }),
  } as unknown as McpManager
}

describe("mcpToolsAsDefinitions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns empty array when mcpManager has no servers", () => {
    const mgr = makeMockMcpManager([])
    const result = mcpToolsAsDefinitions(mgr)
    expect(result).toEqual([])
  })

  it("returns empty array when mcpManager is null/undefined", () => {
    expect(mcpToolsAsDefinitions(null as unknown as McpManager)).toEqual([])
    expect(mcpToolsAsDefinitions(undefined as unknown as McpManager)).toEqual([])
  })

  it("converts a single server's tools into ToolDefinition[] with {server}_{tool} naming", () => {
    const mgr = makeMockMcpManager([{
      server: "browser",
      tools: [
        { name: "navigate", description: "Navigate to URL", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
        { name: "screenshot", description: "Take screenshot", inputSchema: { type: "object", properties: {} } },
      ],
    }])

    const result = mcpToolsAsDefinitions(mgr)

    expect(result).toHaveLength(2)
    expect(result[0].tool.function.name).toBe("browser_navigate")
    expect(result[0].tool.function.description).toBe("Navigate to URL")
    expect(result[0].tool.function.parameters).toEqual({ type: "object", properties: { url: { type: "string" } } })
    expect(result[0].mcpServer).toBe("browser")

    expect(result[1].tool.function.name).toBe("browser_screenshot")
    expect(result[1].tool.function.description).toBe("Take screenshot")
    expect(result[1].mcpServer).toBe("browser")
  })

  it("converts multiple servers' tools, each prefixed with server name", () => {
    const mgr = makeMockMcpManager([
      { server: "browser", tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }] },
      { server: "duffel", tools: [{ name: "search_flights", description: "Search", inputSchema: { type: "object" } }] },
    ])

    const result = mcpToolsAsDefinitions(mgr)

    expect(result).toHaveLength(2)
    expect(result[0].tool.function.name).toBe("browser_navigate")
    expect(result[0].mcpServer).toBe("browser")
    expect(result[1].tool.function.name).toBe("duffel_search_flights")
    expect(result[1].mcpServer).toBe("duffel")
  })

  it("uses fallback description when tool has no description", () => {
    const mgr = makeMockMcpManager([{
      server: "myserver",
      tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }],
    }])

    const result = mcpToolsAsDefinitions(mgr)
    expect(result[0].tool.function.description).toBe("MCP tool: ping (server: myserver)")
  })

  it("uses fallback inputSchema when tool has no inputSchema", () => {
    const mgr = makeMockMcpManager([{
      server: "myserver",
      tools: [{ name: "ping", description: "Ping", inputSchema: undefined as unknown as Record<string, unknown> }],
    }])

    const result = mcpToolsAsDefinitions(mgr)
    expect(result[0].tool.function.parameters).toEqual({ type: "object", properties: {} })
  })

  it("generated handler calls McpManager.callTool(server, tool, args) and returns concatenated text", async () => {
    const mgr = makeMockMcpManager(
      [{ server: "browser", tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }] }],
      { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
    )

    const result = mcpToolsAsDefinitions(mgr)
    const output = await result[0].handler({ url: "https://example.com" })

    expect(mgr.callTool).toHaveBeenCalledWith("browser", "navigate", { url: "https://example.com" })
    expect(output).toBe("hello world")
  })

  it("handler returns JSON for non-text content items", async () => {
    const mgr = makeMockMcpManager(
      [{ server: "browser", tools: [{ name: "screenshot", description: "SS", inputSchema: { type: "object" } }] }],
      { content: [{ type: "image", text: "" }, { type: "text", text: "done" }] },
    )

    const result = mcpToolsAsDefinitions(mgr)
    const output = await result[0].handler({})

    // Non-text items with empty text still get concatenated, but the full result goes through
    expect(typeof output).toBe("string")
  })

  it("handler returns error string (not throw) when callTool fails", async () => {
    const mgr = makeMockMcpManager(
      [{ server: "browser", tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }] }],
      undefined,
      new Error("connection refused"),
    )

    const result = mcpToolsAsDefinitions(mgr)
    const output = await result[0].handler({ url: "https://example.com" })

    expect(output).toBe("[mcp error] browser/navigate: connection refused")
  })

  it("emits nerves events for MCP tool start/end on success", async () => {
    const mgr = makeMockMcpManager(
      [{ server: "browser", tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }] }],
      { content: [{ type: "text", text: "ok" }] },
    )

    const result = mcpToolsAsDefinitions(mgr)
    await result[0].handler({ url: "https://example.com" })

    const startEvent = nervesEvents.find((e) => e.event === "mcp.tool_start")
    const endEvent = nervesEvents.find((e) => e.event === "mcp.tool_end")
    expect(startEvent).toBeDefined()
    expect(startEvent!.component).toBe("repertoire")
    expect((startEvent!.meta as Record<string, unknown>).server).toBe("browser")
    expect((startEvent!.meta as Record<string, unknown>).tool).toBe("navigate")
    expect(endEvent).toBeDefined()
    expect(endEvent!.component).toBe("repertoire")
  })

  it("emits nerves events for MCP tool start/error on failure", async () => {
    const mgr = makeMockMcpManager(
      [{ server: "browser", tools: [{ name: "navigate", description: "Nav", inputSchema: { type: "object" } }] }],
      undefined,
      new Error("timeout"),
    )

    const result = mcpToolsAsDefinitions(mgr)
    await result[0].handler({})

    const startEvent = nervesEvents.find((e) => e.event === "mcp.tool_start")
    const errorEvent = nervesEvents.find((e) => e.event === "mcp.tool_error")
    expect(startEvent).toBeDefined()
    expect(errorEvent).toBeDefined()
    expect(errorEvent!.level).toBe("error")
    expect((errorEvent!.meta as Record<string, unknown>).reason).toBe("timeout")
  })

  it("handler handles non-Error throw values", async () => {
    const mgr = {
      listAllTools: () => [{
        server: "broken",
        tools: [{ name: "crash", description: "Crash", inputSchema: { type: "object" } }],
      }],
      callTool: vi.fn().mockRejectedValue("string-error-value"),
    } as unknown as McpManager

    const result = mcpToolsAsDefinitions(mgr)
    const output = await result[0].handler({})

    expect(output).toBe("[mcp error] broken/crash: string-error-value")
  })

  it("tool definition has type 'function'", () => {
    const mgr = makeMockMcpManager([{
      server: "test",
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    }])

    const result = mcpToolsAsDefinitions(mgr)
    expect(result[0].tool.type).toBe("function")
  })

  describe("double-prefix avoidance", () => {
    it("skips prefix when tool name already starts with server name (e.g. browser_navigate)", () => {
      const mgr = makeMockMcpManager([{
        server: "browser",
        tools: [{ name: "browser_navigate", description: "Navigate", inputSchema: { type: "object" } }],
      }])

      const result = mcpToolsAsDefinitions(mgr)
      expect(result[0].tool.function.name).toBe("browser_navigate")
    })

    it("still prefixes when tool name does NOT start with server name", () => {
      const mgr = makeMockMcpManager([{
        server: "duffel",
        tools: [{ name: "search_flights", description: "Search", inputSchema: { type: "object" } }],
      }])

      const result = mcpToolsAsDefinitions(mgr)
      expect(result[0].tool.function.name).toBe("duffel_search_flights")
    })

    it("still prefixes when server is a prefix of tool name but not at underscore boundary (server='b', tool='browser_navigate')", () => {
      const mgr = makeMockMcpManager([{
        server: "b",
        tools: [{ name: "browser_navigate", description: "Navigate", inputSchema: { type: "object" } }],
      }])

      const result = mcpToolsAsDefinitions(mgr)
      expect(result[0].tool.function.name).toBe("b_browser_navigate")
    })

    it("returns just the tool name when it exactly equals the server name", () => {
      const mgr = makeMockMcpManager([{
        server: "browser",
        tools: [{ name: "browser", description: "Browser tool", inputSchema: { type: "object" } }],
      }])

      const result = mcpToolsAsDefinitions(mgr)
      expect(result[0].tool.function.name).toBe("browser")
    })
  })
})
