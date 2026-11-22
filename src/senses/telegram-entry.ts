// Thin entrypoint for `node dist/senses/telegram-entry.js --agent <name>`.
export {}

const MISSING_AGENT = "missing-agent"
const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error(`Missing required --agent <name> argument.\nUsage: node dist/senses/telegram-entry.js --agent butler\ncode: ${MISSING_AGENT}`)
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
  import("./sense-shutdown"),
])
  .then(async ([{ waitForRuntimeCredentialBootstrap, readRuntimeCredentialConfig, refreshRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig, runtimeCredentialConfigSettled }, { loadOrCreateMachineIdentity }, { startTelegramSenseApp }, { installSenseShutdown }]) => {
    const bootstrapped = await waitForRuntimeCredentialBootstrap(agentName)
    if (!bootstrapped && !readRuntimeCredentialConfig(agentName).ok) {
      await refreshRuntimeCredentialConfig(agentName)
    }
    // Each vault ask spawns the vault CLI; skip it when the daemon's bootstrap already settled this machine's config.
    if (!runtimeCredentialConfigSettled(agentName, "machineRuntimeConfig")) {
      const machine = loadOrCreateMachineIdentity()
      await refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    const app = await startTelegramSenseApp(agentName, true)
    installSenseShutdown({ sense: "telegram", stop: () => app.stop() })
    await app.run()
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
