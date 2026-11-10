// Runs one `ouro` CLI command for the edge benchmark against an isolated home,
// the way src/__tests__/integration/fixtures/run-built-cli.cjs does for the
// hermetic integration lane: no launchd, no self-update, no global installs.
// The daemon it starts gets its pid written to <pidFile>, so the benchmark can
// measure the daemon and everything it spawns.
//
// usage: node edge-benchmark-cli.cjs <packageRoot> <socketPath> <bundlesRoot> <homeDir> <pidFile> '<json args>'
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const { pathToFileURL } = require("url")

async function main() {
  const [packageRoot, socketPath, bundlesRoot, homeDir, pidFile, argsJson] = process.argv.slice(2)
  const args = JSON.parse(argsJson || "[]")
  const cliPath = path.join(packageRoot, "dist", "heart", "daemon", "daemon-cli.js")
  const daemonPath = path.join(packageRoot, "dist", "heart", "daemon", "daemon-entry.js")
  const cli = await import(pathToFileURL(cliPath).href)
  const deps = cli.createDefaultOuroCliDeps(socketPath)

  deps.startDaemonProcess = async (daemonSocketPath) => {
    const child = spawn(process.execPath, [daemonPath, "--socket", daemonSocketPath], {
      cwd: homeDir,
      detached: true,
      env: process.env,
      stdio: "ignore",
    })
    child.unref()
    if (child.pid) fs.writeFileSync(pidFile, String(child.pid))
    return { pid: child.pid ?? null }
  }
  deps.bundlesRoot = bundlesRoot
  deps.homeDir = homeDir
  deps.checkForCliUpdate = undefined
  deps.installOuroCommand = undefined
  deps.ensureCurrentVersionInstalled = undefined
  deps.syncGlobalOuroBotWrapper = undefined
  deps.ensureSkillManagement = undefined
  deps.registerOuroBundleType = undefined
  deps.ensureDaemonBootPersistence = undefined
  deps.detectMode = undefined
  deps.getInstalledBinaryPath = undefined
  deps.execInstalledBinary = undefined

  await cli.runOuroCli(args, deps)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
