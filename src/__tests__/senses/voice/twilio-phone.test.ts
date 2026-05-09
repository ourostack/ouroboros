import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as crypto from "node:crypto"
import { WebSocket, WebSocketServer } from "ws"
import { describe, expect, it, vi } from "vitest"
import { buildVoiceTranscript, closeTwilioPhoneBridgeServer } from "../../../senses/voice"
import { loadSession } from "../../../mind/context"
import {
  computeOpenAIWebhookSignature,
  computeTwilioSignature,
  createTwilioOutboundCall,
  createTwilioPhoneBridge,
  defaultTwilioRecordingDownloader,
  normalizeTwilioE164PhoneNumber,
  normalizeTwilioPhoneBasePath,
  normalizeTwilioPhoneConversationEngine,
  normalizeTwilioPhonePlaybackMode,
  normalizeTwilioPhoneTransportMode,
  openAISipWebhookPath,
  openAISipWebhookUrl,
  outboundCallAnsweredPrompt,
  readRecentTwilioOutboundCallJobs,
  twilioOutboundCallAmdCallbackUrl,
  twilioOutboundCallJobPath,
  twilioOutboundCallStatusCallbackUrl,
  twilioOutboundCallWebhookUrl,
  startTwilioPhoneBridgeServer,
  twilioPhoneWebhookUrl,
  twilioPhoneVoiceSessionKey,
  twilioRecordingMediaUrl,
  updateTwilioOutboundCallJob,
  validateTwilioSignature,
  writeTwilioOutboundCallJob,
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

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
}

function waitForSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      try {
        resolve(JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.once("error", reject)
  })
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    socket.once("close", () => resolve())
    socket.once("error", reject)
  })
}

function collectSocketMessages(socket: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = []
  socket.on("message", (raw) => {
    messages.push(JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>)
  })
  return messages
}

function sendSocketJson(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value))
}

function sendMediaFrame(socket: WebSocket, byte: number): void {
  sendSocketJson(socket, {
    event: "media",
    streamSid: "MZ123",
    media: { payload: Buffer.alloc(160, byte).toString("base64") },
  })
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", resolve)
    socket.close()
  })
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function startOpenAISipMock(expectedCallId: string) {
  const openaiMessages: Record<string, unknown>[] = []
  const openaiSockets: WebSocket[] = []
  const openaiRequests: Array<{ input: string; body: string; auth: string | null }> = []
  const openaiServer = new WebSocketServer({ port: 0 })
  const address = openaiServer.address()
  if (!address || typeof address === "string") throw new Error("OpenAI test server did not bind to a TCP port")
  openaiServer.on("connection", (ws, request) => {
    openaiSockets.push(ws as WebSocket)
    expect(request.url).toContain(`call_id=${expectedCallId}`)
    expect(request.headers.authorization).toBe("Bearer openai-secret")
    ws.on("message", (raw) => {
      openaiMessages.push(JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>)
    })
  })
  const openaiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)
    openaiRequests.push({
      input: String(input),
      body: String(init?.body ?? ""),
      auth: headers.get("authorization"),
    })
    return new Response("", { status: 200 })
  })
  return {
    websocketBaseUrl: `ws://127.0.0.1:${address.port}/v1/realtime`,
    openaiMessages,
    openaiSockets,
    openaiRequests,
    openaiFetch,
    async close() {
      for (const socket of openaiSockets) {
        if (socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      }
      await closeWebSocketServer(openaiServer)
    },
  }
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
    expect(normalizeTwilioPhoneTransportMode(undefined)).toBe("record-play")
    expect(normalizeTwilioPhoneTransportMode("MEDIA-STREAM")).toBe("media-stream")
    expect(() => normalizeTwilioPhoneTransportMode("recordish")).toThrow("invalid Twilio phone transport mode")
    expect(normalizeTwilioPhoneConversationEngine(undefined)).toBe("cascade")
    expect(normalizeTwilioPhoneConversationEngine("OPENAI-REALTIME")).toBe("openai-realtime")
    expect(normalizeTwilioPhoneConversationEngine("OPENAI-SIP")).toBe("openai-sip")
    expect(() => normalizeTwilioPhoneConversationEngine("homemade")).toThrow("invalid Twilio phone conversation engine")
    expect(openAISipWebhookPath("Slugger")).toBe("/voice/agents/slugger/sip/openai")
    expect(openAISipWebhookUrl("https://voice.example.com/base/", "/voice/agents/slugger/sip/openai"))
      .toBe("https://voice.example.com/voice/agents/slugger/sip/openai")
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

  it("computes OpenAI webhook signatures using the Standard Webhooks payload shape", () => {
    const secret = `whsec_${Buffer.from("openai-webhook-secret").toString("base64")}`
    const payload = JSON.stringify({ type: "realtime.call.incoming" })
    expect(computeOpenAIWebhookSignature({
      secret,
      webhookId: "evt_123",
      timestamp: "1760000000",
      payload,
    })).toBe(
      crypto.createHmac("sha256", Buffer.from("openai-webhook-secret"))
        .update(`evt_123.1760000000.${payload}`)
        .digest("base64"),
    )
  })

  it("normalizes outbound phone routing and webhook URLs", () => {
    expect(normalizeTwilioE164PhoneNumber("+1 (555) 123-4567")).toBe("+15551234567")
    expect(normalizeTwilioE164PhoneNumber("555-123-4567")).toBe("+15551234567")
    expect(normalizeTwilioE164PhoneNumber("group:any;+;abc")).toBeUndefined()
    expect(twilioOutboundCallWebhookUrl("https://voice.example.com/base/", "/voice/twilio", "call one"))
      .toBe("https://voice.example.com/voice/twilio/outgoing/call-one")
    expect(twilioOutboundCallStatusCallbackUrl("https://voice.example.com/base/", "/voice/twilio", "call one"))
      .toBe("https://voice.example.com/voice/twilio/outgoing/call-one/status")
    expect(twilioOutboundCallAmdCallbackUrl("https://voice.example.com/base/", "/voice/twilio", "call one"))
      .toBe("https://voice.example.com/voice/twilio/outgoing/call-one/amd")
  })

  it("renders outbound answer prompts with Twilio params or job fallbacks", () => {
    const job = {
      schemaVersion: 1 as const,
      outboundId: "out-1",
      agentName: "slugger",
      to: "",
      from: "",
      reason: "   ",
      createdAt: "2026-05-08T12:00:00.000Z",
    }

    const fallbackPrompt = outboundCallAnsweredPrompt(job, {})
    expect(fallbackPrompt).toContain("No additional reason was recorded.")
    expect(fallbackPrompt).toContain("Twilio did not provide the callee phone.")
    expect(fallbackPrompt).toContain("Twilio did not provide the Ouro phone line.")

    const paramsPrompt = outboundCallAnsweredPrompt({
      ...job,
      to: "+15551234567",
      from: "+15557654321",
      reason: "quick weather check",
    }, {
      To: "+15550001111",
      From: "+15550002222",
    })
    expect(paramsPrompt).toContain("Call reason/context: quick weather check")
    expect(paramsPrompt).toContain("Callee phone: +15550001111.")
    expect(paramsPrompt).toContain("Ouro phone line: +15550002222.")
  })

  it("creates Twilio outbound call API requests with TwiML and status callbacks", async () => {
    const requests: Array<{ input: string; body: URLSearchParams; auth: string | null }> = []
    const result = await createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
      statusCallbackUrl: "https://voice.example.com/voice/twilio/outgoing/out-1/status",
    }, async (input, init) => {
      requests.push({
        input,
        body: new URLSearchParams(String(init.body)),
        auth: init.headers instanceof Headers ? init.headers.get("authorization") : (init.headers as Record<string, string>).authorization,
      })
      return new Response(JSON.stringify({ sid: "CAOUT", status: "queued", queue_time: "0" }), { status: 201 })
    })

    expect(result).toEqual({ callSid: "CAOUT", status: "queued", queueTime: "0" })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.input).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json")
    expect(requests[0]!.body.get("To")).toBe("+15551234567")
    expect(requests[0]!.body.get("From")).toBe("+15557654321")
    expect(requests[0]!.body.get("Url")).toBe("https://voice.example.com/voice/twilio/outgoing/out-1")
    expect(requests[0]!.body.get("Method")).toBe("POST")
    expect(requests[0]!.body.get("StatusCallback")).toBe("https://voice.example.com/voice/twilio/outgoing/out-1/status")
    expect(requests[0]!.body.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"])
    expect(requests[0]!.body.get("MachineDetection")).toBeNull()
    expect(requests[0]!.body.get("AsyncAmd")).toBeNull()
    expect(requests[0]!.auth).toBe(`Basic ${Buffer.from("AC123:token-secret").toString("base64")}`)
  })

  it("can request asynchronous Twilio answering machine detection for outbound calls", async () => {
    const requests: Array<{ body: URLSearchParams }> = []
    await createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
      machineDetection: "Enable",
      asyncAmd: true,
      asyncAmdStatusCallbackUrl: "https://voice.example.com/voice/twilio/outgoing/out-1/amd",
    }, async (_input, init) => {
      requests.push({ body: new URLSearchParams(String(init.body)) })
      return new Response(JSON.stringify({ sid: "CAOUT", status: "queued" }), { status: 201 })
    })

    expect(requests[0]!.body.get("MachineDetection")).toBe("Enable")
    expect(requests[0]!.body.get("AsyncAmd")).toBe("true")
    expect(requests[0]!.body.get("AsyncAmdStatusCallback")).toBe("https://voice.example.com/voice/twilio/outgoing/out-1/amd")
    expect(requests[0]!.body.get("AsyncAmdStatusCallbackMethod")).toBe("POST")
  })

  it("fails outbound Twilio API requests with actionable validation and provider errors", async () => {
    await expect(createTwilioOutboundCall({
      accountSid: "",
      authToken: "token-secret",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    })).rejects.toThrow("missing Twilio account SID")

    await expect(createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    })).rejects.toThrow("missing Twilio auth token")

    await expect(createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "not a phone",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    })).rejects.toThrow("target must be an E.164 phone number")

    await expect(createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "+15551234567",
      from: "not a phone",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    })).rejects.toThrow("caller ID must be an E.164 phone number")

    await expect(createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    }, async () => new Response("twilio says no", { status: 400 }))).rejects.toThrow("Twilio outbound voice call failed: 400 twilio says no")

    await expect(createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    }, async () => new Response(JSON.stringify({ message: "number blocked" }), { status: 403 }))).rejects.toThrow("Twilio outbound voice call failed: 403 number blocked")

    await expect(createTwilioOutboundCall({
      accountSid: "AC123",
      authToken: "token-secret",
      to: "+15551234567",
      from: "+15557654321",
      twimlUrl: "https://voice.example.com/voice/twilio/outgoing/out-1",
    }, async () => new Response("", { status: 201 }))).resolves.toEqual({
      callSid: undefined,
      status: undefined,
      queueTime: undefined,
    })
  })

  it("updates and lists outbound call jobs while ignoring stale or malformed files", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-jobs-"))
    try {
      await expect(updateTwilioOutboundCallJob(outputDir, "missing", {
        status: "completed",
      })).resolves.toBeNull()

      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "recent",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "recent",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "queued",
      })
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "old",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "old",
        createdAt: "2026-05-08T10:00:00.000Z",
        status: "queued",
      })
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "other-friend",
        agentName: "slugger",
        friendId: "bea",
        to: "+15551234567",
        from: "+15557654321",
        reason: "other friend",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "queued",
      })
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "other-number",
        agentName: "slugger",
        friendId: "ari",
        to: "+15550000000",
        from: "+15557654321",
        reason: "other number",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "queued",
      })
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "invalid-date",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "bad date",
        createdAt: "not a date",
        status: "queued",
      })
      await fs.writeFile(path.join(outputDir, "outbound", "malformed.json"), "{", "utf8")
      await fs.writeFile(path.join(outputDir, "outbound", "wrong-schema.json"), JSON.stringify({
        schemaVersion: 2,
        outboundId: "wrong-schema",
      }), "utf8")
      await fs.writeFile(path.join(outputDir, "outbound", "ignored.txt"), "{}", "utf8")

      await expect(updateTwilioOutboundCallJob(outputDir, "recent", {
        status: "completed",
        updatedAt: "2026-05-08T12:00:10.000Z",
      })).resolves.toMatchObject({
        outboundId: "recent",
        status: "completed",
        updatedAt: "2026-05-08T12:00:10.000Z",
      })

      const recent = await readRecentTwilioOutboundCallJobs({
        outputDir,
        to: "+1 (555) 123-4567",
        friendId: "ari",
        sinceMs: 60_000,
        now: Date.parse("2026-05-08T12:00:30.000Z"),
      })

      expect(recent.map((job) => job.outboundId)).toEqual(["recent"])
      await expect(readRecentTwilioOutboundCallJobs({
        outputDir,
        sinceMs: Number.POSITIVE_INFINITY,
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ outboundId: "recent" }),
      ]))
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
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

  it("can answer inbound calls with a bidirectional Twilio Media Stream", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      transportMode: "media-stream",
    })

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: {},
      body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.body)).toContain("<Connect><Stream url=\"wss://voice.example.com/voice/twilio/media-stream\">")
    expect(String(response.body)).toContain("<Parameter name=\"From\" value=\"+15551234567\" />")
    expect(String(response.body)).toContain("<Parameter name=\"To\" value=\"+15557654321\" />")
    expect(String(response.body)).toContain("<Parameter name=\"Agent\" value=\"slugger\" />")
    expect(String(response.body)).toContain("<Parameter name=\"GreetingJobId\" value=\"twilio-CA123-connected\" />")
    expect(String(response.body)).not.toContain("<Record")
    expect(String(response.body)).not.toContain("<Play>")
  })

  it("can answer inbound calls by dialing OpenAI SIP", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      conversationEngine: "openai-sip",
      openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
      openaiSip: { projectId: "proj_test", allowUnsignedWebhooks: true },
    })

    const response = await bridge.handle({
      method: "POST",
      path: "/voice/twilio/incoming",
      headers: {},
      body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
    })

    expect(response.statusCode).toBe(200)
    expect(String(response.body)).toContain("<Dial answerOnBridge=\"true\"><Sip>")
    expect(String(response.body)).toContain("sip:proj_test@sip.api.openai.com;transport=tls?")
    expect(String(response.body)).toContain("X-Ouro-Agent=slugger")
    expect(String(response.body)).toContain("X-Ouro-Direction=inbound")
    expect(String(response.body)).toContain("X-Ouro-From=%2B15551234567")
    expect(String(response.body)).toContain("X-Ouro-To=%2B15557654321")
    expect(String(response.body)).not.toContain("<Connect><Stream")
    expect(String(response.body)).not.toContain("<Record")
  })

  it("fails OpenAI SIP webhooks closed on unsigned, invalid, or incomplete payloads", async () => {
    const bridgeWithoutSigningConfig = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      conversationEngine: "openai-sip",
      openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
      openaiSip: { projectId: "proj_test" },
    })

    const unsigned = await bridgeWithoutSigningConfig.handle({
      method: "POST",
      path: "/voice/agents/slugger/sip/openai",
      headers: {},
      body: JSON.stringify({ type: "realtime.call.incoming" }),
    })
    expect(unsigned).toMatchObject({
      statusCode: 401,
      body: "OpenAI SIP webhook signing secret is not configured",
    })

    const webhookSecret = `whsec_${Buffer.from("sip-webhook-secret").toString("base64")}`
    const bridgeWithSecret = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      conversationEngine: "openai-sip",
      openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
      openaiSip: { projectId: "proj_test", webhookSecret },
    })
    const invalidSignature = await bridgeWithSecret.handle({
      method: "POST",
      path: "/voice/agents/slugger/sip/openai",
      headers: {
        "webhook-id": "evt_bad",
        "webhook-timestamp": String(Math.floor(Date.now() / 1_000)),
        "webhook-signature": "v1,bad",
      },
      body: JSON.stringify({ type: "realtime.call.incoming" }),
    })
    expect(invalidSignature).toMatchObject({
      statusCode: 400,
      body: "invalid OpenAI webhook signature",
    })

    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      conversationEngine: "openai-sip",
      openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
      openaiSip: { projectId: "proj_test", allowUnsignedWebhooks: true },
    })
    await expect(bridge.handle({
      method: "POST",
      path: "/voice/agents/slugger/sip/openai",
      headers: {},
      body: "{",
    })).resolves.toMatchObject({
      statusCode: 400,
      body: "invalid OpenAI webhook payload",
    })
    await expect(bridge.handle({
      method: "POST",
      path: "/voice/agents/slugger/sip/openai",
      headers: {},
      body: JSON.stringify({ type: "realtime.call.ended" }),
    })).resolves.toMatchObject({
      statusCode: 200,
      body: "ok",
    })
    await expect(bridge.handle({
      method: "POST",
      path: "/voice/agents/slugger/sip/openai",
      headers: {},
      body: JSON.stringify({ type: "realtime.call.incoming", data: { sip_headers: [] } }),
    })).resolves.toMatchObject({
      statusCode: 400,
      body: "missing OpenAI SIP call metadata",
    })
  })

  it("accepts OpenAI SIP webhooks and controls the realtime call", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-openai-sip-"))
    const agentRoot = path.join(outputDir, "slugger.ouro")
    const openaiMessages: Record<string, unknown>[] = []
    const openaiSockets: WebSocket[] = []
    const openaiRequests: Array<{ input: string; body: string; auth: string | null }> = []
    const openaiServer = new WebSocketServer({ port: 0 })
    const address = openaiServer.address()
    if (!address || typeof address === "string") throw new Error("OpenAI test server did not bind to a TCP port")
    const openaiUrl = `ws://127.0.0.1:${address.port}/v1/realtime`
    const webhookSecret = `whsec_${Buffer.from("sip-webhook-secret").toString("base64")}`
    try {
      openaiServer.on("connection", (ws, request) => {
        openaiSockets.push(ws as WebSocket)
        expect(request.url).toContain("call_id=call_123")
        expect(request.headers.authorization).toBe("Bearer openai-secret")
        ws.on("message", (raw) => {
          openaiMessages.push(JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>)
        })
      })

      const bridge = createTwilioPhoneBridge({
        ...baseBridgeOptions(outputDir),
        agentRoot,
        conversationEngine: "openai-sip",
        openaiRealtime: {
          apiKey: "openai-secret",
          model: "gpt-realtime-2",
          voice: "cedar",
          voiceStyle: "scrappy, upbeat, warm, lightly British",
          voiceSpeed: 1.08,
        },
        openaiSip: {
          projectId: "proj_test",
          webhookPath: "/voice/agents/slugger/sip/openai",
          webhookSecret,
          apiBaseUrl: "https://api.openai.test/v1",
          websocketBaseUrl: openaiUrl,
          fetch: vi.fn(async (input, init) => {
            const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers)
            openaiRequests.push({
              input,
              body: String(init.body ?? ""),
              auth: headers.get("authorization"),
            })
            return new Response("", { status: 200 })
          }),
        },
      })
      const payload = JSON.stringify({
        type: "realtime.call.incoming",
        data: {
          call_id: "call_123",
          sip_headers: [
            { name: "X-Ouro-From", value: "+15551234567" },
            { name: "X-Ouro-To", value: "+15557654321" },
            { name: "X-Ouro-Friend-Id", value: "ari" },
          ],
        },
      })
      const timestamp = String(Math.floor(Date.now() / 1_000))
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/agents/slugger/sip/openai",
        headers: {
          "webhook-id": "evt_123",
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${computeOpenAIWebhookSignature({
            secret: webhookSecret,
            webhookId: "evt_123",
            timestamp,
            payload,
          })}`,
        },
        body: payload,
      })

      expect(response.statusCode).toBe(200)
      await vi.waitFor(() => expect(openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_123/accept"))).toBe(true), { timeout: 10_000 })
      const accept = openaiRequests.find((request) => request.input.endsWith("/realtime/calls/call_123/accept"))!
      expect(accept.auth).toBe("Bearer openai-secret")
      const acceptBody = JSON.parse(accept.body) as {
        type?: string
        model?: string
        instructions?: string
        audio?: { output?: { voice?: string; speed?: number } }
        tools?: Array<{ name: string }>
      }
      expect(acceptBody).toMatchObject({
        type: "realtime",
        model: "gpt-realtime-2",
        audio: { output: { voice: "cedar", speed: 1.08 } },
      })
      expect(acceptBody.instructions).toContain("Phone voice target: scrappy, upbeat, warm, lightly British")
      expect(acceptBody.instructions).toContain("source=tone")
      expect(acceptBody.tools?.some((tool) => tool.name === "voice_end_call")).toBe(true)
      expect(acceptBody.tools?.some((tool) => tool.name === "voice_play_audio")).toBe(true)

      await vi.waitFor(() => expect(openaiMessages.some((event) => event.type === "response.create")).toBe(true), { timeout: 10_000 })
      const greeting = openaiMessages.find((event) => event.type === "response.create") as { response?: { instructions?: string } }
      expect(greeting.response?.instructions).toContain("A phone voice call just connected over OpenAI SIP.")
      expect(greeting.response?.instructions).toContain("Phone voice target for this first turn: scrappy, upbeat, warm, lightly British")

      openaiSockets[0]?.send(JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello there",
      }))
      openaiSockets[0]?.send(JSON.stringify({
        type: "response.output_audio_transcript.done",
        transcript: "Hi, Ari.",
      }))
      await vi.waitFor(async () => {
        await fs.access(path.join(agentRoot, "state", "sessions", "ari", "voice", "twilio-phone-ari-via-15557654321.json"))
        const saved = loadSession(path.join(agentRoot, "state", "sessions", "ari", "voice", "twilio-phone-ari-via-15557654321.json"))
        expect(saved?.messages.some((message) => message.role === "user" && message.content === "hello there")).toBe(true)
        expect(saved?.messages.some((message) => message.role === "assistant" && message.content === "Hi, Ari.")).toBe(true)
      })

      openaiSockets[0]?.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp-audio",
        call_id: "tool-audio",
        name: "voice_play_audio",
        arguments: JSON.stringify({ source: "tone", label: "latency beep", toneHz: 880, durationMs: 500 }),
      }))
      openaiSockets[0]?.send(JSON.stringify({ type: "response.done", response: { id: "resp-audio" } }))
      await vi.waitFor(() => expect(openaiMessages.some((event) => {
        if (event.type !== "conversation.item.create") return false
        const item = event.item as { type?: string; call_id?: string; output?: string } | undefined
        return item?.type === "function_call_output"
          && item.call_id === "tool-audio"
          && item.output?.includes("Render the requested audio cue now")
      })).toBe(true), { timeout: 10_000 })
      expect(openaiMessages.some((event) => event.type === "response.create")).toBe(true)

      openaiSockets[0]?.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp-end",
        call_id: "tool-end",
        name: "voice_end_call",
        arguments: JSON.stringify({ reason: "caller said goodbye" }),
      }))
      openaiSockets[0]?.send(JSON.stringify({ type: "response.done", response: { id: "resp-end" } }))
      await vi.waitFor(() => expect(openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_123/hangup"))).toBe(true), { timeout: 10_000 })
      expect(openaiMessages.some((event) => {
        if (event.type !== "conversation.item.create") return false
        const item = event.item as { type?: string; call_id?: string; output?: string } | undefined
        return item?.type === "function_call_output" && item.call_id === "tool-end" && item.output?.includes("voice call ending")
      })).toBe(true)
    } finally {
      for (const openaiSocket of openaiSockets) {
        if (openaiSocket.readyState === WebSocket.OPEN) await closeSocket(openaiSocket)
      }
      await closeWebSocketServer(openaiServer)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  }, 20_000)

  it("holds outbound SIP greetings until async AMD confirms a human answer", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-openai-sip-amd-human-"))
    const openai = startOpenAISipMock("call_human")
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-sip-human",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "quick voice check",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const bridge = createTwilioPhoneBridge({
        ...baseBridgeOptions(outputDir),
        conversationEngine: "openai-sip",
        openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
        openaiSip: {
          projectId: "proj_test",
          webhookPath: "/voice/agents/slugger/sip/openai",
          allowUnsignedWebhooks: true,
          apiBaseUrl: "https://api.openai.test/v1",
          websocketBaseUrl: openai.websocketBaseUrl,
          fetch: openai.openaiFetch,
        },
      })
      const outgoing = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-sip-human",
        headers: {},
        body: formBody({ CallSid: "CATWILIOHUMAN", From: "+15557654321", To: "+15551234567" }),
      })
      expect(String(outgoing.body)).toContain("<Dial answerOnBridge=\"true\"><Sip>")

      const sipResponse = await bridge.handle({
        method: "POST",
        path: "/voice/agents/slugger/sip/openai",
        headers: {},
        body: JSON.stringify({
          type: "realtime.call.incoming",
          data: {
            call_id: "call_human",
            sip_headers: [
              { name: "X-Ouro-Direction", value: "outbound" },
              { name: "X-Ouro-From", value: "+15551234567" },
              { name: "X-Ouro-To", value: "+15557654321" },
              { name: "X-Ouro-Friend-Id", value: "ari" },
              { name: "X-Ouro-Outbound-Id", value: "out-sip-human" },
              { name: "X-Ouro-Reason", value: "quick voice check" },
            ],
          },
        }),
      })
      expect(sipResponse.statusCode).toBe(200)
      await vi.waitFor(() => expect(openai.openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_human/accept"))).toBe(true), { timeout: 10_000 })
      const accept = openai.openaiRequests.find((request) => request.input.endsWith("/realtime/calls/call_human/accept"))!
      const acceptBody = JSON.parse(accept.body) as { audio?: { input?: { turn_detection?: { create_response?: boolean } } } }
      expect(acceptBody.audio?.input?.turn_detection?.create_response).toBe(false)
      await vi.waitFor(() => expect(openai.openaiSockets.length).toBe(1), { timeout: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(openai.openaiMessages.some((event) => event.type === "response.create")).toBe(false)

      const amd = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-sip-human/amd",
        headers: {},
        body: formBody({ CallSid: "CATWILIOHUMAN", AnsweredBy: "human" }),
      })
      expect(amd.statusCode).toBe(200)
      await vi.waitFor(() => expect(openai.openaiMessages.some((event) => event.type === "response.create")).toBe(true), { timeout: 10_000 })
      const turnDetectionUpdateIndex = openai.openaiMessages.findIndex((event) => {
        if (event.type !== "session.update") return false
        const session = event.session as { audio?: { input?: { turn_detection?: { create_response?: boolean } } } } | undefined
        return session?.audio?.input?.turn_detection?.create_response === true
      })
      const greetingIndex = openai.openaiMessages.findIndex((event) => event.type === "response.create")
      expect(turnDetectionUpdateIndex).toBeGreaterThanOrEqual(0)
      expect(turnDetectionUpdateIndex).toBeLessThan(greetingIndex)
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-sip-human"), "utf8")) as { status?: string; answeredBy?: string }
      expect(saved.status).toBe("answered")
      expect(saved.answeredBy).toBe("human")
    } finally {
      await openai.close()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  }, 20_000)

  it("releases outbound SIP greetings on AMD unknown when Realtime heard a short human greeting", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-openai-sip-amd-unknown-human-"))
    const openai = startOpenAISipMock("call_unknown_human")
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-sip-unknown-human",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "quick voice check",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const bridge = createTwilioPhoneBridge({
        ...baseBridgeOptions(outputDir),
        conversationEngine: "openai-sip",
        openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
        openaiSip: {
          projectId: "proj_test",
          webhookPath: "/voice/agents/slugger/sip/openai",
          allowUnsignedWebhooks: true,
          apiBaseUrl: "https://api.openai.test/v1",
          websocketBaseUrl: openai.websocketBaseUrl,
          fetch: openai.openaiFetch,
        },
      })
      await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-sip-unknown-human",
        headers: {},
        body: formBody({ CallSid: "CATWILIOUNKNOWN", From: "+15557654321", To: "+15551234567" }),
      })
      const sipResponse = await bridge.handle({
        method: "POST",
        path: "/voice/agents/slugger/sip/openai",
        headers: {},
        body: JSON.stringify({
          type: "realtime.call.incoming",
          data: {
            call_id: "call_unknown_human",
            sip_headers: [
              { name: "X-Ouro-Direction", value: "outbound" },
              { name: "X-Ouro-From", value: "+15551234567" },
              { name: "X-Ouro-To", value: "+15557654321" },
              { name: "X-Ouro-Friend-Id", value: "ari" },
              { name: "X-Ouro-Outbound-Id", value: "out-sip-unknown-human" },
              { name: "X-Ouro-Reason", value: "quick voice check" },
            ],
          },
        }),
      })
      expect(sipResponse.statusCode).toBe(200)
      await vi.waitFor(() => expect(openai.openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_unknown_human/accept"))).toBe(true), { timeout: 10_000 })
      await vi.waitFor(() => expect(openai.openaiSockets.length).toBe(1), { timeout: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(openai.openaiMessages.some((event) => event.type === "response.create")).toBe(false)

      openai.openaiSockets[0]?.send(JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello?",
      }))
      const amd = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-sip-unknown-human/amd",
        headers: {},
        body: formBody({ CallSid: "CATWILIOUNKNOWN", AnsweredBy: "unknown" }),
      })
      expect(amd.statusCode).toBe(200)
      await vi.waitFor(() => expect(openai.openaiMessages.some((event) => event.type === "response.create")).toBe(true), { timeout: 10_000 })
      expect(openai.openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_unknown_human/hangup"))).toBe(false)
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-sip-unknown-human"), "utf8")) as { status?: string; answeredBy?: string }
      expect(saved.status).toBe("answered")
      expect(saved.answeredBy).toBe("unknown")
    } finally {
      await openai.close()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  }, 20_000)

  it("hangs up outbound SIP calls silently when async AMD reports voicemail", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-openai-sip-amd-machine-"))
    const openai = startOpenAISipMock("call_machine")
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-sip-machine",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "quick voice check",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const bridge = createTwilioPhoneBridge({
        ...baseBridgeOptions(outputDir),
        conversationEngine: "openai-sip",
        openaiRealtime: { apiKey: "openai-secret", model: "gpt-realtime-2", voice: "cedar" },
        openaiSip: {
          projectId: "proj_test",
          webhookPath: "/voice/agents/slugger/sip/openai",
          allowUnsignedWebhooks: true,
          apiBaseUrl: "https://api.openai.test/v1",
          websocketBaseUrl: openai.websocketBaseUrl,
          fetch: openai.openaiFetch,
        },
      })
      const outgoing = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-sip-machine",
        headers: {},
        body: formBody({ CallSid: "CATWILIOMACHINE", From: "+15557654321", To: "+15551234567" }),
      })
      expect(String(outgoing.body)).toContain("<Dial answerOnBridge=\"true\"><Sip>")

      const sipResponse = await bridge.handle({
        method: "POST",
        path: "/voice/agents/slugger/sip/openai",
        headers: {},
        body: JSON.stringify({
          type: "realtime.call.incoming",
          data: {
            call_id: "call_machine",
            sip_headers: [
              { name: "X-Ouro-Direction", value: "outbound" },
              { name: "X-Ouro-From", value: "+15551234567" },
              { name: "X-Ouro-To", value: "+15557654321" },
              { name: "X-Ouro-Friend-Id", value: "ari" },
              { name: "X-Ouro-Outbound-Id", value: "out-sip-machine" },
              { name: "X-Ouro-Reason", value: "quick voice check" },
            ],
          },
        }),
      })
      expect(sipResponse.statusCode).toBe(200)
      await vi.waitFor(() => expect(openai.openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_machine/accept"))).toBe(true), { timeout: 10_000 })
      const accept = openai.openaiRequests.find((request) => request.input.endsWith("/realtime/calls/call_machine/accept"))!
      const acceptBody = JSON.parse(accept.body) as { audio?: { input?: { turn_detection?: { create_response?: boolean } } } }
      expect(acceptBody.audio?.input?.turn_detection?.create_response).toBe(false)
      await vi.waitFor(() => expect(openai.openaiSockets.length).toBe(1), { timeout: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(openai.openaiMessages.some((event) => event.type === "response.create")).toBe(false)

      const amd = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-sip-machine/amd",
        headers: {},
        body: formBody({ CallSid: "CATWILIOMACHINE", AnsweredBy: "machine_start" }),
      })
      expect(amd.statusCode).toBe(200)
      await vi.waitFor(() => expect(openai.openaiRequests.some((request) => request.input.endsWith("/realtime/calls/call_machine/hangup"))).toBe(true), { timeout: 10_000 })
      expect(openai.openaiMessages.some((event) => event.type === "response.create")).toBe(false)
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-sip-machine"), "utf8")) as { status?: string; answeredBy?: string; transportCallSid?: string }
      expect(saved.status).toBe("voicemail")
      expect(saved.answeredBy).toBe("machine_start")
      expect(saved.transportCallSid).toBe("CATWILIOMACHINE")
    } finally {
      await openai.close()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  }, 20_000)

  it("prebuffers media-stream greetings before the WebSocket starts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      const response = await server.bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
      })
      const body = String(response.body)
      expect(body).toContain("<Parameter name=\"GreetingJobId\" value=\"twilio-CA123-connected\" />")
      expect(options.runSenseTurn).toHaveBeenCalledTimes(1)

      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const messages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CA123",
          customParameters: {
            From: "+15551234567",
            To: "+15557654321",
            GreetingJobId: "twilio-CA123-connected",
          },
        },
      })
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2))

      expect(messages[0]).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("mp3-response").toString("base64") },
      })
      expect(messages[1]).toMatchObject({
        event: "mark",
        streamSid: "MZ123",
      })
      expect(options.runSenseTurn).toHaveBeenCalledTimes(1)
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("bridges Twilio Media Streams directly through OpenAI Realtime when selected", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const friendId = `test-realtime-${Date.now()}`
    const realtimeGreetingPayload = Buffer.alloc(160, 0x7f).toString("base64")
    const openaiMessages: Record<string, unknown>[] = []
    const openaiSockets: WebSocket[] = []
    const openaiServer = new WebSocketServer({ port: 0 })
    const address = openaiServer.address()
    if (!address || typeof address === "string") throw new Error("OpenAI test server did not bind to a TCP port")
    const openaiUrl = `ws://127.0.0.1:${address.port}`
    const options = {
      ...baseBridgeOptions(outputDir),
      agentRoot: path.join(outputDir, "slugger.ouro"),
      defaultFriendId: friendId,
      transportMode: "media-stream" as const,
      conversationEngine: "openai-realtime" as const,
      openaiRealtime: {
        apiKey: "openai-secret",
        apiKeySource: "voice.openaiRealtimeApiKey",
        websocketUrl: openaiUrl,
        model: "gpt-realtime-2",
        voice: "marin",
        voiceStyle: "lightly British and interrupt-friendly",
        voiceSpeed: 1.1,
        reasoningEffort: "low" as const,
      },
    }
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      openaiServer.on("connection", (ws, request) => {
        openaiSockets.push(ws as WebSocket)
        expect(request.headers.authorization).toBe("Bearer openai-secret")
        ws.on("message", (raw) => {
          const event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
          openaiMessages.push(event)
          if (event.type === "response.create") {
            ws.send(JSON.stringify({
              type: "response.output_audio.delta",
              item_id: "item-greeting",
              content_index: 0,
              delta: realtimeGreetingPayload,
            }))
            ws.send(JSON.stringify({
              type: "response.output_audio_transcript.done",
              transcript: "Hi, you're on with Slugger.",
            }))
            ws.send(JSON.stringify({
              type: "response.done",
              response: { id: "resp-greeting" },
            }))
          }
          if (event.type === "input_audio_buffer.append") {
            ws.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }))
          }
        })
      })

      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      const response = await server.bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CAREALTIME", From: "+15551234567", To: "+15557654321" }),
      })
      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Connect><Stream url=\"wss://voice.example.com/voice/twilio/media-stream\">")
      expect(String(response.body)).not.toContain("GreetingJobId")
      expect(options.runSenseTurn).not.toHaveBeenCalled()

      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const twilioMessages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZREALTIME",
          callSid: "CAREALTIME",
          customParameters: {
            From: "+15551234567",
            To: "+15557654321",
          },
        },
      })

      await vi.waitFor(() => expect(openaiMessages.some((event) => event.type === "session.update")).toBe(true), { timeout: 10_000 })
      const sessionUpdate = openaiMessages.find((event) => event.type === "session.update") as { session: Record<string, unknown> }
      expect(sessionUpdate.session).toMatchObject({
        type: "realtime",
        model: "gpt-realtime-2",
        tool_choice: "auto",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-realtime-whisper" },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: false,
              threshold: 0.68,
              prefix_padding_ms: 220,
              silence_duration_ms: 320,
              idle_timeout_ms: 15_000,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "marin",
            speed: 1.1,
          },
        },
      })
      expect(sessionUpdate.session.instructions).toContain("Phone voice target: lightly British and interrupt-friendly")
      const tools = sessionUpdate.session.tools as Array<{ name: string }>
      expect(tools.some((tool) => tool.name === "voice_end_call")).toBe(true)
      expect(tools.some((tool) => tool.name === "voice_play_audio")).toBe(true)
      expect(tools.some((tool) => tool.name === "speak")).toBe(false)

      await vi.waitFor(() => expect(twilioMessages.some((event) => event.event === "media")).toBe(true))
      expect(twilioMessages.find((event) => event.event === "media")).toEqual({
        event: "media",
        streamSid: "MZREALTIME",
        media: { payload: realtimeGreetingPayload },
      })
      await vi.waitFor(() => expect(twilioMessages.some((event) => event.event === "mark")).toBe(true))
      const playbackMark = twilioMessages.find((event) => event.event === "mark") as { mark?: { name?: string } }
      expect(playbackMark.mark?.name).toMatch(/^rt-/)
      sendSocketJson(socket, {
        event: "mark",
        streamSid: "MZREALTIME",
        mark: { name: playbackMark.mark?.name },
      })

      for (let index = 0; index < 8; index += 1) sendMediaFrame(socket, 0x00)
      await vi.waitFor(() => expect(openaiMessages.some((event) => event.type === "input_audio_buffer.append")).toBe(true))
      await vi.waitFor(() => expect(twilioMessages.some((event) => event.event === "clear")).toBe(true))
      await vi.waitFor(() => expect(openaiMessages.some((event) => event.type === "conversation.item.truncate")).toBe(true))
      expect(openaiMessages.find((event) => event.type === "conversation.item.truncate")).toMatchObject({
        type: "conversation.item.truncate",
        item_id: "item-greeting",
        content_index: 0,
        audio_end_ms: 20,
      })

      const mediaCountBeforeToolAudio = twilioMessages.filter((event) => event.event === "media").length
      openaiSockets[0]?.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call-play-audio",
        name: "voice_play_audio",
        arguments: JSON.stringify({ source: "tone", label: "test tone", durationMs: 80 }),
      }))
      await vi.waitFor(() => {
        expect(twilioMessages.filter((event) => event.event === "media").length).toBeGreaterThan(mediaCountBeforeToolAudio)
      })
      await vi.waitFor(() => {
        expect(openaiMessages.some((event) => {
          if (event.type !== "conversation.item.create") return false
          const item = event.item as { type?: string; output?: string } | undefined
          return item?.type === "function_call_output" && item.output?.includes("played audio")
        })).toBe(true)
      })

      const responseCreateCount = openaiMessages.filter((event) => event.type === "response.create").length
      openaiSockets[0]?.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp-tools",
        call_id: "call-tool-one",
        name: "definitely_missing_voice_tool_one",
        arguments: "{}",
      }))
      openaiSockets[0]?.send(JSON.stringify({
        type: "response.function_call_arguments.done",
        response_id: "resp-tools",
        call_id: "call-tool-two",
        name: "definitely_missing_voice_tool_two",
        arguments: "{}",
      }))
      openaiSockets[0]?.send(JSON.stringify({
        type: "response.done",
        response: { id: "resp-tools" },
      }))
      await vi.waitFor(() => {
        const outputs = openaiMessages.filter((event) => {
          if (event.type !== "conversation.item.create") return false
          const item = event.item as { type?: string; call_id?: string } | undefined
          return item?.type === "function_call_output" && item.call_id?.startsWith("call-tool-")
        })
        expect(outputs).toHaveLength(2)
      })
      await vi.waitFor(() => {
        expect(openaiMessages.filter((event) => event.type === "response.create")).toHaveLength(responseCreateCount + 1)
      })
      expect(options.runSenseTurn).not.toHaveBeenCalled()
      expect(options.tts.synthesize).not.toHaveBeenCalled()
      expect(options.transcriber.transcribe).not.toHaveBeenCalled()
    } finally {
      for (const openaiSocket of openaiSockets) {
        if (openaiSocket.readyState === WebSocket.OPEN) await closeSocket(openaiSocket)
      }
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await closeWebSocketServer(openaiServer)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  }, 15_000)

  it("plays configured initial audio after an OpenAI Realtime greeting", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const realtimeGreetingPayload = Buffer.alloc(160, 0x7f).toString("base64")
    const openaiMessages: Record<string, unknown>[] = []
    const openaiSockets: WebSocket[] = []
    const openaiServer = new WebSocketServer({ port: 0 })
    const address = openaiServer.address()
    if (!address || typeof address === "string") throw new Error("OpenAI test server did not bind to a TCP port")
    const openaiUrl = `ws://127.0.0.1:${address.port}`
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      openaiServer.on("connection", (ws) => {
        openaiSockets.push(ws as WebSocket)
        ws.on("message", (raw) => {
          const event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
          openaiMessages.push(event)
          if (event.type !== "response.create") return
          ws.send(JSON.stringify({
            type: "response.output_audio.delta",
            item_id: "item-greeting",
            content_index: 0,
            delta: realtimeGreetingPayload,
          }))
          ws.send(JSON.stringify({
            type: "response.done",
            response: { id: "resp-greeting" },
          }))
        })
      })

      server = await startTwilioPhoneBridgeServer({
        ...baseBridgeOptions(outputDir),
        publicBaseUrl: "https://voice.example.com",
        port: 0,
        agentRoot: path.join(outputDir, "slugger.ouro"),
        transportMode: "media-stream" as const,
        conversationEngine: "openai-realtime" as const,
        openaiRealtime: {
          apiKey: "openai-secret",
          websocketUrl: openaiUrl,
          model: "gpt-realtime-2",
        },
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const twilioMessages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZINITIAL",
          callSid: "CAINITIAL",
          customParameters: {
            From: "+15551234567",
            To: "+15557654321",
            InitialAudio: JSON.stringify({ source: "tone", label: "hello tone", toneHz: 440, durationMs: 80 }),
          },
        },
      })

      await vi.waitFor(() => expect(openaiMessages.some((event) => event.type === "session.update")).toBe(true), { timeout: 10_000 })
      await vi.waitFor(() => expect(twilioMessages.some((event) =>
        event.event === "media" && (event as { media?: { payload?: string } }).media?.payload === realtimeGreetingPayload,
      )).toBe(true))
      await vi.waitFor(() => expect(twilioMessages.some((event) =>
        event.event === "media" && (event as { media?: { payload?: string } }).media?.payload !== realtimeGreetingPayload,
      )).toBe(true))
    } finally {
      for (const openaiSocket of openaiSockets) {
        if (openaiSocket.readyState === WebSocket.OPEN) await closeSocket(openaiSocket)
      }
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await closeWebSocketServer(openaiServer)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  }, 15_000)

  it("answers outbound call webhooks as the trusted friend's stable voice session", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-1",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "check in about the voice alpha",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
        initialAudio: { source: "tone", label: "hello tone", toneHz: 440, durationMs: 80 },
      })
      const options = {
        ...baseBridgeOptions(outputDir),
        transportMode: "media-stream" as const,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-1",
        headers: {},
        body: formBody({ CallSid: "CAOUT", From: "+15557654321", To: "+15551234567" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Connect><Stream url=\"wss://voice.example.com/voice/twilio/media-stream\">")
      expect(String(response.body)).toContain("<Parameter name=\"Direction\" value=\"outbound\" />")
      expect(String(response.body)).toContain("<Parameter name=\"Remote\" value=\"+15551234567\" />")
      expect(String(response.body)).toContain("<Parameter name=\"Line\" value=\"+15557654321\" />")
      expect(String(response.body)).toContain("<Parameter name=\"FriendId\" value=\"ari\" />")
      expect(String(response.body)).toContain("<Parameter name=\"OutboundId\" value=\"out-1\" />")
      expect(String(response.body)).toContain("<Parameter name=\"InitialAudio\" value=\"{&quot;source&quot;:&quot;tone&quot;,&quot;label&quot;:&quot;hello tone&quot;,&quot;toneHz&quot;:440,&quot;durationMs&quot;:80}\" />")
      expect(String(response.body)).toContain("<Parameter name=\"GreetingJobId\" value=\"twilio-CAOUT-outbound-connected\" />")
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        friendId: "ari",
        sessionKey: "twilio-phone-ari-via-15557654321",
        userMessage: expect.stringContaining("A Twilio outbound phone voice call was answered."),
      }))
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("check in about the voice alpha"),
      }))
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-1"), "utf8")) as { status?: string; transportCallSid?: string }
      expect(saved.status).toBe("answered")
      expect(saved.transportCallSid).toBe("CAOUT")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("hangs up outbound calls answered by voicemail before starting an agent voice turn", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-machine",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "check in about the voice alpha",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const options = {
        ...baseBridgeOptions(outputDir),
        transportMode: "media-stream" as const,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-machine",
        headers: {},
        body: formBody({ CallSid: "CAOUT", From: "+15557654321", To: "+15551234567", AnsweredBy: "machine_start" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Hangup />")
      expect(options.runSenseTurn).not.toHaveBeenCalled()
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-machine"), "utf8")) as { status?: string; answeredBy?: string; events?: Array<{ status: string; answeredBy?: string }> }
      expect(saved.status).toBe("voicemail")
      expect(saved.answeredBy).toBe("machine_start")
      expect(saved.events?.at(-1)).toMatchObject({ status: "voicemail", answeredBy: "machine_start" })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("hangs up outbound calls answered by fax before starting an agent voice turn", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-fax",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "check in about the voice alpha",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const options = {
        ...baseBridgeOptions(outputDir),
        transportMode: "media-stream" as const,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-fax",
        headers: {},
        body: formBody({ CallSid: "CAFAX", From: "+15557654321", To: "+15551234567", AnsweredBy: "fax" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Hangup />")
      expect(options.runSenseTurn).not.toHaveBeenCalled()
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-fax"), "utf8")) as { status?: string; answeredBy?: string }
      expect(saved.status).toBe("fax")
      expect(saved.answeredBy).toBe("fax")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("uses prewarmed outbound greetings instead of making humans wait after answer", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const greetingDir = path.join(outputDir, "outbound-greetings", "out-prewarm")
    const greetingPath = path.join(greetingDir, "greeting.audio")
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      await fs.mkdir(greetingDir, { recursive: true })
      await fs.writeFile(greetingPath, Buffer.from("ulaw-ready"))
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-prewarm",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "say the phone bridge is ready",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
        prewarmedGreeting: {
          utteranceId: "twilio-out-prewarm-outbound-connected",
          audioPath: greetingPath,
          mimeType: "audio/x-mulaw;rate=8000",
          byteLength: Buffer.byteLength("ulaw-ready"),
          preparedAt: "2026-05-08T11:59:58.000Z",
        },
      })
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      const response = await server.bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-prewarm",
        headers: {},
        body: formBody({ CallSid: "CAOUTPRE", From: "+15557654321", To: "+15551234567" }),
      })
      expect(options.runSenseTurn).not.toHaveBeenCalled()
      expect(String(response.body)).toContain("<Parameter name=\"GreetingJobId\" value=\"twilio-CAOUTPRE-outbound-connected\" />")

      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CAOUTPRE",
          customParameters: {
            From: "+15557654321",
            To: "+15551234567",
            Direction: "outbound",
            Remote: "+15551234567",
            Line: "+15557654321",
            FriendId: "ari",
            OutboundId: "out-prewarm",
            GreetingJobId: "twilio-CAOUTPRE-outbound-connected",
          },
        },
      })
      const media = await waitForSocketMessage(socket)
      expect(media).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("ulaw-ready").toString("base64") },
      })
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("falls back to a live outbound greeting when a prewarmed artifact is unavailable", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-prewarm-missing",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "say the phone bridge is ready",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
        prewarmedGreeting: {
          utteranceId: "twilio-out-prewarm-missing-outbound-connected",
          audioPath: path.join(outputDir, "missing.audio"),
          mimeType: "audio/x-mulaw;rate=8000",
          byteLength: 10,
          preparedAt: "2026-05-08T11:59:58.000Z",
        },
      })
      const options = {
        ...baseBridgeOptions(outputDir),
        transportMode: "media-stream" as const,
      }
      const bridge = createTwilioPhoneBridge(options)
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-prewarm-missing",
        headers: {},
        body: formBody({ CallSid: "CAOUTMISS", From: "+15557654321", To: "+15551234567" }),
      })

      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toContain("<Parameter name=\"GreetingJobId\" value=\"twilio-CAOUTMISS-outbound-connected\" />")
      expect(options.runSenseTurn).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("streams prebuffered outbound greetings over the Media Stream socket", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-2",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "say the phone bridge is ready",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      const response = await server.bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-2",
        headers: {},
        body: formBody({ CallSid: "CAOUT2", From: "+15557654321", To: "+15551234567" }),
      })
      expect(String(response.body)).toContain("<Parameter name=\"GreetingJobId\" value=\"twilio-CAOUT2-outbound-connected\" />")

      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const messages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CAOUT2",
          customParameters: {
            From: "+15557654321",
            To: "+15551234567",
            Direction: "outbound",
            Remote: "+15551234567",
            Line: "+15557654321",
            FriendId: "ari",
            OutboundId: "out-2",
            GreetingJobId: "twilio-CAOUT2-outbound-connected",
          },
        },
      })
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2))
      expect(messages[0]).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("mp3-response").toString("base64") },
      })
      expect(options.runSenseTurn).toHaveBeenCalledTimes(1)
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("records outbound call status callbacks", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-status",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "status test",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const bridge = createTwilioPhoneBridge(baseBridgeOptions(outputDir))
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-status/status",
        headers: {},
        body: formBody({ CallSid: "CAOUT", CallStatus: "completed", AnsweredBy: "human" }),
      })
      expect(response.statusCode).toBe(200)
      expect(String(response.body)).toBe("ok")
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-status"), "utf8")) as { status?: string; events?: Array<{ status: string; answeredBy?: string }> }
      expect(saved.status).toBe("completed")
      expect(saved.events?.at(-1)).toMatchObject({ status: "completed", answeredBy: "human" })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("records voicemail status callbacks as terminal non-human answers", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-machine-status",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "status test",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "requested",
      })
      const bridge = createTwilioPhoneBridge(baseBridgeOptions(outputDir))
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-machine-status/status",
        headers: {},
        body: formBody({ CallSid: "CAOUT", CallStatus: "in-progress", AnsweredBy: "machine_end_beep" }),
      })
      expect(response.statusCode).toBe(200)
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-machine-status"), "utf8")) as { status?: string; answeredBy?: string; events?: Array<{ status: string; answeredBy?: string }> }
      expect(saved.status).toBe("voicemail")
      expect(saved.answeredBy).toBe("machine_end_beep")
      expect(saved.events?.at(-1)).toMatchObject({ status: "voicemail", answeredBy: "machine_end_beep" })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("records human async AMD callbacks without ending the outbound call", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-human-amd",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "status test",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "answered",
      })
      const bridge = createTwilioPhoneBridge(baseBridgeOptions(outputDir))
      const response = await bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-human-amd/amd",
        headers: {},
        body: formBody({ CallSid: "CAOUT", AnsweredBy: "human" }),
      })
      expect(response.statusCode).toBe(200)
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-human-amd"), "utf8")) as { status?: string; answeredBy?: string; events?: Array<{ status: string; answeredBy?: string }> }
      expect(saved.status).toBe("answered")
      expect(saved.answeredBy).toBe("human")
      expect(saved.events?.at(-1)).toMatchObject({ status: "amd-human", answeredBy: "human" })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("streams the agent greeting over a Twilio Media Stream WebSocket", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const messages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CA123",
          customParameters: { From: "+15551234567", To: "+15557654321" },
        },
      })
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2))
      const media = messages[0]
      const mark = messages[1]

      expect(media).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("mp3-response").toString("base64") },
      })
      expect(mark).toMatchObject({
        event: "mark",
        streamSid: "MZ123",
      })
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        channel: "voice",
        friendId: "twilio-15551234567",
        sessionKey: "twilio-phone-15551234567-via-15557654321",
        userMessage: expect.stringContaining("A Twilio phone voice call just connected."),
      }))

    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps caller speech during playback as a barge-in follow-up on Media Streams", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    let releaseGreeting: (() => void) | undefined
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    options.transcriber.transcribe = vi.fn(async (request) => buildVoiceTranscript({
      utteranceId: request.utteranceId,
      text: "wait actually",
      audioPath: request.audioPath,
      source: "whisper.cpp",
    }))
    options.tts.synthesize = vi.fn(async (request) => {
      if (request.utteranceId.endsWith("connected")) {
        request.onAudioChunk?.(Buffer.from("greet"))
        await new Promise<void>((resolve) => {
          releaseGreeting = resolve
        })
        return {
          utteranceId: request.utteranceId,
          audio: Buffer.from("greet"),
          byteLength: 5,
          chunkCount: 1,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/x-mulaw;rate=8000",
        }
      }
      request.onAudioChunk?.(Buffer.from("reply"))
      return {
        utteranceId: request.utteranceId,
        audio: Buffer.from("reply"),
        byteLength: 5,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/x-mulaw;rate=8000",
      }
    })

    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const messages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CA123",
          customParameters: { From: "+15551234567", To: "+15557654321" },
        },
      })

      const greetingMedia = await waitForSocketMessage(socket)
      expect(greetingMedia).toMatchObject({ event: "media" })

      for (let index = 0; index < 8; index += 1) sendMediaFrame(socket, 0x00)
      for (let index = 0; index < 36; index += 1) sendMediaFrame(socket, 0xff)

      const clear = await waitForSocketMessage(socket)
      expect(clear).toEqual({ event: "clear", streamSid: "MZ123" })
      releaseGreeting?.()

      const followUpMedia = await waitForSocketMessage(socket)
      expect(followUpMedia).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("reply").toString("base64") },
      })
      expect(options.transcriber.transcribe).toHaveBeenCalledWith(expect.objectContaining({
        utteranceId: "twilio-CA123-1",
        audioPath: expect.stringContaining("twilio-CA123-1.wav"),
      }))
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("Caller said: wait actually"),
      }))
    } finally {
      releaseGreeting?.()
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("lets the agent end a Media Stream call after spoken playback finishes", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    options.runSenseTurn = vi.fn(async (request) => {
      await request.toolContext?.voiceCall?.requestEnd("caller said goodbye")
      await request.deliverySink?.onDelivery({ kind: "settle", text: "Talk soon." })
      return {
        response: "Talk soon.",
        ponderDeferred: false,
        deliveries: [{ kind: "settle" as const, text: "Talk soon." }],
        deliveryFailures: [],
      }
    })
    options.tts.synthesize = vi.fn(async (request) => {
      request.onAudioChunk?.(Buffer.from("bye"))
      return {
        utteranceId: request.utteranceId,
        audio: Buffer.from("bye"),
        byteLength: 3,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/x-mulaw;rate=8000",
      }
    })

    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      const messages = collectSocketMessages(socket)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CAEND",
          customParameters: { From: "+15551234567", To: "+15557654321" },
        },
      })
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(2))

      const media = messages[0]
      expect(media).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("bye").toString("base64") },
      })
      const mark = messages[1]
      expect(mark).toMatchObject({ event: "mark", streamSid: "MZ123" })

      sendSocketJson(socket, {
        event: "mark",
        streamSid: "MZ123",
        mark: (mark as { mark?: unknown }).mark,
      })

      await waitForSocketClose(socket)
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("cancels a pending agent hangup when the caller barges in", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    let releaseGoodbye: (() => void) | undefined
    let turnCount = 0
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    options.transcriber.transcribe = vi.fn(async (request) => buildVoiceTranscript({
      utteranceId: request.utteranceId,
      text: "wait one more thing",
      audioPath: request.audioPath,
      source: "whisper.cpp",
    }))
    options.runSenseTurn = vi.fn(async (request) => {
      turnCount += 1
      if (turnCount === 1) {
        await request.toolContext?.voiceCall?.requestEnd("caller said goodbye")
        await request.deliverySink?.onDelivery({ kind: "settle", text: "Talk soon." })
        return {
          response: "Talk soon.",
          ponderDeferred: false,
          deliveries: [{ kind: "settle" as const, text: "Talk soon." }],
          deliveryFailures: [],
        }
      }
      await request.deliverySink?.onDelivery({ kind: "settle", text: "Go ahead." })
      return {
        response: "Go ahead.",
        ponderDeferred: false,
        deliveries: [{ kind: "settle" as const, text: "Go ahead." }],
        deliveryFailures: [],
      }
    })
    options.tts.synthesize = vi.fn(async (request) => {
      if (request.text === "Talk soon.") {
        request.onAudioChunk?.(Buffer.from("bye"))
        await new Promise<void>((resolve) => {
          releaseGoodbye = resolve
        })
        return {
          utteranceId: request.utteranceId,
          audio: Buffer.from("bye"),
          byteLength: 3,
          chunkCount: 1,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/x-mulaw;rate=8000",
        }
      }
      request.onAudioChunk?.(Buffer.from("reply"))
      return {
        utteranceId: request.utteranceId,
        audio: Buffer.from("reply"),
        byteLength: 5,
        chunkCount: 1,
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
        mimeType: "audio/x-mulaw;rate=8000",
      }
    })

    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CACANCEL",
          customParameters: { From: "+15551234567", To: "+15557654321" },
        },
      })

      const goodbye = await waitForSocketMessage(socket)
      expect(goodbye).toMatchObject({ event: "media", streamSid: "MZ123" })

      for (let index = 0; index < 8; index += 1) sendMediaFrame(socket, 0x00)
      for (let index = 0; index < 36; index += 1) sendMediaFrame(socket, 0xff)

      const clear = await waitForSocketMessage(socket)
      expect(clear).toEqual({ event: "clear", streamSid: "MZ123" })
      releaseGoodbye?.()

      const followUp = await waitForSocketMessage(socket)
      expect(followUp).toEqual({
        event: "media",
        streamSid: "MZ123",
        media: { payload: Buffer.from("reply").toString("base64") },
      })
      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      releaseGoodbye?.()
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("stops outbound Media Stream calls when STT hears a voicemail menu", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    options.transcriber.transcribe = vi.fn(async (request) => buildVoiceTranscript({
      utteranceId: request.utteranceId,
      text: "If you're satisfied with the message press 1. To listen to your message press 2. To erase and rerecord press 3.",
      audioPath: request.audioPath,
      source: "whisper.cpp",
    }))

    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-menu",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "check in about the voice alpha",
        createdAt: "2026-05-08T12:00:00.000Z",
        status: "answered",
      })
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CAOUTMENU",
          customParameters: {
            From: "+15557654321",
            To: "+15551234567",
            Direction: "outbound",
            Remote: "+15551234567",
            Line: "+15557654321",
            FriendId: "ari",
            OutboundId: "out-menu",
          },
        },
      })
      await vi.waitFor(() => expect(options.runSenseTurn).toHaveBeenCalledTimes(1))
      vi.mocked(options.runSenseTurn).mockClear()

      for (let index = 0; index < 8; index += 1) sendMediaFrame(socket, 0x00)
      for (let index = 0; index < 36; index += 1) sendMediaFrame(socket, 0xff)

      await waitForSocketClose(socket)
      expect(options.runSenseTurn).not.toHaveBeenCalled()
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-menu"), "utf8")) as { status?: string; answeredBy?: string; transportCallSid?: string }
      expect(saved.status).toBe("voicemail")
      expect(saved.answeredBy).toBe("voicemail_menu")
      expect(saved.transportCallSid).toBe("CAOUTMENU")
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("stops active outbound Media Stream calls when async AMD reports voicemail", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    const options = {
      ...baseBridgeOptions(outputDir),
      transportMode: "media-stream" as const,
    }
    let server: Awaited<ReturnType<typeof startTwilioPhoneBridgeServer>> | undefined
    let socket: WebSocket | undefined
    try {
      await writeTwilioOutboundCallJob(outputDir, {
        schemaVersion: 1,
        outboundId: "out-async-machine",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "check in about the voice alpha",
        createdAt: "2026-05-08T12:00:00.000Z",
        transportCallSid: "CAASYNC",
        status: "answered",
      })
      server = await startTwilioPhoneBridgeServer({
        ...options,
        publicBaseUrl: "https://voice.example.com",
        port: 0,
      })
      socket = new WebSocket(`${server.localUrl.replace("http:", "ws:")}/voice/twilio/media-stream`)
      await waitForSocketOpen(socket)
      sendSocketJson(socket, {
        event: "start",
        start: {
          streamSid: "MZ123",
          callSid: "CAASYNC",
          customParameters: {
            From: "+15557654321",
            To: "+15551234567",
            Direction: "outbound",
            Remote: "+15551234567",
            Line: "+15557654321",
            FriendId: "ari",
            OutboundId: "out-async-machine",
          },
        },
      })
      await vi.waitFor(() => expect(options.runSenseTurn).toHaveBeenCalledTimes(1))
      vi.mocked(options.runSenseTurn).mockClear()

      const response = await server.bridge.handle({
        method: "POST",
        path: "/voice/twilio/outgoing/out-async-machine/amd",
        headers: {},
        body: formBody({ CallSid: "CAASYNC", AnsweredBy: "machine_start" }),
      })

      expect(response.statusCode).toBe(200)
      await waitForSocketClose(socket)
      expect(options.runSenseTurn).not.toHaveBeenCalled()
      const saved = JSON.parse(await fs.readFile(twilioOutboundCallJobPath(outputDir, "out-async-machine"), "utf8")) as { status?: string; answeredBy?: string; transportCallSid?: string; events?: Array<{ status: string; answeredBy?: string }> }
      expect(saved.status).toBe("voicemail")
      expect(saved.answeredBy).toBe("machine_start")
      expect(saved.transportCallSid).toBe("CAASYNC")
      expect(saved.events?.at(-1)).toMatchObject({ status: "voicemail", answeredBy: "machine_start" })
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) await closeSocket(socket)
      if (server) await closeTwilioPhoneBridgeServer(server)
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

  it("returns not found for unknown GET routes outside the configured voice path", async () => {
    const bridge = createTwilioPhoneBridge({
      ...baseBridgeOptions("/tmp/ouro-twilio-phone"),
      basePath: "/voice/agents/slugger/twilio",
    })

    const staleHealthProbe = await bridge.handle({
      method: "GET",
      path: "/voice/twilio/health",
      headers: {},
    })
    const configuredHealthProbe = await bridge.handle({
      method: "GET",
      path: "/voice/agents/slugger/twilio/health",
      headers: {},
    })

    expect(staleHealthProbe).toMatchObject({
      statusCode: 404,
      body: "not found",
    })
    expect(configuredHealthProbe).toMatchObject({
      statusCode: 200,
      body: "ok",
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
    expect(String(defaultResponse.body)).toContain("timeout=\"1\"")
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

  it("streams an agent reprompt when Whisper returns an empty transcript error", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.transcriber.transcribe = vi.fn(async () => {
        throw new Error("whisper.cpp transcription failed: empty whisper.cpp transcript")
      })
      options.tts.synthesize = vi.fn(async (request) => {
        request.onAudioChunk?.(Buffer.from("reprompt"))
        return {
          utteranceId: request.utteranceId,
          audio: Buffer.from("reprompt"),
          byteLength: 8,
          chunkCount: 1,
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
        }),
      })

      expect(response.statusCode).toBe(200)
      const streamUrl = firstPlayUrl(response.body)
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(streamUrl).pathname,
        headers: {},
      })
      const streamed = await collectBridgeBody(streamResponse.body)

      expect(streamResponse.statusCode).toBe(200)
      expect(streamed.toString("utf8")).toBe("reprompt")
      expect(options.runSenseTurn).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("no intelligible speech"),
      }))
      expect(options.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({
        utteranceId: "twilio-CA111-RE222-nospeech",
        text: expect.stringContaining("agent heard: The last Twilio phone recording contained no intelligible speech."),
      }))
      expect(await fs.readFile(path.join(outputDir, "CA111", "twilio-ca111-re222-nospeech.mp3"), "utf8")).toBe("reprompt")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps the Twilio stream valid when STT fails before audio starts", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
      }
      options.transcriber.transcribe = vi.fn(async () => {
        throw new Error("stt unavailable")
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
      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })

      const streamed = await collectBridgeBody(streamResponse.body)
      expect(streamed.byteLength).toBeGreaterThan(0)
      expect(streamed.subarray(0, 3).toString("utf8")).toBe("ID3")
    } finally {
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

  it("can keep an inbound call ringing until greeting audio starts streaming", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-phone-"))
    let emitFirstChunk: (() => void) | undefined
    let finishTts: (() => void) | undefined
    try {
      const options = {
        ...baseBridgeOptions(outputDir),
        playbackMode: "stream" as const,
        greetingPrebufferMs: 10_000,
      }
      options.tts.synthesize = vi.fn(async (request) => {
        await new Promise<void>((resolve) => {
          emitFirstChunk = () => {
            request.onAudioChunk?.(Buffer.from("ready-"))
            resolve()
          }
        })
        await new Promise<void>((resolve) => {
          finishTts = resolve
        })
        request.onAudioChunk?.(Buffer.from("done"))
        return {
          utteranceId: request.utteranceId,
          audio: Buffer.from("ready-done"),
          byteLength: 10,
          chunkCount: 2,
          modelId: "eleven_flash_v2_5",
          voiceId: "voice_123",
          mimeType: "audio/mpeg",
        }
      })
      const bridge = createTwilioPhoneBridge(options)
      let answered = false
      const responsePromise = bridge.handle({
        method: "POST",
        path: "/voice/twilio/incoming",
        headers: {},
        body: formBody({ CallSid: "CA123", From: "+15551234567", To: "+15557654321" }),
      }).then((response) => {
        answered = true
        return response
      })

      await vi.waitFor(() => expect(emitFirstChunk).toBeDefined())
      expect(answered).toBe(false)
      emitFirstChunk?.()
      const response = await responsePromise

      expect(answered).toBe(true)
      expect(response.statusCode).toBe(200)
      expect(firstPlayUrl(response.body)).toBe("https://voice.example.com/voice/twilio/audio-stream/CA123/twilio-CA123-connected.mp3")

      const streamResponse = await bridge.handle({
        method: "GET",
        path: new URL(firstPlayUrl(response.body)).pathname,
        headers: {},
      })
      const iterator = (streamResponse.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: Buffer.from("ready-"),
      })
      finishTts?.()
      const rest = await collectBridgeBody({ [Symbol.asyncIterator]: () => iterator })
      expect(rest.toString("utf8")).toBe("done")
    } finally {
      finishTts?.()
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

  it("keeps the Twilio stream valid when a turn fails before any audio reaches Twilio", async () => {
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

      const streamed = await collectBridgeBody(streamResponse.body)
      expect(streamed.byteLength).toBeGreaterThan(0)
      expect(streamed.subarray(0, 3).toString("utf8")).toBe("ID3")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("keeps the Twilio stream valid when TTS fails before any audio reaches Twilio", async () => {
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

      const streamed = await collectBridgeBody(streamResponse.body)
      expect(streamed.byteLength).toBeGreaterThan(0)
      expect(streamed.subarray(0, 3).toString("utf8")).toBe("ID3")
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

  it("rejects unsupported non-GET and non-POST Twilio routes", async () => {
    const bridge = createTwilioPhoneBridge(baseBridgeOptions("/tmp/ouro-twilio-phone"))

    const response = await bridge.handle({
      method: "PUT",
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
