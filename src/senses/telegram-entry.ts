// Thin entrypoint for `node dist/senses/telegram-entry.js --agent <name>`.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/telegram-entry.js --agent butler")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("telegram")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Telegram entrypoint",
  meta: { entry: "telegram", agentName },
})

Promise.all([
  import("../heart/runtime-credentials"),
  import("../heart/machine-identity"),
  import("./telegram"),
])
  .then(async ([{ waitForRuntimeCredentialBootstrap, readRuntimeCredentialConfig, refreshRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig }, { loadOrCreateMachineIdentity }, { startTelegramSenseApp }]) => {
    const bootstrapped = await waitForRuntimeCredentialBootstrap(agentName)
    if (!bootstrapped && !readRuntimeCredentialConfig(agentName).ok) {
      await refreshRuntimeCredentialConfig(agentName)
    }
    const machine = loadOrCreateMachineIdentity()
    await refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true }).catch(() => undefined)
    const app = await startTelegramSenseApp(agentName)
    let stopping: Promise<void> | undefined
    const stop = (): void => { stopping ??= app.stop() }
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    await app.run()
    await stopping
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "Telegram entrypoint failed",
      meta: { entry: "telegram", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
