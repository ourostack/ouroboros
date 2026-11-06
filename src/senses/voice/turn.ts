import { emitNervesEvent } from "../../nerves/runtime"
import {
  runSenseTurn as defaultRunSenseTurn,
  type RunSenseTurnOptions,
  type RunSenseTurnResult,
} from "../shared-turn"
import { transcriptToPromptText } from "./transcript"
import type { VoiceTranscript, VoiceTtsResult, VoiceTtsService } from "./types"

export type VoiceRunSenseTurn = (options: RunSenseTurnOptions) => Promise<RunSenseTurnResult>

export type VoiceTtsDelivery =
  | {
      status: "delivered"
      audio: Uint8Array
      byteLength: number
      chunkCount: number
      mimeType: string
      modelId: string
      voiceId: string
    }
  | {
      status: "failed"
      error: string
    }

export interface VoiceLoopbackTurnOptions {
  agentName: string
  friendId: string
  sessionKey: string
  transcript: VoiceTranscript
  tts: VoiceTtsService
  runSenseTurn?: VoiceRunSenseTurn
}

export interface VoiceLoopbackTurnResult {
  responseText: string
  ponderDeferred: boolean
  tts: VoiceTtsDelivery
}

export async function runVoiceLoopbackTurn(options: VoiceLoopbackTurnOptions): Promise<VoiceLoopbackTurnResult> {
  const runSenseTurn = options.runSenseTurn ?? defaultRunSenseTurn
  let userMessage: string
  try {
    userMessage = transcriptToPromptText(options.transcript)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_turn_error",
      message: "voice turn rejected transcript",
      meta: { utteranceId: options.transcript.utteranceId, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_turn_start",
    message: "starting voice loopback turn",
    meta: {
      agentName: options.agentName,
      friendId: options.friendId,
      sessionKey: options.sessionKey,
      utteranceId: options.transcript.utteranceId,
    },
  })

  const turn = await runSenseTurn({
    agentName: options.agentName,
    channel: "voice",
    friendId: options.friendId,
    sessionKey: options.sessionKey,
    userMessage,
  })

  try {
    const spoken: VoiceTtsResult = await options.tts.synthesize({
      utteranceId: options.transcript.utteranceId,
      text: turn.response,
    })
    const result: VoiceLoopbackTurnResult = {
      responseText: turn.response,
      ponderDeferred: turn.ponderDeferred,
      tts: {
        status: "delivered",
        audio: spoken.audio,
        byteLength: spoken.byteLength,
        chunkCount: spoken.chunkCount,
        mimeType: spoken.mimeType,
        modelId: spoken.modelId,
        voiceId: spoken.voiceId,
      },
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_turn_end",
      message: "voice loopback turn delivered speech",
      meta: { utteranceId: options.transcript.utteranceId, responseLength: turn.response.length, byteLength: spoken.byteLength },
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_turn_tts_error",
      message: "voice loopback TTS failed after text response",
      meta: { utteranceId: options.transcript.utteranceId, error: message, responseLength: turn.response.length },
    })
    return {
      responseText: turn.response,
      ponderDeferred: turn.ponderDeferred,
      tts: {
        status: "failed",
        error: message,
      },
    }
  }
}
