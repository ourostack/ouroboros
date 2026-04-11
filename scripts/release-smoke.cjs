#!/usr/bin/env node

/**
 * Verifies published npm package binaries from an isolated npm exec prefix.
 *
 * Running `npm exec --package @ouro.bot/cli@x -- ouro --version` from this
 * repository can resolve an already-installed global `ouro` binary instead of
 * the requested package. This helper always runs from a fresh temp prefix and
 * verifies the resolved binary path before trusting any smoke result.
 */

const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

function lastNonEmptyLine(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.at(-1) || ""
}

function isNpmExecBinPath(resolvedPath, binName) {
  const normalized = path.normalize(resolvedPath.trim())
  const expectedSuffix = path.join("node_modules", ".bin", binName)
  return normalized.endsWith(expectedSuffix)
}

function buildNpmExecArgs(prefixDir, packageRef, command, args = []) {
  return [
    "exec",
    "--yes",
    "--prefix",
    prefixDir,
    "--package",
    packageRef,
    "--",
    command,
    ...args,
  ]
}

function runNpmExec(deps, prefixDir, packageRef, command, args = []) {
  return deps.execFileSync(
    "npm",
    buildNpmExecArgs(prefixDir, packageRef, command, args),
    {
      cwd: prefixDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
}

function runPublishedBinResolutionSmoke(input, deps = defaultDeps()) {
  const packageRef = `${input.packageName}@${input.version}`
  const prefixDir = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-release-smoke-"))

  try {
    const resolvedPath = runNpmExec(deps, prefixDir, packageRef, "which", [input.binName]).trim()
    if (!isNpmExecBinPath(resolvedPath, input.binName)) {
      return {
        ok: false,
        packageRef,
        binName: input.binName,
        resolvedPath,
        output: "",
        message: `${packageRef} ${input.binName} resolved to ${resolvedPath}, not an npm exec package binary`,
      }
    }

    return {
      ok: true,
      packageRef,
      binName: input.binName,
      resolvedPath,
      output: "",
      message: `${packageRef} ${input.binName} resolved from npm exec package`,
    }
  } finally {
    deps.rmSync(prefixDir, { recursive: true, force: true })
  }
}

function runPublishedBinVersionSmoke(input, deps = defaultDeps()) {
  const packageRef = `${input.packageName}@${input.version}`
  const prefixDir = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-release-smoke-"))

  try {
    const resolvedPath = runNpmExec(deps, prefixDir, packageRef, "which", [input.binName]).trim()
    if (!isNpmExecBinPath(resolvedPath, input.binName)) {
      return {
        ok: false,
        packageRef,
        binName: input.binName,
        resolvedPath,
        output: "",
        message: `${packageRef} ${input.binName} resolved to ${resolvedPath}, not an npm exec package binary`,
      }
    }

    const output = runNpmExec(deps, prefixDir, packageRef, input.binName, ["--version"])
    const actualVersion = lastNonEmptyLine(output)
    if (actualVersion !== input.version) {
      return {
        ok: false,
        packageRef,
        binName: input.binName,
        resolvedPath,
        output,
        message: `${packageRef} ${input.binName} reported ${actualVersion || "no version"}, expected ${input.version}`,
      }
    }

    return {
      ok: true,
      packageRef,
      binName: input.binName,
      resolvedPath,
      output,
      message: `${packageRef} ${input.binName} verified at ${input.version}`,
    }
  } finally {
    deps.rmSync(prefixDir, { recursive: true, force: true })
  }
}

function runReleaseSmokeSuite(version, deps = defaultDeps()) {
  return [
    runPublishedBinVersionSmoke({ packageName: "@ouro.bot/cli", binName: "ouro", version }, deps),
    runPublishedBinResolutionSmoke({ packageName: "ouro.bot", binName: "ouro.bot", version }, deps),
  ]
}

function defaultDeps() {
  return {
    execFileSync: childProcess.execFileSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
  }
}

if (require.main === module) {
  const version = process.argv[2] || require(path.resolve(__dirname, "../package.json")).version
  const results = runReleaseSmokeSuite(version)
  let ok = true

  for (const result of results) {
    if (result.ok) {
      console.log(result.message)
      console.log(`  resolved: ${result.resolvedPath}`)
    } else {
      ok = false
      console.error(`release smoke: FAIL: ${result.message}`)
      if (result.output) console.error(result.output)
    }
  }

  if (!ok) process.exit(1)
}

module.exports = {
  buildNpmExecArgs,
  isNpmExecBinPath,
  lastNonEmptyLine,
  runPublishedBinResolutionSmoke,
  runPublishedBinVersionSmoke,
  runReleaseSmokeSuite,
}
