import { emitNervesEvent } from "../../nerves/runtime"
import {
  runSenseTurn as defaultRunSenseTurn,
  type OutwardSenseDelivery,
  type OutwardSenseDeliveryKind,
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
  onAudioChunk?: (chunk: Uint8Array) => void | Promise<void>
}

export interface VoiceSpeechSegment {
  kind: OutwardSenseDeliveryKind
  text: string
  utteranceId: string
  tts: Extract<VoiceTtsDelivery, { status: "delivered" }>
}

export interface VoiceSpeechDeliveryError {
  kind: OutwardSenseDeliveryKind
  text: string
  utteranceId: string
  error: string
}

export interface VoiceLoopbackTurnResult {
  responseText: string
  ponderDeferred: boolean
  tts: VoiceTtsDelivery
  speechSegments: VoiceSpeechSegment[]
  speechDeliveryErrors: VoiceSpeechDeliveryError[]
}

function deliveredTts(spoken: VoiceTtsResult): Extract<VoiceTtsDelivery, { status: "delivered" }> {
  return {
    status: "delivered",
    audio: spoken.audio,
    byteLength: spoken.byteLength,
    chunkCount: spoken.chunkCount,
    mimeType: spoken.mimeType,
    modelId: spoken.modelId,
    voiceId: spoken.voiceId,
  }
}

function aggregateSegments(segments: VoiceSpeechSegment[]): Extract<VoiceTtsDelivery, { status: "delivered" }> {
  const first = segments[0]!.tts
  const audio = Buffer.concat(segments.map((segment) => Buffer.from(segment.tts.audio)))
  return {
    status: "delivered",
    audio,
    byteLength: audio.byteLength,
    chunkCount: segments.reduce((sum, segment) => sum + segment.tts.chunkCount, 0),
    mimeType: first.mimeType,
    modelId: first.modelId,
    voiceId: first.voiceId,
  }
}

function deliveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  const speechSegments: VoiceSpeechSegment[] = []
  const speechDeliveryErrors: VoiceSpeechDeliveryError[] = []
  let deliveryIndex = 0

  const synthesizeDelivery = async (delivery: OutwardSenseDelivery): Promise<void> => {
    deliveryIndex += 1
    const segmentUtteranceId = `${options.transcript.utteranceId}-${deliveryIndex}-${delivery.kind}`
    try {
      const spoken = await options.tts.synthesize({
        utteranceId: segmentUtteranceId,
        text: delivery.text,
        onAudioChunk: options.onAudioChunk,
      })
      speechSegments.push({
        kind: delivery.kind,
        text: delivery.text,
        utteranceId: segmentUtteranceId,
        tts: deliveredTts(spoken),
      })
    } catch (error) {
      const failure = {
        kind: delivery.kind,
        text: delivery.text,
        utteranceId: segmentUtteranceId,
        error: deliveryErrorMessage(error),
      }
      speechDeliveryErrors.push(failure)
      throw error
    }
  }

  const turn = await runSenseTurn({
    agentName: options.agentName,
    channel: "voice",
    friendId: options.friendId,
    sessionKey: options.sessionKey,
    userMessage,
    deliverySink: { onDelivery: synthesizeDelivery },
  })

  if (speechSegments.length > 0) {
    const tts = aggregateSegments(speechSegments)
    const result: VoiceLoopbackTurnResult = {
      responseText: turn.response,
      ponderDeferred: turn.ponderDeferred,
      tts,
      speechSegments,
      speechDeliveryErrors,
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_turn_end",
      message: "voice loopback turn delivered speech",
      meta: {
        utteranceId: options.transcript.utteranceId,
        responseLength: turn.response.length,
        segmentCount: speechSegments.length,
        byteLength: tts.byteLength,
      },
    })
    return result
  }

  const turnDeliveryFailures = turn.deliveryFailures ?? []
  if (speechDeliveryErrors.length > 0 || turnDeliveryFailures.length > 0) {
    const firstError = speechDeliveryErrors[0]?.error ?? turnDeliveryFailures[0]!.error
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_turn_tts_error",
      message: "voice loopback TTS failed after text response",
      meta: { utteranceId: options.transcript.utteranceId, error: firstError, responseLength: turn.response.length },
    })
    return {
      responseText: turn.response,
      ponderDeferred: turn.ponderDeferred,
      tts: {
        status: "failed",
        error: firstError,
      },
      speechSegments,
      speechDeliveryErrors,
    }
  }

  try {
    const spoken: VoiceTtsResult = await options.tts.synthesize({
      utteranceId: options.transcript.utteranceId,
      text: turn.response,
      onAudioChunk: options.onAudioChunk,
    })
    const tts = deliveredTts(spoken)
    const result: VoiceLoopbackTurnResult = {
      responseText: turn.response,
      ponderDeferred: turn.ponderDeferred,
      tts,
      speechSegments: [{
        kind: "text",
        text: turn.response,
        utteranceId: options.transcript.utteranceId,
        tts,
      }],
      speechDeliveryErrors,
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
      speechSegments,
      speechDeliveryErrors,
    }
  }
}
