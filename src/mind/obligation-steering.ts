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
