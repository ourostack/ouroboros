// Thin entrypoint for `node dist/senses/voice-entry.js --agent <name>`.
// The voice sense owns shared transcript/session behavior and starts attached
// voice transports for this machine.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/voice-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("voice")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Voice entrypoint",
  meta: { entry: "voice", agentName },
})

import("./voice/twilio-phone-runtime")
  .then(async ({
    agentScopedTwilioPhoneBasePath,
    startConfiguredTwilioPhoneTransport,
  }) => {
    const twilioPhone = await startConfiguredTwilioPhoneTransport({
      agentName,
      defaultBasePath: agentScopedTwilioPhoneBasePath(agentName),
    })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_entry_ready",
      message: "Voice entrypoint is ready for managed voice turns",
      meta: {
        entry: "voice",
        agentName,
        twilioPhone: twilioPhone.status,
        webhookUrl: twilioPhone.status === "started" ? twilioPhone.settings.webhookUrl : undefined,
      },
    })
    setInterval(() => undefined, 60_000)
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "Voice entrypoint failed",
      meta: { entry: "voice", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
