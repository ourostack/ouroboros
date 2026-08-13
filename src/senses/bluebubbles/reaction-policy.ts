import { emitNervesEvent } from "../../nerves/runtime"
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
  | "capture_only_negative"
  | "capture_only_question"

export type BlueBubblesReactionPolicyDecision =
  {
    route: "capture_only"
    outcome: BlueBubblesReactionCaptureOnlyOutcome
  }

export interface BlueBubblesReactionPolicyInput {
  fromMe: boolean
  action: BlueBubblesReactionAction
  canonicalValue: BlueBubblesReactionDescriptor["canonicalValue"]
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
  } else if (input.canonicalValue === "question") {
    decision = { route: "capture_only", outcome: "capture_only_question" }
  } else {
    decision = { route: "capture_only", outcome: "capture_only_negative" }
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_reaction_policy_evaluated",
    message: "evaluated bluebubbles reaction routing policy",
    meta: {
      action: input.action,
      canonicalValue: input.canonicalValue,
      fromMe: input.fromMe,
      route: decision.route,
      outcome: decision.outcome,
    },
  })
  return decision
}
