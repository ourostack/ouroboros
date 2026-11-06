export type VoiceTranscriptSource = "loopback" | "whisper.cpp"

export interface VoiceTranscriptInput {
  utteranceId: string
  text: string
  source: VoiceTranscriptSource
  audioPath?: string
  language?: string
  startedAt?: string
  endedAt?: string
}

export interface VoiceTranscript {
  utteranceId: string
  text: string
  source: VoiceTranscriptSource
  audioPath: string | null
  language: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface VoiceTranscriptionRequest {
  utteranceId: string
  audioPath: string
  language?: string
}

export interface VoiceTranscriber {
  transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscript>
}

export interface VoiceTtsRequest {
  utteranceId: string
  text: string
}

export interface VoiceTtsResult {
  utteranceId: string
  audio: Uint8Array
  byteLength: number
  chunkCount: number
  modelId: string
  voiceId: string
  mimeType: string
}

export interface VoiceTtsService {
  synthesize(request: VoiceTtsRequest): Promise<VoiceTtsResult>
}
