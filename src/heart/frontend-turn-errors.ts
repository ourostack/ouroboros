import { emitNervesEvent } from "../nerves/runtime"

export class FrontendTurnConflictError extends Error {
  constructor(turnId: string) {
    super(`frontend turn already exists: ${turnId}`)
    this.name = "FrontendTurnConflictError"
    emitNervesEvent({ component: "heart", event: "heart.frontend_turn_conflict", message: "frontend request named an already-owned turn" })
  }
}

export class FrontendSessionConflictError extends Error {
  constructor(sessionKey: string) {
    super(`frontend session already has an active turn: ${sessionKey}`)
    this.name = "FrontendSessionConflictError"
    emitNervesEvent({ component: "heart", event: "heart.frontend_session_conflict", message: "frontend session refused a competing turn" })
  }
}
