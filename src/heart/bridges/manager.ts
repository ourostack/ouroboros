import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { slugify } from "../config"
import { getAgentRoot } from "../identity"
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
  /**
   * Override the desk-task writer used by `promoteBridgeToTask`. Tests
   * inject a fake to avoid touching the real filesystem; production uses
   * the default that writes to `<agent-root>/desk/bridges/<slug>/task.md`.
   */
  writeDeskTask?: (input: DeskTaskWriteInput) => DeskTaskWriteResult
}

interface DeskTaskWriteInput {
  title: string
  category: string
  body: string
  activeBridge: string
  bridgeSessions: string[]
}

interface DeskTaskWriteResult {
  /** Slug for the task directory (also used as the bridge's `taskName`). */
  taskName: string
  /** Absolute path to the written `task.md`. */
  path: string
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

function isCurrentSessionAttached(
  bridge: BridgeRecord,
  currentSession: Pick<BridgeSessionRef, "friendId" | "channel" | "key"> | null,
): boolean {
  if (!currentSession) return false
  return bridge.attachedSessions.some((session) => sessionMatches(session, currentSession))
}

// ──────────────────────────────────────────────────────────────────────────────
// Desk task writer — bridge promotion durably writes a `task.md` under the
// bundle's `desk/bridges/<slug>/` track so the desk substrate (W6) owns the
// promoted task. This module deliberately does not depend on
// `src/repertoire/tasks/` — the task module is being retired in Unit 8c.
// ──────────────────────────────────────────────────────────────────────────────

function formatStemTimestamp(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const hours = String(now.getHours()).padStart(2, "0")
  const minutes = String(now.getMinutes()).padStart(2, "0")
  return `${year}-${month}-${day}-${hours}${minutes}`
}

function formatDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function formatFrontmatterValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"]
    return ["", ...value.map((entry) => `- ${String(entry)}`)]
  }
  if (value === null) return ["null"]
  return [String(value)]
}

function renderTaskMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"]
  for (const key of Object.keys(frontmatter)) {
    const rendered = formatFrontmatterValue(frontmatter[key])
    if (rendered.length === 1) {
      lines.push(`${key}: ${rendered[0]}`)
    } else {
      lines.push(`${key}:`)
      for (const entry of rendered.slice(1)) {
        lines.push(entry)
      }
    }
  }
  lines.push("---")
  lines.push("")
  lines.push(body.trim())
  lines.push("")
  return lines.join("\n")
}

/**
 * Default desk-task writer — writes a `task.md` under
 * `<agentRoot>/desk/bridges/<stem>/task.md` and returns the slug + path.
 *
 * The "bridges" track is the home for promoted bridge work; the slug is
 * `<YYYY-MM-DD-HHMM>-<slugified-title>` to match the timestamped shape used
 * elsewhere in desk.
 */
function defaultWriteDeskTask(input: DeskTaskWriteInput): DeskTaskWriteResult {
  emitNervesEvent({
    event: "engine.bridge_desk_task_write",
    component: "engine",
    message: "writing desk task for promoted bridge",
    meta: { activeBridge: input.activeBridge },
  })

  const now = new Date()
  const stem = `${formatStemTimestamp(now)}-${slugify(input.title).slice(0, 64) || "bridge"}`
  const trackDir = path.join(getAgentRoot(), "desk", "bridges", stem)
  const taskPath = path.join(trackDir, "task.md")

  const today = formatDate(now)
  const frontmatter: Record<string, unknown> = {
    kind: "task",
    schema_version: 1,
    type: "ongoing",
    category: input.category || "coordination",
    title: input.title,
    status: "processing",
    validator: null,
    requester: "agent",
    cadence: null,
    scheduledAt: null,
    lastRun: null,
    created: today,
    updated: today,
    artifacts: [],
    active_bridge: input.activeBridge,
    bridge_sessions: input.bridgeSessions.filter((value) => typeof value === "string" && value.trim().length > 0),
  }

  fs.mkdirSync(trackDir, { recursive: true })
  fs.writeFileSync(taskPath, renderTaskMarkdown(frontmatter, input.body), "utf-8")

  return { taskName: stem, path: taskPath }
}

export function createBridgeManager(options: CreateBridgeManagerOptions = {}): BridgeManager {
  const store = options.store ?? createBridgeStore()
  const now = options.now ?? (() => new Date().toISOString())
  const idFactory = options.idFactory ?? defaultIdFactory
  const writeDeskTask = options.writeDeskTask ?? defaultWriteDeskTask

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
    }): BridgeRecord[] {
      return store.list().map((bridge) => {
        // Unit 8a dropped the legacy task-board read from production callers,
        // and Unit 8b drops it from the manager surface entirely. Bridges
        // suspend when no attached session is active and the current session
        // isn't attached — task-state cross-referencing is no longer part of
        // the lifecycle reconciliation contract.
        const nextState = reconcileBridgeState(bridge, {
          hasAttachedSessionActivity: hasAttachedSessionActivity(bridge, input.sessionActivity),
          hasLiveTask: false,
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

      const written = writeDeskTask({
        title: input.title?.trim() || bridge.objective,
        category: input.category?.trim() || "coordination",
        body: input.body?.trim() || defaultTaskBody(bridge),
        activeBridge: bridge.id,
        bridgeSessions: bridge.attachedSessions.map((session) => sessionIdentityKey(session)),
      })

      const updated = save({
        ...bridge,
        task: {
          taskName: written.taskName,
          path: written.path,
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
          taskName: written.taskName,
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
