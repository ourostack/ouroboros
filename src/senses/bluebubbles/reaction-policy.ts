import { emitNervesEvent } from "../../nerves/runtime"
import type { IngressTargetAuthorship } from "../ingress-evidence"
import type {
  BlueBubblesReactionAction,
  BlueBubblesReactionDescriptor,
} from "./model"

export type BlueBubblesReactionCaptureOnlyOutcome =
  | "ignored_self"
  | "capture_only_removal"
  | "capture_only_positive"
  | "capture_only_custom"
  | "capture_only_unknown"
  | "capture_only_target_not_agent"
  | "capture_only_untrusted_actor"

export type BlueBubblesReactionPolicyDecision =
  | {
      route: "capture_only"
      outcome: BlueBubblesReactionCaptureOnlyOutcome
    }
  | { route: "trust_required" }
  | { route: "restricted_feedback" }

export interface BlueBubblesReactionPolicyInput {
  fromMe: boolean
  action: BlueBubblesReactionAction
  canonicalValue: BlueBubblesReactionDescriptor["canonicalValue"]
  targetAuthorship: IngressTargetAuthorship
  trustedActor?: boolean
}

const POSITIVE_REACTIONS = new Set<BlueBubblesReactionDescriptor["canonicalValue"]>([
  "love",
  "like",
  "laugh",
  "emphasize",
])

export function classifyBlueBubblesReaction(
  input: BlueBubblesReactionPolicyInput,
): BlueBubblesReactionPolicyDecision {
  let decision: BlueBubblesReactionPolicyDecision
  if (input.fromMe) {
    decision = { route: "capture_only", outcome: "ignored_self" }
  } else if (input.action === "remove") {
    decision = { route: "capture_only", outcome: "capture_only_removal" }
  } else if (POSITIVE_REACTIONS.has(input.canonicalValue)) {
    decision = { route: "capture_only", outcome: "capture_only_positive" }
  } else if (input.canonicalValue === "custom") {
    decision = { route: "capture_only", outcome: "capture_only_custom" }
  } else if (input.canonicalValue === "unknown") {
    decision = { route: "capture_only", outcome: "capture_only_unknown" }
  } else if (input.targetAuthorship !== "agent") {
    decision = { route: "capture_only", outcome: "capture_only_target_not_agent" }
  } else if (input.trustedActor === undefined) {
    decision = { route: "trust_required" }
  } else if (!input.trustedActor) {
    decision = { route: "capture_only", outcome: "capture_only_untrusted_actor" }
  } else {
    decision = { route: "restricted_feedback" }
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_reaction_policy_evaluated",
    message: "evaluated bluebubbles reaction routing policy",
    meta: {
      action: input.action,
      canonicalValue: input.canonicalValue,
      fromMe: input.fromMe,
      targetAuthorship: input.targetAuthorship,
      trustEvaluated: input.trustedActor !== undefined,
      route: decision.route,
      outcome: decision.route === "capture_only" ? decision.outcome : null,
    },
  })
  return decision
}
