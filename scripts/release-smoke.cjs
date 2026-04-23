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

function npmExecErrorText(error) {
  return [
    error && error.message,
    error && error.stderr,
    error && Array.isArray(error.output) ? error.output.join("\n") : "",
  ].filter(Boolean).join("\n")
}

function isRetryableNpmExecError(error) {
  return /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ERR_SOCKET_TIMEOUT)\b|Invalid response body|fetch failed|network.*aborted/i.test(
    npmExecErrorText(error),
  )
}

function runNpmExec(deps, prefixDir, packageRef, command, args = []) {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return deps.execFileSync(
        "npm",
        buildNpmExecArgs(prefixDir, packageRef, command, args),
        {
          cwd: prefixDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableNpmExecError(error)) throw error
      deps.sleepSync(5000)
    }
  }

  throw new Error("unreachable npm exec retry state")
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
  const packageRef = input.packageRef ?? `${input.packageName}@${input.version}`
  const expectedVersion = input.expectedVersion ?? input.version
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
    if (actualVersion !== expectedVersion) {
      return {
        ok: false,
        packageRef,
        binName: input.binName,
        resolvedPath,
        output,
        message: `${packageRef} ${input.binName} reported ${actualVersion || "no version"}, expected ${expectedVersion}`,
      }
    }

    return {
      ok: true,
      packageRef,
      binName: input.binName,
      resolvedPath,
      output,
      message: `${packageRef} ${input.binName} verified at ${expectedVersion}`,
    }
  } finally {
    deps.rmSync(prefixDir, { recursive: true, force: true })
  }
}

function runReleaseSmokeSuite(version, deps = defaultDeps()) {
  return [
    runPublishedBinVersionSmoke({ packageName: "@ouro.bot/cli", binName: "ouro", version }, deps),
    runPublishedBinVersionSmoke({
      packageRef: "ouro.bot@latest",
      binName: "ouro.bot",
      expectedVersion: version,
    }, deps),
  ]
}

function defaultDeps() {
  return {
    execFileSync: childProcess.execFileSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    sleepSync(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    },
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
  isRetryableNpmExecError,
  lastNonEmptyLine,
  runPublishedBinResolutionSmoke,
  runPublishedBinVersionSmoke,
  runReleaseSmokeSuite,
}
