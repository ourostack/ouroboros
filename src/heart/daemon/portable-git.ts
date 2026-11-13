import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * A portable git for hosts that have none (a BusyBox appliance has no package
 * manager to install one). The build is GitHub Desktop's dugite-native: git
 * with a relocatable prefix that links only libc, zlib and, for HTTPS, the
 * host's libcurl. It is installed under ~/.ouro-cli/tools/git and used only
 * when the host has no git of its own.
 */
export const PORTABLE_GIT_RELEASE = "v2.56.0-2"
export const PORTABLE_GIT_BUILD = "v2.56.0-a44aeca"

export interface PortableGitAsset {
  name: string
  sha256: string
}

export const PORTABLE_GIT_ASSETS: Readonly<Record<string, PortableGitAsset>> = {
  "linux-arm64": { name: `dugite-native-${PORTABLE_GIT_BUILD}-ubuntu-arm64.tar.gz`, sha256: "d5ce120515bf3013a014e6a918aa87ec0f7a6f5f9687c48d50127e637cb9b6c2" },
  "linux-x64": { name: `dugite-native-${PORTABLE_GIT_BUILD}-ubuntu-x64.tar.gz`, sha256: "1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9" },
  "linux-arm": { name: `dugite-native-${PORTABLE_GIT_BUILD}-ubuntu-arm.tar.gz`, sha256: "7a14edae189f791e64f8d037c8e3830acd648cd1ad891db40c8d6469d33b36cd" },
}

export function portableGitAsset(platform: string, arch: string): PortableGitAsset | null {
  return PORTABLE_GIT_ASSETS[`${platform}-${arch}`] ?? null
}

export function portableGitAssetUrl(asset: PortableGitAsset): string {
  return `https://github.com/desktop/dugite-native/releases/download/${PORTABLE_GIT_RELEASE}/${asset.name}`
}

export function portableGitToolsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".ouro-cli", "tools")
}

/** The stable path: a symlink to the installed release directory. */
export function portableGitRoot(homeDir: string = os.homedir()): string {
  return path.join(portableGitToolsDir(homeDir), "git")
}

export function portableGitBinary(homeDir: string = os.homedir()): string {
  return path.join(portableGitRoot(homeDir), "bin", "git")
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** The first `git` on a PATH value, or null. */
export function findGitOnPath(pathValue: string | undefined, isExecutable: (filePath: string) => boolean = isExecutableFile): string | null {
  for (const dir of (pathValue ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, "git")
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * What a dugite-native git needs to find its helpers, templates and CA bundle
 * when it runs from an arbitrary directory (dugite's own wrapper sets the
 * same). `PREFIX` is left out: npm reads it too.
 */
export function portableGitEnv(root: string, exists: (filePath: string) => boolean = fs.existsSync): Record<string, string> {
  const env: Record<string, string> = {
    GIT_EXEC_PATH: path.join(root, "libexec", "git-core"),
    GIT_TEMPLATE_DIR: path.join(root, "share", "git-core", "templates"),
  }
  const caBundle = path.join(root, "ssl", "cacert.pem")
  if (exists(caBundle)) env.GIT_SSL_CAINFO = caBundle
  return env
}

const HTTPS_HELPER = "git-remote-https"

export interface GitHelperPathDeps {
  /** git's own exec path, as `git --exec-path` reports it. */
  execPath?: (gitBinary: string, env: NodeJS.ProcessEnv) => string | null
  exists?: (filePath: string) => boolean
}

function defaultGitExecPath(gitBinary: string, env: NodeJS.ProcessEnv): string | null {
  const childEnv: NodeJS.ProcessEnv = { ...env }
  delete childEnv.GIT_EXEC_PATH
  const run = spawnSync(gitBinary, ["--exec-path"], { env: childEnv, encoding: "utf8" })
  return run.status === 0 ? run.stdout.trim() : null
}

/**
 * Point GIT_EXEC_PATH at the libexec beside `gitBinary` when git cannot find
 * its https helper where it looks. The Copilot app's bundled git on a Mac is
 * relocated: its own exec path is `//libexec/git-core`, so a process started
 * without the app's GIT_EXEC_PATH (the Ouro daemon) fails every fetch and push
 * with "'remote-https' is not a git command". Returns true when it set the path.
 */
export function pinGitHelperPath(gitBinary: string, env: NodeJS.ProcessEnv, deps: GitHelperPathDeps = {}): boolean {
  if (env.GIT_EXEC_PATH !== undefined) return false
  const exists = deps.exists ?? fs.existsSync
  const libexec = path.join(path.dirname(path.dirname(gitBinary)), "libexec", "git-core")
  if (!exists(path.join(libexec, HTTPS_HELPER))) return false
  const ownExecPath = (deps.execPath ?? defaultGitExecPath)(gitBinary, env)
  if (ownExecPath && exists(path.join(ownExecPath, HTTPS_HELPER))) return false
  env.GIT_EXEC_PATH = libexec
  return true
}

export type PortableGitActivation =
  | { status: "absent" }
  | { status: "system"; git: string }
  | { status: "activated"; binDir: string }

export interface PortableGitActivationOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  isExecutable?: (filePath: string) => boolean
}

/**
 * Put the portable git's bin directory first on PATH when it is installed and
 * the host has no git, so every `git` this process or its children run (bundle
 * sync, clone, the agent's own shell) finds it. Hosts without a portable git
 * pay one failed access check.
 */
export function activatePortableGit(options: PortableGitActivationOptions = {}): PortableGitActivation {
  const env = options.env ?? process.env
  const isExecutable = options.isExecutable ?? isExecutableFile
  const binary = portableGitBinary(options.homeDir)
  if (!isExecutable(binary)) {
    const hostGit = findGitOnPath(env.PATH, isExecutable)
    if (hostGit) pinGitHelperPath(hostGit, env)
    return { status: "absent" }
  }
  const binDir = path.dirname(binary)
  const systemGit = findGitOnPath(env.PATH, isExecutable)
  if (systemGit === binary) return { status: "activated", binDir }
  if (systemGit) {
    pinGitHelperPath(systemGit, env)
    return { status: "system", git: systemGit }
  }
  env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir
  for (const [key, value] of Object.entries(portableGitEnv(path.dirname(binDir)))) {
    if (env[key] === undefined) env[key] = value
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.portable_git_activated",
    message: "the host has no git; using the portable git",
    meta: { binDir },
  })
  return { status: "activated", binDir }
}
