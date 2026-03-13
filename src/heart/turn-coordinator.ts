import type { SteeringFollowUpEffect } from "../senses/continuity"
import { emitNervesEvent } from "../nerves/runtime"

export interface SteeringFollowUp {
  conversationId: string
  text: string
  receivedAt: number
  effect: SteeringFollowUpEffect
}

export interface TurnCoordinator {
  withTurnLock<T>(key: string, fn: () => Promise<T>): Promise<T>
  tryBeginTurn(key: string): boolean
  endTurn(key: string): void
  isTurnActive(key: string): boolean
  enqueueFollowUp(key: string, followUp: SteeringFollowUp): void
  drainFollowUps(key: string): SteeringFollowUp[]
}

function scopedKey(scope: string, key: string): string {
  return `${scope}:${key}`
}

export function createTurnCoordinator(): TurnCoordinator {
  const turnLocks = new Map<string, Promise<void>>()
  const activeTurns = new Set<string>()
  const followUpBuffers = new Map<string, SteeringFollowUp[]>()

  return {
    async withTurnLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      emitNervesEvent({
        component: "engine",
        event: "engine.turn_start",
        message: "turn lock acquired",
        meta: { key },
      })
      const prev = turnLocks.get(key) ?? Promise.resolve()
      const run = prev.then(async () => {
        activeTurns.add(key)
        try {
          return await fn()
        } finally {
          activeTurns.delete(key)
        }
      })
      const settled = run.then(() => undefined, () => undefined)
      turnLocks.set(key, settled)
      try {
        return await run
      } finally {
        if (turnLocks.get(key) === settled) turnLocks.delete(key)
      }
    },

    tryBeginTurn(key: string): boolean {
      if (activeTurns.has(key)) return false
      activeTurns.add(key)
      return true
    },

    endTurn(key: string): void {
      activeTurns.delete(key)
    },

    isTurnActive(key: string): boolean {
      return activeTurns.has(key)
    },

    enqueueFollowUp(key: string, followUp: SteeringFollowUp): void {
      const current = followUpBuffers.get(key) ?? []
      current.push(followUp)
      followUpBuffers.set(key, current)
    },

    drainFollowUps(key: string): SteeringFollowUp[] {
      const current = followUpBuffers.get(key)
      if (!current || current.length === 0) return []
      followUpBuffers.delete(key)
      return [...current]
    },
  }
}

const _sharedTurnCoordinator = createTurnCoordinator()

export function withSharedTurnLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
  return _sharedTurnCoordinator.withTurnLock(scopedKey(scope, key), fn)
}

export function tryBeginSharedTurn(scope: string, key: string): boolean {
  return _sharedTurnCoordinator.tryBeginTurn(scopedKey(scope, key))
}

export function endSharedTurn(scope: string, key: string): void {
  _sharedTurnCoordinator.endTurn(scopedKey(scope, key))
}

export function isSharedTurnActive(scope: string, key: string): boolean {
  return _sharedTurnCoordinator.isTurnActive(scopedKey(scope, key))
}

export function enqueueSharedFollowUp(scope: string, key: string, followUp: SteeringFollowUp): void {
  _sharedTurnCoordinator.enqueueFollowUp(scopedKey(scope, key), followUp)
}

export function drainSharedFollowUps(scope: string, key: string): SteeringFollowUp[] {
  return _sharedTurnCoordinator.drainFollowUps(scopedKey(scope, key))
}
