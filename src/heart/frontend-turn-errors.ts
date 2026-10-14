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
