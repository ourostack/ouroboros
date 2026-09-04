const { spawnSync } = require("child_process")
const path = require("path")

function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm"
}

function buildSteps(repoRoot, deps = defaultDeps(), options = {}) {
  return [
    {
      label: "clean dist",
      command: deps.execPath,
      args: [deps.join(repoRoot, "scripts", "clean-dist.cjs")],
    },
    {
      label: "compile TypeScript",
      command: deps.execPath,
      args: [deps.resolveTypeScriptTsc()],
    },
    {
      label: "smoke Sanctuary health acceptance probe entry",
      command: deps.execPath,
      args: [deps.join(repoRoot, "scripts", "sanctuary-health-acceptance-probe-entry-smoke.cjs")],
    },
    ...(options.skipMailboxUiInstall ? [] : [{
      label: "install Mailbox UI dependencies",
      command: deps.npmExecutable(),
      args: ["install", "--prefix", "packages/mailbox-ui", "--ignore-scripts"],
    }]),
    {
      label: "build Mailbox UI",
      command: deps.npmExecutable(),
      args: ["run", "build", "--prefix", "packages/mailbox-ui"],
    },
    {
      label: "copy Mailbox UI assets",
      command: deps.execPath,
      args: [deps.join(repoRoot, "scripts", "copy-mailbox-ui.cjs")],
    },
  ]
}

function parseArgs(argv) {
  return {
    repoRoot: argv.find((arg) => arg !== "--skip-mailbox-ui-install"),
    skipMailboxUiInstall: argv.includes("--skip-mailbox-ui-install"),
  }
}

function statusFromSpawnResult(result) {
  if (typeof result.status === "number") return result.status
  return 1
}

function failureSuffix(result) {
  if (typeof result.status === "number") return ` with exit code ${result.status}`
  if (result.signal) return ` after signal ${result.signal}`
  if (result.error) return `: ${result.error.message}`
  return ""
}

function runBuildCli(argv = process.argv.slice(2), deps = defaultDeps()) {
  const options = parseArgs(argv)
  const repoRoot = deps.resolve(options.repoRoot ?? deps.defaultRepoRoot)
  for (const step of buildSteps(repoRoot, deps, options)) {
    const result = deps.spawnSync(step.command, step.args, {
      cwd: repoRoot,
      stdio: "inherit",
    })

    const status = statusFromSpawnResult(result)
    if (status !== 0) {
      deps.writeStderr(`build failed during ${step.label}${failureSuffix(result)}\n`)
      return status
    }
  }

  return 0
}

function defaultDeps() {
  return {
    defaultRepoRoot: path.resolve(__dirname, ".."),
    execPath: process.execPath,
    join: path.join,
    npmExecutable,
    resolve: path.resolve,
    resolveTypeScriptTsc: () => require.resolve("typescript/bin/tsc"),
    spawnSync,
    writeStderr: (text) => process.stderr.write(text),
  }
}

if (require.main === module) {
  process.exitCode = runBuildCli()
}

module.exports = {
  buildSteps,
  npmExecutable,
  parseArgs,
  runBuildCli,
}
