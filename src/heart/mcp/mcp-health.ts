import { emitNervesEvent } from "../../nerves/runtime"
import type { McpToolCallResultV1, McpToolInfo } from "../../repertoire/mcp-client"
import { sha256CanonicalJson } from "../runtime/canonical-json"
import type { SchemaBindingV1 } from "../habits/mcp-executors"

const IDENTIFIER = /^[a-z][a-z0-9-]*$/
const SHA256 = /^sha256:[0-9a-f]{64}$/

export interface McpHealthProfileV1 {
  schemaVersion: 1
  profileId: string
  serverId: string
  registryRevision: string
  expectedTools: Array<{
    name: string
    inputSchema: SchemaBindingV1
    outputSchema: SchemaBindingV1 | null
  }>
  credentialBindingNames: string[]
  mode: "inventory-schema-credential-readiness" | "read-only-tool"
  readOnlyProbe: null | {
    toolName: string
    input: Record<string, unknown>
    resultSchema: SchemaBindingV1
    sideEffects: "none"
  }
  timeoutMs: number
  freshnessMs: number
}

export interface McpHealthReceiptV1 {
  schemaVersion: 1
  receiptId: string
  profileId: string
  serverId: string
  registryRevision: string
  negotiatedProtocolVersion: string
  transportIdentitySha256: string
  inventoryRef: string
  inventorySha256: string
  observedTools: Array<{
    name: string
    inputSchemaSha256: string
    outputSchemaSha256: string | null
  }>
  credentialReadiness: Array<{
    bindingName: string
    state: "ready" | "missing" | "locked"
  }>
  probe: null | {
    toolName: string
    requestSha256: string
    resultRef: string
    resultSha256: string
    schemaValid: true
    sideEffects: "none"
  }
  effectfulToolInvoked: false
  checkedAt: string
  expiresAt: string
  disposition: "healthy" | "unhealthy"
}

export interface HealthValidationDeps {
  serverIds: Set<string>
  executorTools: Set<string>
  reconciliationTools: Set<string>
  registryRevision?: string
  resolveSchema(binding: SchemaBindingV1): Record<string, unknown>
}

export class McpHealthProfileRegistry {
  private readonly profiles: Map<string, McpHealthProfileV1>

  constructor(profiles: Map<string, McpHealthProfileV1>) {
    this.profiles = profiles
  }

  keys(): string[] {
    return Array.from(this.profiles.keys())
  }

  get(profileId: string): McpHealthProfileV1 {
    const profile = this.profiles.get(profileId)
    if (!profile) throw new Error(`Unknown MCP health profile: ${profileId}`)
    return structuredClone(profile)
  }
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`)
  return raw as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown.sort()[0]}`)
}

function validateBinding(raw: unknown, label: string, deps: HealthValidationDeps): SchemaBindingV1 {
  const binding = record(raw, label)
  exactKeys(binding, ["root", "ref", "sha256"], label)
  if (binding.root !== "bundle" && binding.root !== "package") throw new Error(`${label}.root is invalid`)
  if (typeof binding.ref !== "string" || binding.ref.length === 0) throw new Error(`${label}.ref is invalid`)
  if (typeof binding.sha256 !== "string" || !SHA256.test(binding.sha256)) throw new Error(`${label}.sha256 is invalid`)
  const resolved = deps.resolveSchema(binding as unknown as SchemaBindingV1)
  if (`sha256:${sha256CanonicalJson(resolved)}` !== binding.sha256) throw new Error(`${label} schema hash mismatch`)
  return binding as unknown as SchemaBindingV1
}

export function validateMcpHealthProfiles(raw: unknown, deps: HealthValidationDeps): McpHealthProfileRegistry {
  if (!Array.isArray(raw)) throw new Error("agent.json mcpHealthProfiles must be an array")
  const profiles = new Map<string, McpHealthProfileV1>()
  for (const [index, entry] of raw.entries()) {
    const label = `mcpHealthProfiles[${index}]`
    const value = record(entry, label)
    exactKeys(value, [
      "schemaVersion", "profileId", "serverId", "registryRevision", "expectedTools",
      "credentialBindingNames", "mode", "readOnlyProbe", "timeoutMs", "freshnessMs",
    ], label)
    if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`)
    if (typeof value.profileId !== "string" || !IDENTIFIER.test(value.profileId)) throw new Error(`${label}.profileId is invalid`)
    if (profiles.has(value.profileId)) throw new Error(`Duplicate MCP health profile: ${value.profileId}`)
    if (typeof value.serverId !== "string" || !deps.serverIds.has(value.serverId)) throw new Error(`${label}.serverId must name an existing server`)
    if (typeof value.registryRevision !== "string" || !SHA256.test(value.registryRevision)) throw new Error(`${label}.registryRevision is invalid`)
    if (deps.registryRevision !== undefined && value.registryRevision !== deps.registryRevision) throw new Error(`${label}.registryRevision does not match the executor registry`)
    if (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1_000 || (value.timeoutMs as number) > 60_000) throw new Error(`${label}.timeoutMs must be from 1000 through 60000`)
    if (!Number.isInteger(value.freshnessMs) || (value.freshnessMs as number) < 60_000 || (value.freshnessMs as number) > 3_600_000) throw new Error(`${label}.freshnessMs must be from 60000 through 3600000`)
    if (!Array.isArray(value.expectedTools)) throw new Error(`${label}.expectedTools must be an array`)
    const toolNames = new Set<string>()
    const expectedTools = value.expectedTools.map((rawTool, toolIndex) => {
      const toolLabel = `${label}.expectedTools[${toolIndex}]`
      const tool = record(rawTool, toolLabel)
      exactKeys(tool, ["name", "inputSchema", "outputSchema"], toolLabel)
      if (typeof tool.name !== "string" || tool.name.length === 0 || toolNames.has(tool.name)) throw new Error(`${toolLabel}.name is invalid or duplicate`)
      toolNames.add(tool.name)
      return {
        name: tool.name,
        inputSchema: validateBinding(tool.inputSchema, `${toolLabel}.inputSchema`, deps),
        outputSchema: tool.outputSchema === null ? null : validateBinding(tool.outputSchema, `${toolLabel}.outputSchema`, deps),
      }
    })
    if (!Array.isArray(value.credentialBindingNames)) throw new Error(`${label}.credentialBindingNames must be an array`)
    const credentialBindingNames: string[] = []
    const credentialSeen = new Set<string>()
    for (const name of value.credentialBindingNames) {
      if (typeof name !== "string" || !IDENTIFIER.test(name) || credentialSeen.has(name)) throw new Error(`${label}.credentialBindingNames contains an invalid or duplicate name`)
      credentialSeen.add(name)
      credentialBindingNames.push(name)
    }

    let readOnlyProbe: McpHealthProfileV1["readOnlyProbe"] = null
    if (value.mode === "inventory-schema-credential-readiness") {
      if (value.readOnlyProbe !== null) throw new Error(`${label} inventory mode cannot configure a probe`)
    } else if (value.mode === "read-only-tool") {
      const probe = record(value.readOnlyProbe, `${label}.readOnlyProbe`)
      exactKeys(probe, ["toolName", "input", "resultSchema", "sideEffects"], `${label}.readOnlyProbe`)
      if (typeof probe.toolName !== "string") throw new Error(`${label}.readOnlyProbe.toolName must be a string`)
      const coordinate = `${value.serverId}/${probe.toolName}`
      if (deps.executorTools.has(coordinate)) throw new Error(`${label}.readOnlyProbe cannot invoke an effectful executor tool`)
      if (deps.reconciliationTools.has(coordinate)) throw new Error(`${label}.readOnlyProbe cannot invoke a reconciliation tool`)
      if (!toolNames.has(probe.toolName)) throw new Error(`${label}.readOnlyProbe.toolName must name an expected tool`)
      if (probe.sideEffects !== "none") throw new Error(`${label}.readOnlyProbe.sideEffects must be none`)
      readOnlyProbe = {
        toolName: probe.toolName,
        input: record(probe.input, `${label}.readOnlyProbe.input`),
        resultSchema: validateBinding(probe.resultSchema, `${label}.readOnlyProbe.resultSchema`, deps),
        sideEffects: "none",
      }
    } else {
      throw new Error(`${label}.mode is invalid`)
    }
    const profile: McpHealthProfileV1 = {
      schemaVersion: 1,
      profileId: value.profileId,
      serverId: value.serverId,
      registryRevision: value.registryRevision,
      expectedTools,
      credentialBindingNames,
      mode: value.mode,
      readOnlyProbe,
      timeoutMs: value.timeoutMs as number,
      freshnessMs: value.freshnessMs as number,
    }
    profiles.set(profile.profileId, profile)
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.mcp_health_profiles_validated",
    message: "validated generic MCP health profile registry",
    meta: { count: profiles.size },
  })
  return new McpHealthProfileRegistry(profiles)
}

export interface HealthRunDeps {
  now(): Date
  inventory(): Promise<{
    negotiatedProtocolVersion: string
    transportIdentitySha256: string
    tools: McpToolInfo[]
  }>
  credentialState(bindingName: string): "ready" | "missing" | "locked"
  callReadOnlyTool(serverId: string, toolName: string, input: Record<string, unknown>, timeoutMs: number): Promise<McpToolCallResultV1>
  validateResult(binding: SchemaBindingV1, value: unknown): void
  persistEvidence(kind: string, value: unknown): { ref: string; sha256: string }
}

function observedTools(tools: McpToolInfo[]): McpHealthReceiptV1["observedTools"] {
  return tools.map((tool) => ({
    name: tool.name,
    inputSchemaSha256: `sha256:${sha256CanonicalJson(tool.inputSchema)}`,
    outputSchemaSha256: tool.outputSchema === undefined ? null : `sha256:${sha256CanonicalJson(tool.outputSchema)}`,
  }))
}

function inventoryMatches(profile: McpHealthProfileV1, observed: McpHealthReceiptV1["observedTools"]): boolean {
  if (observed.length !== profile.expectedTools.length) return false
  return profile.expectedTools.every((expected) => observed.some((tool) =>
    tool.name === expected.name
    && tool.inputSchemaSha256 === expected.inputSchema.sha256
    && tool.outputSchemaSha256 === (expected.outputSchema?.sha256 ?? null),
  ))
}

export async function runMcpHealthProfile(profile: McpHealthProfileV1, deps: HealthRunDeps): Promise<McpHealthReceiptV1> {
  const checkedAtDate = deps.now()
  const checkedAt = checkedAtDate.toISOString()
  const expiresAt = new Date(checkedAtDate.getTime() + profile.freshnessMs).toISOString()
  const inventory = await deps.inventory()
  const observed = observedTools(inventory.tools)
  const inventoryEvidence = deps.persistEvidence("inventory", observed)
  const credentialReadiness = profile.credentialBindingNames.map((bindingName) => ({
    bindingName,
    state: deps.credentialState(bindingName),
  }))
  let healthy = inventoryMatches(profile, observed)
    && credentialReadiness.every((credential) => credential.state === "ready")
  let probe: McpHealthReceiptV1["probe"] = null

  if (profile.mode === "read-only-tool" && profile.readOnlyProbe) {
    try {
      const result = await deps.callReadOnlyTool(
        profile.serverId,
        profile.readOnlyProbe.toolName,
        profile.readOnlyProbe.input,
        profile.timeoutMs,
      )
      if (result.isError === true || !result.structuredContent) throw new Error("read-only health probe returned no valid structured content")
      deps.validateResult(profile.readOnlyProbe.resultSchema, result.structuredContent)
      const evidence = deps.persistEvidence("probe-result", result.structuredContent)
      probe = {
        toolName: profile.readOnlyProbe.toolName,
        requestSha256: `sha256:${sha256CanonicalJson(profile.readOnlyProbe.input)}`,
        resultRef: evidence.ref,
        resultSha256: evidence.sha256,
        schemaValid: true,
        sideEffects: "none",
      }
    } catch {
      healthy = false
    }
  }

  const authority = {
    schemaVersion: 1 as const,
    profileId: profile.profileId,
    serverId: profile.serverId,
    registryRevision: profile.registryRevision,
    negotiatedProtocolVersion: inventory.negotiatedProtocolVersion,
    transportIdentitySha256: inventory.transportIdentitySha256,
    inventoryRef: inventoryEvidence.ref,
    inventorySha256: inventoryEvidence.sha256,
    observedTools: observed,
    credentialReadiness,
    probe,
    effectfulToolInvoked: false as const,
    checkedAt,
    expiresAt,
    disposition: healthy ? "healthy" as const : "unhealthy" as const,
  }
  const receipt: McpHealthReceiptV1 = {
    ...authority,
    receiptId: `sha256:${sha256CanonicalJson(authority)}`,
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.mcp_health_profile_checked",
    message: "checked generic MCP health profile",
    meta: { profileId: profile.profileId, disposition: receipt.disposition },
  })
  return receipt
}

export function isMcpHealthReceiptFresh(receipt: McpHealthReceiptV1, now: Date): boolean {
  return receipt.disposition === "healthy"
    && Number.isFinite(Date.parse(receipt.expiresAt))
    && now.getTime() < Date.parse(receipt.expiresAt)
}
