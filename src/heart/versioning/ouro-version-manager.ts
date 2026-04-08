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
  rmSync?: (p: string, options?: fs.RmOptions) => void
  execSync?: (command: string, options?: { stdio?: string }) => unknown
}

/** Maximum number of installed CLI versions to retain after pruning. */
export const DEFAULT_RETAIN_VERSIONS = 5

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

/**
 * Compare two version strings of the form `0.1.0-alpha.{n}`. Returns
 * positive when `a` is newer, negative when `b` is newer, 0 when equal.
 *
 * The harness only ships `0.1.0-alpha.{n}` versions today; this comparator
 * extracts the numeric tail and falls back to a lexicographic compare for
 * any version that doesn't match the pattern (so unexpected version
 * formats sort consistently rather than throwing).
 */
export function compareCliVersions(a: string, b: string): number {
  const aMatch = /alpha\.(\d+)/.exec(a)
  const bMatch = /alpha\.(\d+)/.exec(b)
  if (aMatch && bMatch) {
    const aN = parseInt(aMatch[1]!, 10)
    const bN = parseInt(bMatch[1]!, 10)
    return aN - bN
  }
  // Fallback: lexicographic. Both-mismatched and one-mismatched cases land
  // here. Predictable, even if not strictly semver-correct.
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Identify which installed CLI versions can be safely deleted, given a
 * retention policy. Pure: takes the full version list and the protected
 * (current/previous) versions, returns the versions to delete.
 *
 * Retention rules:
 *   - Always keep the N most recent versions (default 5).
 *   - Always keep the currently-active version (CurrentVersion symlink target).
 *   - Always keep the previous version (previous symlink target) so rollback
 *     stays one command away.
 *   - Delete everything else.
 *
 * Exported so tests can pin the policy without shelling out to a real fs.
 */
export function selectVersionsToPrune(
  installedVersions: string[],
  protectedVersions: { current: string | null; previous: string | null },
  retain: number = DEFAULT_RETAIN_VERSIONS,
): string[] {
  if (installedVersions.length <= retain) return []

  const sorted = [...installedVersions].sort(compareCliVersions).reverse()
  const keepers = new Set<string>(sorted.slice(0, retain))
  if (protectedVersions.current) keepers.add(protectedVersions.current)
  if (protectedVersions.previous) keepers.add(protectedVersions.previous)

  return installedVersions.filter((v) => !keepers.has(v))
}

/**
 * Prune installed CLI versions according to the retention policy. Removes
 * `~/.ouro-cli/versions/{version}/` directories for versions outside the
 * retention window. Best-effort: per-version delete failures are logged
 * via nerves but don't propagate.
 *
 * Called from the activate path (cli-defaults.ts) so that every successful
 * `ouro up` self-prunes. The user observed `~/.ouro-cli/versions/` going
 * back to alpha.85 from March 20 — every CLI version they'd ever installed
 * was still on disk because nothing ever GCed.
 */
export function pruneOldVersions(
  retain: number = DEFAULT_RETAIN_VERSIONS,
  deps: Pick<OuroVersionManagerDeps, "homeDir" | "readdirSync" | "readlinkSync" | "rmSync"> = {},
): { kept: string[]; deleted: string[]; failed: Array<{ version: string; error: string }> } {
  const cliHome = getOuroCliHome(deps.homeDir)
  /* v8 ignore start -- dep defaults: tests always inject @preserve */
  const readdirSync = deps.readdirSync ?? ((p: string, opts: { withFileTypes: true }) => fs.readdirSync(p, opts))
  const readlinkSync = deps.readlinkSync ?? fs.readlinkSync
  const rmSync = deps.rmSync ?? fs.rmSync
  /* v8 ignore stop */

  const versionsDir = path.join(cliHome, "versions")
  let installed: string[]
  try {
    installed = readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { kept: [], deleted: [], failed: [] }
  }

  const current = (() => {
    try { return path.basename(readlinkSync(path.join(cliHome, "CurrentVersion"))) } catch { return null }
  })()
  const previous = (() => {
    try { return path.basename(readlinkSync(path.join(cliHome, "previous"))) } catch { return null }
  })()

  const toDelete = selectVersionsToPrune(installed, { current, previous }, retain)
  const deleted: string[] = []
  const failed: Array<{ version: string; error: string }> = []

  for (const version of toDelete) {
    const versionDir = path.join(versionsDir, version)
    try {
      rmSync(versionDir, { recursive: true, force: true })
      deleted.push(version)
    } catch (error) {
      failed.push({
        version,
        error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error),
      })
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_versions_pruned",
    message: `pruned ${deleted.length} old CLI versions`,
    meta: { retain, deleted, failed: failed.length, kept: installed.filter((v) => !deleted.includes(v)) },
  })

  return { kept: installed.filter((v) => !deleted.includes(v)), deleted, failed }
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
