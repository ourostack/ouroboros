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

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"
import {
  TWILIO_PHONE_WEBHOOK_BASE_PATH,
  startConfiguredTwilioPhoneTransport,
  type TwilioPhoneTransportRuntimeOverrides,
} from "./voice"

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : undefined
}

function numberArg(name: string): number | undefined {
  const raw = argValue(name)
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`)
  return parsed
}

function standaloneOverrides(): TwilioPhoneTransportRuntimeOverrides {
  return {
    publicBaseUrl: argValue("--public-url"),
    basePath: argValue("--base-path"),
    port: numberArg("--port"),
    host: argValue("--host"),
    outputDir: argValue("--output-dir"),
    defaultFriendId: argValue("--friend"),
    elevenLabsVoiceId: argValue("--elevenlabs-voice-id"),
    whisperCliPath: argValue("--whisper-cli-path"),
    whisperModelPath: argValue("--whisper-model-path"),
    recordTimeoutSeconds: numberArg("--record-timeout"),
    recordMaxLengthSeconds: numberArg("--record-max-length"),
    greetingPrebufferMs: numberArg("--greeting-prebuffer-ms"),
    transportMode: argValue("--transport-mode") as TwilioPhoneTransportRuntimeOverrides["transportMode"],
    playbackMode: argValue("--playback-mode") as TwilioPhoneTransportRuntimeOverrides["playbackMode"],
  }
}

function writeReadyInstructions(localUrl: string, publicBaseUrl: string, webhookUrl: string): void {
  process.stdout.write([
    "Twilio phone voice bridge ready.",
    `local: ${localUrl}`,
    `public: ${publicBaseUrl}`,
    `Twilio Voice webhook: POST ${webhookUrl}`,
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
  const transport = await startConfiguredTwilioPhoneTransport({
    agentName,
    overrides: standaloneOverrides(),
    defaultBasePath: TWILIO_PHONE_WEBHOOK_BASE_PATH,
    requirePublicUrl: true,
  })
  if (transport.status !== "started") {
    throw new Error(`Twilio phone voice transport did not start: ${transport.reason}`)
  }
  writeReadyInstructions(
    transport.bridge.localUrl,
    transport.settings.publicBaseUrl,
    transport.settings.webhookUrl,
  )
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
