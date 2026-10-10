// Thin entrypoint for `node dist/senses/cmux-entry.js --agent <name>`.
// The cmux sense library is tested directly; this file keeps daemon boot wiring small.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/cmux-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("cmux")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting cmux entrypoint",
  meta: { entry: "cmux", agentName },
})

import("../heart/runtime-credentials")
  .then(async ({ readMachineRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig, waitForRuntimeCredentialBootstrap }) => {
    await waitForRuntimeCredentialBootstrap(agentName!)
    if (!readMachineRuntimeCredentialConfig(agentName!).ok) {
      const { loadOrCreateMachineIdentity } = await import("../heart/machine-identity")
      await refreshMachineRuntimeCredentialConfig(agentName!, loadOrCreateMachineIdentity().machineId, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    const { startCmuxSenseApp } = await import("./cmux/sense")
    const app = await startCmuxSenseApp({ agentName: agentName! })
    const shutdown = (): void => {
      void app.stop().finally(() => process.exit(0))
    }
    process.once("SIGTERM", shutdown)
    process.once("SIGINT", shutdown)
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "cmux entrypoint failed",
      meta: { entry: "cmux", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
