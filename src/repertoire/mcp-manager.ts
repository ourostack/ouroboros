import * as path from "node:path"
import { McpClient, isMcpTransportError } from "./mcp-client"
import type { McpToolInfo } from "./mcp-client"
import { loadAgentConfig, type McpServerConfig } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { getCredentialStore } from "./credential-access"
import { listPluginMcpServers, pluginMcpServerToConfig } from "./plugin-mcp"
import { digestJson, freezeToolValue } from "./tool-arguments"
import { McpCallRejectedError, mcpToolSchema } from "./mcp-tools"

export type McpOwner = Readonly<{ agentName: string; agentRoot: string }>
export type RuntimeMcpServers = Record<string, McpServerConfig>
type McpSource = "builtin" | "plugin" | "runtime"
type ToolResult = Awaited<ReturnType<McpClient["callTool"]>>

interface DesiredServer {
  config: McpServerConfig
  source: McpSource
  pluginId?: string
}

interface ServerEntry extends DesiredServer {
  owner: McpOwner
  name: string
  client: McpClient
  cachedTools: McpToolInfo[]
  configDigest: string
  generation: number
  consecutiveFailures: number
  restartTimer?: ReturnType<typeof setTimeout>
}

export interface McpServerView {
  readonly server: string
  readonly source: McpSource
  readonly pluginId?: string
  readonly configDigest: string
  readonly generation: number
  readonly tools: readonly McpToolInfo[]
}

export interface McpTurnView {
  readonly manager: McpManager
  readonly owner: McpOwner
  readonly entries: readonly McpServerView[]
}

export interface McpToolBinding {
  readonly manager: McpManager
  readonly agentName: string
  readonly agentRoot: string
  readonly server: string
  readonly rawName: string
  readonly surfacedName: string
  readonly source: McpSource
  readonly pluginId?: string
  readonly configDigest: string
  readonly generation: number
  readonly schemaDigest: string
}

const MAX_RESTART_RETRIES = 5
const RESTART_DELAY_MS = 1000

function isOwner(value: unknown): value is McpOwner {
  return typeof value === "object" && value !== null
    && "agentName" in value && typeof value.agentName === "string" && value.agentName.length > 0
    && "agentRoot" in value && typeof value.agentRoot === "string" && path.isAbsolute(value.agentRoot)
}

function captureOwner(owner: McpOwner): McpOwner {
  if (!isOwner(owner)) {
    emitNervesEvent({
      level: "warn", event: "mcp.owner_invalid", component: "repertoire",
      message: "MCP requires an explicit owner", meta: { reason: "agent name and absolute root are required" },
    })
    throw new McpCallRejectedError("MCP requires an explicit owner")
  }
  return Object.freeze({ agentName: owner.agentName, agentRoot: owner.agentRoot })
}

function sameOwner(left: McpOwner, right: McpOwner): boolean {
  return left.agentName === right.agentName && left.agentRoot === right.agentRoot
}

function serverKey(owner: McpOwner, name: string): string {
  return JSON.stringify([owner.agentName, owner.agentRoot, name])
}

function buildMergedServerConfig(owner: McpOwner, runtimeServers?: RuntimeMcpServers): Map<string, DesiredServer> {
  const config = loadAgentConfig(owner)
  const desired = new Map<string, DesiredServer>()
  for (const plugin of listPluginMcpServers(undefined, owner)) {
    if (desired.has(plugin.serverName)) throw new McpCallRejectedError(`MCP server name collision: ${plugin.serverName}`)
    desired.set(plugin.serverName, {
      config: pluginMcpServerToConfig(plugin), source: "plugin", pluginId: plugin.pluginId,
    })
  }
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    desired.set(name, { config: server, source: "builtin" })
  }
  for (const [name, server] of Object.entries(runtimeServers ?? {})) {
    desired.set(name, { config: server, source: "runtime" })
  }
  return desired
}

function configurationDigest(owner: McpOwner, desired: DesiredServer): string {
  return digestJson({
    agentName: owner.agentName, agentRoot: owner.agentRoot,
    source: desired.source, pluginId: desired.pluginId ?? null,
    command: desired.config.command, args: desired.config.args ?? [],
    env: desired.config.env ?? {}, cwd: desired.config.cwd ?? "",
  })
}

export class McpManager {
  private servers = new Map<string, ServerEntry>()
  private desiredGenerations = new Map<string, number>()
  private nextGeneration = 0
  private lifecycle: Promise<void> = Promise.resolve()
  private shutdownPromise?: Promise<void>

  constructor() {
    emitNervesEvent({
      event: "mcp.manager_start", component: "repertoire",
      message: "starting MCP manager", meta: { serverCount: 0 },
    })
  }

  // One lifecycle tail; external tool and canary results do not hold it.
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation)
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  private enqueueBackground(operation: () => void | Promise<void>): void {
    void this.enqueue(operation).catch((error: unknown) => {
      emitNervesEvent({
        level: "error", event: "mcp.lifecycle_error", component: "repertoire",
        message: "MCP background lifecycle operation failed",
        meta: { reason: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  async start(
    ownerInput: McpOwner,
    servers: Record<string, McpServerConfig>,
    pluginOrigins: Record<string, string> = {},
  ): Promise<McpTurnView | null> {
    const owner = captureOwner(ownerInput)
    const desired = new Map(Object.entries(structuredClone(servers)).map(([name, config]) => [
      name, { config, source: pluginOrigins[name] ? "plugin" as const : "builtin" as const, pluginId: pluginOrigins[name] },
    ]))
    return this.enqueue(async () => {
      if (this.shutdownPromise) return null
      await this.applyDesired(owner, desired)
      return this.shutdownPromise ? null : this.freezeView(owner)
    })
  }

  async reconcile(ownerInput: McpOwner, runtimeServers?: RuntimeMcpServers): Promise<McpTurnView | null> {
    const owner = captureOwner(ownerInput)
    const runtime = runtimeServers ? structuredClone(runtimeServers) : undefined
    return this.enqueue(async () => {
      if (this.shutdownPromise) return null
      try {
        const desired = buildMergedServerConfig(owner, runtime)
        await this.applyDesired(owner, desired)
        return this.shutdownPromise || desired.size === 0 ? null : this.freezeView(owner)
      } catch (error) {
        emitNervesEvent({
          level: "warn", event: "mcp.reconcile_error", component: "repertoire",
          message: "failed to reconcile MCP servers",
          meta: { reason: error instanceof Error ? error.message : String(error) },
        })
        for (const entry of this.ownedEntries(owner)) this.removeEntry(entry)
        return null
      }
    })
  }

  listAllTools(owner: McpOwner): Array<{ server: string; tools: McpToolInfo[]; pluginId?: string }> {
    captureOwner(owner)
    return this.ownedEntries(owner).filter((entry) => this.isCurrentEntry(entry)).map((entry) => ({
      server: entry.name, tools: structuredClone(entry.cachedTools), pluginId: entry.pluginId,
    }))
  }

  async callTool(binding: McpToolBinding, args: Record<string, unknown>, ownerInput: McpOwner): Promise<ToolResult> {
    const owner = captureOwner(ownerInput)
    const call = await this.enqueue(async () => {
      let entry = this.currentBinding(binding, owner)
      if (!entry.client.isConnected()) {
        await this.recoverStaleTransport(entry, "pre-call disconnected")
        entry = this.currentBinding(binding, owner)
        if (!entry.client.isConnected()) throw new McpCallRejectedError(`Server "${entry.name}" is disconnected`)
      }
      return { entry, result: entry.client.callTool(binding.rawName, args) }
    })
    try {
      return await call.result
    } catch (error) {
      if (!isMcpTransportError(error)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      // Recovery prepares later calls; the server may already have performed this one.
      this.enqueueBackground(async () => {
        if (this.isCurrentEntry(call.entry)) await this.recoverStaleTransport(call.entry, reason)
      })
      throw error
    }
  }

  async validateToolBinding(binding: McpToolBinding, ownerInput: McpOwner): Promise<void> {
    const owner = captureOwner(ownerInput)
    await this.enqueue(() => { this.currentBinding(binding, owner) })
  }

  async runCanaries(ownerInput: McpOwner): Promise<Array<{ server: string; ok: boolean; detail: string }>> {
    const owner = captureOwner(ownerInput)
    const entries = await this.enqueue(() => this.ownedEntries(owner))
    const results: Array<{ server: string; ok: boolean; detail: string }> = []
    for (const entry of entries) {
      let current = entry
      try {
        const refresh = await this.enqueue(async () => {
          if (!this.isCurrentEntry(entry)) return null
          if (!entry.client.isConnected()) await this.recoverStaleTransport(entry, "canary disconnected")
          const recovered = this.servers.get(serverKey(owner, entry.name))
          if (!recovered || !this.isCurrentEntry(recovered) || !recovered.client.isConnected()) return null
          current = recovered
          return { result: recovered.client.refreshTools() }
        })
        if (!refresh) {
          results.push({ server: entry.name, ok: false, detail: "disconnected after recovery attempt" })
          continue
        }
        const tools = await refresh.result
        const updated = await this.enqueue(() => {
          if (!this.isCurrentEntry(current)) return false
          current.cachedTools = structuredClone(tools)
          current.consecutiveFailures = 0
          return true
        })
        results.push({
          server: entry.name, ok: updated,
          detail: updated ? `${tools.length} tools listed` : "server changed during canary",
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (isMcpTransportError(error)) {
          await this.enqueue(async () => {
            if (this.isCurrentEntry(current)) await this.recoverStaleTransport(current, reason)
          })
        }
        results.push({ server: entry.name, ok: false, detail: reason })
      }
    }
    return results
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // Publish closing before queued cleanup so pending network work cannot revive clients.
    this.shutdownPromise = this.enqueue(() => {
      emitNervesEvent({
        event: "mcp.manager_end", component: "repertoire",
        message: "shutting down MCP manager", meta: { serverCount: this.servers.size },
      })
      for (const entry of [...this.servers.values()]) this.removeEntry(entry)
      this.desiredGenerations.clear()
    })
    return this.shutdownPromise
  }

  private ownedEntries(owner: McpOwner): ServerEntry[] {
    return [...this.servers.values()].filter((entry) => sameOwner(entry.owner, owner))
  }

  private isCurrentEntry(entry: ServerEntry): boolean {
    const key = serverKey(entry.owner, entry.name)
    return !this.shutdownPromise && this.servers.get(key) === entry
      && this.desiredGenerations.get(key) === entry.generation
  }

  private freezeView(owner: McpOwner): McpTurnView {
    const entries = this.ownedEntries(owner).filter((entry) => this.isCurrentEntry(entry)).map((entry) => Object.freeze({
      server: entry.name, source: entry.source, pluginId: entry.pluginId,
      configDigest: entry.configDigest, generation: entry.generation,
      tools: freezeToolValue(structuredClone(entry.cachedTools)),
    }))
    return Object.freeze({ manager: this, owner, entries: Object.freeze(entries) })
  }

  private matchesBinding(entry: ServerEntry, binding: McpToolBinding, owner: McpOwner): boolean {
    if (binding.manager !== this || !sameOwner(binding, owner) || !sameOwner(entry.owner, owner)
      || !this.isCurrentEntry(entry) || entry.name !== binding.server
      || entry.source !== binding.source || entry.pluginId !== binding.pluginId
      || entry.configDigest !== binding.configDigest || entry.generation !== binding.generation) return false
    const tools = entry.cachedTools.filter((tool) => tool.name === binding.rawName)
    if (tools.length !== 1) return false
    const schema = mcpToolSchema({ server: entry.name, pluginId: entry.pluginId }, tools[0])
    return schema.function.name === binding.surfacedName && digestJson(schema) === binding.schemaDigest
  }

  private currentBinding(binding: McpToolBinding, owner: McpOwner): ServerEntry {
    const entry = this.servers.get(serverKey(owner, binding.server))
    if (!entry || !this.matchesBinding(entry, binding, owner)) {
      emitNervesEvent({
        level: "warn", event: "mcp.tool_rejected", component: "repertoire",
        message: "MCP tool binding is no longer current", meta: { reason: "stale or unavailable owned tool" },
      })
      throw new McpCallRejectedError("MCP tool binding is stale or unavailable")
    }
    return entry
  }

  private removeEntry(entry: ServerEntry): void {
    const key = serverKey(entry.owner, entry.name)
    this.desiredGenerations.delete(key)
    if (entry.restartTimer) clearTimeout(entry.restartTimer)
    entry.client.shutdown()
    this.servers.delete(key)
  }

  private async applyDesired(owner: McpOwner, desired: Map<string, DesiredServer>): Promise<void> {
    for (const [name, requested] of desired) {
      if (this.shutdownPromise) return
      const descriptor = { ...requested, config: structuredClone(requested.config) }
      const configDigest = configurationDigest(owner, descriptor)
      const current = this.servers.get(serverKey(owner, name))
      if (current && this.isCurrentEntry(current) && current.configDigest === configDigest) continue
      if (current) {
        emitNervesEvent({
          event: "mcp.server_changed", component: "repertoire",
          message: `reconnecting changed MCP server: ${name}`, meta: { server: name },
        })
        this.removeEntry(current)
      } else {
        emitNervesEvent({
          event: "mcp.server_added", component: "repertoire",
          message: `connecting new MCP server: ${name}`, meta: { server: name },
        })
      }
      await this.connectServer({
        ...descriptor, owner, name, configDigest, generation: ++this.nextGeneration, consecutiveFailures: 0,
      })
    }
    for (const entry of this.ownedEntries(owner)) {
      if (desired.has(entry.name)) continue
      emitNervesEvent({
        event: "mcp.server_removed", component: "repertoire",
        message: `disconnecting removed MCP server: ${entry.name}`, meta: { server: entry.name },
      })
      this.removeEntry(entry)
    }
  }

  private async resolveVaultEnv(env: Record<string, string>, owner: McpOwner): Promise<Record<string, string>> {
    const resolved = { ...env }
    if (!Object.values(resolved).some((value) => /^vault:/.test(value))) return resolved
    const store = getCredentialStore(owner.agentName)
    for (const [key, value] of Object.entries(resolved)) {
      const match = value.match(/^vault:([^/]+)\/(.+)$/)
      if (!match) continue
      const [, domain, field] = match
      try {
        resolved[key] = await store.getRawSecret(domain, field)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const classification = reason.includes("no credential found") ? "item not found"
          : reason.includes("field") && reason.includes("not found") ? "field empty" : "vault unreachable"
        throw new Error(`vault:${domain}/${field} could not be resolved: ${classification}`)
      }
    }
    return resolved
  }

  private async connectServer(desired: Omit<ServerEntry, "client" | "cachedTools" | "restartTimer">): Promise<void> {
    const key = serverKey(desired.owner, desired.name)
    this.desiredGenerations.set(key, desired.generation)
    let config = desired.config
    if (config.env) {
      try {
        config = { ...config, env: await this.resolveVaultEnv(config.env, desired.owner) }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        emitNervesEvent({
          level: "error", event: "mcp.vault_resolve_error", component: "repertoire",
          message: `skipping MCP server "${desired.name}": ${reason}`, meta: { server: desired.name, reason },
        })
        this.desiredGenerations.delete(key)
        return
      }
    }
    if (this.shutdownPromise || this.desiredGenerations.get(key) !== desired.generation) return
    const client = new McpClient(config)
    const entry: ServerEntry = { ...desired, client, cachedTools: [] }
    this.servers.set(key, entry)
    client.onClose(() => { this.enqueueBackground(() => this.handleServerCrash(entry)) })
    try {
      await client.connect()
      if (!this.isCurrentEntry(entry)) {
        client.shutdown()
        return
      }
      const tools = await client.listTools()
      if (!this.isCurrentEntry(entry)) {
        client.shutdown()
        return
      }
      entry.cachedTools = structuredClone(tools)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      emitNervesEvent({
        level: "error", event: "mcp.connect_error", component: "repertoire",
        message: `failed to connect MCP server "${desired.name}"`,
        meta: { server: desired.name, reason },
      })
    }
  }

  private handleServerCrash(entry: ServerEntry): void {
    if (!this.isCurrentEntry(entry) || entry.restartTimer) return
    entry.consecutiveFailures++
    if (entry.consecutiveFailures > MAX_RESTART_RETRIES) {
      emitNervesEvent({
        level: "error", event: "mcp.connect_error", component: "repertoire",
        message: `MCP server "${entry.name}" exceeded max restart retries`,
        meta: { server: entry.name, failures: entry.consecutiveFailures },
      })
      return
    }
    emitNervesEvent({
      level: "warn", event: "mcp.server_restart", component: "repertoire",
      message: `restarting crashed MCP server: ${entry.name}`,
      meta: { server: entry.name, attempt: entry.consecutiveFailures },
    })
    entry.restartTimer = setTimeout(() => {
      this.enqueueBackground(async () => {
        if (!this.isCurrentEntry(entry)) return
        delete entry.restartTimer
        await this.restartServer(entry)
      })
    }, RESTART_DELAY_MS)
  }

  private async restartServer(entry: ServerEntry): Promise<void> {
    this.removeEntry(entry)
    await this.connectServer({
      owner: entry.owner, name: entry.name, config: entry.config,
      source: entry.source, pluginId: entry.pluginId,
      configDigest: entry.configDigest, generation: entry.generation,
      consecutiveFailures: entry.consecutiveFailures,
    })
  }

  private async recoverStaleTransport(entry: ServerEntry, reason: string): Promise<void> {
    emitNervesEvent({
      level: "warn", event: "mcp.transport_recovery", component: "repertoire",
      message: `recovering stale MCP transport: ${entry.name}`, meta: { server: entry.name, reason },
    })
    await this.restartServer(entry)
  }
}

let _sharedManager: McpManager | null = null

/** Every caller applies its own desired state and freezes its own view in the shared manager's lifecycle tail. */
export async function getSharedMcpManager(
  options: McpOwner & { runtimeServers?: RuntimeMcpServers },
): Promise<McpTurnView | null> {
  if (!isOwner(options)) {
    emitNervesEvent({
      level: "warn", event: "mcp.owner_invalid", component: "repertoire",
      message: "MCP requires an explicit owner", meta: { reason: "agent name and absolute root are required" },
    })
    return null
  }
  const manager = _sharedManager ??= new McpManager()
  return manager.reconcile(options, options.runtimeServers)
}

export async function releaseRuntimeMcpServers(owner: McpOwner): Promise<void> {
  if (_sharedManager) await _sharedManager.reconcile(owner)
}

export async function shutdownSharedMcpManager(): Promise<void> {
  const manager = _sharedManager
  if (!manager) return
  await manager.shutdown()
  if (_sharedManager === manager) _sharedManager = null
}

/** Reset for testing only. */
export async function resetSharedMcpManager(): Promise<void> {
  await shutdownSharedMcpManager()
}
