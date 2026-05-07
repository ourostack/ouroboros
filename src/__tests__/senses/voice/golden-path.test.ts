import { describe, expect, it, vi } from "vitest"
import { runVoiceGoldenPath } from "../../../senses/voice/golden-path"
import type { VoiceTtsService, VoiceTranscriber } from "../../../senses/voice"

const readyRouting = {
  status: "ready" as const,
  hasCaptureDevice: true,
  hasOutputDevice: true,
  currentOutput: "BlackHole 2ch",
  missing: [],
  guidance: [],
}

describe("voice golden path orchestrator", () => {
  it("turns a meeting link and audio file into transcript, voice session text, TTS, and playback artifact metadata", async () => {
    const transcriber: VoiceTranscriber = {
      transcribe: vi.fn(async () => ({
        utteranceId: "utt_gold",
        text: "Can you hear me from the golden path?",
        source: "whisper.cpp",
        audioPath: "/tmp/input.wav",
        language: "en",
        startedAt: null,
        endedAt: null,
      })),
    }
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => ({
        utteranceId: "utt_gold",
        audio: Buffer.from("spoken"),
        byteLength: 6,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/mpeg",
      })),
    }
    const runSenseTurn = vi.fn(async () => ({
      response: "I hear you.",
      ponderDeferred: false,
    }))
    const playback = vi.fn(async () => ({
      status: "written" as const,
      audioPath: "/tmp/out/utt-gold.mp3",
      byteLength: 6,
      mimeType: "audio/mpeg",
      playbackAttempted: false,
    }))

    const result = await runVoiceGoldenPath({
      agentName: "slugger",
      friendId: "ari",
      meetingUrl: "https://riverside.fm/studio/ari-weekly?token=secret",
      audioPath: "/tmp/input.wav",
      utteranceId: "utt_gold",
      language: "en",
      outputDir: "/tmp/out",
      transcriber,
      tts,
      inspectAudioRouting: async () => readyRouting,
      meetingJoiner: {
        join: vi.fn(async () => ({ status: "simulated", detail: "fixture audio represents the meeting stream" })),
      },
      runSenseTurn,
      writePlaybackArtifact: playback,
    })

    expect(transcriber.transcribe).toHaveBeenCalledWith({
      utteranceId: "utt_gold",
      audioPath: "/tmp/input.wav",
      language: "en",
    })
    expect(runSenseTurn).toHaveBeenCalledWith({
      agentName: "slugger",
      channel: "voice",
      friendId: "ari",
      sessionKey: result.meeting.sessionKey,
      userMessage: "Can you hear me from the golden path?",
    })
    expect(tts.synthesize).toHaveBeenCalledWith({ utteranceId: "utt_gold", text: "I hear you." })
    expect(playback).toHaveBeenCalledWith(expect.objectContaining({
      utteranceId: "utt_gold",
      outputDir: "/tmp/out",
      playAudio: false,
    }))
    expect(result).toMatchObject({
      join: { status: "simulated" },
      transcript: { text: "Can you hear me from the golden path?" },
      responseText: "I hear you.",
      tts: { status: "delivered" },
      playback: { status: "written" },
    })
  })

  it("fails fast for invalid meeting links before touching audio or model edges", async () => {
    const transcriber: VoiceTranscriber = { transcribe: vi.fn() }

    await expect(runVoiceGoldenPath({
      agentName: "slugger",
      friendId: "ari",
      meetingUrl: "file:///tmp/not-a-meeting",
      audioPath: "/tmp/input.wav",
      outputDir: "/tmp/out",
      transcriber,
      tts: { synthesize: vi.fn() },
    })).rejects.toThrow("voice meeting URL must be http or https")

    expect(transcriber.transcribe).not.toHaveBeenCalled()
  })

  it("keeps manual-required join status visible while still processing an explicit audio fixture", async () => {
    const result = await runVoiceGoldenPath({
      agentName: "slugger",
      friendId: "ari",
      meetingUrl: "https://meet.example.com/private-room",
      audioPath: "/tmp/input.wav",
      outputDir: "/tmp/out",
      transcriber: {
        transcribe: async () => ({
          utteranceId: "utt_manual",
          text: "Manual join is visible.",
          source: "whisper.cpp",
          audioPath: "/tmp/input.wav",
          language: null,
          startedAt: null,
          endedAt: null,
        }),
      },
      tts: {
        synthesize: async () => {
          throw new Error("TTS unavailable")
        },
      },
      inspectAudioRouting: async () => readyRouting,
      runSenseTurn: async () => ({ response: "Text still lands.", ponderDeferred: false }),
    })

    expect(result.join.status).toBe("manual_required")
    expect(result.tts).toMatchObject({ status: "failed", error: "TTS unavailable" })
    expect(result.playback).toMatchObject({ status: "skipped", reason: "tts_failed" })
  })

  it("surfaces STT failures as golden-path failures with routing and join already proven", async () => {
    await expect(runVoiceGoldenPath({
      agentName: "slugger",
      friendId: "ari",
      meetingUrl: "https://riverside.fm/studio/ari-weekly",
      audioPath: "/tmp/input.wav",
      outputDir: "/tmp/out",
      transcriber: {
        transcribe: async () => {
          throw new Error("no speech")
        },
      },
      tts: { synthesize: vi.fn() },
      inspectAudioRouting: async () => readyRouting,
      meetingJoiner: { join: async () => ({ status: "simulated", detail: "fixture" }) },
    })).rejects.toThrow("voice golden path failed: no speech")
  })

  it("can use default routing inspection and generated utterance ids", async () => {
    const result = await runVoiceGoldenPath({
      agentName: "slugger",
      friendId: "ari",
      meetingUrl: "https://meet.example.com/private-room",
      audioPath: "/tmp/input.wav",
      outputDir: "/tmp/out",
      transcriber: {
        transcribe: async (request) => ({
          utteranceId: request.utteranceId,
          text: "Default edges are visible.",
          source: "whisper.cpp",
          audioPath: request.audioPath,
          language: null,
          startedAt: null,
          endedAt: null,
        }),
      },
      tts: {
        synthesize: async (request) => ({
          utteranceId: request.utteranceId,
          audio: Buffer.from("audio"),
          byteLength: 5,
          chunkCount: 1,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/mpeg",
        }),
      },
      runSenseTurn: async () => ({ response: "Default response.", ponderDeferred: false }),
      writePlaybackArtifact: async () => ({
        status: "written",
        audioPath: "/tmp/out/default.mp3",
        byteLength: 5,
        mimeType: "audio/mpeg",
        playbackAttempted: false,
      }),
    })

    expect(["ready", "unknown"]).toContain(result.audioRouting.status)
    expect(result.join.status).toBe("manual_required")
    expect(result.transcript.utteranceId).toMatch(/^voice-/)
  })

  it("wraps non-Error golden-path failures defensively", async () => {
    await expect(runVoiceGoldenPath({
      agentName: "slugger",
      friendId: "ari",
      meetingUrl: "https://riverside.fm/studio/ari-weekly",
      audioPath: "/tmp/input.wav",
      outputDir: "/tmp/out",
      transcriber: {
        transcribe: async () => {
          throw "raw stt failure"
        },
      },
      tts: { synthesize: vi.fn() },
      inspectAudioRouting: async () => readyRouting,
    })).rejects.toThrow("voice golden path failed: raw stt failure")
  })
})
