import { describe, expect, it } from "vitest"
import {
  buildVoiceTranscript,
  transcriptToPromptText,
  normalizeVoiceSessionKey,
} from "../../../senses/voice"

describe("voice transcript contracts", () => {
  it("preserves transcript text as the canonical prompt text", () => {
    const transcript = buildVoiceTranscript({
      utteranceId: "utt_001",
      text: "  Can you hear me now?  ",
      audioPath: "/tmp/input.wav",
      source: "loopback",
      startedAt: "2026-05-07T07:30:00.000Z",
      endedAt: "2026-05-07T07:30:01.000Z",
    })

    expect(transcript).toMatchObject({
      utteranceId: "utt_001",
      text: "Can you hear me now?",
      audioPath: "/tmp/input.wav",
      source: "loopback",
    })
    expect(transcriptToPromptText(transcript)).toBe("Can you hear me now?")
  })

  it("rejects empty transcript text before an agent turn is attempted", () => {
    expect(() => buildVoiceTranscript({
      utteranceId: "utt_empty",
      text: " \n\t ",
      source: "loopback",
    })).toThrow("voice transcript text is empty")
  })

  it("normalizes voice session keys without hiding blank input", () => {
    expect(normalizeVoiceSessionKey(" Riverside Room ")).toBe("riverside-room")
    expect(normalizeVoiceSessionKey("ari/weekly:sync")).toBe("ari-weekly-sync")
    expect(() => normalizeVoiceSessionKey("   ")).toThrow("voice session key is empty")
  })
})
