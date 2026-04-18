#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { lastNonEmptyLine } = require("./release-smoke.cjs")

function buildLocalInstallArgs(prefixDir, tarballPath) {
  return [
    "install",
    "--prefix",
    prefixDir,
    tarballPath,
  ]
}

function localBinPath(prefixDir, binName, platform = process.platform) {
  const executable = platform === "win32" ? `${binName}.cmd` : binName
  return path.join(prefixDir, "node_modules", ".bin", executable)
}

function runLocalTarballBinVersionSmoke(input, deps = defaultDeps()) {
  const prefixDir = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-package-e2e-"))

  try {
    deps.execFileSync("npm", buildLocalInstallArgs(prefixDir, input.tarballPath), {
      cwd: prefixDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    const resolvedPath = localBinPath(prefixDir, input.binName, deps.platform)
    const output = deps.execFileSync(resolvedPath, ["--version"], {
      cwd: prefixDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const actualVersion = lastNonEmptyLine(output)

    if (actualVersion !== input.version) {
      return {
        ok: false,
        binName: input.binName,
        resolvedPath,
        output,
        message: `${input.binName} from ${path.basename(input.tarballPath)} reported ${actualVersion || "no version"}, expected ${input.version}`,
      }
    }

    return {
      ok: true,
      binName: input.binName,
      resolvedPath,
      output,
      message: `${input.binName} from ${path.basename(input.tarballPath)} verified at ${input.version}`,
    }
  } finally {
    deps.rmSync(prefixDir, { recursive: true, force: true })
  }
}

function runPackageE2ESuite(input, deps = defaultDeps()) {
  return [
    runLocalTarballBinVersionSmoke({
      tarballPath: input.tarballPath,
      binName: "ouro",
      version: input.version,
    }, deps),
  ]
}

function packCurrentRepo(deps = defaultDeps()) {
  const packDir = deps.mkdtempSync(path.join(deps.tmpdir(), "ouro-package-pack-"))
  try {
    const output = deps.execFileSync(
      "npm",
      ["pack", "--pack-destination", packDir],
      {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const tarballName = lastNonEmptyLine(output)
    if (!tarballName) {
      throw new Error("npm pack did not report a tarball name")
    }
    return {
      packDir,
      tarballPath: path.join(packDir, tarballName),
    }
  } catch (error) {
    deps.rmSync(packDir, { recursive: true, force: true })
    throw error
  }
}

function defaultDeps() {
  return {
    execFileSync: childProcess.execFileSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
    platform: process.platform,
  }
}

if (require.main === module) {
  const deps = defaultDeps()
  const version = process.argv[3] || require(path.resolve(__dirname, "../package.json")).version
  const packed = process.argv[2]
    ? { tarballPath: path.resolve(process.argv[2]), packDir: null }
    : packCurrentRepo(deps)

  try {
    const results = runPackageE2ESuite({
      tarballPath: packed.tarballPath,
      version,
    }, deps)
    let ok = true

    for (const result of results) {
      if (result.ok) {
        console.log(result.message)
        console.log(`  resolved: ${result.resolvedPath}`)
      } else {
        ok = false
        console.error(`package e2e: FAIL: ${result.message}`)
        if (result.output) console.error(result.output)
      }
    }

    if (!ok) process.exit(1)
  } finally {
    if (packed.packDir) {
      deps.rmSync(packed.packDir, { recursive: true, force: true })
    }
  }
}

module.exports = {
  buildLocalInstallArgs,
  localBinPath,
  runLocalTarballBinVersionSmoke,
  runPackageE2ESuite,
  packCurrentRepo,
}
