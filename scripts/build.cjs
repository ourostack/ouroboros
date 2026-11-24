const { spawnSync } = require("child_process")
const path = require("path")

function buildSteps(repoRoot, deps = defaultDeps()) {
  return [
    {
      label: "vendor the pinned Desk release",
      command: deps.execPath,
      args: [deps.join(repoRoot, "scripts", "desk-vendor.cjs")],
    },
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
      label: "copy the generated action doors into dist",
      command: deps.execPath,
      args: [deps.join(repoRoot, "scripts", "copy-action-doors.cjs"), repoRoot],
    },
    {
      label: "smoke Sanctuary health acceptance probe entry",
      command: deps.execPath,
      args: [deps.join(repoRoot, "scripts", "sanctuary-health-acceptance-probe-entry-smoke.cjs")],
    },
  ]
}

function parseArgs(argv) {
  return {
    repoRoot: argv[0],
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
  for (const step of buildSteps(repoRoot, deps)) {
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
  parseArgs,
  runBuildCli,
}
