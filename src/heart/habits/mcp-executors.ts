import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { McpServerConfig } from "../identity"
import { canonicalizeJson, sha256CanonicalJson } from "../runtime/canonical-json"
import type { McpToolInfo } from "../../repertoire/mcp-client"

const IDENTIFIER = /^[a-z][a-z0-9-]*$/
const SHA256 = /^sha256:[0-9a-f]{64}$/

export interface SchemaBindingV1 {
  root: "bundle" | "package"
  ref: string
  sha256: string
}

export interface HabitCredentialBindingV1 {
  name: string
  source: {
    scope: "agent-runtime-config" | "machine-runtime-config"
    jsonPointer: string
  }
}

export interface HabitMcpToolExecutorV1 {
  version: 1
  id: string
  serverId: string
  toolName: string
  habitInputSchema: SchemaBindingV1
  toolInputSchema: SchemaBindingV1
  resultSchema: SchemaBindingV1
  timeoutMs: number
  idempotencyField: "ouroOccurrence"
  credentialBindings: HabitCredentialBindingV1[]
  reconciliation: null | {
    toolName: string
    toolInputSchema: SchemaBindingV1
    resultSchema: SchemaBindingV1
  }
}

export interface ResolvedSchemaBinding {
  definition: SchemaBindingV1
  filePath: string
  value: Record<string, unknown>
}

export interface ResolvedHabitMcpToolExecutor {
  definition: HabitMcpToolExecutorV1
  habitInputSchema: ResolvedSchemaBinding
  toolInputSchema: ResolvedSchemaBinding
  resultSchema: ResolvedSchemaBinding
  reconciliation: null | {
    toolInputSchema: ResolvedSchemaBinding
    resultSchema: ResolvedSchemaBinding
  }
}

export class ResolvedHabitMcpToolExecutorRegistry {
  readonly revision: string
  private readonly executors: Map<string, ResolvedHabitMcpToolExecutor>

  constructor(revision: string, executors: Map<string, ResolvedHabitMcpToolExecutor>) {
    this.revision = revision
    this.executors = executors
  }

  get(id: string): ResolvedHabitMcpToolExecutor {
    const executor = this.executors.get(id)
    if (!executor) throw new Error(`Unknown habit MCP executor: ${id}`)
    return executor
  }

  keys(): string[] {
    return Array.from(this.executors.keys())
  }
}

interface ResolveDeps {
  bundleRoot: string
  packageSchemaRoot: string
  mcpServers: Record<string, McpServerConfig>
  inventoryByServer: Record<string, McpToolInfo[]>
  readFile(filePath: string): string
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`)
  return raw as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown.sort()[0]}`)
}

function parseJsonPointer(pointer: string, label: string): string[] {
  if (!pointer.startsWith("/")) throw new Error(`${label} JSON Pointer must be absolute`)
  return pointer.slice(1).split("/").map((segment) => {
    if (/~(?![01])/u.test(segment)) throw new Error(`${label} JSON Pointer escape is invalid`)
    return segment.replace(/~1/g, "/").replace(/~0/g, "~")
  })
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let current = root
  for (const segment of parseJsonPointer(pointer, "$ref")) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function validateLocalRefs(schema: Record<string, unknown>): void {
  const edges = new Map<string, string[]>()
  const walk = (value: unknown, location: string): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${location}/${index}`))
      return
    }
    const object = value as Record<string, unknown>
    if ("$ref" in object) {
      if (typeof object.$ref !== "string" || !object.$ref.startsWith("#/")) throw new Error("Remote or cross-root JSON Schema $ref is forbidden")
      const pointer = object.$ref.slice(1)
      if (resolvePointer(schema, pointer) === undefined) throw new Error(`Unresolved JSON Schema $ref: ${object.$ref}`)
      const targets = edges.get(location) ?? []
      targets.push(pointer)
      edges.set(location, targets)
    }
    for (const [key, child] of Object.entries(object)) walk(child, `${location}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)
  }
  walk(schema, "")

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (location: string): void => {
    if (visiting.has(location)) throw new Error(`Cyclic JSON Schema $ref at #${location}`)
    if (visited.has(location)) return
    visiting.add(location)
    for (const target of edges.get(location)!) {
      const targetValue = resolvePointer(schema, target)
      if (targetValue && typeof targetValue === "object") {
        const targetEdges = edges.get(target) ?? []
        if (targetEdges.length > 0) visit(target)
      }
    }
    visiting.delete(location)
    visited.add(location)
  }
  for (const location of edges.keys()) visit(location)
}

export function resolveSchemaBinding(bindingRaw: unknown, label: string, deps: ResolveDeps): ResolvedSchemaBinding {
  const binding = record(bindingRaw, label)
  exactKeys(binding, ["root", "ref", "sha256"], label)
  if (binding.root !== "bundle" && binding.root !== "package") throw new Error(`${label}.root must be bundle or package`)
  if (typeof binding.ref !== "string" || binding.ref.length === 0 || path.isAbsolute(binding.ref) || /^[a-z][a-z0-9+.-]*:/i.test(binding.ref)) {
    throw new Error(`${label}.ref must be a confined relative schema path; remote refs are forbidden`)
  }
  if (typeof binding.sha256 !== "string" || !SHA256.test(binding.sha256)) throw new Error(`${label}.sha256 is invalid`)
  const root = path.resolve(binding.root === "bundle" ? deps.bundleRoot : deps.packageSchemaRoot)
  const filePath = path.resolve(root, binding.ref)
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error(`${label}.ref escapes its confined schema root`)
  let parsed: unknown
  try {
    parsed = JSON.parse(deps.readFile(filePath))
  } catch (error) {
    throw new Error(`${label} schema is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = record(parsed, `${label} schema`)
  const actualHash = `sha256:${sha256CanonicalJson(value)}`
  if (actualHash !== binding.sha256) throw new Error(`${label} schema hash mismatch`)
  validateLocalRefs(value)
  return {
    definition: binding as unknown as SchemaBindingV1,
    filePath,
    value,
  }
}

function parseCredentialBindings(raw: unknown, label: string): HabitCredentialBindingV1[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const value = record(entry, `${label}[${index}]`)
    exactKeys(value, ["name", "source"], `${label}[${index}]`)
    if (typeof value.name !== "string" || !IDENTIFIER.test(value.name)) throw new Error(`${label}[${index}].name is not a valid identifier`)
    if (seen.has(value.name)) throw new Error(`Duplicate credential binding name: ${value.name}`)
    seen.add(value.name)
    const source = record(value.source, `${label}[${index}].source`)
    exactKeys(source, ["scope", "jsonPointer"], `${label}[${index}].source`)
    if (source.scope !== "agent-runtime-config" && source.scope !== "machine-runtime-config") throw new Error(`${label}[${index}].source.scope is invalid`)
    if (typeof source.jsonPointer !== "string") throw new Error(`${label}[${index}].source.jsonPointer must be a string`)
    parseJsonPointer(source.jsonPointer, `${label}[${index}].source`)
    return {
      name: value.name,
      source: { scope: source.scope, jsonPointer: source.jsonPointer },
    }
  })
}

function listedTool(inventory: McpToolInfo[], name: string, label: string): McpToolInfo {
  const matches = inventory.filter((tool) => tool.name === name)
  if (matches.length !== 1) throw new Error(`${label} tool is absent or duplicated in fresh inventory: ${name}`)
  return matches[0]
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right)
}

export function resolveHabitMcpToolExecutors(raw: unknown, deps: ResolveDeps): ResolvedHabitMcpToolExecutorRegistry {
  if (!Array.isArray(raw)) throw new Error("agent.json habitExecutors must be an array of entries")
  const definitions: HabitMcpToolExecutorV1[] = []
  const executors = new Map<string, ResolvedHabitMcpToolExecutor>()

  for (const [index, entry] of raw.entries()) {
    const label = `habitExecutors[${index}]`
    const value = record(entry, label)
    exactKeys(value, [
      "version", "id", "serverId", "toolName", "habitInputSchema", "toolInputSchema",
      "resultSchema", "timeoutMs", "idempotencyField", "credentialBindings", "reconciliation",
    ], label)
    if (value.version !== 1) throw new Error(`${label}.version must be 1`)
    if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) throw new Error(`${label}.id is not a valid identifier`)
    if (executors.has(value.id)) throw new Error(`Duplicate habit executor id: ${value.id}`)
    if (typeof value.serverId !== "string" || !deps.mcpServers[value.serverId]) throw new Error(`${label}.serverId must name an existing MCP server`)
    if ((deps.mcpServers[value.serverId].visibility ?? "agent") !== "internal") throw new Error(`${label}.serverId must name an internal MCP server`)
    if (typeof value.toolName !== "string" || value.toolName.length === 0) throw new Error(`${label}.toolName must be a non-empty string`)
    if (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1_000 || (value.timeoutMs as number) > 900_000) throw new Error(`${label}.timeoutMs must be an integer from 1000 through 900000`)
    if (value.idempotencyField !== "ouroOccurrence") throw new Error(`${label}.idempotencyField must be ouroOccurrence`)

    const habitInput = resolveSchemaBinding(value.habitInputSchema, `${label}.habitInputSchema`, deps)
    const toolInput = resolveSchemaBinding(value.toolInputSchema, `${label}.toolInputSchema`, deps)
    const result = resolveSchemaBinding(value.resultSchema, `${label}.resultSchema`, deps)
    const credentialBindings = parseCredentialBindings(value.credentialBindings, `${label}.credentialBindings`)
    const inventory = deps.inventoryByServer[value.serverId]
    if (!Array.isArray(inventory)) throw new Error(`${label}.serverId has no fresh MCP inventory`)
    const tool = listedTool(inventory, value.toolName, label)
    if (!sameJson(tool.inputSchema, toolInput.value)) throw new Error(`${label} listed input schema mismatch`)
    if (tool.outputSchema === undefined) throw new Error(`${label} listed output schema is required`)
    if (!sameJson(tool.outputSchema, result.value)) throw new Error(`${label} listed output schema mismatch`)

    let reconciliation: ResolvedHabitMcpToolExecutor["reconciliation"] = null
    let reconciliationDefinition: HabitMcpToolExecutorV1["reconciliation"] = null
    if (value.reconciliation !== null) {
      const rawReconciliation = record(value.reconciliation, `${label}.reconciliation`)
      exactKeys(rawReconciliation, ["toolName", "toolInputSchema", "resultSchema"], `${label}.reconciliation`)
      if (typeof rawReconciliation.toolName !== "string" || rawReconciliation.toolName.length === 0) throw new Error(`${label}.reconciliation.toolName must be a non-empty string`)
      const reconciliationInput = resolveSchemaBinding(rawReconciliation.toolInputSchema, `${label}.reconciliation.toolInputSchema`, deps)
      const reconciliationResult = resolveSchemaBinding(rawReconciliation.resultSchema, `${label}.reconciliation.resultSchema`, deps)
      const reconcileTool = listedTool(inventory, rawReconciliation.toolName, `${label}.reconciliation`)
      if (!sameJson(reconcileTool.inputSchema, reconciliationInput.value)) throw new Error(`${label} reconciliation input schema mismatch`)
      if (reconcileTool.outputSchema === undefined || !sameJson(reconcileTool.outputSchema, reconciliationResult.value)) throw new Error(`${label} reconciliation output schema mismatch`)
      reconciliation = { toolInputSchema: reconciliationInput, resultSchema: reconciliationResult }
      reconciliationDefinition = {
        toolName: rawReconciliation.toolName,
        toolInputSchema: reconciliationInput.definition,
        resultSchema: reconciliationResult.definition,
      }
    }

    const definition: HabitMcpToolExecutorV1 = {
      version: 1,
      id: value.id,
      serverId: value.serverId,
      toolName: value.toolName,
      habitInputSchema: habitInput.definition,
      toolInputSchema: toolInput.definition,
      resultSchema: result.definition,
      timeoutMs: value.timeoutMs as number,
      idempotencyField: "ouroOccurrence",
      credentialBindings,
      reconciliation: reconciliationDefinition,
    }
    definitions.push(definition)
    executors.set(definition.id, {
      definition,
      habitInputSchema: habitInput,
      toolInputSchema: toolInput,
      resultSchema: result,
      reconciliation,
    })
  }

  const revision = `sha256:${sha256CanonicalJson(definitions)}`
  emitNervesEvent({
    component: "heart",
    event: "heart.habit_mcp_executors_resolved",
    message: "resolved generic MCP habit executor registry",
    meta: { count: executors.size, revision },
  })
  return new ResolvedHabitMcpToolExecutorRegistry(revision, executors)
}

export function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, label: string): void {
  const validate = (current: unknown, currentSchema: Record<string, unknown>, currentLabel: string): void => {
    if (typeof currentSchema.$ref === "string") {
      const target = resolvePointer(schema, currentSchema.$ref.slice(1))
      validate(current, record(target, `${currentLabel} $ref`), currentLabel)
      return
    }
    if (Array.isArray(currentSchema.enum) && !currentSchema.enum.some((candidate) => sameJson(candidate, current))) throw new Error(`${currentLabel} is not in enum`)
    if ("const" in currentSchema && !sameJson(currentSchema.const, current)) throw new Error(`${currentLabel} does not match const`)
    const type = currentSchema.type
    if (type === "object") {
      const object = record(current, currentLabel)
      const required = Array.isArray(currentSchema.required) ? currentSchema.required : []
      for (const key of required) if (typeof key === "string" && !(key in object)) throw new Error(`${currentLabel}.${key} is required`)
      const properties = currentSchema.properties && typeof currentSchema.properties === "object" && !Array.isArray(currentSchema.properties)
        ? currentSchema.properties as Record<string, unknown>
        : {}
      if (currentSchema.additionalProperties === false) {
        const unknown = Object.keys(object).filter((key) => !(key in properties))
        if (unknown.length > 0) throw new Error(`${currentLabel} has unknown field ${unknown.sort()[0]}`)
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in object) validate(object[key], record(propertySchema, `${currentLabel}.${key} schema`), `${currentLabel}.${key}`)
      }
    } else if (type === "array") {
      if (!Array.isArray(current)) throw new Error(`${currentLabel} must be an array`)
      if (currentSchema.items && typeof currentSchema.items === "object") current.forEach((entry, index) => validate(entry, record(currentSchema.items, `${currentLabel} items schema`), `${currentLabel}[${index}]`))
    } else if (type === "string" && typeof current !== "string") throw new Error(`${currentLabel} must be a string`)
    else if (type === "boolean" && typeof current !== "boolean") throw new Error(`${currentLabel} must be a boolean`)
    else if (type === "number" && typeof current !== "number") throw new Error(`${currentLabel} must be a number`)
    else if (type === "integer" && !Number.isInteger(current)) throw new Error(`${currentLabel} must be an integer`)
    else if (type === "null" && current !== null) throw new Error(`${currentLabel} must be null`)
  }
  validate(value, schema, label)
}
