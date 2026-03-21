import type { ActiveWorkFrame } from "../heart/active-work";
import type { Obligation } from "../heart/obligations";
import { emitNervesEvent } from "../nerves/runtime";

export function findActivePersistentObligation(frame: ActiveWorkFrame | undefined): Obligation | null {
  if (!frame) return null;
  return (frame.pendingObligations ?? []).find((ob) => ob.status !== "pending" && ob.status !== "fulfilled") ?? null;
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
  return obligation.currentSurface?.label || "this live loop"
}

function formatCurrentArtifact(frame: ActiveWorkFrame, obligation: Obligation): string {
  return obligation.currentArtifact
    || (obligation.currentSurface?.kind === "merge" ? obligation.currentSurface.label : "")
    || ((frame.codingSessions ?? []).length > 0 ? "no PR or merge artifact yet" : "no explicit artifact yet")
}

function formatNextAction(frame: ActiveWorkFrame, obligation: Obligation): string {
  if (obligation.nextAction) return obligation.nextAction
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
  if (obligation.status === "waiting_for_merge") {
    return `wait for checks, merge ${formatCurrentArtifact(frame, obligation)}, then update runtime`
  }
  if (obligation.status === "updating_runtime") {
    return "update runtime, verify version/changelog, then re-observe"
  }
  return "continue the active loop and bring the result back here"
}

export function renderConcreteStatusGuidance(frame: ActiveWorkFrame, obligation: Obligation | null): string {
  if (!obligation) return ""

  const activeLane = formatActiveLane(frame, obligation)
  const currentArtifact = formatCurrentArtifact(frame, obligation)
  const nextAction = formatNextAction(frame, obligation)

  return `if someone asks what i'm doing or for status, i answer from the concrete state:
- active lane: ${activeLane}
- current artifact: ${currentArtifact}
- next action: ${nextAction}

i don't replace that with a broad mission statement if this concrete state is available.`
}
