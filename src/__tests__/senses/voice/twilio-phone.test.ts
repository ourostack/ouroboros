import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import {
  computeTwilioSignature,
  createTwilioPhoneBridge,
  defaultTwilioRecordingDownloader,
  normalizeTwilioPhoneBasePath,
  normalizeTwilioPhonePlaybackMode,
  startTwilioPhoneBridgeServer,
  twilioPhoneWebhookUrl,
  twilioPhoneVoiceSessionKey,
  twilioRecordingMediaUrl,
  validateTwilioSignature,
} from "../../../senses/voice/twilio-phone"
import type { VoiceTtsService, VoiceTranscriber } from "../../../senses/voice"
import type { VoiceRunSenseTurn } from "../../../senses/voice/turn"

function formBody(values: Record<string, string>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    params.set(key, value)
  }
  return params.toString()
}

async function collectBridgeBody(body: string | Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function firstPlayUrl(body: string | Uint8Array | AsyncIterable<Uint8Array>): string {
  const text = String(body)
  const match = text.match(/<Play>([^<]+)<\/Play>/)
  if (!match) throw new Error(`missing Play URL in ${text}`)
  return match[1]!.replace(/&amp;/g, "&")
}

function baseBridgeOptions(outputDir: string) {
  const transcriber: VoiceTranscriber = {
    transcribe: vi.fn(async (request) => buildVoiceTranscript({
      utteranceId: request.utteranceId,
      text: "hello over the phone",
      audioPath: request.audioPath,
      source: "whisper.cpp",
    })),
  }
  const tts: VoiceTtsService = {
    synthesize: vi.fn(async (request) => ({
      utteranceId: request.utteranceId,
      audio: Buffer.from("mp3-response"),
      byteLength: 12,
      chunkCount: 1,
      modelId: "eleven_flash_v2_5",
      voiceId: "voice_123",
      mimeType: "audio/mpeg",
    })),
  }
  const runSenseTurn: VoiceRunSenseTurn = vi.fn(async (request) => ({
    response: `agent heard: ${request.userMessage}`,
    ponderDeferred: false,
  }))
  const downloadRecording = vi.fn(async () => Buffer.from("wav-input"))

  return {
    agentName: "slugger",
    publicBaseUrl: "https://voice.example.com/base/",
    outputDir,
    transcriber,
    tts,
    runSenseTurn,
    downloadRecording,
    playbackMode: "buffered" as const,
  }
}

describe("Twilio phone voice bridge", () => {
  it("normalizes transport webhook paths for single-agent and agent-scoped routes", () => {
    expect(normalizeTwilioPhoneBasePath()).toBe("/voice/twilio")
    expect(normalizeTwilioPhoneBasePath("voice/agents/slugger/twilio/")).toBe("/voice/agents/slugger/twilio")
    expect(twilioPhoneWebhookUrl("https://voice.example.com/base/", "voice/agents/slugger/twilio"))
      .toBe("https://voice.example.com/voice/agents/slugger/twilio/incoming")
    expect(() => normalizeTwilioPhoneBasePath("   ")).toThrow("Twilio phone webhook base path is empty")
    expect(() => normalizeTwilioPhoneBasePath("/voice//twilio")).toThrow("invalid Twilio phone webhook base path")
  })

  it("normalizes playback mode and keys sessions to the phone voice channel", () => {
    expect(normalizeTwilioPhonePlaybackMode(undefined)).toBe("stream")
    expect(normalizeTwilioPhonePlaybackMode("BUFFERED")).toBe("buffered")
    expect(() => normalizeTwilioPhonePlaybackMode("fast-ish")).toThrow("invalid Twilio phone playback mode")
    expect(twilioPhoneVoiceSessionKey({
      from: "+1 (555) 123-4567",
      to: "+1 (555) 765-4321",
    })).toBe("twilio-phone-15551234567-via-15557654321")
    expect(twilioPhoneVoiceSessionKey({
      defaultFriendId: "ari",
      from: "+1 (555) 123-4567",
      to: "+1 (555) 765-4321",
    })).toBe("twilio-phone-ari-via-15557654321")
    expect(twilioPhoneVoiceSessionKey({
      from: "+++",
    })).toBe("twilio-phone-unknown")
    expect(twilioPhoneVoiceSessionKey({
      to: "+1 (555) 765-4321",
    })).toBe("twilio-phone-line-15557654321")
    expect(twilioPhoneVoiceSessionKey({ callSid: "CA123" })).toBe("twilio-phone-CA123")
    expect(twilioPhoneVoiceSessionKey({})).toBe("twilio-phone-incoming")
  })

  it("starts an agent voice turn when answering inbound calls", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers["content-type"]).toBe("text/xml; charset=utf-8")
      expect(String(response.body)).toContain("<Response>")
      expect(String(response.body)).toContain("<Play>https://voice.example.com/voice/twilio/audio/CA123/twilio-ca123-connected.mp3</Play>")
      expect(String(response.body)).toContain("action=\"https://voice.example.com/voice/twilio/recording\"")
      expect(String(response.body)).toContain("method=\"POST\"")
      expect(String(response.body)).toContain("maxLength=\"30\"")
      expect(String(response.body)).not.toContain("<Say>Connected to Ouro voice")
      expect(String(response.body)).not.toContain("localhost")
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "slugger",
        channel: "voice",
        friendId: "twilio-15551234567",
        sessionKey: "twilio-phone-15551234567-via-15557654321",
        userMessage: expect.stringContaining("A Twilio phone voice call just connected."),
      }))
      expect(options.tts.synthesize).toHaveBeenCalledWith({
        utteranceId: "twilio-CA123-connected",
        text: expect.stringContaining("agent heard: A Twilio phone voice call just connected."),
      })
      expect(await fs.readFile(path.join(outputDir, "CA123", "twilio-ca123-connected.mp3"), "utf8")).toBe("mp3-response")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("starts an inbound agent voice turn even when Twilio omits call and caller identifiers", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: "",
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Play>https://voice.example.com/voice/twilio/audio/incoming/twilio-incoming-connected.mp3</Play>")
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "slugger",
        channel: "voice",
        friendId: "twilio-incoming",
        sessionKey: "twilio-phone-incoming",
        userMessage: expect.stringContaining("Twilio did not provide caller ID."),
      }))
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("Twilio did not provide the dialed line."),
      }))
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps Twilio routes under a configured agent-scoped transport path", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        basePath: "/voice/agents/slugger/twilio",
      }
      const bridge = createTwilioPhoneBridge(options)
      const incoming = await bridge.handle({
        method: "POST",
        path: "/voice/agents/slugger/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567" }),
      })
      const oldPath = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567" }),
      })
      const recording = await bridge.handle({
        method: "POST",
        path: "/voice/agents/slugger/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
        }),
      })

      expect(String(incoming.body)).toContain("action=\"https://voice.example.com/voice/agents/slugger/twilio/recording\"")
      expect(oldPath.statusCode).toBe(404)
      expect(String(recording.body)).toContain("<Play>https://voice.example.com/voice/agents/slugger/twilio/audio/CA111/twilio-ca111-re222.mp3</Play>")
      expect(String(recording.body)).toContain("<Redirect method=\"POST\">https://voice.example.com/voice/agents/slugger/twilio/listen</Redirect>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps listening when the inbound agent greeting turn fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      options.runSenseTurn = vi.fn(async () => {
        throw new Error("agent unavailable")
      })
      const bridge = createTwilioPhoneBridge(options)

      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Record")
      expect(String(response.body)).toContain("action=\"https://voice.example.com/voice/twilio/recording\"")
      expect(String(response.body)).not.toContain("<Play>")
      expect(String(response.body)).not.toContain("<Say>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps listening when the inbound agent greeting TTS fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      options.tts.synthesize = vi.fn(async () => {
        throw new Error("tts unavailable")
      })
      const bridge = createTwilioPhoneBridge(options)

      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Say>voice output failed after the text response was captured.</Say>")
      expect(String(response.body)).toContain("<Record")
      expect(String(response.body)).not.toContain("<Play>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("returns not found for unknown Twilio POST routes with empty bodies", async () => {
    const bridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))

    const response = await bridge.handle({
      method: "POST",
      path: "voice/twilio/unknown",
      headers: {},
    })

    expect(response).toMatchObject({
      statusCode: 404,
      body: "not found",
    })
  })

  it("fails closed when a Twilio auth token is configured and the request is unsigned", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      twilioAuthToken: "twilio-token",
    })

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: {},
      body: formBody({ CallSid: "CA123", From: "+15551234567" }),
    })

    expect(response).toMatchObject({
      statusCode: 403,
      body: "invalid Twilio signature",
    })
  })

  it("fails closed when Twilio sends an empty signature header array", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      twilioAuthToken: "twilio-token",
    })

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: { "x-twilio-signature": [] },
      body: formBody({ CallSid: "CA123", From: "+15551234567" }),
    })

    expect(response.statusCode).toBe(403)
  })

  it("fails closed when Twilio sends an undefined signature header value", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      twilioAuthToken: "twilio-token",
    })

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: { "x-twilio-signature": undefined },
      body: formBody({ CallSid: "CA123", From: "+15551234567" }),
    })

    expect(response.statusCode).toBe(403)
  })

  it("accepts correctly signed Twilio form webhooks", async () => {
    const options = {
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      twilioAuthToken: "twilio-token",
    }
    const body = formBody({ CallSid: "CA123", From: "+15551234567" })
    const params = Object.fromEntries(new URLSearchParams(body))
    const signature = computeTwilioSignature({
      authToken: "twilio-token",
      url: "https://voice.example.com/voice/twilio/incoming",
      params,
    })
    const bridge = createTwilioPhoneBridge(options)

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: { "x-twilio-signature": signature },
      body,
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.body)).toContain("<Record")
  })

  it("accepts signed Twilio webhooks with array headers and byte bodies", async () => {
    const body = formBody({ CallSid: "CA123", From: "+15551234567" })
    const params = Object.fromEntries(new URLSearchParams(body))
    const signature = computeTwilioSignature({
      authToken: "twilio-token",
      url: "https://voice.example.com/voice/twilio/incoming?source=phone",
      params,
    })
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      twilioAuthToken: "twilio-token",
    })

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming?source=phone",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-ignored-header": "skip",
        "X-Twilio-Signature": [signature],
      },
      body: Buffer.from(body),
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.body)).toContain("<Record")
  })

  it("treats blank Twilio auth tokens as local unsigned mode", () => {
    expect(validateTwilioSignature({
      authToken: "   ",
      url: "https://voice.example.com/voice/twilio/incoming",
      params: {},
      signature: "",
    })).toBe(true)
  })

  it("downloads Twilio recordings with optional Basic auth", async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(Buffer.from("wav-open")))
      .mockResolvedValueOnce(new Response(Buffer.from("wav-auth")))
      .mockResolvedValueOnce(new Response("missing", { status: 404, statusText: "Not Found" }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      await expect(defaultTwilioRecordingDownloader({
        recordingUrl: "https://api.twilio.com/Recordings/RE123.wav",
      })).resolves.toEqual(Buffer.from("wav-open"))
      expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.twilio.com/Recordings/RE123.wav", {
        headers: {},
      })

      await expect(defaultTwilioRecordingDownloader({
        recordingUrl: "https://api.twilio.com/Recordings/RE123.wav",
        accountSid: "AC123",
        authToken: "secret",
      })).resolves.toEqual(Buffer.from("wav-auth"))
      expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.twilio.com/Recordings/RE123.wav", {
        headers: { Authorization: expect.stringMatching(/^Basic /) },
      })

      await expect(defaultTwilioRecordingDownloader({
        recordingUrl: "https://api.twilio.com/Recordings/missing.wav",
      })).rejects.toThrow("Twilio recording download failed: 404 Not Found")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("uses the listen route for subsequent utterances", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      recordTimeoutSeconds: 4,
      recordMaxLengthSeconds: 12,
    })
    const defaultBridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))

    const response = await bridge.handle({
      method: "POST",
      path: "voice/twilio/listen?next=1",
      headers: {},
      body: "",
    })
    const defaultResponse = await defaultBridge.handle({
      method: "POST",
      path: "/voice/twilio/listen",
      headers: {},
      body: "",
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.body)).toContain("<Record")
    expect(String(response.body)).toContain("timeout=\"4\"")
    expect(String(response.body)).toContain("maxLength=\"12\"")
    expect(String(response.body)).not.toContain("<Say>")
    expect(defaultResponse.statusCode).toBe(200)
    expect(String(defaultResponse.body)).toContain("timeout=\"2\"")
    expect(String(defaultResponse.body)).toContain("maxLength=\"30\"")
  })

  it("drives a full recording callback through STT, voice turn, TTS, Play, and Redirect", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE222",
          From: "+15551234567",
          To: "+15557654321",
        }),
      })

      expect(options.downloadRecording).toHaveBeenCalledWith({
        accountSid: undefined,
        authToken: undefined,
        recordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE222.wav",
      })
      expect(options.transcriber.transcribe).toHaveBeenCalledWith({
        utteranceId: "twilio-CA111-RE222",
        audioPath: path.join(outputDir, "CA111", "RE222.wav"),
      })
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "slugger",
        channel: "voice",
        friendId: "twilio-15551234567",
        sessionKey: "twilio-phone-15551234567-via-15557654321",
        userMessage: "hello over the phone",
      }))
      expect(options.tts.synthesize).toHaveBeenCalledWith({
        utteranceId: "twilio-CA111-RE222",
        text: "agent heard: hello over the phone",
      })
      expect(await fs.readFile(path.join(outputDir, "CA111", "twilio-ca111-re222.mp3"), "utf8")).toBe("mp3-response")
      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Play>https://voice.example.com/voice/twilio/audio/CA111/twilio-ca111-re222.mp3</Play>")
      expect(String(response.body)).toContain("<Redirect method=\"POST\">https://voice.example.com/voice/twilio/listen</Redirect>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("streams a recording callback through a Twilio Play URL as TTS chunks arrive", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    let releaseTts: (() => void) | undefined
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.tts.synthesize = vi.fn(async (request) => {
        request.onAudioChunk?.(Buffer.from("early-"))
        await new Promise<void>((resolve) => {
          releaseTts = resolve
        })
        request.onAudioChunk?.(Buffer.from("late"))
        return {
          utteranceId: request.utteranceId,
          audio: Buffer.from("early-late"),
          byteLength: 10,
          chunkCount: 2,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/mpeg",
        }
      })
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
          To: "+15557654321",
        }),
      })

      expect(response.statusCode).toBe(200)
      const streamUrl = firstPlayUrl(response.body)
      expect(streamUrl).toBe("https://voice.example.com/voice/twilio/audio-stream/CA111/twilio-CA111-RE222.mp3")
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(streamUrl).pathname,
        headers: {},
      })

      expect(streamResponse.statusCode).toBe(200)
      expect(streamResponse.headers["cache-control"]).toBe("no-store")
      const iterator = (streamResponse.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(Buffer.from(first.value).toString("utf8")).toBe("early-")
      releaseTts?.()

      const rest: Buffer[] = []
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        rest.push(Buffer.from(next.value))
      }

      expect(Buffer.concat(rest).toString("utf8")).toBe("late")
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "twilio-phone-15551234567-via-15557654321",
      }))
      expect(await fs.readFile(path.join(outputDir, "CA111", "twilio-ca111-re222.mp3"), "utf8")).toBe("early-late")
    } finally {
      releaseTts?.()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("streams the inbound greeting through a Twilio Play URL", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Record")
      const streamUrl = firstPlayUrl(response.body)
      expect(streamUrl).toBe("https://voice.example.com/voice/twilio/audio-stream/CA123/twilio-CA123-connected.mp3")

      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(streamUrl).pathname,
        headers: {},
      })

      expect(streamResponse.statusCode).toBe(200)
      expect(await collectBridgeBody(streamResponse.body)).toEqual(Buffer.from("mp3-response"))
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("A Twilio phone voice call just connected."),
        sessionKey: "twilio-phone-15551234567-via-15557654321",
      }))
      expect(await fs.readFile(path.join(outputDir, "CA123", "twilio-ca123-connected.mp3"), "utf8")).toBe("mp3-response")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("streams returned TTS audio when the provider does not expose early chunks", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
          To: "+15557654321",
        }),
      })

      expect(response.statusCode).toBe(200)
      const streamUrl = firstPlayUrl(response.body)
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(streamUrl).pathname,
        headers: {},
      })

      expect(streamResponse.statusCode).toBe(200)
      expect(await collectBridgeBody(streamResponse.body)).toEqual(Buffer.from("mp3-response"))
      expect(await fs.readFile(path.join(outputDir, "CA111", "twilio-ca111-re222.mp3"), "utf8")).toBe("mp3-response")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("surfaces streaming turn failures before any audio reaches Twilio", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.downloadRecording = vi.fn(async () => {
        throw new Error("recording unavailable")
      })
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
          To: "+15557654321",
        }),
      })

      expect(response.statusCode).toBe(200)
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })

      await expect(collectBridgeBody(streamResponse.body)).rejects.toThrow("recording unavailable")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("surfaces streaming TTS failures before any audio reaches Twilio", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.tts.synthesize = vi.fn(async () => {
        throw new Error("tts down")
      })
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
          To: "+15557654321",
        }),
      })

      expect(response.statusCode).toBe(200)
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })

      await expect(collectBridgeBody(streamResponse.body)).rejects.toThrow("tts down")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("ends a stream cleanly when TTS fails after audio already started", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.tts.synthesize = vi.fn(async (request) => {
        request.onAudioChunk?.(Buffer.from("partial"))
        throw new Error("late tts down")
      })
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
      })
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })
      const iterator = (streamResponse.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: Buffer.from("partial"),
      })
      await expect(iterator.next()).resolves.toMatchObject({ done: true })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("routes blank STT output through the streaming reprompt path", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.transcriber.transcribe = vi.fn(async (request) => buildVoiceTranscript({
        utteranceId: request.utteranceId,
        text: "[NO_SPEECH]",
        audioPath: request.audioPath,
        source: "whisper.cpp",
      }))
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
        }),
      })
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })

      expect(await collectBridgeBody(streamResponse.body)).toEqual(Buffer.from("mp3-response"))
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("no intelligible speech"),
        sessionKey: "twilio-phone-15551234567",
      }))
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps streamed audio alive when artifact persistence fails afterward", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    let releaseTts: (() => void) | undefined
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.tts.synthesize = vi.fn(async (request) => {
        request.onAudioChunk?.(Buffer.from("voice"))
        await new Promise<void>((resolve) => {
          releaseTts = resolve
        })
        return {
          utteranceId: request.utteranceId,
          audio: Buffer.from("voice"),
          byteLength: 5,
          chunkCount: 1,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/mpeg",
        }
      })
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
      })
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })
      const iterator = (streamResponse.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: Buffer.from("voice"),
      })
      await fs.rm(path.join(outputDir, "CA123"), { recursive: true, force: true })
      await fs.writeFile(path.join(outputDir, "CA123"), "not a directory")
      releaseTts?.()

      await expect(iterator.next()).resolves.toMatchObject({ done: true })
    } finally {
      releaseTts?.()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("routes blank STT output into an agent reprompt instead of speaking the blank token", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      options.transcriber.transcribe = vi.fn(async (request) => buildVoiceTranscript({
        utteranceId: request.utteranceId,
        text: "[BLANK_AUDIO]",
        audioPath: request.audioPath,
        source: "whisper.cpp",
      }))
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
        }),
      })

      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "slugger",
        channel: "voice",
        friendId: "twilio-15551234567",
        sessionKey: "twilio-phone-15551234567",
        userMessage: expect.stringContaining("no intelligible speech"),
      }))
      expect(options.runSenseTurn).not.toHaveBeenCalledWith(expect.objectContaining({
        userMessage: "[BLANK_AUDIO]",
      }))
      expect(options.tts.synthesize).toHaveBeenCalledWith({
        utteranceId: "twilio-CA111-RE222-nospeech",
        text: expect.stringContaining("agent heard: The last Twilio phone recording contained no intelligible speech."),
      })
      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Play>https://voice.example.com/voice/twilio/audio/CA111/twilio-ca111-re222-nospeech.mp3</Play>")
      expect(String(response.body)).toContain("<Redirect method=\"POST\">https://voice.example.com/voice/twilio/listen</Redirect>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("passes Twilio credentials to recording downloads and can pin the voice friend", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const body = formBody({
        CallSid: "CA111",
        RecordingSid: "RE222",
        RecordingUrl: "https://api.twilio.com/Recordings/RE222",
        From: "+15551234567",
      })
      const params = Object.fromEntries(new URLSearchParams(body))
      const signature = computeTwilioSignature({
        authToken: "twilio-token",
        url: "https://voice.example.com/voice/twilio/recording",
        params,
      })
      const options = {
        ...baseBridgeOptions(outputDir),
        defaultFriendId: "ari",
        twilioAccountSid: "AC_test",
        twilioAuthToken: "twilio-token",
      }
      const bridge = createTwilioPhoneBridge(options)

      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: { "x-twilio-signature": signature },
        body,
      })

      expect(response.statusCode).toBe(200)
      expect(options.downloadRecording).toHaveBeenCalledWith({
        accountSid: "AC_test",
        authToken: "twilio-token",
        recordingUrl: "https://api.twilio.com/Recordings/RE222.wav",
      })
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        friendId: "ari",
      }))
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("uses the default Twilio downloader when no downloader hook is supplied", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response(Buffer.from("wav-input")))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        downloadRecording: undefined,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
        }),
      })

      expect(response.statusCode).toBe(200)
      expect(fetchMock).toHaveBeenCalledWith("https://api.twilio.com/Recordings/RE222.wav", {
        headers: {},
      })
    } finally {
      globalThis.fetch = originalFetch
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("sanitizes unsafe Twilio identifiers before writing artifacts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        defaultFriendId: "   ",
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "!!!",
          RecordingSid: "???",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "",
        }),
      })

      expect(response.statusCode).toBe(200)
      expect(options.transcriber.transcribe).toHaveBeenCalledWith({
        utteranceId: "twilio-unknown-unknown",
        audioPath: path.join(outputDir, "unknown", "unknown.wav"),
      })
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        friendId: "twilio-unknown",
        sessionKey: "twilio-phone-unknown",
      }))
      expect(await fs.readFile(path.join(outputDir, "unknown", "twilio-unknown-unknown.mp3"), "utf8")).toBe("mp3-response")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("falls back to TwiML Say and keeps listening when TTS fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      options.tts.synthesize = vi.fn(async () => {
        throw new Error("tts down")
      })
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
        }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Say>voice output failed after the text response was captured.</Say>")
      expect(String(response.body)).toContain("<Redirect method=\"POST\">https://voice.example.com/voice/twilio/listen</Redirect>")
      expect(String(response.body)).not.toContain("<Play>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it.each([
    ["CallSid", { RecordingSid: "RE222", RecordingUrl: "https://api.twilio.com/Recordings/RE222" }],
    ["RecordingSid", { CallSid: "CA111", RecordingUrl: "https://api.twilio.com/Recordings/RE222" }],
    ["RecordingUrl", { CallSid: "CA111", RecordingSid: "RE222" }],
  ])("keeps listening when Twilio omits %s from a recording callback", async (_fieldName, values) => {
    const bridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/recording",
      headers: {},
      body: formBody({ ...values, From: "+15551234567" }),
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.body)).toContain("<Say>I did not receive audio. Please try again.</Say>")
    expect(String(response.body)).toContain("<Record")
  })

  it("keeps the call alive when a phone turn fails before TTS fallback", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      options.downloadRecording = vi.fn(async () => {
        throw new Error("recording unavailable")
      })
      const bridge = createTwilioPhoneBridge(options)

      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
        }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Say>I could not process that audio. Please try again.</Say>")
      expect(String(response.body)).toContain("<Redirect method=\"POST\">https://voice.example.com/voice/twilio/listen</Redirect>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps the call alive when a phone turn throws a non-Error value", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = baseBridgeOptions(outputDir)
      options.downloadRecording = vi.fn(async () => {
        throw "recording unavailable"
      })
      const bridge = createTwilioPhoneBridge(options)

      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/recording",
        headers: {},
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
        }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Say>I could not process that audio. Please try again.</Say>")
      expect(String(response.body)).toContain("<Redirect method=\"POST\">https://voice.example.com/voice/twilio/listen</Redirect>")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("serves only generated call audio artifacts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await fs.mkdir(path.join(outputDir, "CA111"), { recursive: true })
      await fs.writeFile(path.join(outputDir, "CA111", "reply.mp3"), "mp3-response")
      await fs.writeFile(path.join(outputDir, "CA111", "reply.wav"), "wav-response")
      await fs.writeFile(path.join(outputDir, "CA111", "reply.pcm"), "pcm-response")
      await fs.writeFile(path.join(outputDir, "CA111", "reply.audio"), "audio-response")
      const bridge = createTwilioPhoneBridge(baseBridgeOptions(outputDir))

      const ok = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/reply.mp3",
        headers: {},
      })
      const wav = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/reply.wav",
        headers: {},
      })
      const pcm = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/reply.pcm",
        headers: {},
      })
      const unknown = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/reply.audio",
        headers: {},
      })
      const traversal = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/%2e%2e%2Fsecret.mp3",
        headers: {},
      })
      const short = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111",
        headers: {},
      })
      const malformedEncoding = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/%E0%A4%A",
        headers: {},
      })
      const dotSegment = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/./reply.mp3",
        headers: {},
      })
      const missing = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/missing.mp3",
        headers: {},
      })
      const shortStream = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio-stream/CA111",
        headers: {},
      })
      const invalidStreamSegment = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio-stream/%2e/reply.mp3",
        headers: {},
      })
      const missingStreamJob = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio-stream/CA111/missing.mp3",
        headers: {},
      })

      expect(ok.statusCode).toBe(200)
      expect(ok.headers["content-type"]).toBe("audio/mpeg")
      expect(Buffer.from(ok.body as Uint8Array).toString("utf8")).toBe("mp3-response")
      expect(wav.headers["content-type"]).toBe("audio/wav")
      expect(pcm.headers["content-type"]).toBe("audio/pcm")
      expect(unknown.headers["content-type"]).toBe("application/octet-stream")
      expect(traversal.statusCode).toBe(404)
      expect(short.statusCode).toBe(404)
      expect(malformedEncoding.statusCode).toBe(404)
      expect(dotSegment.statusCode).toBe(404)
      expect(missing.statusCode).toBe(404)
      expect(shortStream.statusCode).toBe(404)
      expect(invalidStreamSegment.statusCode).toBe(404)
      expect(missingStreamJob.statusCode).toBe(404)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("rejects non-POST Twilio routes that are not health or audio", async () => {
    const bridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))

    const response = await bridge.handle({
      method: "GET",
      path: "/voice/twilio/incoming",
      headers: {},
    })

    expect(response).toMatchObject({
      statusCode: 405,
      body: "method not allowed",
    })
  })

  it("normalizes Twilio recording media URLs without double-appending extensions", () => {
    expect(twilioRecordingMediaUrl("https://api.twilio.com/Recordings/RE123")).toBe("https://api.twilio.com/Recordings/RE123.wav")
    expect(twilioRecordingMediaUrl("https://api.twilio.com/Recordings/RE123.mp3")).toBe("https://api.twilio.com/Recordings/RE123.mp3")
    expect(twilioRecordingMediaUrl("https://api.twilio.com/Recordings/RE123?Download=true")).toBe("https://api.twilio.com/Recordings/RE123.wav?Download=true")
  })

  it("starts a local HTTP server for Twilio webhooks", async () => {
    const server = await startTwilioPhoneBridgeServer({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      port: 0,
      host: "127.0.0.1",
    })
    try {
      const response = await fetch(`${server.localUrl}/voice/twilio/health`)

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => error ? reject(error) : resolve())
      })
    }
  })

  it("serves streaming audio Play URLs through the local HTTP server", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const server = await startTwilioPhoneBridgeServer({
      ...baseBridgeOptions(outputDir),
      playbackMode: "stream",
      port: 0,
      host: "127.0.0.1",
    })
    try {
      const twimlResponse = await fetch(`${server.localUrl}/voice/twilio/recording`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          CallSid: "CA111",
          RecordingSid: "RE222",
          RecordingUrl: "https://api.twilio.com/Recordings/RE222",
          From: "+15551234567",
          To: "+15557654321",
        }),
      })

      expect(twimlResponse.status).toBe(200)
      const streamUrl = firstPlayUrl(await twimlResponse.text())
      const audioResponse = await fetch(`${server.localUrl}${new URL(streamUrl).pathname}`)

      expect(audioResponse.status).toBe(200)
      expect(audioResponse.headers.get("content-type")).toBe("audio/mpeg")
      expect(await audioResponse.text()).toBe("mp3-response")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => error ? reject(error) : resolve())
      })
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("uses default host and port for the local HTTP server when omitted", async () => {
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    try {
      try {
        server = await startTwilioPhoneBridgeServer(baseBridgeOptions("/tmp/ouro-twilio-phone"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return
        throw error
      }
      expect(server.localUrl).toBe("http://127.0.0.1:18910")

      const response = await fetch(`${server.localUrl}/voice/twilio/health`)

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("ok")
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.server.close((error) => error ? reject(error) : resolve())
        })
      }
    }
  })

  it("rejects when the local HTTP server cannot bind", async () => {
    await expect(startTwilioPhoneBridgeServer({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      port: 0,
      host: "256.256.256.256",
    })).rejects.toThrow()
  })

  it("surfaces server request failures without crashing the listener", async () => {
    const server = await startTwilioPhoneBridgeServer({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      port: 0,
      host: "127.0.0.1",
    })
    try {
      const response = await fetch(`${server.localUrl}/voice/twilio/incoming`, {
        method: "POST",
        body: Buffer.alloc(1_000_001, "x"),
      }).catch((error: unknown) => error)

      if (response instanceof Response) {
        expect(response.status).toBe(500)
        expect(await response.text()).toBe("internal server error")
      } else {
        expect(response).toBeInstanceOf(Error)
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => error ? reject(error) : resolve())
      })
    }
  })
})
