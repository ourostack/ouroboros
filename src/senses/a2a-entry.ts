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

import("../a2a/server")
  .then(async ({ startA2AServer }) => {
    const rawPort = argValue("--port")
    const port = rawPort ? Number.parseInt(rawPort, 10) : undefined
    await startA2AServer({
      agentName,
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
