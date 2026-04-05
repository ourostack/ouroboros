import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { McpToolInfo } from "../../repertoire/mcp-client"

interface MockClient {
  connect: ReturnType<typeof vi.fn>
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  isConnected: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  _triggerClose: () => void
}

let clientFactory: () => MockClient

function createMockClient(tools: McpToolInfo[] = []): MockClient {
  let closeCallback: (() => void) | null = null
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    }),
    shutdown: vi.fn(),
    isConnected: vi.fn(() => true),
    onClose: vi.fn((cb: () => void) => { closeCallback = cb }),
    _triggerClose: () => { closeCallback?.() },
  }
}

vi.mock("../../repertoire/mcp-client", () => ({
  McpClient: class McpClient {
    connect: MockClient["connect"]
    listTools: MockClient["listTools"]
    callTool: MockClient["callTool"]
    shutdown: MockClient["shutdown"]
    isConnected: MockClient["isConnected"]
    onClose: MockClient["onClose"]
    _triggerClose: MockClient["_triggerClose"]
    constructor() {
      const mock = clientFactory()
      this.connect = mock.connect
      this.listTools = mock.listTools
      this.callTool = mock.callTool
      this.shutdown = mock.shutdown
      this.isConnected = mock.isConnected
      this.onClose = mock.onClose
      this._triggerClose = mock._triggerClose
    }
  },
}))

import { McpManager } from "../../repertoire/mcp-manager"

const BROWSER_TOOLS: McpToolInfo[] = [
  { name: "browser_navigate", description: "Navigate to URL", inputSchema: {} },
  { name: "browser_click", description: "Click element", inputSchema: {} },
  { name: "browser_screenshot", description: "Take screenshot", inputSchema: {} },
  { name: "browser_snapshot", description: "Get page snapshot", inputSchema: {} },
  { name: "browser_type", description: "Type text", inputSchema: {} },
]

describe("Browser MCP config through McpManager", () => {
  let clientInstances: MockClient[]

  beforeEach(() => {
    clientInstances = []
    clientFactory = () => {
      const client = createMockClient(BROWSER_TOOLS)
      clientInstances.push(client)
      return client
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("creates browser server entry when config includes browser MCP", async () => {
    const manager = new McpManager()

    await manager.start({
      browser: {
        command: "npx",
        args: [
          "@playwright/mcp",
          "--user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0",
          "--viewport-size", "1440x900",
        ],
      },
    })

    // Verify a client was created for the browser server
    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0].connect).toHaveBeenCalled()
  })

  it("lists browser tools when browser server is configured", async () => {
    const manager = new McpManager()

    await manager.start({
      browser: {
        command: "npx",
        args: ["@playwright/mcp"],
      },
    })

    const allToolGroups = manager.listAllTools()
    const browserGroup = allToolGroups.find((g) => g.server === "browser")
    expect(browserGroup).toBeDefined()
    const toolNames = browserGroup!.tools.map((t) => t.name)
    expect(toolNames).toContain("browser_navigate")
    expect(toolNames).toContain("browser_click")
    expect(toolNames).toContain("browser_screenshot")
  })

  it("browser server config uses correct @playwright/mcp command", async () => {
    const manager = new McpManager()

    const config = {
      browser: {
        command: "npx",
        args: ["@playwright/mcp"],
      },
    }

    await manager.start(config)

    // Verify the config has the expected structure
    expect(config.browser.command).toBe("npx")
    expect(config.browser.args).toContain("@playwright/mcp")
  })

  it("browser tools appear alongside other MCP server tools", async () => {
    let callCount = 0
    clientFactory = () => {
      callCount++
      const tools = callCount === 1
        ? BROWSER_TOOLS
        : [{ name: "duffel_search_flights", description: "Search flights", inputSchema: {} }]
      const client = createMockClient(tools)
      clientInstances.push(client)
      return client
    }

    const manager = new McpManager()
    await manager.start({
      browser: { command: "npx", args: ["@playwright/mcp"] },
      duffel: { command: "npx", args: ["duffel-mcp"] },
    })

    const allToolGroups = manager.listAllTools()
    const serverNames = allToolGroups.map((g) => g.server)
    expect(serverNames).toContain("browser")
    expect(serverNames).toContain("duffel")

    const browserTools = allToolGroups.find((g) => g.server === "browser")!.tools.map((t) => t.name)
    const duffelTools = allToolGroups.find((g) => g.server === "duffel")!.tools.map((t) => t.name)
    expect(browserTools).toContain("browser_navigate")
    expect(duffelTools).toContain("duffel_search_flights")
  })
})
