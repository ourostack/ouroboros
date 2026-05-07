import { describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import { runVoiceLoopbackTurn } from "../../../senses/voice/turn"
import type { VoiceTtsService } from "../../../senses/voice"

describe("voice loopback turn", () => {
  it("routes transcript text through a voice session and speaks the text response", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_turn_001",
      text: "Can you hear me?",
      source: "loopback",
    })
    const runSenseTurn = vi.fn(async () => ({
      response: "Yes, loud and clear.",
      ponderDeferred: false,
    }))
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => ({
        utteranceId: "utt_turn_001",
        audio: Buffer.from("audio"),
        byteLength: 5,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/pcm;rate=16000",
      })),
    }

    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "riverside",
      transcript,
      runSenseTurn,
      tts,
    })

    expect(runSenseTurn).toHaveBeenCalledWith({
      agentName: "slugger",
      channel: "voice",
      friendId: "ari",
      sessionKey: "riverside",
      userMessage: "Can you hear me?",
    })
    expect(tts.synthesize).toHaveBeenCalledWith({
      utteranceId: "utt_turn_001",
      text: "Yes, loud and clear.",
    })
    expect(result).toMatchObject({
      responseText: "Yes, loud and clear.",
      tts: {
        status: "delivered",
        byteLength: 5,
        chunkCount: 1,
        mimeType: "audio/pcm;rate=16000",
      },
    })
  })

  it("rejects empty transcript text before the agent turn", async () => {
    const runSenseTurn = vi.fn()
    const tts: VoiceTtsService = { synthesize: vi.fn() }

    await expect(runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "riverside",
      transcript: {
        utteranceId: "utt_empty_turn",
        text: " ",
        source: "loopback",
        audioPath: null,
        language: null,
        startedAt: null,
        endedAt: null,
      },
      runSenseTurn,
      tts,
    })).rejects.toThrow("voice transcript text is empty")

    expect(runSenseTurn).not.toHaveBeenCalled()
    expect(tts.synthesize).not.toHaveBeenCalled()
  })

  it("returns TTS failure metadata without discarding the text response", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_turn_fail",
      text: "please answer",
      source: "loopback",
    })
    const runSenseTurn = vi.fn(async () => ({
      response: "Here is the answer.",
      ponderDeferred: false,
    }))
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => {
        throw new Error("speaker unplugged")
      }),
    }

    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "riverside",
      transcript,
      runSenseTurn,
      tts,
    })

    expect(result).toMatchObject({
      responseText: "Here is the answer.",
      tts: {
        status: "failed",
        error: "speaker unplugged",
      },
    })
  })

  it("reports non-Error transcript and TTS failures defensively", async () => {
    const runSenseTurn = vi.fn(async () => ({
      response: "Still text.",
      ponderDeferred: false,
    }))
    const throwingTranscript = {
      utteranceId: "utt_raw_transcript",
      get text(): string {
        throw "raw transcript failure"
      },
      source: "loopback" as const,
      audioPath: null,
      language: null,
      startedAt: null,
      endedAt: null,
    }

    await expect(runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "riverside",
      transcript: throwingTranscript,
      runSenseTurn,
      tts: { synthesize: vi.fn() },
    })).rejects.toBe("raw transcript failure")
    expect(runSenseTurn).not.toHaveBeenCalled()

    const transcript = buildVoiceTranscript({
      utteranceId: "utt_raw_tts_fail",
      text: "please answer",
      source: "loopback",
    })
    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "riverside",
      transcript,
      runSenseTurn,
      tts: {
        synthesize: vi.fn(async () => {
          throw "raw tts failure"
        }),
      },
    })

    expect(result).toMatchObject({
      responseText: "Still text.",
      tts: {
        status: "failed",
        error: "raw tts failure",
      },
    })
  })
})
