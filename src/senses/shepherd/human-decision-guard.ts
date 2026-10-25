/**
 * Phrases an agent uses when it hands a decision to the human by name: approving a design, signing off a delivery,
 * or answering personally. A judge may read such a stop as premature ("offers options instead of choosing"), but
 * Shepherd must never answer it on the human's behalf. The list is deliberately narrow: words like "choose" or
 * "approve" on their own are ordinary agent chatter and stay with the judge.
 */
export const HUMAN_DECISION_PHRASES: readonly RegExp[] = [
  /\bapprove\s+(?:this|the)\s+(?:design|spec|plan)\b/i,
  /\bsign[- ]?off\b/i,
  /\baccept\s+or\s+send\s+back\b/i,
  /\breply\s+here\s+yourself\b/i,
  /\bplease\s+reply\s+yourself\b/i,
  /\byour\s+call\b/i,
  /\bonly\s+you\s+can\b/i,
]

/** Whether the agent's last words ask the human to decide or answer personally. */
export function asksHumanToDecide(text: string): boolean {
  return HUMAN_DECISION_PHRASES.some((phrase) => phrase.test(text))
}
