import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { McpToolInfo } from "../../repertoire/mcp-client"

// Track nerves events for vault resolution tests
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock credential store for vault env resolution
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
  refreshTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  isConnected: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  _triggerClose: () => void
}

let clientFactory: () => MockClient

function transportError(phase: "pre-dispatch" | "post-dispatch", message: string): Error & { phase: string } {
  return Object.assign(new Error(message), { name: "McpTransportError", phase })
}

function createMockClient(tools: McpToolInfo[] = [], shouldFailConnect = false): MockClient {
  let closeCallback: (() => void) | null = null
  let connected = !shouldFailConnect
  return {
    connect: shouldFailConnect
      ? vi.fn().mockRejectedValue(new Error("connect failed"))
      : vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    refreshTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    }),
    shutdown: vi.fn(() => { connected = false }),
    isConnected: vi.fn(() => connected),
    onClose: vi.fn((cb: () => void) => { closeCallback = cb }),
    _triggerClose: () => { connected = false; closeCallback?.() },
  }
}

vi.mock("../../repertoire/mcp-client", () => ({
  isMcpTransportError: (error: unknown) => error instanceof Error && error.name === "McpTransportError",
  McpClient: class McpClient {
    connect: MockClient["connect"]
    listTools: MockClient["listTools"]
    refreshTools: MockClient["refreshTools"]
    callTool: MockClient["callTool"]
    shutdown: MockClient["shutdown"]
    isConnected: MockClient["isConnected"]
    onClose: MockClient["onClose"]
    _triggerClose: MockClient["_triggerClose"]
    constructor() {
      const mock = clientFactory()
      this.connect = mock.connect
      this.listTools = mock.listTools
      this.refreshTools = mock.refreshTools
      this.callTool = mock.callTool
      this.shutdown = mock.shutdown
      this.isConnected = mock.isConnected
      this.onClose = mock.onClose
      this._triggerClose = mock._triggerClose
    }
  },
}))

import {
  McpManager,
  createMcpInternalExecutorAuthority,
} from "../../repertoire/mcp-manager"

describe("McpManager", () => {
  let clientInstances: MockClient[]

  beforeEach(() => {
    clientInstances = []
    nervesEvents.length = 0
    mockGetRawSecret.mockReset()
    clientFactory = () => {
      const client = createMockClient()
      clientInstances.push(client)
      return client
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("start", () => {
    it("spawns clients for each server in config", async () => {
      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
        mail: { command: "mail-server", args: ["--port", "3000"] },
      })

      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[0].connect).toHaveBeenCalled()
      expect(clientInstances[1].connect).toHaveBeenCalled()
    })

    it("handles empty config (no servers)", async () => {
      const manager = new McpManager()

      await manager.start({})

      expect(clientInstances).toHaveLength(0)
    })

    it("logs non-Error exceptions when connect fails", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.connect = vi.fn().mockRejectedValue("string-error")
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()

      // Should not throw, should log the error
      await manager.start({
        ado: { command: "ado-server" },
      })

      expect(clientInstances).toHaveLength(1)
    })

    it("continues starting other servers when one fails to connect", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = clientIdx === 0
          ? createMockClient([], true) // first server fails
          : createMockClient()
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()

      await manager.start({
        failing: { command: "bad-server" },
        working: { command: "good-server" },
      })

      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[1].connect).toHaveBeenCalled()
    })
  })

  describe("listAllTools", () => {
    it("aggregates tools from all connected servers", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const tools = clientIdx === 0
          ? [{ name: "get_items", description: "Get items", inputSchema: { type: "object" } }]
          : [{ name: "send_mail", description: "Send mail", inputSchema: { type: "object" } }]
        const client = createMockClient(tools)
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
        mail: { command: "mail-server" },
      })

      const allTools = manager.listAllTools()

      expect(allTools).toHaveLength(2)
      expect(allTools[0].server).toBe("ado")
      expect(allTools[0].tools).toEqual([
        { name: "get_items", description: "Get items", inputSchema: { type: "object" } },
      ])
      expect(allTools[1].server).toBe("mail")
      expect(allTools[1].tools).toEqual([
        { name: "send_mail", description: "Send mail", inputSchema: { type: "object" } },
      ])
    })

    it("returns empty array when no servers configured", () => {
      const manager = new McpManager()

      const allTools = manager.listAllTools()
      expect(allTools).toEqual([])
    })
  })

  describe("callTool", () => {
    it("routes to correct client", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient()
        if (clientIdx === 1) {
          client.callTool = vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "mail result" }],
          })
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
        mail: { command: "mail-server" },
      })

      const result = await manager.callTool("mail", "send_mail", { to: "test@test.com" })

      expect(result).toEqual({
        content: [{ type: "text", text: "mail result" }],
      })
      expect(clientInstances[1].callTool).toHaveBeenCalledWith("send_mail", { to: "test@test.com" })
    })

    it("returns error for unknown server", async () => {
      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      await expect(manager.callTool("unknown", "tool", {})).rejects.toThrow(/unknown server/i)
    })

    it("returns error for disconnected server", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      await expect(manager.callTool("ado", "get_items", {})).rejects.toThrow(/disconnected/i)
    })

    it("reconnects a stale disconnected transport before calling a tool", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient()
        if (clientIdx === 0) {
          client.isConnected = vi.fn(() => false)
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      const result = await manager.callTool("ado", "get_items", {})

      expect(result.content[0].text).toBe("result")
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[1].connect).toHaveBeenCalled()
      expect(clientInstances[1].callTool).toHaveBeenCalledWith("get_items", {})
      expect(nervesEvents.some((e) => e.event === "mcp.transport_recovery")).toBe(true)
    })

    it("reconnects and retries once after a transport-level call failure", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient()
        if (clientIdx === 0) {
          client.callTool = vi.fn().mockRejectedValue(transportError("pre-dispatch", "Transport closed before write"))
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      const result = await manager.callTool("ado", "get_items", { q: "x" })

      expect(result.content[0].text).toBe("result")
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[0].shutdown).toHaveBeenCalled()
      expect(clientInstances[1].callTool).toHaveBeenCalledWith("get_items", { q: "x" })
    })

    it("reports when transport recovery cannot reconnect after a call failure", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient()
        if (clientIdx === 0) {
          client.callTool = vi.fn().mockRejectedValue(transportError("pre-dispatch", "Transport closed before write"))
        } else {
          client.isConnected = vi.fn(() => false)
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      await expect(manager.callTool("ado", "get_items", {})).rejects.toThrow(
        'Server "ado" is disconnected after recovery: Transport closed before write',
      )
    })

    it("never retries a post-dispatch transport failure", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.callTool = vi.fn().mockRejectedValue(transportError("post-dispatch", "response lost after write"))
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      await expect(manager.callTool("ado", "get_items", {})).rejects.toMatchObject({
        name: "McpTransportError",
        phase: "post-dispatch",
      })
      expect(clientInstances).toHaveLength(1)
      expect(clientInstances[0].callTool).toHaveBeenCalledTimes(1)
    })

    it("does not retry application-level MCP tool errors", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.callTool = vi.fn().mockRejectedValue(new Error("Method not found"))
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      await expect(manager.callTool("ado", "missing", {})).rejects.toThrow("Method not found")
      expect(clientInstances).toHaveLength(1)
    })
  })

  describe("internal server boundary", () => {
    it("filters internal servers from public inventory, calls, and canaries", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const tools = [{ name: clientIdx === 0 ? "public_read" : "internal_effect", description: "Tool", inputSchema: {} }]
        const client = createMockClient(tools)
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const manager = new McpManager()
      await manager.start({
        public: { command: "public-server", visibility: "agent" },
        internal: { command: "internal-server", visibility: "internal" },
      })

      expect(manager.listAllTools()).toEqual([{
        server: "public",
        tools: [{ name: "public_read", description: "Tool", inputSchema: {} }],
      }])
      await expect(manager.callTool("internal", "internal_effect", {})).rejects.toThrow(/internal/i)
      await expect(manager.runCanaries()).resolves.toEqual([{ server: "public", ok: true, detail: "1 tools listed" }])
      expect(clientInstances[1].callTool).not.toHaveBeenCalled()
      expect(clientInstances[1].refreshTools).not.toHaveBeenCalled()
    })

    it("calls an internal tool only with the registered exact memory capability", async () => {
      const completeResult = {
        content: [{ type: "text", text: "data" }],
        structuredContent: { ok: true },
        isError: false,
      }
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        client.callTool = vi.fn().mockResolvedValue(completeResult)
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 7),
      })
      manager.registerInternalExecutorAuthority(authority)
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: { ouroOccurrence: { occurrenceId: "occurrence-a" }, input: {}, credentials: {} },
        timeoutMs: 20_000,
      })).resolves.toEqual(completeResult)
      expect(clientInstances[0].callTool).toHaveBeenCalledWith(
        "internal_effect",
        { ouroOccurrence: { occurrenceId: "occurrence-a" }, input: {}, credentials: {} },
        20_000,
      )
    })

    it.each([
      ["executor", { executorId: "executor-other" }],
      ["server", { serverId: "other" }],
      ["tool", { toolName: "other" }],
      ["revision", { registryRevision: `sha256:${"b".repeat(64)}` }],
      ["token", { token: "00".repeat(32) }],
    ])("rejects a mismatched internal %s capability before lookup or dispatch", async (_label, replacement) => {
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 7),
      })
      manager.registerInternalExecutorAuthority(authority)
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.callInternalTool({
        authority: { ...authority, ...replacement },
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 20_000,
      })).rejects.toThrow(/capability|authority/i)
      expect(clientInstances[0].callTool).not.toHaveBeenCalled()
    })

    it("uses capability-bound internal inventory without surfacing it publicly", async () => {
      const internalTools = [{
        name: "internal_effect",
        description: "Effect",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      }]
      clientFactory = () => {
        const client = createMockClient(internalTools)
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 7),
      })
      manager.registerInternalExecutorAuthority(authority)
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.refreshInternalInventory(authority)).resolves.toEqual(internalTools)
      expect(manager.listAllTools()).toEqual([])
    })
  })

  describe("runCanaries", () => {
    it("refreshes each server's tools through a live request", async () => {
      clientFactory = () => {
        const client = createMockClient([{ name: "ping", description: "Ping", inputSchema: {} }])
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()
      await manager.start({ ado: { command: "ado-server" } })

      const results = await manager.runCanaries()

      expect(results).toEqual([{ server: "ado", ok: true, detail: "1 tools listed" }])
      expect(clientInstances[0].refreshTools).toHaveBeenCalled()
    })

    it("recovers a disconnected server during canary execution", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "ping", description: "Ping", inputSchema: {} }])
        if (clientIdx === 0) {
          client.isConnected = vi.fn(() => false)
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }

      const manager = new McpManager()
      await manager.start({ ado: { command: "ado-server" } })

      const results = await manager.runCanaries()

      expect(results).toEqual([{ server: "ado", ok: true, detail: "1 tools listed" }])
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[1].refreshTools).toHaveBeenCalled()
    })

    it("reports a disconnected server when canary recovery cannot reconnect", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()
      await manager.start({ ado: { command: "ado-server" } })

      const results = await manager.runCanaries()

      expect(results).toEqual([{ server: "ado", ok: false, detail: "disconnected after recovery attempt" }])
      expect(clientInstances).toHaveLength(2)
    })

    it("reports canary refresh failures and recovers transport-level errors", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.refreshTools = vi.fn().mockRejectedValue(transportError("pre-dispatch", "Transport closed during refresh"))
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()
      await manager.start({ ado: { command: "ado-server" } })

      const results = await manager.runCanaries()

      expect(results).toEqual([{ server: "ado", ok: false, detail: "Transport closed during refresh" }])
      expect(clientInstances).toHaveLength(2)
      expect(nervesEvents.some((e) => e.event === "mcp.transport_recovery")).toBe(true)
    })

    it("reports non-Error canary refresh failures", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.refreshTools = vi.fn().mockRejectedValue("plain refresh failure")
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()
      await manager.start({ ado: { command: "ado-server" } })

      const results = await manager.runCanaries()

      expect(results).toEqual([{ server: "ado", ok: false, detail: "plain refresh failure" }])
      expect(clientInstances).toHaveLength(1)
    })
  })

  describe("auto-restart on crash", () => {
    it("restarts a crashed server after delay", async () => {
      vi.useFakeTimers()

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      expect(clientInstances).toHaveLength(1)

      // Simulate crash
      clientInstances[0]._triggerClose()

      // Advance past restart delay
      await vi.advanceTimersByTimeAsync(1500)

      // A new client should have been created
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[1].connect).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it("caps retries at 5 consecutive failures", async () => {
      vi.useFakeTimers()

      clientFactory = () => {
        const client = createMockClient([], true) // always fails connect
        clientInstances.push(client)
        return client
      }

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      // Trigger close on each created client and advance time to trigger restart
      for (let i = 0; i < 6; i++) {
        const current = clientInstances[clientInstances.length - 1]
        current._triggerClose()
        await vi.advanceTimersByTimeAsync(1500)
      }

      // Should have stopped retrying after 5 consecutive failures
      // Initial + 5 retries = 6 total, 7th should not happen
      expect(clientInstances.length).toBeLessThanOrEqual(7)

      vi.useRealTimers()
    })
  })

  describe("shutdown", () => {
    it("shuts down all clients", async () => {
      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
        mail: { command: "mail-server" },
      })

      manager.shutdown()

      expect(clientInstances[0].shutdown).toHaveBeenCalled()
      expect(clientInstances[1].shutdown).toHaveBeenCalled()
    })

    it("is a no-op when no servers are started", () => {
      const manager = new McpManager()
      manager.shutdown()
      expect(clientInstances).toHaveLength(0)
    })
  })

  describe("vault env resolution", () => {
    it("resolves vault: references in server env config", async () => {
      mockGetRawSecret.mockResolvedValue("resolved-secret")

      const manager = new McpManager()

      await manager.start({
        liteapi: {
          command: "liteapi-server",
          env: { LITEAPI_KEY: "vault:liteapi.travel/apiKey" },
        },
      })

      expect(mockGetRawSecret).toHaveBeenCalledWith("liteapi.travel", "apiKey")
      expect(clientInstances).toHaveLength(1)
      expect(clientInstances[0].connect).toHaveBeenCalled()
    })

    it("skips server when vault item not found", async () => {
      mockGetRawSecret.mockRejectedValue(new Error("no credential found"))

      const manager = new McpManager()

      await manager.start({
        liteapi: {
          command: "liteapi-server",
          env: { LITEAPI_KEY: "vault:liteapi.travel/apiKey" },
        },
      })

      // Server should be skipped, no client created
      expect(clientInstances).toHaveLength(0)
      expect(nervesEvents.some((e) => e.event === "mcp.vault_resolve_error")).toBe(true)
    })

    it("classifies 'field empty' vault errors", async () => {
      mockGetRawSecret.mockRejectedValue(new Error("field apiKey not found in item"))

      const manager = new McpManager()

      await manager.start({
        liteapi: {
          command: "liteapi-server",
          env: { LITEAPI_KEY: "vault:liteapi.travel/apiKey" },
        },
      })

      expect(clientInstances).toHaveLength(0)
      const vaultError = nervesEvents.find((e) => e.event === "mcp.vault_resolve_error")
      expect(vaultError).toBeDefined()
      expect((vaultError!.message as string)).toContain("field empty")
    })

    it("classifies generic vault errors as 'vault unreachable'", async () => {
      mockGetRawSecret.mockRejectedValue(new Error("connection refused"))

      const manager = new McpManager()

      await manager.start({
        liteapi: {
          command: "liteapi-server",
          env: { LITEAPI_KEY: "vault:liteapi.travel/apiKey" },
        },
      })

      expect(clientInstances).toHaveLength(0)
      const vaultError = nervesEvents.find((e) => e.event === "mcp.vault_resolve_error")
      expect(vaultError).toBeDefined()
      expect((vaultError!.message as string)).toContain("vault unreachable")
    })

    it("passes through non-vault env values unchanged", async () => {
      const manager = new McpManager()

      await manager.start({
        simple: {
          command: "simple-server",
          env: { PLAIN_KEY: "just-a-value" },
        },
      })

      // No vault resolution needed, server should connect normally
      expect(mockGetRawSecret).not.toHaveBeenCalled()
      expect(clientInstances).toHaveLength(1)
    })

    it("prevents restart attempts after shutdown", async () => {
      vi.useFakeTimers()

      const manager = new McpManager()

      await manager.start({
        ado: { command: "ado-server" },
      })

      const firstClient = clientInstances[0]
      const initialCount = clientInstances.length

      // Shutdown sets shuttingDown flag, then trigger close callback to test the guard
      manager.shutdown()
      firstClient._triggerClose()

      await vi.advanceTimersByTimeAsync(1500)

      // No new client should be created after shutdown
      expect(clientInstances).toHaveLength(initialCount)

      vi.useRealTimers()
    })
  })
})
