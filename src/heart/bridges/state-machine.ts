import { emitNervesEvent } from "../../nerves/runtime"

export type BridgeLifecycle = "forming" | "active" | "suspended" | "completed" | "cancelled"
export type BridgeRuntime = "idle" | "processing" | "awaiting-follow-up"
export type BridgeStateLabel =
  | "forming"
  | "active-idle"
  | "active-processing"
  | "awaiting-follow-up"
  | "suspended"
  | "completed"
  | "cancelled"

export interface BridgeState {
  lifecycle: BridgeLifecycle
  runtime: BridgeRuntime
}

function transition(state: BridgeState, next: BridgeState, action: string): BridgeState {
  emitNervesEvent({
    component: "engine",
    event: "engine.bridge_state_transition",
    message: "bridge state transitioned",
    meta: {
      action,
      from: bridgeStateLabel(state),
      to: bridgeStateLabel(next),
    },
  })
  return next
}

function assertNonTerminal(state: BridgeState, action: string): void {
  if (state.lifecycle === "completed" || state.lifecycle === "cancelled") {
    throw new Error(`cannot ${action} a terminal bridge`)
  }
}

export function createBridgeState(): BridgeState {
  return {
    lifecycle: "forming",
    runtime: "idle",
  }
}

export function bridgeStateLabel(state: BridgeState): BridgeStateLabel {
  switch (state.lifecycle) {
    case "forming":
      return "forming"
    case "suspended":
      return "suspended"
    case "completed":
      return "completed"
    case "cancelled":
      return "cancelled"
    case "active":
      if (state.runtime === "processing") return "active-processing"
      if (state.runtime === "awaiting-follow-up") return "awaiting-follow-up"
      return "active-idle"
  }
}

export function activateBridge(state: BridgeState): BridgeState {
  assertNonTerminal(state, "activate")
  if (state.lifecycle !== "forming" && state.lifecycle !== "suspended") {
    throw new Error("cannot activate bridge from current state")
  }
  return transition(state, { lifecycle: "active", runtime: "idle" }, "activate")
}

export function beginBridgeProcessing(state: BridgeState): BridgeState {
  assertNonTerminal(state, "process")
  if (state.lifecycle !== "active" || state.runtime !== "idle") {
    throw new Error("cannot process bridge from current state")
  }
  return transition(state, { lifecycle: "active", runtime: "processing" }, "begin-processing")
}

export function queueBridgeFollowUp(state: BridgeState): BridgeState {
  assertNonTerminal(state, "queue")
  if (state.lifecycle !== "active") {
    throw new Error("cannot queue follow-up for non-active bridge")
  }
  if (state.runtime === "processing") {
    return transition(state, { lifecycle: "active", runtime: "awaiting-follow-up" }, "queue-follow-up")
  }
  if (state.runtime === "awaiting-follow-up") {
    return state
  }
  throw new Error("cannot queue follow-up when bridge is not processing")
}

export function advanceBridgeAfterTurn(state: BridgeState): BridgeState {
  assertNonTerminal(state, "advance")
  if (state.lifecycle !== "active") {
    throw new Error("cannot advance non-active bridge")
  }
  if (state.runtime === "processing") {
    return transition(state, { lifecycle: "active", runtime: "idle" }, "finish-processing")
  }
  if (state.runtime === "awaiting-follow-up") {
    return transition(state, { lifecycle: "active", runtime: "processing" }, "resume-follow-up")
  }
  throw new Error("cannot advance an idle bridge")
}

export function suspendBridge(state: BridgeState): BridgeState {
  assertNonTerminal(state, "suspend")
  if ((state.lifecycle !== "forming" && state.lifecycle !== "active") || state.runtime !== "idle") {
    throw new Error("cannot suspend bridge from current state")
  }
  return transition(state, { lifecycle: "suspended", runtime: "idle" }, "suspend")
}

export function completeBridge(state: BridgeState): BridgeState {
  assertNonTerminal(state, "complete")
  if (state.runtime !== "idle") {
    throw new Error("cannot complete a bridge mid-turn")
  }
  return transition(state, { lifecycle: "completed", runtime: "idle" }, "complete")
}

export function cancelBridge(state: BridgeState): BridgeState {
  assertNonTerminal(state, "cancel")
  if (state.runtime !== "idle") {
    throw new Error("cannot cancel a bridge mid-turn")
  }
  return transition(state, { lifecycle: "cancelled", runtime: "idle" }, "cancel")
}
