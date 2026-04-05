import { afterEach, describe, expect, it, vi } from "vitest"

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock("node:child_process")
  vi.doUnmock("node:fs/promises")
  vi.doUnmock("node:os")
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
    expect(mkdir).toHaveBeenCalledWith("/Users/test/AgentBundles/slugger.ouro/state/tools/whisper-cpp/models", { recursive: true })
    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      "/tmp/ouro-bb-audio-123/Voice Note.m4a",
      Buffer.from("audio-bytes"),
    )
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      "/Users/test/AgentBundles/slugger.ouro/state/tools/whisper-cpp/models/ggml-base.en.bin",
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
        "/Users/test/AgentBundles/slugger.ouro/state/tools/whisper-cpp/models/ggml-base.en.bin",
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
      expect.arrayContaining(["-m", "/Users/test/AgentBundles/slugger.ouro/state/tools/whisper-cpp/models/ggml-base.en.bin"]),
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
