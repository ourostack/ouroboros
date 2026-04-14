// Thin entrypoint for `npm run teams` / `node dist/senses/teams-entry.js --agent <name>`.
// Separated from teams.ts so the Teams adapter is pure library code with clean
// 100% test coverage -- entrypoints can't be covered by vitest since
// require.main !== module in the test runner.
export {}
// Fail fast if --agent is missing (before any src/ code tries getAgentName())
const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard: --agent check before imports
  console.error("Missing required --agent <name> argument.\nUsage: node dist/senses/teams-entry.js --agent ouroboros")
  process.exit(1)
}

import("../heart/runtime-credentials")
  .then(async ({ refreshRuntimeCredentialConfig }) => {
    await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    const { startTeamsApp } = await import("./teams")
    startTeamsApp()
  })
  .catch((error) => {
    // eslint-disable-next-line no-console -- fatal startup guard for sense process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
