/**
 * Lazy bw CLI installer — auto-installs the Bitwarden CLI when not present.
 *
 * Mirrors the whisper-cpp pattern in senses/bluebubbles/media.ts:
 * check PATH first, install via npm if missing, emit nerves event.
 */

import { execFile as execFileCb } from "node:child_process"
import { emitNervesEvent } from "../nerves/runtime"

const INSTALL_TIMEOUT_MS = 120_000
const WHICH_TIMEOUT_MS = 5_000

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

/**
 * Ensure the `bw` CLI is available, installing it via npm if needed.
 * Returns the path to the `bw` binary.
 */
export async function ensureBwCli(): Promise<string> {
  // 1. Check if bw is already in PATH
  try {
    const existing = (await execFileAsync("which", ["bw"], WHICH_TIMEOUT_MS)).trim()
    if (existing) {
      return existing
    }
  } catch {
    // Not found — fall through to install
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
  try {
    const installed = (await execFileAsync("which", ["bw"], WHICH_TIMEOUT_MS)).trim()
    if (installed) {
      emitNervesEvent({
        event: "repertoire.bw_cli_install_end",
        component: "repertoire",
        message: "bw CLI installed successfully",
        meta: { path: installed },
      })
      return installed
    }
  } catch {
    // Fall through to error
  }

  throw new Error("bw CLI installed via npm but binary not found in PATH")
}
