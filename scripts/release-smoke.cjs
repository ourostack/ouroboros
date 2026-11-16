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
const {
  packageRootFromBinPath,
  validatePackageAssets,
} = require("./package-assets.cjs")

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

function parsePackageRef(packageRef) {
  const at = packageRef.lastIndexOf("@")
  if (at <= 0) return { name: packageRef, version: "" }
  return { name: packageRef.slice(0, at), version: packageRef.slice(at + 1) }
}

function publishedTarballPath(packageName, version) {
  const baseName = packageName.slice(packageName.lastIndexOf("/") + 1)
  return `/${packageName}/-/${baseName}-${version}.tgz`
}

// npm lists a fresh version in its metadata before it serves that version's tarball
// ("Your package is being processed and may take a few minutes to become available").
// Only a 404 on the exact tarball of the version being smoked counts as that lag.
function isUnservedPublishedTarballError(error, packageRef) {
  const { name, version } = parsePackageRef(packageRef)
  if (!version) return false
  const text = npmExecErrorText(error)
  return /\bE404\b/.test(text) && text.includes(publishedTarballPath(name, version))
}

// A just-published version can miss the registry for minutes: npm answers ETARGET / notarget until its
// metadata propagates, then 404s the tarball until it finishes processing (0.1.0-alpha.1151: still 404
// ten minutes after publish, served by fifteen).
function isRegistryPropagationError(error, packageRef) {
  if (/\b(ETARGET|notarget)\b|No matching version found/i.test(npmExecErrorText(error))) return true
  return packageRef ? isUnservedPublishedTarballError(error, packageRef) : false
}

const PROPAGATION_BACKOFF_MS = [10000, 20000, 40000, 60000, 60000, ...Array(9).fill(120000)]

function runNpmWithPropagationRetry(deps, packageRef, args, options) {
  const maxAttempts = PROPAGATION_BACKOFF_MS.length + 1
  let transientFailures = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return deps.execFileSync("npm", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...options, env: { ...options.env } })
    } catch (error) {
      if (isRegistryPropagationError(error, packageRef)) {
        if (attempt === maxAttempts) throw error
        deps.sleepSync(PROPAGATION_BACKOFF_MS[attempt - 1])
        continue
      }
      transientFailures += 1
      if (!isRetryableNpmExecError(error) || transientFailures >= 3) throw error
      deps.sleepSync(5000)
    }
  }

  throw new Error("unreachable npm exec retry state")
}

function runNpmExec(deps, prefixDir, packageRef, command, args = []) {
  return runNpmWithPropagationRetry(deps, packageRef, buildNpmExecArgs(prefixDir, packageRef, command, args), {
    cwd: prefixDir,
    env: {
      ...deps.env,
      HOME: prefixDir,
      USERPROFILE: prefixDir,
    },
  })
}

// Downloads the exact tarball npm serves for packageRef (npm pack checks it against the registry's
// integrity hash), waiting out the same propagation lag as the smoke.
function packPublishedTarball(input, deps = defaultDeps()) {
  const { name, version } = parsePackageRef(input.packageRef)
  const destination = path.resolve(input.destination)
  deps.mkdirSync(destination, { recursive: true })
  runNpmWithPropagationRetry(deps, input.packageRef, ["pack", input.packageRef, "--pack-destination", destination], {
    cwd: destination,
    env: deps.env,
  })
  const tarballPath = path.join(destination, `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`)
  if (!deps.existsSync(tarballPath)) throw new Error(`npm pack ${input.packageRef} did not write ${tarballPath}`)
  return tarballPath
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

function runPublishedPackageAssetSmoke(input, deps = defaultDeps()) {
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

    const packageRoot = packageRootFromBinPath(resolvedPath, input.packageName)
    const result = validatePackageAssets(packageRoot)
    return {
      ok: result.ok,
      packageRef,
      binName: input.binName,
      resolvedPath: packageRoot,
      output: "",
      message: result.message,
    }
  } finally {
    deps.rmSync(prefixDir, { recursive: true, force: true })
  }
}

function runReleaseSmokeSuite(version, deps = defaultDeps()) {
  return [
    runPublishedPackageAssetSmoke({ packageName: "@ouro.bot/cli", binName: "ouro", version }, deps),
    runPublishedBinVersionSmoke({ packageName: "@ouro.bot/cli", binName: "ouro", version }, deps),
    runPublishedBinVersionSmoke({
      packageRef: `ouro.bot@${version}`,
      binName: "ouro.bot",
      expectedVersion: version,
    }, deps),
  ]
}

function defaultDeps() {
  return {
    env: process.env,
    execFileSync: childProcess.execFileSync,
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    sleepSync(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    },
    tmpdir: os.tmpdir,
  }
}

if (require.main === module && process.argv[2] === "pack") {
  const destination = process.argv[3]
  if (!destination) {
    console.error("usage: release-smoke.cjs pack <destination> [version]")
    process.exit(2)
  }
  const version = process.argv[4] || require(path.resolve(__dirname, "../package.json")).version
  console.log(packPublishedTarball({ packageRef: `@ouro.bot/cli@${version}`, destination }))
} else if (require.main === module) {
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
  isRegistryPropagationError,
  lastNonEmptyLine,
  packPublishedTarball,
  PROPAGATION_BACKOFF_MS,
  runPublishedBinResolutionSmoke,
  runPublishedPackageAssetSmoke,
  runPublishedBinVersionSmoke,
  runReleaseSmokeSuite,
}
