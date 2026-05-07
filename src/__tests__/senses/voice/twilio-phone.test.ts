import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript } from "../../../senses/voice"
import {
  computeTwilioSignature,
  createTwilioPhoneBridge,
  startTwilioPhoneBridgeServer,
  twilioRecordingMediaUrl,
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
  }
}

describe("Twilio phone voice bridge", () => {
  it("answers inbound calls with a configurable Record action URL", async () => {
    const bridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))
    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: {},
      body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toBe("text/xml; charset=utf-8")
    expect(String(response.body)).toContain("<Response>")
    expect(String(response.body)).toContain("action=\"https://voice.example.com/voice/twilio/recording\"")
    expect(String(response.body)).toContain("method=\"POST\"")
    expect(String(response.body)).toContain("maxLength=\"30\"")
    expect(String(response.body)).not.toContain("localhost")
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
      expect(options.runSenseTurn).toHaveBeenCalledWith({
        agentName: "slugger",
        channel: "voice",
        friendId: "twilio-15551234567",
        sessionKey: "twilio-CA111",
        userMessage: "hello over the phone",
      })
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

  it("keeps listening when Twilio sends an incomplete recording callback", async () => {
    const bridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/recording",
      headers: {},
      body: formBody({ CallSid: "CA111", From: "+15551234567" }),
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

  it("serves only generated call audio artifacts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await fs.mkdir(path.join(outputDir, "CA111"), { recursive: true })
      await fs.writeFile(path.join(outputDir, "CA111", "reply.mp3"), "mp3-response")
      const bridge = createTwilioPhoneBridge(baseBridgeOptions(outputDir))

      const ok = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/reply.mp3",
        headers: {},
      })
      const traversal = await bridge.handle({
        method: "GET",
        path: "/voice/twilio/audio/CA111/%2e%2e%2Fsecret.mp3",
        headers: {},
      })

      expect(ok.statusCode).toBe(200)
      expect(ok.headers["content-type"]).toBe("audio/mpeg")
      expect(Buffer.from(ok.body as Uint8Array).toString("utf8")).toBe("mp3-response")
      expect(traversal.statusCode).toBe(404)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
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
