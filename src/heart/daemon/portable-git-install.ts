import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  PORTABLE_GIT_RELEASE,
  findGitOnPath,
  portableGitAsset,
  portableGitAssetUrl,
  portableGitBinary,
  portableGitEnv,
  portableGitRoot,
  portableGitToolsDir,
  type PortableGitAsset,
} from "./portable-git"

/** Room for the archive (about 25 MB) and the extracted tree (about 57 MB) together. */
export const PORTABLE_GIT_MIN_FREE_BYTES = 128 * 1024 * 1024
export const PORTABLE_GIT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const MARKER_FILE = "ouro-portable-git.json"

export interface ProcessRun {
  status: number | null
  stdout: string
  stderr: string
}

export interface PortableGitInstallDeps {
  platform: string
  arch: string
  homeDir: string
  fetch: typeof fetch
  freeBytes: (dir: string) => number
  /** Unpack a .tar.gz archive into an existing directory. */
  extract: (archive: string, dest: string) => void
  run: (file: string, args: string[], env?: Record<string, string>) => ProcessRun
  now: () => Date
  resolveAsset?: (platform: string, arch: string) => PortableGitAsset | null
  assetUrl?: (asset: PortableGitAsset) => string
}

export interface PortableGitMarker {
  release: string
  asset: string
  sha256: string
  gitVersion: string
  installedAt: string
}

export interface PortableGitInstallResult {
  status: "installed" | "already-installed"
  root: string
  marker: PortableGitMarker
}

function releaseDir(toolsDir: string): string {
  return path.join(toolsDir, `git-${PORTABLE_GIT_RELEASE}`)
}

export function readPortableGitMarker(root: string): PortableGitMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, MARKER_FILE), "utf8")) as Partial<PortableGitMarker>
    if (typeof parsed.release !== "string" || typeof parsed.gitVersion !== "string") return null
    return parsed as PortableGitMarker
  } catch {
    return null
  }
}

function linkTarget(linkPath: string): string | null {
  try {
    const stat = fs.lstatSync(linkPath)
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not the portable git link; move it aside and run \`ouro git install\` again`)
    }
    return fs.readlinkSync(linkPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function download(deps: PortableGitInstallDeps, url: string, archivePath: string): Promise<string> {
  const response = await deps.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(PORTABLE_GIT_DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) throw new Error(`portable git download failed: HTTP ${response.status} from ${url}`)
  const hash = crypto.createHash("sha256")
  const fd = fs.openSync(archivePath, "w", 0o600)
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      fs.writeSync(fd, chunk)
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest("hex")
}

function verifyTree(deps: PortableGitInstallDeps, tree: string): string {
  const git = deps.run(path.join(tree, "bin", "git"), ["--version"])
  if (git.status !== 0) throw new Error(`portable git does not run on this host: ${(git.stderr || git.stdout).trim()}`)
  // Through git, as sync will run it: with no URL the HTTPS helper prints its
  // usage and exits 129. A missing libcurl stops it before that, and a git
  // that cannot find its helpers says "not a git command".
  const helper = deps.run(path.join(tree, "bin", "git"), ["remote-https"], portableGitEnv(tree))
  if (/is not a git command/.test(helper.stderr)) {
    throw new Error(`portable git cannot find its helpers under ${tree}: ${helper.stderr.trim()}`)
  }
  if (helper.status === 127 || /error while loading shared libraries/.test(helper.stderr)) {
    const reason = helper.stderr.split("\n").find((line) => /shared librar/.test(line)) ?? helper.stderr.trim()
    throw new Error(`portable git's HTTPS helper cannot load on this host (${reason}); install libcurl (libcurl.so.4) or a system git`)
  }
  return git.stdout.trim()
}

/**
 * Remove a tree we created by enumerating it: unlink each file and link (links
 * are never followed), then rmdir bottom-up. Agent-callable code doesn't use
 * recursive rm (test-isolation.contract Directive A). A missing path is fine.
 */
export function removeTree(target: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch {
    return
  }
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true })
    return
  }
  for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry))
  fs.rmdirSync(target)
}

function pruneOthers(toolsDir: string, keep: string): void {
  for (const entry of fs.readdirSync(toolsDir)) {
    const isOurs = /^git-v/.test(entry) || /^\.git-.*\.(partial|tar\.gz)$/.test(entry)
    if (!isOurs || entry === keep) continue
    removeTree(path.join(toolsDir, entry))
  }
}

/**
 * Download, verify and install the pinned portable git, then point
 * ~/.ouro-cli/tools/git at it. The archive must match its pinned sha256, and
 * the unpacked git must run here before it replaces anything.
 */
export async function installPortableGit(deps: PortableGitInstallDeps, options: { force?: boolean } = {}): Promise<PortableGitInstallResult> {
  const asset = (deps.resolveAsset ?? portableGitAsset)(deps.platform, deps.arch)
  if (!asset) {
    throw new Error(`no portable git for ${deps.platform}-${deps.arch}; it covers Linux arm64, x64 and arm. Install git with the host's package manager.`)
  }
  const toolsDir = portableGitToolsDir(deps.homeDir)
  const root = portableGitRoot(deps.homeDir)
  const target = releaseDir(toolsDir)
  fs.mkdirSync(toolsDir, { recursive: true, mode: 0o700 })
  const currentLink = linkTarget(root)
  const installed = readPortableGitMarker(target)
  if (!options.force && installed?.release === PORTABLE_GIT_RELEASE && currentLink === path.basename(target)) {
    return { status: "already-installed", root, marker: installed }
  }

  const free = deps.freeBytes(toolsDir)
  if (free < PORTABLE_GIT_MIN_FREE_BYTES) {
    throw new Error(`portable git needs ${Math.ceil(PORTABLE_GIT_MIN_FREE_BYTES / 1048576)} MiB free under ${toolsDir}; ${Math.floor(free / 1048576)} MiB is free`)
  }

  const url = (deps.assetUrl ?? portableGitAssetUrl)(asset)
  const archive = path.join(toolsDir, `.git-${PORTABLE_GIT_RELEASE}.tar.gz`)
  const staging = path.join(toolsDir, `.git-${PORTABLE_GIT_RELEASE}.partial`)
  emitNervesEvent({ component: "daemon", event: "daemon.portable_git_install_start", message: "installing the portable git", meta: { url, toolsDir } })
  try {
    const digest = await download(deps, url, archive)
    if (digest !== asset.sha256) throw new Error(`portable git archive failed its checksum: expected ${asset.sha256}, got ${digest}`)
    removeTree(staging)
    fs.mkdirSync(staging, { recursive: true })
    deps.extract(archive, staging)
    const gitVersion = verifyTree(deps, staging)
    const marker: PortableGitMarker = { release: PORTABLE_GIT_RELEASE, asset: asset.name, sha256: asset.sha256, gitVersion, installedAt: deps.now().toISOString() }
    fs.writeFileSync(path.join(staging, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`)
    removeTree(target)
    fs.renameSync(staging, target)
    const tempLink = path.join(toolsDir, `.git-link-${process.pid}`)
    fs.rmSync(tempLink, { force: true })
    fs.symlinkSync(path.basename(target), tempLink)
    fs.renameSync(tempLink, root)
    pruneOthers(toolsDir, path.basename(target))
    emitNervesEvent({ component: "daemon", event: "daemon.portable_git_installed", message: "portable git installed", meta: { root, gitVersion, release: PORTABLE_GIT_RELEASE } })
    return { status: "installed", root, marker }
  } catch (error) {
    fs.rmSync(archive, { force: true })
    removeTree(staging)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.portable_git_install_error",
      message: "portable git install failed",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

export interface GitAvailability {
  /** The host's own git, or null. The portable git's directory is not counted. */
  systemGit: string | null
  portable: { root: string; binary: string; marker: PortableGitMarker | null } | null
  /** Whether a portable git exists for this platform. */
  portableSupported: boolean
}

export function describeGitAvailability(options: { env?: NodeJS.ProcessEnv; homeDir?: string; platform?: string; arch?: string } = {}): GitAvailability {
  const env = options.env ?? process.env
  const binary = portableGitBinary(options.homeDir)
  const portableBin = path.dirname(binary)
  const hostPath = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== portableBin).join(path.delimiter)
  const systemGit = findGitOnPath(hostPath)
  const root = portableGitRoot(options.homeDir)
  const portable = fs.existsSync(binary) ? { root, binary, marker: readPortableGitMarker(root) } : null
  return {
    systemGit,
    portable,
    portableSupported: portableGitAsset(options.platform ?? process.platform, options.arch ?? process.arch) !== null,
  }
}

export function renderGitAvailability(availability: GitAvailability): string {
  const lines: string[] = []
  lines.push(availability.systemGit ? `system git: ${availability.systemGit}` : "system git: none")
  if (availability.portable) {
    const marker = availability.portable.marker
    lines.push(`portable git: ${availability.portable.root}${marker ? ` (${marker.gitVersion}, ${marker.release})` : ""}`)
    lines.push(availability.systemGit ? "in use: system git" : "in use: portable git")
  } else if (availability.systemGit) {
    lines.push("in use: system git")
  } else if (availability.portableSupported) {
    lines.push("in use: none; run `ouro git install`")
  } else {
    lines.push("in use: none; install git with the host's package manager")
  }
  return lines.join("\n")
}

/* v8 ignore start -- host defaults: real network, statfs, tar and process spawning @preserve */
export function createDefaultPortableGitInstallDeps(homeDir: string = os.homedir()): PortableGitInstallDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    homeDir,
    fetch: globalThis.fetch,
    freeBytes: (dir) => {
      const stats = fs.statfsSync(dir)
      return Number(stats.bavail) * Number(stats.bsize)
    },
    extract: (archive, dest) => {
      const run = spawnSync("tar", ["-xzf", archive, "-C", dest], { stdio: ["ignore", "pipe", "pipe"] })
      if (run.error) throw run.error
      if (run.status !== 0) throw new Error(`tar failed: ${run.stderr.toString().trim()}`)
    },
    run: (file, args, env) => {
      const run = spawnSync(file, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
      if (run.error) return { status: null, stdout: "", stderr: run.error.message }
      return { status: run.status, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
    },
    now: () => new Date(),
  }
}
/* v8 ignore stop */
