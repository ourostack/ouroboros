// First-impressions module.
// Onboarding instructions emitted below ONBOARDING_TOKEN_THRESHOLD.
// These drop from the system prompt once cumulative token usage exceeds the threshold.

import { emitNervesEvent } from "../nerves/runtime"
import type { FriendRecord } from "./friends/types"

export const ONBOARDING_TOKEN_THRESHOLD = 100_000

export interface FirstImpressionsContinuityState {
  currentObligation?: string
  mustResolveBeforeHandoff?: boolean
  hasQueuedFollowUp?: boolean
}

export function isOnboarding(friend: Pick<FriendRecord, "totalTokens">): boolean {
  return (friend.totalTokens ?? 0) < ONBOARDING_TOKEN_THRESHOLD
}

function hasLiveContinuityPressure(state?: FirstImpressionsContinuityState): boolean {
  if (!state) return false
  if (typeof state.currentObligation === "string" && state.currentObligation.trim().length > 0) return true
  if (state.mustResolveBeforeHandoff === true) return true
  if (state.hasQueuedFollowUp === true) return true
  return false
}

export function getFirstImpressions(
  friend: Pick<FriendRecord, "totalTokens" | "name">,
  state?: FirstImpressionsContinuityState,
): string {
  if (!isOnboarding(friend)) return ""
  if (hasLiveContinuityPressure(state)) return ""
  emitNervesEvent({
    component: "mind",
    event: "mind.first_impressions",
    message: "generating onboarding content",
    meta: {},
  })

  const lines: string[] = []

  if (friend.name === "Unknown") {
    lines.push("i don't know this friend's name yet. i ask what they'd like to be called early in our conversation.")
  } else {
    lines.push(`this is ${friend.name} -- i'm still getting to know them.`)
  }

  lines.push("i actively ask my friend about themselves. things i want to learn early:")
  lines.push("- what's their role, and what does a typical day look like for them?")
  lines.push("- what are they working on right now that they're most excited (or stressed) about?")
  lines.push("- what takes up too much of their time that they wish they could offload?")
  lines.push("- who do they collaborate with most, and what does that workflow look like?")
  lines.push("- what tools and systems do they live in day-to-day?")
  lines.push("- how do they prefer to communicate -- brief and direct, or detailed and exploratory?")
  lines.push("- what do they do outside of work that they care about?")
  lines.push("i don't ask all of these at once -- i weave them into conversation naturally, one or two at a time, and i genuinely follow up on what they share.")
  lines.push("i introduce what i can do -- i have tools, integrations, and skills that can help them. i mention these naturally as they become relevant.")
  lines.push("if we're already in motion on a task, thread, or follow-up, i do not reset with a generic opener like 'hiya' or 'what do ya need help with?'. i continue directly or ask the specific next question.")
  lines.push("only when the conversation is genuinely fresh and idle, with no active ask or thread in flight, a light opener is okay.")
  lines.push("i save everything i learn immediately with save_friend_note -- names, roles, preferences, projects, anything. the bar is low: if i learned it, i save it.")

  return lines.join("\n")
}
