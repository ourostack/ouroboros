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
  envPath?: string
  shell?: string
}

const CLI_PACKAGE_SPECIFIER = "@ouro.bot/cli@alpha"

const WRAPPER_SCRIPT = `#!/bin/sh
exec npx --yes ${CLI_PACKAGE_SPECIFIER} "$@"
`

function detectShellProfile(homeDir: string, shell: string | undefined): string | null {
  if (!shell) return null
  const base = path.basename(shell)
  if (base === "zsh") return path.join(homeDir, ".zshrc")
  if (base === "bash") {
    // macOS uses .bash_profile, Linux uses .bashrc
    const profilePath = path.join(homeDir, ".bash_profile")
    return profilePath
  }
  if (base === "fish") return path.join(homeDir, ".config", "fish", "config.fish")
  return null
}

function isBinDirInPath(binDir: string, envPath: string): boolean {
  return envPath.split(path.delimiter).some((p) => p === binDir)
}

function buildPathExportLine(binDir: string, shell: string | undefined): string {
  const base = shell ? path.basename(shell) : /* v8 ignore next -- unreachable: only called when detectShellProfile returns non-null, which requires shell @preserve */ ""
  if (base === "fish") {
    return `\n# Added by ouro\nset -gx PATH ${binDir} $PATH\n`
  }
  return `\n# Added by ouro\nexport PATH="${binDir}:$PATH"\n`
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
    return { installed: false, scriptPath: null, pathReady: false, shellProfileUpdated: null, skippedReason: "windows" }
  }

  const binDir = path.join(homeDir, ".local", "bin")
  const scriptPath = path.join(binDir, "ouro")

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_install_start",
    message: "installing ouro command to PATH",
    meta: { scriptPath, binDir },
  })

  // If ouro already exists, check content and repair if stale
  if (existsSync(scriptPath)) {
    let existingContent = ""
    try {
      existingContent = readFileSync(scriptPath, "utf-8")
    } catch {
      // Can't read — treat as stale, will overwrite below
    }

    if (existingContent === WRAPPER_SCRIPT) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.ouro_path_install_skip",
        message: "ouro command already installed",
        meta: { scriptPath },
      })
      return { installed: false, scriptPath, pathReady: isBinDirInPath(binDir, envPath), shellProfileUpdated: null, skippedReason: "already-installed" }
    }

    // Content is stale — repair by overwriting
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_path_install_repair",
      message: "repairing stale ouro wrapper script",
      meta: { scriptPath },
    })
  }

  try {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(scriptPath, WRAPPER_SCRIPT, { mode: 0o755 })
    chmodSync(scriptPath, 0o755)
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.ouro_path_install_error",
      message: "failed to install ouro command",
      meta: { error: error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error) },
    })
    return { installed: false, scriptPath: null, pathReady: false, shellProfileUpdated: null, skippedReason: error instanceof Error ? error.message : /* v8 ignore next -- defensive @preserve */ String(error) }
  }

  // Check if ~/.local/bin is already in PATH
  let shellProfileUpdated: string | null = null
  const pathReady = isBinDirInPath(binDir, envPath)

  if (!pathReady) {
    const profilePath = detectShellProfile(homeDir, shell)
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

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_install_end",
    message: "ouro command installed",
    meta: { scriptPath, pathReady, shellProfileUpdated },
  })

  return { installed: true, scriptPath, pathReady, shellProfileUpdated }
}
