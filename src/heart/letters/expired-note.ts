// A letter that reaches its expiresAt with no answer closes as expired, and the agent that owns it is woken with
// "expired, no answer" (design §3.4, "Expiry"), so it can decide what its lane does without the person's answer.
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Letter } from "./letter"
import { queueNoteAndWake, type WakeAnswer } from "./tell-agent"

/** The note in the agent's own words; the subject is the sender's, quoted as theirs. */
export function letterExpiredNote(letter: Letter): string {
  return `letter ${letter.code} expired at ${letter.expiresAt} with no answer from my person; its sender gave it the subject ${JSON.stringify(letter.subject)}. it is closed, so it can't be answered or delivered now; mailbox_read shows it.`
}

/** The private-runtime wake for one expired letter; its idempotency key makes a repeat a duplicate. */
export function letterExpiredWake(agent: string, letter: Letter) {
  return {
    kind: "private.wake" as const,
    agent,
    reason: `letter ${letter.code} expired`,
    triggerSource: "letter-expired",
    budgetClass: "interactive",
    idempotencyKey: `letter-expired:${agent}:${letter.id}`,
    originRefs: [{ kind: "letter", id: letter.id }, { kind: "scheduler", id: "letters-expiry" }],
  }
}

/** The daemon's onExpired: the note is dated by the expiry, so telling twice is one note. */
export function letterExpiredTeller(bundlesRoot: string, wake: (command: ReturnType<typeof letterExpiredWake>) => Promise<WakeAnswer>): (agent: string, letter: Letter) => Promise<void> {
  return async (agent, letter) => {
    const note = { content: letterExpiredNote(letter), timestamp: Date.parse(letter.expiresAt!), packetId: `letter-expired:${letter.id}` }
    const problem = await queueNoteAndWake(agent, path.join(bundlesRoot, `${agent}.ouro`), note, () => wake(letterExpiredWake(agent, letter)))
    if (problem === null) {
      emitNervesEvent({ component: "daemon", event: "letters.expired_told", message: "the agent was told a letter expired", meta: { code: letter.code } })
    } else {
      emitNervesEvent({ level: "warn", component: "daemon", event: "letters.expired_wake_failed", message: "an expired letter's note waits for the agent's next private turn", meta: { code: letter.code, error: problem } })
    }
  }
}
