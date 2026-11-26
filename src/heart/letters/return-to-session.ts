// Returning a person's answer to the session that asked (design §3.4, "Answer return"). A letter filed from an
// agent's turn remembers that turn's session; once the answer is recorded, the daemon queues a note in that session,
// so its next turn reads "Ari answered L7: Ouro". The agent's private runtime is told separately (answered-note.ts).
import * as fs from "fs"
import { isValidSessionCoordinate, resolveSessionPath } from "../config"
import { getPendingDir, queuePendingMessageOnce } from "../../mind/pending"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Letter, LetterEvent } from "./letter"

export type LetterSession = NonNullable<Letter["from"]["session"]>

/**
 * Channels a returned note can't serve: the private runtime is told of every answer anyway, and a voice session drops
 * any note older than a few minutes unread.
 */
const NO_RETURN_CHANNELS = new Set(["inner", "voice"])

/**
 * The session a letter returns its answer to, or null when there is none to return to: a caller with no session
 * (the CLI, an MCP client), a channel in NO_RETURN_CHANNELS, coordinates that would name a folder outside the
 * agent's own, or a session the agent has never had. With `agentRoot`, the session must have its session file.
 */
export function returnSession(value: unknown, agentRoot?: string): LetterSession | null {
  if (typeof value !== "object" || value === null) return null
  const { friendId, channel, key } = value as Record<string, unknown>
  if (![friendId, channel, key].every((part) => isValidSessionCoordinate(part) && part.length <= 300)) return null
  const session = { friendId: friendId as string, channel: channel as string, key: key as string }
  if (NO_RETURN_CHANNELS.has(session.channel)) return null
  if (agentRoot !== undefined && !fs.existsSync(resolveSessionPath(session.friendId, session.channel, session.key, { agentRoot }))) return null
  return session
}

/** The note the asking session reads; the label and note are the person's words. */
export function answerReturnText(person: string, letter: Letter, answer: { option: string; label: string; note?: string }): string {
  return `${person} answered ${letter.code}: ${answer.option} ${answer.label}${answer.note ? ` — ${answer.note}` : ""}`
}

/** Queues the note in the session's pending folder, once per letter. A failed write throws. */
export function queueAnswerReturn(agent: string, agentRoot: string, session: LetterSession, text: string, letter: Letter, at: string): void {
  queuePendingMessageOnce(getPendingDir(agent, session.friendId, session.channel, session.key, agentRoot), {
    // From the mailbox, not the agent: a Telegram session drops the agent's own stale notes unread.
    from: "mailbox", friendId: session.friendId, channel: session.channel, key: session.key, content: text, timestamp: Date.parse(at), packetId: `letter-returned:${letter.id}`,
  })
  emitNervesEvent({ component: "daemon", event: "letters.answer_returned", message: "an answer was returned to the session that asked", meta: { code: letter.code, channel: session.channel } })
}

/** The longest wait between tries, so a session that can't be written is still tried every hour. */
export const RETURN_BACKOFF_MAX_MS = 60 * 60_000

/**
 * Whether an answered letter's return is due now: it has a session, no try has succeeded, and the wait after the last
 * failed try (one minute, doubling, at most an hour) has passed.
 */
export function returnDue(letter: Letter, events: readonly LetterEvent[], now: number): boolean {
  if (!returnSession(letter.from.session) || !events.some((event) => event.t === "answered")) return false
  const tries = events.filter((event): event is Extract<LetterEvent, { t: "returned" }> => event.t === "returned" && event.to === "session")
  if (tries.some((event) => event.ok)) return false
  if (tries.length === 0) return true
  const wait = Math.min(60_000 * 2 ** (tries.length - 1), RETURN_BACKOFF_MAX_MS)
  return now >= Date.parse(tries[tries.length - 1]!.at) + wait
}
