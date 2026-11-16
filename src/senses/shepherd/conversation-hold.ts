import * as path from "node:path"
import { listSessionActivity } from "../../heart/session-activity"
import { sessionTurnInFlight } from "../../mind/session-transaction"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * A notice sent unasked never talks over a conversation. While the owner is mid-exchange with the agent, on any
 * channel, a proactive notice waits and goes with the next one after the conversation goes quiet:
 *
 * - a turn is running in one of their sessions (the agent is answering them now);
 * - they wrote in the last ten minutes, or the agent did (a reply, or a message it sent them unasked, invites an answer);
 * - something they wrote has no answer yet, for up to half an hour, so a turn that died does not hold notices forever.
 *
 * Teams hands the agent a message some seconds after it is sent, so a question in flight is invisible here; the
 * ten-minute window after the agent's own last message is what keeps a notice from landing between that question and
 * its answer.
 */
export const CONVERSATION_QUIET_MS = 10 * 60_000
export const UNANSWERED_HOLD_MS = 30 * 60_000

export type ConversationHold = "turn-running" | "recent-message" | "unanswered" | null

export function ownerConversationHold(agentRoot: string, friendId: string, now: number, deps: { inFlight?: (sessionPath: string) => boolean } = {}): ConversationHold {
  const inFlight = deps.inFlight ?? sessionTurnInFlight
  const records = listSessionActivity({
    sessionsDir: path.join(agentRoot, "state", "sessions"), friendsDir: path.join(agentRoot, "friends"), agentName: path.basename(agentRoot, ".ouro"),
    activeThresholdMs: Number.POSITIVE_INFINITY, nowMs: now, friendId,
  })
  let hold: ConversationHold = null
  for (const record of records) {
    const inbound = record.lastInboundAt ? Date.parse(record.lastInboundAt) : NaN
    const outbound = record.lastOutboundAt ? Date.parse(record.lastOutboundAt) : NaN
    if (inFlight(record.sessionPath)) hold = "turn-running"
    else if (now - inbound < CONVERSATION_QUIET_MS || now - outbound < CONVERSATION_QUIET_MS) hold ??= "recent-message"
    else if (record.unansweredInboundCount > 0 && now - inbound < UNANSWERED_HOLD_MS) hold ??= "unanswered"
    if (hold === "turn-running") break
  }
  if (hold) emitNervesEvent({ component: "senses", event: "senses.owner_notice_held", message: "held a notice the owner did not ask for while they are mid-conversation", meta: { friendId, hold } })
  return hold
}
