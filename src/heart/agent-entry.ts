// Unified agent runtime entrypoint.
// Requires --agent before importing runtime modules that rely on identity.
if (!process.argv.includes("--agent")) {
  // eslint-disable-next-line no-console -- pre-boot guard
  console.error("Missing required --agent <name> argument.\nUsage: node dist/heart/agent-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureCliRuntimeLogger } from "../nerves/cli-logging"

configureCliRuntimeLogger("self")

// Dynamic import: agent-entry is boot-time wiring that starts a sense process.
// Using dynamic import avoids a static heart/ -> senses/ dependency.
import("../senses/inner-dialog-worker")
  .then(({ startInnerDialogWorker }) => startInnerDialogWorker())
  .catch((error) => {
    // eslint-disable-next-line no-console -- fatal startup guard for worker process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
