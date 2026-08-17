#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const ENTRY_RELATIVE_PATH = path.join(
  "node_modules",
  "@ouro.bot",
  "cli",
  "dist",
  "heart",
  "daemon",
  "ouro-entry.js",
)

function buildWrapperPackArgs(packDir) {
  return ["pack", "./packages/ouro.bot", "--pack-destination", packDir]
}

function buildWrapperInstallArgs(prefixDir, tarballPath) {
  return ["install", "--prefix", prefixDir, tarballPath]
}

function wrapperFixtureVersions(version) {
  return [null, "0.0.1", version, "999.0.0"]
}

function installedEntryScript(version) {
  return [
    "#!/usr/bin/env node",
    `const version = ${JSON.stringify(version)}`,
    "if (process.argv.slice(2).includes('--version')) process.stdout.write(version + '\\n')",
    "else process.stdout.write('ran packed ouro ' + JSON.stringify(process.argv.slice(2)) + '\\n')",
    "",
  ].join("\n")
}

function writeInstalledRuntime(homeDir, version) {
  const ouroHome = path.join(homeDir, ".ouro-cli")
  const versionDir = path.join(ouroHome, "versions", version)
  const entryPath = path.join(versionDir, ENTRY_RELATIVE_PATH)
  fs.mkdirSync(path.dirname(entryPath), { recursive: true })
  fs.writeFileSync(entryPath, installedEntryScript(version), { mode: 0o755 })
  const currentLink = path.join(ouroHome, "CurrentVersion")
  fs.rmSync(currentLink, { force: true })
  fs.symlinkSync(versionDir, currentLink)
  fs.writeFileSync(path.join(ouroHome, "version-intent.json"), `${JSON.stringify({
    schemaVersion: 1,
    mode: "latest",
    targetVersion: version,
  }, null, 2)}\n`, { mode: 0o600 })
}

function writeFakeNpm(binDir, version) {
  const fakeNpmPath = path.join(binDir, "npm")
  const script = `#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const args = process.argv.slice(2)
if (args[0] !== "install") {
  process.stderr.write("unexpected fake npm args: " + JSON.stringify(args) + "\\n")
  process.exit(1)
}
const prefixIndex = args.indexOf("--prefix")
const prefix = args[prefixIndex + 1]
const expected = ${JSON.stringify(`@ouro.bot/cli@${version}`)}
if (!args.includes(expected)) {
  process.stderr.write("unexpected cli package ref: " + JSON.stringify(args) + "\\n")
  process.exit(1)
}
const entry = path.join(prefix, ${JSON.stringify(ENTRY_RELATIVE_PATH)})
fs.mkdirSync(path.dirname(entry), { recursive: true })
fs.writeFileSync(entry, ${JSON.stringify(installedEntryScript(version))}, { mode: 0o755 })
`
  fs.writeFileSync(fakeNpmPath, script, { mode: 0o755 })
}

function runPackedWrapperCase(input, deps = defaultDeps()) {
  const root = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-wrapper-case-"))
  const homeDir = path.join(root, "home")
  const binDir = path.join(root, "bin")
  try {
    deps.mkdirSync(homeDir, { recursive: true })
    deps.mkdirSync(binDir, { recursive: true })
    writeFakeNpm(binDir, input.version)
    if (input.installedVersion !== null) writeInstalledRuntime(homeDir, input.installedVersion)

    const result = deps.spawnSync(deps.execPath, [input.wrapperEntry, "--version"], {
      env: {
        ...deps.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        PATH: `${binDir}${path.delimiter}${deps.env.PATH || ""}`,
        SHELL: "/bin/zsh",
      },
      encoding: "utf-8",
    })
    if (result.status !== 0) {
      throw new Error(`packed wrapper failed from ${input.installedVersion ?? "fresh"}: ${result.stderr}`)
    }
    if (result.stdout.trim() !== input.version) {
      throw new Error(`packed wrapper reported ${result.stdout.trim() || "no version"}, expected ${input.version}`)
    }

    const ouroHome = path.join(homeDir, ".ouro-cli")
    const intent = JSON.parse(deps.readFileSync(path.join(ouroHome, "version-intent.json"), "utf8"))
    if (intent.mode !== "pinned" || intent.targetVersion !== input.version) {
      throw new Error(`packed wrapper wrote unexpected intent: ${JSON.stringify(intent)}`)
    }
    const currentTarget = path.basename(deps.readlinkSync(path.join(ouroHome, "CurrentVersion")))
    if (currentTarget !== input.version) {
      throw new Error(`packed wrapper activated ${currentTarget}, expected ${input.version}`)
    }
    const launcherPath = path.join(ouroHome, "bin", "ouro-launcher.js")
    if (!deps.existsSync(launcherPath) || (deps.statSync(launcherPath).mode & 0o777) !== 0o755) {
      throw new Error("packed wrapper did not install an executable recovery launcher")
    }
    return {
      ok: true,
      installedVersion: input.installedVersion,
      message: `packed wrapper replaced ${input.installedVersion ?? "fresh"} state with exact ${input.version} intent`,
    }
  } finally {
    deps.rmSync(root, { recursive: true, force: true })
  }
}

function runPackedWrapperE2E(deps = defaultDeps()) {
  const root = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-wrapper-e2e-"))
  const packDir = path.join(root, "pack")
  const installDir = path.join(root, "install")
  try {
    deps.mkdirSync(packDir, { recursive: true })
    deps.mkdirSync(installDir, { recursive: true })
    const packOutput = deps.execFileSync("npm", buildWrapperPackArgs(packDir), {
      cwd: deps.repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const tarballName = packOutput.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (!tarballName) throw new Error("wrapper npm pack did not report a tarball")
    const tarballPath = path.join(packDir, tarballName)
    deps.execFileSync("npm", buildWrapperInstallArgs(installDir, tarballPath), {
      cwd: installDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const packageRoot = path.join(installDir, "node_modules", "ouro.bot")
    const packageJson = JSON.parse(deps.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
    const wrapperEntry = path.join(packageRoot, "index.js")
    return wrapperFixtureVersions(packageJson.version).map((installedVersion) => runPackedWrapperCase({
      wrapperEntry,
      version: packageJson.version,
      installedVersion,
    }, deps))
  } finally {
    deps.rmSync(root, { recursive: true, force: true })
  }
}

function defaultDeps() {
  return {
    env: process.env,
    execFileSync: childProcess.execFileSync,
    execPath: process.execPath,
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    readFileSync: fs.readFileSync,
    readlinkSync: fs.readlinkSync,
    repoRoot: path.resolve(__dirname, ".."),
    rmSync: fs.rmSync,
    spawnSync: childProcess.spawnSync,
    statSync: fs.statSync,
    tmpdir: os.tmpdir,
  }
}

if (require.main === module) {
  try {
    for (const result of runPackedWrapperE2E()) process.stdout.write(`${result.message}\n`)
  } catch (error) {
    process.stderr.write(`ouro.bot package e2e: FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  buildWrapperInstallArgs,
  buildWrapperPackArgs,
  runPackedWrapperCase,
  runPackedWrapperE2E,
  wrapperFixtureVersions,
}
