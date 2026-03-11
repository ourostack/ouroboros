import { emitNervesEvent } from "../nerves/runtime"

export type SteeringFollowUpEffect = "none" | "set_no_handoff" | "clear_and_supersede"

const NO_HANDOFF_CLAUSES = new Set([
  "dont return control until complete or blocked",
  "do not return control until complete or blocked",
  "dont hand back control until complete or blocked",
  "do not hand back control until complete or blocked",
  "keep going until youre done",
  "keep going until you are done",
  "keep working until youre done",
  "keep working until you are done",
  "dont stop until youre done",
  "do not stop until youre done",
  "only come back if blocked",
  "only return if blocked",
  "only respond if blocked",
  "work autonomously on this",
  "work on this autonomously",
  "handle this autonomously",
])

const CANCEL_SUPERSEDE_CLAUSES = new Set([
  "stop",
  "cancel that",
  "cancel this",
  "never mind",
  "nevermind",
  "forget it",
  "ignore that",
  "ignore this",
  "hold off",
  "ill take it from here",
  "i will take it from here",
  "lets do something else",
  "stop working on that",
  "stop working on this",
  "dont do that",
  "do not do that",
])

export function normalizeContinuityClauses(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\n.!?;]+/)
    .map((clause) => clause.replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

export function resolveMustResolveBeforeHandoff(
  initialValue: boolean,
  ingressTexts: readonly string[] | undefined,
): boolean {
  let current = initialValue

  for (const text of ingressTexts ?? []) {
    for (const clause of normalizeContinuityClauses(text)) {
      if (CANCEL_SUPERSEDE_CLAUSES.has(clause)) {
        current = false
        continue
      }
      if (NO_HANDOFF_CLAUSES.has(clause)) {
        current = true
      }
    }
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.continuity_state_resolved",
    message: "resolved continuity handoff state from ingress text",
    meta: {
      initialValue,
      finalValue: current,
      ingressCount: ingressTexts?.length ?? 0,
    },
  })

  return current
}

export function classifySteeringFollowUpEffect(text: string): SteeringFollowUpEffect {
  const clauses = normalizeContinuityClauses(text)
  let effect: SteeringFollowUpEffect = "none"

  if (clauses.some((clause) => CANCEL_SUPERSEDE_CLAUSES.has(clause))) {
    effect = "clear_and_supersede"
  } else if (clauses.some((clause) => NO_HANDOFF_CLAUSES.has(clause))) {
    effect = "set_no_handoff"
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.continuity_follow_up_classified",
    message: "classified steering follow-up continuity effect",
    meta: {
      effect,
      clauseCount: clauses.length,
    },
  })

  return effect
}
