// Thin entrypoint for `node dist/senses/app-sessions-entry.js --agent <name>`.
// The app-sessions sense library is tested directly; this file keeps daemon boot wiring small.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/app-sessions-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("app-sessions")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting app-sessions entrypoint",
  meta: { entry: "app-sessions", agentName },
})

import("./app-sessions/sense")
  .then(({ startAppSessionsSense }) => {
    const app = startAppSessionsSense({ agentName: agentName! })
    const shutdown = (): void => {
      app.stop()
      process.exit(0)
    }
    process.once("SIGTERM", shutdown)
    process.once("SIGINT", shutdown)
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "app-sessions entrypoint failed",
      meta: { entry: "app-sessions", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
