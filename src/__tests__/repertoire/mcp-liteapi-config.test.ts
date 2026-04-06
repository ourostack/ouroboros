import { describe, it, expect, vi, beforeEach } from "vitest"
import type { McpToolInfo } from "../../repertoire/mcp-client"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock credential store
const mockGetRawSecret = vi.fn()
vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => ({
    getRawSecret: mockGetRawSecret,
    isReady: () => true,
  }),
}))

interface MockClient {
  connect: ReturnType<typeof vi.fn>
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  isConnected: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  _spawnedEnv?: Record<string, string>
  _spawnedCwd?: string
}

let clientFactory: () => MockClient

vi.mock("../../repertoire/mcp-client", () => ({
  McpClient: class McpClient {
    connect: MockClient["connect"]
    listTools: MockClient["listTools"]
    callTool: MockClient["callTool"]
    shutdown: MockClient["shutdown"]
    isConnected: MockClient["isConnected"]
    onClose: MockClient["onClose"]
    _spawnedEnv?: Record<string, string>
    _spawnedCwd?: string
    constructor(config: { env?: Record<string, string>; cwd?: string }) {
      const mock = clientFactory()
      this.connect = mock.connect
      this.listTools = mock.listTools
      this.callTool = mock.callTool
      this.shutdown = mock.shutdown
      this.isConnected = mock.isConnected
      this.onClose = mock.onClose
      this._spawnedEnv = config.env
      this._spawnedCwd = config.cwd
      mock._spawnedEnv = config.env
      mock._spawnedCwd = config.cwd
    }
  },
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: () => ({}),
}))

import { McpManager } from "../../repertoire/mcp-manager"

function createMockClient(tools: McpToolInfo[] = []): MockClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    shutdown: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onClose: vi.fn(),
  }
}

describe("LiteAPI MCP configuration", () => {
  let clientInstances: MockClient[]

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    clientInstances = []
    clientFactory = () => {
      const client = createMockClient()
      clientInstances.push(client)
      return client
    }
  })

  it("resolves vault:liteapi.travel/apiKey for LiteAPI server", async () => {
    mockGetRawSecret.mockResolvedValue("liteapi-test-key-123")

    const manager = new McpManager()
    await manager.start({
      liteapi: {
        command: "npx",
        args: ["tsx", "src/index.ts"],
        cwd: "/path/to/liteapi-mcp-server",
        env: {
          LITEAPI_API_KEY: "vault:liteapi.travel/apiKey",
        },
      },
    })

    expect(mockGetRawSecret).toHaveBeenCalledWith("liteapi.travel", "apiKey")
    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0]._spawnedEnv?.LITEAPI_API_KEY).toBe("liteapi-test-key-123")
    expect(clientInstances[0]._spawnedCwd).toBe("/path/to/liteapi-mcp-server")

    manager.shutdown()
  })

  it("skips LiteAPI when vault resolution fails", async () => {
    mockGetRawSecret.mockRejectedValue(new Error('no credential found for domain "liteapi.travel"'))

    const manager = new McpManager()
    await manager.start({
      liteapi: {
        command: "npx",
        args: ["tsx", "src/index.ts"],
        cwd: "/path/to/liteapi-mcp-server",
        env: {
          LITEAPI_API_KEY: "vault:liteapi.travel/apiKey",
        },
      },
      browser: {
        command: "npx",
        args: ["@anthropic-ai/mcp-playwright"],
      },
    })

    // LiteAPI was skipped, browser connected
    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0]._spawnedCwd).toBeUndefined() // browser has no cwd

    // Error event emitted for LiteAPI
    const errorEvents = nervesEvents.filter(
      (e) => e.level === "error" && (e.message as string)?.includes("liteapi"),
    )
    expect(errorEvents.length).toBeGreaterThan(0)
    expect((errorEvents[0].message as string)).toContain("could not be resolved")

    manager.shutdown()
  })

  it("LiteAPI config uses correct command shape: npx tsx src/index.ts", async () => {
    mockGetRawSecret.mockResolvedValue("test-key")

    const liteApiConfig = {
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: "/opt/liteapi-mcp-server",
      env: {
        LITEAPI_API_KEY: "vault:liteapi.travel/apiKey",
      },
    }

    const manager = new McpManager()
    await manager.start({ liteapi: liteApiConfig })

    expect(clientInstances).toHaveLength(1)
    // The client received the resolved config
    expect(clientInstances[0]._spawnedEnv?.LITEAPI_API_KEY).toBe("test-key")
    expect(clientInstances[0]._spawnedCwd).toBe("/opt/liteapi-mcp-server")

    manager.shutdown()
  })
})
