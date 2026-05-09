// Unified agent runtime entrypoint.
// Requires --agent before importing runtime modules that rely on identity.
const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard
  console.error("Missing required --agent <name> argument.\nUsage: node dist/heart/agent-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureCliRuntimeLogger } from "../nerves/cli-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureCliRuntimeLogger("self")

emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting inner-dialog entrypoint",
  meta: { entry: "inner-dialog", agentName },
})

// Dynamic import: agent-entry is boot-time wiring that starts a sense process.
// Using dynamic import avoids a static heart/ -> senses/ dependency.
import("./runtime-credentials")
  .then(async ({
    readMachineRuntimeCredentialConfig,
    readRuntimeCredentialConfig,
    refreshMachineRuntimeCredentialConfig,
    refreshRuntimeCredentialConfig,
    waitForRuntimeCredentialBootstrap,
  }) => {
    await waitForRuntimeCredentialBootstrap(agentName)
    if (!readRuntimeCredentialConfig(agentName).ok) {
      void refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    /* v8 ignore next 7 -- boot-time best-effort machine credential refresh runs in a child entrypoint and is covered operationally by daemon startup tests @preserve */
    if (!readMachineRuntimeCredentialConfig(agentName).ok) {
      void import("./machine-identity")
        .then(({ loadOrCreateMachineIdentity }) => {
          const machine = loadOrCreateMachineIdentity()
          return refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true })
        })
        .catch(() => undefined)
    }
    const { startInnerDialogWorker } = await import("../senses/inner-dialog-worker")
    await startInnerDialogWorker()
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "inner-dialog entrypoint failed",
      meta: { entry: "inner-dialog", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for worker process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
