// The daemon's `letters.answer` command (design §3.4): the BlueBubbles ingress names a message by GUID, and the
// daemon reads that message from the agent's own server and records the answer if it is one. The command carries no
// text, sender or chat, so whoever sends it can only point at a message the server holds.
import { emitNervesEvent } from "../../nerves/runtime"
import type { LetterAnswerSource } from "../../senses/bluebubbles/agent-client"
import { parseAnswer } from "./answer-reader"
import type { AnswerOutcome, LettersWriter } from "./writer"

export interface LettersAnswerCommand {
  kind: "letters.answer"
  agent: string
  messageGuid: string
  /** Epoch ms past which the daemon records nothing: the asker has stopped waiting and treats the message as chat. */
  deadlineAt?: number
}

/** A cheap first look at the webhook's text: only text in answer form is worth a fetch from the server. */
export function looksLikeAnswer(text: string): boolean {
  return parseAnswer(text) !== null
}

export async function answerLettersAnswerCommand(
  writer: LettersWriter,
  command: LettersAnswerCommand,
  sourceFor: (agent: string) => Promise<LetterAnswerSource>,
): Promise<{ ok: boolean; data?: AnswerOutcome; error?: string }> {
  if (typeof command.agent !== "string" || typeof command.messageGuid !== "string" || !command.messageGuid.trim()) {
    return { ok: false, error: "letters.answer needs an agent and a messageGuid." }
  }
  // Checked before the agent's vault or server is read for it.
  if (!writer.hasAgent(command.agent)) return { ok: false, error: `No agent bundle ${command.agent}.ouro is on this machine.` }
  try {
    const source = await sourceFor(command.agent)
    // The server password travels in the fetch's query string, so only a server nobody between can read is asked.
    if (source.trust === "untrusted") return { ok: true, data: { recorded: false, reason: "untrusted-server-url" } }
    const guid = command.messageGuid.trim()
    const message = await source.getServerMessage(guid)
    if (!message || message.guid !== guid) return { ok: true, data: { recorded: false, reason: "unknown-message" } }
    const sentAt = async (sentGuid: string) => (await source.getServerMessage(sentGuid))?.dateCreated
    const deadlineAt = typeof command.deadlineAt === "number" ? command.deadlineAt : undefined
    return { ok: true, data: await writer.recordAnswer(command.agent, message, source.hostTrust, sentAt, deadlineAt) }
  } catch (error) {
    emitNervesEvent({ level: "error", component: "daemon", event: "letters.answer_failed", message: "a possible answer couldn't be checked", meta: { reason: (error as Error).message } })
    return { ok: false, error: (error as Error).message }
  }
}
