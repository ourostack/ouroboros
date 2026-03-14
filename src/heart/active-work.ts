import type { Channel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import type { BoardResult } from "../repertoire/tasks/types"
import { bridgeStateLabel } from "./bridges/state-machine"
import type { BridgeRecord } from "./bridges/store"
import type { SessionActivityRecord } from "./session-activity"

export type CenterOfGravityMode = "local-turn" | "inward-work" | "shared-work"

export type BridgeSuggestion =
  | {
      kind: "begin-new"
      targetSession: SessionActivityRecord
      objectiveHint: string
      reason: "same-friend-shared-work"
    }
  | {
      kind: "attach-existing"
      bridgeId: string
      targetSession: SessionActivityRecord
      reason: "same-friend-shared-work"
    }

export interface ActiveWorkFrame {
  currentSession: {
    friendId: string
    channel: Channel
    key: string
    sessionPath: string
  } | null
  currentObligation: string | null
  mustResolveBeforeHandoff: boolean
  centerOfGravity: CenterOfGravityMode
  inner: {
    status: "idle" | "running"
    hasPending: boolean
  }
  bridges: BridgeRecord[]
  taskPressure: {
    compactBoard: string
    liveTaskNames: string[]
    activeBridges: string[]
  }
  friendActivity: {
    freshestForCurrentFriend: SessionActivityRecord | null
    otherLiveSessionsForCurrentFriend: SessionActivityRecord[]
  }
  bridgeSuggestion: BridgeSuggestion | null
}

interface BuildActiveWorkFrameInput {
  currentSession: ActiveWorkFrame["currentSession"]
  currentObligation?: string | null
  mustResolveBeforeHandoff: boolean
  inner: ActiveWorkFrame["inner"]
  bridges: BridgeRecord[]
  taskBoard: BoardResult
  friendActivity: SessionActivityRecord[]
}

export interface BridgeSuggestionInput {
  currentSession: ActiveWorkFrame["currentSession"]
  currentObligation?: string | null
  mustResolveBeforeHandoff: boolean
  bridges: BridgeRecord[]
  taskBoard: BoardResult
  friendSessions: SessionActivityRecord[]
}

function activityPriority(source: SessionActivityRecord["activitySource"]): number {
  return source === "friend-facing" ? 0 : 1
}

function compareActivity(a: SessionActivityRecord, b: SessionActivityRecord): number {
  const sourceDiff = activityPriority(a.activitySource) - activityPriority(b.activitySource)
  if (sourceDiff !== 0) return sourceDiff
  return b.lastActivityMs - a.lastActivityMs
}

function summarizeLiveTasks(taskBoard: BoardResult): string[] {
  const live = [
    ...taskBoard.byStatus.processing,
    ...taskBoard.byStatus.validating,
    ...taskBoard.byStatus.collaborating,
  ]
  return [...new Set(live)]
}

function isActiveBridge(bridge: BridgeRecord): boolean {
  return bridge.lifecycle === "active"
}

function hasSharedObligationPressure(input: Pick<BuildActiveWorkFrameInput, "currentObligation" | "mustResolveBeforeHandoff" | "taskBoard">): boolean {
  return (
    typeof input.currentObligation === "string"
    && input.currentObligation.trim().length > 0
  ) || input.mustResolveBeforeHandoff
    || summarizeLiveTasks(input.taskBoard).length > 0
}

export function suggestBridgeForActiveWork(input: BridgeSuggestionInput): BridgeSuggestion | null {
  const candidateSessions = input.friendSessions
    .filter((session) =>
      !input.currentSession
      || session.friendId !== input.currentSession.friendId
      || session.channel !== input.currentSession.channel
      || session.key !== input.currentSession.key)
    .sort(compareActivity)
  const targetSession = candidateSessions[0] ?? null
  if (!targetSession || !hasSharedObligationPressure(input)) {
    return null
  }

  const activeBridge = input.bridges.find(isActiveBridge) ?? null
  if (activeBridge) {
    const alreadyAttached = activeBridge.attachedSessions.some((session) =>
      session.friendId === targetSession.friendId
      && session.channel === targetSession.channel
      && session.key === targetSession.key,
    )
    if (alreadyAttached) {
      return null
    }
    return {
      kind: "attach-existing",
      bridgeId: activeBridge.id,
      targetSession,
      reason: "same-friend-shared-work",
    }
  }

  return {
    kind: "begin-new",
    targetSession,
    objectiveHint: input.currentObligation?.trim() || "keep this shared work aligned",
    reason: "same-friend-shared-work",
  }
}

function formatSessionLabel(
  session: Pick<SessionActivityRecord, "channel" | "key"> | NonNullable<ActiveWorkFrame["currentSession"]>,
): string {
  return `${session.channel}/${session.key}`
}

export function buildActiveWorkFrame(input: BuildActiveWorkFrameInput): ActiveWorkFrame {
  const friendSessions = input.currentSession
    ? input.friendActivity
      .filter((entry) => entry.friendId === input.currentSession?.friendId)
      .sort(compareActivity)
    : []

  const liveTaskNames = summarizeLiveTasks(input.taskBoard)
  const activeBridgePresent = input.bridges.some(isActiveBridge)
  const centerOfGravity: CenterOfGravityMode = activeBridgePresent
    ? "shared-work"
    : (input.inner.status === "running" || input.inner.hasPending || input.mustResolveBeforeHandoff)
      ? "inward-work"
      : "local-turn"

  const frame: ActiveWorkFrame = {
    currentSession: input.currentSession ?? null,
    currentObligation: input.currentObligation?.trim() || null,
    mustResolveBeforeHandoff: input.mustResolveBeforeHandoff,
    centerOfGravity,
    inner: input.inner,
    bridges: input.bridges,
    taskPressure: {
      compactBoard: input.taskBoard.compact,
      liveTaskNames,
      activeBridges: input.taskBoard.activeBridges,
    },
    friendActivity: {
      freshestForCurrentFriend: friendSessions[0] ?? null,
      otherLiveSessionsForCurrentFriend: friendSessions,
    },
    bridgeSuggestion: suggestBridgeForActiveWork({
      currentSession: input.currentSession,
      currentObligation: input.currentObligation,
      mustResolveBeforeHandoff: input.mustResolveBeforeHandoff,
      bridges: input.bridges,
      taskBoard: input.taskBoard,
      friendSessions,
    }),
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.active_work_build",
    message: "built shared active-work frame",
    meta: {
      centerOfGravity: frame.centerOfGravity,
      friendId: frame.currentSession?.friendId ?? null,
      bridges: frame.bridges.length,
      liveTasks: frame.taskPressure.liveTaskNames.length,
      liveSessions: frame.friendActivity.otherLiveSessionsForCurrentFriend.length,
      hasBridgeSuggestion: frame.bridgeSuggestion !== null,
    },
  })

  return frame
}

export function formatActiveWorkFrame(frame: ActiveWorkFrame): string {
  const lines = ["## active work"]

  if (frame.currentSession) {
    lines.push(`current session: ${formatSessionLabel(frame.currentSession)}`)
  }
  lines.push(`center: ${frame.centerOfGravity}`)

  if (typeof frame.currentObligation === "string" && frame.currentObligation.trim().length > 0) {
    lines.push(`obligation: ${frame.currentObligation.trim()}`)
  }

  if (frame.mustResolveBeforeHandoff) {
    lines.push("handoff pressure: must resolve before handoff")
  }

  const innerStatus = frame.inner?.status ?? "idle"
  const innerHasPending = frame.inner?.hasPending === true
  lines.push(`inner status: ${innerStatus}${innerHasPending ? " (pending queued)" : ""}`)

  if ((frame.taskPressure?.liveTaskNames ?? []).length > 0) {
    lines.push(`live tasks: ${frame.taskPressure.liveTaskNames.join(", ")}`)
  }

  if ((frame.bridges ?? []).length > 0) {
    const bridgeLabels = frame.bridges.map((bridge) => `${bridge.id} [${bridgeStateLabel(bridge)}]`)
    lines.push(`bridges: ${bridgeLabels.join(", ")}`)
  }

  if (frame.friendActivity?.freshestForCurrentFriend) {
    lines.push(`freshest friend-facing session: ${formatSessionLabel(frame.friendActivity.freshestForCurrentFriend)}`)
  }

  if (frame.bridgeSuggestion) {
    if (frame.bridgeSuggestion.kind === "attach-existing") {
      lines.push(
        `suggested bridge: attach ${frame.bridgeSuggestion.bridgeId} -> ${formatSessionLabel(frame.bridgeSuggestion.targetSession)}`,
      )
    } else {
      lines.push(`suggested bridge: begin -> ${formatSessionLabel(frame.bridgeSuggestion.targetSession)}`)
      lines.push(`bridge objective hint: ${frame.bridgeSuggestion.objectiveHint}`)
    }
  }

  return lines.join("\n")
}
