import { emitNervesEvent } from "../../nerves/runtime"
import type { RunSenseTurnOptions, RunSenseTurnResult } from "../shared-turn"
import { inspectVoiceAudioRouting, type VoiceAudioRoutingInspection } from "./audio-routing"
import { parseVoiceMeetingUrl, type VoiceMeeting } from "./meeting"
import { writeVoicePlaybackArtifact, type VoicePlaybackRequest, type VoicePlaybackResult } from "./playback"
import { runVoiceLoopbackTurn, type VoiceRunSenseTurn, type VoiceTtsDelivery } from "./turn"
import type { VoiceTranscript, VoiceTranscriber, VoiceTtsService } from "./types"

export type VoiceMeetingJoinStatus = "joined" | "manual_required" | "simulated"

export interface VoiceMeetingJoinResult {
  status: VoiceMeetingJoinStatus
  detail?: string
  participantName?: string
}

export interface VoiceMeetingJoiner {
  join(request: {
    meeting: VoiceMeeting
    audioRouting: VoiceAudioRoutingInspection
  }): Promise<VoiceMeetingJoinResult>
}

export type VoiceGoldenPathPlaybackResult =
  | VoicePlaybackResult
  | {
      status: "skipped"
      reason: "tts_failed"
      playbackAttempted: false
    }

export interface VoiceGoldenPathOptions {
  agentName: string
  friendId: string
  meetingUrl: string
  audioPath: string
  outputDir: string
  transcriber: VoiceTranscriber
  tts: VoiceTtsService
  utteranceId?: string
  language?: string
  sessionKey?: string
  playAudio?: boolean
  inspectAudioRouting?: () => Promise<VoiceAudioRoutingInspection>
  meetingJoiner?: VoiceMeetingJoiner
  runSenseTurn?: VoiceRunSenseTurn
  writePlaybackArtifact?: (request: VoicePlaybackRequest) => Promise<VoicePlaybackResult>
}

export interface VoiceGoldenPathResult {
  meeting: VoiceMeeting
  audioRouting: VoiceAudioRoutingInspection
  join: VoiceMeetingJoinResult
  transcript: VoiceTranscript
  responseText: string
  ponderDeferred: boolean
  tts: VoiceTtsDelivery
  playback: VoiceGoldenPathPlaybackResult
  sessionKey: string
}

const defaultVoiceMeetingJoiner: VoiceMeetingJoiner = {
  async join(request): Promise<VoiceMeetingJoinResult> {
    const result: VoiceMeetingJoinResult = {
      status: "manual_required",
      detail: `Open ${request.meeting.redactedUrl} in a browser profile whose meeting audio is routed through Multi-Output Device.`,
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_meeting_join_manual_required",
      message: "voice meeting join requires browser handoff",
      meta: {
        provider: request.meeting.provider,
        sessionKey: request.meeting.sessionKey,
        routingStatus: request.audioRouting.status,
      },
    })
    return result
  },
}

function defaultUtteranceId(): string {
  return `voice-${Date.now().toString(36)}`
}

function playbackSkipped(): VoiceGoldenPathPlaybackResult {
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_golden_path_playback_skipped",
    message: "voice golden path skipped playback because TTS failed",
    meta: { reason: "tts_failed" },
  })
  return {
    status: "skipped",
    reason: "tts_failed",
    playbackAttempted: false,
  }
}

export async function runVoiceGoldenPath(options: VoiceGoldenPathOptions): Promise<VoiceGoldenPathResult> {
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_golden_path_start",
    message: "starting voice golden path",
    meta: { agentName: options.agentName, friendId: options.friendId },
  })

  try {
    const meeting = parseVoiceMeetingUrl(options.meetingUrl)
    const audioRouting = await (options.inspectAudioRouting ?? inspectVoiceAudioRouting)()
    const joiner = options.meetingJoiner ?? defaultVoiceMeetingJoiner
    const join = await joiner.join({ meeting, audioRouting })
    const utteranceId = options.utteranceId ?? defaultUtteranceId()
    const transcript = await options.transcriber.transcribe({
      utteranceId,
      audioPath: options.audioPath,
      language: options.language,
    })
    const sessionKey = options.sessionKey ?? meeting.sessionKey
    const runSenseTurn = options.runSenseTurn as ((options: RunSenseTurnOptions) => Promise<RunSenseTurnResult>) | undefined
    const turn = await runVoiceLoopbackTurn({
      agentName: options.agentName,
      friendId: options.friendId,
      sessionKey,
      transcript,
      tts: options.tts,
      runSenseTurn,
    })
    const writePlaybackArtifact = options.writePlaybackArtifact ?? writeVoicePlaybackArtifact
    const playback = turn.tts.status === "delivered"
      ? await writePlaybackArtifact({
          utteranceId,
          delivery: turn.tts,
          outputDir: options.outputDir,
          playAudio: options.playAudio ?? false,
        })
      : playbackSkipped()
    const result: VoiceGoldenPathResult = {
      meeting,
      audioRouting,
      join,
      transcript,
      responseText: turn.responseText,
      ponderDeferred: turn.ponderDeferred,
      tts: turn.tts,
      playback,
      sessionKey,
    }

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_golden_path_end",
      message: "finished voice golden path",
      meta: {
        sessionKey,
        joinStatus: join.status,
        ttsStatus: turn.tts.status,
        playbackStatus: playback.status,
      },
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_golden_path_error",
      message: "voice golden path failed",
      meta: { error: message },
    })
    throw new Error(`voice golden path failed: ${message}`)
  }
}
