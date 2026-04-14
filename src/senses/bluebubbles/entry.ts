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

configureDaemonRuntimeLogger("bluebubbles")
import("../../heart/runtime-credentials")
  .then(async ({ refreshRuntimeCredentialConfig }) => {
    await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    const { startBlueBubblesApp } = await import("./index")
    await startBlueBubblesApp()
  })
  .catch((error) => {
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
