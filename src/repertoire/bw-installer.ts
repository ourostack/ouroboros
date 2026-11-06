/**
 * Lazy bw CLI installer — auto-installs the Bitwarden CLI when not present.
 *
 * Mirrors the whisper-cpp pattern in senses/bluebubbles/media.ts:
 * check PATH first, install via npm if missing, emit nerves event.
 */

import { execFile as execFileCb } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

const INSTALL_TIMEOUT_MS = 120_000
const WHICH_TIMEOUT_MS = 5_000
const DEFAULT_WINDOWS_PATHEXT = ".EXE;.CMD;.BAT;.COM"

function execFileAsync(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { timeout }, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isExecutableFile(targetPath: string, platform: NodeJS.Platform): boolean {
  try {
    fs.accessSync(targetPath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function executableNames(
  command: string,
  platform: NodeJS.Platform,
  pathExt: string,
): string[] {
  if (platform !== "win32") return [command]
  if (path.extname(command)) return [command]

  const extensions = pathExt
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  return extensions.length === 0
    ? [command]
    : extensions.map((extension) => (
      extension.startsWith(".") ? `${command}${extension}` : `${command}.${extension}`
    ))
}

function findExecutableInDirectory(
  command: string,
  directory: string,
  platform: NodeJS.Platform,
  pathExt: string,
): string | null {
  const cleanDirectory = stripWrappingQuotes(directory)
  if (!cleanDirectory) return null

  for (const candidateName of executableNames(command, platform, pathExt)) {
    const candidatePath = path.isAbsolute(candidateName)
      ? candidateName
      : path.join(cleanDirectory, candidateName)
    if (isExecutableFile(candidatePath, platform)) {
      return candidatePath
    }
  }

  return null
}

export function findExecutableOnPath(
  command: string,
  envPath = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT,
): string | null {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return isExecutableFile(command, platform) ? command : null
  }

  for (const directory of envPath.split(path.delimiter)) {
    const found = findExecutableInDirectory(command, directory, platform, pathExt)
    if (found) return found
  }

  return null
}

export async function findExecutableViaNpmPrefix(
  command: string,
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT,
): Promise<string | null> {
  try {
    const prefix = stripWrappingQuotes((await execFileAsync("npm", ["prefix", "-g"], WHICH_TIMEOUT_MS)).trim())
    if (!prefix) return null

    const searchDirs = platform === "win32"
      ? [prefix, path.join(prefix, "bin")]
      : [path.join(prefix, "bin"), prefix]

    for (const directory of searchDirs) {
      const found = findExecutableInDirectory(
        command,
        directory,
        platform,
        pathExt,
      )
      if (found) return found
    }
  } catch {
    // Prefix lookup is only a post-install fallback.
  }

  return null
}

/**
 * Ensure the `bw` CLI is available, installing it via npm if needed.
 * Returns the path to the `bw` binary.
 */
export async function ensureBwCli(): Promise<string> {
  // 1. Check if bw is already in PATH
  const existing = findExecutableOnPath("bw")
  if (existing) {
    return existing
  }

  // 2. Install via npm
  emitNervesEvent({
    event: "repertoire.bw_cli_install_start",
    component: "repertoire",
    message: "bw CLI not found, installing via npm",
    meta: {},
  })

  try {
    await execFileAsync("npm", ["install", "-g", "@bitwarden/cli"], INSTALL_TIMEOUT_MS)
  } catch (err) {
    /* v8 ignore next -- execFileCb always throws Error instances @preserve */
    const reason = err instanceof Error ? err.message : String(err)
    emitNervesEvent({
      level: "error",
      event: "repertoire.bw_cli_install_fail",
      component: "repertoire",
      message: "failed to install bw CLI via npm",
      meta: { reason },
    })
    throw new Error(`failed to install bw CLI via npm: ${reason}`)
  }

  // 3. Verify installation and return path
  const installed = findExecutableOnPath("bw") ?? await findExecutableViaNpmPrefix("bw")
  if (installed) {
    emitNervesEvent({
      event: "repertoire.bw_cli_install_end",
      component: "repertoire",
      message: "bw CLI installed successfully",
      meta: { path: installed },
    })
    return installed
  }

  throw new Error("bw CLI installed via npm but binary not found in PATH or npm global bin")
}
