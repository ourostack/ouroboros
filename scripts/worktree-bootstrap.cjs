#!/usr/bin/env node
"use strict"

// `npm run worktree:bootstrap`: give this checkout a node_modules that matches
// package-lock.json. Reuse an installed tree from another checkout of the repo
// (main first) when it matches, so a new worktree needs no network; otherwise
// fall back to `npm install --ignore-scripts` and explain any failure.

const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTCONN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
])

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// npm records the installed tree in node_modules/.package-lock.json. Mirrors
// rewrite `resolved` and `integrity`, so only versions are compared.
function installedTreeMismatch(lock, installedRecord) {
  const wanted = lock?.packages
  const installed = installedRecord?.packages
  if (!wanted || !installed) return "no node_modules/.package-lock.json"
  for (const [key, entry] of Object.entries(installed)) {
    if (!wanted[key]) return `${key} is installed but not in package-lock.json`
    if (wanted[key].version !== entry.version) {
      return `${key} is ${entry.version}, package-lock.json wants ${wanted[key].version}`
    }
  }
  for (const [key, entry] of Object.entries(wanted)) {
    if (key === "" || installed[key] || entry.optional || entry.devOptional) continue
    return `${key}@${entry.version} is missing`
  }
  return null
}

function listCheckouts(root) {
  const result = childProcess.spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })
  if (result.status !== 0) return []
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
}

// clonefile(2) clones a whole directory tree in one call (under a second for
// node_modules, against ~20s for `cp -cR`, which clones file by file). Node has
// no binding, so call it through the system Python, only when the developer
// tools are installed: otherwise /usr/bin/python3 is a stub that opens an
// install dialog.
const CLONEFILE_PY =
  "import ctypes,sys\n" +
  "libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)\n" +
  "sys.exit(0 if libc.clonefile(sys.argv[1].encode(),sys.argv[2].encode(),0)==0 else 1)"

function cloneTree(source, target, platform = process.platform) {
  if (platform === "darwin") {
    const quiet = { stdio: "ignore" }
    const hasDeveloperTools = childProcess.spawnSync("xcode-select", ["-p"], quiet).status === 0
    if (hasDeveloperTools && childProcess.spawnSync("/usr/bin/python3", ["-c", CLONEFILE_PY, source, target], quiet).status === 0) return
    fs.rmSync(target, { recursive: true, force: true })
    if (childProcess.spawnSync("cp", ["-cR", source, target], quiet).status === 0) return
    fs.rmSync(target, { recursive: true, force: true })
  }
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true })
}

function sameDir(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

function reuseInstalledTree({ root, checkouts, clone = cloneTree, log = console.log }) {
  const lock = readJson(path.join(root, "package-lock.json"))
  if (!lock) return { mode: "install", reason: "no package-lock.json" }
  const target = path.join(root, "node_modules")
  if (!installedTreeMismatch(lock, readJson(path.join(target, ".package-lock.json")))) {
    log("worktree:bootstrap: node_modules already matches package-lock.json.")
    return { mode: "current" }
  }
  for (const checkout of checkouts) {
    if (sameDir(checkout, root)) continue
    const source = path.join(checkout, "node_modules")
    if (installedTreeMismatch(lock, readJson(path.join(source, ".package-lock.json")))) continue
    const staging = `${target}.bootstrap-${process.pid}`
    fs.rmSync(staging, { recursive: true, force: true })
    clone(source, staging)
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(staging, target)
    log(`worktree:bootstrap: reused node_modules from ${checkout} (its installed tree matches package-lock.json; no network used).`)
    return { mode: "reused", source: checkout }
  }
  return { mode: "install", reason: "no other checkout has node_modules matching package-lock.json" }
}

function packageFromTarballUrl(url) {
  const match = /^https?:\/\/[^/]+\/(?:.*?\/)?((?:@[^/]+(?:\/|%2[fF]))?[^/@]+)\/-\/([^/]+)\.tgz$/.exec(url)
  if (!match) return null
  const name = decodeURIComponent(match[1])
  const prefix = `${name.split("/").pop()}-`
  if (!match[2].startsWith(prefix)) return null
  return { name, version: match[2].slice(prefix.length) }
}

function diagnoseNpmFailure(stderr, registry) {
  const code = /npm (?:error|ERR!) code (\S+)/.exec(stderr)?.[1]
  const tarball = /\b(?:GET|request to) (https?:\/\/\S+?\.tgz)\b/.exec(stderr)?.[1]
  const pkg = tarball ? packageFromTarballUrl(tarball) : null
  const target = /No matching version found for (\S+?)\.?$/m.exec(stderr)?.[1]
  const spec = pkg ? `${pkg.name}@${pkg.version}` : target
  const name = pkg?.name ?? (target ? target.replace(/@[^@]*$/, "") : null)
  const publicRegistry = "https://registry.npmjs.org/"
  const usingPublic = registry.replace(/\/?$/, "/") === publicRegistry

  if ((code === "E404" || code === "ETARGET") && spec) {
    return [
      `worktree:bootstrap: npm install failed: ${registry} does not serve ${spec}, which package-lock.json requires.`,
      usingPublic
        ? "What probably happened: that version was unpublished or never existed."
        : "What probably happened: the registry is a mirror that has not picked up this version yet (mirrors often hold back new releases for days).",
      `Look further: npm view ${name} versions --registry ${registry}`,
      usingPublic
        ? `Do this: pick a published version from that list and update package-lock.json to it in a pull request.`
        : `Do this: npm install --ignore-scripts --registry ${publicRegistry}  (or run the bootstrap where some checkout already has a matching install; it is reused without network).`,
    ].join("\n")
  }
  if (code && NETWORK_ERROR_CODES.has(code)) {
    const host = /request to (https?:\/\/[^/\s]+)/.exec(stderr)?.[1] ?? registry
    return [
      `worktree:bootstrap: npm install failed: could not reach ${host} (${code}).`,
      "What probably happened: no network, a proxy, or network protection (such as Defender) blocks that registry on this machine.",
      `Look further: npm ping --registry ${host}`,
      "Do this: install once in any checkout of this repo on a network that reaches the registry; every worktree with the same package-lock.json then reuses that install offline.",
    ].join("\n")
  }
  return [
    `worktree:bootstrap: npm install failed${code ? ` (${code})` : ""}.`,
    "What probably happened: see the npm error above.",
    "Look further: the npm debug log path printed above.",
    "Do this: fix the reported cause and rerun npm run worktree:bootstrap.",
  ].join("\n")
}

function runNpmInstall(root) {
  const npmCli = process.env.npm_execpath
  const [command, args] = npmCli && /\.c?js$/.test(npmCli)
    ? [process.execPath, [npmCli, "install", "--ignore-scripts"]]
    : [process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts"]]
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, { cwd: root, stdio: ["inherit", "inherit", "pipe"], shell: process.platform === "win32" && command === "npm.cmd" })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on("error", (error) => resolve({ status: 1, stderr: `${stderr}${error.message}\n` }))
    child.on("close", (status) => resolve({ status: status ?? 1, stderr }))
  })
}

function npmRegistry(root) {
  const result = childProcess.spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["config", "get", "registry"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  })
  return result.stdout?.trim() || "https://registry.npmjs.org/"
}

async function bootstrap({
  root = path.resolve(__dirname, ".."),
  checkouts = listCheckouts(root),
  clone = cloneTree,
  install = runNpmInstall,
  registry = () => npmRegistry(root),
  log = console.log,
  logError = console.error,
} = {}) {
  const reuse = reuseInstalledTree({ root, checkouts, clone, log })
  if (reuse.mode !== "install") return { ...reuse, status: 0 }
  log(`worktree:bootstrap: ${reuse.reason}; running npm install --ignore-scripts.`)
  const result = await install(root)
  if (result.status !== 0) logError(diagnoseNpmFailure(result.stderr, registry()))
  return { mode: "install", status: result.status }
}

if (require.main === module) {
  bootstrap().then((result) => {
    process.exitCode = result.status
  })
}

module.exports = {
  bootstrap,
  cloneTree,
  diagnoseNpmFailure,
  installedTreeMismatch,
  packageFromTarballUrl,
  reuseInstalledTree,
}
