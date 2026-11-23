import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import { runVoiceLoopbackTurn } from "../../../senses/voice/turn"
import { recordVoiceUtterance, voiceUtterances } from "../../../senses/voice/utterances"
import { turnSpoke } from "../../../senses/turn-attempts"
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

// Each thing a caller says ends in a recorded outcome, and what they heard is noted before it plays.
describe("voice turn outcomes", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  function utterance(id: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-turn-outcomes-"))
    dirs.push(dir)
    const turn = recordVoiceUtterance(dir, id, { callSid: "CA1", friendId: "ari", sessionKey: "phone", transport: "media-stream" })!
    return { turn, journal: voiceUtterances(dir) }
  }
  const spoken = (utteranceId: string) => ({
    utteranceId, audio: Buffer.from("audio"), byteLength: 5, chunkCount: 1,
    modelId: "eleven_flash_v2_5", voiceId: "voice_123", mimeType: "audio/pcm;rate=16000",
  })

  it("notes each spoken delivery before it is synthesized, and records the utterance as answered", async () => {
    const { turn, journal } = utterance("utt_outcome_segments")
    const noted: unknown[] = []
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async (request) => {
        noted.push(journal.get("utt_outcome_segments")?.spokeRecords?.map((spoke) => spoke.kind))
        return spoken(request.utteranceId)
      }),
    }
    const runSenseTurn = vi.fn(async (request) => {
      await request.deliverySink?.onDelivery({ kind: "speak", text: "One second." })
      request.onOutwardSend?.(turnSpoke("tool:send_message", null))
      await request.deliverySink?.onDelivery({ kind: "settle", text: "Done now." })
      return { response: "One second. Done now.", ponderDeferred: false }
    })
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", runSenseTurn, tts, utterance: turn,
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_segments", text: "status?", source: "loopback" }),
    })
    expect(noted).toEqual([["speech:speak"], ["speech:speak", "tool:send_message", "speech:settle"]])
    expect(journal.outcome("utt_outcome_segments")).toMatchObject({ outcome: "answered", attempts: 1 })
  })

  it("notes the whole reply before it is synthesized when nothing was delivered during the turn", async () => {
    const { turn, journal } = utterance("utt_outcome_whole")
    let noted: unknown
    const tts: VoiceTtsService = {
      synthesize: vi.fn(async (request) => {
        noted = journal.get("utt_outcome_whole")
        return spoken(request.utteranceId)
      }),
    }
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", tts, utterance: turn,
      runSenseTurn: vi.fn(async () => ({ response: "Loud and clear.", ponderDeferred: false })),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_whole", text: "hear me?", source: "loopback" }),
    })
    expect(noted).toMatchObject({ spoke: true, spokeRecords: [expect.objectContaining({ kind: "speech:text", textLength: 15 })] })
    expect(journal.outcome("utt_outcome_whole")).toMatchObject({ outcome: "answered" })
  })

  it("records an utterance whose reply could not be spoken as failed", async () => {
    const whole = utterance("utt_outcome_tts_fail")
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: whole.turn,
      tts: { synthesize: vi.fn(async () => { throw new Error("speaker unplugged") }) },
      runSenseTurn: vi.fn(async () => ({ response: "No audio.", ponderDeferred: false })),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_tts_fail", text: "answer", source: "loopback" }),
    })
    expect(whole.journal.outcome("utt_outcome_tts_fail")).toMatchObject({ outcome: "failed", detail: "the reply could not be spoken: speaker unplugged" })

    const segment = utterance("utt_outcome_segment_fail")
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: segment.turn,
      tts: { synthesize: vi.fn() },
      runSenseTurn: vi.fn(async () => ({
        response: "No audio.", ponderDeferred: false, deliveries: [],
        deliveryFailures: [{ kind: "settle" as const, text: "No audio.", error: "shared speaker down" }],
      })),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_segment_fail", text: "answer", source: "loopback" }),
    })
    expect(segment.journal.outcome("utt_outcome_segment_fail")).toMatchObject({ outcome: "failed", detail: "the reply could not be spoken: shared speaker down" })
  })

  it("records an utterance whose turn threw as failed and passes the error on", async () => {
    const { turn, journal } = utterance("utt_outcome_threw")
    await expect(runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: turn, tts: { synthesize: vi.fn() },
      runSenseTurn: vi.fn(async () => { throw new Error("provider down") }),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_threw", text: "answer", source: "loopback" }),
    })).rejects.toThrow("provider down")
    expect(journal.outcome("utt_outcome_threw")).toMatchObject({ outcome: "failed", detail: "the turn failed: provider down", attempts: 1 })

    const empty = utterance("utt_outcome_empty")
    await expect(runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: empty.turn, tts: { synthesize: vi.fn() },
      runSenseTurn: vi.fn(),
      transcript: { ...buildVoiceTranscript({ utteranceId: "utt_outcome_empty", text: "x", source: "loopback" }), text: "   " },
    })).rejects.toThrow("voice transcript text is empty")
    expect(empty.journal.outcome("utt_outcome_empty")).toMatchObject({ outcome: "failed", detail: "the turn failed: voice transcript text is empty" })
  })

  it("records a turn with nothing to say as silent, without noting speech that never went out", async () => {
    const { turn, journal } = utterance("utt_outcome_silent")
    let noted: unknown
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: turn,
      tts: { synthesize: vi.fn(async () => { noted = journal.get("utt_outcome_silent"); throw new Error("voice TTS text is empty") }) },
      runSenseTurn: vi.fn(async () => ({ response: "  ", ponderDeferred: false })),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_silent", text: "never mind", source: "loopback" }),
    })
    expect(noted).toMatchObject({ spoke: false })
    expect(journal.outcome("utt_outcome_silent")).toMatchObject({ outcome: "silent", detail: "the agent had nothing to say" })
  })

  it("records a turn whose only speech could not be spoken as failed, even when its final reply is empty", async () => {
    const { turn, journal } = utterance("utt_outcome_mid_turn_fail")
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: turn,
      tts: { synthesize: vi.fn(async () => { throw new Error("speaker unplugged") }) },
      runSenseTurn: vi.fn(async (request) => {
        // As the real turn does, a failed delivery is caught and the turn goes on.
        await request.deliverySink?.onDelivery({ kind: "speak", text: "Checking now." }).catch(() => undefined)
        return { response: "", ponderDeferred: false }
      }),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_mid_turn_fail", text: "status?", source: "loopback" }),
    })
    expect(journal.outcome("utt_outcome_mid_turn_fail")).toMatchObject({ outcome: "failed", detail: "the reply could not be spoken: speaker unplugged" })

    const failures = utterance("utt_outcome_delivery_failures")
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", utterance: failures.turn, tts: { synthesize: vi.fn() },
      runSenseTurn: vi.fn(async () => ({
        response: "", ponderDeferred: false, deliveries: [],
        deliveryFailures: [{ kind: "speak" as const, text: "Checking now.", error: "shared speaker down" }],
      })),
      transcript: buildVoiceTranscript({ utteranceId: "utt_outcome_delivery_failures", text: "status?", source: "loopback" }),
    })
    expect(failures.journal.outcome("utt_outcome_delivery_failures")).toMatchObject({ outcome: "failed", detail: "the reply could not be spoken: shared speaker down" })
  })

  it("passes no outward-send hook when the utterance has no record", async () => {
    const runSenseTurn = vi.fn(async () => ({ response: "Hi.", ponderDeferred: false }))
    await runVoiceLoopbackTurn({
      agentName: "slugger", friendId: "ari", sessionKey: "phone", runSenseTurn,
      tts: { synthesize: vi.fn(async (request) => spoken(request.utteranceId)) },
      transcript: buildVoiceTranscript({ utteranceId: "utt_no_record", text: "hi", source: "loopback" }),
    })
    expect(runSenseTurn.mock.calls[0]![0]).not.toHaveProperty("onOutwardSend")
  })
})
