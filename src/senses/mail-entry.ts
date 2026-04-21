// Thin entrypoint for `node dist/senses/mail-entry.js --agent <name>`.
// The Mail sense library is tested directly; this file keeps daemon boot wiring small.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/mail-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("mail")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Mail entrypoint",
  meta: { entry: "mail", agentName },
})

import("./mail")
  .then(async ({ startMailSenseApp }) => {
    await startMailSenseApp({ agentName })
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "Mail entrypoint failed",
      meta: { entry: "mail", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
