#!/usr/bin/env node
const path = require("path")
const { pathToFileURL } = require("url")

async function main() {
  const socketPath = process.argv[2]
  const bundlesRoot = process.argv[3]
  const homeDir = process.argv[4]
  const args = JSON.parse(process.argv[5] || "[]")
  const repoRoot = path.resolve(__dirname, "../../../../")
  const cliPath = path.join(repoRoot, "dist", "heart", "daemon", "daemon-cli.js")
  const cli = await import(pathToFileURL(cliPath).href)
  const deps = cli.createDefaultOuroCliDeps(socketPath)

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
  const message = error instanceof Error ? error.stack || error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
