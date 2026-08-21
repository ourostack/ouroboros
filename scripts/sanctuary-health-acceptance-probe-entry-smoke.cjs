const { spawnSync } = require("node:child_process")
const path = require("node:path")

const EXPECTED_USAGE = "usage: sanctuary-health-acceptance-probe <run|stop|recover|finalize> --label <label> --scenario <digest> --owner-image <digest> --owner-container <digest> [--owner-image-after <digest> --owner-container-after <digest>]\n"

function runSanctuaryHealthAcceptanceProbeEntrySmoke(repoRoot, deps = defaultDeps()) {
  const entry = deps.join(repoRoot, "dist", "senses", "sanctuary-health-acceptance-probe-entry.js")
  const result = deps.spawnSync(deps.execPath, [entry], { cwd: repoRoot, encoding: "utf8" })
  if (result.error) {
    deps.writeStderr(`Sanctuary health acceptance probe entry smoke failed: ${result.error.message}\n`)
    return 1
  }
  if (result.signal) {
    deps.writeStderr(`Sanctuary health acceptance probe entry smoke failed after ${result.signal}\n`)
    return 1
  }
  if (result.status !== 1) {
    deps.writeStderr(`Sanctuary health acceptance probe entry smoke expected exit code 1, received ${String(result.status)}\n`)
    return 1
  }
  if (result.stdout !== "" || result.stderr !== EXPECTED_USAGE) {
    deps.writeStderr("Sanctuary health acceptance probe entry smoke did not emit canonical usage without Nerves/stdout leakage\n")
    return 1
  }
  return 0
}

function defaultDeps() {
  return {
    execPath: process.execPath,
    join: path.join,
    spawnSync,
    writeStderr: (message) => { process.stderr.write(message) },
  }
}

if (require.main === module) {
  process.exitCode = runSanctuaryHealthAcceptanceProbeEntrySmoke(path.resolve(__dirname, ".."))
}

module.exports = { runSanctuaryHealthAcceptanceProbeEntrySmoke }
