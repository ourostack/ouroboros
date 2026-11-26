// The chat side of a letter's answer (design §3.4): the sense names a message by GUID and the daemon decides from the
// server's own copy, so nothing this process saw in the webhook decides the answer.
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "../../heart/daemon/socket-client"
import { emitNervesEvent } from "../../nerves/runtime"

/** Asks the daemon whether a message answers one of the agent's letters; true when it recorded an answer. */
export async function askDaemonToAnswerLetter(agent: string, messageGuid: string, send: typeof sendDaemonCommand = sendDaemonCommand): Promise<boolean> {
  const answer = await send(DEFAULT_DAEMON_SOCKET_PATH, { kind: "letters.answer", agent, messageGuid }, { timeoutMs: 30_000 })
  if (!answer.ok) throw new Error(answer.error ?? "the daemon refused the letters.answer command")
  const recorded = (answer.data as { recorded?: unknown } | undefined)?.recorded === true
  emitNervesEvent({ level: "debug", component: "senses", event: "senses.bluebubbles_letter_answer_checked", message: "asked the daemon whether a message answers a letter", meta: { messageGuid, recorded } })
  return recorded
}
