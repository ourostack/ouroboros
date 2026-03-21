import type { ActiveWorkFrame } from "../heart/active-work";
import type { Obligation } from "../heart/obligations";
import { emitNervesEvent } from "../nerves/runtime";

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
  return Boolean(
    frame.currentSession
    && obligation.origin.friendId === frame.currentSession.friendId
    && obligation.origin.channel === frame.currentSession.channel
    && obligation.origin.key === frame.currentSession.key,
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
): string {
  const liveConversation = frame.currentSession
    ? `${frame.currentSession.channel}/${frame.currentSession.key}`
    : "not in a live conversation"
  const activeLane = obligation
    ? formatActiveLane(frame, obligation)
    : (frame.currentSession ? "this same thread" : "this live loop")
  const currentArtifact = formatCurrentArtifact(frame, obligation) || 'no artifact yet'
  const nextAction = formatNextAction(frame, obligation) || "continue the active loop and bring the result back here"
  const latest = latestCheckpoint.trim() || "<freshest concrete thing i just finished or verified>"

  return [
    `live conversation: ${liveConversation}`,
    `active lane: ${activeLane}`,
    `current artifact: ${currentArtifact}`,
    `latest checkpoint: ${latest}`,
    `next action: ${nextAction}`,
  ].join("\n")
}

export function renderExactStatusReplyContract(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  return `reply using exactly these five lines and nothing else:
${buildExactStatusReply(frame, obligation, "<freshest concrete thing i just finished or verified>")}
`
}
