import * as path from "path"
import * as crypto from "node:crypto"
import type { Server } from "http"
import { getAgentRoot, loadAgentConfig, type AgentConfig, type AgentProvider } from "../../heart/identity"
import { loadOrCreateMachineIdentity, type MachineIdentity } from "../../heart/machine-identity"
import { readProviderCredentialPool, refreshProviderCredentialPool } from "../../heart/provider-credentials"
import {
  readMachineRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
  waitForRuntimeCredentialBootstrap,
  type RuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
} from "../../heart/runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { createElevenLabsTtsClient } from "./elevenlabs"
import { writeVoicePlaybackArtifact } from "./playback"
import { buildVoiceTranscript } from "./transcript"
import {
  DEFAULT_TWILIO_PHONE_PORT,
  DEFAULT_TWILIO_GREETING_PREBUFFER_MS,
  DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
  TWILIO_PHONE_WEBHOOK_BASE_PATH,
  DEFAULT_TWILIO_PHONE_PLAYBACK_MODE,
  DEFAULT_TWILIO_PHONE_TRANSPORT_MODE,
  normalizeTwilioPhoneBasePath,
  normalizeTwilioPhoneConversationEngine,
  normalizeTwilioPhonePlaybackMode,
  normalizeTwilioPhoneTransportMode,
  normalizeTwilioE164PhoneNumber,
  openAISipWebhookPath,
  openAISipWebhookUrl,
  startTwilioPhoneBridgeServer,
  createTwilioOutboundCall,
  outboundCallAnsweredPrompt,
  readRecentTwilioOutboundCallJobs,
  twilioOutboundCallAmdCallbackUrl,
  twilioOutboundCallStatusCallbackUrl,
  twilioOutboundCallWebhookUrl,
  twilioPhoneWebhookUrl,
  twilioPhoneVoiceSessionKey,
  updateTwilioOutboundCallJob,
  writeTwilioOutboundCallJob,
  type StartTwilioPhoneBridgeServerOptions,
  type OpenAIRealtimeTwilioOptions,
  type OpenAISipPhoneOptions,
  type TwilioPhoneConversationEngine,
  type TwilioPhonePlaybackMode,
  type TwilioPhoneTransportMode,
  type TwilioPhoneBridgeServer,
  type TwilioOutboundCallCreateRequest,
  type TwilioOutboundCallCreateResult,
} from "./twilio-phone"
import type { VoiceCallAudioRequest } from "../../repertoire/tools-base"
import { runVoiceLoopbackTurn } from "./turn"
import { createWhisperCppTranscriber } from "./whisper"

type OpenAIRealtimeTurnDetectionOptions = NonNullable<OpenAIRealtimeTwilioOptions["turnDetection"]>

export interface TwilioPhoneTransportRuntimeOverrides {
  enabled?: boolean
  publicBaseUrl?: string
  basePath?: string
  port?: number
  host?: string
  outputDir?: string
  defaultFriendId?: string
  elevenLabsVoiceId?: string
  whisperCliPath?: string
  whisperModelPath?: string
  recordTimeoutSeconds?: number
  recordMaxLengthSeconds?: number
  greetingPrebufferMs?: number
  playbackMode?: TwilioPhonePlaybackMode
  transportMode?: TwilioPhoneTransportMode
  conversationEngine?: TwilioPhoneConversationEngine
  outboundConversationEngine?: TwilioPhoneConversationEngine
  openaiRealtimeApiKey?: string
  openaiRealtimeModel?: string
  openaiRealtimeVoice?: string
  openaiRealtimeVoiceStyle?: string
  openaiRealtimeVoiceSpeed?: number
  openaiRealtimeWebsocketUrl?: string
  openaiRealtimeReasoningEffort?: OpenAIRealtimeTwilioOptions["reasoningEffort"]
  openaiRealtimeNoiseReduction?: OpenAIRealtimeTwilioOptions["noiseReduction"]
  openaiRealtimeTurnDetectionMode?: OpenAIRealtimeTurnDetectionOptions["mode"]
  openaiRealtimeVadThreshold?: number
  openaiRealtimeVadPrefixPaddingMs?: number
  openaiRealtimeVadSilenceDurationMs?: number
  openaiRealtimeVadIdleTimeoutMs?: number
  openaiRealtimeVadEagerness?: OpenAIRealtimeTurnDetectionOptions["eagerness"]
  openaiRealtimeVadCreateResponse?: boolean
  openaiRealtimeVadInterruptResponse?: boolean
  openaiSipProjectId?: string
  openaiSipWebhookPath?: string
  openaiSipWebhookSecret?: string
  openaiSipAllowUnsignedWebhooks?: boolean
  openaiSipApiBaseUrl?: string
  openaiSipWebsocketBaseUrl?: string
  twilioFromNumber?: string
}

export interface TwilioPhoneTransportRuntimeSettings {
  agentName: string
  publicBaseUrl: string
  basePath: string
  webhookUrl: string
  outputDir: string
  port: number
  host: string
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
  whisperCliPath: string
  whisperModelPath: string
  twilioAccountSid?: string
  twilioAuthToken?: string
  twilioFromNumber?: string
  defaultFriendId?: string
  recordTimeoutSeconds: number
  recordMaxLengthSeconds: number
  greetingPrebufferMs: number
  playbackMode: TwilioPhonePlaybackMode
  transportMode: TwilioPhoneTransportMode
  conversationEngine: TwilioPhoneConversationEngine
  outboundConversationEngine: TwilioPhoneConversationEngine
  openaiRealtime?: OpenAIRealtimeTwilioOptions
  openaiSip?: OpenAISipPhoneOptions
  openaiSipWebhookUrl?: string
}

export type TwilioPhoneTransportRuntimeResolution =
  | { status: "disabled"; reason: string }
  | { status: "configured"; settings: TwilioPhoneTransportRuntimeSettings }

export type TwilioPhoneTransportRuntimeState =
  | { status: "disabled"; reason: string }
  | {
    status: "started"
    settings: TwilioPhoneTransportRuntimeSettings
    bridge: TwilioPhoneBridgeServer
  }

export interface ResolveTwilioPhoneTransportRuntimeOptions {
  agentName: string
  runtimeConfig: RuntimeCredentialConfig
  machineConfig: RuntimeCredentialConfig
  overrides?: TwilioPhoneTransportRuntimeOverrides
  defaultBasePath?: string
  requirePublicUrl?: boolean
}

export interface StartConfiguredTwilioPhoneTransportOptions {
  agentName: string
  overrides?: TwilioPhoneTransportRuntimeOverrides
  defaultBasePath?: string
  requirePublicUrl?: boolean
}

export interface TwilioPhoneTransportRuntimeDeps {
  waitForRuntimeCredentialBootstrap: typeof waitForRuntimeCredentialBootstrap
  loadMachineIdentity: () => MachineIdentity
  refreshRuntimeConfig: typeof refreshRuntimeCredentialConfig
  refreshMachineRuntimeConfig: typeof refreshMachineRuntimeCredentialConfig
  readRuntimeConfig: typeof readRuntimeCredentialConfig
  readMachineRuntimeConfig: typeof readMachineRuntimeCredentialConfig
  cacheSelectedProviderCredentials: (agentName: string) => Promise<void>
  createTranscriber: typeof createWhisperCppTranscriber
  createTts: typeof createElevenLabsTtsClient
  startBridgeServer: (options: StartTwilioPhoneBridgeServerOptions) => Promise<TwilioPhoneBridgeServer>
}

export interface PlaceConfiguredTwilioPhoneCallOptions {
  agentName: string
  friendId?: string
  to: string
  reason: string
  outboundId?: string
  now?: Date
  redialGuardMs?: number
  initialAudio?: VoiceCallAudioRequest
}

export interface PlaceConfiguredTwilioPhoneCallResult {
  outboundId: string
  callSid?: string
  status?: string
  webhookUrl: string
  statusCallbackUrl: string
}

export interface TwilioPhoneOutboundCallRuntimeDeps {
  waitForRuntimeCredentialBootstrap: typeof waitForRuntimeCredentialBootstrap
  loadMachineIdentity: () => MachineIdentity
  refreshRuntimeConfig: typeof refreshRuntimeCredentialConfig
  refreshMachineRuntimeConfig: typeof refreshMachineRuntimeCredentialConfig
  readRuntimeConfig: typeof readRuntimeCredentialConfig
  readMachineRuntimeConfig: typeof readMachineRuntimeCredentialConfig
  createTts: typeof createElevenLabsTtsClient
  runVoiceLoopbackTurn: typeof runVoiceLoopbackTurn
  writeVoicePlaybackArtifact: typeof writeVoicePlaybackArtifact
  createOutboundCall: (request: TwilioOutboundCallCreateRequest) => Promise<TwilioOutboundCallCreateResult>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function configString(config: RuntimeCredentialConfig, dottedPath: string): string | undefined {
  let cursor: unknown = config
  for (const segment of dottedPath.split(".")) {
    const record = asRecord(cursor)
    if (!record) return undefined
    cursor = record[segment]
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : undefined
}

function configNumber(config: RuntimeCredentialConfig, dottedPath: string): number | undefined {
  let cursor: unknown = config
  for (const segment of dottedPath.split(".")) {
    const record = asRecord(cursor)
    if (!record) return undefined
    cursor = record[segment]
  }
  if (typeof cursor === "number" && Number.isFinite(cursor)) return cursor
  if (typeof cursor === "string" && cursor.trim()) {
    const parsed = Number(cursor)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function configBoolean(config: RuntimeCredentialConfig, dottedPath: string): boolean | undefined {
  let cursor: unknown = config
  for (const segment of dottedPath.split(".")) {
    const record = asRecord(cursor)
    if (!record) return undefined
    cursor = record[segment]
  }
  if (typeof cursor === "boolean") return cursor
  if (typeof cursor === "string") {
    const normalized = cursor.trim().toLowerCase()
    if (normalized === "true") return true
    if (normalized === "false") return false
  }
  return undefined
}

function requireConfig(result: RuntimeCredentialConfigReadResult, label: string): RuntimeCredentialConfig {
  if (result.ok) return result.config
  throw new Error(`${label} unavailable: ${result.error}`)
}

function required(value: string | undefined, guidance: string): string {
  if (value) return value
  throw new Error(guidance)
}

function selectedAgentProviders(config: AgentConfig): AgentProvider[] {
  const providers = new Set<AgentProvider>()
  providers.add(config.humanFacing.provider)
  providers.add(config.agentFacing.provider)
  if (config.provider) providers.add(config.provider)
  return [...providers]
}

async function cacheSelectedProviderCredentials(agentName: string): Promise<void> {
  const providers = selectedAgentProviders(loadAgentConfig())
  const cached = readProviderCredentialPool(agentName)
  /* v8 ignore next -- fast path is covered by provider credential pool tests; voice runtime tests exercise refresh/repair paths @preserve */
  if (cached.ok && providers.every((provider) => cached.pool.providers[provider])) return
  const pool = await refreshProviderCredentialPool(agentName, { providers })
  if (!pool.ok) {
    throw new Error(`provider credentials unavailable for phone voice: ${pool.error}`)
  }
  const missing = providers.filter((provider) => !pool.pool.providers[provider])
  if (missing.length > 0) {
    throw new Error(`missing provider credentials for phone voice: ${missing.join(", ")}`)
  }
}

function agentPathSegment(agentName: string): string {
  return agentName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
}

function trimOptional(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function resolveOpenAIRealtimeApiKey(options: {
  runtimeConfig: RuntimeCredentialConfig
  overrides?: TwilioPhoneTransportRuntimeOverrides
}): { apiKey: string; source: string } | undefined {
  const overrideKey = trimOptional(options.overrides?.openaiRealtimeApiKey)
  /* v8 ignore next -- operator CLI overrides use the same validated setting shape as stored runtime config @preserve */
  if (overrideKey) return { apiKey: overrideKey, source: "override.openaiRealtimeApiKey" }

  const voiceKey = configString(options.runtimeConfig, "voice.openaiRealtimeApiKey")
  if (voiceKey) return { apiKey: voiceKey, source: "voice.openaiRealtimeApiKey" }

  const integrationKey = configString(options.runtimeConfig, "integrations.openaiApiKey")
  if (integrationKey) return { apiKey: integrationKey, source: "integrations.openaiApiKey" }

  const compatKey = configString(options.runtimeConfig, "integrations.openaiEmbeddingsApiKey")
  if (compatKey) return { apiKey: compatKey, source: "integrations.openaiEmbeddingsApiKey" }

  return undefined
}

function configuredConversationEngine(
  options: ResolveTwilioPhoneTransportRuntimeOptions,
  overrides: TwilioPhoneTransportRuntimeOverrides,
  transportMode: TwilioPhoneTransportMode,
): TwilioPhoneConversationEngine {
  const explicit = overrides.conversationEngine
    ?? configString(options.machineConfig, "voice.twilioConversationEngine")
    ?? configString(options.machineConfig, "voice.conversationEngine")
    ?? configString(options.runtimeConfig, "voice.twilioConversationEngine")
    ?? configString(options.runtimeConfig, "voice.conversationEngine")
  const hasSipConfig = !!(
    configString(options.runtimeConfig, "voice.openaiSipProjectId")
    || configString(options.machineConfig, "voice.openaiSipProjectId")
  )
  const explicitEngine = explicit ? normalizeTwilioPhoneConversationEngine(explicit) : undefined
  if (hasSipConfig && (!explicitEngine || explicitEngine === "cascade")) return "openai-sip"
  if (explicitEngine) return explicitEngine

  const hasRealtimeConfig = !!resolveOpenAIRealtimeApiKey({ runtimeConfig: options.runtimeConfig, overrides })
  if (hasRealtimeConfig && transportMode === "media-stream") return "openai-realtime"

  return "cascade"
}

function configuredOutboundConversationEngine(
  options: ResolveTwilioPhoneTransportRuntimeOptions,
  overrides: TwilioPhoneTransportRuntimeOverrides,
  conversationEngine: TwilioPhoneConversationEngine,
  transportMode: TwilioPhoneTransportMode,
): TwilioPhoneConversationEngine {
  const defaultOutboundEngine = conversationEngine === "openai-sip" && transportMode === "media-stream"
    ? "openai-realtime"
    : conversationEngine
  const configured = overrides.outboundConversationEngine
    ?? normalizeTwilioPhoneConversationEngine(
      configString(options.machineConfig, "voice.twilioOutboundConversationEngine")
      ?? configString(options.machineConfig, "voice.outboundConversationEngine")
      ?? configString(options.runtimeConfig, "voice.twilioOutboundConversationEngine")
      ?? configString(options.runtimeConfig, "voice.outboundConversationEngine")
      ?? defaultOutboundEngine,
    )
  if (defaultOutboundEngine === "openai-realtime" && configured === "cascade") return defaultOutboundEngine
  return configured
}

function normalizeOpenAIRealtimeReasoningEffort(
  value: string | undefined,
): OpenAIRealtimeTwilioOptions["reasoningEffort"] | undefined {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === "minimal"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "xhigh"
  ) {
    return normalized
  }
  return undefined
}

function normalizeOpenAIRealtimeNoiseReduction(
  value: string | undefined,
): OpenAIRealtimeTwilioOptions["noiseReduction"] | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "near_field" || normalized === "far_field" || normalized === "none") return normalized
  return undefined
}

function normalizeOpenAIRealtimeTurnDetectionMode(
  value: string | undefined,
): OpenAIRealtimeTurnDetectionOptions["mode"] | undefined {
  const normalized = value?.trim().toLowerCase()
  /* v8 ignore next -- mode values are passed through from OpenAI config; invalid fallback is the important fail-soft path @preserve */
  if (normalized === "server_vad" || normalized === "semantic_vad") return normalized
  return undefined
}

function normalizeOpenAIRealtimeVadEagerness(
  value: string | undefined,
): OpenAIRealtimeTurnDetectionOptions["eagerness"] | undefined {
  const normalized = value?.trim().toLowerCase()
  /* v8 ignore next -- eagerness values are passed through from OpenAI config; invalid fallback is the important fail-soft path @preserve */
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "auto") return normalized
  return undefined
}

function errorMessage(error: unknown): string {
  /* v8 ignore next -- thrown runtime values are Errors in supported call paths @preserve */
  return error instanceof Error ? error.message : String(error)
}

export function agentScopedTwilioPhoneBasePath(agentName: string): string {
  return `/voice/agents/${agentPathSegment(agentName)}/twilio`
}

export function resolveTwilioPhoneTransportRuntime(
  options: ResolveTwilioPhoneTransportRuntimeOptions,
): TwilioPhoneTransportRuntimeResolution {
  const overrides = options.overrides ?? {}
  const configuredPublicBaseUrl = trimOptional(overrides.publicBaseUrl)
    ?? configString(options.machineConfig, "voice.twilioPublicUrl")
  const explicitEnabled = overrides.enabled ?? configBoolean(options.machineConfig, "voice.twilioEnabled")
  if (!configuredPublicBaseUrl && options.requirePublicUrl) {
    throw new Error("missing voice.twilioPublicUrl in this machine's runtime config")
  }
  const enabled = explicitEnabled ?? !!configuredPublicBaseUrl
  if (!enabled) {
    return { status: "disabled", reason: "voice.twilioPublicUrl is not configured" }
  }
  if (!configuredPublicBaseUrl) {
    throw new Error("missing voice.twilioPublicUrl in this machine's runtime config")
  }

  const publicUrl = new URL(configuredPublicBaseUrl)
  if (publicUrl.protocol !== "https:") {
    throw new Error("voice.twilioPublicUrl must be an https URL")
  }
  const publicBaseUrl = publicUrl.toString()
  const basePath = normalizeTwilioPhoneBasePath(
    overrides.basePath
      ?? configString(options.machineConfig, "voice.twilioBasePath")
      ?? options.defaultBasePath
      ?? TWILIO_PHONE_WEBHOOK_BASE_PATH,
  )
  const transportMode = overrides.transportMode
    ?? normalizeTwilioPhoneTransportMode(configString(options.machineConfig, "voice.twilioTransportMode") ?? DEFAULT_TWILIO_PHONE_TRANSPORT_MODE)
  const conversationEngine = configuredConversationEngine(options, overrides, transportMode)
  const outboundConversationEngine = configuredOutboundConversationEngine(options, overrides, conversationEngine, transportMode)
  const needsOpenAIRealtime = conversationEngine === "openai-realtime"
    || conversationEngine === "openai-sip"
    || outboundConversationEngine === "openai-realtime"
    || outboundConversationEngine === "openai-sip"
  const needsOpenAISip = conversationEngine === "openai-sip" || outboundConversationEngine === "openai-sip"
  const needsCascade = conversationEngine === "cascade" || outboundConversationEngine === "cascade"

  let elevenLabsApiKey = configString(options.runtimeConfig, "integrations.elevenLabsApiKey") ?? ""
  let elevenLabsVoiceId = trimOptional(overrides.elevenLabsVoiceId)
    ?? configString(options.runtimeConfig, "integrations.elevenLabsVoiceId")
    ?? configString(options.runtimeConfig, "voice.elevenLabsVoiceId")
    ?? ""
  let whisperCliPath = trimOptional(overrides.whisperCliPath)
    ?? configString(options.machineConfig, "voice.whisperCliPath")
    ?? ""
  let whisperModelPath = trimOptional(overrides.whisperModelPath)
    ?? configString(options.machineConfig, "voice.whisperModelPath")
    ?? ""
  let openaiRealtime: OpenAIRealtimeTwilioOptions | undefined
  let openaiSip: OpenAISipPhoneOptions | undefined

  if (needsOpenAIRealtime) {
    if ((conversationEngine === "openai-realtime" || outboundConversationEngine === "openai-realtime") && transportMode !== "media-stream") {
      throw new Error("voice.twilioConversationEngine/openai-realtime requires voice.twilioTransportMode=media-stream")
    }
    const key = resolveOpenAIRealtimeApiKey({ runtimeConfig: options.runtimeConfig, overrides })
    if (!key) {
      throw new Error("missing voice.openaiRealtimeApiKey; save an OpenAI Realtime-capable API key before starting phone voice")
    }
    const turnDetection: OpenAIRealtimeTurnDetectionOptions = {
      mode: overrides.openaiRealtimeTurnDetectionMode
        ?? normalizeOpenAIRealtimeTurnDetectionMode(configString(options.machineConfig, "voice.openaiRealtimeTurnDetectionMode"))
        ?? normalizeOpenAIRealtimeTurnDetectionMode(configString(options.runtimeConfig, "voice.openaiRealtimeTurnDetectionMode")),
      threshold: overrides.openaiRealtimeVadThreshold
        ?? configNumber(options.machineConfig, "voice.openaiRealtimeVadThreshold")
        ?? configNumber(options.runtimeConfig, "voice.openaiRealtimeVadThreshold"),
      prefixPaddingMs: overrides.openaiRealtimeVadPrefixPaddingMs
        ?? configNumber(options.machineConfig, "voice.openaiRealtimeVadPrefixPaddingMs")
        ?? configNumber(options.runtimeConfig, "voice.openaiRealtimeVadPrefixPaddingMs"),
      silenceDurationMs: overrides.openaiRealtimeVadSilenceDurationMs
        ?? configNumber(options.machineConfig, "voice.openaiRealtimeVadSilenceDurationMs")
        ?? configNumber(options.runtimeConfig, "voice.openaiRealtimeVadSilenceDurationMs"),
      idleTimeoutMs: overrides.openaiRealtimeVadIdleTimeoutMs
        ?? configNumber(options.machineConfig, "voice.openaiRealtimeVadIdleTimeoutMs")
        ?? configNumber(options.runtimeConfig, "voice.openaiRealtimeVadIdleTimeoutMs"),
      eagerness: overrides.openaiRealtimeVadEagerness
        ?? normalizeOpenAIRealtimeVadEagerness(configString(options.machineConfig, "voice.openaiRealtimeVadEagerness"))
        ?? normalizeOpenAIRealtimeVadEagerness(configString(options.runtimeConfig, "voice.openaiRealtimeVadEagerness")),
      createResponse: overrides.openaiRealtimeVadCreateResponse
        ?? configBoolean(options.machineConfig, "voice.openaiRealtimeVadCreateResponse")
        ?? configBoolean(options.runtimeConfig, "voice.openaiRealtimeVadCreateResponse"),
      interruptResponse: overrides.openaiRealtimeVadInterruptResponse
        ?? configBoolean(options.machineConfig, "voice.openaiRealtimeVadInterruptResponse")
        ?? configBoolean(options.runtimeConfig, "voice.openaiRealtimeVadInterruptResponse"),
    }
    openaiRealtime = {
      apiKey: key.apiKey,
      apiKeySource: key.source,
      model: trimOptional(overrides.openaiRealtimeModel)
        ?? configString(options.machineConfig, "voice.openaiRealtimeModel")
        ?? configString(options.runtimeConfig, "voice.openaiRealtimeModel"),
      voice: trimOptional(overrides.openaiRealtimeVoice)
        ?? configString(options.runtimeConfig, "voice.openaiRealtimeVoice")
        ?? configString(options.machineConfig, "voice.openaiRealtimeVoice"),
      voiceStyle: trimOptional(overrides.openaiRealtimeVoiceStyle)
        ?? configString(options.runtimeConfig, "voice.openaiRealtimeVoiceStyle")
        ?? configString(options.machineConfig, "voice.openaiRealtimeVoiceStyle"),
      voiceSpeed: overrides.openaiRealtimeVoiceSpeed
        ?? configNumber(options.runtimeConfig, "voice.openaiRealtimeVoiceSpeed")
        ?? configNumber(options.machineConfig, "voice.openaiRealtimeVoiceSpeed"),
      websocketUrl: trimOptional(overrides.openaiRealtimeWebsocketUrl)
        ?? configString(options.machineConfig, "voice.openaiRealtimeWebsocketUrl")
        ?? configString(options.runtimeConfig, "voice.openaiRealtimeWebsocketUrl"),
      reasoningEffort: overrides.openaiRealtimeReasoningEffort
        ?? normalizeOpenAIRealtimeReasoningEffort(configString(options.machineConfig, "voice.openaiRealtimeReasoningEffort"))
        ?? normalizeOpenAIRealtimeReasoningEffort(configString(options.runtimeConfig, "voice.openaiRealtimeReasoningEffort")),
      noiseReduction: overrides.openaiRealtimeNoiseReduction
        ?? normalizeOpenAIRealtimeNoiseReduction(configString(options.machineConfig, "voice.openaiRealtimeNoiseReduction"))
        ?? normalizeOpenAIRealtimeNoiseReduction(configString(options.runtimeConfig, "voice.openaiRealtimeNoiseReduction")),
      turnDetection,
    }

    if (needsOpenAISip) {
      const projectId = trimOptional(overrides.openaiSipProjectId)
        ?? configString(options.runtimeConfig, "voice.openaiSipProjectId")
        ?? configString(options.machineConfig, "voice.openaiSipProjectId")
      if (!projectId) {
        throw new Error("missing voice.openaiSipProjectId; save the OpenAI project id before starting SIP phone voice")
      }
      const allowUnsignedWebhooks = overrides.openaiSipAllowUnsignedWebhooks
        ?? configBoolean(options.machineConfig, "voice.openaiSipAllowUnsignedWebhooks")
        ?? configBoolean(options.runtimeConfig, "voice.openaiSipAllowUnsignedWebhooks")
      const webhookSecret = trimOptional(overrides.openaiSipWebhookSecret)
        ?? configString(options.runtimeConfig, "voice.openaiSipWebhookSecret")
        ?? configString(options.machineConfig, "voice.openaiSipWebhookSecret")
      if (!webhookSecret && !allowUnsignedWebhooks) {
        throw new Error("missing voice.openaiSipWebhookSecret; save the OpenAI webhook signing secret before starting SIP phone voice")
      }
      openaiSip = {
        projectId,
        webhookPath: normalizeTwilioPhoneBasePath(
          trimOptional(overrides.openaiSipWebhookPath)
            ?? configString(options.machineConfig, "voice.openaiSipWebhookPath")
            ?? configString(options.runtimeConfig, "voice.openaiSipWebhookPath")
            ?? openAISipWebhookPath(options.agentName),
        ),
        /* v8 ignore next 2 -- unsigned-webhook local-dev mode is resolved by config contract tests; production uses a secret @preserve */
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(allowUnsignedWebhooks !== undefined ? { allowUnsignedWebhooks } : {}),
        apiBaseUrl: trimOptional(overrides.openaiSipApiBaseUrl)
          ?? configString(options.machineConfig, "voice.openaiSipApiBaseUrl")
          ?? configString(options.runtimeConfig, "voice.openaiSipApiBaseUrl"),
        websocketBaseUrl: trimOptional(overrides.openaiSipWebsocketBaseUrl)
          ?? configString(options.machineConfig, "voice.openaiSipWebsocketBaseUrl")
          ?? configString(options.runtimeConfig, "voice.openaiSipWebsocketBaseUrl"),
      }
    }
  }

  if (needsCascade) {
    elevenLabsApiKey = required(
      elevenLabsApiKey || undefined,
      "missing integrations.elevenLabsApiKey; run 'ouro connect voice --agent <agent>' for setup guidance",
    )
    elevenLabsVoiceId = required(
      elevenLabsVoiceId || undefined,
      "missing integrations.elevenLabsVoiceId; save the ElevenLabs voice ID before starting phone voice",
    )
    whisperCliPath = required(
      whisperCliPath || undefined,
      "missing voice.whisperCliPath in this machine's runtime config",
    )
    whisperModelPath = required(
      whisperModelPath || undefined,
      "missing voice.whisperModelPath in this machine's runtime config",
    )
  }

  const outputDir = trimOptional(overrides.outputDir)
    ?? configString(options.machineConfig, "voice.twilioOutputDir")
    ?? path.join(getAgentRoot(options.agentName), "state", "voice", "twilio-phone")
  const settings: TwilioPhoneTransportRuntimeSettings = {
    agentName: options.agentName,
    publicBaseUrl,
    basePath,
    webhookUrl: twilioPhoneWebhookUrl(publicBaseUrl, basePath),
    outputDir,
    port: overrides.port
      ?? configNumber(options.machineConfig, "voice.twilioPort")
      ?? DEFAULT_TWILIO_PHONE_PORT,
    host: trimOptional(overrides.host)
      ?? configString(options.machineConfig, "voice.twilioHost")
      ?? "127.0.0.1",
    elevenLabsApiKey,
    elevenLabsVoiceId,
    whisperCliPath,
    whisperModelPath,
    twilioAccountSid: configString(options.runtimeConfig, "voice.twilioAccountSid"),
    twilioAuthToken: configString(options.runtimeConfig, "voice.twilioAuthToken"),
    twilioFromNumber: trimOptional(overrides.twilioFromNumber)
      ?? configString(options.runtimeConfig, "voice.twilioFromNumber")
      ?? configString(options.machineConfig, "voice.twilioFromNumber"),
    defaultFriendId: trimOptional(overrides.defaultFriendId)
      ?? configString(options.machineConfig, "voice.twilioDefaultFriendId"),
    recordTimeoutSeconds: overrides.recordTimeoutSeconds
      ?? configNumber(options.machineConfig, "voice.twilioRecordTimeoutSeconds")
      ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
    recordMaxLengthSeconds: overrides.recordMaxLengthSeconds
      ?? configNumber(options.machineConfig, "voice.twilioRecordMaxLengthSeconds")
      ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
    greetingPrebufferMs: overrides.greetingPrebufferMs
      ?? configNumber(options.machineConfig, "voice.twilioGreetingPrebufferMs")
      ?? DEFAULT_TWILIO_GREETING_PREBUFFER_MS,
    playbackMode: overrides.playbackMode
      ?? normalizeTwilioPhonePlaybackMode(configString(options.machineConfig, "voice.twilioPlaybackMode") ?? DEFAULT_TWILIO_PHONE_PLAYBACK_MODE),
    transportMode,
    conversationEngine,
    outboundConversationEngine,
    openaiRealtime,
    openaiSip,
    openaiSipWebhookUrl: openaiSip?.webhookPath ? openAISipWebhookUrl(publicBaseUrl, openaiSip.webhookPath) : undefined,
  }
  return { status: "configured", settings }
}

const defaultTwilioPhoneTransportRuntimeDeps: TwilioPhoneTransportRuntimeDeps = {
  waitForRuntimeCredentialBootstrap,
  loadMachineIdentity: loadOrCreateMachineIdentity,
  refreshRuntimeConfig: refreshRuntimeCredentialConfig,
  refreshMachineRuntimeConfig: refreshMachineRuntimeCredentialConfig,
  readRuntimeConfig: readRuntimeCredentialConfig,
  readMachineRuntimeConfig: readMachineRuntimeCredentialConfig,
  cacheSelectedProviderCredentials,
  createTranscriber: createWhisperCppTranscriber,
  createTts: createElevenLabsTtsClient,
  startBridgeServer: startTwilioPhoneBridgeServer,
}

const defaultTwilioPhoneOutboundCallRuntimeDeps: TwilioPhoneOutboundCallRuntimeDeps = {
  waitForRuntimeCredentialBootstrap,
  loadMachineIdentity: loadOrCreateMachineIdentity,
  refreshRuntimeConfig: refreshRuntimeCredentialConfig,
  refreshMachineRuntimeConfig: refreshMachineRuntimeCredentialConfig,
  readRuntimeConfig: readRuntimeCredentialConfig,
  readMachineRuntimeConfig: readMachineRuntimeCredentialConfig,
  createTts: createElevenLabsTtsClient,
  runVoiceLoopbackTurn,
  writeVoicePlaybackArtifact,
  createOutboundCall: createTwilioOutboundCall,
}

async function readFreshRuntimeSettings(
  agentName: string,
  overrides: TwilioPhoneTransportRuntimeOverrides | undefined,
  defaultBasePath: string | undefined,
  requirePublicUrl: boolean | undefined,
  deps: Pick<TwilioPhoneOutboundCallRuntimeDeps, "waitForRuntimeCredentialBootstrap" | "loadMachineIdentity" | "refreshRuntimeConfig" | "refreshMachineRuntimeConfig" | "readRuntimeConfig" | "readMachineRuntimeConfig">,
  options: { preferCached?: boolean } = {},
): Promise<TwilioPhoneTransportRuntimeSettings> {
  if (options.preferCached) {
    const cachedRuntimeConfig = deps.readRuntimeConfig(agentName)
    const cachedMachineConfig = deps.readMachineRuntimeConfig(agentName)
    /* v8 ignore next -- stale/missing cache falls through to the refresh path; tests cover enabled and disabled cached states @preserve */
    if (cachedRuntimeConfig.ok && cachedMachineConfig.ok) {
      const resolution = resolveTwilioPhoneTransportRuntime({
        agentName,
        runtimeConfig: cachedRuntimeConfig.config,
        machineConfig: cachedMachineConfig.config,
        overrides,
        defaultBasePath,
        requirePublicUrl,
      })
      if (resolution.status === "disabled") {
        throw new Error(`Twilio phone voice transport is disabled: ${resolution.reason}`)
      }
      return resolution.settings
    }
  }
  const bootstrapped = await deps.waitForRuntimeCredentialBootstrap(agentName)
  const hasBootstrappedConfig = bootstrapped
    && deps.readRuntimeConfig(agentName).ok
    && deps.readMachineRuntimeConfig(agentName).ok
  if (!hasBootstrappedConfig) {
    const machine = deps.loadMachineIdentity()
    await Promise.all([
      deps.refreshRuntimeConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined),
      deps.refreshMachineRuntimeConfig(agentName, machine.machineId, { preserveCachedOnFailure: true }).catch(() => undefined),
    ])
  }
  const runtimeConfig = requireConfig(deps.readRuntimeConfig(agentName), "portable runtime/config")
  const machineConfig = requireConfig(deps.readMachineRuntimeConfig(agentName), "machine runtime config")
  const resolution = resolveTwilioPhoneTransportRuntime({
    agentName,
    runtimeConfig,
    machineConfig,
    overrides,
    defaultBasePath,
    requirePublicUrl,
  })
  if (resolution.status === "disabled") {
    throw new Error(`Twilio phone voice transport is disabled: ${resolution.reason}`)
  }
  return resolution.settings
}

export async function startConfiguredTwilioPhoneTransport(
  options: StartConfiguredTwilioPhoneTransportOptions,
  deps: TwilioPhoneTransportRuntimeDeps = defaultTwilioPhoneTransportRuntimeDeps,
): Promise<TwilioPhoneTransportRuntimeState> {
  let settings: TwilioPhoneTransportRuntimeSettings
  try {
    settings = await readFreshRuntimeSettings(
      options.agentName,
      options.overrides,
      options.defaultBasePath,
      options.requirePublicUrl,
      deps,
    )
  } catch (error) {
    if (!errorMessage(error).startsWith("Twilio phone voice transport is disabled:")) throw error
    const reason = errorMessage(error).replace(/^Twilio phone voice transport is disabled: /, "")
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_transport_disabled",
      message: "Twilio phone voice transport is not attached on this machine",
      meta: { agentName: options.agentName, reason },
    })
    return { status: "disabled", reason }
  }

  await deps.cacheSelectedProviderCredentials(options.agentName)
  if (settings.openaiRealtime?.apiKeySource === "integrations.openaiEmbeddingsApiKey") {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_openai_realtime_compat_key",
      message: "OpenAI Realtime voice is temporarily using the legacy OpenAI embeddings API key",
      meta: { agentName: settings.agentName, source: settings.openaiRealtime.apiKeySource },
    })
  }
  const settingsNeedsOpenAIRealtime = settings.conversationEngine === "openai-realtime"
    || settings.conversationEngine === "openai-sip"
    || settings.outboundConversationEngine === "openai-realtime"
    || settings.outboundConversationEngine === "openai-sip"
  const settingsNeedsCascade = settings.conversationEngine === "cascade" || settings.outboundConversationEngine === "cascade"
  const transcriber = settingsNeedsOpenAIRealtime && !settingsNeedsCascade
    ? {
        transcribe: async () => {
          throw new Error("OpenAI Realtime voice sessions do not use the cascade transcriber")
        },
      }
    : deps.createTranscriber({
        whisperCliPath: settings.whisperCliPath,
        modelPath: settings.whisperModelPath,
      })
  const tts = settingsNeedsOpenAIRealtime && !settingsNeedsCascade
    ? {
        synthesize: async () => {
          throw new Error("OpenAI Realtime voice sessions do not use the cascade TTS service")
        },
      }
    : deps.createTts({
        apiKey: settings.elevenLabsApiKey,
        voiceId: settings.elevenLabsVoiceId,
        outputFormat: settings.transportMode === "media-stream" ? "ulaw_8000" : "mp3_44100_128",
      })
  const bridge = await deps.startBridgeServer({
    agentName: settings.agentName,
    publicBaseUrl: settings.publicBaseUrl,
    basePath: settings.basePath,
    outputDir: settings.outputDir,
    transcriber,
    tts,
    port: settings.port,
    host: settings.host,
    twilioAccountSid: settings.twilioAccountSid,
    twilioAuthToken: settings.twilioAuthToken,
    twilioFromNumber: settings.twilioFromNumber,
    defaultFriendId: settings.defaultFriendId,
    recordTimeoutSeconds: settings.recordTimeoutSeconds,
    recordMaxLengthSeconds: settings.recordMaxLengthSeconds,
    greetingPrebufferMs: settings.greetingPrebufferMs,
    transportMode: settings.transportMode,
    playbackMode: settings.playbackMode,
    conversationEngine: settings.conversationEngine,
    outboundConversationEngine: settings.outboundConversationEngine,
    openaiRealtime: settings.openaiRealtime,
    openaiSip: settings.openaiSip,
  })

  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_transport_ready",
    message: "Twilio phone voice transport is ready",
    meta: {
      agentName: settings.agentName,
      localUrl: bridge.localUrl,
      publicBaseUrl: settings.publicBaseUrl,
      basePath: settings.basePath,
      webhookUrl: settings.webhookUrl,
      openaiSipWebhookUrl: settings.openaiSipWebhookUrl ?? "",
      transportMode: settings.transportMode,
      conversationEngine: settings.conversationEngine,
      outboundConversationEngine: settings.outboundConversationEngine,
      openaiRealtimeModel: settings.openaiRealtime?.model ?? "",
    },
  })

  return { status: "started", settings, bridge }
}

function createOutboundId(now: Date): string {
  const timestamp = now.toISOString().replace(/[^0-9A-Za-z]+/g, "").slice(0, 15)
  return `outbound-${timestamp}-${crypto.randomUUID().slice(0, 8)}`
}

function terminalOutboundStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase()
  return normalized === "completed"
    || normalized === "busy"
    || normalized === "no-answer"
    || normalized === "failed"
    || normalized === "canceled"
    || normalized === "voicemail"
    || normalized === "fax"
}

function safeRuntimeSegment(input: string): string {
  /* v8 ignore next -- generated outbound IDs and E.164 numbers always leave a non-empty safe segment @preserve */
  return input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"
}

async function prewarmOutboundGreeting(options: {
  settings: TwilioPhoneTransportRuntimeSettings
  outboundId: string
  friendId?: string
  to: string
  from: string
  reason: string
  createdAt: string
}, deps: Pick<TwilioPhoneOutboundCallRuntimeDeps, "createTts" | "runVoiceLoopbackTurn" | "writeVoicePlaybackArtifact">): Promise<{
  utteranceId: string
  audioPath: string
  mimeType: string
  byteLength: number
  preparedAt: string
} | undefined> {
  if (options.settings.transportMode !== "media-stream") return undefined
  /* v8 ignore next -- Realtime/SIP outbound tests assert no cascade prewarm is attempted @preserve */
  if (options.settings.outboundConversationEngine === "openai-realtime" || options.settings.outboundConversationEngine === "openai-sip") return undefined
  const friendId = options.friendId?.trim() || `twilio-${safeRuntimeSegment(options.to)}`
  const sessionKey = twilioPhoneVoiceSessionKey({
    defaultFriendId: friendId,
    from: options.to,
    to: options.from,
  })
  const utteranceId = `twilio-${safeRuntimeSegment(options.outboundId)}-outbound-connected`
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_outbound_greeting_prewarm_start",
    message: "prewarming Twilio outbound voice greeting before dialing",
    meta: { agentName: options.settings.agentName, outboundId: safeRuntimeSegment(options.outboundId), sessionKey },
  })
  const transcript = buildVoiceTranscript({
    utteranceId,
    text: outboundCallAnsweredPrompt({
      schemaVersion: 1,
      outboundId: options.outboundId,
      agentName: options.settings.agentName,
      /* v8 ignore next -- no-friend outbound calls are covered at placement/job persistence boundary @preserve */
      ...(options.friendId?.trim() ? { friendId: options.friendId.trim() } : {}),
      to: options.to,
      from: options.from,
      reason: options.reason,
      createdAt: options.createdAt,
      status: "prewarming",
    }, { From: options.from, To: options.to }),
    source: "loopback",
  })
  const tts = deps.createTts({
    apiKey: options.settings.elevenLabsApiKey,
    voiceId: options.settings.elevenLabsVoiceId,
    outputFormat: "ulaw_8000",
  })
  const turn = await deps.runVoiceLoopbackTurn({
    agentName: options.settings.agentName,
    friendId,
    sessionKey,
    transcript,
    tts,
  })
  if (turn.tts.status !== "delivered") {
    throw new Error(`outbound greeting prewarm failed: ${turn.tts.error}`)
  }
  const playback = await deps.writeVoicePlaybackArtifact({
    utteranceId,
    delivery: turn.tts,
    outputDir: path.join(options.settings.outputDir, "outbound-greetings", safeRuntimeSegment(options.outboundId)),
  })
  const preparedAt = new Date().toISOString()
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_twilio_outbound_greeting_prewarm_end",
    message: "prewarmed Twilio outbound voice greeting before dialing",
    meta: {
      agentName: options.settings.agentName,
      outboundId: safeRuntimeSegment(options.outboundId),
      sessionKey,
      byteLength: String(playback.byteLength),
    },
  })
  return {
    utteranceId,
    audioPath: playback.audioPath,
    mimeType: playback.mimeType,
    byteLength: playback.byteLength,
    preparedAt,
  }
}

export async function placeConfiguredTwilioPhoneCall(
  options: PlaceConfiguredTwilioPhoneCallOptions,
  deps: TwilioPhoneOutboundCallRuntimeDeps = defaultTwilioPhoneOutboundCallRuntimeDeps,
): Promise<PlaceConfiguredTwilioPhoneCallResult> {
  const settings = await readFreshRuntimeSettings(
    options.agentName,
    undefined,
    agentScopedTwilioPhoneBasePath(options.agentName),
    true,
    deps,
    { preferCached: true },
  )
  const to = normalizeTwilioE164PhoneNumber(options.to)
  const from = normalizeTwilioE164PhoneNumber(settings.twilioFromNumber)
  if (!to) throw new Error("outbound voice call target must be an E.164 phone number")
  if (!from) throw new Error("missing voice.twilioFromNumber; save the Twilio caller number before outbound phone calls")
  if (!settings.twilioAccountSid?.trim()) throw new Error("missing voice.twilioAccountSid; save Twilio credentials before outbound phone calls")
  if (!settings.twilioAuthToken?.trim()) throw new Error("missing voice.twilioAuthToken; save Twilio credentials before outbound phone calls")
  const accountSid = settings.twilioAccountSid.trim()
  const authToken = settings.twilioAuthToken.trim()
  const now = options.now ?? new Date()
  const recent = await readRecentTwilioOutboundCallJobs({
    outputDir: settings.outputDir,
    to,
    friendId: options.friendId,
    sinceMs: options.redialGuardMs ?? 120_000,
    now: now.getTime(),
  })
  const activeRecent = recent.find((job) => !terminalOutboundStatus(job.status))
  if (activeRecent) {
    throw new Error("outbound voice call suppressed: a recent call to this friend/number is still active")
  }

  const outboundId = options.outboundId?.trim() || createOutboundId(now)
  const createdAt = now.toISOString()
  const webhookUrl = twilioOutboundCallWebhookUrl(settings.publicBaseUrl, settings.basePath, outboundId)
  const statusCallbackUrl = twilioOutboundCallStatusCallbackUrl(settings.publicBaseUrl, settings.basePath, outboundId)
  const amdStatusCallbackUrl = twilioOutboundCallAmdCallbackUrl(settings.publicBaseUrl, settings.basePath, outboundId)
  await writeTwilioOutboundCallJob(settings.outputDir, {
    schemaVersion: 1,
    outboundId,
    agentName: options.agentName,
    ...(options.friendId?.trim() ? { friendId: options.friendId.trim() } : {}),
    to,
    from,
    reason: options.reason.trim(),
    ...(options.initialAudio ? { initialAudio: options.initialAudio } : {}),
    createdAt,
    status: settings.transportMode === "media-stream" && settings.outboundConversationEngine === "cascade"
      ? "prewarming"
      : "requested",
  })

  try {
    const prewarmedGreeting = await prewarmOutboundGreeting({
      settings,
      outboundId,
      friendId: options.friendId,
      to,
      from,
      reason: options.reason.trim(),
      createdAt,
    }, deps)
    if (prewarmedGreeting) {
      await updateTwilioOutboundCallJob(settings.outputDir, outboundId, {
        status: "requested",
        prewarmedGreeting,
        events: [{ at: prewarmedGreeting.preparedAt, status: "greeting-prewarmed" }],
      })
    }
    const call = await deps.createOutboundCall({
      accountSid,
      authToken,
      to,
      from,
      twimlUrl: webhookUrl,
      statusCallbackUrl,
      machineDetection: "Enable",
      asyncAmd: true,
      asyncAmdStatusCallbackUrl: amdStatusCallbackUrl,
    })
    await updateTwilioOutboundCallJob(settings.outputDir, outboundId, {
      transportCallSid: call.callSid,
      status: call.status ?? "queued",
      events: [
        ...(prewarmedGreeting ? [{ at: prewarmedGreeting.preparedAt, status: "greeting-prewarmed" }] : []),
        { at: new Date().toISOString(), status: call.status ?? "queued", ...(call.callSid ? { callSid: call.callSid } : {}) },
      ],
    })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_outbound_call_requested",
      message: "Twilio outbound voice call requested",
      meta: {
        agentName: options.agentName,
        outboundId: outboundId.replace(/[^A-Za-z0-9._-]+/g, "-"),
        callSid: call.callSid?.replace(/[^A-Za-z0-9._-]+/g, "-") ?? "unknown",
        status: call.status ?? "queued",
      },
    })
    return {
      outboundId,
      callSid: call.callSid,
      status: call.status,
      webhookUrl,
      statusCallbackUrl,
    }
  } catch (error) {
    await updateTwilioOutboundCallJob(settings.outputDir, outboundId, {
      status: "failed",
      error: errorMessage(error),
    })
    throw error
  }
}

export function closeTwilioPhoneBridgeServer(server: TwilioPhoneBridgeServer): Promise<void> {
  return Promise.all([
    server.bridge.close?.() ?? Promise.resolve(),
    new Promise<void>((resolve, reject) => {
      ;(server.server as Server).close((error?: Error) => error ? reject(error) : resolve())
    }),
  ]).then(() => undefined)
}
