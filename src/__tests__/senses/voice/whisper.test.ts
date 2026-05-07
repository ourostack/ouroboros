import * as fs from "fs/promises"
import { describe, expect, it, vi } from "vitest"
import {
  createNodeWhisperCppProcessRunner,
  createWhisperCppTranscriber,
  parseWhisperCppTranscriptJson,
} from "../../../senses/voice/whisper"

describe("Whisper.cpp voice transcriber", () => {
  it("runs whisper-cli with explicit model/audio/output paths and parses segment JSON", async () => {
    const processRunner = vi.fn(async () => ({ stdout: "", stderr: "" }))
    const readFile = vi.fn(async () => JSON.stringify({
      transcription: [
        { text: " Hello " },
        { text: "from voice. " },
      ],
    }))
    const removeDir = vi.fn(async () => undefined)

    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/opt/whisper/bin/whisper-cli",
      modelPath: "/models/ggml-base.en.bin",
      processRunner,
      readFile,
      makeTempDir: async () => "/tmp/ouro-voice-whisper",
      removeDir,
    })

    const result = await transcriber.transcribe({
      utteranceId: "utt_002",
      audioPath: "/tmp/input.wav",
      language: "en",
    })

    expect(processRunner).toHaveBeenCalledWith(
      "/opt/whisper/bin/whisper-cli",
      ["-m", "/models/ggml-base.en.bin", "-f", "/tmp/input.wav", "-oj", "-of", "/tmp/ouro-voice-whisper/transcript", "-l", "en"],
      { timeoutMs: 120_000 },
    )
    expect(readFile).toHaveBeenCalledWith("/tmp/ouro-voice-whisper/transcript.json", "utf8")
    expect(removeDir).toHaveBeenCalledWith("/tmp/ouro-voice-whisper")
    expect(result).toMatchObject({
      utteranceId: "utt_002",
      text: "Hello from voice.",
      audioPath: "/tmp/input.wav",
      source: "whisper.cpp",
      language: "en",
    })
  })

  it("parses top-level text output from whisper.cpp JSON", () => {
    expect(parseWhisperCppTranscriptJson(JSON.stringify({ text: "  one clean sentence.  " }))).toBe("one clean sentence.")
  })

  it("rejects invalid JSON and empty transcripts with useful errors", () => {
    expect(() => parseWhisperCppTranscriptJson("{not-json")).toThrow("invalid whisper.cpp JSON")
    expect(() => parseWhisperCppTranscriptJson(JSON.stringify({ transcription: [{ text: " " }] }))).toThrow("empty whisper.cpp transcript")
    expect(() => parseWhisperCppTranscriptJson(JSON.stringify({}))).toThrow("empty whisper.cpp transcript")
    expect(parseWhisperCppTranscriptJson(JSON.stringify({ transcription: [{ text: 3 }, { text: " ok " }] }))).toBe("ok")
  })

  it("wraps process failures with command context", async () => {
    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/opt/whisper-cli",
      modelPath: "/models/model.bin",
      processRunner: async () => {
        throw new Error("exit 1")
      },
      readFile: async () => "{}",
      makeTempDir: async () => "/tmp/ouro-voice-fail",
      removeDir: async () => undefined,
    })

    await expect(transcriber.transcribe({
      utteranceId: "utt_fail",
      audioPath: "/tmp/input.wav",
    })).rejects.toThrow("whisper.cpp transcription failed: exit 1")
  })

  it("uses default temp cleanup when no filesystem helpers are injected", async () => {
    const processRunner = vi.fn(async (_command: string, args: string[]) => {
      const outputBase = args[args.indexOf("-of") + 1]
      await fs.writeFile(`${outputBase}.json`, JSON.stringify({ text: "Default temp works." }), "utf8")
      return { exitCode: 0 }
    })
    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/opt/whisper-cli",
      modelPath: "/models/model.bin",
      processRunner,
      timeoutMs: 42,
    })

    const result = await transcriber.transcribe({
      utteranceId: "utt_default_fs",
      audioPath: "/tmp/input.wav",
    })

    expect(processRunner).toHaveBeenCalledWith(
      "/opt/whisper-cli",
      ["-m", "/models/model.bin", "-f", "/tmp/input.wav", "-oj", "-of", expect.stringContaining("transcript")],
      { timeoutMs: 42 },
    )
    expect(result.text).toBe("Default temp works.")
  })

  it("uses the default Node process runner when no runner is injected", async () => {
    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/definitely/not-a-real-ouro-command",
      modelPath: "/models/model.bin",
      readFile: async () => "{}",
      makeTempDir: async () => "/tmp/ouro-voice-default-runner",
      removeDir: async () => undefined,
      timeoutMs: 5_000,
    })

    await expect(transcriber.transcribe({
      utteranceId: "utt_default_runner_error",
      audioPath: "/tmp/input.wav",
    })).rejects.toThrow("whisper.cpp transcription failed:")
  })

  it("wraps non-zero whisper exit codes and stderr", async () => {
    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/opt/whisper-cli",
      modelPath: "/models/model.bin",
      processRunner: async () => ({ exitCode: 2, stderr: "bad audio" }),
      readFile: async () => "{}",
      makeTempDir: async () => "/tmp/ouro-voice-exit",
      removeDir: async () => undefined,
    })

    await expect(transcriber.transcribe({
      utteranceId: "utt_exit",
      audioPath: "/tmp/input.wav",
    })).rejects.toThrow("whisper.cpp transcription failed: exit 2: bad audio")
  })

  it("wraps non-zero whisper exit codes without stderr", async () => {
    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/opt/whisper-cli",
      modelPath: "/models/model.bin",
      processRunner: async () => ({ exitCode: 3 }),
      readFile: async () => "{}",
      makeTempDir: async () => "/tmp/ouro-voice-exit-no-stderr",
      removeDir: async () => undefined,
    })

    await expect(transcriber.transcribe({
      utteranceId: "utt_exit_no_stderr",
      audioPath: "/tmp/input.wav",
    })).rejects.toThrow("whisper.cpp transcription failed: exit 3")
  })

  it("provides a Node process runner for live Whisper.cpp execution", async () => {
    const runner = createNodeWhisperCppProcessRunner()

    const result = await runner(process.execPath, ["-e", "process.stdout.write('voice-runner-ok')"], { timeoutMs: 5_000 })
    const stderr = await runner(process.execPath, ["-e", "process.stderr.write('voice-runner-err')"], { timeoutMs: 5_000 })
    await expect(runner(process.execPath, ["-e", "setTimeout(() => undefined, 50)"], { timeoutMs: 1 }))
      .rejects.toThrow("command timed out")
    await expect(runner("/definitely/not-a-real-ouro-command", [], { timeoutMs: 5_000 }))
      .rejects.toThrow()

    expect(result).toMatchObject({ stdout: "voice-runner-ok", stderr: "", exitCode: 0 })
    expect(stderr).toMatchObject({ stdout: "", stderr: "voice-runner-err", exitCode: 0 })
  })

  it("wraps non-Error transcription failures defensively", async () => {
    const transcriber = createWhisperCppTranscriber({
      whisperCliPath: "/opt/whisper-cli",
      modelPath: "/models/model.bin",
      processRunner: async () => ({ exitCode: 0 }),
      readFile: async () => {
        throw "raw read failure"
      },
      makeTempDir: async () => "/tmp/ouro-voice-raw-fail",
      removeDir: async () => undefined,
    })

    await expect(transcriber.transcribe({
      utteranceId: "utt_raw_fail",
      audioPath: "/tmp/input.wav",
    })).rejects.toThrow("whisper.cpp transcription failed: raw read failure")
  })
})
