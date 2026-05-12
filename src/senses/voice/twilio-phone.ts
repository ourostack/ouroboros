import * as crypto from "node:crypto"
import * as fs from "fs/promises"
import * as http from "http"
import * as path from "path"
import type { Duplex } from "node:stream"
import type OpenAI from "openai"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import { saveSession, loadSession } from "../../mind/context"
import { getChannelCapabilities } from "../../mind/friends/channel"
import { FriendResolver } from "../../mind/friends/resolver"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendRecord, IdentityProvider, ResolvedContext } from "../../mind/friends/types"
import { getAgentRoot, setAgentName } from "../../heart/identity"
import { getSharedMcpManager } from "../../repertoire/mcp-manager"
import { execTool, getToolsForChannel } from "../../repertoire/tools"
import type { ToolContext } from "../../repertoire/tools-base"
import { sanitizeKey } from "../../heart/config"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeVoicePlaybackArtifact } from "./playback"
import { buildVoiceTranscript } from "./transcript"
import { runVoiceLoopbackTurn, type VoiceLoopbackTurnResult, type VoiceRunSenseTurn } from "./turn"
import type { VoiceTranscript, VoiceTranscriber, VoiceTtsService } from "./types"
import { normalizeTwilioE164PhoneNumber } from "./phone"
import { prepareVoiceCallAudio } from "./audio-playback"
import type { VoiceCallAudioRequest, VoiceCallAudioResult } from "../../repertoire/tools-base"
import { VoiceFloorController } from "./floor-controller"

export { normalizeTwilioE164PhoneNumber } from "./phone"

export const DEFAULT_TWILIO_PHONE_PORT = 18910
export const DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS = 1
export const DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS = 30
export const DEFAULT_TWILIO_GREETING_PREBUFFER_MS = 3_500
export const TWILIO_PHONE_WEBHOOK_BASE_PATH = "/voice/twilio"
export const DEFAULT_TWILIO_PHONE_PLAYBACK_MODE = "stream"
export const DEFAULT_TWILIO_PHONE_TRANSPORT_MODE = "record-play"
export const DEFAULT_TWILIO_MEDIA_SPEECH_RMS_THRESHOLD = 650
export const DEFAULT_TWILIO_MEDIA_SILENCE_END_MS = 450
export const DEFAULT_TWILIO_MEDIA_MIN_SPEECH_MS = 120
export const DEFAULT_TWILIO_MEDIA_MAX_UTTERANCE_MS = 15_000

const TWILIO_MEDIA_HANGUP_FALLBACK_MS = 10_000

const TWILIO_STREAM_FAILURE_SILENCE_MP3 = Buffer.from(
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/+0DAAAAAAAAAAAAAAAAAAAAAAABJbmZvAAAADwAAAAsAAAUuADc3Nzc3Nzc3N0tLS0tLS0tLS19fX19fX19fX3Nzc3Nzc3Nzc4eHh4eHh4eHh5ubm5ubm5ubm6+vr6+vr6+vr8PDw8PDw8PDw9fX19fX19fX1+vr6+vr6+vr6////////////wAAAABMYXZjNjIuMTEAAAAAAAAAAAAAAAAkBC8AAAAAAAAFLpJQTFMAAAAAAP/7EMQAA8AAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxCmDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDEUwPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVf/7EMR8g8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVV//sQxKYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVX/+xDEz4PAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDE1gPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMTWA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxNYDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=",
  "base64",
)

export type TwilioPhonePlaybackMode = "stream" | "buffered"
export type TwilioPhoneTransportMode = "record-play" | "media-stream"
export type TwilioPhoneConversationEngine = "cascade" | "openai-realtime" | "openai-sip"

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

export interface TwilioOutboundCallJobEvent {
  at: string
  status: string
  callSid?: string
  answeredBy?: string
}

export interface TwilioOutboundPrewarmedGreeting {
  utteranceId: string
  audioPath: string
  mimeType: string
  byteLength: number
  preparedAt: string
}

export interface TwilioOutboundCallJob {
  schemaVersion: 1
  outboundId: string
  agentName: string
  friendId?: string
  to: string
  from: string
  reason: string
  createdAt: string
  transportCallSid?: string
  status?: string
  answeredBy?: string
  updatedAt?: string
  events?: TwilioOutboundCallJobEvent[]
  error?: string
  prewarmedGreeting?: TwilioOutboundPrewarmedGreeting
  initialAudio?: VoiceCallAudioRequest
}

export interface TwilioOutboundCallCreateRequest {
  accountSid: string
  authToken: string
  to: string
  from: string
  twimlUrl: string
  statusCallbackUrl?: string
  machineDetection?: "Enable" | "DetectMessageEnd"
  asyncAmd?: boolean
  asyncAmdStatusCallbackUrl?: string
}

export interface TwilioOutboundCallCreateResult {
  callSid?: string
  status?: string
  queueTime?: string
}

export type TwilioOutboundCallFetch = (input: string, init: RequestInit) => Promise<Response>

export interface TwilioPhoneBridgeOptions {
  agentName: string
  agentRoot?: string
  publicBaseUrl: string
  outputDir: string
  basePath?: string
  transcriber: VoiceTranscriber
  tts: VoiceTtsService
  runSenseTurn?: VoiceRunSenseTurn
  twilioAccountSid?: string
  twilioAuthToken?: string
  twilioFromNumber?: string
  defaultFriendId?: string
  recordTimeoutSeconds?: number
  recordMaxLengthSeconds?: number
  greetingPrebufferMs?: number
  transportMode?: TwilioPhoneTransportMode
  mediaSpeechRmsThreshold?: number
  mediaSilenceEndMs?: number
  mediaMinSpeechMs?: number
  mediaMaxUtteranceMs?: number
  downloadRecording?: TwilioRecordingDownloader
  playbackMode?: TwilioPhonePlaybackMode
  conversationEngine?: TwilioPhoneConversationEngine
  outboundConversationEngine?: TwilioPhoneConversationEngine
  openaiRealtime?: OpenAIRealtimeTwilioOptions
  openaiSip?: OpenAISipPhoneOptions
}

export interface OpenAIRealtimeTwilioOptions {
  apiKey: string
  apiKeySource?: string
  model?: string
  voice?: string
  voiceStyle?: string
  voiceSpeed?: number
  websocketUrl?: string
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"
  noiseReduction?: "near_field" | "far_field" | "none"
  turnDetection?: {
    mode?: "server_vad" | "semantic_vad"
    threshold?: number
    prefixPaddingMs?: number
    silenceDurationMs?: number
    idleTimeoutMs?: number
    eagerness?: "low" | "medium" | "high" | "auto"
    createResponse?: boolean
    interruptResponse?: boolean
  }
}

export interface OpenAISipPhoneOptions {
  projectId?: string
  webhookPath?: string
  webhookSecret?: string
  allowUnsignedWebhooks?: boolean
  apiBaseUrl?: string
  websocketBaseUrl?: string
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}

export interface TwilioPhoneBridge {
  handle(request: TwilioPhoneBridgeRequest): Promise<TwilioPhoneBridgeResponse>
  handleUpgrade?(request: http.IncomingMessage, socket: Duplex, head: Buffer): boolean
  close?(): Promise<void>
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

export function normalizeTwilioPhoneTransportMode(value: string | undefined): TwilioPhoneTransportMode {
  const normalized = (value ?? DEFAULT_TWILIO_PHONE_TRANSPORT_MODE).trim().toLowerCase()
  if (normalized === "record-play" || normalized === "media-stream") return normalized
  throw new Error(`invalid Twilio phone transport mode: ${value}`)
}

export function normalizeTwilioPhoneConversationEngine(value: string | undefined): TwilioPhoneConversationEngine {
  const normalized = (value ?? "cascade").trim().toLowerCase()
  if (normalized === "cascade" || normalized === "openai-realtime" || normalized === "openai-sip") return normalized
  throw new Error(`invalid Twilio phone conversation engine: ${value}`)
}

function usesOpenAIRealtimeConversationEngine(options: TwilioPhoneBridgeOptions): boolean {
  return normalizeTwilioPhoneConversationEngine(options.conversationEngine) === "openai-realtime"
}

function usesOpenAISipConversationEngine(options: TwilioPhoneBridgeOptions): boolean {
  return normalizeTwilioPhoneConversationEngine(options.conversationEngine) === "openai-sip"
}

function outboundConversationEngine(options: TwilioPhoneBridgeOptions): TwilioPhoneConversationEngine {
  return normalizeTwilioPhoneConversationEngine(options.outboundConversationEngine ?? options.conversationEngine)
}

function usesOpenAIRealtimeOutboundConversationEngine(options: TwilioPhoneBridgeOptions): boolean {
  return outboundConversationEngine(options) === "openai-realtime"
}

function usesOpenAISipOutboundConversationEngine(options: TwilioPhoneBridgeOptions): boolean {
  return outboundConversationEngine(options) === "openai-sip"
}

export function twilioPhoneWebhookUrl(
  publicBaseUrl: string,
  basePath: string | undefined = TWILIO_PHONE_WEBHOOK_BASE_PATH,
): string {
  return routeUrl(publicBaseUrl, `${normalizeTwilioPhoneBasePath(basePath)}/incoming`)
}

export function openAISipWebhookPath(agentName: string): string {
  return `/voice/agents/${safeSegment(agentName.toLowerCase())}/sip/openai`
}

export function openAISipWebhookUrl(
  publicBaseUrl: string,
  webhookPath: string,
): string {
  return routeUrl(publicBaseUrl, normalizeTwilioPhoneBasePath(webhookPath))
}

export function twilioOutboundCallWebhookUrl(
  publicBaseUrl: string,
  basePath: string | undefined,
  outboundId: string,
): string {
  return routeUrl(publicBaseUrl, `${normalizeTwilioPhoneBasePath(basePath)}/outgoing/${encodeURIComponent(safeSegment(outboundId))}`)
}

export function twilioOutboundCallStatusCallbackUrl(
  publicBaseUrl: string,
  basePath: string | undefined,
  outboundId: string,
): string {
  return routeUrl(publicBaseUrl, `${normalizeTwilioPhoneBasePath(basePath)}/outgoing/${encodeURIComponent(safeSegment(outboundId))}/status`)
}

export function twilioOutboundCallAmdCallbackUrl(
  publicBaseUrl: string,
  basePath: string | undefined,
  outboundId: string,
): string {
  return routeUrl(publicBaseUrl, `${normalizeTwilioPhoneBasePath(basePath)}/outgoing/${encodeURIComponent(safeSegment(outboundId))}/amd`)
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

function parameterTwiml(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return ""
  return `<Parameter name="${escapeXml(name)}" value="${escapeXml(trimmed)}" />`
}

function websocketRouteUrl(publicBaseUrl: string, route: string): string {
  const url = new URL(route, publicBaseUrl)
  /* v8 ignore next -- resolveTwilioPhoneTransportRuntime rejects non-HTTPS public URLs before runtime start @preserve */
  if (url.protocol !== "https:") {
    throw new Error("Twilio Media Streams require an https public voice URL")
  }
  url.protocol = "wss:"
  return url.toString()
}

function mediaStreamTwiml(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  params: Record<string, string>,
  greetingJobId?: string,
  customParams: Record<string, string | undefined> = {},
  streamEngine?: TwilioPhoneConversationEngine,
): string {
  const streamRoute = streamEngine ? `${basePath}/media-stream?engine=${encodeURIComponent(streamEngine)}` : `${basePath}/media-stream`
  const streamUrl = websocketRouteUrl(options.publicBaseUrl, streamRoute)
  const twimlParams: Record<string, string | undefined> = {
    From: params.From,
    To: params.To,
    Agent: options.agentName,
    ...customParams,
    GreetingJobId: greetingJobId,
  }
  return [
    `<Connect><Stream url="${escapeXml(streamUrl)}">`,
    ...Object.entries(twimlParams).map(([name, value]) => parameterTwiml(name, value)),
    `</Stream></Connect>`,
  ].join("")
}

/* v8 ignore start -- private SIP URI query permutations are exercised through bridge routes; the queryless helper shape is not externally reachable today @preserve */
function openAISipUri(
  options: TwilioPhoneBridgeOptions,
  customHeaders: Record<string, string | undefined> = {},
): string {
  const projectId = options.openaiSip?.projectId?.trim()
  /* v8 ignore next -- SIP runtime resolution requires projectId before the bridge is started @preserve */
  if (!projectId) {
    throw new Error("missing voice.openaiSipProjectId; configure the OpenAI project id before routing phone calls over SIP")
  }
  const headers = new URLSearchParams()
  for (const [name, value] of Object.entries(customHeaders)) {
    const trimmed = value?.trim()
    if (!trimmed) continue
    headers.set(name, trimmed)
  }
  const query = headers.toString()
  return `sip:${projectId}@sip.api.openai.com;transport=tls${query ? `?${query}` : ""}`
}

function openAISipDialTwiml(
  options: TwilioPhoneBridgeOptions,
  customHeaders: Record<string, string | undefined> = {},
): string {
  return `<Dial><Sip>${escapeXml(openAISipUri(options, customHeaders))}</Sip></Dial>`
}
/* v8 ignore stop */

function safeSegment(input: string): string {
  const cleaned = input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "unknown"
}

function nonHumanAnsweredStatus(answeredBy: string | undefined): "voicemail" | "fax" | undefined {
  const normalized = answeredBy?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === "fax") return "fax"
  if (normalized.startsWith("machine")) return "voicemail"
  return undefined
}

/* v8 ignore start -- exact voicemail menu phrase permutations vary by carrier; bridge tests cover the voicemail-menu behavior path @preserve */
function isVoicemailMenuTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  if (!normalized) return false
  return normalized.includes("if you re satisfied with the message")
    || normalized.includes("if you are satisfied with the message")
    || (
      normalized.includes("press 1")
      && normalized.includes("listen to your message")
      && normalized.includes("erase")
      && normalized.includes("rerecord")
    )
}
/* v8 ignore stop */

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

interface ResolvedVoiceFriendContext {
  friendId: string
  friendStore: FileFriendStore
  resolved: ResolvedContext
}

async function resolveVoiceFriendContext(options: TwilioPhoneBridgeOptions, input: {
  friendId?: string
  remotePhone?: string
  callSid: string
}): Promise<ResolvedVoiceFriendContext> {
  const agentRoot = options.agentRoot ?? getAgentRoot(options.agentName)
  const friendStore = new FileFriendStore(path.join(agentRoot, "friends"))
  const explicitFriendId = input.friendId?.trim()
  if (explicitFriendId) {
    const existing = await friendStore.get(explicitFriendId)
    if (existing) {
      return {
        friendId: existing.id,
        friendStore,
        resolved: { friend: existing, channel: getChannelCapabilities("voice") },
      }
    }
  }

  const remotePhone = normalizeTwilioE164PhoneNumber(input.remotePhone)
  const provider: IdentityProvider = remotePhone ? "imessage-handle" : "local"
  const externalId = remotePhone || explicitFriendId || voiceFriendId(options, input.remotePhone ?? "", input.callSid)
  const resolver = new FriendResolver(friendStore, {
    provider,
    externalId,
    displayName: remotePhone || externalId,
    channel: "voice",
  })
  const resolved = await resolver.resolve()
  return { friendId: resolved.friend.id, friendStore, resolved }
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

export function outboundCallAnsweredPrompt(job: TwilioOutboundCallJob, params: Record<string, string>): string {
  const from = params.From?.trim() || job.from
  const to = params.To?.trim() || job.to
  return [
    "A Twilio outbound phone voice call was answered.",
    "This is the first audible turn in a call I chose to place.",
    `Call reason/context: ${job.reason.trim() || "No additional reason was recorded."}`,
    to ? `Callee phone: ${to}.` : "Twilio did not provide the callee phone.",
    from ? `Ouro phone line: ${from}.` : "Twilio did not provide the Ouro phone line.",
    "Respond through the voice channel as yourself. Briefly greet them and state why you called. Keep this first turn short and conversational.",
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

interface TwilioMediaStreamStart {
  streamSid?: unknown
  callSid?: unknown
  customParameters?: unknown
}

interface TwilioMediaPayload {
  payload?: unknown
}

interface TwilioMediaMark {
  name?: unknown
}

interface TwilioMediaStreamMessage {
  event?: unknown
  streamSid?: unknown
  start?: TwilioMediaStreamStart
  media?: TwilioMediaPayload
  mark?: TwilioMediaMark
}

/* v8 ignore start -- ws RawData variants are provider/runtime transport shapes; session tests cover valid and invalid stream behavior @preserve */
function parseTwilioMediaStreamMessage(raw: RawData): TwilioMediaStreamMessage | null {
  const text = Buffer.isBuffer(raw)
    ? raw.toString("utf8")
    : Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.from(raw as ArrayBuffer).toString("utf8")
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" ? parsed as TwilioMediaStreamMessage : null
  } catch { /* v8 ignore next -- invalid provider socket JSON is observed at the session boundary @preserve */
    return null
  }
}
/* v8 ignore stop */

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/* v8 ignore start -- custom parameter shape validation is defensive around Twilio payloads; stream behavior tests cover the supported object shape @preserve */
function customParameter(start: TwilioMediaStreamStart | undefined, name: string): string {
  const params = start?.customParameters
  if (!params || typeof params !== "object" || Array.isArray(params)) return ""
  return stringField((params as Record<string, unknown>)[name])
}
/* v8 ignore stop */

/* v8 ignore start -- Twilio custom parameter field-combination branches are exercised through outbound route behavior; exact sparse-object permutations are not first-class logic @preserve */
function encodeVoiceCallAudioCustomParameter(request: VoiceCallAudioRequest | undefined): string | undefined {
  if (!request) return undefined
  const value = JSON.stringify({
    ...(request.source ? { source: request.source } : {}),
    ...(request.url ? { url: request.url } : {}),
    ...(request.path ? { path: request.path } : {}),
    ...(request.label ? { label: request.label } : {}),
    ...(Number.isFinite(request.toneHz) ? { toneHz: request.toneHz } : {}),
    ...(Number.isFinite(request.durationMs) ? { durationMs: request.durationMs } : {}),
  })
  return value.length <= 1_500 ? value : undefined
}

function decodeVoiceCallAudioCustomParameter(value: string): VoiceCallAudioRequest | undefined {
  if (!value.trim()) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const source = record.source === "tone" || record.source === "url" || record.source === "file"
      ? record.source
      : undefined
    return {
      ...(source ? { source } : {}),
      ...(typeof record.url === "string" && record.url.trim() ? { url: record.url.trim() } : {}),
      ...(typeof record.path === "string" && record.path.trim() ? { path: record.path.trim() } : {}),
      ...(typeof record.label === "string" && record.label.trim() ? { label: record.label.trim() } : {}),
      ...(typeof record.toneHz === "number" && Number.isFinite(record.toneHz) ? { toneHz: record.toneHz } : {}),
      ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
    }
  } catch { /* v8 ignore next -- invalid Twilio custom parameter JSON is treated as absent audio metadata @preserve */
    return undefined
  }
}
/* v8 ignore stop */

function mulawByteToPcm16(value: number): number {
  const decoded = (~value) & 0xff
  let sample = ((decoded & 0x0f) << 3) + 0x84
  sample <<= (decoded & 0x70) >> 4
  return (decoded & 0x80) ? 0x84 - sample : sample - 0x84
}

/* v8 ignore start -- empty media frames are a defensive provider edge; barge-in behavior is covered through non-empty frame tests @preserve */
function mulawFrameRms(frame: Uint8Array): number {
  if (frame.byteLength === 0) return 0
  let sumSquares = 0
  for (const byte of frame) {
    const sample = mulawByteToPcm16(byte)
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / frame.byteLength)
}
/* v8 ignore stop */

function pcm16WavHeader(dataByteLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataByteLength, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(dataByteLength, 40)
  return header
}

function mulawFramesToPcm16Wav(frames: Uint8Array[], sampleRate = 16_000): Buffer {
  const sampleCount = frames.reduce((sum, frame) => sum + frame.byteLength, 0) * 2
  const pcm = Buffer.alloc(sampleCount * 2)
  let offset = 0
  for (const frame of frames) {
    for (const byte of frame) {
      const sample = mulawByteToPcm16(byte)
      pcm.writeInt16LE(sample, offset)
      offset += 2
      pcm.writeInt16LE(sample, offset)
      offset += 2
    }
  }
  return Buffer.concat([pcm16WavHeader(pcm.byteLength, sampleRate), pcm])
}

function frameLimitForMs(ms: number, frameMs = 20): number {
  return Math.max(1, Math.ceil(ms / frameMs))
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

interface TwilioMediaStreamUtterance {
  utteranceId: string
  frames: Buffer[]
  wasBargeIn: boolean
}

interface TwilioMediaStreamLifecycleSession {
  attach(): void
  end(): void
}

/* v8 ignore start -- legacy cascade Media Streams socket loop is covered by bridge-level WebSocket tests; per-event socket/error permutations are transport-runtime edges @preserve */
class TwilioMediaStreamSession {
  private streamSid = ""
  private callSid = "media-stream"
  private direction = ""
  private outboundId = ""
  private from = ""
  private to = ""
  private friendId = ""
  private sessionKey = ""
  private callDir = ""
  private utteranceIndex = 0
  private playbackGeneration = 0
  private playbackActive = false
  private closed = false
  private inSpeech = false
  private currentFrames: Buffer[] = []
  private preRollFrames: Buffer[] = []
  private currentVoicedFrames = 0
  private currentSilenceFrames = 0
  private currentWasBargeIn = false
  private turnQueue: Promise<void> = Promise.resolve()
  private hangupRequested = false
  private hangupReason = ""
  private hangupFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private readonly playbackBytesByGeneration = new Map<number, number>()
  private readonly speechRmsThreshold: number
  private readonly preRollLimitFrames = frameLimitForMs(200)
  private readonly silenceEndFrames: number
  private readonly minSpeechFrames: number
  private readonly maxUtteranceFrames: number

  constructor(
    private readonly ws: WebSocket,
    private readonly options: TwilioPhoneBridgeOptions,
    private readonly mediaGreetingJobs: TwilioAudioStreamJobStore,
    private readonly lifecycle?: {
      onIdentityChange?: (session: TwilioMediaStreamLifecycleSession, identity: { callSid: string; outboundId: string }) => void
      onClose?: (session: TwilioMediaStreamLifecycleSession, identity: { callSid: string; outboundId: string }) => void
    },
  ) {
    this.speechRmsThreshold = options.mediaSpeechRmsThreshold ?? DEFAULT_TWILIO_MEDIA_SPEECH_RMS_THRESHOLD
    this.silenceEndFrames = frameLimitForMs(options.mediaSilenceEndMs ?? DEFAULT_TWILIO_MEDIA_SILENCE_END_MS)
    this.minSpeechFrames = frameLimitForMs(options.mediaMinSpeechMs ?? DEFAULT_TWILIO_MEDIA_MIN_SPEECH_MS)
    this.maxUtteranceFrames = frameLimitForMs(options.mediaMaxUtteranceMs ?? DEFAULT_TWILIO_MEDIA_MAX_UTTERANCE_MS)
  }

  attach(): void {
    this.ws.on("message", (raw) => this.handleRawMessage(raw))
    this.ws.on("close", () => this.close())
    this.ws.on("error", (error) => {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_media_socket_error",
        message: "Twilio Media Stream socket failed",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), error: errorMessage(error) },
      })
    })
  }

  end(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
    this.close()
  }

  private handleRawMessage(raw: RawData): void {
    const message = parseTwilioMediaStreamMessage(raw)
    if (!message) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_twilio_media_message_rejected",
        message: "Twilio Media Stream message was not valid JSON",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid) },
      })
      return
    }

    const event = stringField(message.event)
    if (event === "start") {
      void this.handleStart(message.start)
      return
    }
    if (event === "media") {
      this.handleMedia(message.media)
      return
    }
    if (event === "mark") {
      this.handleMark(message.mark)
      return
    }
    if (event === "stop") {
      this.close()
    }
  }

  private async handleStart(start: TwilioMediaStreamStart | undefined): Promise<void> {
    this.streamSid = stringField(start?.streamSid)
    this.callSid = stringField(start?.callSid) || this.callSid
    const direction = customParameter(start, "Direction")
    this.direction = direction
    this.outboundId = customParameter(start, "OutboundId")
    const explicitFriendId = customParameter(start, "FriendId")
    if (direction === "outbound") {
      this.from = customParameter(start, "Remote") || customParameter(start, "To")
      this.to = customParameter(start, "Line") || customParameter(start, "From")
    } else {
      this.from = customParameter(start, "From")
      this.to = customParameter(start, "To")
    }
    this.friendId = explicitFriendId || voiceFriendId(this.options, this.from, this.callSid)
    this.sessionKey = twilioPhoneVoiceSessionKey({
      defaultFriendId: explicitFriendId || this.options.defaultFriendId,
      from: this.from,
      to: this.to,
      callSid: this.callSid,
    })
    this.lifecycle?.onIdentityChange?.(this, { callSid: this.callSid, outboundId: this.outboundId })
    this.callDir = path.join(this.options.outputDir, safeSegment(this.callSid))
    await fs.mkdir(this.callDir, { recursive: true })

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_start",
      message: "Twilio Media Stream started",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        streamSid: safeSegment(this.streamSid || "stream"),
        sessionKey: this.sessionKey,
      },
    })

    const greetingJobId = customParameter(start, "GreetingJobId")
    const greetingJob = greetingJobId
      ? this.mediaGreetingJobs.get(safeSegment(this.callSid), greetingJobId)
      : null
    if (greetingJob) {
      this.enqueueGreetingJob(greetingJobId, greetingJob)
    } else {
      this.enqueuePrompt({
        utteranceId: `twilio-${safeSegment(this.callSid)}-connected`,
        promptText: callConnectedPrompt({ From: this.from, To: this.to }),
        wasBargeIn: false,
      })
    }
  }

  private handleMedia(media: TwilioMediaPayload | undefined): void {
    const payload = stringField(media?.payload)
    if (!payload) return
    const frame = Buffer.from(payload, "base64")
    if (frame.byteLength === 0) return
    const voiced = mulawFrameRms(frame) >= this.speechRmsThreshold
    const bargeIn = voiced && this.interruptPlayback()

    if (!this.inSpeech) {
      if (voiced) {
        this.inSpeech = true
        this.currentFrames = [...this.preRollFrames, frame]
        this.preRollFrames = []
        this.currentVoicedFrames = 1
        this.currentSilenceFrames = 0
        this.currentWasBargeIn = bargeIn
      } else {
        this.preRollFrames.push(frame)
        if (this.preRollFrames.length > this.preRollLimitFrames) {
          this.preRollFrames.shift()
        }
      }
      return
    }

    this.currentFrames.push(frame)
    if (voiced) {
      this.currentVoicedFrames += 1
      this.currentSilenceFrames = 0
      this.currentWasBargeIn = this.currentWasBargeIn || bargeIn
    } else {
      this.currentSilenceFrames += 1
    }

    if (this.currentSilenceFrames >= this.silenceEndFrames || this.currentFrames.length >= this.maxUtteranceFrames) {
      this.finishCurrentUtterance()
    }
  }

  private handleMark(mark: TwilioMediaMark | undefined): void {
    const name = stringField(mark?.name)
    if (!name || !name.startsWith(`voice-${this.playbackGeneration}-`)) return
    this.playbackActive = false
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_playback_mark",
      message: "Twilio Media Stream playback mark reached",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), mark: name },
    })
    this.completeHangupIfRequested("playback_mark")
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.clearHangupFallback()
    if (this.inSpeech) this.finishCurrentUtterance()
    this.playbackGeneration += 1
    this.playbackActive = false
    this.lifecycle?.onClose?.(this, { callSid: this.callSid, outboundId: this.outboundId })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_stop",
      message: "Twilio Media Stream stopped",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid) },
    })
  }

  private finishCurrentUtterance(): void {
    const frames = this.currentFrames
    const voicedFrames = this.currentVoicedFrames
    const wasBargeIn = this.currentWasBargeIn
    this.inSpeech = false
    this.currentFrames = []
    this.currentVoicedFrames = 0
    this.currentSilenceFrames = 0
    this.currentWasBargeIn = false

    if (voicedFrames < this.minSpeechFrames) return

    this.utteranceIndex += 1
    this.enqueueUtterance({
      utteranceId: `twilio-${safeSegment(this.callSid)}-${this.utteranceIndex}`,
      frames,
      wasBargeIn,
    })
  }

  private enqueuePrompt(input: { utteranceId: string; promptText: string; wasBargeIn: boolean }): void {
    const transcript = buildVoiceTranscript({
      utteranceId: input.utteranceId,
      text: input.promptText,
      source: "loopback",
    })
    this.enqueueTurn(transcript, input.wasBargeIn)
  }

  private enqueueUtterance(utterance: TwilioMediaStreamUtterance): void {
    this.turnQueue = this.turnQueue
      .catch(() => undefined)
      .then(() => this.processUtterance(utterance))
      .catch((error) => {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_twilio_media_turn_error",
          message: "Twilio Media Stream voice turn failed",
          meta: {
            agentName: this.options.agentName,
            callSid: safeSegment(this.callSid),
            utteranceId: utterance.utteranceId,
            error: errorMessage(error),
          },
        })
      })
  }

  private enqueueGreetingJob(jobId: string, job: TwilioAudioStreamJob): void {
    this.turnQueue = this.turnQueue
      .catch(() => undefined)
      .then(() => this.streamGreetingJob(jobId, job))
      .catch((error) => {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_twilio_media_turn_error",
          message: "Twilio Media Stream greeting playback failed",
          meta: {
            agentName: this.options.agentName,
            callSid: safeSegment(this.callSid),
            utteranceId: jobId,
            error: errorMessage(error),
          },
        })
      })
  }

  private enqueueTurn(transcript: VoiceTranscript, wasBargeIn: boolean): void {
    this.turnQueue = this.turnQueue
      .catch(() => undefined)
      .then(() => this.runTranscriptTurn(transcript, wasBargeIn))
      .catch((error) => {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.voice_twilio_media_turn_error",
          message: "Twilio Media Stream voice turn failed",
          meta: {
            agentName: this.options.agentName,
            callSid: safeSegment(this.callSid),
            utteranceId: transcript.utteranceId,
            error: errorMessage(error),
          },
        })
      })
  }

  private async processUtterance(utterance: TwilioMediaStreamUtterance): Promise<void> {
    await fs.mkdir(this.callDir, { recursive: true })
    const inputPath = path.join(this.callDir, `${safeSegment(utterance.utteranceId)}.wav`)
    await fs.writeFile(inputPath, mulawFramesToPcm16Wav(utterance.frames))
    const transcript = await transcribeRecordingOrNoSpeech({
      transcriber: this.options.transcriber,
      utteranceId: utterance.utteranceId,
      inputPath,
    })
    if (this.direction === "outbound" && isVoicemailMenuTranscript(transcript.text)) {
      if (this.outboundId) {
        await updateTwilioOutboundCallJob(this.options.outputDir, this.outboundId, {
          status: "voicemail",
          answeredBy: "voicemail_menu",
          transportCallSid: this.callSid,
        }).catch(() => null)
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_voicemail_menu_detected",
        message: "Twilio outbound voice stream detected voicemail menu",
        meta: {
          agentName: this.options.agentName,
          callSid: safeSegment(this.callSid),
          outboundId: safeSegment(this.outboundId || "unknown"),
        },
      })
      this.ws.close()
      this.close()
      return
    }
    const turnTranscript = utterance.wasBargeIn
      ? buildVoiceTranscript({
          utteranceId: transcript.utteranceId,
          text: [
            "The caller spoke while my previous voice output was still playing.",
            "Treat this as an interruption or follow-up, acknowledge it first, and do not repeat the interrupted answer unless it is still useful.",
            `Caller said: ${transcript.text}`,
          ].join("\n"),
          audioPath: transcript.audioPath ?? undefined,
          language: transcript.language ?? undefined,
          source: transcript.source,
        })
      : transcript
    await this.runTranscriptTurn(turnTranscript, utterance.wasBargeIn)
  }

  private async runTranscriptTurn(transcript: VoiceTranscript, wasBargeIn: boolean): Promise<void> {
    if (this.closed || !this.streamSid) return
    const generation = this.startPlayback()
    const turn = await runVoiceLoopbackTurn({
      agentName: this.options.agentName,
      friendId: this.friendId || voiceFriendId(this.options, this.from, this.callSid),
      sessionKey: this.sessionKey || twilioPhoneVoiceSessionKey({
        defaultFriendId: this.options.defaultFriendId,
        from: this.from,
        to: this.to,
        callSid: this.callSid,
      }),
      transcript,
      tts: this.options.tts,
      runSenseTurn: this.options.runSenseTurn,
      onAudioChunk: (chunk) => this.sendAudioChunk(chunk, generation),
      voiceCall: {
        requestEnd: (reason) => this.requestHangupAfterPlayback(reason),
        playAudio: (request) => this.playPreparedAudio(request),
      },
    })

    if (generation !== this.playbackGeneration || this.closed) return
    const deliveries = deliveredSegments(turn)
    if ((this.playbackBytesByGeneration.get(generation) ?? 0) === 0) {
      for (const delivery of deliveries) {
        this.sendAudioChunk(delivery.audio, generation)
      }
    }
    if (deliveries.length === 0) {
      this.playbackActive = false
      this.completeHangupIfRequested("no_playback")
      return
    }
    this.sendMark(generation, transcript.utteranceId)
    if (this.hangupRequested) this.armHangupFallback()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_turn_end",
      message: "Twilio Media Stream voice turn delivered playback",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        utteranceId: transcript.utteranceId,
        bargeIn: String(wasBargeIn),
        segmentCount: String(turn.speechSegments.length),
      },
    })
  }

  private async streamGreetingJob(jobId: string, job: TwilioAudioStreamJob): Promise<void> {
    if (this.closed || !this.streamSid) return
    const generation = this.startPlayback()
    try {
      for await (const chunk of job.stream()) {
        if (generation !== this.playbackGeneration || this.closed) return
        this.sendAudioChunk(chunk, generation)
      }
    } catch (error) {
      if (generation === this.playbackGeneration) this.playbackActive = false
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_media_greeting_error",
        message: "Twilio Media Stream prebuffered greeting failed",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), utteranceId: jobId, error: errorMessage(error) },
      })
      return
    }

    if (generation !== this.playbackGeneration || this.closed) return
    if ((this.playbackBytesByGeneration.get(generation) ?? 0) === 0) {
      this.playbackActive = false
      return
    }
    this.sendMark(generation, jobId)
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_greeting_end",
      message: "Twilio Media Stream prebuffered greeting delivered playback",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        utteranceId: jobId,
        byteLength: String(this.playbackBytesByGeneration.get(generation) ?? 0),
      },
    })
  }

  private startPlayback(): number {
    this.playbackGeneration += 1
    this.playbackActive = true
    this.clearHangupFallback()
    return this.playbackGeneration
  }

  private sendAudioChunk(chunk: Uint8Array, generation: number): void {
    if (this.closed || generation !== this.playbackGeneration || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: Buffer.from(chunk).toString("base64") },
    }))
    this.playbackBytesByGeneration.set(
      generation,
      (this.playbackBytesByGeneration.get(generation) ?? 0) + chunk.byteLength,
    )
  }

  private sendMark(generation: number, utteranceId: string): void {
    if (this.closed || generation !== this.playbackGeneration || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      event: "mark",
      streamSid: this.streamSid,
      mark: { name: `voice-${generation}-${safeSegment(utteranceId)}` },
    }))
  }

  private async playPreparedAudio(request: VoiceCallAudioRequest): Promise<VoiceCallAudioResult> {
    const prepared = await prepareVoiceCallAudio(request, {
      agentRoot: this.options.agentRoot ?? getAgentRoot(this.options.agentName),
    })
    const generation = this.startPlayback()
    for (let offset = 0; offset < prepared.audio.byteLength; offset += 160) {
      if (this.closed || generation !== this.playbackGeneration) break
      this.sendAudioChunk(prepared.audio.subarray(offset, offset + 160), generation)
      await delay(20)
    }
    if (!this.closed && generation === this.playbackGeneration) {
      this.sendMark(generation, `audio-${prepared.label}`)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_tool_audio_played",
      message: "played tool-requested audio into Twilio Media Stream call",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        label: prepared.label,
        durationMs: String(prepared.durationMs),
      },
    })
    return { label: prepared.label, durationMs: prepared.durationMs }
  }

  private interruptPlayback(): boolean {
    if (!this.playbackActive || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return false
    this.cancelPendingHangup("barge_in")
    this.playbackGeneration += 1
    this.playbackActive = false
    this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }))
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_barge_in",
      message: "caller interrupted Twilio Media Stream playback",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid) },
    })
    return true
  }

  private requestHangupAfterPlayback(reason?: string): void {
    if (this.closed) return
    this.hangupRequested = true
    this.hangupReason = typeof reason === "string" ? reason : ""
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_hangup_requested",
      message: "agent requested Twilio Media Stream hangup",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        reasonLength: String(this.hangupReason.length),
        playbackActive: String(this.playbackActive),
      },
    })
    if (!this.playbackActive) this.armHangupFallback()
  }

  private completeHangupIfRequested(trigger: string): void {
    if (!this.hangupRequested || this.closed) return
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_hangup_end",
      message: "ending Twilio Media Stream after agent hangup request",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), trigger },
    })
    this.end()
  }

  private cancelPendingHangup(trigger: string): void {
    if (!this.hangupRequested) return
    this.hangupRequested = false
    this.hangupReason = ""
    this.clearHangupFallback()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_media_hangup_cancelled",
      message: "cancelled Twilio Media Stream hangup request",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), trigger },
    })
  }

  private armHangupFallback(): void {
    if (!this.hangupRequested || this.closed || this.hangupFallbackTimer) return
    this.hangupFallbackTimer = setTimeout(() => {
      this.hangupFallbackTimer = null
      this.completeHangupIfRequested("fallback_timer")
    }, TWILIO_MEDIA_HANGUP_FALLBACK_MS)
    this.hangupFallbackTimer.unref?.()
  }

  private clearHangupFallback(): void {
    if (!this.hangupFallbackTimer) return
    clearTimeout(this.hangupFallbackTimer)
    this.hangupFallbackTimer = null
  }
}
/* v8 ignore stop */

const REALTIME_TOOL_FLOW_NAMES = new Set(["speak", "settle", "rest", "observe", "ponder"])
const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-2"
const OPENAI_REALTIME_DEFAULT_VOICE = "cedar"
const OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper"
const OPENAI_REALTIME_BOOTSTRAP_TIMEOUT_MS = 250
const OPENAI_REALTIME_PCMS_BYTES_PER_MS = 8
const OPENAI_REALTIME_DEFAULT_NOISE_REDUCTION: NonNullable<OpenAIRealtimeTwilioOptions["noiseReduction"]> = "near_field"
const OPENAI_REALTIME_DEFAULT_VAD_THRESHOLD = 0.78
const OPENAI_REALTIME_DEFAULT_VAD_PREFIX_PADDING_MS = 300
const OPENAI_REALTIME_DEFAULT_VAD_SILENCE_DURATION_MS = 900
const OPENAI_REALTIME_DEFAULT_VAD_IDLE_TIMEOUT_MS = 7_000
const OPENAI_REALTIME_MAX_OUTPUT_TOKENS = 220
const OPENAI_REALTIME_BARGE_IN_MIN_SPEECH_MS = 260
const OPENAI_REALTIME_BARGE_IN_RMS_THRESHOLD = 1_300
const OPENAI_REALTIME_MIN_VOICE_SPEED = 0.25
const OPENAI_REALTIME_MAX_VOICE_SPEED = 1.5
const OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS = 50
const OPENAI_REALTIME_RESPONSE_CREATE_CONFLICT_BACKOFF_MS = 1_000
const OPENAI_REALTIME_TOOL_PRESENCE_DELAY_MS = 900
const OPENAI_REALTIME_USER_TURN_RESPONSE_DELAY_MS = 1_000
const OPENAI_SIP_OUTBOUND_AMD_GREETING_TIMEOUT_MS = 10_000

interface RealtimePlaybackMark {
  itemId: string
  contentIndex: number
  audioEndMs: number
}

interface RealtimePlaybackState {
  itemId: string
  contentIndex: number
  sentMs: number
  playedMs: number
}

interface RealtimeToolResponseState {
  pendingCallIds: Set<string>
  responseDone: boolean
  followupRequested: boolean
  suppressFollowup: boolean
  presenceRequested: boolean
  presenceTimer: ReturnType<typeof setTimeout> | null
}

interface PendingRealtimeResponseRequest {
  response?: Record<string, unknown>
}

interface OpenAISipHeader {
  name?: unknown
  value?: unknown
}

interface OpenAISipWebhookEvent {
  type?: unknown
  data?: {
    call_id?: unknown
    sip_headers?: unknown
  }
}

interface OpenAISipCallMetadata {
  callId: string
  from: string
  to: string
  direction: string
  outboundId: string
  reason: string
  friendId: string
}

interface OpenAISipPhoneSessionRegistry {
  register(session: OpenAISipPhoneSession): void
  unregister(session: OpenAISipPhoneSession): void
  getByOutboundId(outboundId: string): OpenAISipPhoneSession | undefined
}

const OPENAI_SIP_UNSUPPORTED_TOOL_NAMES = new Set<string>()
const OPENAI_SIP_DEFAULT_API_BASE_URL = "https://api.openai.com/v1"
const OPENAI_SIP_DEFAULT_WEBSOCKET_BASE_URL = "wss://api.openai.com/v1/realtime"

/* v8 ignore start -- OpenAI Realtime/SIP provider adapter helpers are exercised through bridge-level SIP/Realtimes tests; branch permutations are provider-shape fallbacks @preserve */
function openAIRealtimeWebSocketUrl(options: OpenAIRealtimeTwilioOptions): string {
  return options.websocketUrl?.trim()
    || `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL)}`
}

export function computeOpenAIWebhookSignature(input: {
  secret: string
  webhookId?: string
  timestamp: string
  payload: string
}): string {
  const secret = input.secret.startsWith("whsec_")
    ? Buffer.from(input.secret.slice("whsec_".length), "base64")
    : Buffer.from(input.secret, "utf8")
  const signedPayload = input.webhookId
    ? `${input.webhookId}.${input.timestamp}.${input.payload}`
    : `${input.timestamp}.${input.payload}`
  return crypto.createHmac("sha256", secret).update(signedPayload).digest("base64")
}

export function validateOpenAIWebhookSignature(input: {
  secret: string
  headers: Record<string, string | string[] | undefined>
  payload: string
  toleranceSeconds?: number
  nowSeconds?: number
}): boolean {
  const secret = input.secret.trim()
  if (!secret) return false
  const timestamp = headerValue(input.headers, "webhook-timestamp")
  const signatureHeader = headerValue(input.headers, "webhook-signature")
  const webhookId = headerValue(input.headers, "webhook-id")
  if (!timestamp || !signatureHeader) return false
  const timestampSeconds = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(timestampSeconds)) return false
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const toleranceSeconds = input.toleranceSeconds ?? 300
  if (nowSeconds - timestampSeconds > toleranceSeconds) return false
  if (timestampSeconds - nowSeconds > toleranceSeconds) return false

  const expected = Buffer.from(computeOpenAIWebhookSignature({
    secret,
    webhookId: webhookId || undefined,
    timestamp,
    payload: input.payload,
  }))
  for (const candidate of signatureHeader.split(" ")) {
    const raw = candidate.trim()
    if (!raw) continue
    const signature = Buffer.from(raw.startsWith("v1,") ? raw.slice(3) : raw)
    if (signature.length === expected.length && crypto.timingSafeEqual(signature, expected)) return true
  }
  return false
}

function openAISipCallActionUrl(options: OpenAISipPhoneOptions, callId: string, action: "accept" | "hangup" | "reject"): string {
  const base = (options.apiBaseUrl?.trim() || OPENAI_SIP_DEFAULT_API_BASE_URL).replace(/\/+$/, "")
  return `${base}/realtime/calls/${encodeURIComponent(callId)}/${action}`
}

function openAISipControlWebSocketUrl(options: OpenAISipPhoneOptions, callId: string): string {
  const url = new URL(options.websocketBaseUrl?.trim() || OPENAI_SIP_DEFAULT_WEBSOCKET_BASE_URL)
  url.searchParams.set("call_id", callId)
  return url.toString()
}

function parseOpenAISipWebhookEvent(rawBody: string): OpenAISipWebhookEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown
    return parsed && typeof parsed === "object" ? parsed as OpenAISipWebhookEvent : null
  } catch {
    return null
  }
}

function openAISipHeaders(value: unknown): OpenAISipHeader[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is OpenAISipHeader => item && typeof item === "object")
}

function openAISipHeaderValue(headers: OpenAISipHeader[], name: string): string {
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (stringField(header.name).toLowerCase() === wanted) return stringField(header.value)
  }
  return ""
}

function phoneFromSipHeader(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  const tel = trimmed.match(/tel:([^>;]+)/i)?.[1]
  if (tel) return tel.trim()
  const sip = trimmed.match(/sip:([^@>;]+)/i)?.[1]
  if (sip) return sip.trim()
  const bracketed = trimmed.match(/<([^>]+)>/)?.[1]
  return bracketed?.trim() || trimmed
}

function openAISipCallMetadata(event: OpenAISipWebhookEvent): OpenAISipCallMetadata | null {
  const data = event.data
  if (!data || typeof data !== "object") return null
  const callId = stringField(data.call_id)
  if (!callId) return null
  const headers = openAISipHeaders(data.sip_headers)
  const from = openAISipHeaderValue(headers, "X-Ouro-From") || phoneFromSipHeader(openAISipHeaderValue(headers, "From"))
  const to = openAISipHeaderValue(headers, "X-Ouro-To") || phoneFromSipHeader(openAISipHeaderValue(headers, "To"))
  const friendId = openAISipHeaderValue(headers, "X-Ouro-Friend-Id")
  return {
    callId,
    from,
    to,
    direction: openAISipHeaderValue(headers, "X-Ouro-Direction") || "inbound",
    outboundId: openAISipHeaderValue(headers, "X-Ouro-Outbound-Id"),
    reason: openAISipHeaderValue(headers, "X-Ouro-Reason"),
    friendId,
  }
}

function openAISipCallConnectedPrompt(metadata: OpenAISipCallMetadata, voiceStyle?: string): string {
  const styleLine = voiceStyle?.trim()
    ? `Phone voice target for this first turn: ${voiceStyle.trim()}`
    : ""
  if (metadata.direction === "outbound") {
    return [
      "An outbound phone voice call just connected over OpenAI SIP.",
      "This is the first audible turn in a call I chose to place.",
      styleLine,
      `Call reason/context: ${metadata.reason.trim() || "No additional reason was recorded."}`,
      metadata.from ? `Callee phone: ${metadata.from}.` : "The callee phone number was not provided.",
      metadata.to ? `Ouro phone line: ${metadata.to}.` : "The Ouro phone line was not provided.",
      "Respond through the voice channel as yourself. Briefly greet them and state why you called. Keep this first turn short and conversational.",
    ].filter(Boolean).join("\n")
  }
  return [
    "A phone voice call just connected over OpenAI SIP.",
    "This is the first audible turn in the call.",
    styleLine,
    metadata.from ? `Caller phone: ${metadata.from}.` : "Caller phone was not provided.",
    metadata.to ? `Dialed line: ${metadata.to}.` : "Dialed line was not provided.",
    "Respond through the voice channel as yourself. Greet the caller naturally and briefly, then invite them to speak.",
  ].filter(Boolean).join("\n")
}

function openAISipResponseHeaders(params: Record<string, string>, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    "X-Ouro-Agent": params.Agent,
    "X-Ouro-Direction": params.Direction,
    "X-Ouro-From": params.From,
    "X-Ouro-To": params.To,
    ...extra,
  }
}

function boundedNumber(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

function boundedInteger(value: number | undefined, min: number, max: number): number | undefined {
  const bounded = boundedNumber(value, min, max)
  return bounded === undefined ? undefined : Math.round(bounded)
}

function realtimeNoiseReductionConfig(
  realtime: OpenAIRealtimeTwilioOptions,
): { type: "near_field" | "far_field" } | null {
  const mode = realtime.noiseReduction ?? OPENAI_REALTIME_DEFAULT_NOISE_REDUCTION
  if (mode === "none") return null
  return { type: mode }
}

function realtimeTurnDetectionConfig(
  realtime: OpenAIRealtimeTwilioOptions,
  overrides: { createResponse?: boolean; interruptResponse?: boolean } = {},
): Record<string, unknown> {
  const turnDetection = realtime.turnDetection
  const createResponse = overrides.createResponse ?? turnDetection?.createResponse ?? true
  const interruptResponse = overrides.interruptResponse ?? turnDetection?.interruptResponse ?? false
  if (turnDetection?.mode === "semantic_vad") {
    return {
      type: "semantic_vad",
      create_response: createResponse,
      interrupt_response: interruptResponse,
      eagerness: turnDetection.eagerness ?? "medium",
    }
  }
  return {
    type: "server_vad",
    create_response: createResponse,
    interrupt_response: interruptResponse,
    threshold: boundedNumber(turnDetection?.threshold, 0, 1) ?? OPENAI_REALTIME_DEFAULT_VAD_THRESHOLD,
    prefix_padding_ms: boundedInteger(turnDetection?.prefixPaddingMs, 0, 2_000) ?? OPENAI_REALTIME_DEFAULT_VAD_PREFIX_PADDING_MS,
    silence_duration_ms: boundedInteger(turnDetection?.silenceDurationMs, 100, 2_000) ?? OPENAI_REALTIME_DEFAULT_VAD_SILENCE_DURATION_MS,
    idle_timeout_ms: boundedInteger(turnDetection?.idleTimeoutMs, 5_000, 30_000) ?? OPENAI_REALTIME_DEFAULT_VAD_IDLE_TIMEOUT_MS,
  }
}

function realtimeVoiceSpeed(realtime: OpenAIRealtimeTwilioOptions): number | undefined {
  return boundedNumber(realtime.voiceSpeed, OPENAI_REALTIME_MIN_VOICE_SPEED, OPENAI_REALTIME_MAX_VOICE_SPEED)
}

function realtimeOutputAudioConfig(
  realtime: OpenAIRealtimeTwilioOptions,
  format?: { type: "audio/pcmu" },
): Record<string, unknown> {
  const speed = realtimeVoiceSpeed(realtime)
  return {
    ...(format ? { format } : {}),
    voice: realtime.voice?.trim() || OPENAI_REALTIME_DEFAULT_VOICE,
    ...(speed === undefined ? {} : { speed }),
  }
}

function realtimeToolsFromChatTools(
  tools: OpenAI.ChatCompletionFunctionTool[],
  excludedToolNames: Set<string> = new Set(),
): Array<{ type: "function"; name: string; description?: string; parameters?: unknown }> {
  return tools
    .filter((tool) => !REALTIME_TOOL_FLOW_NAMES.has(tool.function.name) && !excludedToolNames.has(tool.function.name))
    .map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters ?? { type: "object", properties: {} },
    }))
}

function mediaStreamRequestedConversationEngine(url: string | undefined): TwilioPhoneConversationEngine | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url, "wss://localhost")
    const engine = parsed.searchParams.get("engine") ?? undefined
    return engine ? normalizeTwilioPhoneConversationEngine(engine) : undefined
  } catch {
    return undefined
  }
}

function parseToolArguments(raw: string): Record<string, string> {
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const args: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      args[key] = value
    } else if (value === undefined) {
      args[key] = ""
    } else {
      args[key] = JSON.stringify(value)
    }
  }
  return args
}

function transcriptMessageText(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const recent = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-8)
    .map((message) => {
      const content = typeof message.content === "string" ? message.content.trim() : ""
      return content ? `${message.role}: ${content}` : ""
    })
    .filter(Boolean)
  if (recent.length === 0) return ""
  return [
    "Recent durable voice transcript for this same voice session:",
    ...recent,
  ].join("\n")
}

function looksLikeShortHumanPhoneGreeting(transcript: string): boolean {
  const normalized = transcript.trim().toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ")
  if (!normalized) return false
  const words = normalized.split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 6) return false
  const text = words.join(" ")
  if (/\b(voicemail|mailbox|unavailable|leave|message|reached|record)\b/.test(text)) return false
  return /^(hi|hello|hey|yo|yes|yeah|yep|ari|slugger)(\b|$)/.test(text)
}

async function readOptionalText(filePath: string, maxChars: number): Promise<string> {
  try {
    const text = (await fs.readFile(filePath, "utf8")).trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars).trim()}\n[truncated for low-latency voice]`
  } catch {
    return ""
  }
}

async function buildRealtimeVoiceInstructions(options: {
  agentName: string
  agentRoot: string
  friend?: FriendRecord
  priorTranscript: string
  realtimeVoice?: string
  realtimeVoiceStyle?: string
  realtimeVoiceSpeed?: number
  realtimeModel?: string
  audioToolMode?: "media-stream" | "realtime-cue" | "none"
}): Promise<string> {
  const psycheDir = path.join(options.agentRoot, "psyche")
  const [soul, identity, tacit] = await Promise.all([
    readOptionalText(path.join(psycheDir, "SOUL.md"), 1_600),
    readOptionalText(path.join(psycheDir, "IDENTITY.md"), 3_200),
    readOptionalText(path.join(psycheDir, "TACIT.md"), 1_400),
  ])
  return [
    `You are ${options.agentName} in the live Voice sense.`,
    "This is the same agent identity as every other Ouro surface. Voice is not a reduced or alternate self.",
    `Never identify yourself as ChatGPT, GPT, an AI model, an OpenAI assistant, or "powered by" any provider. You are ${options.agentName}. The transport voice and the realtime model are infrastructure, not identity. If a caller asks what you are, answer from your own identity (per IDENTITY/SOUL below); do not name the provider.`,
    options.friend ? `Resolved voice friend: ${options.friend.name || options.friend.id} (friendId=${options.friend.id}, trust=${options.friend.trustLevel ?? "friend"}, role=${options.friend.role ?? "friend"}). Use this same friend record and trust context for relationship awareness and tool permissions across voice, text, mail, and every other sense.` : "",
    `Current native Realtime provider config for this call: model=${options.realtimeModel?.trim() || OPENAI_REALTIME_DEFAULT_MODEL}, voice=${options.realtimeVoice?.trim() || OPENAI_REALTIME_DEFAULT_VOICE}${options.realtimeVoiceSpeed === undefined ? "" : `, speed=${options.realtimeVoiceSpeed}`}.`,
    options.realtimeVoiceStyle?.trim()
      ? `Phone voice target: ${options.realtimeVoiceStyle.trim()}`
      : "",
    "Speak as yourself through live audio. Follow voice/style preferences from identity notes; do not say you lack identity, preferences, or agency because the provider voice is configured by the transport.",
    "Audio is synchronous. Default to one short sentence. Use two short sentences only when needed. Do not use markdown, lists, or long explanations unless the caller explicitly asks.",
    "Speak at a calm, unhurried pace. Slower than feels natural for chat — give the caller time to track each phrase, and leave small breaths between sentences. Never rush a reply.",
    "Do not jump in on the caller's silence. Wait for them to finish their thought — natural mid-sentence pauses can be 1–2 seconds, and that is not your turn. Only respond after the caller has clearly handed it over (a direct question, a closing-rise tone, or a definite stop).",
    "If the caller interrupts, stop the older path and answer the newest thing first.",
    "If the caller says they are counting, measuring latency, testing lag, waiting, or wants you quiet, say at most 'got it' and then stay silent until they ask or say something that needs an answer.",
    "Use tools for outside facts or side effects. While a tool is running, give at most one tiny preamble, then summarize the result compactly when it returns.",
    options.audioToolMode === "none"
      ? "This voice lane cannot inject non-speech audio. If the caller asks for a tone, clip, or sample, answer transparently and offer a spoken alternative."
      : options.audioToolMode === "realtime-cue"
        ? "If the caller asks for a beep or tone, use voice_play_audio with source=tone. This direct SIP lane can ask Realtime to render short audio cues, but arbitrary URL/file clip bytes still require a media bridge; if the tool reports that limitation, explain it briefly."
        : "If the caller asks to hear audio, a tone, a sample, or a clip, use voice_play_audio; people on phone calls can do more than talk.",
    "If the caller is done, asks to hang up, or you need to end the call, say a brief natural goodbye first, then call voice_end_call. After voice_end_call, do not say anything else.",
    soul ? `# SOUL\n${soul}` : "",
    identity ? `# IDENTITY\n${identity}` : "",
    tacit ? `# TACIT\n${tacit}` : "",
    options.priorTranscript,
  ].filter(Boolean).join("\n\n")
}

function realtimeBootstrapInstructions(agentName: string, voiceStyle?: string): string {
  return [
    `You are ${agentName} on a live phone call.`,
    voiceStyle?.trim() ? `Phone voice target: ${voiceStyle.trim()}.` : "",
    "Speak naturally through live audio. Keep turns very short, answer quickly, and accept interruptions immediately.",
    "If the caller is done or asks to end the call, say a brief goodbye and call voice_end_call.",
  ].filter(Boolean).join(" ")
}

function realtimeBootstrapTools(): Array<{ type: "function"; name: string; description?: string; parameters?: unknown }> {
  return realtimeToolsFromChatTools(getToolsForChannel(getChannelCapabilities("voice")))
}

function timeoutAfter(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms)
    timer.unref?.()
  })
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function realtimeResponseId(event: Record<string, unknown>): string {
  const direct = stringField(event.response_id)
  if (direct) return direct
  const response = event.response
  if (!response || typeof response !== "object" || Array.isArray(response)) return ""
  return stringField((response as Record<string, unknown>).id)
}

function pcmuPayloadDurationMs(payload: string): number {
  const byteLength = Buffer.from(payload, "base64").byteLength
  if (byteLength <= 0) return 0
  return Math.max(1, Math.round(byteLength / OPENAI_REALTIME_PCMS_BYTES_PER_MS))
}
/* v8 ignore stop */

/* v8 ignore start -- Twilio Media Streams Realtime bridge is a fallback transport; direct SIP is the primary low-latency path and WebSocket integration tests cover representative behavior @preserve */
class TwilioOpenAIRealtimeMediaStreamSession implements TwilioMediaStreamLifecycleSession {
  private streamSid = ""
  private callSid = "media-stream"
  private direction = ""
  private outboundId = ""
  private outboundReason = ""
  private from = ""
  private to = ""
  private friendId = ""
  private sessionKey = ""
  private sessionPath = ""
  private closed = false
  private openaiReady = false
  private greetingSent = false
  private hangupRequested = false
  private pendingAudioPayloads: string[] = []
  private openaiWs: WebSocket | null = null
  private toolContext: ToolContext | undefined
  private friendStore: FileFriendStore | undefined
  private resolvedContext: ResolvedContext | undefined
  private sessionMessages: OpenAI.ChatCompletionMessageParam[] = []
  private playbackState: RealtimePlaybackState | undefined
  private playbackMarkIndex = 0
  private readonly playbackMarks = new Map<string, RealtimePlaybackMark>()
  private readonly toolResponses = new Map<string, RealtimeToolResponseState>()
  private readonly completedRealtimeResponseIds = new Set<string>()
  private activeRealtimeResponseId: string | null = null
  private realtimeResponseCreateInFlight: PendingRealtimeResponseRequest | null = null
  private untrackedActiveRealtimeResponse = false
  private untrackedActiveRealtimeResponseTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRealtimeResponse: PendingRealtimeResponseRequest | null = null
  private pendingRealtimeResponseTimer: ReturnType<typeof setTimeout> | null = null
  private pendingUserTurnResponseTimer: ReturnType<typeof setTimeout> | null = null
  private responseCreateHoldUntilMs = 0
  private initialAudio: VoiceCallAudioRequest | undefined
  private initialAudioPlayed = false
  private callerBargeInSpeechMs = 0
  private lastCallerBargeInSpeechAt = 0
  private floor: VoiceFloorController = new VoiceFloorController({ transport: "twilio-media-stream" })
  private floorUnsubscribe: (() => void) | null = null
  private queuedGatedRealtimeRequest: PendingRealtimeResponseRequest | null = null
  private activeCallerTurnId: string | undefined
  private callerTurnSequence = 0
  private gatedResponseRequestSequence = 0
  private pendingGatedResponseId: string | null = null

  constructor(
    private readonly ws: WebSocket,
    private readonly options: TwilioPhoneBridgeOptions,
    private readonly lifecycle?: {
      onIdentityChange?: (session: TwilioMediaStreamLifecycleSession, identity: { callSid: string; outboundId: string }) => void
      onClose?: (session: TwilioMediaStreamLifecycleSession, identity: { callSid: string; outboundId: string }) => void
    },
  ) {}

  attach(): void {
    this.ws.on("message", (raw) => this.handleRawMessage(raw))
    this.ws.on("close", () => this.close())
    this.ws.on("error", (error) => {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_realtime_socket_error",
        message: "Twilio OpenAI Realtime socket failed",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), error: errorMessage(error) },
      })
    })
  }

  end(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
    this.close()
  }

  private handleRawMessage(raw: RawData): void {
    const message = parseTwilioMediaStreamMessage(raw)
    if (!message) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_twilio_realtime_message_rejected",
        message: "Twilio OpenAI Realtime message was not valid JSON",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid) },
      })
      return
    }

    const event = stringField(message.event)
    if (event === "start") {
      void this.handleStart(message.start)
      return
    }
    if (event === "media") {
      this.handleMedia(message.media)
      return
    }
    if (event === "mark") {
      this.handleMark(message.mark)
      return
    }
    if (event === "stop") {
      this.close()
    }
  }

  private async handleStart(start: TwilioMediaStreamStart | undefined): Promise<void> {
    this.streamSid = stringField(start?.streamSid)
    this.callSid = stringField(start?.callSid) || this.callSid
    this.direction = customParameter(start, "Direction")
    this.outboundId = customParameter(start, "OutboundId")
    this.outboundReason = customParameter(start, "Reason")
    this.initialAudio = decodeVoiceCallAudioCustomParameter(customParameter(start, "InitialAudio"))
    const explicitFriendId = customParameter(start, "FriendId")
    if (this.direction === "outbound") {
      this.from = customParameter(start, "Remote") || customParameter(start, "To")
      this.to = customParameter(start, "Line") || customParameter(start, "From")
    } else {
      this.from = customParameter(start, "From")
      this.to = customParameter(start, "To")
    }
    const voiceContext = await resolveVoiceFriendContext(this.options, {
      friendId: explicitFriendId,
      remotePhone: this.from || undefined,
      callSid: this.callSid,
    })
    this.friendId = voiceContext.friendId
    this.friendStore = voiceContext.friendStore
    this.resolvedContext = voiceContext.resolved
    this.sessionKey = twilioPhoneVoiceSessionKey({
      defaultFriendId: this.friendId,
      from: this.from,
      to: this.to,
      callSid: this.callSid,
    })
    this.lifecycle?.onIdentityChange?.(this, { callSid: this.callSid, outboundId: this.outboundId })
    this.floor = new VoiceFloorController({
      transport: "twilio-media-stream",
      agentName: this.options.agentName,
      callId: this.callSid,
    })
    this.floorUnsubscribe = this.floor.onTransition(() => this.flushQueuedGatedRealtimeRequest())
    this.floor.apply({ type: "call.connected", atMs: Date.now(), callId: this.callSid })

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_realtime_start",
      message: "Twilio OpenAI Realtime stream started",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        sessionKey: this.sessionKey,
      },
    })

    try {
      await this.startOpenAIRealtimeSession()
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_realtime_start_error",
        message: "Twilio OpenAI Realtime stream could not connect",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), error: errorMessage(error) },
      })
      this.end()
    }
  }

  private async startOpenAIRealtimeSession(): Promise<void> {
    const realtime = this.options.openaiRealtime
    if (!realtime?.apiKey?.trim()) {
      throw new Error("OpenAI Realtime API key is not configured")
    }

    this.ensureVoiceToolContext()
    const instructionsPromise = this.buildInstructions()
      .catch(() => realtimeBootstrapInstructions(this.options.agentName))
    const toolsPromise = this.buildRealtimeTools()
      .then((tools) => realtimeToolsFromChatTools(tools))
      .catch(() => realtimeBootstrapTools())
    const ws = new WebSocket(openAIRealtimeWebSocketUrl(realtime), {
      headers: {
        Authorization: `Bearer ${realtime.apiKey.trim()}`,
        "OpenAI-Safety-Identifier": safeSegment(`${this.options.agentName}-${this.friendId}`),
      },
    })
    this.openaiWs = ws

    ws.on("open", () => {
      this.openaiReady = true
      void this.configureOpenAIRealtimeSession(realtime, instructionsPromise, toolsPromise)
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_realtime_openai_open",
        message: "OpenAI Realtime session connected for Twilio call",
        meta: {
          agentName: this.options.agentName,
          callSid: safeSegment(this.callSid),
          model: realtime.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL,
          voice: realtime.voice?.trim() || OPENAI_REALTIME_DEFAULT_VOICE,
          apiKeySource: realtime.apiKeySource ?? "unknown",
        },
      })
    })

    ws.on("message", (raw) => this.handleOpenAIMessage(raw))
    ws.on("close", () => {
      this.openaiReady = false
      if (!this.closed) this.end()
    })
    ws.on("error", (error) => {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_realtime_openai_error",
        message: "OpenAI Realtime socket failed during Twilio call",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), error: errorMessage(error) },
      })
    })
  }

  private async configureOpenAIRealtimeSession(
    realtime: OpenAIRealtimeTwilioOptions,
    instructionsPromise: Promise<string>,
    toolsPromise: Promise<Array<{ type: "function"; name: string; description?: string; parameters?: unknown }>>,
  ): Promise<void> {
    const ready = await Promise.race([
      Promise.all([instructionsPromise, toolsPromise] as const),
      timeoutAfter(OPENAI_REALTIME_BOOTSTRAP_TIMEOUT_MS),
    ])
    const usedBootstrap = ready === undefined
    const [instructions, tools] = ready ?? [
      realtimeBootstrapInstructions(this.options.agentName, realtime.voiceStyle),
      realtimeBootstrapTools(),
    ]
    this.sendOpenAIRealtimeSessionUpdate(realtime, instructions, tools)
    this.flushPendingAudio()
    this.sendInitialGreeting()

    if (!usedBootstrap) return
    Promise.all([instructionsPromise, toolsPromise] as const)
      .then(([fullInstructions, fullTools]) => {
        if (this.closed) return
        this.sendOpenAI({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: fullInstructions,
            tools: fullTools,
            tool_choice: "auto",
          },
        })
      })
      .catch(() => undefined)
  }

  private sendOpenAIRealtimeSessionUpdate(
    realtime: OpenAIRealtimeTwilioOptions,
    instructions: string,
    tools: Array<{ type: "function"; name: string; description?: string; parameters?: unknown }>,
  ): void {
    this.sendOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        model: realtime.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL,
        instructions,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            noise_reduction: realtimeNoiseReductionConfig(realtime),
            transcription: { model: OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL },
            turn_detection: realtimeTurnDetectionConfig(realtime, { createResponse: false, interruptResponse: false }),
          },
          output: realtimeOutputAudioConfig(realtime, { type: "audio/pcmu" }),
        },
        tools,
        tool_choice: "auto",
        max_output_tokens: OPENAI_REALTIME_MAX_OUTPUT_TOKENS,
        ...(realtime.reasoningEffort ? { reasoning: { effort: realtime.reasoningEffort } } : {}),
      },
    })
  }

  private async buildInstructions(): Promise<string> {
    setAgentName(this.options.agentName)
    const agentRoot = this.options.agentRoot ?? getAgentRoot(this.options.agentName)
    const sessionDir = path.join(agentRoot, "state", "sessions", this.friendId, "voice")
    await fs.mkdir(sessionDir, { recursive: true })
    this.sessionPath = path.join(sessionDir, `${sanitizeKey(this.sessionKey)}.json`)

    const existing = loadSession(this.sessionPath)
    const prior = existing?.messages ? transcriptMessageText(existing.messages) : ""
    const realtimeSystem = await buildRealtimeVoiceInstructions({
      agentName: this.options.agentName,
      agentRoot,
      friend: this.resolvedContext?.friend,
      priorTranscript: prior,
      realtimeVoice: this.options.openaiRealtime?.voice,
      realtimeVoiceStyle: this.options.openaiRealtime?.voiceStyle,
      realtimeVoiceSpeed: this.options.openaiRealtime ? realtimeVoiceSpeed(this.options.openaiRealtime) : undefined,
      realtimeModel: this.options.openaiRealtime?.model,
    })
    this.sessionMessages = existing?.messages && existing.messages.length > 0
      ? existing.messages
      : [{ role: "system", content: realtimeSystem }]
    if (!existing) saveSession(this.sessionPath, this.sessionMessages)

    return realtimeSystem
  }

  private requestHangupFromTool(): void {
    if (!this.hangupRequested) {
      this.floor.apply({ type: "hangup.requested", atMs: Date.now(), reason: "voice_end_call" })
    }
    this.hangupRequested = true
    setTimeout(() => this.completeHangupIfReady("tool_fallback"), 7_500).unref?.()
  }

  private ensureVoiceToolContext(): void {
    if (this.toolContext) return
    this.toolContext = {
      signin: async () => undefined,
      ...(this.resolvedContext ? { context: this.resolvedContext } : {}),
      ...(this.friendStore ? { friendStore: this.friendStore } : {}),
      voiceCall: {
        requestEnd: () => this.requestHangupFromTool(),
        playAudio: (request) => this.playPreparedAudio(request),
      },
    }
  }

  private async buildRealtimeTools(): Promise<OpenAI.ChatCompletionFunctionTool[]> {
    if (!this.resolvedContext || !this.friendStore) {
      const voiceContext = await resolveVoiceFriendContext(this.options, {
        friendId: this.friendId,
        remotePhone: this.from || undefined,
        callSid: this.callSid,
      })
      this.friendId = voiceContext.friendId
      this.friendStore = voiceContext.friendStore
      this.resolvedContext = voiceContext.resolved
    }
    const resolved = this.resolvedContext
    const friendStore = this.friendStore
    this.toolContext = {
      signin: async () => undefined,
      context: resolved,
      friendStore,
      voiceCall: {
        requestEnd: () => this.requestHangupFromTool(),
        playAudio: (request) => this.playPreparedAudio(request),
      },
    }
    void this.refreshRealtimeToolsWithMcp(resolved)
    return getToolsForChannel(
      getChannelCapabilities("voice"),
      resolved.friend.toolPreferences,
      resolved,
      undefined,
      undefined,
    )
  }

  private async refreshRealtimeToolsWithMcp(resolved: Awaited<ReturnType<FriendResolver["resolve"]>>): Promise<void> {
    try {
      const mcpManager = await getSharedMcpManager() ?? undefined
      if (!mcpManager || this.closed) return
      const tools = realtimeToolsFromChatTools(getToolsForChannel(
        getChannelCapabilities("voice"),
        resolved.friend.toolPreferences,
        resolved,
        undefined,
        mcpManager,
      ))
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          tools,
          tool_choice: "auto",
        },
      })
    } catch {
      // Keep realtime calls conversational even if optional MCP tool discovery is slow or unavailable.
    }
  }

  private sendInitialGreeting(): void {
    if (this.greetingSent) return
    this.greetingSent = true
    const promptText = this.direction === "outbound" && this.outboundId
      ? outboundCallAnsweredPrompt({
          schemaVersion: 1,
          outboundId: this.outboundId,
          agentName: this.options.agentName,
          ...(this.friendId ? { friendId: this.friendId } : {}),
          to: this.from,
          from: this.to,
          reason: this.outboundReason || "Voice call connected.",
          createdAt: new Date().toISOString(),
        }, { From: this.to, To: this.from })
      : callConnectedPrompt({ From: this.from, To: this.to })
    this.requestRealtimeResponse({ instructions: promptText })
  }

  private handleMedia(media: TwilioMediaPayload | undefined): void {
    const payload = stringField(media?.payload)
    if (!payload) return
    this.trackCallerBargeInEnergy(payload)
    if (!this.openaiReady) {
      this.pendingAudioPayloads.push(payload)
      if (this.pendingAudioPayloads.length > 250) this.pendingAudioPayloads.shift()
      return
    }
    this.sendOpenAI({ type: "input_audio_buffer.append", audio: payload })
  }

  private trackCallerBargeInEnergy(payload: string): void {
    const frame = Buffer.from(payload, "base64")
    if (frame.byteLength === 0) return
    const rms = mulawFrameRms(frame)
    if (rms >= OPENAI_REALTIME_BARGE_IN_RMS_THRESHOLD) {
      this.callerBargeInSpeechMs += pcmuPayloadDurationMs(payload)
      this.lastCallerBargeInSpeechAt = Date.now()
      return
    }
    this.callerBargeInSpeechMs = Math.max(0, this.callerBargeInSpeechMs - pcmuPayloadDurationMs(payload))
  }

  private hasReliableCallerBargeInSpeech(): boolean {
    if (Date.now() - this.lastCallerBargeInSpeechAt > 600) return false
    return this.callerBargeInSpeechMs >= OPENAI_REALTIME_BARGE_IN_MIN_SPEECH_MS
  }

  private handleMark(mark: TwilioMediaMark | undefined): void {
    const name = stringField(mark?.name)
    if (!name) return
    const playback = this.playbackMarks.get(name)
    if (!playback) return
    this.playbackMarks.delete(name)
    if (
      this.playbackState
      && this.playbackState.itemId === playback.itemId
      && this.playbackState.contentIndex === playback.contentIndex
    ) {
      this.playbackState.playedMs = Math.max(this.playbackState.playedMs, playback.audioEndMs)
    }
  }

  private handleOpenAIMessage(raw: RawData): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof event.type === "string" ? event.type : ""
    if (type === "response.created") {
      this.noteRealtimeResponseCreated(event)
      return
    }
    if (type === "response.output_audio.delta" && typeof event.delta === "string") {
      this.handleOpenAIAudioDelta(event)
      return
    }
    if (type === "input_audio_buffer.speech_started") {
      this.handleCallerSpeechStarted()
      return
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.handleCallerSpeechStopped()
      return
    }
    if (type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      this.handleUserTranscript(event.transcript)
      return
    }
    if (type === "response.output_audio_transcript.done" && typeof event.transcript === "string") {
      this.appendTranscript("assistant", event.transcript)
      return
    }
    if (type === "response.function_call_arguments.done") {
      void this.runRealtimeTool(event)
      return
    }
    if (type === "response.done") {
      const responseId = realtimeResponseId(event)
      this.noteRealtimeResponseDone(responseId)
      if (this.completeRealtimeToolResponse(responseId)) return
      void this.playInitialAudioAfterGreeting()
      this.completeHangupIfReady("response_done")
      return
    }
    if (type === "error") {
      this.handleRealtimeError(event)
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_realtime_openai_event_error",
        message: "OpenAI Realtime emitted an error during Twilio call",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), event: JSON.stringify(event).slice(0, 500) },
      })
    }
  }

  private handleRealtimeError(event: Record<string, unknown>): void {
    const error = event.error
    if (!error || typeof error !== "object" || Array.isArray(error)) return
    const code = stringField((error as Record<string, unknown>).code)
    if (code !== "conversation_already_has_active_response") return
    this.noteRealtimeResponseConflict()
  }

  private handleUserTranscript(transcript: string): void {
    const content = transcript.trim()
    if (!content) return
    this.appendTranscript("user", content)
    const turnId = this.activeCallerTurnId ?? `caller-turn-${++this.callerTurnSequence}`
    this.activeCallerTurnId = undefined
    this.floor.apply({ type: "caller.transcript.final", atMs: Date.now(), turnId, text: content })
    this.scheduleUserTurnResponse()
  }

  private scheduleUserTurnResponse(): void {
    if (this.closed) return
    this.clearPendingUserTurnResponse()
    this.pendingUserTurnResponseTimer = setTimeout(() => {
      this.pendingUserTurnResponseTimer = null
      if (this.closed) return
      this.requestRealtimeResponse()
    }, OPENAI_REALTIME_USER_TURN_RESPONSE_DELAY_MS)
    this.pendingUserTurnResponseTimer.unref?.()
  }

  private clearPendingUserTurnResponse(): void {
    if (!this.pendingUserTurnResponseTimer) return
    clearTimeout(this.pendingUserTurnResponseTimer)
    this.pendingUserTurnResponseTimer = null
  }

  private handleCallerSpeechStopped(): void {
    // VAD signaled the caller stopped speaking. Release the floor immediately
    // even if transcription has not yet completed (and may never complete for
    // sub-vocal sounds), so the gate cannot stay stuck thinking the caller
    // still owns the floor. If a transcript-completed event eventually
    // arrives, applyCallerTranscriptFinal will run next on an already-released
    // floor and simply remember the caller turn id.
    if (!this.activeCallerTurnId) return
    if (this.floor.state.floorOwner !== "caller" && this.floor.state.phase !== "caller-speaking") return
    this.floor.apply({
      type: "caller.speech.ended",
      atMs: Date.now(),
      turnId: this.activeCallerTurnId,
    })
  }

  private handleOpenAIAudioDelta(event: Record<string, unknown>): void {
    const payload = stringField(event.delta)
    if (!payload) return
    const itemId = stringField(event.item_id)
    const contentIndex = numberField(event.content_index) ?? 0
    let audioEndMs: number | undefined
    if (itemId) {
      let current = this.playbackState
      if (!current || current.itemId !== itemId || current.contentIndex !== contentIndex) {
        current = { itemId, contentIndex, sentMs: 0, playedMs: 0 }
        this.playbackState = current
      }
      current.sentMs += pcmuPayloadDurationMs(payload)
      audioEndMs = current.sentMs
    }
    this.sendTwilioMedia(payload)
    if (itemId && audioEndMs !== undefined) this.sendTwilioMark({ itemId, contentIndex, audioEndMs })
  }

  private handleCallerSpeechStarted(): void {
    this.clearPendingUserTurnResponse()
    if (!this.hasReliableCallerBargeInSpeech()) {
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_realtime_barge_in_ignored",
        message: "ignored low-confidence OpenAI Realtime barge-in signal",
        meta: {
          agentName: this.options.agentName,
          callSid: safeSegment(this.callSid),
          speechMs: String(this.callerBargeInSpeechMs),
        },
      })
      return
    }
    const playback = this.playbackState
    const turnId = `caller-turn-${++this.callerTurnSequence}`
    this.activeCallerTurnId = turnId
    const interruptedResponseId = this.floor.state.activeAssistantSpeechId
    this.floor.apply({ type: "caller.speech.started", atMs: Date.now(), turnId })
    if (interruptedResponseId) {
      // The caller barged in while the floor model still considered an
      // assistant response active. Without an explicit cancellation, the
      // assistant.speech.done that eventually arrives leaves floorOwner=caller
      // permanently set (the reducer only flips owner away from "assistant"
      // when applying speech.done) and every subsequent caller turn hits the
      // gate's caller_has_floor block. That is the "Slugger goes silent for
      // the rest of the call" symptom. Emit a typed cancellation so the floor
      // model takes the interruption branch and the transcript that follows
      // can cleanly release the floor.
      this.floor.apply({
        type: "assistant.speech.cancelled",
        atMs: Date.now(),
        responseId: interruptedResponseId,
        reason: "caller_barge_in",
      })
      this.pendingGatedResponseId = null
    }
    this.playbackMarks.clear()
    this.sendTwilioClear()
    if (!playback?.itemId) return
    this.sendOpenAI({
      type: "conversation.item.truncate",
      item_id: playback.itemId,
      content_index: playback.contentIndex,
      audio_end_ms: playback.playedMs,
    })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_realtime_output_truncated",
      message: "truncated interrupted OpenAI Realtime voice output",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        audioEndMs: playback.playedMs,
      },
    })
    this.playbackState = undefined
  }

  private registerRealtimeToolResponse(responseId: string, callId: string): RealtimeToolResponseState | undefined {
    if (!responseId) return undefined
    const existing = this.toolResponses.get(responseId)
    const state = existing ?? {
      pendingCallIds: new Set<string>(),
      responseDone: this.completedRealtimeResponseIds.has(responseId),
      followupRequested: false,
      suppressFollowup: false,
      presenceRequested: false,
      presenceTimer: null,
    }
    state.pendingCallIds.add(callId)
    if (!existing) this.toolResponses.set(responseId, state)
    return state
  }

  private completeRealtimeToolCall(responseId: string, callId: string): boolean {
    if (!responseId) return false
    const state = this.toolResponses.get(responseId)
    if (!state) return false
    state.pendingCallIds.delete(callId)
    if (state.pendingCallIds.size === 0) this.clearRealtimeToolPresenceTimer(state)
    return this.maybeCreateRealtimeToolFollowup(responseId, state)
  }

  private completeRealtimeToolResponse(responseId: string): boolean {
    if (!responseId) return false
    this.completedRealtimeResponseIds.add(responseId)
    const state = this.toolResponses.get(responseId)
    if (!state) return false
    state.responseDone = true
    this.maybeCreateRealtimeToolFollowup(responseId, state)
    return true
  }

  private maybeCreateRealtimeToolFollowup(responseId: string, state: RealtimeToolResponseState): boolean {
    if (!state.responseDone || state.pendingCallIds.size > 0 || state.followupRequested) return false
    state.followupRequested = true
    this.toolResponses.delete(responseId)
    this.clearRealtimeToolPresenceTimer(state)
    if (state.suppressFollowup) return true
    this.requestRealtimeResponse()
    return true
  }

  private scheduleRealtimeToolPresence(responseId: string, state: RealtimeToolResponseState): void {
    if (!responseId || state.presenceRequested || state.presenceTimer) return
    state.presenceTimer = setTimeout(() => {
      state.presenceTimer = null
      const current = this.toolResponses.get(responseId)
      if (this.closed || current !== state || state.pendingCallIds.size === 0 || state.suppressFollowup) return
      state.presenceRequested = true
      this.requestRealtimeResponse({
        instructions: "A tool is taking a moment. Say one very short natural holding phrase under six words, then stop speaking.",
      })
    }, OPENAI_REALTIME_TOOL_PRESENCE_DELAY_MS)
    state.presenceTimer.unref?.()
  }

  private clearRealtimeToolPresenceTimer(state: RealtimeToolResponseState): void {
    if (!state.presenceTimer) return
    clearTimeout(state.presenceTimer)
    state.presenceTimer = null
  }

  private clearRealtimeToolPresenceTimers(): void {
    for (const state of this.toolResponses.values()) this.clearRealtimeToolPresenceTimer(state)
  }

  private async runRealtimeTool(event: Record<string, unknown>): Promise<void> {
    const name = typeof event.name === "string" ? event.name : ""
    const callId = typeof event.call_id === "string" ? event.call_id : ""
    if (!name || !callId) return
    const responseId = realtimeResponseId(event)
    const toolState = this.registerRealtimeToolResponse(responseId, callId)
    const coordinated = !!toolState
    if (name === "voice_end_call" && toolState) toolState.suppressFollowup = true
    if (toolState && !toolState.suppressFollowup) this.scheduleRealtimeToolPresence(responseId, toolState)
    // A coordinated tool call (one with a responseId from OpenAI's active
    // response cycle) is proof that the realtime server has already parsed the
    // caller's most recent turn into a tool intent. If we still hold a
    // synthetic caller floor for that turn — because the matching
    // input_audio_transcription.completed event has not arrived yet, which is
    // common in unit fixtures and during fast-turn races — dismiss it so the
    // floor gate is not stuck thinking the caller still owns the floor when
    // the assistant is mid-response.
    if (coordinated && this.activeCallerTurnId) {
      const turnId = this.activeCallerTurnId
      this.activeCallerTurnId = undefined
      this.floor.apply({
        type: "caller.turn.dismissed",
        atMs: Date.now(),
        turnId,
        reason: "coordinated_tool_call",
      })
    }
    this.floor.apply({
      type: "tool.call.started",
      atMs: Date.now(),
      toolCallId: callId,
      toolName: name,
      turnId: this.floor.state.latestCallerTurnId,
    })
    let output: string
    try {
      const args = parseToolArguments(typeof event.arguments === "string" ? event.arguments : "")
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_realtime_tool_start",
        message: "OpenAI Realtime voice tool call started",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), tool: name },
      })
      output = await execTool(name, args, this.toolContext)
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_realtime_tool_end",
        message: "OpenAI Realtime voice tool call completed",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), tool: name },
      })
    } catch (error) {
      output = `[tool error] ${errorMessage(error)}`
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_realtime_tool_error",
        message: "OpenAI Realtime voice tool call failed",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), tool: name, error: errorMessage(error) },
      })
    }
    this.sendOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    })
    this.floor.apply({
      type: "tool.call.completed",
      atMs: Date.now(),
      toolCallId: callId,
      turnId: this.floor.state.latestCallerTurnId,
    })
    if (!this.completeRealtimeToolCall(responseId, callId) && !coordinated) {
      this.requestRealtimeResponse()
    }
  }

  private noteRealtimeResponseCreated(event: Record<string, unknown>): void {
    this.realtimeResponseCreateInFlight = null
    this.untrackedActiveRealtimeResponse = false
    this.clearUntrackedActiveRealtimeResponseTimer()
    const responseId = realtimeResponseId(event)
    if (responseId) this.activeRealtimeResponseId = responseId
  }

  private noteRealtimeResponseDone(_responseId: string): void {
    this.realtimeResponseCreateInFlight = null
    this.untrackedActiveRealtimeResponse = false
    this.clearUntrackedActiveRealtimeResponseTimer()
    this.activeRealtimeResponseId = null
    this.responseCreateHoldUntilMs = Math.max(
      this.responseCreateHoldUntilMs,
      Date.now() + OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS,
    )
    const closingResponseId = this.pendingGatedResponseId
    if (closingResponseId) {
      // Clear the field BEFORE applying the floor event so that a re-entrant
      // queued-flush triggered by the onTransition listener can install a new
      // pendingGatedResponseId for the follow-up request without us racing it
      // back to null after apply() returns.
      this.pendingGatedResponseId = null
      this.floor.apply({ type: "assistant.speech.done", atMs: Date.now(), responseId: closingResponseId })
    }
    this.schedulePendingRealtimeResponse(OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS)
  }

  private requestRealtimeResponse(response?: Record<string, unknown>): void {
    if (this.closed) return
    this.sendGatedRealtimeResponseCreate(response ? { response } : {})
  }

  private sendGatedRealtimeResponseCreate(request: PendingRealtimeResponseRequest): void {
    if (this.closed) return
    const responseId = `gated-${++this.gatedResponseRequestSequence}`
    const decision = this.floor.canRequestResponse({ responseId })
    if (decision.action === "allow") {
      this.queuedGatedRealtimeRequest = null
      this.pendingGatedResponseId = responseId
      this.floor.apply({ type: "assistant.response.requested", atMs: Date.now(), responseId })
      this.sendRealtimeResponseCreate(request)
      // OpenAI's `response.created` ACK is not guaranteed in every error/race path
      // (and fixture WebSocket mocks may omit it). Treat the wire send itself as
      // the moment the assistant has the floor so the gate cannot stay in a
      // pending state forever. Real `response.created` ids that arrive later are
      // idempotently re-applied in noteRealtimeResponseCreated().
      this.floor.apply({ type: "assistant.speech.started", atMs: Date.now(), responseId })
      return
    }
    if (decision.action === "delay") {
      this.queuedGatedRealtimeRequest = request
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_floor_gate_blocked",
        message: `voice floor gate delayed response.create (${decision.reason})`,
        meta: this.floorGateMeta({ action: "delay", reason: decision.reason, responseId, queued: true }),
      })
      return
    }
    this.queuedGatedRealtimeRequest = null
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_floor_gate_blocked",
      message: `voice floor gate suppressed response.create (${decision.reason})`,
      meta: this.floorGateMeta({ action: decision.action, reason: decision.reason, responseId, queued: false }),
    })
  }

  private flushQueuedGatedRealtimeRequest(): void {
    if (this.closed || !this.queuedGatedRealtimeRequest) return
    const queued = this.queuedGatedRealtimeRequest
    const probeId = `gated-probe-${this.gatedResponseRequestSequence}`
    const probe = this.floor.canRequestResponse({ responseId: probeId })
    if (probe.action !== "allow") return
    this.queuedGatedRealtimeRequest = null
    this.sendGatedRealtimeResponseCreate(queued)
  }

  private floorGateMeta(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      agentName: this.options.agentName,
      phase: this.floor.state.phase,
      floorOwner: this.floor.state.floorOwner,
      ...extra,
    }
  }

  private realtimeResponseIsBusy(): boolean {
    return !!this.activeRealtimeResponseId || !!this.realtimeResponseCreateInFlight || this.untrackedActiveRealtimeResponse
  }

  private holdRealtimeResponse(request: PendingRealtimeResponseRequest): void {
    const pendingResponse = request.response ?? this.pendingRealtimeResponse?.response
    this.pendingRealtimeResponse = pendingResponse ? { response: pendingResponse } : {}
  }

  private schedulePendingRealtimeResponse(delayMs: number): void {
    if (!this.pendingRealtimeResponse) return
    if (this.pendingRealtimeResponseTimer) clearTimeout(this.pendingRealtimeResponseTimer)
    this.pendingRealtimeResponseTimer = setTimeout(() => {
      this.pendingRealtimeResponseTimer = null
      this.flushPendingRealtimeResponse()
    }, Math.max(0, delayMs))
    this.pendingRealtimeResponseTimer.unref?.()
  }

  private flushPendingRealtimeResponse(): void {
    if (!this.pendingRealtimeResponse || this.closed || this.realtimeResponseIsBusy()) return
    const waitMs = Math.max(0, this.responseCreateHoldUntilMs - Date.now())
    if (waitMs > 0) {
      this.schedulePendingRealtimeResponse(waitMs)
      return
    }
    const pending = this.pendingRealtimeResponse
    this.pendingRealtimeResponse = null
    this.sendRealtimeResponseCreate(pending)
  }

  private sendRealtimeResponseCreate(request: PendingRealtimeResponseRequest): void {
    this.realtimeResponseCreateInFlight = request
    this.sendOpenAI({
      type: "response.create",
      ...(request.response ? { response: request.response } : {}),
    })
  }

  private noteRealtimeResponseConflict(): void {
    const inFlight = this.realtimeResponseCreateInFlight
    this.realtimeResponseCreateInFlight = null
    this.untrackedActiveRealtimeResponse = true
    if (inFlight) this.holdRealtimeResponse(inFlight)
    this.scheduleUntrackedActiveRealtimeResponseFallback()
  }

  private scheduleUntrackedActiveRealtimeResponseFallback(): void {
    this.clearUntrackedActiveRealtimeResponseTimer()
    this.untrackedActiveRealtimeResponseTimer = setTimeout(() => {
      this.untrackedActiveRealtimeResponseTimer = null
      if (this.closed || !this.untrackedActiveRealtimeResponse) return
      this.untrackedActiveRealtimeResponse = false
      this.responseCreateHoldUntilMs = Math.max(
        this.responseCreateHoldUntilMs,
        Date.now() + OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS,
      )
      this.schedulePendingRealtimeResponse(OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS)
    }, OPENAI_REALTIME_RESPONSE_CREATE_CONFLICT_BACKOFF_MS)
    this.untrackedActiveRealtimeResponseTimer.unref?.()
  }

  private clearUntrackedActiveRealtimeResponseTimer(): void {
    if (!this.untrackedActiveRealtimeResponseTimer) return
    clearTimeout(this.untrackedActiveRealtimeResponseTimer)
    this.untrackedActiveRealtimeResponseTimer = null
  }

  private flushPendingAudio(): void {
    const pending = this.pendingAudioPayloads.splice(0)
    for (const payload of pending) {
      this.sendOpenAI({ type: "input_audio_buffer.append", audio: payload })
    }
  }

  private sendOpenAI(event: unknown): void {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return
    this.openaiWs.send(JSON.stringify(event))
  }

  private async playInitialAudioAfterGreeting(): Promise<void> {
    if (this.initialAudioPlayed || !this.initialAudio) return
    this.initialAudioPlayed = true
    try {
      await this.playPreparedAudio(this.initialAudio, { clearFirst: false })
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_realtime_initial_audio_error",
        message: "failed to play initial audio into Twilio Realtime call",
        meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), error: errorMessage(error) },
      })
    }
  }

  private async playPreparedAudio(
    request: VoiceCallAudioRequest,
    playbackOptions: { clearFirst?: boolean } = {},
  ): Promise<VoiceCallAudioResult> {
    if (!this.streamSid || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("voice call media stream is not ready")
    }
    const prepared = await prepareVoiceCallAudio(request, {
      agentRoot: this.options.agentRoot ?? getAgentRoot(this.options.agentName),
    })
    this.playbackMarks.clear()
    this.playbackState = undefined
    if (playbackOptions.clearFirst ?? true) this.sendTwilioClear()
    for (let offset = 0; offset < prepared.audio.byteLength; offset += 160) {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) break
      this.sendTwilioMedia(Buffer.from(prepared.audio.subarray(offset, offset + 160)).toString("base64"))
      await delay(20)
    }
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        event: "mark",
        streamSid: this.streamSid,
        mark: { name: `tool-audio-${Date.now()}` },
      }))
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_realtime_tool_audio_played",
      message: "played tool-requested audio into Twilio Realtime call",
      meta: {
        agentName: this.options.agentName,
        callSid: safeSegment(this.callSid),
        label: prepared.label,
        durationMs: String(prepared.durationMs),
      },
    })
    return { label: prepared.label, durationMs: prepared.durationMs }
  }

  private sendTwilioMedia(payload: string): void {
    if (this.closed || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload },
    }))
  }

  private sendTwilioMark(playback: RealtimePlaybackMark): void {
    if (this.closed || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return
    const name = `rt-${++this.playbackMarkIndex}`
    this.playbackMarks.set(name, playback)
    this.ws.send(JSON.stringify({
      event: "mark",
      streamSid: this.streamSid,
      mark: { name },
    }))
  }

  private sendTwilioClear(): void {
    if (this.closed || !this.streamSid || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }))
  }

  private appendTranscript(role: "user" | "assistant", text: string): void {
    const content = text.trim()
    if (!content || !this.sessionPath) return
    this.sessionMessages.push({ role, content })
    saveSession(this.sessionPath, this.sessionMessages)
  }

  private completeHangupIfReady(trigger: string): void {
    if (!this.hangupRequested || this.closed) return
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_realtime_hangup_end",
      message: "ending Twilio OpenAI Realtime call after hangup request",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid), trigger },
    })
    this.end()
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    if (this.openaiWs && (this.openaiWs.readyState === WebSocket.OPEN || this.openaiWs.readyState === WebSocket.CONNECTING)) {
      this.openaiWs.close()
    }
    if (this.pendingRealtimeResponseTimer) {
      clearTimeout(this.pendingRealtimeResponseTimer)
      this.pendingRealtimeResponseTimer = null
    }
    this.clearPendingUserTurnResponse()
    this.clearRealtimeToolPresenceTimers()
    this.clearUntrackedActiveRealtimeResponseTimer()
    this.queuedGatedRealtimeRequest = null
    this.floor.apply({ type: "call.ended", atMs: Date.now() })
    this.floorUnsubscribe?.()
    this.floorUnsubscribe = null
    this.lifecycle?.onClose?.(this, { callSid: this.callSid, outboundId: this.outboundId })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_realtime_stop",
      message: "Twilio OpenAI Realtime stream stopped",
      meta: { agentName: this.options.agentName, callSid: safeSegment(this.callSid) },
    })
  }
}
/* v8 ignore stop */

/* v8 ignore start -- direct SIP control has bridge-level coverage; provider failures, bootstrap races, and AMD timers are live-network edge permutations @preserve */
class OpenAISipPhoneSession {
  private friendId = ""
  private sessionKey = ""
  private sessionPath = ""
  private closed = false
  private hangupRequested = false
  private hangupStarted = false
  private initialGreetingSent = false
  private outboundAmdState: "not_needed" | "pending" | "human" | "nonhuman" | "timeout" = "not_needed"
  private outboundAmdGreetingTimer: ReturnType<typeof setTimeout> | null = null
  private outboundAmdHumanGreetingCandidate = false
  private autoResponsesSuppressedForAmd = false
  private openaiWs: WebSocket | null = null
  private toolContext: ToolContext | undefined
  private friendStore: FileFriendStore | undefined
  private resolvedContext: ResolvedContext | undefined
  private sessionMessages: OpenAI.ChatCompletionMessageParam[] = []
  private readonly toolResponses = new Map<string, RealtimeToolResponseState>()
  private readonly completedRealtimeResponseIds = new Set<string>()
  private activeRealtimeResponseId: string | null = null
  private realtimeResponseCreateInFlight: PendingRealtimeResponseRequest | null = null
  private untrackedActiveRealtimeResponse = false
  private untrackedActiveRealtimeResponseTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRealtimeResponse: PendingRealtimeResponseRequest | null = null
  private pendingRealtimeResponseTimer: ReturnType<typeof setTimeout> | null = null
  private pendingUserTurnResponseTimer: ReturnType<typeof setTimeout> | null = null
  private responseCreateHoldUntilMs = 0
  private floor: VoiceFloorController = new VoiceFloorController({ transport: "openai-sip" })
  private floorUnsubscribe: (() => void) | null = null
  private queuedGatedRealtimeRequest: PendingRealtimeResponseRequest | null = null
  private activeCallerTurnId: string | undefined
  private callerTurnSequence = 0
  private gatedResponseRequestSequence = 0
  private pendingGatedResponseId: string | null = null

  constructor(
    private readonly options: TwilioPhoneBridgeOptions,
    private readonly metadata: OpenAISipCallMetadata,
    private readonly registry?: OpenAISipPhoneSessionRegistry,
  ) {}

  get callId(): string {
    return this.metadata.callId
  }

  get outboundId(): string {
    return this.metadata.outboundId
  }

  async start(): Promise<void> {
    try {
      const realtime = this.options.openaiRealtime
      const sip = this.options.openaiSip
      if (!realtime?.apiKey?.trim()) throw new Error("OpenAI Realtime API key is not configured")
      if (!sip) throw new Error("OpenAI SIP options are not configured")

      const voiceContext = await resolveVoiceFriendContext(this.options, {
        friendId: this.metadata.friendId || this.options.defaultFriendId?.trim(),
        remotePhone: this.metadata.from || undefined,
        callSid: this.metadata.callId,
      })
      this.friendId = voiceContext.friendId
      this.friendStore = voiceContext.friendStore
      this.resolvedContext = voiceContext.resolved
      this.sessionKey = twilioPhoneVoiceSessionKey({
        defaultFriendId: this.friendId,
        from: this.metadata.from,
        to: this.metadata.to,
        callSid: this.metadata.callId,
      })
      this.floor = new VoiceFloorController({
        transport: "openai-sip",
        agentName: this.options.agentName,
        callId: this.metadata.callId,
      })
      this.floorUnsubscribe = this.floor.onTransition(() => this.flushQueuedGatedRealtimeRequest())
      this.floor.apply({ type: "call.connected", atMs: Date.now(), callId: this.metadata.callId })
      const initialGreetingMode = await this.outboundAmdInitialGreetingMode()
      if (initialGreetingMode === "reject") {
        await this.rejectOpenAISipCall(realtime, sip, "amd_preclassified_nonhuman")
        return
      }
      this.outboundAmdState = initialGreetingMode === "hold" ? "pending" : "not_needed"
      this.autoResponsesSuppressedForAmd = initialGreetingMode === "hold"
      await this.updateOutboundJobIfNeeded()
      this.ensureVoiceToolContext()

      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_call_start",
        message: "OpenAI SIP phone call webhook accepted for voice handling",
        meta: {
          agentName: this.options.agentName,
          callId: safeSegment(this.metadata.callId),
          sessionKey: this.sessionKey,
          direction: this.metadata.direction,
        },
      })
      this.registry?.register(this)

      const fullConfigPromise = Promise.all([
        this.buildInstructions(),
        this.buildRealtimeTools()
          .then((tools) => realtimeToolsFromChatTools(tools, OPENAI_SIP_UNSUPPORTED_TOOL_NAMES)),
      ] as const)
      const ready = await Promise.race([
        fullConfigPromise,
        timeoutAfter(OPENAI_REALTIME_BOOTSTRAP_TIMEOUT_MS),
      ])
      const usedBootstrap = ready === undefined
      const [instructions, tools] = ready ?? [
        realtimeBootstrapInstructions(this.options.agentName, realtime.voiceStyle),
        realtimeBootstrapTools(),
      ]

      if (this.closed || this.outboundAmdStopped()) return
      await this.acceptOpenAISipCall(realtime, sip, instructions, tools)
      if (this.closed || this.outboundAmdStopped()) return
      this.openControlWebSocket(realtime, sip, fullConfigPromise, usedBootstrap)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_openai_sip_call_error",
        message: "OpenAI SIP phone call could not be started",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), error: errorMessage(error) },
      })
      this.close("start_error")
      throw error
    }
  }

  private async updateOutboundJobIfNeeded(): Promise<void> {
    if (this.metadata.direction !== "outbound" || !this.metadata.outboundId) return
    const job = await readTwilioOutboundCallJob(this.options.outputDir, this.metadata.outboundId)
    if (!job) return
    await updateTwilioOutboundCallJob(this.options.outputDir, job.outboundId, {
      status: "answered",
      transportCallSid: this.metadata.callId,
      events: [
        ...(job.events ?? []),
        { at: new Date().toISOString(), status: "answered", callSid: this.metadata.callId },
      ],
    })
  }

  private async outboundAmdInitialGreetingMode(): Promise<"send" | "hold" | "reject"> {
    if (this.metadata.direction !== "outbound" || !this.metadata.outboundId) return "send"
    const job = await readTwilioOutboundCallJob(this.options.outputDir, this.metadata.outboundId)
    if (!job) return "send"
    const answeredBy = job.answeredBy?.trim()
    if (nonHumanAnsweredStatus(answeredBy) || job.status === "voicemail" || job.status === "fax") return "reject"
    // Silence after pickup feels broken. Start the greeting immediately unless
    // Twilio has already positively identified a machine/fax answer.
    return "send"
  }

  private outboundAmdStopped(): boolean {
    return this.outboundAmdState === "nonhuman" || this.outboundAmdState === "timeout"
  }

  private async acceptOpenAISipCall(
    realtime: OpenAIRealtimeTwilioOptions,
    sip: OpenAISipPhoneOptions,
    instructions: string,
    tools: Array<{ type: "function"; name: string; description?: string; parameters?: unknown }>,
  ): Promise<void> {
    const fetchImpl = sip.fetch ?? fetch
    const response = await fetchImpl(openAISipCallActionUrl(sip, this.metadata.callId, "accept"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${realtime.apiKey.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "realtime",
        model: realtime.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL,
        instructions,
        audio: {
          input: {
            noise_reduction: realtimeNoiseReductionConfig(realtime),
            transcription: { model: OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL },
            turn_detection: realtimeTurnDetectionConfig(
              realtime,
              { createResponse: false, interruptResponse: false },
            ),
          },
          output: realtimeOutputAudioConfig(realtime),
        },
        tools,
        tool_choice: "auto",
        max_output_tokens: OPENAI_REALTIME_MAX_OUTPUT_TOKENS,
      }),
    })
    if (!response.ok) {
      const responseText = await response.text().catch(() => "")
      throw new Error(`OpenAI SIP call accept failed: ${response.status} ${responseText}`.trim())
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_openai_sip_call_accepted",
      message: "OpenAI SIP phone call accepted",
      meta: {
        agentName: this.options.agentName,
        callId: safeSegment(this.metadata.callId),
        model: realtime.model?.trim() || OPENAI_REALTIME_DEFAULT_MODEL,
        voice: realtime.voice?.trim() || OPENAI_REALTIME_DEFAULT_VOICE,
      },
    })
  }

  private async rejectOpenAISipCall(
    realtime: OpenAIRealtimeTwilioOptions,
    sip: OpenAISipPhoneOptions,
    trigger: string,
  ): Promise<void> {
    try {
      const response = await (sip.fetch ?? fetch)(openAISipCallActionUrl(sip, this.metadata.callId, "reject"), {
        method: "POST",
        headers: { authorization: `Bearer ${realtime.apiKey.trim()}` },
      })
      if (!response.ok) {
        const responseText = await response.text().catch(() => "")
        throw new Error(`OpenAI SIP call reject failed: ${response.status} ${responseText}`.trim())
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_call_rejected",
        message: "OpenAI SIP outbound call rejected before media start",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), trigger },
      })
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_openai_sip_call_reject_error",
        message: "OpenAI SIP outbound call reject request failed",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), trigger, error: errorMessage(error) },
      })
    } finally {
      this.close(trigger)
    }
  }

  private openControlWebSocket(
    realtime: OpenAIRealtimeTwilioOptions,
    sip: OpenAISipPhoneOptions,
    fullConfigPromise: Promise<readonly [
      string,
      Array<{ type: "function"; name: string; description?: string; parameters?: unknown }>,
    ]>,
    usedBootstrap: boolean,
  ): void {
    const ws = new WebSocket(openAISipControlWebSocketUrl(sip, this.metadata.callId), {
      headers: {
        Authorization: `Bearer ${realtime.apiKey.trim()}`,
        "OpenAI-Safety-Identifier": safeSegment(`${this.options.agentName}-${this.friendId}`),
      },
    })
    this.openaiWs = ws

    ws.on("open", () => {
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_control_open",
        message: "OpenAI SIP Realtime control socket connected",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId) },
      })
      this.startInitialGreetingFlow()
      if (!usedBootstrap) return
      fullConfigPromise
        .then(([instructions, tools]) => {
          if (this.closed) return
          this.sendOpenAI({
            type: "session.update",
            session: {
              type: "realtime",
              instructions,
              tools,
              tool_choice: "auto",
              ...(realtime.reasoningEffort ? { reasoning: { effort: realtime.reasoningEffort } } : {}),
            },
          })
        })
        .catch(() => undefined)
    })
    ws.on("message", (raw) => this.handleOpenAIMessage(raw))
    ws.on("close", () => {
      if (!this.closed) this.close("control_socket_closed")
    })
    ws.on("error", (error) => {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_openai_sip_control_error",
        message: "OpenAI SIP Realtime control socket failed",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), error: errorMessage(error) },
      })
    })
  }

  private async buildInstructions(): Promise<string> {
    setAgentName(this.options.agentName)
    const agentRoot = this.options.agentRoot ?? getAgentRoot(this.options.agentName)
    const sessionDir = path.join(agentRoot, "state", "sessions", this.friendId, "voice")
    await fs.mkdir(sessionDir, { recursive: true })
    this.sessionPath = path.join(sessionDir, `${sanitizeKey(this.sessionKey)}.json`)

    const existing = loadSession(this.sessionPath)
    const prior = existing?.messages ? transcriptMessageText(existing.messages) : ""
    const realtimeSystem = await buildRealtimeVoiceInstructions({
      agentName: this.options.agentName,
      agentRoot,
      friend: this.resolvedContext?.friend,
      priorTranscript: prior,
      realtimeVoice: this.options.openaiRealtime?.voice,
      realtimeVoiceStyle: this.options.openaiRealtime?.voiceStyle,
      realtimeVoiceSpeed: this.options.openaiRealtime ? realtimeVoiceSpeed(this.options.openaiRealtime) : undefined,
      realtimeModel: this.options.openaiRealtime?.model,
      audioToolMode: "realtime-cue",
    })
    this.sessionMessages = existing?.messages && existing.messages.length > 0
      ? existing.messages
      : [{ role: "system", content: realtimeSystem }]
    if (!existing) saveSession(this.sessionPath, this.sessionMessages)

    return realtimeSystem
  }

  private ensureVoiceToolContext(): void {
    if (this.toolContext) return
    this.toolContext = {
      signin: async () => undefined,
      ...(this.resolvedContext ? { context: this.resolvedContext } : {}),
      ...(this.friendStore ? { friendStore: this.friendStore } : {}),
      voiceCall: {
        requestEnd: () => this.requestHangupFromTool(),
        playAudio: (request) => this.playRealtimeAudioCue(request),
      },
    }
  }

  private async buildRealtimeTools(): Promise<OpenAI.ChatCompletionFunctionTool[]> {
    if (!this.resolvedContext || !this.friendStore) {
      const voiceContext = await resolveVoiceFriendContext(this.options, {
        friendId: this.friendId,
        remotePhone: this.metadata.from || undefined,
        callSid: this.metadata.callId,
      })
      this.friendId = voiceContext.friendId
      this.friendStore = voiceContext.friendStore
      this.resolvedContext = voiceContext.resolved
    }
    const resolved = this.resolvedContext
    const friendStore = this.friendStore
    this.toolContext = {
      signin: async () => undefined,
      context: resolved,
      friendStore,
      voiceCall: {
        requestEnd: () => this.requestHangupFromTool(),
        playAudio: (request) => this.playRealtimeAudioCue(request),
      },
    }
    void this.refreshRealtimeToolsWithMcp(resolved)
    return getToolsForChannel(
      getChannelCapabilities("voice"),
      resolved.friend.toolPreferences,
      resolved,
      undefined,
      undefined,
    )
  }

  private playRealtimeAudioCue(request: VoiceCallAudioRequest): VoiceCallAudioResult {
    const source = request.source ?? "tone"
    const label = request.label?.trim() || (source === "tone" ? "tone cue" : "audio clip")
    if (source !== "tone") {
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_audio_clip_unsupported",
        message: "OpenAI SIP voice audio clip requested without byte-injection support",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), source, label },
      })
      return {
        label,
        durationMs: 0,
        toolResult: [
          "Direct OpenAI SIP cannot inject arbitrary external audio bytes yet.",
          "Briefly tell the caller that this SIP path can do short generated cues, but URL/file clips need the media bridge work before they can be played into the call.",
        ].join(" "),
      }
    }

    const durationMs = boundedInteger(request.durationMs, 80, 4_000) ?? 700
    const toneHz = boundedInteger(request.toneHz, 80, 3_000) ?? 660
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_openai_sip_audio_cue_requested",
      message: "OpenAI SIP voice audio cue requested",
      meta: {
        agentName: this.options.agentName,
        callId: safeSegment(this.metadata.callId),
        label,
        durationMs: String(durationMs),
        toneHz: String(toneHz),
      },
    })
    return {
      label,
      durationMs,
      toolResult: [
        `Render the requested audio cue now: a short, clear, nonverbal beep-like tone around ${toneHz} Hz for about ${durationMs} ms.`,
        "Do not describe the tone first and do not add words unless the caller asks afterward.",
      ].join(" "),
    }
  }

  private async refreshRealtimeToolsWithMcp(resolved: Awaited<ReturnType<FriendResolver["resolve"]>>): Promise<void> {
    try {
      const mcpManager = await getSharedMcpManager() ?? undefined
      if (!mcpManager || this.closed) return
      const tools = realtimeToolsFromChatTools(getToolsForChannel(
        getChannelCapabilities("voice"),
        resolved.friend.toolPreferences,
        resolved,
        undefined,
        mcpManager,
      ), OPENAI_SIP_UNSUPPORTED_TOOL_NAMES)
      this.sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          tools,
          tool_choice: "auto",
        },
      })
    } catch {
      // Keep SIP calls conversational even if optional MCP tool discovery is slow or unavailable.
    }
  }

  private recordOutboundAmdTranscriptCandidate(transcript: string): void {
    if (this.outboundAmdState !== "pending") return
    if (!looksLikeShortHumanPhoneGreeting(transcript)) return
    this.outboundAmdHumanGreetingCandidate = true
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_openai_sip_amd_human_candidate",
      message: "OpenAI SIP outbound AMD saw a short human-like greeting while waiting for Twilio classification",
      meta: {
        agentName: this.options.agentName,
        callId: safeSegment(this.metadata.callId),
        outboundId: safeSegment(this.metadata.outboundId || "unknown"),
      },
    })
  }

  handleAsyncAmd(answeredBy: string, nonHumanStatus?: "voicemail" | "fax"): void {
    if (this.metadata.direction !== "outbound" || !this.metadata.outboundId) return
    if (nonHumanStatus) {
      this.outboundAmdState = "nonhuman"
      this.clearOutboundAmdGreetingTimeout()
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_amd_nonhuman",
        message: "OpenAI SIP outbound call is hanging up after async AMD reported a non-human answer",
        meta: {
          agentName: this.options.agentName,
          callId: safeSegment(this.metadata.callId),
          outboundId: safeSegment(this.metadata.outboundId),
          answeredBy,
          status: nonHumanStatus,
        },
      })
      void this.hangup("amd_nonhuman")
      return
    }
    const normalizedAnsweredBy = answeredBy.trim().toLowerCase()
    if (normalizedAnsweredBy !== "human") {
      if (normalizedAnsweredBy === "unknown" && this.outboundAmdHumanGreetingCandidate) {
        this.releaseOutboundAmdGreeting("amd_unknown_human_candidate")
      }
      return
    }
    this.releaseOutboundAmdGreeting("amd_human")
  }

  private releaseOutboundAmdGreeting(trigger: string): void {
    if (this.outboundAmdState === "nonhuman" || this.outboundAmdState === "timeout") return
    this.outboundAmdState = "human"
    this.clearOutboundAmdGreetingTimeout()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_openai_sip_amd_human",
      message: "OpenAI SIP outbound greeting released after human AMD evidence",
      meta: {
        agentName: this.options.agentName,
        callId: safeSegment(this.metadata.callId),
        outboundId: safeSegment(this.metadata.outboundId),
        trigger,
      },
    })
    this.resumeAfterHumanAmdIfNeeded()
  }

  private resumeAfterHumanAmdIfNeeded(): void {
    if (this.closed) return
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return
    if (this.autoResponsesSuppressedForAmd) {
      const realtime = this.options.openaiRealtime
      if (realtime) {
        this.sendOpenAI({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: realtimeTurnDetectionConfig(realtime, { createResponse: false, interruptResponse: false }),
              },
            },
          },
        })
      }
      this.autoResponsesSuppressedForAmd = false
    }
    this.sendInitialGreeting()
  }

  private armOutboundAmdGreetingTimeout(): void {
    if (this.outboundAmdGreetingTimer || this.outboundAmdState !== "pending") return
    this.outboundAmdGreetingTimer = setTimeout(() => {
      this.outboundAmdGreetingTimer = null
      if (this.closed || this.outboundAmdState !== "pending") return
      this.outboundAmdState = "timeout"
      void this.markOutboundAmdTimeout()
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_openai_sip_amd_timeout",
        message: "OpenAI SIP outbound call hung up because async AMD did not report a human answer",
        meta: {
          agentName: this.options.agentName,
          callId: safeSegment(this.metadata.callId),
          outboundId: safeSegment(this.metadata.outboundId || "unknown"),
        },
      })
      void this.hangup("amd_timeout")
    }, OPENAI_SIP_OUTBOUND_AMD_GREETING_TIMEOUT_MS)
    this.outboundAmdGreetingTimer.unref?.()
  }

  private clearOutboundAmdGreetingTimeout(): void {
    if (!this.outboundAmdGreetingTimer) return
    clearTimeout(this.outboundAmdGreetingTimer)
    this.outboundAmdGreetingTimer = null
  }

  private async markOutboundAmdTimeout(): Promise<void> {
    if (!this.metadata.outboundId) return
    const job = await readTwilioOutboundCallJob(this.options.outputDir, this.metadata.outboundId)
    if (!job) return
    await updateTwilioOutboundCallJob(this.options.outputDir, job.outboundId, {
      status: "amd-timeout",
      transportCallSid: this.metadata.callId,
      events: [
        ...(job.events ?? []),
        { at: new Date().toISOString(), status: "amd-timeout", callSid: this.metadata.callId },
      ],
    })
  }

  private startInitialGreetingFlow(): void {
    if (this.outboundAmdState === "pending") {
      this.armOutboundAmdGreetingTimeout()
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_amd_greeting_hold",
        message: "OpenAI SIP outbound greeting is held until async AMD reports a human answer",
        meta: {
          agentName: this.options.agentName,
          callId: safeSegment(this.metadata.callId),
          outboundId: safeSegment(this.metadata.outboundId || "unknown"),
        },
      })
      return
    }
    if (this.outboundAmdState === "nonhuman" || this.outboundAmdState === "timeout") {
      void this.hangup(`amd_${this.outboundAmdState}`)
      return
    }
    this.resumeAfterHumanAmdIfNeeded()
  }

  private sendInitialGreeting(): void {
    if (this.initialGreetingSent) return
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return
    this.initialGreetingSent = true
    this.requestRealtimeResponse({
      instructions: openAISipCallConnectedPrompt(this.metadata, this.options.openaiRealtime?.voiceStyle),
    })
  }

  private handleOpenAIMessage(raw: RawData): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof event.type === "string" ? event.type : ""
    if (type === "response.created") {
      this.noteRealtimeResponseCreated(event)
      return
    }
    if (type === "input_audio_buffer.speech_started") {
      this.clearPendingUserTurnResponse()
      return
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.handleCallerSpeechStopped()
      return
    }
    if (type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      this.recordOutboundAmdTranscriptCandidate(event.transcript)
      this.handleUserTranscript(event.transcript)
      return
    }
    if (type === "response.output_audio_transcript.done" && typeof event.transcript === "string") {
      this.appendTranscript("assistant", event.transcript)
      return
    }
    if (type === "response.function_call_arguments.done") {
      void this.runRealtimeTool(event)
      return
    }
    if (type === "response.done") {
      const responseId = realtimeResponseId(event)
      this.noteRealtimeResponseDone(responseId)
      if (this.completeRealtimeToolResponse(responseId)) return
      this.completeHangupIfReady("response_done")
      return
    }
    if (type === "error") {
      this.handleRealtimeError(event)
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_openai_sip_event_error",
        message: "OpenAI Realtime emitted an error during SIP call",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), event: JSON.stringify(event).slice(0, 500) },
      })
    }
  }

  private handleRealtimeError(event: Record<string, unknown>): void {
    const error = event.error
    if (!error || typeof error !== "object" || Array.isArray(error)) return
    const code = stringField((error as Record<string, unknown>).code)
    if (code !== "conversation_already_has_active_response") return
    this.noteRealtimeResponseConflict()
  }

  private handleUserTranscript(transcript: string): void {
    const content = transcript.trim()
    if (!content) return
    this.appendTranscript("user", content)
    const turnId = this.activeCallerTurnId ?? `caller-turn-${++this.callerTurnSequence}`
    this.activeCallerTurnId = undefined
    this.floor.apply({ type: "caller.transcript.final", atMs: Date.now(), turnId, text: content })
    this.scheduleUserTurnResponse()
  }

  private scheduleUserTurnResponse(): void {
    if (this.closed) return
    this.clearPendingUserTurnResponse()
    this.pendingUserTurnResponseTimer = setTimeout(() => {
      this.pendingUserTurnResponseTimer = null
      if (this.closed) return
      this.requestRealtimeResponse()
    }, OPENAI_REALTIME_USER_TURN_RESPONSE_DELAY_MS)
    this.pendingUserTurnResponseTimer.unref?.()
  }

  private clearPendingUserTurnResponse(): void {
    if (!this.pendingUserTurnResponseTimer) return
    clearTimeout(this.pendingUserTurnResponseTimer)
    this.pendingUserTurnResponseTimer = null
  }

  private handleCallerSpeechStopped(): void {
    // VAD signaled the caller stopped speaking. Release the floor immediately
    // even if transcription has not yet completed (and may never complete for
    // sub-vocal sounds), so the gate cannot stay stuck thinking the caller
    // still owns the floor. If a transcript-completed event eventually
    // arrives, applyCallerTranscriptFinal will run next on an already-released
    // floor and simply remember the caller turn id.
    if (!this.activeCallerTurnId) return
    if (this.floor.state.floorOwner !== "caller" && this.floor.state.phase !== "caller-speaking") return
    this.floor.apply({
      type: "caller.speech.ended",
      atMs: Date.now(),
      turnId: this.activeCallerTurnId,
    })
  }

  private registerRealtimeToolResponse(responseId: string, callId: string): RealtimeToolResponseState | undefined {
    if (!responseId) return undefined
    const existing = this.toolResponses.get(responseId)
    const state = existing ?? {
      pendingCallIds: new Set<string>(),
      responseDone: this.completedRealtimeResponseIds.has(responseId),
      followupRequested: false,
      suppressFollowup: false,
      presenceRequested: false,
      presenceTimer: null,
    }
    state.pendingCallIds.add(callId)
    if (!existing) this.toolResponses.set(responseId, state)
    return state
  }

  private completeRealtimeToolCall(responseId: string, callId: string): boolean {
    if (!responseId) return false
    const state = this.toolResponses.get(responseId)
    if (!state) return false
    state.pendingCallIds.delete(callId)
    if (state.pendingCallIds.size === 0) this.clearRealtimeToolPresenceTimer(state)
    return this.maybeCreateRealtimeToolFollowup(responseId, state)
  }

  private completeRealtimeToolResponse(responseId: string): boolean {
    if (!responseId) return false
    this.completedRealtimeResponseIds.add(responseId)
    const state = this.toolResponses.get(responseId)
    if (!state) return false
    state.responseDone = true
    this.maybeCreateRealtimeToolFollowup(responseId, state)
    return true
  }

  private maybeCreateRealtimeToolFollowup(responseId: string, state: RealtimeToolResponseState): boolean {
    if (!state.responseDone || state.pendingCallIds.size > 0 || state.followupRequested) return false
    state.followupRequested = true
    this.toolResponses.delete(responseId)
    this.clearRealtimeToolPresenceTimer(state)
    if (state.suppressFollowup) {
      this.completeHangupIfReady("tool_response_done")
      return true
    }
    this.requestRealtimeResponse()
    return true
  }

  private scheduleRealtimeToolPresence(responseId: string, state: RealtimeToolResponseState): void {
    if (!responseId || state.presenceRequested || state.presenceTimer) return
    state.presenceTimer = setTimeout(() => {
      state.presenceTimer = null
      const current = this.toolResponses.get(responseId)
      if (this.closed || current !== state || state.pendingCallIds.size === 0 || state.suppressFollowup) return
      state.presenceRequested = true
      this.requestRealtimeResponse({
        instructions: "A tool is taking a moment. Say one very short natural holding phrase under six words, then stop speaking.",
      })
    }, OPENAI_REALTIME_TOOL_PRESENCE_DELAY_MS)
    state.presenceTimer.unref?.()
  }

  private clearRealtimeToolPresenceTimer(state: RealtimeToolResponseState): void {
    if (!state.presenceTimer) return
    clearTimeout(state.presenceTimer)
    state.presenceTimer = null
  }

  private clearRealtimeToolPresenceTimers(): void {
    for (const state of this.toolResponses.values()) this.clearRealtimeToolPresenceTimer(state)
  }

  private async runRealtimeTool(event: Record<string, unknown>): Promise<void> {
    const name = typeof event.name === "string" ? event.name : ""
    const callId = typeof event.call_id === "string" ? event.call_id : ""
    if (!name || !callId) return
    const responseId = realtimeResponseId(event)
    const toolState = this.registerRealtimeToolResponse(responseId, callId)
    const coordinated = !!toolState
    if (name === "voice_end_call" && toolState) toolState.suppressFollowup = true
    if (toolState && !toolState.suppressFollowup) this.scheduleRealtimeToolPresence(responseId, toolState)
    // A coordinated tool call (one with a responseId from OpenAI's active
    // response cycle) is proof that the realtime server has already parsed the
    // caller's most recent turn into a tool intent. If we still hold a
    // synthetic caller floor for that turn — because the matching
    // input_audio_transcription.completed event has not arrived yet, which is
    // common in unit fixtures and during fast-turn races — dismiss it so the
    // floor gate is not stuck thinking the caller still owns the floor when
    // the assistant is mid-response.
    if (coordinated && this.activeCallerTurnId) {
      const turnId = this.activeCallerTurnId
      this.activeCallerTurnId = undefined
      this.floor.apply({
        type: "caller.turn.dismissed",
        atMs: Date.now(),
        turnId,
        reason: "coordinated_tool_call",
      })
    }
    this.floor.apply({
      type: "tool.call.started",
      atMs: Date.now(),
      toolCallId: callId,
      toolName: name,
      turnId: this.floor.state.latestCallerTurnId,
    })
    let output: string
    try {
      const args = parseToolArguments(typeof event.arguments === "string" ? event.arguments : "")
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_tool_start",
        message: "OpenAI SIP voice tool call started",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), tool: name },
      })
      output = await execTool(name, args, this.toolContext)
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_tool_end",
        message: "OpenAI SIP voice tool call completed",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), tool: name },
      })
    } catch (error) {
      output = `[tool error] ${errorMessage(error)}`
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_openai_sip_tool_error",
        message: "OpenAI SIP voice tool call failed",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), tool: name, error: errorMessage(error) },
      })
    }
    this.sendOpenAI({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    })
    this.floor.apply({
      type: "tool.call.completed",
      atMs: Date.now(),
      toolCallId: callId,
      turnId: this.floor.state.latestCallerTurnId,
    })
    if (!this.completeRealtimeToolCall(responseId, callId) && !coordinated) {
      this.requestRealtimeResponse()
    }
  }

  private noteRealtimeResponseCreated(event: Record<string, unknown>): void {
    this.realtimeResponseCreateInFlight = null
    this.untrackedActiveRealtimeResponse = false
    this.clearUntrackedActiveRealtimeResponseTimer()
    const responseId = realtimeResponseId(event)
    if (responseId) this.activeRealtimeResponseId = responseId
  }

  private noteRealtimeResponseDone(_responseId: string): void {
    this.realtimeResponseCreateInFlight = null
    this.untrackedActiveRealtimeResponse = false
    this.clearUntrackedActiveRealtimeResponseTimer()
    this.activeRealtimeResponseId = null
    this.responseCreateHoldUntilMs = Math.max(
      this.responseCreateHoldUntilMs,
      Date.now() + OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS,
    )
    const closingResponseId = this.pendingGatedResponseId
    if (closingResponseId) {
      // Clear the field BEFORE applying the floor event so that a re-entrant
      // queued-flush triggered by the onTransition listener can install a new
      // pendingGatedResponseId for the follow-up request without us racing it
      // back to null after apply() returns.
      this.pendingGatedResponseId = null
      this.floor.apply({ type: "assistant.speech.done", atMs: Date.now(), responseId: closingResponseId })
    }
    this.schedulePendingRealtimeResponse(OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS)
  }

  private requestRealtimeResponse(response?: Record<string, unknown>): void {
    if (this.closed) return
    this.sendGatedRealtimeResponseCreate(response ? { response } : {})
  }

  private sendGatedRealtimeResponseCreate(request: PendingRealtimeResponseRequest): void {
    if (this.closed) return
    const responseId = `gated-${++this.gatedResponseRequestSequence}`
    const decision = this.floor.canRequestResponse({ responseId })
    if (decision.action === "allow") {
      this.queuedGatedRealtimeRequest = null
      this.pendingGatedResponseId = responseId
      this.floor.apply({ type: "assistant.response.requested", atMs: Date.now(), responseId })
      this.sendRealtimeResponseCreate(request)
      // OpenAI's `response.created` ACK is not guaranteed in every error/race path
      // (and fixture WebSocket mocks may omit it). Treat the wire send itself as
      // the moment the assistant has the floor so the gate cannot stay in a
      // pending state forever. Real `response.created` ids that arrive later are
      // idempotently re-applied in noteRealtimeResponseCreated().
      this.floor.apply({ type: "assistant.speech.started", atMs: Date.now(), responseId })
      return
    }
    if (decision.action === "delay") {
      this.queuedGatedRealtimeRequest = request
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_floor_gate_blocked",
        message: `voice floor gate delayed response.create (${decision.reason})`,
        meta: this.floorGateMeta({ action: "delay", reason: decision.reason, responseId, queued: true }),
      })
      return
    }
    this.queuedGatedRealtimeRequest = null
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_floor_gate_blocked",
      message: `voice floor gate suppressed response.create (${decision.reason})`,
      meta: this.floorGateMeta({ action: decision.action, reason: decision.reason, responseId, queued: false }),
    })
  }

  private flushQueuedGatedRealtimeRequest(): void {
    if (this.closed || !this.queuedGatedRealtimeRequest) return
    const queued = this.queuedGatedRealtimeRequest
    const probeId = `gated-probe-${this.gatedResponseRequestSequence}`
    const probe = this.floor.canRequestResponse({ responseId: probeId })
    if (probe.action !== "allow") return
    this.queuedGatedRealtimeRequest = null
    this.sendGatedRealtimeResponseCreate(queued)
  }

  private floorGateMeta(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      agentName: this.options.agentName,
      phase: this.floor.state.phase,
      floorOwner: this.floor.state.floorOwner,
      ...extra,
    }
  }

  private realtimeResponseIsBusy(): boolean {
    return !!this.activeRealtimeResponseId || !!this.realtimeResponseCreateInFlight || this.untrackedActiveRealtimeResponse
  }

  private holdRealtimeResponse(request: PendingRealtimeResponseRequest): void {
    const pendingResponse = request.response ?? this.pendingRealtimeResponse?.response
    this.pendingRealtimeResponse = pendingResponse ? { response: pendingResponse } : {}
  }

  private schedulePendingRealtimeResponse(delayMs: number): void {
    if (!this.pendingRealtimeResponse) return
    if (this.pendingRealtimeResponseTimer) clearTimeout(this.pendingRealtimeResponseTimer)
    this.pendingRealtimeResponseTimer = setTimeout(() => {
      this.pendingRealtimeResponseTimer = null
      this.flushPendingRealtimeResponse()
    }, Math.max(0, delayMs))
    this.pendingRealtimeResponseTimer.unref?.()
  }

  private flushPendingRealtimeResponse(): void {
    if (!this.pendingRealtimeResponse || this.closed || this.realtimeResponseIsBusy()) return
    const waitMs = Math.max(0, this.responseCreateHoldUntilMs - Date.now())
    if (waitMs > 0) {
      this.schedulePendingRealtimeResponse(waitMs)
      return
    }
    const pending = this.pendingRealtimeResponse
    this.pendingRealtimeResponse = null
    this.sendRealtimeResponseCreate(pending)
  }

  private sendRealtimeResponseCreate(request: PendingRealtimeResponseRequest): void {
    this.realtimeResponseCreateInFlight = request
    this.sendOpenAI({
      type: "response.create",
      ...(request.response ? { response: request.response } : {}),
    })
  }

  private noteRealtimeResponseConflict(): void {
    const inFlight = this.realtimeResponseCreateInFlight
    this.realtimeResponseCreateInFlight = null
    this.untrackedActiveRealtimeResponse = true
    if (inFlight) this.holdRealtimeResponse(inFlight)
    this.scheduleUntrackedActiveRealtimeResponseFallback()
  }

  private scheduleUntrackedActiveRealtimeResponseFallback(): void {
    this.clearUntrackedActiveRealtimeResponseTimer()
    this.untrackedActiveRealtimeResponseTimer = setTimeout(() => {
      this.untrackedActiveRealtimeResponseTimer = null
      if (this.closed || !this.untrackedActiveRealtimeResponse) return
      this.untrackedActiveRealtimeResponse = false
      this.responseCreateHoldUntilMs = Math.max(
        this.responseCreateHoldUntilMs,
        Date.now() + OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS,
      )
      this.schedulePendingRealtimeResponse(OPENAI_REALTIME_RESPONSE_CREATE_GRACE_MS)
    }, OPENAI_REALTIME_RESPONSE_CREATE_CONFLICT_BACKOFF_MS)
    this.untrackedActiveRealtimeResponseTimer.unref?.()
  }

  private clearUntrackedActiveRealtimeResponseTimer(): void {
    if (!this.untrackedActiveRealtimeResponseTimer) return
    clearTimeout(this.untrackedActiveRealtimeResponseTimer)
    this.untrackedActiveRealtimeResponseTimer = null
  }

  private requestHangupFromTool(): void {
    if (this.closed) return
    this.hangupRequested = true
    setTimeout(() => this.completeHangupIfReady("tool_fallback"), 7_500).unref?.()
  }

  private completeHangupIfReady(trigger: string): void {
    if (!this.hangupRequested || this.closed || this.hangupStarted) return
    this.hangupStarted = true
    void this.hangup(trigger)
  }

  private async hangup(trigger: string): Promise<void> {
    const realtime = this.options.openaiRealtime
    const sip = this.options.openaiSip
    if (!realtime?.apiKey?.trim() || !sip) {
      this.close(trigger)
      return
    }
    try {
      const response = await (sip.fetch ?? fetch)(openAISipCallActionUrl(sip, this.metadata.callId, "hangup"), {
        method: "POST",
        headers: { authorization: `Bearer ${realtime.apiKey.trim()}` },
      })
      if (!response.ok) {
        const responseText = await response.text().catch(() => "")
        throw new Error(`OpenAI SIP call hangup failed: ${response.status} ${responseText}`.trim())
      }
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_openai_sip_hangup_end",
        message: "OpenAI SIP phone call hangup requested",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), trigger },
      })
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_openai_sip_hangup_error",
        message: "OpenAI SIP phone call hangup request failed",
        meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), trigger, error: errorMessage(error) },
      })
    } finally {
      this.close(trigger)
    }
  }

  private sendOpenAI(event: unknown): void {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return
    this.openaiWs.send(JSON.stringify(event))
  }

  private appendTranscript(role: "user" | "assistant", text: string): void {
    const content = text.trim()
    if (!content || !this.sessionPath) return
    this.sessionMessages.push({ role, content })
    saveSession(this.sessionPath, this.sessionMessages)
  }

  private close(trigger: string): void {
    if (this.closed) return
    this.closed = true
    this.clearOutboundAmdGreetingTimeout()
    this.registry?.unregister(this)
    if (this.openaiWs && (this.openaiWs.readyState === WebSocket.OPEN || this.openaiWs.readyState === WebSocket.CONNECTING)) {
      this.openaiWs.close()
    }
    if (this.pendingRealtimeResponseTimer) {
      clearTimeout(this.pendingRealtimeResponseTimer)
      this.pendingRealtimeResponseTimer = null
    }
    this.clearPendingUserTurnResponse()
    this.clearRealtimeToolPresenceTimers()
    this.clearUntrackedActiveRealtimeResponseTimer()
    this.queuedGatedRealtimeRequest = null
    this.floor.apply({ type: "call.ended", atMs: Date.now() })
    this.floorUnsubscribe?.()
    this.floorUnsubscribe = null
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_openai_sip_call_stop",
      message: "OpenAI SIP phone call control session stopped",
      meta: { agentName: this.options.agentName, callId: safeSegment(this.metadata.callId), trigger },
    })
  }
}
/* v8 ignore stop */

/* v8 ignore start -- active SIP registry map edge permutations belong with the post-D-012 transport split; SIP call lifecycle is covered through bridge tests @preserve */
class ActiveOpenAISipSessions implements OpenAISipPhoneSessionRegistry {
  private readonly byCallId = new Map<string, OpenAISipPhoneSession>()
  private readonly byOutboundId = new Map<string, OpenAISipPhoneSession>()

  register(session: OpenAISipPhoneSession): void {
    if (session.callId) this.byCallId.set(session.callId, session)
    if (session.outboundId) this.byOutboundId.set(session.outboundId, session)
  }

  unregister(session: OpenAISipPhoneSession): void {
    if (session.callId && this.byCallId.get(session.callId) === session) this.byCallId.delete(session.callId)
    if (session.outboundId && this.byOutboundId.get(session.outboundId) === session) this.byOutboundId.delete(session.outboundId)
  }

  getByOutboundId(outboundId: string): OpenAISipPhoneSession | undefined {
    return this.byOutboundId.get(outboundId)
  }
}
/* v8 ignore stop */

interface ActiveTwilioMediaStreams {
  byCallSid: Map<string, TwilioMediaStreamLifecycleSession>
  byOutboundId: Map<string, TwilioMediaStreamLifecycleSession>
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

/* v8 ignore start -- streaming job internals are covered through Twilio bridge playback routes; timeout/failure interleavings depend on request timing @preserve */
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
    if (this.byteLength === 0) {
      this.append(TWILIO_STREAM_FAILURE_SILENCE_MP3)
    }
    this.status = "failed"
    this.failure = errorMessage(error)
    this.notify()
  }

  waitForFirstChunk(timeoutMs: number): Promise<"ready" | "completed" | "failed" | "timeout"> {
    if (this.byteLength > 0) return Promise.resolve("ready")
    if (this.status === "completed") return Promise.resolve("completed")
    if (this.status === "failed") return Promise.resolve("failed")
    if (timeoutMs <= 0) return Promise.resolve("timeout")

    return new Promise((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (state: "ready" | "completed" | "failed" | "timeout"): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        this.waiters.delete(waiter)
        resolve(state)
      }
      const waiter = (): void => {
        if (this.byteLength > 0) {
          finish("ready")
        } else if (this.status === "completed") {
          finish("completed")
        } else if (this.status === "failed") {
          finish("failed")
        }
      }
      this.waiters.add(waiter)
      timeout = setTimeout(() => finish("timeout"), timeoutMs)
      timeout.unref?.()
    })
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
/* v8 ignore stop */

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

function twilioOutboundCallJobDir(outputDir: string): string {
  return path.join(outputDir, "outbound")
}

export function twilioOutboundCallJobPath(outputDir: string, outboundId: string): string {
  return path.join(twilioOutboundCallJobDir(outputDir), `${safeSegment(outboundId)}.json`)
}

export async function writeTwilioOutboundCallJob(outputDir: string, job: TwilioOutboundCallJob): Promise<void> {
  await fs.mkdir(twilioOutboundCallJobDir(outputDir), { recursive: true })
  await fs.writeFile(twilioOutboundCallJobPath(outputDir, job.outboundId), `${JSON.stringify(job, null, 2)}\n`, "utf8")
}

async function readTwilioOutboundCallJob(outputDir: string, outboundId: string): Promise<TwilioOutboundCallJob | null> {
  try {
    const raw = await fs.readFile(twilioOutboundCallJobPath(outputDir, outboundId), "utf8")
    const parsed = JSON.parse(raw) as TwilioOutboundCallJob
    return parsed && typeof parsed === "object" && parsed.schemaVersion === 1 ? parsed : null
  } catch {
    return null
  }
}

export async function updateTwilioOutboundCallJob(
  outputDir: string,
  outboundId: string,
  update: Partial<TwilioOutboundCallJob>,
): Promise<TwilioOutboundCallJob | null> {
  const existing = await readTwilioOutboundCallJob(outputDir, outboundId)
  if (!existing) return null
  const next: TwilioOutboundCallJob = {
    ...existing,
    ...update,
    outboundId: existing.outboundId,
    schemaVersion: 1,
    updatedAt: update.updatedAt ?? new Date().toISOString(),
  }
  await writeTwilioOutboundCallJob(outputDir, next)
  return next
}

export async function readRecentTwilioOutboundCallJobs(options: {
  outputDir: string
  to?: string
  friendId?: string
  sinceMs: number
  now?: number
}): Promise<TwilioOutboundCallJob[]> {
  const now = options.now ?? Date.now()
  let files: string[]
  try {
    files = await fs.readdir(twilioOutboundCallJobDir(options.outputDir))
  } catch {
    return []
  }
  const jobs: TwilioOutboundCallJob[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const outboundId = file.slice(0, -".json".length)
    const job = await readTwilioOutboundCallJob(options.outputDir, outboundId)
    if (!job) continue
    const createdAtMs = Date.parse(job.createdAt)
    if (!Number.isFinite(createdAtMs) || now - createdAtMs > options.sinceMs) continue
    if (options.to && normalizeTwilioE164PhoneNumber(job.to) !== normalizeTwilioE164PhoneNumber(options.to)) continue
    if (options.friendId && job.friendId !== options.friendId) continue
    jobs.push(job)
  }
  return jobs
}

export async function createTwilioOutboundCall(
  request: TwilioOutboundCallCreateRequest,
  fetchImpl: TwilioOutboundCallFetch = fetch,
): Promise<TwilioOutboundCallCreateResult> {
  const accountSid = request.accountSid.trim()
  const authToken = request.authToken.trim()
  const to = normalizeTwilioE164PhoneNumber(request.to)
  const from = normalizeTwilioE164PhoneNumber(request.from)
  if (!accountSid) throw new Error("missing Twilio account SID for outbound voice call")
  if (!authToken) throw new Error("missing Twilio auth token for outbound voice call")
  if (!to) throw new Error("outbound voice call target must be an E.164 phone number")
  if (!from) throw new Error("outbound voice call caller ID must be an E.164 phone number")
  const body = new URLSearchParams()
  body.set("To", to)
  body.set("From", from)
  body.set("Url", request.twimlUrl)
  body.set("Method", "POST")
  if (request.machineDetection) {
    body.set("MachineDetection", request.machineDetection)
  }
  if (request.asyncAmd === true) {
    body.set("AsyncAmd", "true")
  }
  if (request.asyncAmdStatusCallbackUrl) {
    body.set("AsyncAmdStatusCallback", request.asyncAmdStatusCallbackUrl)
    body.set("AsyncAmdStatusCallbackMethod", "POST")
  }
  if (request.statusCallbackUrl) {
    body.set("StatusCallback", request.statusCallbackUrl)
    body.set("StatusCallbackMethod", "POST")
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      body.append("StatusCallbackEvent", event)
    }
  }

  const response = await fetchImpl(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  )
  const responseText = await response.text()
  let parsed: Record<string, unknown> = {}
  if (responseText.trim()) {
    try {
      parsed = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      parsed = {}
    }
  }
  if (!response.ok) {
    const message = typeof parsed.message === "string" ? parsed.message : responseText
    throw new Error(`Twilio outbound voice call failed: ${response.status} ${message}`.trim())
  }
  return {
    callSid: typeof parsed.sid === "string" ? parsed.sid : undefined,
    status: typeof parsed.status === "string" ? parsed.status : undefined,
    queueTime: typeof parsed.queue_time === "string" ? parsed.queue_time : undefined,
  }
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

async function handleOpenAISipWebhook(
  options: TwilioPhoneBridgeOptions,
  request: TwilioPhoneBridgeRequest,
  activeSipSessions: OpenAISipPhoneSessionRegistry,
): Promise<TwilioPhoneBridgeResponse> {
  const rawBody = bodyText(request.body)
  const sip = options.openaiSip
  const webhookSecret = sip?.webhookSecret?.trim()
  if (!webhookSecret && !sip?.allowUnsignedWebhooks) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_openai_sip_webhook_unsigned_rejected",
      message: "rejected OpenAI SIP webhook because no signing secret is configured",
      meta: { agentName: options.agentName, path: request.path },
    })
    return textResponse(401, "OpenAI SIP webhook signing secret is not configured")
  }
  if (webhookSecret && !validateOpenAIWebhookSignature({
    secret: webhookSecret,
    headers: request.headers,
    payload: rawBody,
  })) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_openai_sip_signature_rejected",
      message: "rejected OpenAI SIP webhook with invalid signature",
      meta: { agentName: options.agentName, path: request.path },
    })
    return textResponse(400, "invalid OpenAI webhook signature")
  }

  const event = parseOpenAISipWebhookEvent(rawBody)
  if (!event) return textResponse(400, "invalid OpenAI webhook payload")
  if (event.type !== "realtime.call.incoming") return textResponse(200, "ok")
  const metadata = openAISipCallMetadata(event)
  if (!metadata) return textResponse(400, "missing OpenAI SIP call metadata")

  const session = new OpenAISipPhoneSession(options, metadata, activeSipSessions)
  /* v8 ignore next -- async SIP session startup failures are logged inside the session; webhook request intentionally returns immediately @preserve */
  void session.start().catch(() => undefined)
  return textResponse(200, "ok")
}

/* v8 ignore start -- Twilio webhook routing is covered by bridge/server tests; branch matrix mostly reflects transport fallbacks and provider callback variants @preserve */
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

  if (usesOpenAISipConversationEngine(options)) {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_sip_connect",
      message: "answering Twilio call by dialing OpenAI SIP",
      meta: { agentName: options.agentName, callSid: safeCallSid, sessionKey, conversationEngine: "openai-sip" },
    })
    return xmlResponse(openAISipDialTwiml(options, openAISipResponseHeaders({
      Agent: options.agentName,
      Direction: "inbound",
      From: params.From,
      To: params.To,
    })))
  }

  if (normalizeTwilioPhoneTransportMode(options.transportMode) === "media-stream") {
    if (usesOpenAIRealtimeConversationEngine(options)) {
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_media_connect",
        message: "answering Twilio call with OpenAI Realtime Media Stream",
        meta: { agentName: options.agentName, callSid: safeCallSid, sessionKey, conversationEngine: "openai-realtime" },
      })
      return xmlResponse(mediaStreamTwiml(options, basePath, params))
    }

    try {
      await fs.mkdir(callDir, { recursive: true })
      const transcript = buildVoiceTranscript({
        utteranceId,
        text: callConnectedPrompt(params),
        source: "loopback",
      })
      const greetingJobId = safeSegment(utteranceId)
      const job = startTwilioPlaybackStreamJob({
        jobs,
        bridgeOptions: options,
        basePath,
        callDir,
        safeCallSid,
        jobId: greetingJobId,
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
        meta: { agentName: options.agentName, callSid: safeCallSid, utteranceId, transportMode: "media-stream" },
      })
      const prebufferState = await job.waitForFirstChunk(options.greetingPrebufferMs ?? DEFAULT_TWILIO_GREETING_PREBUFFER_MS)
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_greeting_prebuffer",
        message: "Twilio Media Stream greeting prebuffer completed",
        meta: { agentName: options.agentName, callSid: safeCallSid, utteranceId, state: prebufferState, transportMode: "media-stream" },
      })
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_media_connect",
        message: "answering Twilio call with a bidirectional Media Stream",
        meta: { agentName: options.agentName, callSid: safeCallSid, sessionKey, greetingJob: prebufferState },
      })
      return xmlResponse(mediaStreamTwiml(
        options,
        basePath,
        params,
        prebufferState === "failed" ? undefined : greetingJobId,
      ))
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_incoming_error",
        message: "Twilio incoming media-stream greeting turn failed",
        meta: { agentName: options.agentName, callSid: safeCallSid, error: errorMessage(error), transportMode: "media-stream" },
      })
      return xmlResponse(mediaStreamTwiml(options, basePath, params))
    }
  }

  try {
    await fs.mkdir(callDir, { recursive: true })
    if (normalizeTwilioPhonePlaybackMode(options.playbackMode) === "stream") {
      const transcript = buildVoiceTranscript({
        utteranceId,
        text: callConnectedPrompt(params),
        source: "loopback",
      })
      const jobId = safeSegment(utteranceId)
      const job = startTwilioPlaybackStreamJob({
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
      const prebufferState = await job.waitForFirstChunk(options.greetingPrebufferMs ?? DEFAULT_TWILIO_GREETING_PREBUFFER_MS)
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_greeting_prebuffer",
        message: "Twilio greeting prebuffer completed",
        meta: { agentName: options.agentName, callSid: safeCallSid, utteranceId, state: prebufferState },
      })
      if (prebufferState === "failed") {
        return xmlResponse(recordTwiml({
          publicBaseUrl: options.publicBaseUrl,
          basePath,
          timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
          maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
        }))
      }
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

async function handleOutgoing(
  options: TwilioPhoneBridgeOptions,
  basePath: string,
  outboundId: string,
  params: Record<string, string>,
  jobs: TwilioAudioStreamJobStore,
): Promise<TwilioPhoneBridgeResponse> {
  const job = await readTwilioOutboundCallJob(options.outputDir, outboundId)
  if (!job) return textResponse(404, "outbound voice call not found")

  const callSid = params.CallSid?.trim() || job.transportCallSid || `outbound-${job.outboundId}`
  const safeCallSid = safeSegment(callSid)
  const answeredBy = params.AnsweredBy?.trim() || undefined
  const nonHumanStatus = nonHumanAnsweredStatus(answeredBy)
  if (nonHumanStatus) {
    await updateTwilioOutboundCallJob(options.outputDir, job.outboundId, {
      status: nonHumanStatus,
      answeredBy,
      transportCallSid: callSid,
      events: [
        ...(job.events ?? []),
        { at: new Date().toISOString(), status: nonHumanStatus, callSid, ...(answeredBy ? { answeredBy } : {}) },
      ],
    })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_outgoing_nonhuman_answer",
      message: "Twilio outbound voice call reached voicemail or fax",
      meta: {
        agentName: options.agentName,
        callSid: safeCallSid,
        outboundId: safeSegment(job.outboundId),
        status: nonHumanStatus,
        answeredBy: answeredBy ?? "unknown",
      },
    })
    return xmlResponse("<Hangup />")
  }

  const callDir = path.join(options.outputDir, safeCallSid)
  const utteranceId = `twilio-${safeCallSid}-outbound-connected`
  const friendId = job.friendId?.trim() || voiceFriendId(options, job.to, callSid)
  const from = normalizeTwilioE164PhoneNumber(params.From) ?? normalizeTwilioE164PhoneNumber(job.from) ?? job.from
  const to = normalizeTwilioE164PhoneNumber(params.To) ?? normalizeTwilioE164PhoneNumber(job.to) ?? job.to
  const sessionKey = twilioPhoneVoiceSessionKey({
    defaultFriendId: friendId,
    from: to,
    to: from,
    callSid,
  })
  await updateTwilioOutboundCallJob(options.outputDir, job.outboundId, {
    status: "answered",
    ...(answeredBy ? { answeredBy } : {}),
    transportCallSid: callSid,
    events: [
      ...(job.events ?? []),
      { at: new Date().toISOString(), status: "answered", callSid, ...(answeredBy ? { answeredBy } : {}) },
    ],
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_outgoing_answered",
    message: "Twilio outbound voice call answered",
    meta: { agentName: options.agentName, callSid: safeCallSid, outboundId: safeSegment(job.outboundId), sessionKey },
  })

  const streamParams = {
    Direction: "outbound",
    Remote: to,
    Line: from,
    FriendId: friendId,
    OutboundId: job.outboundId,
    Reason: job.reason,
    InitialAudio: encodeVoiceCallAudioCustomParameter(job.initialAudio),
  }

  if (usesOpenAISipOutboundConversationEngine(options)) {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_sip_connect",
      message: "answering Twilio outbound call by dialing OpenAI SIP",
      meta: { agentName: options.agentName, callSid: safeCallSid, outboundId: safeSegment(job.outboundId), sessionKey, conversationEngine: "openai-sip" },
    })
    return xmlResponse(openAISipDialTwiml(options, openAISipResponseHeaders({
      Agent: options.agentName,
      Direction: "outbound",
      From: to,
      To: from,
    }, {
      "X-Ouro-Outbound-Id": job.outboundId,
      "X-Ouro-Friend-Id": friendId,
      "X-Ouro-Reason": job.reason,
    })))
  }

  if (normalizeTwilioPhoneTransportMode(options.transportMode) === "media-stream") {
    if (usesOpenAIRealtimeOutboundConversationEngine(options)) {
      return xmlResponse(mediaStreamTwiml(options, basePath, { From: from, To: to }, undefined, streamParams, "openai-realtime"))
    }

    try {
      await fs.mkdir(callDir, { recursive: true })
      const greetingJobId = safeSegment(utteranceId)
      if (job.prewarmedGreeting?.audioPath) {
        try {
          const streamJob = jobs.create(safeCallSid, greetingJobId, job.prewarmedGreeting.mimeType)
          streamJob.append(await fs.readFile(job.prewarmedGreeting.audioPath))
          streamJob.complete()
          emitNervesEvent({
            component: "senses",
            event: "senses.voice_twilio_greeting_prewarmed",
            message: "Twilio Media Stream outbound greeting was ready before answer",
            meta: {
              agentName: options.agentName,
              callSid: safeCallSid,
              outboundId: safeSegment(job.outboundId),
              utteranceId,
              byteLength: String(job.prewarmedGreeting.byteLength),
            },
          })
          return xmlResponse(mediaStreamTwiml(options, basePath, { From: from, To: to }, greetingJobId, streamParams))
        } catch (error) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.voice_twilio_greeting_prewarm_unavailable",
            message: "Twilio Media Stream outbound greeting prewarm could not be used",
            meta: {
              agentName: options.agentName,
              callSid: safeCallSid,
              outboundId: safeSegment(job.outboundId),
              utteranceId,
              error: errorMessage(error),
            },
          })
        }
      }
      const transcript = buildVoiceTranscript({
        utteranceId,
        text: outboundCallAnsweredPrompt(job, { From: from, To: to }),
        source: "loopback",
      })
      const streamJob = startTwilioPlaybackStreamJob({
        jobs,
        bridgeOptions: options,
        basePath,
        callDir,
        safeCallSid,
        jobId: greetingJobId,
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
        meta: { agentName: options.agentName, callSid: safeCallSid, utteranceId, transportMode: "media-stream", outboundId: safeSegment(job.outboundId) },
      })
      const prebufferState = await streamJob.waitForFirstChunk(options.greetingPrebufferMs ?? DEFAULT_TWILIO_GREETING_PREBUFFER_MS)
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_greeting_prebuffer",
        message: "Twilio Media Stream greeting prebuffer completed",
        meta: { agentName: options.agentName, callSid: safeCallSid, utteranceId, state: prebufferState, transportMode: "media-stream" },
      })
      return xmlResponse(mediaStreamTwiml(
        options,
        basePath,
        { From: from, To: to },
        prebufferState === "failed" ? undefined : greetingJobId,
        streamParams,
      ))
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_twilio_incoming_error",
        message: "Twilio outbound media-stream greeting turn failed",
        meta: { agentName: options.agentName, callSid: safeCallSid, outboundId: safeSegment(job.outboundId), error: errorMessage(error), transportMode: "media-stream" },
      })
      return xmlResponse(mediaStreamTwiml(options, basePath, { From: from, To: to }, undefined, {
        ...streamParams,
      }))
    }
  }

  try {
    await fs.mkdir(callDir, { recursive: true })
    return await runPhonePromptTurn({
      bridgeOptions: options,
      basePath,
      callDir,
      safeCallSid,
      utteranceId,
      friendId,
      sessionKey,
      promptText: outboundCallAnsweredPrompt(job, { From: from, To: to }),
      afterPlayback: "record",
    })
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_twilio_incoming_error",
      message: "Twilio outbound voice greeting turn failed",
      meta: { agentName: options.agentName, callSid: safeCallSid, outboundId: safeSegment(job.outboundId), error: errorMessage(error) },
    })
    return xmlResponse(recordTwiml({
      publicBaseUrl: options.publicBaseUrl,
      basePath,
      timeoutSeconds: options.recordTimeoutSeconds ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
      maxLengthSeconds: options.recordMaxLengthSeconds ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
    }))
  }
}

async function handleOutgoingStatus(
  options: TwilioPhoneBridgeOptions,
  outboundId: string,
  params: Record<string, string>,
): Promise<TwilioPhoneBridgeResponse> {
  const job = await readTwilioOutboundCallJob(options.outputDir, outboundId)
  if (!job) return textResponse(404, "outbound voice call not found")
  const rawStatus = params.CallStatus?.trim() || params.CallStatusCallbackEvent?.trim() || "unknown"
  const callSid = params.CallSid?.trim() || job.transportCallSid
  const answeredBy = params.AnsweredBy?.trim() || undefined
  const existingTerminalNonHuman = job.status === "voicemail" || job.status === "fax" ? job.status : undefined
  const status = nonHumanAnsweredStatus(answeredBy) ?? existingTerminalNonHuman ?? rawStatus
  await updateTwilioOutboundCallJob(options.outputDir, job.outboundId, {
    status,
    ...(answeredBy ? { answeredBy } : {}),
    transportCallSid: callSid,
    events: [
      ...(job.events ?? []),
      { at: new Date().toISOString(), status, ...(callSid ? { callSid } : {}), ...(answeredBy ? { answeredBy } : {}) },
    ],
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_outgoing_status",
    message: "Twilio outbound voice call status changed",
    meta: { agentName: options.agentName, callSid: safeSegment(callSid ?? "unknown"), outboundId: safeSegment(job.outboundId), status },
  })
  return textResponse(200, "ok")
}

async function handleOutgoingAmdStatus(
  options: TwilioPhoneBridgeOptions,
  outboundId: string,
  params: Record<string, string>,
  activeMediaStreams: ActiveTwilioMediaStreams,
  activeSipSessions: OpenAISipPhoneSessionRegistry,
): Promise<TwilioPhoneBridgeResponse> {
  const job = await readTwilioOutboundCallJob(options.outputDir, outboundId)
  if (!job) return textResponse(404, "outbound voice call not found")
  const callSid = params.CallSid?.trim() || job.transportCallSid
  const answeredBy = params.AnsweredBy?.trim() || "unknown"
  const nonHumanStatus = nonHumanAnsweredStatus(answeredBy)
  const status = nonHumanStatus ?? job.status ?? "answered"
  await updateTwilioOutboundCallJob(options.outputDir, job.outboundId, {
    status,
    answeredBy,
    transportCallSid: callSid,
    events: [
      ...(job.events ?? []),
      { at: new Date().toISOString(), status: nonHumanStatus ? status : `amd-${answeredBy}`, ...(callSid ? { callSid } : {}), answeredBy },
    ],
  })
  if (nonHumanStatus) {
    const session = activeMediaStreams.byOutboundId.get(job.outboundId)
      ?? (callSid ? activeMediaStreams.byCallSid.get(callSid) : undefined)
    session?.end()
    activeSipSessions.getByOutboundId(job.outboundId)?.handleAsyncAmd(answeredBy, nonHumanStatus)
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_outgoing_async_amd_nonhuman",
      message: "Twilio async AMD reported a non-human outbound answer",
      meta: {
        agentName: options.agentName,
        callSid: safeSegment(callSid ?? "unknown"),
        outboundId: safeSegment(job.outboundId),
        answeredBy,
        status,
      },
    })
    return textResponse(200, "ok")
  }
  activeSipSessions.getByOutboundId(job.outboundId)?.handleAsyncAmd(answeredBy)
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_outgoing_async_amd",
    message: "Twilio async AMD reported an outbound answer classification",
    meta: {
      agentName: options.agentName,
      callSid: safeSegment(callSid ?? "unknown"),
      outboundId: safeSegment(job.outboundId),
      answeredBy,
      status,
    },
  })
  return textResponse(200, "ok")
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
  const sipWebhookPath = normalizeTwilioPhoneBasePath(options.openaiSip?.webhookPath ?? openAISipWebhookPath(options.agentName))
  const jobs = new TwilioAudioStreamJobStore()
  const mediaStreams = new WebSocketServer({ noServer: true })
  const activeMediaStreams: ActiveTwilioMediaStreams = {
    byCallSid: new Map(),
    byOutboundId: new Map(),
  }
  const activeSipSessions = new ActiveOpenAISipSessions()

  mediaStreams.on("connection", (ws, request: http.IncomingMessage) => {
    const lifecycle: {
      onIdentityChange: (session: TwilioMediaStreamLifecycleSession, identity: { callSid: string; outboundId: string }) => void
      onClose: (session: TwilioMediaStreamLifecycleSession, identity: { callSid: string; outboundId: string }) => void
    } = {
      onIdentityChange: (activeSession, identity) => {
        if (identity.callSid) activeMediaStreams.byCallSid.set(identity.callSid, activeSession)
        if (identity.outboundId) activeMediaStreams.byOutboundId.set(identity.outboundId, activeSession)
      },
      onClose: (activeSession, identity) => {
        if (identity.callSid && activeMediaStreams.byCallSid.get(identity.callSid) === activeSession) {
          activeMediaStreams.byCallSid.delete(identity.callSid)
        }
        if (identity.outboundId && activeMediaStreams.byOutboundId.get(identity.outboundId) === activeSession) {
          activeMediaStreams.byOutboundId.delete(identity.outboundId)
        }
      },
    }
    const streamEngine = mediaStreamRequestedConversationEngine(request.url)
    const session = streamEngine === "openai-realtime" || (!streamEngine && usesOpenAIRealtimeConversationEngine(options))
      ? new TwilioOpenAIRealtimeMediaStreamSession(ws, options, lifecycle)
      : new TwilioMediaStreamSession(ws, options, jobs, lifecycle)
    session.attach()
  })

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
      if (method === "GET" && routePath === `${sipWebhookPath}/health`) {
        return textResponse(200, "ok")
      }
      if (method === "GET") return textResponse(404, "not found")
      if (method !== "POST") return textResponse(405, "method not allowed")

      if (routePath === sipWebhookPath) {
        return handleOpenAISipWebhook(options, { ...request, path: requestPath }, activeSipSessions)
      }

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
      if (routePath.startsWith(`${basePath}/outgoing/`)) {
        const outgoingRest = routePath.slice(`${basePath}/outgoing/`.length)
        const [outboundIdPart, suffix] = outgoingRest.split("/")
        const outboundId = outboundIdPart ? decodeSafeSegment(outboundIdPart) : null
        if (!outboundId) return textResponse(404, "not found")
        if (suffix === "status") return handleOutgoingStatus(options, outboundId, params)
        if (suffix === "amd") return handleOutgoingAmdStatus(options, outboundId, params, activeMediaStreams, activeSipSessions)
        if (suffix === undefined) return handleOutgoing(options, basePath, outboundId, params, jobs)
      }
      if (routePath === `${basePath}/listen`) return handleListen(options, basePath)
      if (routePath === `${basePath}/recording`) return handleRecording(options, basePath, params, jobs)
      return textResponse(404, "not found")
    },
    handleUpgrade(request, socket, head): boolean {
      const requestPath = request.url?.startsWith("/") ? request.url : `/${request.url ?? ""}`
      const routePath = requestPath.split("?")[0]!
      if (
        routePath !== `${basePath}/media-stream`
        || normalizeTwilioPhoneTransportMode(options.transportMode) !== "media-stream"
      ) {
        return false
      }

      mediaStreams.handleUpgrade(request, socket, head, (ws) => {
        mediaStreams.emit("connection", ws, request)
      })
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_twilio_media_upgrade",
        message: "accepted Twilio Media Stream WebSocket upgrade",
        meta: { agentName: options.agentName, path: routePath },
      })
      return true
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        mediaStreams.close((error?: Error) => error ? reject(error) : resolve())
      })
    },
  }
}
/* v8 ignore stop */

/* v8 ignore start -- HTTP server adapter behavior is covered through startTwilioPhoneBridgeServer smoke tests; low-level stream disconnect branches are platform-dependent @preserve */
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

function waitForDrain(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", onDrain)
      res.off("error", onError)
      res.off("close", onClose)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      const error = new Error("response closed before drain")
      ;(error as Error & { code?: string }).code = "ERR_STREAM_PREMATURE_CLOSE"
      reject(error)
    }
    res.once("drain", onDrain)
    res.once("error", onError)
    res.once("close", onClose)
  })
}

function isClientDisconnectError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_PREMATURE_CLOSE") {
    return true
  }
  const message = errorMessage(error).toLowerCase()
  return message.includes("aborted")
    || message.includes("socket hang up")
    || message.includes("premature close")
    || message.includes("stream destroyed")
    || message.includes("write after end")
    || message.includes("response closed before drain")
}

async function writeResponseBody(res: http.ServerResponse, body: TwilioPhoneBridgeResponse["body"]): Promise<void> {
  if (!isAsyncIterableBody(body)) {
    res.end(body)
    return
  }

  try {
    for await (const chunk of body) {
      if (res.destroyed || res.writableEnded) return
      /* v8 ignore next -- exercised only when Node reports socket backpressure @preserve */
      if (!res.write(chunk)) {
        await waitForDrain(res)
      }
    }
  } catch (error) {
    if (isClientDisconnectError(error)) return
    throw error
  }
  if (!res.destroyed && !res.writableEnded) {
    res.end()
  }
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
  server.on("upgrade", (req, socket, head) => {
    const handled = bridge.handleUpgrade?.(req, socket, head) ?? false
    if (!handled) {
      socket.destroy()
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
/* v8 ignore stop */
