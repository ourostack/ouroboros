/**
 * An owner-stated brevity preference, enforced where the answer is delivered rather than left to prose.
 *
 * "Be brief, no sections" is a request about how every later reply should look. A model that agrees in one turn and
 * writes five bold-labelled paragraphs in the next has not kept it, so the runtime reads the request from what the
 * person said (or a saved communication preference) and holds the answer to it at settle.
 */
import { emitNervesEvent } from "../nerves/runtime"

export const BRIEF_MAX_CHARS = 600

const ASK_BRIEF = /\b(?:be|keep(?:\s+(?:it|things|replies|answers|your\s+(?:replies|answers|messages)))?|stay)\s+(?:more\s+)?(?:brief|briefer|concise|terse|short|shorter|tight|compact)\b|\bbrevity\b|\bno\s+sections\b|\bshort\s+(?:answers|replies|messages)\b/i
const ASK_LONGER = /\b(?:be\s+(?:more\s+)?(?:detailed|thorough|verbose|longer)|(?:more|full)\s+detail|elaborate|longer\s+(?:answers|replies)|you\s+can\s+be\s+longer|in\s+depth)\b/i

const NEGATED_BRIEF = /\b(?:don['’]?t|do\s+not|stop\s+being|no\s+more|not\s+so|less|never)\s+(?:be\s+|being\s+|so\s+|that\s+)*(?:brief|concise|terse|short|brevity|tight)\b/i
/** A reply that asks for a confirmation or a choice the person must make: the question is the point, so brevity does not apply. */
const REQUIRED_QUESTION = /\b(?:confirm|are\s+you\s+sure|did\s+you\s+mean|which\s+(?:one|of|do\s+you|did\s+you)|do\s+you\s+want\s+me\s+to\s+(?:apply|delete|remove|change|proceed|overwrite)|should\s+i\s+(?:apply|proceed|go\s+ahead|delete|remove|change|overwrite)|before\s+i\s+(?:apply|delete|remove|change|proceed))\b/i

/** True when the latest word from the person (oldest to newest) asks for brevity; a saved preference counts as the oldest word. */
export function briefStyleRequested(userTexts: readonly string[], savedPreference?: string): boolean {
  let brief = false
  for (const text of [...(savedPreference ? [savedPreference] : []), ...userTexts]) {
    if (NEGATED_BRIEF.test(text) || ASK_LONGER.test(text)) brief = false
    else if (ASK_BRIEF.test(text)) brief = true
  }
  return brief
}

const HEADER = /^#{1,6}\s/m
const BOLD_LABEL = /(?:^|\n)\s*(?:[-*•]\s+)?\*\*[^*\n]{1,60}\*\*[ \t]*(?::|—|-|\n|$)|\*\*[^*\n]{1,60}:\*\*/
const SENTENCE_END = /[.!?]+(?:\s+|$)/

/** What is wrong with an answer that should be brief, or null when it is fine. */
export function briefStyleViolation(answer: string, intent?: string): string | null {
  // A blocked reply must say what is blocking, and a reply that asks for a confirmation or a choice must ask it.
  if (intent === "blocked" || REQUIRED_QUESTION.test(answer)) return null
  const problems: string[] = []
  if (HEADER.test(answer) || BOLD_LABEL.test(answer)) problems.push("no markdown headers or bold section labels, just plain sentences")
  if (answer.length > BRIEF_MAX_CHARS) problems.push(`about ${BRIEF_MAX_CHARS} characters at most (this one is ${answer.length})`)
  const sentences = answer.split(SENTENCE_END).filter((part) => part.trim())
  if (sentences.length > 1 && answer.trimEnd().endsWith("?")) problems.push("no closing question tacked onto an answer; answer and stop")
  if (problems.length > 0) emitNervesEvent({ level: "warn", component: "engine", event: "engine.brief_style_violation", message: "a reply broke the person's brevity request", meta: { problems: problems.length, length: answer.length } })
  return problems.length === 0 ? null : `the person asked you to be brief. rewrite the reply: ${problems.join("; ")}. say the answer once, in your own voice, keep every warning, uncertainty and required confirmation, cut everything else, and settle again.`
}

/** The person's saved communication preference, from their relationship policy or their older tool preferences. */
export function savedCommunicationPreference(friend: { relationshipPolicy?: { preferences: Record<string, { value: unknown }> }; toolPreferences?: Record<string, string> } | undefined): string | undefined {
  const value = friend?.relationshipPolicy?.preferences.communication?.value ?? friend?.toolPreferences?.communication
  return value === undefined ? undefined : String(value)
}
