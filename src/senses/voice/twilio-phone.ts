import * as crypto from "node:crypto"
import * as fs from "fs/promises"
import * as http from "http"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeVoicePlaybackArtifact } from "./playback"
import { buildVoiceTranscript } from "./transcript"
import { runVoiceLoopbackTurn, type VoiceLoopbackTurnResult, type VoiceRunSenseTurn } from "./turn"
import type { VoiceTranscript, VoiceTranscriber, VoiceTtsService } from "./types"

export const DEFAULT_TWILIO_PHONE_PORT = 18910
export const DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS = 2
export const DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS = 30
export const TWILIO_PHONE_WEBHOOK_BASE_PATH = "/voice/twilio"
export const DEFAULT_TWILIO_PHONE_PLAYBACK_MODE = "stream"

export type TwilioPhonePlaybackMode = "stream" | "buffered"

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
  body: string | Uint8Array | AsyncIterable<Uint8Array>
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
  downloadRecording?: TwilioRecordingDownloader
  playbackMode?: TwilioPhonePlaybackMode
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
  to: string
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

function streamResponse(body: AsyncIterable<Uint8Array>, contentType: string): TwilioPhoneBridgeResponse {
  return {
    statusCode: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
    body,
  }
}

function isAsyncIterableBody(body: TwilioPhoneBridgeResponse["body"]): body is AsyncIterable<Uint8Array> {
  return typeof body === "object"
    && body !== null
    && Symbol.asyncIterator in body
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

export function normalizeTwilioPhonePlaybackMode(value: string | undefined): TwilioPhonePlaybackMode {
  const normalized = (value ?? DEFAULT_TWILIO_PHONE_PLAYBACK_MODE).trim().toLowerCase()
  if (normalized === "stream" || normalized === "buffered") return normalized
  throw new Error(`invalid Twilio phone playback mode: ${value}`)
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

function voiceFriendId(options: TwilioPhoneBridgeOptions, from: string, callSid: string): string {
  return options.defaultFriendId?.trim() || friendIdFromCaller(from, callSid)
}

function phoneIdentitySegment(input: string): string {
  const phoneish = input.replace(/[^0-9A-Za-z]+/g, "")
  return phoneish || safeSegment(input)
}

export function twilioPhoneVoiceSessionKey(options: {
  defaultFriendId?: string
  from?: string
  to?: string
  callSid?: string
}): string {
  const friendSegment = options.defaultFriendId?.trim()
    ? safeSegment(options.defaultFriendId)
    : options.from?.trim()
      ? phoneIdentitySegment(options.from)
      : ""
  const lineSegment = options.to?.trim() ? phoneIdentitySegment(options.to) : ""
  if (friendSegment && lineSegment) return `twilio-phone-${friendSegment}-via-${lineSegment}`
  if (friendSegment) return `twilio-phone-${friendSegment}`
  if (lineSegment) return `twilio-phone-line-${lineSegment}`
  return `twilio-phone-${safeSegment(options.callSid ?? "incoming")}`
}

function callConnectedPrompt(params: Record<string, string>): string {
  const from = params.From?.trim()
  const to = params.To?.trim()
  return [
    "A Twilio phone voice call just connected.",
    "This is the first audible turn in the call.",
    from ? `Twilio caller ID: ${from}.` : "Twilio did not provide caller ID.",
    to ? `Dialed line: ${to}.` : "Twilio did not provide the dialed line.",
    "Respond through the voice channel as yourself. Greet the caller naturally and briefly, then invite them to speak.",
  ].join("\n")
}

function noSpeechPrompt(): string {
  return [
    "The last Twilio phone recording contained no intelligible speech.",
    "The caller is still on the line.",
    "Respond through the voice channel as yourself. Briefly ask them to try again or check whether they are there.",
  ].join("\n")
}

function isNoSpeechTranscript(text: string): boolean {
  const normalized = text.trim().replace(/[.!?]+$/g, "").toUpperCase()
  return normalized === "[BLANK_AUDIO]"
    || normalized === "BLANK_AUDIO"
    || normalized === "[NO_SPEECH]"
    || normalized === "NO_SPEECH"
}

function isNoSpeechTranscriptionError(error: unknown): boolean {
  const normalized = errorMessage(error).toLowerCase()
  return normalized.includes("empty whisper.cpp transcript")
    || normalized.includes("voice transcript text is empty")
}

function buildNoSpeechTranscript(utteranceId: string): VoiceTranscript {
  return buildVoiceTranscript({
    utteranceId: `${utteranceId}-nospeech`,
    text: noSpeechPrompt(),
    source: "loopback",
  })
}

async function transcribeRecordingOrNoSpeech(options: {
  transcriber: VoiceTranscriber
  utteranceId: string
  inputPath: string
}): Promise<VoiceTranscript> {
  try {
    const transcript = await options.transcriber.transcribe({
      utteranceId: options.utteranceId,
      audioPath: options.inputPath,
    })
    return isNoSpeechTranscript(transcript.text)
      ? buildNoSpeechTranscript(options.utteranceId)
      : transcript
  } catch (error) {
    if (isNoSpeechTranscriptionError(error)) {
      return buildNoSpeechTranscript(options.utteranceId)
    }
    throw error
  }
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
    to: params.To?.trim() ?? "",
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

function nextInputTwiml(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  mode: "record" | "redirect",
): string {
  if (mode === "redirect") return redirectTwiml(options.publicBaseUrl, basePath)
  return recordTwiml({
    publicBaseUrl: options.publicBaseUrl,
    basePath,
    timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
    maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  })
}

class TwilioAudioStreamJob {
  private readonly chunks: Buffer[] = []
  private readonly waiters = new Set<() => void>()
  private status: "pending" | "completed" | "failed" = "pending"
  private failure: string | null = null
  byteLength = 0

  constructor(
    readonly callSid: string,
    readonly jobId: string,
    readonly mimeType: string,
  ) {}

  append(chunk: Uint8Array): void {
    /* v8 ignore next -- append is only called while pending with non-empty chunks in bridge flow @preserve */
    if (this.status !== "pending" || chunk.byteLength === 0) return
    const buffered = Buffer.from(chunk)
    this.chunks.push(buffered)
    this.byteLength += buffered.byteLength
    this.notify()
  }

  complete(): void {
    /* v8 ignore next -- completion is single-shot inside startTwilioPlaybackStreamJob @preserve */
    if (this.status !== "pending") return
    this.status = "completed"
    this.notify()
  }

  fail(error: unknown): void {
    /* v8 ignore next -- failure is single-shot inside startTwilioPlaybackStreamJob @preserve */
    if (this.status !== "pending") return
    this.status = "failed"
    this.failure = errorMessage(error)
    this.notify()
  }

  async *stream(): AsyncIterable<Uint8Array> {
    let index = 0
    let yielded = false
    for (;;) {
      while (index < this.chunks.length) {
        yielded = true
        yield this.chunks[index++]!
      }
      if (this.status === "completed") return
      if (this.status === "failed") {
        if (yielded) return
        throw new Error(this.failure!)
      }
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve)
      })
    }
  }

  private notify(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const waiter of waiters) waiter()
  }
}

class TwilioAudioStreamJobStore {
  private readonly jobs = new Map<string, TwilioAudioStreamJob>()

  create(callSid: string, jobId: string, mimeType = "audio/mpeg"): TwilioAudioStreamJob {
    const key = this.key(callSid, jobId)
    const job = new TwilioAudioStreamJob(callSid, jobId, mimeType)
    this.jobs.set(key, job)
    return job
  }

  get(callSid: string, jobId: string): TwilioAudioStreamJob | null {
    return this.jobs.get(this.key(callSid, jobId)) ?? null
  }

  /* v8 ignore start -- stream job cleanup is delayed beyond request-scope tests @preserve */
  delete(callSid: string, jobId: string): void {
    this.jobs.delete(this.key(callSid, jobId))
  }
  /* v8 ignore stop */

  private key(callSid: string, jobId: string): string {
    return `${callSid}/${jobId}`
  }
}

function deliveredSegments(turn: VoiceLoopbackTurnResult): Array<Extract<VoiceLoopbackTurnResult["speechSegments"][number]["tts"], { status: "delivered" }>> {
  return turn.speechSegments.map((segment) => segment.tts)
}

async function writeVoiceTurnPlaybackArtifacts(options: {
  bridgeOptions: TwilioPhoneBridgeOptions
  basePath: string
  callDir: string
  safeCallSid: string
  baseUtteranceId: string
  turn: VoiceLoopbackTurnResult
}): Promise<string[]> {
  const urls: string[] = []
  for (const segment of options.turn.speechSegments) {
    const playback = await writeVoicePlaybackArtifact({
      utteranceId: segment.utteranceId,
      delivery: segment.tts,
      outputDir: options.callDir,
    })
    urls.push(routeUrl(
      options.bridgeOptions.publicBaseUrl,
      `${options.basePath}/audio/${encodeURIComponent(options.safeCallSid)}/${encodeURIComponent(path.basename(playback.audioPath))}`,
    ))
  }
  return urls
}

function playManyTwiml(urls: string[]): string {
  return urls.map(playTwiml).join("")
}

function streamAudioUrl(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  safeCallSid: string,
  jobId: string,
): string {
  return routeUrl(
    options.publicBaseUrl,
    `${basePath}/audio-stream/${encodeURIComponent(safeCallSid)}/${encodeURIComponent(`${jobId}.mp3`)}`,
  )
}

function scheduleJobCleanup(jobs: TwilioAudioStreamJobStore, safeCallSid: string, jobId: string): void {
  /* v8 ignore start -- stream job cleanup is delayed beyond request-scope tests @preserve */
  const cleanup = setTimeout(() => {
    jobs.delete(safeCallSid, jobId)
  }, 5 * 60_000)
  cleanup.unref?.()
  /* v8 ignore stop */
}

function startTwilioPlaybackStreamJob(options: {
  jobs: TwilioAudioStreamJobStore
  bridgeOptions: TwilioPhoneBridgeOptions
  basePath: string
  callDir: string
  safeCallSid: string
  jobId: string
  baseUtteranceId: string
  runTurn: (onAudioChunk: (chunk: Uint8Array) => void) => Promise<VoiceLoopbackTurnResult>
  meta: Record<string, string>
}): TwilioAudioStreamJob {
  const job = options.jobs.create(options.safeCallSid, options.jobId)
  void (async () => {
    try {
      const turn = await options.runTurn((chunk) => job.append(chunk))
      const deliveries = deliveredSegments(turn)
      if (job.byteLength === 0 && deliveries.length > 0) {
        for (const delivery of deliveries) job.append(delivery.audio)
      }
      if (deliveries.length === 0) {
        /* v8 ignore next -- runVoiceLoopbackTurn cannot return delivered TTS with zero speech segments @preserve */
        if (turn.tts.status === "failed") throw new Error(turn.tts.error)
        /* v8 ignore next -- runVoiceLoopbackTurn emits a speech segment whenever TTS is delivered @preserve */
        throw new Error("voice turn produced no audio")
      }

      try {
        await writeVoiceTurnPlaybackArtifacts({
          bridgeOptions: options.bridgeOptions,
          basePath: options.basePath,
          callDir: options.callDir,
          safeCallSid: options.safeCallSid,
          baseUtteranceId: options.baseUtteranceId,
          turn,
        })
      } catch (artifactError) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.voice_twilio_stream_artifact_error",
          message: "Twilio stream audio was delivered but artifact persistence failed",
          meta: { ...options.meta, error: errorMessage(artifactError) },
        })
      }

      job.complete()
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_stream_end",
        message: "finished Twilio streaming voice playback job",
        meta: { ...options.meta, byteLength: String(job.byteLength), segmentCount: String(deliveries.length) },
      })
    } catch (error) {
      job.fail(error)
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_stream_error",
        message: "Twilio streaming voice playback job failed",
        meta: { ...options.meta, error: errorMessage(error) },
      })
    } finally {
      scheduleJobCleanup(options.jobs, options.safeCallSid, options.jobId)
    }
  })()
  return job
}

async function runPhonePromptTurn(options: {
  bridgeOptions: TwilioPhoneBridgeOptions
  basePath: string
  callDir: string
  safeCallSid: string
  utteranceId: string
  friendId: string
  sessionKey: string
  promptText: string
  afterPlayback: "record" | "redirect"
}): Promise<TwilioPhoneBridgeResponse> {
  const transcript = buildVoiceTranscript({
    utteranceId: options.utteranceId,
    text: options.promptText,
    source: "loopback",
  })
  const turn = await runVoiceLoopbackTurn({
    agentName: options.bridgeOptions.agentName,
    friendId: options.friendId,
    sessionKey: options.sessionKey,
    transcript,
    tts: options.bridgeOptions.tts,
    runSenseTurn: options.bridgeOptions.runSenseTurn,
  })
  const after = nextInputTwiml(options.bridgeOptions, options.basePath, options.afterPlayback)

  if (turn.tts.status !== "delivered") {
    return xmlResponse(`${sayTwiml("voice output failed after the text response was captured.")}${after}`)
  }

  const audioUrls = await writeVoiceTurnPlaybackArtifacts({
    bridgeOptions: options.bridgeOptions,
    basePath: options.basePath,
    callDir: options.callDir,
    safeCallSid: options.safeCallSid,
    baseUtteranceId: options.utteranceId,
    turn,
  })

  return xmlResponse(`${playManyTwiml(audioUrls)}${after}`)
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

async function handleIncoming(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  params: Record<string, string>,
  jobs: TwilioAudioStreamJobStore,
): Promise<TwilioPhoneBridgeResponse> {
  const callSid = params.CallSid?.trim() || "incoming"
  const safeCallSid = safeSegment(callSid)
  const callDir = path.join(options.outputDir, safeCallSid)
  const utteranceId = `twilio-${safeCallSid}-connected`
  const friendId = voiceFriendId(options, params.From?.trim() ?? "", callSid)
  const sessionKey = twilioPhoneVoiceSessionKey({
    defaultFriendId: options.defaultFriendId,
    from: params.From?.trim() ?? "",
    to: params.To?.trim() ?? "",
    callSid,
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_incoming",
    message: "Twilio voice call connected",
    meta: { agentName: options.agentName, callSid: safeCallSid, sessionKey },
  })

  try {
    await fs.mkdir(callDir, { recursive: true })
    if (normalizeTwilioPhonePlaybackMode(options.playbackMode) === "stream") {
      const transcript = buildVoiceTranscript({
        utteranceId,
        text: callConnectedPrompt(params),
        source: "loopback",
      })
      const jobId = safeSegment(utteranceId)
      startTwilioPlaybackStreamJob({
        jobs,
        bridgeOptions: options,
        basePath,
        callDir,
        safeCallSid,
        jobId,
        baseUtteranceId: utteranceId,
        runTurn: (onAudioChunk) => runVoiceLoopbackTurn({
          agentName: options.agentName,
          friendId,
          sessionKey,
          transcript,
          tts: options.tts,
          runSenseTurn: options.runSenseTurn,
          onAudioChunk,
        }),
        meta: { agentName: options.agentName, callSid: safeCallSid, utteranceId },
      })
      return xmlResponse(`${playTwiml(streamAudioUrl(options, basePath, safeCallSid, jobId))}${nextInputTwiml(options, basePath, "record")}`)
    }

    return await runPhonePromptTurn({
      bridgeOptions: options,
      basePath,
      callDir,
      safeCallSid,
      utteranceId,
      friendId,
      sessionKey,
      promptText: callConnectedPrompt(params),
      afterPlayback: "record",
    })
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_twilio_incoming_error",
      message: "Twilio incoming voice greeting turn failed",
      meta: { agentName: options.agentName, callSid: safeCallSid, error: errorMessage(error) },
    })
    return xmlResponse(recordTwiml({
      publicBaseUrl: options.publicBaseUrl,
      basePath,
      timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
      maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
    }))
  }
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
  jobs: TwilioAudioStreamJobStore,
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
  const friendId = voiceFriendId(options, recording.from, recording.callSid)
  const sessionKey = twilioPhoneVoiceSessionKey({
    defaultFriendId: options.defaultFriendId,
    from: recording.from,
    to: recording.to,
    callSid: recording.callSid,
  })

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_turn_start",
    message: "starting Twilio voice turn",
    meta: { agentName: options.agentName, callSid: safeCallSid, recordingSid: safeRecordingSid, sessionKey },
  })

  try {
    if (normalizeTwilioPhonePlaybackMode(options.playbackMode) === "stream") {
      const jobId = safeSegment(utteranceId)
      startTwilioPlaybackStreamJob({
        jobs,
        bridgeOptions: options,
        basePath,
        callDir,
        safeCallSid,
        jobId,
        baseUtteranceId: utteranceId,
        runTurn: async (onAudioChunk) => {
          await fs.mkdir(callDir, { recursive: true })
          const mediaUrl = twilioRecordingMediaUrl(recording.recordingUrl)
          const audio = await downloadRecording({
            recordingUrl: mediaUrl,
            accountSid: options.twilioAccountSid?.trim() || undefined,
            authToken: options.twilioAuthToken?.trim() || undefined,
          })
          await fs.writeFile(inputPath, audio)
          const turnTranscript = await transcribeRecordingOrNoSpeech({
            transcriber: options.transcriber,
            utteranceId,
            inputPath,
          })
          return runVoiceLoopbackTurn({
            agentName: options.agentName,
            friendId,
            sessionKey,
            transcript: turnTranscript,
            tts: options.tts,
            runSenseTurn: options.runSenseTurn,
            onAudioChunk,
          })
        },
        meta: { agentName: options.agentName, callSid: safeCallSid, recordingSid: safeRecordingSid, utteranceId },
      })
      return xmlResponse(`${playTwiml(streamAudioUrl(options, basePath, safeCallSid, jobId))}${redirectTwiml(options.publicBaseUrl, basePath)}`)
    }

    await fs.mkdir(callDir, { recursive: true })
    const mediaUrl = twilioRecordingMediaUrl(recording.recordingUrl)
    const audio = await downloadRecording({
      recordingUrl: mediaUrl,
      accountSid: options.twilioAccountSid?.trim() || undefined,
      authToken: options.twilioAuthToken?.trim() || undefined,
    })
    await fs.writeFile(inputPath, audio)

    const transcript = await transcribeRecordingOrNoSpeech({
      transcriber: options.transcriber,
      utteranceId,
      inputPath,
    })

    if (transcript.utteranceId === `${utteranceId}-nospeech`) {
      return await runPhonePromptTurn({
        bridgeOptions: options,
        basePath,
        callDir,
        safeCallSid,
        utteranceId: `${utteranceId}-nospeech`,
        friendId,
        sessionKey,
        promptText: noSpeechPrompt(),
        afterPlayback: "redirect",
      })
    }

    const turn = await runVoiceLoopbackTurn({
      agentName: options.agentName,
      friendId,
      sessionKey,
      transcript,
      tts: options.tts,
      runSenseTurn: options.runSenseTurn,
    })

    if (turn.tts.status !== "delivered") {
      return xmlResponse(`${sayTwiml("voice output failed after the text response was captured.")}${redirectTwiml(options.publicBaseUrl, basePath)}`)
    }

    const audioUrls = await writeVoiceTurnPlaybackArtifacts({
      bridgeOptions: options,
      basePath,
      callDir,
      safeCallSid,
      baseUtteranceId: utteranceId,
      turn,
    })

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_turn_end",
      message: "finished Twilio voice turn",
      meta: { agentName: options.agentName, callSid: safeCallSid, recordingSid: safeRecordingSid, playbackCount: audioUrls.length },
    })

    return xmlResponse(`${playManyTwiml(audioUrls)}${redirectTwiml(options.publicBaseUrl, basePath)}`)
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

async function handleAudioStream(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  requestPath: string,
  jobs: TwilioAudioStreamJobStore,
): Promise<TwilioPhoneBridgeResponse> {
  const prefix = `${basePath}/audio-stream/`
  const pathOnly = requestPath.split("?")[0]!
  const rest = pathOnly.slice(prefix.length)
  const parts = rest.split("/")
  if (parts.length !== 2) return textResponse(404, "not found")
  const [callSidPart, fileNamePart] = parts as [string, string]
  const callSid = decodeSafeSegment(callSidPart)
  const fileName = decodeSafeSegment(fileNamePart)
  if (!callSid || !fileName) return textResponse(404, "not found")
  const jobId = fileName.replace(/\.[A-Za-z0-9]+$/, "")
  const job = jobs.get(callSid, jobId)
  if (!job) return textResponse(404, "not found")

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_stream_served",
    message: "served Twilio voice streaming audio job",
    meta: { agentName: options.agentName, callSid, jobId },
  })
  return streamResponse(job.stream(), job.mimeType)
}

export function createTwilioPhoneBridge(options: TwilioPhoneBridgeOptions): TwilioPhoneBridge {
  new URL(options.publicBaseUrl)
  const basePath = normalizeTwilioPhoneBasePath(options.basePath)
  const jobs = new TwilioAudioStreamJobStore()

  return {
    async handle(request): Promise<TwilioPhoneBridgeResponse> {
      const method = request.method.toUpperCase()
      const requestPath = request.path.startsWith("/") ? request.path : `/${request.path}`
      const routePath = requestPath.split("?")[0]!
      if (method === "GET" && requestPath.startsWith(`${basePath}/audio/`)) {
        return handleAudio(options, basePath, requestPath)
      }
      if (method === "GET" && requestPath.startsWith(`${basePath}/audio-stream/`)) {
        return handleAudioStream(options, basePath, requestPath, jobs)
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

      if (routePath === `${basePath}/incoming`) return handleIncoming(options, basePath, params, jobs)
      if (routePath === `${basePath}/listen`) return handleListen(options, basePath)
      if (routePath === `${basePath}/recording`) return handleRecording(options, basePath, params, jobs)
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

/* v8 ignore start -- HTTP backpressure is platform-dependent in unit tests @preserve */
function waitForDrain(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = (): void => {
      res.off("error", onError)
      resolve()
    }
    const onError = (error: Error): void => {
      res.off("drain", onDrain)
      reject(error)
    }
    res.once("drain", onDrain)
    res.once("error", onError)
  })
}
/* v8 ignore stop */

async function writeResponseBody(res: http.ServerResponse, body: TwilioPhoneBridgeResponse["body"]): Promise<void> {
  if (!isAsyncIterableBody(body)) {
    res.end(body)
    return
  }

  for await (const chunk of body) {
    /* v8 ignore next -- exercised only when Node reports socket backpressure @preserve */
    if (!res.write(chunk)) {
      await waitForDrain(res)
    }
  }
  res.end()
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
      await writeResponseBody(res, response.body)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_server_error",
        message: "Twilio voice bridge server failed a request",
        meta: { agentName: options.agentName, error: errorMessage(error) },
      })
      /* v8 ignore next -- defensive path for async stream failures after headers @preserve */
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)))
      } else {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        res.end("internal server error")
      }
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
