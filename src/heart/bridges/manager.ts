import { emitNervesEvent } from "../../nerves/runtime"
import {
  advanceBridgeAfterTurn,
  activateBridge,
  beginBridgeProcessing,
  bridgeStateLabel,
  cancelBridge,
  completeBridge,
  createBridgeState,
  queueBridgeFollowUp,
  reconcileBridgeState,
} from "./state-machine"
import type { BridgeRecord, BridgeSessionRef, BridgeStore } from "./store"
import { createBridgeStore } from "./store"
import { drainSharedFollowUps, enqueueSharedFollowUp, endSharedTurn, tryBeginSharedTurn } from "../turn-coordinator"
import { getTaskModule } from "../../repertoire/tasks"
import type { BoardResult } from "../../repertoire/tasks/types"
import type { SessionActivityRecord } from "../session-activity"

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
  reconcileLifecycles(input: {
    currentSession: Pick<BridgeSessionRef, "friendId" | "channel" | "key"> | null
    sessionActivity: SessionActivityRecord[]
    taskBoard: BoardResult
  }): BridgeRecord[]
  promoteBridgeToTask(bridgeId: string, input?: { title?: string; category?: string; body?: string }): BridgeRecord
  completeBridge(bridgeId: string): BridgeRecord
  cancelBridge(bridgeId: string): BridgeRecord
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

function assertBridgeMutable(bridge: BridgeRecord, action: string): void {
  if (bridge.lifecycle === "completed" || bridge.lifecycle === "cancelled") {
    throw new Error(`cannot ${action} a terminal bridge`)
  }
}

function defaultTaskBody(bridge: BridgeRecord): string {
  const lines = [
    "## scope",
    bridge.objective,
    "",
    "## bridge",
    `id: ${bridge.id}`,
  ]
  if (bridge.attachedSessions.length > 0) {
    lines.push("sessions:")
    for (const session of bridge.attachedSessions) {
      lines.push(`- ${sessionIdentityKey(session)}`)
    }
  }
  return lines.join("\n")
}

export function formatBridgeStatus(bridge: BridgeRecord): string {
  const summary = typeof bridge.summary === "string" ? bridge.summary.trim() : ""
  const lines = [
    `bridge: ${bridge.id}`,
    `objective: ${bridge.objective}`,
    `state: ${bridgeStateLabel(bridge)}`,
    `sessions: ${bridge.attachedSessions.length}`,
    `task: ${bridge.task?.taskName ?? "none"}`,
  ]
  if (summary) {
    lines.push(`summary: ${summary}`)
  }
  return lines.join("\n")
}

export function formatBridgeContext(bridges: BridgeRecord[]): string {
  if (bridges.length === 0) return ""
  const lines = ["## active bridge work"]
  for (const bridge of bridges) {
    const task = bridge.task?.taskName ? ` (task: ${bridge.task.taskName})` : ""
    const label = typeof bridge.summary === "string" && bridge.summary.trim().length > 0 ? bridge.summary.trim() : bridge.objective
    lines.push(`- ${bridge.id}: ${label} [${bridgeStateLabel(bridge)}]${task}`)
  }
  return lines.join("\n")
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

function sessionMatches(
  left: Pick<BridgeSessionRef, "friendId" | "channel" | "key">,
  right: Pick<BridgeSessionRef, "friendId" | "channel" | "key">,
): boolean {
  return left.friendId === right.friendId && left.channel === right.channel && left.key === right.key
}

function hasAttachedSessionActivity(bridge: BridgeRecord, sessionActivity: SessionActivityRecord[]): boolean {
  return sessionActivity.some((activity) =>
    activity.channel !== "inner"
    && bridge.attachedSessions.some((session) => sessionMatches(activity, session)))
}

function hasLiveTaskStatus(bridge: BridgeRecord, taskBoard: BoardResult): boolean {
  const taskName = bridge.task?.taskName
  if (!taskName) return false
  return (
    taskBoard.byStatus.processing.includes(taskName)
    || taskBoard.byStatus.collaborating.includes(taskName)
    || taskBoard.byStatus.validating.includes(taskName)
  )
}

function isCurrentSessionAttached(
  bridge: BridgeRecord,
  currentSession: Pick<BridgeSessionRef, "friendId" | "channel" | "key"> | null,
): boolean {
  if (!currentSession) return false
  return bridge.attachedSessions.some((session) => sessionMatches(session, currentSession))
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
      assertBridgeMutable(bridge, "attach session to")
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
      assertBridgeMutable(bridge, "detach session from")
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
        .filter((bridge) => bridge.lifecycle !== "completed" && bridge.lifecycle !== "cancelled")
    },

    reconcileLifecycles(input: {
      currentSession: Pick<BridgeSessionRef, "friendId" | "channel" | "key"> | null
      sessionActivity: SessionActivityRecord[]
      taskBoard: BoardResult
    }): BridgeRecord[] {
      return store.list().map((bridge) => {
        const nextState = reconcileBridgeState(bridge, {
          hasAttachedSessionActivity: hasAttachedSessionActivity(bridge, input.sessionActivity),
          hasLiveTask: hasLiveTaskStatus(bridge, input.taskBoard),
          currentSessionAttached: isCurrentSessionAttached(bridge, input.currentSession),
        })
        if (nextState.lifecycle === bridge.lifecycle && nextState.runtime === bridge.runtime) {
          return bridge
        }
        return save({
          ...bridge,
          ...nextState,
          updatedAt: now(),
        })
      })
    },

    promoteBridgeToTask(bridgeId: string, input: { title?: string; category?: string; body?: string } = {}): BridgeRecord {
      const bridge = requireBridge(bridgeId)
      assertBridgeMutable(bridge, "promote")
      if (bridge.task) return bridge

      const taskPath = getTaskModule().createTask({
        title: input.title?.trim() || bridge.objective,
        type: "ongoing",
        category: input.category?.trim() || "coordination",
        status: "processing",
        body: input.body?.trim() || defaultTaskBody(bridge),
        activeBridge: bridge.id,
        bridgeSessions: bridge.attachedSessions.map((session) => sessionIdentityKey(session)),
      })
      const taskName = taskPath.replace(/^.*\//, "").replace(/\.md$/, "")
      const updated = save({
        ...bridge,
        task: {
          taskName,
          path: taskPath,
          mode: "promoted",
          boundAt: now(),
        },
        updatedAt: now(),
      })
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_promote_task",
        message: "promoted bridge to task-backed work",
        meta: {
          bridgeId,
          taskName,
        },
      })
      return updated
    },

    completeBridge(bridgeId: string): BridgeRecord {
      const bridge = requireBridge(bridgeId)
      const updated = save({
        ...bridge,
        ...completeBridge(bridge),
        updatedAt: now(),
      })
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_complete",
        message: "completed bridge",
        meta: {
          bridgeId,
        },
      })
      return updated
    },

    cancelBridge(bridgeId: string): BridgeRecord {
      const bridge = requireBridge(bridgeId)
      const updated = save({
        ...bridge,
        ...cancelBridge(bridge),
        updatedAt: now(),
      })
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_cancel",
        message: "cancelled bridge",
        meta: {
          bridgeId,
        },
      })
      return updated
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
