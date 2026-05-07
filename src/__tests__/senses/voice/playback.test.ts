import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { writeVoicePlaybackArtifact } from "../../../senses/voice/playback"
import type { VoiceTtsDelivery } from "../../../senses/voice/turn"

const delivered: VoiceTtsDelivery = {
  status: "delivered",
  audio: Buffer.from("mp3 audio"),
  byteLength: 9,
  chunkCount: 1,
  mimeType: "audio/mpeg",
  modelId: "eleven_flash_v2_5",
  voiceId: "voice_123",
}

describe("voice playback artifacts", () => {
  it("writes delivered TTS audio to a stable artifact path without invoking playback by default", async () => {
    const mkdir = vi.fn(async () => undefined)
    const writeFile = vi.fn(async () => undefined)
    const commandRunner = vi.fn(async () => ({ exitCode: 0 }))

    const result = await writeVoicePlaybackArtifact({
      utteranceId: "utt playback",
      delivery: delivered,
      outputDir: "/tmp/voice-artifacts",
      mkdir,
      writeFile,
      commandRunner,
    })

    expect(mkdir).toHaveBeenCalledWith("/tmp/voice-artifacts", { recursive: true })
    expect(writeFile).toHaveBeenCalledWith("/tmp/voice-artifacts/utt-playback.mp3", delivered.audio)
    expect(commandRunner).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: "written",
      audioPath: "/tmp/voice-artifacts/utt-playback.mp3",
      byteLength: 9,
      playbackAttempted: false,
    })
  })

  it("can invoke afplay for a written artifact", async () => {
    const commandRunner = vi.fn(async () => ({ exitCode: 0 }))

    const result = await writeVoicePlaybackArtifact({
      utteranceId: "utt_play",
      delivery: delivered,
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      commandRunner,
      playAudio: true,
      playbackCommandPath: "/usr/bin/afplay",
    })

    expect(commandRunner).toHaveBeenCalledWith("/usr/bin/afplay", ["/tmp/voice-artifacts/utt-play.mp3"], { timeoutMs: 30_000 })
    expect(result).toMatchObject({ status: "played", playbackAttempted: true })
  })

  it("returns failure metadata when playback command fails after writing the artifact", async () => {
    const result = await writeVoicePlaybackArtifact({
      utteranceId: "utt_fail",
      delivery: delivered,
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      commandRunner: async () => ({ exitCode: 2, stderr: "no device" }),
      playAudio: true,
    })

    expect(result).toMatchObject({
      status: "failed",
      audioPath: "/tmp/voice-artifacts/utt-fail.mp3",
      error: "exit 2: no device",
      playbackAttempted: true,
    })
  })

  it("covers alternate audio extensions, fallback stems, and stdout-only playback failures", async () => {
    const writes: string[] = []
    const wav = await writeVoicePlaybackArtifact({
      utteranceId: "utt_wav",
      delivery: { ...delivered, mimeType: "audio/wav" },
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async (filePath) => { writes.push(filePath) },
    })
    const xwav = await writeVoicePlaybackArtifact({
      utteranceId: "utt_xwav",
      delivery: { ...delivered, mimeType: "audio/x-wav" },
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async (filePath) => { writes.push(filePath) },
    })
    const pcm = await writeVoicePlaybackArtifact({
      utteranceId: "!!!",
      delivery: { ...delivered, mimeType: "audio/pcm;rate=16000" },
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async (filePath) => { writes.push(filePath) },
    })
    const fallback = await writeVoicePlaybackArtifact({
      utteranceId: "utt_unknown",
      delivery: { ...delivered, mimeType: "application/octet-stream" },
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async (filePath) => { writes.push(filePath) },
    })
    const stdoutFailure = await writeVoicePlaybackArtifact({
      utteranceId: "utt_stdout_fail",
      delivery: delivered,
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      commandRunner: async () => ({ exitCode: 4, stdout: "bad output device" }),
      playAudio: true,
    })
    const blankFailure = await writeVoicePlaybackArtifact({
      utteranceId: "utt_blank_fail",
      delivery: delivered,
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      commandRunner: async () => ({ exitCode: 5 }),
      playAudio: true,
    })

    expect(wav.audioPath).toBe("/tmp/voice-artifacts/utt-wav.wav")
    expect(xwav.audioPath).toBe("/tmp/voice-artifacts/utt-xwav.wav")
    expect(pcm.audioPath).toBe("/tmp/voice-artifacts/utterance.pcm")
    expect(fallback.audioPath).toBe("/tmp/voice-artifacts/utt-unknown.audio")
    expect(stdoutFailure).toMatchObject({ status: "failed", error: "exit 4: bad output device" })
    expect(blankFailure).toMatchObject({ status: "failed", error: "exit 5" })
    expect(writes).toEqual([
      "/tmp/voice-artifacts/utt-wav.wav",
      "/tmp/voice-artifacts/utt-xwav.wav",
      "/tmp/voice-artifacts/utterance.pcm",
      "/tmp/voice-artifacts/utt-unknown.audio",
    ])
  })

  it("uses default filesystem writes and wraps raw playback failures", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-voice-playback-"))
    try {
      const written = await writeVoicePlaybackArtifact({
        utteranceId: "utt_real_fs",
        delivery: delivered,
        outputDir,
      })
      const rawFailure = await writeVoicePlaybackArtifact({
        utteranceId: "utt_raw_fail",
        delivery: delivered,
        outputDir,
        commandRunner: async () => {
          throw "raw playback failure"
        },
        playAudio: true,
      })

      await expect(fs.readFile(written.audioPath)).resolves.toEqual(delivered.audio)
      expect(written).toMatchObject({ status: "written", playbackAttempted: false })
      expect(rawFailure).toMatchObject({ status: "failed", error: "raw playback failure" })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("can use the default Node playback runner", async () => {
    const result = await writeVoicePlaybackArtifact({
      utteranceId: "utt_default_runner",
      delivery: delivered,
      outputDir: "/tmp/voice-artifacts",
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      playbackCommandPath: "/usr/bin/true",
      playAudio: true,
    })

    expect(result).toMatchObject({ status: "played", playbackAttempted: true })
  })
})
