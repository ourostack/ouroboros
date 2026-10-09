// OpenAI Realtime rejects the whole session (invalid_function_parameters) when any
// tool's parameters schema lacks top-level `type: "object"` or carries a top-level
// oneOf/anyOf/allOf/enum/const/not. Other providers' handling of those keywords is not relied
// on here, so every tool is normalized before it is advertised to a Realtime session.
// Argument validation still runs against the original schema when a tool call arrives.
import { emitNervesEvent } from "../../nerves/runtime"

export interface RealtimeFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters: unknown
}

interface ToolFunctionLike {
  function: { name: string; description?: string; parameters?: unknown }
}

const COMBINATORS = ["oneOf", "anyOf", "allOf"] as const
const FORBIDDEN_TOP_LEVEL = [...COMBINATORS, "enum", "const", "not"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

function describeDefinition(value: unknown): string {
  if (isRecord(value) && typeof value.type === "string") return value.type
  if (isRecord(value) && Array.isArray(value.type)) return value.type.join("|")
  return JSON.stringify(value)
}

/** Resolves a branch that is a local `$ref`; returns undefined when it cannot be resolved. */
function resolveBranch(root: Record<string, unknown>, branch: unknown): unknown {
  let current = branch
  const seen = new Set<string>()
  while (isRecord(current) && typeof current.$ref === "string") {
    const ref = current.$ref
    if (seen.has(ref)) return undefined
    seen.add(ref)
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref)
    const container = match ? root[match[1]!] : undefined
    const name = match ? match[2]!.replace(/~1/g, "/").replace(/~0/g, "~") : ""
    if (!isRecord(container) || !(name in container)) return undefined
    current = container[name]
  }
  return current
}

export interface RealtimeSchemaResult {
  parameters: unknown
  /** Generated guidance to append to the tool description when branches were folded. */
  note?: string
}

/**
 * Normalizes a tool schema for Realtime. Returns null when the schema cannot be expressed
 * as an object (the caller should drop that tool).
 */
export function normalizeRealtimeToolSchema(
  schema: unknown,
  onConflict: (property: string) => void = () => {},
): RealtimeSchemaResult | null {
  if (schema === undefined) return { parameters: { type: "object", properties: {} } }
  if (!isRecord(schema)) return null
  if (schema.type !== undefined && schema.type !== "object") return null
  const needsRewrite = schema.type === undefined || FORBIDDEN_TOP_LEVEL.some((key) => key in schema)
  if (!needsRewrite) return { parameters: schema }

  // Fold the alternatives into one object whose properties are the union (all
  // optional beyond the merged `required`), so the model can still call the tool.
  const properties: Record<string, unknown> = isRecord(schema.properties) ? { ...schema.properties } : {}
  const mergedRequired: string[] = []
  const alternatives = new Map<string, Set<string>>()
  const notes: string[] = []
  for (const key of COMBINATORS) {
    const branches = schema[key]
    if (!Array.isArray(branches)) continue
    const objectBranches: Record<string, unknown>[] = []
    for (const raw of branches) {
      const branch = resolveBranch(schema, raw)
      if (isRecord(raw) && typeof raw.$ref === "string" && branch === undefined) return null
      if (isRecord(branch) && isRecord(branch.properties)) objectBranches.push(branch)
    }
    for (const branch of objectBranches) {
      for (const [name, value] of Object.entries(branch.properties as Record<string, unknown>)) {
        if (!(name in properties)) {
          properties[name] = value
        } else if (!deepEqual(properties[name], value)) {
          const others = alternatives.get(name) ?? new Set<string>()
          if (others.size === 0) onConflict(name)
          others.add(describeDefinition(value))
          alternatives.set(name, others)
        }
      }
    }
    const required = (branch: Record<string, unknown>): string[] =>
      Array.isArray(branch.required) ? branch.required.filter((n): n is string => typeof n === "string") : []
    if (key === "allOf" || objectBranches.length === 1) {
      for (const branch of objectBranches) mergedRequired.push(...required(branch))
    } else if (objectBranches.length > 1) {
      const parts = objectBranches.map((branch, i) => {
        const names = required(branch)
        return names.length > 0
          ? `(${i + 1}) ${names.join(", ")} (all required)`
          : `(${i + 1}) no required fields`
      })
      notes.push(`Provide ${key === "oneOf" ? "exactly one of" : "one or more of"}: ${parts.join("; ")}.`)
    }
  }
  for (const [name, others] of alternatives) notes.push(`\`${name}\` may also be: ${[...others].join(", ")}.`)
  const rewritten: Record<string, unknown> = { ...schema, type: "object", properties }
  for (const key of FORBIDDEN_TOP_LEVEL) delete rewritten[key]
  const baseRequired = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const required = [...new Set([...baseRequired, ...mergedRequired.filter((name) => name in properties)])]
  if (required.length > 0) rewritten.required = required
  return { parameters: rewritten, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) }
}

export function realtimeToolParameters(schema: unknown): unknown | null {
  return normalizeRealtimeToolSchema(schema)?.parameters ?? null
}

export interface RealtimeToolReporter {
  dropped(toolName: string): void
  conflict(toolName: string, property: string): void
}

export function realtimeToolsFromDefinitions(
  definitions: readonly ToolFunctionLike[],
  reporter: RealtimeToolReporter = createRealtimeToolReporter(),
): RealtimeFunctionTool[] {
  const tools: RealtimeFunctionTool[] = []
  for (const { function: fn } of definitions) {
    const result = normalizeRealtimeToolSchema(fn.parameters, (property) => reporter.conflict(fn.name, property))
    if (result === null) {
      reporter.dropped(fn.name)
      continue
    }
    const description = [fn.description, result.note].filter(Boolean).join(" ")
    tools.push({
      type: "function",
      name: fn.name,
      ...(description ? { description } : {}),
      parameters: result.parameters,
    })
  }
  return tools
}

/** Emits warn events carrying the given context (agent, call id); each distinct finding is emitted once. */
export function createRealtimeToolReporter(context: Record<string, unknown> = {}): RealtimeToolReporter {
  const reported = new Set<string>()
  return {
    dropped(toolName) {
      const key = `drop:${toolName}`
      if (reported.has(key)) return
      reported.add(key)
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_realtime_tool_dropped",
        message: "tool schema is not valid for OpenAI Realtime; tool omitted from the voice session",
        meta: { ...context, toolName },
      })
    },
    conflict(toolName, property) {
      const key = `conflict:${toolName}:${property}`
      if (reported.has(key)) return
      reported.add(key)
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_realtime_tool_schema_conflict",
        message: "tool schema branches define the same property differently; first definition kept for OpenAI Realtime",
        meta: { ...context, toolName, property },
      })
    },
  }
}

export interface RealtimeToolAdvertiser {
  tools(definitions: readonly ToolFunctionLike[]): RealtimeFunctionTool[]
  isAdvertised(definitions: readonly ToolFunctionLike[], name: string): boolean
}

/**
 * Per-call advertiser: normalizes selections, reports each finding once per call, and
 * answers which tool names were actually advertised to the model.
 */
export function createRealtimeToolAdvertiser(context: Record<string, unknown> = {}): RealtimeToolAdvertiser {
  const reporter = createRealtimeToolReporter(context)
  return {
    tools(definitions: readonly ToolFunctionLike[]): RealtimeFunctionTool[] {
      return realtimeToolsFromDefinitions(definitions, reporter)
    },
    isAdvertised(definitions: readonly ToolFunctionLike[], name: string): boolean {
      return realtimeToolsFromDefinitions(definitions, reporter).some((tool) => tool.name === name)
    },
  }
}
