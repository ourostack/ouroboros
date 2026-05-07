import { emitNervesEvent } from "../../nerves/runtime"
import type { VoiceTranscript, VoiceTranscriptInput } from "./types"

function compactSpeechText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function buildVoiceTranscript(input: VoiceTranscriptInput): VoiceTranscript {
  const text = compactSpeechText(input.text)
  if (!text) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_transcript_error",
      message: "voice transcript text is empty",
      meta: { utteranceId: input.utteranceId },
    })
    throw new Error("voice transcript text is empty")
  }

  const transcript: VoiceTranscript = {
    utteranceId: input.utteranceId,
    text,
    source: input.source,
    audioPath: input.audioPath ?? null,
    language: input.language ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_transcript_built",
    message: "built voice transcript",
    meta: { utteranceId: transcript.utteranceId, source: transcript.source, length: transcript.text.length },
  })

  return transcript
}

export function transcriptToPromptText(transcript: VoiceTranscript): string {
  const text = compactSpeechText(transcript.text)
  if (!text) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_transcript_error",
      message: "voice prompt text is empty",
      meta: { utteranceId: transcript.utteranceId },
    })
    throw new Error("voice transcript text is empty")
  }
  return text
}

export function normalizeVoiceSessionKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!normalized) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_transcript_error",
      message: "voice session key is empty",
      meta: { inputLength: value.length },
    })
    throw new Error("voice session key is empty")
  }
  return normalized
}
