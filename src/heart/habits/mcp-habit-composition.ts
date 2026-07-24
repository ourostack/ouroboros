import { randomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { McpManager, McpServerCompositionInventory } from "../../repertoire/mcp-manager"
import { createMcpInternalExecutorAuthority } from "../../repertoire/mcp-manager"
import type { AgentConfig } from "../identity"
import {
  readMachineRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
} from "../runtime-credentials"
import { sha256CanonicalJson } from "../runtime/canonical-json"
import {
  AdapterDiagnosticsRegistry,
  writeAdapterDiagnosticProjection,
  type HabitAdapterDiagnosticProjectionV1,
} from "./adapter-diagnostics"
import {
  resolveHabitMcpToolExecutors,
  resolveSchemaBinding,
  validateJsonSchemaValue,
  type HabitCredentialBindingV1,
  type ResolvedHabitMcpToolExecutor,
  type SchemaBindingV1,
} from "./mcp-executors"
import { createMcpToolHabitAdapter } from "./mcp-tool-adapter"
import {
  runMcpHealthProfile,
  validateMcpHealthProfiles,
  type McpHealthReceiptV1,
} from "../mcp/mcp-health"

export interface McpHabitAdapterComposition {
  adapter: ReturnType<typeof createMcpToolHabitAdapter>
  configRevision: string
  ensureHealthy(): Promise<boolean>
}

type EvidenceFileSystem = Pick<typeof fs,
  "mkdirSync" | "existsSync" | "lstatSync" | "readFileSync" | "openSync" | "writeFileSync"
  | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync">

export interface ComposeMcpHabitAdapterInput {
  agent: string
  bundleRoot: string
  packageSchemaRoot: string
  config: AgentConfig
  manager: McpManager
  diagnostics: AdapterDiagnosticsRegistry
  readFile?: (filePath: string) => string
  now?: () => Date
  evidenceFileSystem?: EvidenceFileSystem
}

function pointerSegments(pointer: string): string[] {
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function credentialResult(
  agent: string,
  binding: HabitCredentialBindingV1,
): RuntimeCredentialConfigReadResult {
  return binding.source.scope === "agent-runtime-config"
    ? readRuntimeCredentialConfig(agent)
    : readMachineRuntimeCredentialConfig(agent)
}

function readCredential(agent: string, binding: HabitCredentialBindingV1):
  | { state: "ready"; value: unknown }
  | { state: "missing" | "locked" } {
  const result = credentialResult(agent, binding)
  if (!result.ok) return { state: result.reason === "missing" ? "missing" : "locked" }
  let current: unknown = result.config
  for (const segment of pointerSegments(binding.source.jsonPointer)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return { state: "missing" }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current === undefined || current === null ? { state: "missing" } : { state: "ready", value: current }
}

function writeEvidence(
  bundleRoot: string,
  kind: string,
  value: unknown,
  fileSystem: EvidenceFileSystem = fs,
): { ref: string; sha256: string } {
  const sha256 = `sha256:${sha256CanonicalJson(value)}`
  const relative = path.join("state", "habits", "mcp-health", "evidence", `${kind}-${sha256.slice(7)}.json`)
  const target = path.join(bundleRoot, relative)
  fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  if (fileSystem.existsSync(target)) {
    const stat = fileSystem.lstatSync(target)
    if (!stat.isFile()) throw new Error(`MCP health evidence target is not a regular file: ${relative}`)
    let existing: unknown
    try {
      existing = JSON.parse(fileSystem.readFileSync(target, "utf8"))
    } catch (error) {
      throw new Error(`MCP health evidence is unreadable: ${relative}`, { cause: error })
    }
    if (`sha256:${sha256CanonicalJson(existing)}` !== sha256) throw new Error(`MCP health evidence hash mismatch: ${relative}`)
    return { ref: relative, sha256 }
  }
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    const fd = fileSystem.openSync(temporary, "wx", 0o600)
    try {
      fileSystem.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8")
      fileSystem.fsyncSync(fd)
    } finally {
      fileSystem.closeSync(fd)
    }
    fileSystem.renameSync(temporary, target)
    const directoryFd = fileSystem.openSync(path.dirname(target), "r")
    try {
      fileSystem.fsyncSync(directoryFd)
    } finally {
      fileSystem.closeSync(directoryFd)
    }
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary)
  }
  return { ref: relative, sha256 }
}

function persistHealthReceipt(
  bundleRoot: string,
  receipt: McpHealthReceiptV1,
  fileSystem?: ComposeMcpHabitAdapterInput["evidenceFileSystem"],
): { ref: string; sha256: string } {
  return writeEvidence(bundleRoot, `receipt-${receipt.profileId}`, receipt, fileSystem)
}

function bindingKey(serverId: string, bindingName: string): string {
  return `${serverId}\u0000${bindingName}`
}

function sameJson(left: unknown, right: unknown): boolean {
  return sha256CanonicalJson(left) === sha256CanonicalJson(right)
}

function assertExecutorInventory(executor: ResolvedHabitMcpToolExecutor, inventory: McpServerCompositionInventory): void {
  const invocation = inventory.tools.filter((tool) => tool.name === executor.definition.toolName)
  if (invocation.length !== 1
    || !sameJson(invocation[0].inputSchema, executor.toolInputSchema.value)
    || invocation[0].outputSchema === undefined
    || !sameJson(invocation[0].outputSchema, executor.resultSchema.value)) {
    throw new Error(`Fresh MCP inventory does not match executor ${executor.definition.id}`)
  }
  if (executor.definition.reconciliation && executor.reconciliation) {
    const reconciliation = inventory.tools.filter((tool) => tool.name === executor.definition.reconciliation!.toolName)
    if (reconciliation.length !== 1
      || !sameJson(reconciliation[0].inputSchema, executor.reconciliation.toolInputSchema.value)
      || reconciliation[0].outputSchema === undefined
      || !sameJson(reconciliation[0].outputSchema, executor.reconciliation.resultSchema.value)) {
      throw new Error(`Fresh MCP inventory does not match reconciliation for ${executor.definition.id}`)
    }
  }
}

export async function composeMcpHabitAdapter(input: ComposeMcpHabitAdapterInput): Promise<McpHabitAdapterComposition | null> {
  const definitions = input.config.habitExecutors ?? []
  if (definitions.length === 0) return null
  const readFile = input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"))
  const serverIds = [...new Set(definitions.map((definition) => definition.serverId))]
  const inventories = new Map<string, McpServerCompositionInventory>()
  for (const serverId of serverIds) {
    inventories.set(serverId, await input.manager.refreshServerInventoryForComposition(serverId))
  }
  const resolveDeps = {
    bundleRoot: input.bundleRoot,
    packageSchemaRoot: input.packageSchemaRoot,
    mcpServers: input.config.mcpServers ?? {},
    inventoryByServer: Object.fromEntries([...inventories].map(([serverId, inventory]) => [serverId, inventory.tools])),
    readFile,
  }
  const registry = resolveHabitMcpToolExecutors(definitions, resolveDeps)
  const authorities = new Map<string, ReturnType<typeof createMcpInternalExecutorAuthority>>()
  const authorityList: ReturnType<typeof createMcpInternalExecutorAuthority>[] = []
  const authorityCoordinates: Array<{ executorId: string; serverId: string; toolName: string }> = []
  const credentialBindings = new Map<string, HabitCredentialBindingV1>()
  const executorTools = new Set<string>()
  const reconciliationTools = new Set<string>()
  for (const executorId of registry.keys()) {
    const executor = registry.get(executorId)
    const coordinates = [{ toolName: executor.definition.toolName, reconciliation: false }]
    if (executor.definition.reconciliation) {
      coordinates.push({ toolName: executor.definition.reconciliation.toolName, reconciliation: true })
    }
    for (const coordinate of coordinates) {
      authorityCoordinates.push({
        executorId,
        serverId: executor.definition.serverId,
        toolName: coordinate.toolName,
      })
      const toolCoordinate = `${executor.definition.serverId}/${coordinate.toolName}`
      if (coordinate.reconciliation) reconciliationTools.add(toolCoordinate)
      else executorTools.add(toolCoordinate)
    }
    for (const binding of executor.definition.credentialBindings) {
      const key = bindingKey(executor.definition.serverId, binding.name)
      const existing = credentialBindings.get(key)
      if (existing && !sameJson(existing.source, binding.source)) throw new Error(`Ambiguous MCP credential binding: ${binding.name}`)
      credentialBindings.set(key, binding)
    }
  }

  const healthRegistry = validateMcpHealthProfiles(input.config.mcpHealthProfiles ?? [], {
    serverIds: new Set(Object.keys(input.config.mcpServers!)),
    executorTools,
    reconciliationTools,
    registryRevision: registry.revision,
    resolveSchema: (binding: SchemaBindingV1) => resolveSchemaBinding(binding, "mcpHealthProfiles schema", resolveDeps).value,
  })
  if (healthRegistry.keys().length === 0) throw new Error("MCP habit executors require at least one matching health profile")
  const healthProfiles = healthRegistry.keys().map((profileId) => healthRegistry.get(profileId))
  for (const serverId of serverIds) {
    const serverProfiles = healthProfiles.filter((profile) => profile.serverId === serverId)
    if (serverProfiles.length === 0) throw new Error(`MCP executor server ${serverId} requires a matching health profile`)
    const declaredCredentialNames = new Set(serverProfiles.flatMap((profile) => profile.credentialBindingNames))
    const requiredCredentialNames = new Set(
      definitions
        .filter((definition) => definition.serverId === serverId)
        .flatMap((definition) => definition.credentialBindings.map((binding) => binding.name)),
    )
    for (const name of declaredCredentialNames) {
      if (!credentialBindings.has(bindingKey(serverId, name))) {
        throw new Error(`MCP health profile names unknown credential binding ${name} for ${serverId}`)
      }
    }
    for (const name of requiredCredentialNames) {
      if (!declaredCredentialNames.has(name)) {
        throw new Error(`MCP health profile for ${serverId} must cover credential binding ${name}`)
      }
    }
  }
  for (const coordinate of authorityCoordinates) {
    const authority = createMcpInternalExecutorAuthority({
      ...coordinate,
      registryRevision: registry.revision,
      randomBytes,
    })
    authorityList.push(authority)
    authorities.set(`${coordinate.executorId}\u0000${coordinate.toolName}`, authority)
  }
  input.manager.replaceInternalExecutorAuthorities(`habit-executors:${input.agent}`, authorityList)

  let healthyUntil = 0
  const replaceDiagnostics = (projection: HabitAdapterDiagnosticProjectionV1): void => {
    input.diagnostics.replace(projection)
    writeAdapterDiagnosticProjection(input.bundleRoot, projection)
  }
  const ensureHealthy = async (): Promise<boolean> => {
    const now = (input.now ?? (() => new Date()))()
    if (now.getTime() < healthyUntil) return true
    const receipts: McpHealthReceiptV1[] = []
    let receiptEvidence: Array<{ ref: string; sha256: string }> = []
    try {
      for (const profileId of healthRegistry.keys()) {
        const profile = healthRegistry.get(profileId)
        const receipt = await runMcpHealthProfile(profile, {
          now: () => now,
          inventory: () => input.manager.refreshServerInventoryForComposition(profile.serverId),
          credentialState: (bindingName) => {
            const binding = credentialBindings.get(bindingKey(profile.serverId, bindingName))!
            return readCredential(input.agent, binding).state
          },
          callReadOnlyTool: (serverId, toolName, argumentsValue, timeoutMs) => input.manager.callReadOnlyHealthTool({
            serverId,
            toolName,
            arguments: argumentsValue,
            timeoutMs,
          }),
          validateResult: (binding, value) => {
            const schema = resolveSchemaBinding(binding, "MCP health result", resolveDeps)
            validateJsonSchemaValue(value, schema.value, "MCP health result")
          },
          persistEvidence: (kind, value) => writeEvidence(input.bundleRoot, kind, value, input.evidenceFileSystem),
        })
        receipts.push(receipt)
      }
      receiptEvidence = receipts.map((receipt) => persistHealthReceipt(input.bundleRoot, receipt, input.evidenceFileSystem))
    } catch (error) {
      replaceDiagnostics({
        schemaVersion: 1,
        adapter: { id: "mcp-tool", version: 1 },
        status: "blocked",
        evidence: [],
        blockers: [{
          code: "mcp_health_unavailable",
          actor: "agent-runnable",
          message: error instanceof Error ? error.message : String(error),
        }],
        observedAt: now.toISOString(),
        expiresAt: now.toISOString(),
      })
      return false
    }
    const healthy = receipts.every((receipt) => receipt.disposition === "healthy" && now.getTime() < Date.parse(receipt.expiresAt))
    healthyUntil = healthy ? Math.min(...receipts.map((receipt) => Date.parse(receipt.expiresAt))) : 0
    replaceDiagnostics({
      schemaVersion: 1,
      adapter: { id: "mcp-tool", version: 1 },
      status: healthy ? "healthy" : "blocked",
      evidence: receiptEvidence.map((evidence) => ({ ref: evidence.ref, sha256: evidence.sha256.slice(7) })),
      blockers: healthy ? [] : [{
        code: "mcp_health_unhealthy",
        actor: "agent-runnable",
        message: "A configured MCP health profile is stale, mismatched, or unavailable.",
      }],
      observedAt: now.toISOString(),
      expiresAt: healthy ? new Date(healthyUntil).toISOString() : now.toISOString(),
    })
    return healthy
  }

  const adapter = createMcpToolHabitAdapter({
    registry,
    authorityFor: (executorId, toolName) => {
      return authorities.get(`${executorId}\u0000${toolName}`)!
    },
    refreshExecutor: async (executor) => {
      const inventory = await input.manager.refreshServerInventoryForComposition(executor.definition.serverId)
      assertExecutorInventory(executor, inventory)
    },
    callInternalTool: (request) => input.manager.callInternalTool(request),
    readCredential: (binding) => readCredential(input.agent, binding),
  })
  emitNervesEvent({
    component: "heart",
    event: "heart.mcp_habit_adapter_composed",
    message: "composed generic MCP habit adapter for an agent",
    meta: { agent: input.agent, registryRevision: registry.revision, executors: registry.keys().length },
  })
  return {
    adapter,
    configRevision: `sha256:${sha256CanonicalJson({
      mcpServers: input.config.mcpServers,
      habitExecutors: definitions,
      mcpHealthProfiles: input.config.mcpHealthProfiles,
    })}`,
    ensureHealthy,
  }
}
