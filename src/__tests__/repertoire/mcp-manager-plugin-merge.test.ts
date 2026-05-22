import { describe, it, expect, vi, afterEach } from "vitest"

/**
 * W6 Unit 9 wiring tests: getSharedMcpManager() merges plugin-declared MCP
 * servers (from each enabled plugin's `.mcp.json`) into the same start() call
 * it already runs for `agent.json` mcpServers.
 *
 * Coverage targets:
 *  - merged set spawns both builtin + plugin servers
 *  - plugin-only (no builtin) still yields a manager
 *  - plugin server tools surface with `mcp__<server>__<tool>` naming via
 *    listAllTools()'s `pluginId` flag
 */

describe("getSharedMcpManager + plugin .mcp.json merge", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts both builtin + plugin servers in one McpManager", async () => {
    vi.resetModules()

    const connectCalls: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools: () => Promise<unknown[]>
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => {
          connectCalls.push(this.config.command)
        }
        this.listTools = async () => []
      }
    }

    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))

    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        mcpServers: { calc: { command: "echo-calc", args: [] } },
        plugins: [{ id: "desk", enabled: true }],
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))

    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [
        {
          pluginId: "desk",
          serverName: "desk",
          command: "echo-desk",
          args: ["./mcp.js", "--root", "/tmp/agent/desk"],
          env: {},
          cwd: "/mock/plugins/desk",
        },
      ],
      pluginMcpServerToConfig: (s: any) => ({
        command: s.command,
        args: s.args,
        env: s.env,
        cwd: s.cwd,
      }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager()
    expect(manager).not.toBeNull()
    // Both servers connected
    expect(connectCalls.sort()).toEqual(["echo-calc", "echo-desk"])

    // Plugin server tools surface with the pluginId attribution
    const all = manager!.listAllTools()
    const deskEntry = all.find((e) => e.server === "desk")
    expect(deskEntry).toBeTruthy()
    expect((deskEntry as { pluginId?: string }).pluginId).toBe("desk")

    const calcEntry = all.find((e) => e.server === "calc")
    expect((calcEntry as { pluginId?: string }).pluginId).toBeUndefined()

    mod.resetSharedMcpManager()
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
  })

  it("starts plugin servers when no builtin mcpServers are declared", async () => {
    vi.resetModules()

    const connectCalls: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => {
          connectCalls.push(this.config.command)
        }
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))

    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        plugins: [{ id: "desk", enabled: true }],
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))

    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [
        {
          pluginId: "desk",
          serverName: "desk",
          command: "node",
          args: ["./mcp.js"],
          env: {},
          cwd: "/mock/plugins/desk",
        },
      ],
      pluginMcpServerToConfig: (s: any) => ({
        command: s.command,
        args: s.args,
        env: s.env,
        cwd: s.cwd,
      }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager()
    expect(manager).not.toBeNull()
    expect(connectCalls).toEqual(["node"])

    mod.resetSharedMcpManager()
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
  })

  it("returns null when neither builtin nor plugin servers exist", async () => {
    vi.resetModules()

    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: class {},
      isMcpTransportError: () => false,
    }))

    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({ plugins: [] }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))

    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [],
      pluginMcpServerToConfig: (s: any) => ({ command: s.command }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager()
    expect(manager).toBeNull()

    mod.resetSharedMcpManager()
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
  })

  it("if plugin server-name collides with a builtin server, builtin wins (deterministic)", async () => {
    vi.resetModules()

    const connectCalls: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => {
          connectCalls.push(this.config.command)
        }
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))

    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        mcpServers: { desk: { command: "builtin-desk", args: [] } },
        plugins: [{ id: "desk", enabled: true }],
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))

    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [
        {
          pluginId: "desk",
          serverName: "desk",
          command: "plugin-desk",
          args: [],
          env: {},
          cwd: "/mock/plugins/desk",
        },
      ],
      pluginMcpServerToConfig: (s: any) => ({
        command: s.command,
        args: s.args,
        env: s.env,
        cwd: s.cwd,
      }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager()
    expect(manager).not.toBeNull()
    // Only one server connected — the builtin
    expect(connectCalls).toEqual(["builtin-desk"])

    mod.resetSharedMcpManager()
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
  })

  // ──── regression: alpha.635 fix — reconcile() must keep plugin servers ────
  it("plugin servers survive across reconcile() — second getSharedMcpManager() call keeps them", async () => {
    // Bug pre-fix: getSharedMcpManager() returns existing manager + calls
    // reconcile(). Reconcile read ONLY builtin servers from agent.json, treating
    // plugin servers as "removed" and tearing them down. After ONE turn the
    // mcp__desk__* tools would be gone.
    vi.resetModules()

    const connects: string[] = []
    const shutdowns: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools: () => Promise<unknown[]>
      callTool = vi.fn()
      shutdown: () => void
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => { connects.push(this.config.command) }
        this.listTools = async () => []
        this.shutdown = () => { shutdowns.push(this.config.command) }
      }
    }

    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))

    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        mcpServers: { calc: { command: "builtin-calc", args: [] } },
        plugins: [{ id: "desk", enabled: true }],
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))

    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [
        {
          pluginId: "desk",
          serverName: "desk",
          command: "plugin-desk",
          args: ["./mcp.js"],
          env: {},
          cwd: "/mock/plugins/desk",
        },
      ],
      pluginMcpServerToConfig: (s: any) => ({
        command: s.command,
        args: s.args,
        env: s.env,
        cwd: s.cwd,
      }),
    }))

    const mod = await import("../../repertoire/mcp-manager")

    // First call: start() — both servers connect
    const manager1 = await mod.getSharedMcpManager()
    expect(manager1).not.toBeNull()
    expect(connects.sort()).toEqual(["builtin-calc", "plugin-desk"])
    expect(shutdowns).toEqual([])
    expect(manager1!.listAllTools().map((e) => e.server).sort()).toEqual(["calc", "desk"])

    // Second call: cached manager → reconcile()
    // BUG would do: see only "calc" in desired (config.mcpServers), treat
    // "desk" as removed, shutdown the desk client.
    // FIX: reconcile() re-merges via buildMergedServerConfig() — both stay.
    const manager2 = await mod.getSharedMcpManager()
    expect(manager2).toBe(manager1) // same singleton
    expect(shutdowns).toEqual([]) // desk was NOT torn down
    expect(manager2!.listAllTools().map((e) => e.server).sort()).toEqual(["calc", "desk"])

    // Third call for good measure — same outcome
    await mod.getSharedMcpManager()
    expect(shutdowns).toEqual([])

    mod.resetSharedMcpManager()
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
  })
})
