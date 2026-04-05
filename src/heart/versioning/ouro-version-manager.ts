import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface OuroVersionManagerDeps {
  homeDir?: string
  readlinkSync?: (p: string) => string
  unlinkSync?: (p: string) => void
  symlinkSync?: (target: string, p: string) => void
  existsSync?: (p: string) => boolean
  mkdirSync?: (p: string, options?: fs.MakeDirectoryOptions) => void
  readdirSync?: (p: string, options: { withFileTypes: true }) => fs.Dirent[]
  execSync?: (command: string, options?: { stdio?: string }) => unknown
}

export function getOuroCliHome(homeDir?: string): string {
  /* v8 ignore next -- dep default: tests always inject @preserve */
  const home = homeDir ?? os.homedir()
  return path.join(home, ".ouro-cli")
}

export function getCurrentVersion(deps: Pick<OuroVersionManagerDeps, "homeDir" | "readlinkSync">): string | null {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore next -- dep default: tests always inject @preserve */
  const readlinkSync = deps.readlinkSync ?? fs.readlinkSync
  try {
    const target = readlinkSync(path.join(cliHome, "CurrentVersion"))
    return path.basename(target)
  } catch {
    return null
  }
}

export function getPreviousVersion(deps: Pick<OuroVersionManagerDeps, "homeDir" | "readlinkSync">): string | null {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore next -- dep default: tests always inject @preserve */
  const readlinkSync = deps.readlinkSync ?? fs.readlinkSync
  try {
    const target = readlinkSync(path.join(cliHome, "previous"))
    return path.basename(target)
  } catch {
    return null
  }
}

export function buildChangelogCommand(previousVersion: string | null, currentVersion: string | null): string | null {
  if (!previousVersion || !currentVersion || previousVersion === currentVersion) {
    return null
  }
  return `ouro changelog --from ${previousVersion}`
}

export function listInstalledVersions(deps: Pick<OuroVersionManagerDeps, "homeDir" | "readdirSync">): string[] {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore next -- dep default: tests always inject @preserve */
  const readdirSync = deps.readdirSync ?? ((p: string, opts: { withFileTypes: true }) => fs.readdirSync(p, opts))
  try {
    const entries = readdirSync(path.join(cliHome, "versions"), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export function installVersion(version: string, deps: Pick<OuroVersionManagerDeps, "homeDir" | "mkdirSync" | "execSync">): void {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore start -- dep defaults: tests always inject @preserve */
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  const execSync = deps.execSync ?? ((cmd: string, opts?: { stdio?: string }) => require("child_process").execSync(cmd, opts))
  /* v8 ignore stop */
  const versionDir = path.join(cliHome, "versions", version)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_version_install_start",
    message: "installing CLI version",
    meta: { version, versionDir },
  })

  mkdirSync(versionDir, { recursive: true })
  execSync(`npm install --prefix ${versionDir} @ouro.bot/cli@${version}`, { stdio: "pipe" })

  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_version_install_end",
    message: "CLI version installed",
    meta: { version, versionDir },
  })
}

export function activateVersion(version: string, deps: Pick<OuroVersionManagerDeps, "homeDir" | "readlinkSync" | "unlinkSync" | "symlinkSync" | "existsSync">): void {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore start -- dep defaults: tests always inject @preserve */
  const readlinkSync = deps.readlinkSync ?? fs.readlinkSync
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync
  const symlinkSync = deps.symlinkSync ?? fs.symlinkSync
  const existsSync = deps.existsSync ?? fs.existsSync
  /* v8 ignore stop */
  const currentVersionPath = path.join(cliHome, "CurrentVersion")
  const previousPath = path.join(cliHome, "previous")
  const newTarget = path.join(cliHome, "versions", version)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_version_activate",
    message: "activating CLI version",
    meta: { version },
  })

  // Read old CurrentVersion target (may not exist)
  let oldTarget: string | null = null
  try {
    oldTarget = readlinkSync(currentVersionPath)
  } catch {
    // No current version — first install
  }

  // Update previous symlink to point to old current
  if (oldTarget) {
    try {
      unlinkSync(previousPath)
    } catch {
      // previous symlink may not exist yet
    }
    symlinkSync(oldTarget, previousPath)
  }

  // Update CurrentVersion symlink
  if (existsSync(currentVersionPath)) {
    unlinkSync(currentVersionPath)
  }
  symlinkSync(newTarget, currentVersionPath)
}

export function ensureLayout(deps: Pick<OuroVersionManagerDeps, "homeDir" | "mkdirSync">): void {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore next -- dep default: tests always inject @preserve */
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync

  mkdirSync(cliHome, { recursive: true })
  mkdirSync(path.join(cliHome, "bin"), { recursive: true })
  mkdirSync(path.join(cliHome, "versions"), { recursive: true })

  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_layout_ensured",
    message: "CLI directory layout ensured",
    meta: { cliHome },
  })
}
