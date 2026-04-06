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
      // Capture the env and cwd that the McpManager resolved
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

describe("McpManager vault env resolution", () => {
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

  it("resolves vault: references in env before spawning MCP server", async () => {
    mockGetRawSecret.mockResolvedValue("resolved-api-key")

    const manager = new McpManager()
    await manager.start({
      liteapi: {
        command: "npx",
        args: ["tsx", "src/index.ts"],
        env: { LITEAPI_API_KEY: "vault:liteapi.travel/apiKey" },
      },
    })

    expect(mockGetRawSecret).toHaveBeenCalledWith("liteapi.travel", "apiKey")
    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0]._spawnedEnv?.LITEAPI_API_KEY).toBe("resolved-api-key")

    manager.shutdown()
  })

  it("passes non-vault env values through unchanged", async () => {
    const manager = new McpManager()
    await manager.start({
      test: {
        command: "echo",
        env: { NORMAL_KEY: "plain-value" },
      },
    })

    expect(mockGetRawSecret).not.toHaveBeenCalled()
    expect(clientInstances[0]._spawnedEnv?.NORMAL_KEY).toBe("plain-value")

    manager.shutdown()
  })

  it("resolves multiple vault refs in same server config", async () => {
    mockGetRawSecret
      .mockResolvedValueOnce("key-1")
      .mockResolvedValueOnce("key-2")

    const manager = new McpManager()
    await manager.start({
      multi: {
        command: "test",
        env: {
          API_KEY: "vault:service.com/apiKey",
          SECRET: "vault:service.com/secret",
        },
      },
    })

    expect(mockGetRawSecret).toHaveBeenCalledTimes(2)
    expect(clientInstances[0]._spawnedEnv?.API_KEY).toBe("key-1")
    expect(clientInstances[0]._spawnedEnv?.SECRET).toBe("key-2")

    manager.shutdown()
  })

  it("skips server on vault unreachable and continues to next", async () => {
    mockGetRawSecret.mockRejectedValueOnce(new Error("vault unreachable"))

    const manager = new McpManager()
    await manager.start({
      failing: {
        command: "test",
        env: { KEY: "vault:broken.com/key" },
      },
      working: {
        command: "echo",
        env: { PLAIN: "value" },
      },
    })

    // The failing server was skipped; the working server connected
    // clientInstances[0] is the working server (failing server never spawned)
    expect(clientInstances).toHaveLength(1)
    const errorEvents = nervesEvents.filter(
      (e) => e.level === "error" && (e.message as string)?.includes("vault:broken.com/key"),
    )
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(errorEvents[0].message).toContain("could not be resolved")
    expect(errorEvents[0].message).toContain("vault unreachable")

    manager.shutdown()
  })

  it("skips server on item not found", async () => {
    mockGetRawSecret.mockRejectedValueOnce(new Error('no credential found for domain "missing.com"'))

    const manager = new McpManager()
    await manager.start({
      missing: {
        command: "test",
        env: { KEY: "vault:missing.com/key" },
      },
    })

    expect(clientInstances).toHaveLength(0) // server skipped
    const errorEvents = nervesEvents.filter(
      (e) => e.level === "error" && (e.message as string)?.includes("vault:missing.com/key"),
    )
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(errorEvents[0].message).toContain("could not be resolved")
    expect(errorEvents[0].message).toContain("item not found")

    manager.shutdown()
  })

  it("skips server on field empty", async () => {
    mockGetRawSecret.mockRejectedValueOnce(new Error('field "apiKey" not found for domain "empty.com"'))

    const manager = new McpManager()
    await manager.start({
      empty: {
        command: "test",
        env: { KEY: "vault:empty.com/apiKey" },
      },
    })

    expect(clientInstances).toHaveLength(0) // server skipped
    const errorEvents = nervesEvents.filter(
      (e) => e.level === "error" && (e.message as string)?.includes("vault:empty.com/apiKey"),
    )
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(errorEvents[0].message).toContain("could not be resolved")
    expect(errorEvents[0].message).toContain("field empty")

    manager.shutdown()
  })

  it("passes cwd to McpClient config", async () => {
    const manager = new McpManager()
    await manager.start({
      withCwd: {
        command: "npx",
        args: ["tsx", "src/index.ts"],
        cwd: "/path/to/liteapi-mcp",
      },
    })

    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0]._spawnedCwd).toBe("/path/to/liteapi-mcp")

    manager.shutdown()
  })
})
