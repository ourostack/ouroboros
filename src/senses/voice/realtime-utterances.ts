import { turnSpoke, turnSpokeForTool } from "../turn-attempts"
import { recordVoiceUtterance, type VoiceUtteranceTurn } from "./utterances"

/**
 * The OpenAI Realtime and SIP engines' side of the voice utterance rule. OpenAI hears the caller and speaks the reply
 * itself, so there is no turn to wrap: the call's events say what happened instead. Each final transcript of the
 * caller is recorded before a reply is asked for. The next reply the caller asked for answers everything they said
 * since the last one, once some of its audio played. A reply that made no audio, such as one that only called a tool,
 * hands its utterances on to the next reply. Live audio is never replayed, so whatever is still waiting when the call
 * ends is recorded as failed.
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
  /** Audio sent for a reply was cleared before any of it played; `reason` says what took its place. */
  cutOff(reason: string): void
  /**
   * The call ended. What is still waiting is recorded as failed, or as silent with `silent` as the reason when the
   * call ended because nobody was there to answer, such as a voicemail menu.
   */
  ended(silent?: string): void
}

export interface RealtimeUtteranceCall {
  outputDir: string
  engine: "openai-realtime" | "openai-sip"
  callSid: string
  friendId: string
  sessionKey: string
}

interface Reply {
  utterances: VoiceUtteranceTurn[]
  spoke: boolean
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
  const settleAll = (utterances: VoiceUtteranceTurn[], ...outcome: Parameters<VoiceUtteranceTurn["settle"]>): void => {
    for (const utterance of utterances) utterance.settle(...outcome)
  }

  return {
    heard(itemId) {
      heardCount += 1
      const id = `${prefix}-${segment(call.callSid)}-${segment(itemId) || `caller-${heardCount}`}`
      const record = recordVoiceUtterance(call.outputDir, id, {
        callSid: call.callSid, friendId: call.friendId, sessionKey: call.sessionKey, transport: call.engine,
      })
      if (!record) return
      record.beginAttempt()
      waiting.push(record)
    },
    replyStarted(responseId, answers) {
      if (!answers || !responseId || waiting.length === 0) return
      replies.set(responseId, { utterances: waiting, spoke: false })
      waiting = []
    },
    speaking(responseId) {
      const reply = replies.get(responseId)
      if (!reply || reply.spoke) return
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
      if (!reply || reply.spoke || madeAudio) return
      replies.delete(responseId)
      waiting = [...reply.utterances, ...waiting]
    },
    toolSending(name, args) {
      const spoke = turnSpokeForTool(name, textArgs(args))
      if (!spoke) return
      for (const reply of replies.values()) for (const utterance of reply.utterances) utterance.noteSpoke(spoke)
      for (const utterance of waiting) utterance.noteSpoke(spoke)
    },
    cutOff(reason) {
      for (const [responseId, reply] of replies) {
        if (!reply.spoke) continue
        replies.delete(responseId)
        settleAll(reply.utterances, "failed", reason)
      }
    },
    ended(silent) {
      for (const reply of replies.values()) {
        settleAll(reply.utterances, silent ? "silent" : "failed", silent ?? "the call ended before the reply was played")
      }
      replies.clear()
      settleAll(waiting, silent ? "silent" : "failed", silent ?? "the call ended before this was answered")
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
