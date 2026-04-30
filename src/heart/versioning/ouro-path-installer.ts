import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface OuroPathInstallResult {
  installed: boolean
  scriptPath: string | null
  pathReady: boolean
  shellProfileUpdated: string | null
  skippedReason?: string
  repairedOldLauncher: boolean
  repairedShadowedLauncherPath?: string | null
  pathResolution?: OuroPathResolution
}

export interface OuroPathResolution {
  status: "ok" | "missing" | "shadowed"
  expectedPath: string
  resolvedPath: string | null
  detail: string
  remediation: string | null
}

export interface OuroPathInstallerDeps {
  homeDir?: string
  platform?: NodeJS.Platform
  existsSync?: (p: string) => boolean
  mkdirSync?: (p: string, options?: fs.MakeDirectoryOptions) => void
  writeFileSync?: (p: string, data: string, options?: fs.WriteFileOptions) => void
  readFileSync?: (p: string, encoding: BufferEncoding) => string
  appendFileSync?: (p: string, data: string) => void
  chmodSync?: (p: string, mode: fs.Mode) => void
  realpathSync?: (p: string) => string
  lstatSync?: (p: string) => Pick<fs.Stats, "isSymbolicLink">
  unlinkSync?: (p: string) => void
  ensureCliLayout?: () => void
  envPath?: string
  shell?: string
}

const WRAPPER_SCRIPT = `#!/bin/sh
# Check for dev mode — if dev-config.json exists, dispatch to the dev repo
# Skip dev dispatch for "up" command (explicitly returns to production)
DEV_CONFIG="$HOME/.ouro-cli/dev-config.json"
if [ -f "$DEV_CONFIG" ] && [ "$1" != "up" ]; then
  DEV_REPO=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DEV_CONFIG','utf-8')).repoPath)}catch{}" 2>/dev/null)
  DEV_ENTRY="$DEV_REPO/dist/heart/daemon/ouro-entry.js"
  if [ -n "$DEV_REPO" ] && [ -e "$DEV_ENTRY" ]; then
    exec node "$DEV_ENTRY" "$@"
  fi
fi
# Fall back to installed version
ENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot@alpha" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`

function writeWrapperScript(
  scriptPath: string,
  mkdirSync: NonNullable<OuroPathInstallerDeps["mkdirSync"]>,
  writeFileSync: NonNullable<OuroPathInstallerDeps["writeFileSync"]>,
  chmodSync: NonNullable<OuroPathInstallerDeps["chmodSync"]>,
): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, WRAPPER_SCRIPT, { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
}

function detectShellProfile(homeDir: string, shell: string | undefined, platform?: string): string | null {
  if (!shell) return null
  const base = path.basename(shell)
  if (base === "zsh") return path.join(homeDir, ".zshrc")
  if (base === "bash") {
    // macOS uses .bash_profile; Linux/WSL uses .bashrc (the default
    // interactive shell config on Debian/Ubuntu). Writing to .bash_profile
    // on Linux often has no effect because non-login shells skip it.
    /* v8 ignore next -- ?? fallback: callers always pass platform from deps @preserve */
    const effectivePlatform = platform ?? process.platform
    return effectivePlatform === "darwin"
      ? path.join(homeDir, ".bash_profile")
      : path.join(homeDir, ".bashrc")
  }
  if (base === "fish") return path.join(homeDir, ".config", "fish", "config.fish")
  return null
}

function isBinDirInPath(binDir: string, envPath: string): boolean {
  return envPath.split(path.delimiter).some((p) => p === binDir)
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

function buildPathExportLine(binDir: string, shell: string | undefined): string {
  const base = shell ? path.basename(shell) : /* v8 ignore next -- unreachable: only called when detectShellProfile returns non-null, which requires shell @preserve */ ""
  if (base === "fish") {
    return `\n# Added by ouro\nset -gx PATH ${binDir} $PATH\n`
  }
  return `\n# Added by ouro\nexport PATH="${binDir}:$PATH"\n`
}

function isWrapperCurrent(
  scriptPath: string,
  existsSync: (p: string) => boolean,
  readFileSync: (p: string, encoding: BufferEncoding) => string,
): boolean {
  if (!existsSync(scriptPath)) return false
  try {
    return readFileSync(scriptPath, "utf-8") === WRAPPER_SCRIPT
  } catch {
    return false
  }
}

function isOwnedOuroLauncherPath(resolvedPath: string): boolean {
  const normalized = path.normalize(resolvedPath)
  return (
    normalized.includes(`${path.sep}node_modules${path.sep}@ouro.bot${path.sep}cli${path.sep}`) ||
    normalized.includes(`${path.sep}node_modules${path.sep}ouro.bot${path.sep}`)
  )
}

function isOwnedOuroLauncherContent(content: string): boolean {
  return (
    content.includes("@ouro.bot/cli") ||
    content.includes("ouro.bot@latest") ||
    content.includes("ouro.bot@alpha") ||
    content.includes('exec npx --yes ouro.bot "$@"') ||
    content.includes("CurrentVersion/node_modules/@ouro.bot/cli")
  )
}

function canRepairShadowedLauncher(
  shadowPath: string,
  existsSync: (p: string) => boolean,
  readFileSync: (p: string, encoding: BufferEncoding) => string,
  realpathSync: (p: string) => string,
): boolean {
  if (!existsSync(shadowPath)) return false
  try {
    if (isOwnedOuroLauncherPath(realpathSync(shadowPath))) return true
  } catch {
    // Fall through to content detection below.
  }
  try {
    return isOwnedOuroLauncherContent(readFileSync(shadowPath, "utf-8"))
  } catch {
    return false
  }
}

function repairShadowedLauncher(input: {
  shadowPath: string
  existsSync: (p: string) => boolean
  readFileSync: (p: string, encoding: BufferEncoding) => string
  writeFileSync: NonNullable<OuroPathInstallerDeps["writeFileSync"]>
  chmodSync: NonNullable<OuroPathInstallerDeps["chmodSync"]>
  realpathSync: (p: string) => string
  lstatSync: (p: string) => Pick<fs.Stats, "isSymbolicLink">
  unlinkSync: (p: string) => void
}): string | null {
  if (!canRepairShadowedLauncher(input.shadowPath, input.existsSync, input.readFileSync, input.realpathSync)) {
    return null
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_shadow_repair_start",
    message: "repairing stale shadowed ouro launcher",
    meta: { shadowPath: input.shadowPath },
  })
  try {
    if (input.lstatSync(input.shadowPath).isSymbolicLink()) {
      input.unlinkSync(input.shadowPath)
    }
    input.writeFileSync(input.shadowPath, WRAPPER_SCRIPT, { mode: 0o755 })
    input.chmodSync(input.shadowPath, 0o755)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_path_shadow_repair_end",
      message: "repaired stale shadowed ouro launcher",
      meta: { shadowPath: input.shadowPath },
    })
    return input.shadowPath
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_path_shadow_repair_error",
      message: "failed to repair stale shadowed ouro launcher",
      meta: {
        shadowPath: input.shadowPath,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return null
  }
}

function firstOuroOnPath(envPath: string, existsSync: (p: string) => boolean): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, "ouro")
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function diagnoseOuroPath(deps: {
  homeDir: string
  envPath: string
  existsSync: (p: string) => boolean
  readFileSync: (p: string, encoding: BufferEncoding) => string
}): OuroPathResolution {
  const binDir = path.join(deps.homeDir, ".ouro-cli", "bin")
  const expectedPath = path.join(binDir, "ouro")
  const resolvedPath = firstOuroOnPath(deps.envPath, deps.existsSync)

  if (!resolvedPath) {
    return {
      status: "missing",
      expectedPath,
      resolvedPath: null,
      detail: `PATH does not resolve ouro; expected ${expectedPath}`,
      remediation: `add ${binDir} to PATH or open a new shell after ouro up updates your shell profile`,
    }
  }

  if (samePath(resolvedPath, expectedPath)) {
    return {
      status: "ok",
      expectedPath,
      resolvedPath,
      detail: `PATH resolves ouro to ${expectedPath}`,
      remediation: null,
    }
  }

  if (isWrapperCurrent(resolvedPath, deps.existsSync, deps.readFileSync)) {
    return {
      status: "ok",
      expectedPath,
      resolvedPath,
      detail: `PATH resolves ouro through a compatible wrapper at ${resolvedPath}`,
      remediation: null,
    }
  }

  const shadowDir = path.dirname(resolvedPath)
  return {
    status: "shadowed",
    expectedPath,
    resolvedPath,
    detail: `PATH resolves ouro to ${resolvedPath} before ${expectedPath}`,
    remediation: `move ${binDir} before ${shadowDir} in PATH, or remove/replace ${resolvedPath} after confirming it is the stale ouro launcher`,
  }
}

export function installOuroCommand(deps: OuroPathInstallerDeps = {}): OuroPathInstallResult {
  /* v8 ignore start -- dep defaults: only used in real runtime, tests always inject @preserve */
  const platform = deps.platform ?? process.platform
  const homeDir = deps.homeDir ?? os.homedir()
  const existsSync = deps.existsSync ?? fs.existsSync
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync
  const readFileSync = deps.readFileSync ?? ((p: string, enc: BufferEncoding) => fs.readFileSync(p, enc))
  const appendFileSync = deps.appendFileSync ?? fs.appendFileSync
  const chmodSync = deps.chmodSync ?? fs.chmodSync
  const realpathSync = deps.realpathSync ?? fs.realpathSync
  const lstatSync = deps.lstatSync ?? fs.lstatSync
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync
  const envPath = deps.envPath ?? process.env.PATH ?? ""
  const shell = deps.shell ?? process.env.SHELL
  /* v8 ignore stop */

  if (platform === "win32") {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_path_install_skip",
      message: "skipped ouro PATH install on Windows",
      meta: { platform },
    })
    return { installed: false, scriptPath: null, pathReady: false, shellProfileUpdated: null, skippedReason: "windows", repairedOldLauncher: false }
  }

  // Ensure ~/.ouro-cli/ directory layout exists
  if (deps.ensureCliLayout) {
    deps.ensureCliLayout()
  }

  const binDir = path.join(homeDir, ".ouro-cli", "bin")
  const scriptPath = path.join(binDir, "ouro")
  const oldScriptPath = path.join(homeDir, ".local", "bin", "ouro")

  const resolvePath = (): OuroPathResolution => diagnoseOuroPath({ homeDir, envPath, existsSync, readFileSync })

  const modernCurrent = isWrapperCurrent(scriptPath, existsSync, readFileSync)
  const oldExists = existsSync(oldScriptPath)
  const oldCurrent = oldExists && isWrapperCurrent(oldScriptPath, existsSync, readFileSync)

  // ── Repair old ~/.local/bin/ouro launcher ──
  // If the old launcher exists with stale content it can shadow the modern
  // path and cause the wrong CLI version to run.  Overwrite it with the
  // current wrapper so both paths resolve to ~/.ouro-cli/CurrentVersion.
  let repairedOldLauncher = false
  if (oldExists && !oldCurrent) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_path_repair_old",
      message: "repairing stale old launcher at ~/.local/bin/ouro",
      meta: { oldScriptPath },
    })
    try {
      writeFileSync(oldScriptPath, WRAPPER_SCRIPT, { mode: 0o755 })
      chmodSync(oldScriptPath, 0o755)
      repairedOldLauncher = true
    } catch {
      // Best effort — old launcher repair failure must not block modern install
    }
  }

  // ── Fast-path: modern wrapper already current ──
  if (modernCurrent) {
    let pathResolution = resolvePath()
    const repairedShadowedLauncherPath = pathResolution.status === "shadowed" && pathResolution.resolvedPath
      ? repairShadowedLauncher({
          shadowPath: pathResolution.resolvedPath,
          existsSync,
          readFileSync,
          writeFileSync,
          chmodSync,
          realpathSync,
          lstatSync,
          unlinkSync,
        })
      : null
    if (repairedShadowedLauncherPath) {
      pathResolution = resolvePath()
    }
    if (pathResolution.status === "shadowed") {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.ouro_path_shadowed",
        message: "PATH resolves ouro to a stale external launcher",
        meta: { resolvedPath: pathResolution.resolvedPath, expectedPath: pathResolution.expectedPath, remediation: pathResolution.remediation },
      })
    }
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_path_install_skip",
      message: "ouro command already installed",
      meta: { scriptPath, pathStatus: pathResolution.status, resolvedPath: pathResolution.resolvedPath },
    })
    return {
      installed: false,
      scriptPath,
      pathReady: isBinDirInPath(binDir, envPath),
      shellProfileUpdated: null,
      skippedReason: "already-installed",
      repairedOldLauncher,
      repairedShadowedLauncherPath,
      pathResolution,
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_install_start",
    message: existsSync(scriptPath) ? "repairing stale ouro wrapper script" : "installing ouro command to PATH",
    meta: { scriptPath, binDir },
  })


  try {
    if (!modernCurrent) {
      writeWrapperScript(scriptPath, mkdirSync, writeFileSync, chmodSync)
    }
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_path_install_error",
      message: "failed to install ouro command",
      meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
    })
    return { installed: false, scriptPath: null, pathReady: false, shellProfileUpdated: null, skippedReason: error instanceof Error ? error.message : /* v8 ignore next -- defensive @preserve */ String(error), repairedOldLauncher }
  }

  // Check if ~/.ouro-cli/bin is already in PATH
  const pathReady = isBinDirInPath(binDir, envPath)
  let shellProfileUpdated: string | null = null

  if (!pathReady) {
    const profilePath = detectShellProfile(homeDir, shell, platform)
    if (profilePath) {
      try {
        let existing = ""
        try {
          existing = readFileSync(profilePath, "utf-8")
        } catch {
          // Profile doesn't exist yet — that's fine, we'll create it
        }
        if (!existing.includes(binDir)) {
          appendFileSync(profilePath, buildPathExportLine(binDir, shell))
          shellProfileUpdated = profilePath
        }
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.ouro_path_profile_error",
          message: "failed to update shell profile for PATH",
          meta: { profilePath, error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
        })
      }
    }
  }

  let pathResolution = resolvePath()
  const repairedShadowedLauncherPath = pathResolution.status === "shadowed" && pathResolution.resolvedPath
    ? repairShadowedLauncher({
        shadowPath: pathResolution.resolvedPath,
        existsSync,
        readFileSync,
        writeFileSync,
        chmodSync,
        realpathSync,
        lstatSync,
        unlinkSync,
      })
    : null
  if (repairedShadowedLauncherPath) {
    pathResolution = resolvePath()
  }
  if (pathResolution.status === "shadowed") {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_path_shadowed",
      message: "PATH resolves ouro to a stale external launcher",
      meta: { resolvedPath: pathResolution.resolvedPath, expectedPath: pathResolution.expectedPath, remediation: pathResolution.remediation },
    })
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_install_end",
    message: "ouro command installed",
    meta: {
      scriptPath,
      pathReady,
      shellProfileUpdated,
      oldScriptPath: oldExists ? oldScriptPath : null,
      repairedShadowedLauncherPath,
      pathStatus: pathResolution.status,
      resolvedPath: pathResolution.resolvedPath,
    },
  })

  return {
    installed: true,
    scriptPath,
    pathReady,
    shellProfileUpdated,
    repairedOldLauncher,
    repairedShadowedLauncherPath,
    pathResolution,
  }
}
