import { createHash, timingSafeEqual } from "crypto"
import { McpClient, isMcpTransportError } from "./mcp-client"
import type { McpToolCallResultV1, McpToolInfo } from "./mcp-client"
import { loadAgentConfig, type McpServerConfig } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { getCredentialStore } from "./credential-access"
import { sha256CanonicalJson } from "../heart/runtime/canonical-json"
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

export interface McpInternalExecutorAuthority {
  capabilityId: string
  executorId: string
  serverId: string
  toolName: string
  registryRevision: string
  tokenSha256: string
  token: string
}

export interface McpServerCompositionInventory {
  serverId: string
  negotiatedProtocolVersion: string
  transportIdentitySha256: string
  tools: McpToolInfo[]
}

export function createMcpInternalExecutorAuthority(input: {
  executorId: string
  serverId: string
  toolName: string
  registryRevision: string
  randomBytes: (size: number) => Buffer
}): McpInternalExecutorAuthority {
  const tokenBytes = input.randomBytes(32)
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) throw new Error("Internal MCP capability requires exactly 32 random bytes")
  const token = tokenBytes.toString("hex")
  const tokenSha256 = createHash("sha256").update(tokenBytes).digest("hex")
  const capabilityId = createHash("sha256").update([
    input.executorId,
    input.serverId,
    input.toolName,
    input.registryRevision,
    tokenSha256,
  ].join("\u0000")).digest("hex")
  return {
    capabilityId,
    executorId: input.executorId,
    serverId: input.serverId,
    toolName: input.toolName,
    registryRevision: input.registryRevision,
    tokenSha256,
    token,
  }
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
interface McpServerConfigSource {
  configuredServers?: Record<string, McpServerConfig>
  includePlugins?: boolean
}

function buildMergedServerConfig(runtimeServers?: RuntimeMcpServers, source: McpServerConfigSource = {}): {
  mergedServers: Record<string, McpServerConfig>
  pluginOrigins: Record<string, string>
} {
  const builtinServers = source.configuredServers ?? loadAgentConfig().mcpServers ?? {}
  const pluginServers = source.includePlugins === false ? [] : listPluginMcpServers()
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
  private internalAuthorities = new Map<string, McpInternalExecutorAuthority>()
  private internalAuthorityOwners = new Map<string, Set<string>>()
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
      if ((entry.config.visibility ?? "agent") === "internal") continue
      result.push({
        server: name,
        tools: entry.cachedTools,
        ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
      })
    }
    return result
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResultV1> {
    let entry = this.servers.get(server)
    if (!entry) {
      throw new Error(`Unknown server: ${server}`)
    }
    if ((entry.config.visibility ?? "agent") === "internal") {
      throw new Error(`Server "${server}" is internal and unavailable to ordinary MCP calls`)
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
      if (!error || typeof error !== "object" || (error as { phase?: unknown }).phase !== "pre-dispatch") {
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
      if ((entry.config.visibility ?? "agent") === "internal") continue
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
  async reconcile(runtimeServers?: RuntimeMcpServers, source: McpServerConfigSource = {}): Promise<void> {
    try {
      const { mergedServers, pluginOrigins } = buildMergedServerConfig(runtimeServers, source)
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
          continue
        }
        const current = this.servers.get(name)!
        if (sha256CanonicalJson(current.config) !== sha256CanonicalJson(cfg)
          || current.pluginId !== pluginOrigins[name]) {
          this.revokeAuthoritiesForServer(name)
          current.client.shutdown()
          this.servers.delete(name)
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
          this.revokeAuthoritiesForServer(name)
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
    this.internalAuthorities.clear()
    this.internalAuthorityOwners.clear()
  }

  registerInternalExecutorAuthority(authority: McpInternalExecutorAuthority): void {
    if (this.internalAuthorities.has(authority.capabilityId)) throw new Error(`Duplicate internal MCP capability: ${authority.capabilityId}`)
    this.validateAuthorityShape(authority)
    this.internalAuthorities.set(authority.capabilityId, { ...authority })
    emitNervesEvent({
      component: "repertoire",
      event: "mcp.internal_capability_registered",
      message: "registered memory-only internal MCP executor capability",
      meta: { capabilityId: authority.capabilityId, executorId: authority.executorId },
    })
  }

  replaceInternalExecutorAuthorities(owner: string, authorities: McpInternalExecutorAuthority[]): void {
    if (!owner) throw new Error("Internal MCP capability owner is required")
    const previous = this.internalAuthorityOwners.get(owner) ?? new Set<string>()
    const next = new Set<string>()
    for (const authority of authorities) {
      this.validateAuthorityShape(authority)
      if (next.has(authority.capabilityId)) throw new Error(`Duplicate internal MCP capability: ${authority.capabilityId}`)
      const registered = this.internalAuthorities.get(authority.capabilityId)
      if (registered && !previous.has(authority.capabilityId)) {
        throw new Error(`Internal MCP capability is already owned: ${authority.capabilityId}`)
      }
      next.add(authority.capabilityId)
    }
    for (const capabilityId of previous) this.internalAuthorities.delete(capabilityId)
    for (const authority of authorities) this.internalAuthorities.set(authority.capabilityId, { ...authority })
    this.internalAuthorityOwners.set(owner, next)
    emitNervesEvent({
      component: "repertoire",
      event: "mcp.internal_capabilities_replaced",
      message: "atomically replaced one owner's internal MCP capabilities",
      meta: { owner, count: authorities.length },
    })
  }

  async callInternalTool(input: {
    authority: McpInternalExecutorAuthority
    serverId: string
    toolName: string
    arguments: Record<string, unknown>
    timeoutMs: number
  }): Promise<McpToolCallResultV1> {
    let entry = this.authorizedInternalEntry(input.authority, input.serverId, input.toolName)
    if (!entry.client.isConnected()) {
      await this.recoverStaleTransport(input.serverId, "internal pre-call disconnected")
      entry = this.authorizedInternalEntry(input.authority, input.serverId, input.toolName)
      if (!entry.client.isConnected()) throw new Error("Internal MCP capability server is disconnected after recovery")
    }
    try {
      return await entry.client.callTool(input.toolName, input.arguments, input.timeoutMs)
    } catch (error) {
      if (!isMcpTransportError(error)
        || !error
        || typeof error !== "object"
        || (error as { phase?: unknown }).phase !== "pre-dispatch") {
        throw error
      }
      await this.recoverStaleTransport(input.serverId, error instanceof Error ? error.message : String(error))
      const recovered = this.authorizedInternalEntry(input.authority, input.serverId, input.toolName)
      if (!recovered.client.isConnected()) throw new Error("Internal MCP capability server is disconnected after recovery")
      return recovered.client.callTool(input.toolName, input.arguments, input.timeoutMs)
    }
  }

  async refreshInternalInventory(authority: McpInternalExecutorAuthority): Promise<McpToolInfo[]> {
    let entry = this.authorizedInternalEntry(authority, authority.serverId, authority.toolName)
    if (!entry.client.isConnected()) {
      await this.recoverStaleTransport(authority.serverId, "internal inventory disconnected")
      entry = this.authorizedInternalEntry(authority, authority.serverId, authority.toolName)
      if (!entry.client.isConnected()) throw new Error("Internal MCP capability server is disconnected after recovery")
    }
    let tools: McpToolInfo[]
    try {
      tools = await entry.client.refreshTools()
    } catch (error) {
      if (!isMcpTransportError(error)) throw error
      await this.recoverStaleTransport(authority.serverId, error instanceof Error ? error.message : String(error))
      entry = this.authorizedInternalEntry(authority, authority.serverId, authority.toolName)
      if (!entry.client.isConnected()) throw new Error("Internal MCP capability server is disconnected after recovery")
      tools = await entry.client.refreshTools()
    }
    entry.cachedTools = tools
    return tools
  }

  async refreshServerInventoryForComposition(serverId: string): Promise<McpServerCompositionInventory> {
    let entry = this.servers.get(serverId)
    if (!entry) throw new Error(`MCP server "${serverId}" is unavailable for composition`)
    if (!entry.client.isConnected()) {
      await this.recoverStaleTransport(serverId, "composition inventory disconnected")
      entry = this.servers.get(serverId)
      if (!entry?.client.isConnected()) throw new Error(`MCP server "${serverId}" is unavailable for composition`)
    }
    let tools: McpToolInfo[]
    try {
      tools = await entry.client.refreshTools()
    } catch (error) {
      if (!isMcpTransportError(error)) throw error
      await this.recoverStaleTransport(serverId, error instanceof Error ? error.message : String(error))
      entry = this.servers.get(serverId)
      if (!entry?.client.isConnected()) throw new Error(`MCP server "${serverId}" is unavailable for composition`)
      tools = await entry.client.refreshTools()
    }
    entry.cachedTools = tools
    const negotiatedProtocolVersion = entry.client.protocolVersion()
    if (!negotiatedProtocolVersion) throw new Error(`MCP server "${serverId}" has no negotiated protocol version`)
    return {
      serverId,
      negotiatedProtocolVersion,
      transportIdentitySha256: `sha256:${sha256CanonicalJson({
        serverId,
        command: entry.config.command,
        args: entry.config.args ?? [],
        cwd: entry.config.cwd ?? null,
        visibility: entry.config.visibility ?? "agent",
      })}`,
      tools: structuredClone(tools),
    }
  }

  async callReadOnlyHealthTool(input: {
    serverId: string
    toolName: string
    arguments: Record<string, unknown>
    timeoutMs: number
  }): Promise<McpToolCallResultV1> {
    let entry = this.servers.get(input.serverId)
    if (!entry) throw new Error(`MCP health server "${input.serverId}" is unavailable`)
    if (!entry.client.isConnected()) {
      await this.recoverStaleTransport(input.serverId, "read-only health server disconnected")
      entry = this.servers.get(input.serverId)
      if (!entry?.client.isConnected()) throw new Error(`MCP health server "${input.serverId}" is unavailable`)
    }
    if (!entry.cachedTools.some((tool) => tool.name === input.toolName)) throw new Error(`MCP health tool "${input.toolName}" is absent`)
    try {
      return await entry.client.callTool(input.toolName, input.arguments, input.timeoutMs)
    } catch (error) {
      if (!isMcpTransportError(error)) throw error
      await this.recoverStaleTransport(input.serverId, error instanceof Error ? error.message : String(error))
      entry = this.servers.get(input.serverId)
      if (!entry?.client.isConnected()) throw new Error(`MCP health server "${input.serverId}" is unavailable`)
      if (!entry.cachedTools.some((tool) => tool.name === input.toolName)) throw new Error(`MCP health tool "${input.toolName}" is absent`)
      return entry.client.callTool(input.toolName, input.arguments, input.timeoutMs)
    }
  }

  private authorizedInternalEntry(
    authority: McpInternalExecutorAuthority,
    serverId: string,
    toolName: string,
  ): ServerEntry {
    const registered = this.internalAuthorities.get(authority.capabilityId)
    if (!registered || !this.sameAuthority(registered, authority)) throw new Error("Internal MCP capability authority mismatch")
    if (registered.serverId !== serverId || registered.toolName !== toolName) throw new Error("Internal MCP capability coordinates mismatch")
    const entry = this.servers.get(serverId)
    if (!entry || (entry.config.visibility ?? "agent") !== "internal") throw new Error("Internal MCP capability server is unavailable")
    if (!entry.cachedTools.some((tool) => tool.name === toolName)) throw new Error("Internal MCP capability tool is absent from inventory")
    return entry
  }

  private validateAuthorityShape(authority: McpInternalExecutorAuthority): void {
    if (!/^[0-9a-f]{64}$/.test(authority.capabilityId)
      || !/^[0-9a-f]{64}$/.test(authority.tokenSha256)
      || !/^[0-9a-f]{64}$/.test(authority.token)) {
      throw new Error("Internal MCP capability encoding is invalid")
    }
    const tokenHash = createHash("sha256").update(Buffer.from(authority.token, "hex")).digest("hex")
    if (tokenHash !== authority.tokenSha256) throw new Error("Internal MCP capability token hash mismatch")
  }

  private sameAuthority(left: McpInternalExecutorAuthority, right: McpInternalExecutorAuthority): boolean {
    const leftToken = Buffer.from(left.token, "hex")
    const rightToken = Buffer.from(right.token, "hex")
    return left.capabilityId === right.capabilityId
      && left.executorId === right.executorId
      && left.serverId === right.serverId
      && left.toolName === right.toolName
      && left.registryRevision === right.registryRevision
      && left.tokenSha256 === right.tokenSha256
      && leftToken.length === rightToken.length
      && timingSafeEqual(leftToken, rightToken)
  }

  private revokeAuthoritiesForServer(serverId: string): void {
    const revoked = new Set(
      [...this.internalAuthorities]
        .filter(([, authority]) => authority.serverId === serverId)
        .map(([capabilityId]) => capabilityId),
    )
    if (revoked.size === 0) return
    for (const capabilityId of revoked) this.internalAuthorities.delete(capabilityId)
    for (const [owner, capabilityIds] of this.internalAuthorityOwners) {
      for (const capabilityId of revoked) capabilityIds.delete(capabilityId)
      if (capabilityIds.size === 0) this.internalAuthorityOwners.delete(owner)
    }
    emitNervesEvent({
      component: "repertoire",
      event: "mcp.internal_capabilities_revoked_for_server",
      message: "revoked internal MCP capabilities before server authority changed",
      meta: { serverId, count: revoked.size },
    })
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

const DEFAULT_SHARED_MANAGER_SCOPE = "default"
const _sharedManagers = new Map<string, McpManager>()
const _sharedManagerOperations = new Map<string, Promise<McpManager | null>>()

export interface SharedMcpManagerOptions extends McpServerConfigSource {
  runtimeServers?: RuntimeMcpServers
  scope?: string
}

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
  options: SharedMcpManagerOptions = {},
): Promise<McpManager | null> {
  const scope = options.scope ?? DEFAULT_SHARED_MANAGER_SCOPE
  const prior = _sharedManagerOperations.get(scope) ?? Promise.resolve(_sharedManagers.get(scope) ?? null)
  const operation = prior.then(async (current) => {
    try {
      if (current) {
        await current.reconcile(options.runtimeServers, options)
        return current
      }
      const { mergedServers, pluginOrigins } = buildMergedServerConfig(options.runtimeServers, options)
      if (Object.keys(mergedServers).length === 0) return null

      const manager = new McpManager()
      await manager.start(mergedServers, pluginOrigins)
      _sharedManagers.set(scope, manager)
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
    }
  })
  _sharedManagerOperations.set(scope, operation)

  try {
    return await operation
  } finally {
    if (_sharedManagerOperations.get(scope) === operation) _sharedManagerOperations.delete(scope)
  }
}

/**
 * Shut down the shared MCP manager and clear the singleton.
 * Called during daemon/agent shutdown.
 */
export function shutdownSharedMcpManager(): void {
  for (const manager of _sharedManagers.values()) manager.shutdown()
  _sharedManagers.clear()
  _sharedManagerOperations.clear()
}

/** Reset for testing only */
export function resetSharedMcpManager(): void {
  _sharedManagers.clear()
  _sharedManagerOperations.clear()
}
