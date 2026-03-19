import { describe, it, expect, vi, afterEach } from "vitest"

/**
 * Tests for MCP Manager wiring into production code paths:
 * 1. daemon.ts handleCommand routes mcp.list/mcp.call to shared manager
 * 2. daemon.ts stop() calls shutdownSharedMcpManager()
 * 3. CLI routes mcp commands through daemon socket (not locally)
 * 4. Shared singleton lifecycle (create, shutdown, cleanup)
 */

describe("MCP Manager wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("daemon stop calls shutdownSharedMcpManager", () => {
    it("stop() invokes shutdownSharedMcpManager", async () => {
      vi.resetModules()
      const shutdownSpy = vi.fn()

      vi.doMock("../../repertoire/mcp-manager", () => ({
        getSharedMcpManager: vi.fn().mockResolvedValue(null),
        shutdownSharedMcpManager: shutdownSpy,
      }))

      const { OuroDaemon } = await import("../../heart/daemon/daemon")

      const daemon = new OuroDaemon({
        socketPath: "/tmp/mcp-wiring-test.sock",
        processManager: {
          stopAll: vi.fn(async () => undefined),
          listAgentSnapshots: vi.fn(() => []),
          startAutoStartAgents: vi.fn(async () => undefined),
        },
        scheduler: { listJobs: vi.fn(() => []), stop: vi.fn() },
        healthMonitor: { runChecks: vi.fn(async () => []) },
        router: { send: vi.fn(), pollInbox: vi.fn(() => []) },
        senseManager: { stopAll: vi.fn(async () => undefined), listSenseRows: vi.fn(() => []) },
      } as any)

      await daemon.stop()
      expect(shutdownSpy).toHaveBeenCalledOnce()

      vi.doUnmock("../../repertoire/mcp-manager")
    })
  })

  describe("getSharedMcpManager singleton", () => {
    it("creates manager when mcpServers configured and shutdown cleans up", async () => {
      vi.resetModules()

      const mockConnect = vi.fn().mockResolvedValue(undefined)
      const mockListTools = vi.fn().mockResolvedValue([])
      const mockShutdown = vi.fn()
      const mockOnClose = vi.fn()

      // Must use a real class/function for `new McpClient()` to work
      vi.doMock("../../repertoire/mcp-client", () => ({
        McpClient: class MockMcpClient {
          connect = mockConnect
          listTools = mockListTools
          callTool = vi.fn()
          shutdown = mockShutdown
          isConnected = vi.fn(() => true)
          onClose = mockOnClose
        },
      }))

      vi.doMock("../../heart/identity", () => ({
        loadAgentConfig: () => ({
          mcpServers: { calc: { command: "echo", args: ["test"] } },
        }),
        getAgentRoot: () => "/tmp/test",
        getAgentName: () => "test",
      }))

      // Now import — picks up mocks
      const mod = await import("../../repertoire/mcp-manager")

      const manager = await mod.getSharedMcpManager()
      expect(manager).not.toBeNull()
      expect(mockConnect).toHaveBeenCalledOnce()

      // Verify shutdown cleans up
      mod.shutdownSharedMcpManager()
      expect(mockShutdown).toHaveBeenCalledOnce()

      // Second shutdown is a no-op
      mod.shutdownSharedMcpManager()
      expect(mockShutdown).toHaveBeenCalledOnce()

      mod.resetSharedMcpManager()
      vi.doUnmock("../../repertoire/mcp-client")
      vi.doUnmock("../../heart/identity")
    })
  })

  describe("getSharedMcpManager error path", () => {
    it("returns null and logs when loadAgentConfig throws", async () => {
      vi.resetModules()

      vi.doMock("../../repertoire/mcp-client", () => ({
        McpClient: class MockMcpClient {},
      }))

      vi.doMock("../../heart/identity", () => ({
        loadAgentConfig: () => { throw new Error("no agent root") },
        getAgentRoot: () => { throw new Error("no agent root") },
        getAgentName: () => "test",
      }))

      const mod = await import("../../repertoire/mcp-manager")
      const manager = await mod.getSharedMcpManager()
      expect(manager).toBeNull()

      mod.resetSharedMcpManager()
      vi.doUnmock("../../repertoire/mcp-client")
      vi.doUnmock("../../heart/identity")
    })

    it("returns cached manager on second call", async () => {
      vi.resetModules()

      vi.doMock("../../repertoire/mcp-client", () => ({
        McpClient: class MockMcpClient {
          connect = vi.fn().mockResolvedValue(undefined)
          listTools = vi.fn().mockResolvedValue([])
          callTool = vi.fn()
          shutdown = vi.fn()
          isConnected = vi.fn(() => true)
          onClose = vi.fn()
        },
      }))

      vi.doMock("../../heart/identity", () => ({
        loadAgentConfig: () => ({
          mcpServers: { calc: { command: "echo", args: ["test"] } },
        }),
        getAgentRoot: () => "/tmp/test",
        getAgentName: () => "test",
      }))

      const mod = await import("../../repertoire/mcp-manager")
      const first = await mod.getSharedMcpManager()
      const second = await mod.getSharedMcpManager()
      expect(first).toBe(second)

      mod.resetSharedMcpManager()
      vi.doUnmock("../../repertoire/mcp-client")
      vi.doUnmock("../../heart/identity")
    })
  })

  describe("CLI routes mcp commands through daemon socket", () => {
    it("mcp list goes through sendCommand, not local mcpManager", async () => {
      const { runOuroCli } = await import("../../heart/daemon/daemon-cli")

      const sendCommand = vi.fn().mockResolvedValue({
        ok: true,
        data: [
          { server: "ado", tools: [{ name: "get_items", description: "Get items" }] },
        ],
      })

      const deps = {
        socketPath: "/tmp/test.sock",
        sendCommand,
        startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
        writeStdout: vi.fn(),
        checkSocketAlive: vi.fn().mockResolvedValue(true),
        cleanupStaleSocket: vi.fn(),
        fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
      }

      const result = await runOuroCli(["mcp", "list"], deps)
      expect(sendCommand).toHaveBeenCalledWith("/tmp/test.sock", { kind: "mcp.list" })
      expect(result).toContain("ado")
    })

    it("mcp call goes through sendCommand, not local mcpManager", async () => {
      const { runOuroCli } = await import("../../heart/daemon/daemon-cli")

      const sendCommand = vi.fn().mockResolvedValue({
        ok: true,
        data: { content: [{ type: "text", text: "result" }] },
      })

      const deps = {
        socketPath: "/tmp/test.sock",
        sendCommand,
        startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
        writeStdout: vi.fn(),
        checkSocketAlive: vi.fn().mockResolvedValue(true),
        cleanupStaleSocket: vi.fn(),
        fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
      }

      const result = await runOuroCli(["mcp", "call", "ado", "get_items", "--args", '{"query":"test"}'], deps)
      expect(sendCommand).toHaveBeenCalledWith("/tmp/test.sock", {
        kind: "mcp.call",
        server: "ado",
        tool: "get_items",
        args: '{"query":"test"}',
      })
      expect(result).toContain("result")
    })
  })
})
