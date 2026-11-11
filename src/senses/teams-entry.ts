// Thin entrypoint for `npm run teams` / `node dist/senses/teams-entry.js --agent <name>`.
// Separated from teams.ts so the Teams adapter is pure library code with clean
// 100% test coverage -- entrypoints can't be covered by vitest since
// require.main !== module in the test runner.
export {}
import { configureDaemonRuntimeLogger } from "../heart/daemon/runtime-logging"
import { emitNervesEvent } from "../nerves/runtime"

// Fail fast if --agent is missing (before any src/ code tries getAgentName())
const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/teams-entry.js --agent ouroboros")
  process.exit(1)
}

// Without this the sense's events go to a console nobody reads: the daemon discards its output.
configureDaemonRuntimeLogger("teams")

emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Teams entrypoint",
  meta: { entry: "teams", agentName },
})

import("../heart/runtime-credentials")
  .then(async ({ waitForRuntimeCredentialBootstrap, readRuntimeCredentialConfig, refreshRuntimeCredentialConfig }) => {
    // The bot's credentials must be loaded before the listener starts: without them the Teams SDK
    // validates no sender, and startTeamsApp refuses to start.
    const bootstrapped = await waitForRuntimeCredentialBootstrap(agentName)
    if (!bootstrapped && !readRuntimeCredentialConfig(agentName).ok) {
      await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    const { startTeamsApp } = await import("./teams")
    startTeamsApp()
    // This process runs only where Teams runs, so it sends what other presences forwarded here.
    const [{ startTeamsOutboxDrain }, { sendTeamsOffTurn }, { getAgentRoot }] = await Promise.all([
      import("./teams-outbox"),
      import("./teams-off-turn"),
      import("../heart/identity"),
    ])
    const agentRoot = getAgentRoot()
    startTeamsOutboxDrain(agentRoot, (request) => sendTeamsOffTurn(request, { agentRoot, forward: false }))
  })
  .catch(async (error) => {
    const { describeStartupError } = await import("../heart/optional-packages")
    const detail = describeStartupError(error, "the Teams sense")
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "Teams entrypoint failed",
      meta: { entry: "teams", agentName, error: detail },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(detail)
    process.exit(1)
  })
