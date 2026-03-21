import type { Channel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import type { BoardResult } from "../repertoire/tasks/types"
import type { CodingSession } from "../repertoire/coding/types"
import { bridgeStateLabel } from "./bridges/state-machine"
import type { BridgeRecord } from "./bridges/store"
import type { InnerJob } from "./daemon/thoughts"
import { isOpenObligation, isOpenObligationStatus, type Obligation } from "./obligations"
import type { SessionActivityRecord } from "./session-activity"
import { formatTargetSessionCandidates, type TargetSessionCandidate } from "./target-resolution"
import { sanitizeKey } from "./config"

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
    allOtherLiveSessions?: SessionActivityRecord[]
  }
  codingSessions: CodingSession[]
  otherCodingSessions?: CodingSession[]
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
  otherCodingSessions?: CodingSession[]
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
  pendingObligations?: Obligation[]
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

function hasSharedObligationPressure(input: Pick<BuildActiveWorkFrameInput, "mustResolveBeforeHandoff" | "taskBoard" | "pendingObligations">): boolean {
  return input.mustResolveBeforeHandoff
    || summarizeLiveTasks(input.taskBoard).length > 0
    || activeObligationCount(input.pendingObligations) > 0
}

function formatCodingLaneLabel(session: CodingSession): string {
  return `${session.runner} ${session.id}`
}

function compactCodingCheckpoint(session: CodingSession): string {
  const checkpoint = session.checkpoint?.replace(/\s+/g, " ").trim()
  if (!checkpoint) return ""
  return checkpoint.length <= 80 ? checkpoint : `${checkpoint.slice(0, 77)}...`
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

function mergeArtifactFallback(obligation: Obligation): string {
  const trimmed = obligation.content.trim()
  if (!trimmed) return "the fix"
  const stripped = trimmed.replace(/^merge(?:\s+|$)/i, "").trim()
  return stripped || "the fix"
}

function formatMergeArtifact(obligation: Obligation): string {
  const currentArtifact = obligation.currentArtifact?.trim()
  if (currentArtifact) return currentArtifact
  if (obligation.currentSurface?.kind === "merge") {
    const surfaceLabel = obligation.currentSurface.label.trim()
    if (surfaceLabel) return surfaceLabel
  }
  return mergeArtifactFallback(obligation)
}

function findPrimaryOpenObligation(frame: ActiveWorkFrame): Obligation | null {
  return (frame.pendingObligations ?? []).find((ob) => ob.status !== "pending" && ob.status !== "fulfilled")
    ?? (frame.pendingObligations ?? []).find(isOpenObligation)
    ?? null
}

function matchesCurrentSession(frame: ActiveWorkFrame, obligation: Obligation): boolean {
  return Boolean(
    frame.currentSession
    && obligation.origin.friendId === frame.currentSession.friendId
    && obligation.origin.channel === frame.currentSession.channel
    && sanitizeKey(obligation.origin.key) === sanitizeKey(frame.currentSession.key),
  )
}

function findCurrentSessionOpenObligation(frame: ActiveWorkFrame): Obligation | null {
  return (frame.pendingObligations ?? []).find((obligation) => isOpenObligationStatus(obligation.status) && matchesCurrentSession(frame, obligation))
    ?? null
}

function formatActiveLane(frame: ActiveWorkFrame, obligation: Obligation | null): string | null {
  const liveCodingSession = frame.codingSessions?.[0]
  if (liveCodingSession) {
    return `${formatCodingLaneLabel(liveCodingSession)}${describeCodingSessionScope(liveCodingSession, frame.currentSession)}`
  }
  if (obligation?.currentSurface?.label) {
    return obligation.currentSurface.label
  }
  if (obligation && matchesCurrentSession(frame, obligation) && frame.currentSession) {
    return "this same thread"
  }
  if (frame.inner?.job?.status === "running") {
    return "inner dialog"
  }
  return null
}

function formatCurrentArtifact(frame: ActiveWorkFrame, obligation: Obligation | null): string | null {
  if (obligation?.currentArtifact?.trim()) {
    return obligation.currentArtifact.trim()
  }
  if (obligation?.currentSurface?.kind === "merge" && obligation.currentSurface.label.trim()) {
    return obligation.currentSurface.label.trim()
  }
  if ((frame.codingSessions ?? []).length > 0) {
    return "no PR or merge artifact yet"
  }
  if (obligation) {
    return "no artifact yet"
  }
  return null
}

function formatObligationContentNextAction(obligation: Obligation | null): string | null {
  const content = obligation?.content?.trim()
  if (!content) return null
  return `work on "${content}" and bring back a concrete artifact`
}

function formatNextAction(frame: ActiveWorkFrame, obligation: Obligation | null): string | null {
  if (obligation?.nextAction?.trim()) {
    return obligation.nextAction.trim()
  }
  const liveCodingSession = frame.codingSessions?.[0]
  if (liveCodingSession?.status === "waiting_input") {
    return `answer ${formatCodingLaneLabel(liveCodingSession)} and continue`
  }
  if (liveCodingSession?.status === "stalled") {
    return `unstick ${formatCodingLaneLabel(liveCodingSession)} and continue`
  }
  if (liveCodingSession) {
    return "finish the coding pass and bring the result back here"
  }
  if (obligation?.status === "waiting_for_merge") {
    return `wait for checks, merge ${formatMergeArtifact(obligation)}, then update runtime`
  }
  if (obligation?.status === "updating_runtime") {
    return "update runtime, verify version/changelog, then re-observe"
  }
  if (obligation) {
    return formatObligationContentNextAction(obligation) || "continue the active loop and bring the result back here"
  }
  if (frame.mustResolveBeforeHandoff) {
    return "finish what i started here before moving on"
  }
  return null
}

type SessionOrigin = { friendId: string; channel: string; key: string }
const RECENT_OTHER_LIVE_SESSION_WINDOW_MS = 60 * 60 * 1000

function sessionOriginKey(origin: SessionOrigin): string {
  return `${origin.friendId}/${origin.channel}/${sanitizeKey(origin.key)}`
}

function codingSessionTimestampMs(session: CodingSession): number {
  return Date.parse(session.lastActivityAt ?? session.startedAt)
}

function obligationTimestampMs(obligation: Obligation): number {
  return Date.parse(obligation.updatedAt ?? obligation.createdAt)
}

function newestObligationFirst(left: Obligation, right: Obligation): number {
  return obligationTimestampMs(right) - obligationTimestampMs(left)
}

function formatOtherSessionArtifact(
  obligation: Obligation | null,
  codingSession: CodingSession | null,
): string {
  if (obligation?.currentArtifact?.trim()) return obligation.currentArtifact.trim()
  if (obligation?.currentSurface?.kind === "merge" && obligation.currentSurface.label.trim()) {
    return obligation.currentSurface.label.trim()
  }
  if (codingSession) return "no PR or merge artifact yet"
  return obligation ? "no artifact yet" : "no explicit artifact yet"
}

function formatOtherSessionNextAction(
  obligation: Obligation | null,
  codingSession: CodingSession | null,
): string {
  if (obligation?.nextAction?.trim()) return obligation.nextAction.trim()
  if (obligation?.status === "waiting_for_merge") {
    return `wait for checks, merge ${formatMergeArtifact(obligation)}, then update runtime`
  }
  if (obligation?.status === "updating_runtime") {
    return "update runtime, verify version/changelog, then re-observe"
  }
  if (codingSession?.status === "waiting_input") {
    return `answer ${formatCodingLaneLabel(codingSession)} and continue`
  }
  if (codingSession?.status === "stalled") {
    return `unstick ${formatCodingLaneLabel(codingSession)} and continue`
  }
  if (codingSession) {
    return "finish the coding pass and bring the result back there"
  }
  if (obligation) {
    return formatObligationContentNextAction(obligation) || "continue the active loop and bring the result back there"
  }
  return "check this session and bring back the latest concrete state"
}

function formatOtherSessionLine(
  label: string,
  status: string,
  activeLane: string,
  artifact: string,
  nextAction: string,
): string {
  return `- ${label}: [${status}] ${activeLane}; artifact ${artifact}; next ${nextAction}`
}

export function formatOtherActiveSessionSummaries(frame: ActiveWorkFrame, nowMs = Date.now()): string[] {
  const originMap = new Map<string, SessionOrigin>()

  for (const session of frame.friendActivity?.allOtherLiveSessions ?? []) {
    if (session.friendId === "self" || session.channel === "inner") continue
    originMap.set(sessionOriginKey(session), {
      friendId: session.friendId,
      channel: session.channel,
      key: session.key,
    })
  }

  const orphanCodingSummaries = (frame.otherCodingSessions ?? [])
    .filter((session) => !session.originSession)
    .sort((left, right) => codingSessionTimestampMs(right) - codingSessionTimestampMs(left))
    .map((session) => ({
      timestampMs: codingSessionTimestampMs(session),
      line: formatOtherSessionLine(
        "another session",
        session.status,
        formatCodingLaneLabel(session),
        "no PR or merge artifact yet",
        formatOtherSessionNextAction(null, session),
      ),
    }))

  for (const session of frame.otherCodingSessions ?? []) {
    if (!session.originSession) continue
    if (
      frame.currentSession
      && session.originSession.friendId === frame.currentSession.friendId
      && session.originSession.channel === frame.currentSession.channel
      && sanitizeKey(session.originSession.key) === sanitizeKey(frame.currentSession.key)
    ) {
      continue
    }
    originMap.set(sessionOriginKey(session.originSession), session.originSession)
  }

  for (const obligation of frame.pendingObligations ?? []) {
    if (obligation.status === "fulfilled" || matchesCurrentSession(frame, obligation)) continue
    originMap.set(sessionOriginKey(obligation.origin), obligation.origin)
  }

  const summaries = [...originMap.values()].map((origin) => {
    const originKey = sessionOriginKey(origin)
    const obligation = [...(frame.pendingObligations ?? [])]
      .filter((candidate) => candidate.status !== "fulfilled" && sessionOriginKey(candidate.origin) === originKey)
      .sort(newestObligationFirst)[0] ?? null
    const codingSession = [...(frame.otherCodingSessions ?? [])]
      .filter((candidate) => candidate.originSession && sessionOriginKey(candidate.originSession) === originKey)
      .sort((left, right) => codingSessionTimestampMs(right) - codingSessionTimestampMs(left))[0] ?? null
    const liveSession = (frame.friendActivity?.allOtherLiveSessions ?? []).find((candidate) => sessionOriginKey(candidate) === originKey) ?? null
    const hasFreshSessionActivity = liveSession
      ? (nowMs - liveSession.lastActivityMs) <= RECENT_OTHER_LIVE_SESSION_WINDOW_MS
      : false
    if (!obligation && !codingSession && !hasFreshSessionActivity) {
      return null
    }
    const timestampMs = Math.max(
      liveSession?.lastActivityMs ?? 0,
      codingSession ? codingSessionTimestampMs(codingSession) : 0,
      obligation ? obligationTimestampMs(obligation) : 0,
    )
    const activeLane = codingSession
      ? formatCodingLaneLabel(codingSession)
      : obligation?.currentSurface?.label?.trim() || "this live thread"
    const artifact = formatOtherSessionArtifact(obligation, codingSession)
    const nextAction = formatOtherSessionNextAction(obligation, codingSession)
    const status = obligation?.status ?? codingSession?.status ?? "active"
    const label = liveSession?.friendName ?? origin.friendId
    return {
      timestampMs,
      line: formatOtherSessionLine(`${label}/${origin.channel}/${origin.key}`, status, activeLane, artifact, nextAction),
    }
  }).filter((entry): entry is { timestampMs: number; line: string } => entry !== null)
    .sort((left, right) => right.timestampMs - left.timestampMs)

  const lines = summaries.map((entry) => entry.line)
  return [...lines, ...orphanCodingSummaries.map((entry) => entry.line)]
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
  if (!hasSharedObligationPressure({
    mustResolveBeforeHandoff: input.mustResolveBeforeHandoff,
    taskBoard: input.taskBoard,
    pendingObligations: input.pendingObligations,
  }) || targetCandidates.length === 0) {
    return null
  }
  const targetSession = targetCandidates[0]
  const objectiveHint = [...(input.pendingObligations ?? [])]
    .find((obligation) => isOpenObligationStatus(obligation.status))
    ?.content?.trim() || "keep this shared work aligned"

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
    objectiveHint,
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
  const allOtherLiveSessions = [...input.friendActivity].sort(compareActivity)
  const otherCodingSessions = input.otherCodingSessions ?? []
  const pendingObligations = input.pendingObligations ?? []
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
      allOtherLiveSessions,
    },
    codingSessions: liveCodingSessions,
    otherCodingSessions,
    pendingObligations,
    targetCandidates: input.targetCandidates ?? [],
    bridgeSuggestion: suggestBridgeForActiveWork({
      currentSession: input.currentSession,
      currentObligation: input.currentObligation,
      mustResolveBeforeHandoff: input.mustResolveBeforeHandoff,
      bridges: input.bridges,
      pendingObligations: input.pendingObligations,
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
      otherLiveSessions: allOtherLiveSessions.length,
      otherCodingSessions: otherCodingSessions.length,
      pendingObligations: openObligations,
      hasBridgeSuggestion: frame.bridgeSuggestion !== null,
    },
  })

  return frame
}

export function formatActiveWorkFrame(frame: ActiveWorkFrame): string {
  const lines = ["## what i'm holding"]
  const primaryObligation = findPrimaryOpenObligation(frame)
  const currentSessionObligation = findCurrentSessionOpenObligation(frame)
  const activeLane = formatActiveLane(frame, primaryObligation)
  const currentArtifact = formatCurrentArtifact(frame, primaryObligation)
  const nextAction = formatNextAction(frame, primaryObligation)
  const otherActiveSessions = formatOtherActiveSessionSummaries(frame)

  // Session line
  if (frame.currentSession) {
    let sessionLine = `i'm in a conversation on ${formatSessionLabel(frame.currentSession)}.`
    if (currentSessionObligation?.content?.trim()) {
      sessionLine += ` i still owe them: ${currentSessionObligation.content.trim()}.`
    } else if (frame.mustResolveBeforeHandoff) {
      sessionLine += " i need to finish what i started here before moving on."
    }
    lines.push("")
    lines.push(sessionLine)
  } else {
    lines.push("")
    lines.push("i'm not in a conversation right now.")
  }

  if (activeLane || currentArtifact || nextAction) {
    lines.push("")
    lines.push("## current concrete state")
    if (frame.currentSession) {
      lines.push(`- live conversation: ${formatSessionLabel(frame.currentSession)}`)
    }
    if (activeLane) {
      lines.push(`- active lane: ${activeLane}`)
    }
    if (currentArtifact) {
      lines.push(`- current artifact: ${currentArtifact}`)
    }
    if (nextAction) {
      lines.push(`- next action: ${nextAction}`)
    }
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
      const checkpoint = compactCodingCheckpoint(session)
      lines.push(
        `- [${session.status}] ${formatCodingLaneLabel(session)}${describeCodingSessionScope(session, frame.currentSession)}${checkpoint ? `: ${checkpoint}` : ""}`,
      )
    }
  }

  if (otherActiveSessions.length > 0) {
    lines.push("")
    lines.push("## other active sessions")
    lines.push(...otherActiveSessions)
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
