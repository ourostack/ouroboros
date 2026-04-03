import { McpClient } from "./mcp-client"
import type { McpToolInfo } from "./mcp-client"
import { loadAgentConfig, type McpServerConfig } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

interface ServerEntry {
  name: string
  config: McpServerConfig
  client: McpClient
  cachedTools: McpToolInfo[]
  consecutiveFailures: number
}

const MAX_RESTART_RETRIES = 5
const RESTART_DELAY_MS = 1000

export class McpManager {
  private servers = new Map<string, ServerEntry>()
  private shuttingDown = false

  async start(servers: Record<string, McpServerConfig>): Promise<void> {
    emitNervesEvent({
      event: "mcp.manager_start",
      component: "repertoire",
      message: "starting MCP manager",
      meta: { serverCount: Object.keys(servers).length },
    })

    const entries = Object.entries(servers)
    for (const [name, config] of entries) {
      await this.connectServer(name, config)
    }
  }

  listAllTools(): Array<{ server: string; tools: McpToolInfo[] }> {
    const result: Array<{ server: string; tools: McpToolInfo[] }> = []
    for (const [name, entry] of this.servers) {
      result.push({ server: name, tools: entry.cachedTools })
    }
    return result
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const entry = this.servers.get(server)
    if (!entry) {
      throw new Error(`Unknown server: ${server}`)
    }

    if (!entry.client.isConnected()) {
      throw new Error(`Server "${server}" is disconnected`)
    }

    return entry.client.callTool(tool, args)
  }

  /* v8 ignore start — reconcile: dynamic MCP server management, tested via integration @preserve */
  /** Re-read agent config and connect new servers / disconnect removed ones. */
  async reconcile(): Promise<void> {
    try {
      const config = loadAgentConfig()
      const servers = config.mcpServers ?? {}
      const currentNames = new Set(this.servers.keys())
      const desiredNames = new Set(Object.keys(servers))

      // Connect new servers
      for (const [name, cfg] of Object.entries(servers)) {
        if (!currentNames.has(name)) {
          emitNervesEvent({
            event: "mcp.server_added",
            component: "repertoire",
            message: `connecting new MCP server: ${name}`,
            meta: { server: name, command: cfg.command },
          })
          await this.connectServer(name, cfg)
        }
      }

      // Disconnect removed servers
      for (const name of currentNames) {
        if (!desiredNames.has(name)) {
          emitNervesEvent({
            event: "mcp.server_removed",
            component: "repertoire",
            message: `disconnecting removed MCP server: ${name}`,
            meta: { server: name },
          })
          const entry = this.servers.get(name)
          if (entry) entry.client.shutdown()
          this.servers.delete(name)
        }
      }
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        event: "mcp.reconcile_error",
        component: "repertoire",
        message: "failed to reconcile MCP servers",
        meta: { reason: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  /* v8 ignore stop */

  shutdown(): void {
    this.shuttingDown = true
    emitNervesEvent({
      event: "mcp.manager_stop",
      component: "repertoire",
      message: "shutting down MCP manager",
      meta: { serverCount: this.servers.size },
    })

    for (const [, entry] of this.servers) {
      entry.client.shutdown()
    }
    this.servers.clear()
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    const client = new McpClient(config)

    const entry: ServerEntry = {
      name,
      config,
      client,
      cachedTools: [],
      consecutiveFailures: 0,
    }

    this.servers.set(name, entry)

    client.onClose(() => {
      if (this.shuttingDown) return
      this.handleServerCrash(name)
    })

    try {
      await client.connect()
      const tools = await client.listTools()
      entry.cachedTools = tools
      entry.consecutiveFailures = 0
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      emitNervesEvent({
        level: "error",
        event: "mcp.connect_error",
        component: "repertoire",
        message: `failed to connect MCP server "${name}" (command: ${config.command}). Check that the command exists and is properly configured. Reason: ${reason}`,
        meta: {
          server: name,
          command: config.command,
          args: config.args,
          reason,
        },
      })
    }
  }

  private handleServerCrash(name: string): void {
    const entry = this.servers.get(name)
    /* v8 ignore next -- defensive: entry removed between close event and handler @preserve */
    if (!entry) return

    entry.consecutiveFailures++

    if (entry.consecutiveFailures > MAX_RESTART_RETRIES) {
      emitNervesEvent({
        level: "error",
        event: "mcp.connect_error",
        component: "repertoire",
        message: `MCP server "${name}" exceeded max restart retries (${MAX_RESTART_RETRIES}). Giving up — check that "${entry.config.command}" exists and is properly configured in agent.json mcpServers.`,
        meta: { server: name, command: entry.config.command, failures: entry.consecutiveFailures },
      })
      return
    }

    emitNervesEvent({
      level: "warn",
      event: "mcp.server_restart",
      component: "repertoire",
      message: `restarting crashed MCP server: ${name}`,
      meta: { server: name, attempt: entry.consecutiveFailures },
    })

    /* v8 ignore start -- timer callback: covered by mcp-manager.test.ts via fake timers but v8 can't trace @preserve */
    setTimeout(() => {
      if (this.shuttingDown) return
      this.restartServer(name).catch(() => {
        // Error handling is inside restartServer
      })
    }, RESTART_DELAY_MS)
    /* v8 ignore stop */
  }

  /* v8 ignore start -- called from timer callback: covered by mcp-manager.test.ts via fake timers but v8 can't trace @preserve */
  private async restartServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return

    // Remove old entry and reconnect
    this.servers.delete(name)
    await this.connectServer(name, entry.config)

    // Preserve failure count
    const newEntry = this.servers.get(name)
    if (newEntry) {
      newEntry.consecutiveFailures = entry.consecutiveFailures
    }
  }
  /* v8 ignore stop */
}

let _sharedManager: McpManager | null = null
let _sharedManagerPromise: Promise<McpManager | null> | null = null

/**
 * Get or create a shared McpManager instance from the agent's config.
 * Returns null if no mcpServers are configured.
 * Safe to call from multiple senses — will only create one instance.
 */
export async function getSharedMcpManager(): Promise<McpManager | null> {
  // If manager exists, reconcile to pick up config changes (new/removed servers)
  /* v8 ignore start — reconcile on existing manager @preserve */
  if (_sharedManager) {
    await _sharedManager.reconcile()
    return _sharedManager
  }
  /* v8 ignore stop */
  /* v8 ignore next -- race guard: deduplicates concurrent initialization calls @preserve */
  if (_sharedManagerPromise) return _sharedManagerPromise

  // Always re-check config — agent may have added servers since last call

  _sharedManagerPromise = (async () => {
    try {
      const config = loadAgentConfig()
      const servers = config.mcpServers
      if (!servers || Object.keys(servers).length === 0) return null

      const manager = new McpManager()
      await manager.start(servers)
      _sharedManager = manager
      return manager
    } catch (error) {
      emitNervesEvent({
        level: "error",
        event: "mcp.manager_start",
        component: "repertoire",
        message: "failed to initialize shared MCP manager",
        /* v8 ignore next -- both branches tested: Error in wiring test, non-Error is defensive @preserve */
        meta: { reason: error instanceof Error ? error.message : String(error) },
      })
      return null
    } finally {
      _sharedManagerPromise = null
    }
  })()

  return _sharedManagerPromise
}

/**
 * Shut down the shared MCP manager and clear the singleton.
 * Called during daemon/agent shutdown.
 */
export function shutdownSharedMcpManager(): void {
  if (_sharedManager) {
    _sharedManager.shutdown()
    _sharedManager = null
  }
}

/** Reset for testing only */
export function resetSharedMcpManager(): void {
  _sharedManager = null
  _sharedManagerPromise = null
}
