import { sanitizeKey } from "../heart/config";
import { formatOtherActiveSessionSummaries, type ActiveWorkFrame } from "../heart/active-work";
import type { Obligation } from "../arc/obligations";
import { emitNervesEvent } from "../nerves/runtime";

type SessionOrigin = { friendId: string; channel: string; key: string }

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
    || (matchesCurrentSession(frame, obligation) ? "this same thread" : "this live loop")
}

function formatCurrentArtifact(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  if (obligation?.currentArtifact) return obligation.currentArtifact
  if (obligation?.currentSurface?.kind === "merge") return obligation.currentSurface.label
  if ((frame.codingSessions ?? []).length > 0) return "no PR or merge artifact yet"
  return obligation ? "no artifact yet" : ""
}

function formatNextAction(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  const obligationHasConcreteArtifact = Boolean(obligation?.currentArtifact?.trim())
    || obligation?.currentSurface?.kind === "merge"
  if (obligation?.status === "waiting_for_merge") {
    return obligation.nextAction?.trim() || `wait for checks, merge ${formatMergeArtifact(obligation)}, then update runtime`
  }
  if (obligation?.status === "updating_runtime") {
    return obligation.nextAction?.trim() || "update runtime, verify version/changelog, then re-observe"
  }
  if (obligationHasConcreteArtifact && obligation?.nextAction?.trim()) {
    return obligation.nextAction.trim()
  }
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
  if (obligation?.nextAction?.trim()) return obligation.nextAction.trim()
  if (obligation?.content?.trim()) {
    return `work on "${obligation.content.trim()}" and bring back a concrete artifact`
  }
  return obligation ? "continue the active loop and bring the result back here" : ""
}

export function renderConcreteStatusGuidance(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  const activeLane = obligation ? formatActiveLane(frame, obligation) : ""
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

i answer naturally from those facts instead of forcing a canned status block.`
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
    const summaries = formatOtherActiveSessionSummaries(frame)
    lines.push(...(summaries.length > 0 ? summaries : ["- none"]))
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
