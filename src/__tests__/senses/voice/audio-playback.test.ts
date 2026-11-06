import { describe, expect, it } from "vitest"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { prepareVoiceCallAudio } from "../../../senses/voice/audio-playback"

async function makeExecutableScript(prefix: string, body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const script = path.join(dir, "fake-ffmpeg.sh")
  await fs.writeFile(script, body, { mode: 0o755 })
  await fs.chmod(script, 0o755)
  return script
}

describe("voice call audio playback preparation", () => {
  it("generates Twilio-ready mulaw tones", async () => {
    const prepared = await prepareVoiceCallAudio({
      source: "tone",
      label: "latency beep",
      toneHz: 880,
      durationMs: 250,
    })

    expect(prepared).toMatchObject({
      label: "latency beep",
      durationMs: 250,
      mimeType: "audio/x-mulaw;rate=8000",
    })
    expect(prepared.audio.byteLength).toBe(2000)
  })

  it("uses tone defaults and clamps unsafe tone timing", async () => {
    const short = await prepareVoiceCallAudio({
      durationMs: -20,
      toneHz: Number.POSITIVE_INFINITY,
    })
    expect(short).toMatchObject({
      label: "tone",
      durationMs: 80,
      mimeType: "audio/x-mulaw;rate=8000",
    })
    expect(short.audio.byteLength).toBe(640)

    const long = await prepareVoiceCallAudio({
      source: "tone",
      durationMs: 25_000,
      toneHz: 8_000,
    })
    expect(long.durationMs).toBe(20_000)
    expect(long.audio.byteLength).toBe(160_000)
  })

  it("rejects local audio files outside the agent bundle or temp directory", async () => {
    await expect(prepareVoiceCallAudio({
      source: "file",
      path: path.join(os.homedir(), "outside.wav"),
    }, {
      agentRoot: path.join(os.tmpdir(), "agent.ouro"),
    })).rejects.toThrow("voice audio files must live under the agent bundle or temp directory")
  })

  it("converts fetched URL audio to Twilio mulaw with injected ffmpeg", async () => {
    const fakeFfmpeg = await makeExecutableScript("ouro-fake-ffmpeg-", [
      "#!/bin/sh",
      "last=\"\"",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf '\\377\\000\\177\\200' > \"$last\"",
      "",
    ].join("\n"))
    const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-length": "3" },
    })

    const prepared = await prepareVoiceCallAudio({
      source: "url",
      url: "https://example.test/sound.wav",
      label: "clip",
      durationMs: 900,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      ffmpegCandidates: [fakeFfmpeg],
    })

    expect(prepared).toMatchObject({
      label: "clip",
      durationMs: 1,
      mimeType: "audio/x-mulaw;rate=8000",
    })
    expect([...prepared.audio]).toEqual([255, 0, 127, 128])
  })

  it("uses an explicit ffmpeg path with the default candidate list", async () => {
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent.ouro-"))
    const inputPath = path.join(agentRoot, "cue.wav")
    await fs.writeFile(inputPath, new Uint8Array([8, 9, 10]))
    const fakeFfmpeg = await makeExecutableScript("ouro-fake-ffmpeg-path-", [
      "#!/bin/sh",
      "last=\"\"",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf '\\011\\012\\013\\014\\015\\016\\017\\020' > \"$last\"",
      "",
    ].join("\n"))

    const prepared = await prepareVoiceCallAudio({
      source: "file",
      path: inputPath,
      label: "from path",
    }, {
      agentRoot,
      ffmpegPath: fakeFfmpeg,
    })

    expect(prepared).toMatchObject({
      label: "from path",
      durationMs: 1,
    })
    expect([...prepared.audio]).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
  })

  it("converts agent-bundle file audio and cleans temporary ffmpeg files", async () => {
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent.ouro-"))
    const inputPath = path.join(agentRoot, "cue.wav")
    await fs.writeFile(inputPath, new Uint8Array([4, 5, 6]))
    const fakeFfmpeg = await makeExecutableScript("ouro-fake-ffmpeg-", [
      "#!/bin/sh",
      "last=\"\"",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf '\\001\\002\\003\\004\\005\\006\\007\\010' > \"$last\"",
      "",
    ].join("\n"))

    const prepared = await prepareVoiceCallAudio({
      source: "file",
      path: inputPath,
    }, {
      agentRoot,
      ffmpegCandidates: [fakeFfmpeg],
    })

    expect(prepared.audio.byteLength).toBe(8)
    expect(prepared.durationMs).toBe(1)
  })

  it("allows temp-directory file audio without an agent bundle root", async () => {
    const inputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-voice-file-"))
    const inputPath = path.join(inputDir, "cue.wav")
    await fs.writeFile(inputPath, new Uint8Array([1, 2, 3]))
    const fakeFfmpeg = await makeExecutableScript("ouro-fake-ffmpeg-temp-", [
      "#!/bin/sh",
      "last=\"\"",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "printf '\\021\\022\\023\\024' > \"$last\"",
      "",
    ].join("\n"))

    try {
      const prepared = await prepareVoiceCallAudio({
        source: "file",
        path: inputPath,
      }, {
        ffmpegCandidates: [fakeFfmpeg],
      })

      expect([...prepared.audio]).toEqual([17, 18, 19, 20])
    } finally {
      await fs.rm(inputDir, { recursive: true, force: true })
    }
  })

  it("rejects unsafe or too-large remote audio before conversion", async () => {
    await expect(prepareVoiceCallAudio({
      source: "url",
      url: "file:///tmp/sound.wav",
    })).rejects.toThrow("voice audio URL must be http(s)")

    const notOkFetch = async () => new Response("missing", { status: 404 })
    await expect(prepareVoiceCallAudio({
      source: "url",
      url: "https://example.test/missing.wav",
    }, {
      fetchImpl: notOkFetch as typeof fetch,
    })).rejects.toThrow("voice audio URL fetch failed: 404")

    const tooLargeFetch = async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-length": String((10 * 1024 * 1024) + 1) },
    })
    await expect(prepareVoiceCallAudio({
      source: "url",
      url: "https://example.test/huge.wav",
    }, {
      fetchImpl: tooLargeFetch as typeof fetch,
    })).rejects.toThrow("voice audio URL is too large")

    const oversizedBodyFetch = async () => new Response(Buffer.alloc((10 * 1024 * 1024) + 1), {
      status: 200,
    })
    await expect(prepareVoiceCallAudio({
      source: "url",
      url: "https://example.test/huge-body.wav",
    }, {
      fetchImpl: oversizedBodyFetch as typeof fetch,
    })).rejects.toThrow("voice audio URL is too large")
  })

  it("rejects invalid local audio paths and failed conversion", async () => {
    const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent.ouro-"))
    await expect(prepareVoiceCallAudio({
      source: "file",
      path: agentRoot,
    }, {
      agentRoot,
    })).rejects.toThrow("voice audio path is not a file")

    const tooLarge = path.join(agentRoot, "huge.wav")
    await fs.writeFile(tooLarge, Buffer.alloc((10 * 1024 * 1024) + 1))
    await expect(prepareVoiceCallAudio({
      source: "file",
      path: tooLarge,
    }, {
      agentRoot,
    })).rejects.toThrow("voice audio file is too large")

    const inputPath = path.join(agentRoot, "bad.wav")
    await fs.writeFile(inputPath, new Uint8Array([1, 2, 3]))
    const failingFfmpeg = await makeExecutableScript("ouro-fake-ffmpeg-fail-", [
      "#!/bin/sh",
      "echo nope >&2",
      "exit 2",
      "",
    ].join("\n"))
    await expect(prepareVoiceCallAudio({
      source: "file",
      path: inputPath,
    }, {
      agentRoot,
      ffmpegCandidates: [failingFfmpeg],
    })).rejects.toThrow("nope")

    const silentFailingFfmpeg = await makeExecutableScript("ouro-fake-ffmpeg-silent-fail-", [
      "#!/bin/sh",
      "exit 2",
      "",
    ].join("\n"))
    await expect(prepareVoiceCallAudio({
      source: "file",
      path: inputPath,
    }, {
      agentRoot,
      ffmpegCandidates: [silentFailingFfmpeg],
    })).rejects.toThrow("Command failed")

    await expect(prepareVoiceCallAudio({
      source: "file",
      path: inputPath,
    }, {
      agentRoot,
      ffmpegCandidates: [],
    })).rejects.toThrow("ffmpeg unavailable")
  })
})
