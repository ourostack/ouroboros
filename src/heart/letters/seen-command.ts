// The daemon's `letters.seen` command: the BlueBubbles ingress names a message whose read receipt it saw, or a message
// the person sent in a one-to-one chat, and the daemon reads that message from the agent's own server. A read receipt
// marks seen the letter that message delivered; the person's own message marks seen each letter that landed in their
// chat before they wrote, since their read receipts may be off.
// Like `letters.answer`, the command carries only a GUID, so whoever sends it can only point at a real message.
import { emitNervesEvent } from "../../nerves/runtime"
import type { LetterAnswerSource } from "../../senses/bluebubbles/agent-client"
import type { LettersWriter, SeenOutcome } from "./writer"

export interface LettersSeenCommand {
  kind: "letters.seen"
  agent: string
  messageGuid: string
}

export async function answerLettersSeenCommand(
  writer: LettersWriter,
  command: LettersSeenCommand,
  sourceFor: (agent: string) => Promise<LetterAnswerSource>,
): Promise<{ ok: boolean; data?: SeenOutcome; error?: string }> {
  if (typeof command.agent !== "string" || typeof command.messageGuid !== "string" || !command.messageGuid.trim()) {
    return { ok: false, error: "letters.seen needs an agent and a messageGuid." }
  }
  if (!writer.hasAgent(command.agent)) return { ok: false, error: `No agent bundle ${command.agent}.ouro is on this machine.` }
  try {
    const guid = command.messageGuid.trim()
    // Most read receipts and messages are ordinary chat, so the index is asked before the server is.
    if (!writer.hasWaitingDelivery(command.agent, guid) && !writer.hasUnseenDelivery(command.agent)) return { ok: true, data: { recorded: false, reason: "no-letter" } }
    const source = await sourceFor(command.agent)
    // The server password travels in the fetch's query string, so only a server nobody between can read is asked.
    if (source.trust === "untrusted") return { ok: true, data: { recorded: false, reason: "untrusted-server-url" } }
    const message = await source.getServerMessage(guid)
    if (!message || message.guid !== guid) return { ok: true, data: { recorded: false, reason: "unknown-message" } }
    if (message.isFromMe === false) {
      const sentAt = async (sentGuid: string) => (await source.getServerMessage(sentGuid))?.dateCreated
      return { ok: true, data: await writer.recordSeenByReply(command.agent, message, sentAt) }
    }
    return { ok: true, data: await writer.recordSeen(command.agent, message) }
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "daemon", event: "letters.seen_failed", message: "a read receipt couldn't be checked", meta: { reason: (error as Error).message } })
    return { ok: false, error: (error as Error).message }
  }
}
