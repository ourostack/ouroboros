// Thin entrypoint for `node dist/senses/shepherd-entry.js --agent <name>`.
// The Shepherd sense library is tested directly; this file keeps daemon boot wiring small.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/shepherd-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("shepherd")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Shepherd entrypoint",
  meta: { entry: "shepherd", agentName },
})

import("../heart/runtime-credentials")
  .then(async ({ readMachineRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig, waitForRuntimeCredentialBootstrap }) => {
    await waitForRuntimeCredentialBootstrap(agentName!)
    if (!readMachineRuntimeCredentialConfig(agentName!).ok) {
      const { loadOrCreateMachineIdentity } = await import("../heart/machine-identity")
      await refreshMachineRuntimeCredentialConfig(agentName!, loadOrCreateMachineIdentity().machineId, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    const { startShepherdSenseApp } = await import("./shepherd/sense")
    const app = await startShepherdSenseApp({ agentName: agentName! })
    let attention: { close(): Promise<void> } | undefined
    if (process.platform === "darwin") {
      const { resolveShepherdConnection } = await import("../heart/shepherd-config")
      const machine = readMachineRuntimeCredentialConfig(agentName!)
      const connection = machine.ok ? resolveShepherdConnection(agentName!, machine.config) : null
      if (connection?.ok && connection.connection.host === "cmux") {
        const { startManagedShepherdAttention } = await import("./shepherd/attention")
        const { DEFAULT_DAEMON_SOCKET_PATH } = await import("../heart/daemon/socket-client")
        const { frontendSocketPathForDaemon } = await import("../heart/frontend-socket")
        try {
          attention = await startManagedShepherdAttention({ agent: agentName!, socketPath: frontendSocketPathForDaemon(DEFAULT_DAEMON_SOCKET_PATH), cmuxConnection: connection.connection })
        } catch (error) {
          emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_attention_unavailable", message: "native session attention is unavailable; Shepherd supervision remains running", meta: { agentName, error: String(error) } })
        }
      }
    }
    const shutdown = (): void => {
      app.stop()
      void (attention?.close() ?? Promise.resolve()).then(() => process.exit(0), error => {
        emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_attention_shutdown_error", message: "could not close native session attention", meta: { error: String(error) } })
        process.exit(1)
      })
    }
    process.once("SIGTERM", shutdown)
    process.once("SIGINT", shutdown)
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "Shepherd entrypoint failed",
      meta: { entry: "shepherd", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
