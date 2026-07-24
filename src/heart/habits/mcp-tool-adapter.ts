import { emitNervesEvent } from "../../nerves/runtime"
import type { McpToolCallResultV1 } from "../../repertoire/mcp-client"
import type { McpInternalExecutorAuthority } from "../../repertoire/mcp-manager"
import { sha256CanonicalJson } from "../runtime/canonical-json"
import type {
  HabitCredentialBindingV1,
  ResolvedHabitMcpToolExecutor,
  ResolvedHabitMcpToolExecutorRegistry,
} from "./mcp-executors"
import { validateJsonSchemaValue } from "./mcp-executors"
import type {
  HabitExecutionAdapter,
  HabitInvocationOutcomeV1,
  HabitReconciliationResultV1,
} from "./habit-execution"
import { HabitAdapterInvocationError } from "./habit-execution-registry"

export interface McpToolHabitConfigV1 {
  executorId: string
  input: Record<string, unknown>
}

export type RuntimeCredentialRead =
  | { state: "ready"; value: unknown }
  | { state: "missing" | "locked" }

export interface McpToolHabitAdapterDeps {
  registry: ResolvedHabitMcpToolExecutorRegistry
  refreshExecutor?(executor: ResolvedHabitMcpToolExecutor): Promise<void>
  authorityFor(executorId: string, toolName: string): McpInternalExecutorAuthority
  callInternalTool(input: {
    authority: McpInternalExecutorAuthority
    serverId: string
    toolName: string
    arguments: Record<string, unknown>
    timeoutMs: number
  }): Promise<McpToolCallResultV1>
  readCredential(binding: HabitCredentialBindingV1): RuntimeCredentialRead
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`)
  return raw as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown.sort()[0]}`)
}

function validError(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean"
}

function validEvidence(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return value.kind === "adapter-owned"
    && typeof value.ref === "string"
    && /^[0-9a-f]{64}$/.test(String(value.sha256))
    && typeof value.observedAt === "string"
    && Number.isFinite(Date.parse(value.observedAt))
}

function parseInvocationOutcome(raw: unknown): HabitInvocationOutcomeV1 {
  const value = record(raw, "MCP structured invocation outcome")
  if (value.version !== 1) throw new Error("MCP structured invocation outcome version must be 1")
  if (value.disposition === "outcome_unknown") {
    if (value.reason !== "adapter_reported_unknown" || !validEvidence(value.evidence)) throw new Error("MCP unknown outcome evidence is invalid")
    return value as unknown as HabitInvocationOutcomeV1
  }
  if (value.disposition !== "settled") throw new Error("MCP invocation disposition is invalid")
  const result = record(value.result, "MCP settled result")
  if (result.version !== 1) throw new Error("MCP settled result version must be 1")
  if (result.status === "completed" && typeof result.resultRef === "string") return value as unknown as HabitInvocationOutcomeV1
  if (result.status === "failed_terminal" && validError(result.error)) return value as unknown as HabitInvocationOutcomeV1
  if (result.status === "failed_retryable"
    && validError(result.error)
    && validEvidence(result.safeRetryEvidence)
    && typeof result.notBefore === "string"
    && Number.isFinite(Date.parse(result.notBefore))) return value as unknown as HabitInvocationOutcomeV1
  throw new Error("MCP settled result is invalid")
}

function parseReconciliationResult(raw: unknown): HabitReconciliationResultV1 {
  const value = record(raw, "MCP structured reconciliation result")
  if (value.version !== 1) throw new Error("MCP reconciliation result version must be 1")
  if (value.disposition === "unresolved") return { version: 1, disposition: "unresolved" }
  if (!validEvidence(value.evidence)) throw new Error("MCP reconciliation evidence is invalid")
  if (value.disposition === "completed" && typeof value.resultRef === "string") return value as unknown as HabitReconciliationResultV1
  if (value.disposition === "safe_retry" && validError(value.error) && typeof value.notBefore === "string") return value as unknown as HabitReconciliationResultV1
  if (value.disposition === "failed_terminal" && validError(value.error)) return value as unknown as HabitReconciliationResultV1
  throw new Error("MCP reconciliation disposition is invalid")
}

function credentialsFor(executor: ResolvedHabitMcpToolExecutor, deps: McpToolHabitAdapterDeps): Record<string, unknown> {
  const credentials: Record<string, unknown> = {}
  for (const binding of executor.definition.credentialBindings) {
    const result = deps.readCredential(binding)
    if (result.state !== "ready") {
      throw new Error(`Credential ${binding.name} is ${result.state}; actor human-required must repair the configured runtime credential cache`)
    }
    credentials[binding.name] = result.value
  }
  return credentials
}

function callError(message: string): HabitAdapterInvocationError {
  return new HabitAdapterInvocationError("adapter_transport_unknown", message)
}

export function createMcpToolHabitAdapter(deps: McpToolHabitAdapterDeps): HabitExecutionAdapter<McpToolHabitConfigV1> {
  const validateConfig = (raw: Record<string, unknown>): McpToolHabitConfigV1 => {
    exactKeys(raw, ["executorId", "input"], "mcp-tool configuration")
    if (typeof raw.executorId !== "string") throw new Error("mcp-tool executorId must be a string")
    const input = record(raw.input, "mcp-tool input")
    const executor = deps.registry.get(raw.executorId)
    validateJsonSchemaValue(input, executor.habitInputSchema.value, "mcp-tool input")
    return { executorId: raw.executorId, input }
  }

  return {
    id: "mcp-tool",
    version: 1,
    validateConfig,
    async invoke(input) {
      const executor = deps.registry.get(input.config.executorId)
      await deps.refreshExecutor?.(executor)
      const credentials = credentialsFor(executor, deps)
      const ouroOccurrence = {
        occurrenceId: input.occurrenceId,
        attemptId: input.attemptId,
        idempotencyKey: sha256CanonicalJson({
          agent: input.agent,
          habitId: input.habit.id,
          occurrenceId: input.occurrenceId,
        }),
        deadlineAt: input.deadlineAt,
      }
      const argumentsValue = { ouroOccurrence, input: input.config.input, credentials }
      validateJsonSchemaValue(argumentsValue, executor.toolInputSchema.value, "MCP tool arguments")
      let result: McpToolCallResultV1
      try {
        result = await deps.callInternalTool({
          authority: deps.authorityFor(executor.definition.id, executor.definition.toolName),
          serverId: executor.definition.serverId,
          toolName: executor.definition.toolName,
          arguments: argumentsValue,
          timeoutMs: executor.definition.timeoutMs,
        })
      } catch {
        throw callError("MCP tool result is outcome-unknown after dispatch failure")
      }
      if (result.isError === true) throw callError("MCP tool returned isError")
      if (!result.structuredContent) throw callError("MCP tool returned no structuredContent")
      try {
        validateJsonSchemaValue(result.structuredContent, executor.resultSchema.value, "MCP tool structuredContent")
        const outcome = parseInvocationOutcome(result.structuredContent)
        emitNervesEvent({
          component: "heart",
          event: "heart.mcp_tool_habit_outcome_received",
          message: "received schema-valid generic MCP habit outcome",
          meta: { executorId: executor.definition.id, disposition: outcome.disposition },
        })
        return outcome
      } catch {
        throw callError("MCP tool structuredContent is invalid")
      }
    },
    async reconcile(input) {
      const config = validateConfig(input.config as unknown as Record<string, unknown>)
      const executor = deps.registry.get(config.executorId)
      await deps.refreshExecutor?.(executor)
      const reconciliation = executor.definition.reconciliation
      if (!reconciliation || !executor.reconciliation) return { version: 1, disposition: "unresolved" }
      const credentials = credentialsFor(executor, deps)
      const argumentsValue = {
        ouroOccurrence: {
          occurrenceId: input.occurrenceId,
          attemptId: input.attemptId,
          idempotencyKey: sha256CanonicalJson({
            agent: input.agent,
            habitId: input.habitId,
            occurrenceId: input.occurrenceId,
          }),
        },
        priorEvidence: input.priorEvidence,
        credentials,
      }
      validateJsonSchemaValue(argumentsValue, executor.reconciliation.toolInputSchema.value, "MCP reconciliation arguments")
      let result: McpToolCallResultV1
      try {
        result = await deps.callInternalTool({
          authority: deps.authorityFor(executor.definition.id, reconciliation.toolName),
          serverId: executor.definition.serverId,
          toolName: reconciliation.toolName,
          arguments: argumentsValue,
          timeoutMs: executor.definition.timeoutMs,
        })
      } catch {
        return { version: 1, disposition: "unresolved" }
      }
      if (result.isError === true || !result.structuredContent) return { version: 1, disposition: "unresolved" }
      try {
        validateJsonSchemaValue(result.structuredContent, executor.reconciliation.resultSchema.value, "MCP reconciliation structuredContent")
        return parseReconciliationResult(result.structuredContent)
      } catch {
        return { version: 1, disposition: "unresolved" }
      }
    },
  }
}
