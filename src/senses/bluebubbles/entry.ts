// Thin entrypoint for `npm run bluebubbles` / `node dist/senses/bluebubbles/entry.js --agent <name>`.
// Separated from index.ts so the BlueBubbles adapter stays testable.

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/bluebubbles/entry.js --agent ouroboros")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../../nerves/runtime"

configureDaemonRuntimeLogger("bluebubbles")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting BlueBubbles entrypoint",
  meta: { entry: "bluebubbles", agentName },
})
import("../../heart/runtime-credentials")
  .then(async ({
    readMachineRuntimeCredentialConfig,
    refreshMachineRuntimeCredentialConfig,
    refreshRuntimeCredentialConfig,
    waitForRuntimeCredentialBootstrap,
  }) => {
    await waitForRuntimeCredentialBootstrap(agentName)
    const { checkBlueBubblesSenseHostAccount } = await import("../../heart/bluebubbles-host-account")
    const hostAccount = checkBlueBubblesSenseHostAccount(agentName)
    if (!hostAccount.ok) {
      // Wrong macOS account means the wrong Apple ID: refuse, and exit 0 so the
      // process manager does not treat a deliberate refusal as a crash to restart.
      // eslint-disable-next-line no-console -- operator-facing refusal for the sense process
      console.error(hostAccount.message)
      process.exit(0)
      return
    }
    const { loadOrCreateMachineIdentity } = await import("../../heart/machine-identity")
    const machine = loadOrCreateMachineIdentity()
    const machineConfig = readMachineRuntimeCredentialConfig(agentName)
    if (!machineConfig.ok) {
      await refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    const { startBlueBubblesApp } = await import("./index")
    const server = await startBlueBubblesApp()
    let shutdownStarted = false
    const closeOnSignal = (): void => {
      if (shutdownStarted) return
      shutdownStarted = true
      server.close()
    }
    process.once("SIGTERM", closeOnSignal)
    process.once("SIGINT", closeOnSignal)
    server.once("close", () => {
      process.removeListener("SIGTERM", closeOnSignal)
      process.removeListener("SIGINT", closeOnSignal)
    })
    void refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "BlueBubbles entrypoint failed",
      meta: { entry: "bluebubbles", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
