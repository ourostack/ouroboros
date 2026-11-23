import * as crypto from "node:crypto"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { openInboundJournal, type InboundJournal, type InboundOutcome, type PendingInbound } from "../inbound-journal"
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
  /**
   * How the audio arrived: a Media Stream utterance or a Twilio recording webhook on the cascade path, or a caller
   * turn the OpenAI Realtime or SIP engine heard.
   */
  transport: "media-stream" | "recording" | "openai-realtime" | "openai-sip"
  /** Who made the record. Records an older build wrote have none. */
  owner?: VoiceUtteranceOwner
}

/** The process, and the bridge in it, whose call an utterance belongs to. */
export interface VoiceUtteranceOwner {
  pid: number
  /** Absent for a record made outside a bridge. */
  bridge?: string
}

/** The bridges open in this process. Their calls may still be running, so their utterances are left to them. */
const openBridges = new Set<string>()

/** Open a bridge's claim on the utterances its calls record, and return the id they carry. */
export function openVoiceUtteranceBridge(): string {
  const bridge = crypto.randomUUID()
  openBridges.add(bridge)
  return bridge
}

/** The bridge closed: what its calls left is anyone's to record as failed. */
export function closeVoiceUtteranceBridge(bridge: string): void {
  openBridges.delete(bridge)
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process this user may not signal is still running.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether the call that recorded an utterance can no longer answer it, so a sweep may record it as failed: its bridge
 * is the one sweeping, or closed, or its process stopped, or an older build wrote it without an owner.
 */
function ownerStopped(owner: VoiceUtteranceOwner | undefined, sweeper: string | undefined): boolean {
  if (!owner) return true
  if (owner.pid !== process.pid) return !processRunning(owner.pid)
  return owner.bridge === undefined || owner.bridge === sweeper || !openBridges.has(owner.bridge)
}

/** One utterance whose turn is running. */
export interface VoiceUtteranceTurn {
  id: string
  /** Count a turn starting for this utterance. Never throws: live audio is never replayed, so the count is only a record. */
  beginAttempt(): void
  /**
   * Note speech or a send before it goes out. Never throws: live audio is never replayed, so a note that cannot be
   * written must not cost the caller the answer. It is logged instead.
   */
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
 * Record an utterance before its turn runs, as this process's and `bridge`'s. Null when it already has an outcome, or
 * when its folder cannot be written, in which case the turn still runs and only a crash during it goes unrecorded.
 */
export function recordVoiceUtterance(
  outputDir: string,
  id: string,
  payload: Omit<VoiceUtterancePayload, "owner">,
  bridge?: string,
): VoiceUtteranceTurn | null {
  let journal: InboundJournal<VoiceUtterancePayload>
  try {
    journal = voiceUtterances(outputDir)
    if (!journal.record(id, { ...payload, owner: { pid: process.pid, ...(bridge ? { bridge } : {}) } })) return null
  } catch (error) {
    recordFailed(outputDir, error)
    return null
  }
  const noteFailed = (note: string, error: unknown): void => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_utterance_note_failed",
      message: "could not note a voice utterance's progress; the call goes on",
      meta: { id, note, error: String(error) },
    })
  }
  return {
    id,
    beginAttempt() {
      try {
        journal.beginAttempt(id)
      } catch (error) {
        noteFailed("attempt", error)
      }
    },
    noteSpoke(spoke) {
      try {
        journal.markSpoke(id, spoke)
      } catch (error) {
        noteFailed(spoke.kind, error)
      }
    },
    settle: (outcome, detail) => { settleQuietly(journal, id, outcome, detail) },
  }
}

/** Record an outcome, and log one that cannot be written instead of throwing into the call. True when it landed. */
function settleQuietly(journal: InboundJournal<VoiceUtterancePayload>, id: string, outcome: InboundOutcome, detail?: string): boolean {
  try {
    return journal.settle(id, outcome, detail)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_utterance_settle_failed",
      message: "could not record a voice utterance's outcome; the next start records it as failed",
      meta: { id, outcome, error: String(error) },
    })
    return false
  }
}

/**
 * Record every utterance a stopped call left as failed, and return how many were recorded. Runs once a bridge is
 * listening and when it shuts down, as `bridge`: it records its own and those whose bridge closed or whose process
 * stopped, and leaves those of a bridge still open, here or in another live process, to the next sweep. Never throws:
 * one it cannot record stays pending for the next sweep.
 */
export function failLeftoverVoiceUtterances(outputDir: string, when: "start" | "shutdown", bridge?: string): number {
  let journal: InboundJournal<VoiceUtterancePayload>
  let leftover: Array<PendingInbound<VoiceUtterancePayload>>
  try {
    journal = voiceUtterances(outputDir)
    leftover = journal.pending()
  } catch (error) {
    recordFailed(outputDir, error)
    return 0
  }
  const stopped = when === "start" ? "the voice sense restarted" : "the voice sense shut down"
  let failed = 0
  for (const entry of leftover) {
    if (!ownerStopped(entry.payload.owner, bridge)) continue
    const heard = entry.spoke ? `after ${describeTurnSpokes(entry.spokeRecords)} went out` : "before this was answered"
    if (settleQuietly(journal, entry.id, "failed", `${stopped} ${heard}; live audio is not replayed`)) failed += 1
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
