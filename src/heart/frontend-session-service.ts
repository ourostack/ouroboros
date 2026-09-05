import type { Channel } from "@ouro.bot/friends"

import type { RuntimeMcpServers } from "../repertoire/mcp-manager"
import type { ApprovalSuspensionResult } from "./core"
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

export class FrontendSessionConflictError extends Error {
  constructor(sessionKey: string) {
    super(`frontend session already has an active turn: ${sessionKey}`)
    this.name = "FrontendSessionConflictError"
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
  disableTools?: boolean
  ephemeral?: boolean
}

export interface FrontendSessionRef {
  agent: string
  friendId: string
  sessionKey: string
}

export interface FrontendPermissionRequest {
  requestId: string
  turnId: string
  toolCallId: string
  title: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

export interface FrontendTurnResult {
  turnId: string
  outcome: NonNullable<RunSenseTurnResult["turnOutcome"]>
  response: string
  sessionPath: string | null
}

export interface PreparedFrontendTurn {
  request: FrontendTurnRequest
  sessionIdentity: string
  controller: AbortController
  started: boolean
}

type FrontendTurnRunner = (options: RunSenseTurnOptions) => Promise<RunSenseTurnResult>
type FrontendServiceListener = (event: FrontendServiceEvent) => void

async function defaultReleaseRuntimeMcpServers(): Promise<void> {
  const manager = await import("../repertoire/mcp-manager")
  await manager.releaseRuntimeMcpServers()
}

export interface FrontendAuthorityRuntime {
  approvalCoordinatorFactory(input: {
    request: FrontendTurnRequest
    publish(type: string, data: Record<string, unknown>, journalType?: FrontendJournalEventType): void
  }): NonNullable<RunSenseTurnOptions["approvalCoordinatorFactory"]>
  resumeApproval(input: {
    request: FrontendTurnRequest
    suspension: ApprovalSuspensionResult
    signal: AbortSignal
    frontendEventSink: NonNullable<RunSenseTurnOptions["frontendEventSink"]>
  }): Promise<RunSenseTurnResult>
  resolvePermission(requestId: string, optionId: string): boolean
  cancelTurn(turnId: string): void
  pendingPermissions(ref: FrontendSessionRef): FrontendPermissionRequest[]
  close(): void
}

export interface FrontendServiceEvent {
  agent: string
  friendId: string
  sessionKey: string
  turnId: string
  type: string
  data: Record<string, unknown>
  journalSequence: number | null
  ephemeral: boolean
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
  private readonly activeSessions = new Map<string, string>()
  private readonly listeners = new Set<FrontendServiceListener>()
  private readonly runner: FrontendTurnRunner
  private readonly journal: FrontendJournalStore | null
  private readonly authority: FrontendAuthorityRuntime | null
  private readonly releaseRuntimeMcpServers: () => Promise<void>
  private closed = false

  constructor(options: {
    runner?: FrontendTurnRunner
    journal?: FrontendJournalStore | null
    authority?: FrontendAuthorityRuntime | null
    releaseRuntimeMcpServers?: () => Promise<void>
  } = {}) {
    this.runner = options.runner ?? runSenseTurn
    this.journal = options.journal ?? null
    this.authority = options.authority ?? null
    this.releaseRuntimeMcpServers = options.releaseRuntimeMcpServers ?? defaultReleaseRuntimeMcpServers
  }

  hasTurn(turnId: string): boolean {
    return this.activeTurns.has(turnId)
  }

  cancelTurn(turnId: string): boolean {
    const controller = this.activeTurns.get(turnId)
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    this.authority?.cancelTurn(turnId)
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

  resolvePermission(requestId: string, optionId: string): boolean {
    return this.authority?.resolvePermission(required(requestId, "requestId"), required(optionId, "optionId")) ?? false
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.authority?.close()
  }

  loadSession(
    ref: FrontendSessionRef,
    options: { afterSequence?: number; limit?: number } = {},
  ) {
    if (!this.journal) throw new Error("frontend journal is unavailable")
    const normalized = {
      agent: required(ref.agent, "agent"),
      friendId: required(ref.friendId, "friendId"),
      sessionId: required(ref.sessionKey, "sessionKey"),
    }
    return {
      ...this.journal.replay(normalized, options),
      pendingPermissions: this.authority?.pendingPermissions({
        agent: normalized.agent,
        friendId: normalized.friendId,
        sessionKey: normalized.sessionId,
      }) ?? [],
    }
  }

  prepareTurn(request: FrontendTurnRequest): PreparedFrontendTurn {
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
    const sessionIdentity = [normalized.agent, normalized.friendId, normalized.channel, normalized.sessionKey].join("\0")
    if (this.activeSessions.has(sessionIdentity)) throw new FrontendSessionConflictError(normalized.sessionKey)

    const controller = new AbortController()
    this.activeTurns.set(turnId, controller)
    this.activeSessions.set(sessionIdentity, turnId)
    return { request: normalized, sessionIdentity, controller, started: false }
  }

  async runTurn(request: FrontendTurnRequest): Promise<FrontendTurnResult> {
    return this.runPreparedTurn(this.prepareTurn(request))
  }

  async runPreparedTurn(prepared: PreparedFrontendTurn): Promise<FrontendTurnResult> {
    if (prepared.started) throw new Error(`frontend turn already started: ${prepared.request.turnId}`)
    prepared.started = true
    const normalized = prepared.request
    const turnId = normalized.turnId
    const sessionIdentity = prepared.sessionIdentity
    const controller = prepared.controller
    try {
      this.publish(normalized, "user_message", { text: normalized.message }, "user_message")
      this.publish(normalized, "turn_started", {}, "turn_started")
      const frontendEventSink = {
        onEvent: (event: FrontendTurnEvent) => this.publishFrontendEvent(normalized, event),
      }
      const approvalCoordinatorFactory = normalized.ephemeral
        ? undefined
        : this.authority?.approvalCoordinatorFactory({
          request: normalized,
          publish: (type, data, journalType) => this.publish(normalized, type, data, journalType),
        })
      let result = await this.runner({
        agentName: normalized.agent,
        friendId: normalized.friendId,
        channel: normalized.channel,
        sessionKey: normalized.sessionKey,
        userMessage: normalized.message,
        signal: controller.signal,
        latencyMode: "live",
        frontendEventSink,
        ...(normalized.disableTools ? { disableTools: true } : {}),
        ...(normalized.ephemeral ? { disablePersistence: true } : {}),
        ...(approvalCoordinatorFactory ? { approvalCoordinatorFactory } : {}),
        ...(normalized.runtimeMcpServers ? { runtimeMcpServers: normalized.runtimeMcpServers } : {}),
      })
      let suspensionRounds = 0
      while (result.turnOutcome === "suspended") {
        if (!result.suspension) throw new Error(`frontend turn ${turnId} omitted its approval suspension`)
        if (!this.authority) throw new Error(`frontend turn ${turnId} suspended without an authority runtime`)
        suspensionRounds += 1
        if (suspensionRounds > 8) throw new Error(`frontend turn ${turnId} exceeded its approval suspension limit`)
        result = await this.authority.resumeApproval({
          request: normalized,
          suspension: result.suspension,
          signal: controller.signal,
          frontendEventSink,
        })
      }
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
      try {
        if (normalized.runtimeMcpServers) {
          await this.releaseRuntimeMcpServers()
        }
      } finally {
        this.activeTurns.delete(turnId)
        this.activeSessions.delete(sessionIdentity)
      }
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
    const journalSequence = !request.ephemeral && this.journal && journalType
      ? this.journal.append(journalRef, { turnId: request.turnId, type: journalType, data }).sequence
      : null
    const event: FrontendServiceEvent = {
      ...journalRef,
      sessionKey: journalRef.sessionId,
      turnId: request.turnId,
      type,
      data,
      journalSequence,
      ephemeral: request.ephemeral === true,
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
