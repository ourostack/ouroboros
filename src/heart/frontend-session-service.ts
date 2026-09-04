import type { Channel } from "@ouro.bot/friends"

import type { RuntimeMcpServers } from "../repertoire/mcp-manager"
import { runSenseTurn, type RunSenseTurnOptions, type RunSenseTurnResult } from "../senses/shared-turn"

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

function required(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must be a non-empty string`)
  return trimmed
}

export class FrontendSessionService {
  private readonly activeTurns = new Map<string, AbortController>()
  private readonly runner: FrontendTurnRunner

  constructor(options: { runner?: FrontendTurnRunner } = {}) {
    this.runner = options.runner ?? runSenseTurn
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

  async runTurn(request: FrontendTurnRequest): Promise<FrontendTurnResult> {
    const turnId = required(request.turnId, "turnId")
    if (this.activeTurns.has(turnId)) throw new FrontendTurnConflictError(turnId)

    const controller = new AbortController()
    this.activeTurns.set(turnId, controller)
    try {
      const result = await this.runner({
        agentName: required(request.agent, "agent"),
        friendId: required(request.friendId, "friendId"),
        channel: request.channel,
        sessionKey: required(request.sessionKey, "sessionKey"),
        userMessage: required(request.message, "message"),
        signal: controller.signal,
        ...(request.runtimeMcpServers ? { runtimeMcpServers: request.runtimeMcpServers } : {}),
      })
      if (!result.turnOutcome) throw new Error(`frontend turn ${turnId} omitted its outcome`)
      return {
        turnId,
        outcome: result.turnOutcome,
        response: result.response,
        sessionPath: result.sessionPath ?? null,
      }
    } finally {
      this.activeTurns.delete(turnId)
    }
  }
}
