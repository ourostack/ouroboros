// Thin entrypoint for `npm run bluebubbles` / `node dist/senses/bluebubbles/entry.js --agent <name>`.
// Separated from index.ts so the BlueBubbles adapter stays testable.

if (!process.argv.includes("--agent")) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/bluebubbles/entry.js --agent ouroboros")
  process.exit(1)
}

import { startBlueBubblesApp } from "./index"
import { configureDaemonRuntimeLogger } from "../../heart/daemon/runtime-logging"

configureDaemonRuntimeLogger("bluebubbles")
startBlueBubblesApp()
