import { randomBytes as systemRandomBytes } from "crypto"

import { emitNervesEvent } from "../../nerves/runtime"
import type {
  HabitExecutionAdapter,
  HabitInvocationOutcomeV1,
} from "./habit-execution"
import { HabitAdapterInvocationError } from "./habit-execution-registry"

export interface AgentTurnHabitRequestV1 {
  schemaVersion: 1
  agent: string
  habitId: string
  occurrenceId: string
  attemptId: string
  deadlineAt: string
  responseCapability: string
}

export interface AgentTurnHabitResponseV1 {
  schemaVersion: 1
  occurrenceId: string
  attemptId: string
  responseCapability: string
  outcome: HabitInvocationOutcomeV1
}

export interface AgentTurnHabitResponseSealV1 {
  schemaVersion: 1
  kind: "agent-turn-response-seal"
  occurrenceId: string
  attemptId: string
  responseCapability: string
  responseSha256: string
}

export interface AgentTurnAdapterDeps {
  randomBytes?: (size: number) => Buffer
  request(message: AgentTurnHabitRequestV1, signal: AbortSignal): Promise<AgentTurnHabitResponseV1>
}

function emptyConfig(raw: Record<string, unknown>): Record<string, never> {
  const keys = Object.keys(raw)
  if (keys.length > 0) throw new Error(`agent-turn configuration must be empty; unknown field ${keys.sort()[0]}`)
  return {}
}

function responseMatches(response: unknown, request: AgentTurnHabitRequestV1): response is AgentTurnHabitResponseV1 {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  const value = response as Partial<AgentTurnHabitResponseV1>
  return value.schemaVersion === 1
    && value.occurrenceId === request.occurrenceId
    && value.attemptId === request.attemptId
    && value.responseCapability === request.responseCapability
    && !!value.outcome
    && typeof value.outcome === "object"
    && value.outcome.version === 1
    && (value.outcome.disposition === "settled" || value.outcome.disposition === "outcome_unknown")
}

export function createAgentTurnAdapter(deps: AgentTurnAdapterDeps): HabitExecutionAdapter<Record<string, never>> {
  return {
    id: "agent-turn",
    version: 1,
    validateConfig: emptyConfig,
    async invoke(input) {
      const responseCapability = (deps.randomBytes ?? systemRandomBytes)(32).toString("hex")
      const request: AgentTurnHabitRequestV1 = {
        schemaVersion: 1,
        agent: input.agent,
        habitId: input.habit.id,
        occurrenceId: input.occurrenceId,
        attemptId: input.attemptId,
        deadlineAt: input.deadlineAt,
        responseCapability,
      }
      try {
        const response = await deps.request(request, input.signal)
        if (!responseMatches(response, request)) {
          throw new HabitAdapterInvocationError("adapter_transport_unknown", "agent-turn response correlation or outcome is invalid")
        }
        emitNervesEvent({
          component: "heart",
          event: "heart.agent_turn_habit_result_received",
          message: "received correlated durable agent-turn habit result",
          meta: { occurrenceId: input.occurrenceId, attemptId: input.attemptId },
        })
        return response.outcome
      } catch (error) {
        if (error instanceof HabitAdapterInvocationError) throw error
        throw new HabitAdapterInvocationError(
          "adapter_transport_unknown",
          `agent-turn result transport failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    },
    async reconcile() {
      emitNervesEvent({
        component: "heart",
        event: "heart.agent_turn_habit_reconciliation_unresolved",
        message: "agent-turn unknown outcome remains unresolved",
        meta: {},
      })
      return { version: 1, disposition: "unresolved" }
    },
  }
}
