import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice/transcript"
import type { VoiceTtsService } from "../../../senses/voice/types"

describe("voice loopback turn default shared runner", () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock("../../../senses/shared-turn")
  })

  it("uses the shared voice turn runner when no runner is injected", async () => {
    const runSenseTurn = vi.fn(async () => ({
      response: "Default runner response.",
      ponderDeferred: false,
    }))
    vi.doMock("../../../senses/shared-turn", () => ({ runSenseTurn }))

    const { runVoiceLoopbackTurn } = await import("../../../senses/voice/turn")
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async () => ({
        utteranceId: "utt_default_runner",
        audio: Buffer.from("audio"),
        byteLength: 5,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/pcm;rate=16000",
      })),
    }

    await expect(runVoiceLoopbackTurn({
      agentName: "slugger",
      friendId: "ari",
      sessionKey: "voice-default",
      transcript: buildVoiceTranscript({
        utteranceId: "utt_default_runner",
        text: "use the default runner",
        source: "loopback",
      }),
      tts,
    })).resolves.toMatchObject({
      responseText: "Default runner response.",
      tts: { status: "delivered" },
    })
    expect(runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
      channel: "voice",
      userMessage: "use the default runner",
    }))
  })
})
