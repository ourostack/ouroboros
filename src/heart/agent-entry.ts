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

configureCliRuntimeLogger("self")

// Dynamic import: agent-entry is boot-time wiring that starts a sense process.
// Using dynamic import avoids a static heart/ -> senses/ dependency.
import("./runtime-credentials")
  .then(async ({ refreshRuntimeCredentialConfig }) => {
    await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    const { startInnerDialogWorker } = await import("../senses/inner-dialog-worker")
    await startInnerDialogWorker()
  })
  .catch((error) => {
    // eslint-disable-next-line no-console -- fatal startup guard for worker process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
