// The chat side of a letter's answer (design §3.4): the sense names a message by GUID and the daemon decides from the
// server's own copy, so nothing this process saw in the webhook decides the answer.
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "../../heart/daemon/socket-client"
import { emitNervesEvent } from "../../nerves/runtime"

/** How long the sense waits for the daemon. A deliver can hold the daemon's letter queue for up to 25 s. */
const ANSWER_TIMEOUT_MS = 30_000
/** The daemon records nothing after this much of the wait, so an answer is never recorded once the sense gives up on it. */
const ANSWER_DEADLINE_MS = 27_000

/** How long the sense waits for the daemon to check a read receipt; nothing waits on the answer. */
const SEEN_TIMEOUT_MS = 30_000

/**
 * Asks the daemon whether a message answers one of the agent's letters; true when it recorded an answer now or
 * before (a replay). Past the deadline the daemon records nothing, so a timed-out ask leaves the message a chat turn.
 */

/** Tells the daemon the server reported a message read; it records `seen` if that message delivered a letter. */
export async function tellDaemonLetterSeen(agent: string, messageGuid: string, send: typeof sendDaemonCommand = sendDaemonCommand): Promise<boolean> {
  const answer = await send(DEFAULT_DAEMON_SOCKET_PATH, { kind: "letters.seen", agent, messageGuid }, { timeoutMs: SEEN_TIMEOUT_MS })
  if (!answer.ok) throw new Error(answer.error ?? "the daemon refused the letters.seen command")
  const recorded = (answer.data as { recorded?: unknown } | undefined)?.recorded === true
  emitNervesEvent({ level: "debug", component: "senses", event: "senses.bluebubbles_letter_seen_checked", message: "told the daemon a message was read", meta: { messageGuid, recorded } })
  return recorded
}

export async function askDaemonToAnswerLetter(agent: string, messageGuid: string, send: typeof sendDaemonCommand = sendDaemonCommand, now: () => number = Date.now): Promise<boolean> {
  const answer = await send(DEFAULT_DAEMON_SOCKET_PATH, { kind: "letters.answer", agent, messageGuid, deadlineAt: now() + ANSWER_DEADLINE_MS }, { timeoutMs: ANSWER_TIMEOUT_MS })
  if (!answer.ok) throw new Error(answer.error ?? "the daemon refused the letters.answer command")
  const recorded = (answer.data as { recorded?: unknown } | undefined)?.recorded === true
  emitNervesEvent({ level: "debug", component: "senses", event: "senses.bluebubbles_letter_answer_checked", message: "asked the daemon whether a message answers a letter", meta: { messageGuid, recorded } })
  return recorded
}
