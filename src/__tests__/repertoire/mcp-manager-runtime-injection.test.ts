import { describe, it, expect, vi, afterEach } from "vitest"

/**
 * Workbench runtime-injection: per-turn, per-agent MCP override.
 *
 * The daemon is ONE process for ALL agents on the machine, and the MCP manager
 * is a process-wide singleton that reconcile()s from disk each turn. The runtime
 * Workbench MCP (`ouro_workbench`) is threaded as per-turn PARAMETER data from
 * the senseTurn command into getSharedMcpManager({ runtimeServers }) — NEVER as
 * module-global state.
 *
 * The load-bearing property under test (the no-leak isolation invariant):
 *  (a) a turn that carries runtimeServers → ouro_workbench IS connected for that turn;
 *  (b) a subsequent turn WITHOUT runtimeServers → ouro_workbench is torn down and
 *      is NOT present — it cannot leak into a different agent's concurrent turn.
 */

const WORKBENCH_RUNTIME = {
  ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] as string[] },
}

function mockManagerDeps(): { connects: string[]; shutdowns: string[] } {
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
    // No ouro_workbench in agent.json — the boss receives it ONLY at runtime.
    loadAgentConfig: () => ({ mcpServers: { calc: { command: "builtin-calc", args: [] } } }),
    getAgentRoot: () => "/tmp/agent",
    getAgentName: () => "test",
  }))
  vi.doMock("../../repertoire/plugin-mcp", () => ({
    listPluginMcpServers: () => [],
    pluginMcpServerToConfig: (s: any) => ({ command: s.command, args: s.args }),
  }))
  return { connects, shutdowns }
}

describe("getSharedMcpManager + runtime Workbench MCP injection", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
    vi.doUnmock("../../repertoire/credential-access")
  })

  it("connects ouro_workbench for a turn that carries runtimeServers", async () => {
    vi.resetModules()
    const { connects } = mockManagerDeps()

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(manager).not.toBeNull()

    // Both the builtin server and the runtime-injected Workbench MCP are live.
    expect(connects.sort()).toEqual(["/Apps/OuroWorkbenchMCP", "builtin-calc"])
    const servers = manager!.listAllTools().map((e) => e.server).sort()
    expect(servers).toEqual(["calc", "ouro_workbench"])

    mod.resetSharedMcpManager()
  })

  it("runtime server takes highest precedence over a colliding builtin", async () => {
    vi.resetModules()
    const connects: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => { connects.push(this.config.command) }
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../heart/identity", () => ({
      // A stale agent.json entry for ouro_workbench must lose to the runtime path.
      loadAgentConfig: () => ({
        mcpServers: { ouro_workbench: { command: "stale-disk-path", args: [] } },
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [],
      pluginMcpServerToConfig: (s: any) => ({ command: s.command }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(manager).not.toBeNull()
    // Only the runtime command is spawned; the stale disk path is overridden.
    expect(connects).toEqual(["/Apps/OuroWorkbenchMCP"])

    mod.resetSharedMcpManager()
  })

  it("reconnects an existing stale builtin when a runtime override arrives later", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const connects: string[] = []
    const shutdowns: string[] = []
    const closeHandlers: Array<() => void> = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      isConnected = vi.fn(() => true)
      private closeHandler: () => void = () => undefined
      onClose = vi.fn((handler: () => void) => {
        this.closeHandler = handler
        closeHandlers.push(handler)
      })
      constructor(public config: { command: string }) {
        this.connect = async () => { connects.push(this.config.command) }
      }
      shutdown(): void {
        shutdowns.push(this.config.command)
        queueMicrotask(() => this.closeHandler())
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        mcpServers: { ouro_workbench: { command: "stale-disk-path", args: ["--unsafe"] } },
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [],
      pluginMcpServerToConfig: (server: any) => ({ command: server.command }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    await mod.getSharedMcpManager()
    closeHandlers[0]?.()
    await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    await vi.runAllTimersAsync()

    expect(connects).toEqual(["stale-disk-path", "/Apps/OuroWorkbenchMCP"])
    expect(shutdowns).toEqual(["stale-disk-path"])

    mod.resetSharedMcpManager()
  })

  it("reconnects identical server configs when the owning agent changes", async () => {
    vi.resetModules()
    const connects: string[] = []
    const shutdowns: string[] = []
    let agentName = "agent-a"
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      shutdown: () => void
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        const owner = agentName
        this.connect = async () => { connects.push(`${owner}:${this.config.command}`) }
        this.shutdown = () => { shutdowns.push(`${owner}:${this.config.command}`) }
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        mcpServers: { shared: { command: "same-command", env: { TOKEN: "vault:service/token" } } },
      }),
      getAgentRoot: () => `/tmp/${agentName}`,
      getAgentName: () => agentName,
    }))
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [],
      pluginMcpServerToConfig: (server: any) => ({ command: server.command }),
    }))
    vi.doMock("../../repertoire/credential-access", () => ({
      getCredentialStore: () => ({
        getRawSecret: async () => `${agentName}-secret`,
      }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    await mod.getSharedMcpManager()
    agentName = "agent-b"
    await mod.getSharedMcpManager()

    expect(connects).toEqual(["agent-a:same-command", "agent-b:same-command"])
    expect(shutdowns).toEqual(["agent-a:same-command"])

    mod.resetSharedMcpManager()
  })

  it("runtime server overrides a colliding PLUGIN server and surfaces un-namespaced", async () => {
    vi.resetModules()
    const connects: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => { connects.push(this.config.command) }
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({}),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))
    // A plugin declares an `ouro_workbench` server — the runtime override must win
    // and the surfaced tool must NOT be plugin-namespaced (pluginId cleared).
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [
        { pluginId: "someplugin", serverName: "ouro_workbench", command: "plugin-wb", args: [] },
      ],
      pluginMcpServerToConfig: (s: any) => ({ command: s.command, args: s.args }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(manager).not.toBeNull()
    // Runtime command wins over the plugin's command.
    expect(connects).toEqual(["/Apps/OuroWorkbenchMCP"])
    const entry = manager!.listAllTools().find((e) => e.server === "ouro_workbench")
    expect(entry).toBeTruthy()
    // pluginId cleared → surfaces as a builtin-style (un-namespaced) tool.
    expect((entry as { pluginId?: string }).pluginId).toBeUndefined()

    mod.resetSharedMcpManager()
  })

  // ── THE load-bearing isolation / no-leak test ──
  it("does NOT leak ouro_workbench into a subsequent turn that omits runtimeServers", async () => {
    vi.resetModules()
    const { connects, shutdowns } = mockManagerDeps()

    const mod = await import("../../repertoire/mcp-manager")

    // Turn 1 — agent A carries runtimeServers → ouro_workbench connected.
    const turnA = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(turnA).not.toBeNull()
    expect(turnA!.listAllTools().map((e) => e.server).sort()).toEqual(["calc", "ouro_workbench"])
    expect(connects.sort()).toEqual(["/Apps/OuroWorkbenchMCP", "builtin-calc"])

    // Turn 2 — agent B's turn (same daemon, same singleton) WITHOUT runtimeServers.
    // The runtime server must be torn down and absent: no cross-agent leak.
    const turnB = await mod.getSharedMcpManager()
    expect(turnB).toBe(turnA) // same process-wide singleton
    const turnBServers = turnB!.listAllTools().map((e) => e.server).sort()
    expect(turnBServers).toEqual(["calc"]) // ASSERTION: ouro_workbench is GONE for agent B
    expect(turnBServers).not.toContain("ouro_workbench")
    expect(shutdowns).toEqual(["/Apps/OuroWorkbenchMCP"]) // explicitly torn down

    mod.resetSharedMcpManager()
  })

  it("releases runtime-only servers when the frontend turn ends", async () => {
    vi.resetModules()
    const { shutdowns } = mockManagerDeps()
    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })

    await mod.releaseRuntimeMcpServers()

    expect(manager!.listAllTools().map((entry) => entry.server)).toEqual(["calc"])
    expect(shutdowns).toEqual(["/Apps/OuroWorkbenchMCP"])
    mod.resetSharedMcpManager()
  })

  it("re-injects ouro_workbench on a later turn that carries runtimeServers again (stable per-turn)", async () => {
    vi.resetModules()
    const { shutdowns } = mockManagerDeps()

    const mod = await import("../../repertoire/mcp-manager")

    // Turn 1 with runtime → present.
    const t1 = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(t1!.listAllTools().map((e) => e.server).sort()).toEqual(["calc", "ouro_workbench"])

    // Turn 2 without runtime → gone.
    await mod.getSharedMcpManager()
    expect(shutdowns).toEqual(["/Apps/OuroWorkbenchMCP"])

    // Turn 3 with runtime again → re-connected (boss sends the flag every turn).
    const t3 = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(t3!.listAllTools().map((e) => e.server).sort()).toEqual(["calc", "ouro_workbench"])

    mod.resetSharedMcpManager()
  })

  it("reconcile fails closed when merged configuration cannot be rebuilt", async () => {
    vi.resetModules()
    const connects: string[] = []
    const McpClientMock = class {
      connect: () => Promise<void>
      listTools = async () => []
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {
        this.connect = async () => { connects.push(this.config.command) }
      }
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({ mcpServers: { calc: { command: "builtin-calc", args: [] } } }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))
    // First merge succeeds; the second throws and must tear down stale clients.
    let calls = 0
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => {
        calls += 1
        if (calls > 1) throw new Error("plugin scan blew up during reconcile")
        return []
      },
      pluginMcpServerToConfig: (s: any) => ({ command: s.command }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(manager).not.toBeNull()
    expect(connects.sort()).toEqual(["/Apps/OuroWorkbenchMCP", "builtin-calc"])

    await expect(mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })).resolves.toBeNull()
    expect(manager!.listAllTools()).toEqual([])

    mod.resetSharedMcpManager()
  })

  it("reconcile fails closed for a non-Error configuration failure", async () => {
    vi.resetModules()
    const McpClientMock = class {
      connect = async () => {}
      listTools = async () => []
      callTool = vi.fn()
      shutdown = vi.fn()
      isConnected = vi.fn(() => true)
      onClose = vi.fn()
      constructor(public config: { command: string }) {}
    }
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: McpClientMock,
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({ mcpServers: { calc: { command: "builtin-calc", args: [] } } }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))
    let calls = 0
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => {
        calls += 1
        // Throw a NON-Error value on reconcile to exercise the String(error) branch.
        if (calls > 1) throw "plugin scan failed (string)"
        return []
      },
      pluginMcpServerToConfig: (s: any) => ({ command: s.command }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const manager = await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(manager).not.toBeNull()
    await expect(mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })).resolves.toBeNull()
    expect(manager!.listAllTools()).toEqual([])

    mod.resetSharedMcpManager()
  })

  it("repeated turns that both carry runtimeServers keep ouro_workbench stable (no churn)", async () => {
    vi.resetModules()
    const { connects, shutdowns } = mockManagerDeps()

    const mod = await import("../../repertoire/mcp-manager")

    await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(connects.sort()).toEqual(["/Apps/OuroWorkbenchMCP", "builtin-calc"])

    // Second turn ALSO carries runtime — the server must NOT be torn down and
    // re-created (no per-turn churn for the same agent).
    await mod.getSharedMcpManager({ runtimeServers: WORKBENCH_RUNTIME })
    expect(shutdowns).toEqual([]) // no churn
    // No duplicate reconnect of the runtime server.
    expect(connects.filter((c) => c === "/Apps/OuroWorkbenchMCP")).toEqual(["/Apps/OuroWorkbenchMCP"])

    mod.resetSharedMcpManager()
  })
})
