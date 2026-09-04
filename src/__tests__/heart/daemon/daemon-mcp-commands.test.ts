import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import * as os from "os"
import * as path from "path"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function deferred<T = void>() {
  return Promise.withResolvers<T>()
}

describe("daemon mcp command handlers", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock("../../../repertoire/mcp-manager")
    vi.doUnmock("../../../senses/shared-turn")
  })

  function makeDaemonOptions(socketPath: string) {
    return {
      socketPath,
      processManager: {
        listAgentSnapshots: vi.fn(() => []),
        startAutoStartAgents: vi.fn(async () => undefined),
        stopAll: vi.fn(async () => undefined),
        startAgent: vi.fn(async () => undefined),
        sendToAgent: vi.fn(),
      },
      scheduler: {
        listJobs: vi.fn(() => []),
        triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
        reconcile: vi.fn(async () => undefined),
      },
      healthMonitor: {
        runChecks: vi.fn(async () => []),
      },
      router: {
        send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
        pollInbox: vi.fn(() => []),
      },
      senseManager: {
        startAutoStartSenses: vi.fn(async () => undefined),
        stopAll: vi.fn(async () => undefined),
        listSenseRows: vi.fn(() => []),
      },
    }
  }

  it("mcp.list returns tool data from the shared MCP manager", async () => {
    const mockManager = {
      listAllTools: vi.fn().mockReturnValue([
        {
          server: "ado",
          tools: [
            { name: "get_items", description: "Get work items", inputSchema: { type: "object" } },
          ],
        },
      ]),
    }

    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn().mockResolvedValue(mockManager),
      shutdownSharedMcpManager: vi.fn(),
    }))

    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-mcp-list")
    const daemon = new OuroDaemon(makeDaemonOptions(socketPath) as any)

    const result = await daemon.handleCommand({ kind: "mcp.list" } as any)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual([
      {
        server: "ado",
        tools: [
          { name: "get_items", description: "Get work items", inputSchema: { type: "object" } },
        ],
      },
    ])
  })

  it("mcp.list returns empty data when no manager available", async () => {
    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn().mockResolvedValue(null),
      shutdownSharedMcpManager: vi.fn(),
    }))

    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-mcp-list-none")
    const daemon = new OuroDaemon(makeDaemonOptions(socketPath) as any)

    const result = await daemon.handleCommand({ kind: "mcp.list" } as any)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual([])
    expect(result.message).toContain("no MCP servers configured")
  })

  it("mcp.call invokes tool via shared MCP manager", async () => {
    const mockManager = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "call result" }],
      }),
    }

    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn().mockResolvedValue(mockManager),
      shutdownSharedMcpManager: vi.fn(),
    }))

    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-mcp-call")
    const daemon = new OuroDaemon(makeDaemonOptions(socketPath) as any)

    const result = await daemon.handleCommand({
      kind: "mcp.call",
      server: "ado",
      tool: "get_items",
      args: '{"query":"test"}',
    } as any)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      content: [{ type: "text", text: "call result" }],
    })
    expect(mockManager.callTool).toHaveBeenCalledWith("ado", "get_items", { query: "test" })
  })

  it("mcp.call returns error when no manager available", async () => {
    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn().mockResolvedValue(null),
      shutdownSharedMcpManager: vi.fn(),
    }))

    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-mcp-call-none")
    const daemon = new OuroDaemon(makeDaemonOptions(socketPath) as any)

    const result = await daemon.handleCommand({
      kind: "mcp.call",
      server: "ado",
      tool: "get_items",
    } as any)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no MCP servers configured")
  })

  it("mcp.call without args passes empty object", async () => {
    const mockManager = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "no args result" }],
      }),
    }

    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn().mockResolvedValue(mockManager),
      shutdownSharedMcpManager: vi.fn(),
    }))

    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-mcp-call-noargs")
    const daemon = new OuroDaemon(makeDaemonOptions(socketPath) as any)

    const result = await daemon.handleCommand({
      kind: "mcp.call",
      server: "ado",
      tool: "get_items",
    } as any)
    expect(result.ok).toBe(true)
    expect(mockManager.callTool).toHaveBeenCalledWith("ado", "get_items", {})
  })

  it("mcp.call propagates tool errors", async () => {
    const mockManager = {
      callTool: vi.fn().mockRejectedValue(new Error("Server 'ado' is disconnected")),
    }

    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn().mockResolvedValue(mockManager),
      shutdownSharedMcpManager: vi.fn(),
    }))

    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const socketPath = tmpSocketPath("daemon-mcp-call-error")
    const daemon = new OuroDaemon(makeDaemonOptions(socketPath) as any)

    const result = await daemon.handleCommand({
      kind: "mcp.call",
      server: "ado",
      tool: "get_items",
    } as any)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("disconnected")
  })

  it("serializes MCP reconciliation against another agent turn", async () => {
    const managerEntered = deferred()
    const releaseManager = deferred()
    const turnEntered = deferred()
    const runSenseTurn = vi.fn(async () => {
      turnEntered.resolve()
      return {
        response: "ok",
        ponderDeferred: false,
        deliveries: [],
        deliveryFailures: [],
        turnOutcome: "settled" as const,
      }
    })
    vi.doMock("../../../repertoire/mcp-manager", () => ({
      getSharedMcpManager: vi.fn(async () => {
        managerEntered.resolve()
        await releaseManager.promise
        return { listAllTools: vi.fn().mockReturnValue([]) }
      }),
      shutdownSharedMcpManager: vi.fn(),
    }))
    vi.doMock("../../../senses/shared-turn", () => ({ runSenseTurn }))

    const { OuroDaemon, handleAgentSenseTurn } = await import("../../../heart/daemon/daemon")
    const daemon = new OuroDaemon(makeDaemonOptions(tmpSocketPath("daemon-mcp-turn-serialization")) as any)
    const listing = daemon.handleCommand({ kind: "mcp.list", agent: "first-agent" } as any)
    await managerEntered.promise

    const turn = handleAgentSenseTurn({
      kind: "agent.senseTurn",
      agent: "second-agent",
      friendId: "friend-1",
      channel: "mcp",
      sessionKey: "session-1",
      message: "hello",
    })
    const overlapped = await Promise.race([
      turnEntered.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ])
    expect(overlapped).toBe(false)

    releaseManager.resolve()
    await Promise.all([listing, turn])
    expect(runSenseTurn).toHaveBeenCalledOnce()
  })
})
