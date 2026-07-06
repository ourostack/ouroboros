// Thin entrypoint for `node dist/senses/a2a-entry.js --agent <name>`.
export {}

const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/a2a-entry.js --agent ouroboros [--port 18920] [--base-url https://agent.example]")
  process.exit(1)
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

configureDaemonRuntimeLogger("a2a")
emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting A2A entrypoint",
  meta: { entry: "a2a", agentName },
})

Promise.all([
  import("../a2a/server"),
  import("../a2a/identity"),
  import("../heart/runtime-credentials"),
  import("../heart/machine-identity"),
  import("@ouro.bot/friends/a2a-client"),
])
  .then(async ([
    { startA2AServer },
    { loadOrMintA2AIdentity, readStoredA2ASeed },
    { waitForRuntimeCredentialBootstrap, readMachineRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig, mergeMachineRuntimeCredentialConfig },
    { loadOrCreateMachineIdentity },
    { ready },
  ]) => {
    const os = await import("node:os")
    // Wait for the daemon to deliver the machine-local runtime config (carrying the
    // a2a identity seed) into the in-memory cache before we read or mint identity.
    const bootstrapped = await waitForRuntimeCredentialBootstrap(agentName)
    emitNervesEvent({
      component: "senses",
      event: "senses.a2a_bootstrap_waited",
      message: "awaited runtime-credential bootstrap before A2A identity load",
      meta: { entry: "a2a", agentName, bootstrapped },
    })

    const sodium = await ready()
    const machineId = loadOrCreateMachineIdentity({ homeDir: os.homedir() }).machineId
    const cachedMachineConfigRead = readMachineRuntimeCredentialConfig(agentName)
    const machineConfigRead = cachedMachineConfigRead.ok && readStoredA2ASeed(cachedMachineConfigRead.config)
      ? cachedMachineConfigRead
      : await refreshMachineRuntimeCredentialConfig(agentName, machineId)
    if (!machineConfigRead.ok && machineConfigRead.reason !== "missing") {
      throw new Error(`A2A identity requires readable machine runtime config at ${machineConfigRead.itemPath}: ${machineConfigRead.error}`)
    }
    const machineConfig = machineConfigRead.ok ? machineConfigRead.config : {}
    const identity = await loadOrMintA2AIdentity({
      agentName,
      sodium,
      config: machineConfig,
      upsert: async (next) => {
        const seed = readStoredA2ASeed(next) as string
        await mergeMachineRuntimeCredentialConfig(agentName, machineId, { a2a: { identity: { ed25519Seed: seed } } })
      },
    })

    const rawPort = argValue("--port")
    const port = rawPort ? Number.parseInt(rawPort, 10) : undefined
    await startA2AServer({
      agentName,
      identity,
      ...(argValue("--host") ? { host: argValue("--host") } : {}),
      ...(Number.isInteger(port) ? { port } : {}),
      ...(argValue("--base-url") ? { baseUrl: argValue("--base-url") } : {}),
      ...(argValue("--path") ? { path: argValue("--path") } : {}),
    })
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "A2A entrypoint failed",
      meta: { entry: "a2a", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
