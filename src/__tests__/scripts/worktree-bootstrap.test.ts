import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const scriptPath = path.resolve(__dirname, "../../../scripts/worktree-bootstrap.cjs")
const { cloneTree, diagnoseNpmFailure, installedTreeMismatch, reuseInstalledTree } = require(scriptPath)

const tempDirs: string[] = []

function lockfile(version: string) {
  return {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { "left-pad": version } },
      "node_modules/left-pad": {
        version,
        resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${version}.tgz`,
        integrity: "sha512-AAAA",
      },
      "node_modules/@esbuild/aix-ppc64": { version: "0.25.0", optional: true, os: ["aix"], cpu: ["ppc64"] },
    },
  }
}

function installedRecord(version: string) {
  return {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "node_modules/left-pad": { version, integrity: "sha1-mirror" } },
  }
}

function git(cwd: string, ...args: string[]) {
  childProcess.execFileSync("git", args, { cwd, stdio: "ignore" })
}

// A main checkout with an installed tree, plus a fresh git worktree of it.
function makeCheckouts(installedVersion: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-bootstrap-"))
  tempDirs.push(base)
  const main = path.join(base, "main")
  fs.mkdirSync(path.join(main, "scripts"), { recursive: true })
  fs.copyFileSync(scriptPath, path.join(main, "scripts", "worktree-bootstrap.cjs"))
  fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }))
  fs.writeFileSync(path.join(main, "package-lock.json"), JSON.stringify(lockfile("1.3.0")))
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules/\n")
  git(main, "init", "-q")
  git(main, "add", ".")
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
  fs.mkdirSync(path.join(main, "node_modules", "left-pad"), { recursive: true })
  fs.writeFileSync(path.join(main, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: installedVersion }))
  fs.writeFileSync(path.join(main, "node_modules", ".package-lock.json"), JSON.stringify(installedRecord(installedVersion)))
  const worktree = path.join(base, "worktree")
  git(main, "worktree", "add", "-q", worktree)
  return { base, main, worktree }
}

// Runs the real CLI with npm pointed at a closed local port and an empty cache,
// so any network use fails fast instead of reaching a registry.
function runBootstrap(base: string, worktree: string) {
  fs.writeFileSync(path.join(base, "empty-npmrc"), "")
  return childProcess.spawnSync(process.execPath, [path.join(worktree, "scripts", "worktree-bootstrap.cjs")], {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_execpath: "",
      npm_config_userconfig: path.join(base, "empty-npmrc"),
      npm_config_cache: path.join(base, "npm-cache"),
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_fetch_retries: "0",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("worktree bootstrap", () => {
  it("clones the main checkout's node_modules without network when its installed tree matches the lockfile", () => {
    const { base, worktree } = makeCheckouts("1.3.0")

    const result = runBootstrap(base, worktree)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("reused node_modules from")
    expect(JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", "left-pad", "package.json"), "utf8")).version).toBe("1.3.0")
    expect(fs.existsSync(path.join(base, "npm-cache"))).toBe(false)
  })

  it("falls back to npm install when the main checkout's installed tree does not match, and explains the failure", () => {
    const { base, worktree } = makeCheckouts("1.2.0")

    const result = runBootstrap(base, worktree)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("running npm install --ignore-scripts")
    expect(result.stderr).toContain("could not reach http://127.0.0.1:9 (ECONNREFUSED)")
    expect(result.stderr).toContain("Look further: npm ping --registry http://127.0.0.1:9")
    expect(fs.existsSync(path.join(worktree, "node_modules", "left-pad"))).toBe(false)
  })

  it("compares installed versions, ignoring mirror integrity and optional packages this host cannot install", () => {
    const linux = { os: "linux", cpu: "x64", libc: "glibc" }
    expect(installedTreeMismatch(lockfile("1.3.0"), installedRecord("1.3.0"), linux)).toBeNull()
    const withOptionalFeature = lockfile("1.3.0")
    Object.assign(withOptionalFeature.packages, { "node_modules/stripe": { version: "18.0.0", optional: true } })
    expect(installedTreeMismatch(withOptionalFeature, installedRecord("1.3.0"), linux)).toBe("node_modules/stripe@18.0.0 is missing")
    const linuxOnly = lockfile("1.3.0")
    Object.assign(linuxOnly.packages, { "node_modules/@esbuild/linux-x64": { version: "0.25.0", optional: true, os: ["linux"], cpu: ["x64"] } })
    expect(installedTreeMismatch(linuxOnly, installedRecord("1.3.0"), linux)).toBe("node_modules/@esbuild/linux-x64@0.25.0 is missing")
    expect(installedTreeMismatch(linuxOnly, installedRecord("1.3.0"), { os: "darwin", cpu: "arm64" })).toBeNull()
    expect(installedTreeMismatch(lockfile("1.3.0"), installedRecord("1.2.0"))).toBe(
      "node_modules/left-pad is 1.2.0, package-lock.json wants 1.3.0",
    )
    expect(installedTreeMismatch(lockfile("1.3.0"), { packages: {} })).toBe("node_modules/left-pad@1.3.0 is missing")
    expect(installedTreeMismatch(lockfile("1.3.0"), null)).toBe("no node_modules/.package-lock.json")
  })

  it("names the package and version a mirror lacks, and the command to run", () => {
    const stderr = [
      "npm error code E404",
      "npm error 404 Not Found - GET https://packagefeedproxy.microsoft.io/npm/minimatch/-/minimatch-11.0.7.tgz - Cannot find the file minimatch-11.0.7.tgz in package 'minimatch 11.0.7' in feed 'npm-public'",
      "npm error 404  'minimatch@https://packagefeedproxy.microsoft.io/npm/minimatch/-/minimatch-11.0.7.tgz' is not in this registry.",
    ].join("\n")

    const message = diagnoseNpmFailure(stderr, "https://packagefeedproxy.microsoft.io/npm/")

    expect(message).toContain("https://packagefeedproxy.microsoft.io/npm/ does not serve minimatch@11.0.7")
    expect(message).toContain("Look further: npm view minimatch versions --registry https://packagefeedproxy.microsoft.io/npm/")
    expect(message).toContain("Do this: npm install --ignore-scripts --registry https://registry.npmjs.org/")
  })

  it("copies the tree and keeps .bin symlinks relative where copy-on-write cloning is unavailable", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-bootstrap-"))
    tempDirs.push(base)
    const source = path.join(base, "source")
    fs.mkdirSync(path.join(source, ".bin"), { recursive: true })
    fs.mkdirSync(path.join(source, "tool"))
    fs.writeFileSync(path.join(source, "tool", "cli.js"), "cli")
    fs.symlinkSync("../tool/cli.js", path.join(source, ".bin", "tool"))

    cloneTree(source, path.join(base, "target"), "linux")

    expect(fs.readlinkSync(path.join(base, "target", ".bin", "tool"))).toBe("../tool/cli.js")
    expect(fs.readFileSync(path.join(base, "target", ".bin", "tool"), "utf8")).toBe("cli")
  })

  it("clones a symlinked node_modules as a real directory, never as a shared link", () => {
    const { main, worktree } = makeCheckouts("1.3.0")
    fs.renameSync(path.join(main, "node_modules"), path.join(main, "installed"))
    fs.symlinkSync(path.join(main, "installed"), path.join(main, "node_modules"))

    const result = reuseInstalledTree({
      root: worktree,
      checkouts: [main, worktree],
      clone: (source: string, target: string) => cloneTree(source, target, "linux"),
      log: () => {},
    })

    expect(result.mode).toBe("reused")
    expect(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(worktree, "node_modules", "left-pad", "package.json"))).toBe(true)
  })

  it("names scoped packages from mirror tarball URLs", () => {
    const stderr = "npm error code E404\nnpm error 404 Not Found - GET https://feed.example/npm/registry/@azure/core-auth/-/core-auth-1.10.1.tgz - Not found"

    expect(diagnoseNpmFailure(stderr, "https://feed.example/npm/registry/")).toContain("does not serve @azure/core-auth@1.10.1")
  })
})
