/**
 * Lazy bw CLI installer — auto-installs the Bitwarden CLI when not present.
 *
 * Prefers the Bitwarden CLI that ships with ouro (the `@bitwarden/cli` version pinned in our
 * package.json), because a newer `bw` on PATH can run client migrations our Vaultwarden server
 * does not support: bw 2026.9 posts a user key id that Vaultwarden 1.37 answers with 404, and its
 * login then fails. PATH is the fallback, then an npm install of the same pinned version.
 */

import { execFile as execFileCb } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

const INSTALL_TIMEOUT_MS = 120_000
const WHICH_TIMEOUT_MS = 5_000
const DEFAULT_WINDOWS_PATHEXT = ".EXE;.CMD;.BAT;.COM"
/** Must match the `@bitwarden/cli` dependency in package.json (a test checks). */
export const PINNED_BW_CLI_VERSION = "2026.6.0"

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
 * The `bw` entry point (`build/bw.js`) of the `@bitwarden/cli` package installed with ouro, or
 * null when it is missing. It is run with ouro's own Node (see `bwCommand`), so it needs neither
 * an executable bit nor `node` on PATH, and works on Windows too.
 */
export function findBundledBwCli(
  resolvePackageJson: (id: string) => string = (id) => require.resolve(id),
): string | null {
  try {
    const packageJsonPath = resolvePackageJson("@bitwarden/cli/package.json")
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: unknown }
    const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin && typeof pkg.bin === "object" ? (pkg.bin as Record<string, unknown>).bw : undefined)
    if (typeof bin !== "string") throw new Error("@bitwarden/cli package.json names no bw entry point")
    const entry = path.join(path.dirname(packageJsonPath), bin)
    if (!fs.existsSync(entry)) throw new Error(`bundled bw entry point is missing: ${entry}`)
    return entry
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      event: "repertoire.bw_cli_bundled_missing",
      component: "repertoire",
      message: "the bw that ships with ouro was not found; falling back to bw on PATH",
      meta: { reason: error instanceof Error ? error.message : String(error) },
    })
    return null
  }
}

/** How to spawn a resolved `bw`: a `.js` entry point runs under this Node, anything else directly. */
export function bwCommand(bwBinaryPath: string, args: string[], nodePath: string = process.execPath): { file: string; args: string[] } {
  return bwBinaryPath.endsWith(".js") ? { file: nodePath, args: [bwBinaryPath, ...args] } : { file: bwBinaryPath, args }
}

/**
 * Ensure the `bw` CLI is available: `OURO_BW_BINARY` when set, else the bundled pinned one, else
 * one on PATH, else install the pinned version via npm. Returns the path to the `bw` binary.
 */
export async function ensureBwCli(findBundled: () => string | null = findBundledBwCli): Promise<string> {
  // 0. An explicit override (tests and unusual installs): OURO_BW_BINARY
  const override = process.env.OURO_BW_BINARY?.trim()
  if (override) {
    if (findExecutableOnPath(override)) return override
    throw new Error(`OURO_BW_BINARY is set to ${override}, which is not an executable file`)
  }

  // 1. The bw that ships with ouro
  const bundled = findBundled()
  if (bundled) {
    return bundled
  }

  // 2. A bw already on PATH
  const existing = findExecutableOnPath("bw")
  if (existing) {
    return existing
  }

  // 3. Install the pinned version via npm
  emitNervesEvent({
    event: "repertoire.bw_cli_install_start",
    component: "repertoire",
    message: "bw CLI not found, installing via npm",
    meta: {},
  })

  try {
    await execFileAsync("npm", ["install", "-g", `@bitwarden/cli@${PINNED_BW_CLI_VERSION}`], INSTALL_TIMEOUT_MS)
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

  // 4. Verify installation and return path
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
