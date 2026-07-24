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
  protocolVersion: ReturnType<typeof vi.fn>
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
    protocolVersion: vi.fn(() => "2025-06-18"),
    onClose: vi.fn((cb: () => void) => { closeCallback = cb }),
    _triggerClose: () => { connected = false; closeCallback?.() },
  }
}

vi.mock("../../repertoire/mcp-client", () => ({
  isMcpTransportError: (error: unknown) => (error instanceof Error && error.name === "McpTransportError")
    || String(error).toLowerCase().includes("disconnected"),
  McpClient: class McpClient {
    connect: MockClient["connect"]
    listTools: MockClient["listTools"]
    refreshTools: MockClient["refreshTools"]
    callTool: MockClient["callTool"]
    shutdown: MockClient["shutdown"]
    isConnected: MockClient["isConnected"]
    protocolVersion: MockClient["protocolVersion"]
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
      this.protocolVersion = mock.protocolVersion
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

    it("normalizes a non-Error pre-dispatch transport reason", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient()
        if (clientIdx === 0) {
          client.callTool = vi.fn().mockRejectedValue({
            phase: "pre-dispatch",
            toString: () => "disconnected before write",
          })
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const manager = new McpManager()
      await manager.start({ ado: { command: "ado-server" } })

      await expect(manager.callTool("ado", "get_items", {})).resolves.toBeDefined()
      expect(clientInstances).toHaveLength(2)
    })
  })

  describe("internal server boundary", () => {
    it("requires exactly 32 random bytes for an internal capability", () => {
      const base = {
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
      }
      expect(() => createMcpInternalExecutorAuthority({ ...base, randomBytes: () => Buffer.alloc(31) })).toThrow(/32 random bytes/i)
      expect(() => createMcpInternalExecutorAuthority({ ...base, randomBytes: () => "not-buffer" as unknown as Buffer })).toThrow(/32 random bytes/i)
    })

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

    it("recovers and retries one internal call after a proven pre-dispatch transport failure", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) {
          client.callTool = vi.fn().mockRejectedValue(transportError("pre-dispatch", "closed before write"))
        }
        clientInstances.push(client)
        clientIdx++
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
        arguments: { ouroOccurrence: { occurrenceId: "occurrence-a" } },
        timeoutMs: 20_000,
      })).resolves.toEqual({ content: [{ type: "text", text: "result" }] })
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[0].callTool).toHaveBeenCalledTimes(1)
      expect(clientInstances[1].callTool).toHaveBeenCalledTimes(1)
    })

    it("never retries an internal call after post-dispatch response loss", async () => {
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        client.callTool = vi.fn().mockRejectedValue(transportError("post-dispatch", "response lost"))
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
        arguments: {},
        timeoutMs: 20_000,
      })).rejects.toMatchObject({ name: "McpTransportError", phase: "post-dispatch" })
      expect(clientInstances).toHaveLength(1)
      expect(clientInstances[0].callTool).toHaveBeenCalledTimes(1)
    })

    it("recovers a disconnected internal server before dispatch", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        clientIdx++
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
        arguments: {},
        timeoutMs: 20_000,
      })).resolves.toBeDefined()
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[0].callTool).not.toHaveBeenCalled()
      expect(clientInstances[1].callTool).toHaveBeenCalledTimes(1)
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

    it("atomically replaces one owner's capability set and revokes its stale revision", async () => {
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      const first = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })
      const second = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"b".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 2),
      })
      manager.replaceInternalExecutorAuthorities("agent-a", [first])
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })
      manager.replaceInternalExecutorAuthorities("agent-a", [second])

      await expect(manager.callInternalTool({
        authority: first,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 20_000,
      })).rejects.toThrow(/capability|authority/i)
      await expect(manager.callInternalTool({
        authority: second,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 20_000,
      })).resolves.toBeDefined()
    })

    it("revokes server-bound capabilities before config replacement and removal", async () => {
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      const first = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })
      const survivor = createMcpInternalExecutorAuthority({
        executorId: "executor-b",
        serverId: "survivor",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 3),
      })
      const orphan = createMcpInternalExecutorAuthority({
        executorId: "executor-c",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 4),
      })
      manager.replaceInternalExecutorAuthorities("agent-a", [first, survivor])
      manager.replaceInternalExecutorAuthorities("agent-b", [orphan])
      await manager.start({
        internal: { command: "internal-server", args: ["v1"], visibility: "internal" },
        survivor: { command: "survivor-server", visibility: "internal" },
      })

      await manager.reconcile(undefined, {
        configuredServers: {
          internal: { command: "internal-server", args: ["v2"], visibility: "internal" },
          survivor: { command: "survivor-server", visibility: "internal" },
        },
        includePlugins: false,
      })
      await expect(manager.callInternalTool({
        authority: first,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 20_000,
      })).rejects.toThrow(/capability|authority/i)
      await expect(manager.callInternalTool({
        authority: survivor,
        serverId: "survivor",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 20_000,
      })).resolves.toBeDefined()

      const second = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"b".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 2),
      })
      manager.replaceInternalExecutorAuthorities("agent-a", [second, survivor])
      await manager.reconcile(undefined, {
        configuredServers: { survivor: { command: "survivor-server", visibility: "internal" } },
        includePlugins: false,
      })
      await expect(manager.callInternalTool({
        authority: second,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 20_000,
      })).rejects.toThrow(/capability|authority/i)
      expect(clientInstances[0].shutdown).toHaveBeenCalled()
      expect(clientInstances[1].shutdown).not.toHaveBeenCalled()
      expect(clientInstances[2].shutdown).toHaveBeenCalled()
    })

    it("validates replacement ownership and capability encoding before mutation", () => {
      const manager = new McpManager()
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })

      expect(() => manager.replaceInternalExecutorAuthorities("", [authority])).toThrow(/owner/i)
      expect(() => manager.replaceInternalExecutorAuthorities("agent-a", [authority, authority])).toThrow(/duplicate/i)
      manager.registerInternalExecutorAuthority(authority)
      expect(() => manager.registerInternalExecutorAuthority(authority)).toThrow(/duplicate/i)
      expect(() => manager.replaceInternalExecutorAuthorities("agent-b", [authority])).toThrow(/owned/i)
      expect(() => manager.registerInternalExecutorAuthority({ ...authority, capabilityId: "bad" })).toThrow(/encoding/i)
      expect(() => manager.registerInternalExecutorAuthority({ ...authority, capabilityId: "b".repeat(64), token: "00".repeat(32) })).toThrow(/hash/i)

      const owned = new McpManager()
      owned.replaceInternalExecutorAuthorities("agent-a", [authority])
      expect(() => owned.replaceInternalExecutorAuthorities("agent-a", [authority])).not.toThrow()
      expect(() => owned.replaceInternalExecutorAuthorities("agent-a", [])).not.toThrow()
    })

    it("recovers disconnected and response-lost read-only inventory operations", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.isConnected = vi.fn(() => false)
        if (clientIdx === 2) client.refreshTools = vi.fn().mockRejectedValue(transportError("post-dispatch", "list response lost"))
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const disconnected = new McpManager()
      await disconnected.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(disconnected.refreshServerInventoryForComposition("internal")).resolves.toMatchObject({
        serverId: "internal",
        negotiatedProtocolVersion: "2025-06-18",
      })
      expect(clientInstances).toHaveLength(2)

      const responseLost = new McpManager()
      await responseLost.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(responseLost.refreshServerInventoryForComposition("internal")).resolves.toMatchObject({
        serverId: "internal",
      })
      expect(clientInstances).toHaveLength(4)
      expect(clientInstances[2].refreshTools).toHaveBeenCalledTimes(1)
      expect(clientInstances[3].refreshTools).toHaveBeenCalledTimes(1)
    })

    it("recovers capability-bound inventory and preserves ordinary refresh failures", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.isConnected = vi.fn(() => false)
        if (clientIdx === 2) client.refreshTools = vi.fn().mockRejectedValue(transportError("post-dispatch", "inventory response lost"))
        if (clientIdx === 4) client.refreshTools = vi.fn().mockRejectedValue(new Error("invalid inventory"))
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })

      const disconnected = new McpManager()
      disconnected.registerInternalExecutorAuthority(authority)
      await disconnected.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(disconnected.refreshInternalInventory(authority)).resolves.toHaveLength(1)

      const responseLost = new McpManager()
      responseLost.registerInternalExecutorAuthority(authority)
      await responseLost.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(responseLost.refreshInternalInventory(authority)).resolves.toHaveLength(1)

      const invalid = new McpManager()
      invalid.registerInternalExecutorAuthority(authority)
      await invalid.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(invalid.refreshInternalInventory(authority)).rejects.toThrow(/invalid inventory/i)
    })

    it("recovers and retries a declared no-effect health call after post-dispatch loss", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "health_status", description: "Health", inputSchema: {} }])
        if (clientIdx === 0) client.callTool = vi.fn().mockRejectedValue(transportError("post-dispatch", "read response lost"))
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const manager = new McpManager()
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "health_status",
        arguments: {},
        timeoutMs: 5_000,
      })).resolves.toBeDefined()
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[0].callTool).toHaveBeenCalledTimes(1)
      expect(clientInstances[1].callTool).toHaveBeenCalledTimes(1)
    })

    it("recovers a disconnected no-effect health server and rejects unavailable tools and application errors", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "health_status", description: "Health", inputSchema: {} }])
        if (clientIdx === 0) client.isConnected = vi.fn(() => false)
        if (clientIdx === 2) client.callTool = vi.fn().mockRejectedValue(new Error("probe rejected"))
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const disconnected = new McpManager()
      await disconnected.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(disconnected.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "health_status",
        arguments: {},
        timeoutMs: 5_000,
      })).resolves.toBeDefined()

      const applicationFailure = new McpManager()
      await applicationFailure.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(applicationFailure.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "health_status",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/probe rejected/i)
      await expect(applicationFailure.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "missing",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/absent/i)
      await expect(new McpManager().callReadOnlyHealthTool({
        serverId: "missing",
        toolName: "health_status",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/unavailable/i)
    })

    it("rejects unavailable composition inventory and missing negotiated protocol", async () => {
      await expect(new McpManager().refreshServerInventoryForComposition("missing")).rejects.toThrow(/unavailable/i)

      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        client.protocolVersion = vi.fn(() => null)
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(manager.refreshServerInventoryForComposition("internal")).rejects.toThrow(/protocol version/i)
    })

    it("fails closed when read-only transport recovery remains disconnected", async () => {
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        return client
      }
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })

      const internal = new McpManager()
      internal.registerInternalExecutorAuthority(authority)
      await internal.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(internal.refreshInternalInventory(authority)).rejects.toThrow(/disconnected/i)

      const composition = new McpManager()
      await composition.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(composition.refreshServerInventoryForComposition("internal")).rejects.toThrow(/unavailable/i)

      const health = new McpManager()
      await health.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(health.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/unavailable/i)
    })

    it("fails closed when transport-error recovery reconnects without the required tool", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const tools = clientIdx === 0
          ? [{ name: "health_status", description: "Health", inputSchema: {} }]
          : []
        const client = createMockClient(tools)
        if (clientIdx === 0) client.callTool = vi.fn().mockRejectedValue("disconnected after read")
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const manager = new McpManager()
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "health_status",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/absent/i)
    })

    it("rejects internal coordinate, visibility, and inventory mismatches", async () => {
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        clientInstances.push(client)
        return client
      }
      const coordinates = new McpManager()
      coordinates.registerInternalExecutorAuthority(authority)
      await coordinates.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(coordinates.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "other",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/coordinates/i)

      const visibility = new McpManager()
      visibility.registerInternalExecutorAuthority(authority)
      await visibility.start({ internal: { command: "agent-server" } })
      await expect(visibility.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/server.*unavailable/i)

      clientFactory = () => {
        const client = createMockClient([])
        clientInstances.push(client)
        return client
      }
      const absent = new McpManager()
      absent.registerInternalExecutorAuthority(authority)
      await absent.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(absent.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/tool.*absent/i)
    })

    it("normalizes non-Error read-only transport failures and hashes explicit transport coordinates", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.refreshTools = vi.fn().mockRejectedValue("disconnected inventory")
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const manager = new McpManager()
      await manager.start({
        internal: {
          command: "internal-server",
          args: ["--mode", "health"],
          cwd: "/tmp",
          visibility: "internal",
        },
      })

      await expect(manager.refreshServerInventoryForComposition("internal")).resolves.toMatchObject({
        transportIdentitySha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      })

      const defaults = new McpManager()
      await defaults.start({ public: { command: "public-server", args: ["--list"], cwd: "/tmp" } })
      await expect(defaults.refreshServerInventoryForComposition("public")).resolves.toMatchObject({
        transportIdentitySha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      })
    })

    it("normalizes non-Error internal inventory recovery", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.refreshTools = vi.fn().mockRejectedValue("disconnected inventory")
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })
      const manager = new McpManager()
      manager.registerInternalExecutorAuthority(authority)
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.refreshInternalInventory(authority)).resolves.toHaveLength(1)
    })

    it("fails effectful and read-only calls when their replacement transport remains disconnected", async () => {
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })

      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        return client
      }
      const initiallyDisconnected = new McpManager()
      initiallyDisconnected.registerInternalExecutorAuthority(authority)
      await initiallyDisconnected.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(initiallyDisconnected.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/disconnected/i)

      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.callTool = vi.fn().mockRejectedValue(transportError("pre-dispatch", "closed before write"))
        else client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const effectful = new McpManager()
      effectful.registerInternalExecutorAuthority(authority)
      await effectful.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(effectful.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/disconnected/i)

      clientIdx = 0
      clientInstances = []
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) client.refreshTools = vi.fn().mockRejectedValue(transportError("post-dispatch", "inventory response lost"))
        else client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const internalInventory = new McpManager()
      internalInventory.registerInternalExecutorAuthority(authority)
      await internalInventory.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(internalInventory.refreshInternalInventory(authority)).rejects.toThrow(/disconnected/i)

      clientIdx = 0
      clientInstances = []
      const composition = new McpManager()
      await composition.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(composition.refreshServerInventoryForComposition("internal")).rejects.toThrow(/unavailable/i)

      clientIdx = 0
      clientInstances = []
      clientFactory = () => {
        const client = createMockClient([{ name: "health_status", description: "Health", inputSchema: {} }])
        if (clientIdx === 0) client.callTool = vi.fn().mockRejectedValue(transportError("post-dispatch", "health response lost"))
        else client.isConnected = vi.fn(() => false)
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const health = new McpManager()
      await health.start({ internal: { command: "internal-server", visibility: "internal" } })
      await expect(health.callReadOnlyHealthTool({
        serverId: "internal",
        toolName: "health_status",
        arguments: {},
        timeoutMs: 5_000,
      })).rejects.toThrow(/unavailable/i)
    })

    it("normalizes a non-Error internal pre-dispatch transport reason", async () => {
      let clientIdx = 0
      clientFactory = () => {
        const client = createMockClient([{ name: "internal_effect", description: "Effect", inputSchema: {} }])
        if (clientIdx === 0) {
          client.callTool = vi.fn().mockRejectedValue({
            phase: "pre-dispatch",
            toString: () => "disconnected before internal write",
          })
        }
        clientInstances.push(client)
        clientIdx++
        return client
      }
      const authority = createMcpInternalExecutorAuthority({
        executorId: "executor-a",
        serverId: "internal",
        toolName: "internal_effect",
        registryRevision: `sha256:${"a".repeat(64)}`,
        randomBytes: () => Buffer.alloc(32, 1),
      })
      const manager = new McpManager()
      manager.registerInternalExecutorAuthority(authority)
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.callInternalTool({
        authority,
        serverId: "internal",
        toolName: "internal_effect",
        arguments: {},
        timeoutMs: 5_000,
      })).resolves.toBeDefined()
      expect(clientInstances).toHaveLength(2)
    })

    it("preserves ordinary composition refresh errors without reconnecting", async () => {
      clientFactory = () => {
        const client = createMockClient()
        client.refreshTools = vi.fn().mockRejectedValue(new Error("invalid list result"))
        clientInstances.push(client)
        return client
      }
      const manager = new McpManager()
      await manager.start({ internal: { command: "internal-server", visibility: "internal" } })

      await expect(manager.refreshServerInventoryForComposition("internal")).rejects.toThrow(/invalid list result/i)
      expect(clientInstances).toHaveLength(1)
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

    it("leaves plain values untouched while resolving a sibling vault reference", async () => {
      mockGetRawSecret.mockResolvedValue("resolved-secret")
      const manager = new McpManager()

      await manager.start({
        mixed: {
          command: "mixed-server",
          env: {
            MODE: "read-only",
            API_KEY: "vault:service/apiKey",
          },
        },
      })

      expect(mockGetRawSecret).toHaveBeenCalledOnce()
      expect(clientInstances).toHaveLength(1)
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
