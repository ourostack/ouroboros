import { sanitizeKey } from "../heart/config";
import type { ActiveWorkFrame } from "../heart/active-work";
import type { Obligation } from "../heart/obligations";
import { emitNervesEvent } from "../nerves/runtime";

type SessionOrigin = { friendId: string; channel: string; key: string }
const RECENT_OTHER_LIVE_SESSION_WINDOW_MS = 60 * 60 * 1000

export function findActivePersistentObligation(frame: ActiveWorkFrame | undefined): Obligation | null {
  if (!frame) return null;
  return (frame.pendingObligations ?? []).find((ob) => ob.status !== "pending" && ob.status !== "fulfilled") ?? null;
}

function obligationTimestampMs(obligation: Obligation): number {
  return Date.parse(obligation.updatedAt ?? obligation.createdAt)
}

function newestObligationFirst(left: Obligation, right: Obligation): number {
  return obligationTimestampMs(right) - obligationTimestampMs(left)
}

function matchesCurrentSession(frame: ActiveWorkFrame, obligation: Obligation): boolean {
  return matchesSessionOrigin(frame, obligation.origin)
}

function matchesSessionOrigin(frame: ActiveWorkFrame, origin: SessionOrigin): boolean {
  return Boolean(
    frame.currentSession
    && origin.friendId === frame.currentSession.friendId
    && origin.channel === frame.currentSession.channel
    && sanitizeKey(origin.key) === sanitizeKey(frame.currentSession.key),
  )
}

function sessionOriginKey(origin: SessionOrigin): string {
  return `${origin.friendId}/${origin.channel}/${sanitizeKey(origin.key)}`
}

function codingSessionTimestampMs(session: NonNullable<ActiveWorkFrame["otherCodingSessions"]>[number]): number {
  return Date.parse(session.lastActivityAt ?? session.startedAt)
}

function formatCodingLaneLabel(session: NonNullable<ActiveWorkFrame["otherCodingSessions"]>[number]): string {
  return `${session.runner} ${session.id}`
}

function formatOtherSessionArtifact(
  obligation: Obligation | null,
  codingSession: NonNullable<ActiveWorkFrame["otherCodingSessions"]>[number] | null,
): string {
  if (obligation?.currentArtifact?.trim()) return obligation.currentArtifact.trim()
  if (obligation?.currentSurface?.kind === "merge" && obligation.currentSurface.label.trim()) {
    return obligation.currentSurface.label.trim()
  }
  if (codingSession) return "no PR or merge artifact yet"
  return "no artifact yet"
}

function formatOtherSessionNextAction(
  obligation: Obligation | null,
  codingSession: NonNullable<ActiveWorkFrame["otherCodingSessions"]>[number] | null,
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
    return "continue the active loop and bring the result back there"
  }
  return "check this session and bring back the latest concrete state"
}

function findFriendNameForOrigin(frame: ActiveWorkFrame, origin: SessionOrigin): string {
  return (frame.friendActivity?.allOtherLiveSessions ?? []).find((entry) =>
    sessionOriginKey(entry) === sessionOriginKey(origin),
  )?.friendName ?? origin.friendId
}

function buildOtherActiveSessionLines(frame: ActiveWorkFrame): string[] {
  const originMap = new Map<string, SessionOrigin>()

  for (const session of frame.friendActivity?.allOtherLiveSessions ?? []) {
    if (session.friendId === "self" || session.channel === "inner") continue
    originMap.set(sessionOriginKey(session), {
      friendId: session.friendId,
      channel: session.channel,
      key: session.key,
    })
  }
  for (const session of frame.otherCodingSessions ?? []) {
    if (!session.originSession || matchesSessionOrigin(frame, session.originSession)) continue
    originMap.set(sessionOriginKey(session.originSession), session.originSession)
  }
  for (const obligation of frame.pendingObligations ?? []) {
    if (obligation.status === "fulfilled" || matchesSessionOrigin(frame, obligation.origin)) continue
    originMap.set(sessionOriginKey(obligation.origin), obligation.origin)
  }

  const summaries = [...originMap.values()].map((origin) => {
    const obligation = [...(frame.pendingObligations ?? [])]
      .filter((candidate) => candidate.status !== "fulfilled" && sessionOriginKey(candidate.origin) === sessionOriginKey(origin))
      .sort(newestObligationFirst)[0] ?? null
    const codingSession = [...(frame.otherCodingSessions ?? [])]
      .filter((candidate) => candidate.originSession && sessionOriginKey(candidate.originSession) === sessionOriginKey(origin))
      .sort((left, right) => codingSessionTimestampMs(right) - codingSessionTimestampMs(left))[0] ?? null
    const liveSession = (frame.friendActivity?.allOtherLiveSessions ?? []).find((candidate) => sessionOriginKey(candidate) === sessionOriginKey(origin)) ?? null
    const hasFreshSessionActivity = liveSession
      ? (Date.now() - liveSession.lastActivityMs) <= RECENT_OTHER_LIVE_SESSION_WINDOW_MS
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
    const friendName = findFriendNameForOrigin(frame, origin)
    return {
      timestampMs,
      line: `- ${friendName}/${origin.channel}/${origin.key}: [${status}] ${activeLane}; artifact ${artifact}; next ${nextAction}`,
    }
  }).filter((entry): entry is { timestampMs: number; line: string } => entry !== null)
    .sort((left, right) => right.timestampMs - left.timestampMs)

  return summaries.length > 0 ? summaries.map((entry) => entry.line) : ["- none"]
}

export function findStatusObligation(frame: ActiveWorkFrame | undefined): Obligation | null {
  if (!frame) return null;
  const openObligations = [...(frame.pendingObligations ?? [])]
    .filter((obligation) => obligation.status !== "fulfilled")
    .sort(newestObligationFirst)
  const sameSession = openObligations.find((obligation) => matchesCurrentSession(frame, obligation))
  if (sameSession) return sameSession
  return openObligations[0] ?? null
}

function findCurrentSessionStatusObligation(frame: ActiveWorkFrame): Obligation | null {
  const openObligations = [...(frame.pendingObligations ?? [])]
    .filter((obligation) => obligation.status !== "fulfilled")
    .sort(newestObligationFirst)
  return openObligations.find((obligation) => matchesCurrentSession(frame, obligation)) ?? null
}

export function renderActiveObligationSteering(obligation: Obligation | null): string {
  emitNervesEvent({
    component: "mind",
    event: "mind.obligation_steering_rendered",
    message: "rendered active obligation steering",
    meta: {
      hasObligation: Boolean(obligation),
      hasSurface: Boolean(obligation?.currentSurface?.label),
    },
  })
  if (!obligation) return "";
  const name = obligation.origin.friendId;
  const surfaceLine = obligation.currentSurface?.label
    ? `\nright now that work is happening in ${obligation.currentSurface.label}.`
    : "";
  return `## where my attention is
i'm already working on something i owe ${name}.${surfaceLine}

i should close that loop before i act like this is a fresh blank turn.`;
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

function formatActiveLane(frame: ActiveWorkFrame, obligation: Obligation): string {
  const liveCodingSession = frame.codingSessions?.[0]
  if (liveCodingSession) {
    const sameThread = frame.currentSession
      && liveCodingSession.originSession
      && liveCodingSession.originSession.friendId === frame.currentSession.friendId
      && liveCodingSession.originSession.channel === frame.currentSession.channel
      && liveCodingSession.originSession.key === frame.currentSession.key
    return sameThread
      ? `${liveCodingSession.runner} ${liveCodingSession.id} for this same thread`
      : liveCodingSession.originSession
        ? `${liveCodingSession.runner} ${liveCodingSession.id} for ${liveCodingSession.originSession.channel}/${liveCodingSession.originSession.key}`
        : `${liveCodingSession.runner} ${liveCodingSession.id}`
  }
  return obligation.currentSurface?.label
    || (frame.currentObligation?.trim() ? "this same thread" : "this live loop")
}

function formatCurrentArtifact(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  if (obligation?.currentArtifact) return obligation.currentArtifact
  if (obligation?.currentSurface?.kind === "merge") return obligation.currentSurface.label
  if (frame.currentObligation?.trim()) return "no artifact yet"
  if ((frame.codingSessions ?? []).length > 0) return "no PR or merge artifact yet"
  return obligation ? "no explicit artifact yet" : ""
}

function isStatusCheckPrompt(text: string | undefined): boolean {
  const trimmed = text?.trim()
  if (!trimmed) return false
  return /^(what are you doing|what(?:'|’)s your status|status|status update|what changed|where are you at|where things stand)\??$/i.test(trimmed)
}

function formatNextAction(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  if (obligation?.nextAction) return obligation.nextAction
  const currentObligation = frame.currentObligation?.trim() ?? ""
  const statusCheckPrompt = isStatusCheckPrompt(currentObligation)
  const liveCodingSession = frame.codingSessions?.[0]
  if (liveCodingSession?.status === "waiting_input") {
    return `answer ${liveCodingSession.runner} ${liveCodingSession.id} and continue`
  }
  if (liveCodingSession?.status === "stalled") {
    return `unstick ${liveCodingSession.runner} ${liveCodingSession.id} and continue`
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
  if (currentObligation && !statusCheckPrompt) {
    return `work on "${currentObligation}" and bring back a concrete artifact`
  }
  return obligation ? "continue the active loop and bring the result back here" : ""
}

export function renderConcreteStatusGuidance(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  const activeLane = obligation ? formatActiveLane(frame, obligation) : (frame.currentObligation?.trim() ? "this same thread" : "")
  const currentArtifact = formatCurrentArtifact(frame, obligation)
  const nextAction = formatNextAction(frame, obligation)
  const liveConversation = frame.currentSession
    ? `${frame.currentSession.channel}/${frame.currentSession.key}`
    : ""

  if (!activeLane && !currentArtifact && !nextAction) return ""

  return `if someone asks what i'm doing or for status mid-task, i answer from these live facts instead of copying a canned block.
the live conversation is ${liveConversation || "not in a live conversation"}.
the active lane is ${activeLane}.
the current artifact is ${currentArtifact}.
if i just finished or verified something concrete in this live lane, i name that as the latest checkpoint.
the next action is ${nextAction}.

i use those facts to answer naturally unless this turn is an explicit direct status check, where the separate exact five-line contract applies.`
}

export function renderLiveThreadStatusShape(frame: ActiveWorkFrame): string {
  if (!frame.currentSession) return ""
  return `if someone asks what i'm doing or for status mid-task in this live thread, i answer in these exact lines, in order, with no intro paragraph:
live conversation: ${frame.currentSession.channel}/${frame.currentSession.key}
active lane: this same thread
current artifact: <actual artifact or "no artifact yet">
latest checkpoint: <freshest concrete thing i just finished or verified>
next action: <smallest concrete next step i'm taking now>

no recap paragraph before those lines.
no option list.
present tense only.
if a finished step matters, i label it "just finished" instead of presenting it as current work.`
}

export function buildExactStatusReply(
  frame: ActiveWorkFrame,
  obligation: Obligation | null,
  latestCheckpoint: string,
  statusCheckScope?: "all-sessions-family",
): string {
  const headerObligation = statusCheckScope === "all-sessions-family"
    ? findCurrentSessionStatusObligation(frame)
    : obligation
  const liveConversation = frame.currentSession
    ? `${frame.currentSession.channel}/${frame.currentSession.key}`
    : "not in a live conversation"
  const activeLane = headerObligation
    ? formatActiveLane(frame, headerObligation)
    : (frame.currentSession ? "this same thread" : "this live loop")
  const currentArtifact = formatCurrentArtifact(frame, headerObligation) || "no artifact yet"
  const nextAction = formatNextAction(frame, headerObligation) || "continue the active loop and bring the result back here"
  const latest = latestCheckpoint.trim() || "<freshest concrete thing i just finished or verified>"

  const lines = [
    `live conversation: ${liveConversation}`,
    `active lane: ${activeLane}`,
    `current artifact: ${currentArtifact}`,
    `latest checkpoint: ${latest}`,
    `next action: ${nextAction}`,
  ]

  if (statusCheckScope === "all-sessions-family") {
    lines.push("other active sessions:")
    lines.push(...buildOtherActiveSessionLines(frame))
  }

  return lines.join("\n")
}

export function renderExactStatusReplyContract(
  frame: ActiveWorkFrame,
  obligation: Obligation | null,
  statusCheckScope?: "all-sessions-family",
): string {
  const headerObligation = statusCheckScope === "all-sessions-family"
    ? findCurrentSessionStatusObligation(frame)
    : obligation
  if (statusCheckScope === "all-sessions-family") {
    return `reply using exactly this status shape and nothing else:
live conversation: ${frame.currentSession ? `${frame.currentSession.channel}/${frame.currentSession.key}` : "not in a live conversation"}
active lane: ${headerObligation ? formatActiveLane(frame, headerObligation) : (frame.currentSession ? "this same thread" : "this live loop")}
current artifact: ${formatCurrentArtifact(frame, headerObligation) || "no artifact yet"}
latest checkpoint: <freshest concrete thing i just finished or verified>
next action: ${formatNextAction(frame, headerObligation) || "continue the active loop and bring the result back here"}
other active sessions:
- <session label>: <what i'm doing there right now>`
  }

  return `reply using exactly these five lines and nothing else:
${buildExactStatusReply(frame, obligation, "<freshest concrete thing i just finished or verified>")}
`
}
