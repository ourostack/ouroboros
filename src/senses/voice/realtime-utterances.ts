import { turnSpoke, turnSpokeForTool } from "../turn-attempts"
import { recordVoiceUtterance, type VoiceUtteranceTurn } from "./utterances"

/**
 * The OpenAI Realtime and SIP engines' side of the voice utterance rule. OpenAI hears the caller and speaks the reply
 * itself, so there is no turn to wrap: the call's events say what happened instead. Each final transcript of the
 * caller is recorded before a reply is asked for. The next reply the caller asked for answers everything they said
 * since the last one, once some of its audio played. A reply that made no audio, such as one that only called a tool,
 * hands its utterances on to the next reply. Live audio is never replayed, so whatever is still waiting when the call
 * ends is recorded as failed, or as silent when the call chose to end without answering it.
 */
export interface RealtimeUtteranceLedger {
  /** The caller finished saying something. Recorded before a reply is asked for. */
  heard(itemId: string): void
  /**
   * A reply started. `answers` is false for one the call asked for itself, such as the greeting or a holding phrase
   * while a tool runs: those answer nobody.
   */
  replyStarted(responseId: string, answers: boolean): void
  /** The reply's audio is about to reach the caller: noted once on what it answers, before it goes. */
  speaking(responseId: string): void
  /** Some of the reply's audio played to the caller, so what it answers is answered. */
  played(responseId: string): void
  /**
   * The reply finished. One that made no audio, by `speaking` or by `madeAudio` from the engine's own account of it,
   * hands its utterances on to the next reply.
   */
  replyDone(responseId: string, madeAudio?: boolean): void
  /** A tool is about to run. One that may message a person is noted on every utterance still waiting. */
  toolSending(name: string, args: Record<string, unknown>): void
  /**
   * Audio sent for a reply was cleared before it played; `reason` says what took its place. The reply may still
   * stream more audio afterwards, which can play, so it fails only once it finished with nothing left to play.
   */
  cutOff(reason: string): void
  /**
   * The call asked to hang up. What the caller said so far that no reply has spoken to gets no answer by choice, so
   * it is recorded as silent when the call ends; what they say after this is not.
   */
  hangingUp(): void
  /**
   * The call ended. What is still waiting is recorded as failed, or as silent with `silent` as the reason when the
   * call ended because nobody was there to answer, such as a voicemail or fax machine.
   */
  ended(silent?: string): void
}

export interface RealtimeUtteranceCall {
  outputDir: string
  /** The bridge whose call this is, which its records carry. */
  bridge?: string
  engine: "openai-realtime" | "openai-sip"
  callSid: string
  friendId: string
  sessionKey: string
}

interface Reply {
  utterances: VoiceUtteranceTurn[]
  /** Its speech was noted on what it answers. */
  spoke: boolean
  /** Some of its audio was sent and has neither played nor been cleared. */
  unheard: boolean
  /** OpenAI finished it. */
  done: boolean
  /** What cleared its audio before any played, until more of its audio is sent. */
  cut: string | null
}

function segment(input: string): string {
  return input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

/** Tool arguments as text: only text values can name who a send goes to or what it says. */
function textArgs(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

export function realtimeUtteranceLedger(call: RealtimeUtteranceCall): RealtimeUtteranceLedger {
  const prefix = call.engine === "openai-sip" ? "sip" : "realtime"
  let heardCount = 0
  let waiting: VoiceUtteranceTurn[] = []
  const replies = new Map<string, Reply>()
  /** What the caller said before the call asked to hang up and no reply spoke to. */
  const unansweredByChoice = new Set<VoiceUtteranceTurn>()
  const settleAll = (utterances: VoiceUtteranceTurn[], ...outcome: Parameters<VoiceUtteranceTurn["settle"]>): void => {
    for (const utterance of utterances) utterance.settle(...outcome)
  }

  return {
    heard(itemId) {
      heardCount += 1
      const id = `${prefix}-${segment(call.callSid)}-${segment(itemId) || `caller-${heardCount}`}`
      const record = recordVoiceUtterance(call.outputDir, id, {
        callSid: call.callSid, friendId: call.friendId, sessionKey: call.sessionKey, transport: call.engine,
      }, call.bridge)
      if (!record) return
      record.beginAttempt()
      waiting.push(record)
    },
    replyStarted(responseId, answers) {
      if (!answers || !responseId || waiting.length === 0) return
      replies.set(responseId, { utterances: waiting, spoke: false, unheard: false, done: false, cut: null })
      waiting = []
    },
    speaking(responseId) {
      const reply = replies.get(responseId)
      if (!reply) return
      reply.unheard = true
      if (reply.spoke) return
      reply.spoke = true
      const spoke = turnSpoke("speech:audio", null)
      for (const utterance of reply.utterances) utterance.noteSpoke(spoke)
    },
    played(responseId) {
      const reply = replies.get(responseId)
      if (!reply) return
      replies.delete(responseId)
      settleAll(reply.utterances, "answered")
    },
    replyDone(responseId, madeAudio = false) {
      const reply = replies.get(responseId)
      if (!reply) return
      // Audio still on its way to the caller may yet play.
      if (reply.unheard || (madeAudio && !reply.cut)) {
        reply.done = true
        return
      }
      replies.delete(responseId)
      if (reply.cut) settleAll(reply.utterances, "failed", reply.cut)
      else waiting = [...reply.utterances, ...waiting]
    },
    toolSending(name, args) {
      const spoke = turnSpokeForTool(name, textArgs(args))
      if (!spoke) return
      for (const reply of replies.values()) for (const utterance of reply.utterances) utterance.noteSpoke(spoke)
      for (const utterance of waiting) utterance.noteSpoke(spoke)
    },
    hangingUp() {
      for (const reply of replies.values()) if (!reply.spoke) for (const utterance of reply.utterances) unansweredByChoice.add(utterance)
      for (const utterance of waiting) unansweredByChoice.add(utterance)
    },
    cutOff(reason) {
      for (const [responseId, reply] of replies) {
        if (!reply.unheard) continue
        reply.unheard = false
        reply.cut = reason
        if (!reply.done) continue
        replies.delete(responseId)
        settleAll(reply.utterances, "failed", reason)
      }
    },
    ended(silent) {
      const settle = (utterances: VoiceUtteranceTurn[], spoke: boolean, failure: string): void => {
        for (const utterance of utterances) {
          if (silent) utterance.settle("silent", silent)
          else if (!spoke && unansweredByChoice.has(utterance)) utterance.settle("silent", "the call was ended without a spoken reply")
          else utterance.settle("failed", failure)
        }
      }
      for (const reply of replies.values()) {
        settle(reply.utterances, reply.spoke, reply.cut && !reply.unheard ? reply.cut : "the call ended before the reply was played")
      }
      replies.clear()
      settle(waiting, false, "the call ended before this was answered")
      waiting = []
    },
  }
}

/** Whether a response content part is audio, as in `response.content_part.added` or a finished response's output. */
export function isAudioPart(part: unknown): boolean {
  const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined
  return type === "output_audio" || type === "audio"
}

/** Whether a finished response's output held audio, from its `response.done` event. */
export function responseMadeAudio(event: Record<string, unknown>): boolean {
  const response = event.response
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  const output = (response as { output?: unknown }).output
  if (!Array.isArray(output)) return false
  return output.some((item) => {
    const content = item && typeof item === "object" ? (item as { content?: unknown }).content : undefined
    return Array.isArray(content) && content.some(isAudioPart)
  })
}
