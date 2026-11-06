import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { McpServerConfig } from "../../heart/identity"
import type { McpToolInfo } from "../../repertoire/mcp-client"
import type { PluginMcpServer } from "../../repertoire/plugin-mcp"

const A = Object.freeze({ agentName: "agent-a", agentRoot: "/bundles/agent-a.ouro" })
const B = Object.freeze({ agentName: "agent-b", agentRoot: "/bundles/agent-b.ouro" })
type Owner = Readonly<{ agentName: string; agentRoot: string }>
const ownerKey = (owner: Owner) => JSON.stringify([owner.agentName, owner.agentRoot])
const STATUS: McpToolInfo = {
  name: "status",
  description: "Read status",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
}

function plugin(pluginId = "desk"): PluginMcpServer {
  return { pluginId, serverName: "shared", command: "same-command", args: [], env: {}, cwd: "/plugins/shared" }
}

describe("owned MCP lifecycle", () => {
  let mod: typeof import("../../repertoire/mcp-manager")
  let asDefinitions: typeof import("../../repertoire/mcp-tools").mcpToolsAsDefinitions
  let configs: Map<string, Record<string, McpServerConfig>>
  let plugins: Map<string, PluginMcpServer[]>
  let configFailure: Owner | undefined
  let clients: TestClient[]
  let clientSetup: (client: TestClient, index: number) => void
  let configRead: ReturnType<typeof vi.fn>
  let pluginRead: ReturnType<typeof vi.fn>
  let vaultRead: ReturnType<typeof vi.fn>
  let ambientName: ReturnType<typeof vi.fn>
  let ambientRoot: ReturnType<typeof vi.fn>
  let events: Array<Record<string, unknown>>

  class TestClient {
    connected = false
    tools = structuredClone([STATUS])
    close: () => void = () => undefined
    connect = vi.fn(async () => { this.connected = true })
    listTools = vi.fn(async () => this.tools)
    refreshTools = vi.fn(async () => this.tools)
    callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      content: [{ type: "text", text: "owned result" }],
    }))
    shutdown = vi.fn(() => { this.connected = false })
    isConnected = vi.fn(() => this.connected)
    onClose = vi.fn((callback: () => void) => { this.close = callback })

    constructor(readonly config: McpServerConfig) {
      clients.push(this)
      clientSetup(this, clients.length - 1)
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    configs = new Map([
      [ownerKey(A), { shared: { command: "same-command" } }],
      [ownerKey(B), { shared: { command: "same-command" } }],
    ])
    plugins = new Map()
    clients = []
    events = []
    configFailure = undefined
    clientSetup = () => undefined
    configRead = vi.fn((owner: Owner = B) => {
      if (configFailure && ownerKey(owner) === ownerKey(configFailure)) throw new Error("config unavailable")
      return { mcpServers: configs.get(ownerKey(owner)) ?? {} }
    })
    pluginRead = vi.fn((_home?: string, owner: Owner = B) => plugins.get(ownerKey(owner)) ?? [])
    vaultRead = vi.fn((name: string) => ({
      getRawSecret: vi.fn(async () => `${name}-private-token`),
    }))
    ambientName = vi.fn(() => B.agentName)
    ambientRoot = vi.fn(() => B.agentRoot)
    vi.doMock("../../heart/identity", () => ({
      loadAgentConfig: configRead,
      getAgentName: ambientName,
      getAgentRoot: ambientRoot,
    }))
    vi.doMock("../../repertoire/plugin-mcp", () => ({
      listPluginMcpServers: pluginRead,
      pluginMcpServerToConfig: (server: PluginMcpServer) => ({
        command: server.command, args: server.args, env: server.env, cwd: server.cwd,
      }),
    }))
    vi.doMock("../../repertoire/credential-access", () => ({ getCredentialStore: vaultRead }))
    vi.doMock("../../repertoire/mcp-client", () => ({
      McpClient: TestClient,
      isMcpTransportError: (error: unknown) => /transport|closed/i.test(String(error)),
    }))
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent: (event: Record<string, unknown>) => { events.push(event) },
    }))
    mod = await import("../../repertoire/mcp-manager")
    asDefinitions = (await import("../../repertoire/mcp-tools")).mcpToolsAsDefinitions
  })

  afterEach(async () => {
    await mod.shutdownSharedMcpManager()
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const dependency of [
      "../../heart/identity",
      "../../repertoire/plugin-mcp",
      "../../repertoire/credential-access",
      "../../repertoire/mcp-client",
      "../../nerves/runtime",
    ]) vi.doUnmock(dependency)
  })

  async function viewFor(owner: Owner = A, runtimeServers?: Record<string, McpServerConfig>) {
    const view = await mod.getSharedMcpManager({ ...owner, runtimeServers })
    expect(view?.owner).toEqual(owner)
    return view!
  }

  function context(owner: Owner = A) {
    return { ...owner, signin: async () => undefined }
  }

  it.each(["cold", "warm"] as const)("rejects ambiguous plugin discovery before connecting an arbitrary winner: %s", async (state) => {
    const b = await viewFor(B)
    const prior = state === "warm" ? await viewFor(A) : undefined
    const existingClients = clients.length
    configs.set(ownerKey(A), {})
    plugins.set(ownerKey(A), [plugin("first"), plugin("second")])
    await expect(mod.getSharedMcpManager(A)).resolves.toBeNull()
    expect(clients).toHaveLength(existingClients)
    expect(b.manager.listAllTools(A)).toEqual([])
    expect(b.manager.listAllTools(B)).toHaveLength(1)
    expect(clients[0].shutdown).not.toHaveBeenCalled()
    if (prior) {
      await expect(prior.manager.validateToolBinding(asDefinitions(prior)[0].mcpBinding!, A)).rejects.toThrow(/stale|changed|unavailable/i)
      expect(clients[1].shutdown).toHaveBeenCalledOnce()
    }
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "mcp.reconcile_error", meta: expect.objectContaining({ reason: expect.stringMatching(/collision|ambiguous|duplicate/i) }) })]))
  })

  it("validates current, foreign and removed bindings without invoking any client", async () => {
    const view = await viewFor(A)
    const binding = asDefinitions(view)[0].mcpBinding!
    await expect(view.manager.validateToolBinding(binding, A)).resolves.toBeUndefined()
    await expect(view.manager.validateToolBinding(binding, B)).rejects.toThrow(/stale|changed|unavailable/i)
    await expect(Reflect.apply(view.manager.validateToolBinding, view.manager, [binding, undefined])).rejects.toThrow(/owner/i)
    await view.manager.start(A, {})
    await expect(view.manager.validateToolBinding(binding, A)).rejects.toThrow(/stale|changed|unavailable/i)
    expect(clients[0].callTool).not.toHaveBeenCalled()
  })

  it("threads exact config, plugin and vault ownership despite ambient B and identical configs", async () => {
    const config = { shared: { command: "same-command", env: { TOKEN: "vault:service/token" } } }
    configs.set(ownerKey(A), config)
    configs.set(ownerKey(B), structuredClone(config))
    const a = await viewFor(A)
    const b = await viewFor(B)

    expect(a.manager).toBe(b.manager)
    expect(configRead.mock.calls).toEqual([[A], [B]])
    expect(pluginRead.mock.calls).toEqual([[undefined, A], [undefined, B]])
    expect(vaultRead.mock.calls).toEqual([[A.agentName], [B.agentName]])
    expect(clients.map((client) => client.config.env?.TOKEN)).toEqual([
      "agent-a-private-token", "agent-b-private-token",
    ])
    expect(clients[0].shutdown).not.toHaveBeenCalled()
    expect(a.entries[0].generation).not.toBe(b.entries[0].generation)
    expect(a.entries[0].configDigest).not.toBe(b.entries[0].configDigest)
    expect(ambientName).not.toHaveBeenCalled()
    expect(ambientRoot).not.toHaveBeenCalled()
    expect(JSON.stringify(events)).not.toContain("-private-token")
    expect(JSON.stringify(events)).not.toContain(A.agentRoot)
    expect(JSON.stringify(events)).not.toContain(a.entries[0].configDigest)
  })

  it("keeps different roots separate even when the agent name and server config are identical", async () => {
    const otherRoot = { ...A, agentRoot: "/relocated/agent-a.ouro" }
    configs.set(ownerKey(otherRoot), { shared: { command: "same-command" } })
    const a = await viewFor(A)
    const other = await viewFor(otherRoot)

    expect(clients).toHaveLength(2)
    expect(clients[0].shutdown).not.toHaveBeenCalled()
    expect(a.entries[0].configDigest).not.toBe(other.entries[0].configDigest)
    expect(a.entries[0].generation).not.toBe(other.entries[0].generation)
  })

  it("returns a frozen view from direct owned startup for explicitly bound calls", async () => {
    const manager = new mod.McpManager()
    try {
      const view = await manager.start(A, { shared: { command: "same-command" } })
      expect(view?.owner).toEqual(A)
      expect(Object.isFrozen(view)).toBe(true)
      const definition = asDefinitions(view!)[0]
      expect(await definition.handler({}, context())).toBe("owned result")
    } finally {
      await manager.shutdown()
    }
  })

  it.each([
    undefined, null, false, {}, { agentName: A.agentName },
    { ...A, agentName: "" }, { ...A, agentName: 7 }, { ...A, agentRoot: 7 }, { ...A, agentRoot: "relative" },
  ])(
    "rejects missing or invalid owner coordinates without reading ambient config: %j",
    async (invalid) => {
      await expect(Reflect.apply(mod.getSharedMcpManager, undefined, [invalid])).resolves.toBeNull()
      expect(configRead).not.toHaveBeenCalled()
      expect(pluginRead).not.toHaveBeenCalled()
      expect(vaultRead).not.toHaveBeenCalled()
      expect(ambientName).not.toHaveBeenCalled()
      expect(ambientRoot).not.toHaveBeenCalled()
      expect(clients).toHaveLength(0)
    },
  )

  it.each(["success", "failure"] as const)("gives a cold waiter its own state after delayed A %s", async (outcome) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    clientSetup = (client, index) => {
      if (index !== 0) return
      client.connect.mockImplementation(async () => {
        entered.resolve()
        await release.promise
        if (outcome === "failure") throw new Error("connection failed")
        client.connected = true
      })
    }
    const pendingA = mod.getSharedMcpManager(A)
    await entered.promise
    const pendingB = mod.getSharedMcpManager(B)
    expect(clients).toHaveLength(1)
    release.resolve()
    const [a, b] = await Promise.all([pendingA, pendingB])

    expect(clients).toHaveLength(2)
    expect(a?.owner).toEqual(A)
    expect(b?.owner).toEqual(B)
    expect(a?.manager).toBe(b?.manager)
    expect(b?.entries[0].tools).toEqual([STATUS])
    expect(a?.entries[0].tools).toEqual(outcome === "success" ? [STATUS] : [])
  })

  it("does not clear B after A configuration failure or an empty A configuration", async () => {
    const b = await viewFor(B)
    const a = await viewFor(A)
    configFailure = A
    await expect(mod.getSharedMcpManager(A)).resolves.toBeNull()
    expect(clients[0].shutdown).not.toHaveBeenCalled()
    expect(clients[1].shutdown).toHaveBeenCalledOnce()
    configFailure = undefined
    configs.set(ownerKey(A), {})
    await expect(mod.getSharedMcpManager(A)).resolves.toBeNull()
    const bAgain = await viewFor(B)

    expect(bAgain.entries).toEqual(b.entries)
    expect(a.entries[0].tools).toEqual([STATUS])
    expect(clients).toHaveLength(2)
    expect(clients[0].shutdown).not.toHaveBeenCalled()
  })

  it("freezes nested schemas and metadata, but not the manager, for each caller", async () => {
    const first = await viewFor()
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.owner)).toBe(true)
    expect(Object.isFrozen(first.entries)).toBe(true)
    expect(Object.isFrozen(first.entries[0])).toBe(true)
    expect(Object.isFrozen(first.entries[0].tools)).toBe(true)
    expect(Object.isFrozen(first.entries[0].tools[0].inputSchema.properties)).toBe(true)
    expect(Object.isFrozen(first.manager)).toBe(false)
    const frozen = JSON.stringify(first.entries)
    clients[0].tools[0].description = "changed client-owned description"
    configs.set(ownerKey(A), { shared: { command: "replacement" } })
    const replacement = await viewFor()

    expect(JSON.stringify(first.entries)).toBe(frozen)
    expect(replacement.entries[0].generation).toBeGreaterThan(first.entries[0].generation)
    expect(replacement.entries[0].configDigest).not.toBe(first.entries[0].configDigest)
  })

  it("returns distinct frozen views without churning an unchanged owned server", async () => {
    const first = await viewFor()
    const second = await viewFor()

    expect(second).not.toBe(first)
    expect(second.manager).toBe(first.manager)
    expect(second.entries).toEqual(first.entries)
    expect(clients).toHaveLength(1)
    expect(clients[0].shutdown).not.toHaveBeenCalled()
  })

  it("preserves runtime > builtin > plugin precedence and changes generation when only the source changes", async () => {
    plugins.set(ownerKey(A), [plugin()])
    const builtin = await viewFor()
    const runtime = await viewFor(A, { shared: { command: "same-command" } })
    expect(builtin.entries[0].source).toBe("builtin")
    expect(runtime.entries[0].source).toBe("runtime")
    expect(runtime.entries[0].pluginId).toBeUndefined()
    expect(runtime.entries[0].generation).toBeGreaterThan(builtin.entries[0].generation)
    configs.set(ownerKey(A), {})
    const pluginView = await viewFor()
    expect(pluginView.entries[0]).toMatchObject({ source: "plugin", pluginId: "desk" })
    expect(asDefinitions(pluginView)[0].tool.function.name).toBe("mcp__shared__status")
    expect(pluginView.entries[0].configDigest).not.toBe(runtime.entries[0].configDigest)
  })

  it("changes logical identity when only a plugin's origin changes", async () => {
    configs.set(ownerKey(A), {})
    plugins.set(ownerKey(A), [plugin("first-plugin")])
    const first = await viewFor()
    plugins.set(ownerKey(A), [plugin("second-plugin")])
    const second = await viewFor()

    expect(second.entries[0].pluginId).toBe("second-plugin")
    expect(second.entries[0].generation).toBeGreaterThan(first.entries[0].generation)
    expect(second.entries[0].configDigest).not.toBe(first.entries[0].configDigest)
    expect(asDefinitions(second)[0].tool.function.name).toBe(asDefinitions(first)[0].tool.function.name)
  })

  it("keeps equivalent unresolved configuration stable across environment-key order", async () => {
    configs.set(ownerKey(A), { shared: { command: "same-command", env: { FIRST: "one", SECOND: "two" } } })
    const first = await viewFor()
    configs.set(ownerKey(A), { shared: { command: "same-command", args: [], env: { SECOND: "two", FIRST: "one" }, cwd: "" } })
    const second = await viewFor()

    expect(second.entries).toEqual(first.entries)
    expect(clients).toHaveLength(1)
  })

  it("releases only A's runtime servers and preserves B's current view and client", async () => {
    const runtime = { temporary: { command: "temporary" } }
    const a = await viewFor(A, runtime)
    const b = await viewFor(B, runtime)
    await mod.releaseRuntimeMcpServers(A)
    const aNow = await viewFor(A)
    const bNow = await viewFor(B, runtime)

    expect(aNow.entries.map((entry) => entry.server)).toEqual(["shared"])
    expect(bNow.entries).toEqual(b.entries)
    expect(a.entries.map((entry) => entry.server)).toEqual(["shared", "temporary"])
    expect(clients.map((client) => client.shutdown.mock.calls.length)).toEqual([0, 1, 0, 0])
  })

  it("retains B when A's runtime-release config read fails", async () => {
    await viewFor(A, { temporary: { command: "temporary" } })
    const b = await viewFor(B)
    configFailure = A
    await mod.releaseRuntimeMcpServers(A)
    expect(clients[0].shutdown).toHaveBeenCalledOnce()
    expect(clients[1].shutdown).toHaveBeenCalledOnce()
    expect(clients[2].shutdown).not.toHaveBeenCalled()
    expect((await viewFor(B)).entries).toEqual(b.entries)
  })

  it("binds definitions to exact private coordinates without exposing them in model schemas", async () => {
    const view = await viewFor()
    const definition = asDefinitions(view)[0]
    expect(definition.mcpBinding).toMatchObject({
      agentName: A.agentName,
      agentRoot: A.agentRoot,
      server: "shared",
      rawName: "status",
      surfacedName: "shared_status",
      source: "builtin",
      configDigest: view.entries[0].configDigest,
      generation: view.entries[0].generation,
      schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(definition.tool)).not.toContain(A.agentRoot)
    expect(JSON.stringify(definition.tool)).not.toContain(view.entries[0].configDigest)
    expect(await definition.handler({}, context())).toBe("owned result")
    expect(clients[0].callTool).toHaveBeenCalledExactlyOnceWith("status", {})
  })

  it.each([B, { ...A, agentRoot: B.agentRoot }, { ...B, agentRoot: A.agentRoot }])(
    "rejects a frozen definition invoked with either mismatched owner coordinate: %j",
    async (other) => {
      const view = await viewFor()
      const definition = asDefinitions(view)[0]
      await expect(definition.handler({}, context(other))).rejects.toThrow(/owner/i)
      expect(clients[0].callTool).not.toHaveBeenCalled()
    },
  )

  it.each(["config", "plugin", "schema", "raw-name", "removal"] as const)(
    "rejects stale %s binding before a client call",
    async (change) => {
      const first = await viewFor()
      const binding = asDefinitions(first)[0].mcpBinding!
      if (change === "config") configs.set(ownerKey(A), { shared: { command: "replacement" } })
      if (change === "plugin") {
        configs.set(ownerKey(A), {})
        plugins.set(ownerKey(A), [plugin()])
      }
      if (change === "removal") configs.set(ownerKey(A), {})
      if (change === "schema" || change === "raw-name") {
        clients[0].tools = [change === "schema"
          ? { ...STATUS, inputSchema: { type: "object", properties: { changed: { type: "boolean" } } } }
          : { ...STATUS, name: "renamed" }]
        await first.manager.runCanaries(A)
      } else {
        await mod.getSharedMcpManager(A)
      }
      await expect(first.manager.callTool(binding, {}, A)).rejects.toThrow(/stale|changed|unavailable/i)
      expect(clients.every((client) => client.callTool.mock.calls.length === 0)).toBe(true)
      expect((await viewFor(B)).owner).toEqual(B)
    },
  )

  it.each([
    { rawName: "other" },
    { surfacedName: "other_status" },
    { configDigest: "0".repeat(64) },
    { schemaDigest: "0".repeat(64) },
    { generation: -1 },
    { source: "runtime" as const },
    { pluginId: "unexpected-plugin" },
  ])("rejects a changed frozen coordinate before effects: %j", async (change) => {
    const view = await viewFor()
    const binding = asDefinitions(view)[0].mcpBinding!
    await expect(view.manager.callTool({ ...binding, ...change }, {}, A)).rejects.toThrow(/stale|changed|unavailable/i)
    expect(clients[0].callTool).not.toHaveBeenCalled()
  })

  it("rejects a binding on another manager even with identical owner/config/generation", async () => {
    const view = await viewFor()
    const stranger = new mod.McpManager()
    try {
      await stranger.start(A, { shared: { command: "same-command" } })
      await expect(stranger.callTool(asDefinitions(view)[0].mcpBinding!, {}, A)).rejects.toThrow(/stale|changed|manager/i)
      expect(clients.every((client) => client.callTool.mock.calls.length === 0)).toBe(true)
    } finally {
      await stranger.shutdown()
    }
  })

  it("rejects duplicate raw tools rather than choosing the first one", async () => {
    clientSetup = (client) => { client.tools = structuredClone([STATUS, STATUS]) }
    const view = await viewFor()
    await expect(view.manager.callTool(asDefinitions(view)[0].mcpBinding!, {}, A)).rejects.toThrow(/stale|unique|ambiguous/i)
    expect(clients[0].callTool).not.toHaveBeenCalled()
  })

  it("recovers the same plugin-owned logical generation before a call without changing its name", async () => {
    configs.set(ownerKey(A), {})
    plugins.set(ownerKey(A), [plugin()])
    const first = await viewFor()
    const definition = asDefinitions(first)[0]
    clients[0].connected = false

    expect(await definition.handler({}, context())).toBe("owned result")
    const recovered = await viewFor()
    expect(recovered.entries[0]).toMatchObject({
      source: "plugin", pluginId: "desk",
      generation: first.entries[0].generation, configDigest: first.entries[0].configDigest,
    })
    expect(asDefinitions(recovered)[0].tool.function.name).toBe("mcp__shared__status")
    expect(clients).toHaveLength(2)
    expect(clients[0].callTool).not.toHaveBeenCalled()
    expect(clients[1].callTool).toHaveBeenCalledExactlyOnceWith("status", {})
  })

  it("does not hold lifecycle work while an external tool result is pending", async () => {
    const first = await viewFor()
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<{ content: Array<{ type: string; text: string }> }>()
    clients[0].callTool.mockImplementation(async () => { entered.resolve(); return result.promise })
    const calling = first.manager.callTool(asDefinitions(first)[0].mcpBinding!, {}, A)
    await entered.promise
    let bReady = false
    const pendingB = viewFor(B).then((view) => { bReady = true; return view })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(bReady).toBe(true)
      expect((await pendingB).entries[0].tools).toEqual([STATUS])
    } finally {
      result.resolve({ content: [{ type: "text", text: "completed" }] })
    }
    await expect(calling).resolves.toEqual({ content: [{ type: "text", text: "completed" }] })
  })

  it("does not recover or retry a replaced client after its pending transport call fails", async () => {
    const first = await viewFor()
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<{ content: Array<{ type: string; text: string }> }>()
    clients[0].callTool.mockImplementation(async () => { entered.resolve(); return result.promise })
    const calling = first.manager.callTool(asDefinitions(first)[0].mcpBinding!, {}, A)
    const rejected = expect(calling).rejects.toThrow(/transport|changed|stale/i)
    await entered.promise
    configs.set(ownerKey(A), { shared: { command: "replacement" } })
    const replacement = await viewFor()
    result.reject(new Error("transport closed"))
    await rejected

    expect(clients).toHaveLength(2)
    expect(clients[1].callTool).not.toHaveBeenCalled()
    expect(clients[1].shutdown).not.toHaveBeenCalled()
    expect((await viewFor()).entries).toEqual(replacement.entries)
  })

  it.each(["recovered", "disconnected"] as const)("never replays a started call after transport failure even when its client is %s", async (recovery) => {
    const first = await viewFor()
    const failure = new Error("transport closed after the server may have acted")
    clients[0].callTool.mockRejectedValueOnce(failure)
    if (recovery === "disconnected") {
      clientSetup = (client) => { client.connect.mockRejectedValue(new Error("reconnect unavailable")) }
    }

    await expect(first.manager.callTool(asDefinitions(first)[0].mcpBinding!, {}, A)).rejects.toBe(failure)
    await viewFor()
    expect(clients).toHaveLength(2)
    expect(clients[0].callTool).toHaveBeenCalledOnce()
    expect(clients[1].callTool).not.toHaveBeenCalled()
    expect(clients[1].config).toEqual(clients[0].config)
  })

  it("fences stale close callbacks and timers from a replacement and from B", async () => {
    vi.useFakeTimers()
    const first = await viewFor()
    const old = clients[0]
    old.connected = false
    old.close()
    await Promise.resolve()
    configs.set(ownerKey(A), { shared: { command: "replacement" } })
    const replacement = await viewFor()
    const b = await viewFor(B)
    old.close()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(clients).toHaveLength(3)
    expect(clients[1].shutdown).not.toHaveBeenCalled()
    expect(clients[2].shutdown).not.toHaveBeenCalled()
    expect((await viewFor()).entries).toEqual(replacement.entries)
    expect((await viewFor(B)).entries).toEqual(b.entries)
    expect(first.entries[0].generation).not.toBe(replacement.entries[0].generation)
  })

  it("shuts down an in-flight cold connection without resurrecting it or its timers", async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    clientSetup = (client) => {
      client.connect.mockImplementation(async () => {
        entered.resolve()
        await release.promise
        client.connected = true
      })
    }
    const pending = mod.getSharedMcpManager(A)
    await entered.promise
    const shutdown = mod.shutdownSharedMcpManager()
    release.resolve()
    await Promise.all([pending, shutdown])
    clients[0].close()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(clients).toHaveLength(1)
    expect(clients[0].connected).toBe(false)
    expect(clients[0].shutdown).toHaveBeenCalled()
    clientSetup = () => undefined
    expect((await viewFor(B)).owner).toEqual(B)
  })

  it.each(["success", "failure"] as const)("does not let an old canary %s mutate a replacement", async (outcome) => {
    const first = await viewFor()
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<McpToolInfo[]>()
    clients[0].refreshTools.mockImplementation(async () => { entered.resolve(); return response.promise })
    const canary = first.manager.runCanaries(A)
    await entered.promise
    configs.set(ownerKey(A), { shared: { command: "replacement" } })
    let replacementReady = false
    const replacement = viewFor().then((view) => { replacementReady = true; return view })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(replacementReady).toBe(true)
    } finally {
      if (outcome === "success") response.resolve([{ ...STATUS, name: "stale_tool" }])
      else response.reject(new Error("transport closed during canary"))
    }
    expect((await canary)[0].ok).toBe(false)
    expect((await viewFor()).entries).toEqual((await replacement).entries)
    expect(clients).toHaveLength(2)
    expect(clients[1].shutdown).not.toHaveBeenCalled()
  })

  it("does not create a client after shutdown interrupts pending vault resolution", async () => {
    const entered = Promise.withResolvers<void>()
    const secret = Promise.withResolvers<string>()
    configs.set(ownerKey(A), { shared: { command: "same-command", env: { TOKEN: "vault:service/token" } } })
    vaultRead.mockImplementation(() => ({
      getRawSecret: async () => { entered.resolve(); return secret.promise },
    }))
    const pending = mod.getSharedMcpManager(A)
    await entered.promise
    const shutdown = mod.shutdownSharedMcpManager()
    secret.resolve("private-token")
    await Promise.all([pending, shutdown])

    expect(clients).toHaveLength(0)
    expect((await viewFor(B)).owner).toEqual(B)
  })

  it("surfaces a failed background restart without poisoning later lifecycle work", async () => {
    vi.useFakeTimers()
    await viewFor()
    clients[0].shutdown.mockImplementationOnce(() => { throw new Error("shutdown failed") })
    clients[0].close()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(events).toContainEqual(expect.objectContaining({
      level: "error", event: "mcp.lifecycle_error", meta: expect.objectContaining({ reason: "shutdown failed" }),
    }))
    expect((await viewFor(B)).owner).toEqual(B)
  })

  it("rejects invalid owners at every direct manager entrypoint before client or config access", async () => {
    const manager = new mod.McpManager()
    try {
      await expect(Reflect.apply(manager.start, manager, [null, {}])).rejects.toThrow(/explicit owner/)
      await expect(Reflect.apply(manager.reconcile, manager, [null])).rejects.toThrow(/explicit owner/)
      await expect(Reflect.apply(manager.runCanaries, manager, [null])).rejects.toThrow(/explicit owner/)
      await expect(Reflect.apply(manager.callTool, manager, [{}, {}, null])).rejects.toThrow(/explicit owner/)
      expect(() => Reflect.apply(manager.listAllTools, manager, [null])).toThrow(/explicit owner/)
      expect(clients).toHaveLength(0)
      expect(configRead).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({ event: "mcp.owner_invalid" }))
    } finally {
      await manager.shutdown()
    }
  })

  it("retains explicit plugin origins during direct owned startup", async () => {
    const manager = new mod.McpManager()
    try {
      const view = await manager.start(A, { shared: { command: "same-command" } }, { shared: "desk" })
      expect(view!.entries[0]).toMatchObject({ source: "plugin", pluginId: "desk" })
      expect(asDefinitions(view!)[0].tool.function.name).toBe("mcp__shared__status")
      expect(await asDefinitions(view!)[0].handler({}, context())).toBe("owned result")
    } finally {
      await manager.shutdown()
    }
  })

  it("keeps an adapter's stale binding rejection typed rather than returning success-shaped text", async () => {
    const first = await viewFor()
    const definition = asDefinitions(first)[0]
    configs.set(ownerKey(A), { shared: { command: "replacement" } })
    await viewFor()

    await expect(definition.handler({}, context())).rejects.toMatchObject({ name: "McpCallRejectedError" })
    expect(clients.every((client) => client.callTool.mock.calls.length === 0)).toBe(true)
  })

  it("does not start or reconcile new clients on an already closed manager", async () => {
    const manager = new mod.McpManager()
    const closing = manager.shutdown()
    expect(manager.shutdown()).toBe(closing)
    await closing
    await expect(manager.start(A, { shared: { command: "same-command" } })).resolves.toBeNull()
    await expect(manager.reconcile(A)).resolves.toBeNull()
    expect(clients).toHaveLength(0)
    expect(configRead).not.toHaveBeenCalled()
  })

  it.each(["connect", "tools"] as const)(
    "closes direct startup during pending %s without publishing a view or starting its next server",
    async (phase) => {
      const manager = new mod.McpManager()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      clientSetup = (client) => {
        if (phase === "connect") {
          client.connect.mockImplementation(async () => {
            entered.resolve()
            await release.promise
            client.connected = true
          })
        } else {
          client.listTools.mockImplementation(async () => {
            entered.resolve()
            await release.promise
            return client.tools
          })
        }
      }
      const pending = manager.start(A, {
        first: { command: "first" }, second: { command: "second" },
      })
      try {
        await entered.promise
        const closing = manager.shutdown()
        release.resolve()
        await expect(pending).resolves.toBeNull()
        await closing
        expect(clients).toHaveLength(1)
        expect(clients[0].connected).toBe(false)
        expect(clients[0].shutdown).toHaveBeenCalled()
      } finally {
        release.resolve()
        await manager.shutdown()
      }
    },
  )

  it("shares concurrent shutdown and releases an absent singleton without creating one", async () => {
    const first = await viewFor()
    await Promise.all([mod.shutdownSharedMcpManager(), mod.shutdownSharedMcpManager()])
    await mod.releaseRuntimeMcpServers(A)
    expect(clients[0].shutdown).toHaveBeenCalledOnce()
    const second = await viewFor(B)
    expect(second.manager).not.toBe(first.manager)
  })

  it("rejects a canary entry replaced between its snapshot and queued refresh", async () => {
    const first = await viewFor()
    configs.set(ownerKey(A), { shared: { command: "replacement" } })
    const checking = first.manager.runCanaries(A)
    const replacing = mod.getSharedMcpManager(A)
    const [results, replacement] = await Promise.all([checking, replacing])

    expect(results).toEqual([{ server: "shared", ok: false, detail: "disconnected after recovery attempt" }])
    expect(clients[0].refreshTools).not.toHaveBeenCalled()
    expect(clients[1].refreshTools).not.toHaveBeenCalled()
    expect(replacement!.entries[0].generation).not.toBe(first.entries[0].generation)
  })

  it("fences a timer already queued behind another owner and a replacement", async () => {
    vi.useFakeTimers()
    await viewFor()
    clients[0].close()
    await vi.advanceTimersByTimeAsync(0)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    clientSetup = (client, index) => {
      if (index !== 1) return
      client.connect.mockImplementation(async () => {
        entered.resolve()
        await release.promise
        client.connected = true
      })
    }
    const pendingB = mod.getSharedMcpManager(B)
    try {
      await entered.promise
      configs.set(ownerKey(A), { shared: { command: "replacement" } })
      const replacing = mod.getSharedMcpManager(A)
      await vi.advanceTimersByTimeAsync(1_000)
      release.resolve()
      await Promise.all([pendingB, replacing])
      await vi.advanceTimersByTimeAsync(0)

      expect(clients).toHaveLength(3)
      expect(clients[0].shutdown).toHaveBeenCalledOnce()
      expect(clients[1].shutdown).not.toHaveBeenCalled()
      expect(clients[2].shutdown).not.toHaveBeenCalled()
    } finally {
      release.resolve()
    }
  })

  it("reports non-Error background failures without poisoning another owner", async () => {
    vi.useFakeTimers()
    await viewFor()
    clients[0].shutdown.mockImplementationOnce(() => { throw "shutdown declined" })
    clients[0].close()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(events).toContainEqual(expect.objectContaining({
      event: "mcp.lifecycle_error", meta: { reason: "shutdown declined" },
    }))
    expect((await viewFor(B)).owner).toEqual(B)
  })

  it.each(["store", "secret"] as const)("bounds a non-Error %s failure to its owner", async (phase) => {
    const b = await viewFor(B)
    configs.set(ownerKey(A), { shared: { command: "same-command", env: { TOKEN: "vault:service/token" } } })
    vaultRead.mockImplementation(() => {
      if (phase === "store") throw "store unavailable"
      return { getRawSecret: async () => { throw "raw secret failure" } }
    })
    const a = await viewFor()

    expect(a.entries).toEqual([])
    expect((await viewFor(B)).entries).toEqual(b.entries)
    expect(clients[0].shutdown).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({
      event: "mcp.vault_resolve_error",
      meta: expect.objectContaining({
        reason: phase === "store" ? "store unavailable" : "vault:service/token could not be resolved: vault unreachable",
      }),
    }))
  })

  it("does not replay a transport failure against a recovered client with a changed schema", async () => {
    const first = await viewFor()
    clients[0].callTool.mockRejectedValueOnce(new Error("transport closed"))
    clientSetup = (client) => { client.tools = [] }

    await expect(first.manager.callTool(asDefinitions(first)[0].mcpBinding!, {}, A)).rejects.toThrow("transport closed")
    expect(clients).toHaveLength(2)
    expect(clients[0].callTool).toHaveBeenCalledOnce()
    expect(clients[1].callTool).not.toHaveBeenCalled()
  })
})
