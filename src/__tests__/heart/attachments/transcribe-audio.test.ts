import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => ({ agentRoot: "" }))

vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
  return { ...actual, getAgentToolsRoot: vi.fn(() => path.join(testState.agentRoot, "state", "tools")) }
})

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void
type Handler = (command: string, args: string[]) => { error?: Error; stdout?: string; stderr?: string } | void

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function modelPath(): string {
  return path.join(testState.agentRoot, "state", "tools", "whisper-cpp", "models", "ggml-base.en.bin")
}

function installModel(): void {
  fs.mkdirSync(path.dirname(modelPath()), { recursive: true })
  fs.writeFileSync(modelPath(), "model")
}

// whisper-cli writes <-of>.json; everything else succeeds unless the handler says otherwise.
async function loadWith(handler: Handler, transcript: unknown = { text: " hello there " }) {
  const execFile = vi.fn((command: string, args: string[], _options: unknown, callback: Callback) => {
    const result = handler(command, args)
    if (result) {
      callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "")
      return
    }
    if (command.endsWith("whisper-cli")) fs.writeFileSync(`${args[args.indexOf("-of") + 1]}.json`, JSON.stringify(transcript))
    callback(null, "", "")
  })
  vi.doMock("node:child_process", () => ({ execFile }))
  const module = await import("../../../heart/attachments/transcribe-audio")
  return { ...module, execFile }
}

const onPath = (command: string) => (command === "which" ? { stdout: "/usr/local/bin/whisper-cli\n" } : undefined)

beforeEach(() => {
  testState.agentRoot = tempDir("transcribe-audio-")
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("node:child_process")
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("whisperCppTranscriptText", () => {
  it("reads the top-level text, the transcription segments, or nothing", async () => {
    const { whisperCppTranscriptText } = await import("../../../heart/attachments/transcribe-audio")
    expect(whisperCppTranscriptText(JSON.stringify({ text: "  hi  " }))).toBe("hi")
    expect(whisperCppTranscriptText(JSON.stringify({ transcription: [{ text: " a " }, { text: 3 }, null, { text: "b" }] }))).toBe("a b")
    expect(whisperCppTranscriptText(JSON.stringify({ other: true }))).toBe("")
    expect(() => whisperCppTranscriptText("not json")).toThrow()
  })
})

describe("transcribeAudioFile", () => {
  it("uses whisper-cli from PATH and an installed model, converting with ffmpeg", async () => {
    installModel()
    const { transcribeAudioFile, execFile } = await loadWith(onPath)
    await expect(transcribeAudioFile("/in/voice.ogg", { timeoutMs: 1000 })).resolves.toBe("hello there")
    expect(execFile).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["-i", "/in/voice.ogg"]), expect.any(Object), expect.any(Function))
    expect(execFile).toHaveBeenCalledWith("/usr/local/bin/whisper-cli", expect.arrayContaining(["-m", modelPath()]), expect.any(Object), expect.any(Function))
    expect(execFile).not.toHaveBeenCalledWith("brew", expect.anything(), expect.anything(), expect.anything())
  })

  it("downloads the model once when it is missing", async () => {
    const { transcribeAudioFile } = await loadWith(onPath)
    const fetchImpl = vi.fn().mockResolvedValue(new Response("model-bytes", { status: 200 })) as unknown as typeof fetch
    await expect(transcribeAudioFile("/in/a.m4a", { timeoutMs: 1000, fetchImpl })).resolves.toBe("hello there")
    expect(fs.readFileSync(modelPath(), "utf8")).toBe("model-bytes")
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("names the HTTP status when the model download fails", async () => {
    const { transcribeAudioFile } = await loadWith(onPath)
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 503 })) as unknown as typeof fetch
    await expect(transcribeAudioFile("/in/a.m4a", { timeoutMs: 1000, fetchImpl })).rejects.toThrow("failed to download whisper.cpp model: HTTP 503")
  })

  it("falls back to afconvert, and names both failures when neither converts", async () => {
    installModel()
    const viaAfconvert = await loadWith((command) => command === "ffmpeg" ? { error: new Error("x"), stderr: "no ffmpeg" } : onPath(command))
    await expect(viaAfconvert.transcribeAudioFile("/in/a.caf", { timeoutMs: 1000 })).resolves.toBe("hello there")
    expect(viaAfconvert.execFile).toHaveBeenCalledWith("afconvert", expect.any(Array), expect.any(Object), expect.any(Function))
    vi.resetModules()

    const neither = await loadWith((command) => {
      if (command === "ffmpeg") return { error: new Error("x"), stdout: "ffmpeg said no" }
      if (command === "afconvert") return { error: new Error("afconvert missing") }
      return onPath(command)
    })
    await expect(neither.transcribeAudioFile("/in/a.caf", { timeoutMs: 1000 })).rejects.toThrow(
      "failed to prepare audio for whisper.cpp (ffmpeg: ffmpeg said no; afconvert: afconvert missing)",
    )
  })

  it("still returns the transcript when the scratch folder cannot be removed", async () => {
    installModel()
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.doMock("node:fs/promises", () => ({ ...actual, rm: vi.fn().mockRejectedValue(new Error("busy")) }))
    try {
      const { transcribeAudioFile } = await loadWith(onPath)
      await expect(transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).resolves.toBe("hello there")
    } finally {
      vi.doUnmock("node:fs/promises")
    }
  })

  it("returns an empty string when the audio held no speech", async () => {
    installModel()
    const { transcribeAudioFile } = await loadWith(onPath, { transcription: [] })
    await expect(transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).resolves.toBe("")
  })

  it("uses an installed Homebrew whisper-cpp when whisper-cli is not on PATH", async () => {
    installModel()
    const prefix = tempDir("brew-prefix-")
    fs.mkdirSync(path.join(prefix, "bin"))
    fs.writeFileSync(path.join(prefix, "bin", "whisper-cli"), "")
    const { transcribeAudioFile, execFile } = await loadWith((command, args) => {
      if (command === "which") return { stdout: "" }
      if (command === "brew" && args[0] === "--prefix") return { stdout: `${prefix}\n` }
    })
    await expect(transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).resolves.toBe("hello there")
    expect(execFile).not.toHaveBeenCalledWith("brew", ["install", "whisper-cpp"], expect.anything(), expect.anything())
  })

  it("installs whisper-cpp with Homebrew when it is nowhere yet", async () => {
    installModel()
    const prefix = tempDir("brew-prefix-")
    let installed = false
    const { transcribeAudioFile, execFile } = await loadWith((command, args) => {
      if (command === "which") return { error: new Error("not found") }
      if (command === "brew" && args[0] === "install") {
        fs.mkdirSync(path.join(prefix, "bin"))
        fs.writeFileSync(path.join(prefix, "bin", "whisper-cli"), "")
        installed = true
        return { stdout: "" }
      }
      if (command === "brew" && args[0] === "--prefix") return installed ? { stdout: `${prefix}\n` } : { error: new Error("not installed") }
    })
    await expect(transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).resolves.toBe("hello there")
    expect(execFile).toHaveBeenCalledWith("brew", ["install", "whisper-cpp"], expect.any(Object), expect.any(Function))
  })

  it("installs when the Homebrew prefix exists but holds no binary", async () => {
    installModel()
    const prefix = tempDir("brew-prefix-")
    const { transcribeAudioFile } = await loadWith((command, args) => {
      if (command === "which") return { stdout: "" }
      if (command === "brew" && args[0] === "install") {
        fs.mkdirSync(path.join(prefix, "bin"))
        fs.writeFileSync(path.join(prefix, "bin", "whisper-cli"), "")
        return { stdout: "" }
      }
      if (command === "brew") return { stdout: `${prefix}\n` }
    })
    await expect(transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).resolves.toBe("hello there")
  })

  it("says how to fix it when whisper-cli is missing and Homebrew cannot install it", async () => {
    const { transcribeAudioFile } = await loadWith((command) => command === "which" || command === "brew" ? { error: new Error("spawn brew ENOENT") } : undefined)
    await expect(transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).rejects.toThrow(
      "whisper-cli is not on PATH and installing it with Homebrew failed (spawn brew ENOENT); install whisper.cpp so whisper-cli is on PATH",
    )
  })

  it("fails clearly when Homebrew installs but gives no usable prefix or binary", async () => {
    const noPrefix = await loadWith((command, args) => {
      if (command === "which") return { stdout: "" }
      if (command === "brew" && args[0] === "--prefix") return { stdout: "" }
    })
    await expect(noPrefix.transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).rejects.toThrow("whisper.cpp installed but brew did not return a usable prefix")
    vi.resetModules()

    const prefix = tempDir("brew-prefix-")
    const noBinary = await loadWith((command, args) => {
      if (command === "which") return { stdout: "" }
      if (command === "brew" && args[0] === "--prefix") return { stdout: `${prefix}\n` }
    })
    await expect(noBinary.transcribeAudioFile("/in/a.wav", { timeoutMs: 1000 })).rejects.toThrow("whisper.cpp installed but whisper-cli binary is missing")
  })
})

describe("voiceNoteLine", () => {
  it("gives the transcript line, or a notice when nothing was said", async () => {
    installModel()
    const spoken = await loadWith(onPath)
    await expect(spoken.voiceNoteLine("note.ogg", "/in/note.ogg", { timeoutMs: 1000 })).resolves.toEqual({ line: "voice note transcript: hello there" })
    vi.resetModules()
    const silent = await loadWith(onPath, { text: "   " })
    await expect(silent.voiceNoteLine("note.ogg", "/in/note.ogg", { timeoutMs: 1000 })).resolves.toEqual({
      notice: "attachment hydration failed for note.ogg: empty audio transcript",
    })
  })
})
