// Standalone Twilio phone bridge for local voice testing:
// `node dist/senses/voice-twilio-entry.js --agent <name> --public-url https://<tunnel>`
export {}

function readRequiredAgentName(): string {
  const agentArgIndex = process.argv.indexOf("--agent")
  const value = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
  if (value) return value
  process.stderr.write("Missing required --agent <name> argument.\nUsage: node dist/senses/voice-twilio-entry.js --agent ouroboros --public-url https://<tunnel>\n")
  process.exit(1)
}

const agentName = readRequiredAgentName()

import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { loadOrCreateMachineIdentity } from "../heart/machine-identity"
import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import {
  readMachineRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
  waitForRuntimeCredentialBootstrap,
  type RuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
} from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { createElevenLabsTtsClient } from "./voice/elevenlabs"
import { createWhisperCppTranscriber } from "./voice/whisper"
import {
  DEFAULT_TWILIO_PHONE_PORT,
  DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS,
  DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS,
  TWILIO_PHONE_WEBHOOK_BASE_PATH,
  startTwilioPhoneBridgeServer,
} from "./voice/twilio-phone"

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : undefined
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

function requireConfig(result: RuntimeCredentialConfigReadResult, label: string): RuntimeCredentialConfig {
  if (result.ok) return result.config
  throw new Error(`${label} unavailable: ${result.error}`)
}

function required(value: string | undefined, guidance: string): string {
  if (value) return value
  throw new Error(guidance)
}

function numberArg(name: string): number | undefined {
  const raw = argValue(name)
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`)
  return parsed
}

function writeReadyInstructions(localUrl: string, publicBaseUrl: string): void {
  process.stdout.write([
    "Twilio phone voice bridge ready.",
    `local: ${localUrl}`,
    `public: ${publicBaseUrl}`,
    `Twilio Voice webhook: POST ${new URL(`${TWILIO_PHONE_WEBHOOK_BASE_PATH}/incoming`, publicBaseUrl).toString()}`,
    "",
  ].join("\n"))
}

configureDaemonRuntimeLogger("voice")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Twilio Voice entrypoint",
  meta: { entry: "voice-twilio", agentName },
})

async function main(): Promise<void> {
  await waitForRuntimeCredentialBootstrap(agentName)
  const machine = loadOrCreateMachineIdentity()
  await Promise.all([
    refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined),
    refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true }).catch(() => undefined),
  ])

  const runtimeConfig = requireConfig(readRuntimeCredentialConfig(agentName), "portable runtime/config")
  const machineConfig = requireConfig(readMachineRuntimeCredentialConfig(agentName), "machine runtime config")
  const port = numberArg("--port")
    ?? configNumber(machineConfig, "voice.twilioPort")
    ?? DEFAULT_TWILIO_PHONE_PORT
  const host = argValue("--host")
    ?? configString(machineConfig, "voice.twilioHost")
    ?? "127.0.0.1"
  const publicBaseUrl = required(
    argValue("--public-url") ?? configString(machineConfig, "voice.twilioPublicUrl"),
    `missing public URL; run 'cloudflared tunnel --url http://127.0.0.1:${port}' and restart with --public-url https://<tunnel>`,
  )
  const elevenLabsApiKey = required(
    configString(runtimeConfig, "integrations.elevenLabsApiKey"),
    "missing integrations.elevenLabsApiKey; run 'ouro connect voice --agent <agent>' for setup guidance",
  )
  const elevenLabsVoiceId = required(
    argValue("--elevenlabs-voice-id")
      ?? configString(runtimeConfig, "integrations.elevenLabsVoiceId")
      ?? configString(runtimeConfig, "voice.elevenLabsVoiceId"),
    "missing integrations.elevenLabsVoiceId; save the ElevenLabs voice ID before starting phone voice",
  )
  const whisperCliPath = required(
    configString(machineConfig, "voice.whisperCliPath"),
    "missing voice.whisperCliPath in this machine's runtime config",
  )
  const whisperModelPath = required(
    configString(machineConfig, "voice.whisperModelPath"),
    "missing voice.whisperModelPath in this machine's runtime config",
  )
  const outputDir = argValue("--output-dir")
    ?? configString(machineConfig, "voice.twilioOutputDir")
    ?? path.join(getAgentRoot(agentName), "state", "voice", "twilio-phone")
  const defaultFriendId = argValue("--friend")
    ?? configString(machineConfig, "voice.twilioDefaultFriendId")
  const twilioAccountSid = configString(runtimeConfig, "voice.twilioAccountSid")
  const twilioAuthToken = configString(runtimeConfig, "voice.twilioAuthToken")
  const recordTimeoutSeconds = numberArg("--record-timeout")
    ?? configNumber(machineConfig, "voice.twilioRecordTimeoutSeconds")
    ?? DEFAULT_TWILIO_RECORD_TIMEOUT_SECONDS
  const recordMaxLengthSeconds = numberArg("--record-max-length")
    ?? configNumber(machineConfig, "voice.twilioRecordMaxLengthSeconds")
    ?? DEFAULT_TWILIO_RECORD_MAX_LENGTH_SECONDS

  const transcriber = createWhisperCppTranscriber({
    whisperCliPath,
    modelPath: whisperModelPath,
  })
  const tts = createElevenLabsTtsClient({
    apiKey: elevenLabsApiKey,
    voiceId: elevenLabsVoiceId,
    outputFormat: "mp3_44100_128",
  })
  const bridge = await startTwilioPhoneBridgeServer({
    agentName,
    publicBaseUrl,
    outputDir,
    transcriber,
    tts,
    port,
    host,
    twilioAccountSid,
    twilioAuthToken,
    defaultFriendId,
    recordTimeoutSeconds,
    recordMaxLengthSeconds,
  })
  writeReadyInstructions(bridge.localUrl, publicBaseUrl)
}

main().catch((error) => {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.entry_error",
    message: "Twilio Voice entrypoint failed",
    meta: { entry: "voice-twilio", agentName, error: error instanceof Error ? error.message : String(error) },
  })
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
