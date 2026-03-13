import { emitNervesEvent } from "../../nerves/runtime"
import {
  advanceBridgeAfterTurn,
  activateBridge,
  beginBridgeProcessing,
  createBridgeState,
  queueBridgeFollowUp,
} from "./state-machine"
import type { BridgeRecord, BridgeSessionRef, BridgeStore } from "./store"
import { createBridgeStore } from "./store"
import { drainSharedFollowUps, enqueueSharedFollowUp, endSharedTurn, tryBeginSharedTurn } from "../turn-coordinator"

export interface BeginBridgeInput {
  objective: string
  summary: string
  session: BridgeSessionRef
}

export interface RunBridgeTurnResult {
  queued: boolean
  bridge: BridgeRecord
}

export interface BridgeManager {
  beginBridge(input: BeginBridgeInput): BridgeRecord
  attachSession(bridgeId: string, session: BridgeSessionRef): BridgeRecord
  detachSession(bridgeId: string, session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): BridgeRecord
  getBridge(bridgeId: string): BridgeRecord | null
  listBridges(): BridgeRecord[]
  findBridgesForSession(session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): BridgeRecord[]
  runBridgeTurn(bridgeId: string, fn: () => Promise<void>): Promise<RunBridgeTurnResult>
}

interface CreateBridgeManagerOptions {
  store?: BridgeStore
  now?: () => string
  idFactory?: () => string
}

function defaultIdFactory(): string {
  return `bridge-${Date.now().toString(36)}`
}

function sessionIdentityKey(session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): string {
  return `${session.friendId}/${session.channel}/${session.key}`
}

function ensureRunnable(bridge: BridgeRecord, now: () => string, store: BridgeStore): BridgeRecord {
  if (bridge.lifecycle === "forming" || bridge.lifecycle === "suspended") {
    const activated = {
      ...bridge,
      ...activateBridge(bridge),
      updatedAt: now(),
    }
    return store.save(activated)
  }
  if (bridge.lifecycle === "completed" || bridge.lifecycle === "cancelled") {
    throw new Error(`bridge is terminal: ${bridge.id}`)
  }
  return bridge
}

export function createBridgeManager(options: CreateBridgeManagerOptions = {}): BridgeManager {
  const store = options.store ?? createBridgeStore()
  const now = options.now ?? (() => new Date().toISOString())
  const idFactory = options.idFactory ?? defaultIdFactory

  function requireBridge(bridgeId: string): BridgeRecord {
    const bridge = store.get(bridgeId)
    if (!bridge) {
      throw new Error(`bridge not found: ${bridgeId}`)
    }
    return bridge
  }

  function save(bridge: BridgeRecord): BridgeRecord {
    return store.save(bridge)
  }

  return {
    beginBridge(input: BeginBridgeInput): BridgeRecord {
      const timestamp = now()
      const state = activateBridge(createBridgeState())
      const bridge: BridgeRecord = {
        id: idFactory(),
        objective: input.objective,
        summary: input.summary,
        lifecycle: state.lifecycle,
        runtime: state.runtime,
        createdAt: timestamp,
        updatedAt: timestamp,
        attachedSessions: [input.session],
        task: null,
      }
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_begin",
        message: "created bridge",
        meta: {
          bridgeId: bridge.id,
          session: sessionIdentityKey(input.session),
        },
      })
      return save(bridge)
    },

    attachSession(bridgeId: string, session: BridgeSessionRef): BridgeRecord {
      const bridge = requireBridge(bridgeId)
      const existing = bridge.attachedSessions.some((candidate) => sessionIdentityKey(candidate) === sessionIdentityKey(session))
      if (existing) return bridge
      const updated = {
        ...bridge,
        attachedSessions: [...bridge.attachedSessions, session],
        updatedAt: now(),
      }
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_attach_session",
        message: "attached canonical session to bridge",
        meta: {
          bridgeId,
          session: sessionIdentityKey(session),
        },
      })
      return save(updated)
    },

    detachSession(bridgeId: string, session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): BridgeRecord {
      const bridge = requireBridge(bridgeId)
      const updated = {
        ...bridge,
        attachedSessions: bridge.attachedSessions.filter((candidate) => sessionIdentityKey(candidate) !== sessionIdentityKey(session)),
        updatedAt: now(),
      }
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_detach_session",
        message: "detached canonical session from bridge",
        meta: {
          bridgeId,
          session: sessionIdentityKey(session),
        },
      })
      return save(updated)
    },

    getBridge(bridgeId: string): BridgeRecord | null {
      return store.get(bridgeId)
    },

    listBridges(): BridgeRecord[] {
      return store.list()
    },

    findBridgesForSession(session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): BridgeRecord[] {
      return store.findBySession(session)
    },

    async runBridgeTurn(bridgeId: string, fn: () => Promise<void>): Promise<RunBridgeTurnResult> {
      if (!tryBeginSharedTurn("bridge", bridgeId)) {
        const bridge = requireBridge(bridgeId)
        const queued = bridge.runtime === "awaiting-follow-up"
          ? bridge
          : save({
            ...bridge,
            ...queueBridgeFollowUp(bridge),
            updatedAt: now(),
          })
        enqueueSharedFollowUp("bridge", bridgeId, {
          conversationId: bridgeId,
          text: "bridge follow-up",
          receivedAt: Date.now(),
          effect: "none",
        })
        emitNervesEvent({
          component: "engine",
          event: "engine.bridge_turn_queued",
          message: "queued follow-up bridge turn",
          meta: {
            bridgeId,
          },
        })
        return {
          queued: true,
          bridge: queued,
        }
      }

      try {
        let current = ensureRunnable(requireBridge(bridgeId), now, store)
        current = save({
          ...current,
          ...beginBridgeProcessing(current),
          updatedAt: now(),
        })

        while (true) {
          emitNervesEvent({
            component: "engine",
            event: "engine.bridge_turn_start",
            message: "running bridge turn",
            meta: {
              bridgeId,
            },
          })
          await fn()

          let next = requireBridge(bridgeId)
          const bufferedFollowUps = drainSharedFollowUps("bridge", bridgeId)
          if (bufferedFollowUps.length > 0 && next.runtime !== "awaiting-follow-up") {
            next = save({
              ...next,
              ...queueBridgeFollowUp(next),
              updatedAt: now(),
            })
          }

          const advanced = save({
            ...next,
            ...advanceBridgeAfterTurn(next),
            updatedAt: now(),
          })

          if (advanced.runtime === "processing") {
            current = advanced
            continue
          }

          emitNervesEvent({
            component: "engine",
            event: "engine.bridge_turn_end",
            message: "bridge turn finished",
            meta: {
              bridgeId,
            },
          })
          return {
            queued: false,
            bridge: current = advanced,
          }
        }
      } finally {
        endSharedTurn("bridge", bridgeId)
      }
    },
  }
}
