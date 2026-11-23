import { emitNervesEvent } from "../nerves/runtime"
import { MAX_INBOUND_ATTEMPTS, openInboundJournal, type InboundJournal, type InboundOutcome, type PendingInbound } from "./inbound-journal"
import { describeTurnSpokes, outwardSendTracker, type TurnSpoke } from "./turn-attempts"

/**
 * Teams' side of the shared inbound rule: a message admitted from Teams is written to the journal before its
 * turn runs and leaves it only with a recorded outcome. A process that dies mid-turn leaves it pending, and the
 * next process answers it with a proactive send, but only when nothing went out and the try limit is not used up.
 * Anything else gets a failed outcome, so a reply that already went out is never sent again.
 */

/** What the next process needs to run an admitted message again after its turn was cut off. */
export interface TeamsInboundPayload {
  /** Which bot app received it ("primary" or "secondary"), so only that app replays it. */
  label: string
  activityId: string
  conversationId: string
  conversationType?: string
  text: string
  replyToId?: string
  userId: string
  aadObjectId?: string
  tenantId?: string
  displayName?: string
  channelId: string
  attachments?: unknown[]
}

export function openTeamsInboundJournal(agentRoot: string): InboundJournal<TeamsInboundPayload> {
  return openInboundJournal<TeamsInboundPayload>(agentRoot, "teams")
}

/** What the next process does with a message whose turn never recorded an outcome. */
export type TeamsReplayDecision = { action: "replay" } | { action: "fail"; detail: string }

/** `isCommand` says whether the text is a command Teams handles, such as /new, rather than an ordinary message. */
export function teamsReplayDecision(entry: PendingInbound<TeamsInboundPayload>, isCommand: (text: string) => boolean): TeamsReplayDecision {
  // A replay runs as an ordinary turn, so a command such as /new would act long after it was sent.
  if (isCommand(entry.payload.text)) {
    return { action: "fail", detail: "a command is not run again after a restart" }
  }
  if (entry.spoke) {
    return { action: "fail", detail: `the turn stopped after ${describeTurnSpokes(entry.spokeRecords)} went out, so it is not run again` }
  }
  if (entry.attempts >= MAX_INBOUND_ATTEMPTS) {
    return { action: "fail", detail: `the turn did not finish in ${entry.attempts} attempts` }
  }
  return { action: "replay" }
}

/**
 * The journal entries one conversation turn speaks for: the message that started it (none for a turn about a
 * reaction or edit), plus any later message it took in as steering. A send notes all of them, and the turn's
 * outcome settles all of them, so a crash after a send never replays a message that turn already answered in part.
 */
export interface TeamsTurnInbound {
  /** Note a send before it reaches Teams. A failed write throws, which stops the send. */
  noteSpoke(spoke: TurnSpoke): void
  /** Count a reply send once Teams confirmed it or the send failed, so the outcome says whether a reply reached Teams. */
  noteSent(accepted: boolean): void
  /** A reply send still in flight; `finish` waits for it, since some sends are made without waiting. */
  track(send: Promise<unknown>): void
  /** Notes a tool that messages a person, just before its handler runs. */
  tools: ReturnType<typeof outwardSendTracker>
  /** Take in a later message the running turn answered as steering, counting this turn as one of its tries. */
  absorb(id: string): void
  settle(outcome: InboundOutcome, detail?: string): void
  /**
   * Settle a turn that returned: answered when Teams confirmed a reply, failed when every reply send failed,
   * and silent when the turn sent nothing. Waits for sends still in flight first.
   */
  finish(): Promise<void>
}

/** `journal` is opened only once there is an entry to write, so a turn with none never touches the disk. */
export function teamsTurnInbound(journal: () => InboundJournal<TeamsInboundPayload>, id?: string): TeamsTurnInbound {
  const ids = id ? [id] : []
  let accepted = 0
  let rejected = 0
  const inFlight: Array<Promise<unknown>> = []
  const noteSpoke = (spoke: TurnSpoke): void => {
    for (const inboundId of ids) journal().markSpoke(inboundId, spoke)
  }
  const settle = (outcome: InboundOutcome, detail?: string): void => {
    if (ids.length === 0) return
    for (const inboundId of ids) {
      journal().settle(inboundId, outcome, detail)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.teams_inbound_settled",
      message: "recorded the outcome of a Teams message",
      meta: { outcome, messages: ids.length, ...(detail ? { detail } : {}) },
    })
  }
  return {
    noteSpoke,
    noteSent(ok) {
      if (ok) accepted += 1
      else rejected += 1
    },
    track(send) {
      inFlight.push(send.catch(() => undefined))
    },
    tools: outwardSendTracker(noteSpoke),
    absorb(absorbed) {
      ids.push(absorbed)
      journal().beginAttempt(absorbed)
    },
    settle,
    async finish() {
      await Promise.all(inFlight)
      if (accepted > 0) settle("answered")
      else if (rejected > 0) settle("failed", `Teams confirmed no reply; failed sends: ${rejected}`)
      else settle("silent")
    },
  }
}
