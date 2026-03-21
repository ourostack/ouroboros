import type { Channel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import type { BoardResult } from "../repertoire/tasks/types"
import type { CodingSession } from "../repertoire/coding/types"
import { bridgeStateLabel } from "./bridges/state-machine"
import type { BridgeRecord } from "./bridges/store"
import type { InnerJob } from "./daemon/thoughts"
import { isOpenObligationStatus, type Obligation } from "./obligations"
import type { SessionActivityRecord } from "./session-activity"
import { formatTargetSessionCandidates, type TargetSessionCandidate } from "./target-resolution"

export type CenterOfGravityMode = "local-turn" | "inward-work" | "shared-work"

export type BridgeSuggestion =
  | {
      kind: "begin-new"
      targetSession: TargetSessionCandidate
      objectiveHint: string
      reason: "shared-work-candidate"
    }
  | {
      kind: "attach-existing"
      bridgeId: string
      targetSession: TargetSessionCandidate
      reason: "shared-work-candidate"
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
    origin?: { friendId: string; channel: string; key: string }
    contentSnippet?: string
    obligationPending?: boolean
    job: InnerJob
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
  codingSessions: CodingSession[]
  pendingObligations: Obligation[]
  targetCandidates?: TargetSessionCandidate[]
  bridgeSuggestion: BridgeSuggestion | null
}

interface BuildActiveWorkFrameInput {
  currentSession: ActiveWorkFrame["currentSession"]
  currentObligation?: string | null
  mustResolveBeforeHandoff: boolean
  inner: ActiveWorkFrame["inner"]
  bridges: BridgeRecord[]
  codingSessions?: CodingSession[]
  pendingObligations?: Obligation[]
  taskBoard: BoardResult
  friendActivity: SessionActivityRecord[]
  targetCandidates?: TargetSessionCandidate[]
}

export interface BridgeSuggestionInput {
  currentSession: ActiveWorkFrame["currentSession"]
  currentObligation?: string | null
  mustResolveBeforeHandoff: boolean
  bridges: BridgeRecord[]
  taskBoard: BoardResult
  targetCandidates?: TargetSessionCandidate[]
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

function formatCodingLaneLabel(session: CodingSession): string {
  return `${session.runner} ${session.id}`
}

function describeCodingSessionScope(session: CodingSession, currentSession: ActiveWorkFrame["currentSession"]): string {
  if (!session.originSession) return ""
  if (
    currentSession
    && session.originSession.friendId === currentSession.friendId
    && session.originSession.channel === currentSession.channel
    && session.originSession.key === currentSession.key
  ) {
    return " for this thread"
  }
  return ` for ${session.originSession.channel}/${session.originSession.key}`
}

function activeObligationCount(obligations: Obligation[] | undefined): number {
  return (obligations ?? []).filter((ob) => isOpenObligationStatus(ob.status)).length
}

function formatObligationSurface(obligation: Obligation): string {
  if (!obligation.currentSurface?.label) return ""
  switch (obligation.status) {
    case "investigating":
      return ` (working in ${obligation.currentSurface.label})`
    case "waiting_for_merge":
      return ` (waiting at ${obligation.currentSurface.label})`
    case "updating_runtime":
      return ` (updating via ${obligation.currentSurface.label})`
    default:
      return ` (${obligation.currentSurface.label})`
  }
}

export function suggestBridgeForActiveWork(input: BridgeSuggestionInput): BridgeSuggestion | null {
  const targetCandidates = (input.targetCandidates ?? [])
    .filter((candidate) => {
      if (candidate.delivery.mode === "blocked") {
        return false
      }
      if (candidate.activitySource !== "friend-facing" || candidate.channel === "inner") {
        return false
      }
      if (!input.currentSession) {
        return true
      }
      return !(
        candidate.friendId === input.currentSession.friendId
        && candidate.channel === input.currentSession.channel
        && candidate.key === input.currentSession.key
      )
    })
    .sort((a, b) => {
      return b.lastActivityMs - a.lastActivityMs
    })
  if (!hasSharedObligationPressure(input) || targetCandidates.length === 0) {
    return null
  }
  const targetSession = targetCandidates[0]

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
      reason: "shared-work-candidate",
    }
  }

  return {
    kind: "begin-new",
    targetSession,
    objectiveHint: input.currentObligation?.trim() || "keep this shared work aligned",
    reason: "shared-work-candidate",
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
  const openObligations = activeObligationCount(input.pendingObligations)
  const liveCodingSessions = input.codingSessions ?? []
  const centerOfGravity: CenterOfGravityMode = activeBridgePresent
    ? "shared-work"
    : (input.inner.status === "running" || input.inner.hasPending || input.mustResolveBeforeHandoff || openObligations > 0 || liveCodingSessions.length > 0)
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
    codingSessions: liveCodingSessions,
    pendingObligations: input.pendingObligations ?? [],
    targetCandidates: input.targetCandidates ?? [],
    bridgeSuggestion: suggestBridgeForActiveWork({
      currentSession: input.currentSession,
      currentObligation: input.currentObligation,
      mustResolveBeforeHandoff: input.mustResolveBeforeHandoff,
      bridges: input.bridges,
      taskBoard: input.taskBoard,
      targetCandidates: input.targetCandidates,
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
      codingSessions: frame.codingSessions.length,
      pendingObligations: openObligations,
      hasBridgeSuggestion: frame.bridgeSuggestion !== null,
    },
  })

  return frame
}

export function formatActiveWorkFrame(frame: ActiveWorkFrame): string {
  const lines = ["## what i'm holding"]

  // Session line
  if (frame.currentSession) {
    let sessionLine = `i'm in a conversation on ${formatSessionLabel(frame.currentSession)}.`
    if (typeof frame.currentObligation === "string" && frame.currentObligation.trim().length > 0) {
      sessionLine += ` i told them i'd ${frame.currentObligation.trim()}.`
    } else if (frame.mustResolveBeforeHandoff) {
      sessionLine += " i need to finish what i started here before moving on."
    }
    lines.push("")
    lines.push(sessionLine)
  } else {
    lines.push("")
    lines.push("i'm not in a conversation right now.")
  }

  // Inner status block
  const job = frame.inner?.job
  if (job) {
    if (job.status === "queued") {
      let queuedLine = "i have a thought queued up for private attention."
      if (frame.inner?.contentSnippet) {
        queuedLine += `\nit's about: "${frame.inner.contentSnippet}"`
      }
      lines.push("")
      lines.push(queuedLine)
    } else if (job.status === "running") {
      const originName = job.origin?.friendName ?? job.origin?.friendId
      let runningLine = originName
        ? `i'm thinking through something privately right now. ${originName} asked about something and i wanted to give it real thought.`
        : "i'm thinking through something privately right now."
      if (frame.inner?.obligationPending) {
        runningLine += "\ni still owe them an answer."
      }
      lines.push("")
      lines.push(runningLine)
    } else if (job.status === "surfaced") {
      let surfacedLine = "i finished thinking about something privately. i should bring my answer back."
      if (job.surfacedResult) {
        const truncated = job.surfacedResult.length > 120 ? job.surfacedResult.slice(0, 117) + "..." : job.surfacedResult
        surfacedLine += `\nwhat i came to: ${truncated}`
      }
      lines.push("")
      lines.push(surfacedLine)
    }
    // idle, returned, abandoned: omitted
  }

  if ((frame.codingSessions ?? []).length > 0) {
    lines.push("")
    lines.push("## live coding work")
    for (const session of frame.codingSessions) {
      lines.push(`- [${session.status}] ${formatCodingLaneLabel(session)}${describeCodingSessionScope(session, frame.currentSession)}`)
    }
  }

  // Task pressure
  if ((frame.taskPressure?.liveTaskNames ?? []).length > 0) {
    lines.push("")
    lines.push(`i'm also tracking: ${frame.taskPressure.liveTaskNames.join(", ")}.`)
  }

  // Bridges
  if ((frame.bridges ?? []).length > 0) {
    const bridgeLabels = frame.bridges.map((bridge) => `${bridge.id} [${bridgeStateLabel(bridge)}]`)
    lines.push("")
    lines.push(`i have shared work spanning sessions: ${bridgeLabels.join(", ")}.`)
  }

  // Target candidates (keep factual format)
  const targetCandidatesBlock = frame.targetCandidates && frame.targetCandidates.length > 0
    ? formatTargetSessionCandidates(frame.targetCandidates)
    : ""
  if (targetCandidatesBlock) {
    lines.push("")
    lines.push(targetCandidatesBlock)
  }

  if ((frame.pendingObligations ?? []).length > 0) {
    lines.push("")
    lines.push("## return obligations")
    for (const obligation of frame.pendingObligations) {
      if (!isOpenObligationStatus(obligation.status)) continue
      let obligationLine =
        `- [${obligation.status}] ${obligation.origin.friendId}/${obligation.origin.channel}/${obligation.origin.key}: ${obligation.content}${formatObligationSurface(obligation)}`
      if (obligation.latestNote?.trim()) {
        obligationLine += `\n  latest: ${obligation.latestNote.trim()}`
      }
      lines.push(obligationLine)
    }
  }

  // Bridge suggestion
  if (frame.bridgeSuggestion) {
    lines.push("")
    if (frame.bridgeSuggestion.kind === "begin-new") {
      lines.push(`this work touches my conversation on ${formatSessionLabel(frame.bridgeSuggestion.targetSession)} too -- i should connect these threads.`)
    } else {
      lines.push(`this work relates to bridge ${frame.bridgeSuggestion.bridgeId} -- i should connect ${formatSessionLabel(frame.bridgeSuggestion.targetSession)} to it.`)
    }
  }

  return lines.join("\n")
}
