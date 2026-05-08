import { describe, expect, it } from "vitest"
import {
  createElevenLabsTtsClient,
  createNodeElevenLabsSocketFactory,
} from "../../../senses/voice/elevenlabs"

type Handler = (payload?: unknown) => void

class FakeSocket {
  readonly sent: string[] = []
  private handlers: Record<string, Handler[]> = {}

  on(event: "open" | "message" | "error" | "close", handler: Handler): void {
    this.handlers[event] = [...(this.handlers[event] ?? []), handler]
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.emit("close")
  }

  emit(event: "open" | "message" | "error" | "close", payload?: unknown): void {
    for (const handler of this.handlers[event] ?? []) {
      handler(payload)
    }
  }
}

class FakeNativeWebSocket {
  static last: FakeNativeWebSocket | null = null
  readonly sent: string[] = []
  closed = false
  private handlers: Record<string, Handler[]> = {}

  constructor(readonly url: string) {
    FakeNativeWebSocket.last = this
  }

  addEventListener(event: "open" | "message" | "error" | "close", handler: Handler): void {
    this.handlers[event] = [...(this.handlers[event] ?? []), handler]
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.closed = true
  }

  emit(event: "open" | "message" | "error" | "close", payload?: unknown): void {
    for (const handler of this.handlers[event] ?? []) {
      handler(payload)
    }
  }
}

class FakeOnNativeWebSocket {
  static last: FakeOnNativeWebSocket | null = null
  readonly handlers: Partial<Record<"open" | "message" | "error" | "close", Handler>> = {}
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakeOnNativeWebSocket.last = this
  }

  on(event: "open" | "message" | "error" | "close", handler: Handler): void {
    this.handlers[event] = handler
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {}
}

class FakePropertyNativeWebSocket {
  static last: FakePropertyNativeWebSocket | null = null
  onopen?: Handler
  onmessage?: Handler
  onerror?: Handler
  onclose?: Handler
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakePropertyNativeWebSocket.last = this
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {}
}

describe("ElevenLabs streaming TTS client", () => {
  it("opens the low-latency stream URL, sends text chunks, and collects audio bytes", async () => {
    const socket = new FakeSocket()
    const urls: string[] = []
    const streamedChunks: string[] = []
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: (url) => {
        urls.push(url)
        return socket
      },
    })

    const resultPromise = client.synthesize({
      utteranceId: "utt_tts",
      text: "Hello there. General Kenobi.",
      onAudioChunk: (chunk) => {
        streamedChunks.push(Buffer.from(chunk).toString("utf8"))
      },
    })

    socket.emit("open")
    socket.emit("message", JSON.stringify({ audio: Buffer.from("abc").toString("base64") }))
    socket.emit("message", JSON.stringify({ audio: Buffer.from("def").toString("base64"), isFinal: true }))

    const result = await resultPromise
    socket.emit("message", JSON.stringify({ isFinal: true }))
    socket.emit("error", new Error("ignored after final"))

    expect(urls).toEqual([
      "wss://api.elevenlabs.io/v1/text-to-speech/voice_123/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000",
    ])
    expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ text: " ", xi_api_key: "eleven-secret" }),
      { text: "Hello there. General Kenobi.", try_trigger_generation: true },
      { text: "" },
    ])
    expect(result).toMatchObject({
      utteranceId: "utt_tts",
      modelId: "eleven_flash_v2_5",
      voiceId: "voice_123",
      chunkCount: 2,
      byteLength: 6,
      mimeType: "audio/pcm;rate=16000",
    })
    expect(Buffer.from(result.audio).toString()).toBe("abcdef")
    expect(streamedChunks).toEqual(["abc", "def"])
  })

  it("rejects empty text before opening a socket", async () => {
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => new FakeSocket(),
    })

    await expect(client.synthesize({
      utteranceId: "utt_empty_tts",
      text: "   ",
    })).rejects.toThrow("voice TTS text is empty")
  })

  it("surfaces socket errors without printing secrets", async () => {
    const socket = new FakeSocket()
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => socket,
    })

    const resultPromise = client.synthesize({
      utteranceId: "utt_tts_error",
      text: "Hello",
    })

    socket.emit("open")
    socket.emit("error", "websocket failed")

    await expect(resultPromise).rejects.toThrow("ElevenLabs TTS failed: websocket failed")
  })

  it("surfaces synchronous audio chunk delivery failures", async () => {
    const socket = new FakeSocket()
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => socket,
    })

    const resultPromise = client.synthesize({
      utteranceId: "utt_sync_chunk_fail",
      text: "Hello",
      onAudioChunk: () => {
        throw new Error("chunk sink down")
      },
    })

    socket.emit("open")
    socket.emit("message", JSON.stringify({ audio: Buffer.from("abc").toString("base64") }))

    await expect(resultPromise).rejects.toThrow("ElevenLabs TTS failed: chunk sink down")
  })

  it("surfaces asynchronous audio chunk delivery failures", async () => {
    const socket = new FakeSocket()
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => socket,
    })

    const resultPromise = client.synthesize({
      utteranceId: "utt_async_chunk_fail",
      text: "Hello",
      onAudioChunk: async () => {
        throw new Error("async chunk sink down")
      },
    })

    socket.emit("open")
    socket.emit("message", JSON.stringify({ audio: Buffer.from("abc").toString("base64") }))

    await expect(resultPromise).rejects.toThrow("ElevenLabs TTS failed: async chunk sink down")
  })

  it("supports custom MPEG output and Buffer message payloads", async () => {
    const socket = new FakeSocket()
    const urls: string[] = []
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice with spaces",
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
      socketFactory: (url) => {
        urls.push(url)
        return socket
      },
    })

    const resultPromise = client.synthesize({
      utteranceId: "utt_buffer_tts",
      text: "Buffered audio please.",
    })

    socket.emit("open")
    socket.emit("message", Buffer.from(JSON.stringify({ audio: Buffer.from("mp3").toString("base64"), isFinal: true })))

    await expect(resultPromise).resolves.toMatchObject({
      byteLength: 3,
      chunkCount: 1,
      mimeType: "audio/mpeg",
      modelId: "eleven_multilingual_v2",
      voiceId: "voice with spaces",
    })
    expect(urls).toEqual([
      "wss://api.elevenlabs.io/v1/text-to-speech/voice%20with%20spaces/stream-input?model_id=eleven_multilingual_v2&output_format=mp3_44100_128",
    ])
  })

  it("adapts Node global WebSocket-style sockets to the internal socket contract", () => {
    const socket = createNodeElevenLabsSocketFactory(FakeNativeWebSocket)("wss://example.test")
    const messages: unknown[] = []

    socket.on("message", (payload) => messages.push(payload))
    socket.send("hello")
    FakeNativeWebSocket.last?.emit("message", { data: "world" })
    socket.close()

    expect(FakeNativeWebSocket.last?.url).toBe("wss://example.test")
    expect(FakeNativeWebSocket.last?.sent).toEqual(["hello"])
    expect(FakeNativeWebSocket.last?.closed).toBe(true)
    expect(messages).toEqual([{ data: "world" }])
  })

  it("adapts .on and property-style native WebSocket APIs", () => {
    const onSocket = createNodeElevenLabsSocketFactory(FakeOnNativeWebSocket)("wss://on.example")
    const onMessages: unknown[] = []
    onSocket.on("message", (payload) => onMessages.push(payload))
    FakeOnNativeWebSocket.last?.handlers.message?.("hello")

    const propertySocket = createNodeElevenLabsSocketFactory(FakePropertyNativeWebSocket)("wss://property.example")
    const propertyMessages: unknown[] = []
    propertySocket.on("message", (payload) => propertyMessages.push(payload))
    FakePropertyNativeWebSocket.last?.onmessage?.("world")

    expect(onMessages).toEqual(["hello"])
    expect(propertyMessages).toEqual(["world"])
  })

  it("reads DOM-style message event data while streaming TTS", async () => {
    const socket = new FakeSocket()
    const client = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => socket,
    })

    const resultPromise = client.synthesize({
      utteranceId: "utt_dom_message",
      text: "DOM payload",
    })

    socket.emit("open")
    socket.emit("message", { data: JSON.stringify({ audio: Buffer.from("dom").toString("base64"), isFinal: true }) })

    await expect(resultPromise).resolves.toMatchObject({ byteLength: 3, chunkCount: 1 })
  })

  it("uses the global WebSocket constructor when no socketFactory is injected", async () => {
    const globals = globalThis as unknown as { WebSocket?: unknown }
    const original = globals.WebSocket
    try {
      globals.WebSocket = FakeNativeWebSocket
      const client = createElevenLabsTtsClient({
        apiKey: "eleven-secret",
        voiceId: "voice_123",
      })

      const resultPromise = client.synthesize({
        utteranceId: "utt_global_socket",
        text: "Global socket",
      })

      FakeNativeWebSocket.last?.emit("open")
      FakeNativeWebSocket.last?.emit(
        "message",
        { data: JSON.stringify({ audio: Buffer.from("global").toString("base64"), isFinal: true }) },
      )

      await expect(resultPromise).resolves.toMatchObject({ byteLength: 6, chunkCount: 1 })
    } finally {
      globals.WebSocket = original
    }
  })

  it("requires a WebSocket constructor when no global WebSocket exists", () => {
    const globals = globalThis as unknown as { WebSocket?: unknown }
    const original = globals.WebSocket
    try {
      globals.WebSocket = undefined
      expect(() => createNodeElevenLabsSocketFactory()).toThrow("global WebSocket is unavailable")
    } finally {
      globals.WebSocket = original
    }
  })

  it("rejects malformed stream payloads and premature socket closes", async () => {
    const malformedSocket = new FakeSocket()
    const malformedClient = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => malformedSocket,
    })
    const malformed = malformedClient.synthesize({
      utteranceId: "utt_malformed_tts",
      text: "Hello",
    })
    malformedSocket.emit("open")
    malformedSocket.emit("message", undefined)
    await expect(malformed).rejects.toThrow("ElevenLabs TTS failed:")

    const closeSocket = new FakeSocket()
    const closeClient = createElevenLabsTtsClient({
      apiKey: "eleven-secret",
      voiceId: "voice_123",
      socketFactory: () => closeSocket,
    })
    const closed = closeClient.synthesize({
      utteranceId: "utt_closed_tts",
      text: "Hello",
    })
    closeSocket.emit("open")
    closeSocket.emit("close")
    await expect(closed).rejects.toThrow("ElevenLabs TTS failed: socket closed before final audio")
  })
})
