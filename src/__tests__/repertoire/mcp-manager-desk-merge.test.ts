import { afterEach, describe, expect, it, vi } from "vitest"

const OWNER = Object.freeze({ agentName: "test", agentRoot: "/tmp/agent" })

const events: Array<{ event: string; meta?: Record<string, unknown> }> = []

describe("getSharedMcpManager + the built-in Desk", () => {
  afterEach(() => {
    vi.doUnmock("../../repertoire/mcp-client")
    vi.doUnmock("../../heart/identity")
    vi.doUnmock("../../repertoire/plugin-mcp")
    vi.doUnmock("../../repertoire/desk-mcp")
    vi.doUnmock("../../nerves/runtime")
    events.length = 0
  })

  it("serves every desk the agent looks after, ahead of servers that reuse a desk's name", async () => {
    vi.resetModules()
    const connected: string[] = []
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: class {
        listTools = async () => []
        callTool = vi.fn()
        shutdown = vi.fn()
        isConnected = vi.fn(() => true)
        onClose = vi.fn()
        constructor(public config: { command: string }) {}
        connect = async () => { connected.push(this.config.command) }
      },
      isMcpTransportError: () => false,
    }))
    vi.doMock("../../nerves/runtime", async () => {
      const actual = await vi.importActual<typeof import("../../nerves/runtime")>("../../nerves/runtime")
      return {
        ...actual,
        emitNervesEvent: (event: Parameters<typeof actual.emitNervesEvent>[0]) => {
          events.push(event)
          actual.emitNervesEvent(event)
        },
      }
    })
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: () => ({
        desks: { ari: "~/desk" },
        mcpServers: { desk: { command: "bundle-desk" }, calc: { command: "calc" } },
      }),
      getAgentRoot: () => "/tmp/agent",
      getAgentName: () => "test",
    }))
    const listDeskMcpServers = vi.fn(() => ({
      desk: { command: "own-desk" },
      "desk-ari": { command: "ari-desk" },
    }))
    vi.doMock("../../repertoire/desk-mcp", () => ({ listDeskMcpServers }))
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: () => [{ pluginId: "desk", serverName: "desk-ari", command: "plugin-desk" }],
      pluginMcpServerToConfig: (server: { command: string }) => ({ command: server.command }),
    }))

    const mod = await import("../../repertoire/mcp-manager")
    const runtimeServers = { desk: { command: "runtime-desk" } }
    const manager = await mod.getSharedMcpManager({ ...OWNER, runtimeServers })

    expect(listDeskMcpServers).toHaveBeenCalledWith(expect.objectContaining(OWNER), expect.objectContaining({ desks: { ari: "~/desk" } }))
    expect(connected.sort()).toEqual(["ari-desk", "calc", "own-desk"])
    expect(manager!.entries.filter((entry) => entry.source === "desk").map((entry) => [entry.server, entry.pluginId]).sort()).toEqual([["desk", "desk"], ["desk-ari", "desk"]])
    expect(events.filter((event) => event.event === "mcp.server_name_reserved").map((event) => event.meta)).toEqual([
      { server: "desk-ari", declaredBy: "plugin desk" },
      { server: "desk", declaredBy: "agent.json mcpServers" },
      { server: "desk", declaredBy: "a runtime server" },
    ])

    await mod.resetSharedMcpManager()
  })
})
