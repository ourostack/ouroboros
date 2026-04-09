import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => ({
  agentRoot: "",
}))

vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
  return {
    ...actual,
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => testState.agentRoot),
    getAgentToolsRoot: vi.fn(() => path.join(testState.agentRoot, "state", "tools")),
  }
})

const originalFetch = global.fetch
const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-media-"))
  tempDirs.push(dir)
  testState.agentRoot = dir
  return dir
}

beforeEach(() => {
  makeAgentRoot()
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock("node:child_process")
  vi.doUnmock("node:fs/promises")
  vi.doUnmock("node:os")
  vi.doUnmock("../../../heart/attachments/image-normalize")
  vi.doUnmock("../../../nerves/runtime")
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("BlueBubbles media hydration", () => {
  it("hydrates image attachments into image input parts", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "image-guid",
          mimeType: "image/jpeg",
          transferName: "IMG_5045.heic.jpeg",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("image-bytes"), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
        ),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${Buffer.from("image-bytes").toString("base64")}`,
            detail: "auto",
          },
        },
      ],
      transcriptAdditions: [],
      notices: [],
    })
  })

  it("falls back to a generic image content type when BlueBubbles does not return one", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "image-guid",
          transferName: "IMG_5045.png",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(new Response(Buffer.from("image-bytes"), { status: 200 })),
      },
    )

    expect(result).toEqual({
      inputParts: [
        {
          type: "image_url",
          image_url: {
            url: `data:application/octet-stream;base64,${Buffer.from("image-bytes").toString("base64")}`,
            detail: "auto",
          },
        },
      ],
      transcriptAdditions: [],
      notices: [],
    })
  })

  it("hydrates audio attachments into raw audio input when the provider can use audio", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const transcribeAudio = vi.fn().mockResolvedValue("hey, can you check the logs?")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "audio-guid",
          mimeType: "audio/mp3",
          transferName: "Audio Message.mp3",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp3" },
          }),
        ),
        transcribeAudio,
        preferAudioInput: true,
      },
    )

    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(result).toEqual({
      inputParts: [
        {
          type: "input_audio",
          input_audio: {
            data: Buffer.from("audio-bytes").toString("base64"),
            format: "mp3",
          },
        },
      ],
      transcriptAdditions: [],
      notices: [],
    })
  })

  it("falls back to local transcription for audio when the provider cannot use audio directly", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const transcribeAudio = vi.fn().mockResolvedValue("hey, can you check the logs?")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "audio-guid",
          mimeType: "audio/mp3",
          transferName: "Audio Message.mp3",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp3" },
          }),
        ),
        transcribeAudio,
        preferAudioInput: false,
      },
    )

    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({ guid: "audio-guid", transferName: "Audio Message.mp3" }),
        contentType: "audio/mp3",
      }),
    )
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: hey, can you check the logs?"],
      notices: [],
    })
  })

  it("hydrates generic files into file input parts", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const fileData = Buffer.from("report body")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "file-guid",
          mimeType: "application/pdf",
          transferName: "report.pdf",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(fileData, {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
        ),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [
        {
          type: "file",
          file: {
            file_data: fileData.toString("base64"),
            filename: "report.pdf",
          },
        },
      ],
      transcriptAdditions: [],
      notices: [],
    })
  })

  it("treats metadata-free downloaded blobs as generic file inputs", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const fileData = Buffer.from("blob body")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "blob-guid",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(new Response(fileData, { status: 200 })),
      },
    )

    expect(result).toEqual({
      inputParts: [
        {
          type: "file",
          file: {
            file_data: fileData.toString("base64"),
            filename: "blob-guid",
          },
        },
      ],
      transcriptAdditions: [],
      notices: [],
    })
  })

  it("returns explicit notices when attachment hydration fails", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "broken-guid",
          mimeType: "image/jpeg",
          transferName: "broken.jpg",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockRejectedValue(new Error("socket reset")),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for broken.jpg: socket reset"],
    })
  })

  it("falls back to local transcription when raw audio is preferred but the format is unsupported", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const transcribeAudio = vi.fn().mockResolvedValue("please summarize this note")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "audio-guid",
          mimeType: "audio/x-m4a",
          transferName: "Audio Message.m4a",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
        transcribeAudio,
        preferAudioInput: true,
      },
    )

    expect(transcribeAudio).toHaveBeenCalledOnce()
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: please summarize this note"],
      notices: [],
    })
  })

  it("can use audio input based on file extension even when BlueBubbles omits the content type", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "audio-guid",
          transferName: "Audio Message.wav",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })),
        transcribeAudio: vi.fn(),
        preferAudioInput: true,
      },
    )

    expect(result).toEqual({
      inputParts: [
        {
          type: "input_audio",
          input_audio: {
            data: Buffer.from("audio-bytes").toString("base64"),
            format: "wav",
          },
        },
      ],
      transcriptAdditions: [],
      notices: [],
    })
  })

  it("recognizes audio attachments by extension when BlueBubbles omits mime metadata", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const transcribeAudio = vi.fn().mockResolvedValue("extension-based transcript")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "audio-guid",
          transferName: "Audio Message.ogg",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })),
        transcribeAudio,
      },
    )

    expect(transcribeAudio).toHaveBeenCalledOnce()
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: extension-based transcript"],
      notices: [],
    })
  })

  it("returns an explicit notice when audio transcription comes back empty", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "audio-guid",
          mimeType: "audio/mp3",
          transferName: "Audio Message.mp3",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
        ),
        transcribeAudio: vi.fn().mockResolvedValue("   "),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for Audio Message.mp3: empty audio transcript"],
    })
  })

  it("returns an explicit notice when attachment metadata is missing or oversized", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          mimeType: "image/jpeg",
          transferName: "missing-guid.jpg",
        },
        {
          guid: "too-large",
          mimeType: "application/pdf",
          transferName: "too-large.pdf",
          totalBytes: 9 * 1024 * 1024,
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn(),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: [
        "attachment hydration failed for missing-guid.jpg: attachment guid missing",
        "attachment hydration failed for too-large.pdf: attachment exceeds 8388608 byte limit",
      ],
    })
  })

  it("falls back to a generic attachment label when BlueBubbles provides no guid or filename", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{}],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for attachment: attachment guid missing"],
    })
  })

  it("returns an explicit notice when a downloaded attachment exceeds the byte limit", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, "a")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "too-large-after-download",
          mimeType: "application/octet-stream",
          transferName: "huge.bin",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(oversized, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
        ),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for huge.bin: attachment exceeds 8388608 byte limit"],
    })
  })

  it("bootstraps whisper.cpp when no explicit transcriber is provided", async () => {
    let prefixChecks = 0
    const execFile = vi.fn((command: string, args: string[], _: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "brew" && args[0] === "--prefix") {
        prefixChecks += 1
        if (prefixChecks === 1) {
          callback(new Error("not installed"))
          return
        }
        callback(null, "/opt/homebrew/opt/whisper-cpp\n")
        return
      }
      callback(null)
    })
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-123")
    const access = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("missing"))
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " transcribed locally " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-type": "audio/mp4" },
      }),
    )
    const modelFetchImpl = vi.fn().mockResolvedValue(new Response(Buffer.from("model-bytes"), { status: 200 })) as typeof fetch

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "voice-guid",
          mimeType: "audio/mp4",
          transferName: "Voice Note",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local/",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl,
        modelFetchImpl,
      },
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(modelFetchImpl).toHaveBeenCalledOnce()
    expect(execFile).toHaveBeenCalledWith("brew", ["install", "whisper-cpp"], expect.any(Object), expect.any(Function))
    expect(mkdir).toHaveBeenCalledWith(path.join(testState.agentRoot, "state", "tools", "whisper-cpp", "models"), { recursive: true })
    expect(writeFile).toHaveBeenCalledWith(
      path.join(
        testState.agentRoot,
        "state",
        "attachments",
        "materialized",
        "bluebubbles",
        "voice-guid",
        "original.m4a",
      ),
      Buffer.from("audio-bytes"),
    )
    expect(writeFile).toHaveBeenCalledWith(
      path.join(testState.agentRoot, "state", "tools", "whisper-cpp", "models", "ggml-base.en.bin"),
      Buffer.from("model-bytes"),
    )
    expect(execFile).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-i", "/tmp/ouro-bb-audio-123/Voice Note.m4a", "/tmp/ouro-bb-audio-123/Voice Note.wav"]),
      expect.any(Object),
      expect.any(Function),
    )
    expect(execFile).toHaveBeenCalledWith(
      "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli",
      expect.arrayContaining([
        "-m",
        path.join(testState.agentRoot, "state", "tools", "whisper-cpp", "models", "ggml-base.en.bin"),
        "-f",
        "/tmp/ouro-bb-audio-123/Voice Note.wav",
      ]),
      expect.any(Object),
      expect.any(Function),
    )
    expect(readFile).toHaveBeenCalledWith("/tmp/ouro-bb-audio-123/Voice Note.json", "utf8")
    expect(rm).toHaveBeenCalledWith("/tmp/ouro-bb-audio-123", { recursive: true, force: true })
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: transcribed locally"],
      notices: [],
    })
  })

  it("uses an already-installed whisper.cpp brew prefix without reinstalling", async () => {
    const execFile = vi.fn((command: string, args: string[], _: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(new Error("not found"))
        return
      }
      if (command === "brew" && args[0] === "--prefix") {
        callback(null, "/opt/homebrew/opt/whisper-cpp\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-installed")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " preinstalled transcript " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(execFile).not.toHaveBeenCalledWith("brew", ["install", "whisper-cpp"], expect.any(Object), expect.any(Function))
    expect(execFile).toHaveBeenCalledWith(
      "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli",
      expect.arrayContaining(["-m", path.join(testState.agentRoot, "state", "tools", "whisper-cpp", "models", "ggml-base.en.bin")]),
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: preinstalled transcript"],
      notices: [],
    })
  })

  it("reads whisper.cpp transcript text from the transcription array json shape", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/bin/whisper-cli\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-transcription-array")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        transcription: [
          { text: " Hello from Managed Whisper Smoke. " },
          { text: 42 },
          { text: " Second sentence. " },
        ],
      }),
    )
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: Hello from Managed Whisper Smoke. Second sentence."],
      notices: [],
    })
  })

  it("installs whisper.cpp when brew reports a prefix but the binary is still missing", async () => {
    let prefixChecks = 0
    const execFile = vi.fn((command: string, args: string[], _: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(new Error("not found"))
        return
      }
      if (command === "brew" && args[0] === "--prefix") {
        prefixChecks += 1
        if (prefixChecks === 1) {
          callback(null, "/opt/homebrew/opt/whisper-cpp\n")
          return
        }
        callback(null, "/opt/homebrew/Cellar/whisper-cpp/1.8.3\n")
        return
      }
      callback(null)
    })
    const access = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing binary"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-prefix-missing")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " repaired install transcript " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(execFile).toHaveBeenCalledWith("brew", ["install", "whisper-cpp"], expect.any(Object), expect.any(Function))
    expect(execFile).toHaveBeenCalledWith(
      "/opt/homebrew/Cellar/whisper-cpp/1.8.3/bin/whisper-cli",
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: repaired install transcript"],
      notices: [],
    })
  })

  it("installs whisper.cpp when brew returns an empty prefix before install", async () => {
    let prefixChecks = 0
    const execFile = vi.fn((command: string, args: string[], _: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(new Error("not found"))
        return
      }
      if (command === "brew" && args[0] === "--prefix") {
        prefixChecks += 1
        if (prefixChecks === 1) {
          callback(null, "\n")
          return
        }
        callback(null, "/opt/homebrew/Cellar/whisper-cpp/1.8.3\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-empty-prefix")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " empty prefix transcript " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(execFile).toHaveBeenCalledWith("brew", ["install", "whisper-cpp"], expect.any(Object), expect.any(Function))
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: empty prefix transcript"],
      notices: [],
    })
  })

  it("ignores whisper temp cleanup failures after a successful local transcription", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-cleanup")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " cleanup safe " }))
    const rm = vi.fn().mockRejectedValue(new Error("cleanup failed"))

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "cleanup-guid",
          mimeType: "audio/mp3",
          transferName: "cleanup.mp3",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp3" },
          }),
        ),
      },
    )

    expect(rm).toHaveBeenCalledWith("/tmp/ouro-bb-audio-cleanup", { recursive: true, force: true })
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: cleanup safe"],
      notices: [],
    })
  })

  it("surfaces whisper fallback failures and still cleans up temp files", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      if (command === "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli") {
        callback(new Error("whisper failed"))
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-456")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile: vi.fn(), rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "voice-guid",
          mimeType: "audio/ogg",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/ogg" },
          }),
        ),
      },
    )

    expect(writeFile).toHaveBeenCalledWith("/tmp/ouro-bb-audio-456/voice-guid.audio", Buffer.from("audio-bytes"))
    expect(rm).toHaveBeenCalledWith("/tmp/ouro-bb-audio-456", { recursive: true, force: true })
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for voice-guid: whisper failed"],
    })
  })

  it("preserves the original audio file extension for whisper fallback temp files", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-789")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " caf transcript " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "caf-guid",
          mimeType: "audio/x-caf",
          transferName: "Audio Message.caf",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/x-caf" },
          }),
        ),
      },
    )

    expect(writeFile).toHaveBeenCalledWith("/tmp/ouro-bb-audio-789/Audio Message.caf", Buffer.from("audio-bytes"))
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: caf transcript"],
      notices: [],
    })
  })

  it("returns an explicit notice when whisper.cpp install completes without a usable brew prefix", async () => {
    let prefixChecks = 0
    const execFile = vi.fn((command: string, args: string[], _: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(new Error("not found"))
        return
      }
      if (command === "brew" && args[0] === "--prefix") {
        prefixChecks += 1
        if (prefixChecks === 1) {
          callback(new Error("not installed"))
          return
        }
        callback(null, "\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-no-prefix")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile: vi.fn(), rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for Voice Note.m4a: whisper.cpp installed but brew did not return a usable prefix"],
    })
  })

  it("returns an explicit notice when whisper.cpp installs but whisper-cli is still missing", async () => {
    let prefixChecks = 0
    const execFile = vi.fn((command: string, args: string[], _: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(new Error("not found"))
        return
      }
      if (command === "brew" && args[0] === "--prefix") {
        prefixChecks += 1
        if (prefixChecks === 1) {
          callback(new Error("not installed"))
          return
        }
        callback(null, "/opt/homebrew/opt/whisper-cpp\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockRejectedValue(new Error("missing"))
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-missing-binary")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile: vi.fn(), rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for Voice Note.m4a: whisper.cpp installed but whisper-cli binary is missing"],
    })
  })

  it("returns an explicit notice when the managed whisper.cpp model download fails", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockRejectedValue(new Error("missing"))
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-model-fail")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile: vi.fn(), rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
        modelFetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for Voice Note.m4a: failed to download whisper.cpp model: HTTP 503"],
    })
  })

  it("falls back to afconvert when ffmpeg cannot prepare the voice note", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      if (command === "ffmpeg") {
        callback(new Error("ffmpeg failed"))
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-afconvert")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " afconvert transcript " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(execFile).toHaveBeenCalledWith(
      "afconvert",
      expect.arrayContaining(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", "/tmp/ouro-bb-audio-afconvert/Voice Note.m4a"]),
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: afconvert transcript"],
      notices: [],
    })
  })

  it("surfaces both ffmpeg and afconvert failures when audio preparation cannot complete", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      if (command === "ffmpeg") {
        callback(new Error("ffmpeg failed"))
        return
      }
      if (command === "afconvert") {
        callback(new Error("afconvert failed"))
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-convert-fail")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile: vi.fn(), rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "voice-guid", mimeType: "audio/mp4", transferName: "Voice Note.m4a" }],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: [
        "attachment hydration failed for Voice Note.m4a: failed to prepare audio for whisper.cpp (ffmpeg: ffmpeg failed; afconvert: afconvert failed)",
      ],
    })
  })

  it("returns an explicit notice when BlueBubbles rejects an attachment download", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "unavailable-guid",
          mimeType: "application/pdf",
          transferName: "missing.pdf",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for missing.pdf: HTTP 503"],
    })
  })

  it("returns an explicit notice when attachment hydration throws a non-Error value", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "string-failure-guid",
          mimeType: "application/pdf",
          transferName: "string-failure.pdf",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockRejectedValue("connection lost"),
        transcribeAudio: vi.fn(),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for string-failure.pdf: connection lost"],
    })
  })

  it("returns an empty transcript when whisper json does not include text", async () => {
    const execFile = vi.fn((command: string, _: string[], ___: Record<string, unknown>, callback: (error: Error | null, stdout?: string) => void) => {
      if (command === "which") {
        callback(null, "/opt/homebrew/opt/whisper-cpp/bin/whisper-cli\n")
        return
      }
      callback(null)
    })
    const access = vi.fn().mockResolvedValue(undefined)
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-999")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: 42 }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ access, mkdir, mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ homedir: () => "/Users/test", tmpdir: () => "/tmp" }))

    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [
        {
          guid: "voice-guid",
          mimeType: "audio/mp4",
          transferName: "Voice Note",
        },
      ],
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "content-type": "audio/mp4" },
          }),
        ),
      },
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for Voice Note: empty audio transcript"],
    })
  })
})

describe("BlueBubbles media hydration — capability-aware image routing", () => {
  const pngBytes = Buffer.from("png-bytes")
  const pngBase64 = pngBytes.toString("base64")
  const pngDataUrl = `data:image/png;base64,${pngBase64}`

  function baseConfig() {
    return {
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
    }
  }
  function baseChannel() {
    return {
      port: 18790,
      webhookPath: "/bluebubbles-webhook",
      requestTimeoutMs: 30000,
    }
  }
  function pngResponse() {
    return new Response(pngBytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    })
  }
  function gifResponse() {
    return new Response(Buffer.from("gif-bytes"), {
      status: 200,
      headers: { "content-type": "image/gif" },
    })
  }

  it("vision-capable chat model: uses native image_url pass-through and never calls VLM", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => {
      throw new Error("should not be called")
    })
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "claude-opus-4-6",
        vlmDescribe,
      },
    )
    expect(vlmDescribe).not.toHaveBeenCalled()
    expect(result.inputParts).toEqual([
      {
        type: "image_url",
        image_url: { url: pngDataUrl, detail: "auto" },
      },
    ])
  })

  it("non-vision chat model: fires VLM and replaces image_url with a text part", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "a tabby cat sitting on a keyboard")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
        userText: "what is this?",
      },
    )
    expect(vlmDescribe).toHaveBeenCalledTimes(1)
    const call = vlmDescribe.mock.calls[0][0] as {
      prompt: string
      imageDataUrl: string
      attachmentGuid: string
      mimeType: string
      chatModel: string
    }
    expect(call.prompt).toContain('User message: "what is this?"')
    expect(call.prompt).toContain("Describe this image in detail")
    expect(call.prompt).toContain("Include any text visible in the image verbatim")
    expect(call.imageDataUrl).toBe(pngDataUrl)
    expect(call.attachmentGuid).toBe("g1")
    expect(call.mimeType).toBe("image/png")
    expect(call.chatModel).toBe("MiniMax-M2.5")
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: a tabby cat sitting on a keyboard]" },
    ])
  })

  it("non-vision chat model with multiple images: fires VLM once per image, preserves order", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const descriptions = ["first image description", "second image description"]
    const vlmDescribe = vi.fn(async () => descriptions.shift() ?? "fallback")
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pngResponse())
      .mockResolvedValueOnce(pngResponse())
    const result = await hydrateBlueBubblesAttachments(
      [
        { guid: "g1", mimeType: "image/png", transferName: "a.png" },
        { guid: "g2", mimeType: "image/png", transferName: "b.png" },
      ],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl,
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
        userText: "check these",
      },
    )
    expect(vlmDescribe).toHaveBeenCalledTimes(2)
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: first image description]" },
      { type: "text", text: "[image description: second image description]" },
    ])
  })

  it("non-vision chat model, image-only (no user text): prompt still has User message: \"\"", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "desc")
    await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    const prompt = (vlmDescribe.mock.calls[0][0] as { prompt: string }).prompt
    expect(prompt).toContain('User message: ""')
  })

  it("non-vision chat model with inbound text: prompt includes the text verbatim", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "desc")
    await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
        userText: "whats the flight number in the bottom right?",
      },
    )
    const prompt = (vlmDescribe.mock.calls[0][0] as { prompt: string }).prompt
    expect(prompt).toContain('User message: "whats the flight number in the bottom right?"')
  })

  it("non-vision chat model normalizes gif images before VLM describe instead of skipping them", async () => {
    vi.resetModules()
    const agentRoot = makeAgentRoot()
    const normalizedPath = path.join(agentRoot, "normalized-gif.jpg")
    fs.writeFileSync(normalizedPath, "normalized-gif")
    const nervesMock = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMock }))
    const normalizeImageForVision = vi.fn().mockResolvedValue({
      path: normalizedPath,
      mimeType: "image/jpeg",
      byteCount: 14,
    })
    vi.doMock("../../../heart/attachments/image-normalize", () => ({
      MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE: 32 * 1024 * 1024,
      MAX_VLM_IMAGE_BYTES: 5 * 1024 * 1024,
      normalizeImageForVision,
    }))
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "gif normalized description")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/gif", transferName: "fun.gif" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(gifResponse()),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    expect(normalizeImageForVision).toHaveBeenCalled()
    expect(vlmDescribe).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "image/jpeg",
        imageDataUrl: `data:image/jpeg;base64,${Buffer.from("normalized-gif").toString("base64")}`,
      }),
    )
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: gif normalized description]" },
    ])
    const unsupported = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_vision_format_unsupported",
    )
    expect(unsupported).toBeUndefined()
    const hydrate = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_media_hydrate" && c[0]?.meta?.attachmentGuid === "g1",
    )
    expect(hydrate?.[0].meta).toMatchObject({
      attachmentGuid: "g1",
      hydrationPath: "vlm-describe",
    })
  })

  it("allows images above the old 8 MiB cap when they can be normalized", async () => {
    vi.resetModules()
    const agentRoot = makeAgentRoot()
    const normalizedPath = path.join(agentRoot, "big-normalized.jpg")
    fs.writeFileSync(normalizedPath, "normalized-large-image")
    const normalizeImageForVision = vi.fn().mockResolvedValue({
      path: normalizedPath,
      mimeType: "image/jpeg",
      byteCount: 22,
    })
    vi.doMock("../../../heart/attachments/image-normalize", () => ({
      MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE: 32 * 1024 * 1024,
      MAX_VLM_IMAGE_BYTES: 5 * 1024 * 1024,
      normalizeImageForVision,
    }))
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "large image description")
    const result = await hydrateBlueBubblesAttachments(
      [{
        guid: "large-image",
        mimeType: "image/tiff",
        transferName: "poster.tiff",
        totalBytes: 12 * 1024 * 1024,
      }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("raw-tiff"), {
            status: 200,
            headers: { "content-type": "image/tiff" },
          }),
        ),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )

    expect(normalizeImageForVision).toHaveBeenCalled()
    expect(vlmDescribe).toHaveBeenCalled()
    expect(result.notices).toEqual([])
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: large image description]" },
    ])
  })

  it("unsupported format with vision-capable chat model: passes through as image_url, no unsupported event", async () => {
    vi.resetModules()
    const nervesMock = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMock }))
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "should not be called")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/gif", transferName: "fun.gif" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(gifResponse()),
        chatModel: "MiniMax-VL-01",
        vlmDescribe,
      },
    )
    expect(vlmDescribe).not.toHaveBeenCalled()
    expect(result.inputParts).toEqual([
      {
        type: "image_url",
        image_url: {
          url: `data:image/gif;base64,${Buffer.from("gif-bytes").toString("base64")}`,
          detail: "auto",
        },
      },
    ])
    const unsupported = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_vision_format_unsupported",
    )
    expect(unsupported).toBeUndefined()
    const hydrate = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_media_hydrate" && c[0]?.meta?.attachmentGuid === "g1",
    )
    expect(hydrate?.[0].meta).toMatchObject({ hydrationPath: "native-passthrough" })
    vi.doUnmock("../../../nerves/runtime")
  })

  it("VLM describer throws: turn does not crash, falls back to text part with reason", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => {
      throw new Error("vlm unavailable — retry in a moment")
    })
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description failed: vlm unavailable — retry in a moment]" },
    ])
  })

  it("audio attachment with non-vision chat model: audio path unchanged (regression guard)", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const transcribeAudio = vi.fn().mockResolvedValue("hello there")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "a1", mimeType: "audio/mp3", transferName: "note.mp3" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("audio"), {
            status: 200,
            headers: { "content-type": "audio/mp3" },
          }),
        ),
        transcribeAudio,
        preferAudioInput: false,
        chatModel: "MiniMax-M2.5",
        vlmDescribe: vi.fn(),
      },
    )
    expect(result.transcriptAdditions).toEqual(["voice note transcript: hello there"])
  })

  it("mixed attachments (image + audio) with non-vision chat model: both paths fire", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "a screenshot")
    const transcribeAudio = vi.fn().mockResolvedValue("hello")
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pngResponse())
      .mockResolvedValueOnce(
        new Response(Buffer.from("audio"), {
          status: 200,
          headers: { "content-type": "audio/mp3" },
        }),
      )
    const result = await hydrateBlueBubblesAttachments(
      [
        { guid: "g1", mimeType: "image/png", transferName: "pic.png" },
        { guid: "a1", mimeType: "audio/mp3", transferName: "note.mp3" },
      ],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl,
        transcribeAudio,
        preferAudioInput: false,
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    expect(vlmDescribe).toHaveBeenCalledTimes(1)
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: a screenshot]" },
    ])
    expect(result.transcriptAdditions).toEqual(["voice note transcript: hello"])
  })

  it("per-attachment bluebubbles_media_hydrate event: fires once per attachment with AX-4 meta", async () => {
    vi.resetModules()
    const nervesMock = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMock }))
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "desc")
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pngResponse())
      .mockResolvedValueOnce(pngResponse())
    await hydrateBlueBubblesAttachments(
      [
        { guid: "g1", mimeType: "image/png", transferName: "a.png" },
        { guid: "g2", mimeType: "image/png", transferName: "b.png" },
      ],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl,
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    const hydrates = nervesMock.mock.calls.filter(
      (c) => c[0]?.event === "senses.bluebubbles_media_hydrate",
    )
    expect(hydrates.length).toBe(2)
    const g1 = hydrates.find((c) => c[0].meta.attachmentGuid === "g1")
    const g2 = hydrates.find((c) => c[0].meta.attachmentGuid === "g2")
    expect(g1?.[0].meta).toMatchObject({
      attachmentGuid: "g1",
      mimeType: "image/png",
      hydrationPath: "vlm-describe",
    })
    expect(typeof g1?.[0].meta.byteCount).toBe("number")
    expect(g2?.[0].meta).toMatchObject({
      attachmentGuid: "g2",
      mimeType: "image/png",
      hydrationPath: "vlm-describe",
    })
    vi.doUnmock("../../../nerves/runtime")
  })

  it("when chatModel is omitted: defaults to native pass-through (backward compat)", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
      },
    )
    expect(result.inputParts).toEqual([
      {
        type: "image_url",
        image_url: { url: pngDataUrl, detail: "auto" },
      },
    ])
  })

  it("uses global fetch when fetchImpl dep is omitted (default-arg fallback)", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const originalFetch = global.fetch
    try {
      const stub = vi.fn().mockResolvedValue(pngResponse())
      ;(global as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch
      const result = await hydrateBlueBubblesAttachments(
        [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
        baseConfig(),
        baseChannel(),
        { chatModel: "claude-opus-4-6" },
      )
      expect(stub).toHaveBeenCalledTimes(1)
      expect(result.inputParts[0]).toMatchObject({ type: "image_url" })
    } finally {
      ;(global as { fetch: typeof fetch }).fetch = originalFetch
    }
  })

  it("webp image with non-vision chat model: supported VLM format", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "webp desc")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/webp", transferName: "pic.webp" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("webp-bytes"), {
            status: 200,
            headers: { "content-type": "image/webp" },
          }),
        ),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    expect(vlmDescribe).toHaveBeenCalledTimes(1)
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: webp desc]" },
    ])
  })

  it("jpeg image with non-vision chat model: supported VLM format", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const vlmDescribe = vi.fn(async () => "jpeg desc")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/jpeg", transferName: "pic.jpg" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(Buffer.from("jpeg-bytes"), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
        ),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    expect(vlmDescribe).toHaveBeenCalledTimes(1)
    expect(result.inputParts).toEqual([
      { type: "text", text: "[image description: jpeg desc]" },
    ])
  })

  it("senses.bluebubbles_media_hydrate emits at warn level so it survives the BB default log level (B3)", async () => {
    vi.resetModules()
    const nervesMock = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMock }))
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "claude-opus-4-6",
      },
    )
    const hydrate = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_media_hydrate",
    )
    expect(hydrate).toBeDefined()
    expect(hydrate?.[0].level).toBe("warn")
    vi.doUnmock("../../../nerves/runtime")
  })

  it("non-vision chat model with missing content-type: still normalizes and describes the image", async () => {
    vi.resetModules()
    const agentRoot = makeAgentRoot()
    const normalizedPath = path.join(agentRoot, "missing-content-type.jpg")
    fs.writeFileSync(normalizedPath, "normalized-no-content-type")
    const nervesMock = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMock }))
    vi.doMock("../../../heart/attachments/image-normalize", () => ({
      MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE: 32 * 1024 * 1024,
      MAX_VLM_IMAGE_BYTES: 5 * 1024 * 1024,
      normalizeImageForVision: vi.fn().mockResolvedValue({
        path: normalizedPath,
        mimeType: "image/jpeg",
        byteCount: 26,
      }),
    }))
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    // Attachment reports no mimeType and response has no content-type → image
    // detection still fires on extension (".png") but contentType is
    // undefined, so isSupportedVlmFormat rejects it.
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(new Response(Buffer.from("x"), { status: 200 })),
        chatModel: "MiniMax-M2.5",
        vlmDescribe: vi.fn().mockResolvedValue("png without content-type"),
      },
    )
    expect(result.inputParts).toEqual([{ type: "text", text: "[image description: png without content-type]" }])
    const unsupported = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_vision_format_unsupported",
    )
    expect(unsupported).toBeUndefined()
    vi.doUnmock("../../../nerves/runtime")
  })

  it("VLM describer throws a non-Error value: turn does not crash, fallback text includes coerced reason", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vlmDescribe = vi.fn(async () => {
      throw "plain string failure"
    }) as unknown as Parameters<typeof hydrateBlueBubblesAttachments>[3]["vlmDescribe"]
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "MiniMax-M2.5",
        vlmDescribe,
      },
    )
    expect(result.inputParts[0]).toEqual({
      type: "text",
      text: "[image description failed: plain string failure]",
    })
  })

  it("non-vision chat model but no vlmDescribe dep provided: falls back to notice", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../../senses/bluebubbles/media")
    const result = await hydrateBlueBubblesAttachments(
      [{ guid: "g1", mimeType: "image/png", transferName: "pic.png" }],
      baseConfig(),
      baseChannel(),
      {
        fetchImpl: vi.fn().mockResolvedValue(pngResponse()),
        chatModel: "MiniMax-M2.5",
      },
    )
    // No vlmDescribe → behave like an error path
    expect(result.inputParts).toEqual([
      { type: "text", text: expect.stringMatching(/image description failed/i) },
    ])
  })
})
