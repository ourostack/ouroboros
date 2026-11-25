import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomicSync } from "../../heart/atomic-file"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface BlueBubblesRuntimeState {
  upstreamStatus: "unknown" | "ok" | "error"
  detail: string
  lastCheckedAt?: string
  /** Stamped on every write, and on sync ticks a running pass skips: the listener's sync loop is alive. */
  lastHeartbeatAt?: string
  /** The start of the last sync whose catch-up finished; the next catch-up starts from here. Kept by writes that omit it. */
  catchUpThrough?: string
  /**
   * After an outage, iMessage keeps delivering the messages it held for minutes after BlueBubbles answers again, and
   * they carry the time they were sent, not the time they landed. Until `recoveryLookbackUntil`, every catch-up keeps
   * reaching back to `recoveryLookbackSince` instead of the healthy overlap, so a late-landing message is still found.
   * Kept by writes that omit them.
   */
  recoveryLookbackSince?: string
  recoveryLookbackUntil?: string
  proofMethod?: string
  pendingRecoveryCount: number
  failedRecoveryCount?: number
  oldestPendingRecoveryAt?: string
  oldestPendingRecoveryAgeMs?: number
  activeTurnCount?: number
  stalledTurnCount?: number
  oldestActiveTurnStartedAt?: string
  oldestActiveTurnAgeMs?: number
  lastRecoveredAt?: string
  lastRecoveredMessageGuid?: string
}

const DEFAULT_RUNTIME_STATE: BlueBubblesRuntimeState = {
  upstreamStatus: "unknown",
  detail: "startup health probe pending",
  pendingRecoveryCount: 0,
}

export function getBlueBubblesRuntimeStatePath(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(
    agentRoot,
    "state",
    "senses",
    "bluebubbles",
    "runtime.json",
  )
}

export function readBlueBubblesRuntimeState(agentName: string, agentRoot?: string): BlueBubblesRuntimeState {
  const filePath = getBlueBubblesRuntimeStatePath(agentName, agentRoot)
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<BlueBubblesRuntimeState>
    const failedRecoveryCount = typeof parsed.failedRecoveryCount === "number" && Number.isFinite(parsed.failedRecoveryCount)
      ? parsed.failedRecoveryCount
      : undefined
    return {
      upstreamStatus: parsed.upstreamStatus === "ok" || parsed.upstreamStatus === "error"
        ? parsed.upstreamStatus
        : "unknown",
      detail: typeof parsed.detail === "string" && parsed.detail.trim()
        ? parsed.detail
        : DEFAULT_RUNTIME_STATE.detail,
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : undefined,
      lastHeartbeatAt: typeof parsed.lastHeartbeatAt === "string" ? parsed.lastHeartbeatAt : undefined,
      catchUpThrough: typeof parsed.catchUpThrough === "string" ? parsed.catchUpThrough : undefined,
      recoveryLookbackSince: typeof parsed.recoveryLookbackSince === "string" ? parsed.recoveryLookbackSince : undefined,
      recoveryLookbackUntil: typeof parsed.recoveryLookbackUntil === "string" ? parsed.recoveryLookbackUntil : undefined,
      proofMethod: typeof parsed.proofMethod === "string" && parsed.proofMethod.trim()
        ? parsed.proofMethod
        : undefined,
      pendingRecoveryCount: typeof parsed.pendingRecoveryCount === "number" && Number.isFinite(parsed.pendingRecoveryCount)
        ? parsed.pendingRecoveryCount
        : 0,
      ...(typeof failedRecoveryCount === "number" ? { failedRecoveryCount } : {}),
      oldestPendingRecoveryAt: typeof parsed.oldestPendingRecoveryAt === "string"
        ? parsed.oldestPendingRecoveryAt
        : undefined,
      oldestPendingRecoveryAgeMs: typeof parsed.oldestPendingRecoveryAgeMs === "number" && Number.isFinite(parsed.oldestPendingRecoveryAgeMs)
        ? parsed.oldestPendingRecoveryAgeMs
        : undefined,
      activeTurnCount: typeof parsed.activeTurnCount === "number" && Number.isFinite(parsed.activeTurnCount)
        ? parsed.activeTurnCount
        : undefined,
      stalledTurnCount: typeof parsed.stalledTurnCount === "number" && Number.isFinite(parsed.stalledTurnCount)
        ? parsed.stalledTurnCount
        : undefined,
      oldestActiveTurnStartedAt: typeof parsed.oldestActiveTurnStartedAt === "string"
        ? parsed.oldestActiveTurnStartedAt
        : undefined,
      oldestActiveTurnAgeMs: typeof parsed.oldestActiveTurnAgeMs === "number" && Number.isFinite(parsed.oldestActiveTurnAgeMs)
        ? parsed.oldestActiveTurnAgeMs
        : undefined,
      lastRecoveredAt: typeof parsed.lastRecoveredAt === "string" ? parsed.lastRecoveredAt : undefined,
      lastRecoveredMessageGuid: typeof parsed.lastRecoveredMessageGuid === "string"
        ? parsed.lastRecoveredMessageGuid
        : undefined,
    }
  } catch {
    return { ...DEFAULT_RUNTIME_STATE }
  }
}

export function writeBlueBubblesRuntimeState(agentName: string, state: BlueBubblesRuntimeState, agentRoot?: string): string {
  const filePath = getBlueBubblesRuntimeStatePath(agentName, agentRoot)
  try {
    const kept = state.catchUpThrough === undefined || state.recoveryLookbackUntil === undefined
      ? readBlueBubblesRuntimeState(agentName, agentRoot)
      : null
    const catchUpThrough = state.catchUpThrough ?? kept?.catchUpThrough
    const recoveryLookbackSince = state.recoveryLookbackUntil === undefined ? kept?.recoveryLookbackSince : state.recoveryLookbackSince
    const recoveryLookbackUntil = state.recoveryLookbackUntil ?? kept?.recoveryLookbackUntil
    // Replaced whole, so the daemon reading it mid-write never sees half a file.
    writeJsonAtomicSync(filePath, {
      ...state,
      ...(catchUpThrough === undefined ? {} : { catchUpThrough }),
      ...(recoveryLookbackSince === undefined || recoveryLookbackUntil === undefined ? {} : { recoveryLookbackSince, recoveryLookbackUntil }),
      lastHeartbeatAt: new Date(Date.now()).toISOString(),
    })
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_runtime_state_error",
      message: "failed to write bluebubbles runtime state",
      meta: {
        agentName,
        upstreamStatus: state.upstreamStatus,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return filePath
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_runtime_state_written",
    message: "wrote bluebubbles runtime state",
    meta: {
      agentName,
      upstreamStatus: state.upstreamStatus,
      pendingRecoveryCount: state.pendingRecoveryCount,
      failedRecoveryCount: state.failedRecoveryCount ?? 0,
      activeTurnCount: state.activeTurnCount ?? 0,
      stalledTurnCount: state.stalledTurnCount ?? 0,
      path: filePath,
    },
  })

  return filePath
}

/** Refresh the heartbeat of the state on disk, while a sync that has not written yet is still running. */
export function touchBlueBubblesRuntimeHeartbeat(agentName: string, agentRoot?: string): void {
  if (!fs.existsSync(getBlueBubblesRuntimeStatePath(agentName, agentRoot))) return
  writeBlueBubblesRuntimeState(agentName, readBlueBubblesRuntimeState(agentName, agentRoot), agentRoot)
}
