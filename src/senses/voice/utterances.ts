import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { openInboundJournal, type InboundJournal, type InboundOutcome } from "../inbound-journal"
import { describeTurnSpokes, type TurnSpoke } from "../turn-attempts"

/**
 * Voice's side of the shared inbound rule. Each thing a caller says gets a record before its turn runs, and its turn
 * records the outcome. Live audio is never replayed: the caller has moved on, so an utterance a stopped process left
 * is recorded as failed when the sense starts or shuts down. What the caller already heard is noted before each
 * delivery, so that failure says what went out.
 */

export interface VoiceUtterancePayload {
  callSid: string
  friendId: string
  sessionKey: string
  /** How the audio arrived: a Media Stream utterance, or a Twilio recording webhook. */
  transport: "media-stream" | "recording"
}

/** One utterance whose turn is running. */
export interface VoiceUtteranceTurn {
  id: string
  /** Count a turn starting for this utterance. */
  beginAttempt(): void
  /** Note speech or a send before it goes out. A failed write throws, which stops the delivery. */
  noteSpoke(spoke: TurnSpoke): void
  /** Record the utterance's one outcome. Never throws: an outcome it cannot write is failed at the next start. */
  settle(outcome: InboundOutcome, detail?: string): void
}

const journals = new Map<string, InboundJournal<VoiceUtterancePayload>>()

/** The utterance records of one voice output folder, kept in its `utterances` folder. */
export function voiceUtterances(outputDir: string): InboundJournal<VoiceUtterancePayload> {
  let journal = journals.get(outputDir)
  if (!journal) {
    journal = openInboundJournal<VoiceUtterancePayload>(outputDir, "voice", { dir: path.join(outputDir, "utterances") })
    journals.set(outputDir, journal)
  }
  return journal
}

function recordFailed(outputDir: string, error: unknown): void {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.voice_utterance_record_failed",
    message: "could not open the voice utterance records; the call goes on without them",
    meta: { outputDir, error: String(error) },
  })
}

/** Whether this utterance already has a record, pending or settled, so a repeated webhook is not run twice. */
export function seenVoiceUtterance(outputDir: string, id: string): boolean {
  try {
    const journal = voiceUtterances(outputDir)
    return journal.get(id) !== null || journal.outcome(id) !== null
  } catch (error) {
    recordFailed(outputDir, error)
    return false
  }
}

/**
 * Record an utterance before its turn runs. Null when it already has an outcome, or when its folder cannot be
 * written, in which case the turn still runs and only a crash during it goes unrecorded.
 */
export function recordVoiceUtterance(outputDir: string, id: string, payload: VoiceUtterancePayload): VoiceUtteranceTurn | null {
  let journal: InboundJournal<VoiceUtterancePayload>
  try {
    journal = voiceUtterances(outputDir)
    if (!journal.record(id, payload)) return null
  } catch (error) {
    recordFailed(outputDir, error)
    return null
  }
  return {
    id,
    beginAttempt: () => { journal.beginAttempt(id) },
    noteSpoke: (spoke) => journal.markSpoke(id, spoke),
    settle(outcome, detail) {
      try {
        journal.settle(id, outcome, detail)
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_utterance_settle_failed",
          message: "could not record a voice utterance's outcome; the next start records it as failed",
          meta: { id, outcome, error: String(error) },
        })
      }
    },
  }
}

/**
 * Record every utterance a stopped process left as failed, and return how many there were. Runs when the sense
 * starts and when it shuts down.
 */
export function failLeftoverVoiceUtterances(outputDir: string, when: "start" | "shutdown"): number {
  let journal: InboundJournal<VoiceUtterancePayload>
  try {
    journal = voiceUtterances(outputDir)
  } catch (error) {
    recordFailed(outputDir, error)
    return 0
  }
  const stopped = when === "start" ? "the voice sense restarted" : "the voice sense shut down"
  let failed = 0
  for (const entry of journal.pending()) {
    const heard = entry.spoke ? `after ${describeTurnSpokes(entry.spokeRecords)} went out` : "before this was answered"
    journal.settle(entry.id, "failed", `${stopped} ${heard}; live audio is not replayed`)
    failed += 1
  }
  if (failed > 0) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_utterances_left_failed",
      message: "recorded voice utterances a stopped call left as failed; live audio is not replayed",
      meta: { when, failed },
    })
  }
  return failed
}
