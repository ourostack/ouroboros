// The chat side of a letter's answer (design §3.4): the sense names a message by GUID and the daemon decides from the
// server's own copy, so nothing this process saw in the webhook decides the answer.
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "../../heart/daemon/socket-client"
import { emitNervesEvent } from "../../nerves/runtime"

/** How long the sense waits for the daemon. A deliver can hold the daemon's letter queue for up to 25 s. */
const ANSWER_TIMEOUT_MS = 30_000
/** The daemon records nothing after this much of the wait, so an answer is never recorded once the sense gives up on it. */
const ANSWER_DEADLINE_MS = 27_000

/**
 * Asks the daemon whether a message answers one of the agent's letters; true when it recorded an answer now or
 * before (a replay). Past the deadline the daemon records nothing, so a timed-out ask leaves the message a chat turn.
 */
export async function askDaemonToAnswerLetter(agent: string, messageGuid: string, send: typeof sendDaemonCommand = sendDaemonCommand, now: () => number = Date.now): Promise<boolean> {
  const answer = await send(DEFAULT_DAEMON_SOCKET_PATH, { kind: "letters.answer", agent, messageGuid, deadlineAt: now() + ANSWER_DEADLINE_MS }, { timeoutMs: ANSWER_TIMEOUT_MS })
  if (!answer.ok) throw new Error(answer.error ?? "the daemon refused the letters.answer command")
  const recorded = (answer.data as { recorded?: unknown } | undefined)?.recorded === true
  emitNervesEvent({ level: "debug", component: "senses", event: "senses.bluebubbles_letter_answer_checked", message: "asked the daemon whether a message answers a letter", meta: { messageGuid, recorded } })
  return recorded
}
