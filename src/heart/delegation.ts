import type { Channel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import type { ActiveWorkFrame } from "./active-work"

export type DelegationReason =
  | "explicit_reflection"
  | "cross_session"
  | "bridge_state"
  | "task_state"
  | "non_fast_path_tool"
  | "unresolved_obligation"

export interface DelegationDecision {
  target: "fast-path" | "delegate-inward"
  reasons: DelegationReason[]
  outwardClosureRequired: boolean
}

interface DelegationInput {
  channel: Channel
  ingressTexts: string[]
  activeWork: ActiveWorkFrame
  mustResolveBeforeHandoff: boolean
  requestedToolNames?: string[]
}

const CROSS_SESSION_TOOLS = new Set(["query_session", "send_message", "bridge_manage"])
const FAST_PATH_TOOLS = new Set(["final_answer"])
const REFLECTION_PATTERN = /\b(think|reflect|ponder|surface|surfaces|surfaced|sit with|metaboli[sz]e)\b/i
const CROSS_SESSION_PATTERN = /\b(other chat|other session|across chats?|across sessions?|keep .* aligned|relay|carry .* across)\b/i

function hasExplicitReflection(ingressTexts: string[]): boolean {
  return ingressTexts.some((text) => REFLECTION_PATTERN.test(text))
}

function hasCrossSessionPressure(ingressTexts: string[], requestedToolNames: string[]): boolean {
  if (requestedToolNames.some((name) => CROSS_SESSION_TOOLS.has(name))) {
    return true
  }
  return ingressTexts.some((text) => CROSS_SESSION_PATTERN.test(text))
}

function hasNonFastPathToolRequest(requestedToolNames: string[]): boolean {
  return requestedToolNames.some((name) => !FAST_PATH_TOOLS.has(name))
}

export function decideDelegation(input: DelegationInput): DelegationDecision {
  const requestedToolNames = (input.requestedToolNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  const reasons: DelegationReason[] = []
  if (hasExplicitReflection(input.ingressTexts)) {
    reasons.push("explicit_reflection")
  }
  if (hasCrossSessionPressure(input.ingressTexts, requestedToolNames)) {
    reasons.push("cross_session")
  }
  if (input.activeWork.centerOfGravity === "shared-work" || input.activeWork.bridges.some((bridge) => bridge.lifecycle === "active")) {
    reasons.push("bridge_state")
  }
  if (input.activeWork.taskPressure.liveTaskNames.length > 0) {
    reasons.push("task_state")
  }
  if (hasNonFastPathToolRequest(requestedToolNames)) {
    reasons.push("non_fast_path_tool")
  }
  if (input.mustResolveBeforeHandoff || input.activeWork.mustResolveBeforeHandoff) {
    reasons.push("unresolved_obligation")
  }

  const target = reasons.length === 0 ? "fast-path" : "delegate-inward"
  const decision: DelegationDecision = {
    target,
    reasons,
    outwardClosureRequired: target === "delegate-inward" && input.channel !== "inner",
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.delegation_decide",
    message: "computed delegation hint",
    meta: {
      channel: input.channel,
      target: decision.target,
      reasons: decision.reasons,
      outwardClosureRequired: decision.outwardClosureRequired,
    },
  })

  return decision
}
