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

    expect(runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "slugger",
      channel: "voice",
      friendId: "ari",
      sessionKey: "riverside",
      userMessage: "Can you hear me?",
      latencyMode: "live",
    }))
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

  it("passes voice call controls into the shared voice session turn", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_control",
      text: "Can you hang up after this?",
      source: "loopback",
    })
    const voiceCall = { requestEnd: vi.fn() }
    const runSenseTurn = vi.fn(async () => ({
      response: "Yes, ending the call.",
      ponderDeferred: false,
    }))
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => ({
        utteranceId: "utt_control",
        audio: Buffer.from("audio"),
        byteLength: 5,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/pcm;rate=16000",
      })),
    }

    await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "phone",
      transcript,
      runSenseTurn,
      tts,
      voiceCall,
    })

    expect(runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
      toolContext: { voiceCall },
    }))
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

  it("speaks tool-delivered speak and settle segments as separate utterances", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_segments",
      text: "start talking",
      source: "loopback",
    })
    const runSenseTurn = vi.fn(async (request) => {
      await request.deliverySink?.onDelivery({ kind: "speak", text: "One second." })
      await request.deliverySink?.onDelivery({ kind: "settle", text: "Done now." })
      return {
        response: "One second.\nDone now.",
        ponderDeferred: false,
        deliveries: [
          { kind: "speak" as const, text: "One second." },
          { kind: "settle" as const, text: "Done now." },
        ],
        deliveryFailures: [],
      }
    })
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async (request) => {
        const audio = Buffer.from(`${request.text}|`)
        return {
          utteranceId: request.utteranceId,
          audio,
          byteLength: audio.byteLength,
          chunkCount: 1,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/mpeg",
        }
      }),
    }

    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "phone",
      transcript,
      runSenseTurn,
      tts,
    })

    expect(tts.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      utteranceId: "utt_segments-1-speak",
      text: "One second.",
    }))
    expect(tts.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      utteranceId: "utt_segments-2-settle",
      text: "Done now.",
    }))
    expect(result.responseText).toBe("One second.\nDone now.")
    expect(result.speechSegments).toMatchObject([
      { kind: "speak", text: "One second.", utteranceId: "utt_segments-1-speak" },
      { kind: "settle", text: "Done now.", utteranceId: "utt_segments-2-settle" },
    ])
    expect(result.tts.status).toBe("delivered")
    if (result.tts.status !== "delivered") throw new Error("expected delivered TTS")
    expect(Buffer.from(result.tts.audio).toString("utf8")).toBe("One second.|Done now.|")
  })

  it("returns delivery failure metadata when tool-delivered speech cannot synthesize", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_delivery_fail",
      text: "please answer",
      source: "loopback",
    })
    const runSenseTurn = vi.fn(async (request) => {
      try {
        await request.deliverySink?.onDelivery({ kind: "settle", text: "No audio." })
      } catch {
        // The shared turn runner catches final delivery failures; this injected
        // runner mirrors that contract so the voice wrapper can report them.
      }
      return {
        response: "No audio.",
        ponderDeferred: false,
        deliveries: [],
        deliveryFailures: [{ kind: "settle" as const, text: "No audio.", error: "speaker unplugged" }],
      }
    })
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => {
        throw new Error("speaker unplugged")
      }),
    }

    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "phone",
      transcript,
      runSenseTurn,
      tts,
    })

    expect(tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      utteranceId: "utt_delivery_fail-1-settle",
      text: "No audio.",
    }))
    expect(result).toMatchObject({
      responseText: "No audio.",
      tts: {
        status: "failed",
        error: "speaker unplugged",
      },
      speechDeliveryErrors: [{
        kind: "settle",
        text: "No audio.",
        utteranceId: "utt_delivery_fail-1-settle",
        error: "speaker unplugged",
      }],
    })
  })

  it("reports non-Error tool-delivered TTS failures defensively", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_raw_delivery_fail",
      text: "please answer",
      source: "loopback",
    })
    const runSenseTurn = vi.fn(async (request) => {
      try {
        await request.deliverySink?.onDelivery({ kind: "settle", text: "No audio." })
      } catch {
        // Mirrors the shared turn runner's final-delivery failure contract.
      }
      return {
        response: "No audio.",
        ponderDeferred: false,
        deliveries: [],
        deliveryFailures: [{ kind: "settle" as const, text: "No audio.", error: "raw speaker failure" }],
      }
    })
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => {
        throw "raw speaker failure"
      }),
    }

    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "phone",
      transcript,
      runSenseTurn,
      tts,
    })

    expect(result).toMatchObject({
      tts: {
        status: "failed",
        error: "raw speaker failure",
      },
      speechDeliveryErrors: [{
        error: "raw speaker failure",
      }],
    })
  })

  it("uses shared-turn delivery failure metadata when no local speech attempt was made", async () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_shared_delivery_fail",
      text: "please answer",
      source: "loopback",
    })
    const runSenseTurn = vi.fn(async () => ({
      response: "No audio.",
      ponderDeferred: false,
      deliveries: [],
      deliveryFailures: [{ kind: "settle" as const, text: "No audio.", error: "shared speaker down" }],
    }))
    const tts: VoiceTtsService = {
      synthesize: vi.fn(),
    }

    const result = await runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "phone",
      transcript,
      runSenseTurn,
      tts,
    })

    expect(tts.synthesize).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      responseText: "No audio.",
      tts: {
        status: "failed",
        error: "shared speaker down",
      },
    })
  })
})
