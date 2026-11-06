import * as crypto from "node:crypto"
import * as fs from "fs/promises"
import * as http from "http"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeVoicePlaybackArtifact } from "./playback"
import { runVoiceLoopbackTurn, type VoiceRunSenseTurn } from "./turn"
import type { VoiceTranscriber, VoiceTtsService } from "./types"

export const DEFAULT_TWILIO_PHONE_PORT = 18910
export const DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS = 2
export const DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS = 30
export const TWILIO_PHONE_WEBHOOK_BASE_PATH = "/voice/twilio"

export interface TwilioSignatureInput {
  authToken: string
  url: string
  params: Record<string, string>
}

export interface TwilioPhoneBridgeRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body?: string | Uint8Array
}

export interface TwilioPhoneBridgeResponse {
  statusCode: number
  headers: Record<string, string>
  body: string | Uint8Array
}

export interface TwilioRecordingDownloadRequest {
  recordingUrl: string
  accountSid?: string
  authToken?: string
}

export type TwilioRecordingDownloader = (request: TwilioRecordingDownloadRequest) => Promise<Uint8Array>

export interface TwilioPhoneBridgeOptions {
  agentName: string
  publicBaseUrl: string
  outputDir: string
  basePath?: string
  transcriber: VoiceTranscriber
  tts: VoiceTtsService
  runSenseTurn?: VoiceRunSenseTurn
  twilioAccountSid?: string
  twilioAuthToken?: string
  defaultFriendId?: string
  recordTimeoutSeconds?: number
  recordMaxLengthSeconds?: number
  greetingText?: string
  downloadRecording?: TwilioRecordingDownloader
}

export interface TwilioPhoneBridge {
  handle(request: TwilioPhoneBridgeRequest): Promise<TwilioPhoneBridgeResponse>
}

export interface TwilioPhoneBridgeServer {
  bridge: TwilioPhoneBridge
  server: http.Server
  localUrl: string
}

export interface StartTwilioPhoneBridgeServerOptions extends TwilioPhoneBridgeOptions {
  port?: number
  host?: string
}

interface RecordingCallbackParams {
  callSid: string
  recordingSid: string
  recordingUrl: string
  from: string
}

function bodyText(body: string | Uint8Array | undefined): string {
  if (body === undefined) return ""
  if (typeof body === "string") return body
  return Buffer.from(body).toString("utf8")
}

function formParams(rawBody: string): Record<string, string> {
  const parsed = new URLSearchParams(rawBody)
  const params: Record<string, string> = {}
  for (const [key, value] of parsed) {
    params[key] = value
  }
  return params
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (Array.isArray(value)) return value[0] ?? ""
    return value ?? ""
  }
  return ""
}

function xmlResponse(body: string): TwilioPhoneBridgeResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
  }
}

function textResponse(statusCode: number, body: string): TwilioPhoneBridgeResponse {
  return {
    statusCode,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body,
  }
}

function binaryResponse(body: Uint8Array, contentType: string): TwilioPhoneBridgeResponse {
  return {
    statusCode: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=300",
    },
    body,
  }
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function routeUrl(publicBaseUrl: string, route: string): string {
  return new URL(route, publicBaseUrl).toString()
}

export function normalizeTwilioPhoneBasePath(value: string | undefined = TWILIO_PHONE_WEBHOOK_BASE_PATH): string {
  const trimmed = value.trim()
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "")
  if (!withoutTrailingSlash || withoutTrailingSlash === "/") {
    throw new Error("Twilio phone webhook base path is empty")
  }
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(withoutTrailingSlash) || withoutTrailingSlash.includes("//")) {
    throw new Error(`invalid Twilio phone webhook base path: ${value}`)
  }
  return withoutTrailingSlash
}

export function twilioPhoneWebhookUrl(
  publicBaseUrl: string,
  basePath: string | undefined = TWILIO_PHONE_WEBHOOK_BASE_PATH,
): string {
  return routeUrl(publicBaseUrl, `${normalizeTwilioPhoneBasePath(basePath)}/incoming`)
}

function requestPublicUrl(publicBaseUrl: string, requestPath: string): string {
  return routeUrl(publicBaseUrl, requestPath)
}

function recordTwiml(options: {
  publicBaseUrl: string
  basePath: string
  timeoutSeconds: number
  maxLengthSeconds: number
}): string {
  return `<Record action="${escapeXml(routeUrl(options.publicBaseUrl, `${options.basePath}/recording`))}" method="POST" playBeep="false" timeout="${options.timeoutSeconds}" maxLength="${options.maxLengthSeconds}" trim="trim-silence" />`
}

function redirectTwiml(publicBaseUrl: string, basePath: string): string {
  return `<Redirect method="POST">${escapeXml(routeUrl(publicBaseUrl, `${basePath}/listen`))}</Redirect>`
}

function sayTwiml(message: string): string {
  return `<Say>${escapeXml(message)}</Say>`
}

function playTwiml(url: string): string {
  return `<Play>${escapeXml(url)}</Play>`
}

function safeSegment(input: string): string {
  const cleaned = input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "unknown"
}

function decodeSafeSegment(input: string): string | null {
  try {
    const decoded = decodeURIComponent(input)
    if (!/^[A-Za-z0-9._-]+$/.test(decoded)) return null
    if (decoded === "." || decoded === "..") return null
    return decoded
  } catch {
    return null
  }
}

function contentTypeForAudio(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === ".mp3") return "audio/mpeg"
  if (ext === ".wav") return "audio/wav"
  if (ext === ".pcm") return "audio/pcm"
  return "application/octet-stream"
}

function friendIdFromCaller(from: string, callSid: string): string {
  const phoneish = from.replace(/[^0-9A-Za-z]+/g, "")
  return phoneish ? `twilio-${phoneish}` : `twilio-${safeSegment(callSid)}`
}

function parseRecordingParams(params: Record<string, string>): RecordingCallbackParams | null {
  const callSid = params.CallSid?.trim()
  const recordingSid = params.RecordingSid?.trim()
  const recordingUrl = params.RecordingUrl?.trim()
  if (!callSid || !recordingSid || !recordingUrl) return null
  return {
    callSid,
    recordingSid,
    recordingUrl,
    from: params.From?.trim() ?? "",
  }
}

function recordAgainResponse(options: TwilioPhoneBridgeOptions, basePath: string, message: string): TwilioPhoneBridgeResponse {
  return xmlResponse(`${sayTwiml(message)}${recordTwiml({
    publicBaseUrl: options.publicBaseUrl,
    basePath,
    timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
    maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  })}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function computeTwilioSignature(input: TwilioSignatureInput): string {
  const payload = input.url + Object.keys(input.params)
    .sort()
    .map((key) => `${key}${input.params[key]}`)
    .join("")
  return crypto.createHmac("sha1", input.authToken).update(payload).digest("base64")
}

export function validateTwilioSignature(input: TwilioSignatureInput & { signature: string }): boolean {
  if (!input.authToken.trim()) return true
  if (!input.signature.trim()) return false
  const expected = Buffer.from(computeTwilioSignature(input))
  const actual = Buffer.from(input.signature)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export function twilioRecordingMediaUrl(recordingUrl: string): string {
  const url = new URL(recordingUrl)
  if (!/\.[A-Za-z0-9]+$/.test(url.pathname)) {
    url.pathname = `${url.pathname}.wav`
  }
  return url.toString()
}

export async function defaultTwilioRecordingDownloader(request: TwilioRecordingDownloadRequest): Promise<Uint8Array> {
  const headers: Record<string, string> = {}
  if (request.accountSid && request.authToken) {
    headers.Authorization = `Basic ${Buffer.from(`${request.accountSid}:${request.authToken}`).toString("base64")}`
  }

  const response = await fetch(request.recordingUrl, { headers })
  if (!response.ok) {
    throw new Error(`Twilio recording download failed: ${response.status} ${response.statusText}`.trim())
  }
  return Buffer.from(await response.arrayBuffer())
}

function verifyRequest(options: TwilioPhoneBridgeOptions, request: TwilioPhoneBridgeRequest, params: Record<string, string>): boolean {
  const authToken = options.twilioAuthToken?.trim()
  if (!authToken) return true
  return validateTwilioSignature({
    authToken,
    url: requestPublicUrl(options.publicBaseUrl, request.path),
    params,
    signature: headerValue(request.headers, "x-twilio-signature"),
  })
}

async function handleIncoming(options: TwilioPhoneBridgeOptions, basePath: string): Promise<TwilioPhoneBridgeResponse> {
  const greeting = options.greetingText ?? "Connected to Ouro voice. Speak after the prompt."
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_incoming",
    message: "Twilio voice call connected",
    meta: { agentName: options.agentName },
  })
  return xmlResponse(`${sayTwiml(greeting)}${recordTwiml({
    publicBaseUrl: options.publicBaseUrl,
    basePath,
    timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
    maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  })}`)
}

async function handleListen(options: TwilioPhoneBridgeOptions, basePath: string): Promise<TwilioPhoneBridgeResponse> {
  return xmlResponse(recordTwiml({
    publicBaseUrl: options.publicBaseUrl,
    basePath,
    timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
    maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  }))
}

async function handleRecording(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  params: Record<string, string>,
): Promise<TwilioPhoneBridgeResponse> {
  const recording = parseRecordingParams(params)
  if (!recording) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_twilio_recording_rejected",
      message: "Twilio recording callback was missing required fields",
      meta: { agentName: options.agentName },
    })
    return recordAgainResponse(options, basePath, "I did not receive audio. Please try again.")
  }

  const safeCallSid = safeSegment(recording.callSid)
  const safeRecordingSid = safeSegment(recording.recordingSid)
  const callDir = path.join(options.outputDir, safeCallSid)
  const inputPath = path.join(callDir, `${safeRecordingSid}.wav`)
  const utteranceId = `twilio-${safeCallSid}-${safeRecordingSid}`
  const downloadRecording = options.downloadRecording ?? defaultTwilioRecordingDownloader

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_turn_start",
    message: "starting Twilio voice turn",
    meta: { agentName: options.agentName, callSid: safeCallSid, recordingSid: safeRecordingSid },
  })

  try {
    await fs.mkdir(callDir, { recursive: true })
    const mediaUrl = twilioRecordingMediaUrl(recording.recordingUrl)
    const audio = await downloadRecording({
      recordingUrl: mediaUrl,
      accountSid: options.twilioAccountSid?.trim() || undefined,
      authToken: options.twilioAuthToken?.trim() || undefined,
    })
    await fs.writeFile(inputPath, audio)

    const transcript = await options.transcriber.transcribe({
      utteranceId,
      audioPath: inputPath,
    })
    const turn = await runVoiceLoopbackTurn({
      agentName: options.agentName,
      friendId: options.defaultFriendId?.trim() || friendIdFromCaller(recording.from, recording.callSid),
      sessionKey: `twilio-${safeCallSid}`,
      transcript,
      tts: options.tts,
      runSenseTurn: options.runSenseTurn,
    })

    if (turn.tts.status !== "delivered") {
      return xmlResponse(`${sayTwiml("voice output failed after the text response was captured.")}${redirectTwiml(options.publicBaseUrl, basePath)}`)
    }

    const playback = await writeVoicePlaybackArtifact({
      utteranceId,
      delivery: turn.tts,
      outputDir: callDir,
    })
    const audioUrl = routeUrl(
      options.publicBaseUrl,
      `${basePath}/audio/${encodeURIComponent(safeCallSid)}/${encodeURIComponent(path.basename(playback.audioPath))}`,
    )

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_turn_end",
      message: "finished Twilio voice turn",
      meta: { agentName: options.agentName, callSid: safeCallSid, recordingSid: safeRecordingSid, audioPath: playback.audioPath },
    })

    return xmlResponse(`${playTwiml(audioUrl)}${redirectTwiml(options.publicBaseUrl, basePath)}`)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_twilio_turn_error",
      message: "Twilio voice turn failed",
      meta: {
        agentName: options.agentName,
        callSid: safeCallSid,
        recordingSid: safeRecordingSid,
        error: errorMessage(error),
      },
    })
    return xmlResponse(`${sayTwiml("I could not process that audio. Please try again.")}${redirectTwiml(options.publicBaseUrl, basePath)}`)
  }
}

async function handleAudio(options: TwilioPhoneBridgeOptions, basePath: string, requestPath: string): Promise<TwilioPhoneBridgeResponse> {
  const prefix = `${basePath}/audio/`
  const pathOnly = requestPath.split("?")[0]!
  const rest = pathOnly.slice(prefix.length)
  const parts = rest.split("/")
  if (parts.length !== 2) return textResponse(404, "not found")
  const [callSidPart, fileNamePart] = parts as [string, string]
  const callSid = decodeSafeSegment(callSidPart)
  const fileName = decodeSafeSegment(fileNamePart)
  if (!callSid || !fileName) return textResponse(404, "not found")

  const baseDir = path.resolve(options.outputDir, callSid)
  const audioPath = path.resolve(baseDir, fileName)

  try {
    const audio = await fs.readFile(audioPath)
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_audio_served",
      message: "served Twilio voice audio artifact",
      meta: { agentName: options.agentName, callSid, fileName },
    })
    return binaryResponse(audio, contentTypeForAudio(fileName))
  } catch {
    return textResponse(404, "not found")
  }
}

export function createTwilioPhoneBridge(options: TwilioPhoneBridgeOptions): TwilioPhoneBridge {
  new URL(options.publicBaseUrl)
  const basePath = normalizeTwilioPhoneBasePath(options.basePath)

  return {
    async handle(request): Promise<TwilioPhoneBridgeResponse> {
      const method = request.method.toUpperCase()
      const requestPath = request.path.startsWith("/") ? request.path : `/${request.path}`
      const routePath = requestPath.split("?")[0]!
      if (method === "GET" && requestPath.startsWith(`${basePath}/audio/`)) {
        return handleAudio(options, basePath, requestPath)
      }
      if (method === "GET" && routePath === `${basePath}/health`) {
        return textResponse(200, "ok")
      }
      if (method !== "POST") return textResponse(405, "method not allowed")

      const params = formParams(bodyText(request.body))
      if (!verifyRequest(options, { ...request, path: requestPath }, params)) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.voice_twilio_signature_rejected",
          message: "rejected Twilio webhook with invalid signature",
          meta: { agentName: options.agentName, path: requestPath },
        })
        return textResponse(403, "invalid Twilio signature")
      }

      if (routePath === `${basePath}/incoming`) return handleIncoming(options, basePath)
      if (routePath === `${basePath}/listen`) return handleListen(options, basePath)
      if (routePath === `${basePath}/recording`) return handleRecording(options, basePath, params)
      return textResponse(404, "not found")
    },
  }
}

function readRequestBody(req: http.IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    req.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength
      if (byteLength > limitBytes) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

export async function startTwilioPhoneBridgeServer(
  options: StartTwilioPhoneBridgeServerOptions,
): Promise<TwilioPhoneBridgeServer> {
  const port = options.port ?? DEFAULT_TWILIO_PHONE_PORT
  const host = options.host ?? "127.0.0.1"
  const bridge = createTwilioPhoneBridge(options)
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req)
      const response = await bridge.handle({
        method: req.method as string,
        path: req.url as string,
        headers: req.headers,
        body,
      })
      res.writeHead(response.statusCode, response.headers)
      res.end(response.body)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_server_error",
        message: "Twilio voice bridge server failed a request",
        meta: { agentName: options.agentName, error: errorMessage(error) },
      })
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      res.end("internal server error")
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_server_start",
    message: "Twilio voice bridge server started",
    meta: { agentName: options.agentName, host, port, publicBaseUrl: options.publicBaseUrl },
  })

  const actualPort = (server.address() as { port: number }).port

  return {
    bridge,
    server,
    localUrl: `http://${host}:${actualPort}`,
  }
}
