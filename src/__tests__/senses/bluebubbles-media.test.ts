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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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

  it("uses on-device whisper fallback when no explicit transcriber is provided", async () => {
    const execFile = vi.fn((_: string, __: string[], ___: Record<string, unknown>, callback: (error: Error | null) => void) =>
      callback(null),
    )
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-123")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " transcribed locally " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ tmpdir: () => "/tmp" }))
    global.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })) as typeof fetch

    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    )

    expect(writeFile).toHaveBeenCalledWith("/tmp/ouro-bb-audio-123/Voice Note.m4a", Buffer.from("audio-bytes"))
    expect(execFile).toHaveBeenCalledWith(
      "whisper",
      expect.arrayContaining(["/tmp/ouro-bb-audio-123/Voice Note.m4a", "--model", "turbo"]),
      { timeout: 120000 },
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

  it("ignores whisper temp cleanup failures after a successful local transcription", async () => {
    const execFile = vi.fn((_: string, __: string[], ___: Record<string, unknown>, callback: (error: Error | null) => void) =>
      callback(null),
    )
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-cleanup")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " cleanup safe " }))
    const rm = vi.fn().mockRejectedValue(new Error("cleanup failed"))

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ tmpdir: () => "/tmp" }))
    global.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })) as typeof fetch

    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    )

    expect(rm).toHaveBeenCalledWith("/tmp/ouro-bb-audio-cleanup", { recursive: true, force: true })
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: cleanup safe"],
      notices: [],
    })
  })

  it("surfaces whisper fallback failures and still cleans up temp files", async () => {
    const execFile = vi.fn((_: string, __: string[], ___: Record<string, unknown>, callback: (error: Error | null) => void) =>
      callback(new Error("whisper failed")),
    )
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-456")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ mkdtemp, writeFile, readFile: vi.fn(), rm }))
    vi.doMock("node:os", () => ({ tmpdir: () => "/tmp" }))
    global.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })) as typeof fetch

    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const execFile = vi.fn((_: string, __: string[], ___: Record<string, unknown>, callback: (error: Error | null) => void) =>
      callback(null),
    )
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-789")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: " caf transcript " }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ tmpdir: () => "/tmp" }))
    global.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })) as typeof fetch

    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    )

    expect(writeFile).toHaveBeenCalledWith("/tmp/ouro-bb-audio-789/Audio Message.caf", Buffer.from("audio-bytes"))
    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: caf transcript"],
      notices: [],
    })
  })

  it("returns an explicit notice when BlueBubbles rejects an attachment download", async () => {
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    const execFile = vi.fn((_: string, __: string[], ___: Record<string, unknown>, callback: (error: Error | null) => void) =>
      callback(null),
    )
    const mkdtemp = vi.fn().mockResolvedValue("/tmp/ouro-bb-audio-999")
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ text: 42 }))
    const rm = vi.fn().mockResolvedValue(undefined)

    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({ mkdtemp, writeFile, readFile, rm }))
    vi.doMock("node:os", () => ({ tmpdir: () => "/tmp" }))
    global.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 })) as typeof fetch

    const { hydrateBlueBubblesAttachments } = await import("../../senses/bluebubbles-media")
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
    )

    expect(result).toEqual({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for Voice Note: empty audio transcript"],
    })
  })
})
