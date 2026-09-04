import type { Channel } from "@ouro.bot/friends"

import type { RuntimeMcpServers } from "../repertoire/mcp-manager"
import { runSenseTurn, type FrontendTurnEvent, type RunSenseTurnOptions, type RunSenseTurnResult } from "../senses/shared-turn"
import {
  FrontendJournalStore,
  type FrontendJournalEventType,
  type FrontendJournalRef,
} from "./frontend-journal"
import { emitNervesEvent } from "../nerves/runtime"

export class FrontendTurnConflictError extends Error {
  constructor(turnId: string) {
    super(`frontend turn already exists: ${turnId}`)
    this.name = "FrontendTurnConflictError"
  }
}

export interface FrontendTurnRequest {
  turnId: string
  agent: string
  friendId: string
  channel: Channel
  sessionKey: string
  message: string
  runtimeMcpServers?: RuntimeMcpServers
}

export interface FrontendTurnResult {
  turnId: string
  outcome: NonNullable<RunSenseTurnResult["turnOutcome"]>
  response: string
  sessionPath: string | null
}

type FrontendTurnRunner = (options: RunSenseTurnOptions) => Promise<RunSenseTurnResult>
type FrontendServiceListener = (event: FrontendServiceEvent) => void

export interface FrontendServiceEvent {
  agent: string
  friendId: string
  sessionKey: string
  turnId: string
  type: string
  data: Record<string, unknown>
  journalSequence: number | null
}

const JOURNALED_FRONTEND_EVENTS = new Set<FrontendJournalEventType>([
  "assistant_delivery",
  "tool_started",
  "tool_completed",
  "structured_output",
  "error",
])

function required(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must be a non-empty string`)
  return trimmed
}

export class FrontendSessionService {
  private readonly activeTurns = new Map<string, AbortController>()
  private readonly listeners = new Set<FrontendServiceListener>()
  private readonly runner: FrontendTurnRunner
  private readonly journal: FrontendJournalStore | null

  constructor(options: { runner?: FrontendTurnRunner; journal?: FrontendJournalStore | null } = {}) {
    this.runner = options.runner ?? runSenseTurn
    this.journal = options.journal ?? null
  }

  hasTurn(turnId: string): boolean {
    return this.activeTurns.has(turnId)
  }

  cancelTurn(turnId: string): boolean {
    const controller = this.activeTurns.get(turnId)
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  }

  cancelAllTurns(): number {
    let cancelled = 0
    for (const controller of this.activeTurns.values()) {
      if (controller.signal.aborted) continue
      controller.abort()
      cancelled += 1
    }
    return cancelled
  }

  subscribe(listener: FrontendServiceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async runTurn(request: FrontendTurnRequest): Promise<FrontendTurnResult> {
    const turnId = required(request.turnId, "turnId")
    const normalized: FrontendTurnRequest = {
      ...request,
      turnId,
      agent: required(request.agent, "agent"),
      friendId: required(request.friendId, "friendId"),
      sessionKey: required(request.sessionKey, "sessionKey"),
      message: required(request.message, "message"),
    }
    if (this.activeTurns.has(turnId)) throw new FrontendTurnConflictError(turnId)

    const controller = new AbortController()
    this.activeTurns.set(turnId, controller)
    try {
      this.publish(normalized, "user_message", { text: normalized.message }, "user_message")
      this.publish(normalized, "turn_started", {}, "turn_started")
      const result = await this.runner({
        agentName: normalized.agent,
        friendId: normalized.friendId,
        channel: normalized.channel,
        sessionKey: normalized.sessionKey,
        userMessage: normalized.message,
        signal: controller.signal,
        frontendEventSink: {
          onEvent: (event) => this.publishFrontendEvent(normalized, event),
        },
        ...(normalized.runtimeMcpServers ? { runtimeMcpServers: normalized.runtimeMcpServers } : {}),
      })
      if (!result.turnOutcome) throw new Error(`frontend turn ${turnId} omitted its outcome`)
      const frontendResult: FrontendTurnResult = {
        turnId,
        outcome: result.turnOutcome,
        response: result.response,
        sessionPath: result.sessionPath ?? null,
      }
      const terminalType: FrontendJournalEventType = result.turnOutcome === "aborted"
        ? "turn_cancelled"
        : result.turnOutcome === "errored"
          ? "turn_failed"
          : "turn_completed"
      this.publish(normalized, terminalType, { result: frontendResult }, terminalType)
      return frontendResult
    } catch (error) {
      this.publish(normalized, "turn_failed", {
        error: error instanceof Error ? error.message : String(error),
      }, "turn_failed")
      throw error
    } finally {
      this.activeTurns.delete(turnId)
    }
  }

  private publishFrontendEvent(request: FrontendTurnRequest, event: FrontendTurnEvent): void {
    const journalType = JOURNALED_FRONTEND_EVENTS.has(event.type as FrontendJournalEventType)
      ? event.type as FrontendJournalEventType
      : undefined
    this.publish(request, event.type, event.data, journalType)
  }

  private publish(
    request: FrontendTurnRequest,
    type: string,
    data: Record<string, unknown>,
    journalType?: FrontendJournalEventType,
  ): void {
    const journalRef: FrontendJournalRef = {
      agent: request.agent,
      friendId: request.friendId,
      sessionId: request.sessionKey,
    }
    const journalSequence = this.journal && journalType
      ? this.journal.append(journalRef, { turnId: request.turnId, type: journalType, data }).sequence
      : null
    const event: FrontendServiceEvent = {
      ...journalRef,
      sessionKey: journalRef.sessionId,
      turnId: request.turnId,
      type,
      data,
      journalSequence,
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.frontend_listener_error",
          message: "frontend session listener failed",
          meta: { type, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }
}
