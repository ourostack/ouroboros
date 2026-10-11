#!/usr/bin/env node
// Package end-to-end check for `ouro self-update`: serve the packed build as a
// GitHub release from a loopback HTTP server, run the packed CLI's
// self-update in a throwaway HOME with no daemon, and require that it installs
// and activates the release.

const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { packCurrentRepo, buildLocalInstallArgs } = require("./package-e2e.cjs")

const PUBLISHER = { login: "github-actions[bot]" }
const OLD_VERSION = "0.1.0-alpha.1"

const SERVER_SOURCE = `
const http = require("http")
const fs = require("fs")
const [tarballPath, version] = process.argv.slice(1)
const name = "ouro.bot-cli-" + version + ".tgz"
const server = http.createServer((req, res) => {
  const base = "http://127.0.0.1:" + server.address().port
  if (req.url === "/releases") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify([{
      tag_name: "v" + version,
      draft: false,
      author: ${JSON.stringify(PUBLISHER)},
      assets: [{ name, browser_download_url: base + "/releases/download/v" + version + "/" + name, uploader: ${JSON.stringify(PUBLISHER)} }],
    }]))
    return
  }
  if (req.url === "/releases/download/v" + version + "/" + name) {
    res.setHeader("content-type", "application/octet-stream")
    fs.createReadStream(tarballPath).pipe(res)
    return
  }
  res.statusCode = 404
  res.end("not found")
})
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"))
`

function startServer(tarballPath, version) {
  const child = childProcess.spawn(process.execPath, ["-e", SERVER_SOURCE, tarballPath, version], { stdio: ["ignore", "pipe", "ignore"] })
  return new Promise((resolve, reject) => {
    let buffered = ""
    child.stdout.on("data", (chunk) => {
      buffered += String(chunk)
      const line = buffered.split("\n")[0]
      if (buffered.includes("\n")) resolve({ child, port: Number.parseInt(line, 10) })
    })
    child.on("exit", (code) => reject(new Error(`release server exited ${code}`)))
  })
}

async function main() {
  const version = require(path.resolve(__dirname, "../package.json")).version
  const packed = process.argv[2]
    ? { tarballPath: path.resolve(process.argv[2]), packDir: null }
    : packCurrentRepo()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-self-update-e2e-"))
  const prefix = path.join(root, "runner")
  const home = path.join(root, "home")
  const cliHome = path.join(home, ".ouro-cli")
  const { child, port } = await startServer(packed.tarballPath, version)
  try {
    // The CLI that runs the update pass.
    childProcess.execFileSync("npm", buildLocalInstallArgs(prefix, packed.tarballPath), { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    // A machine on an older version with no daemon and no update history.
    fs.mkdirSync(path.join(cliHome, "versions", OLD_VERSION), { recursive: true })
    fs.symlinkSync(path.join(cliHome, "versions", OLD_VERSION), path.join(cliHome, "CurrentVersion"))

    const entry = path.join(prefix, "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
    const result = childProcess.spawnSync(process.execPath, [entry, "self-update"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // Keep this machine's npm configuration (registry, auth) in the throwaway HOME.
        ...(fs.existsSync(path.join(os.homedir(), ".npmrc")) ? { npm_config_userconfig: path.join(os.homedir(), ".npmrc") } : {}),
        OURO_SELF_UPDATE_E2E: "1",
        OURO_SELF_UPDATE_E2E_GITHUB_BASE: `http://127.0.0.1:${port}`,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15 * 60_000,
    })
    const output = `${result.stdout || ""}${result.stderr || ""}`
    const current = path.basename(fs.readlinkSync(path.join(cliHome, "CurrentVersion")))
    const state = JSON.parse(fs.readFileSync(path.join(cliHome, "update-state.json"), "utf8"))
    const failures = []
    if (result.status !== 0) failures.push(`ouro self-update exited ${result.status}`)
    if (!output.includes("self-update: updated")) failures.push("output did not report self-update: updated")
    if (current !== version) failures.push(`CurrentVersion is ${current}, expected ${version}`)
    if (state.outcome !== "updated" || state.source !== "github") failures.push(`update-state.json recorded ${state.outcome} via ${state.source}`)
    if (failures.length) {
      console.error(`self-update package e2e: FAIL: ${failures.join("; ")}`)
      console.error(output)
      process.exitCode = 1
      return
    }
    console.log(`ouro self-update installed and activated ${version} from a GitHub release (${OLD_VERSION} -> ${current})`)
  } finally {
    child.kill()
    fs.rmSync(root, { recursive: true, force: true })
    if (packed.packDir) fs.rmSync(packed.packDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`self-update package e2e: FAIL: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
