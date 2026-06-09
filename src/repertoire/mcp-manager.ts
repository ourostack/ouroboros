import { McpClient, isMcpTransportError } from "./mcp-client"
import type { McpToolInfo } from "./mcp-client"
import { loadAgentConfig, type McpServerConfig } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { getCredentialStore } from "./credential-access"
import {
  listPluginMcpServers,
  pluginMcpServerToConfig,
} from "./plugin-mcp"

interface ServerEntry {
  name: string
  config: McpServerConfig
  client: McpClient
  cachedTools: McpToolInfo[]
  consecutiveFailures: number
  /**
   * If this server came from a plugin's `.mcp.json`, the plugin id is stored
   * here. Downstream (`mcpToolsAsDefinitions`) uses this to namespace the
   * surfaced tool names as `mcp__<server>__<tool>` per the Anthropic public
   * naming convention. Builtin (agent.json mcpServers) entries leave it unset.
   */
  pluginId?: string
}

const MAX_RESTART_RETRIES = 5
const RESTART_DELAY_MS = 1000

/**
 * Per-turn, per-agent runtime MCP server overrides.
 *
 * Threaded as parameter data from the `agent.senseTurn` daemon command through
 * `runSenseTurn` into the MCP manager for a SINGLE turn of a SINGLE agent. It is
 * NEVER stored as module-global state — the daemon is one process for all agents
 * on the machine, so a global override would leak into a concurrent turn for a
 * different agent. Used by the Workbench runtime-injection path so the boss agent
 * receives `ouro_workbench` without writing it to `agent.json`.
 */
export type RuntimeMcpServers = Record<string, McpServerConfig>

/**
 * Merge builtin (agent.json mcpServers) + plugin-declared (.mcp.json) servers.
 *
 * Builtin wins on name collision. Returns the merged config map plus a
 * `pluginOrigins` map (server-name → plugin-id) for tools-surfacing namespace.
 *
 * Shared by `getSharedMcpManager()` (initial start) and `McpManager.reconcile()`
 * (re-read on each turn). Both code paths MUST use the same merge logic — if
 * reconcile reads only builtin, plugin servers get classified as "removed"
 * on the second turn and torn down. See alpha.635 fix.
 *
 * `runtimeServers` are per-turn, per-agent overrides (e.g. Workbench's
 * `ouro_workbench`) supplied as PARAMETER data for the current turn — never read
 * from module state. They merge with the HIGHEST precedence (after builtin), so
 * a stale `agent.json` entry loses to the live runtime path. Because they are a
 * parameter, a turn that omits them produces a merged set WITHOUT them, and
 * `reconcile()` then tears the runtime server down — this is the no-leak
 * invariant that keeps the runtime MCP from bleeding into a different agent's
 * concurrent turn on the shared daemon.
 */
function buildMergedServerConfig(runtimeServers?: RuntimeMcpServers): {
  mergedServers: Record<string, McpServerConfig>
  pluginOrigins: Record<string, string>
} {
  const config = loadAgentConfig()
  const builtinServers = config.mcpServers ?? {}
  const pluginServers = listPluginMcpServers()
  const mergedServers: Record<string, McpServerConfig> = {}
  const pluginOrigins: Record<string, string> = {}
  for (const p of pluginServers) {
    if (builtinServers[p.serverName] !== undefined) continue
    mergedServers[p.serverName] = pluginMcpServerToConfig(p)
    pluginOrigins[p.serverName] = p.pluginId
  }
  for (const [name, cfg] of Object.entries(builtinServers)) {
    mergedServers[name] = cfg
  }
  // Runtime overrides win over both plugin and builtin (highest precedence).
  // They are NOT recorded in pluginOrigins, so they surface as builtin-style
  // (un-namespaced) tools — matching how an agent.json mcpServers entry would.
  if (runtimeServers) {
    for (const [name, cfg] of Object.entries(runtimeServers)) {
      mergedServers[name] = cfg
      delete pluginOrigins[name]
    }
  }
  return { mergedServers, pluginOrigins }
}

export class McpManager {
  private servers = new Map<string, ServerEntry>()
  private shuttingDown = false

  async start(
    servers: Record<string, McpServerConfig>,
    pluginOrigins: Record<string, string> = {},
  ): Promise<void> {
    emitNervesEvent({
      event: "mcp.manager_start",
      component: "repertoire",
      message: "starting MCP manager",
      meta: {
        serverCount: Object.keys(servers).length,
        pluginServerCount: Object.keys(pluginOrigins).length,
      },
    })

    const entries = Object.entries(servers)
    for (const [name, config] of entries) {
      await this.connectServer(name, config, pluginOrigins[name])
    }
  }

  listAllTools(): Array<{ server: string; tools: McpToolInfo[]; pluginId?: string }> {
    const result: Array<{ server: string; tools: McpToolInfo[]; pluginId?: string }> = []
    for (const [name, entry] of this.servers) {
      result.push({ server: name, tools: entry.cachedTools, pluginId: entry.pluginId })
    }
    return result
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    let entry = this.servers.get(server)
    if (!entry) {
      throw new Error(`Unknown server: ${server}`)
    }

    if (!entry.client.isConnected()) {
      await this.recoverStaleTransport(server, "pre-call disconnected")
      entry = this.servers.get(server)
      if (!entry?.client.isConnected()) {
        throw new Error(`Server "${server}" is disconnected`)
      }
    }

    try {
      return await entry.client.callTool(tool, args)
    } catch (error) {
      if (!isMcpTransportError(error)) {
        throw error
      }
      const reason = error instanceof Error ? error.message : String(error)
      await this.recoverStaleTransport(server, reason)
      const recovered = this.servers.get(server)
      if (!recovered?.client.isConnected()) {
        throw new Error(`Server "${server}" is disconnected after recovery: ${reason}`)
      }
      return recovered.client.callTool(tool, args)
    }
  }

  async runCanaries(): Promise<Array<{ server: string; ok: boolean; detail: string }>> {
    const results: Array<{ server: string; ok: boolean; detail: string }> = []
    for (const [server, entry] of [...this.servers]) {
      try {
        if (!entry.client.isConnected()) {
          await this.recoverStaleTransport(server, "canary disconnected")
        }
        const current = this.servers.get(server)
        if (!current?.client.isConnected()) {
          results.push({ server, ok: false, detail: "disconnected after recovery attempt" })
          continue
        }
        const tools = await current.client.refreshTools()
        current.cachedTools = tools
        current.consecutiveFailures = 0
        results.push({ server, ok: true, detail: `${tools.length} tools listed` })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (isMcpTransportError(error)) {
          await this.recoverStaleTransport(server, reason)
        }
        results.push({ server, ok: false, detail: reason })
      }
    }
    return results
  }

  /** Re-read agent config AND enabled-plugin .mcp.json files, then connect new
   *  servers / disconnect removed ones. Must include plugin-declared servers
   *  in the desired set — otherwise plugin servers (e.g. mcp__desk__*) are
   *  treated as "removed" on every call and get torn down between turns.
   *
   *  `runtimeServers` are the current turn's per-agent overrides. They MUST be
   *  passed on every reconcile for the agent that owns them, otherwise the
   *  runtime server (e.g. ouro_workbench) is classified as "removed" and torn
   *  down — which is exactly the desired no-leak behavior for a turn that omits
   *  them. */
  async reconcile(runtimeServers?: RuntimeMcpServers): Promise<void> {
    try {
      const { mergedServers, pluginOrigins } = buildMergedServerConfig(runtimeServers)
      const currentNames = new Set(this.servers.keys())
      const desiredNames = new Set(Object.keys(mergedServers))

      // Connect new servers
      for (const [name, cfg] of Object.entries(mergedServers)) {
        if (!currentNames.has(name)) {
          emitNervesEvent({
            event: "mcp.server_added",
            component: "repertoire",
            message: `connecting new MCP server: ${name}`,
            meta: { server: name, command: cfg.command },
          })
          await this.connectServer(name, cfg, pluginOrigins[name])
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
          /* v8 ignore next -- defensive: name comes from this.servers.keys() this same tick, so entry is always present; the guard only protects against an awaited connectServer crash-handler racing a delete @preserve */
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

  shutdown(): void {
    this.shuttingDown = true
    // `_end` (not `_stop`) to pair with `mcp.manager_start` under the
    // nerves audit start/end pairing rule.
    emitNervesEvent({
      event: "mcp.manager_end",
      component: "repertoire",
      message: "shutting down MCP manager",
      meta: { serverCount: this.servers.size },
    })

    for (const [, entry] of this.servers) {
      entry.client.shutdown()
    }
    this.servers.clear()
  }

  /**
   * Resolve `vault:DOMAIN/FIELD` references in server env config.
   * Returns resolved env or throws with a descriptive error.
   */
  private async resolveVaultEnv(
    _serverName: string,
    env: Record<string, string>,
  ): Promise<Record<string, string>> {
    const resolved = { ...env }
    // Short-circuit: only spin up a credential store if at least one env value
    // actually requests vault resolution. Plugin MCP servers commonly ship with
    // `env: {}` or pure-string envs, and we shouldn't pay the credential-store
    // boot cost (or fail in test envs that have no vault) for those cases.
    const hasVaultRef = Object.values(resolved).some((v) => /^vault:/.test(v))
    if (!hasVaultRef) return resolved
    const store = getCredentialStore()

    for (const [key, value] of Object.entries(resolved)) {
      const match = value.match(/^vault:([^/]+)\/(.+)$/)
      if (!match) continue

      const [, domain, field] = match
      try {
        resolved[key] = await store.getRawSecret(domain, field)
      } catch (err) {
        /* v8 ignore next -- reason @preserve */
        const reason = err instanceof Error ? err.message : String(err)
        // Classify the error for actionable messaging
        let classification = "vault unreachable"
        if (reason.includes("no credential found")) {
          classification = "item not found"
        } else if (reason.includes("field") && reason.includes("not found")) {
          classification = "field empty"
        }
        throw new Error(`vault:${domain}/${field} could not be resolved: ${classification}`)
      }
    }

    return resolved
  }

  private async connectServer(
    name: string,
    config: McpServerConfig,
    pluginId?: string,
  ): Promise<void> {
    // Resolve vault: references in env before spawning
    let resolvedConfig = config
    if (config.env) {
      try {
        const resolvedEnv = await this.resolveVaultEnv(name, config.env)
        resolvedConfig = { ...config, env: resolvedEnv }
      } catch (err) {
        /* v8 ignore next -- reason @preserve */
        const reason = err instanceof Error ? err.message : String(err)
        emitNervesEvent({
          level: "error",
          event: "mcp.vault_resolve_error",
          component: "repertoire",
          message: `skipping MCP server "${name}": ${reason}`,
          meta: { server: name, reason },
        })
        return // Skip this server, continue to next
      }
    }

    const client = new McpClient(resolvedConfig)

    const entry: ServerEntry = {
      name,
      config,
      client,
      cachedTools: [],
      consecutiveFailures: 0,
      pluginId,
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
    entry.client.shutdown()
    await this.connectServer(name, entry.config)

    // Preserve failure count
    const newEntry = this.servers.get(name)
    if (newEntry) {
      newEntry.consecutiveFailures = entry.consecutiveFailures
    }
  }
  /* v8 ignore stop */

  private async recoverStaleTransport(name: string, reason: string): Promise<void> {
    emitNervesEvent({
      level: "warn",
      event: "mcp.transport_recovery",
      component: "repertoire",
      message: `recovering stale MCP transport: ${name}`,
      meta: { server: name, reason },
    })
    await this.restartServer(name)
  }
}

let _sharedManager: McpManager | null = null
let _sharedManagerPromise: Promise<McpManager | null> | null = null

/**
 * Get or create a shared McpManager instance from the agent's config.
 * Returns null if no mcpServers are configured.
 * Safe to call from multiple senses — will only create one instance.
 *
 * `options.runtimeServers` are the current turn's per-agent MCP overrides (e.g.
 * Workbench's `ouro_workbench`). They are PARAMETER data for this call only —
 * passed into the merge for both the initial `start()` and every subsequent
 * `reconcile()`, and never persisted as module state. A call that omits them
 * reconciles to a set WITHOUT them, tearing any prior runtime server down — the
 * no-leak invariant for the shared multi-agent daemon.
 */
export async function getSharedMcpManager(
  options?: { runtimeServers?: RuntimeMcpServers },
): Promise<McpManager | null> {
  const runtimeServers = options?.runtimeServers
  // If manager exists, reconcile to pick up config changes (new/removed servers)
  // AND this turn's runtime overrides. Passing runtimeServers per-call is what
  // scopes the runtime MCP to the active agent's turn.
  if (_sharedManager) {
    await _sharedManager.reconcile(runtimeServers)
    return _sharedManager
  }
  /* v8 ignore next -- race guard: deduplicates concurrent initialization calls @preserve */
  if (_sharedManagerPromise) return _sharedManagerPromise

  // Always re-check config — agent may have added servers since last call

  _sharedManagerPromise = (async () => {
    try {
      const { mergedServers, pluginOrigins } = buildMergedServerConfig(runtimeServers)
      if (Object.keys(mergedServers).length === 0) return null

      const manager = new McpManager()
      await manager.start(mergedServers, pluginOrigins)
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
