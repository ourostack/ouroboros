import * as path from "path"
import type { Server } from "http"
import { getAgentRoot, loadAgentConfig, type AgentConfig, type AgentProvider } from "../../heart/identity"
import { loadOrCreateMachineIdentity, type MachineIdentity } from "../../heart/machine-identity"
import { refreshProviderCredentialPool } from "../../heart/provider-credentials"
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
import {
  DEFAULT_TWILIO_PHONE_PORT,
  DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
  TWILIO_PHONE_WEBHOOK_BASE_PATH,
  DEFAULT_TWILIO_PHONE_PLAYBACK_MODE,
  normalizeTwilioPhoneBasePath,
  normalizeTwilioPhonePlaybackMode,
  startTwilioPhoneBridgeServer,
  twilioPhoneWebhookUrl,
  type StartTwilioPhoneBridgeServerOptions,
  type TwilioPhonePlaybackMode,
  type TwilioPhoneBridgeServer,
} from "./twilio-phone"
import { createWhisperCppTranscriber } from "./whisper"

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
  playbackMode?: TwilioPhonePlaybackMode
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
  defaultFriendId?: string
  recordTimeoutSeconds: number
  recordMaxLengthSeconds: number
  playbackMode: TwilioPhonePlaybackMode
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
  const elevenLabsApiKey = required(
    configString(options.runtimeConfig, "integrations.elevenLabsApiKey"),
    "missing integrations.elevenLabsApiKey; run 'ouro connect voice --agent <agent>' for setup guidance",
  )
  const elevenLabsVoiceId = required(
    trimOptional(overrides.elevenLabsVoiceId)
      ?? configString(options.runtimeConfig, "integrations.elevenLabsVoiceId")
      ?? configString(options.runtimeConfig, "voice.elevenLabsVoiceId"),
    "missing integrations.elevenLabsVoiceId; save the ElevenLabs voice ID before starting phone voice",
  )
  const whisperCliPath = required(
    trimOptional(overrides.whisperCliPath)
      ?? configString(options.machineConfig, "voice.whisperCliPath"),
    "missing voice.whisperCliPath in this machine's runtime config",
  )
  const whisperModelPath = required(
    trimOptional(overrides.whisperModelPath)
      ?? configString(options.machineConfig, "voice.whisperModelPath"),
    "missing voice.whisperModelPath in this machine's runtime config",
  )
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
    defaultFriendId: trimOptional(overrides.defaultFriendId)
      ?? configString(options.machineConfig, "voice.twilioDefaultFriendId"),
    recordTimeoutSeconds: overrides.recordTimeoutSeconds
      ?? configNumber(options.machineConfig, "voice.twilioRecordTimeoutSeconds")
      ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
    recordMaxLengthSeconds: overrides.recordMaxLengthSeconds
      ?? configNumber(options.machineConfig, "voice.twilioRecordMaxLengthSeconds")
      ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
    playbackMode: overrides.playbackMode
      ?? normalizeTwilioPhonePlaybackMode(configString(options.machineConfig, "voice.twilioPlaybackMode") ?? DEFAULT_TWILIO_PHONE_PLAYBACK_MODE),
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

export async function startConfiguredTwilioPhoneTransport(
  options: StartConfiguredTwilioPhoneTransportOptions,
  deps: TwilioPhoneTransportRuntimeDeps = defaultTwilioPhoneTransportRuntimeDeps,
): Promise<TwilioPhoneTransportRuntimeState> {
  await deps.waitForRuntimeCredentialBootstrap(options.agentName)
  const machine = deps.loadMachineIdentity()
  await Promise.all([
    deps.refreshRuntimeConfig(options.agentName, { preserveCachedOnFailure: true }).catch(() => undefined),
    deps.refreshMachineRuntimeConfig(options.agentName, machine.machineId, { preserveCachedOnFailure: true }).catch(() => undefined),
  ])
  const runtimeConfig = requireConfig(deps.readRuntimeConfig(options.agentName), "portable runtime/config")
  const machineConfig = requireConfig(deps.readMachineRuntimeConfig(options.agentName), "machine runtime config")
  const resolution = resolveTwilioPhoneTransportRuntime({
    agentName: options.agentName,
    runtimeConfig,
    machineConfig,
    overrides: options.overrides,
    defaultBasePath: options.defaultBasePath,
    requirePublicUrl: options.requirePublicUrl,
  })
  if (resolution.status === "disabled") {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_twilio_transport_disabled",
      message: "Twilio phone voice transport is not attached on this machine",
      meta: { agentName: options.agentName, reason: resolution.reason },
    })
    return resolution
  }

  await deps.cacheSelectedProviderCredentials(options.agentName)
  const settings = resolution.settings
  const transcriber = deps.createTranscriber({
    whisperCliPath: settings.whisperCliPath,
    modelPath: settings.whisperModelPath,
  })
  const tts = deps.createTts({
    apiKey: settings.elevenLabsApiKey,
    voiceId: settings.elevenLabsVoiceId,
    outputFormat: "mp3_44100_128",
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
    defaultFriendId: settings.defaultFriendId,
    recordTimeoutSeconds: settings.recordTimeoutSeconds,
    recordMaxLengthSeconds: settings.recordMaxLengthSeconds,
    playbackMode: settings.playbackMode,
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
    },
  })

  return { status: "started", settings, bridge }
}

export function closeTwilioPhoneBridgeServer(server: TwilioPhoneBridgeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    ;(server.server as Server).close((error?: Error) => error ? reject(error) : resolve())
  })
}
