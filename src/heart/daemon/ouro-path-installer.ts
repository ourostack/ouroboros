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
  migratedFromOldPath: boolean
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
  unlinkSync?: (p: string) => void
  rmdirSync?: (p: string) => void
  readdirSync?: (p: string) => string[]
  ensureCliLayout?: () => void
  envPath?: string
  shell?: string
}

const WRAPPER_SCRIPT = `#!/bin/sh
ENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
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

/**
 * Remove lines matching the old ouro PATH block from shell profile content.
 * Returns the cleaned content.
 */
function removeOldPathBlock(content: string, oldBinDir: string): string {
  const lines = content.split("\n")
  const result: string[] = []
  let i = 0
  while (i < lines.length) {
    // Detect "# Added by ouro" followed by a PATH export containing the old binDir
    if (lines[i].trim() === "# Added by ouro" && i + 1 < lines.length && lines[i + 1].includes(oldBinDir)) {
      // Skip both lines (comment + export)
      i += 2
      // Also skip trailing blank line if present
      /* v8 ignore next -- edge: trailing blank line presence varies @preserve */
      if (i < lines.length && lines[i].trim() === "") i++
      continue
    }
    result.push(lines[i])
    i++
  }
  return result.join("\n")
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
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync
  const rmdirSync = deps.rmdirSync ?? fs.rmdirSync
  const readdirSync = deps.readdirSync ?? ((p: string) => fs.readdirSync(p).map(String))
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
    return { installed: false, scriptPath: null, pathReady: false, shellProfileUpdated: null, skippedReason: "windows", migratedFromOldPath: false }
  }

  // Ensure ~/.ouro-cli/ directory layout exists
  if (deps.ensureCliLayout) {
    deps.ensureCliLayout()
  }

  const binDir = path.join(homeDir, ".ouro-cli", "bin")
  const scriptPath = path.join(binDir, "ouro")

  // ── Migration from old ~/.local/bin/ouro ──
  const oldBinDir = path.join(homeDir, ".local", "bin")
  const oldScriptPath = path.join(oldBinDir, "ouro")
  let migratedFromOldPath = false

  if (existsSync(oldScriptPath)) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_path_migrate_start",
      message: "migrating ouro from old PATH location",
      meta: { oldScriptPath },
    })

    try {
      unlinkSync(oldScriptPath)
      migratedFromOldPath = true

      // Remove empty ~/.local/bin/ directory
      if (existsSync(oldBinDir)) {
        try {
          const remaining = readdirSync(oldBinDir)
          if (remaining.length === 0) {
            rmdirSync(oldBinDir)
          }
        } catch {
          // Best effort cleanup
        }
      }
    } catch {
      // Best effort migration — continue with new install
    }

    // Remove old PATH entry from shell profile
    const profilePath = detectShellProfile(homeDir, shell)
    /* v8 ignore start -- profile cleanup: only fires during migration from old layout @preserve */
    if (profilePath) {
      try {
        const profileContent = readFileSync(profilePath, "utf-8")
        if (profileContent.includes(oldBinDir)) {
          const cleaned = removeOldPathBlock(profileContent, oldBinDir)
          writeFileSync(profilePath, cleaned)
        }
      } catch {
        // Best effort profile cleanup
      }
    }
    /* v8 ignore stop */
  }

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
      return { installed: false, scriptPath, pathReady: isBinDirInPath(binDir, envPath), shellProfileUpdated: null, skippedReason: "already-installed", migratedFromOldPath }
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
    return { installed: false, scriptPath: null, pathReady: false, shellProfileUpdated: null, skippedReason: error instanceof Error ? error.message : /* v8 ignore next -- defensive @preserve */ String(error), migratedFromOldPath }
  }

  // Check if ~/.ouro-cli/bin is already in PATH
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

  return { installed: true, scriptPath, pathReady, shellProfileUpdated, migratedFromOldPath }
}
